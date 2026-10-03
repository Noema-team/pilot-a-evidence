<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract mismatch

Run: 385ed21a-8c3b-4e2b-8b62-a9a5b0375a00 · Iteration 1 · Step: scoping.produce
Intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

## Scope

This cycle fixes the contract mismatch on the worker→rag-api failure path, bounded by the authoritative Definition (`wi-define-108-a8`, artifact `definition:obj-108`):

1. **Worker failure payload (rag-worker-service/main.py, `process_document` exception handler).** The worker's failed status payload currently publishes only `{"error": str(e)}` via `_publish_status_update`. It must be changed to publish `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic (F11).

2. **Stage tracking in `process_document`.** A stage tracker (a local variable set immediately before each pipeline step) is introduced so the exception handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. The safe fallback value when the stage is genuinely unknown is `"processing"` — the same value the stale-lease sweep uses for `error_stage` — so `error_stage` never regresses to null (F9).

3. **retryable derivation.** The worker sets `retryable` from `classify_error(e)` (F7, F8): transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (per `classify_error`'s conservative default), → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`. No changes to `classify_error` itself, ACK/NACK policy, leases, or heartbeats.

4. **rag-api failed branch (rag-api-service/main.py, `run_transactional_update`).** No reader or schema changes. The failed branch already reads `error_message`, `stage`, and `retryable` from the payload and persists `error`, `error_stage`, and `retryable` on the main document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) in the processing/summary error subdocument (F4). This cycle verifies and contract-tests that behavior; the worker is aligned to it, not the other way around (F2).

5. **Contract test (apps/ai-server/tests/integration/test_api_contracts.py or sibling).** A new contract test covers the worker failure → rag-api persistence path: it exercises the worker's failure-payload construction and feeds it through rag-api's failed-branch persistence (via the Firestore emulator mode both services already support, or fakes), asserting the persisted `error`, `error_stage`, and `retryable` equal the worker's values (F10). It includes a key-set drift guard so a future edit to either side's payload keys fails the build.

In scope files: `apps/ai-server/rag-worker-service/main.py` (failure payload construction, stage tracking), `apps/ai-server/tests/integration/` (new contract test). rag-api's `run_transactional_update` is exercised by the test but is not modified.

## Purpose

Every worker-originated RAG processing failure currently persists to Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a silently defaulted `retryable: true`, because the worker publishes a one-key payload (`error`) while rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`) (F3, F4, F5). Users and support cannot disambiguate failures; retryability is fabricated rather than derived (F1).

The purpose of this cycle is to make the failure record tell the truth: the worker's actual error message, the pipeline stage that failed, and a retryable flag deliberately derived from the same classification (`classify_error`) that drives the worker's ACK/NACK retry behavior. The fix aligns the worker — the only writer that doesn't speak the established `error`/`error_stage`/`retryable` schema already used by the stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource` model (F6) — so no migration, backfill, or reader change is needed. A contract test locks the seam so payload-key drift on either side fails the build instead of silently re-creating this bug.

## Requirements

From the authoritative Definition (binding):

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Constraint-derived rules (must / must_not / prefer):
- The worker is aligned to rag-api's existing contract; rag-api's reads and persisted schema are not changed.
- No Firestore migration, field rename, or backfill of existing documents; persisted field names (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- The legacy `error` key is retained in the worker's failure payload alongside `error_message` (prefer).

## Boundaries

Non-goals, per the authoritative Definition:

- **Stale-lease sweep unchanged.** `_fail_if_still_stale`'s direct failure write already persists `error`/`error_stage`/`retryable` consistently with this contract; it stays as-is (including its `retryable=true`, which remains correct because a dead worker is a transient condition).
- **Retry/backoff mechanics unchanged.** Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals are untouched — only the *reporting* of retryability in the payload changes.
- **No frontend or mobile changes.** `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **No structured error-code taxonomy.** The processing/summary error `code` remains `"UNKNOWN"` unless a code is actually sent; no error-code values are introduced in this fix.
- **No rag-api schema or reader changes.** The fix direction is worker-alignment precisely to avoid a schema migration (F2).
- **Companion D3 issue out of scope.** The Objective references a companion D3 issue (and original analysis in `plans/upload-flow.md` as deviation D4, a file not present in the current tree); anything that issue covers beyond this worker→rag-api failure payload alignment is outside this cycle (F12).

Known risks accepted within scope: unknown consumers of the status topic reading the old key set (mitigated by retaining `error`; residual risk accepted as low); stage-tracker drift as the pipeline evolves (mitigated by the "set the tracker immediately before the await" convention and representative-stage test coverage — an early-stage and a late-stage failure, not every step); `retryable=false` for unclassified-unknown errors reducing auto-retry affordances (accepted; widening `classify_error` is out of scope, manual reprocess via `POST /process` remains); the contract test ossifying the payload (intentional — that is the drift guard).

## Version bump

Minor. The change is additive and behavior-corrective: the worker's failure payload gains keys (`error_message`, `stage`, `retryable`) and `process_document` gains internal stage tracking; rag-api's contract and persisted schema are unchanged. The one deliberate behavior change (unclassified-unknown failures now persist `retryable: false` instead of the silent default `true`) is a bug-fix semantics correction within the existing schema, not a breaking API change — no persisted field names, endpoints, or client-visible response shapes change. If the repository's release conventions distinguish patch vs. minor by test additions alone, a patch bump is acceptable; minor is the default choice because a persisted-value behavior change (retryable for unknown errors) is observable to clients.

## Deferred items

- **Companion D3 issue.** Referenced by the Objective as filed alongside this one; its content is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred (F12).
- **Reconciliation with `plans/upload-flow.md` deviation D4.** The original D4 analysis lives in a file not present in the current tree; the reference comes only from the Objective text. Reconciling this cycle's analysis with it is deferred.
- **Status-topic consumer audit.** Only rag-api's status subscriber is verified as a consumer of the worker's failure payload (F11). A full audit of other topic consumers/tooling is deferred; the retained legacy `error` key is the hedge. If the audit later confirms rag-api is the only consumer, dropping the duplicate key is trivial cleanup.
- **Widening `classify_error`.** Genuinely transient-but-unrecognized failures will now persist `retryable: false`; improving the classifier's heuristics is out of scope for this cycle.
- **Structured error-code taxonomy.** Any future failure taxonomy (populating `error_code` beyond the `"UNKNOWN"` default) is deferred.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>