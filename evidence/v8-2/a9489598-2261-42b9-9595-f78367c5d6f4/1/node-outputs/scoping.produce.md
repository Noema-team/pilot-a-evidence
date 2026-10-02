I've verified the repository evidence underpinning the Definition: the worker's `process_document` exception handler publishes `{"error": str(e)}` (rag-worker-service/main.py), rag-api's `run_transactional_update` failed branch reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` plus the `processing/summary` error subdocument (rag-api-service/main.py), the stale-lease sweep already writes the target schema, `classify_error()` drives ACK/NACK in `run_worker`, and the contract-test house pattern exists in `apps/ai-server/tests/integration/test_api_contracts.py` with emulator branches in both services. The charter below stays inside that bounded scope.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api: failure payload contract mismatch

## Scope

This cycle aligns the rag-worker's failed-status payload to rag-api's existing failed-branch contract. In scope:

- **rag-worker-service/main.py — failure payload.** The `process_document` exception handler must publish a failed status whose details carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
- **rag-worker-service/main.py — stage tracking.** `process_document` gains a stage tracker (a local set immediately before each pipeline step) so the failure handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- **rag-worker-service/main.py — retryable derivation.** `retryable` is derived from `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (per `classify_error`'s conservative default), → `false`. This aligns the persisted record with the worker's ACK/NACK behavior in `run_worker`.
- **rag-api-service — no contract change.** rag-api's failed branch (`run_transactional_update`) is not modified: it persists `error ← details.error_message`, `error_stage ← details.stage`, `retryable ← details.retryable`, and writes the same message and stage into the `processing/summary` error subdocument (`error.code` stays `"UNKNOWN"` unless a code is actually sent).
- **Contract test.** A worker→rag-api failure-path contract test in `apps/ai-server/tests/integration` (following the existing `test_api_contracts.py` fixture/AST patterns) that builds the failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes, asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and includes a key-set drift guard so a future edit to either side's payload keys fails the build.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures. Today every worker-originated failure persists the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`, because the worker publishes `{"error": str(e)}` while rag-api reads `error_message`/`stage`/`retryable`. The fix direction is the worker aligning to rag-api — the persisted `error`/`error_stage`/`retryable` schema is already established across the stale-lease sweep, rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse` — so no Firestore migration, field rename, or backfill is needed and no reader changes. The seam is locked in by a contract test so the two sides cannot silently drift apart again.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error ← payload error_message`, `error_stage ← payload stage`, `retryable ← payload retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

## Boundaries

Must / must-not constraints:

- The worker is aligned to rag-api's existing contract (`error_message`/`stage`/`retryable`) — rag-api's reads and persisted schema are not changed.
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- Prefer retaining the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- Prefer not to introduce a structured error-code taxonomy (`error_code` values) in this fix.

Non-goals (out of scope):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here; deferred).

## Version bump

- **rag-worker-service:** patch-level behavior change (failure payload keys, stage tracking, retryable derivation). No public HTTP API surface changes; the status-topic message gains keys inside `details`.
- **rag-api-service:** no version bump — its failed-branch reads and persisted schema are unchanged by design; the FastAPI `version` string stays as is.
- **Firestore schema:** no change — `schema_version` remains 2; no migration or backfill.
- **Tests:** additive — new contract test(s) under `apps/ai-server/tests/integration`; no existing test contract is relaxed.

## Deferred items

- The companion D3 issue referenced by the Objective — its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is out of this cycle.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes only from the Objective text.
- Dropping the legacy `error` key from the worker's failure payload — deferred until a consumer audit confirms the worker is the only publisher and rag-api the only consumer of the status topic; removal is trivial cleanup afterwards.
- A structured error-code taxonomy / failure taxonomy (`error_code` values beyond the existing "UNKNOWN" default) — explicitly not in this fix.
- Widening `classify_error`'s heuristics to reclassify unrecognized-but-transient failures — out of scope; `retryable: false` for unclassified-unknown errors is accepted, with manual reprocess via `POST /process` unaffected.
- Retry/backoff mechanics (ACK/NACK policy, processing leases, heartbeat intervals), the stale-lease sweep's behavior, and any frontend/mobile work — all out of scope.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>