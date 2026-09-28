<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
Cycle Charter — rag-worker → rag-api failure payload contract alignment

Run 6780aa46-4497-4d73-8b00-182b5265b40b · Iteration 1 · Step scoping.produce
Source of truth: WorkItem wi-define-108-a8 (artifact definition:obj-108, sha256 71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5). This charter restates that Definition's bounded scope; it does not widen, narrow, or reinterpret it. Repository claims below were verified in source this cycle; assumptions and unknowns are labeled as such.

## Scope

Three touch points, all serving one contract:

1. **rag-worker-service failure payload** (`apps/ai-server/rag-worker-service/main.py`). Verified: `process_document`'s exception handler publishes the failed status with details `{"error": str(e)}` via `_publish_status_update`. In scope: rebuild that failure payload to carry
   - `error_message` — the actual exception message,
   - `stage` — the pipeline stage executing at failure time,
   - `retryable` — deliberately derived from `classify_error(e)` (transient → true; permanent, including the conservative unknown-exception default → false),
   - the legacy `error` key retained alongside `error_message` as a compatibility hedge, because the only verified consumer is rag-api's status subscriber and other topic readers are unverified.

2. **Stage tracking in `process_document`** (same file). Verified: the function is one large try block and the failure handler has no stage information; the progress updates publish the stage vocabulary `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`. In scope: a stage tracker set immediately before each pipeline step (the update-before-await convention) so the failure handler reports the true failing stage, with `"processing"` as the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage` (verified in `_fail_if_still_stale`).

3. **Contract test: worker failure → rag-api persistence.** In scope: a test that exercises the worker's failure-payload construction through rag-api's `run_transactional_update` failed branch (Firestore emulator or fakes), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and adds a key-set drift guard so an edit to either side's payload keys fails the build. Verified enablers: the fixture- and AST-based contract-test patterns in `apps/ai-server/tests/integration/test_api_contracts.py`; `FIRESTORE_EMULATOR_HOST` branches in both services' `main.py`; worker test tree exists (`tests/unit/` populated, `tests/integration/` present but empty).

**rag-api-service production code: no changes required.** Verified: its failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main document, plus `code` (default `"UNKNOWN"`), `message`, and `stage` in the `processing/summary` error subdocument. The worker is the misaligned side; rag-api enters this cycle only through the contract test that pins its behavior.

Verified context the implementation sits on:
- rag-api failed-branch fallbacks today: `error` = `"Processing failed"`, `error_stage` = `None`, `retryable` = `True` — exactly what worker failures currently persist.
- `ALLOWED_TRANSITIONS` admits `failed` only from `processing` — the contract test must place the resource in `processing` status before the failed update.
- `classify_error` returns true for `TransientError` and transient types (connection/timeout errors, HTTP 429/500/502/503/504), false for `PermanentError`, other 4xx, and — conservatively — unknown exceptions; `run_worker` uses the same classification for ACK/NACK.
- `_fail_if_still_stale` already writes `error` / `error_stage: "processing"` / `retryable: True` directly and is consistent with the contract.
- `models/resource.py` `Resource` exposes `error`, `error_stage`, `retryable` (default True); the existing contract tests already pin `error`/`error_stage` on `ResourceResponse`.

## Purpose

Every worker-originated failure currently persists garbage: because the worker publishes a one-key payload against rag-api's three-key contract, every failure lands in Firestore as the fallback string "Processing failed", a null stage, and a fabricated `retryable: true` — with the `processing/summary` error subdocument inheriting the same fallbacks and `error_code` always "UNKNOWN". Users and support cannot disambiguate failures, and the persisted retryable flag does not reflect the worker's actual ACK/NACK decision.

This cycle makes a failed RAG processing job persist the truth — the worker's actual error message, the failing pipeline stage, and a retryable flag deliberately derived from the same classification that drives retry behavior — and locks the seam with a contract test so neither side's payload keys can drift silently again.

## Requirements

Restated from the authoritative Definition (binding, unchanged):

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

## Boundaries

Must/must-not/prefer constraints and non-goals, from the Definition:

- **The worker aligns to rag-api, not the reverse.** No changes to rag-api's reads or persisted schema; no Firestore migration, field rename, or backfill — the persisted fields `error`, `error_stage`, `retryable` keep their names and semantics.
- **The API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures** — every worker-originated failure payload carries `retryable` explicitly.
- **Stale-lease sweep untouched** — `_fail_if_still_stale`'s direct failure write already persists `error`/`error_stage`/`retryable` consistently with this contract; its `retryable: true` stays correct because a dead worker is a transient condition.
- **Retry/backoff mechanics untouched** — Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals change nothing; only the *reporting* of retryability changes.
- **No frontend or mobile changes** — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **No structured error-code taxonomy** — the `processing/summary` error `code` remains `"UNKNOWN"` unless a code is actually sent; no `error_code` values are introduced.
- **Retain the legacy `error` key** in the worker's failure payload alongside `error_message` (prefer-constraint; one redundant string per failure as insurance for unverified topic consumers and log tooling).
- **Contract-test ossification is intentional** — adding a payload key later means touching the test; that is the drift guard doing its job.

Accepted tradeoff, deliberate: unclassified-unknown exceptions will now persist `retryable: false` instead of the silent default `true`. That is `classify_error`'s conservatism applied to persistence; it prevents fabricated auto-retry affordances, and manual reprocess via `POST /process` is unaffected. Widening `classify_error` is out of scope.

## Version bump

- **rag-worker-service: patch.** Bug fix to the failure-reporting contract; no new worker-facing surface. The `retryable: false` behavior for unclassified errors is a correction of a silently fabricated default, not a feature.
- **rag-api-service: none.** No production code change is required or planned; its failed branch already implements the contract. Only test additions reference it.
- **Shared tests (`apps/ai-server/tests/…`): n/a** — test-only additions carry no runtime version.

Unverified: whether the repo tracks a monorepo-level version or changelog that must also move — no such file was verified this cycle. If one exists, treat this cycle as a patch there too.

## Deferred items

- **Companion D3 issue** referenced by the Objective — its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle (Definition fact F12, DEFERRED).
- **Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`** — verified this cycle that the repo's `plans/` directory contains no `upload-flow.md`; the reference exists only in the Objective text. Reconciliation is deferred until that file or its successor reappears.
- **Dropping the legacy `error` key** from the worker's failure payload — trivial cleanup after a consumer audit confirms rag-api's status subscriber is the only reader of the status topic; not this cycle.
- **Widening `classify_error`** to recognize more transient conditions — out of scope; the conservative unknown→permanent default stands.
- **Structured error codes / failure taxonomy** — prefer-not per the Definition; revisit only if a consumer need emerges.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>