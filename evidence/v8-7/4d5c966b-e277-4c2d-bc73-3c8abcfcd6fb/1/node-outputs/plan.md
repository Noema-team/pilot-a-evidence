All contracted evidence has been gathered and verified against the pinned sources (worker `main.py` sha256 `7d7718bc…`, rag-api `main.py` sha256 `579b0bdf…`, contract-test file sha256 `cb073c27…`, worker test conftest sha256 `20baea26…`). The plan below is produced strictly from that verified evidence plus the authoritative Definition; anything not directly read is explicitly marked as taken from the Definition or as needing confirmation during implementation.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

- Run: 4d5c966b-e277-4c2d-bc73-3c8abcfcd6fb (iteration 1, planning depth: minimal)
- Authoritative scope: WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). Binding; not widened or narrowed here.
- Intent: a failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived `retryable` — locked in by a contract test on the worker→rag-api failure path.

Evidence key (sources read directly during investigation, sha-pinned):
- `apps/ai-server/rag-worker-service/main.py` (sha256 `7d7718bc…`, 2252 lines) — cited below as **W**.
- `apps/ai-server/rag-api-service/main.py` (sha256 `579b0bdf…`, 2328 lines) — cited as **A**.
- `apps/ai-server/tests/integration/test_api_contracts.py` (sha256 `cb073c27…`) — cited as **T**.
- `apps/ai-server/rag-worker-service/tests/conftest.py` (sha256 `20baea26…`) — cited as **WC**.
Line references are approximate (`~L`) from the read snapshot; function names are the stable anchors.

---

## 1. Verified current state (what is broken)

1. **Worker publishes a one-key failure payload.** `process_document`'s exception handler (W ~L1088–1096) does:
   `metrics.error_message, metrics.end_time = str(e), time.time()` then
   `await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)`.
   `process_document` (W ~L997–1097) is one large `try` block; nothing tracks which pipeline step was executing, so no stage can be reported today (F3, F9 confirmed by direct read).
2. **rag-api's failed branch reads three different keys.** `run_transactional_update(db, doc_ref, new_status, details, logger, user_id)` (A ~L168; failed branch ~L241–244, direct read):
   ```python
   main_update["error"]      = details.get("error_message", "Processing failed")
   main_update["error_stage"] = details.get("stage")
   main_update["retryable"]  = details.get("retryable", True)
   ```
   and writes `stage`/`progress` into the `processing/summary` subdocument (base dict verified A ~L247–252; the failed-branch `message`/`error_code` ("UNKNOWN") summary writes are pinned by Definition fact F4 — the read was truncated at A ~L249, so those specific lines are taken from the authoritative Definition, not independently read).
3. **Net effect (F5):** every worker-originated failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (silent default), and the summary subdocument inherits the fallbacks with `error_code="UNKNOWN"`.
4. **The `error`/`error_stage`/`retryable` schema is already established everywhere else** (F6): the worker's stale-lease sweep `_fail_if_still_stale` (W ~L2183–2207, direct read) writes `error`, `error_stage="processing"`, `retryable=True` transactionally; rag-api's enqueue-failure paths and the `Resource` model / `ResourceResponse` expose the same fields (model file not directly read this pass — taken from F6).
5. **`classify_error()` exists and drives ACK/NACK** (W ~L37–80 and `run_worker` handler ~L2040–2075, direct read): `TransientError` → True; transient httpx types (`ConnectError`, `ConnectTimeout`, `ReadTimeout`, `WriteTimeout`, `PoolTimeout`), `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` → True; `httpx.HTTPStatusError` with status in (429, 500, 502, 503, 504) → True; `PermanentError`, other 4xx, and **unknown exceptions → False** (conservative default). `run_worker` NACKs transient (omits ack_id) and acks permanent.
6. **Stage vocabulary in progress updates** (W, direct read): `starting`, `text_retrieved` (progress 20), `tagging_complete` (40), `summary_generated` (50), `chunking_complete` (60), `embeddings_complete` (80), `completed` (100).
7. **Contract-test infrastructure exists** (T, direct read): `tests/integration/test_api_contracts.py` imports `main as rag_api_main`, uses JSON fixtures in `tests/fixtures/api-contracts/` and AST-shape extraction; both services have hermetic branches (rag-api's `FIRESTORE_EMULATOR_HOST` startup branch verified A ~L139–149; worker logs `PUBSUB_EMULATOR_HOST` at module level W ~L1800s; full worker emulator support asserted by F10).
8. **Worker test stubbing exists** (WC, direct read): `rag-worker-service/tests/conftest.py` sets env defaults (`GCP_PROJECT=test-gcp`, `RAG_STATUS_TOPIC=test-topic`, `GOOGLE_APPLICATION_CREDENTIALS=/dev/null`, …) and stubs `langchain`, `openai`, `langfuse`, `firebase_admin`, `google.cloud.*`, `spacy`, `tiktoken`, `tenacity` (retry → passthrough) so worker `main` imports without real GCP.
9. **`_publish_status_update` mechanics** (W ~L1522–1596, direct read): injects `details["jobId"]` when `job_id` is provided and not already present; wraps publish in try/except (publish failures only log `status_publish_failed`); message envelope carries `user_id/course_id/resource_id/status/details/timestamp/sequence`; details pass through untouched otherwise.

## 2. Fix strategy — the worker aligns to the API

Zero changes to `rag-api-service/`. No Firestore migration, rename, or backfill (constraint `must_not`). The worker is the only writer not speaking the established schema; fix the odd one out.

### 2.1 Failure-payload builder (worker; new, pure, module-level)

Add next to `classify_error` in `apps/ai-server/rag-worker-service/main.py` (~L80):

```python
def build_failure_details(error: Exception, stage: str) -> Dict[str, Any]:
    """Build the failed-status payload per the rag-api failed-branch contract.

    Keys are pinned by tests/integration contract tests:
      error_message -> rag-api persists as `error`
      stage         -> rag-api persists as `error_stage`
      retryable     -> derived from classify_error, mirrors ACK/NACK behavior
      error         -> legacy key retained for unknown status-topic consumers (F11)
    """
    return {
        "error_message": str(error),
        "error": str(error),
        "stage": stage,
        "retryable": classify_error(error),
    }
```

- `retryable` derivation (F8, binding): transient-classified → `True` (Pub/Sub will redeliver; the NACK path); permanent-classified, **including unclassified-unknown** → `False` (acked; manual reprocess via `POST /process` remains). This makes the persisted record tell the truth about ACK/NACK, which uses the same `classify_error`.
- **Deliberate behavior change:** unclassified-unknown exceptions flip from persisted `retryable=True` (silent default) to `False`. Accepted per F8; `classify_error` widening is out of scope.
- Legacy `error` key retained as the compatibility hedge (F11, constraint `prefer`); one redundant string per failure message.
- No error-code taxonomy introduced (constraint `prefer_not`); worker sends no `error_code`, so summary `error.code` stays `"UNKNOWN"`.

### 2.2 Stage tracker in `process_document` (worker)

- Declare `current_stage = "processing"` **before** the `try` block so the handler can always reference it.
- Convention (must be stated in a one-line comment at the tracker declaration): **set the tracker immediately before the await/step it labels**. Mapping to the verified code:
  - init `"processing"` — failures before the first transition (e.g. `_validate_processing_request` raising) report `"processing"`, matching `_fail_if_still_stale`'s `error_stage` value so the field never regresses to null;
  - `"starting"` immediately before the first `_publish_status_update(..., {"stage": "starting"}, ...)` (W ~L1004);
  - `"text_retrieved"` before `_get_extracted_text` (~L1007);
  - `"tagging_complete"` before `content_tagger.generate_tags` (~L1012);
  - `"summary_generated"` before `generate_document_summary` (~L1016);
  - `"chunking_complete"` before `_create_enhanced_chunks` (~L1034);
  - `"embeddings_complete"` before `_generate_embeddings_with_openrouter` (~L1038); **inherited** by `delete_old_vectors_via_service`, `store_chunks_via_service`, and `_save_processing_metadata_to_subcollection` (no new stage name is introduced — the pinned vocabulary has no storage-stage name; a failure there reports `"embeddings_complete"`, i.e. "failed after embeddings, during storage").
- Handler rewiring (W ~L1091):
  ```python
  await self._publish_status_update(
      user_id, course_id, resource_id, "failed",
      build_failure_details(e, current_stage), job_id)
  ```
  `metrics.error_message = str(e)`, the log line, and `trace.update(...)` stay unchanged.
- Semantics note (document in the code comment): stage names are the existing completion milestones used as "step in flight" labels under the update-before-await convention — a failure during text retrieval reports `text_retrieved`. Drift risk (a future step added without updating the tracker) is mitigated by the convention comment plus representative-stage contract tests (early + late failure), not by ossifying every step.

### 2.3 rag-api — no changes

The verified failed branch already maps payload → persisted exactly as required (`error ← error_message`, `error_stage ← stage`, `retryable ← retryable`; summary carries the same message/stage per F4). `ALLOWED_TRANSITIONS` already permits `processing → failed` (A ~L175–181). Any edit here is out of scope.

### 2.4 Explicitly unchanged

- `_fail_if_still_stale` / `_stale_lease_sweep_loop` (W ~L2183–2252): keeps `retryable=True` — a dead worker is a transient condition (non-goal).
- ACK/NACK policy, leases, heartbeats, retry decorators (non-goal; only *reporting* of retryability changes).
- `models/resource.py`, `ResourceResponse`, frontend/mobile (non-goal).

## 3. Edge cases and decisions

| Case | Decision | Rationale |
|---|---|---|
| Empty exception message (`str(e) == ""`) | Builder emits `str(e)` verbatim; persisted `error` would be `""` (key present, so API fallback not operative) | Requirement pins `error_message` = the actual exception message; no extra keys allowed (key-set guard). Type name remains visible in worker logs (`document_processing_failed`, `run_worker` logs `error_type`). Accepted residual. |
| `jobId` injection | `_publish_status_update` adds `details["jobId"]` when `job_id` provided (W ~L1527–1529) | Contract key set is therefore `{error, error_message, stage, retryable}` + optional `jobId`; tests pass `job_id=None` for exact-set assertions and assert the ⊆-relation when `job_id` is set. |
| Publish failure | `_publish_status_update` swallows publish errors (logs `status_publish_failed`) | Builder is pure, so payload construction cannot be the failure source; unchanged behavior. |
| Unknown status-topic consumers | Legacy `error` retained alongside `error_message` (F11) | If a later audit confirms worker is sole publisher / rag-api sole consumer, dropping the duplicate is trivial cleanup. |
| Post-embedding storage failures | Report inherited `"embeddings_complete"` | No storage stage exists in the pinned vocabulary; more informative than the `"processing"` fallback, which is reserved for "genuinely unknown". |

## 4. Work breakdown and sequencing

- **T1 — Worker change + worker unit tests.** Add `build_failure_details`; add stage tracker + handler rewiring in `process_document`; add `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` (see docs/test-plan.md, WU-*). Runnable entirely under the existing worker conftest stubs (WC).
- **T2 — Contract-test scaffolding.** Inspect `apps/ai-server/tests/integration/conftest.py` (**content not read this pass — must confirm**; T imports `rag_api_main` directly, so the integration environment already resolves rag-api's imports). Add worker-dependency stubbing for the integration run modeled on WC (`_stub_module` bootstrap + env defaults), scoped so both worker `main` and rag-api `main` import in one pytest session. Persistence layer: Firestore emulator (`FIRESTORE_EMULATOR_HOST`, `GCP_PROJECT=demo-project` default per A ~L139–149); the worker's own startup path is never exercised (processor is constructed directly), so worker emulator support is not load-bearing.
- **T3 — Contract tests.** New file `apps/ai-server/tests/integration/test_worker_failure_contract.py` (see docs/test-plan.md, CT-*). Depends on T1's builder/tracker.
- **T4 — Full-suite green.** Worker unit suite, rag-api unit suite (incl. `test_service_contracts.py`, `test_models_resource.py`), top-level integration (`test_api_contracts.py`) — rag-api is untouched, so its suites act as canaries.

Order: T1 first; T2 can proceed in parallel; T3 after T1 (+T2); T4 last.

## 5. Files touched

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Add `build_failure_details`; stage tracker + handler rewiring in `process_document`; convention comment. **Only production file changed.** |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | New (WU-*). |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | New (CT-*). |
| `apps/ai-server/tests/integration/conftest.py` | Extend with worker stubbing (pending T2 inspection). |

Not touched: everything under `apps/ai-server/rag-api-service/`, worker sweep/heartbeat/ACK-NACK code, `models/resource.py`, frontend, `plans/upload-flow.md` (not present in tree; D4 reconciliation deferred per F12).

## 6. Acceptance criteria → where satisfied

| Acceptance (from Definition) | Satisfied by |
|---|---|
| 1. Failed status payload carries `error_message`/`stage`/`retryable`, none relying on API fallbacks | §2.1 + §2.2; pinned by CT-1/CT-4/CT-5 |
| 2. Persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = derived value | rag-api verified mapping + CT-1/CT-2/CT-3 |
| 3. `processing/summary` error subdocument carries same message and stage | CT-6 (summary specifics per F4) |
| 4. Contract test exists and passes, failing on either side's key drift | CT-1..CT-6 incl. behavioral drift guards |

## 7. Risks and tradeoffs (from the Definition, with mitigations)

- **Unknown consumers of the status topic** → legacy `error` retained; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves → update-before-await convention comment + representative-stage tests (early and late failure).
- **`retryable=False` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures → accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` unaffected.
- **Contract test ossifies the payload** → intentional; adding a key later means touching the test, which is the drift guard doing its job.

## 8. Evidence verification status

- Directly read and sha-pinned: worker failure handler, `process_document` step sequence and stage vocabulary, `_publish_status_update`, `classify_error`, `run_worker` ACK/NACK, `_fail_if_still_stale`, rag-api `run_transactional_update` signature + failed-branch main-update writes + summary base dict + emulator startup branch, `test_api_contracts.py` pattern, worker test conftest stubs, test directory layouts.
- Taken from the authoritative Definition without independent read: rag-api summary-subdocument failed-branch `message`/`error_code` specifics (F4; read truncated at A ~L249), `Resource`/`ResourceResponse` field exposure (F6), rag-api enqueue-failure paths (F6), full worker emulator-mode support (F10), companion D3 issue content (F12 — deferred).
- To confirm during implementation: contents of `apps/ai-server/tests/integration/conftest.py`, both services' `pytest.ini` (markers/asyncio mode), and the exact pytest invocation entry points for the top-level integration suite.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker→rag-api failure payload contract

Companion to docs/plan.md (run 4d5c966b, scope `wi-define-108-a8`). Strategy per the Definition: **import both sides rather than restate the contract in a fixture** — build the failure payload through the worker's real code path, feed it through rag-api's `run_transactional_update`, assert the persisted `error`/`error_stage`/`retryable`, and add drift guards so a future key edit on either side fails the build.

## 1. Environments and mechanics

- **Persistence: Firestore emulator.** `run_transactional_update` (rag-api `main.py` ~L168, module-level, verified signature `(db, doc_ref, new_status, details, logger, user_id)`) is called directly with a real `firestore.client()` pointed at the emulator (`FIRESTORE_EMULATOR_HOST` set; rag-api's emulator startup branch verified ~L139–149 establishes the supported pattern). Fakes remain the fallback if emulator orchestration is unavailable in CI (Definition permits "emulator or fakes").
- **Worker import: stub heavy deps.** Reuse the approach proven in `rag-worker-service/tests/conftest.py` (sha `20baea26…`): `_stub_module` for `langchain*`, `openai`, `langfuse`, `firebase_admin`, `google.cloud.*`, `spacy`, `tiktoken`, `tenacity` (retry → passthrough) plus env defaults (`GCP_PROJECT`, `RAG_STATUS_TOPIC`, `GOOGLE_APPLICATION_CREDENTIALS=/dev/null`, …). For the top-level integration suite, this bootstrap moves into `apps/ai-server/tests/integration/conftest.py` or a helper imported by the new test file (**conftest content not yet read — confirm in T2**; `test_api_contracts.py` already imports `rag_api_main` successfully, so the integration env resolves rag-api's imports today).
- **Processor construction (worker side):** build `EnhancedDocumentProcessor` via `object.__new__` and inject attributes — `db` (emulator client), `pubsub_publisher` (fake capturing `publish(topic_path, data)` calls and returning an already-completed `concurrent.futures.Future`, because `_publish_status_update` awaits `asyncio.wrap_future(future)` — verified W ~L1571), `langfuse=None` (verified `if self.langfuse else None` guard), `config`, `content_tagger`, plus whatever the executed path touches. Bypassing `__init__` avoids real clients/creds.
- **Step patching:** patch the step under test (and all later steps) as **instance attributes** — e.g. `processor._get_extracted_text = raising_async(...)` — which also bypasses the `@retry` tenacity decorators on `_generate_embeddings_with_openrouter` and `store_chunks_via_service` (verified W ~L1620, ~L1770) so no real retries/waits run. `content_tagger.generate_tags` normally swallows exceptions (verified, returns `[], {}`), so stage tests patch it to raise.
- **Seed data (emulator):** resource doc at `users/{uid}/resources/{rid}` with `userId`, `extractedText`, `status="processing"` (the only status from which `failed` is an allowed transition — verified `ALLOWED_TRANSITIONS` A ~L175–181).
- **job_id:** contract key-set assertions use `job_id=None`; one test covers `job_id` set → allowed extra key `jobId` only (verified injection W ~L1527–1529).

## 2. Worker unit tests — `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`

Run under the existing worker conftest stubs; no emulator needed.

| ID | Test | Assertions |
|---|---|---|
| WU-1 | Builder key set | `set(build_failure_details(e, "s"))` == `{"error", "error_message", "stage", "retryable"}` — exactly, no extras |
| WU-2 | retryable derivation table | `TransientError`→True; `httpx.ConnectError`→True; `httpx.HTTPStatusError` 429/500/502/503/504→True; `TimeoutError`→True; `PermanentError`→False; `httpx.HTTPStatusError` 404→False; `ValueError`→False; bare `Exception` (unknown)→**False** (pins the deliberate F8 change) |
| WU-3 | message passthrough | `error_message == error == str(e)` verbatim, incl. empty-message edge (`str(e) == ""` → `""`; accepted per plan §3) |
| WU-4 | stage: pre-first-transition | patch `_validate_processing_request` to raise `ValueError("doc missing")` → captured failed payload `stage == "processing"`, `error_message == "doc missing"`, `retryable is False` |
| WU-5 | stage: text retrieval | patch `_get_extracted_text` to raise `TransientError("weaviate timeout")` → `stage == "text_retrieved"`, `retryable is True` |
| WU-6 | stage: tagging | patch `content_tagger.generate_tags` to raise → `stage == "tagging_complete"` |
| WU-7 | stage: summary | patch `generate_document_summary` to raise → `stage == "summary_generated"` |
| WU-8 | stage: chunking | patch `_create_enhanced_chunks` to raise → `stage == "chunking_complete"` |
| WU-9 | stage: embeddings | patch `_generate_embeddings_with_openrouter` to raise → `stage == "embeddings_complete"` |
| WU-10 | stage: storage (inheritance) | patch `delete_old_vectors_via_service` and `store_chunks_via_service` to raise → `stage == "embeddings_complete"` (inherited; documents the no-new-vocabulary decision) |
| WU-11 | jobId tolerance | with `job_id="j1"`, captured details keys == contract keys ∪ `{"jobId"}` |

All WU-4..WU-11 drive `process_document` end-to-end (patching every step after the one under test) and assert on the JSON published through the fake publisher (`status == "failed"` envelope, `details` payload) — i.e., through `_publish_status_update`, not around it.

## 3. Contract tests — `apps/ai-server/tests/integration/test_worker_failure_contract.py`

New sibling of `test_api_contracts.py`, same import-based house pattern (`import main as rag_api_main`; worker `main` imported under the stub bootstrap). Shared fixture: emulator client, seeded resource, processor as in §1, a helper `run_failure(scenario) -> (captured_payload, doc_snapshot, summary_snapshot)` that (a) drives `process_document` with the scenario's patched raising step, (b) decodes the captured failed-status message, (c) calls `rag_api_main.run_transactional_update(db, doc_ref, "failed", payload, logger, uid)`, (d) re-reads the main doc and `processing/summary` subdoc.

| ID | Scenario | Assertions |
|---|---|---|
| CT-1 | Early-stage transient (`_get_extracted_text` raises `TransientError("weaviate timeout")`) | main doc: `error == "weaviate timeout"` (not `"Processing failed"`), `error_stage == "text_retrieved"` (not None), `retryable is True`; status `"failed"` |
| CT-2 | Late-stage permanent (`store_chunks_via_service` raises `PermanentError("partial vector write")`) | `error == "partial vector write"`, `error_stage == "embeddings_complete"`, `retryable is False` |
| CT-3 | Unknown exception (bare `Exception("boom")` at text retrieval) | `retryable is False` persisted — pins the deliberate behavior change (was silent `True`) |
| CT-4 | Worker key-set drift guard | captured payload keys (job_id=None) == `{error, error_message, stage, retryable}` exactly. Fails if the worker adds, renames, or drops any key |
| CT-5 | API read-side drift guard (behavioral) | For each `k ∈ {error_message, stage, retryable}`: payload-minus-`k` → persisted fallback observed (`error == "Processing failed"`, `error_stage is None`, `retryable is True`; summary `stage == "unknown"`); full payload → persisted values equal payload values, fallbacks never operative. Fails if rag-api renames a read, stops reading a key, or a fallback becomes operative for worker failures (constraint 3) |
| CT-6 | Summary-subdocument parity (acceptance 3) | For CT-1 and CT-2 payloads: summary `message == main.error`, summary `stage == main.error_stage`, `error_code == "UNKNOWN"` (no code sent; per F4 — verify exact summary field names against rag-api source during T2, since that slice was read only partially) |

These six satisfy the Definition's requirement that the test "exercise the worker's failure-payload construction through rag-api's failed-branch persistence and assert the persisted error, error_stage, and retryable equal the worker's values" and "fail if either side's payload keys drift" — CT-4 catches worker-side drift, CT-5 catches API-side drift, CT-1/2/3 catch value-level drift.

## 4. Regression and canaries

- `rag-worker-service` unit suite (existing: `test_processing_lease.py`, `test_chunking.py`, etc.) — must pass unchanged; sweep/lease code untouched.
- `rag-api-service` unit suite (incl. `test_service_contracts.py`, `test_models_resource.py`) — must pass with **zero** rag-api diffs; acts as the canary for "API side unchanged".
- Top-level `tests/integration/test_api_contracts.py` — must pass unchanged (fixtures/models untouched).
- New suites from §2–§3 green.

## 5. Drift → failing test mapping

| Future edit | Caught by |
|---|---|
| Worker renames/drops `error_message`/`stage`/`retryable`/`error` | CT-4 (+WU-1) |
| Worker stops tracking stage (tracker removed/bypassed) | WU-5..WU-10, CT-1/CT-2 (`error_stage` regresses to None → CT-5 fallback assertion) |
| rag-api renames a `details.get(...)` read | CT-1/CT-2 (persisted ≠ payload) and CT-5 (omission no longer changes output) |
| rag-api adds a new required key | CT-1/CT-2 (persisted falls back) |
| `classify_error` default flips for unknown exceptions | WU-2, CT-3 |
| New pipeline step added without tracker update | WU-9/WU-10 representative coverage + convention comment (accepted residual per plan §7) |

## 6. Commands and CI notes

- Per-service: `pytest` from `apps/ai-server/rag-worker-service/` and `apps/ai-server/rag-api-service/` (both have `pytest.ini` — **contents not read; confirm markers/asyncio mode in T2**).
- Top-level integration: `pytest apps/ai-server/tests/integration/` with `FIRESTORE_EMULATOR_HOST` and `GCP_PROJECT=demo-project` set; emulator bootstrapped per the existing hermetic pattern (**confirm exact existing invocation in T2** — `test_api_contracts.py` imports `rag_api_main` at module scope, so the current harness already provides a working import environment).
- Worker contract-test import requires the stub bootstrap to run **before** `import main` (worker side); mirror WC's ordering or pre-register stubs in `sys.modules` via a conftest fixture with import-time safety.

## 7. Explicitly not tested (non-goals)

- ACK/NACK mechanics, Pub/Sub redelivery, lease/heartbeat timing (only retryability *reporting* changes); `_fail_if_still_stale` write (unchanged, already schema-consistent); rag-api enqueue-failure paths (untouched); frontend exposure of `error`/`error_stage` (`ResourceResponse` unchanged); structured error codes (none introduced).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>