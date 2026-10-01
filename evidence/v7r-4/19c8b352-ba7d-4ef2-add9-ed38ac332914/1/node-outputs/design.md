Design complete. Both artifacts below are derived exclusively from the authoritative Definition (WorkItem `wi-define-108-a8`) and the repository evidence verified during investigation: rag-api's `run_transactional_update` failed branch and `_process_status_message` envelope, the `Resource` model's `error`/`error_stage`/`retryable` fields, the enqueue-failure write paths, the `FIRESTORE_EMULATOR_HOST` startup branch, the `tests/integration/conftest.py` mock harness, and the fixture/AST contract-test patterns in `test_api_contracts.py`. Worker-side internals follow the Definition's integrity-pinned facts (F3, F5–F9).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api Failure Payload Contract Alignment

- **Cycle intent:** rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage
- **Authoritative source:** WorkItem `wi-define-108-a8`, Definition artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`)
- **Status:** Designed (iteration 1, step: design)

---

## 1. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's **actual error message**, the **failing pipeline stage**, and a **deliberately derived retryable flag** — locked in by a contract test on the worker → rag-api failure path.

## 2. Problem (verified)

The worker's exception handler in `process_document` publishes a one-key failure payload (`details = {"error": str(e)}`) via `_publish_status_update`. rag-api's failed branch in `run_transactional_update` reads three keys — `error_message`, `stage`, `retryable` — and persists them as `error`, `error_stage`, and `retryable` on the main resource document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument.

Because of the key mismatch, every worker-originated failure currently persists:

| Persisted field | Value today | Why |
|---|---|---|
| `error` | `"Processing failed"` | rag-api fallback for missing `error_message` |
| `error_stage` | `None` | rag-api reads `details.get("stage")` — absent |
| `retryable` | `True` | rag-api silent default `details.get("retryable", True)` |

The `processing/summary` error subdocument inherits the same fallbacks, with `error.code` always `"UNKNOWN"`.

The `error`/`error_stage`/`retryable` schema is already established by three other write paths and both response surfaces: the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths (`POST /process`, `POST /resources`, both writing `error_stage: "enqueue"` directly), and the `Resource` model / `ResourceResponse` (retryable defaults `True`). The worker's status publisher is the only writer that does not speak this schema.

## 3. Fix Direction (binding)

**The worker aligns to rag-api's existing contract** — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or the persisted schema. Rationale: the persisted field names are already consistent across three write paths and two API response models; changing the API side would ripple. This direction requires no Firestore migration, no field rename, and no backfill.

## 4. Definitions and Vocabulary

### 4.1 Status message envelope (unchanged)
Worker → rag-api status messages on Pub/Sub topic `rag-status-updates` carry the envelope keys rag-api's `_process_status_message` already reads: `user_id`, `course_id`, `resource_id`, `status`, `details`. This fix changes only the contents of `details` on `status = "failed"` messages.

### 4.2 Failure details contract (to-be, worker → rag-api)

| Key | Content | Required |
|---|---|---|
| `error_message` | The actual exception message (`str(e)`) | Yes — never absent |
| `stage` | Pipeline stage executing at failure time (vocabulary in 4.3) | Yes — never absent |
| `retryable` | Deliberately derived boolean (rule in 5.FR-4) | Yes — never absent |
| `error` | Legacy duplicate of `error_message`, retained for continuity with any unknown consumers of the status topic and existing log tooling | Yes (preferred retained) |

### 4.3 Stage vocabulary (failure values)
Reuses the existing progress-update stage names, with a safe fallback:

| Token | Pipeline step it labels |
|---|---|
| `starting` | Job pickup / initial setup |
| `text_retrieved` | Text extraction |
| `tagging_complete` | Content tagging |
| `summary_generated` | Summary generation |
| `chunking_complete` | Chunking |
| `embeddings_complete` | Embedding generation |
| `processing` | Safe value when the stage is genuinely unknown (same value the stale-lease sweep uses for `error_stage`) |

`completed` is a terminal success status and is never a failure stage value.

### 4.4 Persisted fields (unchanged names and semantics)
Main resource document: `error` (string), `error_stage` (string), `retryable` (bool, model default `True`). `processing/summary` subdocument: `error.code`, `error.message`, `error.stage`.

## 5. Functional Requirements

### FR-1 — Failure payload keys (worker)
When document processing fails, the worker's failed status payload `details` **must** include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload **must never** rely on rag-api's fallback defaults for these keys — i.e., all three keys are present and populated on every worker-originated failure.

*Traceability: Definition requirement 1; facts F1, F3, F5; acceptance A1.*

### FR-2 — Stage tracking (worker)
The worker **must** track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names **must** reuse the existing progress-stage vocabulary (Section 4.3), with `"processing"` as the safe value when the stage is genuinely unknown (e.g., failure before the first stage transition). The field must never regress to `None`.

*Traceability: Definition requirement 2; facts F9, F6; acceptance A1, A2.*

### FR-3 — Passthrough persistence (rag-api, unchanged behavior)
rag-api's failed branch **must** persist the worker-provided values unchanged:
- main document `error` ← payload `error_message`
- main document `error_stage` ← payload `stage`
- main document `retryable` ← payload `retryable`
- `processing/summary` error subdocument `message` ← same message as the main document; `stage` ← same stage as the main document.

No read-side or schema change is required on rag-api: its failed branch already implements exactly this mapping when the keys are present. This requirement is satisfied by the worker sending the keys and is pinned by FR-5.

*Traceability: Definition requirement 3; fact F4; acceptance A2, A3.*

### FR-4 — Deliberate retryable derivation (worker)
The retryable derivation **must** be explicit and aligned with the worker's existing ACK/NACK behavior via `classify_error(e)`:
- errors classified **transient** → `retryable: true` (Pub/Sub will redeliver; the record tells the truth);
- errors classified **permanent** — including unclassified-unknown exceptions, per `classify_error`'s conservative default — → `retryable: false` (acked, no redelivery; manual reprocess via `POST /process` remains available).

The API-side `details.get("retryable", True)` fallback **must not** be the operative mechanism for worker failures.

*Traceability: Definition requirement 4; facts F7, F8; acceptance A1, A2.*

### FR-5 — Contract test on the failure path
A contract test **must** cover the worker failure → rag-api persistence path. It **must**:
- exercise the worker's failure-payload construction (through the worker's own code path, not a restated fixture);
- feed the produced `details` through rag-api's failed-branch persistence (`run_transactional_update`) via the Firestore emulator or fakes;
- assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values;
- **fail if either side's payload keys drift** (key-set drift guard on the worker's failure details; sentinel-value equality on the API side so any fallback default triggers failure).

*Traceability: Definition requirement 5; facts F10, F4; acceptance A4.*

## 6. Behavioral Rules

- **BR-1 (legacy key):** The worker retains the legacy `error` key in failure `details`, with the same value as `error_message`, as a compatibility hedge for unknown consumers of the status topic. (Prefer-constraint; dropping it later is trivial cleanup after a consumer audit.)
- **BR-2 (no migration):** No Firestore migration, field rename, or backfill of existing documents. Persisted fields keep their names and semantics.
- **BR-3 (no error-code taxonomy):** No structured error codes are introduced. `processing/summary` `error.code` remains `"UNKNOWN"` because the worker does not send `error_code` in this scope.
- **BR-4 (stale-lease sweep unchanged):** The sweep's direct failure write (`error`/`error_stage="processing"`/`retryable=true`) stays as-is; a dead worker is a transient condition, so its `retryable=true` remains correct.
- **BR-5 (retry mechanics unchanged):** Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals are untouched — only the *reporting* of retryability in the payload changes.
- **BR-6 (deliberate behavior change, accepted):** Unclassified-unknown exceptions currently persist `retryable: true` (silent default) but classify as permanent; after this fix they persist `retryable: false`. This is `classify_error`'s intended conservatism (prevents infinite retry loops); manual reprocess via `POST /process` is unaffected.

## 7. Constraints

| Type | Constraint |
|---|---|
| must | Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema. |
| must_not | No Firestore migration, field rename, or backfill of existing documents; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. |
| must | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side fallback must not be operative for worker failures. |
| prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| prefer_not | Do not introduce a structured error-code taxonomy. |

## 8. Non-Goals

- Changing the stale-lease sweep's direct failure write (already contract-consistent).
- Changing retry/backoff mechanics: ACK/NACK policy, leases, heartbeats — only the reporting of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — `error.code` stays `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker → rag-api failure payload alignment (its content is unavailable in this context; deferred).

## 9. Acceptance Criteria

| # | Criterion | Verified by |
|---|---|---|
| A1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | FR-1, FR-2, FR-4; contract test CT-1/CT-2/CT-4 |
| A2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | FR-3; contract test CT-1/CT-2/CT-3 |
| A3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | FR-3; contract test CT-5 |
| A4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | FR-5; test suite green |

## 10. Traceability Matrix

| Requirement | Definition requirement | Supporting facts | Acceptance | Primary verification |
|---|---|---|---|---|
| FR-1 | req 1 | F1, F3, F5 | A1 | Contract test (payload keys present) |
| FR-2 | req 2 | F9, F6 | A1, A2 | Contract test (early/late/unknown stage) |
| FR-3 | req 3 | F4 | A2, A3 | Contract test (persistence equality) |
| FR-4 | req 4 | F7, F8 | A1, A2 | Contract test (true and false cases) |
| FR-5 | req 5 | F10, F4 | A4 | Contract test existence + green |

Fact index: F1 product intent (persist message/stage/retryable) · F2 preferred direction (align worker) · F3 worker publishes `{"error": str(e)}` · F4 rag-api failed-branch reads/persists · F5 fallback persistence today · F6 established persisted schema · F7 `classify_error` semantics · F8 adopted retryable derivation (assumed, ratified here) · F9 stage vocabulary, no failure-stage tracking today · F10 contract-test infrastructure exists · F11 legacy-key hedge (assumed, ratified here) · F12 companion D3 issue deferred.

## 11. Deferred Items

- The companion D3 issue referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker → rag-api failure payload alignment is out of scope.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`: that file is not present in the current tree; the reference comes from the Objective text only.
- Dropping the legacy `error` key from the worker payload, pending a consumer audit of the status topic.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api Failure Payload Contract Alignment

- **Cycle intent:** rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage
- **Implements:** docs/requirements.md (FR-1 … FR-5)
- **Scope of change:** one production file (`apps/ai-server/rag-worker-service/main.py`) plus one new contract test module under `apps/ai-server/tests/integration/`. rag-api production code is unchanged; it is the reference consumer pinned by the test.

---

## 1. Overview

The worker and rag-api communicate job outcomes over the Pub/Sub status topic (`rag-status-updates`, subscription `rag-status-updates-sub`). rag-api's subscriber (`_process_status_message`) routes `details` into `run_transactional_update`, whose failed branch reads `error_message`/`stage`/`retryable` and persists them as `error`/`error_stage`/`retryable` on the main resource document and into the `processing/summary` error subdocument. The worker's exception handler publishes only `{"error": str(e)}`, so every worker-originated failure persists fallbacks. This design makes the worker speak the API's existing contract, derives `retryable` from the classification the worker already computes, tracks the failing stage, and locks the seam with a contract test.

## 2. System Context (verified components)

```
+----------------------------------------------------+
| rag-worker-service  (apps/ai-server/rag-worker-    |
|                      service/main.py)              |
|   process_document                                 |
|     current_stage   <-- NEW: local stage tracker   |
|     except <e>:                                    |
|       classification = classify_error(e)  (exists) |
|       retryable     <-- NEW: derived, explicit     |
|       _publish_status_update(status="failed",      |
|           details={ error_message, stage,          |
|                     retryable, error (legacy) })   |
+-----------------------+----------------------------+
                        | publish (envelope: user_id,
                        | course_id, resource_id,
                        | status, details)
                        v
             Pub/Sub topic "rag-status-updates"
                        | subscription "rag-status-updates-sub"
                        v
+----------------------------------------------------+
| rag-api-service  (apps/ai-server/rag-api-service/  |
|                   main.py)  -- UNCHANGED           |
|   _process_status_message                          |
|     └> run_transactional_update                    |
|          state machine: processing -> failed       |
|          failed branch (existing reads):           |
|            main:  error      <- details[error_message]
|                   error_stage<- details[stage]     |
|                   retryable  <- details[retryable] |
|            processing/summary (merge):             |
|              stage <- details[stage]               |
|              error { code: details[error_code]     |
|                              default "UNKNOWN",    |
|                      message: details[error_message],
|                      stage:   details[stage] }     |
+-----------------------+----------------------------+
                        v
        Firestore users/{uid}/resources/{rid}
          + subcollection processing/summary
```

Other writers to the same persisted schema (unchanged, for context): the worker's stale-lease sweep `_fail_if_still_stale` (writes `error`/`error_stage="processing"`/`retryable=true` directly) and rag-api's enqueue-failure paths in `POST /process` and `POST /resources` (write `error`/`error_stage="enqueue"` directly).

## 3. As-Is vs To-Be Contract

### 3.1 As-is (broken)
Worker failure details: `{"error": str(e)}`. rag-api failed branch reads `error_message` (fallback `"Processing failed"`), `stage` (no fallback → `None`), `retryable` (fallback `True`). Result: every worker failure persists fallbacks; `summary.error.code` is always `"UNKNOWN"`.

### 3.2 To-be
Worker failure details: `{error_message, stage, retryable, error}` where `error` duplicates `error_message` (legacy hedge). rag-api's failed branch is unchanged; with the keys present it persists:

| Payload key | Main document field | `processing/summary` field |
|---|---|---|
| `error_message` | `error` | `error.message` |
| `stage` | `error_stage` | `error.stage` (and top-level `stage`) |
| `retryable` | `retryable` | — |
| `error` (legacy) | ignored by rag-api | ignored by rag-api |
| `error_code` | — (not sent by worker) | `error.code` = `"UNKNOWN"` (default) |

The state-machine precondition is unchanged: the failed branch persists only on a legal `processing → failed` transition (a repeated `failed → failed` message is a no-op, preserving idempotency).

## 4. Worker-Side Design

### 4.1 Stage tracker
`process_document` is one large `try` block; today nothing knows where failure occurred. Add a local stage tracker:

- A local variable (e.g., `current_stage`) initialized at function entry to `"starting"`.
- **Convention: set the tracker immediately before each awaited pipeline step**, using the progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. Because the assignment precedes the await, the tracker at exception time names the step whose execution failed.
- The exception handler reports `stage = current_stage`; if the tracker is somehow unset/empty (failure before the first transition), the safe value is `"processing"` — the same value the stale-lease sweep uses for `error_stage`, so `error_stage` never regresses to `None`.
- Drift risk (a future pipeline step added without updating the tracker) is mitigated by the update-before-await convention and by representative-stage contract tests (an early-stage and a late-stage failure), which catch the tracker being removed or bypassed without ossifying every step.

### 4.2 Failure payload construction
In `process_document`'s exception handler, replace the one-key payload with the full contract via the existing `_publish_status_update` helper:

```
details = {
    "error_message": str(e),        # actual exception message
    "stage": current_stage,         # tracker value, or "processing" if unknown
    "retryable": <derived per 4.3>, # explicit, never defaulted
    "error": str(e),                # legacy key retained (BR-1)
}
```

The envelope (`user_id`, `course_id`, `resource_id`, `status="failed"`) is unchanged.

### 4.3 retryable derivation
Derive from the classification the worker already computes for ACK/NACK decisions:

| `classify_error(e)` outcome | `retryable` | Worker ACK/NACK behavior | Persisted record tells the truth because |
|---|---|---|---|
| transient | `true` | NACK → Pub/Sub redelivers | record matches actual retry behavior |
| permanent (type- and status-code heuristics) | `false` | ACK → no redelivery; manual reprocess via `POST /process` | record matches actual behavior |
| unclassified-unknown (conservative default) | `false` | ACK | deliberate behavior change (BR-6); prevents fabricated auto-retry affordance |

The derivation is computed once in the exception handler. `run_worker`'s existing ACK/NACK logic is not refactored (BR-5) — it already calls `classify_error` independently.

### 4.4 Explicitly unchanged
- `_fail_if_still_stale` (stale-lease sweep): its direct write already matches the contract; a dead worker is transient, so `retryable=true` stays correct.
- Pub/Sub ACK/NACK policy, leases, heartbeats.
- rag-api's failed branch, `Resource` model, `ResourceResponse`, and all enqueue-failure paths.

## 5. rag-api-Side Design

No production change. The failed branch of `run_transactional_update` already implements FR-3 exactly when the keys are present; it is designated the **reference consumer**. Its fallbacks (`"Processing failed"`, `None`, `True`) remain in place for non-worker publishers but must never be operative for worker failures (FR-1) — a property the contract test enforces by using sentinel values that cannot collide with any fallback.

## 6. Contract Test Architecture

### 6.1 Location and harness
- New module in `apps/ai-server/tests/integration/`, alongside `test_api_contracts.py`, reusing its house patterns (direct imports of `rag-api` `main`, fixture/AST static checks where appropriate) and `conftest.py`, which already stubs `firebase_admin`/`google.cloud.*`/`structlog` and puts `rag-api-service` on `sys.path`.
- Both services support hermetic Firestore-emulator mode (`FIRESTORE_EMULATOR_HOST` branch in rag-api's `startup()`, project id from `GCP_PROJECT`, default `demo-project`).

Two supported harness modes:
1. **Fakes (default, fully hermetic):** install a minimal fake Firestore surface before importing rag-api `main` — `firestore.transactional` as an identity decorator, `SERVER_TIMESTAMP` as a sentinel, a fake `db.transaction()`, a fake `doc_ref` whose `get(transaction=...)` returns a snapshot with `status: "processing"`, and capturing `transaction.update` / `transaction.set` calls for assertion.
2. **Firestore emulator:** run against the real emulator via the verified startup branch when an integration-grade run is desired.

### 6.2 Principle: import both sides, restate nothing
The test builds the failure payload **through the worker's code path** (drive `process_document` with pipeline dependencies mocked to raise at the target stage; capture the payload handed to `_publish_status_update`), then feeds the captured `details` **verbatim** into rag-api's `run_transactional_update`. No fixture restates the contract, so a drift on either side breaks the test rather than silently re-creating the bug.

### 6.3 Sentinel values
Use distinctive per-run sentinels (e.g., `error_message = "sentinel-error-<uuid>"`, real stage tokens, and both `retryable` polarities). Any rag-api fallback (`"Processing failed"`, `None`, `True`) fails the equality assertions — this is the API-side drift detector.

### 6.4 Test matrix

| ID | Scenario | Seed status | Exception | Asserts |
|---|---|---|---|---|
| CT-1 | Early-stage transient failure | `processing` | transient-classified, raised at/after `starting` | persisted `error` == message; `error_stage` == stage token; `retryable == true` |
| CT-2 | Late-stage permanent failure | `processing` | permanent-classified, raised at a late stage (e.g., `chunking_complete`) | same equality; `retryable == false` |
| CT-3 | Unknown-stage fallback | `processing` | failure before first tracker assignment | `error_stage == "processing"` (never `None`) |
| CT-4 | Worker payload key-set drift guard | — | — | worker failure `details` key set == `{error_message, stage, retryable, error}` exactly; additions/removals fail the build |
| CT-5 | Summary parity | `processing` | any | `summary.error.message` == main `error`; `summary.error.stage` == main `error_stage`; `summary.error.code == "UNKNOWN"` |
| CT-6 (optional) | Legacy-payload tripwire | `processing` | — | feeding the old shape `{"error": ...}` yields fallback persistence — documents why the contract exists and pins rag-api's fallback behavior |

### 6.5 Drift-guard semantics
- **Worker side:** CT-4 pins the exact key set; any edit to the payload keys must touch the test — intentional (the drift guard doing its job).
- **API side:** sentinel equality (6.3) detects any change to the keys the failed branch reads; CT-6 optionally pins the fallback behavior itself.

## 7. Failure Sequence (to-be)

1. Worker `process_document` step N raises `e`; `current_stage` holds step N's token.
2. Exception handler: `classification = classify_error(e)`; `retryable` derived (transient → `true`, permanent/unknown → `false`).
3. `_publish_status_update(status="failed", details={error_message, stage, retryable, error})` → Pub/Sub `rag-status-updates`.
4. rag-api `_process_status_message` resolves the canonical document path and calls `run_transactional_update` (threaded, as today).
5. State machine accepts `processing → failed`; transaction writes main doc `{status: "failed", error, error_stage, retryable, ...}` and merges `processing/summary` with `error {code: "UNKNOWN", message, stage}`.
6. Message acked. Manual recovery path unchanged: `failed → queued` is a legal transition; `POST /process` re-enqueues.

## 8. Compatibility and Rollout

- **No migration:** persisted field names and semantics unchanged (must-not constraint).
- **Legacy key hedge:** the redundant `error` key costs one duplicate string per failure message and keeps any unknown consumer of the status topic working (only rag-api's subscriber is a verified consumer). Dropping it later is trivial cleanup after a consumer audit.
- **Behavior change (deliberate):** unclassified-unknown failures flip from persisted `retryable: true` (silent default) to `false` (conservative classification). Manual reprocess via `POST /process` is unaffected; the sweep's `retryable=true` write is unaffected.
- **Idempotency:** repeated failed-status messages remain no-ops via the existing same-status guard.

## 9. Risks and Tradeoffs

| Risk | Mitigation | Disposition |
|---|---|---|
| Unknown consumers of the status topic reading the old key set | Legacy `error` key retained | Residual risk accepted as low |
| Stage-tracker drift as the pipeline evolves | Update-before-await convention; representative-stage tests (CT-1/CT-2) | Accepted; convention documented in code |
| `retryable=false` for genuinely transient-but-unrecognized failures | Manual reprocess via `POST /process`; widening `classify_error` is out of scope | Accepted |
| Contract test ossifies the payload | Intentional — it is the drift guard; adding a key means touching the test | Accepted by design |

## 10. File Touch List

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Stage tracker in `process_document`; failure payload `{error_message, stage, retryable, error}`; retryable derived from `classify_error` |
| `apps/ai-server/tests/integration/` (new module) | Contract tests CT-1…CT-5 (+ optional CT-6); conftest support for the fake Firestore surface if needed |
| `apps/ai-server/rag-api-service/main.py` | **No change** — failed branch is the pinned reference consumer |
| `apps/ai-server/rag-api-service/models/resource.py` | No change |
| Stale-lease sweep, Pub/Sub retry config, frontends | No change (non-goals) |

## 11. Requirements Traceability

| Requirement | Architecture element |
|---|---|
| FR-1 (payload keys) | §4.2 payload construction; CT-4 key-set guard |
| FR-2 (stage tracking) | §4.1 stage tracker + vocabulary; CT-1/CT-2/CT-3 |
| FR-3 (passthrough persistence) | §5 reference consumer; §3.2 mapping table; CT-1/CT-2/CT-5 |
| FR-4 (retryable derivation) | §4.3 derivation table; CT-1 (true) / CT-2 (false) |
| FR-5 (contract test) | §6 test architecture |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>