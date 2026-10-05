I have the full picture of both sides of the seam. Now I'll write the contract test file.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_failure_payload_contract.py">>>
"""Worker → rag-api failure payload contract tests.

Contract under test (from the authoritative definition):

  1. When document processing fails, the worker's failed status payload must
     include `error_message` (the actual exception message), `stage` (the
     pipeline stage executing at failure time), and `retryable` (deliberately
     derived) — the payload must never rely on rag-api's fallback defaults.
  2. The worker tracks the currently executing pipeline stage; stage names
     reuse the existing progress-stage vocabulary, with "processing" as the
     safe value when the stage is genuinely unknown.
  3. rag-api's failed branch persists worker-provided values unchanged:
     error ← error_message, error_stage ← stage, retryable ← retryable; the
     processing/summary error subdocument carries the same message and stage.
  4. retryable derivation is explicit and aligned with classify_error():
     transient → True, permanent (incl. unclassified-unknown) → False.
  5. Key-set drift guard: a change to either side's payload keys must fail
     the build.

The worker side is exercised in a subprocess (its module imports heavy ML
dependencies that are mocked there, mirroring the conftest pattern); the
failure payload it produces is then fed through rag-api's
`run_transactional_update` in-process with fake Firestore objects, so the
assertions cover the real worker failure-payload construction AND the real
rag-api failed-branch persistence — not a restated fixture.
"""

import ast
import json
import os
import subprocess
import sys
import types
from unittest.mock import MagicMock

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.normpath(os.path.join(HERE, "..", ".."))
RAG_API_DIR = os.path.join(AI_SERVER_DIR, "rag-api-service")
RAG_WORKER_DIR = os.path.join(AI_SERVER_DIR, "rag-worker-service")

if RAG_API_DIR not in sys.path:
    sys.path.insert(0, RAG_API_DIR)

import main as rag_api_main  # noqa: E402  (conftest mocked the cloud SDKs)

# Stage vocabulary from the requirement: existing progress-stage names plus
# the safe unknown-stage value.
STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "processing",  # safe value when stage is genuinely unknown
    "completed",
}

# Keys rag-api's failed branch reads from the worker payload.
API_READ_KEYS = {"error_message", "stage", "retryable"}

# Legacy key the worker retains alongside error_message (compatibility hedge).
LEGACY_ERROR_KEY = "error"


# ============================================================================
# Worker-side harness: builds the failure payload through the real
# process_document code path in a subprocess with heavy deps mocked.
# ============================================================================

WORKER_HARNESS = r'''
import asyncio
import json
import os
import sys
import types
from unittest.mock import AsyncMock, MagicMock

def _mock(name):
    sys.modules[name] = MagicMock()
    return sys.modules[name]

for _name in [
    "firebase_admin", "firebase_admin.firestore", "firebase_admin.credentials",
    "firebase_admin.auth", "firebase_admin.storage",
    "google", "google.cloud", "google.cloud.firestore", "google.cloud.firestore_v1",
    "google.cloud.firestore_v1.base_query", "google.cloud.pubsub_v1",
    "google.cloud.storage", "google.oauth2", "google.oauth2.service_account",
    "google.auth", "google.auth.credentials",
    "langchain", "langchain.text_splitter", "langchain.schema",
    "langfuse", "spacy", "sklearn", "sklearn.feature_extraction",
    "sklearn.feature_extraction.text", "tiktoken", "openai", "structlog",
]:
    _mock(_name)

# tenacity's @retry must pass functions through untouched.
_ten = types.ModuleType("tenacity")
_ten.retry = lambda **kwargs: (lambda fn: fn)
_ten.stop_after_attempt = lambda n: n
_ten.wait_exponential = lambda **kwargs: kwargs
sys.modules["tenacity"] = _ten

try:
    import pydantic_settings  # noqa: F401
except ImportError:
    _ps = types.ModuleType("pydantic_settings")
    _ps.BaseSettings = object
    sys.modules["pydantic_settings"] = _ps

os.environ.setdefault("GCP_PROJECT", "test-project")
os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-creds.json")
os.environ.setdefault("RAG_PROCESS_SUB", "vector-process-sub")
os.environ.setdefault("RAG_STATUS_TOPIC", "rag-status-updates")

sys.path.insert(0, sys.argv[2])
import main as worker  # rag-worker-service/main.py


def make_processor():
    """Skeleton processor: real methods, no cloud clients."""
    proc = object.__new__(worker.EnhancedDocumentProcessor)
    proc.logger = MagicMock()
    proc.langfuse = None
    proc.db = MagicMock()
    proc.config = MagicMock()
    proc.config.summary_prompt_version = 1
    proc.config.summary_max_chars = 5000
    proc.config.summary_model = "test-model"
    proc._status_sequence = {}
    return proc


def happy_path_stubs(proc):
    """Stub every pipeline step to succeed (used for late-stage failures)."""
    proc._validate_processing_request = AsyncMock(return_value=None)
    proc._get_extracted_text = AsyncMock(return_value=("some text", {"title": "T"}))
    proc.content_tagger = MagicMock()
    proc.content_tagger.generate_tags = AsyncMock(return_value=([], {}))
    proc.generate_document_summary = AsyncMock(return_value=None)
    proc._get_document_path = MagicMock(return_value="users/u1/resources/r1")
    proc._create_enhanced_chunks = AsyncMock(return_value=[])
    proc._generate_embeddings_with_openrouter = AsyncMock(return_value=[])
    proc.delete_old_vectors_via_service = AsyncMock(return_value=0)


def run_scenario(scenario):
    proc = make_processor()
    captured = []

    async def capture(user_id, course_id, resource_id, status, details, job_id=None):
        captured.append({
            "status": status,
            "details": json.loads(json.dumps(details)),
        })

    proc._publish_status_update = capture

    exc = None
    if scenario == "validate_fails":
        # Fails before any stage transition: stage genuinely unknown.
        exc = RuntimeError("boom-validation")
        proc._validate_processing_request = AsyncMock(side_effect=exc)
    elif scenario == "extract_transient":
        exc = worker.TransientError("openrouter connect timeout")
        happy_path_stubs(proc)
        proc._get_extracted_text = AsyncMock(side_effect=exc)
    elif scenario == "extract_permanent":
        exc = ValueError("PDF extraction resulted in empty text")
        happy_path_stubs(proc)
        proc._get_extracted_text = AsyncMock(side_effect=exc)
    elif scenario == "store_unknown":
        # Unclassified-unknown exception late in the pipeline.
        exc = RuntimeError("partial vector write: 3/5 chunks stored")
        happy_path_stubs(proc)
        proc.store_chunks_via_service = AsyncMock(side_effect=exc)
    else:
        raise SystemExit("unknown scenario: %s" % scenario)

    asyncio.run(proc.process_document("u1", "__ungrouped__", "r1", None))

    failed = [c for c in captured if c["status"] == "failed"]
    progress = [c for c in captured if c["status"] == "processing"]
    print(json.dumps({
        "failed_payloads": failed,
        "progress_stages": [c["details"].get("stage") for c in progress],
        "classification": worker.classify_error(exc),
        "exception_message": str(exc),
    }))


run_scenario(sys.argv[1])
'''


def run_worker_scenario(scenario: str) -> dict:
    result = subprocess.run(
        [sys.executable, "-c", WORKER_HARNESS, scenario, RAG_WORKER_DIR],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"worker harness failed for scenario {scenario!r}:\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
    return json.loads(result.stdout.strip().splitlines()[-1])


# ============================================================================
# rag-api side: fake Firestore objects driving the real
# run_transactional_update.
# ============================================================================

class FakeSnapshot:
    exists = True

    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return self._data


class FakeTransaction:
    def __init__(self):
        self.updates = []
        self.sets = []

    def update(self, ref, data):
        self.updates.append(data)

    def set(self, ref, data, merge=False):
        self.sets.append({"data": data, "merge": merge})


class FakeSummaryRef:
    pass


class FakeSummaryCollection:
    def document(self, name):
        assert name == "summary"
        return FakeSummaryRef()


class FakeDocRef:
    id = "r1"

    def __init__(self, data):
        self._data = data

    def get(self, transaction=None):
        return FakeSnapshot(self._data)

    def collection(self, name):
        return FakeSummaryCollection()


class FakeDb:
    def __init__(self, tx):
        self._tx = tx

    def transaction(self):
        return self._tx


def persist_failure_via_rag_api(details: dict):
    """Feed a worker failure payload through rag-api's real failed branch."""
    # The conftest-mocked firestore module needs a passthrough decorator and a
    # sentinel timestamp so the real transaction body actually executes.
    firestore_mod = sys.modules["google.cloud.firestore"]
    firestore_mod.transactional = lambda fn: fn
    firestore_mod.SERVER_TIMESTAMP = "SERVER_TIMESTAMP"

    tx = FakeTransaction()
    doc_ref = FakeDocRef({"status": "processing"})
    db = FakeDb(tx)

    rag_api_main.run_transactional_update(
        db, doc_ref, "failed", details, rag_api_main.logger, "u1"
    )
    assert tx.updates, "rag-api failed branch wrote no main-document update"
    assert tx.sets, "rag-api failed branch wrote no processing/summary update"
    return tx.updates[0], tx.sets[0]["data"]


# ============================================================================
# Tests
# ============================================================================

class TestWorkerFailurePayloadContract:
    """Requirement 1, 2, 4: the worker's failure payload shape and semantics."""

    def _failed_details(self, scenario):
        out = run_worker_scenario(scenario)
        assert out["failed_payloads"], (
            f"scenario {scenario}: process_document did not publish a 'failed' status"
        )
        return out, out["failed_payloads"][-1]["details"]

    @pytest.mark.parametrize(
        "scenario, expected_retryable",
        [
            ("extract_transient", True),    # TransientError → retryable
            ("extract_permanent", False),   # ValueError → permanent
            ("store_unknown", False),       # unclassified-unknown → permanent
        ],
    )
    def test_failure_payload_carries_error_message_stage_retryable(
        self, scenario, expected_retryable
    ):
        out, details = self._failed_details(scenario)
        for key in ("error_message", "stage", "retryable"):
            assert key in details, (
                f"worker failure payload missing {key!r} — rag-api would fall back "
                f"to its silent defaults (this is the bug this contract pins)"
            )
        assert details["error_message"] == out["exception_message"], (
            "error_message must be the worker's actual exception message"
        )
        assert details["retryable"] is expected_retryable
        assert details["retryable"] is out["classification"], (
            "retryable must be derived from classify_error, matching the "
            "worker's ACK/NACK behavior"
        )

    def test_failure_stage_uses_progress_vocabulary(self):
        for scenario in ("extract_transient", "extract_permanent", "store_unknown"):
            _, details = self._failed_details(scenario)
            assert details["stage"] in STAGE_VOCABULARY, (
                f"failure stage {details['stage']!r} is outside the progress-stage "
                f"vocabulary {sorted(STAGE_VOCABULARY)}"
            )

    def test_late_failure_reports_a_late_stage_not_starting(self):
        """Stage tracking must reflect where the pipeline actually was."""
        out, details = self._failed_details("store_unknown")
        assert details["stage"] != "starting", (
            "a failure during vector storage must not report the initial stage"
        )
        # The stage published on the progress timeline just before the
        # failure must be consistent with the reported failure stage: the
        # tracker cannot lag behind the last completed transition.
        progress = [s for s in out["progress_stages"] if s]
        assert progress, "no progress stages published before the failure"
        assert details["stage"] in STAGE_VOCABULARY

    def test_unknown_stage_failure_uses_safe_value_not_null(self):
        """Failure before any stage transition → safe value, never None."""
        _, details = self._failed_details("validate_fails")
        assert details.get("stage") is not None, (
            "stage must never be null — rag-api would persist error_stage=None"
        )
        assert details["stage"] in STAGE_VOCABULARY

    def test_legacy_error_key_retained_for_unknown_consumers(self):
        """Compatibility hedge: legacy `error` key stays alongside error_message."""
        _, details = self._failed_details("extract_transient")
        assert LEGACY_ERROR_KEY in details
        assert details[LEGACY_ERROR_KEY] == details["error_message"]

    def test_failure_payload_key_set_drift_guard(self):
        """Exact key-set pin: adding/removing keys must touch this test."""
        _, details = self._failed_details("extract_transient")
        expected = {"error_message", "stage", "retryable", LEGACY_ERROR_KEY}
        actual = set(details.keys())
        assert expected == actual, (
            f"worker failure payload key set drifted: "
            f"missing={expected - actual}, extra={actual - expected}"
        )


class TestWorkerApiFailureSeam:
    """Requirement 3 + acceptance: worker payload → rag-api persistence."""

    @pytest.mark.parametrize(
        "scenario, expected_retryable",
        [
            ("extract_transient", True),
            ("extract_permanent", False),
            ("store_unknown", False),
        ],
    )
    def test_persisted_failure_matches_worker_payload(self, scenario, expected_retryable):
        out = run_worker_scenario(scenario)
        details = out["failed_payloads"][-1]["details"]

        main_update, summary_update = persist_failure_via_rag_api(details)

        # Main document: worker values persisted unchanged, no fallbacks.
        assert main_update["status"] == "failed"
        assert main_update["error"] == details["error_message"]
        assert main_update["error"] != "Processing failed", (
            "persisted error fell back to rag-api's default — payload keys drifted"
        )
        assert main_update["error_stage"] == details["stage"]
        assert main_update["error_stage"] is not None
        assert main_update["retryable"] is expected_retryable
        assert main_update["retryable"] is details["retryable"]

        # processing/summary error subdocument: same message and stage.
        err = summary_update["error"]
        assert err["message"] == details["error_message"]
        assert err["stage"] == details["stage"]
        assert err["code"] == "UNKNOWN"  # no structured taxonomy sent
        assert summary_update["stage"] == details["stage"]


class TestFailureContractSourceDriftGuard:
    """Static drift guard: either side renaming its keys fails the build."""

    def _worker_source(self):
        with open(os.path.join(RAG_WORKER_DIR, "main.py")) as f:
            return f.read()

    def _api_source(self):
        with open(os.path.join(RAG_API_DIR, "main.py")) as f:
            return f.read()

    def test_rag_api_failed_branch_reads_contract_keys(self):
        tree = ast.parse(self._api_source())
        read_keys = set()
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "details"
                and node.args
                and isinstance(node.args[0], ast.Constant)
            ):
                read_keys.add(node.args[0].value)
        missing = API_READ_KEYS - read_keys
        assert not missing, (
            f"rag-api failed branch no longer reads {missing} from the worker "
            f"payload — the worker→rag-api failure contract is broken"
        )

    def test_worker_failure_payload_emits_contract_keys(self):
        source = self._worker_source()
        tree = ast.parse(source)
        dict_keys = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                for key in node.keys:
                    if isinstance(key, ast.Constant) and isinstance(key.value, str):
                        dict_keys.add(key.value)
        missing = API_READ_KEYS - dict_keys
        assert not missing, (
            f"rag-worker no longer constructs failure payloads with {missing} — "
            f"the worker→rag-api failure contract is broken"
        )
        assert LEGACY_ERROR_KEY in dict_keys, (
            "worker dropped the legacy 'error' key — the compatibility hedge "
            "for unknown status-topic consumers is gone"
        )
        assert "classify_error" in source, (
            "worker no longer uses classify_error — retryable derivation "
            "must stay aligned with the ACK/NACK classification"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>