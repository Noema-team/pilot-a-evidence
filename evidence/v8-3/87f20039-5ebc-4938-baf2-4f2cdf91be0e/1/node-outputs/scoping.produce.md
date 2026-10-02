<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

Run: 87f20039-5ebc-4938-baf2-4f2cdf91be0e · Iteration: 1 · Step: scoping.produce
Authoritative source: define-work WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).

## Scope

In scope for this cycle:

1. **Worker failure payload fix** — `apps/ai-server/rag-worker-service/main.py`:
   - The `process_document` exception handler currently publishes the failed status with a one-key payload, `{"error": str(e)}` (verified in the handler's `_publish_status_update` call). It must instead publish `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived), while retaining the legacy `error` key alongside `error_message` as a compatibility hedge.
   - A stage tracker threaded through `process_document`: a local set immediately before each pipeline step and read by the exception handler, so the failure payload reports the true failing stage. Stage names reuse the existing progress-update vocabulary verified in `process_document`: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` (plus terminal `completed`), with `"processing"` as the safe value when the stage is genuinely unknown — the same value the worker's stale-lease sweep (`_fail_if_still_stale`) already writes to `error_stage` (verified in its transaction write).
   - `retryable` derived explicitly from the existing `classify_error(e)` function (verified at the top of `main.py`): transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown exceptions per `classify_error`'s conservative `return False`, → `false`.
2. **Contract test** — under `apps/ai-server/tests/integration/`, following the house pattern in `test_api_contracts.py` (verified: fixture- and AST-based static contract tests; both services' conftest stubbing/mocking patterns exist — `tests/integration/conftest.py` mocks rag-api's cloud deps and path-inserts `rag-api-service`; `rag-worker-service/tests/conftest.py` stubs heavy deps with env defaults). The test must:
   - Build the worker's failure payload through the worker's own code path (not a restated fixture), feed it through rag-api's `run_transactional_update` failed branch (verified in `rag-api-service/main.py`: reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`; persists `error`/`error_stage`/`retryable` on the main document and `error.code`/`error.message`/`error.stage` into the `processing/summary` subdocument) against the Firestore emulator or fakes.
   - Assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and that the `processing/summary` error subdocument carries the same message and stage.
   - Include a key-set drift guard so a future edit to either side's payload keys fails the build.
   - Cover representative stages: at least one early-stage failure and one late-stage failure, pinning the stage-tracker mechanism without ossifying every step.
3. **rag-api-service** — no reader or persisted-schema changes. Its failed branch already reads and persists the contract keys (verified directly). It is touched only if the contract test requires an importability shim; any such touch is test-support, not behavior change.

Expected changed files: `apps/ai-server/rag-worker-service/main.py`; new or extended test file(s) under `apps/ai-server/tests/integration/`. Everything else is out of scope (see Boundaries).

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. Verified mechanics of the break:

- Worker side: the `process_document` exception handler publishes `failed` status with details `{"error": str(e)}` — no `error_message`, no `stage`, no `retryable`.
- API side: `run_transactional_update`'s failed branch reads `error_message`, `stage`, and `retryable` from the payload details and persists them as `error`, `error_stage`, and `retryable` on the main resource document, with fallbacks `"Processing failed"`, `None`, and `True` respectively; the `processing/summary` error subdocument inherits the same fallback message and stage, with `error_code` defaulting to `"UNKNOWN"`.
- Net effect today: every worker-originated failure lands in Firestore as the fabricated string "Processing failed", a null stage, and a silently defaulted `retryable: true` — users and support cannot disambiguate what failed or where.

Why the worker aligns to the API rather than the reverse: the persisted failure schema `error`/`error_stage`/`retryable` is already the established convention across the other write paths — the worker's stale-lease sweep `_fail_if_still_stale` writes exactly those fields (verified: `error_stage: "processing"`, `retryable: True`), and the `Resource` model in `rag-api-service/models/resource.py` exposes `error`, `error_stage`, and `retryable` (default `True`) through `to_dict`/`from_dict` (verified). The worker's status publisher is the only writer that doesn't speak this schema. Fixing the odd one out requires no Firestore migration, no field rename, no backfill, and no reader changes.

Why `retryable` is derived rather than defaulted: the worker already classifies every exception via `classify_error()` (verified: explicit `TransientError`/`PermanentError` types, transient exception types such as `httpx.ConnectError`/timeouts, transient HTTP status codes 429/500/502/503/504, and a conservative `return False` for unknown exceptions), and that classification drives ACK/NACK in `run_worker` (verified: transient → omitted from `ack_ids` so Pub/Sub redelivers; permanent → acked). Deriving `retryable` from the same function makes the persisted record tell the truth about what will actually happen. One deliberate behavior change follows: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent, so they will now persist `false` — that is the conservatism `classify_error` was written for, and manual reprocess via `POST /process` is unaffected. The stale-lease sweep's separate `retryable: true` write stays correct: a dead worker is a transient condition by nature.

Compatibility hedge: only rag-api's status subscriber (`_process_status_message` → `run_transactional_update`) was verified as a consumer of these payloads; other tooling may share the status topic. The worker retains the legacy `error` key alongside `error_message` — one redundant string per failure message as insurance against an unknown reader.

The whole alignment is locked in by a contract test on the worker→rag-api failure path, so this class of drift fails the build instead of shipping silently.

## Requirements

1. **Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for these keys. The legacy `error` key is retained alongside `error_message`.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Convention: set the tracker immediately before each awaited pipeline step. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **API-side pass-through.** rag-api's failed branch persists the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument carries the same message and stage (its `code` remains `"UNKNOWN"` unless a code is actually sent).
4. **Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent, including unclassified-unknown per `classify_error`'s conservative default → `retryable: false`.
5. **Contract test.** A test covering the worker failure → rag-api persistence path must exist and pass: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence (via the Firestore emulator or fakes), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and fails if either side's payload keys drift. It must pin representative stages (early-stage and late-stage failure) to catch the stage tracker being removed or bypassed.

Acceptance checks for this cycle:

- A failed job's published status message contains `error_message`, `stage`, and `retryable`, none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual message (not "Processing failed"), `error_stage` = the failing stage (not None), `retryable` = the worker's derived value.
- The `processing/summary` error subdocument carries the same message and stage as the main document.
- The contract test exists, passes, and enforces the key set on both sides.

## Boundaries

Hard constraints (must / must-not):

- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

Preferences (prefer / prefer-not):

- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — `_fail_if_still_stale` already persists `error`/`error_stage`/`retryable` consistently with this contract (verified).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context).

Known, accepted tradeoffs within scope: stage-tracker drift as the pipeline evolves (mitigated by the set-before-await convention and representative-stage test coverage); `retryable: false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures (accepted; widening `classify_error` is out of scope and manual reprocess remains); the contract test intentionally ossifies the payload key set — that is the drift guard doing its job.

## Version bump

- **rag-worker-service: patch bump.** This is a behavior fix in failure reporting; no new capability surface.
- **rag-api-service: no bump expected.** Its failed branch already implements the contract (verified); no behavior change is planned. Bump only if implementation forces a touch, and then patch.
- **Tests (`apps/ai-server/tests/integration/`):** test-only addition; no versioned artifact.

Honesty note: the only version marker directly verified in the read portions of the tree is the FastAPI app literal `version="1.0.0"` in `rag-api-service/main.py`; no dedicated version file or changelog was verified for rag-worker-service. The charter fixes the bump *level* (patch); the exact location of version markers, if any exist beyond the FastAPI literal, is an implementation detail to confirm during build.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`**: that file is not present in the current tree (the reference comes from the Objective text); deferred until the file or its successor is available.
- **Dropping the legacy `error` key** from the worker's failure payload: future cleanup if an audit confirms the worker is the only publisher and rag-api's status subscriber the only consumer.
- **Widening `classify_error` coverage** (e.g., recognizing more transient-but-unrecognized failure modes): out of scope here; the conservative permanent classification stands.
- **Structured error-code taxonomy / failure taxonomy**: explicitly not introduced by this fix; deferred as a possible future enhancement.
- **Retry/backoff mechanics, sweep behavior, and frontend work**: out of scope per Boundaries; listed here for visibility that they were considered and consciously excluded, not merely postponed.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>