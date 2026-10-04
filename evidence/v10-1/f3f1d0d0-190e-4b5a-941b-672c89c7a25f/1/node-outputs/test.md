<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-108/apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""Contract tests: rag-worker failure payload -> rag-api failed-branch persistence.

Scope (Definition wi-define-108-a8):
  - The worker's failed status payload must carry error_message, stage, and
    retryable (deliberately derived from classify_error), never relying on
    rag-api's fallback defaults. Legacy `error` key is retained as a
    compatibility hedge.
  - rag-api's failed branch (run_transactional_update) must read exactly those
    keys and persist error / error_stage / retryable unchanged.
  - Stage names reuse the progress vocabulary; "processing" is the safe
    unknown value.
  - Key-set drift on either side must fail the build.

These tests are derived from the Definition's requirements, not from
implementation internals: they pin the *contract* (payload keys, derivation
mechanism, persisted field names) using AST analysis of both services plus a
functional test of the worker's classify_error semantics. No cloud
credentials, emulators, or heavy service imports are required — the tests run
hermetically, matching the house pattern in test_api_contracts.py.
"""

import ast
import json
import os
import subprocess
import sys
import types

APP_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..")
)
WORKER_MAIN = os.path.join(APP_DIR, "rag-worker-service", "main.py")
RAG_API_MAIN = os.path.join(APP_DIR, "rag-api-service", "main.py")

# The contract under test.
API_READ_KEYS = {"error_message", "stage", "retryable"}
PERSISTED_KEYS = {"error", "error_stage", "retryable"}
LEGACY_HEDGE_KEY = "error"

# Progress-stage vocabulary the failing stage must reuse (Definition F9 /
# requirement 2). "processing" is the safe unknown value.
STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
}
SAFE_UNKNOWN_STAGE = "processing"


def _read(path):
    with open(path) as f:
        return f.read()


def _parse(path):
    return ast.parse(_read(path))


def _find_function(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def _failed_publish_details_node(worker_tree):
    """Locate the details-dict AST node of the worker's failed status publish
    (the _publish_status_update call with status == "failed")."""
    for node in ast.walk(worker_tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "_publish_status_update"):
            continue
        # Signature: (user_id, course_id, resource_id, status, details, ...)
        if len(node.args) < 5:
            continue
        status_arg = node.args[3]
        if isinstance(status_arg, ast.Constant) and status_arg.value == "failed":
            details = node.args[4]
            if isinstance(details, ast.Dict):
                return details
    return None


def _dict_literal_keys(node):
    keys = set()
    for k in node.keys:
        if isinstance(k, ast.Constant) and isinstance(k.value, str):
            keys.add(k.value)
    return keys


def _dict_literal_value_for(node, key):
    for k, v in zip(node.keys, node.values):
        if isinstance(k, ast.Constant) and k.value == key:
            return v
    return None


class TestWorkerFailurePayloadKeys:
    """Requirement 1: the failed payload carries error_message/stage/retryable
    (plus the legacy `error` hedge), never relying on API-side fallbacks."""

    def test_failed_payload_has_all_contract_keys(self):
        details = _failed_publish_details_node(_parse(WORKER_MAIN))
        assert details is not None, (
            "Worker must publish a failed status via _publish_status_update "
            "with a dict-literal details payload"
        )
        keys = _dict_literal_keys(details)
        missing = API_READ_KEYS - keys
        assert not missing, (
            f"Worker failed payload missing contract keys {missing}; "
            "rag-api's failed branch reads error_message/stage/retryable and "
            "will silently fall back to defaults without them"
        )

    def test_failed_payload_retains_legacy_error_key(self):
        details = _failed_publish_details_node(_parse(WORKER_MAIN))
        assert details is not None
        keys = _dict_literal_keys(details)
        assert LEGACY_HEDGE_KEY in keys, (
            "Worker failed payload should retain the legacy 'error' key "
            "alongside error_message for unknown consumers of the status topic"
        )

    def test_error_message_is_actual_exception_message(self):
        details = _failed_publish_details_node(_parse(WORKER_MAIN))
        value = _dict_literal_value_for(details, "error_message")
        assert value is not None
        # Must be derived from the exception (str(e) / f-string of e), not a
        # constant fallback string like "Processing failed".
        is_str_call = isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "str"
        is_fstring = isinstance(value, ast.JoinedStr)
        assert is_str_call or is_fstring, (
            "error_message must carry the actual exception message "
            "(e.g. str(e)), not a constant fallback"
        )
        if is_str_call:
            assert value.args, "str() must be called on the exception"
            arg = value.args[0]
            assert isinstance(arg, ast.Name) and arg.id == "e", (
                "error_message must be str(e) — the actual exception"
            )


class TestWorkerRetryableDerivation:
    """Requirement 4: retryable is deliberately derived from classify_error —
    transient -> True, permanent/unknown -> False — never a silent default."""

    def test_retryable_is_derived_from_classify_error(self):
        details = _failed_publish_details_node(_parse(WORKER_MAIN))
        value = _dict_literal_value_for(details, "retryable")
        assert value is not None, "retryable key must be present in failed payload"
        assert isinstance(value, ast.Call), (
            "retryable must be a derived value (a call), not a constant — "
            "a literal True here would re-create the silent-default bug"
        )
        is_classify = (
            isinstance(value.func, ast.Name)
            and value.func.id == "classify_error"
        )
        assert is_classify, (
            "retryable must be derived via classify_error(e) so the persisted "
            "record matches the worker's ACK/NACK behavior"
        )
        assert value.args and isinstance(value.args[0], ast.Name) and value.args[0].id == "e", (
            "classify_error must be called on the caught exception e"
        )

    def test_classify_error_transient_semantics(self):
        """Functional check of the derivation's two sides: transient -> True,
        permanent and unclassified-unknown -> False (conservative default)."""
        result = _run_classify_error_in_subprocess()
        assert result["transient_error"] is True, "TransientError must classify as transient (retryable=true)"
        assert result["permanent_error"] is False, "PermanentError must classify as permanent (retryable=false)"
        assert result["unknown_error"] is False, (
            "Unclassified-unknown exceptions must classify as permanent "
            "(retryable=false) per classify_error's conservative default — "
            "this is the deliberate behavior change from the old silent true"
        )
        assert result["http_429"] is True, "HTTP 429 must classify as transient"
        assert result["http_400"] is False, "HTTP 4xx (non-429) must classify as permanent"


def _run_classify_error_in_subprocess():
    """Extract classify_error's source via AST and exec it in a clean
    subprocess with a stubbed httpx — avoids importing the worker module
    (which has heavy top-level cloud dependencies)."""
    tree = _parse(WORKER_MAIN)
    fn = _find_function(tree, "classify_error")
    assert fn is not None, "classify_error must exist in rag-worker-service/main.py"
    source = ast.get_source_segment(_read(WORKER_MAIN), fn)
    assert source is not None

    harness = r"""
import sys, types, json

# Minimal httpx stub with the exception classes classify_error references.
httpx = types.ModuleType("httpx")
class _HTTPXErr(Exception): pass
for name in ("ConnectError", "ConnectTimeout", "ReadTimeout",
             "WriteTimeout", "PoolTimeout"):
    setattr(httpx, name, type(name, (_HTTPXErr,), {}))
class HTTPStatusError(_HTTPXErr):
    def __init__(self, status_code):
        super().__init__(f"http {status_code}")
        self.response = types.SimpleNamespace(status_code=status_code)
httpx.HTTPStatusError = HTTPStatusError
sys.modules["httpx"] = httpx

import asyncio

ns = {}
exec(compile(SOURCE, "classify_error", "exec"), ns)
classify_error = ns["classify_error"]

class TransientError(Exception): pass
class PermanentError(Exception): pass
# classify_error references these only via isinstance; rebind into ns is not
# needed because the extracted source defines none — inject them.
import builtins
ns["TransientError"] = TransientError
ns["PermanentError"] = PermanentError

out = {
    "transient_error": classify_error(TransientError("boom")),
    "permanent_error": classify_error(PermanentError("bad input")),
    "unknown_error": classify_error(ValueError("mystery")),
    "http_429": classify_error(HTTPStatusError(429)),
    "http_400": classify_error(HTTPStatusError(400)),
}
print(json.dumps(out))
"""
    # The extracted source references TransientError/PermanentError as free
    # names; provide them in the exec namespace before exec runs.
    harness = harness.replace("ns = {}", "ns = {'TransientError': TransientError, 'PermanentError': PermanentError}")
    harness = harness.replace("SOURCE", repr(source))
    result = subprocess.run(
        [sys.executable, "-c", harness],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"classify_error harness failed: {result.stderr}")
    return json.loads(result.stdout.strip())


class TestWorkerStageTracking:
    """Requirement 2: process_document tracks the executing stage and the
    failure handler reports it; stage names reuse the progress vocabulary."""

    def test_failed_payload_stage_is_tracked_variable(self):
        details = _failed_publish_details_node(_parse(WORKER_MAIN))
        value = _dict_literal_value_for(details, "stage")
        assert value is not None, "stage key must be present in failed payload"
        assert isinstance(value, ast.Name), (
            "stage in the failed payload must come from a tracked variable "
            "set during the pipeline — a constant means the failure handler "
            "cannot report the true failing stage"
        )
        stage_var = value.id

        fn = _find_function(_parse(WORKER_MAIN), "process_document")
        assert fn is not None, "process_document must exist in the worker"
        # The tracked variable must actually be assigned inside process_document.
        assigned = False
        for node in ast.walk(fn):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == stage_var:
                        assigned = True
        assert assigned, (
            f"Failure payload reads stage variable '{stage_var}' but "
            "process_document never assigns it — stage tracking is broken"
        )

    def test_stage_tracker_uses_progress_vocabulary(self):
        fn = _find_function(_parse(WORKER_MAIN), "process_document")
        assert fn is not None
        # Find the stage variable: the Name read by the failed payload.
        details = _failed_publish_details_node(_parse(WORKER_MAIN))
        stage_value = _dict_literal_value_for(details, "stage")
        stage_var = stage_value.id if isinstance(stage_value, ast.Name) else None
        assert stage_var is not None

        assigned_constants = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == stage_var:
                        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                            assigned_constants.add(node.value.value)
        # The safe unknown value may also be assigned; everything else must
        # come from the progress vocabulary.
        non_vocab = assigned_constants - STAGE_VOCABULARY - {SAFE_UNKNOWN_STAGE}
        assert not non_vocab, (
            f"Stage tracker assigns non-vocabulary stages {non_vocab}; "
            f"stage names must reuse the progress vocabulary {sorted(STAGE_VOCABULARY)} "
            f"(plus '{SAFE_UNKNOWN_STAGE}' as the safe unknown value)"
        )
        # Representative coverage: an early stage and a late stage must both
        # be tracked (pins the update-before-await convention without
        # ossifying every step).
        assert "starting" in assigned_constants, (
            "Stage tracker must be set before the first pipeline transition "
            "(e.g. 'starting')"
        )
        late = assigned_constants & {"embeddings_complete", "chunking_complete", "summary_generated"}
        assert late, (
            "Stage tracker must cover late pipeline stages, not just startup — "
            f"found only {sorted(assigned_constants)}"
        )


class TestRagApiFailedBranch:
    """Requirement 3: rag-api's failed branch reads the worker's keys and
    persists them unchanged into the established schema."""

    def test_failed_branch_reads_worker_contract_keys(self):
        fn = _find_function(_parse(RAG_API_MAIN), "run_transactional_update")
        assert fn is not None, "run_transactional_update must exist in rag-api-service/main.py"
        read_keys = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get":
                if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                    read_keys.add(node.args[0].value)
        missing = API_READ_KEYS - read_keys
        assert not missing, (
            f"rag-api failed branch no longer reads {missing} from the "
            "worker's details payload — the worker->rag-api failure contract "
            "has drifted"
        )

    def test_failed_branch_persists_established_schema(self):
        fn = _find_function(_parse(RAG_API_MAIN), "run_transactional_update")
        assert fn is not None
        written_keys = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Dict):
                written_keys |= _dict_literal_keys(node)
        missing = PERSISTED_KEYS - written_keys
        assert not missing, (
            f"run_transactional_update no longer writes persisted failure "
            f"fields {missing} (error/error_stage/retryable are the "
            "established schema — renaming them would require a migration, "
            "which is forbidden by the Definition)"
        )


class TestCrossServiceKeyDriftGuard:
    """Requirement 5: the contract test must fail if either side's payload
    keys drift. This is the drift guard itself: worker published keys must
    cover everything rag-api reads."""

    def test_worker_payload_covers_api_reads(self):
        details = _failed_publish_details_node(_parse(WORKER_MAIN))
        assert details is not None
        published = _dict_literal_keys(details)
        missing = API_READ_KEYS - published
        assert not missing, (
            f"DRIFT: worker publishes {sorted(published)} but rag-api's "
            f"failed branch reads {sorted(API_READ_KEYS)} — missing {missing}. "
            "Every worker failure would silently fall back to rag-api's "
            "defaults (\"Processing failed\", null stage, retryable=true)."
        )

    def test_worker_payload_has_no_unknown_extra_keys(self):
        """Pin the payload shape: adding a key later must be a deliberate,
        test-visible change (that is the drift guard doing its job)."""
        details = _failed_publish_details_node(_parse(WORKER_MAIN))
        assert details is not None
        published = _dict_literal_keys(details)
        allowed = API_READ_KEYS | {LEGACY_HEDGE_KEY}
        extra = published - allowed
        assert not extra, (
            f"Worker failed payload gained unexpected keys {extra}. If this "
            "is a deliberate contract extension, update this drift guard — "
            "the payload shape is intentionally pinned."
        )


class TestStaleLeaseSweepContractUnchanged:
    """Non-goal guard: the stale-lease sweep already writes the established
    schema directly (error/error_stage/retryable with retryable=true and
    stage 'processing'); it must not regress."""

    def test_sweep_writes_established_failure_schema(self):
        fn = _find_function(_parse(WORKER_MAIN), "_fail_if_still_stale")
        assert fn is not None, "_fail_if_still_stale must exist in the worker"
        written = set()
        stage_value = None
        retryable_value = None
        for node in ast.walk(fn):
            if isinstance(node, ast.Dict):
                written |= _dict_literal_keys(node)
                v = _dict_literal_value_for(node, "error_stage")
                if isinstance(v, ast.Constant):
                    stage_value = v.value
                r = _dict_literal_value_for(node, "retryable")
                if isinstance(r, ast.Constant):
                    retryable_value = r.value
        assert {"error", "error_stage", "retryable"}.issubset(written), (
            "Stale-lease sweep must keep writing error/error_stage/retryable"
        )
        assert stage_value == SAFE_UNKNOWN_STAGE, (
            f"Sweep's error_stage must stay '{SAFE_UNKNOWN_STAGE}' (the safe "
            "unknown value), got " + repr(stage_value)
        )
        assert retryable_value is True, (
            "Sweep's retryable must stay True — a dead worker is a transient "
            "condition by nature"
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>