Investigation complete. Both sides of the seam were verified directly in the pinned sources (worker `main.py` sha256 `7d7718bc…`, rag-api `main.py` sha256 `579b0bdf…`), along with the existing contract-test infrastructure and fake-Firestore patterns. The plan below is grounded entirely in that verified evidence; the two artifacts follow.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (authoritative Definition artifact `definition:obj-108`, sha256 `71f1c39c…`)
Run: 9a74bb9f-3f64-46e6-a162-9c14b69f4536 · Iteration 1 · Step: plan

## 1. Goal

Align the rag-worker's failed-status payload with rag-api's failed-branch contract so a failed RAG
processing job persists the worker's actual error message, the failing pipeline stage, and a
deliberately derived `retryable` flag — locked in by a contract test on the worker → rag-api failure
path.

## 2. Verified current state (evidence anchors)

Line numbers are approximate and refer to the pinned blobs:
- Worker: `apps/ai-server/rag-worker-service/main.py` (sha256 `7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988`)
- API: `apps/ai-server/rag-api-service/main.py` (sha256 `579b0bdfff8f97ee81112251ec7380b392f4aa7c38d216cd56d1782a34ed2746` — note: recorded blob sha is `…34ed2746` per read tooling; treat anchors as approximate)

| # | Fact | Anchor |
|---|------|--------|
| W1 | `process_document` is one large `try`; its `except Exception` handler publishes `"failed"` with details `{"error": str(e)}` only | worker `main.py` ≈ L1096–1103 |
| W2 | Progress publishes use stage vocabulary: `starting`, `text_retrieved` (20), `tagging_complete` (40), `summary_generated` (50), `chunking_complete` (60), `embeddings_complete` (80), final `completed` (100) | worker `main.py` ≈ L1036–1095 |
| W3 | `classify_error(e) -> bool` (True = transient): `TransientError` → True; `PermanentError` → False; httpx connect/timeout types, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` → True; `httpx.HTTPStatusError` with 429/5xx → True, other 4xx → False; **unknown exceptions → False (conservative permanent)** | worker `main.py` ≈ L37–77 |
| W4 | `_publish_status_update` mutates `details`, injecting `jobId` when a `job_id` is supplied and absent | worker `main.py` ≈ L1627–1629 |
| W5 | `run_worker` ACK/NACK uses `classify_error`, but `process_document` swallows all pipeline exceptions and returns normally — pipeline failures are always acked after the failed status is published; the classify path fires for errors outside `process_fn` (payload parse, claim, regenerate-map) | worker `main.py` ≈ L2050–2080, handler ≈ L1096 |
| W6 | Stale-lease sweep writes `error` / `error_stage="processing"` / `retryable=True` directly — already on-contract, out of scope | worker `main.py` ≈ L2152–2158 |
| A1 | rag-api failed branch reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)` into `main_update["error"|"error_stage"|"retryable"]` | api `main.py` ≈ L248–251 |
| A2 | Failed-branch summary write: `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}` plus top-level `stage`/`progress` | api `main.py` ≈ L271–276 |
| A3 | `run_transactional_update` guards transitions (`processing → failed` allowed) and decorates the inner `update_logic` with `@firestore.transactional` **at call time** — monkeypatchable in tests | api `main.py` ≈ L204–278 |
| A4 | `Resource` model exposes `error`/`error_stage`/`retryable` (default True); `ResourceResponse` exposes `error`/`error_stage` (no `retryable` field) | `models/resource.py` ≈ L52–54; api `main.py` ≈ L606–617 |
| T1 | Contract-test house patterns exist: fixture/AST static tests (`tests/integration/test_api_contracts.py`), mocked-SDK conftest (`tests/integration/conftest.py`), worker SDK stubs (`rag-worker-service/tests/conftest.py`), fake-Firestore fakes + `firestore.transactional` identity stand-in (`rag-worker-service/tests/unit/test_processing_lease.py`) | as listed |

**The bug:** W1's one-key payload meets none of A1's three keys, so every worker-originated failure
persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (silent default), and the
summary subdocument inherits the fallbacks with `error_code="UNKNOWN"`.

## 3. Non-goals (from the Definition, binding)

- No change to rag-api production code — the worker aligns to the API's existing reads and persisted
  schema (`error`, `error_stage`, `retryable` keep names and semantics; no migration/backfill).
- No change to the stale-lease sweep's direct failure write (W6 is already on-contract).
- No change to retry/backoff mechanics: Pub/Sub ACK/NACK policy, leases, heartbeats — only the
  *reporting* of retryability changes.
- No structured error-code taxonomy: summary `error.code` stays `"UNKNOWN"` unless a code is sent.
- No frontend/mobile changes. Nothing under the companion D3 issue's scope (unavailable here; deferred).

## 4. Constraints (must / prefer)

- **must** — worker publishes `error_message` / `stage` / `retryable`; the API-side
  `details.get(..., fallback)` defaults must never be the operative mechanism for worker failures.
- **must** — every failure payload carries `retryable` explicitly, derived from `classify_error`
  (transient → true; permanent, including unclassified-unknown → false).
- **must_not** — no Firestore migration, field rename, or backfill.
- **prefer** — retain the legacy `error` key alongside `error_message` (hedge for unknown consumers
  of the status topic).
- **prefer_not** — no error-code taxonomy.

## 5. Design

### 5.1 Failure payload builder (worker, new pure function)

Add next to `classify_error` (worker `main.py`, after ≈ L77):

```python
def build_failure_payload(error: Exception, stage: str) -> Dict[str, Any]:
    """Build the failed-status details payload for rag-api's failed branch.

    Contract (pinned by apps/ai-server/tests/integration/test_worker_failure_contract.py):
      error_message — actual exception message (rag-api persists it as `error`)
      stage         — pipeline stage executing at failure time (persisted as `error_stage`)
      retryable     — deliberately derived from classify_error; never silently defaulted
      error         — legacy duplicate of error_message, retained for unknown consumers
                      of the status topic (compat hedge, Definition F11)
    """
    return {
        "error_message": str(error),
        "stage": stage,
        "retryable": classify_error(error),
        "error": str(error),
    }
```

### 5.2 Stage tracking (worker, `process_document`)

Convention: **set the tracker immediately before the await it describes**, using the existing
progress-stage vocabulary (Definition requirement 2). Semantics: the `stage` in a failure record
names the pipeline phase that was executing, labeled by the progress milestone that phase produces.

| tracker assignment (immediately before) | value |
|---|---|
| initialization (first line inside `try`) | `"processing"` (safe unknown value; same value the sweep uses) |
| `self._validate_processing_request(...)` | `"starting"` |
| `self._get_extracted_text(...)` | `"text_retrieved"` |
| `self.content_tagger.generate_tags(...)` | `"tagging_complete"` |
| `self.generate_document_summary(...)` + the `ragDescription` Firestore update | `"summary_generated"` |
| `self._create_enhanced_chunks(...)` | `"chunking_complete"` |
| `self._generate_embeddings_with_openrouter(...)` | `"embeddings_complete"` |
| post-embedding tail: `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, `_update_user_usage`, `_generate_resource_map` | `"embeddings_complete"` (unchanged — no dedicated vocabulary entry exists; documented limitation) |

Tracker is a plain local (`current_stage`) — `process_document` is single-threaded per job.

### 5.3 Exception handler rewiring (worker)

Replace the handler body (W1) with:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    failure_payload = build_failure_payload(e, current_stage)
    self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                      resource_id=resource_id, error=str(e),
                      stage=failure_payload["stage"], retryable=failure_payload["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_payload, job_id)
    if trace:
        trace.update(output={"success": False, "error": str(e),
                             "stage": failure_payload["stage"],
                             "retryable": failure_payload["retryable"]})
    return metrics
```

The handler must call `build_failure_payload` (not inline the dict) — the wiring unit test pins this
by exact-dict comparison of the published details against the builder's output.

### 5.4 `retryable` derivation (adopted default, Definition F8)

`retryable = classify_error(e)`: transient-classified → `true`; permanent-classified, including
unclassified-unknown per `classify_error`'s conservative default → `false`.

**Deliberate behavior change:** unclassified-unknown exceptions previously persisted the silent
default `true`; they now persist `false`. Accepted per the Definition (prevents uninformed retry
loops; manual reprocess via `POST /process` unaffected).

**Factual note for reviewers (verified, W5):** `process_document` catches all exceptions and returns
normally, so `run_worker` acks the job message after the failed status is published regardless of
classification; the classify-based NACK path applies to errors outside `process_fn`. The persisted
`retryable` flag is therefore the record of reprocessability (client UX / any future auto-requeue),
and its derivation rule is exactly as adopted in F8. Changing ACK/NACK mechanics remains out of scope.

### 5.5 rag-api: zero production change

`run_transactional_update` already implements requirement 3 (A1, A2). Once the worker sends
`error_message`/`stage`/`retryable`, persistence is correct with no API edit. The API side is
delivered entirely by the contract test that pins it.

### 5.6 Compatibility & rollout

- Payload change is additive (adds three keys, retains `error`); only the worker deploys. No
  ordering constraint against rag-api (unchanged) or the sweep (unchanged).
- Residual risk — unknown status-topic consumers reading only `error`: mitigated by retaining the
  legacy key (Definition F11); accepted as low.

## 6. Edge cases and decisions

1. **Failure during `_validate_processing_request`** reports `stage="starting"` (the job was
   starting up). The `"processing"` value remains the initialized fallback for genuinely unknown
   contexts.
2. **Tail steps after `embeddings_complete`** (vector delete/store, metadata save, usage, map)
   report `"embeddings_complete"` — no vocabulary entry exists for them; extending the vocabulary is
   out of the Definition's bounded stage list. Documented as a known attribution limit.
3. **`jobId` injection (W4):** `_publish_status_update` adds `jobId` to the details dict when a job
   id is present. The exact-key-set assertion applies to `build_failure_payload`'s return value
   (pre-injection); wiring tests assert the published dict as `{**payload, "jobId": job_id}` when a
   job id is passed.
4. **Trace/log enrichment** (stage, retryable added to `document_processing_failed` and the Langfuse
   trace output) is included — zero-risk observability gain inside the touched handler.
5. **Other `"failed"` publishers in the worker:** verified there is exactly one
   `_publish_status_update(..., "failed", ...)` call site (the handler). The sweep writes Firestore
   directly (W6) and is explicitly out of scope.

## 7. Deliverables

| # | File | Change |
|---|------|--------|
| 1 | `apps/ai-server/rag-worker-service/main.py` | Add `build_failure_payload`; add `current_stage` tracker per §5.2; rewire the `except` handler per §5.3 |
| 2 | `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | New — builder + wiring tests (see test plan §3.A) |
| 3 | `apps/ai-server/tests/integration/test_worker_failure_contract.py` | New — cross-service contract test + drift guards (see test plan §3.B) |
| 4 | `apps/ai-server/rag-api-service/**` | **No production change** |

## 8. Task breakdown

Status: NOT STARTED

1. **Worker payload builder + stage tracker** (deliverable 1). Accept: handler publishes
   `error_message`/`stage`/`retryable`/`error`; tracker set before every await per §5.2 table.
2. **Worker unit tests** (deliverable 2). Accept: builder pure tests + wiring tests at an early and
   a late representative stage pass.
3. **Cross-service contract test** (deliverable 3). Accept: transient and permanent end-to-end
   persistence assertions, summary-subdocument assertions, both drift guards pass.
4. **Regression sweep.** Run the full worker suite (`rag-worker-service/pytest.ini`), the rag-api
   suite, and the `apps/ai-server/tests/integration` suite; confirm no other test asserts the old
   `{"error": ...}` payload shape.
5. **Consumer sanity check (documentation only).** Grep the tree for other readers of the status
   topic's failure details to confirm the F11 hedge posture; record findings in the PR description.
   No code change regardless of outcome (dropping `error` is trivial later cleanup).

## 9. Acceptance criteria mapping (Definition `acceptance`)

| Definition acceptance | Delivered by |
|---|---|
| AC1 — failed status message contains `error_message`, `stage`, `retryable`, none relying on API fallbacks | §5.1–5.3; pinned by unit wiring tests + contract key-set guard |
| AC2 — persisted `error` = actual message, `error_stage` = failing stage, `retryable` = derived value | Contract tests (transient + permanent) against fakes |
| AC3 — processing/summary error subdocument carries same message and stage | Contract test summary assertions (A2 shape, `code="UNKNOWN"`) |
| AC4 — contract test exists, passes, fails on either side's key drift | Deliverable 3: exact payload key set + API-side AST read-key guard |

## 10. Risks and tradeoffs

- **Unknown status-topic consumers** reading the old key set — mitigated by retaining `error`;
  residual risk accepted as low (Definition F11).
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention
  and representative early/late-stage test coverage; a new step without a tracker assignment reports
  the previous stage, never a crash.
- **`retryable=false` for unclassified-unknown errors** may reduce auto-retry affordances for
  genuinely transient-but-unrecognized failures — accepted per Definition; widening `classify_error`
  is out of scope; manual reprocess remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard. Adding a key later
  means touching the test, which is the point.
- **Dual-`main` import mechanics in the contract test** — worker `main.py` has import-time side
  effects (env reads, subscriber client construction) and both services name their entry module
  `main`. Mitigated by loading the worker under a distinct module name with the established stub
  set (test plan §2); this is the plan's main mechanical risk and is de-risked by the existing
  conftest/stub patterns (T1).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker → rag-api failure payload contract

Companion to `docs/plan.md`. Covers deliverables 2 and 3: worker unit tests and the cross-service
contract test that locks the failure-path seam.

## 1. Strategy

- **Fakes over emulator.** The Definition permits "the Firestore emulator or fakes". Fakes are
  chosen: `run_transactional_update`'s failed branch is straight read/update/set logic (A3), the
  fake-Firestore pattern already exists (`test_processing_lease.py`), and fakes keep the test
  hermetic and fast. The emulator branch (both services set `FIRESTORE_EMULATOR_HOST`-aware init)
  remains a manual verification option, not a CI dependency.
- **Import both sides, don't restate the contract.** The test builds the payload through the
  worker's real `build_failure_payload` and persists it through rag-api's real
  `run_transactional_update`. No fixture restates key names except the drift guards themselves.
- **Both drift directions guarded:** worker-side by an exact key-set assertion on the payload;
  API-side by an AST scan of the failed branch's `details.get(...)` read keys (the legacy-`error`
  hedge would otherwise mask an API-side rename from value assertions alone).

## 2. Test environments and module-loading mechanics

### 2.A Worker unit tests — `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`

- Runs under `rag-worker-service/pytest.ini` (`testpaths = tests`, `asyncio_mode = auto`).
- `tests/conftest.py` already: sets required env defaults (`GCP_PROJECT`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `OPENROUTER_*`, etc.) and stubs `openai`, `langfuse`,
  `firebase_admin`, `google.*`, `spacy`, `tiktoken`, `tenacity`, `langchain*`. `import main` then
  works (proven by `test_processing_lease.py`).
- Processor construction for wiring tests: bypass `__init__` (it builds real cloud clients) with
  `proc = EnhancedDocumentProcessor.__new__(EnhancedDocumentProcessor)` and set only the attributes
  the failure path touches: `config = MagicMock()`, `langfuse = None`, `logger = MagicMock()`,
  `content_tagger = MagicMock()` (with `generate_tags = AsyncMock(...)` where needed),
  `db = MagicMock()`. Monkeypatch pipeline methods and `_publish_status_update` on the instance.
  If existing worker unit tests already exercise a lighter construction pattern, prefer it — verify
  at implementation time.

### 2.B Cross-service contract test — `apps/ai-server/tests/integration/test_worker_failure_contract.py`

Colocated with `test_api_contracts.py` so it runs under the same invocation; that directory's
`conftest.py` already mocks `firebase_admin`, `google.cloud.*`, `structlog`, sets `GCP_PROJECT` /
`GOOGLE_APPLICATION_CREDENTIALS` / `SHARED_INTERNAL_TOKEN`, and puts `rag-api-service` on
`sys.path` (so `import main as rag_api_main` works, as in `test_api_contracts.py`).

Loading the worker side without a `main` module-name collision — in-file helper (self-contained;
no conftest churn):

```python
import importlib.util, sys, types, os
from pathlib import Path

AI_SERVER = Path(__file__).resolve().parents[1]          # apps/ai-server
WORKER_MAIN = AI_SERVER / "rag-worker-service" / "main.py"

def _stub(name, attrs=None):
    mod = types.ModuleType(name)
    if attrs:
        for k, v in attrs.items():
            setattr(mod, k, v)
    return mod

def load_worker_main():
    """Import rag-worker main.py under a distinct module name (rag-api owns `main`)."""
    if "rag_worker_main" in sys.modules:
        return sys.modules["rag_worker_main"]
    # Stub heavy deps only if not already importable (mirrors the worker conftest).
    for name, attrs in {
        "openai": {"AsyncOpenAI": type("AsyncOpenAI", (), {"__init__": lambda self, **k: None}),
                   "APIError": type("APIError", (Exception,), {}),
                   "APIConnectionError": type("APIConnectionError", (Exception,), {})},
        "langfuse": {"Langfuse": type("Langfuse", (), {"__init__": lambda self, **k: None})},
        "spacy": {}, "tiktoken": {"get_encoding": lambda x: None},
        "tenacity": {"retry": lambda *a, **k: (lambda f: f),
                     "stop_after_attempt": lambda n: None,
                     "wait_exponential": lambda **k: None},
    }.items():
        try:
            __import__(name)
        except ImportError:
            sys.modules.setdefault(name, _stub(name, attrs))
    try:
        __import__("langchain.text_splitter")
    except ImportError:
        sys.modules.setdefault("langchain", _stub("langchain", {"__path__": []}))
        sys.modules.setdefault("langchain.text_splitter", _stub("langchain.text_splitter"))
        sys.modules.setdefault("langchain.schema", _stub("langchain.schema"))
    spec = importlib.util.spec_from_file_location("rag_worker_main", WORKER_MAIN)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["rag_worker_main"] = mod
    spec.loader.exec_module(mod)   # import-time env reads are satisfied by conftest
    return mod
```

Import-time side effects of worker `main.py` are all satisfied under this conftest: env vars are
set; `service_account.Credentials.from_service_account_file`, `pubsub_v1.SubscriberClient`, and
`firebase_admin` are MagicMocks; `structlog` is mocked. `langchain`/`openai`/`spacy`/`tiktoken`/
`tenacity`/`langfuse` are stubbed above only when genuinely absent.

### 2.C Fake Firestore (per-ref state)

Adapt the fakes from `rag-worker-service/tests/unit/test_processing_lease.py`
(`FakeTx`/`FakeSnap`/`FakeRef`/`FakeDb`, `_tx_identity`), with one structural change: **state is
per-`FakeRef`**, because `run_transactional_update` writes `error` (string) to the main doc and
`error` (dict) + `stage` to `processing/summary` — a shared-state fake would clobber one with the
other.

```python
class FakeTx:
    def __init__(self): self.writes = []
    def get(self, ref, transaction=None): return FakeSnap(ref._data)
    def update(self, ref, data): ref._data.update(data); self.writes.append(("update", ref, dict(data)))
    def set(self, ref, data, merge=None): ref._data.update(data); self.writes.append(("set", ref, dict(data)))

class FakeSnap:
    def __init__(self, data): self._data = data; self.exists = True
    def to_dict(self): return dict(self._data)

class FakeRef:
    def __init__(self, path, data): self.path, self._data = path, dict(data)
    def get(self, transaction=None): return FakeSnap(self._data)
    def collection(self, name):
        c = FakeCollection(); self._subs = getattr(self, "_subs", {}); self._subs[name] = c; return c

class FakeCollection:
    def __init__(self): self._docs = {}
    def document(self, name):
        return self._docs.setdefault(name, FakeRef(name, {}))

class FakeDb:
    def __init__(self, root_ref): self._root = root_ref; self._tx = FakeTx()
    def transaction(self): return self._tx
    def document(self, path): return self._root  # single-doc tests: path is informational
```

Per-test wiring (fixture or helper):

```python
main_ref = FakeRef("users/u1/resources/r1", {"status": "processing"})   # transition guard needs "processing"
summary_ref = main_ref.collection("processing").document("summary")
db = FakeDb(main_ref)
monkeypatch.setattr(rag_api_main.firestore, "transactional", lambda fn: fn)  # call-time decorator (A3)
monkeypatch.setattr(rag_api_main.firestore, "SERVER_TIMESTAMP", "SERVER_TIMESTAMP", raising=False)
rag_api_main.run_transactional_update(db, main_ref, "failed", payload, MagicMock(), "u1")
```

Assertions read `main_ref._data` (main doc) and `summary_ref._data` (subdocument) plus `db._tx.writes`.

## 3. Test matrix

### 3.A Worker unit tests — `rag-worker-service/tests/unit/test_failure_payload.py`

| ID | Test | Setup → Act → Assert | Catches |
|----|------|----------------------|---------|
| A1 | `test_builder_transient_error` | `build_failure_payload(TransientError("openrouter 503"), "text_retrieved")` → `retryable is True`, `error_message == error == "openrouter 503"`, `stage == "text_retrieved"` | derivation rule regressions |
| A2 | `test_builder_permanent_error` | `build_failure_payload(PermanentError("bad input"), "chunking_complete")` → `retryable is False` | derivation rule regressions |
| A3 | `test_builder_unknown_error_is_conservative` | `build_failure_payload(ValueError("boom"), "starting")` → `retryable is False` (the deliberate behavior change) | silent-default regression |
| A4 | `test_builder_exact_key_set` | `set(payload) == {"error_message", "stage", "retryable", "error"}` | **worker-side key drift** (either direction) |
| A5 | `test_handler_publishes_builder_payload_early_stage` | instance per §2.A; `_validate_processing_request` raises `TransientError`; `_publish_status_update` captured → published `("failed", {**build_failure_payload(exc, "starting"), "jobId": "j1"})` (exact dict) | handler bypassing the builder; tracker missing at the first step |
| A6 | `test_handler_publishes_builder_payload_late_stage` | mocks: `_get_extracted_text` → `("text", {"title": "t"})`, `content_tagger.generate_tags` → `([], {})`, `generate_document_summary` → `None`, `_create_enhanced_chunks` → `[]`; `_generate_embeddings_with_openrouter` raises `ValueError` → published stage `"embeddings_complete"`, `retryable is False` | tracker staleness at late stages; permanent derivation end-to-end in the handler |
| A7 | `test_handler_without_job_id_has_exact_payload` | as A5 with `job_id=None` → published details exactly equal builder output (no `jobId` key) | W4 injection interplay |
| A8 | `test_handler_preserves_metrics_and_trace` | as A5 → `metrics.error_message == str(exc)`, `end_time` set; trace update includes `stage`/`retryable` (trace is `None`-safe when `langfuse is None`) | pre-existing behavior preserved |

### 3.B Cross-service contract tests — `apps/ai-server/tests/integration/test_worker_failure_contract.py`

| ID | Test | Setup → Act → Assert | Catches |
|----|------|----------------------|---------|
| B1 | `test_transient_failure_persists_worker_values` | `exc = rag_worker_main.TransientError("openrouter connect timeout after 60s")`; `payload = rag_worker_main.build_failure_payload(exc, "text_retrieved")`; run `run_transactional_update` per §2.C → main doc: `error == "openrouter connect timeout after 60s"` (not `"Processing failed"`), `error_stage == "text_retrieved"` (not `None`), `retryable is True`; `status == "failed"` | **the core bug**; AC2 |
| B2 | `test_permanent_failure_persists_retryable_false` | same with `ValueError("Document r1 not found…")`, stage `"starting"` → `retryable is False`, `error`/`error_stage` persisted verbatim | deliberate behavior change; AC2 |
| B3 | `test_summary_subdocument_carries_message_and_stage` | from B1's run → `summary_ref._data["error"] == {"code": "UNKNOWN", "message": <msg>, "stage": "text_retrieved"}` and `summary_ref._data["stage"] == "text_retrieved"` | AC3; A2 shape |
| B4 | `test_worker_payload_key_set_is_exact` | `set(build_failure_payload(...)) == {"error_message", "stage", "retryable", "error"}` (redundant with A4, asserted on this side of the seam too) | **worker-side key drift** |
| B5 | `test_rag_api_failed_branch_reads_worker_keys` (AST guard) | parse `rag-api-service/main.py`; in `run_transactional_update` collect first-arg constants of every `details.get(...)` call (`ast.walk` covers the nested `update_logic`) → `{"error_message", "stage", "retryable"}` ⊆ collected | **API-side key drift** that the legacy-`error` hedge would mask in B1/B2 |
| B6 | `test_api_fallbacks_unchanged_for_keyless_payload` | `run_transactional_update` with `details = {"progress": 10}` → `error == "Processing failed"`, `error_stage is None`, `retryable is True`; summary `error.code == "UNKNOWN"` | pins that rag-api semantics were not changed (constraint) |
| B7 | *(optional)* `test_terminal_status_not_overwritten` | seed `status="completed"`, publish failed → no writes recorded | transition-guard regression (A3) |

### 3.C Drift-detection summary

| Drift event | Failing test |
|---|---|
| Worker renames/drops `error_message`, `stage`, or `retryable` | A4, B1, B4 |
| Worker handler stops using `build_failure_payload` / tracker | A5, A6 |
| Worker drops the legacy `error` hedge key | A4, B4 (deliberate test touch required — intended) |
| rag-api renames a `details.get(...)` read key | B5 (always), B1/B2 (value-visible cases) |
| rag-api changes fallback defaults | B6 |
| rag-api changes the summary error subdocument shape | B3 |

## 4. How to run

```bash
# Worker unit tests
cd apps/ai-server/rag-worker-service && python -m pytest tests/unit/test_failure_payload.py

# Cross-service contract test (same invocation/environment as test_api_contracts.py)
cd apps/ai-server && python -m pytest tests/integration/test_worker_failure_contract.py

# Full regression
cd apps/ai-server/rag-worker-service && python -m pytest tests
cd apps/ai-server/rag-api-service && python -m pytest tests
```

Validation step for the implementer: confirm the CI job that already runs
`apps/ai-server/tests/integration/test_api_contracts.py` picks up the new contract test file
(check `.github/` workflows for the ai-server pytest invocation). No new env vars, services, or
emulators are required.

## 5. Acceptance criteria mapping

| Definition acceptance | Tests |
|---|---|
| AC1 — payload carries `error_message`/`stage`/`retryable`, no fallback reliance | A1–A7, B4 |
| AC2 — persisted `error`/`error_stage`/`retryable` equal worker values | B1, B2 |
| AC3 — summary subdocument carries same message and stage | B3 |
| AC4 — contract test exists, passes, fails on key drift either side | B1–B6 |

## 6. Known limitations

- Stage attribution for the post-embedding tail steps reports `"embeddings_complete"` (no dedicated
  vocabulary entry; see plan §6.2). The contract test pins early/late representative stages per the
  Definition and intentionally does not ossify every step.
- Fakes approximate Firestore transaction semantics (single-tx, per-ref state). The failed branch
  uses no transaction features beyond get/update/set, so this is adequate; the emulator remains a
  manual cross-check option.
- Exact CI invocation of `apps/ai-server/tests` was not verified in this investigation (no workflow
  files read); the colocated-with-`test_api_contracts.py` placement makes pickup expected but must
  be confirmed at implementation time.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>