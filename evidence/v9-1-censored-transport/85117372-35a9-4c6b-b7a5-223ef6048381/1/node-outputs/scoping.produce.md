<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle aligns the rag-worker's failure status payload with the contract rag-api's failed branch already reads, and locks the seam with a contract test. Verified against the tree during scoping:

- **`apps/ai-server/rag-worker-service/main.py` — failure payload.** `process_document`'s exception handler currently publishes status `"failed"` with details `{"error": str(e)}`. It will instead publish details carrying:
  - `error_message` — the actual exception message (`str(e)`);
  - `stage` — the pipeline stage executing at failure time;
  - `retryable` — deliberately derived from `classify_error(e)`: transient-classified → `true`; permanent-classified, including unclassified-unknown (per `classify_error`'s conservative default) → `false`;
  - the legacy `error` key retained alongside `error_message` (same string) as a hedge for unknown consumers of the status topic.
- **`apps/ai-server/rag-worker-service/main.py` — stage tracking.** A stage tracker in `process_document`, set immediately before each awaited pipeline step, so the failure handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary (verified in the `_publish_status_update` calls): `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`; `"processing"` is the safe value when the stage is genuinely unknown — the same value the stale-lease sweep (`_fail_if_still_stale`) writes to `error_stage`, so the field never regresses to null.
- **`apps/ai-server/rag-api-service/main.py` — no runtime change required.** `run_transactional_update`'s failed branch already reads `error_message`/`stage`/`retryable` (with fallbacks `"Processing failed"` / None / `True`) and persists `error`/`error_stage`/`retryable` on the main document plus `message`/`stage` (with `code` defaulting to `"UNKNOWN"`) into `processing/summary`. The requirement is that it persists worker-provided values unchanged; the fallbacks must never be operative for worker-originated failures.
- **Contract test under `apps/ai-server/tests/integration/`.** Exercises the worker's failure-payload construction through rag-api's `run_transactional_update` failed-branch persistence (Firestore emulator or fakes), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and includes a key-set drift guard on both sides' payload keys. Placement (extend `test_api_contracts.py` vs. a sibling module following its fixture/AST patterns) is an implementation choice.

Files in scope: `apps/ai-server/rag-worker-service/main.py` and a contract test under `apps/ai-server/tests/integration/`. rag-api runtime code is expected to be unchanged; any touch there is limited to what the contract test needs.

## Purpose

Every worker-originated failure currently lands in Firestore with fabricated values. The verified seam: the worker's exception handler publishes one key (`{"error": str(e)}`); rag-api's failed branch reads three (`error_message`, `stage`, `retryable`) and persists `details.get("error_message", "Processing failed")`, `details.get("stage")` (None), and `details.get("retryable", True)`. The `processing/summary` error subdocument inherits the same fallbacks, with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures, and `retryable` is silently defaulted instead of derived.

The worker is the odd writer out: the stale-lease sweep, rag-api's enqueue-failure paths (per the authoritative Definition), and the `Resource` model (verified: `error`, `error_stage`, `retryable` with `retryable` defaulting `True`) all already use the `error`/`error_stage`/`retryable` schema. Aligning the worker to the API means no Firestore migration, no field rename, no backfill, and no reader changes.

Acceptance outcomes for this cycle:
1. A failed job's published payload contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
2. After a failed job, the persisted resource document has `error` = the worker's actual message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
3. The `processing/summary` error subdocument carries the same message and stage as the main document.
4. A contract test covering the worker failure → rag-api persistence path exists and passes, failing if either side's payload keys drift.

## Requirements

Binding requirements (from the authoritative Definition, cross-checked against the tree):

1. **Payload completeness.** The worker's failed status payload must include `error_message` (actual exception message), `stage` (pipeline stage at failure time), and `retryable` (deliberately derived). It must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. Convention: set the tracker immediately before the awaited step.
3. **API persistence unchanged.** rag-api's failed branch persists worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument carries the same message and stage.
4. **retryable derivation.** Explicit and aligned with the worker's ACK/NACK behavior (verified: `run_worker` calls `classify_error(e)` — transient errors are omitted from `ack_ids` so Pub/Sub redelivers; permanent errors are acked): `classify_error` transient → `retryable: true`; permanent, including unclassified-unknown → `retryable: false`.
5. **Contract test.** Must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (Firestore emulator or fakes) and assert persisted `error`, `error_stage`, and `retryable` equal the worker's values; must fail if either side's payload keys drift. Verified setup constraint: `run_transactional_update`'s transition gate only allows `processing → failed`, so the test resource must be seeded in `processing` state before the failed update; `run_transactional_update` is a module-level function with an injectable db/doc_ref/logger, which supports the fakes-based approach.

Binding constraints:
- **Must:** align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`) — not change rag-api's reads or persisted schema.
- **Must not:** require a Firestore migration, field rename, or backfill; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must:** every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer:** retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling.
- **Prefer not:** introduce a structured error-code taxonomy (`error_code` values).

The failure payload flows through the existing `_publish_status_update` envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`, injected `jobId`) — that envelope is unchanged; only the failed-status `details` keys change.

## Boundaries

Out of scope (non-goals from the Definition):
- The stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (verified: `_fail_if_still_stale` writes `error_stage: "processing"`, `retryable: True`).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` (verified in the model and in the existing mobile contract expectations in `test_api_contracts.py`).
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here).

Accepted tradeoffs and risks (deliberate, per the Definition):
- Unclassified-unknown exceptions will now persist `retryable: false` (previously the silent default `true`). This matches `classify_error`'s conservative default and the worker's actual ACK behavior; the manual reprocess path remains available (per the Definition, via `POST /process`). Widening `classify_error` is out of scope.
- The legacy `error` key is retained as a compatibility hedge; residual risk from unknown status-topic consumers is accepted as low.
- Stage-tracker drift (a future pipeline step added without updating the tracker) is mitigated by the update-before-await convention and representative-stage test coverage (an early-stage and a late-stage failure), not by ossifying every step.
- The contract test intentionally ossifies the payload key set — that is the drift guard doing its job; adding a key later means touching the test.

## Version bump

- **rag-worker-service: minor.** Behavioral change to the published failure payload (new keys; `retryable` now derived, so unclassified failures persist `false` instead of the silent default `true`). No data migration or backfill required.
- **rag-api-service: none (patch at most).** No runtime code change is required by this scope; if any test-support or comment change lands, patch at most.
- The contract-test addition is test-infrastructure only and does not drive a service version bump.

Caveat preserved from scoping: no in-repo version constant for either service was read or verified during investigation; the classification above is by change semantics. Apply it through whatever versioning channel the repo uses (changelog entry / PR labeling).

## Deferred items

- **Companion D3 issue.** The Objective references a D3 issue filed alongside this one; its content is unavailable in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred (Definition fact F12, status DEFERRED).
- **plans/upload-flow.md D4 reconciliation.** The original analysis is in a file not present in the current tree; reconciling this cycle's analysis with that deviation note is deferred.
- **Structured error-code taxonomy.** Prefer-not per the Definition; `error.code` stays `"UNKNOWN"` unless a code is actually sent.
- **Dropping the legacy `error` key.** Future cleanup if a later audit confirms rag-api's status subscriber is the only consumer of the status topic.
- **Widening `classify_error` coverage.** Out of scope; the `retryable: false` outcome for unclassified errors is accepted.
- **Retry/backoff mechanics, sweep behavior, frontend work.** All out of scope as listed under Boundaries.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>