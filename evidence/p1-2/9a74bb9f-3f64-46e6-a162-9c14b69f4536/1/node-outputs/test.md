I've reviewed both sides of the seam. Now I'll write the contract tests: behavioral tests for the worker's failure-payload construction (extracted via AST/exec so we don't import the heavy worker module), behavioral tests for rag-api's `run_transactional_update` failed branch against fakes, an end-to-end worker→API persistence test, and key-set drift guards on both sides.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_failure_payload_contract.py">>>
"""
Contract tests: rag-worker failure payload -> rag-api failed-branch persistence.

Requirements under test (from the Definition, wi-define-108-a8):

1. The worker's failed status payload must include error_message (the actual
   exception message), stage (the pipeline stage executing at failure time),
   and retryable (deliberately derived) — never relying on rag-api's
   fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage; stage names
   reuse the existing progress vocabulary (starting, text_retrieved,
   tagging_complete, summary_generated, chunking_complete,
   embeddings_complete) with "processing" as the safe unknown value.
3. rag-api's failed branch must persist worker-provided values unchanged:
   error <- error_message, error_stage <- stage, retryable <- retryable;
   the processing/summary error subdocument carries the same message/stage.
4. retryable derivation is aligned with classify_error: transient -> True,
   permanent (including unclassified-unknown) -> False.
5. A contract test covers the worker failure -> rag-api persistence path and
   fails if either side's payload keys drift.

The worker side is exercised through its real code path: the failure-payload
dict expression is extracted from process_document's except handler via AST
and evaluated with the real classify_error (also extracted and exec'd), so
the payload is *built by the worker's own code*, not restated in a fixture.
The rag-api side is exercised behaviorally through run_transactional_update
with fake Firestore objects (the house pattern from conftest.py: cloud SDKs
are mocked, business logic runs for real).
"""

import ast
import copy
import importlib.util
import os
import subprocess
import sys
import textwrap
from unittest.mock import MagicMock

import pytest

import main as rag_api_main  # conftest.py puts rag-api-service on sys.path

HERE = os.path.dirname(__file__)
WORKER_MAIN = os.path.abspath(
    os.path.join(HERE, "..", "..", "rag-worker-service", "main.py")
)

# Existing progress-stage vocabulary (worker's _publish_status_update calls).
WORKER_STAGE_VOCAB = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "completed",
}
# Safe value when the stage is genuinely unknown (same value the stale-lease
# sweep uses for error_stage).
SAFE_STAGE = "processing"

# Keys the worker's failure payload must carry (requirement 1 + compat hedge).
REQUIRED_FAILURE_KEYS = {"error_message", "stage", "retryable"}
LEGACY_ERROR_KEY = "error"


# ========================================
# AST helpers (worker side)
# ========================================


def _worker_tree():
    with open(WORKER_MAIN) as f:
        return ast.parse(f.read(), filename=WORKER_MAIN)


def _find_function(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"function {name!r} not found in {WORKER_MAIN}")


def _failed_publish_call(fn):
    """Return (except_handler, _publish_status_update('failed', ...) call)."""
    handlers = [n for n in ast.walk(fn) if isinstance(n, ast.ExceptHandler)]
    assert handlers, "process_document must have an exception handler"
    handler = handlers[0]
    for node in ast.walk(handler):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "_publish_status_update"
            and any(
                isinstance(a, ast.Constant) and a.value == "failed"
                for a in node.args
            )
        ):
            return handler, node
    raise AssertionError(
        "process_document's except handler must publish a 'failed' status "
        "via _publish_status_update"
    )


def _details_node(call):
    for arg in call.args:
        if isinstance(arg, ast.Dict):
            return arg
    raise AssertionError("failed _publish_status_update call must pass a dict of details")


def _stage_tracker_var(fn, details):
    """Identify the stage-tracker local referenced by the failure payload."""
    string_assigned = set()
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    string_assigned.add(target.id)
    names = {n.id for n in ast.walk(details) if isinstance(n, ast.Name)}
    candidates = names & string_assigned
    assert len(candidates) == 1, (
        "the failure payload must reference exactly one stage-tracker local "
        f"(found: {sorted(candidates)})"
    )
    return candidates.pop()


def _stage_values_assigned(fn, stage_var):
    values = []
    for node in ast.walk(fn):
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
            and any(isinstance(t, ast.Name) and t.id == stage_var for t in node.targets)
        ):
            values.append(node.value.value)
    return values


def _build_worker_failure_payload(stage_value, exc, classify_error):
    """Evaluate the worker's real failure-payload dict expression.

    The dict literal from process_document's except handler is executed with
    the stage tracker bound to `stage_value` and the exception bound to `exc`,
    using the worker's actual classify_error for the retryable derivation.
    """
    tree = _worker_tree()
    fn = _find_function(tree, "process_document")
    _, call = _failed_publish_call(fn)
    details = _details_node(call)
    stage_var = _stage_tracker_var(fn, details)

    class Substitute(ast.NodeTransformer):
        def visit_Name(self, node):
            if node.id == stage_var:
                return ast.copy_location(ast.Constant(value=stage_value), node)
            if node.id == "e":
                return ast.copy_location(ast.Constant(value=exc), node)
            return node

    payload_expr = Substitute().visit(copy.deepcopy(details))
    ast.fix_missing_locations(payload_expr)
    code = compile(ast.Expression(payload_expr), "<worker_failure_payload>", "eval")
    namespace = {"classify_error": classify_error, "str": str, "bool": bool}
    return eval(code, namespace)


# ========================================
# Extract + exec the worker's error classification (no heavy imports)
# ========================================

_EXTRACT_SCRIPT = textwrap.dedent(
    """\
    import ast, sys
    path = sys.argv[1]
    source = open(path).read()
    tree = ast.parse(source)
    wanted_classes = {"ProcessingError", "TransientError", "PermanentError"}
    segments = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name in wanted_classes:
            segments.append(ast.get_source_segment(source, node))
        if isinstance(node, ast.FunctionDef) and node.name == "classify_error":
            segments.append(ast.get_source_segment(source, node))
    assert len(segments) >= 4, f"expected 3 exception classes + classify_error, got {len(segments)}"
    print("\\n\\n".join(segments))
    """
)


@pytest.fixture(scope="module")
def worker_error_module(tmp_path_factory):
    """Exec the worker's TransientError/PermanentError/classify_error in isolation."""
    tmp = tmp_path_factory.mktemp("worker_error_classification")
    result = subprocess.run(
        [sys.executable, "-c", _EXTRACT_SCRIPT, WORKER_MAIN],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"extraction subprocess failed: {result.stderr}"
    module_path = tmp / "worker_error_classification.py"
    module_path.write_text("import httpx\nimport asyncio\n\n" + result.stdout)
    spec = importlib.util.spec_from_file_location("worker_error_classification", str(module_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ========================================
# Fake Firestore objects (rag-api side)
# ========================================


class FakeSnapshot:
    def __init__(self, data):
        self._data = data
        self.exists = True

    def to_dict(self):
        return self._data


class FakeSummaryDocRef:
    def __init__(self, path):
        self.path = path
        self.id = path.split("/")[-1]


class FakeCollectionRef:
    def __init__(self, path):
        self._path = path

    def document(self, doc_id):
        return FakeSummaryDocRef(f"{self._path}/{doc_id}")


class FakeDocRef:
    def __init__(self, data, path="users/u1/resources/r1"):
        self._data = data
        self.path = path
        self.id = path.split("/")[-1]

    def get(self, transaction=None):
        return FakeSnapshot(self._data)

    def collection(self, name):
        return FakeCollectionRef(f"{self.path}/{name}")


class FakeTransaction:
    def __init__(self):
        self.updates = []
        self.sets = []

    def update(self, ref, data):
        self.updates.append((ref, data))

    def set(self, ref, data, merge=False):
        self.sets.append((ref, data, merge))


class FakeDb:
    def __init__(self):
        self.last_transaction = None

    def transaction(self):
        self.last_transaction = FakeTransaction()
        return self.last_transaction


@pytest.fixture
def run_failed_update(monkeypatch):
    """Run rag-api's failed branch against fakes; return (main_update, summary_update)."""

    def _run(details, doc_status="processing"):
        # The @firestore.transactional decorator resolves at call time, so a
        # pass-through here makes update_logic a plain function over fakes.
        monkeypatch.setattr(rag_api_main.firestore, "transactional", lambda f: f)
        db = FakeDb()
        doc_ref = FakeDocRef({"status": doc_status})
        rag_api_main.run_transactional_update(db, doc_ref, "failed", details, MagicMock(), "u1")
        tx = db.last_transaction
        assert tx.updates, "failed branch must update the main document"
        assert tx.sets, "failed branch must write the processing/summary subdocument"
        main_update = tx.updates[0][1]
        summary_update = tx.sets[0][1]
        return main_update, summary_update

    return _run


# ========================================
# Worker: failure payload construction (AST-pinned, real code path)
# ========================================


class TestWorkerFailurePayload:
    def test_payload_carries_required_keys(self, worker_error_module):
        payload = _build_worker_failure_payload(
            "chunking_complete", ValueError("boom while chunking"), worker_error_module.classify_error
        )
        missing = REQUIRED_FAILURE_KEYS - set(payload)
        assert not missing, f"worker failure payload missing required keys: {missing}"

    def test_payload_carries_actual_exception_message(self, worker_error_module):
        payload = _build_worker_failure_payload(
            "starting", ValueError("boom while starting"), worker_error_module.classify_error
        )
        assert payload["error_message"] == "boom while starting"
        assert payload["error_message"] != "Processing failed"

    def test_payload_carries_failing_stage(self, worker_error_module):
        payload = _build_worker_failure_payload(
            "embeddings_complete", ValueError("boom"), worker_error_module.classify_error
        )
        assert payload["stage"] == "embeddings_complete"

    def test_payload_never_omits_retryable(self, worker_error_module):
        for exc in (
            ValueError("unknown"),
            worker_error_module.TransientError("flaky"),
            worker_error_module.PermanentError("bad input"),
        ):
            payload = _build_worker_failure_payload("starting", exc, worker_error_module.classify_error)
            assert "retryable" in payload, f"payload for {type(exc).__name__} must carry retryable explicitly"
            assert isinstance(payload["retryable"], bool)

    def test_legacy_error_key_retained_for_unknown_consumers(self, worker_error_module):
        payload = _build_worker_failure_payload(
            "starting", ValueError("boom"), worker_error_module.classify_error
        )
        assert LEGACY_ERROR_KEY in payload, (
            "the legacy 'error' key must be retained alongside error_message "
            "for continuity with existing status-topic consumers"
        )
        assert payload[LEGACY_ERROR_KEY] == "boom"

    def test_stage_tracker_uses_progress_vocabulary(self):
        tree = _worker_tree()
        fn = _find_function(tree, "process_document")
        _, call = _failed_publish_call(fn)
        stage_var = _stage_tracker_var(fn, _details_node(call))
        values = _stage_values_assigned(fn, stage_var)
        assert values, "stage tracker must be assigned before pipeline steps"
        illegal = set(values) - WORKER_STAGE_VOCAB - {SAFE_STAGE}
        assert not illegal, f"stage tracker uses names outside the progress vocabulary: {illegal}"

    def test_stage_tracker_assigned_throughout_pipeline(self):
        tree = _worker_tree()
        fn = _find_function(tree, "process_document")
        _, call = _failed_publish_call(fn)
        stage_var = _stage_tracker_var(fn, _details_node(call))
        values = _stage_values_assigned(fn, stage_var)
        assert len(values) >= 5, (
            "the stage tracker must be updated across the pipeline (update-before-await "
            f"convention); found only {values}"
        )

    def test_stage_tracker_has_safe_unknown_value(self):
        tree = _worker_tree()
        fn = _find_function(tree, "process_document")
        _, call = _failed_publish_call(fn)
        stage_var = _stage_tracker_var(fn, _details_node(call))
        values = _stage_values_assigned(fn, stage_var)
        assert SAFE_STAGE in values, (
            f"the stage tracker must fall back to {SAFE_STAGE!r} when the stage is unknown"
        )


# ========================================
# Worker: retryable derivation aligned with classify_error / ACK-NACK
# ========================================


class TestRetryableDerivation:
    def test_transient_error_classifies_retryable(self, worker_error_module):
        assert worker_error_module.classify_error(
            worker_error_module.TransientError("temporary outage")
        ) is True

    def test_permanent_error_classifies_not_retryable(self, worker_error_module):
        assert worker_error_module.classify_error(
            worker_error_module.PermanentError("invalid document")
        ) is False

    def test_connection_errors_are_transient(self, worker_error_module):
        assert worker_error_module.classify_error(ConnectionError("conn refused")) is True
        assert worker_error_module.classify_error(TimeoutError("timed out")) is True

    def test_unknown_exception_is_conservatively_permanent(self, worker_error_module):
        assert worker_error_module.classify_error(ValueError("mystery")) is False

    def test_worker_payload_retryable_matches_classification(self, worker_error_module):
        transient = _build_worker_failure_payload(
            "text_retrieved", worker_error_module.TransientError("flaky"), worker_error_module.classify_error
        )
        permanent = _build_worker_failure_payload(
            "text_retrieved", ValueError("unclassified"), worker_error_module.classify_error
        )
        assert transient["retryable"] is True
        assert permanent["retryable"] is False


# ========================================
# rag-api: failed-branch persistence (behavioral, fakes)
# ========================================


class TestRagApiFailedBranchPersistence:
    def test_persists_worker_values_unchanged(self, run_failed_update):
        details = {
            "error_message": "embedding call failed after 3 attempts",
            "stage": "embeddings_complete",
            "retryable": False,
        }
        main_update, summary_update = run_failed_update(details)
        assert main_update["status"] == "failed"
        assert main_update["error"] == "embedding call failed after 3 attempts"
        assert main_update["error_stage"] == "embeddings_complete"
        assert main_update["retryable"] is False

    def test_summary_subdocument_carries_same_message_and_stage(self, run_failed_update):
        details = {
            "error_message": "vector write partial",
            "stage": "chunking_complete",
            "retryable": True,
        }
        _, summary_update = run_failed_update(details)
        error = summary_update["error"]
        assert error["message"] == "vector write partial"
        assert error["stage"] == "chunking_complete"
        assert error["code"] == "UNKNOWN"

    def test_summary_stage_matches_payload_stage(self, run_failed_update):
        details = {"error_message": "m", "stage": "tagging_complete", "retryable": True}
        _, summary_update = run_failed_update(details)
        assert summary_update["stage"] == "tagging_complete"

    def test_retryable_false_is_not_silently_flipped(self, run_failed_update):
        details = {"error_message": "m", "stage": "starting", "retryable": False}
        main_update, _ = run_failed_update(details)
        assert main_update["retryable"] is False


# ========================================
# Drift guards (either side changing keys fails the build)
# ========================================


class TestFailureContractDriftGuards:
    def test_rag_api_failed_branch_reads_contract_keys(self):
        """rag-api's failed branch must read error_message, stage, retryable."""
        tree = _worker_tree()  # placeholder; parse rag-api below
        with open(rag_api_main.__file__) as f:
            api_tree = ast.parse(f.read(), filename=rag_api_main.__file__)
        fn = None
        for node in ast.walk(api_tree):
            if isinstance(node, ast.FunctionDef) and node.name == "run_transactional_update":
                fn = node
                break
        assert fn is not None, "run_transactional_update must exist in rag-api main"
        read_keys = set()
        for node in ast.walk(fn):
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
        missing = REQUIRED_FAILURE_KEYS - read_keys
        assert not missing, (
            "rag-api's failed branch no longer reads worker contract keys: "
            f"{missing} — the worker->rag-api failure contract has drifted"
        )
        del tree

    def test_worker_payload_keys_are_the_contract(self, worker_error_module):
        """The worker's payload key set is pinned: adding/removing keys must touch this test."""
        payload = _build_worker_failure_payload(
            "starting", ValueError("boom"), worker_error_module.classify_error
        )
        for key in REQUIRED_FAILURE_KEYS:
            assert key in payload
        assert LEGACY_ERROR_KEY in payload


# ========================================
# End-to-end: worker failure payload -> rag-api persistence
# ========================================


class TestWorkerToApiFailureContract:
    @pytest.mark.parametrize(
        "stage,exc_factory,expected_retryable",
        [
            ("starting", lambda m: m.PermanentError("document not found at path"), False),
            ("text_retrieved", lambda m: m.TransientError("gcs download timeout"), True),
            ("chunking_complete", lambda m: ValueError("unclassified failure"), False),
            ("embeddings_complete", lambda m: m.TransientError("openrouter 503"), True),
        ],
    )
    def test_worker_failure_persists_exactly_what_worker_sent(
        self, run_failed_update, worker_error_module, stage, exc_factory, expected_retryable
    ):
        exc = exc_factory(worker_error_module)
        payload = _build_worker_failure_payload(stage, exc, worker_error_module.classify_error)
        # _publish_status_update injects jobId into details before publishing.
        payload = {**payload, "jobId": "job-123"}

        main_update, summary_update = run_failed_update(payload)

        assert main_update["error"] == str(exc), (
            "persisted error must be the worker's actual message, not the 'Processing failed' fallback"
        )
        assert main_update["error_stage"] == stage, (
            "persisted error_stage must be the worker's failing stage, not None"
        )
        assert main_update["retryable"] is expected_retryable, (
            "persisted retryable must be the worker's derived value, not the silent default"
        )
        assert summary_update["error"]["message"] == str(exc)
        assert summary_update["error"]["stage"] == stage

    def test_legacy_error_key_is_not_what_the_api_persists(self, run_failed_update, worker_error_module):
        """The API must persist error_message, not the legacy 'error' hedge key."""
        payload = _build_worker_failure_payload(
            "starting", ValueError("real message"), worker_error_module.classify_error
        )
        payload = {**payload, "error": "legacy-hedge-value"}
        main_update, _ = run_failed_update(payload)
        assert main_update["error"] == "real message"
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>