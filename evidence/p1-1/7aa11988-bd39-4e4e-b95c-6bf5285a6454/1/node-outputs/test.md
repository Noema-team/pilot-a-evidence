I have the full picture of both sides. Now writing the contract test: worker failure payload built through the real `process_document` exception handler (in a hermetic subprocess using the worker's existing stub conftest), fed through rag-api's `run_transactional_update` with fakes, asserting persisted `error`/`error_stage`/`retryable` equal the worker's values, plus key-drift guards on both sides.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-define-108-a8/test-worker-failure-contract.md">>>
# Test artifact: worker→rag-api failure payload contract

New file: `apps/ai-server/tests/integration/test_worker_failure_contract.py`

## What it covers
1. **Worker failure payload construction** — drives the real `process_document` exception handler (not a restated fixture) in a hermetic subprocess that reuses `rag-worker-service/tests/conftest.py` stubs. Three representative scenarios:
   - `pre` — failure before the first stage transition → stage `"processing"` (safe value)
   - `early` — failure during text retrieval → stage `"text_retrieved"`
   - `late` — failure during chunking → stage `"chunking_complete"`
   - `unknown` — unclassified `RuntimeError` → retryable deliberately `False` (classify_error's conservative default)
2. **rag-api failed-branch persistence** — the captured payload `details` is fed through the real `run_transactional_update` against fakes; asserts main-doc `error`/`error_stage`/`retryable` equal the worker's values, that the fallback `"Processing failed"` / `None` / silent-`True` defaults are NOT operative, and that the `processing/summary` error subdocument carries the same message and stage with `code == "UNKNOWN"`.
3. **Drift guards** — payload key-set assertions on the worker side (`error_message`, `stage`, `retryable` required; legacy `error` retained and equal to `error_message`), and source-level assertions that rag-api's failed branch reads exactly `error_message`/`stage`/`retryable`. Either side drifting keys fails the build.
4. **retryable ↔ classify_error alignment** — the subprocess also reports `classify_error()`'s verdict for the raised exception class; the test asserts the payload's `retryable` equals it (transient → true, permanent/unknown → false).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_contract.py">>>
"""Contract test: rag-worker failure payload → rag-api failed-branch persistence.

The worker's process_document exception handler publishes a failed status whose
`details` must carry error_message (the actual exception message), stage (the
pipeline stage executing at failure time) and retryable (deliberately derived
from classify_error — never a silent default). rag-api's failed branch in
run_transactional_update reads those keys and persists error / error_stage /
retryable on the main document, plus message/stage into the
processing/summary error subdocument.

This test exercises BOTH real code paths — it never restates the contract in a
fixture:

  Worker side: a subprocess imports the worker's main.py (using the worker
  test suite's stub conftest for firebase/pubsub/openai/etc.), builds a bare
  EnhancedDocumentProcessor, makes a pipeline step raise at a chosen stage,
  runs the real process_document, and captures what the failure handler
  publishes.

  API side: the captured details dict is fed through the real
  run_transactional_update (imported from rag-api-service main.py, with the
  firebase mocks from this package's conftest) against in-memory fakes, and
  the persisted writes are asserted against the worker's values.

If either side's payload keys drift, the equality assertions and the explicit
key-set guards below fail the build.
"""

import ast
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
WORKER_DIR = os.path.join(AI_SERVER_DIR, "rag-worker-service")
WORKER_TESTS_DIR = os.path.join(WORKER_DIR, "tests")
API_DIR = os.path.join(AI_SERVER_DIR, "rag-api-service")

API_MAIN_PATH = os.path.join(API_DIR, "main.py")

USER_ID = "user-contract"
COURSE_ID = "__ungrouped__"
RESOURCE_ID = "res-contract"

# Scenarios: (name, where the pipeline raises, exception message, stage the
# tracker must report at failure time). Stage names reuse the existing
# progress-stage vocabulary; "processing" is the safe value before the first
# transition.
SCENARIOS = {
    "pre": {
        "message": "user user-contract does not own document res-contract",
        "expected_stage": "processing",
    },
    "early": {
        "message": "extracted text missing for resource res-contract",
        "expected_stage": "text_retrieved",
    },
    "late": {
        "message": "weaviate batch insert failed for res-contract",
        "expected_stage": "chunking_complete",
    },
    "unknown": {
        "message": "mystery failure while chunking res-contract",
        "expected_stage": "chunking_complete",
    },
}

# The worker driver: executed via `python -c` so the worker's heavyweight
# module-level state (Pub/Sub subscriber, service-account loading) lives and
# dies inside an isolated interpreter, and so its stub conftest never collides
# with the firebase mocks this package's conftest installs for rag-api.
WORKER_DRIVER = r'''
import asyncio
import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, sys.argv[2])        # rag-worker-service
sys.path.insert(0, sys.argv[3])        # rag-worker-service/tests

import conftest  # noqa: F401  — installs env defaults + cloud-SDK stubs
import main as worker_main

scenario = sys.argv[1]


class CapturingPublisher:
    """Stands in for _publish_status_update; records (status, details)."""

    def __init__(self):
        self.calls = []

    async def __call__(self, user_id, course_id, resource_id, status, details, job_id=None):
        self.calls.append({"status": status, "details": dict(details)})


def build_processor(scenario):
    proc = worker_main.EnhancedDocumentProcessor.__new__(
        worker_main.EnhancedDocumentProcessor
    )
    proc.config = SimpleNamespace(
        summary_prompt_version=1,
        summary_max_chars=100,
        summary_model="test-model",
        embedding_model="text-embedding-3-small",
    )
    proc.langfuse = None
    proc.embedding_cost_per_token = 0.00002
    proc._status_sequence = {}

    cap = CapturingPublisher()
    proc._publish_status_update = cap

    async def validate(u, c, r):
        pass

    proc._validate_processing_request = validate

    class Tagger:
        async def generate_tags(self, text, metadata):
            return [], {}

    proc.content_tagger = Tagger()

    async def summary(text, title):
        return {"overview": "o", "bulletPoints": []}

    proc.generate_document_summary = summary
    proc._get_document_path = lambda u, c, r: "users/%s/resources/%s" % (u, r)

    class Doc:
        def update(self, data):
            pass

    class DB:
        def document(self, path):
            return Doc()

    proc.db = DB()

    async def get_text(u, c, r):
        return "hello world", {"title": "t"}

    proc._get_extracted_text = get_text

    if scenario == "pre":
        async def boom(u, c, r):
            raise PermissionError(SCENARIOS[scenario]["message"])
        proc._validate_processing_request = boom
    elif scenario == "early":
        async def boom(u, c, r):
            raise ValueError(SCENARIOS[scenario]["message"])
        proc._get_extracted_text = boom
    elif scenario in ("late", "unknown"):
        async def boom(*a, **kw):
            if scenario == "late":
                raise worker_main.TransientError(SCENARIOS[scenario]["message"])
            raise RuntimeError(SCENARIOS[scenario]["message"])
        proc._create_enhanced_chunks = boom
    else:
        raise SystemExit("unknown scenario: %s" % scenario)

    return proc, cap


proc, cap = build_processor(scenario)
asyncio.run(proc.process_document(USER_ID, COURSE_ID, RESOURCE_ID, None))

failed = [c for c in cap.calls if c["status"] == "failed"]
assert len(failed) == 1, "expected exactly one failed status publish, got %r" % (cap.calls,)
details = failed[0]["details"]

# classify_error's verdict for the exception class raised in this scenario —
# the payload's retryable must equal it (transient -> true, else false).
if scenario == "late":
    probe = worker_main.TransientError("probe")
elif scenario == "pre":
    probe = PermissionError("probe")
elif scenario == "early":
    probe = ValueError("probe")
else:
    probe = RuntimeError("probe")

print(json.dumps({
    "status": failed[0]["status"],
    "details": details,
    "classify_error_verdict": worker_main.classify_error(probe),
}))
'''

REQUIRED_PAYLOAD_KEYS = {"error_message", "stage", "retryable"}
EXPECTED_PAYLOAD_KEYS = {"error_message", "stage", "retryable", "error"}


def _run_worker_scenario(name):
    env = os.environ.copy()
    result = subprocess.run(
        [sys.executable, "-c", WORKER_DRIVER, name, WORKER_DIR, WORKER_TESTS_DIR],
        capture_output=True,
        text=True,
        timeout=180,
        env=env,
    )
    assert result.returncode == 0, (
        "worker driver failed for scenario %r:\nstdout=%s\nstderr=%s"
        % (name, result.stdout, result.stderr)
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


# ── rag-api side fakes ────────────────────────────────────────────────────────


class FakeSnap:
    def __init__(self, data):
        self._data = dict(data)
        self.exists = True

    def to_dict(self):
        return dict(self._data)


class FakeTx:
    """Records transactional update/set writes on the doc state."""

    def __init__(self, doc_state):
        self._doc = dict(doc_state)
        self.updates = []
        self.sets = []

    def get(self, ref, transaction=None):
        return FakeSnap(self._doc)

    def update(self, ref, data):
        self._doc.update(data)
        self.updates.append(dict(data))

    def set(self, ref, data, merge=None):
        self.sets.append(dict(data))


class FakeDocRef:
    """A resource doc ref whose processing/summary subdoc resolves to itself."""

    def __init__(self, tx):
        self._tx = tx
        self.id = RESOURCE_ID
        self.path = "users/%s/resources/%s" % (USER_ID, RESOURCE_ID)

    def get(self, transaction=None):
        return FakeSnap(self._tx._doc)

    def collection(self, name):
        return self

    def document(self, name):
        return self


class FakeDb:
    def __init__(self, tx):
        self._tx = tx

    def transaction(self):
        return self._tx


class _Logger:
    def info(self, *a, **kw):
        pass

    def warning(self, *a, **kw):
        pass

    def error(self, *a, **kw):
        pass


def _run_failed_branch(details):
    """Feed the worker's payload through rag-api's real failed branch."""
    import main as rag_api_main

    saved_transactional = rag_api_main.firestore.transactional
    saved_timestamp = rag_api_main.firestore.SERVER_TIMESTAMP
    rag_api_main.firestore.transactional = lambda fn: fn
    rag_api_main.firestore.SERVER_TIMESTAMP = "SERVER_TIMESTAMP"
    try:
        tx = FakeTx({"status": "processing"})
        db = FakeDb(tx)
        ref = FakeDocRef(tx)
        rag_api_main.run_transactional_update(
            db, ref, "failed", details, _Logger(), USER_ID
        )
    finally:
        rag_api_main.firestore.transactional = saved_transactional
        rag_api_main.firestore.SERVER_TIMESTAMP = saved_timestamp
    return tx


def _assert_persistence_matches_payload(tx, details):
    """The core seam assertion: rag-api persists the worker's values unchanged."""
    assert tx.updates, "failed branch must update the main document"
    main_update = tx.updates[-1]
    assert main_update["status"] == "failed"
    assert main_update["error"] == details["error_message"], (
        "persisted error must equal the worker's error_message, got %r"
        % (main_update["error"],)
    )
    assert main_update["error_stage"] == details["stage"], (
        "persisted error_stage must equal the worker's stage, got %r"
        % (main_update["error_stage"],)
    )
    assert main_update["retryable"] == details["retryable"], (
        "persisted retryable must equal the worker's derived retryable, got %r"
        % (main_update["retryable"],)
    )
    # The fallback defaults must NOT be operative for worker failures.
    assert main_update["error"] != "Processing failed"
    assert main_update["error_stage"] is not None

    assert tx.sets, "failed branch must write the processing/summary subdoc"
    summary_update = tx.sets[-1]
    assert summary_update["error"]["message"] == details["error_message"]
    assert summary_update["error"]["stage"] == details["stage"]
    assert summary_update["error"]["code"] == "UNKNOWN"


# ── tests ─────────────────────────────────────────────────────────────────────


class TestWorkerFailurePayloadContract:
    """The worker's failure payload must carry the full contract, built by the
    real process_document exception handler."""

    def _payload(self, scenario):
        result = _run_worker_scenario(scenario)
        assert result["status"] == "failed"
        return result

    def test_payload_carries_required_keys(self):
        for scenario in SCENARIOS:
            result = self._payload(scenario)
            details = result["details"]
            missing = REQUIRED_PAYLOAD_KEYS - set(details)
            assert not missing, (
                "scenario %r: worker failure payload missing keys %s (got %s)"
                % (scenario, missing, sorted(details))
            )

    def test_payload_key_set_is_pinned(self):
        """Drift guard: the failure payload key set is deliberate. Adding or
        removing keys must fail the build so the seam is re-examined."""
        for scenario in SCENARIOS:
            details = self._payload(scenario)["details"]
            assert set(details) == EXPECTED_PAYLOAD_KEYS, (
                "scenario %r: failure payload key set drifted: %s (expected %s)"
                % (scenario, sorted(details), sorted(EXPECTED_PAYLOAD_KEYS))
            )

    def test_payload_error_message_is_actual_exception_message(self):
        for scenario, spec in SCENARIOS.items():
            details = self._payload(scenario)["details"]
            assert details["error_message"] == spec["message"], (
                "scenario %r: error_message %r != actual exception message %r"
                % (scenario, details["error_message"], spec["message"])
            )

    def test_payload_reports_failing_stage(self):
        for scenario, spec in SCENARIOS.items():
            details = self._payload(scenario)["details"]
            assert details["stage"] == spec["expected_stage"], (
                "scenario %r: stage %r != expected %r"
                % (scenario, details["stage"], spec["expected_stage"])
            )

    def test_payload_stage_uses_progress_vocabulary(self):
        allowed = {
            "processing", "starting", "text_retrieved", "tagging_complete",
            "summary_generated", "chunking_complete", "embeddings_complete",
            "completed",
        }
        for scenario in SCENARIOS:
            details = self._payload(scenario)["details"]
            assert details["stage"] in allowed, (
                "scenario %r: stage %r is outside the progress-stage vocabulary"
                % (scenario, details["stage"])
            )

    def test_payload_retryable_matches_classify_error(self):
        for scenario in SCENARIOS:
            result = self._payload(scenario)
            details = result["details"]
            assert isinstance(details["retryable"], bool), (
                "scenario %r: retryable must be a bool, got %r"
                % (scenario, details["retryable"])
            )
            assert details["retryable"] is result["classify_error_verdict"], (
                "scenario %r: retryable %r must equal classify_error's verdict %r"
                % (scenario, details["retryable"], result["classify_error_verdict"])
            )

    def test_transient_error_is_retryable_true(self):
        details = self._payload("late")["details"]
        assert details["retryable"] is True

    def test_permanent_error_is_retryable_false(self):
        details = self._payload("early")["details"]
        assert details["retryable"] is False

    def test_unclassified_unknown_error_is_retryable_false(self):
        """classify_error treats unknown exceptions as permanent; the payload
        must say so explicitly instead of relying on rag-api's silent
        retryable=True default."""
        details = self._payload("unknown")["details"]
        assert details["retryable"] is False

    def test_legacy_error_key_retained_alongside_error_message(self):
        """Compatibility hedge: unknown consumers of the status topic keep
        reading the legacy `error` key, which must carry the same message."""
        for scenario in SCENARIOS:
            details = self._payload(scenario)["details"]
            assert details["error"] == details["error_message"], (
                "scenario %r: legacy error key %r must mirror error_message %r"
                % (scenario, details["error"], details["error_message"])
            )


class TestWorkerFailureToApiPersistence:
    """The full seam: worker-built payload → rag-api's real failed branch →
    persisted document. Persisted values must equal the worker's values."""

    def _persisted(self, scenario):
        result = _run_worker_scenario(scenario)
        return result["details"], _run_failed_branch(result["details"])

    def test_early_stage_failure_persists_worker_values(self):
        details, tx = self._persisted("early")
        _assert_persistence_matches_payload(tx, details)
        assert tx.updates[-1]["error_stage"] == "text_retrieved"
        assert tx.updates[-1]["retryable"] is False

    def test_late_stage_failure_persists_worker_values(self):
        details, tx = self._persisted("late")
        _assert_persistence_matches_payload(tx, details)
        assert tx.updates[-1]["error_stage"] == "chunking_complete"
        assert tx.updates[-1]["retryable"] is True

    def test_pre_transition_failure_uses_safe_processing_stage(self):
        details, tx = self._persisted("pre")
        _assert_persistence_matches_payload(tx, details)
        assert tx.updates[-1]["error_stage"] == "processing"

    def test_unknown_error_persists_deliberate_retryable_false(self):
        details, tx = self._persisted("unknown")
        _assert_persistence_matches_payload(tx, details)
        assert tx.updates[-1]["retryable"] is False

    def test_summary_error_subdocument_matches_main_document(self):
        details, tx = self._persisted("late")
        main_update = tx.updates[-1]
        summary_update = tx.sets[-1]
        assert summary_update["error"]["message"] == main_update["error"]
        assert summary_update["error"]["stage"] == main_update["error_stage"]

    def test_missing_worker_keys_would_hit_fallback(self):
        """Sanity on the API side: a payload WITHOUT the contract keys falls
        back — proving the equality assertions above are actually
        discriminating between the aligned payload and the old broken one."""
        tx = _run_failed_branch({"error": "legacy-only payload"})
        main_update = tx.updates[-1]
        assert main_update["error"] == "Processing failed"
        assert main_update["error_stage"] is None
        assert main_update["retryable"] is True


class TestApiFailedBranchReadsWorkerKeys:
    """Static drift guard: rag-api's failed branch must read exactly the
    worker's payload keys (error_message / stage / retryable) from details.
    If the API side renames or drops a read, this fails the build."""

    @staticmethod
    def _failed_branch_source():
        with open(API_MAIN_PATH) as f:
            tree = ast.parse(f.read())
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "run_transactional_update":
                return ast.get_source_segment(open(API_MAIN_PATH).read(), node)
        raise AssertionError("run_transactional_update not found in rag-api main.py")

    def test_failed_branch_reads_error_message(self):
        src = self._failed_branch_source()
        assert 'details.get("error_message"' in src, (
            "rag-api failed branch must read details['error_message']"
        )

    def test_failed_branch_reads_stage(self):
        src = self._failed_branch_source()
        assert 'details.get("stage"' in src, (
            "rag-api failed branch must read details['stage']"
        )

    def test_failed_branch_reads_retryable(self):
        src = self._failed_branch_source()
        assert 'details.get("retryable"' in src, (
            "rag-api failed branch must read details['retryable']"
        )

    def test_persisted_field_names_unchanged(self):
        """No migration constraint: the persisted fields keep their names."""
        src = self._failed_branch_source()
        for field in ('"error"', '"error_stage"', '"retryable"'):
            assert field in src, (
                "rag-api failed branch must keep persisting %s" % field
            )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>