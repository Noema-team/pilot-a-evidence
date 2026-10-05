The authoritative definition is fully pinned in the task, and I've verified the repository evidence it cites (the worker's `classify_error`/failure path in `apps/ai-server/rag-worker-service/main.py` and the existing contract-test patterns in `apps/ai-server/tests/integration/test_api_contracts.py`). Producing the cycle charter for the scoped step now.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

Authoritative source: define-work WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).

## Scope

Work in scope for this cycle:

1. **Worker failure payload alignment** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler / `_publish_status_update` failure path): publish a failed-status payload carrying `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
2. **Stage tracking in `process_document`**: introduce a local stage tracker set immediately before each pipeline await, so the failure handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **Explicit retryable derivation**: the worker sets `retryable` from `classify_error(e)` — transient-classified errors map to `true`; permanent-classified errors (including unclassified-unknown, per `classify_error`'s conservative default) map to `false` — aligning the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.
4. **rag-api failed-branch pass-through verification** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch): no functional changes to rag-api — the constraint is that the worker aligns to rag-api's existing reads (`error_message`/`stage`/`retryable`) and persisted schema (`error`/`error_stage`/`retryable`). Any rag-api edits are limited to what the contract test requires to exercise the failed branch hermetically.
5. **Contract test on the worker → rag-api failure path** (`apps/ai-server/tests/integration/`, following the fixture- and AST-based patterns in `test_api_contracts.py`): exercise the worker's failure-payload construction through rag-api's failed-branch persistence (Firestore emulator or fakes), assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and include a key-set drift guard so a future edit to either side's payload keys fails the build.

Files expected to change: `apps/ai-server/rag-worker-service/main.py`; `apps/ai-server/tests/integration/test_api_contracts.py` (or a sibling test module reusing its patterns); optionally new fixtures under `apps/ai-server/tests/fixtures/api-contracts/`. `apps/ai-server/rag-api-service/main.py` is verify-only.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures. Today the worker publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch reads `error_message`/`stage`/`retryable`; every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a silently defaulted `retryable: true`, with the processing/summary error subdocument inheriting the same fallbacks (`error_code` always "UNKNOWN"). This cycle fixes the seam by aligning the worker — the odd one out among four write paths — to the established persisted schema, with no migration, no field rename, no backfill, and no reader changes, and locks the contract in with a test so the two sides cannot silently drift again.

## Requirements

- When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
- The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
- The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
- A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift. Coverage pins representative stages (an early-stage failure and a late-stage failure) rather than ossifying every pipeline step.
- Constraint (must): the worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- Constraint (must_not): no Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Constraint (must): every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- Constraint (prefer): retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- Constraint (prefer_not): do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

## Boundaries

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract, including its separate `retryable=true` write (a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.
- Widening `classify_error`'s heuristics, even though unclassified-unknown failures will now persist `retryable: false` instead of the silent default `true` (manual reprocess via `POST /process` remains available).

## Version bump

- `apps/ai-server/rag-worker-service`: **patch** — bug-fix alignment of the failure payload to the existing rag-api contract; the retryable behavior change for unclassified-unknown errors is a correctness fix, not a new feature.
- `apps/ai-server/rag-api-service`: **none** — no functional changes; the failed branch is verified as-is.
- `apps/ai-server/tests`: **none** — test-only additions (contract test and drift guard).

## Deferred items

- The companion D3 issue referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker → rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference exists only in the Objective text.
- Dropping the legacy `error` key from the worker's failure payload — trivial cleanup if a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic.
- A structured error-code taxonomy / failure taxonomy (processing/summary `error.code` stays "UNKNOWN" unless a code is actually sent).
- Retry/backoff mechanics (ACK/NACK policy, leases, heartbeats) and the stale-lease sweep's behavior.
- Frontend/mobile changes.
- Widening `classify_error` for genuinely transient-but-unrecognized failure classes.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>