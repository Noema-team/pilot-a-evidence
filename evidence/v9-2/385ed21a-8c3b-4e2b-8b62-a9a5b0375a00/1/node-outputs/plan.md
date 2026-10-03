<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan: rag-worker → rag-api failure payload contract alignment

**Run:** 385ed21a-8c3b-4e2b-8b62-a9a5b0375a00 · **Iteration:** 1
**Intent:** rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage
**Authoritative source:** define-work WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c…`)

---

## 1. Problem statement

The rag-worker's failure publisher and rag-api's failure consumer were written against different contracts:

- **Worker** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler): publishes failed status with details `{"error": str(e)}` via `_publish_status_update`.
- **rag-api** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch): reads details keys `error_message`, `stage`, `retryable`; persists `error`, `error_stage`, `retryable` on the main resource document; writes `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary error subdocument.

Consequence (F5): every worker-originated failure persists `error = "Processing failed"` (fallback), `error_stage = None`, and `retryable = True` (silent default). The `processing/summary` error subdocument inherits the same fallbacks with `error_code = "UNKNOWN"`.

The established persisted failure schema is already `error`/`error_stage`/`retryable` across three other write paths (worker stale-lease sweep `_fail_if_still_stale`, rag-api enqueue-failure paths `/process` and `POST /resources`) and both response models (`ResourceResponse`, `Resource` model — retryable defaults True) (F6). The worker's status publisher is the only writer that does not speak this contract.

## 2. Fix direction (binding)

Align the **worker** to rag-api's existing contract — publish `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or the persisted schema. No Firestore migration, field rename, or backfill (constraint: must_not). The persisted fields `error`, `error_stage`, `retryable` keep their names and semantics.

## 3. Work breakdown

### 3.1 Worker: stage tracking in `process_document`

**File:** `apps/ai-server/rag-worker-service/main.py`

`process_document` is one large try block; at failure time nothing knows where execution was. Add a local stage tracker:

1. Introduce a local variable (e.g. `current_stage: str = "processing"`) initialized to the safe value `"processing"` — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.
2. Immediately **before each pipeline step's `await`** (the "set-the-tracker-before-the-await" convention), assign the corresponding stage name. Stage names must reuse the existing progress-update vocabulary (F9):
   - `starting`
   - `text_retrieved`
   - `tagging_complete`
   - `summary_generated`
   - `chunking_complete`
   - `embeddings_complete`
3. The exception handler reads the tracker and includes it in the failure payload as `stage`.

**Convention note (drift risk):** a future pipeline step added without updating the tracker reports a stale stage. The convention is "set the tracker immediately before the await"; the contract test pins the mechanism on representative stages (an early-stage failure and a late-stage failure) — enough to catch the tracker being removed or bypassed without ossifying every step.

**Mapping subtlety:** the progress vocabulary names are *completion* markers (`text_retrieved`, `tagging_complete`, …). When the tracker is set immediately before a step, the value reported at failure is the name of the step about to run / just completed per the existing vocabulary. Choose the value so a failure stage reads naturally next to the progress timeline clients already see; the exact per-step assignment is resolved during implementation against the actual `_publish_status_update` call sites in `process_document` (verified vocabulary per F9; per-step assignment order is an implementation detail to be confirmed against the code).

### 3.2 Worker: derive `retryable` explicitly

**File:** `apps/ai-server/rag-worker-service/main.py`

The worker already classifies every exception via `classify_error()` (F7): `TransientError`/`PermanentError` plus type- and status-code heuristics; unknown exceptions classify conservatively as **permanent**. That classification drives ACK/NACK in `run_worker`.

In the failure handler:

1. Call `retryable = classify_error(e)` — the same call pattern `run_worker` uses.
2. Include `retryable` explicitly in the failure payload. Transient-classified → `true`; permanent-classified (including unclassified-unknown) → `false` (adopted default, F8).

**Rationale (F8):** this aligns the persisted record with the worker's actual ACK/NACK behavior — transient errors are ones Pub/Sub will redeliver (retryable true); permanent errors are acked and will not come back (retryable false; manual reprocess via `POST /process` remains available).

**Deliberate behavior change:** unclassified-unknown exceptions currently persist `retryable: true` (the silent API-side default) but classify as permanent, so they will now persist `false`. This is the conservatism `classify_error` was written for — it prevents infinite retry loops — and the manual reprocess path is unaffected. Accepted tradeoff; widening `classify_error` is out of scope.

**Stale-lease sweep unchanged:** `_fail_if_still_stale`'s direct write of `retryable=true` stays correct — a dead worker is a transient condition by nature. Non-goal; do not touch.

### 3.3 Worker: failure payload construction

**File:** `apps/ai-server/rag-worker-service/main.py` (`process_document` exception handler → `_publish_status_update`)

Replace the one-key payload with:

```python
error_message = str(e)
retryable = classify_error(e)          # deliberately derived, never defaulted
details = {
    "error_message": error_message,   # new contract key (rag-api reads this)
    "error": error_message,           # legacy key retained (compatibility hedge, F11)
    "stage": current_stage,           # stage tracker value; "processing" if unknown
    "retryable": retryable,           # explicit — API fallback must not be operative
}
```

**Compatibility hedge (F11):** only rag-api's status subscriber is a *verified* consumer of these payloads; other services and tooling may share the topic. The worker retains the legacy `error` key alongside `error_message` — one redundant string per failure message as insurance against unknown readers. Dropping the duplicate later is trivial cleanup if an audit confirms worker-is-only-publisher / rag-api-is-only-consumer.

**Constraint:** every worker-originated failure payload must carry `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must never be the operative mechanism for worker failures.

**Prefer-not honored:** no structured error-code taxonomy is introduced; the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent (it is not, in this fix).

### 3.4 rag-api: no reader changes (verification only)

**File:** `apps/ai-server/rag-api-service/main.py` (`run_transactional_update` failed branch)

The failed branch already reads `error_message`, `stage`, `retryable` and persists `error`, `error_stage`, `retryable` on the main document, and writes `message`/`stage` into the processing/summary error subdocument with `error_code` defaulting to `"UNKNOWN"` (F4). **No code changes are planned here.** Implementation must verify (not modify) that:

- main document: `error ← payload error_message`, `error_stage ← payload stage`, `retryable ← payload retryable` — worker-provided values persisted unchanged;
- processing/summary error subdocument: carries the same message and stage.

If verification during implementation reveals the branch deviates from F4's description, stop and re-plan — that would contradict the authoritative definition.

### 3.5 Contract test: worker failure → rag-api persistence path

**File:** `apps/ai-server/tests/integration/test_api_contracts.py` (extend; house pattern exists per F10)

The contract test must **import both sides rather than restate the contract in a fixture**:

1. **Build the failure payload through the worker's code path** — construct a representative failure (e.g. raise a `TransientError` and a `PermanentError`/unknown exception inside the worker's payload-construction logic) and capture the details dict the worker would publish. This may require extracting the payload-construction into a small testable helper in the worker (e.g. `build_failure_payload(error_message, stage, retryable)` or equivalent) so the test exercises real code, not a copied literal. Prefer the minimal extraction that keeps the production handler calling the same helper.
2. **Feed it through rag-api's failed branch** — call `run_transactional_update` (or the minimal seam around it) against the Firestore emulator, using the hermetic `FIRESTORE_EMULATOR_HOST` branches both services already support (F10). If the emulator is unavailable in the test environment, use fakes per the existing fixture- and AST-based patterns in `test_api_contracts.py`.
3. **Assert persistence:** persisted `error` == worker's `error_message`, `error_stage` == worker's `stage`, `retryable` == worker's `retryable`; the processing/summary error subdocument carries the same message and stage.
4. **Key-set drift guard:** assert the exact key sets — the worker payload contains exactly `{error_message, error, stage, retryable}` (or the agreed set), and rag-api's failed branch reads exactly those keys (via AST inspection of the source, matching the existing AST-based contract-test style). A future edit adding/removing keys on either side fails the build.
5. **Representative stage coverage:** one early-stage failure (e.g. failure at/near `starting` or `text_retrieved`) and one late-stage failure (e.g. `embeddings_complete`/`chunking_complete`), asserting the reported stage matches the tracker value at failure time. This pins the tracker mechanism without ossifying every step.
6. **retryable derivation coverage:** a transient-classified exception → payload `retryable: true`; a permanent-classified (and an unclassified-unknown) exception → payload `retryable: false` — asserting the value is deliberately derived, not defaulted.

### 3.6 Regression checks (existing behavior must not break)

- Stale-lease sweep `_fail_if_still_stale` writes unchanged (non-goal).
- rag-api enqueue-failure paths (`/process`, `POST /resources`) unchanged.
- `ResourceResponse` / `Resource` model unchanged (non-goal: frontend/mobile).
- Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals unchanged (non-goal) — only the *reporting* of retryability in the payload changes.
- Worker's existing unit tests (`rag-worker-service/tests/`) and rag-api's tests (`rag-api-service/tests/`) must still pass; both use `pytest.ini` with `asyncio_mode = auto`.

## 4. Acceptance criteria → implementation mapping

| # | Acceptance | Where satisfied |
|---|---|---|
| 1 | Worker's failed status message contains `error_message` (actual exception message), `stage` (failing stage), `retryable` (deliberately derived); none relying on API fallback defaults | §3.3 (payload construction), §3.1 (stage tracker), §3.2 (classify_error derivation) |
| 2 | Persisted resource: `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = worker's derived value | §3.3 + §3.4 (unchanged rag-api failed branch now receives matching keys) |
| 3 | Processing/summary error subdocument carries same message and stage | §3.4 verification + contract test assertion |
| 4 | Contract test covers worker failure → rag-api persistence path, exercising both sides, asserting persisted `error`/`error_stage`/`retryable` equal worker values, failing on key drift | §3.5 |

## 5. Constraints checklist

- [must] Worker aligned to rag-api's contract (`error_message`/`stage`/`retryable`); rag-api reads and persisted schema unchanged. → §3.3, §3.4
- [must_not] No Firestore migration, rename, or backfill; persisted fields keep names/semantics. → §2, §3.4
- [must] `retryable` always sent explicitly by worker; API `details.get("retryable", True)` fallback never operative for worker failures. → §3.2, §3.3
- [prefer] Legacy `error` key retained alongside `error_message`. → §3.3
- [prefer_not] No structured error-code taxonomy. → §3.3, non-goal

## 6. Non-goals (explicit)

- Stale-lease sweep's direct failure write (already consistent).
- Retry/backoff mechanics: ACK/NACK policy, leases, heartbeats.
- Frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`).
- Structured error codes / failure taxonomy.
- Companion D3 issue scope (unavailable in this context; deferred). Reconciling with the original D4 deviation note in `plans/upload-flow.md` (file not present in current tree) — deferred.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic reading the old key set | Retain legacy `error` key (§3.3); residual risk accepted as low |
| Stage-tracker drift as pipeline evolves | Update-before-await convention + representative-stage contract tests (§3.1, §3.5) |
| `retryable=false` for unclassified errors reduces auto-retry affordances | Accepted; widening `classify_error` out of scope; manual reprocess via `POST /process` remains |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key later means touching the test |
| rag-api failed branch deviating from F4's description | §3.4 stop-and-re-plan gate |

## 8. Implementation order

1. §3.1 — stage tracker in `process_document` (worker).
2. §3.2 — `retryable = classify_error(e)` in failure handler (worker).
3. §3.3 — payload construction with `error_message`/`error`/`stage`/`retryable` (worker); extract testable helper if needed for §3.5.
4. §3.4 — verify rag-api failed branch matches F4 (read-only; stop-and-re-plan on deviation).
5. §3.5 — contract test in `tests/integration/test_api_contracts.py` (payload construction through persistence + drift guard + stage/retryable coverage).
6. §3.6 — run worker and rag-api test suites; confirm no regressions.

## 9. Verification notes / unknowns

- Verified in this session: directory layout of `apps/ai-server` (both service trees, `tests/integration/test_api_contracts.py` present, `tests/fixtures/api-contracts/` fixtures present), both services' `pytest.ini` (`testpaths = tests`, `asyncio_mode = auto`), and the top of `rag-worker-service/main.py` (exception classes, `classify_error` with conservative permanent default for unknown exceptions, `ProcessingStatus` enum, config model).
- The per-step assignment order of the stage tracker (which exact stage name precedes which await) is an implementation detail to be confirmed against the actual `_publish_status_update` call sites in `process_document`; the vocabulary itself is authoritative per F9.
- The exact shape of rag-api's `run_transactional_update` failed branch is taken from the authoritative definition (F4) and must be verified read-only during implementation (§3.4 gate).
- Whether the contract test uses the Firestore emulator or fakes depends on what the existing `test_api_contracts.py` fixture patterns support at implementation time (F10 says both are viable).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan: rag-worker → rag-api failure payload contract alignment

**Run:** 385ed21a-8c3b-4e2b-8b62-a9a5b0375a00 · **Iteration:** 1
**Scope:** worker failure payload construction → rag-api failed-branch persistence, plus regression safety for the untouched paths.

---

## 1. Test strategy overview

The centerpiece is a **contract test on the worker→rag-api failure path** that imports both sides rather than restating the contract in a fixture. It exercises the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes), and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values — failing if either side's payload keys drift.

House pattern: `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests). Both services support a hermetic Firestore-emulator mode (`FIRESTORE_EMULATOR_HOST` branches), so a hermetic run is implementable with existing patterns.

Test runners: both services use `pytest.ini` with `testpaths = tests` and `asyncio_mode = auto`; the integration suite lives under `apps/ai-server/tests/integration/`.

## 2. Contract test: worker failure → rag-api persistence

**File:** `apps/ai-server/tests/integration/test_api_contracts.py` (extend)

### 2.1 Worker-side payload construction (through real code)

- **TC-C1: Payload built through the worker's code path.** Construct a representative failure and capture the details dict the worker would publish. If the payload construction is not directly invocable, extract a minimal testable helper in the worker (e.g. `build_failure_payload(...)`) that the production exception handler also calls — the test must exercise real code, not a copied literal.
- **TC-C2: Required keys present.** The failure payload contains `error_message` (the actual exception message string), `stage`, and `retryable`. None of these may be absent — their absence is what causes rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) to become operative.
- **TC-C3: Legacy `error` key retained.** The payload also contains the legacy `error` key with the same value as `error_message` (compatibility hedge, F11).
- **TC-C4: Stage values use the existing progress vocabulary.** Reported stages are drawn from `{starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete}` with `"processing"` as the safe unknown value.

### 2.2 rag-api-side persistence (through the failed branch)

- **TC-C5: Persisted main document matches worker values.** Feed the worker-built payload through rag-api's `run_transactional_update` failed branch (Firestore emulator or fake). Assert persisted `error == payload["error_message"]`, `error_stage == payload["stage"]`, `retryable == payload["retryable"]` — worker-provided values persisted unchanged.
- **TC-C6: Processing/summary error subdocument consistency.** The processing/summary error subdocument carries the same message and stage as the main document; `error_code` remains `"UNKNOWN"` (no code is sent in this fix).
- **TC-C7: Fallback defaults are never operative.** Construct a payload where the worker's actual values differ from rag-api's fallbacks (e.g. message ≠ `"Processing failed"`, stage ≠ `None`, retryable ≠ `True` for a permanent-classified error) and assert the persisted values are the worker's, proving the fallbacks are not silently filling in.

### 2.3 Drift guards

- **TC-C8: Worker payload key-set drift guard.** Assert the worker's failure payload key set exactly (or at minimum contains, per the agreed contract — resolved at implementation) `{error_message, error, stage, retryable}`. A future edit removing a required key fails the build.
- **TC-C9: rag-api reader key drift guard (AST-based).** Using the existing AST-based contract-test style, assert rag-api's failed branch reads `error_message`, `stage`, and `retryable` from the details payload. A future rename on the API side fails the build.
- **TC-C10: Persisted schema drift guard.** Assert rag-api persists to `error`, `error_stage`, `retryable` (the established schema shared with the stale-lease sweep, enqueue-failure paths, `ResourceResponse`, and the `Resource` model). A rename of the persisted fields fails the build — protecting the no-migration constraint.

### 2.4 Stage-tracker coverage (representative, not exhaustive)

- **TC-C11: Early-stage failure reports the right stage.** Force a failure at/near the beginning of `process_document` (e.g. at/near `starting` or `text_retrieved`); assert the payload's `stage` equals the tracker value for that point in the pipeline.
- **TC-C12: Late-stage failure reports the right stage.** Force a failure at/near the end (e.g. `chunking_complete` or `embeddings_complete`); assert the payload's `stage` matches.
- **TC-C13: Unknown-stage safe value.** A failure occurring before the first tracker assignment (if reachable) reports `stage == "processing"` — never `None`/missing.
- Rationale: two representative stages pin the tracker mechanism (set-before-await) without ossifying every pipeline step; TC-C13 pins the safe fallback.

### 2.5 retryable derivation coverage

- **TC-C14: Transient-classified error → retryable true.** Raise an exception that `classify_error` classifies transient (e.g. `TransientError`, or an `httpx.ConnectError`/timeout type per the worker's heuristics); assert payload `retryable is True`.
- **TC-C15: Permanent-classified error → retryable false.** Raise a `PermanentError` (or a 4xx `httpx.HTTPStatusError`); assert payload `retryable is False`.
- **TC-C16: Unclassified-unknown error → retryable false (deliberate behavior change).** Raise an unrecognized exception type; `classify_error`'s conservative default classifies it permanent → assert payload `retryable is False`. This pins the deliberate change away from the old silent `True` default.
- **TC-C17: Derivation is the same function used for ACK/NACK.** Assert (by import/AST) that the failure handler derives retryable via `classify_error` — the same function `run_worker` uses for ACK/NACK decisions — so the persisted record cannot drift from actual retry behavior.

## 3. Regression tests (existing behavior must not break)

- **TC-R1: Stale-lease sweep unchanged.** Existing tests (or a targeted check) confirm `_fail_if_still_stale` still writes `error`/`error_stage`/`retryable` directly with `retryable=true` — non-goal, untouched.
- **TC-R2: rag-api enqueue-failure paths unchanged.** `/process` and `POST /resources` failure writes still persist `error`/`error_stage`/`retryable` as before.
- **TC-R3: Worker happy path unchanged.** The worker's progress status updates (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`) are unaffected by the stage tracker; existing worker tests pass.
- **TC-R4: ACK/NACK mechanics unchanged.** `run_worker`'s use of `classify_error` for ACK/NACK is untouched; only the *reporting* of retryability in the payload changes.
- **TC-R5: Service test suites green.** `rag-worker-service/tests/` and `rag-api-service/tests/` pass under each service's `pytest.ini` (`asyncio_mode = auto`).
- **TC-R6: Response models unchanged.** `ResourceResponse` and the `Resource` model (`apps/ai-server/rag-api-service/models/resource.py`) still expose `error`/`error_stage`/`retryable` (retryable default True) — covered by existing fixture-based response contract tests (`tests/fixtures/api-contracts/resource_response.json` et al.) where applicable.

## 4. Test environment / hermeticity

- **Emulator mode:** both services support `FIRESTORE_EMULATOR_HOST` branches; the contract test prefers the emulator for a true end-to-end persistence assertion, falling back to fakes per the existing `test_api_contracts.py` patterns if the emulator is unavailable in CI.
- **No external services:** the contract test must not require Pub/Sub, OpenRouter, Weaviate, or Langfuse — the worker-side payload construction and rag-api-side failed-branch persistence are exercised in isolation (unit-seam style within the integration suite).
- **Determinism:** failure scenarios are constructed by raising known exception types; no timing-dependent assertions.

## 5. Acceptance criteria → test mapping

| Acceptance criterion | Tests |
|---|---|
| Worker's failed status message contains `error_message`, `stage`, `retryable`; none relying on API fallbacks | TC-C1, TC-C2, TC-C7 |
| Persisted `error` = actual message, `error_stage` = failing stage, `retryable` = worker's derived value | TC-C5, TC-C7, TC-C14–TC-C16 |
| Processing/summary error subdocument carries same message and stage | TC-C6 |
| Contract test exercises both sides, asserts persisted equality, fails on key drift | TC-C1–TC-C10 |

## 6. Coverage gaps / notes

- **Per-step stage assignment:** TC-C11/TC-C12 cover representative early/late stages only; intermediate stages (`tagging_complete`, `summary_generated`) are covered implicitly by the tracker mechanism but not individually pinned — intentional, to avoid ossifying every step.
- **Unknown topic consumers:** no test can verify unknown consumers of the status topic; the legacy `error` key retention (TC-C3) is the hedge, verified only as "key present in payload."
- **rag-api failed-branch shape:** the exact code shape of `run_transactional_update`'s failed branch is taken from the authoritative definition (F4); TC-C5/TC-C9 assert behavior and reader keys, which will surface any deviation from F4 when the tests run.
- **Emulator vs fakes:** which mechanism the final contract test uses depends on what the existing fixture patterns support at implementation time; both are pre-approved by the definition (F10).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>