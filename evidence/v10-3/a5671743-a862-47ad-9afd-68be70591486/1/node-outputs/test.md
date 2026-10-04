Tests derived strictly from the Definition's requirements and the repository evidence verified during investigation: the worker's `process_document` exception handler and `_publish_status_update` publish path, `classify_error`'s transient/permanent semantics, rag-api's `run_transactional_update` failed branch (reads `error_message`/`stage`/`retryable`, persists `error`/`error_stage`/`retryable` plus the summary error subdocument), and the existing hermetic integration-test patterns (`tests/integration/conftest.py`, `test_api_contracts.py`).

Design notes:
- The worker side is exercised through the real `process_document` code path (processor built via `__new__` with stubbed pipeline steps and a real `concurrent.futures.Future` for Pub/Sub), so the published failure payload is captured from the worker's own publisher — not restated in a fixture.
- rag-api's `run_transactional_update` is imported from `main` with `firestore.transactional` patched to a passthrough so the real failed-branch logic runs against fake Firestore objects.
- An end-to-end test feeds the worker's captured payload directly into rag-api's failed branch and asserts persisted values verbatim, including that `retryable=False` proves the API-side default is not operative.
- AST-based drift guards pin the payload key sets on both sides, following the house fixture/AST contract-test pattern.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""
Contract tests: rag-worker failure payload -> rag-api failed-branch persistence.

Derived from the WorkItem definition (wi-define-108-a8). Requirements under test:

1. A failed job's worker payload must carry error_message (the actual exception
   message), stage (the failing pipeline stage, drawn from the existing
   progress-stage vocabulary with "processing" as the unknown-stage safe value),
   and retryable (deliberately derived from classify_error) — never relying on
   rag-api's fallback defaults. The legacy `error` key is retained alongside
   error_message for continuity with unknown consumers of the status topic.
2. retryable derivation must align with the worker's ACK/NACK behavior:
   classify_error transient -> True, permanent (including unclassified-unknown)
   -> False.
3. rag-api's failed branch must persist the worker-provided values unchanged:
   error <- error_message, error_stage <- stage, retryable <- retryable, and the
   processing/summary error subdocument must carry the same message and stage
   (error_code stays "UNKNOWN" unless a code is actually sent).
4. Drift guards: if either side's payload keys change, the build fails.
"""

import ast
import asyncio
import concurrent.futures
import importlib
import importlib.util
import json
import os
import sys
import types
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.normpath(os.path.join(TESTS_DIR, "..", ".."))
RAG_API_DIR = os.path.join(AI_SERVER_DIR, "rag-api-service")
RAG_WORKER_DIR = os.path.join(AI_SERVER_DIR, "rag-worker-service")

# ---------------------------------------------------------------------------
# Hermetic imports.
#
# conftest.py already mocks the google/firebase/structlog stack used by
# rag-api. rag-worker additionally imports heavy ML dependencies that are not
# exercised by the failure-payload code path under test; mock those too so the
# worker module can be imported directly (both sides are imported, not
# restated, per the test strategy).
# ---------------------------------------------------------------------------
for _mod in [
    "langchain", "langchain.text_splitter", "langchain.schema",
    "openai", "langfuse",
    "spacy",
    "sklearn", "sklearn.feature_extraction", "sklearn.feature_extraction.text",
    "tiktoken", "tenacity",
]:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

if RAG_API_DIR not in sys.path:
    sys.path.insert(0, RAG_API_DIR)

# run_transactional_update decorates its inner logic with
# @firestore.transactional. Against the conftest mocks that decorator is a
# MagicMock and the transaction body would never execute. Replace it with a
# passthrough BEFORE importing (or reloading) rag-api main so the real
# failed-branch logic runs against our fakes.
import firebase_admin  # mocked by conftest

firebase_admin.firestore.transactional = lambda fn: fn

import main as rag_api_main  # noqa: E402

if getattr(rag_worker_main_placeholder := None, "_", None):  # pragma: no cover
    raise AssertionError("unreachable")

if getattr(rag_api_main, "_failure_contract_passthrough", False) is not True:
    # main may already be cached (imported by test_api_contracts) without the
    # passthrough decorator baked in; reload it in place so the real
    # transaction body is live. importlib.reload mutates the module object in
    # place, so other modules' references remain valid.
    importlib.reload(rag_api_main)
    rag_api_main._failure_contract_passthrough = True


def _load_worker_module():
    spec = importlib.util.spec_from_file_location(
        "rag_worker_main", os.path.join(RAG_WORKER_DIR, "main.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["rag_worker_main"] = module
    spec.loader.exec_module(module)
    return module


rag_worker_main = _load_worker_module()

# The stage vocabulary the worker already uses in its progress updates, plus
# the "processing" safe value for a genuinely unknown stage.
STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "processing",
}


# ---------------------------------------------------------------------------
# Worker-side helpers: build an EnhancedDocumentProcessor without running its
# heavy __init__, stub the pipeline steps, and capture what the worker actually
# publishes to the status topic.
# ---------------------------------------------------------------------------
def _make_processor():
    processor = rag_worker_main.EnhancedDocumentProcessor.__new__(
        rag_worker_main.EnhancedDocumentProcessor
    )
    processor.logger = MagicMock()
    processor.langfuse = None
    processor.config = types.SimpleNamespace(
        gcp_project="test-project",
        rag_status_topic="rag-status-updates",
    )
    publisher = MagicMock()
    future = concurrent.futures.Future()
    future.set_result("message-id")
    publisher.publish.return_value = future
    processor.pubsub_publisher = publisher
    processor.db = MagicMock()
    return processor


def _published_messages(processor):
    messages = []
    for call in processor.pubsub_publisher.publish.call_args_list:
        messages.append(json.loads(call.args[1].decode("utf-8")))
    return messages


def _failed_payloads(processor):
    return [m for m in _published_messages(processor) if m.get("status") == "failed"]


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# rag-api-side helpers: fake Firestore objects capturing exactly what the
# failed branch writes.
# ---------------------------------------------------------------------------
class FakeTransaction:
    def __init__(self):
        self.updates = []
        self.sets = []

    def update(self, ref, data):
        self.updates.append((ref, data))

    def set(self, ref, data, merge=False):
        self.sets.append((ref, data, merge))


class FakeSnapshot:
    exists = True

    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return self._data


class FakeSummaryRef:
    def __init__(self):
        self.sets = []

    def set(self, data, merge=False):
        self.sets.append((data, merge))


class FakeDocRef:
    def __init__(self, data=None, doc_id="res-1"):
        self.id = doc_id
        self._data = data if data is not None else {"status": "processing"}
        self.updates = []
        self.summary = FakeSummaryRef()

    def get(self, transaction=None):
        return FakeSnapshot(self._data)

    def update(self, data):
        self.updates.append(data)

    def collection(self, name):
        assert name == "processing"
        return types.SimpleNamespace(document=lambda doc_id: self.summary)


class FakeDB:
    def transaction(self):
        return FakeTransaction()


def _run_failed_branch(details):
    db = FakeDB()
    doc_ref = FakeDocRef()
    rag_api_main.run_transactional_update(
        db, doc_ref, "failed", details, MagicMock(), "user-1"
    )
    assert len(db.transaction.updates) == 1, "failed branch must update the main doc"
    assert len(db.transaction.sets) == 1, "failed branch must write the summary subdoc"
    main_update = db.transaction.updates[0][1]
    summary_update = db.transaction.sets[0][1]
    return main_update, summary_update


# ---------------------------------------------------------------------------
# Worker failure-payload construction (real process_document code path).
# ---------------------------------------------------------------------------
class TestWorkerFailurePayloadConstruction:
    def test_early_stage_failure_payload_carries_contract_keys(self):
        processor = _make_processor()
        exc = ValueError("Document res-1 not found at users/u1/resources/res-1")
        processor._validate_processing_request = AsyncMock(side_effect=exc)

        _run(processor.process_document("u1", "__ungrouped__", "res-1", "job-1"))

        failures = _failed_payloads(processor)
        assert len(failures) == 1
        details = failures[0]["details"]
        # The actual exception message, not a fallback string.
        assert details["error_message"] == "Document res-1 not found at users/u1/resources/res-1"
        # Stage must be present, non-empty, and drawn from the existing
        # progress-stage vocabulary (or the "processing" safe value).
        assert isinstance(details["stage"], str) and details["stage"]
        assert details["stage"] in STAGE_VOCABULARY
        # retryable must be explicitly present and deliberately derived.
        assert isinstance(details["retryable"], bool)
        assert details["retryable"] == rag_worker_main.classify_error(exc)
        # Legacy key retained for unknown consumers of the status topic.
        assert details["error"] == details["error_message"]

    def test_late_stage_failure_reports_stage_within_vocabulary(self):
        processor = _make_processor()
        processor._validate_processing_request = AsyncMock()
        processor._get_extracted_text = AsyncMock(
            return_value=("some extracted document text", {"title": "Doc"})
        )
        exc = httpx.ReadTimeout("tagging upstream timed out")
        processor.content_tagger = types.SimpleNamespace(
            generate_tags=AsyncMock(side_effect=exc)
        )

        _run(processor.process_document("u1", "__ungrouped__", "res-1", "job-1"))

        failures = _failed_payloads(processor)
        assert len(failures) == 1
        details = failures[0]["details"]
        assert details["error_message"] == "tagging upstream timed out"
        assert details["stage"] in STAGE_VOCABULARY
        # ReadTimeout classifies transient -> retryable must be True.
        assert details["retryable"] is True
        assert details["retryable"] == rag_worker_main.classify_error(exc)
        assert details["error"] == details["error_message"]

    @pytest.mark.parametrize(
        "exc_factory, expected_retryable",
        [
            (lambda: httpx.ConnectError("connection refused"), True),
            (lambda: httpx.ReadTimeout("read timed out"), True),
            (lambda: ValueError("bad document"), False),
            (lambda: RuntimeError("unclassified failure"), False),
            (lambda: rag_worker_main.TransientError("temporary"), True),
            (lambda: rag_worker_main.PermanentError("invalid input"), False),
        ],
        ids=[
            "connect-error-transient",
            "read-timeout-transient",
            "value-error-permanent",
            "unclassified-unknown-permanent",
            "transient-error-type",
            "permanent-error-type",
        ],
    )
    def test_retryable_is_derived_from_classify_error(self, exc_factory, expected_retryable):
        processor = _make_processor()
        exc = exc_factory()
        processor._validate_processing_request = AsyncMock(side_effect=exc)

        _run(processor.process_document("u1", "__ungrouped__", "res-1", "job-1"))

        details = _failed_payloads(processor)[0]["details"]
        assert details["retryable"] is expected_retryable
        assert details["retryable"] == rag_worker_main.classify_error(exc)


# ---------------------------------------------------------------------------
# rag-api failed-branch persistence (real run_transactional_update logic).
# ---------------------------------------------------------------------------
class TestRagApiFailedBranchPersistence:
    def test_worker_provided_values_persisted_unchanged(self):
        details = {
            "error_message": "Document res-1 not found at users/u1/resources/res-1",
            "stage": "starting",
            "retryable": False,
        }
        main_update, summary_update = _run_failed_branch(details)

        assert main_update["status"] == "failed"
        assert main_update["error"] == details["error_message"]
        assert main_update["error_stage"] == details["stage"]
        assert main_update["retryable"] == details["retryable"]

        error_subdoc = summary_update["error"]
        assert error_subdoc["message"] == details["error_message"]
        assert error_subdoc["stage"] == details["stage"]
        # error_code stays "UNKNOWN" unless a code is actually sent.
        assert error_subdoc["code"] == "UNKNOWN"

    def test_retryable_false_is_not_silently_defaulted(self):
        details = {
            "error_message": "boom",
            "stage": "embeddings_complete",
            "retryable": False,
        }
        main_update, _ = _run_failed_branch(details)
        assert main_update["retryable"] is False

    def test_retryable_true_payload_persists_true(self):
        details = {
            "error_message": "upstream timeout",
            "stage": "tagging_complete",
            "retryable": True,
        }
        main_update, _ = _run_failed_branch(details)
        assert main_update["retryable"] is True

    def test_persisted_error_is_not_the_fallback_string(self):
        details = {
            "error_message": "real underlying cause",
            "stage": "text_retrieved",
            "retryable": True,
        }
        main_update, summary_update = _run_failed_branch(details)
        assert main_update["error"] != "Processing failed"
        assert summary_update["error"]["message"] != "Processing failed"


# ---------------------------------------------------------------------------
# End-to-end: the worker's actual published failure payload fed through
# rag-api's real failed branch.
# ---------------------------------------------------------------------------
class TestWorkerToApiFailureContract:
    @pytest.mark.parametrize(
        "exc_factory",
        [
            lambda: ValueError("Document res-1 not found"),
            lambda: httpx.ReadTimeout("embedding upstream timed out"),
        ],
        ids=["permanent-classified", "transient-classified"],
    )
    def test_worker_failure_payload_persists_verbatim(self, exc_factory):
        processor = _make_processor()
        exc = exc_factory()
        processor._validate_processing_request = AsyncMock(side_effect=exc)

        _run(processor.process_document("u1", "__ungrouped__", "res-1", "job-1"))
        payload = _failed_payloads(processor)[0]
        details = payload["details"]

        main_update, summary_update = _run_failed_branch(details)

        assert main_update["error"] == details["error_message"]
        assert main_update["error_stage"] == details["stage"]
        assert main_update["retryable"] == details["retryable"]
        # The persisted retryable equals the worker's own classification —
        # the record tells the truth about ACK/NACK behavior.
        assert main_update["retryable"] == rag_worker_main.classify_error(exc)
        assert summary_update["error"]["message"] == details["error_message"]
        assert summary_update["error"]["stage"] == details["stage"]
        # None of the rag-api fallback defaults may be operative.
        assert main_update["error"] != "Processing failed"
        assert main_update["error_stage"] is not None


# ---------------------------------------------------------------------------
# Drift guards: static AST checks pinning the payload key sets on both sides,
# following the fixture/AST contract-test pattern in test_api_contracts.py.
# ---------------------------------------------------------------------------
def _read_source(path):
    with open(path) as f:
        return f.read()


def _failed_publish_detail_keys(worker_source):
    """Keys of the failure details dict the worker publishes for status=failed."""
    tree = ast.parse(worker_source)
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == "process_document":
            for sub in ast.walk(node):
                if not isinstance(sub, ast.Call):
                    continue
                func = sub.func
                if not (isinstance(func, ast.Attribute) and func.attr == "_publish_status_update"):
                    continue
                if (
                    len(sub.args) >= 5
                    and isinstance(sub.args[3], ast.Constant)
                    and sub.args[3].value == "failed"
                ):
                    details_arg = sub.args[4]
                    if isinstance(details_arg, ast.Dict):
                        return {k.value for k in details_arg.keys if isinstance(k, ast.Constant)}
            # details may be built into a local dict before the call; scan the
            # function for dict literals carrying the contract keys.
            best = set()
            for d in ast.walk(node):
                if isinstance(d, ast.Dict):
                    keys = {k.value for k in d.keys if isinstance(k, ast.Constant)}
                    if "error_message" in keys and len(keys) > len(best):
                        best = keys
            if best:
                return best
    # Last resort: any dict literal in the module carrying error_message.
    best = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys = {k.value for k in node.keys if isinstance(k, ast.Constant)}
            if "error_message" in keys and len(keys) > len(best):
                best = keys
    return best


def _api_failed_branch_details_keys(api_source):
    """Keys rag-api's run_transactional_update reads from the details payload."""
    tree = ast.parse(api_source)
    keys = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "run_transactional_update":
            for sub in ast.walk(node):
                if (
                    isinstance(sub, ast.Call)
                    and isinstance(sub.func, ast.Attribute)
                    and sub.func.attr == "get"
                    and isinstance(sub.func.value, ast.Name)
                    and sub.func.value.id == "details"
                    and sub.args
                    and isinstance(sub.args[0], ast.Constant)
                ):
                    keys.add(sub.args[0].value)
    return keys


class TestFailurePayloadKeyDriftGuard:
    REQUIRED_KEYS = {"error_message", "stage", "retryable"}

    def test_worker_failure_payload_keys(self):
        keys = _failed_publish_detail_keys(
            _read_source(os.path.join(RAG_WORKER_DIR, "main.py"))
        )
        missing = self.REQUIRED_KEYS - keys
        assert not missing, (
            "rag-worker failure payload is missing required keys; "
            f"found {sorted(keys)}, missing {sorted(missing)}"
        )
        assert "error" in keys, (
            "legacy `error` key must be retained alongside error_message "
            "for unknown consumers of the status topic"
        )

    def test_rag_api_failed_branch_reads_worker_keys(self):
        keys = _api_failed_branch_details_keys(
            _read_source(os.path.join(RAG_API_DIR, "main.py"))
        )
        missing = self.REQUIRED_KEYS - keys
        assert not missing, (
            "rag-api failed branch no longer reads the worker's failure keys; "
            f"found {sorted(keys)}, missing {sorted(missing)}"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>