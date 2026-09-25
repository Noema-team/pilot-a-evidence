## Scope

Align the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

Changed code:

- `apps/ai-server/rag-worker-service/main.py` — the only production code changed:
  - `process_document`'s exception handler publishes the failed status with `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived), retaining the legacy `error` key alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
  - A stage tracker through `process_document` is set immediately before each pipeline step (update-before-await convention) so the failure handler reports the true failing stage; stage names reuse the existing progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
  - `retryable` is derived from `classify_error(e)`: transient-classified errors map to `true`; permanent-classified errors, including unclassified-unknown per `classify_error`'s conservative default, map to `false` — aligned with the worker's existing ACK/NACK behavior in `run_worker`.
  - A small pure helper for failure-payload construction may be extracted in this file so the contract test can exercise the real construction path without instantiating the full processor.
- Contract test added under `apps/ai-server/tests/integration/` (new module alongside `test_api_contracts.py`, exact filename at implementer's discretion): it imports both sides rather than restating the contract in a fixture — builds the worker's failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` against the Firestore emulator or fakes, asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values (including the `processing/summary` error subdocument's message and stage), and includes a key-set drift guard on both the worker's payload keys and rag-api's read keys so a future edit to either side fails the build. It covers representative stages: an early-stage failure and a late-stage failure.

Not changed: `rag-api-service/main.py`'s failed branch and its reads (they already match this contract once the worker sends the keys — they are pinned by the test, not edited); the persisted schema (`error`, `error_stage`, `retryable` keep their names and semantics); the worker's stale-lease sweep; `ResourceResponse` and the `Resource` model.

## Purpose

A failed RAG processing job must persist the worker's actual error message and failing stage so users and support can disambiguate failures; retryable must be sent by the worker or derived deliberately, never silently defaulted. Today the worker publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch reads `error_message`/`stage`/`retryable`, so every worker-originated failure lands in Firestore as the fallback `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true` — with the `processing/summary` error subdocument inheriting the same fallbacks and `error_code` always `"UNKNOWN"`. The worker is the odd one out: the stale-lease sweep, rag-api's enqueue-failure paths, and both response models already speak the `error`/`error_stage`/`retryable` schema. This cycle fixes the odd one out — no migration, no backfill, no reader changes — and closes the seam with a contract test so the mismatch cannot silently recur.

## Requirements

- When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
- The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
- The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
- A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Acceptance for the cycle: a failed job's published status message carries all three keys; the persisted resource document has `error` = the worker's actual message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value; the `processing/summary` error subdocument carries the same message and stage; the contract test exists and passes.

## Boundaries

Constraints:

- **Must** — the worker aligns to rag-api's existing contract (publishing `error_message`/`stage`/`retryable`) rather than changing rag-api's reads or persisted schema.
- **Must not** — no Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must** — every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer** — retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **Prefer not** — no structured error-code taxonomy (`error_code` values) in this fix.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract, and its `retryable: true` stays correct because a dead worker is a transient condition by nature.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Widening `classify_error` to recognize more failure modes.

Accepted deliberate behavior change: unclassified-unknown exceptions previously persisted `retryable: true` (the silent default) but classify as permanent, so they will now persist `false`. This is the conservatism `classify_error` was written for; manual reprocess via `POST /process` remains available.

## Version bump

- rag-worker-service: no version marker exists in the service, so there is nothing to bump.
- rag-api-service: production code is not modified by this cycle; its FastAPI app version stays `1.0.0`. If implementation ends up touching `rag-api-service/main.py`, bump the app version `1.0.0` → `1.0.1` in the same change.
- No `schema_version` changes on documents, no dependency additions, no migration — this is a patch-level behavior fix internal to the worker→API seam.

## Deferred items

- The companion D3 issue referenced by the Objective: its content is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text only.
- Auditing other consumers of the rag-status topic and, if the worker is confirmed as the only publisher and rag-api the only consumer, dropping the legacy `error` key as trivial cleanup.
- Widening `classify_error` to recognize more genuinely-transient failure modes (persisting `retryable: false` for unclassified errors is accepted for this cycle).
- A structured error-code taxonomy or failure taxonomy.
- Any frontend or mobile work.