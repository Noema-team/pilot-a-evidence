<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Plan — rag-worker → rag-api failure payload contract alignment

- WorkItem: `wi-define-108-a8` (authoritative Definition artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`)
- Run: `7aa11988-bd39-4e4e-b95c-6bf5285a6454` · Iteration 1 · Step: plan
- Companion test plan: `docs/test-plan.md`

## Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG
processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately
derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## Problem (verified)

- The worker's `process_document` exception handler publishes a one-key failure payload
  (`{"error": str(e)}`) via `_publish_status_update` (Definition F3).
- rag-api's failed branch in `run_transactional_update` reads `error_message`, `stage`, and `retryable`,
  persisting them as `error` / `error_stage` / `retryable` on the main resource document, and writes
  `message` / `stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary error
  subdocument (F4).
- Because of the key mismatch, every worker-originated failure currently persists the fallback string
  `"Processing failed"`, `error_stage: None`, and a silently defaulted `retryable: True` (F5).
- The persisted `error` / `error_stage` / `retryable` schema is already established across three other
  write paths (worker stale-lease sweep `_fail_if_still_stale`, rag-api's `/process` and `POST /resources`
  enqueue-failure paths) and both `ResourceResponse` and the `Resource` model (F6). The worker's status
  publisher is the only writer that does not speak it.

## Direction

The worker aligns to rag-api's existing contract — it is the odd one out. No rag-api reader changes, no
persisted-field changes, no migration, no backfill.

## Non-goals

- Changing the stale-lease sweep's direct failure write (already consistent: persists
  `error`/`error_stage`/`retryable`, with `retryable: True` — correct, since a dead worker is a transient
  condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only
  the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains
  `"UNKNOWN"` unless a code is actually sent.
- Anything the companion D3 issue covers beyond this payload alignment (its content is unavailable here;
  deferred), and reconciling this analysis with the D4 deviation note in `plans/upload-flow.md` (file not
  present in the current tree).

## Constraints

| Type | Constraint |
|------|------------|
| must | Worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed. |
| must_not | No Firestore migration, field rename, or backfill; persisted fields `error`/`error_stage`/`retryable` keep names and semantics. |
| must | Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message` (compatibility hedge for unknown consumers of the status topic). |
| prefer_not | Do not introduce a structured error-code taxonomy. |

## Design

### 1. Stage tracker in `process_document` (worker `main.py`)

- Introduce a local stage tracker in `process_document` (e.g. `current_stage`), initialized to the safe
  value `"processing"`.
- **Convention: set the tracker immediately before each awaited pipeline step.** Values reuse the existing
  progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`,
  `chunking_complete`, `embeddings_complete`. The exact value assigned to each step is taken from the
  step's corresponding `_publish_status_update` progress call site in `process_document` (those call sites
  are the vocabulary source per F9); do not invent new stage names.
- The exception handler reports the tracker's current value. `"processing"` remains the value only when a
  failure occurs before the first tracker assignment — the same safe value the stale-lease sweep uses for
  `error_stage`, so the field never regresses to null.
- Drift risk (a future pipeline step added without updating the tracker) is mitigated by the
  update-before-await convention and representative early/late-stage test coverage (see test plan), not by
  ossifying every step.

### 2. Failure payload construction (worker `main.py`)

- Extract a small module-level builder in the worker's `main.py` (indicative name
  `_build_failure_payload(error: Exception, stage: str) -> dict`, named consistently with existing
  module-level helpers such as `_fail_if_still_stale` / `_claim_resource_if_queued`). It returns:
  - `error_message`: `str(e)` — the actual exception message;
  - `stage`: the tracker value passed in;
  - `retryable`: `classify_error(e)` — deliberately derived (see §3);
  - `error`: `str(e)` — legacy key retained alongside `error_message` (constraint "prefer"; F11 hedge).
- The `process_document` exception handler calls the builder and passes its result to the existing
  `_publish_status_update` call unchanged in all other respects (same status/topic wiring as today).
- Keeping the builder module-level and pure makes the worker side of the seam directly importable by the
  contract test, matching the house pattern of importing `main` and calling module-level functions
  (`rag-worker-service/tests/unit/test_processing_lease.py` does exactly this).

### 3. retryable derivation

- `retryable` comes from `classify_error(e)`: transient-classified → `True`; permanent-classified →
  `False`. Unclassified-unknown exceptions classify as permanent by `classify_error`'s conservative
  default, so they derive `False` (F7, F8).
- Rationale: aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker` —
  transient errors are ones Pub/Sub will redeliver; permanent errors are acked and will not return
  (manual reprocess via `POST /process` remains available).
- **Deliberate, sanctioned behavior change:** unclassified-unknown exceptions currently persist
  `retryable: True` (silent default) and will now persist `False`. This is the conservatism
  `classify_error` was written for. Widening `classify_error` is out of scope.
- The stale-lease sweep's separate direct write of `retryable: True` stays untouched and correct.

### 4. rag-api side: no source changes expected

- Per F4, rag-api's failed branch already reads exactly the keys the worker will now send and persists
  them unchanged into `error` / `error_stage` / `retryable` plus the processing/summary error subdocument.
- Expected rag-api diff: **none**. The contract test pins the seam. If implementation reveals any
  deviation from F4's description, record it under *Plan deviations* before touching rag-api — any rag-api
  change beyond a verified defect against the Definition requires a deviation entry.

## Implementation phases

### Phase 1 — Worker failure payload

Status: NOT STARTED

#### Scope

- Stage tracker in `process_document` per §1 (update-before-await convention, vocabulary values,
  `"processing"` safe default).
- Module-level failure-payload builder per §2; exception handler wired to it; legacy `error` key retained.
- No changes to `_publish_status_update` itself, the sweep, ACK/NACK logic, leases, or heartbeats.

#### Acceptance criteria

- A failed job's published status payload contains `error_message` (actual exception message), `stage`
  (failing stage from the tracker), and `retryable` (derived via `classify_error`), plus the retained
  legacy `error` key — none of these relying on rag-api's fallback defaults. (Definition acceptance A1.)
- Stage names reuse the existing progress vocabulary; `"processing"` appears only when the stage is
  genuinely unknown.
- `retryable` is `True` exactly for transient-classified errors and `False` for permanent-classified
  errors, including unclassified-unknown.

#### Validation

- New worker unit tests (see `docs/test-plan.md`, suite U) pass:
  `cd apps/ai-server/rag-worker-service && python -m pytest`
- Pre-existing worker unit suite remains green (including `test_processing_lease.py`, which pins the
  sweep's `retryable is True` — must remain untouched and passing).

### Phase 2 — Worker→rag-api failure-path contract test

Status: NOT STARTED

#### Scope

- New cross-service contract test file in `apps/ai-server/tests/integration/` (indicative name
  `test_worker_failure_contract.py`), exercising:
  1. the worker's failure-payload construction (through the worker's real code path — the builder, and
     where feasible `process_document` driven to fail early and late with a capturing status publisher);
  2. rag-api's failed-branch persistence (`run_transactional_update`) via Firestore fakes or the Firestore
     emulator;
  3. persisted-value equality: `error` ← payload `error_message`, `error_stage` ← payload `stage`,
     `retryable` ← payload `retryable`; processing/summary error subdocument carries the same message and
     stage, `error_code` `"UNKNOWN"` when none sent;
  4. drift guards on both sides' payload keys (see test plan C4/C5 — including a binding guard that
     catches rag-api silently re-binding to the legacy `error` key, which value-equality alone cannot
     catch because the worker sends both keys with equal values).
- Extend `apps/ai-server/tests/integration/conftest.py` as needed: add the worker service directory to
  `sys.path` and the worker-side module stubs (modeled on
  `rag-worker-service/tests/conftest.py`), taking care with the two services both exposing a `main`
  module (prefer distinct module names via `importlib` spec loading; consult the existing two-service
  cross-service tests in the same directory — `test_chat_pipeline.py`, `test_search_pipeline.py` — for the
  established import technique before introducing a new one).

#### Acceptance criteria

- The contract test exists, passes, and fails if either side's payload keys drift. (Definition
  acceptance A4; also evidences A2 and A3.)

#### Validation

- `cd apps/ai-server && python -m pytest tests/integration -q` (confirm the exact invocation used by CI —
  see Open item V3).
- Full pre-existing integration/contract suite remains green.

### Phase 3 — Verification and closeout

Status: NOT STARTED

#### Scope

- Run the full worker unit suite, the rag-api suite (must remain green with **zero** rag-api source
  changes), and the shared integration suite.
- Confirm no migration/backfill artifacts were introduced (constraint must_not).
- Resolve the Open items V1–V5 below; record outcomes (and any deviations) in this plan.

#### Acceptance criteria

- All four Definition acceptance criteria met; traceability table in `docs/test-plan.md` fully mapped.

#### Validation

- Commands from Phases 1–2 plus the rag-api suite:
  `cd apps/ai-server/rag-api-service && python -m pytest`

## Open items to resolve during implementation (verified-unknown, must not be assumed)

- **V1 — `utils/status_updater.py` is not on the failure path (verify, then leave alone).** This verified
  file is a Firestore-direct status writer using a *different* field family
  (`processingStatus`/`processingStage`/`processingError`) and a *different* stage vocabulary
  (e.g. `PDF_DOWNLOAD`, `COMPLETED`) against `users/{uid}/courses/{cid}/courseResources/{rid}`. Its callers
  are unknown from this investigation. Grep for `StatusUpdater` usage; if it is legacy/dead code, do not
  touch it and do not conflate its vocabulary with the required progress-stage vocabulary. It is out of
  scope either way unless it turns out to participate in the worker→rag-api failure path (which would
  contradict F3/F9 and require a plan deviation).
- **V2 — rag-api failed branch matches F4.** Read `run_transactional_update`'s failed branch before
  Phase 2; expected: no changes needed. Any mismatch → plan deviation entry.
- **V3 — CI pickup.** Read `apps/ai-server/.github/workflows/test.yml` and confirm the job that runs
  `tests/integration` picks up new files in that directory (existing contract tests there run in CI per
  `docs/TESTING-STRATEGY.md` Phase 3).
- **V4 — early/late failure seams in `process_document`.** The internal step function/call names were not
  restated in this plan (only their existence and `_publish_status_update` call sites are established).
  Determine the minimal patch seams for forcing an early-stage and a late-stage failure from the actual
  body of `process_document` during implementation.
- **V5 — representative `classify_error` heuristic cases.** `classify_error`'s full heuristic branches
  (beyond the `TransientError`/`PermanentError` isinstance checks, which are verified) should be read to
  pick one representative type-/status-code-heuristic transient case for the unit suite.

## Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error`;
  residual risk accepted as low (F11).
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and
  representative early/late-stage coverage.
- **`retryable: false` for unclassified-unknown errors** reduces auto-retry affordances for genuinely
  transient-but-unrecognized failures — accepted by the Definition (F8); manual reprocess via
  `POST /process` remains; widening `classify_error` is out of scope.
- **The contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding
  a key later means touching the test.
- **Two-`main`-module import friction in the shared integration conftest** — mitigated by reusing the
  established cross-service import technique; fallback is `importlib` spec loading under distinct module
  names.

## Definition of done

- [ ] Worker failure payload carries `error_message`/`stage`/`retryable` (+ legacy `error`), derived per §2–§3.
- [ ] Stage tracker implemented with update-before-await convention and `"processing"` safe value.
- [ ] rag-api source unchanged; no migration/backfill.
- [ ] Worker unit suite green including new tests (U-series).
- [ ] Contract test green including drift guards (C-series).
- [ ] rag-api suite green (unchanged).
- [ ] Open items V1–V5 resolved and recorded; deviations (if any) logged below.

## Plan deviations

(record approved material changes to this plan here — none at planning time.)
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker→rag-api failure payload contract

- WorkItem: `wi-define-108-a8` · Companion plan: `docs/plan.md`
- Strategy anchor: `docs/TESTING-STRATEGY.md` (test pyramid, naming conventions, contract-test layer)

## Strategy

Two layers, matching the repo's existing patterns:

1. **Worker unit tests** (`apps/ai-server/rag-worker-service/tests/unit/`) — fast, in-service, using the
   established `sys.path.insert` + `import main` pattern and the Fake transaction/doc harness from
   `test_processing_lease.py`. Cover the payload builder, the retryable derivation, and the stage tracker
   inside `process_document` (early/late failure injection).
2. **Cross-service contract test** (`apps/ai-server/tests/integration/`) — imports **both sides** rather
   than restating the contract in a fixture: builds the failure payload through the worker's code path and
   feeds it through rag-api's `run_transactional_update` failed branch against Firestore fakes (preferred)
   or the Firestore emulator. Asserts persisted `error`, `error_stage`, `retryable`, and the
   processing/summary error subdocument. Includes explicit key-set drift guards.

Principles:

- **Import, don't restate.** The contract test calls the worker's payload builder and rag-api's
  `run_transactional_update`; it does not hard-code a copy of the payload shape as the system under test.
- **Deterministic.** No sleeps, no real network, no real Firestore unless the emulator variant is chosen;
  worker `pytest.ini` runs with `asyncio_mode = auto`.
- **Drift fails the build.** Key changes on either side must fail a test (see C4/C5 for why value equality
  alone is insufficient on the api side).
- **Anti-ossification.** Representative early/late stages only; do not pin every pipeline step, rag-api
  internals beyond the Definition-named fields, or the sweep (already pinned by
  `test_processing_lease.py::TestSweepRace`, including `retryable is True` — those tests must remain
  untouched and green).

## Suite U — worker unit tests (new file, indicative: `tests/unit/test_failure_payload.py`)

Follows `test_processing_lease.py` conventions (`import main`, fakes, `monkeypatch` on `main.*`).
Exact patch seams for U9–U11 are determined from `process_document`'s actual body (plan open item V4).

| ID | Case | Assertion |
|----|------|-----------|
| U1 | Payload builder key set | Built payload's keys are exactly `{error, error_message, stage, retryable}` |
| U2 | Actual message | `error_message == str(exception)` (a distinctive sentinel message, not a fallback string) |
| U3 | Legacy key retained | `error == str(exception)` — same message as `error_message` |
| U4 | Transient → retryable | `TransientError`-derived exception ⇒ `retryable is True` |
| U5 | Permanent → not retryable | `PermanentError`-derived exception ⇒ `retryable is False` |
| U6 | Unclassified-unknown → not retryable | Plain `Exception` (matches no explicit type) ⇒ `retryable is False` (conservative default; pins the sanctioned behavior change) |
| U7 | Heuristic classification representative | One representative case from `classify_error`'s type-/status-code heuristics maps to the same retryable value `classify_error` returns (case selected per plan open item V5) |
| U8 | Stage passthrough | Builder returns the `stage` argument verbatim, including the `"processing"` safe value |
| U9 | Early-stage failure | Drive `process_document` to fail at an early pipeline step (collaborator patched to raise); capture the `_publish_status_update` payload via a fake publisher; assert published `stage` is the expected early vocabulary value and `error_message`/`retryable` are populated |
| U10 | Late-stage failure | Same mechanism with a late pipeline step (e.g. around chunking/embeddings); assert the late vocabulary value |
| U11 | Failure before first transition | Failure before the first tracker assignment ⇒ published `stage == "processing"` (never `None`) |
| U12 | Handler wiring | The exception handler passes the builder's output to `_publish_status_update` unchanged (fake publisher captures the exact details dict) |

## Suite C — contract tests (new file in `apps/ai-server/tests/integration/`, indicative:
`test_worker_failure_contract.py`)

Environment: extend the directory `conftest.py` with the worker service on `sys.path` plus worker-side
module stubs (modeled on `rag-worker-service/tests/conftest.py`); load the two `main` modules under
distinct module names (prefer the technique already used by the existing two-service tests in this
directory — `test_chat_pipeline.py` / `test_search_pipeline.py` — before introducing `importlib` spec
loading). Existing env defaults (`GCP_PROJECT`, `SHARED_INTERNAL_TOKEN`) already present.

Fakes vs emulator: **fakes preferred** (hermetic, no CI emulator service; the Fake transaction harness
pattern from `test_processing_lease.py`, including the identity stand-in for the `firestore.transactional`
wrapper, is the template). The Firestore emulator is the sanctioned fallback if
`run_transactional_update`'s transaction semantics cannot be faked faithfully — that choice would need CI
wiring for the emulator and a plan-deviation entry.

| ID | Case | Assertion |
|----|------|-----------|
| C1 | Transient failure, end-to-end seam | Worker-built failure payload (transient-classified error, representative stage) fed through rag-api's `run_transactional_update` failed branch ⇒ persisted `error == payload["error_message"]` (not `"Processing failed"`), `error_stage == payload["stage"]` (not `None`), `retryable is True` |
| C2 | Permanent failure, end-to-end seam | Same with a permanent-classified error ⇒ `retryable is False` persisted |
| C3 | Summary/processing error subdocument | Subdocument `message` and `stage` equal the main document's persisted values; `error_code == "UNKNOWN"` when the payload sends no code |
| C4 | Worker-side key-set drift guard | Explicit assertion on the worker-built payload's key set (complements U1 at the seam); fails if the worker renames/drops `error_message`, `stage`, or `retryable` |
| C5 | API-side binding drift guard | Payload constructed with a **divergent sentinel**: legacy `error` set to one string, `error_message` to another ⇒ persisted `error` must equal the `error_message` value. Necessity: because the worker sends `error` and `error_message` with equal values in production, plain value equality (C1/C2) cannot detect rag-api silently re-binding to the legacy `error` key — this case can |
| C6 | Early/late stage through the real worker path | Where `process_document` is drivable under the shared conftest stubs: force an early and a late failure (per U9/U10 seams), capture the real published payload, run it through the failed branch, assert persisted `error_stage` matches the failing step. Fallback (record as a note, not a deviation, if the stub burden is prohibitive): C1/C2 carry representative stage values via the builder, and U9–U11 pin the tracker mechanism in-suite U |
| C7 | Drift guard self-check (optional) | Legacy-shaped payload (`{"error": ...}` only) ⇒ persisted fallbacks (`"Processing failed"`, `None`, `True`), demonstrating the harness actually detects the original mismatch. Optional because it ossifies the fallback strings; include only if it aids review of the guard's sensitivity |

## Traceability

| Definition requirement | Covered by |
|------------------------|------------|
| R1 — payload carries `error_message`/`stage`/`retryable`, never fallback-reliant | U1–U3, U8, U12, C1, C2, C4 |
| R2 — stage tracking with existing vocabulary + `"processing"` safe value | U8–U11, C6 |
| R3 — rag-api persists worker values unchanged; subdocument carries same message/stage | C1–C3, C5 |
| R4 — retryable derivation aligned with `classify_error` / ACK-NACK | U4–U7, C1, C2 |
| R5 — contract test exercises construction → persistence, fails on key drift | C1–C6 (C4/C5 are the drift guards) |

| Definition acceptance criterion | Evidenced by |
|--------------------------------|--------------|
| A1 — published payload has all three keys, none fallback-reliant | U1–U12, C4 |
| A2 — persisted `error` (actual message), `error_stage` (stage), `retryable` (derived) | C1, C2, C5 |
| A3 — processing/summary error subdocument matches main document | C3 |
| A4 — contract test exists, passes, fails on either side's key drift | C1–C6 |

## Execution

```bash
# Worker unit suite (includes new U-series; asyncio_mode=auto via pytest.ini)
cd apps/ai-server/rag-worker-service && python -m pytest

# rag-api suite — must remain green with zero source changes
cd apps/ai-server/rag-api-service && python -m pytest

# Shared integration/contract suite (includes new C-series)
cd apps/ai-server && python -m pytest tests/integration -q
```

Confirm the CI invocation for `tests/integration` against `apps/ai-server/.github/workflows/test.yml`
(plan open item V3) so the new contract file is picked up by the existing contract-test job.

## Explicitly not tested here

- Stale-lease sweep behavior — already pinned by `test_processing_lease.py` (`TestSweepRace`), untouched.
- ACK/NACK policy, lease/heartbeat mechanics — out of scope; only payload reporting changes.
- rag-api endpoints end-to-end over HTTP — covered by existing `rag-api-service/tests/integration`;
  this plan's contract test targets the `run_transactional_update` failed branch directly.
- `utils/status_updater.py` — legacy/parallel writer with a different field family and stage vocabulary
  (plan open item V1); no tests unless V1 finds it on the live failure path (which would be a deviation).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>