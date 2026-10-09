 I have enough context from the authoritative definition and repository evidence to produce the cycle charter.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

## Scope

This cycle fixes the contract mismatch between the RAG worker's failure status publisher and rag-api's failed-branch consumer.

In scope:

1. **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler via `_publish_status_update`): the failed status payload must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
2. **Stage tracking in `process_document`**: a local stage tracker set immediately before each pipeline step, reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **Retryable derivation**: the worker derives `retryable` from `classify_error(e)` — transient-classified → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.
4. **Contract test** (in the existing `apps/ai-server/tests/integration/test_api_contracts.py` pattern): a worker failure → rag-api persistence test that builds the failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` failed branch (via Firestore emulator or fakes), and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It includes a key-set drift guard so edits to either side's payload keys fail the build.
5. **rag-api side (verification only)**: rag-api's failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` plus the processing/summary error subdocument (`message`, `stage`, `error_code` defaulting `"UNKNOWN"`). It is asserted by the contract test, not changed.

## Purpose

Every worker-originated failure currently persists to Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true`, because the worker publishes `{"error": str(e)}` while rag-api reads `error_message`/`stage`/`retryable`. Users and support cannot disambiguate failures, and retryability is silently defaulted rather than derived.

The fix aligns the worker — the odd one out — to rag-api's existing contract. The persisted field names (`error`, `error_stage`, `retryable`) are already consistent across the worker's stale-lease sweep, rag-api's enqueue-failure paths, and both response models, so changing the worker's payload keys avoids any migration, rename, or backfill. Deriving `retryable` from `classify_error` makes the persisted record tell the truth about what Pub/Sub will actually do (transient = redelivered; permanent = acked, manual reprocess via `POST /process` remains). A contract test locks the seam so neither side can drift again silently.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the failing pipeline stage), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

## Boundaries

Out of scope (non-goals):

- **Stale-lease sweep** (`_fail_if_still_stale`): unchanged — it already persists `error`/`error_stage`/`retryable` consistently with this contract (its `retryable: true` write stays correct: a dead worker is a transient condition).
- **Retry/backoff mechanics**: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes. Note the deliberate behavior change: unclassified-unknown exceptions will now persist `retryable: false` (previously the silent default `true`); widening `classify_error` is out of scope and manual reprocess via `POST /process` is unaffected.
- **Frontend or mobile changes**: `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **Structured error codes / failure taxonomy**: the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- **rag-api reader changes or schema changes**: no migration, field rename, or backfill of existing documents; persisted fields keep their names and semantics.
- **Dropping the legacy `error` key** from the worker payload in this cycle — it is retained as the compatibility hedge; removal is trivial later cleanup if an audit confirms the worker is the only publisher.
- **Anything the companion D3 issue covers** beyond this worker→rag-api failure payload alignment (its content is unavailable in this context), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (that file is not present in the current tree).

Constraints honored: align the worker to rag-api's existing contract (must); no migration/rename/backfill (must not); explicit `retryable` on every worker failure payload, with rag-api's `details.get("retryable", True)` fallback never operative for worker failures (must); retain the legacy `error` key (prefer); no structured error-code taxonomy (prefer not).

## Version bump

Patch-level. The change is a bug fix within existing service behavior: worker payload keys corrected, a stage tracker added, `retryable` derived from existing `classify_error`, and a contract test added. No new endpoints, no schema changes, no API surface changes (`ResourceResponse` untouched). Bump the affected service version(s) (`rag-worker-service`; `rag-api-service` only if it carries a version constant touched by the test) by patch increment.

## Deferred items

- **Companion D3 issue**: referenced by the Objective but not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling with the original D4 deviation note** in `plans/upload-flow.md`: that file is not present in the current tree; the reference comes only from the Objective text. Deferred.
- **Auditing other potential consumers of the status topic** to confirm the legacy `error` key can be dropped: deferred cleanup, contingent on such an audit.
- **Widening `classify_error`** to recognize additional transient-but-unrecognized exception types: accepted residual risk, out of scope.
- **Structured error-code taxonomy** for the processing/summary error subdocument: prefer-not constraint; deferred.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>