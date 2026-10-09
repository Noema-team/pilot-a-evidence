 I have reviewed the authoritative Definition and verified the repository evidence (worker's `process_document` exception handler publishing `{"error": str(e)}`, rag-api's `run_transactional_update` failed branch reading `error_message`/`stage`/`retryable`, and the existing contract-test infrastructure). Here is the cycle charter.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

## Scope

This cycle aligns the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag.

In scope:

1. **Worker failure payload (`apps/ai-server/rag-worker-service/main.py`)**
   - The `process_document` exception handler's `_publish_status_update` call for `failed` status must publish `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) in its details payload.
   - The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic (constraint: prefer; the duplicate is one redundant string per failure message).
   - No structured error-code taxonomy is introduced (constraint: prefer not).

2. **Stage tracking (`apps/ai-server/rag-worker-service/main.py`)**
   - `process_document` must track the currently executing pipeline stage via a local tracker, set immediately before each pipeline step (the "update-before-await" convention), so the failure handler reports the true failing stage.
   - Stage names reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
   - When the stage is genuinely unknown (e.g. failure before the first transition), the safe value is `"processing"` — the same value the stale-lease sweep uses for `error_stage` — so the persisted `error_stage` never regresses to null.

3. **retryable derivation (`apps/ai-server/rag-worker-service/main.py`)**
   - The worker sets `retryable` from `classify_error(e)`: transient-classified errors map to `true`; permanent-classified errors — including unclassified-unknown, per `classify_error`'s conservative default — map to `false`.
   - This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker` (transient = Pub/Sub redelivers; permanent = acked, manual reprocess via `POST /process` remains).
   - The stale-lease sweep's separate `retryable=true` write is unchanged: a dead worker is a transient condition by nature.

4. **Contract test (`apps/ai-server/tests/integration/`)**
   - A new contract test covering the worker failure → rag-api persistence path, following the house pattern in `tests/integration/test_api_contracts.py`.
   - It must exercise the worker's failure-payload construction and rag-api's `run_transactional_update` failed branch (via the Firestore emulator or fakes), and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
   - It must include a key-set drift guard so a future edit to either side's payload keys fails the build instead of silently re-creating the mismatch.
   - It must pin the stage-tracker mechanism on representative stages (an early-stage failure and a late-stage failure) — enough to catch the tracker being removed or bypassed without ossifying every step.

5. **rag-api side (`apps/ai-server/rag-api-service/main.py`)**
   - No changes to rag-api's reads, persisted schema, or field names. The failed branch of `run_transactional_update` already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable`; the worker is aligned to it, not the other way around. Any rag-api edits are limited to what the contract test needs to exercise the existing code path.

## Purpose

A failed RAG processing job must persist the worker's actual error message and failing stage so users and support can disambiguate failures; `retryable` must be sent by the worker or derived deliberately, never silently defaulted.

Today that contract is broken at the seam: the worker publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true` — and the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`. Nobody tests the seam, so the drift went unnoticed.

The fix direction is deliberate: the worker aligns to rag-api's existing contract because the persisted field names (`error`, `error_stage`, `retryable`) are already consistent across three other write paths (the worker's stale-lease sweep, rag-api's enqueue-failure paths) and two API response models (`ResourceResponse`, the `Resource` model). The worker's status publisher is the only writer that doesn't speak the schema — fix the odd one out. This requires no Firestore migration, no field rename, and no backfill of existing documents.

Deriving `retryable` from `classify_error()` makes the persisted record tell the truth about what will actually happen: a transient error is one Pub/Sub will redeliver; a permanent error was acked and will not come back. One deliberate behavior change falls out — unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent, so they will now persist `false`. That is the conservatism `classify_error` was written for: it prevents infinite retry loops, and manual reprocess via `POST /process` remains available.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The `retryable` derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

## Boundaries

Out of scope (non-goals):

- **The stale-lease sweep's direct failure write** — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- **Retry/backoff mechanics** — Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals are unchanged; only the *reporting* of retryability in the payload changes.
- **Frontend or mobile changes** — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **Structured error codes or a failure taxonomy** — the `processing/summary` error `code` remains `"UNKNOWN"` unless a code is actually sent.
- **Any scope the companion D3 issue covers** beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred below).
- **Widening `classify_error`** to recognize more exception types — its current classification is the source of truth for the derivation.

Constraints binding this scope:

- The worker must be aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema. (must)
- The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. (must_not)
- Every worker-originated failure payload must carry `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. (must)
- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling. (prefer)
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. (prefer_not)

## Version bump

No version bump is declared for this cycle. The change is an internal bug fix across two backend services plus a test addition; no public API surface, persisted schema, or release artifact changes in a way that warrants a declared version increment here. If the project's release process requires one at merge time, it is a patch-level bump.

## Deferred items

- **Companion D3 issue** — the Objective references a companion D3 issue filed alongside this one (and original analysis in `plans/upload-flow.md` as deviation D4). That issue's scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling with `plans/upload-flow.md` deviation D4** — that file is not present in the current tree; the reference comes from the Objective text. Reconciliation is deferred.
- **Dropping the legacy `error` key** — if a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic, removing the duplicate `error` key is trivial cleanup, deferred until that audit exists.
- **Stage-tracker drift hardening** — a future pipeline step added without updating the tracker would report a stale stage; the representative-stage contract test pins the mechanism, but exhaustive per-step coverage is deferred.
- **Widening `classify_error`** — genuinely transient-but-unrecognized failures will now persist `retryable: false`; widening the classifier to recognize more exception types is deferred.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>