Charter produced from the authoritative definition (`wi-define-108-a8`) plus repository evidence verified during investigation (rag-api's `run_transactional_update` failed branch and emulator branch, the contract-test infrastructure in `apps/ai-server/tests/integration/`, and the absence of `plans/upload-flow.md`).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
Cycle charter for run f33835d5-f24d-4368-bab4-3155bf6a1fab, iteration 1, step scoping.produce.
Intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage".
Authoritative source: WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). Scope below is bound to that definition — not widened, narrowed, or reinterpreted.

## Scope

Align the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

In scope:

1. **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`). The `process_document` exception handler's failed-status publication (today `details = {"error": str(e)}` via `_publish_status_update`) is rebuilt to emit:
   - `error_message` — the actual exception message, never a fallback string;
   - `stage` — the pipeline stage executing at failure time;
   - `retryable` — deliberately derived, never omitted;
   - the legacy `error` key retained alongside `error_message`, as a compatibility hedge for any unknown consumer of the status topic.

2. **Stage tracking in `process_document`.** A stage-tracker local set immediately before each pipeline step (convention: "set the tracker immediately before the await"). Stage names reuse the existing progress-update vocabulary — `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` — with `"processing"` as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null).

3. **retryable derivation.** The worker sets `retryable` from `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (classify_error's conservative default), → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker` (transient = Pub/Sub will redeliver; permanent = acked, manual reprocess via `POST /process` remains).

4. **rag-api read side: no functional change.** `run_transactional_update`'s failed branch in `apps/ai-server/rag-api-service/main.py` already reads `error_message`/`stage`/`retryable` (fallbacks `"Processing failed"` / `None` / `True` — verified this session) and persists `error`/`error_stage`/`retryable` on the main document plus message/stage (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument. The worker aligns to this contract; rag-api's reads and persisted schema are pinned by the contract test, not modified.

5. **Contract test** (`apps/ai-server/tests/integration/`, following the existing `test_api_contracts.py` fixture- and AST-based house pattern). The test imports both sides rather than restating the contract in a fixture: it builds the failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` against the Firestore emulator or fakes (both services have `FIRESTORE_EMULATOR_HOST` hermetic branches — the rag-api branch verified this session), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and includes a key-set drift guard so a future key edit on either side fails the build. Coverage pins the stage-tracking mechanism on representative stages: an early-stage failure and a late-stage failure.

Expected change surface: `apps/ai-server/rag-worker-service/main.py` and the contract test file(s) under `apps/ai-server/tests/integration/`. `apps/ai-server/rag-api-service/main.py` and `apps/ai-server/rag-api-service/models/resource.py` are expected unchanged (test-pinned only).

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true` — and the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures, and the persisted retryability is a silent default rather than a derived decision.

The worker's status publisher is the only failure writer that does not speak the established `error`/`error_stage`/`retryable` schema: the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths (`/process`, `POST /resources`), and the `Resource` model / `ResourceResponse` (retryable defaults `True`) all already use it. Aligning the worker — the odd one out — is the fix that ripples least: no migration, no backfill, no reader changes. The cycle closes by locking the seam with a contract test so this mismatch class cannot silently recur.

## Requirements

Binding requirements from the definition:

1. **Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **rag-api persistence fidelity.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. **Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per classify_error's conservative default) → `retryable` false.
5. **Contract test.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Acceptance criteria (all must be met to close the cycle):

- A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
- A contract test covering the worker failure → rag-api persistence path exists and passes, asserting the persisted `error`, `error_stage`, and `retryable` equal the worker's values and failing if either side's payload keys drift.

## Boundaries

Constraints:

- **MUST** — the worker is aligned to rag-api's existing contract (publishing `error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed.
- **MUST NOT** — the fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **MUST** — every worker-originated failure payload carries `retryable` explicitly (deliberately derived); rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **PREFER** — retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **PREFER NOT** — do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract, and its separate `retryable: true` write stays correct (a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred).

Accepted behavior change: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent under `classify_error`; after this cycle they persist `retryable: false`. This is the conservatism `classify_error` was written for — it prevents infinite retry loops — and the manual reprocess path via `POST /process` is unaffected. Widening `classify_error` is out of scope.

Known risks (accepted, with mitigation):

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the update-before-await convention and representative-stage (early + late failure) test coverage.
- The contract test ossifies the payload — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Version bump

None required. This is an internal behavior fix on the worker→rag-api status seam plus a test: no persisted-schema change (Firestore documents keep `schema_version: 2` as written by `run_transactional_update` — verified), no client-facing API shape change (`ResourceResponse`/`Resource` untouched), no new endpoints, no new runtime dependencies. If the affected services carry version strings that are bumped per release in the normal PR flow, a patch-level bump is the ceiling; no minor or major bump is warranted by this change.

## Deferred items

- **Companion D3 issue** referenced by the Objective — its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle.
- **Reconciliation with deviation D4 in `plans/upload-flow.md`** — that file is not present in the current tree (verified: `plans/` contains no `upload-flow.md`); the reference exists only in the Objective text. Nothing to reconcile until the file or the issue content is supplied.
- **Dropping the legacy `error` key** from the worker's failure payload — pending an audit confirming the worker is the only publisher and rag-api's status subscriber the only consumer of the status topic; trivial cleanup afterwards if confirmed.
- **Widening `classify_error` heuristics** (recognizing more genuinely-transient failure patterns) — out of scope; unclassified-unknown stays conservatively permanent → `retryable: false`.
- **Structured error-code taxonomy** for the `processing/summary` `error.code` field (beyond the existing `"UNKNOWN"` default).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>