# Cycle Charter: rag-worker → rag-api failure payload contract alignment

Intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

## Scope

Align the rag-worker's failed status payload with rag-api's existing failed-branch contract, and pin the seam with a contract test. Concretely:

1. **rag-worker-service failure payload** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler): the failed status `details` published via `_publish_status_update` must carry
   - `error_message` — the actual exception message (`str(e)`),
   - `stage` — the pipeline stage executing at failure time,
   - `retryable` — deliberately derived from `classify_error(e)` (transient → `true`, permanent/unclassified-unknown → `false`),
   - the legacy `error` key retained alongside `error_message` as a compatibility hedge for any unknown consumers of the status topic.

2. **Stage tracking in `process_document`**: a local stage tracker set immediately before each pipeline step, reported by the exception handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.

3. **Contract test** in `apps/ai-server/tests/integration/` (extending the existing `test_api_contracts.py` pattern): exercises the worker's failure-payload construction through rag-api's `run_transactional_update` failed branch (Firestore emulator or fakes, per the existing hermetic modes both services support), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and includes a key-set drift guard that fails the build if either side's payload keys change.

4. **rag-api-service: no code changes.** Its failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` plus the `processing/summary` error subdocument (`error_code` stays "UNKNOWN"). The alignment is entirely on the worker side, per the authoritative constraint.

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures. Today the worker publishes `{"error": str(e)}` while rag-api reads `error_message`/`stage`/`retryable`, so every worker-originated failure persists the fallback `"Processing failed"`, a null `error_stage`, and a silently defaulted `retryable: true` — on the main document and the `processing/summary` error subdocument alike. The persisted field names (`error`, `error_stage`, `retryable`) are already consistent across the worker's stale-lease sweep, rag-api's enqueue-failure paths, `Resource`, and `ResourceResponse`; the worker's status publisher is the only writer that doesn't speak the schema. This cycle fixes the odd one out and locks the seam with a test so the mismatch cannot silently recur. Deriving `retryable` from `classify_error` also aligns the persisted record with the worker's actual ACK/NACK behavior: transient = Pub/Sub will redeliver; permanent = acked, manual reprocess via `POST /process` remains.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage. (No rag-api code change is required to satisfy this; the requirement is verified by the contract test.)
4. The `retryable` derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false. Note this is a deliberate behavior change for unclassified-unknown exceptions: previously persisted `true` via silent default, now persisted `false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift. Coverage must include a representative early-stage failure and a late-stage failure to pin the stage-tracker mechanism without ossifying every step.

## Boundaries

Must / must-not / prefer constraints:

- The worker must be aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload must carry `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix; the `processing/summary` error `code` remains `"UNKNOWN"` unless a code is actually sent.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (its `retryable: true` for a dead worker remains correct: worker death is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy.
- Widening `classify_error`'s heuristics (the conservative permanent-default for unclassified errors stays; the retryable-false consequence is accepted).
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment.

Known drift risks accepted and mitigated in scope: stage-tracker drift as the pipeline evolves (mitigated by the "set the tracker immediately before the await" convention plus representative-stage test coverage); contract-test ossification of the payload key set (intentional — that is the drift guard working).

## Version bump

- `rag-worker-service`: **minor** — the failure status payload gains keys (`error_message`, `stage`, `retryable`) and unclassified-unknown failures now persist `retryable: false` instead of the silent-default `true`; this is an observable behavior change for consumers of the status topic, though no public API or client-facing shape changes.
- `rag-api-service`: **none** — no code changes; its failed-branch contract is the target being aligned to.
- `tests/integration` (ai-server): test-only addition; no version impact.
- No data/schema version bump: no Firestore migration, field rename, or backfill is involved.

## Deferred items

- **Companion D3 issue**: the Objective references a companion D3 issue filed alongside this one (original analysis in `plans/upload-flow.md` as deviation D4 — a file not present in the current tree). Its content is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling this analysis with the original D4 deviation note** in `plans/upload-flow.md` (file absent from the tree; reference comes only from Objective text) — deferred.
- **Dropping the legacy `error` key** from the worker's failure payload, contingent on a later audit confirming the worker is the only publisher and rag-api the only consumer of the status topic — deferred as trivial cleanup.
- **Widening `classify_error`** to recognize more transient failure classes (reducing the retryable-false exposure for genuinely transient-but-unrecognized errors) — deferred; manual reprocess via `POST /process` covers the gap in the meantime.
- **Structured error-code taxonomy / failure classification beyond "UNKNOWN"** — deferred; requires a designed taxonomy and reader support, not a payload fix.