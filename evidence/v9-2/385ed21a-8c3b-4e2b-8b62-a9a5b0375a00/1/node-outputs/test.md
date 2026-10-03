All context gathered. The tests below are derived from the Definition's requirements only (worker failure payload keys/stage tracking/retryable derivation; rag-api failed-branch persistence; contract + drift guards), following the existing `tests/integration` house pattern (mocked cloud SDKs, direct import of both services, AST-based drift guards).

Key design points:
- Worker `main.py` is loaded via `importlib` under a unique module name so it doesn't collide with rag-api's `main` in `sys.modules`.
- Failure payloads are built by driving the real `process_document` exception handler (pipeline steps stubbed to raise at an early stage, a late stage, and pre-stage), capturing `_publish_status_update` calls.
- Captured payloads are then fed through the real `run_transactional_update` failed branch against fake Firestore doubles, asserting persisted `error`/`error_stage`/`retryable` equal the worker's values and that the `processing/summary` error subdocument matches.
- Drift guards pin the worker payload key set exactly and AST-verify both sides' key usage.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-define-108-a8/test-worker-failure-payload-contract.md">>>
# Test artifacts — worker → rag-api failure payload contract

## Authorized output
- `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py` (new)

## Coverage map (requirement → test)
1. Failure payload carries `error_message`/`stage`/`retryable`, never relying on API fallbacks → `TestWorkerFailurePayload::test_failed_payload_*`
2. Stage tracking reuses progress vocabulary; `"processing"` safe default → `test_stage_*` tests (early failure, late failure, pre-stage failure)
3. rag-api persists worker values unchanged (main doc + `processing/summary` subdoc) → `TestApiFailedBranchPersistence::test_*`
4. retryable derived from `classify_error` (transient→True, permanent/unknown→False) → `test_retryable_*` tests
5. Contract test across worker→API seam with drift guards → `test_worker_failure_payload_key_set_is_pinned`, `test_rag_api_failed_branch_reads_worker_keys_ast_guard`, `test_worker_publishes_failure_payload_with_contract_keys_ast_guard`

## Notes
- Worker module loaded via `importlib` under a unique name (`rag_worker_main_under_test`) to avoid `sys.modules["main"]` collision with rag-api.
- Heavy third-party deps (langchain, openai, marker, spacy, sklearn, tiktoken, tenacity, langfuse, pypdf) mocked before import; `httpx` and `pydantic` kept real so `classify_error` heuristics are exercised against real exception types.
- rag-api's `firestore` module object is monkeypatched with a fake (`transactional` identity decorator + `SERVER_TIMESTAMP` sentinel) so `run_transactional_update` runs its real logic against fake doc/transaction doubles.
- Tests intentionally fail against the current implementation (worker publishes only `{"error": str(e)}`); they define the target contract per the Definition.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""
Contract tests: rag-worker failure payload → rag-api failed-branch persistence.

Derived from the authoritative Definition (wi-define-108-a8), NOT from
implementation code. The contract under test:

  Worker (process_document exception handler) publishes a "failed" status
  whose details carry:
    - error_message: the actual exception message
    - stage:         the pipeline stage executing at failure time, drawn from
                     the progress-stage vocabulary (starting, text_retrieved,
                     tagging_complete, summary_generated, chunking_complete,
                     embeddings_complete) with "processing" as the safe
                     unknown value
    - retryable:     deliberately derived from classify_error(e)
                     (transient → True, permanent/unclassified → False)
    - error:         legacy key retained for unknown topic consumers

  rag-api (run_transactional_update, failed branch) persists, unchanged:
    - main doc:      error ← error_message, error_stage ← stage,
                     retryable ← retryable
    - processing/summary subdoc: error.message ← error_message,
                     error.stage ← stage, error.code ← "UNKNOWN" default

These tests fail if either side's payload keys drift.
"""

import ast
import asyncio
import importlib.util
import os
import sys
import types
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Environment + heavy-dependency mocking (house pattern, see conftest.py and
# test_chat_pipeline.py). Must happen BEFORE the worker module is loaded.
# ---------------------------------------------------------------------------

os.environ.setdefault("GCP_PROJECT", "test-project")
os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-creds.json")
os.environ.setdefault("SHARED_INTERNAL_TOKEN", "test-token")
os.environ.setdefault("OPENROUTER_API_KEY", "test-key")
os.environ.setdefault("OPENROUTER_BASE_URL", "http://localhost:9")
os.environ.setdefault("OPENROUTER_MODEL", "test-model")
os.environ.setdefault("FIREBASE_STORAGE_BUCKET", "test-bucket")
os.environ.setdefault("FIREBASE_PROJECT_ID", "test-project")
os.environ.setdefault("RAG_PROCESS_SUB", "test-sub")
os.environ.setdefault("RAG_STATUS_TOPIC", "test-status-topic")
os.environ.setdefault("WEAVIATE_SERVICE_URL", "http://localhost:9")

_WORKER_EXTRA_MOCKS = [
    "langchain", "langchain.text_splitter", "langchain.schema",
    "openai", "langfuse",
    "spacy",
    "sklearn", "sklearn.feature_extraction", "sklearn.feature_extraction.text",
    "tiktoken",
    "tenacity",
    "pypdf",
    "marker", "marker.models", "marker.converters", "marker.converters.pdf",
    "marker.output",
    "google.auth", "google.auth.credentials",
]

for _mod in _WORKER_EXTRA_MOCKS:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

_HERE = os.path.dirname(os.path.abspath(__file__))
_RAG_API_DIR = os.path.normpath(os.path.join(_HERE, "..", "..", "rag-api-service"))
_WORKER_MAIN_PATH = os.path.normpath(
    os.path.join(_HERE, "..", "..", "rag-worker-service", "main.py")
)

if _RAG_API_DIR not in sys.path:
    sys.path.insert(0, _RAG_API_DIR)


def _load_worker_main():
    """Load rag-worker-service/main.py under a unique module name.

    Both services ship a top-level main.py; importing the worker's as
    `main` would collide with rag-api's cached entry in sys.modules.
    """
    spec = importlib.util.spec_from_file_location(
        "rag_worker_main_under_test", _WORKER_MAIN_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_worker_main = None


def get_worker_main():
    global _worker_main
    if _worker_main is None:
        _worker_main = _load_worker_main()
    return _worker_main


def get_rag_api_main():
    import main as rag_api_main  # conftest put rag-api-service on sys.path
    return rag_api_main


# ---------------------------------------------------------------------------
# Fake Firestore doubles for rag-api's run_transactional_update
# ---------------------------------------------------------------------------

class FakeSnapshot:
    def __init__(self, data):
        self._data = data
        self.exists = True

    def to_dict(self):
        return dict(self._data)


class FakeTransaction:
    def __init__(self):
        self.updates = []   # (doc_ref, data)
        self.sets = []      # (ref, data, merge)

    def update(self, doc_ref, data):
        self.updates.append((doc_ref, data))

    def set(self, ref, data, merge=False):
        self.sets.append((ref, data, merge))


class FakeSubRef:
    def __init__(self, path):
        self.path = path
        self.id = path.split("/")[-1]


class FakeCollection:
    def __init__(self, path):
        self.path = path

    def document(self, doc_id):
        return FakeSubRef(f"{self.path}/{doc_id}")


class FakeDocRef:
    def __init__(self, path, data):
        self.path = path
        self.id = path.split("/")[-1]
        self._data = data
        self.collection_obj = FakeCollection(f"{self.path}")

    def get(self, transaction=None):
        return FakeSnapshot(self._data)

    def collection(self, name):
        return self.collection_obj


class FakeDB:
    def transaction(self):
        return FakeTransaction()


def _fake_firestore_module():
    """Stand-in for the (conftest-mocked) firestore module inside rag-api.

    Provides the two symbols run_transactional_update uses:
    @firestore.transactional and firestore.SERVER_TIMESTAMP.
    """
    mod = types.SimpleNamespace()
    mod.transactional = lambda fn: fn  # identity decorator: run real logic
    mod.SERVER_TIMESTAMP = object()    # sentinel, never compared by the code
    return mod


# ---------------------------------------------------------------------------
# Processor harness: bare EnhancedDocumentProcessor with stubbed pipeline
# ---------------------------------------------------------------------------

def make_processor(worker):
    proc = worker.EnhancedDocumentProcessor.__new__(worker.EnhancedDocumentProcessor)
    proc.logger = MagicMock()
    proc.langfuse = None
    proc.db = MagicMock()
    proc.config = MagicMock()
    proc.content_tagger = MagicMock()
    # _get_document_path is real code that probes Firestore; stub it.
    proc._get_document_path = lambda user_id, course_id, resource_id: (
        f"users/{user_id}/resources/{resource_id}"
    )
    return proc


async def run_process_document(proc, worker, exc):
    """Drive process_document with stubbed steps; capture status publishes.

    Returns (metrics, publishes) where publishes is a list of
    (status, details) tuples from _publish_status_update.
    """
    publishes = []

    async def capture_publish(user_id, course_id, resource_id, status, details, job_id=None):
        publishes.append((status, details))

    proc._publish_status_update = capture_publish

    async def ok_validate(user_id, course_id, resource_id):
        return None

    async def ok_text(user_id, course_id, resource_id):
        return "some extracted text", {"title": "Test Doc", "filename": "test.md"}

    async def ok_tags(text, metadata):
        return ["tag1"], {"tag1": 0.9}

    async def ok_summary(text, title):
        return {"overview": "o", "bulletPoints": ["b"]}

    async def ok_chunks(text, metadata, tags, user_id, course_id, resource_id):
        return []

    async def raise_always(*args, **kwargs):
        raise exc

    # Defaults: everything succeeds. Individual tests override the failing
    # step by assigning onto the instance before calling.
    proc._validate_processing_request = ok_validate
    proc._get_extracted_text = ok_text
    proc.content_tagger.generate_tags = ok_tags
    proc.generate_document_summary = ok_summary
    proc._create_enhanced_chunks = ok_chunks

    metrics = await proc.process_document("user1", "__ungrouped__", "res1", "job-1")
    return metrics, publishes


def failed_payloads(publishes):
    return [d for (s, d) in publishes if s == "failed"]


# ---------------------------------------------------------------------------
# Worker-side tests: failure payload construction
# ---------------------------------------------------------------------------

WORKER_PAYLOAD_KEYS = {"error", "error_message", "stage", "retryable"}

PROGRESS_STAGE_VOCABULARY = {
    "starting", "text_retrieved", "tagging_complete", "summary_generated",
    "chunking_complete", "embeddings_complete", "completed", "processing",
}


class TestWorkerFailurePayload:
    def test_early_failure_payload_has_contract_keys_and_values(self):
        worker = get_worker_main()
        proc = make_processor(worker)
        exc = worker.TransientError("upstream text service unavailable")
        proc._get_extracted_text = raise_always_factory(exc)

        _, publishes = asyncio.get_event_loop().run_until_complete(
            run_process_document(proc, worker, exc)
        )
        failed = failed_payloads(publishes)
        assert len(failed) == 1, f"expected exactly one failed publish, got {publishes}"
        details = failed[0]

        assert details["error_message"] == "upstream text service unavailable"
        assert details["stage"] == "text_retrieved"
        assert details["retryable"] is True
        # Legacy key retained for unknown status-topic consumers.
        assert details["error"] == "upstream text service unavailable"

    def test_late_failure_reports_embeddings_stage(self):
        worker = get_worker_main()
        proc = make_processor(worker)
        exc = __import__("httpx").ConnectTimeout("embedding provider timed out")
        proc._generate_embeddings_with_openrouter = raise_always_factory(exc)

        _, publishes = asyncio.get_event_loop().run_until_complete(
            run_process_document(proc, worker, exc)
        )
        failed = failed_payloads(publishes)
        assert len(failed) == 1
        details = failed[0]

        assert details["error_message"] == "embedding provider timed out"
        assert details["stage"] == "embeddings_complete"
        assert details["retryable"] is True  # httpx.ConnectTimeout classifies transient

    def test_failure_before_first_stage_reports_safe_processing_stage(self):
        worker = get_worker_main()
        proc = make_processor(worker)
        exc = ValueError("Document res1 not found at path users/user1/resources/res1")
        proc._validate_processing_request = raise_always_factory(exc)

        _, publishes = asyncio.get_event_loop().run_until_complete(
            run_process_document(proc, worker, exc)
        )
        failed = failed_payloads(publishes)
        assert len(failed) == 1
        details = failed[0]

        assert details["stage"] == "processing"
        assert details["error_message"].startswith("Document res1 not found")

    def test_failed_payload_key_set_is_pinned(self):
        """Drift guard: the failure payload's key set is part of the contract.

        Adding or removing a key must fail the build (per the Definition:
        'Adding a key later means touching the test, which is the point').
        """
        worker = get_worker_main()
        proc = make_processor(worker)
        exc = worker.PermanentError("invalid document checksum")
        proc._get_extracted_text = raise_always_factory(exc)

        _, publishes = asyncio.get_event_loop().run_until_complete(
            run_process_document(proc, worker, exc)
        )
        details = failed_payloads(publishes)[0]
        assert set(details.keys()) == WORKER_PAYLOAD_KEYS, (
            f"failure payload key set drifted: {sorted(details.keys())}"
        )

    def test_stage_values_come_from_progress_vocabulary(self):
        worker = get_worker_main()
        proc = make_processor(worker)

        for exc, expected_stage in [
            (worker.TransientError("t"), "text_retrieved"),
            (worker.PermanentError("p"), "text_retrieved"),
        ]:
            proc._get_extracted_text = raise_always_factory(exc)
            _, publishes = asyncio.get_event_loop().run_until_complete(
                run_process_document(proc, worker, exc)
            )
            stage = failed_payloads(publishes)[0]["stage"]
            assert stage in PROGRESS_STAGE_VOCABULARY, (
                f"stage {stage!r} is outside the progress-stage vocabulary"
            )
            assert stage == expected_stage


def raise_always_factory(exc):
    async def _raise(*args, **kwargs):
        raise exc
    return _raise


# ---------------------------------------------------------------------------
# retryable derivation (aligned with classify_error / ACK-NACK behavior)
# ---------------------------------------------------------------------------

class TestRetryableDerivation:
    @pytest.mark.parametrize(
        "exc_kind,expected_retryable",
        [
            ("transient", True),
            ("permanent", False),
            ("unclassified", False),  # conservative default for unknown errors
        ],
    )
    def test_retryable_matches_classify_error(self, exc_kind, expected_retryable):
        worker = get_worker_main()
        proc = make_processor(worker)

        exc = {
            "transient": worker.TransientError("rate limited, back off"),
            "permanent": worker.PermanentError("malformed document"),
            "unclassified": ValueError("some unrecognized failure"),
        }[exc_kind]

        # The derivation must agree with the worker's own classification,
        # which drives ACK/NACK in run_worker.
        assert worker.classify_error(exc) is expected_retryable

        proc._get_extracted_text = raise_always_factory(exc)
        _, publishes = asyncio.get_event_loop().run_until_complete(
            run_process_document(proc, worker, exc)
        )
        details = failed_payloads(publishes)[0]
        assert details["retryable"] is expected_retryable, (
            f"{exc_kind} error must persist retryable={expected_retryable}"
        )
        # retryable must be explicitly present — never left for rag-api's
        # details.get("retryable", True) fallback to fabricate.
        assert "retryable" in details


# ---------------------------------------------------------------------------
# rag-api side: failed-branch persistence of the worker's payload
# ---------------------------------------------------------------------------

def run_failed_branch(rag_api_main, monkeypatch, details, current_status="processing"):
    """Run the real run_transactional_update failed branch against fakes."""
    fake_fs = _fake_firestore_module()
    monkeypatch.setattr(rag_api_main, "firestore", fake_fs)

    db = FakeDB()
    doc_ref = FakeDocRef(
        "users/user1/resources/res1",
        {"status": current_status, "userId": "user1"},
    )
    transaction = db.transaction()
    rag_api_main.run_transactional_update(
        db, doc_ref, "failed", details, MagicMock(), "user1"
    )
    return transaction, doc_ref


class TestApiFailedBranchPersistence:
    def test_transient_failure_persists_worker_values_unchanged(self, monkeypatch):
        rag_api_main = get_rag_api_main()
        details = {
            "error": "upstream text service unavailable",
            "error_message": "upstream text service unavailable",
            "stage": "text_retrieved",
            "retryable": True,
        }
        transaction, doc_ref = run_failed_branch(rag_api_main, monkeypatch, details)

        assert len(transaction.updates) == 1, "failed branch must update the main doc"
        main_update = transaction.updates[0][1]
        assert main_update["error"] == "upstream text service unavailable"
        assert main_update["error_stage"] == "text_retrieved"
        assert main_update["retryable"] is True
        assert main_update["status"] == "failed"

    def test_permanent_failure_persists_retryable_false(self, monkeypatch):
        rag_api_main = get_rag_api_main()
        details = {
            "error": "malformed document",
            "error_message": "malformed document",
            "stage": "chunking_complete",
            "retryable": False,
        }
        transaction, _ = run_failed_branch(rag_api_main, monkeypatch, details)

        main_update = transaction.updates[0][1]
        assert main_update["error"] == "malformed document"
        assert main_update["error_stage"] == "chunking_complete"
        assert main_update["retryable"] is False

    def test_api_fallback_defaults_are_not_operative(self, monkeypatch):
        """The worker's actual values must win — never 'Processing failed',
        never a null stage, never the silent retryable=True default."""
        rag_api_main = get_rag_api_main()
        details = {
            "error": "embedding provider timed out",
            "error_message": "embedding provider timed out",
            "stage": "embeddings_complete",
            "retryable": False,
        }
        transaction, _ = run_failed_branch(rag_api_main, monkeypatch, details)

        main_update = transaction.updates[0][1]
        assert main_update["error"] != "Processing failed"
        assert main_update["error"] == "embedding provider timed out"
        assert main_update["error_stage"] is not None
        assert main_update["error_stage"] == "embeddings_complete"
        assert main_update["retryable"] is False

    def test_summary_error_subdocument_carries_same_message_and_stage(self, monkeypatch):
        rag_api_main = get_rag_api_main()
        details = {
            "error": "upstream text service unavailable",
            "error_message": "upstream text service unavailable",
            "stage": "text_retrieved",
            "retryable": True,
        }
        transaction, doc_ref = run_failed_branch(rag_api_main, monkeypatch, details)

        summary_sets = [
            (ref, data) for (ref, data, merge) in transaction.sets
            if ref.path.endswith("processing/summary")
        ]
        assert len(summary_sets) == 1, "failed branch must write processing/summary"
        _, summary_update = summary_sets[0]

        assert summary_update["stage"] == "text_retrieved"
        error = summary_update["error"]
        assert error["message"] == "upstream text service unavailable"
        assert error["stage"] == "text_retrieved"
        # No structured error-code taxonomy: code stays the "UNKNOWN" default
        # unless a code is actually sent.
        assert error["code"] == "UNKNOWN"

    def test_end_to_end_worker_payload_through_api_failed_branch(self, monkeypatch):
        """Full seam: worker-built failure payload → rag-api persistence.
        Persisted error/error_stage/retryable must equal the worker's values."""
        worker = get_worker_main()
        rag_api_main = get_rag_api_main()

        proc = make_processor(worker)
        exc = worker.TransientError("weaviate service unreachable")
        proc._get_extracted_text = raise_always_factory(exc)
        _, publishes = asyncio.get_event_loop().run_until_complete(
            run_process_document(proc, worker, exc)
        )
        details = failed_payloads(publishes)[0]

        transaction, _ = run_failed_branch(rag_api_main, monkeypatch, details)
        main_update = transaction.updates[0][1]

        assert main_update["error"] == details["error_message"]
        assert main_update["error_stage"] == details["stage"]
        assert main_update["retryable"] == details["retryable"]


# ---------------------------------------------------------------------------
# Static drift guards (AST-based, house pattern from test_api_contracts.py)
# ---------------------------------------------------------------------------

def _parse(path):
    with open(path) as f:
        return ast.parse(f.read())


def _dict_literal_keys(tree):
    keys = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for k in node.keys:
                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                    keys.add(k.value)
    return keys


def _details_get_keys(tree):
    """String constants passed as the first arg of details.get(...) calls."""
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


class TestStaticDriftGuards:
    def test_worker_publishes_failure_payload_with_contract_keys_ast_guard(self):
        """The worker source must contain a failure-payload dict literal with
        error_message, stage, retryable (and the legacy error key)."""
        tree = _parse(_WORKER_MAIN_PATH)
        keys = _dict_literal_keys(tree)
        required = {"error", "error_message", "stage", "retryable"}
        missing = required - keys
        assert not missing, (
            "rag-worker failure payload no longer publishes required keys; "
            f"missing from dict literals: {missing}"
        )

    def test_rag_api_failed_branch_reads_worker_keys_ast_guard(self):
        """rag-api's failed branch must read error_message, stage, and
        retryable from the payload details — the contract it persists."""
        rag_api_main_path = os.path.join(_RAG_API_DIR, "main.py")
        tree = _parse(rag_api_main_path)
        keys = _details_get_keys(tree)
        required = {"error_message", "stage", "retryable"}
        missing = required - keys
        assert not missing, (
            "rag-api failed branch no longer reads the worker's contract keys; "
            f"missing details.get() keys: {missing}"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>