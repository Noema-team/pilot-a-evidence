<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_payload_contract.py">>>
"""Contract tests: rag-worker failure payload → rag-api failed-branch persistence.

Derived from the authoritative definition (WorkItem wi-define-108-a8) only —
never from implementation code. The contract under test:

  1. When document processing fails, the worker's failed status payload must
     include `error_message` (the actual exception message), `stage` (the
     pipeline stage executing at failure time), and `retryable` (deliberately
     derived) — never relying on rag-api's fallback defaults.
  2. Stage names reuse the existing progress-stage vocabulary (starting,
     text_retrieved, tagging_complete, summary_generated, chunking_complete,
     embeddings_complete), with "processing" as the safe value when the stage
     is genuinely unknown.
  3. rag-api's failed branch persists the worker-provided values unchanged:
     main document error ← error_message, error_stage ← stage,
     retryable ← retryable; the processing/summary error subdocument carries
     the same message and stage.
  4. retryable derivation is explicit and aligned with classify_error:
     transient → true; permanent (including unclassified-unknown) → false.
  5. The legacy `error` key is retained alongside `error_message`
     (compatibility hedge).

The dynamic tests drive the real code paths on both sides rather than
restating the contract in a fixture:
  - the worker side runs in a subprocess (its own tests/conftest.py installs
    the cloud-SDK stubs), monkeypatches `_publish_status_update` to capture
    the published status payloads, and invokes `process_document` with
    introspected arguments so the real exception handler builds the failure
    payload;
  - the rag-api side runs in-process (the integration conftest already stubs
    firebase/google-cloud and puts rag-api-service on sys.path); the captured
    worker payload is fed into `run_transactional_update` with a fake
    (MagicMock) Firestore transaction surface, and the persisted update
    dicts are asserted against the worker's values.

Static AST drift guards pin the payload key sets on both sides so a future
edit to either side's keys fails the build instead of silently re-creating
the key-mismatch bug (house pattern: tests/integration/test_api_contracts.py).
"""

import asyncio
import ast
import functools
import inspect
import json
import os
import subprocess
import sys
from unittest import mock

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
AI_SERVER_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
RAG_API_DIR = os.path.join(AI_SERVER_DIR, "rag-api-service")
RAG_WORKER_DIR = os.path.join(AI_SERVER_DIR, "rag-worker-service")

sys.path.insert(0, RAG_API_DIR)
import main as rag_api_main  # noqa: E402  (integration conftest stubbed the cloud SDKs)

# --- contract constants (from the authoritative definition) -----------------

WORKER_FAILURE_KEYS = {"error_message", "stage", "retryable"}
LEGACY_ERROR_KEY = "error"
PERSISTED_ERROR_KEYS = {"error", "error_stage", "retryable"}
PROGRESS_STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
}
SAFE_UNKNOWN_STAGE = "processing"
ALLOWED_FAILURE_STAGES = PROGRESS_STAGE_VOCABULARY | {SAFE_UNKNOWN_STAGE}


# ============================================================================
# Worker-side probe (subprocess so the worker's own stubs are used and the
# two services' module trees never collide on sys.path).
# ============================================================================

_SUBPROCESS_SCRIPT = r'''
import asyncio, importlib.util, inspect, json, os, sys

wdir = sys.argv[1]
os.chdir(wdir)
sys.path.insert(0, wdir)
sys.path.insert(0, os.path.join(wdir, "tests"))

spec = importlib.util.spec_from_file_location(
    "worker_conftest_stubs", os.path.join(wdir, "tests", "conftest.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

import main as worker_main


class Permissive(dict):
    """Dict that also tolerates attribute access (msg.data style consumers)."""
    def __getattr__(self, k):
        return "test-" + k


def jsonable(v):
    try:
        json.dumps(v)
        return v
    except Exception:
        return repr(v)


captured = []
orig = getattr(worker_main, "_publish_status_update", None)
if orig is None:
    print(json.dumps({"fatal": "_publish_status_update not found on worker main"}))
    sys.exit(0)

if inspect.iscoroutinefunction(orig):
    async def recorder(*a, **k):
        captured.append({"args": [jsonable(x) for x in a],
                         "kwargs": {n: jsonable(v) for n, v in k.items()}})
else:
    def recorder(*a, **k):
        captured.append({"args": [jsonable(x) for x in a],
                         "kwargs": {n: jsonable(v) for n, v in k.items()}})

worker_main._publish_status_update = recorder


def fake_arg(name, param):
    if param.default is not inspect.Parameter.empty:
        return param.default
    low = name.lower()
    if any(t in low for t in ("detail", "payload", "data", "message", "msg", "body", "event")):
        return Permissive({
            "resource_id": "test-resource",
            "user_id": "test-user",
            "filename": "test.pdf",
            "status": "processing",
        })
    if low.endswith("id") or any(t in low for t in ("user", "resource", "bucket", "topic", "sub", "name")):
        return "test-" + low.replace("_", "-")
    return Permissive()


sig = inspect.signature(worker_main.process_document)
kwargs = {}
for name, p in sig.parameters.items():
    if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
        continue
    kwargs[name] = fake_arg(name, p)

exc_info = None
classification = None
try:
    res = worker_main.process_document(**kwargs)
    if inspect.iscoroutine(res):
        asyncio.run(res)
except BaseException as e:  # the failure path under test
    exc_info = {"type": type(e).__name__, "message": str(e)}
    ce = getattr(worker_main, "classify_error", None)
    if ce is not None:
        try:
            classification = jsonable(ce(e))
        except Exception as ce_err:
            classification = "classify_error failed: %r" % (ce_err,)

print(json.dumps({
    "published": captured,
    "exception": exc_info,
    "classification": classification,
}, default=repr))
'''


@functools.lru_cache(maxsize=1)
def _worker_failure_probe():
    proc = subprocess.run(
        [sys.executable, "-c", _SUBPROCESS_SCRIPT, RAG_WORKER_DIR],
        capture_output=True,
        text=True,
        timeout=180,
        cwd=RAG_WORKER_DIR,
    )
    if proc.returncode != 0:
        pytest.fail(
            "Worker failure-probe subprocess crashed (this is a harness failure, "
            "not a contract pass):\n" + (proc.stderr or "")[-4000:]
        )
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    if not lines:
        pytest.fail("Worker failure-probe produced no output.")
    out = json.loads(lines[-1])
    if "fatal" in out:
        pytest.fail("Worker failure-probe fatal: %s" % out["fatal"])
    return out


def _iter_dicts(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _iter_dicts(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _iter_dicts(v)


def _failure_payload(probe):
    """Extract the failed-status details dict from captured publishes.

    Prefers a dict carrying the new contract keys; falls back to any dict
    carrying the legacy `error` key so the drift-guard tests can fail with a
    precise message when the worker still publishes the old one-key payload.
    """
    dicts = [d for call in probe.get("published", []) for d in _iter_dicts(call)]
    with_new_keys = [d for d in dicts if WORKER_FAILURE_KEYS.issubset(d)]
    if with_new_keys:
        return with_new_keys[-1]
    with_legacy = [d for d in dicts if LEGACY_ERROR_KEY in d]
    if with_legacy:
        return with_legacy[-1]
    pytest.fail(
        "No failure status payload captured from the worker. "
        "published=%r exception=%r" % (probe.get("published"), probe.get("exception"))
    )


def _expected_retryable(classification):
    """Map classify_error's result to the contract: transient → True, else False."""
    if isinstance(classification, bool):
        return classification
    return "transient" in str(classification).lower()


# ============================================================================
# Dynamic contract tests: worker failure payload construction
# ============================================================================

class TestWorkerFailurePayload:
    """Requirement: the failed status payload carries error_message/stage/retryable."""

    @pytest.fixture(scope="class")
    def probe(self):
        return _worker_failure_probe()

    @pytest.fixture(scope="class")
    def payload(self, probe):
        return _failure_payload(probe)

    def test_payload_carries_all_required_keys(self, payload):
        missing = WORKER_FAILURE_KEYS - set(payload)
        assert not missing, (
            "Worker failure payload is missing required keys %s — rag-api's "
            "fallback defaults would silently fill in for them. Payload keys: %r"
            % (sorted(missing), sorted(payload))
        )

    def test_payload_does_not_publish_error_key_alone(self, payload):
        assert WORKER_FAILURE_KEYS.issubset(payload), (
            "Worker still publishes the legacy one-key failure payload "
            "{'error': ...} — the key-mismatch bug this contract pins."
        )

    def test_error_message_is_the_actual_exception_message(self, probe, payload):
        exc = probe.get("exception")
        assert exc, "Worker probe did not record the driving exception."
        assert payload.get("error_message") == exc["message"], (
            "error_message must be the actual exception message %r, got %r"
            % (exc["message"], payload.get("error_message"))
        )
        assert isinstance(payload.get("error_message"), str) and payload["error_message"], (
            "error_message must be a non-empty string"
        )

    def test_stage_is_present_and_in_progress_vocabulary(self, payload):
        stage = payload.get("stage")
        assert stage, "stage must be present in the failure payload (never null/missing)"
        assert stage in ALLOWED_FAILURE_STAGES, (
            "stage %r must reuse the progress-stage vocabulary %s (with %r as the "
            "safe unknown value)" % (stage, sorted(PROGRESS_STAGE_VOCABULARY), SAFE_UNKNOWN_STAGE)
        )

    def test_retryable_is_an_explicit_bool(self, payload):
        assert "retryable" in payload, "retryable must be sent explicitly by the worker"
        assert isinstance(payload["retryable"], bool), (
            "retryable must be a deliberately derived bool, got %r" % (payload["retryable"],)
        )

    def test_retryable_matches_classify_error_derivation(self, probe, payload):
        classification = probe.get("classification")
        assert classification is not None, (
            "Worker probe could not classify the exception via classify_error"
        )
        expected = _expected_retryable(classification)
        assert payload.get("retryable") is expected, (
            "retryable=%r must equal the classify_error derivation (%r → %s). "
            "Transient → true; permanent (including unclassified-unknown) → false."
            % (payload.get("retryable"), classification, expected)
        )

    def test_legacy_error_key_retained_for_unknown_consumers(self, payload):
        assert LEGACY_ERROR_KEY in payload, (
            "The legacy 'error' key must be retained alongside error_message as "
            "the compatibility hedge for unknown consumers of the status topic"
        )
        assert payload[LEGACY_ERROR_KEY] == payload.get("error_message"), (
            "legacy 'error' must carry the same message as error_message"
        )


# ============================================================================
# Dynamic contract tests: rag-api failed-branch persistence
# ============================================================================

def _collect_dicts_deep(obj):
    """Collect every dict reachable through Mock call records and containers."""
    found = []
    if isinstance(obj, mock.Mock):
        for call in obj.mock_calls:
            try:
                call_args, call_kwargs = call[1], call[2]
            except Exception:
                continue
            for a in call_args:
                found.extend(_collect_dicts_deep(a))
            for v in call_kwargs.values():
                found.extend(_collect_dicts_deep(v))
    elif isinstance(obj, dict):
        found.append(obj)
        for v in obj.values():
            found.extend(_collect_dicts_deep(v))
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            found.extend(_collect_dicts_deep(v))
    return found


class TestRagApiFailedBranchPersistence:
    """Requirement: rag-api persists the worker-provided values unchanged."""

    @pytest.fixture(scope="class")
    def probe(self):
        return _worker_failure_probe()

    @pytest.fixture(scope="class")
    def payload(self, probe):
        return _failure_payload(probe)

    @pytest.fixture(scope="class")
    def persisted_dicts(self, payload):
        fn = getattr(rag_api_main, "run_transactional_update", None)
        if fn is None:
            pytest.fail("rag-api main does not expose run_transactional_update — API side drifted.")
        sig = inspect.signature(fn)
        args = []
        for name, p in sig.parameters.items():
            if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                continue
            low = name.lower()
            if any(t in low for t in ("detail", "payload", "status_data", "failure", "error_data")):
                args.append(dict(payload))
            elif low in ("status", "new_status") or "status" in low:
                args.append("failed")
            elif "user" in low:
                args.append("test-user")
            elif "resource" in low or low.endswith("id"):
                args.append("test-resource")
            else:
                args.append(mock.MagicMock(name=name))
        result = fn(*args)
        if inspect.iscoroutine(result):
            result = asyncio.run(result)
        dicts = []
        for a in args:
            dicts.extend(_collect_dicts_deep(a))
        return dicts

    def test_main_document_persists_worker_values(self, payload, persisted_dicts):
        expected = {
            "error": payload["error_message"],
            "error_stage": payload["stage"],
            "retryable": payload["retryable"],
        }
        matches = [d for d in persisted_dicts if all(d.get(k) == v for k, v in expected.items())]
        assert matches, (
            "No persisted update carries the worker's values unchanged "
            "(error ← error_message, error_stage ← stage, retryable ← retryable). "
            "Worker payload: %r. Persisted dicts seen: %r"
            % (payload, persisted_dicts[:10])
        )

    def test_persisted_error_is_not_the_fallback_string(self, payload, persisted_dicts):
        fallback = [d for d in persisted_dicts if d.get("error") == "Processing failed"]
        assert not fallback, (
            "The failed branch persisted the fallback 'Processing failed' instead "
            "of the worker's actual message %r" % (payload["error_message"],)
        )

    def test_persisted_error_stage_is_not_null(self, payload, persisted_dicts):
        null_stage = [d for d in persisted_dicts if "error_stage" in d and d.get("error_stage") is None]
        assert not null_stage, (
            "The failed branch persisted error_stage=None instead of the worker's "
            "stage %r" % (payload["stage"],)
        )

    def test_processing_summary_error_subdocument_carries_message_and_stage(self, payload, persisted_dicts):
        subs = [
            d for d in persisted_dicts
            if d.get("message") == payload["error_message"]
            and d.get("stage") == payload["stage"]
        ]
        assert subs, (
            "The processing/summary error subdocument must carry the same message "
            "and stage as the main document. Worker payload: %r. Persisted dicts: %r"
            % (payload, persisted_dicts[:10])
        )
        for sub in subs:
            if "error_code" in sub:
                assert sub["error_code"] == "UNKNOWN", (
                    "error_code must remain the 'UNKNOWN' default unless a code is "
                    "actually sent; got %r" % (sub["error_code"],)
                )


# ============================================================================
# Static drift guards (AST-based, house pattern from test_api_contracts.py)
# ============================================================================

def _parse(path):
    with open(path, "r", encoding="utf-8") as f:
        return ast.parse(f.read())


def _dict_key_sets(tree):
    sets = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            keys = set()
            for k in node.keys:
                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                    keys.add(k.value)
            if keys:
                sets.append(keys)
    return sets


def _string_constants(tree):
    return {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }


def _subscript_and_get_keys(tree):
    keys = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) \
                and isinstance(node.slice.value, str):
            keys.add(node.slice.value)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "get" and node.args:
            first = node.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                keys.add(first.value)
    return keys


class TestWorkerFailurePayloadStaticDriftGuard:
    """Fails if the worker's failure-payload keys drift from the contract."""

    @pytest.fixture(scope="class")
    def tree(self):
        return _parse(os.path.join(RAG_WORKER_DIR, "main.py"))

    def test_failure_payload_dict_includes_contract_keys(self, tree):
        key_sets = _dict_key_sets(tree)
        assert any(WORKER_FAILURE_KEYS.issubset(ks) for ks in key_sets), (
            "No dict literal in rag-worker main.py carries the failure contract "
            "keys %s — the worker's failure payload construction drifted." % sorted(WORKER_FAILURE_KEYS)
        )

    def test_no_legacy_only_failure_dict(self, tree):
        key_sets = _dict_key_sets(tree)
        legacy_only = [ks for ks in key_sets if ks == {LEGACY_ERROR_KEY}]
        assert not legacy_only, (
            "A failure payload dict with only the legacy 'error' key still exists "
            "in rag-worker main.py — the key-mismatch bug is being re-created."
        )

    def test_safe_unknown_stage_literal_present(self, tree):
        assert SAFE_UNKNOWN_STAGE in _string_constants(tree), (
            "The safe fallback stage %r must exist in the worker's stage tracking"
            % SAFE_UNKNOWN_STAGE
        )

    def test_progress_stage_vocabulary_literals_present(self, tree):
        constants = _string_constants(tree)
        missing = PROGRESS_STAGE_VOCABULARY - constants
        assert not missing, (
            "Worker no longer references progress stage names %s — the failure "
            "stage must reuse the existing progress-stage vocabulary." % sorted(missing)
        )


class TestRagApiFailedBranchStaticDriftGuard:
    """Fails if rag-api's failed-branch reads or persisted keys drift."""

    @pytest.fixture(scope="class")
    def tree(self):
        return _parse(os.path.join(RAG_API_DIR, "main.py"))

    def test_failed_branch_reads_worker_contract_keys(self, tree):
        read_keys = _subscript_and_get_keys(tree)
        missing = WORKER_FAILURE_KEYS - read_keys
        assert not missing, (
            "rag-api main.py no longer reads the worker failure payload keys %s "
            "— the consumer side of the contract drifted." % sorted(missing)
        )

    def test_persisted_failure_schema_keys_present(self, tree):
        constants = _string_constants(tree)
        missing = PERSISTED_ERROR_KEYS - constants
        assert not missing, (
            "rag-api main.py no longer references the persisted failure schema "
            "keys %s — the persisted schema must not be renamed." % sorted(missing)
        )

    def test_error_code_unknown_default_preserved(self, tree):
        assert "UNKNOWN" in _string_constants(tree), (
            "The processing/summary error_code default 'UNKNOWN' must be preserved "
            "(no structured error-code taxonomy in this fix)"
        )


class TestCrossServiceContractConsistency:
    """The two sides must agree: worker publishes what rag-api reads."""

    def test_worker_publish_keys_superset_of_api_read_keys(self):
        worker_tree = _parse(os.path.join(RAG_WORKER_DIR, "main.py"))
        api_tree = _parse(os.path.join(RAG_API_DIR, "main.py"))
        worker_keys = set().union(*_dict_key_sets(worker_tree)) if _dict_key_sets(worker_tree) else set()
        api_read_keys = _subscript_and_get_keys(api_tree)
        missing = WORKER_FAILURE_KEYS - (worker_keys & api_read_keys)
        assert not missing, (
            "Keys %s are not both published by the worker and read by rag-api — "
            "the failure payload contract is misaligned again." % sorted(missing)
        )
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>