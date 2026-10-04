Scoping is complete. The charter below is drawn from the authoritative Definition and the repository evidence verified during investigation (worker's `process_document` exception handler publishing `{"error": str(e)}`; rag-api's `run_transactional_update` failed branch reading `error_message`/`stage`/`retryable`; the established `error`/`error_stage`/`retryable` schema across the sweep, enqueue-failure paths, and the `Resource` model; `classify_error`'s ACK/NACK role; and the existing contract-test patterns). Unverified details (e.g., exact version manifests) are flagged as such rather than invented.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle aligns the rag-worker's failure status payload to rag-api's existing failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

Code in scope:

1. **`apps/ai-server/rag-worker-service/main.py` — `EnhancedDocumentProcessor.process_document`**
   - Add a stage tracker (a local set immediately before each pipeline step) so the exception handler knows the stage executing at failure time. Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`; `"processing"` is the safe value when the stage is genuinely unknown (matching the stale-lease sweep's `error_stage` value, so the field never regresses to null).
   - Rebuild the failure payload in the `except` handler: publish `error_message` (the actual exception message), `stage` (tracked stage), and `retryable` (derived from `classify_error(e)`), while retaining the legacy `error` key alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic.

2. **`apps/ai-server/rag-api-service/main.py` — `run_transactional_update` failed branch**
   - Behavior is pinned, not redesigned. The failed branch already reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, and `details.get("retryable", True)`, persists `error`/`error_stage`/`retryable` on the main document, and writes `processing/summary.error` as `{code: error_code | "UNKNOWN", message, stage}`. Changes here are limited to whatever the contract test exposes as necessary; reads and persisted field names stay exactly as they are.

3. **`apps/ai-server/tests/integration/` — new contract test** (following the existing `test_api_contracts.py` patterns)
   - Builds the worker's failure payload through the worker's own code path (not a restated fixture), feeds it through rag-api's `run_transactional_update` against the Firestore emulator or fakes, and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
   - Includes a key-set drift guard so a future edit to either side's payload keys fails the build instead of silently re-creating this bug.
   - Pins the stage-tracker mechanism on representative stages (an early-stage failure and a late-stage failure) without ossifying every pipeline step.

Verified seam (scoping evidence):
- Worker publishes failed status with details `{"error": str(e)}` from `process_document`'s exception handler via `_publish_status_update` (rag-worker-service/main.py).
- rag-api's failed branch reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main doc, plus `message`/`stage`/`code` in the `processing/summary` error subdocument (rag-api-service/main.py, `run_transactional_update`).
- The persisted schema `error`/`error_stage`/`retryable` is already written directly by the worker's stale-lease sweep (`_fail_if_still_stale`: `error_stage: "processing"`, `retryable: True`) and rag-api's enqueue-failure paths (POST `/process` and POST `/resources`: `error_stage: "enqueue"`), and is exposed by the `Resource` model and `ResourceResponse`.
- The worker's ACK/NACK logic in `run_worker` uses `classify_error(e)`: transient → NACK (Pub/Sub redelivers), permanent → ack; unknown exceptions classify as permanent (conservative `False`).

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing stage, and a deliberately derived retryable flag so users and support can disambiguate failures. Today every worker-originated failure lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`, because the worker's failure publisher and rag-api's failure consumer were written against different contracts and nobody tests the seam.

The fix direction is aligning the worker to the API, and the repository evidence makes that more than the cheap option: the persisted field names are already consistent across three other write paths and two API response models, so changing the API side would be the change that ripples. The worker is the odd one out; fix the odd one out — no migration, no backfill, no reader changes.

Deriving `retryable` from `classify_error` makes the persisted record tell the truth about what Pub/Sub will actually do: a transient error is one Pub/Sub will redeliver (retryable true); a permanent error was acked and will not come back (retryable false, with manual reprocess via POST `/process` still available). The contract test locks the seam so key drift on either side fails the build.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.
6. (Preferred, per constraint) Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.

## Boundaries

Must not:
- Change rag-api's reads or persisted schema — the worker aligns to rag-api's existing contract, not vice versa.
- Require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Let the API-side `details.get("retryable", True)` fallback be the operative mechanism for worker failures — every worker-originated failure payload carries `retryable` explicitly.

Out of scope (non-goals):
- The stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error `code` remains `"UNKNOWN"` unless a code is actually sent.
- Widening `classify_error`'s transient/permanent heuristics.
- Dropping the legacy `error` key — that is future cleanup, contingent on an audit confirming rag-api's status subscriber is the only consumer.

Accepted deliberate behavior change: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent, so they will now persist `false`. That is the conservatism `classify_error` was written for — it prevents infinite retry loops — and the manual reprocess path via POST `/process` is unaffected. The stale-lease sweep's separate `retryable: true` write stays correct: a dead worker is a transient condition by nature.

Risks accepted: unknown consumers of the status topic reading the old key set (mitigated by retaining `error`; residual risk accepted as low); stage-tracker drift as the pipeline evolves (convention: set the tracker immediately before the await; contract test pins representative early- and late-stage failures); the contract test ossifying the payload (intentional — that is the drift guard doing its job; adding a key later means touching the test).

## Version bump

- **rag-worker-service: patch bump.** The failure status payload gains keys and a derived `retryable`; no public API surface, schema, or migration change.
- **rag-api-service: no bump** if implementation confirms `run_transactional_update` needs no code change (its failed branch already reads the contract keys); apply a patch bump only if the contract test forces a change there.
- **Tests: no runtime version bump** for the new contract test.
- Note: the version manifests for these services were not verified during scoping; apply the bump wherever the worker service's version is tracked, or skip if no manifest exists.

## Deferred items

- The companion D3 issue referenced by the Objective — its content is unavailable in this context; anything it covers beyond this worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text.
- Dropping the worker's legacy `error` key from the failure payload, pending a confirmed audit that rag-api's status subscriber is the only consumer of the status topic.
- A structured error-code taxonomy / failure classification surfaced in payloads (the summary `error.code` remains `"UNKNOWN"`).
- Widening `classify_error`'s transient heuristics (e.g., for genuinely transient-but-unrecognized failures that will now persist `retryable: false`).
- Any frontend or mobile work related to failure display.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>