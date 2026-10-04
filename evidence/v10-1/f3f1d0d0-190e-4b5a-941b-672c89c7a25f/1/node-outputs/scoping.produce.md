<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle aligns the rag-worker's failure status payload with the contract rag-api's status subscriber already reads, and locks the worker→rag-api failure seam with a contract test. Three production-code changes, all in `apps/ai-server/rag-worker-service/main.py`, plus one new test module:

1. **Failure payload keys.** `process_document`'s exception handler currently publishes the failed status with details `{"error": str(e)}` (verified). It will instead publish details containing:
   - `error_message` — the actual exception message (`str(e)`);
   - `stage` — the pipeline stage executing at failure time (item 2);
   - `retryable` — deliberately derived from `classify_error(e)` (item 3);
   - `error` — the legacy key, retained alongside `error_message` with the same message, as a compatibility hedge for any unverified consumers of the `rag-status-updates` topic and existing log tooling.

2. **Stage tracking.** `process_document` is one large try block, so at failure time nothing knows where it was (verified). A local stage tracker will be set immediately before each pipeline step and reported by the exception handler. Stage names reuse the existing progress-update vocabulary the worker already publishes — `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` (all verified in `process_document`'s `_publish_status_update` calls) — with `"processing"` as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep already writes to `error_stage`).

3. **retryable derivation.** The worker sets `retryable` from its existing `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (classify_error's conservative default), → `false`. `classify_error` itself is not modified. This makes the persisted record agree with the worker's actual ACK/NACK behavior in `run_worker` (verified: transient → not acked → Pub/Sub redelivers; permanent → acked).

4. **Contract test.** A new test module under `apps/ai-server/tests/integration/` (suggested name `test_worker_failure_contract.py`; pattern per `test_api_contracts.py` and the existing `conftest.py`) that imports both sides rather than restating the contract in a fixture: it exercises the worker's failure-payload construction, feeds the payload through rag-api's `run_transactional_update` failed branch (Firestore emulator or fakes), and asserts the persisted main-document `error`, `error_stage`, and `retryable` equal the worker's values, plus the `processing/summary` error subdocument's `message` and `stage`. It includes a key-set drift guard on both sides so a future edit to either side's payload keys fails the build instead of silently re-creating this bug.

**rag-api-service is not expected to change.** Its failed branch in `run_transactional_update` already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main document, and writes `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument (verified). Once the worker sends the right keys, worker-provided values flow through unchanged; the contract test verifies this. If implementation reveals an adjustment is needed, it must stay within "persist the worker-provided values unchanged".

Verified testability notes for the implementer:
- rag-api's `run_transactional_update(db, doc_ref, new_status, details, logger, user_id)` is module-level and directly callable. Its `ALLOWED_TRANSITIONS` gate requires the fixture document to be in `processing` status before the failed update is applied (verified: `processing → {completed, failed}`; other transitions are rejected with no write).
- Worker `main.py` reads `GCP_PROJECT` (KeyError if absent) and `GOOGLE_APPLICATION_CREDENTIALS` at import time and constructs Pub/Sub clients at module level; it also imports heavy dependencies (langchain, openai, langfuse, spacy, sklearn, tiktoken, tenacity) that are not in the integration `conftest.py` mock list today. The test must satisfy these import-time requirements — the existing conftest already defaults `GCP_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS`; extend the mock list or ensure the dependencies are present in the test environment.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures. Today it cannot: the worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam.

The worker publishes `{"error": str(e)}`; rag-api's failed branch reads `error_message`, `stage`, and `retryable`, falling back to `"Processing failed"`, `None`, and `True` when the keys are missing (both verified). Every worker-originated failure therefore lands in Firestore as the fallback string, a null stage, and a fabricated `retryable: true`; the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

The fix direction is the worker aligning to rag-api's existing contract because the persisted schema (`error`/`error_stage`/`retryable`) is already consistent across every other write path: the worker's stale-lease sweep (`_fail_if_still_stale` writes `error` / `error_stage: "processing"` / `retryable: true`), rag-api's enqueue-failure path (verified in `POST /process`, which writes `error` / `error_stage: "enqueue"`), and the `Resource` model (`error`/`error_stage`/`retryable`, retryable defaulting `True`) and `ResourceResponse` (`error`/`error_stage`) that expose them to clients — all verified. The worker's status publisher is the only writer that doesn't speak the schema; fixing the odd one out requires no migration, no field rename, no backfill, and no reader changes.

Deriving `retryable` from `classify_error` makes the persisted record tell the truth about what will actually happen: a transient error is one Pub/Sub will redeliver (`retryable: true`); a permanent error was acked and will not come back (`retryable: false`; manual reprocess via `POST /process` remains). One deliberate behavior change follows: unclassified-unknown exceptions currently persist `retryable: true` via the silent default but classify as permanent, so they will now persist `false` — the conservatism `classify_error` was written for, preventing infinite retry loops. The stale-lease sweep's separate `retryable: true` write stays correct: a dead worker is a transient condition by nature.

The contract test exists because this bug is silent cross-service drift: each side was individually reasonable and only the seam was wrong. Pinning the payload key set in a test converts the next drift from a production data-quality bug into a build failure.

## Requirements

Binding requirements, carried from the authoritative definition:

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Implementation conventions:
- Set the stage tracker immediately before each awaited pipeline step in `process_document` ("update-before-await"). The contract test pins the mechanism on representative stages (an early-stage failure and a late-stage failure) rather than ossifying every step.
- Retain the legacy `error` key in the failure payload alongside `error_message` (same message string), per the compatibility hedge.
- Do not send `error_code` from the worker; the summary subdocument's `error.code` stays `"UNKNOWN"`.
- No changes to `_publish_status_update`'s envelope (`user_id`/`course_id`/`resource_id`/`status`/`details`/`timestamp`/`sequence`, job_id injection, lease-heartbeat write) — the fix is confined to the `details` the failure handler passes.

## Boundaries

Hard constraints (must / must_not):
- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload must carry `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. (The fallback itself stays in rag-api's code for non-worker publishers; it is simply never relied upon on this path.)

Preferences:
- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- Prefer not to introduce a structured error-code taxonomy (`error_code` values) in this fix.

Out of scope (non-goals):
- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context).

Accepted risks and tradeoffs:
- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- `retryable: false` for unclassified-unknown errors reduces auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope and manual reprocess via `POST /process` remains.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Version bump

No data migration, backfill, or schema change is required or permitted (see the must_not constraint in Boundaries), so no persistence-version bump applies.

Code-side: the production change lands in `rag-worker-service` only, plus a new integration test; `rag-api-service`'s failed branch already implements the read side and is expected to need no production change. The only version identifier verified in this cycle is the FastAPI app metadata `version="1.0.0"` in `rag-api-service/main.py`; since no rag-api code change is anticipated, no bump is proposed there. No version identifier was found for `rag-worker-service` in the verified evidence; if the team tracks service versions elsewhere (not verified in this cycle), treat this as a patch-level fix — a behavior correction with no change to persisted field names or API response shapes.

## Deferred items

- The companion D3 issue referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree (the reference comes from the Objective text).
- A structured error-code taxonomy / failure taxonomy (`error_code` values) — excluded by the prefer_not constraint; `error.code` remains `"UNKNOWN"`.
- Auditing other potential consumers of the `rag-status-updates` topic, and dropping the legacy `error` key once an audit confirms the worker is the only publisher and rag-api the only consumer (trivial cleanup afterward).
- Widening `classify_error`'s transient recognition (additional exception types or status codes) — out of scope; the `retryable: false` consequence for unclassified errors is accepted.
- Any retry/backoff mechanics work: ACK/NACK policy, processing leases, heartbeat intervals.
- Frontend/mobile exposure changes (`ResourceResponse` already carries `error`/`error_stage`).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>