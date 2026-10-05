The authoritative definition is fully pinned in the task, and I've verified the referenced seams exist (`apps/ai-server/rag-worker-service/main.py`, `apps/ai-server/tests/integration/test_api_contracts.py`). Producing the cycle charter scoped strictly to that definition.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

## Scope

This cycle aligns the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

In scope:

1. **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler via `_publish_status_update`): publish `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic (constraint: prefer).
2. **Stage tracking** in `process_document`: a stage tracker set immediately before each pipeline step, reported by the exception handler. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **retryable derivation** from `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's ACK/NACK behavior in `run_worker`.
4. **rag-api failed branch** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update`): verified to persist worker-provided values unchanged — main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage. No reader or schema changes; the API side is the fixed contract.
5. **Contract test** in `apps/ai-server/tests/integration/` (following the existing `test_api_contracts.py` fixture/AST patterns): exercise the worker's failure-payload construction through rag-api's failed-branch persistence (Firestore emulator or fakes), assert persisted `error`, `error_stage`, and `retryable` equal the worker's values, and include a key-set drift guard that fails the build if either side's payload keys drift. Coverage pins the mechanism on representative stages (an early-stage failure and a late-stage failure).

Out of scope: everything not listed above, and in particular the items under Boundaries and Deferred items below.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts and nothing tests the seam. The worker's exception handler publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker failure therefore lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true` — so users and support cannot disambiguate failures, and the persisted retryability is a silent default rather than a decision.

The purpose of this cycle is to make a failed job's persisted record tell the truth: the actual error message, the stage that failed, and a retryable flag deliberately derived from the worker's own error classification and consistent with its ACK/NACK retry behavior. The direction is to align the worker (the odd one out) to rag-api's established `error`/`error_stage`/`retryable` persisted schema — already used consistently by the worker's stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource` model / `ResourceResponse` — because that avoids any schema migration, field rename, or backfill.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → retryable `true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → retryable `false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Acceptance criteria (from the Definition, all must be met):

- A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The processing/summary error subdocument for the failed job carries the same message and stage as the main document.
- A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift.

## Boundaries

Musts:

- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.

Must-nots:

- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload must carry `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

Preferences:

- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix; the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.

Explicit non-goals (from the Definition):

- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract; its `retryable=true` write stays correct (a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment.

Known behavior change accepted within scope: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent, so they will now persist `false`. This is the conservatism `classify_error` was written for; manual reprocess via `POST /process` remains unaffected.

## Version bump

Patch-level service change confined to `apps/ai-server` (`rag-worker-service`, `rag-api-service` test coverage only — no API behavior change on the rag-api side). No new public API surface, no schema change, no migration; existing consumers of `ResourceResponse` are unaffected. Bump the affected service patch version(s) per the repo's existing per-service versioning convention; no major or minor bump is warranted.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling this analysis with deviation D4 in `plans/upload-flow.md`**: that file is not present in the current tree; the reference comes only from the Objective text and is deferred.
- **Dropping the legacy `error` duplicate key**: if a later audit confirms the worker is the only publisher and rag-api's status subscriber the only consumer, removing the redundant key is trivial cleanup — deferred, not part of this cycle.
- **Widening `classify_error`** to recognize more transient conditions (reducing `retryable=false` for genuinely transient-but-unrecognized failures) — out of scope; manual reprocess remains.
- **Stage-tracker drift hardening beyond representative stages**: the contract test pins the mechanism on an early-stage and a late-stage failure rather than ossifying every pipeline step; broader per-step pinning is deferred to the "set the tracker immediately before the await" convention.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>