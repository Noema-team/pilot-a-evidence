<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Plan: Align rag-worker failure payload with rag-api's failed-branch contract

- **WorkItem:** wi-define-108-a8 (authoritative Definition artifact `definition:obj-108`, sha256 `71f1c39c…`)
- **Objective:** rag-worker → rag-api failure payload contract mismatch — failures persist without message or stage
- **Status:** Plan complete — implementation not started
- **Branch model:** feature work per `AGENTS.md`; suggested feature slug `fix/worker-failure-payload-contract` (small-change eligible: no schema change, no migration, touches rag-worker + its tests and shared integration tests only — if review prefers the feature path, phases below map 1:1 to phase branches)

---

## 1. Problem (verified)

The worker's `process_document` exception handler publishes a failed status whose details contain only `{"error": str(e)}`. rag-api's `run_transactional_update` failed branch reads three different keys and persists with fallbacks:

| rag-api reads (verified in `rag-api-service/main.py`) | Worker sends today | Persisted result today |
|---|---|---|
| `details.get("error_message", "Processing failed")` → `error` | `error` (ignored) | `"Processing failed"` |
| `details.get("stage")` → `error_stage` | — | `None` |
| `details.get("retryable", True)` → `retryable` | — | `True` (silent default) |

The `processing/summary` error subdocument inherits the same fallbacks: `{"code": "UNKNOWN", "message": "Processing failed", "stage": None}`, and `summary.stage` falls back to `"unknown"`.

The persisted schema (`error`, `error_stage`, `retryable`) is already written correctly by three other paths — the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure path in `POST /process` (writes `error_stage: "enqueue"` directly), and the `Resource` model (`models/resource.py`: `error`, `error_stage`, `retryable: bool = True`). The worker's status publisher is the only writer that doesn't speak the contract.

## 2. Verified evidence base

Confirmed by direct repository reads during investigation:

- **rag-api `run_transactional_update`** (module-level, `rag-api-service/main.py`): signature `(db, doc_ref, new_status, details, logger, user_id)`; `ALLOWED_TRANSITIONS` allows `processing → failed`; failed branch writes `error`/`error_stage`/`retryable` on the main doc and `{"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}` into `processing/summary`; summary also gets `stage = details.get("stage", "unknown")` and `progress = details.get("progress", 0)`.
- **rag-api `_process_status_message`**: parses envelope keys `user_id`, `course_id`, `resource_id`, `status`, `details`; resolves canonical `users/{uid}/resources/{rid}` vs legacy course path; runs the transactional update via `asyncio.to_thread`; acks/nacks.
- **rag-api `POST /process`**: enqueue-failure path writes `status: "failed"`, `error`, `error_stage: "enqueue"` directly (bypasses the transactional update) — untouched by this plan.
- **`models/resource.py`**: `Resource` dataclass persists `error`, `error_stage`, `retryable` (default `True`). `ResourceResponse` (in `main.py`) exposes `error` and `error_stage` to clients (no `retryable` field — surfacing it is out of scope).
- **Worker `classify_error(e) -> bool`** (`rag-worker-service/main.py`): `TransientError` → True; `PermanentError` → False; known transient types (httpx connect/timeout errors, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`) → True; HTTP-status heuristics for transient status codes; unclassified exceptions fall through to permanent (conservative default). This classification drives ACK/NACK in `run_worker`.
- **Worker emulator branch**: `_init_services` supports `FIRESTORE_EMULATOR_HOST` (mirrors rag-api's branch).
- **Worker test fakes** (`rag-worker-service/tests/unit/test_processing_lease.py`): `FakeTx`/`FakeSnap`/`FakeRef`/`FakeCollection`/`FakeDb` + `_tx_identity` stand-in for `firestore.transactional` + `monkeypatch.setattr(main.firestore, "SERVER_TIMESTAMP", "TS", raising=False)`. The sweep test already asserts `retryable is True` on the stale-lease write — this must stay green (sweep is a non-goal).
- **Shared integration conftest** (`apps/ai-server/tests/integration/conftest.py`): env defaults (`GCP_PROJECT=test-project`, fake creds, `SHARED_INTERNAL_TOKEN`), `MagicMock` stubs for `firebase_admin`, `google.cloud.*`, `structlog`, and `sys.path` insert for `rag-api-service` only (not the worker).
- **Worker test conftest** (`rag-worker-service/tests/conftest.py`): minimal stubs for `openai`, `langfuse`, `firebase_admin`, `google.cloud.*`, `spacy`, `tiktoken`, `tenacity`, `langchain` — i.e., worker `main.py` imports all of these at module level; a test importing worker `main.py` outside the worker tree needs an equivalent stub set.
- **pytest configs**: both services use `pytest.ini` with `asyncio_mode = auto`; `apps/ai-server/tests/` has no local pytest.ini (async plugin mode there is unverified — see §10).

Pinned by the authoritative Definition (binding, not re-derived): the failure handler's current payload shape (F3), the progress-stage vocabulary (F9), the `retryable` derivation decision (F8), the legacy-`error` hedge (F11), and the contract-test infrastructure characterization of `test_api_contracts.py` as fixture- and AST-based (F10).

## 3. Design

### 3.1 Worker failure payload (the fix)

In `process_document`'s exception handler, replace the one-key payload with:

```python
{
    "error_message": str(e),          # actual exception message
    "stage": <current pipeline stage>,  # from the stage tracker (§3.2)
    "retryable": classify_error(e),   # deliberately derived (§3.3)
    "error": str(e),                  # legacy key retained (compat hedge, F11)
}
```

- `error_message` / `stage` / `retryable` are the contract keys rag-api already reads. None of them may be absent — rag-api's `.get()` fallbacks must never be the operative mechanism for worker failures (constraint 3).
- `error` is retained deliberately for unknown consumers of the status topic and log tooling (constraint: prefer). rag-api ignores it; it costs one redundant string per failure.
- No `error_code` is sent — the summary subdocument's `code` stays `"UNKNOWN"` via rag-api's existing default (constraint: prefer not to introduce a taxonomy).

### 3.2 Stage tracking

`process_document` is one large try block; today nothing knows where it failed. Add a stage tracker:

- A local variable (e.g. `current_stage`), initialized to a sentinel (`None`) **before** the try block so the handler can always see it.
- **Convention: set the tracker immediately before each awaited pipeline step**, using the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. A failure during a step reports the name of the step that was executing.
- Steps after the last vocabulary name (e.g. vector storage / post-processing persistence) retain the last assigned value — no new names invented in this fix.
- **Unknown fallback:** if the failure occurs before the first assignment, the handler resolves the stage to `"processing"` — the same value the stale-lease sweep uses for `error_stage` (per the Definition), so `error_stage` never regresses to `None`.
- Drift risk is managed by convention ("set before the await") plus representative-stage test coverage (§ test-plan), not by ossifying every step.

### 3.3 `retryable` derivation

`retryable = classify_error(e)` — the same classification that already drives ACK/NACK:

- Transient-classified → `retryable: true` (Pub/Sub will redeliver; the record tells the truth).
- Permanent-classified, **including unclassified-unknown** (classify_error's conservative default) → `retryable: false` (acked, no auto-redelivery; manual reprocess via `POST /process` remains).

**Deliberate behavior change:** unclassified-unknown exceptions currently persist `retryable: true` (silent default) and will now persist `false`. Accepted per the Definition (F8): this matches the worker's actual retry behavior and prevents infinite-retry affordances for unrecognized failures.

**Explicitly unchanged:** the stale-lease sweep keeps its direct `retryable: true` write (a dead worker is a transient condition); ACK/NACK policy, leases, heartbeats, and backoff are untouched — only the *reporting* of retryability changes.

### 3.4 Testability extraction (behavior-preserving refactor)

The payload construction currently lives inline in the exception handler. Extract it into a small module-level pure helper in the worker (illustrative name: `_build_failure_payload(e: Exception, stage: Optional[str]) -> dict`):

- Returns exactly the §3.1 key set; resolves `None`/sentinel stage to `"processing"`.
- The exception handler calls the helper and passes the result as the `details` argument to `_publish_status_update` (exact `_publish_status_update` call shape to be confirmed against `main.py` at implementation — see §10).
- No behavior change; this exists so the contract test can exercise the worker's real construction code path instead of restating the contract in a fixture.

### 3.5 rag-api side: no production change

rag-api's failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` unchanged. The constraint "align the worker to rag-api, never the reverse" means **zero production-code changes in `rag-api-service`**. The API side is pinned by the new contract test only.

## 4. Phases

### Phase 01 — Worker failure payload + stage tracking — `NOT STARTED`

**Branch:** `phase/worker-failure-payload-contract/01-worker-payload` (or single small-change PR if the small-change path is chosen).

**Files:**
- `apps/ai-server/rag-worker-service/main.py` — stage tracker in `process_document`; `_build_failure_payload` helper; handler rewiring.
- `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` — new.

**Tasks:**
1. Read the current `process_document` exception handler and `_publish_status_update` call sites; confirm the payload flow described in §2/§3 before editing.
2. Add the stage tracker per §3.2 (init before try; assign before each awaited step using the six vocabulary names).
3. Add `_build_failure_payload` per §3.4; rewire the handler to use it.
4. Add worker unit tests (see test-plan §3.1): key set, value mapping, retryable derivation for transient/permanent/unclassified, legacy `error` key, stage fallback to `"processing"`.
5. Run worker suite; confirm `test_processing_lease.py` still passes (sweep untouched).

**Exit criteria:** every worker-originated failure publishes `error_message`/`stage`/`retryable` (+ legacy `error`); stage reflects the executing step or `"processing"`; worker unit tests green.

### Phase 02 — Cross-service contract test + drift guards — `NOT STARTED`

**Branch:** `phase/worker-failure-payload-contract/02-contract-test`.

**Files:**
- `apps/ai-server/tests/integration/test_worker_failure_contract.py` — new (self-contained stubbing at module top; see test-plan §2.3 for why not the shared conftest).
- `apps/ai-server/rag-worker-service/tests/integration/test_failure_stages.py` — new (worker-tree integration test driving `process_document`; the worker's own conftest already provides all stubs, and `tests/integration/` already exists with `__init__.py`).
- No changes to `apps/ai-server/tests/integration/conftest.py` (blast-radius avoidance; revisit only if §10 items force it).

**Tasks:**
1. Build the seam test: worker `_build_failure_payload` (real `classify_error`) → rag-api `run_transactional_update` against fake-db fakes (house pattern from `test_processing_lease.py`: `FakeTx`/`FakeSnap`/`FakeRef`/`FakeCollection`/`FakeDb`, `_tx_identity` for `firestore.transactional`, patched `SERVER_TIMESTAMP`); seed the doc with `status: "processing"` so the transition is valid.
2. Assert persisted main-doc `error == str(exception)`, `error_stage == stage`, `retryable == derived value` (and explicitly `!= "Processing failed"` / `!= None` guards); assert summary subdoc `error.message`/`error.stage` match, `error.code == "UNKNOWN"`, `summary.stage == stage`.
3. Add the process_document stage-tracker test (early-stage failure → `text_retrieved`; late-stage failure → `embeddings_complete`; pre-assignment failure → `processing`), capturing the payload via a monkeypatched `_publish_status_update`, and asserting the **published** payload's key set (handler-path drift guard).
4. Add the rag-api-side AST drift guard: parse `rag-api-service/main.py`, walk `run_transactional_update`, collect `details.get(...)` key literals in the failed-branch writes, assert they are exactly `{error_message, stage, retryable, error_code}` (following the AST-based approach the existing `test_api_contracts.py` uses — its concrete helpers were not retained in this context; implement standalone rather than assuming reuse).
5. Run the full `apps/ai-server/tests/integration` directory — existing tests must stay green.

**Exit criteria:** contract test passes end-to-end; a forced key drift on either side fails the build (verified once manually by temporarily renaming a key during development, then reverting).

## 5. Acceptance criteria mapping (from the Definition)

| # | Acceptance | Met by |
|---|---|---|
| 1 | Worker failure payload carries `error_message`/`stage`/`retryable`, none relying on rag-api fallbacks | Phase 01 implementation + unit tests + handler-path key-set guard (Phase 02, task 3) |
| 2 | Persisted `error` = actual message (not `"Processing failed"`), `error_stage` = failing stage (not None), `retryable` = derived | Phase 02 seam test assertions |
| 3 | `processing/summary` error subdocument carries same message and stage | Phase 02 seam test (summary assertions) |
| 4 | Contract test covering worker failure → rag-api persistence exists and passes; fails on key drift on either side | Phase 02 (tasks 1–4) |

## 6. Constraint compliance

- **Must (align worker, not rag-api):** §3.1/§3.5 — rag-api production code untouched.
- **Must-not (no migration/rename/backfill):** persisted field names `error`/`error_stage`/`retryable` unchanged; only payload keys on the wire change.
- **Must (explicit retryable):** §3.3 — `details.get("retryable", True)` fallback is never operative for worker failures.
- **Prefer (retain legacy `error`):** §3.1.
- **Prefer-not (no error-code taxonomy):** no `error_code` sent; summary `code` stays `"UNKNOWN"`.

## 7. Non-goals (from the Definition — do not implement)

- Stale-lease sweep changes (its direct write already conforms; existing test must stay green).
- Retry/backoff mechanics: ACK/NACK policy, leases, heartbeat intervals.
- Frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`).
- Structured error codes / failure taxonomy.
- Anything the companion D3 issue covers beyond this payload alignment (content unavailable here — deferred); reconciling with the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## 8. Risks & mitigations

- **Unknown consumers of the status topic** reading the old key set → mitigated by retaining `error`; residual risk accepted as low (per Definition F11).
- **Stage-tracker drift** as the pipeline evolves → mitigated by the set-before-await convention + representative early/late-stage tests.
- **`retryable: false` for unclassified-unknown errors** reduces auto-retry affordances → accepted; widening `classify_error` is out of scope; manual reprocess unaffected.
- **Contract test ossifies the payload** → intentional; that is the drift guard. Adding a key later means touching the test deliberately.
- **Cross-service import weight in the shared integration dir** (worker `main.py` needs stubs the shared conftest doesn't provide) → mitigated by module-local stubbing in the new test file (stub-if-missing semantics, matching both existing conftests) and by not touching the shared conftest. If import-time failures appear, fall back to hosting the both-sides test under `rag-worker-service/tests/integration/` with a local conftest addition for the rag-api import (decision point flagged in §10).
- **Async test mode in `apps/ai-server/tests/`** (no local pytest.ini; mode unverified) → write async-driving tests as sync tests using `asyncio.run(...)` to avoid plugin-mode assumptions.

## 9. Validation

- `pytest apps/ai-server/rag-worker-service/tests` (worker unit + integration; `asyncio_mode=auto` applies)
- `pytest apps/ai-server/rag-api-service/tests` (must remain green — no production change)
- `pytest apps/ai-server/tests/integration` (new contract tests + existing suite)
- `./dev/run ai-server` as the final gate (requires Docker Compose per `AGENTS.md`)

## 10. Verify at implementation (known unknowns — do not guess)

1. Exact body of `process_document`'s exception handler and the exact `_publish_status_update` signature/call shape (Definition F3 pins the behavior; the code must be read before editing).
2. Exact callable names of the pipeline step collaborators inside `process_document` (text extraction, tagging, summary, chunking, embeddings) needed for monkeypatching in the stage-tracker test.
3. Whether worker `main.py` imports anything at module level that neither conftest stubs (e.g. lazy vs. top-level imports of PDF-extraction libraries) — run the import in the test env early in Phase 02.
4. Whether `pytest-asyncio` is active for `apps/ai-server/tests/` and in which mode — resolved by the `asyncio.run` sync-test approach regardless.
5. Exact patterns/helpers inside `tests/integration/test_api_contracts.py` (existence and AST/fixture characterization pinned by Definition F10; specifics not retained) — implement the new AST guard standalone.
6. Whether `./dev/run ai-server` picks up `apps/ai-server/tests/integration` automatically (it runs the suite containing `test_api_contracts.py` today; confirm the new file is collected).

## 11. Plan deviations

None at planning time. Per `AGENTS.md`, any material deviation discovered during implementation stops the phase and is recorded here for human review.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan: worker→rag-api failure payload contract

Companion to `docs/plan.md`. Covers the contract test required by the Definition's requirement 5 / acceptance criterion 4, plus the worker-side unit coverage that makes the seam test meaningful.

## 1. Strategy

1. **Import both sides; never restate the contract in a fixture.** The payload is built by the worker's real code path (`_build_failure_payload`, called by the real exception handler) and persisted by rag-api's real `run_transactional_update`. The test asserts equality across the seam, so either side drifting fails the build.
2. **Fakes over the Firestore emulator.** rag-api's `run_transactional_update(db, doc_ref, new_status, details, logger, user_id)` takes the db as a parameter and is already exercised against fakes elsewhere; the house fake pattern exists and is hermetic (no Docker, no emulator lifecycle). The Definition permits "the Firestore emulator or fakes" — fakes are primary. An emulator-based variant is optional and not required for acceptance.
3. **Drift guards on both sides.** Worker side: behavioral key-set assertions on the helper output and on the payload the real handler publishes. rag-api side: an AST scan pinning the `details.get(...)` key literals in the failed branch.
4. **Existing tests stay green.** `test_processing_lease.py` already asserts the sweep writes `retryable is True` — the sweep is a non-goal and its test is the regression canary.

## 2. Test environments & fakes

### 2.1 Worker tree (`rag-worker-service/tests/…`)
- `tests/conftest.py` already stubs everything worker `main.py` imports at module level (`openai`, `langfuse`, `firebase_admin`, `google.cloud.*`, `spacy`, `tiktoken`, `tenacity`, `langchain`) and sets env defaults. New tests under `tests/unit/` and `tests/integration/` inherit it automatically.
- `pytest.ini` sets `asyncio_mode = auto` — async test functions work directly in this tree.
- Reuse the fake family proven in `tests/unit/test_processing_lease.py`: `FakeTx` (records writes, `get()` returns current doc state), `FakeSnap`, `FakeRef` (with `collection()`/`document()`), `FakeCollection`, `FakeDb`; `_tx_identity` monkeypatched over `firestore.transactional`; `SERVER_TIMESTAMP` monkeypatched to a sentinel. For the new tests these fakes are re-declared locally in the new test module (copy, don't refactor the existing file — avoids touching a regression test for an unrelated bug).

### 2.2 rag-api tree (`rag-api-service/tests/…`)
- No new tests required here (rag-api production code is unchanged). Existing suites must pass unchanged.

### 2.3 Shared integration tree (`apps/ai-server/tests/integration/…`)
- The directory conftest mocks `firebase_admin`, `google.cloud.*`, `structlog` and puts **only** `rag-api-service` on `sys.path`. It does **not** stub the worker's heavier imports (`openai`, `langchain`, `langfuse`, `spacy`, `tiktoken`, `tenacity`).
- Decision: **do not modify the shared conftest** (it would change stubbing for six existing test modules). Instead, the new test file performs module-local setup *before* importing worker `main.py`: append the worker service dir to `sys.path` and install stub-if-missing entries for the worker-only modules, mirroring the worker conftest's stub set. The parent conftest's `MagicMock` stubs for `firebase_admin`/`google.cloud`/`structlog` run first and are compatible (stub-if-missing semantics in both conftests mean no double-stubbing conflicts).
- No local `pytest.ini` exists in this tree and the async plugin mode is unverified → any async driving is done from **sync tests via `asyncio.run(...)`**.
- Fallback (pre-approved decision point): if worker `main.py` proves unimportable here for reasons the stub set can't fix, relocate the both-sides test under `rag-worker-service/tests/integration/` with a local conftest addition that stubs rag-api's import surface instead. Record the switch as a plan deviation note, not a silent change.

## 3. Test inventory

### 3.1 `rag-worker-service/tests/unit/test_failure_payload.py` (Phase 01)

Pure tests of `_build_failure_payload(e, stage)` — no mocks beyond `monkeypatch` of `firestore` sentinels if the helper touches them (it should not).

| Case | Assertion |
|---|---|
| Key set | `set(payload) == {"error_message", "stage", "retryable", "error"}` — exact; extra/missing keys fail |
| Message fidelity | `payload["error_message"] == str(e)` and `payload["error"] == str(e)` (legacy hedge carries the same string) |
| Transient → retryable true | `TransientError("x")` → `retryable is True`; also spot-check a known transient type (e.g. `httpx.ConnectError`) → True |
| Permanent → retryable false | `PermanentError("x")` → `retryable is False` |
| Unclassified-unknown → retryable false | plain `ValueError("boom")` / generic `Exception` → `retryable is False` (conservative default; this pins the deliberate behavior change) |
| Stage passthrough | a concrete stage string is returned unchanged; the helper never invents a stage |
| Unknown-stage fallback | `None` (sentinel) → `"processing"` |

### 3.2 `rag-worker-service/tests/integration/test_failure_stages.py` (Phase 02)

Drives the real `process_document` with pipeline collaborators monkeypatched to raise, capturing the payload via a monkeypatched `_publish_status_update` (records `(status, details)` calls). The exact collaborator callables to patch are identified by reading `main.py` at implementation time (plan §10.2); the *mechanism* below is the contract.

| Case | Setup | Assertion |
|---|---|---|
| Early-stage failure | force the text-extraction step to raise `ValueError("extract exploded")` | captured failed-status details: `stage == "text_retrieved"`, `error_message == "extract exploded"`, `error == "extract exploded"`, `retryable is False`; key set exact |
| Late-stage failure | let early steps succeed (stubbed), force the embeddings step to raise `TransientError("embed timeout")` | `stage == "embeddings_complete"`, `retryable is True` |
| Pre-assignment failure | raise before the first tracker assignment (e.g. patch the earliest collaborator / entry path) | `stage == "processing"` (never `None`) |
| Handler uses the helper | any of the above | captured payload equals `_build_failure_payload(raised_exception, expected_stage)` — proves the handler routes through the extracted code path (no parallel inline construction) |
| Transient/permanent agreement | same runs | `payload["retryable"] == classify_error(raised_exception)` — payload and ACK/NACK classification can never disagree |

Representative stages only (early + late), per the Definition — the test pins the tracker mechanism, not every step.

### 3.3 `apps/ai-server/tests/integration/test_worker_failure_contract.py` (Phase 02) — the seam

Module-local stubbing per §2.3, then:

**Fixture:** fake-db family (§2.1 pattern); `monkeypatch` rag-api `main.firestore.transactional → _tx_identity` and `SERVER_TIMESTAMP → "TS"`; seed the document with `status: "processing"` (so `processing → failed` is an allowed transition), a filename, and `user_id`.

**Core test — end-to-end persistence equality:**
1. `payload = worker_main._build_failure_payload(exc, stage)` with a real exception (e.g. `ValueError("OCR returned garbage")`, stage `"chunking_complete"`).
2. `api_main.run_transactional_update(db, ref, "failed", payload, logger, user_id)` (logger may be a stub).
3. Assert on the recorded main-doc update:
   - `error == "OCR returned garbage"` (and a guard assertion `error != "Processing failed"`)
   - `error_stage == "chunking_complete"` (and `!= None`)
   - `retryable is False` (matches the worker's derivation for that exception class; run a second case with a `TransientError` asserting `retryable is True`)
   - `status == "failed"`
4. Assert on the recorded `processing/summary` write:
   - `error.message == payload["error_message"]`, `error.stage == payload["stage"]` (same as main doc)
   - `error.code == "UNKNOWN"` (no `error_code` sent — taxonomy stays out)
   - `stage == payload["stage"]` (not the `"unknown"` fallback)

**Drift guards:**

| Guard | Mechanism | Fails when |
|---|---|---|
| Worker payload keys (helper) | `set(payload) == {"error_message", "stage", "retryable", "error"}` | a key is added/renamed/removed in the helper |
| Worker payload keys (handler path) | key-set assertion on the payload captured from the real `process_document` failure (§3.2) | the handler stops routing through the helper or constructs divergent keys inline |
| rag-api failed-branch reads | AST walk of `rag-api-service/main.py` → `run_transactional_update`; collect string literals passed to `details.get(...)` within the failed-branch code (main-doc failed writes + summary failed-error block); assert exactly `{"error_message", "stage", "retryable", "error_code"}` | rag-api reads a renamed key, drops a read, or adds a new details key silently |
| Behavioral backstop | the equality assertions in the core test | rag-api stops reading a key the worker sends (persisted value falls back → equality fails) |

The AST guard is implemented standalone in this file (the concrete helpers inside the existing `test_api_contracts.py` were not retained in this context; only its fixture-/AST-based character is pinned by the Definition). If `run_transactional_update` is refactored so the AST walk can't find the failed branch, the guard fails loudly — that is desired; update the guard deliberately in the same change.

### 3.4 Regression watchlist (must remain green, no edits)

- `rag-worker-service/tests/unit/test_processing_lease.py` — sweep still writes `retryable is True`, `status == "failed"`; claim/sweep race behavior unchanged.
- `rag-api-service/tests/integration/test_endpoints.py`, `test_timeline_endpoints.py` — no production change; untouched.
- `apps/ai-server/tests/integration/*` — the new module-local stubbing must not leak (stub-if-missing only; verify by running the whole directory).

## 4. Acceptance coverage matrix

| Acceptance criterion (Definition) | Covered by |
|---|---|
| AC1: payload carries error_message/stage/retryable, no fallback reliance | §3.1 key-set + value cases; §3.2 handler-path capture |
| AC2: persisted error/error_stage/retryable equal worker values | §3.3 core test equality + not-fallback guards |
| AC3: summary subdocument carries same message/stage | §3.3 summary assertions |
| AC4: contract test exists, passes, fails on either-side key drift | §3.3 (whole file) + §3.2 handler-path guard |

## 5. How to run

```bash
pytest apps/ai-server/rag-worker-service/tests          # §3.1, §3.2
pytest apps/ai-server/rag-api-service/tests             # regression only
pytest apps/ai-server/tests/integration                 # §3.3 + existing suite
./dev/run ai-server                                     # final gate (Docker Compose required)
```

## 6. Explicitly not tested (out of scope, per the Definition)

- Stale-lease sweep behavior (already covered by `test_processing_lease.py`; unchanged).
- ACK/NACK policy, leases, heartbeats, backoff — only the payload's `retryable` reporting changes.
- Real Pub/Sub transport, real Firestore, the emulator stack — fakes suffice for the contract.
- Frontend exposure of `retryable` (`ResourceResponse` unchanged).
- Error-code taxonomy (`error.code` asserted to remain `"UNKNOWN"`; nothing else).
- Exhaustive per-step stage assertions beyond the two representative stages.

## 7. Open items resolved during implementation

Same list as plan §10 (handler/`_publish_status_update` exact shape; pipeline collaborator names for monkeypatching; worker import surface under the shared conftest; async plugin mode in `apps/ai-server/tests/`). Each resolves during Phase 01/02 execution and does not change test strategy — only patch points.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>