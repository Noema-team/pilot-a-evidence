I've verified the repository evidence backing the Definition: the worker's `classify_error()` conservative-permanent default, the existing fixture/AST-based contract-test patterns in `tests/integration/test_api_contracts.py`, and the service layout. The charter below is written strictly within the authoritative Definition's bounds — no widening (no rag-api reader changes, no schema migration, no error-code taxonomy) and no narrowing (stage tracking, explicit retryable derivation, legacy `error` key retention, and the worker→rag-api contract test are all included).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract mismatch

## Scope

This cycle fixes the contract mismatch between the RAG worker's failure status publisher and rag-api's failed-branch consumer. Today the worker's `process_document` exception handler publishes a one-key payload (`{"error": str(e)}`) while rag-api's `run_transactional_update` failed branch reads `error_message`, `stage`, and `retryable` — so every worker-originated failure persists the fallback string "Processing failed", a null `error_stage`, and a silently-defaulted `retryable: true`, with the same fallbacks inherited by the processing/summary error subdocument (`error_code` always "UNKNOWN").

In scope:

1. **Worker payload alignment.** The worker's failed status payload is published with the keys rag-api already reads: `error_message` (the actual exception message), `stage` (the failing pipeline stage), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unverified consumers of the status topic.
2. **Stage tracking in `process_document`.** The worker tracks the currently executing pipeline stage via a stage tracker set immediately before each pipeline step, so the failure handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. The safe value `"processing"` is used when the stage is genuinely unknown (e.g. failure before the first transition), matching the stale-lease sweep's convention so `error_stage` never regresses to null.
3. **Explicit retryable derivation.** The worker derives `retryable` from its existing `classify_error()`: transient-classified errors → `retryable: true`; permanent-classified errors, including unclassified-unknown exceptions (per `classify_error`'s conservative default) → `retryable: false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker` (transient = Pub/Sub will redeliver; permanent = acked, manual reprocess via `POST /process` remains available).
4. **rag-api persistence (unchanged behavior, verified).** rag-api's failed branch persists the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage, with `error_code` remaining "UNKNOWN" unless a code is actually sent. No reader changes and no schema changes are made — the persisted field names (`error`, `error_stage`, `retryable`) and their semantics are preserved exactly.
5. **Contract test.** A contract test covering the worker failure → rag-api persistence path, following the existing fixture- and AST-based patterns in `apps/ai-server/tests/integration/test_api_contracts.py`. It imports both sides rather than restating the contract in a fixture: it exercises the worker's failure-payload construction, feeds it through rag-api's failed-branch persistence (via the Firestore emulator or fakes, using the services' existing `FIRESTORE_EMULATOR_HOST` hermetic branches), and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It includes a key-set drift guard so a future edit to either side's payload keys fails the build instead of silently re-creating this bug, and pins the stage-tracking mechanism on representative stages (an early-stage failure and a late-stage failure) rather than ossifying every pipeline step.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures — locked in by a contract test on the worker→rag-api failure path.

The worker is the only writer of failure data that does not speak the established `error`/`error_stage`/`retryable` schema: the worker's stale-lease sweep, rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse` all already use it. Aligning the worker to rag-api's existing contract (rather than changing rag-api's reads or the persisted schema) requires no Firestore migration, field rename, or backfill of existing documents, and touches the smallest possible surface.

The retryable derivation makes the persisted record tell the truth about retry behavior. One deliberate behavior change falls out: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent under `classify_error`, so they will now persist `false`. This is the conservatism `classify_error` was written for — it prevents infinite retry loops — and the manual reprocess path is unaffected. The stale-lease sweep's separate direct write of `retryable: true` stays correct because a dead worker is a transient condition by nature.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → retryable true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → retryable false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

## Boundaries

Must constraints:

- The worker must be aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- Every worker-originated failure payload must carry `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

Must-not constraints:

- The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.

Prefer constraints:

- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.

Accepted risks and tradeoffs:

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- `retryable=false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope, and manual reprocess remains.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Version bump

No release version bump is specified by the Definition or required by this scope. The change is confined to two service source files (`rag-worker-service/main.py`, `rag-api-service/main.py` if verification-only adjustments are needed) plus a new contract test under `apps/ai-server/tests/integration/`; no persisted schema, API surface, or configuration contract changes warrant a version increment. If the repository's release process requires a patch bump for any service-code change, the smallest applicable bump (patch) is the default — but no version field, changelog entry, or release artifact is in scope per the Definition.

## Deferred items

- The companion D3 issue referenced by the Objective is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text only.
- Dropping the legacy `error` key from the worker's failure payload once a consumer audit confirms the worker is the only publisher and rag-api the only consumer of the status topic — trivial cleanup if that audit happens later.
- Widening `classify_error` to recognize additional transient exception types (e.g. genuinely transient-but-unrecognized failures currently classified permanent) — out of scope; manual reprocess via `POST /process` remains available.
- Any structured error-code taxonomy or failure classification beyond what already exists.
- Frontend/mobile surfacing changes — `ResourceResponse` already exposes `error` and `error_stage`.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>