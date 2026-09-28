I have enough grounding from the definition and the repository evidence. Producing the cycle charter now.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

## Scope

This cycle changes the rag-worker's failure-status payload so it speaks rag-api's existing failed-branch contract, and locks the seam with a contract test. Concretely, in scope:

1. **Worker failure payload construction** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler and its `_publish_status_update` call): the failed status payload must publish `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic.
2. **Stage tracking in `process_document`**: a tracker local set immediately before each pipeline step, reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep uses for `error_stage`).
3. **retryable derivation in the worker**: `retryable` is set from `classify_error(e)` — transient-classified errors map to `true`; permanent-classified errors, including unclassified-unknown (per `classify_error`'s conservative default), map to `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.
4. **Contract test** (`apps/ai-server/tests/integration/`, following the fixture- and AST-based patterns in `test_api_contracts.py`): a test covering the worker failure → rag-api persistence path. It must exercise the worker's failure-payload construction through rag-api's `run_transactional_update` failed branch (via the Firestore emulator or fakes — both services support hermetic `FIRESTORE_EMULATOR_HOST` branches) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must include a key-set drift guard so a future edit to either side's payload keys fails the build.

Out of scope by construction: rag-api's code is **not** changed. Its failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main document plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) in the processing/summary subdocument — that read side is the contract the worker aligns to.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test covers the seam. The worker's exception handler publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Because of the mismatch, every worker-originated failure currently persists:

- `error` as the fallback string `"Processing failed"` — users and support cannot see the actual error;
- `error_stage` as `None` — the failing pipeline stage is lost;
- `retryable` as the silent default `true` — a fabricated value that does not reflect the worker's real ACK/NACK decision.

The processing/summary error subdocument inherits the same fallbacks, with `error_code` always `"UNKNOWN"`.

The purpose of this cycle is to make a failed RAG processing job persist the worker's actual error message, the true failing stage, and a deliberately derived retryable flag — so failures are disambiguable and the persisted record tells the truth about whether Pub/Sub will redeliver. The fix direction is deliberate: the persisted field names `error`/`error_stage`/`retryable` are already consistent across the worker's stale-lease sweep, rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse`. The worker's status publisher is the only writer that doesn't speak this schema; aligning the worker requires no Firestore migration, no field rename, no backfill, and no reader changes.

One deliberate behavior change is accepted: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent, so they will now persist `false`. That is the conservatism `classify_error` was written for — it prevents infinite retry loops — and manual reprocess via `POST /process` remains available.

## Requirements

1. **Failure payload keys.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. Convention: set the tracker immediately before the awaited step.
3. **rag-api persistence unchanged.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage. No changes to rag-api's reads or persisted schema.
4. **Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
5. **Contract test.** A contract test must cover the worker failure → rag-api persistence path: it exercises the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must fail if either side's payload keys drift, and should pin the stage-tracker mechanism on representative stages (an early-stage failure and a late-stage failure) rather than ossifying every step.
6. **Legacy key retention.** The worker's failure payload retains the legacy `error` key alongside `error_message` for continuity with any existing consumers of the status topic and log tooling.

## Boundaries

Hard boundaries — this cycle must not:

- **Change rag-api's failed branch, reads, or persisted schema.** The worker aligns to the API, not the reverse.
- **Require any Firestore migration, field rename, or backfill.** The persisted fields `error`, `error_stage`, `retryable` keep their names and semantics.
- **Leave the API-side `details.get("retryable", True)` fallback as the operative mechanism** for worker failures — every worker-originated failure payload carries `retryable` explicitly.
- **Change the stale-lease sweep** (`_fail_if_still_stale`) — its direct write already persists `error`/`error_stage`/`retryable` consistently with this contract, and its `retryable: true` stays correct (a dead worker is a transient condition).
- **Change retry/backoff mechanics** — Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals, or `classify_error` itself. Only the *reporting* of retryability in the payload changes.
- **Introduce structured error codes or a failure taxonomy** — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- **Touch frontend or mobile** — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **Widen the scope to the companion D3 issue** referenced by the Objective — its content is unavailable in this context; anything beyond the worker→rag-api failure payload alignment is deferred.

Known drift risk, accepted and mitigated: a future pipeline step added without updating the stage tracker reports a stale stage. Mitigation is the update-before-await convention plus representative-stage contract-test coverage.

## Version bump

No explicit version policy is specified in the authoritative Definition; this section records the charter's determination from the constraint set:

- **rag-worker-service: patch bump.** The change is a bug fix to the failure payload (added keys, stage tracking, derived retryable). It is backward-compatible at the transport level — keys are added and the legacy `error` key is retained — but it does change observable persisted behavior (`retryable: false` for unclassified-unknown errors instead of the silent `true` default), which argues against treating it as invisible. Patch is the appropriate bump; the deliberate behavior change is documented in this charter and in the acceptance criteria.
- **rag-api-service: no bump.** Its code is unchanged; the existing contract is the alignment target.
- **No database migration, index change, or backfill** accompanies the bump (constraint: must not).

## Deferred items

- **Companion D3 issue scope.** The Objective references a D3 issue filed alongside this one. Its content is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling with the original D4 deviation note.** `plans/upload-flow.md` (where deviation D4 was originally recorded) is not present in the current tree; reconciling this analysis with it is deferred.
- **Dropping the legacy `error` key.** If a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic, removing the duplicate key is trivial cleanup — deferred, not part of this cycle.
- **Widening `classify_error`.** If genuinely-transient-but-unrecognized failures prove common under the new `retryable: false` default, widening the classifier's heuristics is a separate decision — deferred.
- **Structured error-code taxonomy.** Explicitly a non-goal for this cycle; the `error_code` defaulting to `"UNKNOWN"` stands.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>