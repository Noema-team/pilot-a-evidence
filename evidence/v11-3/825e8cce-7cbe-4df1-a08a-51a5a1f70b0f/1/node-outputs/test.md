Tests are derived from the Definition only. Now writing the contract test file.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""Worker → rag-api failure-payload contract tests.

Derived from the authoritative Definition (wi-define-108-a8):

- The worker's failed status payload must carry ``error_message`` (actual
  exception message), ``stage`` (pipeline stage executing at failure time,
  from the existing progress-stage vocabulary with ``"processing"`` as the
  unknown-stage fallback), and ``retryable`` (deliberately derived from
  classify_error: transient → True, permanent/unknown → False). The legacy
  ``error`` key is retained for continuity with unknown consumers.
- rag-api's failed branch must persist those values unchanged: main doc
  ``error`` ← error_message, ``error_stage`` ← stage, ``retryable`` ←
  retryable; the processing/summary error subdocument carries the same
  message and stage (error_code stays "UNKNOWN" unless sent).
- Both sides of the seam are exercised (worker payload construction through
  rag-api's run_transactional_update against a fake Firestore), and key-set
  drift on either side fails the build.

The worker side is loaded in a subprocess (its module imports heavy ML
dependencies); the rag-api side is imported in-process per the existing
conftest pattern.
"""

import ast
import json
import os
import subprocess
import sys
from unittest.mock import MagicMock

import pytest

import main as rag_api_main

WORKER_MAIN = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__), "..", "..", "rag-worker-service", "main.py"
    )
)

# Existing progress-stage vocabulary the failure stage must reuse.
STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
}

# Safe value when the failing stage is genuinely unknown — same value the
# worker's stale-lease sweep uses for error_stage.
UNKNOWN_STAGE_FALLBACK = "processing"

# Exact failure-payload key set: the three contract keys plus the retained
# legacy `error` key. Any drift on either side must fail the build.
WORKER_PAYLOAD_KEYS = {"error_message", "stage", "retryable", "error"}

FALLBACK_ERROR_STRING = "Processing failed"


# ========================================
# Worker side: subprocess loader
# ========================================

_WORKER_LOAD_SCRIPT = r"""
import json
import os
import sys
import types
from unittest.mock import MagicMock

worker_main_path, error_kind, message, stage = sys.argv[1:5]

os.environ.setdefault("GCP_PROJECT", "test-project")
os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-creds.json")
os.environ.setdefault("SHARED_INTERNAL_TOKEN", "test-token")

# Heavy imports the worker module pulls at module scope. Only classify_error
# and the failure-payload builder are needed; everything cloud/ML is mocked.
# httpx stays REAL: classify_error uses isinstance() against httpx types.
for mod in [
    "langchain",
    "langchain.text_splitter",
    "langchain.schema",
    "openai",
    "langfuse",
    "firebase_admin",
    "firebase_admin.firestore",
    "firebase_admin.storage",
    "firebase_admin.credentials",
    "firebase_admin.auth",
    "google",
    "google.cloud",
    "google.cloud.pubsub_v1",
    "google.cloud.storage",
    "google.cloud.firestore_v1",
    "google.cloud.firestore_v1.base_query",
    "google.oauth2",
    "google.oauth2.service_account",
    "google.auth",
    "google.auth.credentials",
    "spacy",
    "sklearn",
    "sklearn.feature_extraction",
    "sklearn.feature_extraction.text",
    "tiktoken",
    "tenacity",
    "pydantic",
    "structlog",
]:
    sys.modules[mod] = MagicMock()

# BaseSettings is subclassed, so it must be a real class, not a MagicMock.
pydantic_settings = types.ModuleType("pydantic_settings")


class BaseSettings:
    pass


pydantic_settings.BaseSettings = BaseSettings
sys.modules["pydantic_settings"] = pydantic_settings

sys.path.insert(0, os.path.dirname(worker_main_path))
import main as worker_main  # noqa: E402

exc_cls = {
    "transient": worker_main.TransientError,
    "permanent": worker_main.PermanentError,
    "unknown": ValueError,
}[error_kind]
exc = exc_cls(message)

details = worker_main.build_failure_details(exc, stage or None)
print(json.dumps(details))
"""


def _worker_failure_details(error_kind: str, message: str, stage=None) -> dict:
    """Build the worker's failure payload through its own code path."""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            _WORKER_LOAD_SCRIPT,
            WORKER_MAIN,
            error_kind,
            message,
            stage or "",
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        pytest.fail(
            "Worker failure-payload construction failed "
            f"(error_kind={error_kind!r}):\n{result.stderr}"
        )
    return json.loads(result.stdout.strip().splitlines()[-1])


# ========================================
# Worker side: AST checks on process_document
# ========================================


def _worker_source() -> str:
    with open(WORKER_MAIN) as f:
        return f.read()


def _process_document_node():
    tree = ast.parse(_worker_source())
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == "process_document":
            return node
    pytest.fail("worker process_document function not found")


def _build_failure_details_node():
    tree = ast.parse(_worker_source())
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "build_failure_details":
            return node
    pytest.fail(
        "worker must expose a module-level build_failure_details(error, stage) "
        "helper that constructs the failure payload"
    )


class TestWorkerFailurePayloadKeys:
    """The worker's failure payload contract (key set + values)."""

    @pytest.mark.parametrize(
        "error_kind,message,stage,expected_retryable",
        [
            ("transient", "connection reset by peer", "text_retrieved", True),
            ("permanent", "PDF extraction failed: corrupt file", "text_retrieved", False),
            ("unknown", "something unexpected happened", "embeddings_complete", False),
        ],
    )
    def test_payload_carries_error_message_stage_retryable(
        self, error_kind, message, stage, expected_retryable
    ):
        details = _worker_failure_details(error_kind, message, stage)

        assert details["error_message"] == message, (
            "failure payload must carry the actual exception message as error_message"
        )
        assert details["stage"] == stage, (
            "failure payload must carry the failing pipeline stage as stage"
        )
        assert details["retryable"] is expected_retryable, (
            "retryable must be deliberately derived from classify_error "
            "(transient → True, permanent/unknown → False), never defaulted"
        )

    def test_legacy_error_key_retained_for_unknown_consumers(self):
        details = _worker_failure_details("permanent", "boom", "chunking_complete")
        assert details["error"] == "boom", (
            "the legacy `error` key must be retained alongside error_message"
        )

    def test_payload_key_set_has_no_drift(self):
        details = _worker_failure_details("transient", "boom", "starting")
        assert set(details.keys()) == WORKER_PAYLOAD_KEYS, (
            "failure payload key set drifted: "
            f"expected {sorted(WORKER_PAYLOAD_KEYS)}, got {sorted(details.keys())}"
        )

    def test_unknown_stage_falls_back_to_processing(self):
        details = _worker_failure_details("permanent", "boom", None)
        assert details["stage"] == UNKNOWN_STAGE_FALLBACK, (
            "when the stage is genuinely unknown the payload must use the safe "
            f"value {UNKNOWN_STAGE_FALLBACK!r}, never None"
        )

    def test_stage_names_reuse_progress_vocabulary(self):
        for stage in STAGE_VOCABULARY:
            details = _worker_failure_details("transient", "boom", stage)
            assert details["stage"] == stage


class TestWorkerStageTracking:
    """process_document must track the executing stage for the failure handler."""

    def test_stage_tracker_covers_representative_stages(self):
        """The stage tracker must be assigned the progress-stage names inside
        process_document — an early stage and a late stage at minimum — so the
        failure handler reports the true failing stage."""
        fn = _process_document_node()
        tracked = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Assign):
                if isinstance(node.value, ast.Constant) and node.value.value in STAGE_VOCABULARY:
                    tracked.add(node.value.value)
        representative = {"starting", "text_retrieved", "chunking_complete", "embeddings_complete"}
        missing = representative - tracked
        assert not missing, (
            "process_document must set the stage tracker before each pipeline "
            f"step; missing tracker assignments for: {sorted(missing)}"
        )

    def test_failed_publish_uses_failure_payload_builder(self):
        """The exception handler's failed-status publish must route through
        build_failure_details (which derives error_message/stage/retryable),
        not a bare {\"error\": str(e)} payload."""
        fn = _process_document_node()
        failed_publishes = []
        for node in ast.walk(fn):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                if node.func.attr == "_publish_status_update" and len(node.args) >= 3:
                    arg1 = node.args[1]
                    if isinstance(arg1, ast.Constant) and arg1.value == "failed":
                        failed_publishes.append(node)
        assert failed_publishes, "process_document must publish a 'failed' status"
        for call in failed_publishes:
            details_arg = call.args[2]
            assert isinstance(details_arg, ast.Call) and isinstance(
                details_arg.func, ast.Name
            ) and details_arg.func.id == "build_failure_details", (
                "the failed-status details must be built by build_failure_details "
                "so error_message/stage/retryable are always present"
            )


# ========================================
# rag-api side: failed-branch persistence (fake Firestore)
# ========================================


class _FakeSnapshot:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return self._data or {}


class _FakeTransaction:
    def __init__(self, doc_ref):
        self.doc_ref = doc_ref

    def update(self, ref, update_data):
        ref.apply_update(update_data)

    def set(self, ref, data, merge=False):
        ref.apply_set(data, merge=merge)


class _FakeDocRef:
    """Minimal Firestore document ref covering run_transactional_update."""

    def __init__(self, data):
        self.data = dict(data)
        self.updates = []
        self.sets = []
        self.id = "res-1"

    def get(self, transaction=None):
        return _FakeSnapshot(self.data)

    def apply_update(self, update_data):
        self.updates.append(update_data)
        self.data.update(update_data)

    def apply_set(self, data, merge=False):
        self.sets.append(data)
        if merge:
            self.data.update(data)
        else:
            self.data = dict(data)

    def collection(self, name):
        return self

    def document(self, name):
        return self


class _FakeDB:
    def transaction(self):
        return _FakeTransaction(None)


@pytest.fixture
def fake_firestore(monkeypatch):
    """Replace the mocked firestore module attributes with fakes so the
    @firestore.transactional decorator runs the real update logic."""
    monkeypatch.setattr(rag_api_main.firestore, "transactional", lambda f: f)
    monkeypatch.setattr(rag_api_main.firestore, "SERVER_TIMESTAMP", "SERVER_TIMESTAMP")
    return rag_api_main.firestore


def _failed_resource_doc():
    return _FakeDocRef({"status": "processing", "userId": "user-1"})


def _summary_error_writes(doc_ref):
    """The processing/summary error subdocument writes (via merge sets)."""
    out = []
    for s in doc_ref.sets:
        err = s.get("error")
        if isinstance(err, dict) and "message" in err:
            out.append(err)
    return out


class TestWorkerToApiFailurePersistence:
    """End-to-end: worker payload → rag-api run_transactional_update →
    persisted error / error_stage / retryable."""

    def test_permanent_failure_persists_worker_values(self, fake_firestore):
        message = "PDF extraction failed: corrupt file"
        details = _worker_failure_details("permanent", message, "text_retrieved")
        doc_ref = _failed_resource_doc()

        rag_api_main.run_transactional_update(
            _FakeDB(), doc_ref, "failed", details, rag_api_main.logger, "user-1"
        )

        assert doc_ref.data["status"] == "failed"
        assert doc_ref.data["error"] == message, (
            "persisted error must be the worker's actual message, not the "
            f"{FALLBACK_ERROR_STRING!r} fallback"
        )
        assert doc_ref.data["error_stage"] == "text_retrieved", (
            "persisted error_stage must be the worker's failing stage, not None"
        )
        assert doc_ref.data["retryable"] is False, (
            "persisted retryable must be the worker's derived value"
        )

    def test_transient_failure_persists_retryable_true(self, fake_firestore):
        details = _worker_failure_details("transient", "upstream 503", "embeddings_complete")
        doc_ref = _failed_resource_doc()

        rag_api_main.run_transactional_update(
            _FakeDB(), doc_ref, "failed", details, rag_api_main.logger, "user-1"
        )

        assert doc_ref.data["error"] == "upstream 503"
        assert doc_ref.data["error_stage"] == "embeddings_complete"
        assert doc_ref.data["retryable"] is True

    def test_summary_error_subdocument_carries_same_message_and_stage(
        self, fake_firestore
    ):
        message = "vector write partial: 3/10 chunks stored"
        details = _worker_failure_details("permanent", message, "chunking_complete")
        doc_ref = _failed_resource_doc()

        rag_api_main.run_transactional_update(
            _FakeDB(), doc_ref, "failed", details, rag_api_main.logger, "user-1"
        )

        errors = _summary_error_writes(doc_ref)
        assert errors, "failed branch must write an error subdocument to processing/summary"
        subdoc = errors[-1]
        assert subdoc["message"] == message
        assert subdoc["stage"] == "chunking_complete"
        assert subdoc["code"] == "UNKNOWN", (
            "error_code must stay UNKNOWN unless a code is actually sent"
        )

    def test_unknown_stage_persists_processing_not_none(self, fake_firestore):
        details = _worker_failure_details("unknown", "mystery failure", None)
        doc_ref = _failed_resource_doc()

        rag_api_main.run_transactional_update(
            _FakeDB(), doc_ref, "failed", details, rag_api_main.logger, "user-1"
        )

        assert doc_ref.data["error"] == "mystery failure"
        assert doc_ref.data["error_stage"] == UNKNOWN_STAGE_FALLBACK
        assert doc_ref.data["retryable"] is False


class TestFailureContractDriftGuard:
    """If either side's payload keys drift, the build must fail."""

    def test_worker_payload_keys_satisfy_api_reads(self, fake_firestore):
        """The union of keys rag-api's failed branch reads (error_message,
        stage, retryable) must all be present in the worker's payload —
        none relying on rag-api's fallback defaults."""
        details = _worker_failure_details("permanent", "drift probe", "starting")
        for key in ("error_message", "stage", "retryable"):
            assert key in details, (
                f"worker failure payload lost the {key!r} key — rag-api's "
                "fallback default would silently apply again"
            )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>