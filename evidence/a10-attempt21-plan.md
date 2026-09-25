<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Worker → rag-api Failure Payload Contract Alignment

Status: PLANNED — plan prepared from the authoritative Definition (`wi-define-108-a8`); not yet reviewed, no implementation started.

## Goal

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived `retryable` flag. Today the worker's exception handler publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch reads `error_message` / `stage` / `retryable` — so every worker-originated failure lands in Firestore as the fallback string `"Processing failed"`, `error_stage: null`, and a silently defaulted `retryable: true`, with the `processing/summary` error subdocument inheriting the same fallbacks (`error_code` always `"UNKNOWN"`).

The fix direction is fixed by the Definition: **the worker aligns to rag-api's existing contract** — publish `error_message` / `stage` / `retryable` — because the persisted schema (`error`, `error_stage`, `retryable`) is already consistent across the worker's stale-lease sweep, rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse`. The worker's status publisher is the only writer that doesn't speak it. No rag-api reader changes, no migration, no backfill. The seam is locked by a contract test on the worker → rag-api failure path.

## Verified background (from the Definition's pinned facts)

- Worker: `process_document`'s exception handler publishes failed status via `_publish_status_update` with `details={"error": str(e)}` (F3).
- rag-api: `run_transactional_update`'s failed branch reads `details` keys `error_message`, `stage`, `retryable`; persists `error`, `error_stage`, `retryable` on the main resource document; writes `message` / `stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument (F4).
- The worker classifies exceptions via `classify_error()` (TransientError/PermanentError plus type- and status-code heuristics; unknown exceptions classify as permanent) and uses that classification for ACK/NACK in `run_worker` (F7).
- The worker publishes named progress stages (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`) but has no stage tracking in the failure handler today (F9).
- Contract-test infrastructure exists (`apps/ai-server/tests/integration/test_api_contracts.py`, fixture- and AST-based static contract tests) and both services support a hermetic Firestore-emulator mode via `FIRESTORE_EMULATOR_HOST` branches (F10).

Key mapping (the contract under test):

| Worker payload key (new) | rag-api reads | Persisted as | Notes |
|---|---|---|---|
| `error_message` | `details["error_message"]` | main doc `error`; subdoc `message` | actual exception message; `"Processing failed"` fallback must never be operative |
| `stage` | `details["stage"]` | main doc `error_stage`; subdoc `stage` | progress vocabulary; `"processing"` safe fallback |
| `retryable` | `details["retryable"]` | main doc `retryable` | derived from `classify_error(e)`; silent default must never be operative |
| `error` (legacy, retained) | not read by rag-api | — | compatibility hedge for unknown consumers of the status topic |
| — | `error_code` | subdoc `error_code` | stays `"UNKNOWN"` unless a code is actually sent (none is, in this scope) |

## Non-goals

- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract; its `retryable=true` stays correct (a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error `code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here; deferred per the Definition).
- Reconciling this analysis with the original D4 deviation note referenced in `plans/upload-flow.md` (that file is not present in the current tree; the reference comes from the Objective text).

## Constraints

- **Must**: the worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed.
- **Must not**: no Firestore migration, field rename, or backfill of existing documents; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must**: every worker-originated failure payload carries `retryable` explicitly (deliberately derived); rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer**: retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling.
- **Prefer not**: no structured error-code taxonomy (`error_code` values) in this fix.

## Deliberate behavior change (must be called out in the PR description)

Unclassified-unknown exceptions currently persist `retryable: true` via rag-api's silent default. After this change they persist `retryable: false`, because `classify_error` conservatively classes unknown exceptions as permanent. This is intentional — it aligns the persisted record with the worker's actual ACK/NACK behavior (permanent errors are acked and will not be redelivered; manual reprocess via `POST /process` remains available) and prevents infinite retry loops. Residual tradeoff, accepted per the Definition: genuinely transient-but-unrecognized failures lose the auto-retry affordance; widening `classify_error` is out of scope.

## Workflow note

This change touches two services plus the shared integration test suite and changes a service-to-service payload contract, so the small-change criteria in `AGENTS.md` are not all met (not "one service plus its tests"; cross-service contract change). Use the feature path. Per `AGENTS.md` / `plans/README.md`, this plan body belongs at `plans/<feature-slug>.md` on the feature branch once created; this document is that plan.

- Suggested feature branch: `feature/rag-failure-payload-contract`
- Suggested phase branches: `phase/rag-failure-payload-contract/01-worker-payload`, `phase/rag-failure-payload-contract/02-contract-test`

---

## Phase 1 — Worker failure payload alignment

Status: NOT STARTED

### Scope

1. **Stage tracking in `process_document`.**
   - Introduce a local stage tracker, initialized to `"starting"`.
   - Convention (binding): set the tracker **immediately before each pipeline step's await**, to the progress-vocabulary name of the step in flight — the same name whose progress update is published when that step completes. Vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. Every existing progress-update site in `process_document` gets a tracker update at its corresponding await.
   - The exception handler reports the tracker value. When no stage is known at all (failure before the tracker exists; defensive default in the payload builder), report `"processing"` — the same safe value the stale-lease sweep uses for `error_stage`, so the field never regresses to null. `"processing"` is the only permitted value outside the vocabulary.
   - Known drift risk (accepted, mitigated in Phase 2): a future pipeline step added without a tracker update reports a stale stage. The convention is "set the tracker immediately before the await".

2. **Failure payload construction in the exception handler.** Replace the current one-key payload with a details dict containing exactly:
   - `error_message`: `str(e)` — the actual exception message;
   - `stage`: the tracked stage (or `"processing"` when genuinely unknown);
   - `retryable`: derived from `classify_error(e)` — transient classification → `True`; permanent classification, including unclassified-unknown → `False`;
   - `error`: `str(e)` — legacy key retained alongside `error_message` (compatibility hedge per the Definition; dropping it later is trivial cleanup if an audit confirms rag-api is the only consumer).
   - Recommended shape: extract construction into a named module-level helper (e.g. `build_failure_details(exc, stage)`) so it is unit-testable in isolation and importable by the Phase 2 contract test. The binding requirement is that the contract test exercises the worker's real construction path — never a re-stated fixture.
   - `classify_error` itself is unchanged and must remain a pure function of the exception; it is called a second time (it is already called in `run_worker` for ACK/NACK decisions).

3. **Explicitly unchanged.**
   - `_fail_if_still_stale` (stale-lease sweep) — already writes `error`/`error_stage`/`retryable` consistently.
   - `run_worker` ACK/NACK decisions, Pub/Sub retry policy, leases, heartbeats.
   - rag-api: **no production code changes in this feature.** Its failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` plus `message`/`stage` (`error_code` defaulting `"UNKNOWN"`) into the `processing/summary` subdocument.
   - No new runtime dependencies, no config/`.env` changes.

### Acceptance criteria

- The worker's failed status payload contains `error_message` (actual exception message), `stage` (pipeline stage executing at failure time), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. *(Definition acceptance 1)*
- The legacy `error` key is present and equal to `error_message`.
- Stage names come from the existing progress vocabulary; `"processing"` appears only when the stage is genuinely unknown; the reported stage is never null/absent.
- `retryable`: transient-classified → `true`; permanent-classified (including unclassified-unknown) → `false`; always derived via `classify_error`, never a literal default.
- Existing worker tests pass unchanged (no behavior change outside the failure path).

### Validation

- `cd apps/ai-server/rag-worker-service && python -m pytest` — full worker suite green.
- New worker unit tests green (see `docs/test-plan.md` §1).

---

## Phase 2 — Cross-service contract test and drift guard

Status: NOT STARTED

### Scope

1. **New contract test** in `apps/ai-server/tests/integration/` (suggested name `test_worker_failure_contract.py`, per the `test_<module>.py` convention) covering the worker failure → rag-api persistence seam:
   - **Worker side, real code path:** drive `process_document` with the dependency boundary of a chosen pipeline step monkeypatched to raise — once for an early stage and once for a late stage (representative-stage coverage, the agreed mitigation for tracker drift). Capture the payload the worker actually publishes via a fake publisher.
   - **rag-api side, real code path:** feed that captured payload through `run_transactional_update`'s failed branch against the Firestore emulator (`FIRESTORE_EMULATOR_HOST` branches exist in both services) or in-memory fakes. The test must be hermetic — no GCP credentials, no network; fakes are the default when no emulator is configured.
   - **Persistence assertions** (compared against the captured payload, not restated literals): main doc `error == payload["error_message"]` (and `!= "Processing failed"`), `error_stage == payload["stage"]` (and not `None`), `retryable == payload["retryable"]`; `processing/summary` error subdocument `message` and `stage` equal the same values, `error_code == "UNKNOWN"`.
   - **Retryable matrix:** a transient-classified exception persists `retryable=true`; a permanent-classified and an unclassified-unknown exception persist `retryable=false` (pins the deliberate behavior change).
   - **Key-set drift guards:**
     - Worker side: exact key-set assertion on the constructed payload — `set(payload.keys()) == {"error", "error_message", "stage", "retryable"}`. Adding or removing a key fails the build.
     - rag-api side: AST-based pin (following the existing pattern in `test_api_contracts.py`) that the failed branch reads exactly `{error_message, stage, retryable}` from `details`. A renamed or dropped read fails the build. The guard must fail loudly if it cannot locate `run_transactional_update`'s failed branch — a silently-empty scan is a false pass.
   - Import both services' real modules (path setup plus the stubbing patterns already established in each service's `tests/conftest.py`); do not restate the contract in a fixture.
2. **No production code changes in this phase.** If running the test exposes a Phase 1 defect, the minimal supporting fix may land in this phase PR (per `AGENTS.md`: small supporting changes necessary to complete the phase safely); anything larger stops the phase and records a plan deviation.

### Acceptance criteria

- The contract test exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. *(Definition acceptance 4)*
- After a simulated failed job, the persisted document has `error` = the worker's actual message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), `retryable` = the worker's derived value. *(Definition acceptance 2)*
- The `processing/summary` error subdocument carries the same message and stage as the main document. *(Definition acceptance 3)*
- Drifting either side's payload keys fails the suite (enforced by the two drift guards).

### Validation

- `python -m pytest apps/ai-server/tests/integration/test_worker_failure_contract.py -v`
- `python -m pytest apps/ai-server/tests/integration/` — full shared suite green (existing contract tests unaffected).
- `cd apps/ai-server/rag-api-service && python -m pytest` — rag-api suite green; confirms no existing test depended on the worker's old payload shape (rag-api production code is unchanged).
- `./dev/run ai-server` as the pre-PR gate (requires Docker Compose up).

---

## Risks and tradeoffs (accepted per the Definition)

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and representative-stage (early + late) test coverage.
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains.
- **The contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Implementation-time lookups (not scope questions)

The following are verified at implementation time against current code; they do not change scope: `classify_error`'s exact return shape (the payload maps its transient indication → `True`, everything else → `False`); the internal function/client boundaries to monkeypatch for per-stage failures in `process_document`; whether rag-api's failed branch is inline or extracted (it lives within `run_transactional_update` per F4 — the AST guard targets that branch wherever it resides).

## Recorded separately (not in this feature)

Optional follow-up: note the worker→rag-api failure-payload contract in `docs/system-overview/ai-server/overview.md`. Useful, not required by the Definition — record as a separate small change if wanted.

## Plan deviations

None at planning time. Per the Definition, the companion D3 issue's scope and the D4/`plans/upload-flow.md` reconciliation are deferred and must not be picked up during implementation. Any material change discovered during implementation stops the phase and is recorded here for human review.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — Worker → rag-api Failure Payload Contract

Companion to `docs/plan.md`. Objective: lock the worker→rag-api failure seam so the payload-key mismatch that produced `"Processing failed"` / `error_stage: null` / fabricated `retryable: true` can never silently recur. Every Definition acceptance criterion maps to at least one named test below.

## Contract under test

| Worker payload key | rag-api read (failed branch of `run_transactional_update`) | Persisted to | Test expectation |
|---|---|---|---|
| `error_message` | required | main doc `error`; subdoc `message` | equals `str(e)`; persisted value never `"Processing failed"` |
| `stage` | required | main doc `error_stage`; subdoc `stage` | progress vocabulary or `"processing"`; persisted value never `None` |
| `retryable` | required | main doc `retryable` | derived from `classify_error(e)`; persisted value equals the derived value, never a silent default |
| `error` | not read | — | legacy key retained, equal to `error_message` |
| *(absent)* | `error_code` | subdoc `error_code` | `"UNKNOWN"` default |

## Level 1 — Worker unit tests

Location: `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` (new file; `tests/unit/` exists).
Environment: the service's `tests/conftest.py` already stubs `google.cloud.*`, `firebase_admin`, Pub/Sub clients, etc.; `pytest.ini` sets `asyncio_mode = auto` for async `process_document` tests. Naming per `docs/TESTING-STRATEGY.md`: `test_<thing>_<condition>_<expected>`.

### Payload construction
- `test_failure_payload_contains_error_message_stage_retryable` — build the payload from a real exception plus a stage; assert `error_message == str(e)`, `stage` as given, `retryable` present and boolean.
- `test_failure_payload_retains_legacy_error_key` — `error` present and `== error_message`.
- `test_failure_payload_unknown_stage_reports_processing` — builder invoked with no/`None` stage → `"processing"` (never `None`, never absent).

### Stage tracking (drive `process_document` with a monkeypatched step boundary that raises)
- `test_failure_before_first_pipeline_step_reports_starting` — exception raised before the first step → stage `"starting"` (a vocabulary value, never `None`).
- `test_failure_during_text_retrieval_reports_text_retrieved` — early-stage representative.
- `test_failure_during_embeddings_reports_embeddings_complete` — late-stage representative.
- Coverage note: early + late representatives only, per the agreed drift mitigation — the full per-step matrix is deliberately not pinned.

### Retryable derivation
- `test_retryable_true_for_transient_classification` — a `TransientError` (or exception matching the existing transient heuristics, as already exercised by the worker's existing classification tests) → `retryable is True`.
- `test_retryable_false_for_permanent_classification` — a `PermanentError` → `retryable is False`.
- `test_retryable_false_for_unclassified_unknown` — a generic `Exception` → `retryable is False`. **Pins the deliberate behavior change** vs the old silent default `true`.
- `test_retryable_agrees_with_classify_error` — assert the payload's `retryable` equals the direct `classify_error(e)` result for each case; guards against a divergent re-implementation of the classification.

### Publisher integration
- `test_failed_processing_publishes_full_payload` — monkeypatch the publisher; on failure, assert the published status update's details contain all four keys with correct values.

## Level 2 — Cross-service contract test

Location: `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new file; `tests/integration/` exists alongside `test_api_contracts.py` and its `conftest.py`).
This is the only test that spans the seam; it is the Definition's mandated contract test and the primary drift guard.

### Setup / hermeticity
- Import **both services' real code**: worker payload-construction path (`process_document` and/or the extracted payload builder) and rag-api's `run_transactional_update`. Path setup plus the stubbing patterns already established in each service's `tests/conftest.py` (both stub `google.cloud.*`/`firebase_admin` without credentials).
- Firestore: prefer the emulator when `FIRESTORE_EMULATOR_HOST` is set (both services support it); otherwise in-memory fakes. Default in CI is the fakes path if the job provides no emulator. No real GCP, no network.
- Pub/Sub: fakes only. The worker publishes into a fake publisher; the captured details dict is handed programmatically to rag-api's failed branch. **That hand-off is the contract.**

### Scenarios
1. **Early-stage transient failure** — `process_document` raises at the first pipeline step (monkeypatched boundary); exception classifies transient. Assert persisted main doc: `error == payload["error_message"]`, `error_stage == payload["stage"]`, `retryable == payload["retryable"]` (True); `error != "Processing failed"`; `error_stage is not None`. Assert `processing/summary` subdoc: `message == payload["error_message"]`, `stage == payload["stage"]`, `error_code == "UNKNOWN"`.
2. **Late-stage permanent failure** — raises at a late step (embeddings stage); classifies permanent. Same persistence assertions; `retryable` False persisted.
3. **Unclassified-unknown exception** — generic `Exception`; assert persisted `retryable` False (pins the deliberate change).
4. **Drift guard — worker key set** — `set(payload.keys()) == {"error", "error_message", "stage", "retryable"}`; any added/removed/renamed key fails the build.
5. **Drift guard — rag-api read keys (AST-based)** — parse `rag-api-service/main.py` (pattern per `test_api_contracts.py`); assert the keys the failed branch reads from `details` are exactly `{error_message, stage, retryable}`. The guard **must fail loudly** if it cannot locate `run_transactional_update`'s failed branch — a silently-empty scan is a false pass and is itself a test failure.

### Assertion rule (what makes this a real contract test)
Persisted-value assertions compare against the payload the worker **actually produced** (captured from the fake publisher), never against literals restated in the test. Literal key-set assertions are permitted only as the explicit drift guards (scenarios 4–5), where the literal *is* the pinned contract.

## Level 3 — Regression suites (must stay green)

- `apps/ai-server/rag-worker-service` full suite (unit + integration) — no behavior change outside the failure path.
- `apps/ai-server/rag-api-service` full suite — rag-api production code is unchanged; confirms no existing test depended on the worker's old payload shape. If one does, it is updated in Phase 2 with a note in the PR (the worker's old shape was itself the bug).
- `apps/ai-server/tests/integration/` full shared suite, including the existing `test_api_contracts.py` — unaffected by the change.
- `./dev/run ai-server` as the pre-PR gate (requires Docker Compose up).

## CI wiring

No new workflow config. The shared integration suite already runs in the ai-server test pipeline (unit → integration → cross-service + contract); the new contract test rides the existing job. If the CI job provides no Firestore emulator, the fakes path is the default; the emulator path is opt-in via `FIRESTORE_EMULATOR_HOST`.

## Acceptance criteria ↔ test mapping (Definition acceptance)

| Definition acceptance criterion | Covered by |
|---|---|
| 1. Worker failure payload carries `error_message`/`stage`/`retryable`, none relying on rag-api fallbacks | Level 1 payload-construction + stage-tracking + retryable tests; Level 2 scenario 4 |
| 2. Persisted `error` = actual message, `error_stage` = failing stage, `retryable` = derived value | Level 2 scenarios 1–3 |
| 3. `processing/summary` subdocument carries same message and stage | Level 2 scenarios 1–2 subdoc assertions |
| 4. Contract test exists and passes; fails on key drift on either side | Level 2 (whole file), especially scenarios 4–5 |

## Explicitly not tested (out of scope per the plan)

- Real Pub/Sub delivery semantics and ACK/NACK behavior — unchanged; only payload reporting changes.
- `classify_error`'s internal heuristics — already covered by existing worker tests; this plan only pins the payload mapping on top of it.
- Stale-lease sweep (`_fail_if_still_stale`) behavior — unchanged non-goal.
- Frontend/mobile rendering of `error`/`error_stage` — `ResourceResponse` already exposes them.
- Firestore security rules and indexes.

## Known limitations

- Representative-stage coverage only (early + late), not every pipeline step — the agreed mitigation for tracker drift; the update-before-await convention is documented in the plan.
- The rag-api AST drift guard is anchored to the failed branch of `run_transactional_update`; if that code moves to another module, the guard's target must be updated — and the guard's fail-loudly requirement ensures the move is noticed, not silently skipped.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>