I have verified the current state of both sides of the seam against the tree. Key confirmations:

- **Worker publish site** (`rag-worker-service/main.py`, `process_document` except handler): publishes `{"error": str(e)}` — one key, no stage, no retryable.
- **rag-api failed branch** (`rag-api-service/main.py`, `run_transactional_update`): reads `error_message` / `stage` / `retryable` with fallbacks `"Processing failed"` / `None` / `True`, persists `error` / `error_stage` / `retryable` on the main doc and `message` / `stage` / `code="UNKNOWN"` into `processing/summary.error`.
- **Already-aligned writers**: `_fail_if_still_stale` (worker sweep, writes `error`/`error_stage:"processing"`/`retryable:True`), rag-api enqueue-failure paths, `Resource` model (`retryable` defaults `True`).
- **Test infrastructure**: `apps/ai-server/tests/integration/test_api_contracts.py` (fixture + AST patterns, conftest mocks firebase/google/structlog and puts rag-api on `sys.path`), worker suite with full stub conftest + fake-transaction pattern in `test_processing_lease.py`, worker `pytest.ini` with `asyncio_mode = auto`.

One implementation-critical discovery: both services have a module named `main`, and `tests/integration/conftest.py` already imports rag-api's as `main` — the contract test must load the worker's `main.py` via `importlib` under a distinct module name to avoid a collision.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

- Run: af5a015c-e9c4-439d-a97d-5c20625db661 · Iteration 1 · Step: plan
- Authoritative scope: WorkItem `wi-define-108-a8`, artifact `definition:obj-108`
  (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`) — treated as exact and binding.
- Companion test document: `docs/test-plan.md`.

## 1. Objective

Align the rag-worker's failed-status payload with rag-api's failed-branch contract so a failed RAG job persists the
worker's **actual error message**, the **failing pipeline stage**, and a **deliberately derived retryable flag** —
locked in by a contract test on the worker → rag-api failure path. The worker aligns to rag-api (never the reverse);
no Firestore migration, field rename, or backfill.

## 2. Current state (verified against the tree)

**Worker publish site** — `apps/ai-server/rag-worker-service/main.py`, `EnhancedDocumentProcessor.process_document`,
except handler (the only change site on the worker):

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                      resource_id=resource_id, error=str(e))
    await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

**rag-api consumer** — `apps/ai-server/rag-api-service/main.py`, `run_transactional_update`, failed branch (unchanged
by this plan; quoted as the contract to align to):

```python
if new_status == "failed":
    main_update["error"] = details.get("error_message", "Processing failed")
    main_update["error_stage"] = details.get("stage")
    main_update["retryable"] = details.get("retryable", True)
...
if new_status == "failed":
    summary_update["error"] = {
        "code": details.get("error_code", "UNKNOWN"),
        "message": details.get("error_message", "Processing failed"),
        "stage": details.get("stage"),
    }
```

(`summary_update["stage"] = details.get("stage", "unknown")` is also set for every status.)

**Consequence today (F5):** every worker-originated failure persists `error="Processing failed"`,
`error_stage=None`, `retryable=True` (silent default), and `processing/summary.error` inherits the same fallbacks with
`code="UNKNOWN"`.

**Already aligned (F6 — do not touch):** worker stale-lease sweep `_fail_if_still_stale` (writes
`error` / `error_stage:"processing"` / `retryable:True`), rag-api enqueue-failure paths (`POST /process`,
`POST /resources` → `error_stage:"enqueue"`), `Resource` model (`models/resource.py`, `retryable` defaults `True`),
`ResourceResponse` (exposes `error`, `error_stage`; does not expose `retryable` — out of scope).

**Classification (F7):** module-level `classify_error(e)` in worker `main.py` → `True` = transient, `False` =
permanent; unknown exceptions conservatively classify as permanent. It drives ACK/NACK in `run_worker`.

## 3. Design

### 3.1 Payload contract (worker details → rag-api persistence)

| Worker `details` key | rag-api read | Persisted as | Notes |
|---|---|---|---|
| `error_message` | `details.get("error_message", "Processing failed")` | main doc `error`; `processing/summary.error.message` | actual `str(e)` |
| `stage` | `details.get("stage")` | main doc `error_stage`; `summary.error.stage`; `summary.stage` | stage-tracker value |
| `retryable` | `details.get("retryable", True)` | main doc `retryable` | derived from `classify_error(e)` — never the fallback |
| `error` (legacy) | *not read by rag-api* | — | compatibility hedge for unknown topic consumers (F11) |
| `error_code` | *not sent by worker* | `summary.error.code = "UNKNOWN"` | prefer-not: no error-code taxonomy |

### 3.2 New module-level helper `build_failure_details`

Added to `rag-worker-service/main.py` directly below `classify_error` (module level so it is importable without
constructing `EnhancedDocumentProcessor`, which requires config/env/service init):

```python
def build_failure_details(exc: Exception, stage: Optional[str]) -> Dict[str, Any]:
    """
    Build the `details` payload for a "failed" status update, aligned with
    rag-api's failed-branch contract (run_transactional_update):
      error_message -> persisted as `error` (main doc + processing/summary)
      stage         -> persisted as `error_stage` (main doc + processing/summary)
      retryable     -> persisted as `retryable`, derived from classify_error
    The legacy `error` key is retained alongside error_message for any unknown
    consumer of the status topic (definition fact F11).
    """
    message = str(exc)
    return {
        "error_message": message,
        "stage": stage if stage else "processing",
        "retryable": classify_error(exc),
        # Legacy key kept for continuity with existing topic consumers and log
        # tooling. Drop only after an audit confirms rag-api is the sole consumer.
        "error": message,
    }
```

- `stage if stage else "processing"` guarantees `error_stage` never regresses to `None` even if a future call site
  passes an unset stage — `"processing"` is the same safe value the stale-lease sweep uses.
- `retryable` is always explicitly present; rag-api's `details.get("retryable", True)` fallback is no longer the
  operative mechanism for worker failures (constraint: must).
- No `error_code` key is emitted (constraint: prefer-not taxonomy); rag-api defaults `code` to `"UNKNOWN"`.

### 3.3 Stage tracker in `process_document`

Convention: **set the tracker immediately before the await** of each pipeline step; the value is the step in flight,
named by its completion event in the existing progress vocabulary. Initialize before the `try` so the handler can
always read it.

| Location in `process_document` | Assignment | Rationale |
|---|---|---|
| after `trace = ...`, immediately **before** `try:` | `current_stage = "processing"` | safe value if the handler is ever reached with no assignment |
| first statement inside `try:` (before `_validate_processing_request`) | `current_stage = "starting"` | validation + initial `{"stage": "starting"}` publish window |
| before `await self._get_extracted_text(...)` | `current_stage = "text_retrieved"` | extraction in flight |
| before `await self.content_tagger.generate_tags(...)` | `current_stage = "tagging_complete"` | tagging in flight |
| before `await self.generate_document_summary(...)` | `current_stage = "summary_generated"` | covers summary generation **and** the `ragDescription` Firestore update that follows it |
| before `await self._create_enhanced_chunks(...)` | `current_stage = "chunking_complete"` | chunking in flight |
| before `await self._generate_embeddings_with_openrouter(chunks)` | `current_stage = "embeddings_complete"` | embeddings in flight |
| post-embedding steps (`delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, completed publish) | **no assignment** — tracker stays `"embeddings_complete"` | the fixed vocabulary has no storage-phase name; the last completed transition is the truthful label. Do **not** regress to `"processing"` here. |

`"processing"` remains the defensive value for genuinely-unknown paths only (e.g. a future refactor that introduces
code before the first assignment).

### 3.4 Rewritten except handler

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    failure_details = build_failure_details(e, current_stage)
    self.logger.error(
        "document_processing_failed",
        user_id=user_id, course_id=course_id, resource_id=resource_id,
        error=str(e), stage=failure_details["stage"], retryable=failure_details["retryable"],
    )
    await self._publish_status_update(
        user_id, course_id, resource_id, "failed", failure_details, job_id
    )
    if trace:
        trace.update(output={"success": False, "error": str(e), "stage": failure_details["stage"]})
    return metrics
```

Unchanged surrounding behavior: `metrics.error_message` still set; `_publish_status_update` still injects `jobId`
into details, publishes with sequence numbers, resets the sequence on the terminal `"failed"` status, and renews the
processing lease.

### 3.5 `retryable` derivation — and the one deliberate behavior change

| Exception at failure | `classify_error` | persisted `retryable` | worker ACK/NACK |
|---|---|---|---|
| `TransientError` | True | `true` | nack → Pub/Sub redelivers |
| `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | True | `true` | nack |
| `httpx.HTTPStatusError` with 429/500/502/503/504 | True | `true` | nack |
| `PermanentError` | False | `false` | ack; manual reprocess via `POST /process` |
| `httpx.HTTPStatusError` other 4xx | False | `false` | ack |
| anything unclassified (incl. `ValueError`, `RuntimeError`) | False (conservative default) | `false` | ack |

**Deliberate behavior change (per F8, accepted):** unclassified-unknown exceptions previously persisted
`retryable: true` via rag-api's silent default; they now persist `false`, matching the worker's actual ack-and-do-not-
retry behavior. Manual reprocess (`POST /process`) is unaffected. The stale-lease sweep keeps writing
`retryable: true` (a dead worker is a transient condition) — unchanged, covered by existing tests.

### 3.6 rag-api: zero code changes

`run_transactional_update` already persists worker-provided values unchanged once the keys are present; the
fallbacks (`"Processing failed"`, `None`, `True`) become dead paths for worker failures. No reader, model, response,
or schema change. Requirement 3 is satisfied by the worker change plus contract-test verification.

## 4. Changes by file

| # | File | Change |
|---|---|---|
| 1 | `apps/ai-server/rag-worker-service/main.py` | Add `build_failure_details` below `classify_error` (§3.2) |
| 2 | `apps/ai-server/rag-worker-service/main.py` | `process_document`: stage tracker init + 7 assignments (§3.3) |
| 3 | `apps/ai-server/rag-worker-service/main.py` | `process_document` except handler rewrite (§3.4) |
| 4 | `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | **New** — payload construction + stage-tracker unit tests |
| 5 | `apps/ai-server/tests/integration/test_worker_failure_contract.py` | **New** — cross-service worker→rag-api failure-path contract test + drift guards |
| — | `apps/ai-server/rag-api-service/**` | **No changes** |
| — | `models/resource.py`, `ResourceResponse`, docker-compose, workflows, fixtures | **No changes** |

## 5. Implementation steps (ordered)

1. **Add `build_failure_details`** (§3.2). Verify: `python -c "import sys; sys.path.insert(0,'apps/ai-server/rag-worker-service'); import main; print(main.build_failure_details(ValueError('x'), 'text_retrieved'))"` with the worker test env stubs (or just proceed — step 4 exercises it).
2. **Add the stage tracker** (§3.3): init before `try`, seven assignments per the table.
3. **Rewrite the except handler** (§3.4) to publish `build_failure_details(e, current_stage)`.
4. **Add worker unit tests** `tests/unit/test_failure_payload.py` (see test-plan §3): payload construction/classification mapping, stage tracker through `process_document` with mocked steps (processor built via `__new__`, step methods replaced with `AsyncMock`/closures, `_publish_status_update` replaced with a capturing fake).
5. **Add the cross-service contract test** `tests/integration/test_worker_failure_contract.py` (see test-plan §4): load worker `main.py` via `importlib` under the module name `rag_worker_main` (both services define `main`; `tests/integration/conftest.py` already imported rag-api's as `main` — a second `import main` would return the cached rag-api module), then feed `build_failure_details` output through the real `rag_api_main.run_transactional_update` against a fake transactional Firestore, asserting persisted values.
6. **Run all suites** (test-plan §8) and confirm the regression set stays green.

## 6. Acceptance criteria mapping

| Acceptance (from definition) | Delivered by | Verified by |
|---|---|---|
| A1 — failed status message carries `error_message`/`stage`/`retryable`, none relying on rag-api fallbacks | §3.2, §3.4 | RW-FP-U01–U07, RW-FP-S01–S05 |
| A2 — persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = derived | §3.4 + unchanged rag-api branch | XC-FP-C01, XC-FP-C02 |
| A3 — `processing/summary` error subdocument carries same message and stage | rag-api branch (unchanged) fed the new keys | XC-FP-C03 |
| A4 — contract test exists, passes, fails on key drift on either side | §4 #5 | XC-FP-C01/C02 + XC-FP-D01–D04 |

## 7. Risks & mitigations

- **Unknown consumers of the status topic** reading the old key set → mitigated by retaining legacy `error` alongside `error_message` (F11); residual risk accepted as low; dropping the duplicate is trivial later cleanup.
- **Stage-tracker drift** as the pipeline evolves → "set before the await" convention documented in code order; representative-stage tests (early + late failure) pin the mechanism without ossifying every step. If the tracker is removed, the handler's `current_stage` reference raises `NameError` inside `except` and the stage tests fail loudly.
- **`retryable=false` for unclassified-unknown** may reduce auto-retry affordances for unrecognized-but-transient failures → accepted per definition; widening `classify_error` is out of scope; manual reprocess remains.
- **Contract test ossifies the payload** → intentional drift guard; adding a key later means touching the test.
- **Module-name collision in the contract test** (`main` in both services) → importlib alias `rag_worker_main`; never `import main` for the worker side.
- **AST guard brittleness** → scoped narrowly to the failed-publish call site and the helper's return dict; the functional tests carry the semantic weight, the AST guard only pins that the publish site routes through the helper.

## 8. Out of scope (per definition nonGoals)

- Stale-lease sweep behavior (already contract-consistent; `retryable: true` stays).
- Retry/backoff mechanics: ACK/NACK policy, leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`).
- Structured error-code taxonomy (`summary.error.code` stays `"UNKNOWN"`; worker sends no `error_code`).
- Anything the unavailable companion D3 issue covers beyond this payload alignment; reconciling with the missing `plans/upload-flow.md` D4 note.

## 9. Verification commands

```bash
# worker unit suite (new + existing)
cd apps/ai-server/rag-worker-service && python -m pytest tests/unit/test_failure_payload.py -v
cd apps/ai-server/rag-worker-service && python -m pytest tests -v

# cross-service contract suite (new file auto-collected alongside test_api_contracts.py)
cd apps/ai-server && python -m pytest tests/integration/test_worker_failure_contract.py -v
cd apps/ai-server && python -m pytest tests/integration -v
```

No config, CI-workflow, or pytest.ini changes are required: the worker file lands under the existing
`testpaths = tests` (asyncio_mode=auto already set); the contract file matches `tests/integration/test_*.py` and is
synchronous (no asyncio needed).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — rag-worker → rag-api failure payload contract alignment

Companion to `docs/plan.md`. Covers the worker's failure-payload construction, the stage tracker, and the
worker → rag-api failure-path contract test, including drift guards on both sides.

## 1. Goals

1. Prove the worker's failed payload always carries `error_message` (actual message), `stage` (true failing stage from
   the existing progress vocabulary), and `retryable` (derived from `classify_error`) — never relying on rag-api's
   fallback defaults.
2. Prove end-to-end persistence: worker payload → rag-api `run_transactional_update` → main doc `error` /
   `error_stage` / `retryable` and `processing/summary.error` — values equal to the worker's.
3. Lock the seam: any key drift on either side fails the build.
4. No regression to the stale-lease sweep, ACK/NACK logic, or existing contract fixtures.

## 2. Environments & harness

### 2.1 Worker unit tests — `apps/ai-server/rag-worker-service/tests/unit/`

- Runs under the existing `tests/conftest.py` stub set (firebase, google.cloud, openai, langfuse, langchain, spacy,
  tiktoken, tenacity, pubsub) and `pytest.ini` (`testpaths = tests`, `asyncio_mode = auto`) — async test methods run
  without decorators.
- `import main` works as in existing suites (e.g. `test_processing_lease.py`).
- Processor harness for pipeline tests — no config/env/service init:
  ```python
  proc = main.EnhancedDocumentProcessor.__new__(main.EnhancedDocumentProcessor)
  proc.logger = structlog.get_logger()          # real structlog in this env
  proc.langfuse = None
  proc.db = SimpleNamespace(document=lambda path: SimpleNamespace(update=lambda d: None))
  proc._get_document_path = lambda user_id, course_id, resource_id: f"users/{user_id}/resources/{resource_id}"
  proc.embedding_cost_per_token = 0.00002       # touched by metrics math even with 0 chunks
  proc.config = SimpleNamespace(summary_prompt_version=1, summary_max_chars=5000, summary_model="m")
  proc.content_tagger = SimpleNamespace(generate_tags=AsyncMock(return_value=([], {})))
  ```
  Replace step methods per scenario with `AsyncMock(side_effect=...)` / `AsyncMock(return_value=...)`, and replace
  `_publish_status_update` with a capturing fake:
  ```python
  captured = []
  async def fake_publish(user_id, course_id, resource_id, status, details, job_id=None):
      captured.append((status, dict(details), job_id))
  proc._publish_status_update = fake_publish   # instance attribute → not bound; no self
  ```
  Then `await proc.process_document("u1", "c1", "r1", "job-1")` and assert on `captured[-1]`.

### 2.2 Cross-service contract test — `apps/ai-server/tests/integration/test_worker_failure_contract.py`

- Gets rag-api via the existing `conftest.py` (mocks `firebase_admin`/`google.cloud`/`structlog` as `MagicMock`,
  inserts `rag-api-service` on `sys.path`): `import main as rag_api_main`.
- **Worker import (collision-safe):** both services define `main`; conftest already imported rag-api's. Load the
  worker under an alias:
  ```python
  WORKER_MAIN = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "rag-worker-service", "main.py"))

  def _load_worker_main():
      for name, attrs in WORKER_STUBS:          # only what conftest doesn't already stub:
          sys.modules.setdefault(name, types.ModuleType(name, **{"__path__": []}) if attrs is None
                                 else _stub_with(attrs))   # langchain, langchain.text_splitter,
          # langchain.schema, openai, langfuse, spacy, sklearn, sklearn.feature_extraction,
          # sklearn.feature_extraction.text, tiktoken (get_encoding), tenacity (identity retry)
      spec = importlib.util.spec_from_file_location("rag_worker_main", WORKER_MAIN)
      mod = importlib.util.module_from_spec(spec)
      sys.modules["rag_worker_main"] = mod
      spec.loader.exec_module(mod)              # module-level env reads are satisfied by conftest env defaults
      return mod

  @pytest.fixture(scope="module")
  def rag_worker_main():
      return _load_worker_main()
  ```
  Module-level side effects at worker import (`GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `SubscriberClient(...)`, `subscription_path`, `logger.info`) all resolve against conftest's env defaults and
  MagicMocks. Real `httpx`, `pydantic`, `pydantic_settings` are already installed (rag-api needs them).
- **Fake transactional Firestore** for `run_transactional_update` (mirrors the fake-tx pattern in
  `rag-worker-service/tests/unit/test_processing_lease.py`):
  ```python
  class FakeSnapshot:
      def __init__(self, data): self._data = data; self.exists = True
      def to_dict(self): return dict(self._data)

  class FakeSummaryRef:  # marker only; tx.set records it
      pass

  class FakeDocRef:
      id = "r1"
      def __init__(self, store): self._store = store
      def get(self, transaction=None): return FakeSnapshot(self._store["doc"])
      def collection(self, name): return SimpleNamespace(document=lambda doc_id: FakeSummaryRef())

  class FakeTx:
      def __init__(self, store): self._store = store
      def update(self, ref, data): self._store["main"] = data
      def set(self, ref, data, merge=None): self._store["summary"] = data

  class FakeDb:
      def __init__(self, store): self._store = store; self._tx = FakeTx(store)
      def transaction(self): return self._tx
      def document(self, path): return FakeDocRef(self._store)
  ```
- **Monkeypatches required** (conftest's `firebase_admin.firestore` is a bare `MagicMock`, so rag-api's
  `@firestore.transactional` would otherwise no-op into a MagicMock):
  ```python
  monkeypatch.setattr(rag_api_main.firestore, "transactional", lambda fn: fn, raising=False)
  monkeypatch.setattr(rag_api_main.firestore, "SERVER_TIMESTAMP", "SERVER_TIMESTAMP", raising=False)
  ```
- Invocation: `rag_api_main.run_transactional_update(FakeDb(store), FakeDb(store).document("users/u1/resources/r1"),
  "failed", payload, rag_api_main.logger, "u1")` with `store = {"doc": {"status": "processing"}}` (processing → failed
  is an allowed transition in `ALLOWED_TRANSITIONS`).
- **Emulator vs fakes:** fakes are the primary mechanism — hermetic, no infra dependency, and the definition allows
  either ("via the Firestore emulator or fakes"). Both services' `FIRESTORE_EMULATOR_HOST` branches remain available
  for a future live-emulator variant; not in this scope.
- Tests are synchronous (both `build_failure_details` and `run_transactional_update` are sync); no asyncio needed.

## 3. Worker unit tests — `tests/unit/test_failure_payload.py`

### 3.1 Payload construction (`TestBuildFailureDetails`)

| ID | Test | Assertions |
|---|---|---|
| RW-FP-U01 | transient exception → retryable True | `build_failure_details(TransientError("timeout"), "embeddings_complete")["retryable"] is True` |
| RW-FP-U02 | permanent exception → retryable False | `PermanentError("bad input")` → `retryable is False` |
| RW-FP-U03 | unclassified-unknown → conservative False | `ValueError("boom")` → `retryable is False` (pins the deliberate behavior change) |
| RW-FP-U04 | http heuristics | `httpx.ConnectError` → True; `httpx.HTTPStatusError` w/ 500-response → True; w/ 404-response → False (build real `httpx.Request`/`httpx.Response`) |
| RW-FP-U05 | key set + legacy hedge | required keys `{error_message, stage, retryable}` present; legacy `error` present and `== error_message`; `"error_code" not in payload` (pins prefer-not) |
| RW-FP-U06 | stage passthrough & safe value | stage value passes through unchanged; `stage=None` → `"processing"` (never `None`) |
| RW-FP-U07 | derivation sourced from classify_error | monkeypatch `main.classify_error` with a spy returning False → payload `retryable is False` and spy called with the exception (pins that the payload derives from the same function run_worker uses for ACK/NACK) |

### 3.2 Stage tracker through `process_document` (`TestProcessDocumentFailureStage`)

| ID | Scenario (mocked steps) | Assertions on captured failed publish |
|---|---|---|
| RW-FP-S01 | early: `_validate_processing_request` raises `ValueError("doc missing")` | `status == "failed"`; `stage == "starting"`; `error_message == "doc missing"`; `retryable is False` |
| RW-FP-S02 | text retrieval: `_get_extracted_text` raises `ValueError("boom-extract")` | `stage == "text_retrieved"`; `error_message == "boom-extract"`; `retryable is False`; legacy `error == error_message` |
| RW-FP-S03 | embeddings: text/tagging/summary/chunking mocked to succeed, `_generate_embeddings_with_openrouter` raises `httpx.ConnectError("conn refused")` | `stage == "embeddings_complete"`; `retryable is True` (transient path) |
| RW-FP-S04 | chunking: `_create_enhanced_chunks` raises `RuntimeError("boom-chunk")` | `stage == "chunking_complete"`; `retryable is False` |
| RW-FP-S05 | handler hygiene | failed publish emitted exactly once with status `"failed"`; `metrics.error_message == str(e)`; progress publishes before the failure still carry the existing `{"stage": ...}` shape |
| RW-FP-S06 | storage phase: all steps succeed through embeddings, `store_chunks_via_service` raises `RuntimeError("partial write")` | `stage == "embeddings_complete"` (tracker deliberately not regressed to `"processing"` in the storage phase) |

If the tracker is removed or bypassed, the handler's `current_stage` reference raises inside `except` and S01–S04 fail
loudly — no AST guard needed for the tracker.

## 4. Cross-service contract tests — `tests/integration/test_worker_failure_contract.py`

### 4.1 Functional persistence (`TestWorkerFailurePersistence`)

| ID | Test | Assertions |
|---|---|---|
| XC-FP-C01 | transient path end-to-end | payload = `rag_worker_main.build_failure_details(httpx.ConnectError("upstream unavailable"), "embeddings_complete")` → `run_transactional_update(..., "failed", payload, ...)`; persisted main: `error == "upstream unavailable"` (≠ `"Processing failed"`), `error_stage == "embeddings_complete"` (not None), `retryable is True`, `status == "failed"` |
| XC-FP-C02 | permanent path end-to-end | payload from `ValueError("malformed pdf")` at stage `"text_retrieved"`; persisted `retryable is False` — proves the value came from the payload, not rag-api's `True` default |
| XC-FP-C03 | summary subdocument parity | `store["summary"]["error"]["message"] == main error`, `["stage"] == main error_stage`, `["code"] == "UNKNOWN"`; top-level `store["summary"]["stage"] == payload stage` (acceptance A3) |

### 4.2 Drift guards (`TestFailureContractDrift`)

| ID | Guard | Mechanism | Catches |
|---|---|---|---|
| XC-FP-D01 | worker payload key drift (functional) | assert `{"error_message","stage","retryable"} <= set(payload)`; legacy `error` present; `error_code` absent | worker drops/rekeys a required key |
| XC-FP-D02 | rag-api read-key drift (functional) | C01/C02 equality assertions: if rag-api renames `error_message`/`stage`/`retryable` reads, the fallbacks (`"Processing failed"`, `None`, `True`) surface and equality fails; a dropped persistence write leaves the key missing in the recorded `main`/`summary` update | rag-api side rekeys or stops persisting |
| XC-FP-D03 | publish-site routing (AST, in-process `ast.parse` of worker `main.py`) | locate `AsyncFunctionDef process_document` → its `ExceptHandler` → the `Call` to `_publish_status_update` whose 4th positional arg is `Constant "failed"`; assert the 5th arg (details) is a `Call` to `Name "build_failure_details"` | someone reintroduces a hand-rolled `{"error": str(e)}` payload at the publish site, bypassing the helper |
| XC-FP-D04 | helper contract (AST) | locate `FunctionDef build_failure_details`; assert its returned `ast.Dict` has string keys including `error_message`, `stage`, `retryable`, `error`, and that the `retryable` value is a `Call` to `Name "classify_error"` | helper stops deriving retryable from `classify_error` or drops a key |

AST helpers follow the house pattern in `test_api_contracts.py` (`_get_agent_graph_shapes`) but parse in-process from
the worker source file — no subprocess, no import of the worker module required for the static guards.

### 4.3 Drift-detection matrix (why each direction fails the build)

| Drift | Failing signal |
|---|---|
| Worker drops/rekeys `error_message` | XC-FP-C01: persisted `error == "Processing failed"` ≠ worker message; XC-FP-D03; RW-FP-U05 |
| Worker drops `stage` | XC-FP-C01: persisted `error_stage is None` ≠ stage |
| Worker drops `retryable` | XC-FP-C02: persisted `retryable is True` (default) ≠ worker `False` |
| Worker bypasses helper at publish site | XC-FP-D03 |
| Helper stops deriving from `classify_error` | XC-FP-D04 + RW-FP-U07 |
| rag-api rekeys its reads | XC-FP-C01/C02 fallback values surface |
| rag-api stops persisting a field | key absent from recorded `main`/`summary` update |

## 5. Regression set (must stay green)

| Suite | Why it matters |
|---|---|
| `rag-worker-service/tests` (full) | worker behavior unchanged elsewhere; `test_processing_lease.py` pins the sweep's `error`/`error_stage:"processing"`/`retryable:True` write, which this plan must not alter |
| `tests/integration/test_api_contracts.py` | rag-api response-model fixtures untouched; proves zero rag-api drift |
| `tests/integration/test_search_pipeline.py`, `test_chat_pipeline.py` | untouched flows over the same status subscriber path |

## 6. Acceptance → test mapping

| Acceptance | Tests |
|---|---|
| A1 payload carries all three keys, no fallback reliance | RW-FP-U01–U07, RW-FP-S01–S05 |
| A2 persisted error/error_stage/retryable equal worker values | XC-FP-C01, XC-FP-C02 |
| A3 summary subdocument message + stage parity | XC-FP-C03 |
| A4 contract test exists, passes, fails on either side's key drift | XC-FP-C01/C02 + XC-FP-D01–D04 |

## 7. Deliberately NOT tested

- Stale-lease sweep write shape (already covered by `test_processing_lease.py`; non-goal).
- ACK/NACK mechanics, lease/heartbeat timing (non-goal; only retryable *reporting* changes).
- Frontend exposure of `retryable` (out of scope; `ResourceResponse` unchanged).
- Full `process_document` happy path with real externals (existing RW-U17/U18 territory; not needed here).
- A live Firestore-emulator run of the contract path (fakes satisfy the definition; emulator variant deferred).

## 8. Commands & CI wiring

```bash
cd apps/ai-server/rag-worker-service && python -m pytest tests/unit/test_failure_payload.py -v
cd apps/ai-server/rag-worker-service && python -m pytest tests -v
cd apps/ai-server && python -m pytest tests/integration/test_worker_failure_contract.py -v
cd apps/ai-server && python -m pytest tests/integration -v
```

No pytest.ini/pyproject/workflow changes: the worker file is collected by the existing `testpaths = tests`
(`asyncio_mode = auto` covers the async pipeline tests); the contract file matches `tests/integration/test_*.py` in
whatever job already runs the integration/contract suite (per `docs/TESTING-STRATEGY.md`) and is synchronous.

## 9. Test-side risks & notes

- **MagicMock conftest interactions:** the integration conftest's bare-MagicMock `firebase_admin.firestore` makes
  `@firestore.transactional` a no-op — the monkeypatches in §2.2 are mandatory, not optional.
- **Module-name collision:** never `import main` for the worker in `tests/integration`; only the `rag_worker_main`
  alias. The AST guards read the source file directly and are immune.
- **Stub discipline in the loader:** use `sys.modules.setdefault` so conftest's firebase/google/structlog mocks are
  never overwritten; the loader stubs only langchain/openai/langfuse/spacy/sklearn/tiktoken/tenacity.
- **AST guard scope:** pinned narrowly (failed-publish site + helper return dict) to avoid ossifying unrelated code;
  the functional tests carry the semantic assertions.
- **`httpx.HTTPStatusError` construction** in RW-FP-U04 requires real `request`/`response` objects — build them with
  `httpx.Request("GET", "http://test")` and `httpx.Response(status_code)`; do not mock the exception class.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>