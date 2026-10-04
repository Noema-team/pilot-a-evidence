Scoping complete. The charter below is derived from the authoritative Definition plus the repository evidence verified during investigation (worker `process_document` handler publishing `{"error": str(e)}`, `classify_error` semantics and its ACK/NACK use in `run_worker`, the sweep's `error`/`error_stage: "processing"`/`retryable: True` write, the progress-stage vocabulary, the `Resource` model's `error`/`error_stage`/`retryable` fields, and the existing `test_api_contracts.py` pattern). Claims I could not re-verify directly (rag-api's failed-branch internals) are carried from the Definition and marked as pinned-by-test rather than restated as independently verified.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle changes one production file and adds one contract test.

**1. `apps/ai-server/rag-worker-service/main.py` — failure payload alignment (worker side only).**

- `process_document`'s exception handler currently publishes `"failed"` status with a one-key details dict — verified in the handler: `await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)`. Replace that payload with:
  - `error_message`: the actual exception message (`str(e)`);
  - `stage`: the pipeline stage executing at failure time, from a stage tracker maintained through `process_document`;
  - `retryable`: derived explicitly from the existing `classify_error(e)` — transient-classified → `true`; permanent-classified, including unclassified-unknown (per `classify_error`'s conservative default), → `false`;
  - the legacy `error` key retained alongside `error_message` (compatibility hedge for status-topic consumers not verified in this cycle).
- **Stage tracking.** `process_document` is one large `try` block; add a stage tracker set immediately before each pipeline step (convention: set-then-await). Stage names reuse the existing progress-update vocabulary — `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` — with `"processing"` as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep writes to `error_stage`, so the field never regresses to null). The `_publish_status_update` envelope (`user_id`/`course_id`/`resource_id`/`status`/`details`/`timestamp`/`sequence`) is unchanged; only the failed branch's `details` dict changes.
- `classify_error` itself is not modified; it is consumed as-is for the derivation.

**2. Contract test — worker failure → rag-api persistence path.**

- A new contract test following the existing fixture- and AST-based house pattern in `apps/ai-server/tests/integration/test_api_contracts.py` (exact file placement within the existing integration-test layout at implementer's discretion).
- It must import both sides rather than restate the contract in a fixture: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes (both services have hermetic `FIRESTORE_EMULATOR_HOST` branches), and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
- Include a key-set drift guard so a future edit to either side's payload keys fails the build instead of silently re-creating this bug.
- Cover representative stages — an early-stage failure and a late-stage failure — pinning the tracker mechanism without ossifying every pipeline step.

**3. `apps/ai-server/rag-api-service` — pinned, not modified.** Its failed branch reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable`, writing message/stage with `error_code` defaulting to `"UNKNOWN"` into the processing/summary subdocument (Definition facts F4/F6; verified independently for the `Resource` model's `error`/`error_stage`/`retryable` fields in `rag-api-service/models/resource.py`). The contract test pins this behavior as-is. If implementation contradicts F4, surface it as a deviation for review — do not silently grow scope by editing rag-api.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker publishes `{"error": str(e)}`; rag-api's failed branch reads `error_message`, `stage`, and `retryable`. Every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`; the processing/summary error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures.

The persisted `error`/`error_stage`/`retryable` schema is already established across three other write paths — the worker's stale-lease sweep (`_fail_if_still_stale`, verified writing `error`/`error_stage: "processing"`/`retryable: True`) and rag-api's enqueue-failure paths (`/process`, `POST /resources`) — and is exposed by `ResourceResponse` and the `Resource` model (`retryable` defaults `True`). The worker's status publisher is the only writer that doesn't speak it, so the worker aligns to the API, not the reverse: no migration, no field rename, no backfill, no reader changes.

One deliberate behavior change follows: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent under `classify_error`; they will now persist `false`. That is the conservatism `classify_error` was written for, and it makes the persisted record tell the truth about what Pub/Sub will do (transient = redelivered; permanent = acked, with manual reprocess via `POST /process` remaining available). The stale-lease sweep's separate `retryable: true` write stays correct: a dead worker is a transient condition by nature.

## Requirements

Binding requirements (restated from the authoritative Definition):

1. **Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **API persistence unchanged.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. **Explicit retryable derivation, aligned with ACK/NACK.** Errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`. This mirrors `run_worker`'s existing ACK/NACK behavior (verified: transient errors are omitted from `ack_ids` so Pub/Sub redelivers; permanent errors are acknowledged).
5. **Contract test.** A contract test must cover the worker failure → rag-api persistence path: exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes), assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and fail if either side's payload keys drift.

Preferred (from the Definition's constraint set):

6. Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
7. Do not introduce a structured error-code taxonomy (`error_code` values) in this fix; the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.

Acceptance criteria (definition of done for this cycle):

- A failed job's status message published by the worker contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The processing/summary error subdocument for the failed job carries the same message and stage as the main document.
- The contract test exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift.

## Boundaries

Hard boundaries — must not do:

- **No rag-api contract or schema changes.** The worker aligns to rag-api's existing reads and persisted schema; the persisted field names and semantics (`error`, `error_stage`, `retryable`) are unchanged. No Firestore migration, field rename, or backfill of existing documents.
- **No silent defaults.** Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **No retry/backoff mechanics changes.** Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals are untouched — only the reporting of retryability in the payload changes.
- **No changes to the stale-lease sweep.** `_fail_if_still_stale` already persists `error`/`error_stage`/`retryable` consistently with this contract.
- **No frontend or mobile changes.** `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **No structured error-code taxonomy.** The processing/summary `error.code` stays "UNKNOWN" unless a code is actually sent.
- **No widening of `classify_error` and no alternative retryability source.** The derivation is `classify_error`-based per the Definition; other retryability signals that exist in the tree (e.g. the `retryable` metadata attribute on `PDFProcessingError` in `rag-worker-service/exceptions.py`) are not adopted in this fix.
- **No legacy-key removal.** Dropping the retained `error` key is future cleanup contingent on a consumer audit — not this cycle.

Known, accepted risks (documented, not mitigated in-scope): unknown consumers of the status topic reading the old key set (mitigated by retaining `error`; residual risk accepted as low); stage-tracker drift as the pipeline evolves (mitigated by the set-immediately-before-the-await convention and representative-stage test coverage); `retryable: false` for unrecognized-but-genuinely-transient failures (accepted; manual reprocess remains available).

## Version bump

No version bump is mandated by the Definition, and no version manifest for `rag-worker-service` or `rag-api-service` was verified during scoping, so this charter does not invent one. Guidance for the implementer:

- The change alters worker-published payload contents and adds tests; it does not change any persisted schema, public API surface, or client-facing model (`ResourceResponse` fields are untouched), so no consumer-driven version requirement arises.
- If the repository's convention is to bump a changed service's version per deployable change, apply a patch-level bump to `rag-worker-service` only; `rag-api-service` code is not modified in this cycle.
- Follow the repo's existing convention; do not introduce a new versioning scheme as part of this fix.

## Deferred items

- **Companion D3 issue.** The Objective references a companion D3 issue filed alongside this one; its scope is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **`plans/upload-flow.md` D4 reconciliation.** The original analysis is said to live there as deviation D4, but that file is not present in the current tree (the reference comes from the Objective text). Reconciling this charter's analysis with it is deferred until the file's whereabouts are established.
- **Legacy `error` key retirement.** If a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic, dropping the duplicate key is trivial cleanup — deferred, not part of this cycle.
- **`classify_error` widening.** Recognizing more transient failure modes (reducing `retryable: false` for unrecognized-but-transient errors) is deferred; manual reprocess via `POST /process` covers the gap in the meantime.
- **Structured error-code taxonomy.** Revisit only if failure disambiguation eventually demands machine-readable codes; the processing/summary `error.code` remains "UNKNOWN" for now.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>