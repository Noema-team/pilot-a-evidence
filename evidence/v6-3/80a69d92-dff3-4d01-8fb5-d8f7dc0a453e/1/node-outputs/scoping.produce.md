Charter produced from the pinned Definition and the evidence verified during investigation (worker/api service structure, `Resource` model failure fields, `classify_error`/ACK-NACK wiring in `run_worker`, `_publish_status_update` shape, and the existing contract-test patterns in `apps/ai-server/tests/integration/test_api_contracts.py`).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

In scope:

1. **Worker failure payload** — `apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler: the failed status `details` must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived), with the legacy `error` key retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
2. **Stage tracking** — a stage tracker in `process_document`, set immediately before each pipeline step ("set before the await" convention) and reported by the failure handler. Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`; `"processing"` is the safe value when the stage is genuinely unknown (the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null).
3. **retryable derivation** — derived from `classify_error(e)`, the same classification that drives ACK/NACK in `run_worker`: transient-classified errors → `retryable: true`; permanent-classified, including unclassified-unknown (classify_error's conservative default) → `retryable: false`.
4. **rag-api failed branch** — `apps/ai-server/rag-api-service/main.py` `run_transactional_update` persists the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument carries the same message and stage; `error_code` remains `"UNKNOWN"` unless a code is actually sent (none will be sent in this cycle). No reader or persisted-schema changes; expected code change on this side is none-to-minimal, pinned by the contract test.
5. **Contract test** — new test(s) under `apps/ai-server/tests/integration/` alongside `test_api_contracts.py`, following its existing fixture- and AST-based patterns. The test imports both sides rather than restating the contract in a fixture: it builds the failure payload through the worker's code path, feeds it through rag-api's failed-branch persistence against the Firestore emulator or fakes (both services have hermetic `FIRESTORE_EMULATOR_HOST` branches), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and includes a key-set drift guard so a future edit to either side's payload keys fails the build. Coverage pins representative stages — an early-stage failure and a late-stage failure — enough to catch the tracker being removed or bypassed without ossifying every step.

Expected touch points: `rag-worker-service/main.py` (payload construction + stage tracker); new/extended contract test file(s) under `apps/ai-server/tests/integration/`; `rag-api-service` only if the contract test surfaces a gap.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — and the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures, and retryability is silently defaulted instead of deliberately derived.

The worker aligns to the API, not the reverse: `error`/`error_stage`/`retryable` is the established persisted schema — the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths (`/process`, `POST /resources`), and the `Resource` model plus `ResourceResponse` all already speak it. The worker's status publisher is the only writer that doesn't. Fixing the odd one out avoids any Firestore migration, field rename, or backfill.

Deriving `retryable` from `classify_error` makes the persisted record tell the truth about retry behavior: a transient error is one Pub/Sub will redeliver (retryable true); a permanent error was acked and will not come back (retryable false; manual reprocess via `POST /process` remains). One deliberate behavior change follows: unclassified-unknown exceptions currently persist `retryable: true` via the silent default but classify as permanent, so they will now persist `false` — the conservatism `classify_error` was written for, preventing infinite retry loops. The stale-lease sweep's separate `retryable: true` write stays correct: a dead worker is a transient condition by nature.

## Requirements

- **R1 — Failure payload completeness:** when document processing fails, the worker's failed status payload includes `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload never relies on rag-api's fallback defaults for these keys.
- **R2 — Stage tracking:** the worker tracks the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- **R3 — rag-api persistence fidelity:** the failed branch persists worker-provided values unchanged — main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable` — and the `processing/summary` error subdocument carries the same message and stage.
- **R4 — Explicit retryable derivation:** transient per `classify_error` → `true`; permanent, including unclassified-unknown per `classify_error`'s conservative default → `false`. Aligned with the worker's ACK/NACK behavior in `run_worker`.
- **R5 — Contract test:** a test covers the worker failure → rag-api persistence path, exercising the worker's failure-payload construction and rag-api's failed-branch persistence (Firestore emulator or fakes), asserting the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and failing if either side's payload keys drift.

Acceptance criteria this cycle must satisfy (all currently unmet):

- A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
- The contract test covering the worker failure → rag-api persistence path exists and passes, failing if either side's payload keys drift.

## Boundaries

Hard constraints:

- **Must:** align the worker to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- **Must not:** require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must:** every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer:** retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **Prefer not:** introduce a structured error-code taxonomy (`error_code` values) in this fix.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (its `retryable: true` stays correct: a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains "UNKNOWN" unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment.

Accepted risks and tradeoffs:

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- `retryable: false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope and manual reprocess via `POST /process` remains.
- The contract test ossifies the payload — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Version bump

- **No database schema bump:** forbidden by constraint — no Firestore migration, field rename, or backfill; the resource document's persisted failure fields keep their names and semantics. The `schema_version: 2` value written on the resource document at claim time is untouched by this cycle.
- **No client-facing API contract change:** `ResourceResponse`'s exposed failure fields (`error`, `error_stage`, `retryable`) are unchanged; the mobile contract fixtures under `apps/ai-server/tests/fixtures/api-contracts/` are unaffected.
- **Service-level magnitude: bug-fix scope.** `rag-worker-service` carries the behavior change (payload keys, stage tracking, retryable derivation); `rag-api-service` is expected to need no code change (patch at most, only if the contract test surfaces a gap). Both ship as container images (Dockerfile per service); treat as patch-level rebuilds.
- **Repo release/versioning convention:** not verified during this cycle's investigation and not assumed here — implementers should follow whatever bump process the repo already uses; no bump beyond that is required by this scope.

## Deferred items

- **Companion D3 issue:** the Objective references a D3 issue filed alongside this one; its content is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle.
- **`plans/upload-flow.md` deviation D4 reconciliation:** the Objective cites original analysis there, but the file is not present in the current tree (per the Definition's investigation; the reference exists only in Objective text). Reconciliation is deferred until that artifact exists.
- **Dropping the legacy `error` key** from the worker's failure payload: deferred pending an audit of status-topic consumers; if the worker is confirmed as the only publisher and rag-api the only consumer, removal is trivial cleanup.
- **Widening `classify_error` coverage** (recognizing more transient failure shapes): deferred; the accepted tradeoff is that unrecognized-transient failures persist `retryable: false`, with manual reprocess via `POST /process` available.
- **Structured error-code taxonomy / failure taxonomy:** prefer-not now; revisit only if failure disambiguation demands grow beyond message + stage.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>