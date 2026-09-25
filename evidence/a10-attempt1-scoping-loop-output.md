I've verified the authoritative definition against the current tree. Both sides of the seam confirm the definition's claims:

- **Worker** (`apps/ai-server/rag-worker-service/main.py`): `process_document`'s exception handler publishes `"failed"` with details `{"error": str(e)}`; no stage tracking exists; `classify_error()` and `run_worker`'s ACK/NACK logic are as described; the stale-lease sweep writes `error`/`error_stage`/`retryable` directly with `retryable: True`.
- **API** (`apps/ai-server/rag-api-service/main.py`): `run_transactional_update`'s failed branch reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`, and writes the summary error subdocument with `code` defaulting `"UNKNOWN"`.
- **Test infrastructure** (`apps/ai-server/tests/integration/test_api_contracts.py` + `conftest.py`): fixture- and AST-based static contract tests exist, with mock-based hermetic imports of rag-api.

The scope is implementable exactly as bounded. Producing the cycle charter now.

<<<SLE-OUTPUT>>>
### docs/cycle-charter.md
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

- **Run:** 927af8d5-33d8-4528-aff5-53d222a2d90b
- **Step:** scoping.produce
- **Authoritative source:** define-work WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This charter restates that Definition's bounded scope; it does not widen, narrow, or reinterpret it.

## Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## Problem (verified in tree)

- **Worker** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler): publishes `"failed"` status with a one-key payload, `{"error": str(e)}`, via `_publish_status_update`. There is no stage tracking, so the failing stage cannot be reported.
- **API** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch): reads `details["error_message"]`, `details["stage"]`, `details["retryable"]`; persists `error`, `error_stage`, `retryable` on the main resource document; writes `message`/`stage` (with `error_code` defaulting `"UNKNOWN"`) into the `processing/summary` error subdocument.
- **Consequence:** every worker-originated failure persists the fallback string `"Processing failed"`, `error_stage = None`, and a silently defaulted `retryable = True`. The summary subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.
- **Established schema:** `error`/`error_stage`/`retryable` are already written directly by the worker's stale-lease sweep (`_fail_if_still_stale`, with `error_stage: "processing"`, `retryable: True`) and by rag-api's enqueue-failure paths (`/process`, `POST /resources`), and are exposed by `ResourceResponse` and the `Resource` model (`retryable` defaults `True`). The worker's status publisher is the only failure writer that doesn't speak this schema.

## Direction

The worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable` keys in the payload) — not the reverse. The persisted field names are consistent across three other write paths and two API response models; changing the API side would be the change that ripples. No migration, no backfill, no reader changes.

## In scope

1. **Worker failure payload** (`rag-worker-service/main.py`, `process_document` exception handler):
   - Failed status details must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
   - Retain the legacy `error` key alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic and existing log tooling (per constraint "prefer").
2. **Worker stage tracking** (`process_document`):
   - A stage tracker (local state set immediately before each pipeline step) so the failure handler reports the true failing stage.
   - Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
   - Safe value `"processing"` when the stage is genuinely unknown (same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null).
   - Convention: set the tracker immediately before the `await` of each pipeline step.
3. **retryable derivation** (worker):
   - `retryable` is set from `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors (including unclassified-unknown, per `classify_error`'s conservative default) → `false`.
   - Rationale: aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker` (transient = Pub/Sub redelivers; permanent = acked, manual reprocess via `POST /process` remains available).
   - Accepted behavior change: unclassified-unknown exceptions move from the silent default `retryable: true` to `retryable: false`. This is the conservatism `classify_error` was written for; manual reprocess is unaffected.
4. **rag-api side — verify only, no changes**: the failed branch must persist worker-provided values unchanged (main doc `error` ← `error_message`, `error_stage` ← `stage`, `retryable` ← `retryable`; summary error subdocument carries the same message and stage). This already holds once the keys match; no reader or schema edits are in scope.
5. **Contract test** (`apps/ai-server/tests/integration/`, following the house pattern in `test_api_contracts.py`):
   - Import both sides rather than restate the contract in a fixture: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes, and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
   - Assert the processing/summary error subdocument carries the same message and stage.
   - Include a key-set drift guard on both sides' payload keys so a future edit to either side fails the build instead of silently re-creating the bug.
   - Cover representative stages: an early-stage failure and a late-stage failure — enough to catch the stage tracker being removed or bypassed without ossifying every step.

## Out of scope (non-goals)

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (its separate `retryable: true` stays correct: a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree; the reference comes from the Objective text).
- Widening `classify_error`'s heuristics.

## Constraints

| Type | Constraint |
|---|---|
| must | Worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema. |
| must_not | No Firestore migration, field rename, or backfill of existing documents; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. |
| must | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling. |
| prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## Requirements (implementation contract)

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — never relying on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

## Acceptance criteria

| # | Criterion | Met |
|---|---|---|
| A1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | false |
| A2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | false |
| A3 | The processing/summary error subdocument for the failed job carries the same message and stage as the main document. | false |
| A4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | false |

## Test strategy

- Contract test imports both services rather than restating the contract in a fixture (worker payload construction → `run_transactional_update` → persisted assertions), per the existing pattern in `apps/ai-server/tests/integration/test_api_contracts.py`.
- Both services support hermetic Firestore-emulator branches (`FIRESTORE_EMULATOR_HOST`); the integration `conftest.py` already mocks cloud dependencies for direct rag-api imports, so fakes or the emulator are both viable.
- Drift guard: assert the exact key sets of the worker's failure payload and rag-api's failed-branch reads, so key changes on either side fail the build.
- Representative-stage coverage: one early-stage failure (e.g. during text retrieval) and one late-stage failure (e.g. during embedding/storage) to pin the stage-tracker mechanism.

## Risks and accepted tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error` alongside `error_message`; residual risk accepted as low. Dropping the duplicate later is trivial cleanup if an audit confirms worker→rag-api is the only path.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the "set the tracker immediately before the await" convention and representative-stage test coverage.
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope, and manual reprocess via `POST /process` remains.
- **The contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Facts register (from the authoritative Definition)

| ID | Status | Summary |
|---|---|---|
| F1 | KNOWN (human, product-intent) | Failed jobs must persist actual error message and failing stage; retryable must be sent or deliberately derived, never silently defaulted. |
| F2 | KNOWN (human, product-intent) | Preferred fix direction: worker payload keys → `error_message`/`stage`, avoiding a schema migration. |
| F3 | KNOWN (repository) | Worker publishes failed status with `{"error": str(e)}` from `process_document`'s exception handler. |
| F4 | KNOWN (repository) | rag-api's failed branch reads `error_message`/`stage`/`retryable`; persists `error`/`error_stage`/`retryable`; writes summary error with `error_code` default `"UNKNOWN"`. |
| F5 | KNOWN (repository) | Key mismatch ⇒ every worker failure persists fallback `"Processing failed"`, `error_stage=None`, silent `retryable=True`. |
| F6 | KNOWN (repository) | `error`/`error_stage`/`retryable` are the established persisted schema (sweep, enqueue-failure paths, `ResourceResponse`, `Resource` model). |
| F7 | KNOWN (repository) | Worker classifies exceptions via `classify_error()` and uses it for ACK/NACK in `run_worker`; unknown exceptions classify as permanent. |
| F8 | ASSUMED (investigation) | Adopted default: worker sets `retryable` from `classify_error(e)` (transient → true, permanent/unknown → false); sweep's `retryable=true` stays correct. |
| F9 | KNOWN (repository) | Worker publishes named progress stages but has no failure-stage tracking today. |
| F10 | KNOWN (repository) | Contract-test infrastructure and hermetic emulator modes exist; the test is implementable with existing patterns. |
| F11 | ASSUMED (investigation) | No other consumer of the failure payload keys is known; worker retains legacy `error` key as a hedge. |
| F12 | DEFERRED (human) | Companion D3 issue's scope is unavailable here; anything beyond this payload alignment is out of this Definition's bounded scope. |
<<<END-SLE-OUTPUT>>>