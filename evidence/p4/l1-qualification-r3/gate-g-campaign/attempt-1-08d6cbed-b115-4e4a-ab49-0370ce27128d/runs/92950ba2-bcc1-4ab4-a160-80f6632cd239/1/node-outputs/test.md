I've reviewed the worker's `process_document` failure handler, rag-api's `run_transactional_update` failed branch, the existing contract-test patterns, and the conftest mocking infrastructure. Now I'll write the contract tests derived from the Definition's requirements.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""
Contract test: rag-worker → rag-api failure payload.

Requirements under test (Definition wi-define-108-a8):

1. When document processing fails, the worker's failed status payload must
   include `error_message` (the actual exception message), `stage` (the
   pipeline stage executing at failure time), and `retryable` (deliberately
   derived) — the payload must never rely on rag-api's fallback defaults for
   these keys.
2. The worker must track the currently executing pipeline stage through
   process_document; stage names reuse the existing progress-stage vocabulary
   (starting, text_retrieved, tagging_complete, summary_generated,
   chunking_complete, embeddings_complete), with "processing" as the safe
   value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged:
   main document error ← error_message, error_stage ← stage, retryable ←
   retryable; the processing/summary error subdocument carries the same
   message and stage (error_code stays "UNKNOWN" unless sent).
4. retryable derivation is explicit and aligned with the worker's ACK/NACK
   behavior: classify_error transient → true, permanent/unknown → false.
5. The legacy `error` key is retained alongside `error_message` for
   continuity with existing consumers of the status topic.

The test exercises BOTH sides of the seam rather than restating the contract:
the worker's failure payload is built by actually running process_document
with a stubbed pipeline that fails at a chosen stage (in a subprocess with
the worker's heavy dependencies mocked, following the house pattern in
test_api_contracts.py), and the produced payload is fed through rag-api's
real run_transactional_update against in-memory Firestore fakes.

These tests are written from the requirements, not the current implementation:
before the fix, the worker publishes only {"error": str(e)}, so the payload
shape, stage, and retryable assertions all fail — that is the drift guard
doing its job.
"""

import ast
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

import main as rag_api_main

AI_SERVER = Path(__file__).resolve().parents[2]
WORKER_MAIN = AI_SERVER / "rag-worker-service" / "main.py"
API_MAIN = AI_SERVER / "rag-api-service" / "main.py"

ALLOWED_STAGES = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "processing",  # safe value when the stage is genuinely unknown
}

REQUIRED_FAILURE_KEYS = {"error_message", "stage", "retryable"}
LEGACY_KEY = "error"


# ========================================
# Worker-side harness (subprocess)
# ========================================

WORKER_HARNESS = r'''
"""Runs process_document with a stubbed pipeline and dumps the failure payloads.

Imported only inside a subprocess so the worker module's heavy top-level
imports (langchain, marker, firebase, pubsub, ...) never load in the pytest
process. Everything the failure path needs is real worker code: process_document,
classify_error, the exception classes.
"""
import asyncio
import json
import os
import sys
import types

os.environ.setdefault("GCP_PROJECT", "test-project")
os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-creds.json")
os.environ.setdefault("RAG_PROCESS_SUB", "vector-process-sub")
os.environ.setdefault("RAG_STATUS_TOPIC", "rag-status-updates")
os.environ.setdefault("SHARED_INTERNAL_TOKEN", "test-token")


def _module(name, **attrs):
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


# --- mock the heavy third-party imports at the top of worker main.py ---

class _StubLogger:
    def info(self, *a, **k): pass
    def error(self, *a, **k): pass
    def warning(self, *a, **k): pass
    def debug(self, *a, **k): pass
    def bind(self, **k): return self

structlog = _module("structlog", configure=lambda **k: None, get_logger=lambda **k: _StubLogger())

# httpx: prefer the real one (classify_error isinstance-checks its exception
# types); fall back to stand-in exception classes if it is not installed.
try:
    import httpx  # noqa: F401
except ImportError:
    class _E(Exception):
        pass
    httpx = _module(
        "httpx",
        ConnectError=_E, ConnectTimeout=_E, ReadTimeout=_E, WriteTimeout=_E,
        PoolTimeout=_E, HTTPStatusError=_E, RequestError=_E,
        AsyncClient=lambda **k: None,
    )
    sys.modules["httpx"] = httpx

class _APIError(Exception):
    pass

openai = _module("openai", APIError=_APIError, APIConnectionError=_APIError, AsyncOpenAI=lambda **k: None)
langchain = _module("langchain")
langchain.text_splitter = _module("langchain.text_splitter", RecursiveCharacterTextSplitter=lambda **k: None)
langchain.schema = _module("langchain.schema", Document=object)
langfuse = _module("langfuse", Langfuse=lambda **k: None)
spacy = _module("spacy")

sklearn = _module("sklearn")
sklearn.feature_extraction = _module("sklearn.feature_extraction")
sklearn.feature_extraction.text = _module(
    "sklearn.feature_extraction.text", TfidfVectorizer=lambda **k: None
)

tiktoken = _module("tiktoken", get_encoding=lambda name: types.SimpleNamespace(encode=lambda s: []))

def _retry_identity(**kwargs):
    def deco(fn):
        return fn
    return deco
tenacity = _module(
    "tenacity",
    retry=_retry_identity,
    stop_after_attempt=lambda n: None,
    wait_exponential=lambda **k: None,
)

try:
    import pydantic  # noqa: F401
except ImportError:
    pydantic = _module(
        "pydantic",
        field_validator=lambda *a, **k: (lambda fn: fn),
        Field=lambda *a, **k: None,
        ConfigDict=lambda **k: {},
    )
    sys.modules["pydantic"] = pydantic
pydantic_settings = _module("pydantic_settings", BaseSettings=object)

# --- firebase / google.cloud mocks (the failure path never touches them) ---

firebase_admin = _module("firebase_admin", _apps={})
firebase_admin.firestore = _module("firebase_admin.firestore", SERVER_TIMESTAMP="SERVER_TIMESTAMP")
firebase_admin.storage = _module("firebase_admin.storage")
firebase_admin.credentials = _module("firebase_admin.credentials", Certificate=lambda p: None)
firebase_admin.auth = _module("firebase_admin.auth")

google = _module("google")
google.cloud = _module("google.cloud")
google.cloud.pubsub_v1 = _module(
    "google.cloud.pubsub_v1", PublisherClient=lambda **k: None, SubscriberClient=lambda **k: None
)
google.cloud.storage = _module("google.cloud.storage", Client=lambda **k: None)
google.cloud.firestore_v1 = _module("google.cloud.firestore_v1")
google.cloud.firestore_v1.base_query = _module(
    "google.cloud.firestore_v1.base_query", FieldFilter=lambda *a, **k: None
)
google.oauth2 = _module("google.oauth2")
google.oauth2.service_account = _module(
    "google.oauth2.service_account", Credentials=types.SimpleNamespace(
        from_service_account_file=lambda p: None)
)
google.auth = _module("google.auth")
google.auth.credentials = _module("google.auth.credentials", AnonymousCredentials=object)

# --- load the worker module ---

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__) if "__file__" in dir() else ".", "")))
sys.path.insert(0, sys.argv[1])
import main as worker  # noqa: E402


class _Recorder:
    def __init__(self):
        self.published = []

    async def publish(self, user_id, course_id, resource_id, status, details, job_id=None):
        self.published.append({"status": status, "details": dict(details)})


def _make_processor(recorder, fail_at):
    """Build a processor via object.__new__ (no __init__ / no cloud clients)
    and stub the pipeline so it fails at the requested stage."""
    proc = object.__new__(worker.EnhancedDocumentProcessor)
    proc.langfuse = None
    proc.embedding_cost_per_token = 0.0
    proc.config = types.SimpleNamespace(summary_prompt_version=1, summary_max_chars=5000,
                                        summary_model="m")
    proc.db = types.SimpleNamespace(document=lambda path: types.SimpleNamespace(update=lambda d: None))

    async def fake_publish(user_id, course_id, resource_id, status, details, job_id=None):
        recorder.published.append({"status": status, "details": dict(details)})

    proc._publish_status_update = fake_publish

    async def noop_validate(user_id, course_id, resource_id):
        pass

    proc._validate_processing_request = noop_validate

    if fail_at == "text_retrieval":
        async def get_text(user_id, course_id, resource_id):
            raise worker.TransientError("storage unavailable during text extraction")
        proc._get_extracted_text = get_text
    else:
        async def get_text(user_id, course_id, resource_id):
            return "markdown body", {"title": "t", "filename": "f.pdf"}
        proc._get_extracted_text = get_text

        class _Tagger:
            async def generate_tags(self, text, metadata):
                return [], {}
        proc.content_tagger = _Tagger()

        async def fake_summary(text, title):
            return None
        proc.generate_document_summary = fake_summary

        def doc_path(user_id, course_id, resource_id):
            return f"users/{user_id}/resources/{resource_id}"
        proc._get_document_path = doc_path

        async def fake_chunks(text, metadata, tags, user_id, course_id, resource_id):
            return []
        proc._create_enhanced_chunks = fake_chunks

        if fail_at == "embeddings":
            async def embed(chunks):
                raise worker.PermanentError("embedding provider rejected the request")
            proc._generate_embeddings_with_openrouter = embed

    return proc


def run_scenario(name, fail_at, exc_type_name):
    recorder = _Recorder()
    proc = _make_processor(recorder, fail_at)
    try:
        asyncio.run(proc.process_document("user-1", "__ungrouped__", "res-1", job_id=None))
    except Exception as e:  # process_document must swallow pipeline errors
        return {"error": "process_document raised: %r" % e}
    failures = [p for p in recorder.published if p["status"] == "failed"]
    if not failures:
        return {"error": "no failed status published"}
    exc = worker.TransientError("x") if exc_type_name == "TransientError" else worker.PermanentError("x")
    return {
        "failure": failures[-1],
        "classify_error": worker.classify_error(exc),
    }


out = {
    "early_transient": run_scenario("early_transient", "text_retrieval", "TransientError"),
    "late_permanent": run_scenario("late_permanent", "embeddings", "PermanentError"),
}
print("<<<WORKER_HARNESS_RESULT>>>")
print(json.dumps(out))
'''

HARNESS_MARKER = "<<<WORKER_HARNESS_RESULT>>>"
_HARNESS_CACHE = None


def _run_worker_harness():
    """Run the worker harness in a subprocess (worker deps stay mocked there)
    and cache the parsed result."""
    global _HARNESS_CACHE
    if _HARNESS_CACHE is not None:
        return _HARNESS_CACHE
    result = subprocess.run(
        [sys.executable, "-", str(WORKER_MAIN.parent)],
        input=WORKER_HARNESS,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "worker harness subprocess failed:\nSTDOUT:\n%s\nSTDERR:\n%s"
            % (result.stdout, result.stderr)
        )
    stdout = result.stdout
    marker_idx = stdout.find(HARNESS_MARKER)
    assert marker_idx != -1, "harness did not print result marker; stdout:\n%s" % stdout
    payload = stdout[marker_idx + len(HARNESS_MARKER):].strip()
    _HARNESS_CACHE = json.loads(payload.splitlines()[0])
    return _HARNESS_CACHE


# ========================================
# rag-api fakes for run_transactional_update
# ========================================

class FakeSnapshot:
    def __init__(self, data):
        self._data = data
        self.exists = True

    def to_dict(self):
        return dict(self._data)


class FakeDocRef:
    def __init__(self, path, store):
        self.path = path
        self.id = path.split("/")[-1]
        self._store = store

    def get(self, transaction=None):
        return FakeSnapshot(self._store.setdefault(self.path, {}))

    def collection(self, name):
        return FakeCollectionRef(f"{self.path}/{name}", self._store)

    def update(self, data):
        self._store.setdefault(self.path, {}).update(data)


class FakeCollectionRef:
    def __init__(self, base, store):
        self._base = base
        self._store = store

    def document(self, doc_id):
        return FakeDocRef(f"{self._base}/{doc_id}", self._store)


class FakeTransaction:
    def __init__(self, store):
        self._store = store

    def update(self, ref, data):
        self._store.setdefault(ref.path, {}).update(data)

    def set(self, ref, data, merge=False):
        if merge:
            self._store.setdefault(ref.path, {}).update(data)
        else:
            self._store[ref.path] = dict(data)


class FakeDb:
    def __init__(self):
        self.store = {}

    def document(self, path):
        return FakeDocRef(path, self.store)

    def transaction(self):
        return FakeTransaction(self.store)


@pytest.fixture
def api_update():
    """run_transactional_update with the @firestore.transactional decorator
    neutralized (the conftest mocks firebase_admin.firestore) and a fake db."""
    rag_api_main.firestore.transactional = lambda fn: fn
    db = FakeDb()

    def _call(doc_path, new_status, details):
        doc_ref = db.document(doc_path)
        db.store[doc_path] = {"status": "processing", "userId": "user-1"}
        rag_api_main.run_transactional_update(
            db, doc_ref, new_status, details, rag_api_main.logger, "user-1"
        )
        return db.store

    return _call


# ========================================
# Dynamic contract tests
# ========================================

class TestWorkerFailurePayload:
    """Requirement 1, 2, 4, 5: the worker's failed status payload."""

    @pytest.fixture(scope="class")
    def scenarios(self):
        return _run_worker_harness()

    def test_process_document_swallows_pipeline_errors(self, scenarios):
        for name, result in scenarios.items():
            assert "error" not in result, (
                f"scenario {name}: process_document must not raise through the "
                f"failure handler — {result.get('error')}"
            )

    def test_failure_payload_carries_required_keys(self, scenarios):
        for name, result in scenarios.items():
            details = result["failure"]["details"]
            missing = REQUIRED_FAILURE_KEYS - set(details)
            assert not missing, (
                f"scenario {name}: worker failure payload missing required keys "
                f"{missing}; payload was {sorted(details)} — rag-api's fallback "
                f"defaults must never be the operative mechanism for worker failures"
            )

    def test_failure_payload_error_message_is_actual_exception_message(self, scenarios):
        early = scenarios["early_transient"]["failure"]["details"]
        assert early["error_message"] == "storage unavailable during text extraction", (
            "error_message must carry the worker's actual exception message, "
            f"got {early.get('error_message')!r} (the rag-api fallback is "
            f"'Processing failed' — that string must never appear)"
        )
        late = scenarios["late_permanent"]["failure"]["details"]
        assert late["error_message"] == "embedding provider rejected the request"

    def test_failure_payload_never_contains_fallback_string(self, scenarios):
        for name, result in scenarios.items():
            details = result["failure"]["details"]
            assert details.get("error_message") != "Processing failed"
            assert details.get("error") != "Processing failed"

    def test_failure_payload_stage_is_from_progress_vocabulary(self, scenarios):
        for name, result in scenarios.items():
            stage = result["failure"]["details"].get("stage")
            assert stage in ALLOWED_STAGES, (
                f"scenario {name}: failure stage {stage!r} must reuse the existing "
                f"progress-stage vocabulary (or 'processing' when genuinely unknown); "
                f"allowed: {sorted(ALLOWED_STAGES)}"
            )

    def test_stage_tracker_reports_true_failing_stage(self, scenarios):
        # Early failure: the pipeline died during text extraction — the stage
        # must not be the terminal/unknown value.
        early_stage = scenarios["early_transient"]["failure"]["details"]["stage"]
        assert early_stage not in ("processing",), (
            "early-stage failure reported the unknown-stage fallback 'processing' — "
            "the stage tracker is not being set before the pipeline steps"
        )
        # Late failure: the pipeline got past chunking, so the reported stage
        # must differ from the early failure's stage (representative coverage
        # of the update-before-await convention).
        late_stage = scenarios["late_permanent"]["failure"]["details"]["stage"]
        assert late_stage != early_stage, (
            f"early failure ({early_stage!r}) and late failure ({late_stage!r}) "
            "report the same stage — the stage tracker is not advancing with the pipeline"
        )

    def test_retryable_is_explicitly_derived_from_classify_error(self, scenarios):
        for name, result in scenarios.items():
            details = result["failure"]["details"]
            assert "retryable" in details, (
                f"scenario {name}: retryable must be sent explicitly by the worker"
            )
            assert details["retryable"] is result["classify_error"], (
                f"scenario {name}: retryable ({details['retryable']!r}) must equal "
                f"classify_error's verdict ({result['classify_error']!r}) — transient "
                f"maps to true, permanent (including unclassified-unknown) to false"
            )

    def test_transient_error_is_retryable_true(self, scenarios):
        assert scenarios["early_transient"]["failure"]["details"]["retryable"] is True

    def test_permanent_error_is_retryable_false(self, scenarios):
        assert scenarios["late_permanent"]["failure"]["details"]["retryable"] is False

    def test_legacy_error_key_retained_alongside_error_message(self, scenarios):
        for name, result in scenarios.items():
            details = result["failure"]["details"]
            assert LEGACY_KEY in details, (
                f"scenario {name}: the legacy '{LEGACY_KEY}' key must be retained "
                f"alongside error_message for continuity with existing consumers "
                f"of the status topic"
            )
            assert details[LEGACY_KEY] == details["error_message"], (
                f"scenario {name}: legacy 'error' and 'error_message' must agree"
            )

    def test_failure_payload_key_set_is_exact(self, scenarios):
        """Drift guard: the payload's key set is pinned. Adding a key later
        means touching this test — that is the point."""
        expected = REQUIRED_FAILURE_KEYS | {LEGACY_KEY}
        for name, result in scenarios.items():
            actual = set(result["failure"]["details"])
            assert actual == expected, (
                f"scenario {name}: failure payload keys drifted — "
                f"expected {sorted(expected)}, got {sorted(actual)}"
            )


class TestWorkerToApiFailurePersistence:
    """Requirement 3: rag-api's failed branch persists the worker's values
    unchanged, and the processing/summary error subdocument matches."""

    @pytest.fixture(scope="class")
    def scenarios(self):
        return _run_worker_harness()

    def _persist(self, api_update, details):
        return api_update("users/user-1/resources/res-1", "failed", details)

    def test_main_doc_persists_worker_values_unchanged(self, api_update, scenarios):
        for name, result in scenarios.items():
            details = result["failure"]["details"]
            store = self._persist(api_update, details)
            doc = store["users/user-1/resources/res-1"]
            assert doc["error"] == details["error_message"], (
                f"scenario {name}: persisted error must equal the worker's "
                f"error_message, got {doc['error']!r}"
            )
            assert doc["error_stage"] == details["stage"], (
                f"scenario {name}: persisted error_stage must equal the worker's "
                f"stage, got {doc['error_stage']!r} (must never be None)"
            )
            assert doc["retryable"] == details["retryable"], (
                f"scenario {name}: persisted retryable must equal the worker's "
                f"derived value, got {doc['retryable']!r}"
            )
            assert doc["status"] == "failed"

    def test_persisted_error_is_not_the_fallback_string(self, api_update, scenarios):
        store = self._persist(
            api_update, scenarios["early_transient"]["failure"]["details"]
        )
        assert store["users/user-1/resources/res-1"]["error"] != "Processing failed"

    def test_persisted_error_stage_is_not_none(self, api_update, scenarios):
        store = self._persist(
            api_update, scenarios["early_transient"]["failure"]["details"]
        )
        assert store["users/user-1/resources/res-1"]["error_stage"] is not None

    def test_processing_summary_subdocument_carries_same_message_and_stage(
        self, api_update, scenarios
    ):
        for name, result in scenarios.items():
            details = result["failure"]["details"]
            store = self._persist(api_update, details)
            summary = store["users/user-1/resources/res-1/processing/summary"]
            assert "error" in summary, (
                f"scenario {name}: processing/summary must carry an error subdocument"
            )
            err = summary["error"]
            assert err["message"] == details["error_message"], (
                f"scenario {name}: summary error.message must equal the worker's "
                f"error_message, got {err.get('message')!r}"
            )
            assert err["stage"] == details["stage"], (
                f"scenario {name}: summary error.stage must equal the worker's "
                f"stage, got {err.get('stage')!r}"
            )
            assert err["code"] == "UNKNOWN", (
                "summary error.code stays 'UNKNOWN' unless a code is actually sent"
            )

    def test_no_firestore_migration_required(self, api_update, scenarios):
        """Constraint: persisted field names keep their names and semantics —
        error/error_stage/retryable on the main doc, message/stage/code in the
        summary error subdocument."""
        store = self._persist(
            api_update, scenarios["late_permanent"]["failure"]["details"]
        )
        doc = store["users/user-1/resources/res-1"]
        assert set(doc) >= {"error", "error_stage", "retryable", "status"}
        summary_err = store["users/user-1/resources/res-1/processing/summary"]["error"]
        assert set(summary_err) == {"code", "message", "stage"}


# ========================================
# Static AST drift guards
# ========================================

def _worker_source():
    return WORKER_MAIN.read_text()


def _api_source():
    return API_MAIN.read_text()


def _dict_key_sets_in_function(tree, function_name):
    """All string-keyed dict literals inside the named function."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == function_name:
            for sub in ast.walk(node):
                if isinstance(sub, ast.Dict):
                    keys = {
                        k.value for k in sub.keys if isinstance(k, ast.Constant)
                    }
                    if keys:
                        found.append(keys)
    return found


def _get_calls_in_function(tree, function_name):
    calls = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == function_name:
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call):
                    calls.append(sub)
    return calls


class TestWorkerFailureHandlerSourceContract:
    """AST guard on the worker: the failure handler must build the full
    payload and derive retryable via classify_error."""

    def test_process_document_failure_dict_has_required_keys(self):
        tree = ast.parse(_worker_source())
        dicts = _dict_key_sets_in_function(tree, "process_document")
        matching = [d for d in dicts if REQUIRED_FAILURE_KEYS.issubset(d)]
        assert matching, (
            "process_document contains no dict literal carrying "
            f"{sorted(REQUIRED_FAILURE_KEYS)} — the failure payload is missing "
            "required keys (worker is publishing the stale one-key payload)"
        )

    def test_process_document_failure_dict_retains_legacy_error_key(self):
        tree = ast.parse(_worker_source())
        dicts = _dict_key_sets_in_function(tree, "process_document")
        matching = [d for d in dicts if REQUIRED_FAILURE_KEYS.issubset(d)]
        assert matching and all(LEGACY_KEY in d for d in matching), (
            "the worker's failure payload dict must retain the legacy 'error' key"
        )

    def test_process_document_uses_classify_error_for_retryable(self):
        tree = ast.parse(_worker_source())
        calls = _get_calls_in_function(tree, "process_document")
        uses_classify = any(
            isinstance(c.func, ast.Name) and c.func.id == "classify_error"
            for c in calls
        )
        assert uses_classify, (
            "process_document must derive retryable via classify_error so the "
            "payload agrees with the worker's ACK/NACK behavior"
        )

    def test_progress_stage_vocabulary_unchanged(self):
        """The failure stage names must reuse the existing progress vocabulary —
        guard that the progress publishes still use those stage names."""
        tree = ast.parse(_worker_source())
        stages = set()
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.keyword)
                and node.arg == "details"
                and isinstance(node.value, ast.Dict)
            ):
                for k, v in zip(node.value.keys, node.value.values):
                    if (
                        isinstance(k, ast.Constant)
                        and k.value == "stage"
                        and isinstance(v, ast.Constant)
                    ):
                        stages.add(v.value)
        assert {
            "starting", "text_retrieved", "tagging_complete",
            "summary_generated", "chunking_complete", "embeddings_complete",
        }.issubset(stages), (
            f"worker progress stage vocabulary drifted; found {sorted(stages)}"
        )


class TestApiFailedBranchSourceContract:
    """AST guard on rag-api: the failed branch must keep reading exactly the
    worker's keys and persisting them under the established names."""

    def _failed_branch_sources(self):
        tree = ast.parse(_api_source())
        snippets = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "update_logic":
                snippets.append(ast.get_source_segment(_api_source(), node) or "")
        return snippets

    def test_failed_branch_reads_worker_keys(self):
        tree = ast.parse(_api_source())
        keys_read = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "update_logic":
                for sub in ast.walk(node):
                    if (
                        isinstance(sub, ast.Call)
                        and isinstance(sub.func, ast.Attribute)
                        and sub.func.attr == "get"
                        and sub.args
                        and isinstance(sub.args[0], ast.Constant)
                    ):
                        keys_read.add(sub.args[0].value)
        missing = REQUIRED_FAILURE_KEYS - keys_read
        assert not missing, (
            f"rag-api failed branch no longer reads worker keys: missing {missing} — "
            "the two sides of the seam have drifted"
        )

    def test_failed_branch_persists_established_field_names(self):
        source = _api_source()
        for field in ("error", "error_stage", "retryable"):
            assert f'"{field}"' in source, (
                f"rag-api must keep persisting '{field}' — the established "
                "failure schema (no migration/rename allowed)"
            )

    def test_failed_branch_summary_error_subdocument_shape(self):
        tree = ast.parse(_api_source())
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "update_logic":
                for sub in ast.walk(node):
                    if (
                        isinstance(sub, ast.Dict)
                        and any(
                            isinstance(k, ast.Constant) and k.value == "code"
                            for k in sub.keys
                        )
                    ):
                        keys = {
                            k.value for k in sub.keys if isinstance(k, ast.Constant)
                        }
                        assert keys == {"code", "message", "stage"}, (
                            f"summary error subdocument shape drifted: {sorted(keys)}"
                        )
                        return
        pytest.fail("failed branch no longer writes a summary error subdocument")
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>