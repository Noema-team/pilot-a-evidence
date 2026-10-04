I've reviewed the worker's `process_document` failure handler, rag-api's `run_transactional_update` failed branch, `classify_error`, and the existing contract-test patterns. Now writing the contract tests, derived strictly from the Definition's requirements: worker payload keys (`error_message`/`stage`/`retryable`, legacy `error` retained), stage tracking with the progress-stage vocabulary, retryable derived from `classify_error`, rag-api persisting values unchanged, an end-to-end worker→rag-api persistence assertion, and AST key-drift guards on both sides.

The tests are written so they fail against the current code (worker publishes only `{"error": ...}`) and pass once the worker aligns to the contract — they exercise the real `process_document` exception path and the real `run_transactional_update` failed branch via fakes, plus AST drift guards on both sources.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""
Worker → rag-api failure payload contract tests.

Scope (from definition wi-define-108-a8): a failed RAG processing job must
publish a failure payload carrying error_message (the actual exception
message), stage (the failing pipeline stage), and retryable (deliberately
derived from classify_error) — and rag-api's failed branch must persist those
values unchanged as error / error_stage / retryable on the main document, with
the same message and stage in the processing/summary error subdocument.

These tests are derived from the requirements, not the implementation:
- They drive the real `process_document` exception handler (with the pipeline
  steps mocked) and the real `run_transactional_update` failed branch (with a
  fake Firestore transaction), and assert the seam between them.
- AST drift guards fail the build if either side's payload keys change.

They intentionally FAIL against the current code, where the worker publishes
only {"error": str(e)} and rag-api falls back to "Processing failed" / None /
True.
"""

import ast
import asyncio
import importlib.util
import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# ---------------------------------------------------------------------------
# Environment + module mocking (mirrors tests/integration/conftest.py, plus
# the heavy ML dependencies the rag-worker imports at module scope).
# ---------------------------------------------------------------------------

os.environ.setdefault("GCP_PROJECT", "test-project")
os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-creds.json")
os.environ.setdefault("SHARED_INTERNAL_TOKEN", "test-token")
os.environ.setdefault("FIREBASE_STORAGE_BUCKET", "test-bucket")
os.environ.setdefault("FIREBASE_PROJECT_ID", "test-project")
os.environ.setdefault("OPENROUTER_API_KEY", "test-key")
os.environ.setdefault("OPENROUTER_BASE_URL", "http://test-openrouter")
os.environ.setdefault("OPENROUTER_MODEL", "test-model")
os.environ.setdefault("RAG_PROCESS_SUB", "test-sub")
os.environ.setdefault("RAG_STATUS_TOPIC", "test-status-topic")
os.environ.setdefault("WEAVIATE_SERVICE_URL", "http://test-weaviate:8002")

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.normpath(os.path.join(TESTS_DIR, "..", ".."))
RAG_API_DIR = os.path.join(AI_SERVER_DIR, "rag-api-service")
RAG_WORKER_DIR = os.path.join(AI_SERVER_DIR, "rag-worker-service")
RAG_API_MAIN_PATH = os.path.join(RAG_API_DIR, "main.py")
RAG_WORKER_MAIN_PATH = os.path.join(RAG_WORKER_DIR, "main.py")

if RAG_API_DIR not in sys.path:
    sys.path.insert(0, RAG_API_DIR)

# Cloud SDK mocks are installed by conftest.py. Add the worker's heavy
# module-scope imports here so the worker module can be loaded hermetically.
_HEAVY_MOCKS = [
    "langchain",
    "langchain.text_splitter",
    "langchain.schema",
    "openai",
    "langfuse",
    "tiktoken",
    "spacy",
    "sklearn",
    "sklearn.feature_extraction",
    "sklearn.feature_extraction.text",
]
for _mod in _HEAVY_MOCKS:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

# tenacity must be a pass-through decorator, not a MagicMock: the worker
# applies @retry(...) at class-definition time, and a MagicMock decorator
# would replace the decorated methods with non-callable mocks.
if "tenacity" not in sys.modules:
    _tenacity = MagicMock()
    _tenacity.retry = lambda **kwargs: (lambda fn: fn)
    _tenacity.stop_after_attempt = MagicMock()
    _tenacity.wait_exponential = MagicMock()
    sys.modules["tenacity"] = _tenacity


def _load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def rag_api_main():
    return _load_module("rag_api_failure_contract_main", RAG_API_MAIN_PATH)


@pytest.fixture(scope="module")
def rag_worker_main():
    return _load_module("rag_worker_failure_contract_main", RAG_WORKER_MAIN_PATH)


# ---------------------------------------------------------------------------
# Fake Firestore plumbing for run_transactional_update's failed branch.
# ---------------------------------------------------------------------------

class FakeSnapshot:
    def __init__(self, data):
        self._data = data
        self.exists = True

    def to_dict(self):
        return dict(self._data)


class FakeTransaction:
    def __init__(self):
        self.updates = []
        self.sets = []

    def update(self, doc_ref, data):
        self.updates.append((doc_ref, data))

    def set(self, doc_ref, data, merge=False):
        self.sets.append((doc_ref, data, merge))


class FakeSummaryRef:
    def __init__(self):
        self.sets = []

    def set(self, data, merge=False):
        self.sets.append((data, merge))


class FakeDocRef:
    def __init__(self, data, doc_id="resource-1"):
        self._data = data
        self.id = doc_id
        self.path = f"users/user1/resources/{doc_id}"
        self.summary_ref = FakeSummaryRef()

    def get(self, transaction=None):
        return FakeSnapshot(self._data)

    def collection(self, name):
        assert name == "processing"
        return self

    def document(self, name):
        assert name == "summary"
        return self.summary_ref


class FakeDb:
    def transaction(self):
        return FakeTransaction()


@pytest.fixture
def firestore_env(rag_api_main):
    """Make the (mocked) firebase_admin.firestore module behave enough like
    the real one for run_transactional_update to execute its body."""
    fs = sys.modules["firebase_admin"].firestore
    original = {k: getattr(fs, k, None) for k in ("transactional", "SERVER_TIMESTAMP")}
    fs.transactional = lambda fn: fn  # execute the transactional body directly
    fs.SERVER_TIMESTAMP = "SERVER_TIMESTAMP"
    yield fs
    for k, v in original.items():
        if v is not None:
            setattr(fs, k, v)


def run_failed_branch(rag_api_main, details, current_status="processing"):
    db = FakeDb()
    doc_ref = FakeDocRef({"status": current_status})
    rag_api_main.run_transactional_update(
        db, doc_ref, "failed", details, MagicMock(), "user1"
    )
    transaction = db.transaction()
    assert transaction.updates, "failed branch must update the main document"
    main_update = transaction.updates[-1][1]
    assert doc_ref.summary_ref.sets, "failed branch must write processing/summary"
    summary_update = doc_ref.summary_ref.sets[-1][0]
    return main_update, summary_update


# ---------------------------------------------------------------------------
# Worker failure-payload harness: drive the real process_document exception
# handler with the pipeline steps stubbed.
# ---------------------------------------------------------------------------

ALLOWED_STAGES = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "completed",
    "processing",  # safe value when the stage is genuinely unknown
}


class StatusRecorder:
    """Records _publish_status_update calls: (status, details)."""

    def __init__(self):
        self.calls = []

    async def __call__(self, user_id, course_id, resource_id, status, details, job_id=None):
        self.calls.append((status, dict(details)))

    def failed_payloads(self):
        return [details for status, details in self.calls if status == "failed"]


def make_processor(rag_worker_main, monkeypatch, failing_step=None, error=None):
    """Build a processor via __new__ (bypassing the heavy __init__) and stub
    the pipeline around the real process_document body."""
    proc = object.__new__(rag_worker_main.EnhancedDocumentProcessor)
    proc.logger = MagicMock()
    proc.langfuse = None
    proc.db = MagicMock()
    proc.config = MagicMock()
    proc._get_document_path = lambda user_id, course_id, resource_id: (
        "users/user1/resources/resource-1"
    )

    recorder = StatusRecorder()
    monkeypatch.setattr(proc, "_publish_status_update", recorder)

    async def validate_ok(self, user_id, course_id, resource_id):
        pass

    async def text_ok(self, user_id, course_id, resource_id):
        return "some extracted text", {"title": "T", "filename": "f.pdf"}

    async def tags_ok(self, text, metadata):
        return [], {}

    async def summary_ok(self, text, title):
        return {"overview": "o", "bulletPoints": []}

    async def fail(self, *args, **kwargs):
        raise error

    monkeypatch.setattr(proc, "_validate_processing_request", validate_ok.__get__(proc))
    monkeypatch.setattr(proc, "_get_extracted_text", text_ok.__get__(proc))
    monkeypatch.setattr(proc, "generate_document_summary", summary_ok.__get__(proc))
    monkeypatch.setattr(proc.content_tagger if hasattr(proc, "content_tagger") else proc,
                        "generate_tags", tags_ok, raising=False)
    # content_tagger is an attribute the real __init__ sets; provide a stub.
    proc.content_tagger = MagicMock()
    proc.content_tagger.generate_tags = AsyncMock(return_value=([], {}))

    if failing_step is not None:
        monkeypatch.setattr(proc, failing_step, fail.__get__(proc))

    return proc, recorder


def run_process(proc, rag_worker_main):
    return asyncio.run(
        proc.process_document("user1", "__ungrouped__", "resource-1", job_id="job-1")
    )


# ---------------------------------------------------------------------------
# Worker-side: failure payload construction (process_document exception path)
# ---------------------------------------------------------------------------

class TestWorkerFailurePayloadKeys:
    def test_early_failure_payload_carries_required_keys(self, rag_worker_main, monkeypatch):
        """Requirement: the failed payload must include error_message, stage,
        and retryable — never relying on rag-api's fallback defaults."""
        proc, recorder = make_processor(
            rag_worker_main, monkeypatch,
            failing_step="_get_extracted_text",
            error=ValueError("boom during extraction"),
        )
        run_process(proc, rag_worker_main)
        payloads = recorder.failed_payloads()
        assert payloads, "worker must publish a failed status update"
        details = payloads[0]
        assert details.get("error_message") == "boom during extraction"
        assert "stage" in details, "failure payload must carry the failing stage"
        assert "retryable" in details, "failure payload must carry retryable explicitly"

    def test_legacy_error_key_retained_for_unknown_consumers(self, rag_worker_main, monkeypatch):
        """Preferred hedge: the legacy `error` key stays alongside error_message."""
        proc, recorder = make_processor(
            rag_worker_main, monkeypatch,
            failing_step="_get_extracted_text",
            error=ValueError("boom"),
        )
        run_process(proc, rag_worker_main)
        details = recorder.failed_payloads()[0]
        assert details.get("error") == "boom"


class TestWorkerRetryableDerivation:
    def test_transient_error_is_retryable_true(self, rag_worker_main, monkeypatch):
        proc, recorder = make_processor(
            rag_worker_main, monkeypatch,
            failing_step="_get_extracted_text",
            error=rag_worker_main.TransientError("temporarily unavailable"),
        )
        run_process(proc, rag_worker_main)
        assert recorder.failed_payloads()[0]["retryable"] is True

    def test_permanent_error_is_retryable_false(self, rag_worker_main, monkeypatch):
        proc, recorder = make_processor(
            rag_worker_main, monkeypatch,
            failing_step="_get_extracted_text",
            error=ValueError("invalid document"),
        )
        run_process(proc, rag_worker_main)
        assert recorder.failed_payloads()[0]["retryable"] is False

    def test_unclassified_unknown_error_is_retryable_false(self, rag_worker_main, monkeypatch):
        """classify_error's conservative default: unknown → permanent → False.
        (Deliberate behavior change from the silent True default.)"""
        proc, recorder = make_processor(
            rag_worker_main, monkeypatch,
            failing_step="_get_extracted_text",
            error=RuntimeError("something unexpected"),
        )
        run_process(proc, rag_worker_main)
        assert recorder.failed_payloads()[0]["retryable"] is False

    def test_retryable_matches_classify_error(self, rag_worker_main, monkeypatch):
        for exc, expected in [
            (rag_worker_main.TransientError("t"), True),
            (rag_worker_main.PermanentError("p"), False),
            (ValueError("v"), False),
            (httpx_connect_error := _make_connect_error(), True),
        ]:
            proc, recorder = make_processor(
                rag_worker_main, monkeypatch,
                failing_step="_get_extracted_text", error=exc,
            )
            run_process(proc, rag_worker_main)
            derived = recorder.failed_payloads()[0]["retryable"]
            assert derived == expected, f"{type(exc).__name__}: derived {derived}, classify says {expected}"
            assert derived == rag_worker_main.classify_error(exc)


def _make_connect_error():
    import httpx
    return httpx.ConnectError("connection refused")


class TestWorkerStageTracking:
    def test_late_stage_failure_reports_executing_stage(self, rag_worker_main, monkeypatch):
        """The tracker must be set before each pipeline step: a failure during
        chunking must report the chunking stage, not None and not 'starting'."""
        proc, recorder = make_processor(
            rag_worker_main, monkeypatch,
            failing_step="_create_enhanced_chunks",
            error=RuntimeError("chunker exploded"),
        )
        run_process(proc, rag_worker_main)
        details = recorder.failed_payloads()[0]
        assert details["stage"] == "chunking_complete"

    def test_failure_before_first_transition_reports_safe_stage(self, rag_worker_main, monkeypatch):
        """When the stage is genuinely unknown the safe value is 'processing'
        (same value the stale-lease sweep uses) — never None/missing."""
        proc, recorder = make_processor(
            rag_worker_main, monkeypatch,
            failing_step="_validate_processing_request",
            error=ValueError("Document resource-1 not found"),
        )
        run_process(proc, rag_worker_main)
        details = recorder.failed_payloads()[0]
        assert details["stage"] == "processing"

    def test_stage_uses_existing_progress_vocabulary(self, rag_worker_main, monkeypatch):
        proc, recorder = make_processor(
            rag_worker_main, monkeypatch,
            failing_step="_create_enhanced_chunks",
            error=RuntimeError("x"),
        )
        run_process(proc, rag_worker_main)
        assert recorder.failed_payloads()[0]["stage"] in ALLOWED_STAGES


# ---------------------------------------------------------------------------
# rag-api side: failed branch persists worker values unchanged
# ---------------------------------------------------------------------------

class TestRagApiFailedBranchPersistence:
    def test_persists_worker_values_unchanged(self, rag_api_main, firestore_env):
        details = {
            "error_message": "chunker exploded",
            "stage": "chunking_complete",
            "retryable": False,
        }
        main_update, summary_update = run_failed_branch(rag_api_main, details)
        assert main_update["error"] == "chunker exploded"
        assert main_update["error_stage"] == "chunking_complete"
        assert main_update["retryable"] is False

    def test_summary_subdoc_carries_same_message_and_stage(self, rag_api_main, firestore_env):
        details = {
            "error_message": "embedding service timed out",
            "stage": "embeddings_complete",
            "retryable": True,
        }
        _, summary_update = run_failed_branch(rag_api_main, details)
        err = summary_update["error"]
        assert err["message"] == "embedding service timed out"
        assert err["stage"] == "embeddings_complete"

    def test_error_code_defaults_to_unknown(self, rag_api_main, firestore_env):
        details = {"error_message": "m", "stage": "s", "retryable": True}
        _, summary_update = run_failed_branch(rag_api_main, details)
        assert summary_update["error"]["code"] == "UNKNOWN"

    def test_stage_never_persists_as_none_for_worker_failures(self, rag_api_main, firestore_env):
        """The contract: worker failures must not regress error_stage to None.
        (With the aligned payload the API never falls back.)"""
        details = {"error_message": "m", "stage": "text_retrieved", "retryable": True}
        main_update, _ = run_failed_branch(rag_api_main, details)
        assert main_update["error_stage"] == "text_retrieved"


# ---------------------------------------------------------------------------
# End-to-end seam: worker payload → rag-api persistence
# ---------------------------------------------------------------------------

class TestWorkerToApiFailurePath:
    @pytest.mark.parametrize("exc,stage", [
        ("transient", "text_retrieved"),
        ("permanent", "chunking_complete"),
    ])
    def test_persisted_record_equals_worker_payload(self, rag_worker_main, rag_api_main,
                                                    monkeypatch, firestore_env, exc, stage):
        """The core contract test: exercise the worker's failure-payload
        construction, feed it through rag-api's failed branch, and assert the
        persisted error / error_stage / retryable equal the worker's values."""
        error = {
            "transient": rag_worker_main.TransientError("upstream 503"),
            "permanent": ValueError("malformed document"),
        }[exc]

        proc, recorder = make_processor(
            rag_worker_main, monkeypatch,
            failing_step="_create_enhanced_chunks" if stage == "chunking_complete"
            else "_get_extracted_text",
            error=error,
        )
        run_process(proc, rag_worker_main)
        details = recorder.failed_payloads()[0]

        main_update, summary_update = run_failed_branch(rag_api_main, details)

        assert main_update["error"] == details["error_message"]
        assert main_update["error_stage"] == details["stage"]
        assert main_update["retryable"] == details["retryable"]
        assert summary_update["error"]["message"] == details["error_message"]
        assert summary_update["error"]["stage"] == details["stage"]

        # The persisted error must be the worker's actual message — never the
        # "Processing failed" fallback.
        assert main_update["error"] != "Processing failed"
        assert main_update["error_stage"] is not None


# ---------------------------------------------------------------------------
# Drift guards: payload keys pinned in both sources via AST
# ---------------------------------------------------------------------------

def _module_ast(path):
    with open(path) as f:
        return ast.parse(f.read())


def _failure_handler_dict_keys(module_ast):
    """Keys of dict literals inside process_document's exception handler —
    where the failed status payload is constructed."""
    for node in ast.walk(module_ast):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "process_document":
            for sub in ast.walk(node):
                if isinstance(sub, ast.ExceptHandler):
                    keys = set()
                    for n in ast.walk(sub):
                        if isinstance(n, ast.Dict):
                            for k in n.keys:
                                if isinstance(k, ast.Constant):
                                    keys.add(k.value)
                    if keys:
                        yield keys


def _function_string_constants(module_ast, func_name):
    for node in ast.walk(module_ast):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            consts = set()
            for n in ast.walk(node):
                if isinstance(n, ast.Constant) and isinstance(n.value, str):
                    consts.add(n.value)
            return consts
    return set()


class TestPayloadKeyDriftGuard:
    def test_worker_failure_payload_keys_pinned(self):
        """A future edit that drops or renames the worker's failure-payload
        keys must fail the build."""
        tree = _module_ast(RAG_WORKER_MAIN_PATH)
        all_keys = set()
        for keys in _failure_handler_dict_keys(tree):
            all_keys |= keys
        required = {"error_message", "stage", "retryable"}
        missing = required - all_keys
        assert not missing, (
            f"worker failure payload is missing required keys {missing}; "
            "the worker→rag-api failure contract has drifted"
        )
        assert "error" in all_keys, "legacy `error` key must be retained for unknown consumers"

    def test_rag_api_failed_branch_reads_pinned_keys(self):
        """A future edit that renames the keys rag-api reads must fail the
        build."""
        tree = _module_ast(RAG_API_MAIN_PATH)
        consts = _function_string_constants(tree, "run_transactional_update")
        required = {"error_message", "stage", "retryable", "error_code"}
        missing = required - consts
        assert not missing, (
            f"rag-api failed branch no longer reads {missing}; "
            "the worker→rag-api failure contract has drifted"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>