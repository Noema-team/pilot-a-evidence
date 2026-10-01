<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Plan: rag-worker → rag-api failure payload contract alignment

## Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## Non-goals

- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already writes `error`/`error_stage`/`retryable` consistently.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals. Only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error`/`error_stage`.
- Structured error codes / failure taxonomy — summary `error.code` stays `"UNKNOWN"` unless a code is actually sent.
- Any scope covered by the companion D3 issue beyond this payload alignment (its content is unavailable here; deferred). Reconciling the original D4 deviation note in `plans/upload-flow.md` is also deferred (file not present in current tree).

## Constraints

- **must**: align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable` payload keys → persisted `error`/`error_stage`/`retryable`); do not change rag-api's reads or persisted schema.
- **must_not**: no Firestore migration, field rename, or backfill of existing documents.
- **must**: every worker-originated failure payload carries `retryable` explicitly, derived deliberately; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **prefer**: retain the legacy `error` key in the worker's failure payload alongside `error_message` (compatibility hedge for unknown consumers of the status topic).
- **prefer_not**: no structured error-code taxonomy.

## Verified repository facts

- Worker (`apps/ai-server/rag-worker-service/main.py`): `classify_error(e) -> bool` returns True for transient (explicit `TransientError`, known transient exception types such as `httpx.ConnectError`/`TimeoutError`, HTTP status 429/500/502/503/504) and False for permanent (`PermanentError`, other 4xx, and unknown exceptions by conservative default). `run_worker` uses this for ACK/NACK.
- Worker's `process_document` exception handler publishes failed status with details `{"error": str(e)}` via `_publish_status_update`.
- Worker publishes named progress stages (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`) but has no stage tracking in the failure handler.
- rag-api (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch) reads `error_message`, `stage`, `retryable` from the payload details; persists `error`, `error_stage`, `retryable` on the main resource document; writes `message`/`stage` into the processing/summary error subdocument with `error_code` defaulting to `"UNKNOWN"`.
- Persisted failure schema is established: worker stale-lease sweep, rag-api enqueue-failure paths (`/process`, `POST /resources`), `ResourceResponse`, and `Resource` model (`models/resource.py`, `retryable` defaults True) all use `error`/`error_stage`/`retryable`.
- Contract-test infrastructure exists: `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests; imports `main as rag_api_main` directly). Both services support hermetic Firestore-emulator mode (`FIRESTORE_EMULATOR_HOST` branches).
- Both services have `pytest.ini` with `asyncio_mode = auto`, `testpaths = tests`.

## Design decisions

### 1. Worker aligns to the API's keys

The worker is the only writer that doesn't speak the `error`/`error_stage`/`retryable` persisted schema. Fix the odd one out: publish `error_message`, `stage`, `retryable`. No reader changes, no migration.

### 2. Stage tracking in `process_document`

`process_document` is one large try block, so nothing knows where failure occurred. Add a local stage tracker (e.g. `current_stage`) set immediately **before** each pipeline `await`, using the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. The exception handler reports the tracker value; when the stage is genuinely unknown (failure before the first transition), use `"processing"` — the same safe value the stale-lease sweep uses — so `error_stage` never regresses to null.

Convention: "set the tracker immediately before the await." Drift risk (a future pipeline step added without updating the tracker) is mitigated by representative-stage contract coverage (early-stage and late-stage failure), not by ossifying every step.

### 3. retryable: derive from `classify_error`, never default

Derive `retryable` from the same `classify_error(e)` that drives ACK/NACK in `run_worker`:

- transient-classified → `retryable: true` (Pub/Sub will redeliver)
- permanent-classified, including unclassified-unknown → `retryable: false` (acked; manual reprocess via `POST /process` remains)

Deliberate behavior change: unclassified-unknown exceptions currently persist `retryable: true` (silent default) but classify permanent — they will now persist `false`. This is the conservatism `classify_error` was written for; it prevents infinite retry loops. The stale-lease sweep's separate `retryable: true` write stays correct (a dead worker is a transient condition).

### 4. Compatibility hedge: retain legacy `error` key

Only rag-api's status subscriber is a verified consumer. The worker retains the legacy `error` key alongside `error_message` — one redundant string per failure message as insurance for unknown readers of the status topic and log tooling. Dropping the duplicate later is trivial cleanup if an audit confirms the worker is the sole publisher.

## Phases

### Phase 1 — Worker failure payload

Status: NOT STARTED

#### Scope

- In `apps/ai-server/rag-worker-service/main.py`, `process_document`: introduce the stage tracker; set it immediately before each pipeline step with the existing stage vocabulary; initialize to `"processing"`.
- In the exception handler: build the failure payload with `error_message` (`str(e)`), `stage` (tracker value), `retryable` (`classify_error(e)`), and retain the legacy `error` key (`str(e)`); publish via `_publish_status_update`.
- No changes to `classify_error`, `run_worker` ACK/NACK logic, leases, or heartbeats.

#### Acceptance criteria

- Every worker-originated failure payload contains `error_message`, `stage`, and `retryable` (plus legacy `error`); none of the three keys rely on rag-api's fallback defaults.
- Stage names reuse the existing progress-stage vocabulary; unknown stage reports `"processing"`.
- `retryable` is derived from `classify_error`: transient → true, permanent/unknown → false.

#### Validation

- Unit-level check of payload construction (see test plan).
- `pytest apps/ai-server/rag-worker-service/tests`

### Phase 2 — rag-api failed-branch passthrough verification

Status: NOT STARTED

#### Scope

- No code change expected: verify `run_transactional_update`'s failed branch persists payload values unchanged — main doc `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`; processing/summary error subdocument carries the same message and stage, `error_code` stays `"UNKNOWN"`.
- If any read-side default is found to override worker values, fix minimally so worker-provided values persist unchanged (still no schema change).

#### Acceptance criteria

- After a failed job, the persisted resource document has `error` = the worker's actual message (not "Processing failed"), `error_stage` = the failing stage (not None), `retryable` = the worker's derived value.
- The processing/summary error subdocument carries the same message and stage as the main document.

#### Validation

- Contract test exercising `run_transactional_update` against the Firestore emulator or fakes (see test plan).

### Phase 3 — Contract test and drift guard

Status: NOT STARTED

#### Scope

- Add a worker→rag-api failure-path contract test following the house pattern in `apps/ai-server/tests/integration/test_api_contracts.py`: import both sides rather than restating the contract in a fixture; build the failure payload through the worker's code path; feed it through rag-api's `run_transactional_update` against the Firestore emulator (or fakes); assert persisted `error`, `error_stage`, `retryable` equal the worker's values.
- Add a key-set drift guard: assert the worker's failure payload key set and rag-api's failed-branch read key set match the contract (`error_message`, `stage`, `retryable`, plus legacy `error`), so a future edit to either side's keys fails the build.
- Cover representative stages: an early-stage failure and a late-stage failure, asserting the reported stage tracks the executing step.

#### Acceptance criteria

- Contract test exists and passes; it fails if either side's payload keys drift.

#### Validation

- `pytest apps/ai-server/tests/integration/test_api_contracts.py`

## Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- **`retryable: false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key later means touching the test.

## Plan deviations

Record approved material changes to the plan here. (None at planning time.)
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan: rag-worker → rag-api failure payload contract alignment

## Scope under test

- `apps/ai-server/rag-worker-service/main.py` — `process_document` failure handler (payload construction), stage tracker, `classify_error`-derived `retryable`.
- `apps/ai-server/rag-api-service/main.py` — `run_transactional_update` failed branch (persistence of `error`, `error_stage`, `retryable`; processing/summary error subdocument).
- Cross-service seam: worker failure payload keys ↔ rag-api failed-branch read keys.

## Test strategy

Import both sides rather than restate the contract in a fixture. Build the failure payload through the worker's actual code path, feed it through rag-api's `run_transactional_update` against the Firestore emulator (or fakes), and assert the persisted fields. Add a key-set drift guard so future key edits on either side fail the build instead of silently re-creating the mismatch. Follow the existing house pattern in `apps/ai-server/tests/integration/test_api_contracts.py` (direct `import main as rag_api_main`, static/AST checks, fixture contracts); both services support hermetic runs via `FIRESTORE_EMULATOR_HOST` branches.

## Test cases

### T1 — Worker failure payload shape (worker unit / integration)

- Trigger a failure in `process_document` (early stage, e.g. during text retrieval) with a known exception message.
- Capture the payload passed to `_publish_status_update`.
- Assert payload contains:
  - `error_message` == the actual exception message
  - `stage` == the executing stage at failure time (vocabulary value, e.g. `text_retrieved`)
  - `retryable` == the value `classify_error(e)` returns for that exception
  - legacy `error` == the same exception message (compatibility hedge)
- Assert none of the three contract keys is absent or defaulted.

### T2 — Stage tracking across the pipeline

- Force failures at representative stages: an early-stage failure (e.g. before/within text retrieval) and a late-stage failure (e.g. during embeddings).
- Assert reported `stage` matches the executing step in each case (early → e.g. `text_retrieved`; late → e.g. `embeddings_complete`).
- Assert failure before the first stage transition reports the safe value `"processing"` (never null/missing).

### T3 — retryable derivation

- Table-driven over `classify_error` classes:
  - `TransientError` / `httpx.ConnectTimeout` / HTTP 503 → payload `retryable == True`
  - `PermanentError` / HTTP 400 / unknown exception type → payload `retryable == False`
- Assert the payload's `retryable` always equals `classify_error(e)` for the raised exception (deliberate derivation, never a silent default).

### T4 — rag-api failed-branch persistence (contract, Firestore emulator or fakes)

- Seed a resource document; invoke `run_transactional_update`'s failed branch with a worker-constructed payload (from T1's code path, not a hand-written fixture).
- Assert persisted main document:
  - `error` == payload `error_message` (not `"Processing failed"`)
  - `error_stage` == payload `stage` (not None)
  - `retryable` == payload `retryable` (not the silent `True` default)
- Assert processing/summary error subdocument:
  - `message` == payload `error_message`
  - `stage` == payload `stage`
  - `error_code` == `"UNKNOWN"` (no code sent)

### T5 — Key-set drift guard

- Statically (AST, per house pattern) or dynamically assert:
  - the worker's failure payload key set is exactly `{error_message, stage, retryable, error}`;
  - rag-api's failed branch reads exactly `error_message`, `stage`, `retryable` from details.
- Any key added or removed on either side fails the test with a message naming the drifted side.

### T6 — End-to-end failure path (emulator, where available)

- With the Firestore emulator running, publish a worker failure payload through the status-subscriber path into rag-api's `run_transactional_update`; assert the persisted document matches T4's assertions with real worker-produced values.

## Acceptance mapping

| Definition acceptance criterion | Tests |
|---|---|
| Failure payload carries `error_message`/`stage`/`retryable`, no fallback reliance | T1, T3, T5 |
| Persisted `error`/`error_stage`/`retryable` equal worker's values | T4, T6 |
| Processing/summary subdocument carries same message and stage | T4, T6 |
| Contract test exists, passes, fails on key drift | T5 (+ T4/T6 as the path test) |

## Commands

- Worker: `pytest apps/ai-server/rag-worker-service/tests`
- API: `pytest apps/ai-server/rag-api-service/tests`
- Contract suite: `pytest apps/ai-server/tests/integration/test_api_contracts.py`
- Emulator mode (where used): set `FIRESTORE_EMULATOR_HOST` per each service's existing hermetic branch before running T4/T6.

## Out of scope for testing

- Stale-lease sweep behavior (unchanged by design; its `retryable: true` write is intentionally preserved).
- ACK/NACK retry mechanics, leases, heartbeats.
- Frontend/mobile field exposure (`ResourceResponse` already covers `error`/`error_stage`).
- Structured error-code taxonomy (`error_code` stays `"UNKNOWN"`).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>