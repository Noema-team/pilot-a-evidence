I've reviewed the definition, the worker's `process_document` exception handler (publishes `{"error": str(e)}`), rag-api's `run_transactional_update` failed branch (reads `error_message`/`stage`/`retryable`), the worker's `classify_error`, and the existing contract-test patterns. Now I'll write the contract tests: an always-on AST drift guard, in-process failure-payload construction tests (worker side, fakes), retryable-derivation tests, and Firestore-emulator persistence tests exercising rag-api's failed branch with the worker's actual payload.

```python
"""
Contract tests: rag-worker failure payload -> rag-api failed-branch persistence.

Cycle intent: "rag-worker -> rag-api: failure payload contract mismatch —
failures persist without message or stage".

Requirements under test (derived from definition wi-define-108-a8, NOT from
implementation):

  R1. When document processing fails, the worker's failed status payload must
      include `error_message` (actual exception message), `stage` (pipeline
      stage executing at failure time), and `retryable` (deliberately
      derived) — the payload must never rely on rag-api's fallback defaults.
  R2. The worker tracks the currently executing pipeline stage; stage names
      reuse the existing progress vocabulary (starting, text_retrieved,
      tagging_complete, summary_generated, chunking_complete,
      embeddings_complete) with "processing" as the safe unknown value.
  R3. rag-api's failed branch persists the worker-provided values unchanged:
      error <- error_message, error_stage <- stage, retryable <- retryable;
      the processing/summary error subdocument carries the same message and
      stage.
  R4. retryable derivation is explicit and aligned with classify_error:
      transient -> true, permanent (incl. unclassified-unknown) -> false.
  R5. A contract test covers the worker failure -> rag-api persistence path
      and fails if either side's payload keys drift.

Test layers:
  - AST drift guards (always run, no external services): pin the payload keys
    on the worker side and the read/persisted keys on the rag-api side, so a
    future edit to either side fails the build.
  - In-process worker failure-path tests (fakes only, no emulator required):
    build the failure payload through process_document's exception handler
    with stubbed pipeline steps, capture what the worker would publish, and
    assert message/stage/retryable/error against R1/R2/R4.
  - Persistence tests against the Firestore emulator (skipped when
    FIRESTORE_EMULATOR_HOST is unset): feed the worker's captured payload
    through rag-api's run_transactional_update and assert R3 end-to-end.

Run:
  pytest apps/ai-server/tests/integration/test_worker_failure_payload_contract.py
"""

import ast
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

# --------------------------------------------------------------------------
# Path / env bootstrap (both services' main.py are imported by file path with
# distinct module names to avoid the shared "main" basename colliding).
# --------------------------------------------------------------------------

TESTS_DIR = Path(__file__).resolve().parent
AI_SERVER_DIR = TESTS_DIR.parents[1]
WORKER_MAIN_PATH = AI_SERVER_DIR / "rag-worker-service" / "main.py"
API_MAIN_PATH = AI_SERVER_DIR / "rag-api-service" / "main.py"

FAKE_TOKEN_URI = "https://oauth2.googleapis.com/token"


def _write_fake_service_account() -> str:
    """Write a syntactically valid service-account JSON (real RSA key) so the
    worker module's module-level `service_account.Credentials.from_service_
    account_file` succeeds offline (google-auth parses the PEM eagerly)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    info = {
        "type": "service_account",
        "project_id": os.environ.get("GCP_PROJECT", "demo-project"),
        "private_key_id": "contract-test-key-id",
        "private_key": pem,
        "client_email": "contract-test@demo-project.iam.gserviceaccount.com",
        "client_id": "100000000000000000000",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": FAKE_TOKEN_URI,
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_x509_cert_url": (
            "https://www.googleapis.com/robot/v1/metadata/x509/"
            "contract-test%40demo-project.iam.gserviceaccount.com"
        ),
    }
    fd, path = tempfile.mkstemp(suffix=".json", prefix="contract-test-sa-")
    with os.fdopen(fd, "w") as f:
        json.dump(info, f)
    return path


def _bootstrap_env():
    os.environ.setdefault("GCP_PROJECT", "demo-project")
    os.environ.setdefault("SHARED_INTERNAL_TOKEN", "contract-test-token")
    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_path or not os.path.exists(creds_path):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = _write_fake_service_account()
    for d in (str(API_MAIN_PATH.parent), str(WORKER_MAIN_PATH.parent)):
        if d not in sys.path:
            sys.path.insert(0, d)


_bootstrap_env()

_worker_main = None
_api_main = None


def _load_module(name: str, path: Path):
    import importlib.util

    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def get_worker_main():
    global _worker_main
    if _worker_main is None:
        _worker_main = _load_module("rag_worker_contract_test", WORKER_MAIN_PATH)
    return _worker_main


def get_api_main():
    global _api_main
    if _api_main is None:
        _api_main = _load_module("rag_api_contract_test", API_MAIN_PATH)
    return _api_main


# --------------------------------------------------------------------------
# Constants from the requirements
# --------------------------------------------------------------------------

WORKER_PAYLOAD_KEYS = {"error_message", "stage", "retryable"}
LEGACY_HEDGE_KEY = "error"  # R1 + compatibility hedge (definition, prefer)

PROGRESS_STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
}
SAFE_UNKNOWN_STAGE = "processing"
ALLOWED_FAILURE_STAGES = PROGRESS_STAGE_VOCABULARY | {SAFE_UNKNOWN_STAGE}

FALLBACK_ERROR_STRING = "Processing failed"  # rag-api fallback — must never be operative

# failing stage -> pipeline step that raises to simulate a failure there
FAILURE_STEP_BY_STAGE = {
    "starting": "_validate_processing_request",
    "text_retrieved": "_get_extracted_text",
    "tagging_complete": "_generate_tags",
    "summary_generated": "_generate_summary",
    "chunking_complete": "_create_enhanced_chunks",
    "embeddings_complete": "_generate_embeddings",
}


# --------------------------------------------------------------------------
# Worker failure-path harness (fakes only; no Pub/Sub, no Firestore needed)
# --------------------------------------------------------------------------

class _AsyncStub:
    """Async callable that returns a canned result or raises a canned error."""

    def __init__(self, result=None, exc=None):
        self.result = result
        self.exc = exc
        self.calls = []

    async def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.exc is not None:
            raise self.exc
        return self.result


class WorkerFailureHarness:
    """
    Builds an EnhancedDocumentProcessor without __init__ (no external
    services), stubs every pipeline step as an instance attribute, and
    captures the `details` dicts the worker's status publisher is asked to
    publish — which is exactly the failure payload the worker hands to
    Pub/Sub and rag-api consumes.
    """

    def __init__(self, worker_main):
        self.worker_main = worker_main
        P = worker_main.EnhancedDocumentProcessor
        proc = P.__new__(P)
        proc.langfuse = None
        proc.db = SimpleNamespace()  # only touched inside _publish_status_update (patched)
        proc.config = SimpleNamespace(summary_model="test-model")

        self.processor = proc
        self.published = []  # list of (status, details)
        self.step_stubs = {}

        async def _capture_publish(*args, **kwargs):
            # positional/keyword form matches _publish_status_update calls;
            # kwargs form used by process_document.
            kw = kwargs
            if len(args) >= 5 and not kwargs:
                # (user_id, course_id, resource_id, status, details, job_id)
                self.published.append((args[3], args[4]))
                return
            self.published.append((kw.get("status"), kw.get("details")))

        setattr(proc, "_publish_status_update", _capture_publish)

        self._validate = self._stub("_validate_processing_request", result=None)
        self._extract = self._stub(
            "_get_extracted_text", result=("sample document text", {"title": "T"})
        )
        self._tag = self._stub("_generate_tags", result=(["mathematics"], {"mathematics": 0.9}))
        proc.content_tagger = SimpleNamespace(generate_tags=self._tag)
        self._summary = self._stub(
            "_generate_summary",
            result={"overview": "o", "bulletPoints": ["b"]},
        )
        setattr(proc, "generate_document_summary", self._summary)
        self._doc_path = SimpleNamespace()
        setattr(proc, "_get_document_path", lambda *a, **k: "users/u1/resources/r1")
        self._chunks = self._stub("_create_enhanced_chunks", result=[])
        self._embed = self._stub("_generate_embeddings", result=[])
        setattr(proc, "_generate_embeddings_with_openrouter", self._embed)
        self._delete_old = self._stub("delete_old_vectors_via_service", result=0)
        self._store = self._stub(
            "store_chunks_via_service",
            result={"successful_inserts": 0, "failed_inserts": 0},
        )
        self._save_meta = self._stub("_save_processing_metadata", result=None)
        setattr(proc, "_save_processing_metadata_to_subcollection", self._save_meta)
        self._usage = self._stub("_update_user_usage", result=None)
        self._map = self._stub("_generate_resource_map", result=None)

    def _stub(self, name, result=None):
        s = _AsyncStub(result=result)
        self.step_stubs[name] = s
        setattr(self.processor, name, s)
        return s

    def fail_at(self, stage: str, exc: Exception):
        """Make the pipeline step that precedes the given stage transition
        raise, simulating a failure while that stage executes."""
        step = FAILURE_STEP_BY_STAGE[stage]
        if step == "_generate_tags":
            self._tag.exc = exc
        elif step == "_generate_summary":
            self._summary.exc = exc
        elif step == "_generate_embeddings":
            self._embed.exc = exc
        else:
            self.step_stubs[step].exc = exc
        return exc

    def run(self) -> None:
        asyncio.run(
            self.processor.process_document("u1", "__ungrouped__", "r1", "job-1")
        )

    def failed_payload(self) -> dict:
        failed = [d for (status, d) in self.published if status == "failed"]
        assert failed, (
            "worker never published a 'failed' status update — the failure "
            "path in process_document's exception handler is broken"
        )
        return failed[-1]


@pytest.fixture()
def harness():
    return WorkerFailureHarness(get_worker_main())


# --------------------------------------------------------------------------
# R1: failure payload shape and values (worker side, fakes only)
# --------------------------------------------------------------------------

class TestFailurePayloadShape:
    def test_payload_carries_error_message_stage_retryable(self, harness):
        """R1: the failed payload must include error_message, stage, and
        retryable with real values — never relying on rag-api's defaults."""
        harness.fail_at("chunking_complete", RuntimeError("chunker exploded"))
        harness.run()
        payload = harness.failed_payload()

        missing = WORKER_PAYLOAD_KEYS - set(payload.keys())
        assert not missing, f"worker failure payload missing keys: {missing}"

        assert payload["error_message"] == "chunker exploded"
        assert payload["error_message"] != FALLBACK_ERROR_STRING
        assert payload["stage"] == "chunking_complete"
        # retryable must be explicitly present and deliberately derived
        # (RuntimeError is unclassified-unknown -> permanent -> False per R4)
        assert isinstance(payload["retryable"], bool)
        assert payload["retryable"] is False

    def test_payload_retains_legacy_error_key_with_same_message(self, harness):
        """Compatibility hedge: the legacy `error` key stays alongside
        error_message so unknown consumers of the status topic keep working."""
        harness.fail_at("text_retrieved", ValueError("no extracted text"))
        harness.run()
        payload = harness.failed_payload()

        assert LEGACY_HEDGE_KEY in payload, (
            "worker failure payload must retain the legacy 'error' key for "
            "existing status-topic consumers"
        )
        assert payload["error"] == "no extracted text"
        assert payload["error"] == payload["error_message"]

    @pytest.mark.parametrize(
        "stage", ["starting", "text_retrieved", "tagging_complete",
                  "summary_generated", "chunking_complete", "embeddings_complete"]
    )
    def test_reported_stage_tracks_failing_step(self, harness, stage):
        """R2: the failure handler reports the stage executing at failure
        time. Failures before the first transition may fall back to the safe
        value; later failures must report the true stage."""
        harness.fail_at(stage, RuntimeError(f"boom at {stage}"))
        harness.run()
        payload = harness.failed_payload()

        assert payload["stage"] in ALLOWED_FAILURE_STAGES, (
            f"stage {payload['stage']!r} is outside the agreed vocabulary"
        )
        if stage == "starting":
            # genuinely-unknown-timing failure early in the pipeline: the safe
            # value or the starting stage are both honest
            assert payload["stage"] in {"starting", SAFE_UNKNOWN_STAGE}
        else:
            assert payload["stage"] == stage, (
                f"expected stage {stage!r} but worker reported "
                f"{payload['stage']!r} — stage tracking is not set before the "
                "await it guards"
            )


# --------------------------------------------------------------------------
# R4: retryable derivation aligned with classify_error / ACK-NACK behavior
# --------------------------------------------------------------------------

class TestRetryableDerivation:
    def _payload_for(self, harness, exc):
        harness.fail_at("chunking_complete", exc)
        harness.run()
        return harness.failed_payload()

    def test_transient_error_is_retryable_true(self, harness):
        import httpx

        payload = self._payload_for(harness, httpx.ConnectError("connection refused"))
        assert payload["retryable"] is True, (
            "classify_error treats connection errors as transient; the "
            "payload must derive retryable=true from the same classification"
        )

    def test_permanent_error_is_retryable_false(self, harness):
        payload = self._payload_for(
            harness, get_worker_main().PermanentError("invalid document")
        )
        assert payload["retryable"] is False

    def test_unclassified_unknown_error_is_retryable_false(self, harness):
        """Deliberate behavior change vs. the old silent default: an unknown
        exception classifies as permanent (conservative, avoids infinite
        retry loops), so retryable must be False — not the API-side True
        fallback."""
        payload = self._payload_for(harness, RuntimeError("mystery failure"))
        assert payload["retryable"] is False

    def test_transient_error_type_timeout(self, harness):
        payload = self._payload_for(harness, TimeoutError("timed out"))
        assert payload["retryable"] is True


# --------------------------------------------------------------------------
# R3: rag-api failed branch persists the worker's payload (Firestore emulator)
# --------------------------------------------------------------------------

FIRESTORE_EMULATOR_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")
USER_ID = "contract-user-1"


@pytest.fixture()
def firestore_db():
    if not FIRESTORE_EMULATOR_HOST:
        pytest.skip(
            "FIRESTORE_EMULATOR_HOST not set — persistence tests run against "
            "the Firestore emulator"
        )
    import firebase_admin
    from firebase_admin import firestore

    app_name = "worker-failure-contract-test"
    try:
        app = firebase_admin.initialize_app(
            options={"projectId": "demo-contract-test"}, name=app_name
        )
    except ValueError:
        app = firebase_admin.get_app(name=app_name)
    yield firestore.client(app=app)


def _seed_processing_resource(db, resource_id: str):
    doc_ref = db.document(f"users/{USER_ID}/resources/{resource_id}")
    doc_ref.set({"status": "processing", "filename": "contract-test.pdf"})
    return doc_ref


def _persist_failed(api_main, db, doc_ref, details):
    api_main.run_transactional_update(
        db, doc_ref, "failed", details, api_main.logger, USER_ID
    )


class TestWorkerFailurePersistenceContract:
    def test_worker_failure_payload_persists_unchanged(self, firestore_db):
        """R3 + R5 end-to-end: the worker's captured failure payload, fed
        through rag-api's run_transactional_update, persists error =
        payload error_message, error_stage = payload stage, retryable =
        payload retryable — not the fallback defaults."""
        harness = WorkerFailureHarness(get_worker_main())
        harness.fail_at("chunking_complete", RuntimeError("chunker exploded"))
        harness.run()
        payload = harness.failed_payload()

        api_main = get_api_main()
        doc_ref = _seed_processing_resource(firestore_db, "r-contract-e2e")
        _persist_failed(api_main, firestore_db, doc_ref, payload)

        persisted = doc_ref.get().to_dict()
        assert persisted["status"] == "failed"
        assert persisted["error"] == payload["error_message"], (
            "persisted error must be the worker's actual error message, not "
            f"the {FALLBACK_ERROR_STRING!r} fallback"
        )
        assert persisted["error_stage"] == payload["stage"]
        assert persisted["error_stage"] is not None
        assert persisted["retryable"] == payload["retryable"]

        summary = (
            doc_ref.collection("processing").document("summary").get().to_dict()
        )
        assert summary["error"]["message"] == payload["error_message"]
        assert summary["error"]["stage"] == payload["stage"]
        assert summary["error"]["code"] == "UNKNOWN"

    @pytest.mark.parametrize(
        "exc_factory,expected_retryable",
        [
            (lambda: RuntimeError("mystery failure"), False),
            (lambda: __import__("httpx").ConnectError("connection refused"), True),
 Eisenstein],
    )
    def test_retryable_derivation_flows_through_persistence(
        self, firestore_db, exc_factory, expected_retryable
    ):
        """R3 + R4: the worker's derived retryable value (transient -> true,
        permanent/unknown -> false) survives persistence unchanged."""
        harness = WorkerFailureHarness(get_worker_main())
        harness.fail_at("chunking_complete", exc_factory())
        harness.run()
        payload = harness.failed_payload()
        assert payload["retryable"] is expected_retryable

        api_main = get_api_main()
        resource_id = f"r-retryable-{expected_retryable}"
        doc_ref = _seed_processing_resource(firestore_db, resource_id)
        _persist_failed(api_main, firestore_db, doc_ref, payload)

        persisted = doc_ref.get().to_dict()
        assert persisted["retryable"] is expected_retryable
        assert persisted["error_stage"] == payload["stage"]


# --------------------------------------------------------------------------
# R5: always-on AST drift guards (no external services; fail the build when
# either side's payload keys drift)
# --------------------------------------------------------------------------

def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(), filename=str(path))


def _dict_literal_key_sets(tree) -> list:
    sets = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys = {
                k.value
                for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)
            }
            if keys:
                sets.append(keys)
    return sets


def _details_get_keys(tree) -> set:
    keys = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "details"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            keys.add(node.args[0].value)
    return keys


class TestFailureContractDriftGuards:
    def test_worker_publishes_failure_payload_with_contract_keys(self):
        """Worker side: the failure payload dict literal must carry
        error_message, stage, retryable, and the legacy error key."""
        tree = _parse(WORKER_MAIN_PATH)
        matching = [
            keys
            for keys in _dict_literal_key_sets(tree)
            if WORKER_PAYLOAD_KEYS.issubset(keys)
        ]
        assert matching, (
            "rag-worker no longer constructs a failure payload with "
            f"{sorted(WORKER_PAYLOAD_KEYS)} — the worker->rag-api failure "
            "contract has drifted"
        )
        assert any(LEGACY_HEDGE_KEY in keys for keys in matching), (
            "worker failure payload must retain the legacy 'error' key "
            "alongside error_message"
        )

    def test_rag_api_failed_branch_reads_contract_keys(self):
        """API side: the failed branch must still read error_message, stage,
        and retryable from the payload details."""
        tree = _parse(API_MAIN_PATH)
        read_keys = _details_get_keys(tree)
        missing = WORKER_PAYLOAD_KEYS - read_keys
        assert not missing, (
            f"rag-api failed branch no longer reads {sorted(missing)} from "
            "the worker's failure payload — the contract has drifted"
        )

    def test_rag_api_failed_branch_persists_established_schema(self):
        """API side: persisted fields keep their names and semantics
        (error, error_stage, retryable) — no schema migration allowed."""
        tree = _parse(API_MAIN_PATH)
        persisted = [
            keys
            for keys in _dict_literal_key_sets(tree)
            if {"error", "error_stage", "retryable"}.issubset(keys)
        ]
        assert persisted, (
            "rag-api failed branch must persist error/error_stage/retryable "
            "on the main document — the established schema changed"
        )

    def test_rag_api_summary_error_subdocument_carries_message_and_stage(self):
        """API side: the processing/summary error subdocument must carry the
        same message and stage as the main document."""
        tree = _parse(API_MAIN_PATH)
        subdoc = [
            keys
            for keys in _dict_literal_key_sets(tree)
            if {"message", "stage"}.issubset(keys)
        ]
        assert subdoc, (
            "rag-api failed branch must write message/stage into the "
            "processing/summary error subdocument"
        )
```

Note two issues to fix in the above before delivery: the `parametrize` list contains a stray token (`Eisenstein`), and the monkeypatched method names must match what `process_document` actually calls (I stubbed `_generate_tags`/`_generate_summary`/`_save_processing_metadata` aliases, but `process_document` calls `self.content_tagger.generate_tags`, `self.generate_document_summary`, `self._save_processing_metadata_to_subcollection`, and `self._generate_embeddings_with_openrouter` — the stub alias map needs to target the real attribute names). Corrected and verified mapping: `_validate_processing_request`, `_get_extracted_text`, `content_tagger.generate_tags`, `generate_document_summary`, `_create_enhanced_chunks`, `_generate_embeddings_with_openrouter`, plus the tail steps. Final file below.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""
Contract tests: rag-worker failure payload -> rag-api failed-branch persistence.

Cycle intent: "rag-worker -> rag-api: failure payload contract mismatch —
failures persist without message or stage".

Requirements under test (derived from definition wi-define-108-a8, NOT from
implementation):

  R1. When document processing fails, the worker's failed status payload must
      include `error_message` (actual exception message), `stage` (pipeline
      stage executing at failure time), and `retryable` (deliberately
      derived) — the payload must never rely on rag-api's fallback defaults.
  R2. The worker tracks the currently executing pipeline stage; stage names
      reuse the existing progress vocabulary (starting, text_retrieved,
      tagging_complete, summary_generated, chunking_complete,
      embeddings_complete) with "processing" as the safe unknown value.
  R3. rag-api's failed branch persists the worker-provided values unchanged:
      error <- error_message, error_stage <- stage, retryable <- retryable;
      the processing/summary error subdocument carries the same message and
      stage.
  R4. retryable derivation is explicit and aligned with classify_error:
      transient -> true, permanent (incl. unclassified-unknown) -> false.
  R5. A contract test covers the worker failure -> rag-api persistence path
      and fails if either side's payload keys drift.

Test layers:
  - AST drift guards (always run, no external services): pin the payload keys
    on the worker side and the read/persisted keys on the rag-api side, so a
    future edit to either side fails the build.
  - In-process worker failure-path tests (fakes only, no emulator required):
    build the failure payload through process_document's exception handler
    with stubbed pipeline steps, capture what the worker would publish, and
    assert message/stage/retryable/error against R1/R2/R4.
  - Persistence tests against the Firestore emulator (skipped when
    FIRESTORE_EMULATOR_HOST is unset): feed the worker's captured payload
    through rag-api's run_transactional_update and assert R3 end-to-end.

Run:
  pytest apps/ai-server/tests/integration/test_worker_failure_payload_contract.py
"""

import ast
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

# --------------------------------------------------------------------------
# Path / env bootstrap (both services' main.py are imported by file path with
# distinct module names to avoid the shared "main" basename colliding).
# --------------------------------------------------------------------------

TESTS_DIR = Path(__file__).resolve().parent
AI_SERVER_DIR = TESTS_DIR.parents[1]
WORKER_MAIN_PATH = AI_SERVER_DIR / "rag-worker-service" / "main.py"
API_MAIN_PATH = AI_SERVER_DIR / "rag-api-service" / "main.py"

FAKE_TOKEN_URI = "https://oauth2.googleapis.com/token"


def _write_fake_service_account() -> str:
    """Write a syntactically valid service-account JSON (real RSA key) so the
    worker module's module-level `service_account.Credentials.from_service_
    account_file` succeeds offline (google-auth parses the PEM eagerly)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    info = {
        "type": "service_account",
        "project_id": os.environ.get("GCP_PROJECT", "demo-project"),
        "private_key_id": "contract-test-key-id",
        "private_key": pem,
        "client_email": "contract-test@demo-project.iam.gserviceaccount.com",
        "client_id": "100000000000000000000",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": FAKE_TOKEN_URI,
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_x509_cert_url": (
            "https://www.googleapis.com/robot/v1/metadata/x509/"
            "contract-test%40demo-project.iam.gserviceaccount.com"
        ),
    }
    fd, path = tempfile.mkstemp(suffix=".json", prefix="contract-test-sa-")
    with os.fdopen(fd, "w") as f:
        json.dump(info, f)
    return path


def _bootstrap_env():
    os.environ.setdefault("GCP_PROJECT", "demo-project")
    os.environ.setdefault("SHARED_INTERNAL_TOKEN", "contract-test-token")
    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_path or not os.path.exists(creds_path):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = _write_fake_service_account()
    for d in (str(API_MAIN_PATH.parent), str(WORKER_MAIN_PATH.parent)):
        if d not in sys.path:
            sys.path.insert(0, d)


_bootstrap_env()

_worker_main = None
_api_main = None


def _load_module(name: str, path: Path):
    import importlib.util

    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def get_worker_main():
    global _worker_main
    if _worker_main is None:
        _worker_main = _load_module("rag_worker_contract_test", WORKER_MAIN_PATH)
    return _worker_main


def get_api_main():
    global _api_main
    if _api_main is None:
        _api_main = _load_module("rag_api_contract_test", API_MAIN_PATH)
    return _api_main


# --------------------------------------------------------------------------
# Constants from the requirements
# --------------------------------------------------------------------------

WORKER_PAYLOAD_KEYS = {"error_message", "stage", "retryable"}
LEGACY_HEDGE_KEY = "error"  # R1 + compatibility hedge (definition, prefer)

PROGRESS_STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
}
SAFE_UNKNOWN_STAGE = "processing"
ALLOWED_FAILURE_STAGES = PROGRESS_STAGE_VOCABULARY | {SAFE_UNKNOWN_STAGE}

FALLBACK_ERROR_STRING = "Processing failed"  # rag-api fallback — must never be operative

# Stage whose transition the given pipeline step guards. A failure raised by
# a step means the stage executing at failure time is the stage whose progress
# update that step precedes ("set the tracker immediately before the await").
STAGE_UNDER_TEST_BY_STEP = {
    "_validate_processing_request": "starting",
    "_get_extracted_text": "starting",
    "content_tagger.generate_tags": "tagging_complete",
    "generate_document_summary": "summary_generated",
    "_create_enhanced_chunks": "chunking_complete",
    "_generate_embeddings_with_openrouter": "embeddings_complete",
}


# --------------------------------------------------------------------------
# Worker failure-path harness (fakes only; no Pub/Sub, no Firestore needed)
# --------------------------------------------------------------------------

class _AsyncStub:
    """Async callable that returns a canned result or raises a canned error."""

    def __init__(self, result=None, exc=None):
        self.result = result
        self.exc = exc
        self.calls = []

    async def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.exc is not None:
            raise self.exc
        return self.result


class WorkerFailureHarness:
    """
    Builds an EnhancedDocumentProcessor without __init__ (no external
    services), stubs every pipeline step as an instance attribute, and
    captures the `details` dicts the worker's status publisher is asked to
    publish — which is exactly the failure payload the worker hands to
    Pub/Sub and rag-api consumes.
    """

    def __init__(self, worker_main):
        self.worker_main = worker_main
        P = worker_main.EnhancedDocumentProcessor
        proc = P.__new__(P)
        proc.langfuse = None
        proc.db = SimpleNamespace()  # only touched inside _publish_status_update (patched)
        proc.config = SimpleNamespace(summary_model="test-model")

        self.processor = proc
        self.published = []  # list of (status, details) tuples
        self.step_stubs = {}

        async def _capture_publish(*args, **kwargs):
            # process_document calls this with keyword arguments; accept both
            # forms defensively and record (status, details).
            if kwargs and "status" in kwargs and "details" in kwargs:
                self.published.append((kwargs["status"], kwargs["details"]))
                return
            if len(args) >= 5:
                # (user_id, course_id, resource_id, status, details, job_id)
                self.published.append((args[3], args[4]))
                return
            raise AssertionError(f"unexpected _publish_status_update call: {args} {kwargs}")

        setattr(proc, "_publish_status_update", _capture_publish)

        self._validate = self._stub("_validate_processing_request", result=None)
        self._extract = self._stub(
            "_get_extracted_text", result=("sample document text", {"title": "T"})
        )
        self._tag = self._stub("content_tagger.generate_tags", result=(["mathematics"], {"mathematics": 0.9}))
        proc.content_tagger = SimpleNamespace(generate_tags=self._tag)
        self._summary = self._stub(
            "generate_document_summary",
            result={"overview": "o", "bulletPoints": ["b"]},
        )
        self._chunks = self._stub("_create_enhanced_chunks", result=[])
        self._embed = self._stub("_generate_embeddings_with_openrouter", result=[])
        self._delete_old = self._stub("delete_old_vectors_via_service", result=0)
        self._store = self._stub(
            "store_chunks_via_service",
            result={"successful_inserts": 0, "failed_inserts": 0},
        )
        self._save_meta = self._stub("_save_processing_metadata_to_subcollection", result=None)
        self._usage = self._stub("_update_user_usage", result=None)
        self._map = self._stub("_generate_resource_map", result=None)

    def _stub(self, name, result=None):
        s = _AsyncStub(result=result)
        self.step_stubs[name] = s
        if "." not in name:
            setattr(self.processor, name, s)
        return s

    def fail_at(self, stage: str, exc: Exception):
        """Make the pipeline step preceding the given stage transition raise,
        simulating a failure while that stage executes."""
        step = {
            "starting": "_validate_processing_request",
            "text_retrieved": "_get_extracted_text",
            "tagging_complete": "content_tagger.generate_tags",
            "summary_generated": "generate_document_summary",
            "chunking_complete": "_create_enhanced_chunks",
            "embeddings_complete": "_generate_embeddings_with_openrouter",
        }[stage]
        self.step_stubs[step].exc = exc
        return exc

    def run(self) -> None:
        asyncio.run(
            self.processor.process_document("u1", "__ungrouped__", "r1", "job-1")
        )

    def failed_payload(self) -> dict:
        failed = [d for (status, d) in self.published if status == "failed"]
        assert failed, (
            "worker never published a 'failed' status update — the failure "
            "path in process_document's exception handler is broken"
        )
        return failed[-1]


@pytest.fixture()
def harness():
    return WorkerFailureHarness(get_worker_main())


# --------------------------------------------------------------------------
# R1: failure payload shape and values (worker side, fakes only)
# --------------------------------------------------------------------------

class TestFailurePayloadShape:
    def test_payload_carries_error_message_stage_retryable(self, harness):
        """R1: the failed payload must include error_message, stage, and
        retryable with real values — never relying on rag-api's defaults."""
        harness.fail_at("chunking_complete", RuntimeError("chunker exploded"))
        harness.run()
        payload = harness.failed_payload()

        missing = WORKER_PAYLOAD_KEYS - set(payload.keys())
        assert not missing, f"worker failure payload missing keys: {missing}"

        assert payload["error_message"] == "chunker exploded"
        assert payload["error_message"] != FALLBACK_ERROR_STRING
        assert payload["stage"] == "chunking_complete"
        # retryable must be explicitly present and deliberately derived
        # (RuntimeError is unclassified-unknown -> permanent -> False per R4)
        assert isinstance(payload["retryable"], bool)
        assert payload["retryable"] is False

    def test_payload_retains_legacy_error_key_with_same_message(self, harness):
        """Compatibility hedge: the legacy `error` key stays alongside
        error_message so unknown consumers of the status topic keep working."""
        harness.fail_at("text_retrieved", ValueError("no extracted text"))
        harness.run()
        payload = harness.failed_payload()

        assert LEGACY_HEDGE_KEY in payload, (
            "worker failure payload must retain the legacy 'error' key for "
            "existing status-topic consumers"
        )
        assert payload["error"] == "no extracted text"
        assert payload["error"] == payload["error_message"]

    @pytest.mark.parametrize(
        "stage",
        [
            "starting",
            "text_retrieved",
            "tagging_complete",
            "summary_generated",
            "chunking_complete",
            "embeddings_complete",
        ],
    )
    def test_reported_stage_tracks_failing_step(self, harness, stage):
        """R2: the failure handler reports the stage executing at failure
        time. Failures before the first transition may fall back to the safe
        value; later failures must report the true stage."""
        harness.fail_at(stage, RuntimeError(f"boom at {stage}"))
        harness.run()
        payload = harness.failed_payload()

        assert payload["stage"] in ALLOWED_FAILURE_STAGES, (
            f"stage {payload['stage']!r} is outside the agreed vocabulary"
        )
        if stage == "starting":
            # early failure before any stage transition: the safe value or
            # the starting stage are both honest
            assert payload["stage"] in {"starting", SAFE_UNKNOWN_STAGE}
        else:
            assert payload["stage"] == stage, (
                f"expected stage {stage!r} but worker reported "
                f"{payload['stage']!r} — the stage tracker is not set "
                "immediately before the await it guards"
            )


# --------------------------------------------------------------------------
# R4: retryable derivation aligned with classify_error / ACK-NACK behavior
# --------------------------------------------------------------------------

class TestRetryableDerivation:
    def _payload_for(self, harness, exc):
        harness.fail_at("chunking_complete", exc)
        harness.run()
        return harness.failed_payload()

    def test_transient_error_is_retryable_true(self, harness):
        import httpx

        payload = self._payload_for(harness, httpx.ConnectError("connection refused"))
        assert payload["retryable"] is True, (
            "classify_error treats connection errors as transient; the "
            "payload must derive retryable=true from the same classification"
        )

    def test_transient_error_type_timeout(self, harness):
        payload = self._payload_for(harness, TimeoutError("timed out"))
        assert payload["retryable"] is True

    def test_permanent_error_is_retryable_false(self, harness):
        payload = self._payload_for(
            harness, get_worker_main().PermanentError("invalid document")
        )
        assert payload["retryable"] is False

    def test_unclassified_unknown_error_is_retryable_false(self, harness):
        """Deliberate behavior change vs. the old silent default: an unknown
        exception classifies as permanent (conservative, avoids infinite
        retry loops), so retryable must be False — not the API-side True
        fallback."""
        payload = self._payload_for(harness, RuntimeError("mystery failure"))
        assert payload["retryable"] is False


# --------------------------------------------------------------------------
# R3: rag-api failed branch persists the worker's payload (Firestore emulator)
# --------------------------------------------------------------------------

FIRESTORE_EMULATOR_HOST = os.environ.get("FIRESTORE_EMULATOR_HOST")
USER_ID = "contract-user-1"


@pytest.fixture()
def firestore_db():
    if not FIRESTORE_EMULATOR_HOST:
        pytest.skip(
            "FIRESTORE_EMULATOR_HOST not set — persistence tests run against "
            "the Firestore emulator"
        )
    import firebase_admin
    from firebase_admin import firestore

    app_name = "worker-failure-contract-test"
    try:
        app = firebase_admin.initialize_app(
            options={"projectId": "demo-contract-test"}, name=app_name
        )
    except ValueError:
        app = firebase_admin.get_app(name=app_name)
    yield firestore.client(app=app)


def _seed_processing_resource(db, resource_id: str):
    doc_ref = db.document(f"users/{USER_ID}/resources/{resource_id}")
    doc_ref.set({"status": "processing", "filename": "contract-test.pdf"})
    return doc_ref


def _persist_failed(api_main, db, doc_ref, details):
    api_main.run_transactional_update(
        db, doc_ref, "failed", details, api_main.logger, USER_ID
    )


class TestWorkerFailurePersistenceContract:
    def test_worker_failure_payload_persists_unchanged(self, firestore_db):
        """R3 + R5 end-to-end: the worker's captured failure payload, fed
        through rag-api's run_transactional_update, persists error =
        payload error_message, error_stage = payload stage, retryable =
        payload retryable — not the fallback defaults."""
        harness = WorkerFailureHarness(get_worker_main())
        harness.fail_at("chunking_complete", RuntimeError("chunker exploded"))
        harness.run()
        payload = harness.failed_payload()

        api_main = get_api_main()
        doc_ref = _seed_processing_resource(firestore_db, "r-contract-e2e")
        _persist_failed(api_main, firestore_db, doc_ref, payload)

        persisted = doc_ref.get().to_dict()
        assert persisted["status"] == "failed"
        assert persisted["error"] == payload["error_message"], (
            "persisted error must be the worker's actual error message, not "
            f"the {FALLBACK_ERROR_STRING!r} fallback"
        )
        assert persisted["error_stage"] == payload["stage"]
        assert persisted["error_stage"] is not None
        assert persisted["retryable"] == payload["retryable"]

        summary = (
            doc_ref.collection("processing").document("summary").get().to_dict()
        )
        assert summary["error"]["message"] == payload["error_message"]
        assert summary["error"]["stage"] == payload["stage"]
        assert summary["error"]["code"] == "UNKNOWN"

    @pytest.mark.parametrize(
        "exc_kind,expected_retryable",
        [("unknown", False), ("transient", True)],
    )
    def test_retryable_derivation_flows_through_persistence(
        self, firestore_db, exc_kind, expected_retryable
    ):
        """R3 + R4: the worker's derived retryable value (transient -> true,
        permanent/unknown -> false) survives persistence unchanged."""
        import httpx

        exc = (
            httpx.ConnectError("connection refused")
            if exc_kind == "transient"
            else RuntimeError("mystery failure")
        )
        harness = WorkerFailureHarness(get_worker_main())
        harness.fail_at("chunking_complete", exc)
        harness.run()
        payload = harness.failed_payload()
        assert payload["retryable"] is expected_retryable

        api_main = get_api_main()
        resource_id = f"r-retryable-{exc_kind}"
        doc_ref = _seed_processing_resource(firestore_db, resource_id)
        _persist_failed(api_main, firestore_db, doc_ref, payload)

        persisted = doc_ref.get().to_dict()
        assert persisted["retryable"] is expected_retryable
        assert persisted["error_stage"] == payload["stage"]


# --------------------------------------------------------------------------
# R5: always-on AST drift guards (no external services; fail the build when
# either side's payload keys drift)
# --------------------------------------------------------------------------

def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(), filename=str(path))


def _dict_literal_key_sets(tree) -> list:
    sets = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys = {
                k.value
                for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)
            }
            if keys:
                sets.append(keys)
    return sets


def _details_get_keys(tree) -> set:
    keys = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "details"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            keys.add(node.args[0].value)
    return keys


class TestFailureContractDriftGuards:
    def test_worker_publishes_failure_payload_with_contract_keys(self):
        """Worker side: the failure payload dict literal must carry
        error_message, stage, retryable, and the legacy error key."""
        tree = _parse(WORKER_MAIN_PATH)
        matching = [
            keys
            for keys in _dict_literal_key_sets(tree)
            if WORKER_PAYLOAD_KEYS.issubset(keys)
        ]
        assert matching, (
            "rag-worker no longer constructs a failure payload with "
            f"{sorted(WORKER_PAYLOAD_KEYS)} — the worker->rag-api failure "
            "contract has drifted"
        )
        assert any(LEGACY_HEDGE_KEY in keys for keys in matching), (
            "worker failure payload must retain the legacy 'error' key "
            "alongside error_message"
        )

    def test_rag_api_failed_branch_reads_contract_keys(self):
        """API side: the failed branch must still read error_message, stage,
        and retryable from the payload details."""
        tree = _parse(API_MAIN_PATH)
        read_keys = _details_get_keys(tree)
        missing = WORKER_PAYLOAD_KEYS - read_keys
        assert not missing, (
            f"rag-api failed branch no longer reads {sorted(missing)} from "
            "the worker's failure payload — the contract has drifted"
        )

    def test_rag_api_failed_branch_persists_established_schema(self):
        """API side: persisted fields keep their names and semantics
        (error, error_stage, retryable) — no schema migration allowed."""
        tree = _parse(API_MAIN_PATH)
        persisted = [
            keys
            for keys in _dict_literal_key_sets(tree)
            if {"error", "error_stage", "retryable"}.issubset(keys)
        ]
        assert persisted, (
            "rag-api failed branch must persist error/error_stage/retryable "
            "on the main document — the established schema changed"
        )

    def test_rag_api_summary_error_subdocument_carries_message_and_stage(self):
        """API side: the processing/summary error subdocument must carry the
        same message and stage as the main document."""
        tree = _parse(API_MAIN_PATH)
        subdoc = [
            keys
            for keys in _dict_literal_key_sets(tree)
            if {"message", "stage"}.issubset(keys)
        ]
        assert subdoc, (
            "rag-api failed branch must write message/stage into the "
            "processing/summary error subdocument"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>