I've verified the repository context (worker/API sources, existing contract-test infrastructure, conftest mocking pattern). Now producing the cycle charter per the authoritative definition.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

## Scope

This cycle fixes the contract mismatch on the worker → rag-api failure path, and nothing else:

1. **Worker failure payload (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler).** The failed status update currently publishes only `{"error": str(e)}`. It must publish:
   - `error_message` — the actual exception message (`str(e)`);
   - `stage` — the pipeline stage executing at failure time, tracked in `process_document`;
   - `retryable` — deliberately derived from `classify_error(e)` (transient → `true`, permanent/unknown → `false`);
   - the legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.

2. **Stage tracking in `process_document`.** A stage tracker (local variable) is set immediately before each pipeline step, using the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. When the stage is genuinely unknown (failure before the first transition), the safe value is `"processing"` — the same value the stale-lease sweep uses — so `error_stage` never regresses to null.

3. **rag-api failed branch (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update`).** No reader or schema change. Its existing reads of `error_message` / `stage` / `retryable` become operative because the worker now supplies them; the branch must persist worker-provided values unchanged (main doc `error` ← `error_message`, `error_stage` ← `stage`, `retryable` ← `retryable`; processing/summary error subdocument carries the same message and stage, `error_code` stays `"UNKNOWN"` unless a code is actually sent).

4. **Contract test (`apps/ai-server/tests/integration/`, house pattern from `test_api_contracts.py`).** A test covering the worker failure → rag-api persistence path: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` (Firestore emulator or fakes per the existing `conftest.py` mock pattern), and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. Include a payload key-set drift guard on both sides so a future key edit on either side fails the build. Cover representative stages: an early-stage failure and a late-stage failure.

Acceptance targets (from the Definition): worker payload carries all three keys without relying on rag-api fallbacks; persisted doc has real error message (not `"Processing failed"`), real stage (not `None`), derived retryable; processing/summary subdocument matches the main document; contract test exists and passes.

## Purpose

A failed RAG processing job today lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true`, because the worker's exception handler publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Users and support cannot disambiguate failures, and the persisted retryable flag lies about what the worker actually did (it silently defaults `true` even for errors the worker acked as permanent).

The fix direction is deliberate: the worker aligns to rag-api's existing contract, not the reverse. The persisted `error` / `error_stage` / `retryable` schema is already consistent across the worker's stale-lease sweep, rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse` — the worker's status publisher is the only writer that doesn't speak it. Aligning the worker avoids any Firestore migration, field rename, or backfill, and keeps the persisted field names and semantics exactly as they are.

Deriving `retryable` from `classify_error(e)` makes the persisted record tell the truth about the worker's ACK/NACK behavior: transient errors are ones Pub/Sub will redeliver (`retryable: true`); permanent errors — including unclassified-unknown, per `classify_error`'s conservative default — were acked and will not return (`retryable: false`; manual reprocess via `POST /process` remains). One deliberate behavior change follows: unclassified-unknown failures persist `retryable: false` instead of the silent `true` default. This is the conservatism `classify_error` was written for and prevents infinite retry loops.

## Requirements

1. **Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **API persistence unchanged.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. **Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
5. **Contract test.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.
6. **Compatibility hedge (preferred).** The worker retains the legacy `error` key alongside `error_message` in the failure payload, for continuity with any existing consumers of the status topic and log tooling.

## Boundaries

**Must / must-not constraints (binding):**
- The worker aligns to rag-api's existing contract — publishing `error_message` / `stage` / `retryable` — rather than changing rag-api's reads or persisted schema.
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- No structured error-code taxonomy: the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.

**Out of scope (non-goals):**
- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error` / `error_stage` / `retryable: true` consistently with this contract, and its `retryable: true` stays correct (a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Widening `classify_error`'s heuristics — residual risk that genuinely transient-but-unrecognized failures now persist `retryable: false` is accepted; manual reprocess via `POST /process` remains.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Dropping the legacy `error` key — retained this cycle; trivial cleanup only if a later audit confirms the worker is the sole publisher and rag-api the sole consumer.
- Any scope the companion D3 issue covers beyond this worker → rag-api failure payload alignment (its content is unavailable in this context).

## Version bump

Patch bump for both touched services (`rag-worker-service`, `rag-api-service`): the persisted schema, public API surface, and `ResourceResponse` are unchanged; the change is a bug fix to the worker's status payload plus contract-test coverage. rag-api itself may require no code change (its failed branch already reads the correct keys) — if so, only the worker and tests change, and the rag-api bump is limited to test-adjacent tooling if needed at all. No database version, no migration, no backfill.

## Deferred items

1. **Companion D3 issue.** The Objective references a companion D3 issue filed alongside this one; its scope is not available in this context. Anything it covers beyond the worker → rag-api failure payload alignment is deferred.
2. **Reconciling with plans/upload-flow.md deviation D4.** The original analysis reference lives in `plans/upload-flow.md`, a file not present in the current tree (the reference comes from the Objective text). Reconciliation is deferred until that file exists or its content is supplied.
3. **Legacy `error` key removal.** Retained this cycle as a hedge; removal is deferred to a follow-up audit of status-topic consumers.
4. **Structured error-code taxonomy.** Explicitly not introduced this cycle (prefer-not constraint); if a taxonomy is wanted later, it is a separate cycle touching `classify_error` and the summary error subdocument.
5. **`classify_error` heuristic widening.** Accepted residual risk that unrecognized transient failures persist `retryable: false`; widening the heuristics is out of scope.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>