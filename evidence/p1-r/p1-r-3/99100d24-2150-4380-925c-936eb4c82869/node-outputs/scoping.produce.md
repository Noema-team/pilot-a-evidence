I've reviewed the repository context (worker's `classify_error`/exception types, rag-api's failed-branch contract surface, the existing `tests/integration/test_api_contracts.py` pattern, and the conftest mocking setup). The charter below is scoped strictly to the authoritative definition.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

## Scope

This cycle fixes the contract mismatch on the worker→rag-api failure path. Today the worker's `process_document` exception handler publishes a failed status with a single key (`{"error": str(e)}`), while rag-api's failed branch in `run_transactional_update` reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error`, `error_stage`, and `retryable`. Every worker-originated failure therefore persists the fallback string "Processing failed", a null `error_stage`, and a silently defaulted `retryable: true`; the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN".

In scope:

1. **Worker payload alignment** — the worker's failed status payload is changed to carry `error_message` (the actual exception message), `stage` (the failing pipeline stage), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unverified consumers of the status topic. rag-api's reads and persisted schema are not changed; the worker is aligned to the API's existing contract.
2. **Stage tracking in `process_document`** — a local stage tracker is set immediately before each pipeline step and reported by the exception handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown (matching the stale-lease sweep's `error_stage` value, so the field never regresses to null).
3. **Explicit retryable derivation** — the worker sets `retryable` from `classify_error(e)`: transient-classified errors → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`. Known consequence, accepted: unclassified-unknown exceptions change from persisted `retryable: true` (silent default) to `false`.
4. **Contract test** — a new test in `apps/ai-server/tests/integration/` (following the existing `test_api_contracts.py` fixture/AST patterns and the hermetic Firestore-emulator / fakes mode) that imports both sides rather than restating the contract: it builds the failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` failed branch, and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It includes a key-set drift guard so a future edit to either side's payload keys fails the build. Coverage pins representative stages (an early-stage failure and a late-stage failure) rather than ossifying every step.

Affected code: `apps/ai-server/rag-worker-service/main.py` (failure payload construction, stage tracking, retryable derivation) and `apps/ai-server/tests/integration/` (new contract test). rag-api service code is intentionally untouched.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures. Today none of that happens: the seam between the worker's publisher and rag-api's consumer was written against different contracts and nothing tests it, so every worker failure lands in Firestore with fabricated fallback values. Retryable must be sent by the worker or derived deliberately — never silently defaulted — because the persisted value should tell the truth about whether Pub/Sub will redeliver (transient) or the job was acked and needs manual reprocess via `POST /process` (permanent).

The preferred fix direction is aligning the worker to `error_message`/`stage` — matching rag-api's persisted fields — because `error`/`error_stage`/`retryable` is already the established schema across the worker's stale-lease sweep, rag-api's enqueue-failure paths (`/process`, `POST /resources`), and the `Resource` model plus `ResourceResponse`. The worker's status publisher is the only writer that doesn't speak it; fixing the odd one out avoids any schema migration, field rename, or backfill.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage (with `error_code` remaining "UNKNOWN" unless a code is actually sent).
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.
6. (Constraint — must) The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
7. (Constraint — must_not) The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
8. (Constraint — must) Every worker-originated failure payload must carry `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
9. (Constraint — prefer) Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
10. (Constraint — prefer_not) Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

## Boundaries

Out of scope (non-goals):

- **Changing the stale-lease sweep's direct failure write** (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract, and its `retryable: true` stays correct (a dead worker is a transient condition by nature).
- **Changing retry/backoff mechanics** — Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals are untouched; only the *reporting* of retryability in the payload changes.
- **Frontend or mobile changes** — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **Introducing structured error codes or a failure taxonomy** — the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.
- **Widening `classify_error`'s heuristics** — the reduced auto-retry affordance for genuinely transient-but-unrecognized failures is accepted; manual reprocess via `POST /process` remains available.
- **Any rag-api code change** — the API's failed branch, reads, and persisted schema stay exactly as they are.
- **Dropping the legacy `error` key** — that is potential later cleanup pending a consumer audit, not part of this cycle.

## Version bump

- `rag-worker-service`: **patch** bump — behavioral fix to the failure-status payload (new payload keys, stage tracking, retryable derivation); no new public API surface, no schema change.
- `rag-api-service`: **no bump** — no code change; its failed-branch contract is the alignment target and is read as-is.
- `tests/integration` and shared test fixtures: no version bump (test-only addition).

## Deferred items

- **Companion D3 issue** referenced by the Objective — its content is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling this analysis with the original D4 deviation note** in `plans/upload-flow.md` — that file is not present in the current tree (the reference comes from the Objective text); deferred.
- **Dropping the legacy `error` key** from the worker's failure payload — contingent on a future audit confirming the worker is the only publisher and rag-api the only consumer of the status topic.
- **A structured error-code taxonomy / failure taxonomy** — out of scope by prefer_not constraint; the summary `error.code` stays "UNKNOWN" unless a code is actually sent.
- **Widening `classify_error` heuristics** to recognize more transient failure modes — accepted residual risk that unrecognized-transient failures persist `retryable: false`.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>