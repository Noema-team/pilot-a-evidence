<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle changes the rag-worker's failure reporting and adds one contract test. rag-api's failure handling is pinned, not changed.

**Changed — `apps/ai-server/rag-worker-service/main.py`:**
- `process_document` exception handler: the failed status payload published via `_publish_status_update` must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unverified consumers of the status topic.
- Stage tracking through `process_document`: a local stage tracker set immediately before each pipeline step and reported by the exception handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown — the same value the stale-lease sweep already writes for `error_stage`.
- `retryable` derivation from the existing `classify_error(e)`: transient-classified → `true`; permanent-classified, including unclassified-unknown (`classify_error`'s conservative default), → `false`. This mirrors the ACK/NACK decision `run_worker` already makes with the same function.

**Added — contract test under `apps/ai-server/tests/integration/`:**
- Follows the existing patterns in `test_api_contracts.py` (fixture- and AST-based static contract tests; both services support a hermetic Firestore-emulator mode per the authoritative Definition). The test imports both sides rather than restating the contract in a fixture: it builds the failure payload through the worker's code path, feeds it through rag-api's failed-branch persistence (`run_transactional_update`), and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It covers an early-stage and a late-stage failure and includes a key-set drift guard so a future edit to either side's payload keys fails the build.

**Pinned, unchanged — `apps/ai-server/rag-api-service/main.py` and `models/resource.py`:**
- rag-api's failed branch keeps reading `error_message`/`stage`/`retryable` from the status payload's details, persisting `error`/`error_stage`/`retryable` on the main resource document, and writing `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary subdocument. No reader or schema change; the worker aligns to this contract.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts and nothing tests the seam. The worker side is confirmed in source: `process_document`'s exception handler publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch, per the authoritative Definition, reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true`; the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

The goal: a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag, so users and support can disambiguate failures and the persisted record tells the truth about retry behavior — transient errors are ones Pub/Sub will redeliver; permanent errors were acked and remain reprocessable via `POST /process`. The fix direction is the worker aligning to rag-api's existing contract, because `error`/`error_stage`/`retryable` is already the established schema across the stale-lease sweep (`_fail_if_still_stale`), both enqueue-failure paths (`POST /process`, `POST /resources`), and the `Resource`/`ResourceResponse` models — the worker's status publisher is the only writer that doesn't speak it. No migration, no backfill, no reader changes. A contract test locks the seam so this drift cannot silently recur.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (actual exception message), `stage` (pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Binding constraints:
- Must align the worker to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- Must not require a Firestore migration, field rename, or backfill; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload must carry `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- Prefer retaining the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling.
- Prefer not to introduce a structured error-code taxonomy (`error_code` values) in this fix.

## Boundaries

Out of scope for this cycle:
- The stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract, and its `retryable: true` stays correct because a dead worker is a transient condition.
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any rag-api code change to reads or the persisted schema.
- Anything the companion D3 issue covers beyond this worker→rag-api failure payload alignment (see Deferred items).

Accepted behavior change: unclassified-unknown exceptions currently persist `retryable: true` (rag-api's silent default) but classify as permanent under `classify_error`; after this cycle they persist `retryable: false`. This is the conservatism `classify_error` was written for; the manual reprocess path (`POST /process`) is unaffected.

Known risks and mitigations:
- Unknown consumers of the status topic reading the old key set — mitigated by retaining the legacy `error` key; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the "set the tracker immediately before the await" convention and representative-stage (early + late failure) contract-test coverage.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job. Adding a key later means touching the test.

## Version bump

- No Firestore schema migration, field rename, or backfill is involved, so there is no data-version bump.
- `rag-api-service`: no code change is planned; its contract and persisted schema are unchanged, so no API version change (its FastAPI app version string is currently `1.0.0` and need not move).
- `rag-worker-service`: this is a patch-level behavioral fix to the published failure payload, including one deliberate semantic change (unclassified-unknown failures now persist `retryable: false` instead of the silent default `true`). No version file or bump mechanism for these services was verified during investigation, so this cycle mandates none; if the release process tracks per-service versions, treat the worker change as a patch bump.

## Deferred items

- The companion D3 issue referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`: that file is not present in the current tree (the reference comes from the Objective text), so no reconciliation is possible this cycle.
- Auditing consumers of the worker status topic and, if rag-api is confirmed as the sole consumer, dropping the legacy `error` key as trivial cleanup.
- Widening `classify_error` coverage for failure modes that are transient in practice but unrecognized by its heuristics (they will persist `retryable: false` until then; manual reprocess remains).
- A structured error-code taxonomy / failure taxonomy for the processing/summary error subdocument.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>