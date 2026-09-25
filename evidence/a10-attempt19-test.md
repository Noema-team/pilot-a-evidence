The investigation is complete. I verified both sides of the seam from the repository: the worker's `process_document` exception handler publishes `{"error": str(e)}` via `_publish_status_update` (whose envelope and `jobId`/sequence handling I confirmed), `classify_error`'s transient/permanent semantics, the progress-stage vocabulary, rag-api's `run_transactional_update` failed branch (key reads, fallbacks, transition gate, summary subdocument write), the persisted `error`/`error_stage`/`retryable` schema on `Resource`, and the existing contract-test/fake-transaction patterns (`tests/integration/test_api_contracts.py`, the worker's `test_processing_lease.py` fakes, both conftests' stubbing). The test file below encodes the target contract: it drives the real worker `process_document` to failure at chosen pipeline steps, captures the published status message through the real `_publish_status_update`, feeds the payload through the real rag-api failed branch against a fake Firestore transaction, and pins both sides' key sets so drift fails the build. It is expected to fail against the current drifted behavior and pass once the worker aligns to `error_message`/`stage`/`retryable`.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_failure_payload_contract.py">>>
"""Contract tests for the rag-worker → rag-api failure-payload seam.

Scope (definition wi-define-108-a8): a failed RAG processing job must persist
the worker's actual error message, the failing pipeline stage, and a
deliberately derived retryable flag. The historical drift: the worker's
process_document exception handler published only {"error": str(e)} while
rag-api's failed branch reads error_message/stage/retryable — so every
worker-originated failure persisted as error="Processing failed",
error_stage=None and a fabricated retryable=True.

These tests encode the TARGET contract. They fail against the drifted
behaviour and pin the seam once the worker publishes error_message/stage/
retryable (with the legacy `error` key retained as a compatibility hedge).

Both sides are imported rather than restated in a fixture:

* Worker side — rag-worker-service/main.py is loaded by file path under the
  module name `rag_worker_main` (`main` in this test package already refers
  to rag-api-service/main.py). Before that import, the worker suite's own
  tests/conftest.py stubs are replayed; they guard every sys.modules
  insertion with `if mod not in sys.modules`, so they compose with the cloud
  mocks this package's conftest installs. The real `process_document` is
  driven to failure at a chosen pipeline step and the status message it
  publishes through the real `_publish_status_update` is captured with a
  fake Pub/Sub publisher.

* API side — the captured `details` payload is fed through the real
  `run_transactional_update` failed branch of rag-api-service/main.py,
  executed against a fake Firestore transaction (the same fake-transaction
  pattern as the worker's tests/unit/test_processing_lease.py), with
  firestore.transactional replaced by an identity decorator.

Requirement → test map:
  R1 payload carries error_message/stage/retryable, never api fallbacks
     → TestWorkerFailurePayload (value assertions) and
       TestWorkerToApiFailureContract (fallback values never appear).
  R2 stage tracking with the progress vocabulary, "processing" when unknown
     → the stage assertions on early/late failures and
       test_failure_before_first_stage_transition_reports_processing.
  R3 rag-api persists worker values unchanged; summary subdoc mirrors them
     → TestApiFailedBranch (sentinel test) and TestWorkerToApiFailureContract.
  R4 retryable derived from classify_error (transient→True; permanent and
     unclassified-unknown→False)
     → test_retryable_derivation_matches_classify_error and the
       transient/permanent payload tests.
  R5 contract test fails if either side's payload keys drift
     → test_failure_payload_key_set_is_pinned (worker key set) and
       test_failed_branch_persists_values_under_the_contract_keys (api key
       names, via distinct sentinels).
"""

import asyncio
import concurrent.futures
import importlib
import importlib.util
import json
import os
import sys
import types

import httpx

# rag-api-service is placed on sys.path and its cloud dependencies are mocked
# by this package's conftest.py — the same import test_api_contracts.py uses.
import main as rag_api_main

HERE = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
RAG_WORKER_DIR = os.path.join(AI_SERVER_DIR, "rag-worker-service")

# Keys rag-api's failed branch reads (persisted as error/error_stage/retryable).
# REQUIRED must always be present in the worker's failure payload; CONTRACT is
# the full pinned payload including the retained legacy `error` key
# (compatibility hedge for unknown consumers of the status topic).
REQUIRED_FAILURE_KEYS = {"error_message", "stage", "retryable"}
CONTRACT_FAILURE_KEYS = {"error_message", "stage", "retryable", "error"}

_worker_main_cache = None


def _stub_if_missing(name, attrs=None):
    """Import a module for real when available; install a minimal stub if not."""
    if name in sys.modules:
        return
    try:
        importlib.import_module(name)
        return
    except Exception:
        module = types.ModuleType(name)
        for key, value in (attrs or {}).items():
            setattr(module, key, value)
        sys.modules[name] = module


def _get_worker_main():
    """Load rag-worker-service/main.py once, under a unique module name.

    `main` already refers to rag-api-service/main.py in this test package, so
    the worker is loaded by file path as `rag_worker_main`. The worker suite's
    own tests/conftest.py is replayed first for its env defaults and module
    stubs (each insertion guarded by `if mod not in sys.modules`, so it
    composes with the mocks this package's conftest installed).
    """
    global _worker_main_cache
    if _worker_main_cache is not None:
        return _worker_main_cache

    worker_conftest_path = os.path.join(RAG_WORKER_DIR, "tests", "conftest.py")
    with open(worker_conftest_path, "r", encoding="utf-8") as handle:
        source = handle.read()
    exec(
        compile(source, worker_conftest_path, "exec"),
        {"__name__": "_worker_conftest_bootstrap"},
    )

    # Gap fill: the worker conftest stubs langchain/openai/spacy/tiktoken/
    # tenacity but assumes sklearn is installed. Provide a minimal stand-in
    # when it is missing so the worker module still imports.
    _stub_if_missing("sklearn", {"__path__": []})
    _stub_if_missing("sklearn.feature_extraction", {"__path__": []})
    _stub_if_missing(
        "sklearn.feature_extraction.text",
        {"TfidfVectorizer": type("TfidfVectorizer", (), {})},
    )

    spec = importlib.util.spec_from_file_location(
        "rag_worker_main", os.path.join(RAG_WORKER_DIR, "main.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["rag_worker_main"] = module
    spec.loader.exec_module(module)
    _worker_main_cache = module
    return _worker_main_cache


# ── Fakes ─────────────────────────────────────────────────────────────────────


class _KwLogger:
    """structlog-style logger stand-in: accepts event + arbitrary kwargs."""

    def __init__(self):
        self.events = []

    def _record(self, event, **kwargs):
        self.events.append((event, kwargs))

    info = _record
    warning = _record
    error = _record
    debug = _record


class _FakePublisher:
    """pubsub_v1.PublisherClient stand-in that records published JSON messages."""

    def __init__(self):
        self.published = []

    def topic_path(self, project, topic):
        return f"projects/{project}/topics/{topic}"

    def publish(self, topic, data):
        self.published.append((topic, json.loads(data.decode("utf-8"))))
        future = concurrent.futures.Future()
        future.set_result(None)
        return future


class _FakeLeaseRef:
    """Document ref for the lease-heartbeat lookups inside _publish_status_update."""

    def get(self):
        return types.SimpleNamespace(exists=False)

    def set(self, data, merge=None):
        pass

    def update(self, data):
        pass


class _FakeLeaseDb:
    def document(self, path):
        return _FakeLeaseRef()


class _FakeSnapshot:
    def __init__(self, data):
        self._data = data
        self.exists = True

    def to_dict(self):
        return dict(self._data)


class _FakeMainRef:
    def __init__(self, path, db):
        self.path = path
        self.id = path.rsplit("/", 1)[-1]
        self._db = db

    def get(self, transaction=None):
        return _FakeSnapshot(self._db.main_doc)

    def collection(self, name):
        return _FakeSubCollection(self._db)


class _FakeSubCollection:
    def __init__(self, db):
        self._db = db

    def document(self, name):
        return _FakeSubRef(self._db)


class _FakeSubRef:
    def __init__(self, db):
        self._db = db


class _FakeTransaction:
    def __init__(self, db):
        self._db = db

    def update(self, ref, data):
        self._db.main_doc.update(data)
        self._db.main_updates.append(dict(data))

    def set(self, ref, data, merge=None):
        self._db.summary_doc.update(data)
        self._db.summary_sets.append(dict(data))


class _FakeDb:
    """Firestore stand-in for run_transactional_update's transactional writes."""

    def __init__(self, initial_main=None):
        self.main_doc = dict(initial_main or {})
        self.summary_doc = {}
        self.main_updates = []
        self.summary_sets = []

    def transaction(self):
        return _FakeTransaction(self)


# ── Worker driver ─────────────────────────────────────────────────────────────


def _make_processor(worker):
    """Build an EnhancedDocumentProcessor without running __init__.

    Only the attributes touched by process_document's failure path and by the
    real _publish_status_update are provided; every pipeline step is replaced
    by _install_pipeline.
    """
    processor = worker.EnhancedDocumentProcessor.__new__(worker.EnhancedDocumentProcessor)
    processor.langfuse = None
    processor.logger = _KwLogger()
    processor.config = types.SimpleNamespace(
        gcp_project="test-gcp",
        rag_status_topic="rag-status-updates",
    )
    processor.pubsub_publisher = _FakePublisher()
    processor.db = _FakeLeaseDb()
    processor._status_sequence = {}  # instance shadow of the class-level dict
    return processor


def _install_pipeline(processor, fail_step, exc):
    """Replace every pipeline step with a fake; `fail_step` raises `exc`.

    Step → stage vocabulary: the tracker convention under test is "set the
    tracker immediately before the await", using the step's progress-stage
    name — extract→text_retrieved, tag→tagging_complete, summary→
    summary_generated, chunk→chunking_complete, embeddings→embeddings_complete.
    A failure before the first stage transition reports the safe value
    "processing".
    """

    async def raise_exc(*args, **kwargs):
        raise exc

    async def noop(*args, **kwargs):
        return None

    async def extract_text(*args, **kwargs):
        return "# Document\n\nbody text for the pipeline", {
            "title": "Test Document",
            "filename": "test.md",
            "total_pages": 1,
        }

    async def generate_tags(*args, **kwargs):
        return [], {}

    async def create_chunks(*args, **kwargs):
        return []

    async def generate_embeddings(*args, **kwargs):
        return []

    async def store_chunks(*args, **kwargs):
        return {"successful_inserts": 0, "failed_inserts": 0}

    processor._validate_processing_request = raise_exc if fail_step == "validate" else noop
    processor._get_extracted_text = raise_exc if fail_step == "extract" else extract_text
    processor.content_tagger = types.SimpleNamespace(
        generate_tags=raise_exc if fail_step == "tag" else generate_tags
    )
    processor.generate_document_summary = raise_exc if fail_step == "summary" else noop
    processor._create_enhanced_chunks = raise_exc if fail_step == "chunk" else create_chunks
    processor._generate_embeddings_with_openrouter = (
        raise_exc if fail_step == "embeddings" else generate_embeddings
    )
    processor.delete_old_vectors_via_service = noop
    processor.store_chunks_via_service = store_chunks
    processor._save_processing_metadata_to_subcollection = noop
    processor._update_user_usage = noop
    processor._generate_resource_map = noop


def _run_failing_job(worker, fail_step, exc, job_id=None, resource_id="res-contract"):
    """Drive the real process_document to failure; return (processor, metrics)."""
    processor = _make_processor(worker)
    _install_pipeline(processor, fail_step, exc)
    # asyncio.run because this test package has no asyncio_mode=auto config.
    metrics = asyncio.run(
        processor.process_document("user-1", "__ungrouped__", resource_id, job_id)
    )
    return processor, metrics


def _failure_message(processor):
    """Return the last published status message, asserting it is the failure."""
    assert processor.pubsub_publisher.published, "worker published no status updates"
    _topic, message = processor.pubsub_publisher.published[-1]
    assert message["status"] == "failed", (
        f"expected last published status to be 'failed', got {message['status']!r}"
    )
    return message


# ── API driver ────────────────────────────────────────────────────────────────


def _persist_failure(monkeypatch, details, initial_status="processing"):
    """Feed `details` through rag-api's failed branch; return the fake db."""
    # Identity transactional decorator + sentinel timestamp: lets the real
    # failed-branch logic run against the fake transaction (house pattern from
    # the worker's test_processing_lease.py).
    monkeypatch.setattr(
        rag_api_main.firestore, "transactional", lambda fn: fn, raising=False
    )
    monkeypatch.setattr(
        rag_api_main.firestore, "SERVER_TIMESTAMP", "SERVER_TIMESTAMP", raising=False
    )
    db = _FakeDb({"status": initial_status, "userId": "user-1"})
    doc_ref = _FakeMainRef("users/user-1/resources/res-contract", db)
    rag_api_main.run_transactional_update(
        db, doc_ref, "failed", details, _KwLogger(), "user-1"
    )
    assert db.main_updates, "failed branch performed no main-document update"
    return db


# ── Worker side of the seam ───────────────────────────────────────────────────


class TestWorkerFailurePayload:
    """The worker's failed status payload (acceptance criteria 1 and 2)."""

    def test_transient_failure_carries_message_stage_and_retryable(self):
        worker = _get_worker_main()
        exc = worker.TransientError("weaviate temporarily unreachable")
        processor, _ = _run_failing_job(worker, "extract", exc)
        details = _failure_message(processor)["details"]
        assert details["error_message"] == "weaviate temporarily unreachable"
        # Failure during the text-extraction step reports that step's
        # progress-vocabulary name.
        assert details["stage"] == "text_retrieved"
        # Transient classification → deliberately derived retryable=True.
        assert details["retryable"] is True
        # Legacy `error` key retained alongside error_message (hedge for
        # unknown consumers of the status topic).
        assert details["error"] == "weaviate temporarily unreachable"

    def test_permanent_failure_reports_failing_stage_and_retryable_false(self):
        worker = _get_worker_main()
        exc = worker.PermanentError("document exceeds the maximum supported page count")
        processor, _ = _run_failing_job(worker, "embeddings", exc)
        details = _failure_message(processor)["details"]
        assert details["error_message"] == (
            "document exceeds the maximum supported page count"
        )
        assert details["stage"] == "embeddings_complete"
        assert details["retryable"] is False

    def test_unclassified_unknown_error_derives_retryable_false(self):
        worker = _get_worker_main()
        exc = RuntimeError("something completely unexpected went wrong")
        processor, _ = _run_failing_job(worker, "embeddings", exc)
        details = _failure_message(processor)["details"]
        # classify_error's conservative default: unknown → permanent. The
        # payload must reflect that derivation, not a silent retryable=True.
        assert worker.classify_error(exc) is False
        assert details["retryable"] is False

    def test_failure_before_first_stage_transition_reports_processing(self):
        worker = _get_worker_main()
        exc = ValueError(
            "Document res-contract not found at path users/user-1/resources/res-contract"
        )
        processor, _ = _run_failing_job(worker, "validate", exc)
        details = _failure_message(processor)["details"]
        # Safe value when the stage is genuinely unknown (failure before the
        # first stage transition) — never None.
        assert details["stage"] == "processing"
        assert details["error_message"] == str(exc)
        assert details["retryable"] is False

    def test_retryable_derivation_matches_classify_error(self):
        worker = _get_worker_main()
        cases = [
            (worker.TransientError("temporary backend outage"), True),
            (httpx.ConnectError("connection refused"), True),
            (worker.PermanentError("malformed document"), False),
            (ValueError("unclassified input error"), False),
        ]
        for exc, expected in cases:
            processor, _ = _run_failing_job(worker, "extract", exc)
            details = _failure_message(processor)["details"]
            # The derivation source is classify_error — the same function that
            # drives ACK/NACK — so the record tells the truth about whether
            # Pub/Sub will redeliver.
            assert details["retryable"] == worker.classify_error(exc)
            assert details["retryable"] is expected

    def test_failure_payload_key_set_is_pinned(self):
        """Drift guard (worker side): the exact detail-key set of the payload.

        error_message/stage/retryable are rag-api's contract keys; `error` is
        the retained legacy key. Adding or removing a key must be a deliberate
        contract change mirrored on the rag-api side and in this test.
        """
        worker = _get_worker_main()
        exc = worker.TransientError("boom")
        processor, _ = _run_failing_job(worker, "extract", exc, job_id=None)
        details = _failure_message(processor)["details"]
        assert set(details) == CONTRACT_FAILURE_KEYS


class TestPublishedFailureEnvelope:
    """The published message envelope around the failure payload."""

    def test_failed_status_message_identifies_the_resource(self):
        worker = _get_worker_main()
        exc = worker.TransientError("weaviate temporarily unreachable")
        processor, _ = _run_failing_job(
            worker, "extract", exc, job_id="job-42", resource_id="res-envelope"
        )
        _topic, message = processor.pubsub_publisher.published[-1]
        assert message["user_id"] == "user-1"
        assert message["course_id"] == "__ungrouped__"
        assert message["resource_id"] == "res-envelope"
        assert message["status"] == "failed"
        assert REQUIRED_FAILURE_KEYS <= set(message["details"])
        assert message["details"]["error_message"] == "weaviate temporarily unreachable"


# ── API side of the seam ──────────────────────────────────────────────────────


class TestApiFailedBranch:
    """rag-api's failed-branch read/persist behaviour, pinned as-is."""

    def test_failed_branch_persists_values_under_the_contract_keys(self, monkeypatch):
        """Drift guard (api side): distinct sentinels prove the failed branch
        reads error_message/stage/retryable — not the legacy `error` key and
        not its fallback defaults."""
        details = {
            "error_message": "SENTINEL-MESSAGE",
            "stage": "SENTINEL-STAGE",
            "retryable": False,
            "error": "SENTINEL-LEGACY",
        }
        db = _persist_failure(monkeypatch, details)
        assert db.main_doc["status"] == "failed"
        assert db.main_doc["error"] == "SENTINEL-MESSAGE"
        assert db.main_doc["error_stage"] == "SENTINEL-STAGE"
        assert db.main_doc["retryable"] is False
        assert db.summary_doc["stage"] == "SENTINEL-STAGE"
        assert db.summary_doc["error"] == {
            "code": "UNKNOWN",
            "message": "SENTINEL-MESSAGE",
            "stage": "SENTINEL-STAGE",
        }

    def test_failed_branch_fallbacks_stay_unchanged(self, monkeypatch):
        """Pins rag-api's existing fallback defaults: this fix aligns the
        worker to the API contract and must not change the API's reads."""
        db = _persist_failure(monkeypatch, {"error": "legacy-only payload"})
        assert db.main_doc["error"] == "Processing failed"
        assert db.main_doc["error_stage"] is None
        assert db.main_doc["retryable"] is True
        assert db.summary_doc["stage"] == "unknown"
        assert db.summary_doc["error"]["code"] == "UNKNOWN"
        assert db.summary_doc["error"]["message"] == "Processing failed"
        assert db.summary_doc["error"]["stage"] is None


# ── The seam: worker payload → rag-api persistence ────────────────────────────


class TestWorkerToApiFailureContract:
    """End-to-end over the seam: the worker's published failure details are
    fed verbatim into rag-api's failed branch (acceptance criteria 2–4)."""

    def test_transient_failure_flows_from_worker_to_persisted_document(self, monkeypatch):
        worker = _get_worker_main()
        exc = worker.TransientError("embedding request timed out after 60s")
        processor, _ = _run_failing_job(worker, "embeddings", exc)
        details = _failure_message(processor)["details"]

        db = _persist_failure(monkeypatch, details)

        assert db.main_doc["status"] == "failed"
        # The worker's actual message — not the "Processing failed" fallback.
        assert db.main_doc["error"] == "embedding request timed out after 60s"
        assert db.main_doc["error"] != "Processing failed"
        # The failing stage — not None.
        assert db.main_doc["error_stage"] == "embeddings_complete"
        # The worker's derived value — not the silent default.
        assert db.main_doc["retryable"] is True
        # processing/summary error subdocument mirrors message and stage.
        assert db.summary_doc["stage"] == db.main_doc["error_stage"]
        assert db.summary_doc["error"] == {
            "code": "UNKNOWN",
            "message": "embedding request timed out after 60s",
            "stage": "embeddings_complete",
        }

    def test_permanent_failure_flows_from_worker_to_persisted_document(self, monkeypatch):
        worker = _get_worker_main()
        # RuntimeError is unclassified-unknown → classify_error says permanent.
        exc = RuntimeError("marker returned no usable text")
        processor, _ = _run_failing_job(worker, "extract", exc)
        details = _failure_message(processor)["details"]

        db = _persist_failure(monkeypatch, details)

        assert db.main_doc["error"] == "marker returned no usable text"
        assert db.main_doc["error_stage"] == "text_retrieved"
        assert db.main_doc["retryable"] is False
        assert db.summary_doc["stage"] == db.main_doc["error_stage"]
        assert db.summary_doc["error"]["message"] == db.main_doc["error"]
        assert db.summary_doc["error"]["stage"] == db.main_doc["error_stage"]
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>