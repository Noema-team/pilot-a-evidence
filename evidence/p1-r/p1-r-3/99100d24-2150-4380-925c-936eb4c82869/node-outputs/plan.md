 <<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — Worker→rag-api Failure Payload Alignment

Step: SLE implementation step for the bounded Definition "worker→rag-api failure payload alignment".
Authorized outputs for this step: `docs/plan.md` and `docs/test-plan.md` (this document and its companion test plan).

## 1. Problem (verified)

The worker's failure publisher and rag-api's failure consumer speak different contracts, and no test covers the seam.

Verified from `apps/ai-server/rag-api-service/main.py` (`run_transactional_update`, failed branch):

```python
if new_status == "failed":
    main_update["error"] = details.get("error_message", "Processing failed")
    main_update["error_stage"] = details.get("stage")
    main_update["retryable"] = details.get("retryable", True)
...
if new_status == "failed":
    summary_update["error"] = {
        "code": details.get("error_code", "UNKNOWN"),
        "message": details.get("error_message", "Processing failed"),
        "stage": details.get("stage"),
    }
```

The worker's exception handler in `process_document` publishes a one-key failure payload (`{"error": str(e)}`) inside the standard status envelope. Verified envelope keys consumed by rag-api's `_process_status_message`: `user_id`, `course_id`, `resource_id`, `status`, `details`.

Consequence (per the Definition): every worker failure persists as `error = "Processing failed"`, `error_stage = None`, `retryable = true` (fabricated by the API-side fallback), and the `processing/summary` error subdocument inherits the same fallbacks with `error_code = "UNKNOWN"`.

The `error`/`error_stage`/`retryable` persisted schema is already consistent across three other write paths (worker stale-lease sweep, rag-api enqueue-failure paths) and both response models (`Resource` dataclass in `apps/ai-server/rag-api-service/models/resource.py` exposes `error`, `error_stage`, `retryable: bool = True`). The worker's status publisher is the only writer that doesn't speak it.

## 2. Direction (from the Definition)

Align the worker to rag-api's existing contract — publish `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or the persisted schema. No Firestore migration, field rename, or backfill.

Key design decisions carried from the Definition:

1. **Stage tracking**: a local stage tracker in `process_document`, set immediately before each pipeline await; the failure handler reports the tracker value. Stage names reuse the existing progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`); `"processing"` is the safe value when the stage is genuinely unknown (same value the stale-lease sweep uses for `error_stage`).
2. **retryable derived, not defaulted**: reuse `classify_error()` — the same function that drives ACK/NACK in `run_worker`. Transient → `retryable: true`; permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`. Deliberate behavior change: unclassified-unknown failures flip from the silent default `true` to `false`; accepted per the Definition.
3. **Compatibility hedge**: retain the legacy `error` key alongside `error_message` in the failure payload, for continuity with any unverified consumers of the status topic and log tooling.
4. **rag-api: zero code changes.** Once the worker sends the three keys, the verified failed branch already persists them unchanged (`error ← error_message`, `error_stage ← stage`, `retryable ← retryable`; summary `error.message`/`error.stage` carry the same values; `error_code` stays `"UNKNOWN"` unless a code is sent). The `details.get(...)` fallbacks remain in place for non-worker publishers but are no longer the operative mechanism for worker failures.

## 3. Changes

### 3.1 Worker: stage tracking (`apps/ai-server/rag-worker-service/main.py`)

- Introduce a local stage tracker in `process_document` (exact insertion points per the existing pipeline awaits; the worker's `main.py` internals were inspected earlier in this step but exact line numbers are not restated here — locate the awaits during implementation).
- Convention: **set the tracker immediately before each pipeline await**, to the progress-vocabulary name associated with that step per the existing `_publish_status_update` emission points (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`).
- Initialize the tracker to `"processing"` so a failure before the first transition reports the safe value, never null.
- The exception handler reads the tracker at failure time and includes it in the payload.
- Drift risk (known): a future pipeline step added without updating the tracker reports a stale stage. Mitigated by the update-before-await convention and representative-stage contract-test coverage (early-stage and late-stage failure scenarios); the test intentionally does not ossify every step.

### 3.2 Worker: failure payload construction (`apps/ai-server/rag-worker-service/main.py`)

Change the exception handler's failure `details` from `{"error": str(e)}` to:

```python
details = {
    "error_message": str(e),          # actual exception message
    "stage": current_stage,           # tracker value; "processing" if unknown
    "retryable": derive_retryable(e), # classify_error-derived, explicit
    "error": str(e),                  # legacy key retained (hedge)
}
```

- `derive_retryable(e)` wraps `classify_error(e)`: transient → `True`, permanent/unclassified → `False`. Implement as a small named helper (or inline the classification) so the contract test can exercise the exact derivation through the worker's code path. The exact exception classes `classify_error` treats as transient are per the existing implementation in the worker's `main.py`/`exceptions.py` — do not widen them in this fix.
- `retryable` must always be present in worker-originated failure payloads — the API-side `details.get("retryable", True)` fallback must never be the operative mechanism for worker failures.
- Do not introduce structured error codes (`error_code` stays absent → summary `error.code` remains `"UNKNOWN"`).
- The payload stays inside the verified envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`); only the failure `details` keys change.
- The stale-lease sweep's direct failure write is untouched (non-goal).

### 3.3 rag-api: no code changes

Verified: `run_transactional_update`'s failed branch already persists worker-provided values unchanged once the keys are present. `models/resource.py` already carries the fields. `ResourceResponse` already exposes `error`/`error_stage` (per the Definition and the mobile contract fixture in `apps/ai-server/tests/integration/test_api_contracts.py`). Nothing to change; the contract test pins this side so future drift fails the build.

### 3.4 Contract test + drift guard (`apps/ai-server/tests/integration/`)

New test module (proposed: `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py`), following the house patterns in `apps/ai-server/tests/integration/test_api_contracts.py` (direct imports of `rag_api_main`, AST subprocess shape extraction, fixture-based assertions) and the stub conventions of `apps/ai-server/rag-worker-service/tests/conftest.py`.

Full design in `docs/test-plan.md`. Summary:

- **Import both sides, don't restate the contract in a fixture**: build the failure payload through the worker's code path (preferred: in-process import of the worker's failure-payload construction after applying the worker-conftest stub set; fallback: subprocess bootstrap using the same stubs, matching the `_get_agent_graph_shapes` subprocess pattern). Feed the payload through rag-api's `run_transactional_update` against the Firestore emulator (both services have `FIRESTORE_EMULATOR_HOST` branches — verified in rag-api's `AppState.startup`) or a minimal in-memory fake implementing the surface `run_transactional_update` uses (`db.transaction()`, `@firestore.transactional`, `doc_ref.get(transaction=)`, `transaction.update`, `doc_ref.collection("processing").document("summary")`, `transaction.set(merge=True)`, `firestore.SERVER_TIMESTAMP`).
- **Assertions**: persisted main-doc `error == worker error_message` (not `"Processing failed"`), `error_stage == worker stage`, `retryable == worker retryable`; summary `error.message` and `error.stage` equal the same values; `error.code == "UNKNOWN"`.
- **Key-set drift guard**: AST-parse the worker's failure-payload construction and rag-api's failed-branch `details.get(...)` key names (house AST subprocess pattern); assert the worker publishes ⊇ `{error_message, stage, retryable}` (with `error` as a known-extra legacy key) and rag-api's failed branch reads exactly `{error_message, stage, retryable}` (plus optional `error_code`). A future edit to either side's keys fails the build.
- **Representative stage coverage**: an early-stage failure scenario and a late-stage failure scenario, asserting the tracker-reported stage lands in `error_stage` — enough to catch the tracker being removed or bypassed without pinning every step.

### 3.5 Worker unit tests (`apps/ai-server/rag-worker-service/tests/unit/`)

New unit test module (proposed: `test_failure_payload.py`) covering payload construction and the stage tracker in isolation. Full design in `docs/test-plan.md`.

## 4. Files touched

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Stage tracker in `process_document`; failure payload gains `error_message`/`stage`/`retryable` (legacy `error` retained); `retryable` derived via `classify_error` |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | New — payload construction, stage tracker, retryable derivation |
| `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py` | New — worker failure → rag-api persistence contract test + key-set drift guard |
| `apps/ai-server/tests/integration/conftest.py` | Possibly extended — only if the contract test needs the worker on `sys.path` with stubs scoped to the new module; prefer keeping setup self-contained in the test module to avoid perturbing existing tests that rely on the current conftest (verified: it inserts only the rag-api path and mocks rag-api's cloud deps) |
| `apps/ai-server/rag-api-service/main.py` | **No change** |
| `apps/ai-server/rag-api-service/models/resource.py` | **No change** |

## 5. Acceptance criteria mapping

| Definition acceptance | How met |
|---|---|
| Worker failure payload contains `error_message`, `stage`, `retryable` — none relying on rag-api's fallback defaults | §3.2; pinned by worker unit tests and contract-test payload assertions |
| Persisted doc: `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = worker-derived value | §3.1 + §3.2; rag-api's verified failed branch persists them unchanged; asserted by contract test |
| `processing/summary` error subdocument carries same message and stage | Verified failed-branch behavior; asserted by contract test |
| Contract test covering worker failure → rag-api persistence exists and passes, failing on either side's key drift | §3.4; drift guard via AST key-set assertions |

## 6. Risks and tradeoffs (carried from the Definition)

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error`; residual risk accepted as low. Only rag-api's status subscriber was verified as a consumer.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- **`retryable: false` for unclassified-unknown failures** (behavior change from the silent default) — accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` unaffected.
- **Contract test ossifies the payload** — intentional; that is the drift guard. Adding a key later means touching the test.
- **Import viability of the worker's `main.py` in the shared integration-test environment** — the worker's own conftest applies a large stub set (verified: langchain, openai, langfuse, firebase_admin, google.cloud, spacy, tiktoken, tenacity, google.cloud.firestore, etc.) that the shared `apps/ai-server/tests/integration/conftest.py` does not. Preferred mitigation: replicate the minimal required stubs inside the new contract test module (or reuse the worker conftest's stub logic) before importing the worker; fallback: subprocess bootstrap. Exact viability is an implementation-time unknown — the test plan covers both paths.

## 7. Out of scope (non-goals, from the Definition)

- Changing the stale-lease sweep's direct failure write.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy — summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Anything the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context; deferred), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (that file is not present in the current tree — the reference comes from the Objective text).

## 8. Unknowns to resolve at implementation time

- Exact line numbers and the full current failure-payload key set in the worker's `main.py` (the file was inspected earlier in this step; exact contents are not restated here — re-locate the exception handler's `_publish_status_update` call and the pipeline awaits before editing).
- The exact exception classes `classify_error` treats as transient (per the existing worker implementation; do not widen).
- Whether the shared integration conftest needs a worker `sys.path` entry, or the new contract test is fully self-contained (decide per §6 last bullet).
- Whether a Firestore emulator is available in the hermetic test run, or the in-memory fake path is used (both are supported per the Definition; the fake must implement only the verified `run_transactional_update` surface listed in §3.4).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — Worker→rag-api Failure Payload Alignment

Companion to `docs/plan.md`. Covers the test strategy for the bounded Definition "worker→rag-api failure payload alignment".

## 1. Scope

What is tested:

- The worker's failure-payload construction: `error_message` (actual exception message), `stage` (tracker-reported failing stage, `"processing"` when genuinely unknown), `retryable` (deliberately derived via `classify_error`), legacy `error` key retained.
- The worker's stage tracker: representative early-stage and late-stage failure scenarios report the true failing stage.
- The seam: worker failure payload → rag-api's `run_transactional_update` failed branch → persisted `error`/`error_stage`/`retryable` on the main document and `processing/summary` error subdocument.
- Key-set drift on both sides of the seam.

What is deliberately not tested (non-goals): stale-lease sweep behavior, ACK/NACK/lease/heartbeat mechanics, frontend exposure of `error`/`error_stage` (already pinned by the existing mobile contract fixtures in `test_api_contracts.py`), structured error codes, the companion D3 issue.

## 2. Test levels and locations

### 2.1 Worker unit tests — `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` (new)

Run under the worker's own pytest config (`apps/ai-server/rag-worker-service/pytest.ini`, verified: `testpaths = tests`, `asyncio_mode = auto`) with the existing `tests/conftest.py` stub set (verified: stubs langchain, openai, langfuse, firebase_admin, google.cloud.*, spacy, tiktoken, tenacity, google.cloud.firestore, etc.).

Cases:

1. **Payload construction (failure-relevant keys)**: given an exception with a known message and a tracker stage, the failure `details` contain:
   - `error_message` == the exception message,
   - `stage` == the tracker value,
   - `retryable` present and boolean (deliberately derived — never absent),
   - legacy `error` == the exception message (hedge per the Definition).
2. **Retryable derivation — transient**: an exception of a class `classify_error` treats as transient (exact classes per the existing worker implementation — do not widen) → `retryable is True`.
3. **Retryable derivation — permanent**: an exception `classify_error` treats as permanent → `retryable is False`.
4. **Retryable derivation — unclassified-unknown**: an exception `classify_error` does not recognize → `retryable is False` (conservative default; pins the deliberate behavior change from the silent `True`).
5. **Stage tracker — early-stage failure**: drive `process_document` with a mocked pipeline that raises at the first representative step (e.g., text extraction) → failure payload `stage` equals the progress-vocabulary name associated with that step per the existing emission points (exact name matched 1:1 to the existing `_publish_status_update` vocabulary during implementation).
6. **Stage tracker — late-stage failure**: same, raising at a late representative step (e.g., vector storage / embeddings) → `stage` equals that step's name.
7. **Stage tracker — genuinely unknown**: a failure before the first tracker transition → `stage == "processing"` (never null; same value the stale-lease sweep uses for `error_stage`).
8. **Envelope intact**: the published message still carries `user_id`, `course_id`, `resource_id`, `status` (verified envelope keys consumed by rag-api's `_process_status_message`); only the failure `details` keys changed.

Note: the worker's `main.py` internals (exact function boundaries, the full current failure-payload key set) were inspected earlier in this step but are not restated here — re-locate the exception handler and pipeline awaits before writing these tests, and match the mocked-pipeline seam to the actual structure of `process_document`.

### 2.2 Contract test — `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py` (new)

Location rationale: the house cross-service contract tests live in `apps/ai-server/tests/integration/` (`test_api_contracts.py`, verified: direct import of `rag_api_main`, AST subprocess shape extraction via `_get_agent_graph_shapes`, fixture-based assertions under `tests/fixtures/api-contracts/`). The shared `conftest.py` (verified) sets `GCP_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS` env defaults, mocks rag-api's cloud dependencies (`firebase_admin`, `google.cloud.*`, `structlog`, ...), and inserts `rag-api-service` on `sys.path` — so `run_transactional_update` is importable as in `test_api_contracts.py`.

**Import both sides, don't restate the contract in a fixture.**

Worker side (failure-payload construction through the worker's code path):

- Preferred: in-process import of the worker's failure-payload construction (the helper/inline derivation built in plan §3.2, or `process_document` driven with a mocked pipeline that raises) after applying the minimal stub set the worker's import requires — replicate the relevant stubs from `apps/ai-server/rag-worker-service/tests/conftest.py` inside the new test module, scoped so they don't perturb existing tests relying on the current shared conftest. If the shared conftest must change (worker `sys.path` entry), keep the addition additive and verify the existing integration tests still pass.
- Fallback: subprocess bootstrap — a small script that applies the worker-conftest stubs, imports the worker, builds the failure payload for a representative stage, and prints it as JSON; the test asserts on the printed payload. This matches the verified `_get_agent_graph_shapes` subprocess pattern and sidesteps stub conflicts entirely.

rag-api side (persistence through the real failed branch):

- Call `run_transactional_update(db, doc_ref, "failed", details, logger, user_id)` — the verified signature — with the worker-built `details`.
- Firestore backend, two supported modes (both services have `FIRESTORE_EMULATOR_HOST` branches per the Definition; verified in rag-api's `AppState.startup`):
  - **Emulator mode** (preferred when available): create the resource document, run the update, read back the main doc and `processing/summary`.
  - **In-memory fake mode** (hermetic default): a minimal fake implementing exactly the surface `run_transactional_update` uses (verified): `db.transaction()` returning a callable-compatible object, the `@firestore.transactional` decorator (invoke the wrapped function with the transaction), `doc_ref.get(transaction=...)` returning a snapshot with `exists`/`to_dict()`, `transaction.update(doc_ref, main_update)`, `doc_ref.collection("processing").document("summary")`, `transaction.set(summary_ref, summary_update, merge=True)`, and `firestore.SERVER_TIMESTAMP`. The fake records all writes for assertion. Seed the doc with `status: "processing"` so the `processing → failed` transition is allowed by the verified `ALLOWED_TRANSITIONS`.

Cases:

1. **Persistence — happy contract path**: worker-built failure details (representative message, early stage, `retryable` from a transient-classified exception) fed through `run_transactional_update` →
   - main doc `error` == worker `error_message` (and != `"Processing failed"`),
   - main doc `error_stage` == worker `stage` (and != None),
   - main doc `retryable` == worker `retryable` (and is the worker's value, not the API-side fallback),
   - summary `error.message` == same message, summary `error.stage` == same stage,
   - summary `error.code` == `"UNKNOWN"` (no code sent),
   - main doc `status` == `"failed"`.
2. **Persistence — late-stage failure**: same assertions with a late representative stage.
3. **Persistence — retryable false path**: worker-built details from a permanent/unclassified exception → main doc `retryable` is `False` (proves the API branch does not override with its `True` fallback when the key is present).
4. **Persistence — genuinely unknown stage**: worker-built details with `stage == "processing"` → `error_stage == "processing"`.
5. **Fallback regression (documents the boundary)**: details *without* the new keys (legacy one-key payload `{"error": str(e)}`) still produce the verified fallback behavior (`"Processing failed"`, `None`, `True`) — this pins that the fix works by the worker publishing keys, not by changing rag-api, and that non-worker publishers are unaffected.

**Key-set drift guards** (AST-based, house `_get_agent_graph_shapes` subprocess pattern):

6. **Worker publishes the contract keys**: AST-parse `apps/ai-server/rag-worker-service/main.py`; locate the failure-payload `details` dict construction; assert its key set ⊇ `{error_message, stage, retryable}` and includes `error` (known-extra legacy key, explicitly allowed). Fails if the worker's failure keys are renamed or dropped.
7. **rag-api reads exactly the contract keys**: AST-parse `apps/ai-server/rag-api-service/main.py`; in the `new_status == "failed"` branches of `run_transactional_update`, assert the `details.get(...)` key names are exactly `{error_message, stage, retryable}` plus optional `error_code` (with their verified fallback defaults). Fails if rag-api's failed-branch reads drift.
8. **Cross-side key match**: the worker's published failure key set (case 6) and rag-api's failed-branch read key set (case 7) intersect on exactly `{error_message, stage, retryable}` — the seam is pinned from both directions.

### 2.3 Regression suites

Run all three, in this order:

1. `apps/ai-server/rag-worker-service` pytest (unit + existing tests; the stage-tracker and payload changes touch `process_document`, so existing worker tests must stay green).
2. `apps/ai-server/rag-api-service` pytest (no API code changes expected — suite must pass unchanged; guards against accidental edits).
3. `apps/ai-server/tests/integration` pytest (existing contract tests + the new contract test; the shared conftest may have been additively extended — existing tests must stay green).

Optional hermetic end-to-end verification (when the emulator stack is available): run the worker and rag-api against the Firestore emulator with `FIRESTORE_EMULATOR_HOST` set, force a processing failure, and inspect the persisted document — manual confirmation of acceptance criteria 2 and 3 outside the fake.

## 3. Environment and fixtures

- Worker unit tests: worker's own conftest stub set (verified) — no new fixtures needed beyond a mocked-pipeline seam for `process_document` and controlled exception classes for `classify_error` cases.
- Contract test: shared integration conftest for rag-api imports (verified); worker-side stubs replicated in-module or via subprocess bootstrap (decide per plan §6/§8); in-memory Firestore fake as the hermetic default, emulator when available.
- No new fixture files under `tests/fixtures/api-contracts/` — the Definition's test strategy says import both sides rather than restate the contract in a fixture; the drift guards use AST extraction, matching the existing house pattern.

## 4. Acceptance mapping

| Definition acceptance | Covered by |
|---|---|
| Worker failure payload contains `error_message`, `stage`, `retryable`, none relying on API fallbacks | §2.1 cases 1–4, 8; §2.2 case 1 (fallback regression case 5 pins the boundary) |
| Persisted `error`/`error_stage`/`retryable` equal worker values | §2.2 cases 1–4 |
| Summary error subdocument carries same message and stage | §2.2 cases 1–2 |
| Contract test exists and passes; fails on either side's key drift | §2.2 cases 1–8 (drift guards 6–8) |

## 5. Deliberate coverage tradeoffs

- **Representative stages, not every step**: the stage tracker is pinned on an early-stage and a late-stage failure (per the Definition) — enough to catch the tracker being removed or bypassed without ossifying every pipeline step. A future step added without updating the tracker is a known residual risk (plan §6), mitigated by the update-before-await convention.
- **The drift guard intentionally ossifies the payload**: adding a key later means touching the test — that is the guard doing its job (per the Definition).
- **`classify_error` transient classes are not re-enumerated in tests**: unit tests use the existing classes as-is; widening them is out of scope, and the tests must not encode a taxonomy the fix doesn't introduce.
- **Unverified consumers of the status topic are not audited**: the legacy `error` key retention is pinned by §2.1 case 1 and §2.2 case 6; behavior for hypothetical other consumers is out of scope.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>