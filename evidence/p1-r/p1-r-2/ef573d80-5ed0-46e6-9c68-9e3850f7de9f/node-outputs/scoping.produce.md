Investigation is complete; the charter below is produced strictly from the evidence verified during the read phase (worker `main.py` failure handler, stage publishes, `classify_error`/ACK-NACK wiring, stale-lease sweep; rag-api `run_transactional_update` failed branch, `Resource` model, `ResourceResponse`, enqueue-failure paths; `tests/integration/test_api_contracts.py`; `AGENTS.md` workflow rules). Anything not verified is marked as such rather than asserted.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

Production change is confined to `apps/ai-server/rag-worker-service`; the contract test is added under `apps/ai-server/tests/integration/`. rag-api-service code is not expected to change.

- **Worker failure payload** (`rag-worker-service/main.py`, `process_document` exception handler): the failed status publish currently sends only `{"error": str(e)}` (verified). It must send `error_message` (the actual exception message), `stage` (the failing pipeline stage), and `retryable` (deliberately derived), while retaining the legacy `error` key alongside `error_message` as the compatibility hedge for unknown consumers of the status topic (F11).
- **Stage tracking in `process_document`**: a stage tracker set immediately before each pipeline step and reported by the failure handler. Stage names reuse the existing progress-update vocabulary (verified in the worker's progress publishes): `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. `"processing"` is the safe value when the stage is genuinely unknown — the same value the stale-lease sweep (`_fail_if_still_stale`) already writes for `error_stage` (verified).
- **retryable derivation**: `retryable` comes from `classify_error(e)` — transient-classified errors map to `True`, permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) to `False`. This aligns the persisted record with the worker's ACK/NACK behavior in `run_worker`, which already uses `classify_error` for exactly that decision (verified).
- **rag-api-service**: no reader or persisted-schema change. The failed branch of `run_transactional_update` already reads `error_message`/`stage`/`retryable`, persists `error`/`error_stage`/`retryable` on the main document, and writes `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` subdocument (verified). It persists worker-provided values unchanged; this cycle makes the worker's payload operative against that existing branch.
- **Contract test**: a worker→rag-api failure-path contract test following the existing fixture/AST patterns in `apps/ai-server/tests/integration/test_api_contracts.py`. It must exercise the worker's failure-payload construction through rag-api's `run_transactional_update` persistence (Firestore emulator or fakes — both services have verified `FIRESTORE_EMULATOR_HOST` branches), assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, cover representative early-stage and late-stage failures, and include a key-set drift guard so a future edit to either side's payload keys fails the build.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore persists `error` as the fallback `"Processing failed"`, `error_stage` as `None`, and `retryable` as the silent default `True` — and the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate what failed or where.

The fix direction is deliberately one-sided: the worker aligns to rag-api's existing contract. The persisted `error`/`error_stage`/`retryable` schema is already written consistently by three other paths — the worker's stale-lease sweep and rag-api's enqueue-failure paths in `POST /process` and `POST /resources` (both verified writing `error`/`error_stage` directly) — and exposed by both `ResourceResponse` and the `Resource` model (`retryable` defaults `True`). The worker's status publisher is the only writer that doesn't speak it; fixing the odd one out requires no migration, no field rename, no backfill, and no reader changes.

Deriving `retryable` from `classify_error` makes the persisted record tell the truth about retry behavior: a transient error is one Pub/Sub will redeliver (retryable true); a permanent error was acked and will not come back (retryable false; manual reprocess via `POST /process` remains available). One deliberate behavior change follows: unclassified-unknown exceptions currently persist `retryable: true` via the silent default but classify as permanent, so they will now persist `false` — the conservatism `classify_error` was written for.

## Requirements

Binding requirements for this cycle:

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument carries the same message and stage. (Verified: the branch already does exactly this — the requirement is that the worker's payload make it operative, not that rag-api change.)
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown) → `retryable: false`.
5. A contract test must cover the worker failure → rag-api persistence path: it exercises the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and fails if either side's payload keys drift.

Acceptance criteria this cycle must satisfy:

- A failed job's published status message contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument carries the same message and stage as the main document.
- The contract test exists and passes, exercising worker payload construction through rag-api's failed-branch persistence with the key-set drift guard.

## Boundaries

Constraints:

- **Must**: align the worker to rag-api's existing contract (publishing `error_message`/`stage`/`retryable`) — not change rag-api's reads or persisted schema.
- **Must not**: require a Firestore migration, field rename, or backfill; the persisted fields `error`, `error_stage`, `retryable` keep their names and semantics. The `schema_version: 2` marker written by the transactional update stays as is.
- **Must**: every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer**: retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **Prefer not**: introduce a structured error-code taxonomy; the summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract (verified: `error_stage: "processing"`, `retryable: True`).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients (verified).
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context).

Known tradeoffs accepted by this charter:

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the "set the tracker immediately before the await" convention and representative-stage test coverage (early- and late-stage failure), not by ossifying every step.
- `retryable: false` for unclassified-unknown failures reduces auto-retry affordances for genuinely transient-but-unrecognized errors — accepted; widening `classify_error` is out of scope and manual reprocess via `POST /process` remains.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job. Adding a key later means touching the test.
- Observed but untouched: on failure, rag-api's summary update persists `progress` via its `details.get("progress", 0)` default (the worker's failure payload carries no progress key). Not part of this contract; unchanged.

Workflow fit (per `AGENTS.md`): no schema/migration change, no cross-client contract change (mobile/web consume `ResourceResponse`, which already exposes the persisted fields; the worker→rag-api Pub/Sub payload is internal to ai-server), no security/permissions, CI, or new-dependency change; production code touches one service (rag-worker-service) plus its tests, with the seam test in the shared integration suite. This fits the small-change path (`fix/<slug>` → single PR to `main`); escalate to the feature path if implementation reveals otherwise.

## Version bump

- No persisted-schema or data-model version change: Firestore documents keep `schema_version: 2`; the `Resource` model and `ResourceResponse` field sets are untouched; no migration or backfill.
- Versioning reality as verified: the only version string verified in the tree is rag-api's FastAPI app metadata (`version="1.0.0"`); no repo-wide or per-service version manifest was verified, and none was verified for rag-worker-service. This cycle is a behavior fix in the worker with no API-shape change, so it warrants at most a patch-level bump of the affected service if the release convention tracks one; no rag-api bump is warranted unless implementation ends up touching rag-api code (not expected — the contract test lives in the shared integration suite).

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred (F12, DEFERRED).
- **Reconciling with deviation D4** in `plans/upload-flow.md`: that file is not present in the current tree; the reference comes from the Objective text. Any reconciliation is deferred until the file or the original analysis is available.
- **Dropping the legacy `error` key** from the worker's failure payload: deferred pending an audit confirming the worker is the only publisher and rag-api the only consumer of the status topic; trivial cleanup once confirmed.
- **Widening `classify_error`** (e.g., recognizing additional transient conditions): out of scope; the unclassified-unknown → permanent conservatism stands for this cycle.
- **Structured error-code taxonomy / failure taxonomy**: prefer-not for this cycle; the summary `error.code` stays `"UNKNOWN"` unless a code is actually sent.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>