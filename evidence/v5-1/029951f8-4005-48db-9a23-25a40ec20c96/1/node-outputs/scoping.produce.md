Re-emitting with the corrected artifact marker (the opening marker's closing angle brackets were malformed — three `>>>` required after the quoted path).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

Run: 029951f8-4005-48db-9a23-25a40ec20c96 · Iteration 1 · Step: scoping.produce
Source of truth: define-work WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).

## Scope

In scope for this cycle — and nothing else:

1. **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`). The `process_document` exception handler must publish a failed status whose `details` carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — none of the three left to rag-api's fallback defaults. The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
2. **Stage tracking** (`apps/ai-server/rag-worker-service/main.py`). `process_document` gains a stage tracker set immediately before each pipeline step (the "set the tracker, then await" convention) and reported by the failure handler. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`); `"processing"` is the safe value when the stage is genuinely unknown (e.g. failure before the first transition) — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.
3. **Retryable derivation** (`apps/ai-server/rag-worker-service/main.py`). The worker derives `retryable` from the existing `classify_error(e)`: transient-classified → `true`; permanent-classified, including unclassified-unknown (classify_error's conservative default) → `false`. This makes the persisted record match the worker's actual ACK/NACK behavior in `run_worker`. Accepted consequence: unclassified-unknown failures flip from the silent default `true` to `false`; manual reprocess via `POST /process` is unaffected.
4. **Contract test** (`apps/ai-server/tests/integration/`, following the patterns in `test_api_contracts.py`). A worker failure → rag-api persistence contract test that imports both sides rather than restating the contract in a fixture: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes, and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must include a key-set drift guard so an edit to either side's payload keys fails the build, and pin the stage-tracker mechanism on representative stages (an early-stage failure and a late-stage failure).

rag-api's failed branch (`run_transactional_update`) is **exercised but not modified**: its reads (`error_message`, `stage`, `retryable`) and persisted fields (`error`, `error_stage`, `retryable`) stay exactly as they are.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts and nobody tests the seam. The worker's exception handler publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error`/`error_stage`/`retryable`. Every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — and the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures.

This cycle aligns the worker to rag-api's existing contract — the direction the Objective prefers and the one the repository evidence supports: `error`/`error_stage`/`retryable` is already the persisted failure schema written by the worker's stale-lease sweep (`_fail_if_still_stale`) and rag-api's enqueue-failure paths (`/process`, `POST /resources`), and exposed by `ResourceResponse` and the `Resource` model. The worker's status publisher is the only writer that doesn't speak it; fixing the odd one out requires no migration, no backfill, and no reader changes. A contract test locks the seam so key drift on either side fails the build instead of silently re-creating the bug.

## Requirements

Binding requirements for this cycle:

- **R1 — Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
- **R2 — True failing stage.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- **R3 — API persists unchanged.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
- **R4 — Explicit retryable.** The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
- **R5 — Contract test.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Done when (acceptance):

- A failed job's status message published by the worker contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
- The contract test covering the worker failure → rag-api persistence path exists and passes, failing on key drift on either side.

## Boundaries

Constraints:

- **Must:** the worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- **Must not:** no Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must:** every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer:** retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **Prefer not:** do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error `code` remains "UNKNOWN" unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (see Deferred items).

Known risks accepted within these boundaries: unknown consumers of the status topic reading the old key set (mitigated by retaining `error`; residual risk accepted as low); stage-tracker drift as the pipeline evolves (mitigated by the update-before-await convention and representative-stage test coverage); `retryable=false` for unclassified errors reducing auto-retry affordances (accepted; widening `classify_error` is out of scope); the contract test ossifying the payload (intentional — that is the drift guard doing its job).

## Version bump

- **rag-worker-service:** patch-level behavior bump — the status-topic failure payload gains keys (additive) and one deliberate behavior change (unclassified-unknown failures persist `retryable: false` instead of the silent default `true`). No public function signatures change.
- **rag-api-service:** no version bump — its code, reads, and persisted schema are unchanged by this cycle.
- **Firestore:** no schema version change — `schema_version: 2` documents and the `error`/`error_stage`/`retryable` fields keep their names and semantics; no migration, rename, or backfill.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred (definition fact F12).
- **Reconciling with the original D4 deviation note** in `plans/upload-flow.md`: that file is not present in the current tree (the reference comes from the Objective text); deferred.
- **Dropping the legacy `error` key** from the worker's failure payload: only after an audit confirms the worker is the only publisher and rag-api the only consumer of the status topic; trivial cleanup when safe.
- **Widening `classify_error`** to recognize more genuinely-transient failure modes (interim cost: unrecognized-but-transient failures persist `retryable: false`; manual reprocess via `POST /process` remains).
- **Structured error-code taxonomy / failure taxonomy:** the `processing/summary` error `code` stays "UNKNOWN"; any taxonomy is a separate future decision.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>