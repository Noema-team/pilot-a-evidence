<<<SLE-OUTPUT>>><<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — worker→rag-api failure payload contract alignment

## Purpose

The rag-worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker's exception handler in `process_document` publishes a one-key payload (`{"error": str(e)}`) via `_publish_status_update`; rag-api's failed branch in `run_transactional_update` reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error`/`error_stage`/`retryable` on the main resource document, and writes `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary error subdocument. Because of the key mismatch, every worker-originated failure currently persists `error` as the fallback string `"Processing failed"`, `error_stage` as `None`, and `retryable` as the silent default `True` — leaving users and support unable to disambiguate failures.

This cycle aligns the worker to rag-api's existing contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## Scope

**In scope — worker side (`apps/ai-server/rag-worker-service/main.py`):**

- The failure status payload published by the worker's exception handler must include:
  - `error_message` — the actual exception message (`str(e)`), never a fallback string;
  - `stage` — the pipeline stage executing at failure time;
  - `retryable` — deliberately derived from `classify_error(e)` (the same classification that drives ACK/NACK in `run_worker`), so the payload's retryability matches actual retry behavior (transient = Pub/Sub will redeliver; permanent = acked and will not return, manual reprocess via `POST /process` still available). The payload must never rely on rag-api's `details.get("retryable", True)` fallback for this key.
  - The legacy `error` key is retained alongside `error_message` as a hedge for unknown consumers of the status topic (only rag-api's status subscriber is a verified consumer).
- A stage tracker in `process_document`: a local set immediately before each pipeline step and reported by the exception handler, so the failure handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`). For a failure before the first transition, the safe value is `"processing"` — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null. Convention: update the tracker before awaiting each step.

**In scope — rag-api side (`apps/ai-server/rag-api-service/main.py`):**

- No contract change: rag-api's failed branch must persist the worker-provided values unchanged — main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage (with `error_code` remaining `"UNKNOWN"`).

**In scope — contract test (`apps/ai-server/tests/integration/test_api_contracts.py` or sibling):**

- A contract test covering the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction through rag-api's `run_transactional_update` failed branch (via the Firestore emulator or fakes — existing fixture and `FIRESTORE_EMULATOR_HOST` branch infrastructure), and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. The test imports both sides rather than restating the contract in a fixture, and covers representative stages (an early-stage failure and a late-stage failure) so tracker removal or bypass is caught without ossifying every step. It fails if either side's payload keys drift.

**Out of scope:**

- Changing rag-api's reads, persisted field names, or semantics — `error`, `error_stage`, `retryable` keep their names and meanings; the worker aligns to the API, not vice versa.
- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing rag-api's enqueue-failure paths (`/process`, `POST /resources`) — already consistent.
- Widening `classify_error` or changing ACK/NACK decisions in `run_worker` — the retryable derivation only consumes its existing output.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing a structured error-code taxonomy or `error_code` values beyond the existing `"UNKNOWN"` default in the processing/summary error subdocument.
- Anything the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is not available in this context), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (that file is not present in the current tree).
- Auditing or changing other potential consumers of the worker's status topic beyond retaining the legacy `error` key as a hedge.

**Known deliberate behavior change:** unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent; after this fix they will persist `retryable: false`.

**Known drift risk:** a future pipeline step added without updating the stage tracker reports a stale stage — mitigated by the update-before-await convention and representative-stage contract-test coverage.
<<<END-SLE-ARTIFACT>>><<<END-SLE-OUTPUT>>>