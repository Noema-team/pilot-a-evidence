I've reviewed the worker publisher, rag-api's failed branch, and the existing test infrastructure. Now writing the contract test file.

Key design decisions:
- **Import both sides, don't restate the contract**: load `rag-worker-service/main.py` under a private module name (using the worker's own conftest stubs) and rag-api's `run_transactional_update` (already importable via the integration conftest).
- **Drive the real code paths**: failures injected into `process_document`'s pipeline steps; captured `failed` details fed verbatim into `run_transactional_update` against a fake Firestore transaction.
- **AST drift guard** following the existing static-contract pattern in `test_api_contracts.py`.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""Worker → rag-api failure-payload contract test.

Contract under test (definition wi-define-108-a8):

  A failed RAG processing job must persist the worker's ACTUAL error message,
  the failing pipeline stage, and a deliberately derived retryable flag.

Seam being pinned:

  rag-worker  process_document() exception handler
      → publishes status "failed" with details carrying
        error_message / stage / retryable (plus the legacy `error` key)
  rag-api     run_transactional_update() failed branch
      → persists main doc  error ← error_message, error_stage ← stage,
        retryable ← retryable
      → writes processing/summary error subdoc with the same message/stage

The test imports BOTH sides rather than restating the contract in a fixture:
the worker's failure payload is built by driving the real `process_document`
code path with injected failures, then fed verbatim through rag-api's
`run_transactional_update` against a fake Firestore transaction. Static
AST drift guards fail the build if either side's payload keys change.

These tests are derived from the requirements only. Until the worker aligns
its payload (error_message/stage/retryable) and adds stage tracking, the
functional tests FAIL — that is the point: they encode the target contract.
"""
import ast
import asyncio
import importlib.util
import os
import sys
import types
from unittest.mock import AsyncMock

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
WORKER_DIR = os.path.join(AI_SERVER_DIR, "rag-worker-service")
WORKER_TESTS_DIR = os.path.join(WORKER_DIR, "tests")
WORKER_MAIN_PATH = os.path.join(WORKER_DIR, "main.py")
API_MAIN_PATH = os.path.join(AI_SERVER_DIR, "rag-api-service", "main.py")

# Stage vocabulary the worker already publishes in progress updates. Failure
# stages must reuse these names (with "processing" as the safe unknown value,
# matching the stale-lease sweep's error_stage).
STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "completed",
}
UNKNOWN_STAGE = "processing"

REQUIRED_FAILURE_KEYS = {"error_message", "stage", "retryable"}
LEGACY_FAILURE_KEY = "error"  # retained for unknown consumers of the topic


# --------------------------------------------------------------------------
# Worker module loading
# --------------------------------------------------------------------------

def _apply_worker_test_stubs():
    """Execute the worker service's own tests/conftest.py so its third-party
    stubs (openai, firebase_admin, pubsub, tiktoken, tenacity, ...) and env
    defaults are in place before rag-worker's main.py is imported."""
    for name in ["sklearn", "sklearn.feature_extraction",
                 "sklearn.feature_extraction.text"]:
        if name not in sys.modules:
            try:
                __import__(name)
            except Exception:
                sys.modules[name] = types.ModuleType(name)
    sys.modules["sklearn.feature_extraction.text"].TfidfVectorizer = object

    stub_path = os.path.join(WORKER_TESTS_DIR, "conftest.py")
    spec = importlib.util.spec_from_file_location(
        "rag_worker_contract_test_stubs", stub_path
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)


_worker_main = None


def _load_worker_main():
    """Import rag-worker's main.py under a private module name so it never
    collides with rag-api's `main` in this pytest session."""
    global _worker_main
    if _worker_main is not None:
        return _worker_main
    _apply_worker_test_stubs()
    spec = importlib.util.spec_from_file_location(
        "rag_worker_main_under_test", WORKER_MAIN_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    _worker_main = mod
    return mod


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------

class StatusRecorder:
    """Stands in for EnhancedDocumentProcessor._publish_status_update and
    records every (status, details) the pipeline publishes."""

    def __init__(self):
        self.calls = []

    async def __call__(self, user_id, course_id, resource_id, status,
                       details, job_id=None):
        self.calls.append(
            {"status": status, "details": details, "job_id": job_id}
        )

    def failed_details(self):
        failed = [c for c in self.calls if c["status"] == "failed"]
        assert failed, "worker never published a 'failed' status update"
        return failed[-1]["details"]


class _WorkerDocRef:
    def __init__(self):
        self.updates = []

    def update(self, data):
        self.updates.append(data)


class _WorkerDb:
    def __init__(self):
        self.ref = _WorkerDocRef()

    def document(self, path):
        return self.ref


def _make_processor(worker_main, recorder, *, text_error=None,
                    store_error=None):
    """Build an EnhancedDocumentProcessor without running __init__ (which
    would touch real Firebase/Pub/Sub), then stub every pipeline step with
    fakes. Only the failure-payload construction under test is real code."""
    proc = object.__new__(worker_main.EnhancedDocumentProcessor)
    proc.config = types.SimpleNamespace(
        summary_prompt_version=1,
        summary_max_chars=5000,
        summary_model="test-model",
        embedding_model="text-embedding-3-small",
    )
    proc.langfuse = None
    proc.db = _WorkerDb()
    proc.content_tagger = types.SimpleNamespace(
        generate_tags=AsyncMock(return_value=(["tag1"], {"tag1": 0.9}))
    )
    proc._publish_status_update = recorder
    proc._validate_processing_request = AsyncMock()

    if text_error is not None:
        proc._get_extracted_text = AsyncMock(side_effect=text_error)
    else:
        proc._get_extracted_text = AsyncMock(
            return_value=("extracted text", {"title": "Test Doc"})
        )

    proc.generate_document_summary = AsyncMock(
        return_value={"overview": "o", "bulletPoints": ["b"]}
    )
    proc._get_document_path = lambda *a, **k: "users/u1/resources/r1"
    proc._create_enhanced_chunks = AsyncMock(return_value=[])
    proc._generate_embeddings_with_openrouter = AsyncMock(return_value=[])
    proc.delete_old_vectors_via_service = AsyncMock(return_value=0)
    if store_error is not None:
        proc.store_chunks_via_service = AsyncMock(side_effect=store_error)
    else:
        proc.store_chunks_via_service = AsyncMock(
            return_value={"successful_inserts": 0, "failed_inserts": 0}
        )
    proc._save_processing_metadata_to_subcollection = AsyncMock()
    proc._update_user_usage = AsyncMock()
    proc._generate_resource_map = AsyncMock()
    return proc


async def _run_and_capture_failure(worker_main, **kwargs):
    recorder = StatusRecorder()
    proc = _make_processor(worker_main, recorder, **kwargs)
    metrics = await proc.process_document("u1", "c1", "r1", "job-1")
    details = recorder.failed_details()
    return details, metrics


# --------------------------------------------------------------------------
# rag-api failed-branch harness
# --------------------------------------------------------------------------

class _ApiSnap:
    def __init__(self, data):
        self._data = data
        self.exists = True

    def to_dict(self):
        return dict(self._data)


class _ApiTx:
    def __init__(self, doc_state):
        self._doc = dict(doc_state)
        self.updates = []
        self.sets = []

    def get(self, ref, transaction=None):
        return _ApiSnap(self._doc)

    def update(self, ref, data):
        self._doc.update(data)
        self.updates.append(data)

    def set(self, ref, data, merge=None):
        self.sets.append((ref, data))


class _ApiSummaryRef:
    def __init__(self, tx):
        self._tx = tx

    def __repr__(self):  # stable identity for recording
        return "processing/summary"


class _ApiDocRef:
    def __init__(self, tx):
        self._tx = tx
        self.id = "r1"

    def get(self, transaction=None):
        return self._tx.get(self, transaction=transaction)

    def collection(self, name):
        assert name == "processing"
        return types.SimpleNamespace(
            document=lambda doc_id: _ApiSummaryRef(self._tx)
            if doc_id == "summary" else object()
        )


class _ApiDb:
    def __init__(self, doc_state):
        self.tx = _ApiTx(doc_state)

    def transaction(self):
        return self.tx


@pytest.fixture
def rag_api_main():
    import main as rag_api_main  # provided by tests/integration/conftest.py
    return rag_api_main


def _persist_failure(rag_api_main, details, monkeypatch,
                     current_status="processing"):
    """Feed a worker failure payload through rag-api's failed branch and
    return the fake tx (persisted writes) plus the main-doc state."""
    monkeypatch.setattr(
        rag_api_main.firestore, "SERVER_TIMESTAMP", "SERVER_TIMESTAMP",
        raising=False,
    )
    monkeypatch.setattr(
        rag_api_main.firestore, "transactional",
        lambda fn: fn, raising=False,
    )
    db = _ApiDb({"status": current_status})
    doc_ref = _ApiDocRef(db.tx)
    rag_api_main.run_transactional_update(
        db, doc_ref, "failed", details, _NullLogger(), "u1"
    )
    return db


class _NullLogger:
    def warning(self, *a, **k):
        pass

    def info(self, *a, **k):
        pass

    def error(self, *a, **k):
        pass


# --------------------------------------------------------------------------
# Worker failure payload construction (functional)
# --------------------------------------------------------------------------

class TestWorkerFailurePayload:
    @pytest.fixture(scope="class")
    def worker_main(self):
        return _load_worker_main()

    @pytest.mark.asyncio
    async def test_transient_failure_payload_has_full_contract(
        self, worker_main
    ):
        """A transient failure must publish error_message (the actual
        exception message), stage, and an explicitly derived retryable=True.
        None of these may be left for rag-api's fallback defaults."""
        details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=worker_main.TransientError("embedding service timeout"),
        )
        assert details["error_message"] == "embedding service timeout"
        assert details["retryable"] is True
        assert isinstance(details["stage"], str) and details["stage"]
        # The legacy key is retained for unknown consumers of the topic.
        assert details["error"] == "embedding service timeout"

    @pytest.mark.asyncio
    async def test_permanent_failure_payload_derives_retryable_false(
        self, worker_main
    ):
        """PermanentError classifies as permanent → retryable must be
        explicitly False, not the silent API-side default True."""
        details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=worker_main.PermanentError("document not found at path"),
        )
        assert details["error_message"] == "document not found at path"
        assert details["retryable"] is False

    @pytest.mark.asyncio
    async def test_unclassified_unknown_error_derives_retryable_false(
        self, worker_main
    ):
        """classify_error's conservative default treats unknown exceptions as
        permanent → retryable False. This is a deliberate behavior change
        from the old silent default (True) and must stay aligned with the
        worker's ACK/NACK decision for the same exception."""
        details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=ValueError("PDF extraction resulted in empty text"),
        )
        assert details["retryable"] is False
        # The worker's own ACK/NACK classification must agree with the
        # published retryable flag — one source of truth.
        assert worker_main.classify_error(
            ValueError("PDF extraction resulted in empty text")
        ) is False

    @pytest.mark.asyncio
    async def test_retryable_matches_ack_nack_classification_transient(
        self, worker_main
    ):
        """Same alignment for transient errors: ConnectionError classifies
        transient (Pub/Sub will redeliver) → retryable True."""
        err = ConnectionError("connection reset by peer")
        details, _ = await _run_and_capture_failure(
            worker_main, text_error=err
        )
        assert worker_main.classify_error(err) is True
        assert details["retryable"] is True

    @pytest.mark.asyncio
    async def test_stage_tracks_early_pipeline_failure(self, worker_main):
        """A failure during text retrieval must report a stage from the
        existing progress-stage vocabulary (or the safe 'processing' value)
        — never None and never a fabricated name outside the vocabulary."""
        details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=worker_main.TransientError("storage download failed"),
        )
        assert details["stage"] in STAGE_VOCABULARY | {UNKNOWN_STAGE}

    @pytest.mark.asyncio
    async def test_stage_tracks_late_pipeline_failure(self, worker_main):
        """A failure after embeddings completed (during vector storage) must
        report the last tracked stage, 'embeddings_complete' — proving the
        tracker advanced past the early stages instead of staying at the
        initial value."""
        details, _ = await _run_and_capture_failure(
            worker_main,
            store_error=RuntimeError(
                "partial vector write: 3/5 chunks stored, 2 failed"
            ),
        )
        assert details["stage"] == "embeddings_complete"
        assert details["error_message"] == (
            "partial vector write: 3/5 chunks stored, 2 failed"
        )

    @pytest.mark.asyncio
    async def test_stage_falls_back_to_processing_when_genuinely_unknown(
        self, worker_main
    ):
        """A failure before any pipeline step (e.g. validation) has no
        tracked stage — the safe value 'processing' must be used so
        error_stage never regresses to null."""
        details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=None,
        )
        # Force a pre-pipeline failure: validation raises before any stage
        # tracker update could happen.
        recorder = StatusRecorder()
        proc = _make_processor(worker_main, recorder)
        proc._validate_processing_request = AsyncMock(
            side_effect=PermissionError("user u1 does not own document r1")
        )
        await proc.process_document("u1", "c1", "r1", "job-1")
        details = recorder.failed_details()
        assert details["stage"] == UNKNOWN_STAGE
        assert details["error_message"] == "user u1 does not own document r1"

    @pytest.mark.asyncio
    async def test_payload_never_relies_on_api_fallbacks(self, worker_main):
        """The contract's core regression: before the fix every worker
        failure carried only {'error': ...}, so rag-api persisted the
        fallback 'Processing failed', error_stage None, retryable True.
        All three keys must now be present with real values."""
        details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=worker_main.TransientError("rate limited by openrouter"),
        )
        assert REQUIRED_FAILURE_KEYS <= set(details.keys()), (
            f"worker failure payload missing contract keys: "
            f"missing={REQUIRED_FAILURE_KEYS - set(details.keys())}"
        )
        assert details["error_message"] != "Processing failed"
        assert details["stage"] is not None

    @pytest.mark.asyncio
    async def test_job_id_still_attached_to_failure_payload(
        self, worker_main
    ):
        """The publisher attaches jobId to details; the failure path must
        not lose it (clients correlate failures to upload jobs by it)."""
        details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=worker_main.TransientError("boom"),
        )
        assert details["jobId"] == "job-1"


# --------------------------------------------------------------------------
# rag-api failed-branch persistence fed by the worker's payload
# --------------------------------------------------------------------------

class TestWorkerToApiPersistenceContract:
    @pytest.fixture(scope="class")
    def worker_main(self):
        return _load_worker_main()

    @pytest.mark.asyncio
    async def test_transient_failure_persists_worker_values_end_to_end(
        self, worker_main, rag_api_main, monkeypatch
    ):
        """The full seam: build the payload through the worker's real failure
        path, persist it through rag-api's real failed branch, and assert the
        persisted error/error_stage/retryable EQUAL the worker's values."""
        worker_details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=worker_main.TransientError("embedding service timeout"),
        )
        db = _persist_failure(rag_api_main, worker_details, monkeypatch)

        main_doc = db.tx._doc
        assert main_doc["status"] == "failed"
        assert main_doc["error"] == "embedding service timeout", (
            "persisted error must be the worker's actual message, "
            "not the 'Processing failed' fallback"
        )
        assert main_doc["error_stage"] == worker_details["stage"], (
            "persisted error_stage must be the worker's failing stage, "
            "not None"
        )
        assert main_doc["retryable"] is True

        # processing/summary error subdocument carries the same message and
        # stage as the main document.
        summary_writes = [data for _, data in db.tx.sets]
        assert summary_writes, "failed branch must write the summary subdoc"
        err = summary_writes[-1]["error"]
        assert err["message"] == "embedding service timeout"
        assert err["stage"] == worker_details["stage"]
        assert err["code"] == "UNKNOWN"  # no error-code taxonomy in this fix

    @pytest.mark.asyncio
    async def test_permanent_failure_persists_retryable_false(
        self, worker_main, rag_api_main, monkeypatch
    ):
        """A permanent failure must persist retryable=False — the old silent
        default (True) fabricated retryability for permanent errors."""
        worker_details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=worker_main.PermanentError("invalid storage URL"),
        )
        db = _persist_failure(rag_api_main, worker_details, monkeypatch)
        assert db.tx._doc["retryable"] is False
        assert db.tx._doc["error"] == "invalid storage URL"
        assert db.tx._doc["error_stage"] == worker_details["stage"]

    @pytest.mark.asyncio
    async def test_api_persists_unchanged_worker_values_no_mutation(
        self, worker_main, rag_api_main, monkeypatch
    ):
        """The failed branch must persist the worker-provided values
        UNCHANGED — it is a pass-through, not a re-derivation point."""
        worker_details, _ = await _run_and_capture_failure(
            worker_main,
            text_error=worker_main.TransientError("429 from openrouter"),
        )
        db = _persist_failure(rag_api_main, worker_details, monkeypatch)
        assert db.tx._doc["error"] == worker_details["error_message"]
        assert db.tx._doc["error_stage"] == worker_details["stage"]
        assert db.tx._doc["retryable"] == worker_details["retryable"]


# --------------------------------------------------------------------------
# Static drift guards (AST-based, following test_api_contracts.py's pattern)
# --------------------------------------------------------------------------

def _worker_source():
    with open(WORKER_MAIN_PATH) as f:
        return f.read()


def _api_source():
    with open(API_MAIN_PATH) as f:
        return f.read()


def _process_document_except_handler_keys(source):
    """String keys of every dict literal inside process_document's except
    handler — where the failed status payload is constructed."""
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) \
                and node.name == "process_document":
            for sub in ast.walk(node):
                if isinstance(sub, ast.ExceptHandler):
                    keys = set()
                    for n in ast.walk(sub):
                        if isinstance(n, ast.Dict):
                            keys |= {
                                k.value for k in n.keys
                                if isinstance(k, ast.Constant)
                            }
                    return keys
    return set()


def _except_handler_calls_classify_error(source):
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) \
                and node.name == "process_document":
            for sub in ast.walk(node):
                if isinstance(sub, ast.ExceptHandler):
                    for n in ast.walk(sub):
                        if isinstance(n, ast.Call):
                            fn = n.func
                            name = getattr(fn, "id", None) or \
                                getattr(fn, "attr", None)
                            if name == "classify_error":
                                return True
    return False


def _failed_branch_detail_keys(source):
    """Keys read via details.get(...) inside run_transactional_update's
    `new_status == "failed"` branches."""
    tree = ast.parse(source)
    keys = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) \
                and node.name == "run_transactional_update":
            for sub in ast.walk(node):
                if isinstance(sub, ast.If):
                    has_failed = any(
                        isinstance(c, ast.Constant) and c.value == "failed"
                        for c in ast.walk(sub.test)
                    )
                    if not has_failed:
                        continue
                    for n in ast.walk(sub):
                        if isinstance(n, ast.Call) \
                                and isinstance(n.func, ast.Attribute) \
                                and n.func.attr == "get" and n.args \
                                and isinstance(n.args[0], ast.Constant):
                            keys.add(n.args[0].value)
    return keys


def _progress_stage_names(source):
    """Stage values published by process_document's progress updates."""
    tree = ast.parse(source)
    stages = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) \
                and node.name == "process_document":
            for sub in ast.walk(node):
                if isinstance(sub, ast.Dict):
                    for k, v in zip(sub.keys, sub.values):
                        if isinstance(k, ast.Constant) and k.value == "stage" \
                                and isinstance(v, ast.Constant):
                            stages.add(v.value)
    return stages


class TestFailurePayloadKeyDriftGuard:
    """Fail the build if either side's payload keys drift. Adding a key
    later means touching this test — that is the drift guard doing its job."""

    def test_worker_failure_payload_publishes_required_keys(self):
        keys = _process_document_except_handler_keys(_worker_source())
        missing = REQUIRED_FAILURE_KEYS - keys
        assert not missing, (
            "rag-worker's failure payload no longer publishes required "
            f"keys {missing} — the worker→rag-api contract is broken"
        )

    def test_worker_retains_legacy_error_key(self):
        keys = _process_document_except_handler_keys(_worker_source())
        assert LEGACY_FAILURE_KEY in keys, (
            "the legacy 'error' key was dropped from the worker's failure "
            "payload — unknown consumers of the status topic depend on it"
        )

    def test_api_failed_branch_reads_matching_keys(self):
        keys = _failed_branch_detail_keys(_api_source())
        missing = REQUIRED_FAILURE_KEYS - keys
        assert not missing, (
            "rag-api's failed branch no longer reads required keys "
            f"{missing} — the worker→rag-api contract is broken"
        )

    def test_worker_derives_retryable_via_classify_error(self):
        assert _except_handler_calls_classify_error(_worker_source()), (
            "the worker's failure handler must derive retryable from "
            "classify_error() so the persisted flag matches the ACK/NACK "
            "behavior for the same exception"
        )

    def test_failure_stages_reuse_progress_stage_vocabulary(self):
        stages = _progress_stage_names(_worker_source())
        missing = STAGE_VOCABULARY - stages
        assert not missing, (
            f"process_document no longer publishes stage names {missing} — "
            "failure stages must reuse the existing progress vocabulary"
        )

    def test_worker_and_api_key_sets_are_aligned(self):
        worker_keys = _process_document_except_handler_keys(_worker_source())
        api_keys = _failed_branch_detail_keys(_api_source())
        unread = REQUIRED_FAILURE_KEYS - api_keys
        unpublished = REQUIRED_FAILURE_KEYS - worker_keys
        assert not unread and not unpublished, (
            f"key drift between worker publisher and api consumer: "
            f"worker missing={unpublished}, api missing={unread}"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>