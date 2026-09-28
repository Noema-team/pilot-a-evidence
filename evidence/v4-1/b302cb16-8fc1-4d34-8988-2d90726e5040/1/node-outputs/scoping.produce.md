<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

In scope, and only this:

1. **Worker failure payload** — `apps/ai-server/rag-worker-service/main.py`, the `process_document` exception handler and its `_publish_status_update(..., "failed", ...)` call. The failed status payload gains `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic.
2. **Stage tracking** — same file, `process_document`: a local stage tracker set immediately before each pipeline step and reported by the exception handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`); `"processing"` is the safe value when the stage is genuinely unknown (matching the stale-lease sweep's `error_stage` value, so the field never regresses to null).
3. **retryable derivation** — same file: `retryable` is derived from `classify_error(e)`, the same classification that already drives ACK/NACK in `run_worker`. Transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (per `classify_error`'s conservative default) → `false`.
4. **Contract test** — `apps/ai-server/tests/integration/`, following the existing fixture/AST pattern in `test_api_contracts.py`: it imports both sides rather than restating the contract, builds the failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` failed branch against the Firestore emulator (or fakes), and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It includes a key-set drift guard so a future edit to either side's payload keys fails the build.

Explicitly in scope by exclusion: rag-api's failed branch (`run_transactional_update` in `apps/ai-server/rag-api-service/main.py`) is **not modified**. It already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable`; the worker — the only writer that doesn't speak the established schema — is aligned to it.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error`/`error_stage`/`retryable`. Verified consequence: every worker-originated failure lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`; the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures.

The persisted failure schema (`error`/`error_stage`/`retryable`) is already consistent across three other write paths — the worker's stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource` model / `ResourceResponse` — so aligning the worker is the change that ripples least: no migration, no backfill, no reader changes. This cycle makes a failed job persist the worker's actual error message, the true failing stage, and a retryable flag that tells the truth about whether Pub/Sub will redeliver — locked in by a contract test on the worker→rag-api failure path so the seam cannot silently drift again.

## Requirements

1. **Payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. Convention: set the tracker immediately before the awaited step.
3. **API-side persistence unchanged and faithful.** rag-api's failed branch persists the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument carries the same message and stage (its `code` remains "UNKNOWN" unless a code is actually sent — none is sent in this fix).
4. **Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`. Known deliberate behavior change: unclassified-unknown failures flip from the silent persisted default `true` to `false`; manual reprocess via `POST /process` is unaffected.
5. **Contract test.** A test covering the worker failure → rag-api persistence path must exist and pass: it exercises the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift. Coverage pins the mechanism on representative stages (an early-stage failure and a late-stage failure) rather than ossifying every step.
6. **Compatibility hedge.** The worker retains the legacy `error` key in the failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.

Acceptance checks (all must hold at cycle end):
- A failed job's published status message contains `error_message`, `stage`, and `retryable`, none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument carries the same message and stage as the main document.
- The contract test exists, passes, and fails on key drift on either side.

## Boundaries

Hard constraints:

- **Must:** the worker aligns to rag-api's existing contract (publishing `error_message`/`stage`/`retryable`) — rag-api's reads and persisted schema are not changed.
- **Must not:** require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must:** every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer:** retain the legacy `error` key alongside `error_message` (adopted — see Requirement 6).
- **Prefer not:** introduce a structured error-code taxonomy (`error_code` values) in this fix.

Non-goals (out of scope):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (its `retryable: true` stays correct: a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error `code` remains "UNKNOWN" unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred — see below).
- Widening `classify_error`'s transient heuristics for unrecognized-but-actually-transient failures; the conservatism is intentional and manual reprocess remains.

Residual risks accepted: unknown consumers of the status topic reading the old key set (mitigated by retaining `error`); stage-tracker drift as the pipeline evolves (mitigated by the update-before-await convention and representative-stage test coverage); contract-test ossification of the payload (intentional — that is the drift guard).

## Version bump

- **rag-worker-service:** patch-level bump recommended — the change is a behavioral fix confined to failure reporting (payload keys, stage tracking, retryable derivation); no public API surface, schema, or data-format change.
- **rag-api-service:** no bump — no service code changes; the service is only exercised by the new contract test.
- **Tests:** additive only (`apps/ai-server/tests/integration/`).
- No data migration, backfill, or infrastructure change accompanies this cycle.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle.
- **Reconciling with the original D4 deviation note** in `plans/upload-flow.md`: that file is not present in the current tree (the reference comes from the Objective text only); reconciliation is deferred.
- **Dropping the legacy `error` key** from the worker's failure payload: deferred pending an audit confirming the worker is the only publisher and rag-api the only consumer of the status topic; trivial cleanup afterwards if confirmed.
- **Structured error-code taxonomy** (`error_code` values beyond the existing "UNKNOWN" default): deliberately not introduced in this fix.
- **Widening `classify_error`** to recognize more transient failure modes: out of scope; unrecognized exceptions conservatively persist `retryable: false`, and manual reprocess via `POST /process` remains the recovery path.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>