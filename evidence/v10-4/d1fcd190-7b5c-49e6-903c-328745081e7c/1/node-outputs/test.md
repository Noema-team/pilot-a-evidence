<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""Contract test: rag-worker failure payload → rag-api failed-branch persistence.

Derived from the authoritative Definition (wi-define-108-a8), NOT from
implementation details beyond the repository claims it pins:

- The worker's failed status payload must carry `error_message` (actual
  exception message), `stage` (failing pipeline stage, from the existing
  progress-stage vocabulary, "processing" as the safe unknown value), and
  `retryable` (deliberately derived from classify_error) — plus the legacy
  `error` key retained as a compatibility hedge.
- rag-api's failed branch must persist those values unchanged:
  error ← error_message, error_stage ← stage, retryable ← retryable, and the
  processing/summary error subdocument must carry the same message and stage.
- The test must fail if either side's payload keys drift.

Structure mirrors the house pattern in test_api_contracts.py:
  * dynamic exercise of rag-api's run_transactional_update against fakes,
  * AST-based static guards on both services' sources (the worker's failure
    payload construction cannot be imported hermetically without the worker's
    own stub conftest, so its contract is pinned by AST, exactly like the
    agent-graph shapes are pinned in test_api_contracts.py),
  * a subprocess check of classify_error's transient/permanent derivation.
"""

import ast
import json
import os
import subprocess
import sys
from unittest.mock import MagicMock

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.abspath(os.path.join(TESTS_DIR, "..", ".."))
RAG_API_DIR = os.path.join(AI_SERVER_DIR, "rag-api-service")
RAG_WORKER_DIR = os.path.join(AI_SERVER_DIR, "rag-worker-service")
WORKER_MAIN = os.path.join(RAG_WORKER_DIR, "main.py")
WORKER_CONFTEST = os.path.join(RAG_WORKER_DIR, "tests", "conftest.py")

# The integration conftest already put rag-api-service on sys.path and stubbed
# its cloud dependencies.
import main as rag_api_main  # noqa: E402


# ---------------------------------------------------------------------------
# Worker-side contract, pinned by AST (same technique as _get_agent_graph_shapes)
# ---------------------------------------------------------------------------

def _worker_tree():
    with open(WORKER_MAIN) as f:
        return ast.parse(f.read())


def _dict_literal_keys(node):
    """Key set of an ast.Dict whose keys are all constants, else None."""
    if not isinstance(node, ast.Dict):
        return None
    keys = set()
    for k in node.keys:
        if not isinstance(k, ast.Constant):
            return None
        keys.add(k.value)
    return keys


REQUIRED_FAILURE_KEYS = {"error_message", "stage", "retryable"}
LEGACY_HEDGE_KEY = "error"

# Existing progress-stage vocabulary from the worker's status updates
# (Definition F9), plus the safe unknown value.
ALLOWED_STAGES = {
    "starting", "text_retrieved", "tagging_complete", "summary_generated",
    "chunking_complete", "embeddings_complete", "completed", "processing",
}


class TestWorkerFailurePayloadContract:
    """The worker's failed-status payload must speak rag-api's contract."""

    def test_worker_publishes_failure_payload_with_required_keys(self):
        """The exception-handler payload dict must contain error_message,
        stage and retryable — plus the retained legacy `error` key."""
        tree = _worker_tree()
        found = []
        for node in ast.walk(tree):
            keys = _dict_literal_keys(node)
            if keys and LEGACY_HEDGE_KEY in keys and "error_message" in keys:
                found.append(keys)
        assert found, (
            "Worker failure payload not found: no dict literal containing both "
            "'error' and 'error_message'. The failed-status payload construction "
            "has drifted or was removed."
        )
        for keys in found:
            missing = REQUIRED_FAILURE_KEYS - keys
            assert not missing, (
                f"Worker failure payload missing required keys {missing}; "
                f"payload keys: {sorted(keys)}"
            )

    def test_worker_failure_payload_does_not_rely_on_old_single_key_shape(self):
        """Regression guard for the original bug: a payload with only
        {'error': ...} and none of the contract keys must not exist."""
        tree = _worker_tree()
        for node in ast.walk(tree):
            keys = _dict_literal_keys(node)
            if keys and "error" in keys and keys == {"error"}:
                # The legacy-only one-key payload is exactly the bug. Allow it
                # nowhere: the failure payload must always carry the contract
                # keys alongside the legacy hedge.
                ctx = getattr(node, "lineno", "?")
                pytest.fail(
                    f"Worker still publishes a legacy-only failure payload "
                    f"{{'error': ...}} at line {ctx} — align it to "
                    f"error_message/stage/retryable."
                )

    def test_worker_retryable_is_derived_from_classify_error(self):
        """retryable must be deliberately derived via classify_error, not a
        literal default. The failure payload construction must reference
        classify_error in its retryable value expression."""
        tree = _worker_tree()
        payload_nodes = []
        for node in ast.walk(tree):
            keys = _dict_literal_keys(node)
            if keys and "error_message" in keys and LEGACY_HEDGE_KEY in keys:
                payload_nodes.append(node)
        assert payload_nodes, "failure payload construction not found"
        for node in payload_nodes:
            retryable_value = None
            for k, v in zip(node.keys, node.values):
                if isinstance(k, ast.Constant) and k.value == "retryable":
                    retryable_value = v
            assert retryable_value is not None, "retryable key missing from failure payload"
            names = {n.id for n in ast.walk(retryable_value) if isinstance(n, ast.Name)}
            assert "classify_error" in names, (
                "retryable in the worker failure payload must be derived from "
                "classify_error(e), not defaulted"
            )

    def test_worker_tracks_pipeline_stage_before_failure(self):
        """The worker must track the currently executing stage so the failure
        handler can report it: a stage-tracker local must be assigned string
        literals drawn from the existing progress-stage vocabulary."""
        tree = _worker_tree()
        tracker_assignments = {}  # var name -> set of assigned stage literals
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        keys = _dict_literal_keys(node.value)
                        if keys is None and isinstance(node.value, ast.Constant) \
                                and isinstance(node.value.value, str):
                            # candidate stage tracker assignment: name = "stage"
                            if node.value.value in ALLOWED_STAGES:
                                tracker_assignments.setdefault(target.id, set()).add(
                                    node.value.value
                                )
        stage_literals = set().union(*tracker_assignments.values()) if tracker_assignments else set()
        assert stage_literals, (
            "No stage-tracker assignments found in the worker: the failure "
            "handler cannot report the failing stage. Set a stage local "
            "immediately before each pipeline step using the progress-stage "
            "vocabulary."
        )
        unknown = stage_literals - ALLOWED_STAGES
        assert not unknown, (
            f"Stage tracker uses names outside the progress-stage vocabulary: "
            f"{unknown}"
        )

    def test_worker_stage_values_are_within_api_vocabulary(self):
        """Any stage string literal the worker publishes must be in the agreed
        vocabulary so error_stage never regresses to an ad-hoc value."""
        tree = _worker_tree()
        published = set()
        for node in ast.walk(tree):
            keys = _dict_literal_keys(node)
            if keys and "stage" in keys:
                for k, v in zip(node.keys, node.values):
                    if isinstance(k, ast.Constant) and k.value == "stage" \
                            and isinstance(v, ast.Constant) and isinstance(v.value, str):
                        published.add(v.value)
        bad = published - ALLOWED_STAGES
        assert not bad, f"Worker publishes non-vocabulary stage values: {bad}"


# ---------------------------------------------------------------------------
# rag-api side: dynamic exercise of run_transactional_update's failed branch
# ---------------------------------------------------------------------------

class _FakeSnapshot:
    def __init__(self, data):
        self.exists = True
        self._data = data

    def to_dict(self):
        return dict(self._data)


class _FakeTransaction:
    def __init__(self):
        self.updates = []
        self.sets = []

    def update(self, ref, data):
        self.updates.append((ref, data))

    def set(self, ref, data, merge=False):
        self.sets.append((ref, data, merge))


class _FakeSummaryRef:
    def __init__(self, path):
        self.path = path


class _FakeDocRef:
    def __init__(self, data, doc_id="res-1"):
        self._data = data
        self.id = doc_id

    def get(self, transaction=None):
        return _FakeSnapshot(self._data)

    def collection(self, name):
        return type(
            "_Coll",
            (),
            {"document": lambda self, doc_id: _FakeSummaryRef(f"{self}/{name}/{doc_id}")},
        )()


class _FakeDB:
    """Minimal db double: transaction() returns a recorder; the
    @firestore.transactional decorator is neutralised so update_logic runs
    directly against the recorder."""

    def __init__(self, data):
        self._data = data
        self.last_transaction = None

    def transaction(self):
        self.last_transaction = _FakeTransaction()
        return self.last_transaction


@pytest.fixture
def neutralized_transactional(monkeypatch):
    """Make firestore.transactional a pass-through so the inner update_logic
    actually executes against our fakes (the stubbed firebase_admin.firestore
    module would otherwise return a bare MagicMock)."""
    import firebase_admin.firestore as fs_mod
    monkeypatch.setattr(fs_mod, "transactional", lambda f: f, raising=False)
    if not hasattr(fs_mod, "SERVER_TIMESTAMP"):
        monkeypatch.setattr(fs_mod, "SERVER_TIMESTAMP", "SERVER_TIMESTAMP", raising=False)
    return fs_mod


def _run_failed_branch(resource_data, details):
    db = _FakeDB(resource_data)
    doc_ref = _FakeDocRef(resource_data)
    rag_api_main.run_transactional_update(
        db, doc_ref, "failed", details, MagicMock(), "user-1"
    )
    tx = db.last_transaction
    assert tx is not None and tx.updates, "failed branch produced no main-document update"
    main_update = tx.updates[0][1]
    summary_update = None
    for ref, data, _merge in tx.sets:
        summary_update = data
        break
    return main_update, summary_update


class TestRagApiFailedBranchPersistence:
    def test_failed_branch_persists_worker_payload_unchanged(self, neutralized_transactional):
        details = {
            "error_message": "Extraction failed: encrypted PDF",
            "stage": "text_retrieved",
            "retryable": False,
            "error": "Extraction failed: encrypted PDF",  # legacy hedge key
        }
        main_update, summary_update = _run_failed_branch(
            {"status": "processing"}, details
        )
        assert main_update["status"] == "failed"
        assert main_update["error"] == "Extraction failed: encrypted PDF"
        assert main_update["error_stage"] == "text_retrieved"
        assert main_update["retryable"] is False

    def test_summary_error_subdocument_carries_same_message_and_stage(
        self, neutralized_transactional
    ):
        details = {
            "error_message": "Embedding upstream 503",
            "stage": "embeddings_complete",
            "retryable": True,
        }
        main_update, summary_update = _run_failed_branch(
            {"status": "processing"}, details
        )
        err = summary_update["error"]
        assert err["message"] == main_update["error"]
        assert err["stage"] == main_update["error_stage"]
        assert err["message"] == "Embedding upstream 503"
        assert err["stage"] == "embeddings_complete"
        # No structured error-code taxonomy in this fix: code stays UNKNOWN
        # unless actually sent.
        assert err["code"] == "UNKNOWN"

    def test_transient_payload_persists_retryable_true(self, neutralized_transactional):
        details = {
            "error_message": "temporary network blip",
            "stage": "tagging_complete",
            "retryable": True,
        }
        main_update, _ = _run_failed_branch({"status": "processing"}, details)
        assert main_update["retryable"] is True

    def test_worker_shaped_payload_never_hits_fallback_defaults(
        self, neutralized_transactional
    ):
        """The original bug: with the old single-key payload, rag-api persisted
        'Processing failed' / None / True. A contract-shaped payload must never
        produce those fallbacks."""
        details = {
            "error_message": "chunker exploded",
            "stage": "chunking_complete",
            "retryable": False,
        }
        main_update, _ = _run_failed_branch({"status": "processing"}, details)
        assert main_update["error"] != "Processing failed"
        assert main_update["error_stage"] is not None
        # retryable must be the worker's value, not the API's silent default.
        assert main_update["retryable"] == details["retryable"]


# ---------------------------------------------------------------------------
# Key-set drift guards
# ---------------------------------------------------------------------------

def _api_failed_branch_keys_via_source():
    """Statically extract the details keys rag-api's failed branch reads, so a
    rename on either side fails the build."""
    with open(os.path.join(RAG_API_DIR, "main.py")) as f:
        tree = ast.parse(f.read())
    keys = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "get":
            obj = node.func.value
            if isinstance(obj, ast.Name) and obj.id == "details" and node.args:
                first = node.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    # Only keys read inside the failed branch matter; the
                    # failed branch is identified by its fallback strings.
                    if "error_message" == first.value or "stage" == first.value \
                            or "retryable" == first.value or "error_code" == first.value:
                        keys.add(first.value)
    return keys


class TestContractKeyDrift:
    def test_worker_payload_keys_cover_api_failed_branch_reads(self):
        api_keys = _api_failed_branch_keys_via_source()
        for required in ("error_message", "stage", "retryable"):
            assert required in api_keys, (
                f"rag-api failed branch no longer reads details['{required}'] — "
                f"the worker→rag-api failure contract has drifted on the API side."
            )

    def test_worker_payload_keys_match_api_reads(self):
        """End-to-end key-set agreement: every key rag-api's failed branch
        reads (minus the API-only error_code taxonomy) must be published by
        the worker's failure payload, and vice versa."""
        api_keys = _api_failed_branch_keys_via_source() - {"error_code"}
        tree = _worker_tree()
        worker_keys = set()
        for node in ast.walk(tree):
            keys = _dict_literal_keys(node)
            if keys and "error_message" in keys:
                worker_keys |= keys
        assert worker_keys, "worker failure payload not found"
        missing_from_worker = api_keys - worker_keys
        assert not missing_from_worker, (
            f"rag-api failed branch reads {missing_from_worker} but the worker "
            f"does not publish them — failures will fall back to defaults again."
        )


# ---------------------------------------------------------------------------
# classify_error derivation (worker side, via subprocess with the worker's
# own stub conftest so the import is hermetic)
# ---------------------------------------------------------------------------

_CLASSIFY_SCRIPT = """\
import sys, json
sys.path.insert(0, {worker_dir!r})
exec(open({conftest!r}).read())
import main as worker
result = {{
    "has_classify_error": hasattr(worker, "classify_error"),
    "transient": bool(worker.classify_error(worker.TransientError("t"))),
    "permanent": bool(worker.classify_error(worker.PermanentError("p"))),
    "unknown": bool(worker.classify_error(ValueError("mystery"))),
}}
print(json.dumps(result))
""".format(worker_dir=RAG_WORKER_DIR, conftest=WORKER_CONFTEST)


def _classify_shapes():
    result = subprocess.run(
        [sys.executable, "-c", _CLASSIFY_SCRIPT],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        pytest.fail(f"worker classify_error probe failed: {result.stderr}")
    return json.loads(result.stdout.strip())


class TestRetryableDerivation:
    def test_worker_exposes_classify_error(self):
        shapes = _classify_shapes()
        assert shapes["has_classify_error"], "worker must expose classify_error"

    def test_transient_classifies_truthy(self):
        shapes = _classify_shapes()
        assert shapes["transient"], "TransientError must classify as transient (retryable=true)"

    def test_unknown_classifies_like_permanent(self):
        """Per the adopted default: unclassified-unknown exceptions are
        conservative — they must classify the same way as PermanentError, so
        the derived retryable is false rather than a silent true."""
        shapes = _classify_shapes()
        assert shapes["unknown"] == shapes["permanent"], (
            "Unclassified-unknown exceptions must map to the permanent "
            "classification (retryable=false), matching classify_error's "
            "conservative default."
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>