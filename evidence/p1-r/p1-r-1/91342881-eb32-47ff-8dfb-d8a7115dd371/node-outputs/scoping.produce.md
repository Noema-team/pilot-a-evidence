<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

Two change targets, nothing else:

1. **`apps/ai-server/rag-worker-service/main.py` — the worker's failure status payload.** The exception handler in `EnhancedDocumentProcessor.process_document` currently publishes a one-key details payload, `{"error": str(e)}`, on the `"failed"` status update. It must instead publish:
   - `error_message` — the actual exception message (`str(e)`, unchanged);
   - `stage` — the pipeline stage executing at failure time, from a stage tracker maintained inside `process_document` (set immediately before each pipeline step; convention: update-before-await);
   - `retryable` — derived explicitly from the existing `classify_error(e)`: transient-classified → `true`; permanent-classified, including unclassified-unknown (classify_error's conservative default) → `false`;
   - the legacy `error` key retained alongside `error_message` (same string) as a compatibility hedge for any unverified consumer of the status topic.

   Stage names reuse the existing progress vocabulary already published by `process_document` (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown (e.g. failure before the first transition) — the same value the worker's stale-lease sweep (`_fail_if_still_stale`) already writes to `error_stage`, so the field never regresses to null.

2. **A contract test covering the worker failure → rag-api persistence path**, added in the existing integration contract-test location (`apps/ai-server/tests/integration/`, alongside `test_api_contracts.py` and its mocked-cloud `conftest.py`, which already supports direct imports of the rag-api module). The test imports both sides rather than restating the contract in a fixture: it exercises the worker's failure-payload construction, feeds the payload through rag-api's `run_transactional_update` failed branch (Firestore emulator or fakes — both services already have `FIRESTORE_EMULATOR_HOST` branches), and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must include a key-set drift guard on both sides' payload keys so a future key edit fails the build instead of silently re-creating this bug, and it must cover a representative early-stage failure and a representative late-stage failure (enough to catch the stage tracker being removed or bypassed without ossifying every pipeline step).

rag-api-service production code is the reference side of the contract, not a change target: its failed branch in `run_transactional_update` already reads `error_message`/`stage`/`retryable`, persists `error`/`error_stage`/`retryable` on the main resource document, and writes `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument. The worker aligns to the API; nothing on the API side changes.

## Purpose

Every worker-originated failure currently lands in Firestore as a lie. The worker publishes `{"error": str(e)}`; rag-api's failed branch reads `error_message`/`stage`/`retryable` and falls back to `"Processing failed"`, `None`, and `True` respectively. Users and support cannot disambiguate failures, the failing stage is lost, and `retryable` is fabricated rather than derived. The `processing/summary` error subdocument inherits the same fallbacks, with `error_code` always `"UNKNOWN"`.

The fix direction is deliberate: the persisted failure schema (`error`/`error_stage`/`retryable`) is already established across the worker's stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource` model / `ResourceResponse` — the worker's status publisher is the only writer that doesn't speak it. Aligning the worker avoids any Firestore migration, field rename, or backfill, and leaves rag-api's reads and persisted schema untouched.

One deliberate behavior change is accepted and should be surfaced in review: unclassified-unknown exceptions currently persist `retryable: true` via rag-api's silent default but classify as permanent under `classify_error`, so they will now persist `retryable: false`. That matches the worker's actual ACK/NACK behavior in `run_worker` (permanent errors are acked, not redelivered; manual reprocess via `POST /process` remains available) and is the conservatism `classify_error` was written for. The stale-lease sweep's separate direct write keeps `retryable: true`, which stays correct — a dead worker is a transient condition.

## Requirements

1. Every worker-originated failed status payload must carry `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage. (Verified as already true in current code; this is a pinned invariant, not new work.)
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent, including unclassified-unknown → `retryable: false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.
6. The legacy `error` key is retained in the worker's failure payload alongside `error_message` (constraint: prefer).
7. No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics (constraint: must_not).
8. No structured error-code taxonomy is introduced; the summary `error.code` remains `"UNKNOWN"` unless a code is actually sent (constraint: prefer_not).

## Boundaries

Out of scope for this cycle:

- **rag-api-service production code** — reads, persisted schema, `ResourceResponse`, and the `Resource` model are unchanged; the worker aligns to the API, never the reverse.
- **The stale-lease sweep** (`_fail_if_still_stale`) — its direct failure write already persists `error`/`error_stage`/`retryable` consistently with this contract.
- **Retry/backoff mechanics** — Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals are untouched; only the *reporting* of retryability in the payload changes.
- **Frontend or mobile changes** — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **Widening `classify_error`** — the `retryable: false` outcome for unrecognized exceptions is accepted; reclassifying error types is separate work.
- **Dropping the legacy `error` key** — deferred until/unless a consumer audit confirms the worker is the only publisher and rag-api the only consumer of the status topic.
- **Anything the companion D3 issue covers** beyond this worker→rag-api failure payload alignment (its content is unavailable in this context).

## Version bump

Patch level, rag-worker-service only.

- This is a behavioral bug fix in failure reporting: the payload gains keys (`error_message`, `stage`, `retryable`) additively while the legacy `error` key is retained, the persisted schema is unchanged, and rag-api is unchanged — no breaking change on any verified interface.
- No Firestore schema/migration version bump applies; the constraints explicitly forbid migration, rename, or backfill.
- No central version manifest was verified in the investigated tree; the only version string seen is FastAPI app metadata (`version="1.0.0"`) in `rag-api-service/main.py`, which is unaffected by this change. The services ship as Docker images, so the practical bump surface is the rag-worker-service image; treat it as a patch release under the repo's existing image-tagging convention.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`**: that file is not present in the current tree (the reference comes from the Objective text); reconciliation is deferred until the file or its successor exists.
- **Dropping the legacy `error` key** from the worker's failure payload, pending a consumer audit of the status topic.
- **Structured error-code taxonomy** (`error_code` values beyond the `"UNKNOWN"` default).
- **Widening `classify_error`** to recognize additional transient failure modes.
- **Exposing `retryable` to clients**: `ResourceResponse` exposes `error`/`error_stage`; `retryable` is persisted on the `Resource` model but was not verified as client-exposed — any exposure work is separate.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>