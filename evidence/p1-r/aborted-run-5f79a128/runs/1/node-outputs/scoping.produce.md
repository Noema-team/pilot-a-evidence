The authoritative definition is fully specified and self-contained; the repository evidence it cites matches the code I inspected (`classify_error`, the exception-class hierarchy, and the worker/api layout). I have what's needed to produce the cycle charter.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle fixes the worker→rag-api failure payload contract mismatch for RAG document processing failures.

In scope:

1. **Worker failure payload alignment** — `apps/ai-server/rag-worker-service/main.py`: the `process_document` exception handler must publish a failed status payload containing `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
2. **Stage tracking in `process_document`** — a local stage tracker set immediately before each pipeline step, reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **Retryable derivation** — the worker derives `retryable` from `classify_error(e)`: transient-classified → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.
4. **rag-api failed-branch passthrough (verification only)** — `apps/ai-server/rag-api-service/main.py`'s `run_transactional_update` failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main document plus message/stage (with `error_code` defaulting to `"UNKNOWN"`) in the processing/summary subdocument. This branch is the contract target; no reader or schema changes are made to it.
5. **Contract test** — a worker failure → rag-api persistence contract test following the existing patterns in `apps/ai-server/tests/integration/test_api_contracts.py`: it exercises the worker's failure-payload construction, feeds it through rag-api's failed-branch persistence (via the Firestore emulator or fakes), and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must include a key-set drift guard so a future edit to either side's payload keys fails the build.

Out of scope (see Boundaries).

## Purpose

A failed RAG processing job currently persists garbage: the worker publishes `{"error": str(e)}`, but rag-api's failed branch reads `error_message`/`stage`/`retryable`. Every worker-originated failure therefore lands in Firestore with `error = "Processing failed"` (fallback), `error_stage = None`, and `retryable = True` (silent default), and the processing/summary error subdocument inherits the same fallbacks with `error_code = "UNKNOWN"`.

The purpose of this cycle is to align the worker — the only writer that doesn't speak the established `error`/`error_stage`/`retryable` schema (already used by the stale-lease sweep, rag-api's enqueue-failure paths, `ResourceResponse`, and the `Resource` model) — to rag-api's contract, so that:

- Users and support can disambiguate failures via the actual error message and failing stage.
- The persisted `retryable` flag tells the truth about whether Pub/Sub will redeliver (transient → `true`) or the job was acked with manual reprocess via `POST /process` remaining (permanent → `false`).
- The worker→rag-api failure seam is locked in by a contract test so the mismatch cannot silently re-emerge.

The fix requires no Firestore migration, field rename, or backfill: the persisted field names and semantics are unchanged; only the worker's published payload keys change.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.
6. The worker's failure payload must retain the legacy `error` key alongside `error_message` (compatibility hedge for unknown consumers of the status topic and log tooling).

## Boundaries

Must constraints:

- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.

Must-not constraints:

- The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.

Prefer / prefer-not:

- Prefer retaining the legacy `error` key in the worker's failure payload alongside `error_message`.
- Prefer not to introduce a structured error-code taxonomy (`error_code` values) in this fix.

Explicit non-goals:

- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Widening `classify_error`'s heuristics — the behavior change where unclassified-unknown errors now persist `retryable: false` (previously the silent `True` default) is accepted as intended conservatism; manual reprocess via `POST /process` is unaffected.

Accepted risks and tradeoffs:

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the "set the tracker immediately before the await" convention and representative-stage contract-test coverage (an early-stage failure and a late-stage failure), without ossifying every step.
- `retryable=false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; manual reprocess remains.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job.

## Version bump

Patch. The change is confined to the worker's failure-payload construction (key additions plus a derived `retryable` value), a local stage tracker, and a new contract test. No public API surface, persisted schema, or configuration contract changes; `retryable`'s derived value for unclassified-unknown errors changes from the previous silent default (`true`) to `false`, which is a behavior correction within the same field semantics, not a schema or interface change.

## Deferred items

- The companion D3 issue referenced by the Objective is not available in this context; anything it covers beyond this worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text only.
- Dropping the legacy `error` key from the worker's failure payload once an audit confirms the worker is the only publisher and rag-api the only consumer of the status topic (trivial follow-up cleanup).
- Any structured error-code taxonomy or failure classification beyond `classify_error`'s existing heuristics.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>