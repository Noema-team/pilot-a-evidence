<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
**Cycle charter — rag-worker → rag-api failure payload contract alignment**
Run 04d1e224-0ff1-4bd9-8dfe-6ed25afd1df6 · Iteration 1 · Step: scoping.produce
Authoritative source: WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c…e89cac5`). This charter restates that Definition's bounded scope; it does not widen, narrow, or reinterpret it.

## Scope

Code changed in this cycle:

- `apps/ai-server/rag-worker-service/main.py` — the worker's failure-reporting path only:
  - `process_document`'s exception handler: the failed status payload published via `_publish_status_update` must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived from `classify_error(e)`), while retaining the legacy `error` key alongside `error_message`.
  - Stage tracking through `process_document`: a stage tracker set immediately before each pipeline step so the failure handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`); `"processing"` is the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.
  - `retryable` derivation aligned with the worker's existing ACK/NACK behavior in `run_worker`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (`classify_error`'s conservative default) → `false`.
- `apps/ai-server/tests/integration/` — a worker→rag-api failure-path contract test following the existing fixture- and AST-based patterns in `test_api_contracts.py`:
  - Build the failure payload through the worker's code path and feed it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes — importing both sides rather than restating the contract in a fixture.
  - Assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and that the `processing/summary` error subdocument carries the same message and stage.
  - Include a key-set drift guard so a future edit to either side's payload keys fails the build instead of silently re-creating this bug.

Exercised but not modified (already conforming; pinned by the test, not changed):

- `apps/ai-server/rag-api-service/main.py` — `run_transactional_update`'s failed branch already reads `details` keys `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main resource document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` subdocument. rag-api's reads and persisted schema are the contract; they do not change.
- `apps/ai-server/rag-api-service/models/resource.py` — `Resource` already exposes `error`/`error_stage`/`retryable` (retryable defaults `True`).

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. Verified in the current tree:

- `rag-worker-service/main.py`: `process_document`'s exception handler publishes the failed status with details `{"error": str(e)}` via `_publish_status_update`.
- `rag-api-service/main.py`: `run_transactional_update`'s failed branch reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, and `details.get("retryable", True)`, persists them as `error`/`error_stage`/`retryable` on the main document, and writes the same fallbacks (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument.

Consequence: every worker-originated failure lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`. Users and support cannot disambiguate what failed or where.

Direction (the Definition's preferred fix): the worker aligns to rag-api's contract. The persisted failure schema (`error`/`error_stage`/`retryable`) is already used consistently by the worker's stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource`/`ResourceResponse` models — the worker's status publisher is the only writer that doesn't speak it. Aligning the worker is therefore the change that does not ripple: no migration, no backfill, no reader changes.

Deliberate behavior change to flag for approval: unclassified-unknown exceptions currently persist `retryable: true` via the silent default but classify as permanent under `classify_error`; after this fix they persist `retryable: false`. That matches the worker's actual ACK/NACK behavior (permanent errors are acked; manual reprocess via `POST /process` remains) and is the conservatism `classify_error` was written for. The stale-lease sweep's separate `retryable: true` write stays correct — a dead worker is a transient condition by nature.

Compatibility hedge: only rag-api's status subscriber is a known consumer of these payloads; the worker retains the legacy `error` key alongside `error_message` so any unknown consumer of the shared status topic keeps working.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The `retryable` derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Acceptance (definition of done):

- A failed job's status message published by the worker contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
- The contract test exists and passes, exercising the worker's failure-payload construction through rag-api's failed-branch persistence and asserting the persisted values, failing on key drift on either side.

## Boundaries

Binding constraints:

- MUST align the worker to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- MUST NOT require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- MUST send `retryable` explicitly on every worker-originated failure payload; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- PREFER retaining the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- PREFER NOT introducing a structured error-code taxonomy (`error_code` values) in this fix.

Implementation conventions pinned by this charter:

- The stage tracker is set immediately before each awaited pipeline step; the contract test pins representative stages (an early-stage failure and a late-stage failure) rather than every step — enough to catch the tracker being removed or bypassed without ossifying every transition.
- The contract test imports both services' code rather than restating the contract in a fixture.

Non-goals (explicitly out of scope):

- Changing the stale-lease sweep's direct failure write — `_fail_if_still_stale` already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment.

## Version bump

- Classification: bug fix → patch-level if the repo's release convention requires an explicit bump.
- No Firestore migration, field rename, or backfill; documents keep `schema_version: 2` (both services already write it on status updates; unchanged by this fix).
- rag-api's code is not expected to change, so its declared service version (the FastAPI app `version="1.0.0"` in `rag-api-service/main.py`) stays untouched.
- No version declaration for `rag-worker-service` was identified in the verified code slices; apply the repo's standard patch-level convention if one applies.

## Deferred items

- The companion D3 issue referenced by the Objective: its content is not available in this context; anything it covers beyond this worker→rag-api failure payload alignment is out of this cycle.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`: that file is not present in the current tree (the reference comes from the Objective text); reconciliation is deferred.
- Dropping the legacy `error` key from the worker's failure payload: deferred until an audit confirms the worker is the sole publisher and rag-api the sole consumer of the status topic; until then the duplicate key is retained as a compatibility hedge (trivial cleanup later if confirmed).
- Widening `classify_error`'s transient/permanent heuristics (e.g., recognizing additional transient conditions): out of scope; `retryable: false` for unclassified-unknown errors is accepted for this cycle, with manual reprocess via `POST /process` unaffected.
- A structured error-code taxonomy: deferred; `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>