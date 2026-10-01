I've verified the Definition's repository claims against the actual tree: `classify_error()` in the worker (with the conservative permanent default), the `tests/integration/test_api_contracts.py` fixture/AST-based contract-test pattern, and both services' layouts all match the cited evidence. The authoritative Definition is internally consistent and implementable as written, so the charter below scopes exactly that — nothing widened or narrowed.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — worker→rag-api failure payload contract alignment

Run: 652fa48d-0d0e-45e6-a7a1-6ea36aed926b · Iteration 1 · Step: scoping.produce
Authoritative source: define-work WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`)

## Scope

This cycle aligns the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag.

In scope:

1. **Worker failure payload keys** — the worker's failed status publication (currently `{"error": str(e)}` from `process_document`'s exception handler via `_publish_status_update`) is changed to publish `error_message` (the actual exception message), `stage`, and `retryable`. The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
2. **Stage tracking in `process_document`** — a stage tracker (local state set immediately before each pipeline step) so the failure handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, with `processing` as the safe value when the stage is genuinely unknown.
3. **Retryable derivation** — the worker sets `retryable` from `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (per `classify_error`'s conservative default), → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.
4. **rag-api failed branch (unchanged reads, verified persistence)** — rag-api's failed branch in `run_transactional_update` continues to read `error_message`, `stage`, and `retryable` from the payload and persists them unchanged: main document `error` ← `error_message`, `error_stage` ← `stage`, `retryable` ← `retryable`; the processing/summary error subdocument carries the same message and stage, with `error_code` remaining "UNKNOWN" unless a code is actually sent.
5. **Contract test on the worker→rag-api failure seam** — a contract test (following the existing fixture- and AST-based patterns in `apps/ai-server/tests/integration/test_api_contracts.py`) that exercises the worker's failure-payload construction through rag-api's failed-branch persistence (via the Firestore emulator or fakes), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and fails if either side's payload keys drift.

Out of scope (see Boundaries): the stale-lease sweep's direct failure write, retry/backoff mechanics, frontend/mobile, structured error codes, and anything covered by the companion D3 issue beyond this payload alignment.

## Purpose

A failed RAG processing job must persist the worker's actual error message and failing stage so users and support can disambiguate failures. Today the worker's publisher and rag-api's consumer were written against different contracts and nothing tests the seam: the worker publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` from `details.get("retryable", True)` — and the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN".

The fix direction is worker-side alignment because the persisted `error`/`error_stage`/`retryable` schema is already established across three other write paths (the worker's stale-lease sweep, rag-api's `/process` and `POST /resources` enqueue-failure paths) and two response surfaces (`ResourceResponse`, the `Resource` model). The worker is the only writer that doesn't speak the schema; aligning it requires no Firestore migration, no field rename, no backfill, and no reader changes. Deriving `retryable` from `classify_error()` makes the persisted record tell the truth about what Pub/Sub will actually do: transient errors are redelivered (retryable true); permanent errors were acked and will not return (retryable false, manual reprocess via `POST /process` remains available).

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `processing` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → retryable true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → retryable false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Acceptance criteria (from the Definition, all currently unmet):

- A failed job's status message published by the worker contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The processing/summary error subdocument for the failed job carries the same message and stage as the main document.
- A contract test covering the worker failure → rag-api persistence path exists and passes, asserting persisted `error`, `error_stage`, and `retryable` equal the worker's values and failing on key drift on either side.

## Boundaries

Must:

- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

Must not:

- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.

Prefer:

- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.

Prefer not:

- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix; the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.

Non-goals (explicitly excluded):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (its separate `retryable=true` write stays correct: a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy.
- Widening `classify_error`'s classification heuristics (the `retryable=false` behavior for unclassified-unknown errors is an accepted, deliberate change).
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment.

## Version bump

No version bump is required by this cycle. The change alters no persisted schema (field names and semantics of `error`/`error_stage`/`retryable` are unchanged), no public API surface consumed by clients (`ResourceResponse` is untouched), and no migration or backfill is involved. Delivery is a container rebuild of `rag-worker-service` (payload keys, stage tracker, retryable derivation) and `rag-api-service` (no behavioral change; touched only if the contract test exposes a needed clarification). If repo convention nonetheless requires a bump, patch-level increments to those two services are the ceiling — no minor/major bump is warranted by this scope.

## Deferred items

- **Companion D3 issue** — the Objective references a companion D3 issue filed alongside this one; its scope is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred (Fact F12, status DEFERRED).
- **Reconciling with `plans/upload-flow.md` deviation D4** — the original analysis reference points to a file not present in the current tree; reconciliation is deferred.
- **Dropping the legacy `error` key** — after a consumer audit confirms the worker is the only publisher and rag-api's status subscriber the only consumer, removing the duplicate key is trivial cleanup, deferred to a later cycle.
- **Structured error-code taxonomy** — enriching the processing/summary `error.code` beyond "UNKNOWN" is deferred (prefer-not constraint).
- **Widening `classify_error`** — improving recognition of genuinely-transient-but-unrecognized exceptions (so they classify transient rather than falling through to permanent) is out of scope; manual reprocess via `POST /process` remains available.
- **Retry/backoff mechanics** — any change to ACK/NACK policy, lease/heartbeat intervals, or backoff behavior beyond reporting retryability in the payload.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>