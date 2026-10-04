<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- Run: afc18a5b-f04f-49c6-a9c7-4f3f856203ea
- Iteration: 1 · Step: design · Planning depth: minimal
- Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- Authoritative scope: WorkItem `wi-define-108-a8`, artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`. The Definition is binding; this document restates and operationalizes it without widening or narrowing it.

## 1. Problem

A failed RAG processing job loses the worker's diagnostic context at the worker→rag-api seam:

- The worker's exception handler in `process_document` (`apps/ai-server/rag-worker-service/main.py`) publishes the failed status with `details = {"error": str(e)}` via `_publish_status_update`.
- rag-api's failed branch in `run_transactional_update` (`apps/ai-server/rag-api-service/main.py`) reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, and `details.get("retryable", True)`, and persists them as `error`, `error_stage`, and `retryable` on the main resource document, plus `message`/`stage` (and `code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument.

Because of the key mismatch, every worker-originated failure currently persists:

- `error = "Processing failed"` (fabricated fallback, not the actual exception message),
- `error_stage = None`,
- `retryable = True` (silent default, not derived from the worker's actual ACK/NACK classification),

and the `processing/summary` error subdocument inherits the same fallbacks with `code` always `"UNKNOWN"` and the summary's top-level `stage` always `"unknown"`.

The persisted failure schema (`error`/`error_stage`/`retryable`) is already established by three other write paths and both response models: the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths (`/process`, `POST /resources`), `ResourceResponse`, and the `Resource` model (`apps/ai-server/rag-api-service/models/resource.py`, `retryable` defaults `True`). The worker's status publisher is the only writer that does not speak it.

## 2. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## 3. Scope

### 3.1 In scope

- rag-worker failure-payload construction: new keys `error_message`, `stage`, `retryable`; legacy `error` key retained.
- Stage tracking through `process_document` so the failure handler reports the true failing stage.
- `retryable` derivation from the worker's existing `classify_error()` classification.
- A contract test covering the worker failure → rag-api persistence path, including key-set drift guards.

### 3.2 Out of scope (non-goals, binding)

- Changing the stale-lease sweep's direct failure write (it already persists `error`/`error_stage`/`retryable` consistently with this contract).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## 4. Functional requirements

- **R1 (must) — Failure payload keys.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for these keys. The legacy `error` key (same string as `error_message`) is retained alongside `error_message` for continuity with any unknown consumers of the status topic and existing log tooling.
- **R2 (must) — Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null).
- **R3 (must, zero rag-api code change) — Persistence fidelity.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` gets the payload `error_message`, `error_stage` gets the payload `stage`, `retryable` gets the payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage. This is satisfied by the existing rag-api code once the keys align; it is verified by test, not by modifying rag-api. The API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures (it remains in place only for non-worker producers).
- **R4 (must) — Explicit retryable derivation.** The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior in `run_worker`: errors classified transient by `classify_error` map to `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) map to `retryable: false`.
- **R5 (must) — Contract test.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must fail if either side's payload keys drift, and it must pin the stage-tracking mechanism on representative stages (an early-stage failure and a late-stage failure).
- **R6 (must_not) — No schema change.** The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **R7 (must_not) — No reader changes.** rag-api's reads of the status payload and its persisted schema are not modified; the worker is aligned to the API, not vice versa.
- **R8 (prefer, pinned) — Legacy key retention.** The worker's failure payload retains `error` alongside `error_message` (one redundant string per failure message as insurance against unknown readers of the shared status topic). Dropping it later is trivial cleanup after a consumer audit; while present it is pinned by the contract test.

## 5. Constraints (from the Definition, binding)

| Type | Constraint |
|---|---|
| must | Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`) rather than changing rag-api's reads or persisted schema. |
| must_not | No Firestore migration, field rename, or backfill; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. |
| must | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be operative for worker failures. |
| prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## 6. Acceptance criteria and verification

| # | Criterion (from Definition) | Verified by |
|---|---|---|
| A1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | Contract test: worker payload construction captured on the failure path (early- and late-stage failure cases); static key-set drift guard. |
| A2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | Contract test round-trip: worker payload fed through rag-api `run_transactional_update` against fakes; assertions on the persisted main document, including explicit negative assertions against the fallback values. |
| A3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | Contract test round-trip: assertions on `processing/summary` `error.message`, `error.stage` (and `error.code == "UNKNOWN"`, top-level `stage` = failing stage). |
| A4 | A contract test covering the worker failure → rag-api persistence path exists and passes, exercising the worker's failure-payload construction through rag-api's failed-branch persistence and asserting persisted `error`, `error_stage`, `retryable` equal the worker's values, failing if either side's payload keys drift. | The contract test file itself (behavioral round-trip plus static AST key-set drift guard on both services' sources). |

## 7. Assumptions and deferred items

- **Assumed (adopted, F8):** `retryable` is derived from `classify_error(e)` — transient maps to `true`, permanent/unclassified-unknown maps to `false`. Rationale: aligns the persisted record with the worker's actual ACK/NACK retry behavior; the stale-lease sweep's separate `retryable=true` write stays correct because a dead worker is a transient condition. Known behavior change: unclassified-unknown exceptions previously persisted `retryable: true` (silent default) and will now persist `false`; accepted as the conservatism `classify_error` was written for — manual reprocess via `POST /process` is unaffected.
- **Assumed (hedge, F11):** No consumer other than rag-api's status subscriber is known to parse the worker's failure payload keys; the legacy `error` key is retained as insurance (R8).
- **Deferred (F12):** The companion D3 issue referenced by the Objective (content unavailable here) and reconciliation with the D4 deviation note in `plans/upload-flow.md` (file absent from the tree). Anything those cover beyond this payload alignment is out of scope.

## 8. Traceability

| Definition requirement | This doc | Acceptance | Test |
|---|---|---|---|
| Payload keys error_message/stage/retryable, never fallback-reliant | R1 | A1, A2 | T1–T3, T7, T8 |
| Stage tracking with progress vocabulary plus "processing" fallback | R2 | A1, A2 | T4, T5, T6 |
| rag-api persists worker values unchanged (processing/summary included) | R3 | A2, A3 | T1–T3 |
| retryable derivation aligned with ACK/NACK | R4 | A1, A2 | T1, T2, T6 |
| Contract test on worker→rag-api failure path with drift guard | R5, R8 | A4 | T1–T8 |
| No migration / no reader changes / no taxonomy | R6, R7; §5 | — | by construction (rag-api untouched) |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

- Run: afc18a5b-f04f-49c6-a9c7-4f3f856203ea · Iteration 1 · Step: design
- Binding scope: Definition `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c…`). See `docs/requirements.md` for requirements/acceptance; this document specifies the technical design that satisfies them.

## 1. Context

The upload→RAG flow runs: rag-api enqueues a Pub/Sub job → rag-worker's `run_worker` claims the resource (transactional claim plus lease) and executes `process_document` → the worker publishes status updates to the `rag-status-updates` topic via `_publish_status_update` → rag-api's subscriber (`_process_status_message`) applies each update to Firestore through `run_transactional_update`, writing the main resource document and the `processing/summary` subdocument.

The seam under repair is the *failed* status message: the worker's details dict and rag-api's failed-branch reads were written against different key sets, and no test covered the seam.

```
rag-worker process_document                      rag-api
  try: 6 pipeline steps, progress publishes
  except e:
    _publish_status_update("failed", details)    _process_status_message
      -> Pub/Sub rag-status-updates ----------->   run_transactional_update(db, doc_ref, "failed", details)
                                                     main doc:   error    <- details["error_message"]
                                                                 error_stage <- details["stage"]
                                                                 retryable   <- details["retryable"]
                                                     processing/summary:
                                                                 error{code, message, stage}; stage
```

## 2. Current behavior (broken)

- Worker handler (`rag-worker-service/main.py`, `process_document` except block): `await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)`.
- rag-api failed branch (`rag-api-service/main.py`, `run_transactional_update`):
  - main doc: `error = details.get("error_message", "Processing failed")`, `error_stage = details.get("stage")`, `retryable = details.get("retryable", True)`;
  - summary: `stage = details.get("stage", "unknown")`, `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`.
- Net effect per failure: `error="Processing failed"`, `error_stage=None`, `retryable=True`, summary `stage="unknown"`, `error.code="UNKNOWN"`.
- The failure handler has no stage tracking today (F9): `process_document` is one large try block, so at failure time nothing knows where it was.

## 3. Target design

Only `apps/ai-server/rag-worker-service/main.py` changes (plus tests). rag-api is untouched.

### 3.1 Failure payload builder (new, worker)

A module-level pure function next to `classify_error`:

```python
def build_failure_payload(exc: Exception, stage: Optional[str] = None) -> Dict[str, Any]:
    message = str(exc)
    return {
        "error": message,                 # legacy key — retained for unknown consumers of the topic (F11/R8)
        "error_message": message,         # contract key read by rag-api's failed branch
        "stage": stage or "processing",   # safe fallback, same value the stale-lease sweep uses
        "retryable": classify_error(exc), # deliberately derived; never defaulted
    }
```

The exception handler becomes:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", ..., error=str(e),
                      stage=stage, retryable=classify_error(e))   # log enrichment is a nicety, not a requirement
    await self._publish_status_update(user_id, course_id, resource_id, "failed",
                                      build_failure_payload(e, stage), job_id)
```

Notes:

- `_publish_status_update` mutates the passed details to add `jobId` (existing behavior, unchanged); the builder returns a fresh dict per call, so there is no shared-state issue. rag-api tolerates the extra key (it only `.get()`s known keys; `jobId` is only read on the processing branch).
- The builder never swallows or wraps exceptions; `classify_error` is pure.
- Degenerate edge: an exception with an empty message persists `error=""` — that is the actual message; it is not the `"Processing failed"` fabrication. Accepted.

### 3.2 Stage tracking (worker)

A local `stage` variable in `process_document`, assigned **immediately before each pipeline step's await**, holding the progress-vocabulary token of the stage that step belongs to (the token that step publishes on success). Initialized to `"starting"` as the first statement of the try block (so a validation failure reports `starting`).

| Pipeline work (interval) | Tracker value | Progress token published on success |
|---|---|---|
| `_validate_processing_request` + initial status publish | `starting` | `starting` |
| `_get_extracted_text` | `text_retrieved` | `text_retrieved` |
| `content_tagger.generate_tags` | `tagging_complete` | `tagging_complete` |
| `generate_document_summary` + `ragDescription` Firestore write + publish | `summary_generated` | `summary_generated` |
| `_create_enhanced_chunks` | `chunking_complete` | `chunking_complete` |
| `_generate_embeddings_with_openrouter` | `embeddings_complete` | `embeddings_complete` |
| `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, final publish, `_update_user_usage`, `_generate_resource_map` | `embeddings_complete` | (status `completed` — not a stage token) |

- The post-embeddings steps have no dedicated token in the failure vocabulary (the Definition's vocabulary excludes `completed` as a failure stage); they inherit `embeddings_complete`, which is accurate ("embeddings finished; the failure came after").
- **Fallback:** `build_failure_payload` maps a `None`/empty stage to `"processing"` — the same safe value the stale-lease sweep writes — so `error_stage` never regresses to null. Today the tracker is always initialized, so the fallback is defensive (e.g., against refactors that bypass it).
- **Decision record (stage semantics):** the tracker holds the *executing* stage's token, assigned before the step, rather than the *last completed* stage. Reporting the last completed stage would misattribute mid-step failures one stage early (a failure during embeddings would claim `chunking_complete`); reporting the executing stage matches the Definition's "the pipeline stage executing at failure time" and the "set the tracker immediately before the await" convention. The tokens are completion-tensed because that is the existing vocabulary (F9); this is a naming constraint, not a progress claim.
- **Drift risk and convention:** a future pipeline step added without updating the tracker reports a stale stage. Convention: *assign the tracker immediately before the step's await, using that step's completion token*. The contract test pins the mechanism on representative stages (early and late), which catches the tracker being removed or bypassed without ossifying every step.

### 3.3 retryable derivation (worker)

`retryable` comes from the existing `classify_error(e)` — the same classification that drives ACK/NACK in `run_worker`:

| Exception | classify_error | retryable persisted | Pub/Sub outcome (unchanged) |
|---|---|---|---|
| `TransientError` | transient | `true` | NACK, redelivered |
| `PermanentError` | permanent | `false` | acked; manual reprocess via `POST /process` |
| `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | transient | `true` | NACK, redelivered |
| `httpx.HTTPStatusError` with status in {429, 500, 502, 503, 504} | transient | `true` | NACK, redelivered |
| `httpx.HTTPStatusError` other 4xx/5xx | permanent | `false` | acked |
| unclassified-unknown (conservative default) | permanent | `false` | acked |

- **Deliberate behavior change:** unclassified-unknown exceptions previously persisted `retryable: true` (the API's silent default) and will now persist `false` — consistent with the worker actually acking them. Manual reprocess is unaffected. Widening `classify_error` is out of scope.
- The stale-lease sweep's direct write (`error` / `error_stage="processing"` / `retryable=True`) is unchanged and stays correct: a dead worker is a transient condition.

### 3.4 rag-api side (unchanged)

Zero code changes. Once the worker sends the aligned keys, the existing failed branch persists:

| Worker payload key | Main document field | `processing/summary` |
|---|---|---|
| `error_message` | `error` | `error.message` |
| `stage` | `error_stage` | `error.stage` (and top-level `stage` — previously always `"unknown"`) |
| `retryable` | `retryable` | — |
| `error_code` (deliberately unsent) | — | `error.code` = `"UNKNOWN"` (no taxonomy in this fix) |
| `progress` (unsent on failure, as today) | — | `progress` = 0 |
| `jobId` (added by `_publish_status_update`) | — | read only on the processing branch |

The API-side fallbacks (`"Processing failed"`, `retryable=True`) remain in code for non-worker producers but cease to be operative for worker failures (R3).

### 3.5 Compatibility hedge

Only rag-api's status subscriber is a verified consumer of these payloads; other services and tooling share the topic. The worker retains the legacy `error` key alongside `error_message` (R8) — one redundant string per failure message as insurance. If a later audit confirms rag-api is the only consumer, dropping the duplicate is trivial cleanup (and would mean updating the pinned contract test, which is the drift guard doing its job).

## 4. Pinned data contract

Worker failure payload `details` (exact key set, pinned by test):

```
error        : str   # == error_message (legacy, retained)
error_message: str   # actual exception message
stage        : str   # starting | text_retrieved | tagging_complete | summary_generated
                       | chunking_complete | embeddings_complete | processing (fallback)
retryable    : bool  # classify_error(exc): transient->True, permanent/unknown->False
jobId        : str   # added by _publish_status_update when a job_id exists; tolerated extra
```

Persisted failure schema (unchanged names/semantics, R6): main doc `error: str`, `error_stage: str`, `retryable: bool`; `Resource`/`ResourceResponse` expose them as today.

## 5. Contract test architecture

### 5.1 Placement and imports

- New file: `apps/ai-server/tests/integration/test_worker_failure_contract.py`, sibling of `test_api_contracts.py`, sharing `apps/ai-server/tests/integration/conftest.py` (house pattern: import the real modules rather than restating the contract in fixtures).
- rag-api side: already importable (`import main as rag_api_main`) via the existing conftest path insertion and mocks.
- Worker side: `rag-worker-service/main.py` cannot be imported as `main` (module-name collision with rag-api's cached `main`). The conftest gains a loader that (a) seeds the worker's known stub modules — mirroring `rag-worker-service/tests/conftest.py` (`langchain.text_splitter`, `langchain.schema`, `openai`, `langfuse`, `spacy`/`sklearn`, `tiktoken`, `tenacity` with identity `retry`, and the full dotted `google.cloud.*` names including `google.cloud.firestore_v1.base_query` with `FieldFilter`), skipping any module that is really importable — and (b) loads the worker's `main.py` via `importlib.util.spec_from_file_location` under the distinct name `rag_worker_main`, exposed as a fixture. Worker env defaults (`OPENROUTER_*`, `RAG_*`, `FIREBASE_*`, `WEAVIATE_SERVICE_URL`, …) are `os.environ.setdefault`-ed the same way the worker's conftest does.

### 5.2 Fake Firestore (hermetic; emulator not required)

`run_transactional_update` is exercised against a minimal in-memory fake (the Definition allows "the Firestore emulator or fakes"; fakes match the existing suite, which runs with no live services):

- Surface implemented: `db.document(path)`, `db.transaction()`, `doc_ref.get(transaction=…)`, `doc_ref.id`/`.path`, `doc_ref.collection("processing").document("summary")`, `transaction.get/update/set(merge=True)`; a dict-backed store for main docs and subcollections; a seeding helper.
- `firebase_admin.firestore.transactional` is patched to a pass-through decorator and `SERVER_TIMESTAMP` to a sentinel (both on the same mocked module object rag-api's `from firebase_admin import firestore` bound to; MagicMock child access is memoized, so the patch is visible to `rag_api_main`).
- **Explicitly not under test:** transaction atomicity/semantics (production behavior, unchanged), real Pub/Sub delivery, the emulator. The contract under test is payload keys → persisted fields.

### 5.3 Worker-side harness

`process_document` is driven on a processor built via `EnhancedDocumentProcessor.__new__` with injected doubles for exactly the collaborators it touches: `langfuse=None`, `db` (MagicMock), `logger`, `content_tagger` (stub), `embedding_cost_per_token` (float), and monkeypatched step methods (`_validate_processing_request`, `_publish_status_update` → async capture list, `_get_extracted_text`, `generate_document_summary` → `None`, `_get_document_path`, `_create_enhanced_chunks`, `_generate_embeddings_with_openrouter`, …). This runs the real try/except handler, the real stage tracker, and the real `build_failure_payload` — no config/env coupling, no network, no Pub/Sub.

### 5.4 Test matrix

| ID | Test | Asserts |
|---|---|---|
| T1 | Round-trip, transient: `build_failure_payload(TransientError("…"), "chunking_complete")` fed to `run_transactional_update` on a seeded (`status="processing"`) fake doc | main doc `error` == message, `error_stage` == `"chunking_complete"`, `retryable is True`, `status=="failed"`; summary `error.message`/`error.stage` equal, `error.code=="UNKNOWN"`, top-level `stage` == failing stage |
| T2 | Round-trip, permanent: `ValueError("…")` payload through the failed branch | `retryable is False` end-to-end |
| T3 | Fallback absence | persisted `error != "Processing failed"`, `error_stage is not None`, `retryable` equals the derived bool (guards regression to silent defaults) |
| T4 | Stage tracking, early: `_get_extracted_text` raises | captured failed payload: `stage=="text_retrieved"`, `error_message` == actual message, `retryable` derived |
| T5 | Stage tracking, late: `_generate_embeddings_with_openrouter` raises | captured failed payload: `stage=="embeddings_complete"` |
| T6 | Unknown stage + derivation mapping | `build_failure_payload(e, None)` yields `stage=="processing"`; classify mapping table (§3.3) spot-checked (transient types → True, `ValueError`/unknown → False, HTTP 429/500 → True, other 4xx → False) |
| T7 | Static key-set drift guard (in-process `ast.parse` of both sources — house pattern) | worker failure-payload keys == {error, error_message, stage, retryable}; rag-api failed-branch `details.get(...)` read keys ⊇ {error_message, stage, retryable} and ⊆ worker keys; `error_code` read tolerated (deliberately unsent) |
| T8 | Legacy key pinned | `"error"` present in the payload and equal to `error_message` (R8) |
| T9 (optional) | Subscriber path: `_process_status_message` with a fake Pub/Sub message and fake `app_state.db` | end-to-end json → details → persistence → `message.ack()` |

### 5.5 Drift-failure semantics

- Worker renames/removes a key → rag-api's fallbacks activate → T1–T3 fail on value assertions; T7 fails statically.
- rag-api changes its reads → T7 fails statically; value assertions catch semantic changes.
- Stage tracker removed/bypassed → T4/T5 fail (missing or wrong `stage`).

## 6. Edge cases

- `_publish_status_update` failing inside the failure handler: it catches and logs `status_publish_failed` without raising (unchanged) — the handler still completes.
- Empty exception message: persists `error=""` (the actual message), never the fabricated fallback (§3.1).
- Sequence counter: `_publish_status_update` resets per-resource sequence on terminal states (`completed`/`failed`) — unchanged.
- Pre-existing quirk, out of scope: `_update_user_usage`/`_generate_resource_map` run inside the try after the `completed` publish; a failure there publishes `failed` with stage `embeddings_complete` — accurate under the tracker semantics.

## 7. Decision records

1. **Worker aligns to the API** (not vice versa): the persisted `error`/`error_stage`/`retryable` schema is already consistent across three write paths and two models; changing the API side would ripple. No migration, no reader changes.
2. **Stage token = executing step's completion token, assigned before the step's await**; rejected alternative (last-published stage) misattributes mid-step failures; see §3.2 decision record.
3. **retryable from `classify_error`**, accepting the unknown→`false` behavior change as intended conservatism (§3.3).
4. **Legacy `error` key retained** as a cheap hedge (§3.5).
5. **Fakes over the emulator** for the contract test: hermetic, matches the existing suite; transaction atomicity explicitly out of the test's scope (§5.2).
6. **Worker imported under a distinct module name** (`rag_worker_main` via importlib) to avoid the `main.py` collision with rag-api in the shared test process (§5.1).

## 8. Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the assign-before-await convention and representative-stage test coverage (T4/T5).
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope; manual reprocess remains.
- **The contract test ossifies the payload** — intentional; adding a key later means touching the test, which is the drift guard working.

## 9. Rollout and operational impact

- No new env vars, no config changes, no Firestore migration/backfill, no rag-api deploy dependency (worker and api may deploy independently; the fix is worker-side only and backward-compatible with the current rag-api).
- Observability: failure log event optionally gains `stage`/`retryable` fields; persisted documents immediately carry truthful `error`/`error_stage`/`retryable`; summary `stage` stops being `"unknown"` for worker failures.
- Verification: run `pytest apps/ai-server/tests/integration/test_worker_failure_contract.py` plus the existing suite to confirm no regressions.

## 10. Deferred / future work

- Consumer audit of the status topic; if rag-api is the sole consumer, drop the legacy `error` key (and update the pinned test).
- The companion D3 issue (content unavailable here) and reconciliation with the D4 deviation note in `plans/upload-flow.md` (file absent from the tree).
- Optional: a structured error-code taxonomy (`error.code` beyond `"UNKNOWN"`) — explicitly not in this fix.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>