Both services and the existing contract-test infrastructure match the Definition's evidence refs. The authoritative Definition fully specifies the scope; I've verified the referenced files exist (`apps/ai-server/rag-worker-service/main.py`, `apps/ai-server/rag-api-service/main.py`, `apps/ai-server/tests/integration/test_api_contracts.py`) and confirmed `classify_error()` and its conservative unknown→permanent default in the worker source. Producing the charter now.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

Authoritative source: define-work WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).

## Scope

Align the rag-worker's failed-status payload to rag-api's existing failed-branch contract so worker-originated failures persist real diagnostic data instead of fallback defaults. In scope:

- **Worker payload alignment** (`apps/ai-server/rag-worker-service/main.py`): the `process_document` exception handler must publish a failure status payload containing `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
- **Stage tracking in `process_document`**: a stage tracker (local state) set immediately before each pipeline await, reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage`.
- **Explicit retryable derivation**: the worker sets `retryable` from `classify_error(e)` — transient-classified errors → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.
- **rag-api side stays as-is**: the failed branch of `run_transactional_update` (`apps/ai-server/rag-api-service/main.py`) already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` plus the `processing`/`summary` error subdocument (message, stage, `error_code` defaulting to `"UNKNOWN"`). No reader, schema, or persisted-field changes on the API side; it persists worker-provided values unchanged.
- **Contract test** (following the existing patterns in `apps/ai-server/tests/integration/test_api_contracts.py`, using the Firestore emulator or fakes): exercise the worker's failure-payload construction through rag-api's failed-branch persistence, assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and include a key-set drift guard so a future edit to either side's payload keys fails the build. Cover representative stages: an early-stage failure and a late-stage failure.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures. Today the worker publishes only `{"error": str(e)}` while rag-api reads `error_message`/`stage`/`retryable`, so every worker failure lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — and the `processing`/`summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN". The worker is the only failure writer that doesn't speak the established `error`/`error_stage`/`retryable` schema (the stale-lease sweep, rag-api's enqueue-failure paths, `ResourceResponse`, and the `Resource` model all already use it), so the worker is aligned to the API — no migration, no field rename, no backfill, no reader changes.

One deliberate, accepted behavior change: unclassified-unknown exceptions currently persist `retryable: true` via the silent default but classify as permanent under `classify_error`, so they will now persist `false`. This is the conservatism `classify_error` was written for (it prevents infinite retry loops); manual reprocess via `POST /process` remains available.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

## Boundaries

Must:

- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- Every worker-originated failure payload must carry `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

Must not:

- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.

Prefer / prefer not:

- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

Non-goals (out of scope):

- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary error `code` remains `"UNKNOWN"` unless a code is actually sent.
- Widening `classify_error`'s heuristics.

Accepted risks (per the Definition):

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the "set the tracker immediately before the await" convention and representative-stage test coverage.
- `retryable=false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; manual reprocess remains.

## Version bump

Patch. No persisted schema change, no new public API surface, no reader changes: the code change is confined to the rag-worker's failure-payload construction (plus stage tracking), with the contract test added under `apps/ai-server/tests/integration/`. rag-api-service requires no functional change (its failed branch already implements the contract); any rag-api touch is limited to test support. Neither service's external contract changes shape — the worker's payload gains keys that were previously missing, which is the bug fix itself.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle (F12, DEFERRED).
- **Reconciling with `plans/upload-flow.md` deviation D4**: that file is not present in the current tree; the reference comes from the Objective text. Reconciliation is deferred.
- **Dropping the legacy `error` key**: if a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic, removing the duplicate key is trivial cleanup — deferred, not part of this fix.
- **Structured error-code taxonomy / failure taxonomy**: the processing/summary error `code` stays `"UNKNOWN"` unless a code is actually sent; any taxonomy is deferred (prefer-not constraint).
- **Widening `classify_error`'s heuristics** to recognize more transient failure modes: out of scope; the conservative unknown→permanent default stands.
- **Retry/backoff mechanics** (ACK/NACK policy, leases, heartbeats): only the reporting of retryability changes; mechanics are deferred/untouched.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>