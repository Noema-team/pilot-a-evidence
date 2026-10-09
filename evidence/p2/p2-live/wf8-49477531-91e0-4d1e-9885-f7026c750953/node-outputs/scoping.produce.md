The authoritative definition is complete and self-contained; the repository evidence (worker's `classify_error`/exception classes, service layout) is consistent with it. Producing the cycle charter.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

## Scope

This cycle fixes the contract mismatch between the rag-worker's failure status payload and rag-api's failed-branch persistence contract.

In scope:

1. **Worker failure payload (rag-worker-service/main.py).** The `process_document` exception handler currently publishes `{"error": str(e)}` via `_publish_status_update`. It must be changed to publish a payload containing:
   - `error_message` — the actual exception message (`str(e)`),
   - `stage` — the pipeline stage executing at failure time,
   - `retryable` — deliberately derived from `classify_error(e)` (transient → `true`, permanent/unknown → `false`),
   - the legacy `error` key retained alongside `error_message` as a compatibility hedge for any unknown consumers of the status topic.

2. **Stage tracking in `process_document`.** A stage tracker local must be set immediately before each pipeline step, reusing the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. When the stage is genuinely unknown (e.g. failure before the first transition), the safe value is `"processing"` — the same value the stale-lease sweep uses for `error_stage` — so the field never regresses to null.

3. **rag-api failed branch (rag-api-service/main.py, `run_transactional_update`).** No reader changes to field names or semantics; it already reads `error_message`/`stage`/`retryable` from the payload details. Verification only that it persists the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage (with `error_code` defaulting to `"UNKNOWN"`).

4. **Contract test (apps/ai-server/tests/integration/test_api_contracts.py or a sibling).** A worker failure → rag-api persistence contract test that:
   - imports both sides rather than restating the contract in a fixture,
   - builds the failure payload through the worker's code path and feeds it through rag-api's failed-branch persistence (via the Firestore emulator or fakes),
   - asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values,
   - includes a key-set drift guard so a future edit to either side's payload/persistence keys fails the build,
   - covers representative stages (an early-stage failure and a late-stage failure) to pin the stage-tracker mechanism without ossifying every step.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag, so users and support can disambiguate failures. Today every worker-originated failure persists the fallback string `"Processing failed"`, a null `error_stage`, and a silently defaulted `retryable: true`, because the worker's one-key payload (`{"error": ...}`) does not match the three keys rag-api's failed branch reads (`error_message`, `stage`, `retryable`). The `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

The fix direction is to align the worker to rag-api's existing contract: the persisted `error`/`error_stage`/`retryable` schema is already used consistently by the stale-lease sweep, rag-api's enqueue-failure paths, and both response models, so the worker is the only writer that doesn't speak it. Aligning the worker requires no schema migration, field rename, or backfill. Deriving `retryable` from `classify_error()` makes the persisted record tell the truth about the worker's ACK/NACK behavior (transient = Pub/Sub will redeliver; permanent = acked, manual reprocess via `POST /process` remains), and a contract test locks the worker→rag-api failure path so the seam cannot silently drift again.

## Requirements

- When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
- The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
- The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
- A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.
- The worker must retain the legacy `error` key alongside `error_message` in the failure payload (compatibility hedge).

## Boundaries

Must constraints:

- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- Every worker-originated failure payload must carry `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

Must-not constraints:

- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.

Non-goals (explicitly out of scope):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (its separate `retryable=true` write stays correct: a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Widening `classify_error`'s heuristics (the `retryable=false` behavior for unclassified-unknown errors is an accepted, deliberate change).
- Dropping the legacy `error` key from the payload (possible later cleanup only if an audit confirms the worker is the only publisher and rag-api the only consumer).
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment.

Known risks accepted in this scope:

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- The contract test ossifying the payload key set — intentional; that is the drift guard doing its job.

## Version bump

Minor. The change adds new keys to the worker's published failure payload and a deliberate behavior change (`retryable` explicitly derived, so unclassified-unknown errors now persist `false` instead of the silent `true` default), plus a new contract test. No breaking change to persisted schema, API routes, or response models; the legacy `error` key is retained for compatibility.

## Deferred items

- The companion D3 issue referenced by the Objective: its content is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes only from the Objective text.
- Auditing all potential consumers of the worker status topic to confirm the legacy `error` key can be dropped.
- Introducing a structured error-code taxonomy (`error_code` values beyond the `"UNKNOWN"` default).
- Any change to `classify_error`'s classification heuristics.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>