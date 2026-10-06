<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
Authoritative scope: define-work WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).

## Scope

Implement the worker-side alignment to rag-api's existing failed-branch contract, plus the contract test that pins the seam. Per the authoritative Definition, the worker is the odd writer out: the stale-lease sweep, rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse` already speak the `error`/`error_stage`/`retryable` schema.

**In scope — `apps/ai-server/rag-worker-service/main.py`:**

- **Failure payload keys.** The `process_document` exception handler currently publishes a one-key payload (`{"error": str(e)}`) via `_publish_status_update`. It must instead publish `error_message` (the actual exception message), `stage` (the failing pipeline stage), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` with the same message, as the compatibility hedge for unknown consumers of the status topic.
- **Stage tracking.** `process_document` is one large try block with no stage awareness at failure time. Add a stage tracker (a local set immediately before each pipeline step) reported by the exception handler. Stage names reuse the existing progress-update vocabulary — `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` — with `"processing"` as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep uses, so `error_stage` never regresses to null).
- **retryable derivation.** Derive `retryable` from the existing `classify_error(e)`: transient-classified errors → `true`; permanent-classified, including unclassified-unknown per `classify_error`'s conservative default, → `false`. This makes the persisted record match the worker's actual ACK/NACK behavior in `run_worker`. No changes to `classify_error` itself.
- **Envelope unchanged.** The failed status goes through the existing `_publish_status_update` (user_id/course_id/resource_id/status/details/timestamp/sequence message shape, sequence reset on terminal states, lease heartbeat). Only the `details` payload changes.

**In scope — `apps/ai-server/rag-api-service/`:** no code changes expected. The failed branch of `run_transactional_update` already reads `error_message`/`stage`/`retryable`, persists `error`/`error_stage`/`retryable` on the main document, and writes message/stage (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary error subdocument. This behavior is pinned by the contract test, not modified. Only if the contract test exposes actual drift on the API side is the minimal correction needed to satisfy the pinned contract in scope; any schema, read-path, or field-name change there is out of scope.

**In scope — contract test.** A new worker-failure → rag-api-persistence contract test following the house pattern in `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests) and, where runtime behavior is exercised, the hermetic patterns both services already support (`FIRESTORE_EMULATOR_HOST` branches in both services' init, verified in the worker's `_init_services`; the worker's test conftest module-stubbing pattern in `apps/ai-server/rag-worker-service/tests/conftest.py`; rag-api's MagicMock-based integration tests in `rag-api-service/tests/integration/test_endpoints.py`). The test must:

- Build the failure payload through the worker's actual code path (import the worker, not restate the contract in a fixture).
- Feed that payload through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes.
- Assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and that the processing/summary error subdocument carries the same message and stage.
- Include a key-set drift guard on both sides (worker payload keys and rag-api's read keys) so a future key edit on either side fails the build.
- Cover representative stages: an early-stage failure and a late-stage failure (enough to catch the tracker being removed or bypassed without ossifying every step).

Note: `apps/ai-server/rag-worker-service/tests/integration/` exists but contains only `__init__.py` (no existing worker integration tests). The contents of `apps/ai-server/tests/integration/conftest.py` were not verified in this cycle; the test may need its own stub setup mirroring the worker conftest pattern. Either location consistent with the existing test tree is acceptable.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker publishes `{"error": str(e)}`; rag-api's failed branch reads `error_message`, `stage`, and `retryable`. As a result, every worker-originated failure currently persists the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true` — on both the main resource document and the processing/summary error subdocument (whose `error_code` is always `"UNKNOWN"`). Users and support cannot disambiguate failures, and the persisted retryability does not reflect the worker's actual retry behavior.

The preferred fix direction — aligning the worker to rag-api's keys — is more than the cheap option: the persisted field names are already consistent across three other write paths and two response models, so changing the API side would be the change that ripples and would require a migration. The worker aligning to `error_message`/`stage` requires no Firestore migration, field rename, or backfill, and no reader changes.

One deliberate behavior change is accepted: unclassified-unknown exceptions currently persist `retryable: true` (silent default) but classify as permanent under `classify_error`; they will now persist `false`. That is the conservatism `classify_error` was written for — it prevents infinite retry loops — and manual reprocess via `POST /process` is unaffected.

## Requirements

1. **Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. Convention: set the tracker immediately before the await.
3. **API-side persistence unchanged.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage.
4. **Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
5. **Contract test.** A contract test must cover the worker failure → rag-api persistence path: exercising the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes), asserting the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and failing if either side's payload keys drift.

**Acceptance criteria (all must be met at verification):**

- A failed job's status message published by the worker contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The processing/summary error subdocument for the failed job carries the same message and stage as the main document.
- The contract test described in requirement 5 exists and passes.

## Boundaries

**Hard constraints:**

- The worker is aligned to rag-api's existing contract (`error_message`/`stage`/`retryable` published); rag-api's reads and persisted schema are not changed.
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

**Preferences (binding direction, not hard gates):**

- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling.
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

**Out of scope (non-goals):**

- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract, and its `retryable=true` stays correct (a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients (verified in the mobile contract test's field sets).
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Widening `classify_error`'s heuristics, even though `retryable=false` for unrecognized-but-actually-transient failures may reduce auto-retry affordances — accepted risk; manual reprocess via `POST /process` remains.

**Known risks (accepted and mitigated as scoped):**

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves (a step added without updating the tracker reports a stale stage) — mitigated by the update-before-await convention and representative-stage test coverage.
- The contract test ossifies the payload — intentional; that is the drift guard doing its job. Adding a key later means touching the test.

## Version bump

None required. Neither `rag-worker-service` nor `rag-api-service` exposes a version manifest in the verified tree (no version files observed in either service directory; the `.python-version` files pin runtime, not service version). The change alters the worker's outbound failure payload and adds a test; it does not change the API's persisted schema, endpoints, or response models. If the release process in force requires a bump anyway, a patch-level bump of `rag-worker-service` is the appropriate choice — flag this as an open item for the implementing step rather than inventing a version here.

## Deferred items

- **Companion D3 issue.** The Objective references a companion D3 issue filed alongside this one; its content is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle.
- **D4 deviation-note reconciliation.** The original analysis lives in `plans/upload-flow.md` as deviation D4, a file not present in the current tree; reconciling this analysis with it is deferred.
- **Dropping the legacy `error` key.** If a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic, removing the duplicate key is trivial cleanup — deferred, deliberately not part of this fix.
- **Widening `classify_error`.** Any expansion of transient/permanent heuristics (e.g., to recover auto-retry for unrecognized transient failures) is out of scope.
- **Structured error codes / failure taxonomy.** Not introduced here; the processing/summary `error.code` stays `"UNKNOWN"` unless a code is actually sent.
- **Stale-lease sweep, ACK/NACK policy, leases, heartbeats, frontend/mobile.** All explicitly out of scope per the Definition's non-goals.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>