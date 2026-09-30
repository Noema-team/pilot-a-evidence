The authoritative definition is fully resolved and pinned in the task context; I verified the repository evidence it cites (the worker's `classify_error`/exception-classification structure in `apps/ai-server/rag-worker-service/main.py` and the existing contract-test suite at `apps/ai-server/tests/integration/test_api_contracts.py`). Producing the cycle charter now, scoped exactly to the Definition — worker-side payload alignment, stage tracking, derived retryable, and a failure-path contract test — with no widening or narrowing.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract mismatch

## Scope

This cycle changes the worker's failure reporting and adds the contract test that pins the seam. It does **not** change rag-api's reads, persisted schema, or any other write path.

**In scope:**

1. **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler → `_publish_status_update`):
   - Publish `error_message` (the actual exception message), `stage`, and `retryable` in the failed status payload.
   - Retain the legacy `error` key alongside `error_message` as a compatibility hedge for unknown consumers of the status topic (constraint: prefer).
   - The payload must never rely on rag-api's `details.get(...)` fallback defaults.

2. **Stage tracking** (`process_document`):
   - Track the currently executing pipeline stage through the function body (set immediately before each pipeline step / `await`).
   - Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
   - `"processing"` is the safe value when the stage is genuinely unknown (same value the stale-lease sweep uses for `error_stage`); the field never regresses to null.

3. **retryable derivation** (worker):
   - `retryable` is derived explicitly from `classify_error(e)`: transient-classified → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`.
   - This aligns the persisted record with the worker's ACK/NACK behavior in `run_worker` (transient = Pub/Sub redelivers; permanent = acked, manual reprocess via `POST /process` remains).
   - Known deliberate behavior change: unclassified-unknown exceptions previously persisted the silent default `true`; they now persist `false`.

4. **rag-api failed branch** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update`):
   - No code change required by this cycle: the branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main document plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary subdocument. The cycle verifies — and the contract test pins — that worker-provided values persist unchanged.

5. **Contract test** (`apps/ai-server/tests/integration/test_api_contracts.py` suite, following its existing fixture/AST/hermetic patterns):
   - Cover the worker failure → rag-api persistence path: build the failure payload through the worker's actual code path, feed it through rag-api's failed-branch persistence (Firestore emulator or fakes), and assert persisted `error`, `error_stage`, and `retryable` equal the worker's values.
   - Include a key-set drift guard so a future edit to either side's payload keys fails the build.
   - Pin the stage-tracker mechanism on representative stages (an early-stage failure and a late-stage failure) — enough to catch the tracker being removed or bypassed without ossifying every step.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures. Today the worker publishes `{"error": str(e)}` while rag-api's failed branch reads `error_message`/`stage`/`retryable`, so every worker-originated failure lands in Firestore as the fallback `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true` — and nothing tests the seam. This cycle aligns the worker (the odd one out: the stale-lease sweep, rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse` all already speak `error`/`error_stage`/`retryable`) to that established contract, with no migration, no backfill, and no reader changes.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

**Acceptance criteria (from the Definition):**
- The worker's failed status message contains `error_message`, `stage`, and `retryable`, none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The processing/summary error subdocument carries the same message and stage as the main document.
- A contract test covering the worker failure → rag-api persistence path exists and passes, failing if either side's payload keys drift.

## Boundaries

**Must:**
- Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`) rather than changing rag-api's reads or persisted schema.

**Must not:**
- Require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.

**Must (explicitness):**
- Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

**Prefer:**
- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling.

**Prefer not:**
- Introduce a structured error-code taxonomy (`error_code` values) in this fix; the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.

**Out of scope (non-goals):**
- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract; its separate `retryable=true` write stays correct (a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy.
- Widening `classify_error`'s heuristics (the `retryable=false`-for-unclassified tradeoff is accepted; manual reprocess via `POST /process` remains).

## Version bump

**Minor.** Rationale: this is a bug-fix alignment with no schema migration or backfill, but it ships two user-visible behavior changes — failed jobs now persist the real message/stage instead of fallbacks, and unclassified-unknown errors flip from the silent `retryable: true` default to a derived `false`. A patch bump would undersell the persisted-data behavior change; a major bump is unwarranted since the persisted field names and API response shape are unchanged. No database migration accompanies the release.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred (Fact F12, DEFERRED).
- **Reconciling this analysis with deviation D4 in `plans/upload-flow.md`**: that file is not present in the current tree (the reference comes from the Objective text); deferred.
- **Dropping the legacy `error` key** from the worker's failure payload after a consumer audit confirms rag-api's status subscriber is the only consumer — trivial follow-up cleanup, not this cycle.
- **Structured error codes / failure taxonomy** — explicitly a prefer-not and non-goal for this cycle.
- **Widening `classify_error`** to recognize more transient failure modes (reducing the `retryable=false`-for-unclassified tradeoff) — out of scope.
- **Retry/backoff mechanics** (ACK/NACK policy, leases, heartbeats) and **stale-lease sweep behavior** — untouched.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>