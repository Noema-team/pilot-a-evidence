I've verified the Definition's repository claims against the current tree before scoping: the worker's `process_document` exception handler publishes `{"error": str(e)}` (`apps/ai-server/rag-worker-service/main.py`), rag-api's `run_transactional_update` failed branch reads `error_message`/`stage`/`retryable` with the "Processing failed" fallback (`apps/ai-server/rag-api-service/main.py`), the stale-lease sweep and enqueue-failure paths already write `error`/`error_stage`/`retryable`, `classify_error`/ACK-NACK exist as described, and the contract-test pattern lives in `apps/ai-server/tests/integration/test_api_contracts.py`. The charter below restates the authoritative Definition without widening or narrowing it.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
Cycle Charter — rag-worker → rag-api failure payload contract alignment

## Scope

This cycle aligns the rag-worker's failed-status payload with rag-api's failed-branch contract, so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag. Change is concentrated in the worker; rag-api's reads and persisted schema are untouched.

**Code change — `apps/ai-server/rag-worker-service/main.py`**

- **Failure payload.** The `process_document` exception handler stops publishing the one-key `{"error": str(e)}` payload. The failed status payload must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic.
- **Stage tracking.** `process_document` tracks the currently executing pipeline stage (a local set immediately before each pipeline step — the "update before the await" convention) so the exception handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. `"processing"` is the safe value when the stage is genuinely unknown (e.g. failure before the first transition), matching the stale-lease sweep's `error_stage` value so the field never regresses to null.
- **retryable derivation.** `retryable` is derived from the existing `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (which `classify_error` conservatively treats as permanent) → `false`. This aligns the persisted record with `run_worker`'s ACK/NACK behavior. Known deliberate behavior change: unclassified-unknown failures flip from the silent default `true` to `false`; manual reprocess via `POST /process` is unaffected.

**Contract test — `apps/ai-server/tests/integration/`**

- A contract test covering the worker failure → rag-api persistence path, following the existing fixture-/AST-based house pattern in `test_api_contracts.py` (new test module or added class in that directory — final file choice is an implementation detail within the integration tests). It must import both sides rather than restate the contract in a fixture: build the failure payload through the worker's code path (extracting a small importable payload-builder helper from the exception handler so the handler and the test share the code is in scope), feed it through rag-api's `run_transactional_update` against the Firestore emulator or fakes, and assert the persisted `error`, `error_stage`, and `retryable` on the main document equal the worker's values, plus the message/stage in the `processing/summary` error subdocument.
- A key-set drift guard: the test fails if either side's payload keys drift. Coverage pins representative stages (an early-stage failure and a late-stage failure) so the stage tracker being removed or bypassed fails the build, without ossifying every pipeline step.

**Unchanged**

- rag-api-service source (reads, `run_transactional_update`, persisted fields `error`/`error_stage`/`retryable`, `processing/summary` subdocument shape, endpoints, `ResourceResponse`).
- No Firestore migration, field rename, or backfill; `schema_version` stays 2.
- The stale-lease sweep's direct failure write (already contract-consistent); Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. Today every worker-originated failure persists into Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — because the worker publishes `{"error": str(e)}` while rag-api reads `error_message`, `stage`, and `retryable` (`details.get(...)` fallbacks). The `processing/summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures, and the persisted retryability does not reflect the worker's actual ACK/NACK decision.

The fix direction is deliberate: `error`/`error_stage`/`retryable` is already the established persisted failure schema — the worker's stale-lease sweep, rag-api's enqueue-failure paths (`/process`, `POST /resources`), and the `Resource` model / `ResourceResponse` all use it. The worker's status publisher is the only writer that doesn't speak it, so the worker aligns to the API. No migration, no backfill, no reader changes. A contract test then locks the seam so a future key edit on either side fails the build instead of silently re-creating this bug.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument carries the same message and stage (this holds with zero rag-api changes once the worker sends the right keys).
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `false`.
5. A contract test must cover the worker failure → rag-api persistence path: it exercises the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

**Acceptance criteria (from the authoritative Definition, all currently unmet):**

- A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
- A contract test covering the worker failure → rag-api persistence path exists and passes, exercising the worker's failure-payload construction through rag-api's failed-branch persistence and asserting the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift.

## Boundaries

**Hard constraints**

- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema. (must)
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields `error`, `error_stage`, `retryable` keep their names and semantics. (must_not)
- Every worker-originated failure payload must carry `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. (must)
- The worker retains the legacy `error` key in its failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling. (prefer)
- No structured error-code taxonomy (`error_code` values) is introduced in this fix. (prefer_not)

**Out of scope (non-goals)**

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains "UNKNOWN" unless a code is actually sent; widening `classify_error` is likewise out of scope.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here; deferred — see Deferred items).

**Accepted risks / tradeoffs**

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- `retryable=false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; manual reprocess via `POST /process` remains.
- The contract test ossifies the payload — intentional; the drift guard is the point. Adding a key later means touching the test.

## Version bump

Patch-level fix. No user-facing version artifact is edited in this cycle:

- `rag-worker-service` declares no in-repo version constant; its behavioral change ships as a patch-level image rebuild through the existing CI pipeline.
- `rag-api-service` is not modified, so its FastAPI version string (`1.0.0`) is unchanged.
- No Firestore `schema_version` change (stays 2) and no new runtime dependencies. Validation via `./dev/run ai-server` per repo workflow; the contract test runs with the existing integration test setup.

## Deferred items

- **Companion D3 issue.** The Objective references a D3 issue filed alongside this one; its scope is not available in this context. Anything it covers beyond this worker→rag-api failure payload alignment is deferred.
- **`plans/upload-flow.md` deviation D4.** The original analysis reference (D4) points to a file not present in the current tree; reconciling this analysis with that note is deferred.
- **Dropping the legacy `error` key.** If a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic, removing the duplicate `error` key is trivial follow-up cleanup.
- **Structured error codes / failure taxonomy.** The `processing/summary` `error.code` stays "UNKNOWN" unless a code is actually sent; designing a taxonomy, or widening `classify_error` to recognize more transient failure modes, is future work.
- **Retry/backoff mechanics.** ACK/NACK policy, processing leases, and heartbeat intervals are untouched — only the reporting of retryability changes.
- **Stale-lease sweep behavior.** Its direct failure write already speaks the contract; no change.
- **Stage-tracker hardening beyond representative coverage.** The contract test pins the mechanism on an early-stage and a late-stage failure; exhaustive per-step stage assertions are not in this cycle.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>