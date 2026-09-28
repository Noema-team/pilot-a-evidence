<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- WorkItem: `wi-define-108-a8` (authoritative artifact `definition:obj-108`, sha256 `71f1c39c…`)
- Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- Step: design (requirements + architecture) · Status of this document: binding scope for the implementation cycle

## 1. Objective

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's **actual error message**, the **failing pipeline stage**, and a **deliberately derived retryable flag** — locked in by a contract test on the worker→rag-api failure path.

## 2. Problem statement (verified repository facts)

- **Producer side.** The worker's exception handler in `process_document` (`apps/ai-server/rag-worker-service/main.py`) publishes failed status with `details = {"error": str(e)}` via `_publish_status_update`.
- **Consumer side.** rag-api's failed branch in `run_transactional_update` (`apps/ai-server/rag-api-service/main.py`) reads three detail keys and persists them:
  - main document: `error ← details.error_message` (fallback `"Processing failed"`), `error_stage ← details.stage` (fallback `None`), `retryable ← details.retryable` (fallback `True`);
  - `processing/summary` subdocument: `error = {code: details.error_code | default "UNKNOWN", message: details.error_message | fallback, stage: details.stage}`.
- **Consequence.** Because of the key mismatch, every worker-originated failure currently persists `error = "Processing failed"`, `error_stage = None`, and `retryable = True` (silent default). The summary error subdocument inherits the same fallbacks with `code` always `"UNKNOWN"`.
- **The schema is already established elsewhere.** `error` / `error_stage` / `retryable` are written directly by the worker's stale-lease sweep (`_fail_if_still_stale`, which writes `retryable: True` — pinned by `rag-worker-service/tests/unit/test_processing_lease.py`) and by rag-api's enqueue-failure paths (e.g. the `POST /process` rollback writes `error` / `error_stage: "enqueue"`). `models/resource.py` carries all three on `Resource` (`retryable` defaults `True`), and `ResourceResponse` exposes `error` and `error_stage` to clients.
- **The worker already knows retryability.** `classify_error()` classifies every exception as transient or permanent (TransientError/PermanentError plus type- and status-code heuristics; unknown exceptions classify as permanent) and that classification drives ACK/NACK in `run_worker` — but the failure payload does not report it.
- **No stage tracking exists.** `process_document` publishes named progress stages (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`), but the failure handler has no stage tracking today, so the failing stage cannot be reported at failure time.
- **Contract-test infrastructure exists.** `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests), hermetic Firestore-emulator branches in both services (`FIRESTORE_EMULATOR_HOST`), and established cloud-SDK stub regimes in both test conftests make the worker→rag-api failure-path contract test implementable with existing patterns (F10).
- **Consumer hedge.** Only rag-api's status subscriber is a verified consumer of the worker's status payloads; the topic may have other readers. The worker retains the legacy `error` key alongside `error_message` as a compatibility hedge (F11).

## 3. Constraints (binding)

| # | Type | Constraint |
|---|------|------------|
| C1 | must | Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema. |
| C2 | must_not | No Firestore migration, field rename, or backfill; persisted fields `error`/`error_stage`/`retryable` keep names and semantics. |
| C3 | must | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| C4 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| C5 | prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values). |

## 4. Functional requirements

- **FR-1 — Failure payload completeness.** When document processing fails, the worker's failed status payload includes `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). None of these keys may be absent: the payload must never rely on rag-api's fallback defaults.
- **FR-2 — Stage tracking.** The worker tracks the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`); `"processing"` is the safe value when the stage is genuinely unknown (the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null).
- **FR-3 — rag-api persistence unchanged.** rag-api's failed branch persists worker-provided values unchanged: main document `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`; the `processing/summary` error subdocument carries the same message and stage (`code` remains `"UNKNOWN"` unless a code is actually sent). This is existing behavior — it must be preserved and pinned, not reimplemented.
- **FR-4 — retryable derivation.** Explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error(e)` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
- **FR-5 — Legacy key hedge.** The worker's failure payload retains `error` (same value as `error_message`) for continuity with any existing consumers of the status topic and log tooling.
- **FR-6 — Contract test.** A contract test covers the worker failure → rag-api persistence path: it exercises the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must fail if either side's payload keys drift.

## 5. Accepted behavior change

Unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent; after this fix they persist `retryable: false`. Accepted per the adopted default (F8): it prevents infinite retry loops and makes the persisted record match the worker's actual ACK behavior; manual reprocess via `POST /process` is unaffected. The stale-lease sweep's direct `retryable: true` write is unchanged and remains correct — a dead worker is a transient condition by nature.

## 6. Non-goals

- Changing the stale-lease sweep's direct failure write (already persists `error`/`error_stage`/`retryable` consistently with this contract).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here; deferred), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (that file is not present in the current tree — the reference comes from the Objective text).

## 7. Acceptance criteria

1. **AC-1:** A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
2. **AC-2:** After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value.
3. **AC-3:** The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
4. **AC-4:** A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift.

## 8. Open items / unknowns

- The companion D3 issue's content is unavailable in this context; anything beyond this alignment is deferred (F12).
- `plans/upload-flow.md` is not present in the current tree; the D4 reference exists only in the Objective text. Reconciliation deferred.
- Non-rag-api consumers of the status topic are unverified; the `error` hedge (FR-5) covers them without an audit. A later audit may drop the duplicate key as trivial cleanup.

<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload alignment

## 1. Direction

The worker is the odd writer out. Three other write paths — the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's `POST /process` enqueue-failure rollback, and rag-api's `POST /resources` enqueue-failure path — plus two response surfaces (`Resource` model, `ResourceResponse`) already speak `error`/`error_stage`/`retryable`. The worker's status publisher is the only writer that doesn't. Fix the worker; rag-api's failed branch and the persisted schema are untouched. No migration, no backfill, no reader changes (C1, C2).

## 2. The seam contract

Worker failure payload (status `"failed"`, `details` object):

| Payload key | Value | rag-api persists to | Today's operative fallback |
|---|---|---|---|
| `error_message` | `str(e)` — actual exception message | main `error`; summary `error.message` | `"Processing failed"` |
| `stage` | failing pipeline stage (tracker) | main `error_stage`; summary `error.stage`; summary `stage` | `None` / `"unknown"` |
| `retryable` | derived from `classify_error(e)` | main `retryable` | silent `True` |
| `error` | `str(e)` (legacy hedge, FR-5) | not read by rag-api | n/a |
| `error_code` | not sent (C5) | summary `error.code` | `"UNKNOWN"` |

rag-api's failed branch (`run_transactional_update`) is unchanged: it already reads `error_message`/`stage`/`retryable`, persists `error`/`error_stage`/`retryable` on the main document, and writes `message`/`stage` (code default `"UNKNOWN"`) into `processing/summary.error`. With FR-1 satisfied, the fallbacks become dead paths for worker-originated failures but remain in place for robustness.

## 3. Worker changes (`rag-worker-service/main.py`)

### 3.1 Stage tracker
- A local `current_stage` in `process_document`, initialized to `"processing"` (the safe unknown value; matches the sweep's `error_stage`).
- Set immediately **before** each pipeline step (set-before-await convention) to the matching progress-stage name: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. `completed` is the success terminal, never a failure stage.
- The exception handler reads the tracker; no new stage names are invented (FR-2).
- Drift rule: a future pipeline step must set the tracker immediately before its await. The contract test pins the mechanism on representative stages (an early-stage and a late-stage failure), which catches the tracker being removed or bypassed without ossifying every step.

### 3.2 retryable derivation
- The exception handler calls the worker's existing classifier — `classify_error(e)`, the same entry point `run_worker` uses for ACK/NACK (F7) — and maps: transient → `True`; permanent, including unclassified-unknown → `False` (FR-4, F8).
- One source of truth: the persisted `retryable` and the ACK/NACK decision can no longer diverge. (`PDFProcessingError.retryable` in `exceptions.py` is metadata on the exception hierarchy; per the adopted default the payload value comes from `classify_error`, not from that attribute.)
- Deliberate behavior change: unclassified-unknown failures flip from persisted `True` (silent default) to `False` — the classifier's conservatism, accepted per requirements §5.

### 3.3 Failure payload construction
- Centralize in one helper so the contract test exercises exactly the production code path:

```python
def _build_failure_details(e: Exception, stage: str) -> dict:
    return {
        "error_message": str(e),
        "stage": stage,
        "retryable": <classify_error(e) == transient>,  # per 3.2
        "error": str(e),  # legacy hedge (FR-5)
    }
```

- The handler passes this to the existing `_publish_status_update(status="failed", details=...)`. The message envelope (`user_id`, `course_id`, `resource_id`, `status`, `jobId`, …) is unchanged; only the `details` keys change.

## 4. rag-api changes

None. The failed branch already implements FR-3; the fix is producer-side only (C1, C2). The contract test converts the existing consumer behavior from implicit to pinned.

## 5. End-to-end flow (after fix)

1. A `process_document` pipeline step fails; the exception propagates to the handler with `current_stage` set.
2. The handler builds `details` via the helper: actual message, failing stage, derived `retryable`, legacy `error`.
3. `_publish_status_update` publishes `status="failed"` to `rag-status-updates`.
4. rag-api's subscriber `_process_status_message` resolves the doc path (canonical first, legacy course path fallback) and runs `run_transactional_update` in a thread.
5. The failed-branch transaction writes: main doc `{status: failed, error, error_stage, retryable, status_updated_at, updated_at, schema_version: 2}`; `processing/summary` `{stage, progress, error: {code: "UNKNOWN", message, stage}, updated_at}` (merge).
6. Clients read `error`/`error_stage` via `ResourceResponse` — unchanged.

## 6. Contract test architecture

- **Location:** `apps/ai-server/tests/integration/` (new file alongside `test_api_contracts.py`), reusing that suite's patterns and the rag-api import/mocking regime in `tests/integration/conftest.py`.
- **Tier 1 — behavioral (emulator or fakes):** trigger the worker's failure path (stub a pipeline step to raise; early-stage and late-stage cases), capture the payload built by the real helper/handler, feed it through the real `run_transactional_update` against the Firestore emulator (`FIRESTORE_EMULATOR_HOST` branch) or a fake transaction/db (the `FakeDb`/`FakeTx`/`_tx_identity` pattern proven in `rag-worker-service/tests/unit/test_processing_lease.py`), then assert persisted `error`, `error_stage`, `retryable` equal the worker's values and that the summary subdocument's `error.message`/`error.stage` match (AC-2, AC-3).
- **Tier 2 — key-drift guard (AST or introspection, hermetic):** assert the worker's failure payload key set is exactly `{error_message, stage, retryable, error}` and that rag-api's failed branch reads exactly `{error_message, stage, retryable}` (tolerating `error_code`). Any added/removed/renamed key on either side fails the build — intentional ossification; adding a key later means touching the test, which is the point.
- **Classification cases:** transient-classified exception → persisted `retryable: true`; permanent and unclassified-unknown → `retryable: false`.
- **Implementation consideration (named task):** the two services' conftests stub overlapping cloud modules in `sys.modules`; the cross-service test must reconcile the stub regimes (e.g., extend `tests/integration/conftest.py` with the worker's stubs before importing the worker module, or import the worker helper under the worker's stub regime first). The binding bar is FR-6: both sides' real code must be exercised — a fixture restating the contract does not satisfy it.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained (FR-5); residual risk accepted as low; a later audit may drop the duplicate |
| Stage-tracker drift as the pipeline evolves | Set-before-await convention + representative-stage test coverage |
| `retryable: false` for genuinely transient-but-unrecognized failures | Accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains |
| Contract test ossifies the payload | Intentional — that is the drift guard doing its job |
| Cross-service test stub conflicts | Named implementation task (§6); FR-6's "real code both sides" constraint is the acceptance bar |

## 8. Out of scope

Structured error-code taxonomy (summary `error.code` stays `"UNKNOWN"` unless a code is actually sent); retry/backoff mechanics (ACK/NACK policy, leases, heartbeats — only the *reporting* of retryability changes); the stale-lease sweep's behavior; frontend or mobile work; any scope the companion D3 issue covers beyond this alignment; reconciliation with the D4 deviation note in `plans/upload-flow.md` (file absent from the current tree).

## 9. Traceability

| Requirement | Acceptance | Facts |
|---|---|---|
| FR-1 | AC-1 | F3, F4, F5 |
| FR-2 | AC-1, AC-2 | F9, F6 |
| FR-3 | AC-2, AC-3 | F4 |
| FR-4 | AC-2 | F7, F8 |
| FR-5 | AC-1 | F11 |
| FR-6 | AC-4 | F10 |

<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>