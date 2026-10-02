<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

Authoritative source: define-work WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This charter restates that scope for approval; it neither widens nor narrows it.

Cycle intent: rag-worker → rag-api failure payload contract mismatch — failures persist without message or stage.

In scope for this cycle:

1. **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`, the `process_document` exception handler / `_publish_status_update` path): the failed status payload must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unverified consumer of the status topic.
2. **Stage tracking in `process_document`**: a stage tracker set immediately before each pipeline step and reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`); `"processing"` is the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.
3. **retryable derivation**: derived from the worker's existing `classify_error()` — transient-classified errors → `retryable: true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`. This mirrors the ACK/NACK decision `run_worker` already makes from the same classification.
4. **rag-api side — test-only pinning, no code change expected**: the failed branch of `run_transactional_update` (verified in `apps/ai-server/rag-api-service/main.py`) already reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, and `details.get("retryable", True)`; persists `error`/`error_stage`/`retryable` on the main document; and writes `code` (default `"UNKNOWN"`), `message`, and `stage` into the `processing/summary` error subdocument. This cycle changes none of that behavior; the contract test pins it.
5. **Contract test** in `apps/ai-server/tests/integration/` (house pattern verified present: `test_api_contracts.py` plus the `fixtures/api-contracts/` response-shape fixtures; both services have verified `FIRESTORE_EMULATOR_HOST` hermetic branches): build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` against the Firestore emulator or fakes, and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. Include a key-set drift guard on both sides so a future key edit on either side fails the build. Cover representative stages: an early-stage failure and a late-stage failure — enough to catch the tracker being removed or bypassed without ossifying every step.

Expected change surface: `apps/ai-server/rag-worker-service/main.py` plus a new or extended integration contract test. No changes anticipated in `apps/ai-server/rag-api-service/main.py` or `apps/ai-server/rag-api-service/models/resource.py` (verified: the `Resource` model already carries `error`/`error_stage`/`retryable`, with `retryable` defaulting `True`).

## Purpose

Every worker-originated failure currently lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`, because the worker publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch reads `error_message`/`stage`/`retryable`. Users and support cannot disambiguate failures, and the persisted retryable flag does not reflect the worker's actual ACK/NACK behavior.

The fix direction is deliberate: the worker aligns to the API, because `error`/`error_stage`/`retryable` is already the persisted schema across three other write paths (the worker's stale-lease sweep, rag-api's enqueue-failure paths) and both response models — the worker's status publisher is the only writer that does not speak it. No migration, no backfill, no reader changes. A contract test locks the seam so key drift on either side fails CI instead of silently re-creating this bug.

One deliberate behavior change falls out: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent, so they will now persist `false` — the conservatism `classify_error` was written for. Manual reprocess via `POST /process` is unaffected, and the stale-lease sweep's separate `retryable: true` write stays correct (a dead worker is a transient condition by nature).

## Requirements

From the authoritative Definition (binding):

1. When document processing fails, the worker's failed status payload must include `error_message` (actual exception message), `stage` (pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → retryable `true`; classified permanent (including unclassified-unknown) → retryable `false`.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Acceptance criteria (from the Definition; all currently unmet):

- A failed job's status message published by the worker contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
- The contract test covering the worker failure → rag-api persistence path exists and passes, failing if either side's payload keys drift.

## Boundaries

Constraints (from the Definition):

- **Must**: align the worker to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- **Must not**: require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must**: every worker-originated failure payload carries `retryable` explicitly (deliberately derived); rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer**: retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **Prefer not**: introduce a structured error-code taxonomy (`error_code` values) in this fix.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred — see below).

Risks accepted within scope: unknown status-topic consumers reading the old key set (mitigated by retaining `error`; residual risk accepted as low); stage-tracker drift as the pipeline evolves (mitigated by the set-the-tracker-immediately-before-the-await convention and representative-stage test coverage); `retryable: false` for genuinely transient-but-unrecognized failures (accepted; widening `classify_error` is out of scope and manual reprocess remains); the contract test ossifying the payload (intentional — that is the drift guard doing its job).

## Version bump

No version bump required for this cycle.

- No persisted schema change, no field rename, no migration, no backfill — the persisted `error`/`error_stage`/`retryable` fields keep their names and semantics (verified in `apps/ai-server/rag-api-service/models/resource.py`).
- No client-facing API shape change: `ResourceResponse`/`Resource` are untouched; mobile and web are unaffected.
- No new runtime dependencies.
- The changed wire format is the internal worker→rag-api status topic, aligned to the contract its only verified consumer (rag-api's status subscriber) already reads.

Not verified in this cycle: whether either service carries a service-level version manifest — none was present in the verified `rag-api-service` directory listing (`.python-version` there is the Python runtime version, not a service version). If release tooling requires a bump, this is patch-level at most.

Workflow note (per `AGENTS.md`): the change surface is `rag-worker-service` plus the shared `apps/ai-server/tests/integration` suite, with no rag-api code change anticipated — this fits the small-change path (`fix/<slug>`, single PR to `main`): no data model/schema/migration changes, no new dependencies, one service plus tests. The one checklist clause worth a human glance is "no cross-client contract changes": the status-topic payload keys change, but toward the shape the consumer already implements, and no mobile/web-shared shape changes. Recommended: small-change path; escalate to the feature path only if implementation reveals otherwise.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its content is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle.
- **Reconciliation with the original D4 deviation note in `plans/upload-flow.md`**: that file is not present in the current tree (verified absent from both the repo-root `plans/` and `docs/documentation/plans/`); the reference exists only in the Objective text.
- **Dropping the legacy `error` key** from the worker's failure payload: trivial cleanup once an audit confirms rag-api's status subscriber is the only consumer of the topic; the duplicate is retained this cycle as the compatibility hedge.
- **Audit of other potential status-topic consumers**: not performed this cycle; the retained `error` key makes it non-blocking.
- **Widening `classify_error`'s classification coverage** (recognizing more transient failure modes): out of scope; the `retryable: false` default for unclassified errors is accepted for this cycle.
- **Structured error-code taxonomy**: deferred; `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>