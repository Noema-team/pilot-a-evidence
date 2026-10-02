<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
**Cycle Charter — rag-worker → rag-api failure payload contract alignment**
Run 4d5c966b-e277-4c2d-bc73-3c8abcfcd6fb · Iteration 1 · Step scoping.produce
Authoritative scope: wi-define-108-a8 (artifact `definition:obj-108`) — binding; supporting material is subordinate.

## Scope

This cycle changes the rag-worker's failure reporting to match rag-api's existing failed-branch contract, and adds the contract test that pins the seam. Concretely:

- **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler → `_publish_status_update`): the `failed` status `details` payload is rebuilt to carry `error_message` (the actual exception message), `stage` (the failing pipeline stage), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a hedge for unverified consumers of the status topic.
- **Stage tracking** in `process_document`: a stage tracker set immediately before each pipeline step so the failure handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary verified in the code (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown — the same value the worker's stale-lease sweep (`_fail_if_still_stale`) writes to `error_stage`.
- **retryable derivation**: the worker sets `retryable` from `classify_error(e)` — transient-classified errors map to `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) map to `false`. This mirrors the ACK/NACK decision in `run_worker` (transient → omitted from ack_ids so Pub/Sub redelivers; permanent → acked).
- **Contract test** under `apps/ai-server/tests/integration/`: exercises the worker's failure-payload construction, feeds it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes, asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and includes a key-set drift guard so an edit to either side's payload keys fails the build. Built on the existing fixture/AST patterns in `tests/integration/test_api_contracts.py`; both services have verified `FIRESTORE_EMULATOR_HOST` branches supporting hermetic runs.

Pinned, not changed: rag-api's failed branch (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update`) already persists `error ← details.error_message`, `error_stage ← details.stage`, `retryable ← details.retryable` on the main document and writes `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument. The worker aligns to this; the test pins it.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. Verified today: the worker's exception handler publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`) and falls back to `"Processing failed"`, `None`, and `True` when they are absent. Every worker-originated failure therefore lands in Firestore as the fallback string, a null stage, and a fabricated `retryable: true` — and the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures (product intent F1).

The worker aligns to the API because the persisted failure schema (`error`/`error_stage`/`retryable`) is already consistent across the other write paths — the worker's stale-lease sweep and rag-api's enqueue-failure paths write it directly, and `ResourceResponse` plus the `Resource` model expose it (`retryable` defaulting `True`). The worker's status publisher is the only writer that doesn't speak the schema. Fixing the odd one out avoids any migration, backfill, or reader change.

One deliberate behavior change is accepted: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent under `classify_error`; after this cycle they persist `false`. That is the conservatism `classify_error` was written for — it prevents infinite retry loops — and manual reprocess via `POST /process` is unaffected. The stale-lease sweep's separate `retryable: true` write stays correct: a dead worker is a transient condition.

## Requirements

Binding requirements carried from the authoritative definition:

1. When document processing fails, the worker's `failed` status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The `retryable` derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Acceptance signals for cycle completion:

- A failed job's published status message contains `error_message`, `stage`, and `retryable`, none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
- The contract test exists and passes, exercising payload construction through failed-branch persistence with a key-drift guard on both sides.

## Boundaries

Hard constraints:

- **Must** — the worker aligns to rag-api's existing contract (publishing `error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed.
- **Must not** — no Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must** — every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer** — retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **Prefer not** — do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — `_fail_if_still_stale` already persists `error`/`error_stage` (`"processing"`)/`retryable` (`true`) consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error `code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (see Deferred items).

Accepted risks (recorded from scoping):

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the "set the tracker immediately before the await" convention and representative-stage contract coverage (an early-stage and a late-stage failure), enough to catch the tracker being removed or bypassed without ossifying every step.
- `retryable: false` for genuinely transient but unrecognized failures — accepted; widening `classify_error` is out of scope and manual reprocess remains.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job.

## Version bump

- **rag-worker-service: minor.** Behavior change in observable failure reporting: failure payloads gain `error_message`/`stage`/`retryable`, and unclassified-unknown failures now persist `retryable: false` instead of the silent default `true`. A minor bump (not patch) reflects the deliberate behavior change; apply it under whatever release convention governs this service.
- **rag-api-service: none.** No code change planned; its existing failed-branch behavior is pinned by the new contract test.
- **Persisted data: none.** Documents keep `schema_version: 2` (verified as written by both the worker's claim transaction and rag-api's `run_transactional_update`); no migration, rename, or backfill.
- Caveat: no service-level version file was identified in the verified tree for either service; the classification above is a release recommendation for this cycle, not a file edit in scope.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its content is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred (definition fact F12).
- **`plans/upload-flow.md` D4 reconciliation**: the file is not present in the current tree (verified against the `plans/` directory); the reference originates in the Objective text. Reconciling the original deviation analysis with this charter is deferred until the file or the D3 issue content is available.
- **Dropping the legacy `error` key** from the worker's failure payload: pending an audit confirming the worker is the only publisher and rag-api the only consumer of the status topic; trivial cleanup if confirmed.
- **Widening `classify_error`** to recognize more transient conditions: out of scope; the `retryable: false` conservatism for unclassified errors stands this cycle.
- **Structured error-code taxonomy / failure taxonomy**: the `processing/summary` error `code` stays `"UNKNOWN"` unless a code is actually sent.
- **Frontend/mobile surfacing changes**: none needed; `ResourceResponse` already exposes `error` and `error_stage`.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>