 <<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api Failure Payload Contract Alignment

Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
Authoritative source: WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).

## 1. Problem Statement

When a RAG processing job fails in the worker, the failure status payload published by
`rag-worker-service` does not match the keys `rag-api-service`'s failed branch reads. The worker
publishes `details = {"error": str(e)}` (F3), while `run_transactional_update`'s failed branch reads
`error_message`, `stage`, and `retryable` (F4). As a result, every worker-originated failure persists:

- `error` = the fallback string `"Processing failed"` (not the worker's actual message)
- `error_stage` = `None` (no stage tracking exists in the failure handler)
- `retryable` = `True` (the silent default in `details.get("retryable", True)`)

Users and support cannot disambiguate failures, and retry behavior is not deliberately derived (F1, F5).

## 2. Goals

1. A failed RAG processing job persists the worker's actual error message, the failing pipeline stage,
   and a deliberately derived `retryable` flag on the resource document.
2. The fix is locked in by a contract test covering the worker → rag-api failure path.
3. No Firestore migration, field rename, or backfill of existing documents is required.

## 3. Scope

### In scope
- `apps/ai-server/rag-worker-service/main.py`:
  - Failure payload key alignment (`error_message`, `stage`, `retryable`).
  - Stage tracking through `process_document`.
  - `retryable` derivation from `classify_error(e)`.
- `apps/ai-server/rag-api-service/main.py`: no production-code changes expected; its failed branch is
  the contract target.
- New contract test(s) exercising the worker failure → rag-api persistence path.

### Out of scope
- Any change to the persisted schema (`error`, `error_stage`, `retryable` field names) — these are the
  established schema used by the stale-lease sweep, both enqueue-failure paths, `ResourceResponse`,
  and the `Resource` model (F6).
- Any structured error-code taxonomy (`error_code` values beyond rag-api's existing `"UNKNOWN"`
  default) — explicitly a "prefer not" constraint.
- Anything covered by the companion D3 issue (not available in this context) and reconciliation with
  the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).
- Backfilling or migrating existing failed documents.

## 4. Functional Requirements

### FR-1 — Payload key alignment (worker side)
The worker's failure status payload published via `_publish_status_update` for a failed job MUST
include, inside `details`:
- `error_message`: the worker's actual error message (`str(e)`), not a generic fallback.
- `stage`: the pipeline stage at which the failure occurred (see FR-2).
- `retryable`: a deliberately derived boolean (see FR-3).

### FR-2 — Legacy key retention (hedge)
The worker MUST retain the legacy `error` key (set to the same message as `error_message`) alongside
the new `error_message` key, so any unknown consumer of the failure payload continues to see the
message it expects today. No consumer other than rag-api's status subscriber is known to parse these
keys, but the hedge is cheap and non-breaking.

### FR-3 — Stage tracking through `process_document`
The worker MUST track the currently executing pipeline stage through `process_document` so that the
exception handler can report the failing stage in the failure payload. Stage names MUST reuse the
existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`,
`summary_generated`, `chunking_complete`, `embeddings_complete`. If a failure occurs before the first
stage transition, the stage value MUST be `"processing"` — the same value the stale-lease sweep uses
for `error_stage` — so `error_stage` never regresses to `null`.

### FR-4 — Deliberate `retryable` derivation (adopted default, F8)
The worker MUST set `retryable` from `classify_error(e)`:
- Errors classified as transient → `retryable: true`.
- Errors classified as permanent (including unclassified-unknown exceptions, per
  `classify_error`'s conservative default) → `retryable: false`.

Rationale: this aligns the persisted record with the worker's own ACK/NACK classification used in
`run_worker` (F7). This is a deliberate behavior change: unclassified-unknown exceptions currently
persist `retryable: true` via the silent default but classify as permanent, so they will now persist
`false`. This conservatism prevents infinite retry loops; the manual reprocess path
(`POST /process`) is unaffected.

### FR-5 — rag-api persistence (contract target, unchanged behavior)
After a failed job, the persisted resource document MUST have:
- `error` = the worker's actual error message (not `"Processing failed"`),
- `error_stage` = the failing stage (not `None`),
- `retryable` = the worker's derived value.

The processing/summary subdocument continues to receive `message`/`stage` with `error_code`
defaulting to `"UNKNOWN"` (existing rag-api behavior, F4).

### FR-6 — Silent default must not be operative
The rag-api `details.get("retryable", True)` fallback MUST NOT be the operative mechanism for
worker failures: the worker always sends `retryable` explicitly. The rag-api fallback may remain in
place for other/older publishers, but the worker path must not rely on it.

### FR-7 — Contract test
A contract test covering the worker failure → rag-api persistence path MUST exist and pass. It MUST:
- Exercise the worker's failure code path to build the failure payload (importing the worker's code,
  not restating the contract in a fixture).
- Feed that payload through rag-api's `run_transactional_update` against the Firestore emulator
  (the emulator branches already exist in the codebase, making this implementable).
- Assert the persisted document satisfies FR-5 (actual message, non-null stage, derived retryable).

### FR-8 — Key-set drift guard
A key-set drift guard MUST be added so that a future edit to either side's payload keys (worker
publish keys, rag-api read keys) fails the build instead of silently re-creating this mismatch. The
guard should compare the declared key sets on both sides (e.g., via a small shared constant or a
test asserting the exact expected key sets against the code's actual keys).

## 5. Non-Functional Requirements

### NFR-1 — must_not constraints
- MUST NOT require a Firestore migration, field rename, or backfill of existing documents.
- MUST NOT change the persisted failure schema (`error`, `error_stage`, `retryable`).
- MUST NOT rely on the `details.get("retryable", True)` fallback for worker-originated failures.

### NFR-2 — prefer_not constraints
- Prefer not to introduce a structured error-code taxonomy (`error_code` values) in this fix.

### NFR-3 — Compatibility
- The fix must not break other publishers sharing the Pub/Sub topic or other consumers of the
  status payload. The legacy `error` key hedge (FR-2) covers unknown consumers.

## 6. Design Direction (rationale)

The Objective prefers aligning the worker to `error_message`/`stage`, and repository evidence makes
that the correct option: the persisted field names (`error`/`error_stage`/`retryable`) are already
consistent across three other write paths (stale-lease sweep, `/process` enqueue failure,
`POST /resources` enqueue failure) and two API response models (`ResourceResponse`, `Resource`).
Changing the API side would ripple; changing the worker side requires no migration, no backfill, and
no reader changes.

`process_document` is currently one large try block, so at failure time nothing knows where it was —
hence FR-3's stage tracking. Using the existing progress-vocabulary stage names means a failure
stage reads naturally next to the progress timeline.

## 7. Acceptance Criteria

1. A worker-side failure produces a payload with `details` containing `error_message` (actual
   message), `stage` (failing stage or `"processing"` if pre-first-transition), `retryable`
   (from `classify_error`), and the legacy `error` key (same message).
2. After `run_transactional_update` processes that payload, the resource document has
   `error` = actual message, `error_stage` = the stage, `retryable` = the derived value.
3. Transient-classified errors persist `retryable: true`; permanent-classified (including
   unknown) errors persist `retryable: false`.
4. The contract test (FR-7) exists and passes against the Firestore emulator.
5. The key-set drift guard (FR-8) fails the build if either side's key set changes without the
   other.
6. No schema migration, backfill, or reader-side changes are made.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>