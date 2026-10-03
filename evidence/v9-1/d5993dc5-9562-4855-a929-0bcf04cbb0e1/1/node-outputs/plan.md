<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan: Align rag-worker failure payload with rag-api's failed-branch contract

## 1. Scope and authoritative definition

This plan implements WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c…`). The Definition is binding; this plan does not widen or narrow it.

**Problem.** The worker's `process_document` exception handler publishes `{"error": str(e)}` via `_publish_status_update`. rag-api's `run_transactional_update` failed branch reads `details["error_message"]`, `details["stage"]`, and `details["retryable"]`, persisting them as `error`, `error_stage`, `retryable` on the main resource document and `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary subdocument. Because of the key mismatch, every worker-originated failure persists the fallback `"Processing failed"`, `error_stage: None`, and a silently-defaulted `retryable: true`.

**Direction (per Definition constraints).** Fix the worker, not the API. The persisted schema (`error`, `error_stage`, `retryable`) is already consistent across the stale-lease sweep, rag-api's enqueue-failure paths, `ResourceResponse`, and the `Resource` model — changing the API side would ripple; the worker is the only misaligned writer.

## 2. Non-goals (from Definition)

- No change to the stale-lease sweep's direct failure write (already contract-consistent).
- No change to retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals. Only the *reporting* of retryability in the payload changes.
- No frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`).
- No structured error-code taxonomy; the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- No Firestore migration, field rename, or backfill of existing documents.
- Companion D3 issue scope and reconciliation with `plans/upload-flow.md` D4 (file not present in tree) are deferred.

## 3. Changes

### 3.1 Stage tracking in `process_document` (rag-worker-service/main.py)

`process_document` is one large try block; at failure time nothing knows where execution was. Introduce a local stage tracker:

- Add a local variable, e.g. `current_stage: str = "processing"`, initialized before the first pipeline step.
- Immediately **before each awaited pipeline step**, set `current_stage` to the stage name for that step. Stage names must reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` (F9). This keeps a failure stage readable next to the progress timeline clients already see.
- Convention to document in a code comment: **set the tracker immediately before the await**. A future pipeline step added without updating the tracker reports a stale stage; the contract test pins representative stages (early and late failure) to catch the tracker being removed or bypassed without ossifying every step.
- `"processing"` is the safe value when the stage is genuinely unknown (e.g. failure before the first transition) — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.

### 3.2 Failure payload construction in the exception handler (rag-worker-service/main.py)

Replace the one-key payload in `process_document`'s exception handler with a deliberately derived three-key payload:

- `error_message`: `str(e)` — the actual exception message (was previously only under `error`).
- `stage`: the tracker value from §3.1 at failure time.
- `retryable`: derived from `classify_error(e)` (F7/F8):
  - transient-classified errors → `retryable: true`
  - permanent-classified errors, **including unclassified-unknown** (per `classify_error`'s conservative default) → `retryable: false`

  Rationale (F8): this aligns the persisted record with the worker's actual ACK/NACK behavior — a transient error is one Pub/Sub will redeliver; a permanent error was acked and will not come back (manual reprocess via `POST /process` remains). The stale-lease sweep's separate `retryable: true` write stays correct because a dead worker is a transient condition by nature.

  **Deliberate behavior change:** unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent, so they will now persist `false`. This is the conservatism `classify_error` was written for — it prevents infinite retry loops. Manual reprocess is unaffected. Widening `classify_error` is out of scope.

- **Compatibility hedge (F11):** retain the legacy `error` key alongside `error_message` (same string value). Only rag-api's status subscriber was verified as a consumer of these payloads; other services and tooling share the topic. One redundant string per failure message is insurance against an unknown reader. If a later audit confirms the worker is the only publisher and rag-api the only consumer, dropping the duplicate is trivial cleanup (out of scope here).

The payload must never rely on rag-api's fallback defaults for these keys (Definition constraint). The API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

### 3.3 rag-api failed branch (rag-api-service/main.py)

**No code changes required.** The failed branch of `run_transactional_update` already reads `error_message`/`stage`/`retryable` and persists them unchanged (F4):

- main document: `error ← payload error_message`, `error_stage ← payload stage`, `retryable ← payload retryable`
- processing/summary error subdocument: `message` and `stage` carry the same values; `error_code` stays `"UNKNOWN"` (no code is sent — per non-goal, no error taxonomy).

Verification-only work here: the contract test (§4) exercises this branch end-to-end to prove the seam. Any incidental discovery that the branch does not behave as F4 states must be raised as a finding, not silently patched — the Definition pins the API side as the reference contract.

## 4. Contract test (worker failure → rag-api persistence)

A new test in `apps/ai-server/tests/integration/` (house pattern: `tests/integration/test_api_contracts.py` for fixture- and AST-based static contract tests; `tests/integration/test_search_pipeline.py` for the module-mocking + `app_state` injection pattern — both verified in-tree). The test must **import both sides rather than restate the contract in a fixture**:

1. **Worker side:** build the failure payload through the worker's actual code path (the `process_document` exception handler's payload construction), for at least:
   - an early-stage failure (e.g. failure during the first pipeline step → stage `starting` or the tracker's pre-first-step value),
   - a late-stage failure (e.g. failure after `embeddings_complete`-adjacent work),
   - a transient-classified exception (`retryable: true`),
   - a permanent-classified / unclassified-unknown exception (`retryable: false`).
2. **API side:** feed the resulting payload through rag-api's `run_transactional_update` failed branch against the Firestore emulator, or against fakes if the emulator is unavailable in the test environment (both services have `FIRESTORE_EMULATOR_HOST` branches supporting hermetic runs, F10; the search-pipeline test's MagicMock-`app_state` pattern is the fallback shape).
3. **Assertions:**
   - persisted `error` == worker's `error_message` (and **not** the fallback `"Processing failed"`),
   - persisted `error_stage` == worker's `stage` (and **not** `None`),
   - persisted `retryable` == worker's derived value,
   - the processing/summary error subdocument's `message` and `stage` match the main document's values.
4. **Key-set drift guard:** assert the exact set of keys the worker publishes for failures and the exact set of keys rag-api's failed branch reads, so a future edit to either side's keys fails the build instead of silently re-creating this bug. This may be done statically (AST scan of both functions, per the `test_api_contracts.py` house pattern) or dynamically via the payload-construction exercise; either way it must fail on drift.

## 5. Implementation order

1. **Worker stage tracker** (§3.1) — set-before-await convention, comment documenting it.
2. **Worker failure payload** (§3.2) — `error_message`/`stage`/`retryable` + legacy `error` hedge, `retryable` derived from `classify_error(e)`.
3. **Contract test** (§4) — worker payload construction → `run_transactional_update` failed branch → persisted-field assertions + key-set drift guard.
4. **Verification pass** — run the new contract test plus existing integration tests (`test_api_contracts.py`, `test_search_pipeline.py`) to confirm no regression; confirm no API-side code changes were needed (or raise a finding if F4 does not hold exactly).

## 6. Risks and mitigations (from Definition)

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic reading the old key set | Retain legacy `error` key alongside `error_message`; residual risk accepted as low. |
| Stage-tracker drift as the pipeline evolves | Update-before-await convention documented in code; representative-stage contract-test coverage. |
| `retryable=false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures | Accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains. |
| Contract test ossifies the payload | Intentional — that is the drift guard doing its job; adding a key later means touching the test. |

## 7. Acceptance criteria mapping

| Definition acceptance | Covered by |
|---|---|
| Worker failure payload contains `error_message`, `stage`, `retryable` — none relying on API fallbacks | §3.1 + §3.2; asserted by contract test |
| Persisted resource has real `error`, real `error_stage`, worker-derived `retryable` | §3.2 + §3.3; asserted by contract test |
| Processing/summary error subdocument carries same message and stage | §3.3 (already correct); asserted by contract test |
| Contract test exists and passes, failing on either side's key drift | §4 (test + drift guard) |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan: worker→rag-api failure payload contract alignment

## 1. Objective

Prove that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived `retryable` flag — locked in by a contract test on the worker→rag-api failure path (Definition acceptance item 4).

## 2. Test infrastructure and house patterns

- **Location:** `apps/ai-server/tests/integration/` — the existing contract-test home (`test_api_contracts.py` uses fixture- and AST-based static contract tests; verified in-tree).
- **Hermetic execution:** both services support `FIRESTORE_EMULATOR_HOST` branches (F10). Prefer the Firestore emulator for the persistence assertions; fall back to the MagicMock-`app_state` injection pattern from `tests/integration/test_search_pipeline.py` (mock `firebase_admin`/`google.cloud` modules, stub `app_state.db`, override `authenticate_s2s`) if the emulator is unavailable in CI.
- **Import both sides, don't restate the contract:** the test imports the worker's failure-payload construction and rag-api's `run_transactional_update` rather than duplicating key names in a fixture. This is what makes key drift on either side fail the build.

## 3. Test cases

### T1 — Worker failure payload construction (unit-level, worker side)

For each scenario, invoke the worker's failure-payload construction path (the `process_document` exception handler) with a raised exception and assert the published payload:

| Case | Exception | Expected payload |
|---|---|---|
| T1a | Exception raised during the first pipeline step | `error_message` == actual message; `stage` == the early stage name (`starting` or tracker's pre-first-step value); `retryable` per `classify_error`; legacy `error` key present with same string as `error_message` |
| T1b | Exception raised during a late pipeline step (after `embeddings_complete`-adjacent work) | `stage` == the late stage name from the tracker |
| T1c | Exception classified **transient** by `classify_error` (e.g. a type/status-code heuristic match) | `retryable == true` |
| T1d | Exception classified **permanent** by `classify_error` | `retryable == false` |
| T1e | **Unclassified-unknown** exception (no heuristic match — `classify_error`'s conservative default) | `retryable == false` (deliberate behavior change from the old silent `true` default) |
| T1f | Failure before the first tracker transition (genuinely unknown stage) | `stage == "processing"` (never `None`/missing) |

Assertions also cover: payload keys never rely on rag-api's fallback defaults — `error_message`, `stage`, and `retryable` are always present and non-fallback.

### T2 — rag-api failed-branch persistence (contract seam)

Feed T1's payloads through `run_transactional_update`'s failed branch against the emulator (or fake db) and assert on the persisted resource document:

- `error` == worker's `error_message` — and **not** the fallback `"Processing failed"` (F5 regression guard).
- `error_stage` == worker's `stage` — and **not** `None` (F5 regression guard).
- `retryable` == worker's derived value (T1c → `true`; T1d/T1e → `false`).
- The processing/summary error subdocument: `message` == main document `error`; `stage` == main document `error_stage`; `error_code == "UNKNOWN"` (no code sent — non-goal: no error taxonomy).

### T3 — Key-set drift guard (static, per `test_api_contracts.py` house pattern)

AST-scan (or equivalent structural assertion on imported code) both sides and assert exact key sets:

- Worker failure payload publishes exactly: `{error_message, stage, retryable, error}` (the legacy `error` hedge is part of the pinned contract until a later audit removes it).
- rag-api's failed branch reads exactly: `{error_message, stage, retryable}`.
- Any added/removed/renamed key on either side fails this test — the drift guard doing its job (Definition: "Adding a key later means touching the test, which is the point").

### T4 — Regression: existing behavior preserved

- Stale-lease sweep (`_fail_if_still_stale`): unchanged — still writes `error`/`error_stage`/`retryable` directly with `retryable: true` (non-goal to change; assert its write path still exists and uses the established schema, e.g. via the existing static contract tests).
- rag-api enqueue-failure paths (`/process`, `POST /resources`): unchanged — still write the established schema directly.
- ACK/NACK behavior in `run_worker`: unchanged — `classify_error` classification still drives ACK/NACK; only the *reporting* of retryability in the payload changed (non-goal).
- Existing integration suites (`test_api_contracts.py`, `test_search_pipeline.py`) pass unmodified.

## 4. Environment / setup notes

- Set `SHARED_INTERNAL_TOKEN`, `GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, and (for emulator mode) `FIRESTORE_EMULATOR_HOST` as in `test_search_pipeline.py`'s header (verified pattern).
- Mock third-party GCP modules at import time per the house pattern when not using the emulator; when using the emulator, only `FIRESTORE_EMULATOR_HOST` needs pointing at a local emulator instance.
- The worker's `classify_error` heuristics must be exercised through the real function (no stubbing) so T1c–T1e pin the actual derivation.

## 5. Pass criteria

- All T1–T3 cases pass; T4 confirms no regressions in existing suites.
- The contract test fails if either side's payload keys drift (verified by temporarily mutating a key in a local run — optional manual validation, not committed).
- Definition acceptance items 1–4 are each observable in at least one test assertion.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>