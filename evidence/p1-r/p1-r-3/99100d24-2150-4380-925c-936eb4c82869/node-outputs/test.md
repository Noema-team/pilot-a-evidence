I've reviewed the worker, rag-api, conftest, and the existing contract-test patterns. Now I'll write the executable contract tests for the worker→rag-api failure payload seam.

Key design decisions, derived from the Definition only:
- **Worker side exercised dynamically**: import the worker module (heavy cloud deps mocked, `httpx`/`pydantic` real so `classify_error` behaves for real), build an `EnhancedDocumentProcessor` via `object.__new__` with stubbed pipeline steps, run `process_document`, and capture what the exception handler publishes — asserting `error_message` (actual message), `stage` (from the progress-stage vocabulary, tracked through the pipeline), and `retryable` (equal to `classify_error(e)`) are all present and correct, plus the retained legacy `error` key.
- **API side exercised dynamically**: `run_transactional_update` driven against an in-memory fake Firestore (real `transactional` passthrough + `SERVER_TIMESTAMP` sentinel installed before import), asserting persisted `error`/`error_stage`/`retryable` equal the worker's payload values and the `processing/summary` error subdocument carries the same message/stage with `code: "UNKNOWN"`.
- **Full seam test**: the captured worker failure payload is fed straight into rag-api's failed branch — the actual contract pin.
- **Drift guard (AST)**: rag-api's failed branch must read exactly `error_message`/`stage`/`retryable`; if either side's keys drift, the build fails.
- A fallback-documentation test pins the API's existing fallbacks so the worker tests can prove they are never relied upon.

These tests encode the target contract and will fail until the worker alignment lands — that is the drift guard doing its job.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_failure_payload_contract.py">>>
"""Worker → rag-api failure payload contract tests.

Contract under test (from the authoritative Definition):

1. When document processing fails, the worker's failed status payload must
   include:
     - ``error_message``: the actual exception message,
     - ``stage``: the pipeline stage executing at failure time, drawn from the
       existing progress-stage vocabulary (starting, text_retrieved,
       tagging_complete, summary_generated, chunking_complete,
       embeddings_complete) with "processing" as the safe unknown value,
     - ``retryable``: deliberately derived from ``classify_error`` —
       transient → True, permanent (including unclassified-unknown) → False,
   and must retain the legacy ``error`` key alongside ``error_message``.
   The payload must never rely on rag-api's fallback defaults.

2. rag-api's failed branch must persist the worker-provided values unchanged:
   main document ``error`` ← ``error_message``, ``error_stage`` ← ``stage``,
   ``retryable`` ← ``retryable``; the ``processing/summary`` error subdocument
   must carry the same message and stage (code stays "UNKNOWN" unless sent).

3. A drift guard: if either side's payload keys change, these tests fail.

The tests import BOTH sides rather than restating the contract in fixtures:
the worker's failure payload is built by running ``process_document`` with
stubbed pipeline steps, and the captured payload is fed through rag-api's
``run_transactional_update`` against an in-memory fake Firestore.
"""

import ast
import asyncio
import importlib.util
import json
import os
import sys
import types
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

# --------------------------------------------------------------------------
# Environment + module mocks (conftest covers rag-api's needs; the worker has
# a heavier dependency surface, mocked here. httpx and pydantic stay REAL so
# classify_error's isinstance heuristics behave exactly as in production).
# --------------------------------------------------------------------------

os.environ.setdefault("GCP_PROJECT", "test-project")
os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-creds.json")
os.environ.setdefault("SHARED_INTERNAL_TOKEN", "test-token")

APPS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RAG_API_DIR = os.path.join(APPS_DIR, "rag-api-service")
RAG_WORKER_DIR = os.path.join(APPS_DIR, "rag-worker-service")

if RAG_API_DIR not in sys.path:
    sys.path.insert(0, RAG_API_DIR)


def _mock_module(name):
    if name not in sys.modules:
        sys.modules[name] = MagicMock()


for _mod in [
    "firebase_admin",
    "firebase_admin.credentials",
    "firebase_admin.auth",
    "google",
    "google.cloud",
    "google.cloud.firestore",
    "google.cloud.firestore_v1",
    "google.cloud.pubsub_v1",
    "google.cloud.storage",
    "google.oauth2",
    "google.oauth2.service_account",
    "structlog",
    "spacy",
    "tiktoken",
    "langfuse",
    "langchain",
    "langchain.text_splitter",
    "langchain.schema",
    "sklearn",
    "sklearn.feature_extraction",
    "sklearn.feature_extraction.text",
    "openai",
]:
    _mock_module(_mod)

# tenacity must keep decorated async methods real callables.
if "tenacity" not in sys.modules or isinstance(sys.modules["tenacity"], MagicMock):
    _tenacity = types.ModuleType("tenacity")
    _tenacity.retry = lambda **kwargs: (lambda fn: fn)
    _tenacity.stop_after_attempt = lambda n: None
    _tenacity.wait_exponential = lambda **kwargs: None
    sys.modules["tenacity"] = _tenacity

# pydantic_settings must provide a real (inert) BaseSettings base class — a
# MagicMock instance cannot be subclassed.
if "pydantic_settings" not in sys.modules:
    _ps = types.ModuleType("pydantic_settings")
    _ps.BaseSettings = object
    sys.modules["pydantic_settings"] = _ps
elif isinstance(getattr(sys.modules["pydantic_settings"], "BaseSettings", None), MagicMock):
    _ps = sys.modules["pydantic_settings"]
    _ps.BaseSettings = object


# --------------------------------------------------------------------------
# Fake Firestore: just enough surface for rag-api's run_transactional_update
# (doc_ref.get/update, transaction.update/set, processing/summary subdoc).
# --------------------------------------------------------------------------

SERVER_TIMESTAMP = "<SERVER_TIMESTAMP>"


class FakeSnapshot:
    def __init__(self, ref):
        self._ref = ref

    @property
    def exists(self):
        return self._ref._data is not None

    def to_dict(self):
        return dict(self._ref._data) if self._ref._data is not None else None


class FakeDocRef:
    def __init__(self, store, path):
        self._store = store
        self.path = path
        self.id = path.split("/")[-1]
        self._store.setdefault(path, {})

    @property
    def _data(self):
        return self._store.get(self.path)

    def get(self, transaction=None):
        return FakeSnapshot(self)

    def update(self, data):
        self._data.update(data)

    def set(self, data, merge=False):
        if merge:
            self._data.update(data)
        else:
            self._store[self.path] = dict(data)

    def collection(self, name):
        return FakeCollectionRef(self._store, f"{self.path}/{name}")


class FakeCollectionRef:
    def __init__(self, store, prefix):
        self._store = store
        self._prefix = prefix

    def document(self, doc_id):
        return FakeDocRef(self._store, f"{self._prefix}/{doc_id}")


class FakeTransaction:
    def update(self, doc_ref, data):
        doc_ref.update(data)

    def set(self, doc_ref, data, merge=False):
        doc_ref.set(data, merge=merge)


class FakeDb:
    def __init__(self):
        self.store = {}

    def transaction(self):
        return FakeTransaction()

    def document(self, path):
        return FakeDocRef(self.store, path)


def _install_fake_firestore():
    """Install a fake firebase_admin.firestore with a real `transactional`
    passthrough so run_transactional_update's inner function actually runs
    (conftest's MagicMock firestore would silently no-op the decorator)."""
    fake = MagicMock()
    fake.transactional = lambda fn: fn
    fake.SERVER_TIMESTAMP = SERVER_TIMESTAMP
    sys.modules["firebase_admin.firestore"] = fake
    sys.modules["firebase_admin"].firestore = fake
    return fake


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_install_fake_firestore()

# Load rag-api main under a unique name (it has no side effects at import
# beyond config parsing; startup()/firebase init happen in the lifespan hook,
# which these tests never enter).
rag_api_main = _load_module("rag_api_failure_contract_main", os.path.join(RAG_API_DIR, "main.py"))

# Load the worker main under a unique name (its module-level Pub/Sub setup is
# harmless against the mocks; ProcessingConfig is never instantiated here).
worker_main = _load_module("rag_worker_failure_contract_main", os.path.join(RAG_WORKER_DIR, "main.py"))


# --------------------------------------------------------------------------
# Constants from the Definition
# --------------------------------------------------------------------------

PROGRESS_STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "completed",
}
SAFE_UNKNOWN_STAGE = "processing"
ALLOWED_FAILURE_STAGES = PROGRESS_STAGE_VOCABULARY | {SAFE_UNKNOWN_STAGE}

# Ordered for the early-vs-late stage-tracking assertions.
_STAGE_ORDER = [
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "completed",
]

REQUIRED_FAILURE_KEYS = {"error_message", "stage", "retryable"}
LEGACY_ERROR_KEY = "error"


# --------------------------------------------------------------------------
# Helpers: drive the worker's process_document with stubbed pipeline steps
# --------------------------------------------------------------------------

def _make_processor(failure_at=None, exception=None):
    """Build an EnhancedDocumentProcessor without running __init__ (which
    opens cloud clients) and stub every pipeline step. If `failure_at` names
    a step, that step raises `exception`; otherwise the pipeline completes."""
    proc = object.__new__(worker_main.EnhancedDocumentProcessor)
    proc.config = MagicMock()
    proc.config.summary_prompt_version = 1
    proc.config.summary_max_chars = 5000
    proc.config.summary_model = "test-model"
    proc.langfuse = None
    proc.logger = MagicMock()
    proc.db = FakeDb()

    published = []  # list of (status, details)

    async def capture_publish(user_id, course_id, resource_id, status, details, job_id=None):
        published.append((status, dict(details)))

    proc._publish_status_update = capture_publish

    async def maybe_fail(*_a, **_k):
        if failure_at is None:
            return _STEP_RETVALS.get(failure_at, None)
        raise exception

    text = ("text", {"title": "Test Doc"})

    async def get_text(*_a, **_k):
        if failure_at == "text_retrieval":
            raise exception
        return text

    async def generate_tags(*_a, **_k):
        if failure_at == "tagging":
            raise exception
        return [], {}

    async def generate_summary(*_a, **_k):
        if failure_at == "summary":
            raise exception
        return {"overview": "o", "bulletPoints": ["b"]}

    async def create_chunks(*_a, **_k):
        if failure_at == "chunking":
            raise exception
        return []

    async def generate_embeddings(*_a, **_k):
        if failure_at == "embeddings":
            raise exception
        return []

    async def store_chunks(*_a, **_k):
        if failure_at == "vector_storage":
            raise exception
        return {"successful_inserts": 0, "failed_inserts": 0}

    proc._validate_processing_request = AsyncMock(return_value=None)
    proc._get_extracted_text = get_text
    proc.content_tagger = MagicMock()
    proc.content_tagger.generate_tags = generate_tags
    proc.generate_document_summary = generate_summary
    proc._get_document_path = lambda *a, **k: "users/u1/resources/r1"
    proc._create_enhanced_chunks = create_chunks
    proc._generate_embeddings_with_openrouter = generate_embeddings
    proc.delete_old_vectors_via_service = AsyncMock(return_value=0)
    proc.store_chunks_via_service = store_chunks
    proc._save_processing_metadata_to_subcollection = AsyncMock(return_value=None)
    proc._update_user_usage = AsyncMock(return_value=None)
    proc._generate_resource_map = AsyncMock(return_value=None)

    return proc, published


# retvals are only consulted on the success path; keep a tiny table.
_STEP_RETVALS = {}


def _run_process(proc, user_id="u1", course_id="__ungrouped__", resource_id="r1"):
    return asyncio.run(
        proc.process_document(user_id, course_id, resource_id, job_id="job-1")
    )


def _failed_publishes(published):
    return [d for status, d in published if status == "failed"]


# --------------------------------------------------------------------------
# Worker-side: failure payload construction
# --------------------------------------------------------------------------

class TestWorkerFailurePayload:
    def _payload_for(self, failure_at, exception):
        proc, published = _make_processor(failure_at=failure_at, exception=exception)
        _run_process(proc)
        failed = _failed_publishes(published)
        assert len(failed) == 1, (
            f"expected exactly one 'failed' status publish, got {failed}"
        )
        return failed[0]

    def test_early_failure_payload_has_actual_message_stage_and_retryable(self):
        details = self._payload_for("text_retrieval", ValueError("boom-text"))
        for key in REQUIRED_FAILURE_KEYS:
            assert key in details, (
                f"worker failure payload missing required key '{key}': {details}"
            )
        assert details["error_message"] == "boom-text"
        assert isinstance(details["retryable"], bool)
        assert details["stage"] in ALLOWED_FAILURE_STAGES, (
            f"stage '{details['stage']}' outside the progress-stage vocabulary"
        )

    def test_early_failure_stage_is_an_early_stage(self):
        details = self._payload_for("text_retrieval", ValueError("boom-text"))
        assert _STAGE_ORDER.index(details["stage"]) <= _STAGE_ORDER.index("text_retrieved")

    def test_late_failure_stage_is_a_late_stage(self):
        details = self._payload_for("vector_storage", RuntimeError("weaviate down"))
        assert details["error_message"] == "weaviate down"
        assert _STAGE_ORDER.index(details["stage"]) >= _STAGE_ORDER.index("chunking_complete")

    def test_payload_does_not_rely_on_api_fallback_message(self):
        details = self._payload_for("text_retrieval", ValueError("boom-text"))
        assert details["error_message"] != "Processing failed"

    def test_payload_retains_legacy_error_key(self):
        details = self._payload_for("text_retrieval", ValueError("boom-text"))
        assert LEGACY_ERROR_KEY in details, (
            "worker failure payload must retain the legacy 'error' key for "
            "unknown consumers of the status topic"
        )
        assert details[LEGACY_ERROR_KEY] == "boom-text"

    def test_transient_error_maps_to_retryable_true(self):
        details = self._payload_for(
            "text_retrieval", worker_main.TransientError("temporary outage")
        )
        assert details["retryable"] is True

    def test_permanent_error_maps_to_retryable_false(self):
        details = self._payload_for("text_retrieval", worker_main.PermanentError("bad input"))
        assert details["retryable"] is False

    def test_unclassified_unknown_error_maps_to_retryable_false(self):
        # classify_error's conservative default: unknown → permanent → False.
        details = self._payload_for("text_retrieval", ValueError("mystery failure"))
        assert details["retryable"] is False

    def test_connection_error_maps_to_retryable_true(self):
        details = self._payload_for("text_retrieval", httpx.ConnectError("conn refused"))
        assert details["retryable"] is True

    @pytest.mark.parametrize(
        "failure_at,exception",
        [
            ("text_retrieval", ValueError("boom-text")),
            ("tagging", RuntimeError("tagger exploded")),
            ("summary", RuntimeError("summary exploded")),
            ("chunking", RuntimeError("chunker exploded")),
            ("embeddings", RuntimeError("embedder exploded")),
            ("vector_storage", RuntimeError("weaviate down")),
        ],
    )
    def test_retryable_always_equals_classify_error(self, failure_at, exception):
        details = self._payload_for(failure_at, exception)
        assert details["retryable"] is worker_main.classify_error(exception), (
            "payload retryable must be derived from classify_error, matching "
            "the worker's ACK/NACK behavior"
        )
        assert details["error_message"] == str(exception)

    def test_stage_never_none_or_missing(self):
        for failure_at in ("text_retrieval", "vector_storage"):
            details = self._payload_for(failure_at, ValueError("x"))
            assert details.get("stage") not in (None, ""), (
                "failure stage must never be null/empty — use 'processing' "
                "when genuinely unknown"
            )


class TestWorkerStageVocabularyOnProgressPath:
    def test_success_path_stage_names_use_existing_vocabulary(self):
        proc, published = _make_processor()
        _run_process(proc)
        stages = [
            d["stage"] for status, d in published
            if status == "processing" and "stage" in d
        ]
        assert stages, "progress publishes must carry stage names"
        unknown = set(stages) - PROGRESS_STAGE_VOCABULARY
        assert not unknown, f"progress stages outside vocabulary: {unknown}"


# --------------------------------------------------------------------------
# classify_error ↔ retryable alignment (unit-level, both directions)
# --------------------------------------------------------------------------

class TestClassifyErrorDrivesRetryable:
    def _status_error(self, code):
        request = httpx.Request("GET", "http://example.com")
        response = httpx.Response(code, request=request)
        return httpx.HTTPStatusError(f"HTTP {code}", request=request, response=response)

    @pytest.mark.parametrize(
        "exc,expected",
        [
            (worker_main.TransientError("t"), True),
            (worker_main.PermanentError("p"), False),
            (ValueError("unknown"), False),  # conservative default
            (httpx.ConnectError("c"), True),
            (httpx.ReadTimeout("r"), True),
            (ConnectionError("c"), True),
            (TimeoutError("t"), True),
            (_status_error(429), True),
            (_status_error(500), True),
            (_status_error(503), True),
            (_status_error(404), False),
            (_status_error(400), False),
        ],
    )
    def test_classification(self, exc, expected):
        assert worker_main.classify_error(exc) is expected


# --------------------------------------------------------------------------
# rag-api side: failed-branch persistence against fake Firestore
# --------------------------------------------------------------------------

def _seed_resource(db, user_id="u1", resource_id="r1"):
    ref = db.document(f"users/{user_id}/resources/{resource_id}")
    ref.set({"status": "processing", "userId": user_id})
    return ref


def _run_failed_branch(db, doc_ref, details):
    rag_api_main.run_transactional_update(db, doc_ref, "failed", details, MagicMock(), "u1")


class TestRagApiFailedBranchPersistence:
    def test_persists_worker_values_unchanged(self):
        db = FakeDb()
        ref = _seed_resource(db)
        details = {
            "error_message": "boom-text",
            "stage": "text_retrieved",
            "retryable": False,
            "error": "boom-text",  # legacy key must be ignored by the API
        }
        _run_failed_branch(db, ref, details)

        data = db.store["users/u1/resources/r1"]
        assert data["status"] == "failed"
        assert data["error"] == "boom-text", "main doc error must come from payload error_message"
        assert data["error_stage"] == "text_retrieved", "error_stage must come from payload stage"
        assert data["retryable"] is False, "retryable must come from payload retryable"

        summary = db.store["users/u1/resources/r1/processing/summary"]
        assert summary["error"]["message"] == "boom-text"
        assert summary["error"]["stage"] == "text_retrieved"
        assert summary["error"]["code"] == "UNKNOWN"
        assert summary["stage"] == "text_retrieved"

    def test_retryable_true_round_trips(self):
        db = FakeDb()
        ref = _seed_resource(db)
        _run_failed_branch(db, ref, {
            "error_message": "temporary outage",
            "stage": "embeddings_complete",
            "retryable": True,
        })
        data = db.store["users/u1/resources/r1"]
        assert data["error"] == "temporary outage"
        assert data["error_stage"] == "embeddings_complete"
        assert data["retryable"] is True

    def test_legacy_only_payload_still_hits_fallbacks(self):
        # Documents the API's existing fallback behavior: a payload carrying
        # only the legacy 'error' key (the OLD worker shape) lands as
        # "Processing failed"/None/True. This is exactly what the worker-side
        # tests above forbid — the fallbacks exist but must never be the
        # operative mechanism for worker failures.
        db = FakeDb()
        ref = _seed_resource(db)
        _run_failed_branch(db, ref, {"error": "old-style failure"})
        data = db.store["users/u1/resources/r1"]
        assert data["error"] == "Processing failed"
        assert data["error_stage"] is None
        assert data["retryable"] is True


# --------------------------------------------------------------------------
# The seam: worker payload → rag-api persistence, end to end
# --------------------------------------------------------------------------

class TestWorkerToApiFailureSeam:
    @pytest.mark.parametrize(
        "failure_at,exception",
        [
            ("text_retrieval", ValueError("boom-text")),
            ("text_retrieval", httpx.ConnectError("conn refused")),
            ("vector_storage", RuntimeError("weaviate down")),
        ],
    )
    def test_worker_payload_persisted_verbatim_by_rag_api(self, failure_at, exception):
        proc, published = _make_processor(failure_at=failure_at, exception=exception)
        _run_process(proc)
        failed = _failed_publishes(published)
        assert len(failed) == 1
        details = failed[0]

        db = FakeDb()
        ref = _seed_resource(db)
        _run_failed_branch(db, ref, details)

        data = db.store["users/u1/resources/r1"]
        assert data["error"] == details["error_message"]
        assert data["error"] == str(exception), "persisted error must be the actual exception message"
        assert data["error_stage"] == details["stage"]
        assert data["error_stage"] is not None
        assert data["retryable"] is details["retryable"]
        assert data["retryable"] is worker_main.classify_error(exception)

        summary = db.store["users/u1/resources/r1/processing/summary"]
        assert summary["error"]["message"] == details["error_message"]
        assert summary["error"]["stage"] == details["stage"]


# --------------------------------------------------------------------------
# Drift guards (AST): pin the payload keys on both sides of the seam
# --------------------------------------------------------------------------

RAG_API_MAIN_PATH = os.path.join(RAG_API_DIR, "main.py")
RAG_WORKER_MAIN_PATH = os.path.join(RAG_WORKER_DIR, "main.py")


def _failed_branch_string_constants(source_path):
    """String constants appearing inside `if new_status == "failed":` blocks
    of run_transactional_update in rag-api's main.py."""
    with open(source_path) as f:
        tree = ast.parse(f.read())
    constants = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "run_transactional_update":
            for sub in ast.walk(node):
                if isinstance(sub, ast.If):
                    test = sub.test
                    is_failed_branch = (
                        isinstance(test, ast.Compare)
                        and isinstance(test.left, ast.Name)
                        and test.left.id == "new_status"
                        and any(
                            isinstance(c, ast.Constant) and c.value == "failed"
                            for c in test.comparators
                        )
                    )
                    if is_failed_branch:
                        for n in ast.walk(sub):
                            if isinstance(n, ast.Constant) and isinstance(n.value, str):
                                constants.add(n.value)
    return constants


class TestContractDriftGuards:
    def test_rag_api_failed_branch_reads_contract_keys(self):
        constants = _failed_branch_string_constants(RAG_API_MAIN_PATH)
        missing = REQUIRED_FAILURE_KEYS - constants
        assert not missing, (
            f"rag-api failed branch no longer reads payload keys {missing} — "
            "the worker→rag-api failure contract has drifted"
        )

    def test_worker_source_publishes_failed_status_with_contract_keys(self):
        """The worker's process_document exception handler must publish a
        'failed' status whose details carry error_message, stage, and
        retryable (plus the retained legacy error key). Checked on the AST so
        the guard fails at build time if the handler drops a key."""
        with open(RAG_WORKER_MAIN_PATH) as f:
            tree = ast.parse(f.read())

        process_fn = next(
            n for n in ast.walk(tree)
            if isinstance(n, ast.AsyncFunctionDef) and n.name == "process_document"
        )
        handler = next(
            n for n in ast.walk(process_fn)
            if isinstance(n, ast.ExceptHandler)
        )

        failed_calls = []
        for node in ast.walk(handler):
            if isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "_publish_status_update":
                args = node.args
                if len(args) >= 5 and isinstance(args[4], ast.Constant) and args[4].value == "failed":
                    failed_calls.append(node)
        assert failed_calls, "worker exception handler must publish a 'failed' status"

        keys = set()
        for call in failed_calls:
            details_arg = call.args[5] if len(call.args) > 5 else call.keywords and None
            # details may be passed positionally (6th arg) or built inline;
            # collect every string constant reachable in the call subtree.
            for n in ast.walk(call):
                if isinstance(n, ast.Constant) and isinstance(n.value, str):
                    keys.add(n.value)

        missing = REQUIRED_FAILURE_KEYS - keys
        assert not missing, (
            f"worker failed-status payload no longer includes {missing} — "
            "the worker→rag-api failure contract has drifted"
        )
        assert LEGACY_ERROR_KEY in keys, (
            "worker failed-status payload must retain the legacy 'error' key"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>