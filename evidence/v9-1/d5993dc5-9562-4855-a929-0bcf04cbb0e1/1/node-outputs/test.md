<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="apps/ai-server/tests/integration/test_worker_failure_contract.py">>>
"""Worker → rag-api failure-path contract tests.

Derived from the authoritative Definition (wi-define-108-a8): a failed RAG
processing job must persist the worker's actual error message, the failing
pipeline stage, and a deliberately derived retryable flag. The worker must
publish error_message/stage/retryable (retaining the legacy `error` key);
rag-api's failed branch must persist them unchanged as error/error_stage/
retryable on the main document and message/stage in the processing/summary
error subdocument.

Two layers:
  1. Static (AST) drift guards on both sides' payload keys — following the
     fixture/AST house pattern in test_api_contracts.py — so a future edit to
     either side's keys fails the build.
  2. A dynamic test that feeds a worker-contract failure payload through
     rag-api's run_transactional_update against fake Firestore objects and
     asserts the persisted fields equal the worker's values (never the
     "Processing failed" / None / True fallbacks).

The worker's retryable derivation is exercised through the real
classify_error() in rag-worker-service/main.py (run in a subprocess with the
worker's own test stubs, since this conftest only stubs rag-api's deps).
"""
import ast
import json
import os
import subprocess
import sys

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RAG_API_DIR = os.path.join(REPO_ROOT, "rag-api-service")
RAG_WORKER_DIR = os.path.join(REPO_ROOT, "rag-worker-service")
RAG_API_MAIN = os.path.join(RAG_API_DIR, "main.py")
RAG_WORKER_MAIN = os.path.join(RAG_WORKER_DIR, "main.py")

# Contract keys the worker's failure payload MUST carry (Definition
# requirements + legacy-key hedge F11).
REQUIRED_WORKER_FAILURE_KEYS = {"error_message", "stage", "retryable"}
LEGACY_WORKER_FAILURE_KEY = "error"

# Existing progress-stage vocabulary (F9) plus the safe unknown-stage value.
STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "processing",
}

# rag-api's failed-branch persisted schema (F4/F6) — must not be renamed.
API_PERSISTED_FAILURE_FIELDS = {"error", "error_stage", "retryable"}


# ---------------------------------------------------------------------------
# Static extraction helpers (subprocess/AST, per test_api_contracts.py pattern)
# ---------------------------------------------------------------------------

_WORKER_PAYLOAD_KEYS_SCRIPT = """\
import ast, json, sys

with open(sys.argv[1]) as f:
    tree = ast.parse(f.read())

keys = set()

# Dict literals inside except handlers of process_document: the failure
# publisher's payload is constructed in the exception handler.
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "process_document":
        for sub in ast.walk(node):
            if isinstance(sub, ast.ExceptHandler):
                for d in ast.walk(sub):
                    if isinstance(d, ast.Dict):
                        for k in d.keys:
                            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                                keys.add(k.value)

# Dict literals passed as details= to any status-publish call, in case the
# payload is assembled outside the handler body.
for node in ast.walk(tree):
    if isinstance(node, ast.Call):
        name = ""
        if isinstance(node.func, ast.Name):
            name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            name = node.func.attr
        if "publish" in name or "status_update" in name:
            for kw in node.keywords:
                if kw.arg == "details" and isinstance(kw.value, ast.Dict):
                    for k in kw.value.keys:
                        if isinstance(k, ast.Constant) and isinstance(k.value, str):
                            keys.add(k.value)

print(json.dumps(sorted(keys)))
"""

_STAGE_CONSTANTS_SCRIPT = """\
import ast, json, sys

with open(sys.argv[1]) as f:
    tree = ast.parse(f.read())

strings = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        strings.add(node.value)
print(json.dumps(sorted(strings)))
"""


def _run_ast_script(script, path):
    result = subprocess.run(
        [sys.executable, "-c", script, path],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"AST subprocess failed: {result.stderr}")
    return set(json.loads(result.stdout.strip()))


def _get_worker_failure_payload_keys():
    return _run_ast_script(_WORKER_PAYLOAD_KEYS_SCRIPT, RAG_WORKER_MAIN)


def _get_worker_string_constants():
    return _run_ast_script(_STAGE_CONSTANTS_SCRIPT, RAG_WORKER_MAIN)


def _get_api_failed_branch_string_constants():
    with open(RAG_API_MAIN) as f:
        tree = ast.parse(f.read())
    strings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "run_transactional_update":
            for sub in ast.walk(node):
                if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                    strings.add(sub.value)
    return strings


def _classify_via_worker(exc_kind, exc_message):
    """Run the worker's real classify_error in a subprocess with the worker
    test-suite's stub conftest (which makes `import main` hermetic)."""
    script = f"""\
import sys, os, json
worker_dir = {RAG_WORKER_DIR!r}
sys.path.insert(0, worker_dir)
with open(os.path.join(worker_dir, "tests", "conftest.py")) as f:
    exec(compile(f.read(), "conftest.py", "exec"))
import main
kind = {exc_kind!r}
if kind == "transient":
    print(json.dumps({{"retryable": bool(main.classify_error(main.TransientError({exc_message!r})))}}))
elif kind == "permanent":
    print(json.dumps({{"retryable": bool(main.classify_error(main.PermanentError({exc_message!r})))}}))
else:
    print(json.dumps({{"retryable": bool(main.classify_error(RuntimeError({exc_message!r})))}}))
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"classify subprocess failed: {result.stderr}")
    return json.loads(result.stdout.strip())["retryable"]


# ---------------------------------------------------------------------------
# Fake Firestore scaffolding for rag-api's run_transactional_update
# ---------------------------------------------------------------------------

class FakeSnapshot:
    exists = True

    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return self._data


class FakeSummaryRef:
    def __init__(self):
        self.set_calls = []


class FakeCollection:
    def __init__(self, summary_ref):
        self._summary_ref = summary_ref

    def document(self, name):
        assert name == "summary"
        return self._summary_ref


class FakeDocRef:
    def __init__(self, data, summary_ref):
        self.id = "res-contract-1"
        self._data = data
        self._summary_ref = summary_ref
        self.update_calls = []

    def get(self, transaction=None):
        return FakeSnapshot(self._data)

    def collection(self, name):
        assert name == "processing"
        return FakeCollection(self._summary_ref)


class FakeTransaction:
    def __init__(self, doc_ref):
        self._doc_ref = doc_ref

    def update(self, ref, data):
        ref.update_calls.append(data)

    def set(self, ref, data, merge=False):
        ref.set_calls.append(data)


class FakeDB:
    def __init__(self, doc_ref):
        self._doc_ref = doc_ref

    def transaction(self):
        return FakeTransaction(self._doc_ref)


def _run_failed_branch(details):
    """Feed a worker failure payload through rag-api's real failed branch."""
    import main as rag_api_main

    summary_ref = FakeSummaryRef()
    doc_ref = FakeDocRef({"status": "processing"}, summary_ref)
    db = FakeDB(doc_ref)

    # The integration conftest stubs firebase_admin.firestore as a MagicMock,
    # so the @firestore.transactional decorator would swallow update_logic.
    # Replace it with identity so the real transaction body executes against
    # the fakes above.
    original = rag_api_main.firestore.transactional
    rag_api_main.firestore.transactional = lambda fn: fn
    try:
        rag_api_main.run_transactional_update(
            db, doc_ref, "failed", details, rag_api_main.logger, "user-1"
        )
    finally:
        rag_api_main.firestore.transactional = original

    assert len(doc_ref.update_calls) == 1, "failed branch must update the main doc exactly once"
    main_update = doc_ref.update_calls[0]
    assert len(summary_ref.set_calls) == 1, "failed branch must write the processing/summary doc exactly once"
    summary_update = summary_ref.set_calls[0]
    return main_update, summary_update


# ---------------------------------------------------------------------------
# Drift guards: worker side
# ---------------------------------------------------------------------------

class TestWorkerFailurePayloadContract:
    def test_failure_payload_carries_required_keys(self):
        keys = _get_worker_failure_payload_keys()
        missing = REQUIRED_WORKER_FAILURE_KEYS - keys
        assert not missing, (
            "Worker failure payload is missing contract keys "
            f"{missing} — rag-api's failed branch reads error_message/stage/"
            "retryable and will silently fall back to 'Processing failed'/"
            "None/True without them."
        )

    def test_failure_payload_retains_legacy_error_key(self):
        keys = _get_worker_failure_payload_keys()
        assert LEGACY_WORKER_FAILURE_KEY in keys, (
            "Worker failure payload must retain the legacy 'error' key "
            "alongside error_message for unknown consumers of the status topic."
        )

    def test_stage_vocabulary_is_reused_not_invented(self):
        strings = _get_worker_string_constants()
        missing = STAGE_VOCABULARY - strings
        assert not missing, (
            f"Worker source no longer references stage names {missing} — "
            "the failure handler must reuse the existing progress-stage "
            "vocabulary, with 'processing' as the safe unknown-stage value."
        )


# ---------------------------------------------------------------------------
# Drift guards: rag-api side
# ---------------------------------------------------------------------------

class TestRagApiFailedBranchContract:
    def test_failed_branch_reads_worker_payload_keys(self):
        strings = _get_api_failed_branch_string_constants()
        for key in ("error_message", "stage", "retryable"):
            assert key in strings, (
                f"rag-api failed branch no longer reads details key '{key}' — "
                "the worker→rag-api failure contract is broken."
            )

    def test_failed_branch_persists_established_schema(self):
        strings = _get_api_failed_branch_string_constants()
        missing = API_PERSISTED_FAILURE_FIELDS - strings
        assert not missing, (
            f"rag-api failed branch no longer persists {missing} — "
            "error/error_stage/retryable are the established persisted schema "
            "shared with the stale-lease sweep, enqueue-failure paths, and "
            "ResourceResponse; renaming them would require a migration."
        )

    def test_failed_branch_keeps_fallbacks_intact(self):
        strings = _get_api_failed_branch_string_constants()
        assert "Processing failed" in strings, (
            "rag-api failed branch lost its 'Processing failed' fallback — "
            "non-worker failure paths rely on it."
        )
        assert "UNKNOWN" in strings, (
            "rag-api failed branch lost the error_code 'UNKNOWN' default."
        )


# ---------------------------------------------------------------------------
# retryable derivation (worker's real classify_error)
# ---------------------------------------------------------------------------

class TestRetryableDerivation:
    def test_transient_error_derives_retryable_true(self):
        assert _classify_via_worker("transient", "upstream unavailable") is True

    def test_permanent_error_derives_retryable_false(self):
        assert _classify_via_worker("permanent", "malformed document") is False

    def test_unclassified_unknown_derives_retryable_false(self):
        # classify_error's conservative default: unknown exceptions classify
        # as permanent → retryable false (deliberate behavior change from the
        # old silent default of True).
        assert _classify_via_worker("unknown", "something unexpected") is False


# ---------------------------------------------------------------------------
# Dynamic end-to-end: worker payload → rag-api failed branch → persistence
# ---------------------------------------------------------------------------

class TestWorkerFailurePersistencePath:
    MSG = "Embeddings request failed after 3 attempts"

    def _worker_payload(self, stage, retryable):
        """The worker's failure payload per the contract: error_message/stage/
        retryable plus the retained legacy error key."""
        return {
            "error": self.MSG,
            "error_message": self.MSG,
            "stage": stage,
            "retryable": retryable,
        }

    def test_transient_failure_persists_worker_values(self):
        retryable = _classify_via_worker("transient", self.MSG)
        assert retryable is True
        main_update, summary_update = _run_failed_branch(
            self._worker_payload("embeddings_complete", retryable)
        )
        assert main_update["status"] == "failed"
        assert main_update["error"] == self.MSG
        assert main_update["error_stage"] == "embeddings_complete"
        assert main_update["retryable"] is True

    def test_permanent_failure_persists_worker_values(self):
        retryable = _classify_via_worker("permanent", self.MSG)
        assert retryable is False
        main_update, summary_update = _run_failed_branch(
            self._worker_payload("text_retrieved", retryable)
        )
        assert main_update["error"] == self.MSG
        assert main_update["error_stage"] == "text_retrieved"
        assert main_update["retryable"] is False

    def test_persisted_error_is_never_the_fallback_string(self):
        main_update, _ = _run_failed_branch(
            self._worker_payload("chunking_complete", True)
        )
        assert main_update["error"] != "Processing failed", (
            "Worker failure persisted the rag-api fallback string — the "
            "payload's error_message was not carried through."
        )

    def test_persisted_error_stage_is_never_none(self):
        main_update, _ = _run_failed_branch(
            self._worker_payload("processing", True)
        )
        assert main_update["error_stage"] is not None, (
            "error_stage regressed to None — the worker must always send a "
            "stage ('processing' when genuinely unknown)."
        )

    def test_summary_error_subdocument_matches_main_document(self):
        main_update, summary_update = _run_failed_branch(
            self._worker_payload("summary_generated", False)
        )
        err = summary_update["error"]
        assert err["message"] == main_update["error"] == self.MSG
        assert err["stage"] == main_update["error_stage"] == "summary_generated"
        assert err["code"] == "UNKNOWN", (
            "No structured error-code taxonomy in this fix: code stays "
            "'UNKNOWN' unless a code is actually sent."
        )

    def test_missing_payload_keys_still_hit_fallbacks(self):
        # Documents the fallback semantics for NON-worker failure paths;
        # the drift guards above ensure worker payloads never rely on them.
        main_update, summary_update = _run_failed_branch({})
        assert main_update["error"] == "Processing failed"
        assert main_update["error_stage"] is None
        assert main_update["retryable"] is True
        assert summary_update["error"]["message"] == "Processing failed"
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>