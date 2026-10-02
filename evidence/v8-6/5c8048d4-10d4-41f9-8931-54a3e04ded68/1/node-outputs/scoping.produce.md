<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
Cycle charter — run 5c8048d4-10d4-41f9-8931-54a3e04ded68, iteration 1, step scoping.produce
Intent: rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage
Authoritative scope source: WorkItem wi-define-108-a8 → artifact definition:obj-108 (sha256 71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5). This charter restates that scope; it does not widen, narrow, or reinterpret it.

## Scope

This cycle changes how the rag-worker reports failure, and adds the contract test that pins the worker→rag-api failure seam. Concretely, in scope:

- Worker failure payload (apps/ai-server/rag-worker-service/main.py, process_document exception handler): the failed status published via _publish_status_update must carry details keys error_message (the actual exception message), stage (the pipeline stage executing at failure time), and retryable (deliberately derived). The legacy `error` key is retained alongside error_message as a compatibility hedge for consumers of the status topic other than rag-api's subscriber (the only consumer verified to date).
- Stage tracking (same file, process_document): a stage tracker local set immediately before each pipeline step, reported by the exception handler. Stage names reuse the existing progress-update vocabulary verified in process_document — starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete — with "processing" as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep's _fail_if_still_stale writes to error_stage, so the field never regresses to null).
- retryable derivation (same file): retryable is derived from classify_error(e) — the same classification run_worker already uses for ACK/NACK decisions. Transient-classified → true; permanent-classified, including unclassified-unknown (classify_error's conservative default) → false.
- rag-api side (apps/ai-server/rag-api-service/main.py, run_transactional_update failed branch): no behavioral change. Its existing reads (error_message, stage, retryable) and persisted writes (error, error_stage, retryable on the main document; message/stage with error_code defaulting "UNKNOWN" in the processing/summary subdocument) are the contract the worker aligns to. That file is touched only if the new contract test exposes a defect inside the existing failed-branch logic.
- Contract test (apps/ai-server/tests/integration/, following the house pattern in test_api_contracts.py): a test covering the worker failure → rag-api persistence path. It must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator — both services have verified FIRESTORE_EMULATOR_HOST branches — or fakes), assert the persisted error, error_stage, and retryable equal the worker's values, and include a key-set drift guard so a future edit to either side's payload keys fails the build instead of silently re-creating this bug. Coverage must include at least an early-stage failure and a late-stage failure (representative stages pinning the tracker mechanism), not every pipeline step.

Files expected to change: apps/ai-server/rag-worker-service/main.py and a test module under apps/ai-server/tests/integration/ (plus fixtures if the emulator/fake pattern needs them). No other services, models, or infrastructure.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures. Today that never happens: the worker's exception handler publishes a one-key payload ({"error": str(e)}) while rag-api's failed branch reads three keys (error_message, stage, retryable), so every worker-originated failure persists the fallback string "Processing failed", a null error_stage, and a fabricated retryable: true — with the processing/summary error subdocument inheriting the same fallbacks and error_code always "UNKNOWN" (verified in both services' main.py).

The fix direction is deliberate, not just cheap: the persisted failure schema error/error_stage/retryable is already spoken by three other write paths (the worker's stale-lease sweep _fail_if_still_stale, rag-api's enqueue-failure paths in /process and POST /resources) and exposed by the Resource model and ResourceResponse. The worker's status publisher is the only writer that doesn't speak it — so the worker aligns to the API, not the reverse. That avoids any Firestore migration, field rename, or backfill, and leaves rag-api's readers and persisted schema untouched.

Deriving retryable from classify_error makes the persisted record tell the truth about retry behavior: a transient error is one Pub/Sub will redeliver (the worker NACKs), a permanent error was acked and will not return (manual reprocess via POST /process remains). One deliberate behavior change follows: unclassified-unknown exceptions currently persist retryable true via the silent default but classify permanent — they will now persist false, which is the conservatism classify_error was written for.

## Requirements

1. When document processing fails, the worker's failed status payload must include error_message (the actual exception message), stage (the pipeline stage executing at failure time), and retryable (deliberately derived). The payload must never rely on rag-api's fallback defaults ("Processing failed", null stage, retryable default true) for these keys.
2. The worker must track the currently executing pipeline stage through process_document so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete), with "processing" as the safe value when the stage is genuinely unknown. Convention: set the tracker immediately before each awaited pipeline step.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document error ← payload error_message, error_stage ← payload stage, retryable ← payload retryable; the processing/summary error subdocument must carry the same message and stage. (This is the branch's existing verified behavior; the requirement binds it as the contract — it does not authorize changes to it.)
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by classify_error → retryable true; classified permanent (including unclassified-unknown, per classify_error's conservative default) → retryable false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted error, error_stage, and retryable equal the worker's values; it must fail if either side's payload keys drift.

Acceptance outcomes this cycle must demonstrate:
- A failed job's published status message contains error_message, stage, and retryable — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has error = the worker's actual message (not "Processing failed"), error_stage = the failing stage (not None), and retryable = the worker's derived value.
- The processing/summary error subdocument carries the same message and stage as the main document.
- The contract test exists and passes, exercising worker payload construction through rag-api failed-branch persistence with the assertions above.

## Boundaries

Hard constraints (must / must_not):
- The worker aligns to rag-api's existing contract (publishing error_message/stage/retryable); rag-api's reads and persisted schema are not changed.
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields keep the names error, error_stage, retryable and their current semantics.
- Every worker-originated failure payload carries retryable explicitly; rag-api's details.get("retryable", True) fallback must not be the operative mechanism for worker failures.
- Retaining the legacy `error` key alongside error_message is preferred (compatibility hedge); dropping it is a follow-up, not this cycle.
- No structured error-code taxonomy is introduced (prefer_not): the processing/summary error.code remains "UNKNOWN" unless a code is actually sent.

Explicitly out of scope (non-goals):
- The stale-lease sweep's direct failure write (_fail_if_still_stale) — it already persists error/error_stage/retryable consistently with this contract (verified: error_stage "processing", retryable true) and is not touched.
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — ResourceResponse already exposes error and error_stage to clients.
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this worker→rag-api payload alignment (its content is unavailable in this context).

Known accepted risks (recorded decisions, not open questions): unknown consumers of the status topic reading the old key set (mitigated by retaining `error`; residual risk accepted as low); stage-tracker drift as the pipeline evolves (mitigated by the update-before-await convention and representative-stage test coverage); retryable=false for unclassified errors reducing auto-retry affordances for genuinely transient-but-unrecognized failures (accepted; manual reprocess via POST /process remains); the contract test ossifying the payload keys (intentional — that is the drift guard doing its job).

## Version bump

- Persisted schema: no version change. The change alters no persisted field names or shapes, so the schema_version: 2 marker already written by both the worker's claim path and rag-api's run_transactional_update stays at 2. No migration or backfill, by constraint.
- rag-api-service: no API-surface version change. Its response models (ResourceResponse et al.) and the FastAPI app version constant ("1.0.0", verified in rag-api-service/main.py) are untouched; the failed branch's behavior is pinned, not altered.
- rag-worker-service: behavior-level, patch-grade change (failure payload keys, stage tracking, retryable derivation). No version constant for the worker was observed in the reviewed source slices; if the release process requires one, treat this as a patch bump — no minor/major bump is warranted because no public interface or persisted schema changes.
- Contract test: new test code only; no versioning implications.

## Deferred items

- Companion D3 issue: the Objective references a D3 issue filed alongside this one; its scope is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred (Definition fact F12).
- plans/upload-flow.md deviation D4 reconciliation: the reference comes from the Objective text; that file is not present in the current tree, so reconciling this analysis with it is deferred until the file or its content is available.
- Dropping the legacy `error` key from the worker's failure payload: deferred pending an audit confirming the worker is the only publisher and rag-api the only consumer of the status topic. Trivial cleanup once confirmed.
- Structured error-code taxonomy (error_code values beyond the "UNKNOWN" default): deferred; explicitly a prefer_not for this cycle.
- Retry/backoff mechanics and widening classify_error's coverage (e.g. recognizing more transient exception types): deferred; only retryability reporting changes this cycle.
- Stale-lease sweep behavior changes: deferred; its writes already match the contract.
- Frontend/mobile work: none needed; ResourceResponse already exposes error and error_stage.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>