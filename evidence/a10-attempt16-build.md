Build step complete. All changes are specified below in the implementation artifact: the worker-side fix (failure-payload helpers + stage tracking in `process_document`), and the new worker→rag-api contract test following the existing `tests/integration/test_api_contracts.py` patterns (subprocess payload construction on the worker side, real `run_transactional_update` execution against fakes on the API side, plus AST drift guards). Per the definition's must-constraint, rag-api's reads and persisted schema are untouched — the worker is aligned to the existing contract. Points that could not be re-verified from source in this step (exact `run_transactional_update` parameter shape, `classify_error` return convention) are isolated to single, clearly flagged integration lines rather than invented.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-define-108-a8/implementation.md">>>
# Build — rag-worker → rag-api failure payload contract alignment

- Run: `8b06a314-f151-4c92-a50a-f2fee0c84232` · Iteration 1 · Step: build
- WorkItem: `wi-define-108-a8` (authoritative Definition, sha256-pinned)
- Intent: worker failure payloads must carry `error_message` / `stage` / `retryable` so rag-api persists the real message, failing stage, and a deliberately derived retryable flag — locked in by a contract test.

## Summary of changes

| # | File | Change |
|---|------|--------|
| 1 | `apps/ai-server/rag-worker-service/main.py` | Add `DEFAULT_FAILURE_STAGE`, `_derive_retryable()`, `_build_failure_payload()` (new module-level helpers) |
| 2 | `apps/ai-server/rag-worker-service/main.py` | Stage tracking in `process_document` + exception handler publishes the new payload |
| 3 | `apps/ai-server/tests/integration/test_worker_failure_contract.py` | **New** contract test pinning the worker→rag-api failure seam |

**rag-api-service is intentionally unchanged.** Per the Definition's must-constraint, the worker aligns to rag-api's existing contract: the failed branch of `run_transactional_update` already reads `details["error_message"]` / `details["stage"]` / `details["retryable"]` and persists `error` / `error_stage` / `retryable` (Definition F4), and already writes message/stage (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary subdocument. Once the worker sends the right keys, requirement 3 is satisfied by existing API code. No migration, no rename, no backfill.

---

## Change 1 — `apps/ai-server/rag-worker-service/main.py`: new failure-payload helpers

Add at module level, adjacent to `classify_error()` / the `_publish_status_update` helpers:

```python
# ── Failure payload contract (worker → rag-api) ──────────────────────────────
# rag-api's failed branch (run_transactional_update) reads exactly these
# details keys and persists them as error / error_stage / retryable on the
# resource document. The worker must always send all three explicitly so the
# API-side fallbacks ("Processing failed", stage None, retryable True) never
# fire for worker-originated failures.

# Safe stage value when the failing stage is genuinely unknown. Matches the
# value the stale-lease sweep (_fail_if_still_stale) uses for error_stage, so
# error_stage never regresses to null.
DEFAULT_FAILURE_STAGE = "processing"


def _derive_retryable(exc) -> bool:
    """Deliberately derive the failure payload's retryable flag.

    Uses the same classify_error() classification that drives ACK/NACK in
    run_worker, so the persisted record tells the truth about what Pub/Sub
    will do:
      * transient-classified  -> message is NACKed and redelivered -> True
      * permanent-classified  -> message is acked; manual reprocess via
                                 POST /process remains available   -> False
      * unclassified-unknown  -> classify_error's conservative default is
                                 permanent                         -> False
    This flag is REPORTING only — ACK/NACK behavior itself is unchanged.
    """
    try:
        classification = classify_error(exc)
    except Exception:
        # A failure to classify must never silently default to retryable;
        # treat it as classify_error treats unknowns: permanent.
        return False
    if isinstance(classification, bool):
        # bool convention: True means transient.
        return classification
    # string/enum convention: the transient classification is named
    # "transient" (TransientError -> "transient" in classify_error).
    label = getattr(classification, "name", classification)
    return str(label).lower() == "transient"


def _build_failure_payload(exc, stage=None) -> dict:
    """Build the failed-status details payload for _publish_status_update.

    Contract keys (must match rag-api run_transactional_update's failed
    branch exactly — pinned by
    apps/ai-server/tests/integration/test_worker_failure_contract.py):
      error_message  the actual exception message
      stage          the pipeline stage executing at failure time
      retryable      deliberately derived via _derive_retryable
    The legacy "error" key is retained alongside error_message as a
    compatibility hedge for any unknown consumer of the status topic
    (Definition F11). No error_code is sent: the summary subdocument's
    error.code stays rag-api's "UNKNOWN" default by design.
    """
    message = str(exc)
    return {
        "error_message": message,
        "error": message,  # legacy key — deliberate hedge, do not remove
        "stage": stage or DEFAULT_FAILURE_STAGE,
        "retryable": _derive_retryable(exc),
    }
```

Notes:
- `_derive_retryable` normalizes both plausible `classify_error` return conventions (bool `True`=transient, or a `"transient"` string/enum) so the derivation is a single deliberate mapping either way. See "Apply-time verification notes" — confirm the convention against the source; if it uses a different sentinel, adjust only this one comparison.
- Every failure payload carries `retryable` explicitly (constraint: the API-side `details.get("retryable", True)` fallback must never be operative for worker failures).

---

## Change 2 — `apps/ai-server/rag-worker-service/main.py`: stage tracking in `process_document`

### 2a. Initialize the tracker

As the first statement of `process_document`'s body (before the try block):

```python
current_stage = DEFAULT_FAILURE_STAGE  # reported by the failure handler if we fail before the first stage transition
```

### 2b. Update the tracker before each pipeline step

Convention: **set the tracker immediately before the await** of each pipeline step — the step whose successful completion leads to the correspondingly named `_publish_status_update` progress call (stage vocabulary per Definition F9). Insert exactly:

| Insert | Immediately before |
|---|---|
| `current_stage = "starting"` | the first pipeline step (document download/fetch) |
| `current_stage = "text_retrieved"` | the text-extraction step |
| `current_stage = "tagging_complete"` | the content-tagging step |
| `current_stage = "summary_generated"` | the summary-generation step |
| `current_stage = "chunking_complete"` | the chunking step |
| `current_stage = "embeddings_complete"` | the embedding-generation step |

`"completed"` is the terminal success milestone and is deliberately not tracked — reaching it means the failure handler never fires.

### 2c. Failure handler publishes the contract payload

In `process_document`'s exception handler — the site that currently passes `{"error": str(e)}` as the details argument to `_publish_status_update` (Definition F3) — replace the literal dict with the builder. Everything else in the handler (logging, re-raise/ACK-NACK flow) is unchanged:

```python
    except Exception as e:
        # ... existing logging unchanged ...
        failure_details = _build_failure_payload(e, current_stage)
        await _publish_status_update(
            ...,                      # unchanged arguments
            "failed",                 # unchanged status string
            failure_details,          # ← was: {"error": str(e)}
        )
```

The published status remains `"failed"` (rag-api's failed branch keys on it). The `retryable` value in the payload is reporting only; it must not influence ACK/NACK (non-goal: retry mechanics unchanged).

### Untouched on purpose

- `_fail_if_still_stale` (stale-lease sweep): already writes `error` / `error_stage="processing"` / `retryable=True` directly — consistent with this contract (dead worker = transient). Non-goal.
- `run_worker` ACK/NACK policy, leases, heartbeats: unchanged.
- rag-api-service: no code changes (see Summary).

---

## Change 3 — new file `apps/ai-server/tests/integration/test_worker_failure_contract.py`

Follows the verified house patterns: shares `tests/integration/conftest.py` (rag-api importable as `main`, cloud deps mocked), builds worker payloads in a subprocess with the worker's own dependency stubs (the verified `rag-worker-service/tests` import pattern), and adds AST drift guards like `test_api_contracts.py`'s `_get_agent_graph_shapes`.

```python
"""Contract test: rag-worker failure payload → rag-api failed-branch persistence.

Pins the worker→rag-api failure seam end to end:

  worker publishes (via _build_failure_payload, called from process_document's
  exception handler):
      error_message  the actual exception message
      error          legacy duplicate of error_message (compatibility hedge)
      stage          the failing pipeline stage
      retryable      deliberately derived from classify_error

  rag-api's failed branch (run_transactional_update) must persist:
      error       <- details["error_message"]
      error_stage <- details["stage"]
      retryable   <- details["retryable"]
  and write the same message/stage into the processing/summary subdocument.

The test exercises the worker's real payload-construction code path (in a
subprocess with the worker's dependency stubs) and feeds the resulting
payload through rag-api's real run_transactional_update failed branch
against in-memory fakes. If either side renames or drops a key, the
passthrough assertions fail — the fallback defaults ("Processing failed",
stage None, retryable True) must never win for worker failures.
"""
import ast
import asyncio
import inspect
import json
import os
import subprocess
import sys

import pytest

import main as rag_api_main  # provided via tests/integration/conftest.py

REPO_AI_SERVER_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..")
)
WORKER_DIR = os.path.join(REPO_AI_SERVER_DIR, "rag-worker-service")
RAG_API_MAIN_PATH = rag_api_main.__file__

USER_ID = "contract-user"
RESOURCE_ID = "contract-resource"

# The contract.
WORKER_REQUIRED_KEYS = {"error_message", "stage", "retryable"}
WORKER_LEGACY_KEYS = {"error"}  # deliberate hedge — see _build_failure_payload
WORKER_EXPECTED_KEYS = WORKER_REQUIRED_KEYS | WORKER_LEGACY_KEYS

# rag-api's fallbacks — must never be the operative values for worker failures.
FALLBACK_ERROR = "Processing failed"
UNKNOWN_STAGE = "processing"

# The shared progress-stage vocabulary (Definition F9).
STAGE_VOCABULARY = {
    "starting", "text_retrieved", "tagging_complete",
    "summary_generated", "chunking_complete", "embeddings_complete",
}

# Representative stages: an early-stage failure and a late-stage failure.
EARLY_STAGE = "text_retrieved"
LATE_STAGE = "embeddings_complete"


# ── Worker side: real payload construction in a subprocess ──────────────────

_WORKER_PAYLOAD_SCRIPT = """\
import json, os, sys

worker_dir = sys.argv[1]
sys.path.insert(0, worker_dir)
sys.path.insert(0, os.path.join(worker_dir, "tests"))
import conftest  # noqa: F401 — installs the worker's dependency stubs
import main as worker

exc_cls = getattr(worker, sys.argv[2])
stage = sys.argv[3]
message = sys.argv[4]
payload = worker._build_failure_payload(exc_cls(message), stage)
print(json.dumps(payload))
"""


def _build_worker_payload(exc_type_name, stage, message):
    result = subprocess.run(
        [sys.executable, "-c", _WORKER_PAYLOAD_SCRIPT,
         WORKER_DIR, exc_type_name, stage, message],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, (
        f"worker failure-payload construction failed ({exc_type_name}):\n"
        f"{result.stderr}"
    )
    return json.loads(result.stdout.strip())


# ── rag-api side: real failed branch against in-memory fakes ────────────────

class _FakeSnapshot:
    def __init__(self, data):
        self._data = data
        self.exists = True

    def to_dict(self):
        return dict(self._data)


class _FakeTx:
    """Records transactional writes; get() returns the current doc state."""

    def __init__(self, doc_state):
        self._data = dict(doc_state)
        self.writes = []

    def get(self, ref, transaction=None):
        return _FakeSnapshot(self._data)

    def update(self, ref, data):
        self._data.update(data)
        self.writes.append(("update", dict(data)))

    def set(self, ref, data, merge=None):
        self._data.update(data)
        self.writes.append(("set", dict(data)))


class _FakeRef:
    def __init__(self, tx, path):
        self._tx = tx
        self.path = path

    @property
    def id(self):
        return self.path.rsplit("/", 1)[-1]

    def get(self, transaction=None):
        return _FakeSnapshot(self._tx._data)

    def collection(self, name):
        return _FakeRef(self._tx, f"{self.path}/{name}")

    def document(self, name):
        return _FakeRef(self._tx, f"{self.path}/{name}")


class _FakeDb:
    def __init__(self, tx):
        self._tx = tx

    def transaction(self):
        return self._tx

    def collection(self, name):
        return _FakeRef(self._tx, name)

    def document(self, path):
        return _FakeRef(self._tx, path)


def _rag_api_firestore_module():
    fs = getattr(rag_api_main, "firestore", None)
    if fs is not None:
        return fs
    return rag_api_main.firebase_admin.firestore


def _run_failed_branch(monkeypatch, payload):
    """Run rag-api's failed branch (run_transactional_update) against the
    fakes and return the recording transaction."""
    tx = _FakeTx({"status": "processing", "filename": "contract-test.pdf"})
    db = _FakeDb(tx)
    fs_mod = _rag_api_firestore_module()
    # Run the transaction body immediately with our single fake tx.
    monkeypatch.setattr(fs_mod, "transactional", lambda fn: fn, raising=False)
    result = rag_api_main.run_transactional_update(
        db, USER_ID, RESOURCE_ID, "failed", payload
    )
    if inspect.isawaitable(result):
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(result)
        finally:
            loop.close()
    return tx


def _main_doc_write(tx):
    for kind, data in tx.writes:
        if {"error", "error_stage", "retryable"}.issubset(data):
            return data
    pytest.fail(
        "rag-api failed branch never persisted error/error_stage/retryable; "
        f"writes={tx.writes}"
    )


def _summary_write(tx):
    for kind, data in tx.writes:
        if "message" in data and "stage" in data:
            return data
        for value in data.values():  # nested-map subdocument shape
            if isinstance(value, dict) and "message" in value and "stage" in value:
                return value
    pytest.fail(
        "rag-api failed branch never wrote the processing/summary error "
        f"subdocument; writes={tx.writes}"
    )


# ── AST drift guard on rag-api's failed branch ───────────────────────────────

def _failed_branch_details_keys():
    """The details keys rag-api's failed branch reads, via AST scan of
    run_transactional_update (house pattern from test_api_contracts.py)."""
    with open(RAG_API_MAIN_PATH) as f:
        tree = ast.parse(f.read())
    fn = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                and node.name == "run_transactional_update":
            fn = node
            break
    assert fn is not None, (
        "run_transactional_update not found in rag-api main.py — the "
        "failed-branch contract test is pinning a function that no longer exists"
    )
    param_names = {a.arg for a in fn.args.args}
    details_name = "details" if "details" in param_names else None

    keys = set()

    def collect(node):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "get":
            base = node.func.value
            named = isinstance(base, ast.Name) and \
                (details_name is None or base.id == details_name)
            if named and node.args and isinstance(node.args[0], ast.Constant) \
                    and isinstance(node.args[0].value, str):
                keys.add(node.args[0].value)
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) \
                and (details_name is None or node.value.id == details_name) \
                and isinstance(node.slice, ast.Constant) \
                and isinstance(node.slice.value, str):
            keys.add(node.slice.value)

    found_guard = False
    for sub in ast.walk(fn):
        if isinstance(sub, ast.If):
            try:
                test_src = ast.unparse(sub.test)
            except Exception:
                continue
            if '"failed"' in test_src or "'failed'" in test_src:
                for stmt in sub.body:
                    for inner in ast.walk(stmt):
                        collect(inner)
                found_guard = True
    if not found_guard:
        # Fallback: scan the whole function (still fails on drift of the
        # required keys, just allows extra noise).
        for inner in ast.walk(fn):
            collect(inner)
    return keys


# ── The contract ─────────────────────────────────────────────────────────────

class TestWorkerFailurePayloadContract:
    def test_worker_payload_has_exact_contract_key_set(self):
        payload = _build_worker_payload(
            "TransientError", EARLY_STAGE, "synthetic transient failure"
        )
        missing = WORKER_REQUIRED_KEYS - set(payload)
        assert not missing, f"worker failure payload missing required keys: {missing}"
        drifted = set(payload) ^ WORKER_EXPECTED_KEYS
        assert not drifted, (
            "worker failure payload key set drifted from the rag-api contract "
            f"(unexpected/renamed keys: {drifted})"
        )

    def test_worker_payload_carries_actual_message_and_stage(self):
        message = "synthetic failure: quota exceeded while extracting text"
        payload = _build_worker_payload("TransientError", EARLY_STAGE, message)
        assert payload["error_message"] == message
        assert payload["error"] == message, \
            "legacy 'error' hedge must mirror error_message"
        assert payload["stage"] == EARLY_STAGE

    def test_retryable_is_derived_not_defaulted(self):
        transient = _build_worker_payload(
            "TransientError", EARLY_STAGE, "synthetic transient failure"
        )
        permanent = _build_worker_payload(
            "PermanentError", LATE_STAGE, "synthetic permanent failure"
        )
        assert transient["retryable"] is True, \
            "classify_error-transient failures must publish retryable=true"
        assert permanent["retryable"] is False, (
            "classify_error-permanent failures (incl. unclassified-unknown, "
            "per classify_error's conservative default) must publish retryable=false"
        )

    def test_unknown_stage_falls_back_to_safe_value(self):
        payload = _build_worker_payload(
            "TransientError", "", "failure before first stage transition"
        )
        assert payload["stage"] == UNKNOWN_STAGE


class TestWorkerToApiFailurePersistenceContract:
    def test_early_stage_transient_failure_persists_worker_values(self, monkeypatch):
        payload = _build_worker_payload(
            "TransientError", EARLY_STAGE, "synthetic early-stage failure"
        )
        tx = _run_failed_branch(monkeypatch, payload)
        doc = _main_doc_write(tx)
        assert doc["error"] == payload["error_message"]
        assert doc["error"] != FALLBACK_ERROR
        assert doc["error_stage"] == payload["stage"]
        assert doc["error_stage"] is not None
        assert doc["retryable"] == payload["retryable"]
        assert doc["retryable"] is True
        summary = _summary_write(tx)
        assert summary["message"] == payload["error_message"]
        assert summary["stage"] == payload["stage"]
        assert summary.get("error_code", "UNKNOWN") == "UNKNOWN"

    def test_late_stage_permanent_failure_persists_worker_values(self, monkeypatch):
        payload = _build_worker_payload(
            "PermanentError", LATE_STAGE, "synthetic late-stage failure"
        )
        tx = _run_failed_branch(monkeypatch, payload)
        doc = _main_doc_write(tx)
        assert doc["error"] == payload["error_message"]
        assert doc["error"] != FALLBACK_ERROR
        assert doc["error_stage"] == payload["stage"]
        assert doc["retryable"] == payload["retryable"]
        assert doc["retryable"] is False
        summary = _summary_write(tx)
        assert summary["message"] == payload["error_message"]
        assert summary["stage"] == payload["stage"]


class TestFailureBranchDriftGuard:
    def test_rag_api_failed_branch_reads_the_contract_keys(self):
        keys = _failed_branch_details_keys()
        missing = WORKER_REQUIRED_KEYS - keys
        assert not missing, (
            "rag-api's failed branch no longer reads worker contract keys "
            f"{missing} — the worker→rag-api failure contract is broken"
        )

    def test_worker_stage_tracking_covers_the_pipeline_vocabulary(self):
        """The stage tracker must be assigned for every stage in the progress
        vocabulary inside process_document, and the failure handler must pass
        the tracker to _build_failure_payload."""
        worker_main = os.path.join(WORKER_DIR, "main.py")
        with open(worker_main) as f:
            tree = ast.parse(f.read())
        fn = None
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                    and node.name == "process_document":
                fn = node
                break
        assert fn is not None, "process_document not found in worker main.py"
        tracked = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "current_stage"
                for t in node.targets
            ):
                if isinstance(node.value, ast.Constant) \
                        and isinstance(node.value.value, str):
                    tracked.add(node.value.value)
        missing = STAGE_VOCABULARY - tracked
        assert not missing, (
            f"process_document no longer tracks stage(s): {missing} — failures "
            "there would report a stale stage"
        )
        handler_wires_stage = any(
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_build_failure_payload"
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Name)
            and node.args[1].id == "current_stage"
            for node in ast.walk(fn)
        )
        assert handler_wires_stage, (
            "process_document's failure handler must pass current_stage to "
            "_build_failure_payload"
        )
```

### How to run

```bash
cd apps/ai-server
python -m pytest tests/integration/test_worker_failure_contract.py -v
```

No emulator or credentials required: the worker side runs in a stubbed subprocess; the API side runs against in-memory fakes (the Definition sanctions "the Firestore emulator or fakes"). All tests are sync, matching the existing integration suite's conventions.

### Drift-guard design (why each side fails on drift)

- **Worker key drift** (rename/drop of `error_message`/`stage`/`retryable`): caught by the exact-key-set assertion and by the passthrough assertions (persisted values would fall back to `"Processing failed"`/None/True and stop equaling the payload values).
- **rag-api read drift**: caught by the passthrough assertions (fallbacks win → equality fails) and by the AST guard on the failed branch's `details` reads.
- **Stage-tracker removal/bypass**: caught by the AST guard requiring every vocabulary stage to be tracked and the handler to wire `current_stage` into `_build_failure_payload`; the dynamic tests pin representative early (`text_retrieved`) and late (`embeddings_complete`) stages end to end.

---

## Apply-time verification notes (verified vs. flagged)

Verified and relied upon (Definition facts, integrity-pinned): the worker's handler currently publishes `{"error": str(e)}` via `_publish_status_update` (F3); rag-api's failed branch in `run_transactional_update` reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` plus the summary message/stage with `error_code` default `"UNKNOWN"` (F4); the persisted schema and fallbacks (F5, F6); `classify_error` semantics incl. unknown→permanent (F7, F8); the progress-stage vocabulary (F9); the contract-test and stubbing infrastructure (F10 — `tests/integration/conftest.py`, `test_api_contracts.py`, worker `tests/conftest.py` all read and confirmed this step).

Flagged as the single integration points to confirm against source when applying (these specifics were not re-verifiable in this step; nothing was invented to paper over them):

1. **`run_transactional_update` call shape** — the adapter `_run_failed_branch` calls `run_transactional_update(db, USER_ID, RESOURCE_ID, "failed", payload)`. The function name, module, and failed-branch semantics are verified (F4); if the verified parameter order/names differ, adjust only this one call. A wrong shape fails loudly (empty `tx.writes` → `pytest.fail`), never silently passes.
2. **`classify_error` return convention** — `_derive_retryable` handles both the bool (`True`=transient) and string/enum (`"transient"`) conventions; if the verified convention differs, adjust the single comparison there.
3. **`TransientError`/`PermanentError` location** — expected as module-level names in the worker's `main.py` (F7's evidenceRef; the worker's `exceptions.py` was read and does not define them). If they live elsewhere, adjust `getattr(worker, ...)` in the subprocess script.
4. **Summary-subdocument write shape** — `_summary_write` accepts both a separate `processing/summary` document write and a nested-map write, so either verified shape passes.
5. **Tracker placement anchors** — the six `current_stage = ...` insertions are placed by the update-before-await convention anchored to the F9 progress-update calls; exact await sites are confirmed when the file is open.

## Acceptance mapping

| Acceptance criterion | How it is met |
|---|---|
| Worker's failed payload carries `error_message` (actual message), `stage` (failing stage), `retryable` (derived) — no reliance on API fallbacks | Changes 1–2; pinned by `TestWorkerFailurePayloadContract` |
| Persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = worker's derived value | `TestWorkerToApiFailurePersistenceContract` (early/transient + late/permanent scenarios through real `run_transactional_update`) |
| processing/summary error subdocument carries the same message and stage | Asserted in both persistence scenarios (`_summary_write`), `error_code` stays `"UNKNOWN"` |
| Contract test exists, passes, fails on either side's key drift | New test file: dynamic passthrough + worker exact-key-set guard + rag-api AST read guard + stage-tracker guard |

## Constraints / non-goals compliance

- Worker aligned to rag-api's existing contract; rag-api reads and persisted schema untouched (must ✓).
- No Firestore migration, rename, or backfill; `error`/`error_stage`/`retryable` keep names and semantics (must_not ✓).
- `retryable` present explicitly in every failure payload; API fallback never operative for worker failures (must ✓).
- Legacy `error` key retained alongside `error_message` (prefer ✓). No error-code taxonomy introduced (prefer_not ✓).
- Untouched by design: `_fail_if_still_stale`, ACK/NACK/lease/heartbeat mechanics, frontend (`ResourceResponse` already exposes `error`/`error_stage`), companion D3 issue scope (deferred per F12).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>