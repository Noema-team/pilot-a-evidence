<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-define-108-a8/tests.md">>>
# Executable tests — rag-worker → rag-api failure payload contract

Run: `8b06a314-f151-4c92-a50a-f2fee0c84232` · Iteration 1 · Step: test
Authoritative source: WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c…`).

## Scope of this suite

Tests are derived **only** from the Definition's requirements (R1–R5) and acceptance criteria — never from implementation internals. The suite has three files:

| File | Location | Pins |
|---|---|---|
| `test_failure_payload_contract.py` | `apps/ai-server/rag-worker-service/tests/unit/` | R1 (payload keys + legacy `error`), R2 (stage tracking), R4 (retryable derivation) |
| `test_worker_to_api_failure_contract.py` | `apps/ai-server/rag-worker-service/tests/integration/` | R3 (passthrough persistence), acceptance 2–4, AST key-drift guards on **both** sides |
| `rag_api_failure_harness.py` | `apps/ai-server/rag-worker-service/tests/integration/` | child-process harness; imports rag-api in isolation, records Firestore writes |

**Expected initial state: RED.** The current worker publishes `{"error": str(e)}` (Definition F3), so the required-keys test fails immediately. These tests define "done" for the implement step; they must pass afterwards and stay green as drift guards.

**Verified repo patterns this suite reuses:** worker test stubs (`rag-worker-service/tests/conftest.py`), worker pytest config (`pytest.ini`: `testpaths = tests`, `asyncio_mode = auto`), the mock-module list from `apps/ai-server/tests/integration/conftest.py`, the path-resolution style of `tests/integration/test_shared_algorithms_in_sync.py`, and the empty `tests/integration/` package in the worker tree.

## How to run

```bash
cd apps/ai-server/rag-worker-service
python -m pytest tests/unit/test_failure_payload_contract.py -v
python -m pytest tests/integration/test_worker_to_api_failure_contract.py -v
# or via the repo validation entrypoint:
./dev/run ai-server
```

No Firestore emulator or network is required: the cross-service test runs rag-api's `run_transactional_update` in a hermetic child process against recording fakes (the Definition permits "the Firestore emulator **or fakes**"). An emulator variant is possible later via the services' `FIRESTORE_EMULATOR_HOST` branches (F10) but is deliberately not wired here — fakes are deterministic and need no stack.

## Harness design (why it looks like this)

- **No internal names are guessed.** Failure is induced at the `_publish_status_update` boundary (the one seam the Definition names), so no pipeline function needs mocking by name. Stage coverage uses the Definition's own convention: tracker set immediately before each await, so a failure injected at the `summary_generated` progress boundary must report stage `summary_generated`.
- **Signature adaptation is isolated.** Both dynamic harnesses discover call signatures via `inspect` and fill unknown parameters with permissive fakes. Each file has one clearly marked `HARNESS ADAPTER` section: if a local parameter needs a real value, wire it **there**. The contract assertions are never adapted to fit a signature.
- **Cross-service isolation.** Both services have a `main.py` and both stub cloud SDKs differently; importing rag-api into the worker's pytest process would collide (`models/` exists in both trees — verified). The contract test therefore runs the rag-api side in a subprocess: stubs + `sys.path` are exact per the verified integration conftest, and writes come back as JSON.
- **Write capture is API-style-agnostic.** The fakes record writes whether `run_transactional_update` uses `transaction.set(ref, data)` or `ref.set(data, transaction=...)`, so the assertions survive either calling convention.

---

## File 1: `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload_contract.py`

```python
"""
Worker-side contract tests for the failure status payload.

WorkItem: wi-define-108-a8 (definition:obj-108)

Pins, from the Definition's requirements only:

  R1  a failed job's published details carry error_message (the actual
      exception message), stage (the pipeline stage executing at failure
      time) and retryable (deliberately derived); the legacy `error` key is
      retained alongside error_message (compatibility hedge, fact F11).
  R2  the reported stage comes from the existing progress-stage vocabulary
      (starting, text_retrieved, tagging_complete, summary_generated,
      chunking_complete, embeddings_complete) with "processing" as the safe
      value when the stage is genuinely unknown.
  R4  retryable is derived from classify_error: transient -> True,
      permanent (including unclassified-unknown) -> False.

Failure is induced at the status-publish boundary; no internal pipeline
function is named.  Expected RED against current code (worker publishes
only {"error": str(e)}) — these tests define "done" for the implement step.
"""

import inspect

import main as worker_main

try:
    from exceptions import TransientError, PermanentError
except ImportError:  # pragma: no cover - fallback if they live in main
    from main import TransientError, PermanentError

STAGE_VOCABULARY = {
    "starting",
    "text_retrieved",
    "tagging_complete",
    "summary_generated",
    "chunking_complete",
    "embeddings_complete",
    "processing",  # safe value when the stage is genuinely unknown
}

REQUIRED_PAYLOAD_KEYS = {"error_message", "stage", "retryable"}
LEGACY_PAYLOAD_KEYS = {"error"}


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

class _Anything:
    """Infinitely permissive stand-in: callable, awaitable, indexable.

    Lets process_document run deep enough to reach a chosen stage boundary
    without this test naming any internal pipeline function.
    """

    def __getattr__(self, name):
        return _Anything()

    def __call__(self, *args, **kwargs):
        return _Anything()

    def __await__(self):
        async def _done():
            return _Anything()
        return _done().__await__()

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    def __len__(self):
        return 1

    def __getitem__(self, key):
        return _Anything()

    def __iter__(self):
        return iter([])

    def __bool__(self):
        return True

    def get(self, *args, **kwargs):
        return _Anything()


class _CompletedAwaitable:
    """Awaitable resolving to None — the spy works whether the worker awaits
    _publish_status_update or calls it fire-and-forget."""

    def __await__(self):
        async def _noop():
            return None
        return _noop().__await__()


# --- HARNESS ADAPTER -------------------------------------------------------
# If process_document takes parameters that must be specific real values for
# the pipeline to reach later stages (e.g. a document id), wire them here.
# NEVER adapt the assertions below to fit the signature — this adapter exists
# so the contract assertions stay stable across refactors.
FAKE_ARGS = {}
# ---------------------------------------------------------------------------


def _call_process_document():
    fn = worker_main.process_document
    kwargs = {}
    for name, param in inspect.signature(fn).parameters.items():
        if param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        kwargs[name] = FAKE_ARGS.get(name, _Anything())
    return fn(**kwargs)


async def _capture_failure_payload(exc, fail_on_token=None):
    """Run process_document under a spying _publish_status_update.

    fail_on_token: when given, the spy raises `exc` the first time a publish
    call mentions that token — injecting a failure at that stage boundary.
    Returns (failure_payload_or_None, all_recorded_publish_calls).
    """
    recorded = []
    state = {"raised": False}

    def spy(*args, **kwargs):
        recorded.append({"args": args, "kwargs": kwargs})
        if (
            fail_on_token is not None
            and not state["raised"]
            and fail_on_token in repr((args, kwargs))
        ):
            state["raised"] = True
            raise exc
        return _CompletedAwaitable()

    real = worker_main._publish_status_update
    worker_main._publish_status_update = spy
    try:
        result = _call_process_document()
        if inspect.isawaitable(result):
            await result
    except Exception:
        # Publishing a failed status and then re-raising (for run_worker's
        # ACK/NACK decision) is an acceptable shape — swallow either way.
        pass
    finally:
        worker_main._publish_status_update = real

    return _find_failure_payload(recorded), recorded


def _find_dict_with_key(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            return obj
        for value in obj.values():
            found = _find_dict_with_key(value, key)
            if found is not None:
                return found
    elif isinstance(obj, (list, tuple)):
        for value in obj:
            found = _find_dict_with_key(value, key)
            if found is not None:
                return found
    return None


def _find_failure_payload(recorded):
    for call in recorded:
        for candidate in list(call["args"]) + list(call["kwargs"].values()):
            found = _find_dict_with_key(candidate, "error_message")
            if found is not None:
                return found
    return None


async def _failed_payload(exc, fail_on_token=None):
    payload, _ = await _capture_failure_payload(exc, fail_on_token=fail_on_token)
    assert payload is not None, (
        "process_document's failure path did not publish a payload containing "
        "an 'error_message' key through _publish_status_update — the failure "
        "handler is not speaking the rag-api contract at all."
    )
    return payload


def _is_transient(verdict):
    """ADAPTER: interpret classify_error's return value (bool, enum-like, or
    'transient'/'permanent' string all resolve correctly)."""
    if isinstance(verdict, bool):
        return verdict
    name = getattr(verdict, "name", None) or str(verdict)
    return "transient" in name.lower()


# ---------------------------------------------------------------------------
# R1 — required keys, actual message, legacy key
# ---------------------------------------------------------------------------

async def test_failure_payload_carries_required_keys():
    payload = await _failed_payload(
        PermanentError("boom: unsupported layout"), fail_on_token="starting"
    )
    missing = REQUIRED_PAYLOAD_KEYS - set(payload)
    assert not missing, (
        f"failure payload is missing required keys {sorted(missing)}; "
        f"published keys: {sorted(payload)}. rag-api's fallback defaults "
        f"('Processing failed', stage None, retryable True) would remain the "
        f"operative mechanism for these keys."
    )
    assert payload["error_message"] == "boom: unsupported layout"
    assert isinstance(payload["retryable"], bool), (
        "retryable must be a real bool, not a string or placeholder"
    )


async def test_failure_payload_retains_legacy_error_key():
    payload = await _failed_payload(PermanentError("boom"), fail_on_token="starting")
    missing = LEGACY_PAYLOAD_KEYS - set(payload)
    assert not missing, (
        "legacy 'error' key was dropped from the failure payload — the "
        "compatibility hedge for unknown status-topic consumers (F11) is gone"
    )
    assert payload["error"] == "boom"


# ---------------------------------------------------------------------------
# R2 — stage tracking
# ---------------------------------------------------------------------------

async def test_failure_payload_stage_is_from_progress_vocabulary():
    payload = await _failed_payload(PermanentError("boom"), fail_on_token="starting")
    assert payload["stage"] in STAGE_VOCABULARY, (
        f"stage {payload['stage']!r} is outside the progress-stage vocabulary"
    )


async def test_stage_reported_for_early_failure():
    # Failure injected at the first ("starting") publish boundary.  The
    # tracker must hold the first stage or the safe unknown value — never
    # None, never a fabricated name.
    payload = await _failed_payload(PermanentError("early boom"), fail_on_token="starting")
    assert payload["stage"] in {"starting", "processing"}, (
        f"early failure reported stage {payload['stage']!r}"
    )


async def test_stage_reported_for_late_failure():
    # Failure injected when the "summary_generated" progress marker is
    # published.  Under the set-tracker-immediately-before-the-await
    # convention, the tracker holds "summary_generated" at that boundary.
    # If the pipeline cannot reach that boundary on the permissive mocks,
    # wire the required real values in FAKE_ARGS — do not weaken this
    # assertion.
    payload = await _failed_payload(
        PermanentError("llm exploded"), fail_on_token="summary_generated"
    )
    assert payload["stage"] == "summary_generated", (
        f"late failure reported stage {payload['stage']!r} — the stage "
        f"tracker was removed, bypassed, or stage transitions were reordered"
    )


# ---------------------------------------------------------------------------
# R4 — retryable derivation aligned with classify_error
# ---------------------------------------------------------------------------

async def test_retryable_true_for_transient_error():
    payload = await _failed_payload(TransientError("pubsub brownout"), fail_on_token="starting")
    assert payload["retryable"] is True


async def test_retryable_false_for_permanent_error():
    payload = await _failed_payload(PermanentError("unsupported file"), fail_on_token="starting")
    assert payload["retryable"] is False


async def test_retryable_false_for_unclassified_exception():
    # classify_error's conservative default: unknown -> permanent -> False.
    # This is the deliberate behaviour change called out in the Definition
    # (previously the silent API-side default persisted True).
    payload = await _failed_payload(RuntimeError("mystery failure"), fail_on_token="starting")
    assert payload["retryable"] is False


async def test_retryable_matches_classify_error_for_all_classes():
    cases = [TransientError("t"), PermanentError("p"), RuntimeError("unclassified")]
    for exc in cases:
        payload = await _failed_payload(exc, fail_on_token="starting")
        expected = _is_transient(worker_main.classify_error(exc))
        assert payload["retryable"] == expected, (
            f"retryable for {type(exc).__name__} disagrees with classify_error: "
            f"payload={payload['retryable']!r}, classify_error={expected!r}"
        )
```

---

## File 2: `apps/ai-server/rag-worker-service/tests/integration/test_worker_to_api_failure_contract.py`

```python
"""
Cross-service contract test: rag-worker failure payload -> rag-api persistence.

WorkItem: wi-define-108-a8 (definition:obj-108)

Covers requirement R3 and acceptance criterion 4: the worker's failure
payload, built through the worker's real code path, is fed through rag-api's
run_transactional_update (hermetic child process, recording Firestore fakes)
and the persisted error / error_stage / retryable must equal the worker's
values — plus AST drift guards over both sides' key sets so a future edit on
either side fails the build instead of silently re-creating the fallback bug.
"""

import ast
import json
import subprocess
import sys
from pathlib import Path

import pytest

from tests.unit.test_failure_payload_contract import (  # reused worker-side harness
    TransientError,
    _failed_payload,
)

SERVICE_ROOT = Path(__file__).resolve().parents[2]  # rag-worker-service
AI_SERVER = SERVICE_ROOT.parent                     # apps/ai-server
WORKER_MAIN = SERVICE_ROOT / "main.py"
RAG_API_MAIN = AI_SERVER / "rag-api-service" / "main.py"
HARNESS = Path(__file__).resolve().parent / "rag_api_failure_harness.py"

FALLBACK_ERROR = "Processing failed"


async def _worker_failure_payload():
    # Transient injection -> retryable True end-to-end; failure at the
    # summary_generated boundary -> stage "summary_generated".
    return await _failed_payload(
        TransientError("contract-test: embedding provider returned 503"),
        fail_on_token="summary_generated",
    )


def _run_rag_api_side(payload):
    proc = subprocess.run(
        [sys.executable, str(HARNESS)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(AI_SERVER),
    )
    if proc.returncode != 0:
        pytest.fail(
            "rag-api harness crashed while importing/calling "
            "run_transactional_update:\n" + proc.stderr[-4000:]
        )
    return json.loads(proc.stdout)


def _expand_dotted(data):
    """Normalise dot-path keys ('processing.error') into nested dicts so the
    subdocument search works regardless of write style."""
    out = {}
    for key, value in data.items():
        node = out
        parts = key.split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = _expand_dotted(value) if isinstance(value, dict) else value
    return out


def _all_write_data(out):
    return [_expand_dotted(w["data"]) for w in out["writes"]]


def _merged_top_level(writes):
    merged = {}
    for w in writes:
        for key, value in w["data"].items():
            if "." not in key:
                merged[key] = value
    return merged


def _find_subdoc(obj, message, stage):
    if isinstance(obj, dict):
        if obj.get("message") == message and obj.get("stage") == stage:
            return obj
        for value in obj.values():
            found = _find_subdoc(value, message, stage)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = _find_subdoc(value, message, stage)
            if found is not None:
                return found
    return None


# ---------------------------------------------------------------------------
# R3 / acceptance 2 — persisted values equal the worker's values, unchanged
# ---------------------------------------------------------------------------

async def test_worker_failure_payload_persists_through_rag_api_failed_branch():
    payload = await _worker_failure_payload()
    out = _run_rag_api_side(payload)
    writes = out["writes"]
    assert writes, (
        "no Firestore writes were captured — the HARNESS ADAPTER in "
        "rag_api_failure_harness.py needs the real reference wiring for this "
        f"signature: {out.get('signature')}"
    )

    merged = _merged_top_level(writes)
    for field in ("error", "error_stage", "retryable"):
        assert field in merged, (
            f"rag-api's failed branch did not persist '{field}' on the main "
            f"resource document; captured writes: {writes!r}"
        )

    assert merged["error"] == payload["error_message"], (
        f"persisted error {merged['error']!r} != worker error_message "
        f"{payload['error_message']!r}"
    )
    assert merged["error"] != FALLBACK_ERROR, (
        "the rag-api fallback 'Processing failed' is still the operative "
        "value — the worker payload keys or the API reads have drifted"
    )
    assert merged["error_stage"] == payload["stage"], (
        f"persisted error_stage {merged['error_stage']!r} != worker stage "
        f"{payload['stage']!r}"
    )
    assert merged["error_stage"] is not None, "error_stage regressed to None"
    assert merged["retryable"] == payload["retryable"], (
        f"persisted retryable {merged['retryable']!r} != worker-derived "
        f"{payload['retryable']!r}"
    )


# ---------------------------------------------------------------------------
# Acceptance 3 — processing/summary error subdocument
# ---------------------------------------------------------------------------

async def test_processing_summary_error_subdocument_carries_message_and_stage():
    payload = await _worker_failure_payload()
    out = _run_rag_api_side(payload)
    for data in _all_write_data(out):
        subdoc = _find_subdoc(data, payload["error_message"], payload["stage"])
        if subdoc is not None:
            break
    else:
        pytest.fail(
            "no processing/summary error subdocument write carries the "
            f"worker's message and stage; captured writes: {out['writes']!r}"
        )


async def test_processing_summary_error_subdocument_error_code_defaults_to_unknown():
    # Pins Definition fact F4 and the non-goal: error_code stays "UNKNOWN"
    # because the worker sends no code (no error-code taxonomy in this fix).
    payload = await _worker_failure_payload()
    out = _run_rag_api_side(payload)
    for data in _all_write_data(out):
        subdoc = _find_subdoc(data, payload["error_message"], payload["stage"])
        if subdoc is not None:
            assert subdoc.get("error_code") == "UNKNOWN"
            return
    pytest.fail("processing/summary error subdocument write not found")


# ---------------------------------------------------------------------------
# AST drift guards — key sets pinned in source on BOTH sides
# ---------------------------------------------------------------------------

def _parse(path):
    assert path.exists(), f"expected source file missing: {path}"
    return ast.parse(path.read_text())


def _string_key_sites(tree):
    """String keys a piece of code can address dicts by: dict-literal keys,
    keyword-argument names, subscript constants and .get(...) constants."""
    sites = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            sites.append({
                k.value for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)
            })
        elif isinstance(node, ast.Call):
            sites.append({kw.arg for kw in node.keywords if kw.arg})
            if (
                isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ):
                sites.append({node.args[0].value})
        elif isinstance(node, ast.Subscript):
            sl = node.slice
            if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
                sites.append({sl.value})
    return [s for s in sites if s]


def _function_node(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def test_worker_failure_payload_keys_pinned_by_source():
    sites = _string_key_sites(_parse(WORKER_MAIN))
    union = set().union(*sites)
    missing = {"error_message", "stage", "retryable"} - union
    assert not missing, (
        f"rag-worker main.py no longer mentions failure-contract keys "
        f"{sorted(missing)} anywhere — the worker failure payload has "
        f"drifted from the rag-api contract"
    )


def test_rag_api_failed_branch_reads_and_persists_contract_keys():
    tree = _parse(RAG_API_MAIN)
    fn = _function_node(tree, "run_transactional_update")
    assert fn is not None, (
        "run_transactional_update disappeared from rag-api main.py — the "
        "contract test can no longer pin the failed branch"
    )
    union = set().union(*_string_key_sites(fn))
    missing_reads = {"error_message", "stage", "retryable"} - union
    assert not missing_reads, (
        f"rag-api's failed branch no longer reads payload keys "
        f"{sorted(missing_reads)} — contract drift on the consumer side"
    )
    missing_persisted = {"error", "error_stage", "retryable"} - union
    assert not missing_persisted, (
        f"rag-api's failed branch no longer persists "
        f"{sorted(missing_persisted)} — the persisted schema must keep its "
        f"names and semantics (no-migration constraint)"
    )
    constants = {
        n.value for n in ast.walk(fn)
        if isinstance(n, ast.Constant) and isinstance(n.value, str)
    }
    assert FALLBACK_ERROR in constants, (
        "the 'Processing failed' fallback was removed from rag-api — the "
        "constraint is that rag-api's reads stay unchanged; only the worker "
        "side aligns"
    )
```

---

## File 3: `apps/ai-server/rag-worker-service/tests/integration/rag_api_failure_harness.py`

```python
#!/usr/bin/env python3
"""
Child-process harness for the worker -> rag-api failure-path contract test.

Reads a worker failure payload (JSON) on stdin, imports rag-api-service's
main.py in isolation (cloud SDKs mocked, mirroring
apps/ai-server/tests/integration/conftest.py), calls run_transactional_update
with recording Firestore fakes, and prints JSON to stdout:

    {"payload": ..., "signature": "...", "writes": [{"op", "target", "data"}]}

Run only via test_worker_to_api_failure_contract.py.
"""

import asyncio
import inspect
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

os.environ.setdefault("GCP_PROJECT", "test-project")
os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/fake-creds.json")
os.environ.setdefault("SHARED_INTERNAL_TOKEN", "test-token")

# Same mock set as apps/ai-server/tests/integration/conftest.py — assigned
# unconditionally so a real SDK on the path cannot reach the network.  If
# rag-api's main.py imports an additional cloud module at import time, add it
# to this list (ADAPTER — do not touch the parent test's assertions).
required_mocks = [
    "firebase_admin",
    "firebase_admin.firestore",
    "firebase_admin.credentials",
    "firebase_admin.auth",
    "google.cloud",
    "google.cloud.firestore",
    "google.cloud.firestore_v1",
    "google.cloud.pubsub_v1",
    "google.oauth2",
    "google.oauth2.service_account",
    "structlog",
]
for mod in required_mocks:
    sys.modules[mod] = MagicMock()

# If run_transactional_update is wrapped in a firestore @transactional
# decorator, a MagicMock decorator would replace the function with a Mock and
# the body would never run.  Neutralise it (harmless if unused).
for mod in ("google.cloud.firestore", "firebase_admin.firestore"):
    sys.modules[mod].transactional = lambda f: f

RAG_API_DIR = str(Path(__file__).resolve().parents[3] / "rag-api-service")
sys.path.insert(0, RAG_API_DIR)


class FakeSnapshot:
    def __init__(self, data=None):
        self._data = dict(data or {})
        self.exists = True

    def to_dict(self):
        return dict(self._data)


class FakeDocRef:
    """Document reference that records set/update/create calls."""

    def __init__(self, path, data=None):
        self.path = path
        self._data = dict(data or {})
        self.calls = []

    def get(self, transaction=None, **kwargs):
        return FakeSnapshot(self._data)

    def set(self, data, merge=False, **kwargs):
        self.calls.append(("set", dict(data)))

    def update(self, data, **kwargs):
        self.calls.append(("update", dict(data)))

    def create(self, data, **kwargs):
        self.calls.append(("create", dict(data)))


class FakeTransaction:
    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, ref, **kwargs):
        return ref.get()

    def set(self, ref, data, merge=False, **kwargs):
        self.calls.append(("set", ref, dict(data)))

    def update(self, ref, data, **kwargs):
        self.calls.append(("update", ref, dict(data)))


# --- HARNESS ADAPTER -------------------------------------------------------
# Maps run_transactional_update's parameter names to fakes.  If the local
# signature uses different names, extend SUPPLY — never change the parent
# test's assertions.
def call_run_transactional_update(rag_api, payload):
    fn = rag_api.run_transactional_update
    resource_id = "contract-test-resource"
    main_ref = FakeDocRef(f"resources/{resource_id}", {"status": "processing"})
    sub_ref = FakeDocRef(f"resources/{resource_id}/processing/summary")
    tx = FakeTransaction()
    supply = {
        "transaction": tx,
        "tx": tx,
        "resource_id": resource_id,
        "resource_ref": main_ref,
        "doc_ref": main_ref,
        "ref": main_ref,
        "summary_ref": sub_ref,
        "processing_ref": sub_ref,
        "status": "failed",
        "new_status": "failed",
        "details": payload,
        "payload": payload,
        "data": payload,
    }
    kwargs = {}
    for name, param in inspect.signature(fn).parameters.items():
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        kwargs[name] = supply.get(name, MagicMock(name=name))
    result = fn(**kwargs)
    if inspect.isawaitable(result):
        result = asyncio.run(result)

    writes = [
        {"op": op, "target": ref.path, "data": data} for op, ref, data in tx.calls
    ]
    for ref in (main_ref, sub_ref):
        for op, data in ref.calls:
            writes.append({"op": op, "target": ref.path, "data": data})
    return {
        "payload": payload,
        "signature": str(inspect.signature(fn)),
        "writes": writes,
    }
# ---------------------------------------------------------------------------


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    import main as rag_api  # noqa: E402  (after stubs + sys.path)

    json.dump(call_run_transactional_update(rag_api, payload), sys.stdout)


if __name__ == "__main__":
    main()
```

---

## Requirement traceability

| Definition requirement / acceptance | Tests |
|---|---|
| R1 payload carries error_message/stage/retryable, never fallback-reliant (acceptance 1) | `test_failure_payload_carries_required_keys`, `test_failure_payload_retains_legacy_error_key`; end-to-end: `merged["error"] != "Processing failed"` |
| R2 stage tracking, progress vocabulary, `"processing"` safe value | `test_failure_payload_stage_is_from_progress_vocabulary`, `test_stage_reported_for_early_failure`, `test_stage_reported_for_late_failure` |
| R3 rag-api persists worker values unchanged; subdoc carries message+stage (acceptance 2, 3) | `test_worker_failure_payload_persists_through_rag_api_failed_branch`, `test_processing_summary_error_subdocument_carries_message_and_stage`, `test_processing_summary_error_subdocument_error_code_defaults_to_unknown` |
| R4 retryable derivation via classify_error (transient→True, permanent/unknown→False) | `test_retryable_true_for_transient_error`, `test_retryable_false_for_permanent_error`, `test_retryable_false_for_unclassified_exception`, `test_retryable_matches_classify_error_for_all_classes` |
| R5 / acceptance 4 contract test with key-drift guard on both sides | entire integration file: dynamic passthrough + `test_worker_failure_payload_keys_pinned_by_source` + `test_rag_api_failed_branch_reads_and_persists_contract_keys` |

## Deliberately not tested (Definition non-goals)

- Stale-lease sweep (`_fail_if_still_stale`) — its `retryable=true` write is out of scope and already consistent.
- ACK/NACK policy, leases, heartbeats — only the *reporting* of retryability changes; `run_worker` behavior is untouched.
- `ResourceResponse`/frontend exposure — already correct per F6.
- Error-code taxonomy — the `error_code == "UNKNOWN"` test pins the *absence* of new codes.
- Golden-journey failure injection (J6) — noted as not-yet-written in `dev/journeys/README.md`; a future e2e complement, not a substitute for this seam-level contract test.

## Known assumptions (explicit, for the implementer)

1. **Signatures are discovered, not assumed.** `process_document`, `_publish_status_update`, `classify_error`, and `run_transactional_update` names come from the Definition's verified facts (F3, F4, F7, F9). Parameter wiring happens only in the two marked `HARNESS ADAPTER` sections; if a local name differs, extend the adapter — the assertions are the contract and must not change.
2. **Late-stage injection ordering.** `test_stage_reported_for_late_failure` assumes the Definition's stated convention (tracker set immediately before each await; progress publish after step completion), so a failure at the `summary_generated` publish boundary reports `summary_generated`. If the pipeline cannot reach that boundary on the permissive mocks, wire real values in `FAKE_ARGS`.
3. **rag-api import-time deps.** The child harness mocks the exact module list from the verified integration conftest; if rag-api's `main.py` imports another cloud module at import time, add it to `required_mocks` (the parent test surfaces the crash stderr verbatim).
4. **Unverified details preserved as unknown.** Internal function bodies, exact publish-call shapes, and the contents of `test_api_contracts.py`'s helpers were not readable in this session; nothing in these tests depends on them — all assertions trace to the Definition's facts and requirements.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>