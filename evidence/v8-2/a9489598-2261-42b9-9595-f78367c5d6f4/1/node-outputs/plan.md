Investigation complete — producing the contracted artifacts from verified evidence (worker handler and progress-stage publishes, worker emulator branches, `models/resource.py` failure fields, shared integration conftest, CI workflow and change-detector wiring), with the authoritative Definition supplying the remaining repository claims; unverified details are flagged as open items rather than invented.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (Definition artifact `definition:obj-108`, sha256 `71f1c39c…cac5`)
Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

## Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job
persists the worker's actual error message, the failing pipeline stage, and a deliberately derived `retryable` flag —
locked in by a contract test on the worker→rag-api failure path.

## Problem (verified)

- The worker's `process_document` exception handler (`apps/ai-server/rag-worker-service/main.py`) publishes the failed
  status with a one-key payload: `{"error": str(e)}`.
- rag-api's failed branch (`run_transactional_update`, `apps/ai-server/rag-api-service/main.py`) reads
  `error_message`, `stage`, and `retryable` from the payload details and persists `error` / `error_stage` /
  `retryable` on the main resource document, plus message/stage (with `error_code` defaulting to `"UNKNOWN"`) into
  the `processing/summary` error subdocument (Definition F4).
- Because of the key mismatch, every worker-originated failure currently persists `error` as the fallback
  `"Processing failed"`, `error_stage` as `None`, and `retryable` as the silent default `True` (Definition F5).
- The persisted schema `error` / `error_stage` / `retryable` is already used consistently by the worker's stale-lease
  sweep, rag-api's enqueue-failure paths, `ResourceResponse`, and the `Resource` model
  (`apps/ai-server/rag-api-service/models/resource.py` — fields verified: `error: Optional[str]`,
  `error_stage: Optional[str]`, `retryable: bool = True`). The worker's status publisher is the only writer that
  does not speak this contract.
- The worker already publishes a progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`,
  `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`) in its processing status updates, but
  the failure handler has no stage tracking, so the failing stage cannot be reported today (Definition F9).

## Direction

The worker aligns to rag-api's existing contract — publish `error_message` / `stage` / `retryable` — rather than
changing rag-api's reads or persisted schema. The persisted field names are consistent across three other write
paths and two response models; changing the API side would ripple (and would require a migration/backfill, which is
forbidden). The worker is the odd one out; fix the odd one out. No Firestore migration, field rename, or backfill.

## Non-goals (binding, from the Definition)

- Changing the stale-lease sweep's direct failure write (already contract-consistent).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the
  *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error `code` remains
  `"UNKNOWN"` unless a code is actually sent.
- Widening `classify_error`'s heuristics.
- Anything the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context;
  deferred), and reconciling with the D4 deviation note in `plans/upload-flow.md` (file not present in the current
  tree).

## Constraints (binding, from the Definition)

1. **must** — align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change
   rag-api's reads or persisted schema.
2. **must_not** — no Firestore migration, field rename, or backfill; persisted fields keep their names/semantics.
3. **must** — every worker-originated failure payload carries `retryable` explicitly (deliberately derived);
   rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
4. **prefer** — retain the legacy `error` key in the worker's failure payload alongside `error_message`
   (continuity for unknown consumers of the status topic and log tooling; Definition F11).
5. **prefer_not** — no structured error-code taxonomy in this fix.

## Design

### D1 — Worker failure-payload builder: new dependency-light module

New file `apps/ai-server/rag-worker-service/status_payload.py` (final name/placement confirmable at implementation;
alternative home: the existing `exceptions.py`):

- `FAILURE_STAGE_UNKNOWN = "processing"` — the safe stage value.
- The stage vocabulary tuple (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`,
  `chunking_complete`, `embeddings_complete`) for reuse by tests and the tracker.
- `build_failure_payload(error_message: str, stage: str, retryable: bool) -> dict` returning exactly:
  `{"error_message": <msg>, "stage": <stage>, "retryable": <bool>, "error": <msg>}` — the legacy `error` key is
  retained with the same value per constraint 4 / F11. No other keys (constraint 5: no error-code taxonomy).

**Why a separate light module:** the shared contract test runs in the CI `cross-service-and-contract-tests` job,
which installs only `rag-api-service` and `agent-graph-service` requirements (verified in
`.github/workflows/backend-tests.yml`). Worker `main.py` imports its full dependency set at module import (verified:
the workflow's own incident notes state worker unit tests import `main` and fail at collection when it cannot
import; marker/pypdf imports are lazy inside functions, but other top-level imports are worker-requirements-only).
The contract test therefore must not import worker `main.py`. A pure, import-free builder module keeps the contract
test hermetic — and the cross-job environment itself enforces the module's lightness: any heavy import added to it
fails the suite at collection in CI.

**Contingency:** if implementation shows worker `main.py` imports cleanly under the shared conftest's mock list with
only trivial additions, driving the handler directly in the contract test is an acceptable alternative; the builder
module remains the primary design.

### D2 — Stage tracking in `process_document`

Add a local `current_stage` tracker, initialized to `"processing"`, and assign it immediately before each pipeline
step's await, using the existing progress-vocabulary name that step works toward:

| Pipeline step | Tracker assignment (immediately before the step's await) | Progress update on completion |
|---|---|---|
| pre-pipeline window (validation/claim, before the first transition) | — (tracker retains init value) | — |
| start of tracked region | `current_stage = "starting"` | `{"stage": "starting", …}` |
| text extraction / retrieval | `current_stage = "text_retrieved"` | `{"stage": "text_retrieved", …}` |
| content tagging | `current_stage = "tagging_complete"` | `{"stage": "tagging_complete", …}` |
| summary generation | `current_stage = "summary_generated"` | `{"stage": "summary_generated", …}` |
| chunking | `current_stage = "chunking_complete"` | `{"stage": "chunking_complete", …}` |
| embeddings | `current_stage = "embeddings_complete"` | `{"stage": "embeddings_complete", …}` |
| post-embedding steps (old-vector deletion, vector storage, metadata save) | no new assignment — tracker keeps `"embeddings_complete"` | success path continues to `completed` |

Semantics: `stage` reports the pipeline step in progress at failure time, identified by its progress-vocabulary
name — deliberately no new stage names are introduced (constraint 5 and the Definition's vocabulary requirement), so
a failure stage reads naturally next to the progress timeline clients already see. `"processing"` survives only for
failures before the first assignment ("genuinely unknown"), matching the stale-lease sweep's `error_stage` value so
the field never regresses to null.

**Drift-prevention convention (commented in code):** "set `current_stage` immediately before the await it
describes." A future pipeline step added without updating the tracker reports a stale stage; the contract test pins
the mechanism on representative early/late stages, which catches the tracker being removed or bypassed without
ossifying every step. Exact insertion points are confirmed against the full `process_document` body at
implementation start (Open item 3 — steps 3–6 and the handler were verified directly; earlier steps come from
Definition F9).

### D3 — `retryable` derivation: derive, don't default

In the exception handler, derive retryability from the existing `classify_error(e)` (Definition F7 — the same
classification that drives ACK/NACK in `run_worker`; `classify_error` itself is **not** modified):

| `classify_error(e)` classification | `retryable` persisted |
|---|---|
| transient | `True` (Pub/Sub will redeliver) |
| permanent | `False` (acked; manual reprocess via `POST /process` remains) |
| unclassified-unknown (conservative default) | `False` |

Deliberate behavior change: unclassified-unknown exceptions previously persisted `retryable: true` (the silent
default) and will now persist `false` — that is the conservatism `classify_error` was written for and aligns the
persisted record with the worker's actual ACK/NACK behavior (Definition F8). The stale-lease sweep's separate
`retryable=true` write stays correct and untouched (a dead worker is a transient condition by nature).

The exact comparison form adapts to `classify_error`'s return shape (Open item 2).

### D4 — Exception handler change (worker `main.py`)

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()   # unchanged (internal metrics field)
    self.logger.error("document_processing_failed", ...)            # unchanged
    retryable = ...  # derived from classify_error(e) per D3
    details = build_failure_payload(str(e), current_stage, retryable)
    await self._publish_status_update(user_id, course_id, resource_id, "failed", details, job_id)
    ...
```

`_publish_status_update` itself is unchanged; only the failed call site's details change. Progress-update call sites
are untouched. The bare `{"error": str(e)}` payload is removed.

### D5 — rag-api side: functionally unchanged

No changes to `run_transactional_update`'s reads, keys, or persisted schema (constraints 1–2). The
`details.get("retryable", True)` fallback remains in code but is no longer operative for worker failures because the
worker always sends `retryable` (constraint 3).

**Contingent seam only:** if the contract test cannot drive `run_transactional_update` with a fake db/transaction
through its existing signature (Open item 1), add a minimal optional-parameter injection that defaults to current
behavior. That changes no reads, keys, or persisted semantics — constraint-compliant — but must be recorded as a
plan deviation if it turns out to alter behavior in any way.

### D6 — Contract test placement and shared-suite wiring

- The contract test is **added to the existing `apps/ai-server/tests/integration/test_api_contracts.py`**. This is
  required, not stylistic: the `cross-service-and-contract-tests` CI job invokes an explicit pytest file list
  (`test_search_pipeline.py`, `test_chat_pipeline.py`, `test_shared_algorithms_in_sync.py`,
  `test_api_contracts.py` — verified), so a new sibling file would never execute in CI. It also matches Definition
  F10 (existing fixture- and AST-based contract-test patterns).
- Extend `apps/ai-server/tests/integration/conftest.py` to add the `rag-worker-service` directory to `sys.path`
  (the conftest currently adds only `rag-api-service` — verified — and its header explicitly documents the
  extend-the-mocks/path pattern). The builder module should need no new mocks; add to `required_mocks` only if the
  fallback in D1 is chosen.
- Do **not** place the contract test in `rag-worker-service/tests/integration/` — that directory is empty and
  `rag-worker-service` is absent from the CI integration-services matrix (both verified), so such a test would never
  run.

### D7 — Worker unit tests

New worker unit test file(s) under `apps/ai-server/rag-worker-service/tests/unit/` (e.g.
`test_failure_payload.py`) covering the builder, the handler's publication behavior, the retryable derivation, and
representative stage tracking (detailed in `docs/test-plan.md`). These run in the `python-unit-tests` CI job when
`rag-worker-service` changes (verified: worker is in `UNIT_SERVICES`).

## Files touched

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/status_payload.py` | **new** — builder + stage constants (D1) |
| `apps/ai-server/rag-worker-service/main.py` | `process_document`: stage tracker (D2) + handler payload/derivation (D3, D4) |
| `apps/ai-server/tests/integration/conftest.py` | add worker service dir to `sys.path` (D6) |
| `apps/ai-server/tests/integration/test_api_contracts.py` | new contract tests + drift guards (D6) |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | **new** — worker-side tests (D7) |
| `apps/ai-server/rag-api-service/main.py` | **contingent only** — minimal injectability seam if D5's contingency triggers; no contract change |

Explicitly **not** touched: `models/resource.py`, the stale-lease sweep, `classify_error`, `_publish_status_update`,
retry/lease/heartbeat mechanics, frontend.

## Phases

### Phase 1 — Worker: failure payload + stage tracking

Status: NOT STARTED

**Scope**

- Add `status_payload.py` (builder, `FAILURE_STAGE_UNKNOWN`, vocabulary tuple) per D1.
- `process_document`: stage tracker with update-before-await convention across all steps per D2 (insertion points
  confirmed against the full function body first).
- Exception handler: derive `retryable` from `classify_error(e)`; publish `build_failure_payload(...)` output per
  D3/D4.
- No changes to the sweep, `classify_error`, `_publish_status_update`, or the success path.

**Acceptance criteria**

- Failed publish details contain exactly the pinned key set `{error_message, stage, retryable, error}` with correct
  values; the bare `{"error": ...}` payload is gone.
- Stage tracker reports representative early and late failures correctly; `"processing"` fallback preserved.
- `retryable`: transient→`True`; permanent and unclassified-unknown→`False`.
- Success path byte-identical in behavior (progress updates untouched); worker unit suite passes.

**Validation**

- `cd apps/ai-server && python3 -m pytest rag-worker-service/tests/unit/ -v`
- Inspection/grep: no remaining bare `{"error": str(e)}` failed-publish in `main.py`.

### Phase 2 — Contract test in the shared suite

Status: NOT STARTED

**Scope**

- Confirm `run_transactional_update`'s seam (signature; how db/transaction are obtained; exact `processing/summary`
  error-subdocument write shape and field names) and record findings in the test module docstring (Open item 1).
- Extend `tests/integration/conftest.py` sys.path per D6.
- Add to `test_api_contracts.py`:
  - worker→api persistence test: build the failure payload through the worker's builder for a transient early-stage
    failure and a permanent late-stage failure; feed it through rag-api's failed branch against fakes; assert
    persisted `error == payload["error_message"]`, `error_stage == payload["stage"]`,
    `retryable == payload["retryable"]`.
  - subdocument assertion: `processing/summary` error subdocument carries the same message and stage; `error_code`
    is `"UNKNOWN"` (no code sent).
  - key-set drift guards both directions: the worker payload's key set pinned exactly; rag-api's failed-branch read
    keys pinned (`error_message`, `stage`, `retryable`) using the file's existing fixture/AST patterns.
  - passthrough assertion: a `retryable=False` payload persists `False` (guards against reintroduced defaulting);
    message and stage persist verbatim.

**Acceptance criteria**

- Tests pass hermetically (no network, no emulator required).
- Drift guards demonstrably bite: during development, temporarily rename a worker payload key, rename an api read
  key, and drop `retryable` from the payload — each mutation turns the corresponding test red; then revert.

**Validation**

- `cd apps/ai-server && python3 -m pytest tests/integration/test_api_contracts.py -v`

### Phase 3 — CI verification + wrap-up

Status: NOT STARTED

**Scope**

- Open a PR touching `rag-worker-service` and/or `apps/ai-server/tests/`; confirm the change detector triggers
  `cross-service-and-contract-tests` (verified trigger rules) and that the contract test appears in that job's log.
- Optional, non-blocking: hermetic end-to-end smoke via the `dev/` stack **only if** a worker+api journey already
  exists there (contents unverified — do not build one for this fix).
- Check whether any in-tree service documentation describes the worker failure payload and update if so
  (existence unverified; do not block on it).

**Acceptance criteria**

- `backend-summary` green on the PR; contract test visible in the cross job log.

**Validation**

- CI run on the PR.

## Acceptance criteria (Definition mapping)

| Definition acceptance criterion | Proven by |
|---|---|
| 1. Failed status payload contains `error_message` (actual message), `stage` (failing stage), `retryable` (derived) — none relying on api fallback defaults | Phase 1 unit tests (builder + handler); pinned key set in contract test |
| 2. Persisted resource doc: `error` = actual message (not `"Processing failed"`), `error_stage` = failing stage (not None), `retryable` = worker's derived value | Contract test CT-1 (Phase 2) |
| 3. `processing/summary` error subdocument carries the same message and stage | Contract test CT-2 (Phase 2) |
| 4. Contract test covers worker failure → rag-api persistence, asserts equality, fails on key drift on either side | CT-1…CT-4 + mutation verification protocol (Phase 2) |

## Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining the legacy `error` key
  (constraint 4, F11); residual risk accepted as low; dropping the duplicate later is trivial cleanup.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and
  representative-stage test coverage (early + late), not per-step ossification.
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-
  unrecognized failures — accepted per F8; widening `classify_error` is out of scope; manual reprocess via
  `POST /process` remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key later
  means touching the test, which is the point.
- **CI cross job does not install worker requirements** (verified) — mitigated by the dependency-light builder
  module (D1); the environment itself enforces the module's lightness at collection time.
- **Explicit pytest file list in the cross job** (verified) — mitigated by adding tests to the existing
  `test_api_contracts.py` rather than a new file (D6).

## Open items to confirm at implementation start (unverified — do not assume)

1. `run_transactional_update`'s exact signature and how the db/transaction are obtained; the exact field names and
   path of the `processing/summary` error subdocument write (F4 describes the behavior; exact keys come from code).
2. `classify_error`'s return shape (enum/string/bool) — the D3 comparison adapts to it.
3. The full ordered body of `process_document` — exact tracker insertion points for the early steps (steps 3–6 and
   the handler were verified directly; earlier steps rest on F9).
4. The existing fixture/AST helper conventions inside `test_api_contracts.py` — new tests follow them.
5. Contents of `rag-worker-service/tests/conftest.py` — whether handler-level unit tests need additional fixtures.
6. Whether any in-tree documentation describes the worker failure payload.

## Plan deviations

None recorded.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker→rag-api failure payload contract

WorkItem: `wi-define-108-a8` · Companion to `docs/plan.md`

## 1. Objective

Prove that a failed RAG processing job publishes a contract-complete failure payload from the worker and that
rag-api's failed branch persists the worker's values unchanged — and that the build fails if either side's payload
keys drift.

## 2. Contract under test

### 2.1 Worker failure payload (status `"failed"` details)

Pinned key set — exactly, no more, no less:

| Key | Type | Value |
|---|---|---|
| `error_message` | str | the actual exception message (`str(e)`) |
| `stage` | str | pipeline stage executing at failure time (vocabulary below); `"processing"` when genuinely unknown |
| `retryable` | bool | deliberately derived (table 2.3) — never absent, never api-defaulted |
| `error` | str | legacy key retained, equal to `error_message` (compatibility hedge, Definition F11) |

### 2.2 rag-api failed-branch persistence mapping (rag-api unchanged — regression pin)

| Payload key | Persisted target |
|---|---|
| `error_message` | main document `error` |
| `stage` | main document `error_stage` |
| `retryable` | main document `retryable` |
| `error_message`, `stage` | `processing/summary` error subdocument message/stage (exact field names confirmed at implementation — Open item 1 in the plan) |
| (no code sent) | subdocument `error_code` = `"UNKNOWN"` (existing default) |

### 2.3 `retryable` derivation (via existing `classify_error`, unchanged)

| Classification | Persisted `retryable` |
|---|---|
| transient | `True` |
| permanent | `False` |
| unclassified-unknown (conservative default) | `False` |

Known deliberate flip: previously-unknown errors persisted `True` via the api's silent default; they now persist
`False`. Manual reprocess via `POST /process` is unaffected.

### 2.4 Stage vocabulary and tracker convention

Tracker is assigned immediately before each step's await; value = the progress-vocabulary name that step works
toward:

`starting` → `text_retrieved` → `tagging_complete` → `summary_generated` → `chunking_complete` →
`embeddings_complete`; post-embedding steps keep `embeddings_complete`; init/fallback value `processing`.
(Exact early-step insertion points confirmed at implementation — plan Open item 3.)

## 3. Test inventory

### Worker unit tests — `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` (new)

Runs in CI job `python-unit-tests` (matrix service `rag-worker-service`) — verified wiring.

| ID | Level | What / How | Key assertions |
|---|---|---|---|
| WU-1 | unit | `build_failure_payload` pure function: representative message/stage/retryable combos | returns exactly `{error_message, stage, retryable, error}`; values verbatim |
| WU-2 | unit | builder legacy-key hedge | `payload["error"] == payload["error_message"]` always |
| WU-3 | unit | handler publication: monkeypatch `_publish_status_update`, force an exception at a representative early step and a representative late step | status `"failed"`; details match WU-1 shape; `stage` equals the tracker value for the step in progress; early failure before first assignment yields `"processing"`; logging call unchanged |
| WU-4 | unit | derivation through the handler: raise a transient-classified error (e.g. `TransientError` instance), a permanent-classified error, and a generic `Exception` (unknown) | payload `retryable` is `True` / `False` / `False` respectively — exercises the real `classify_error` wiring, not a restatement |
| WU-5 | unit | success-path regression: run a stubbed successful `process_document` | progress updates unchanged (`stage`/`progress` details untouched); `completed` publish intact — guards against tracker-refactor side effects |

### Contract tests — appended to `apps/ai-server/tests/integration/test_api_contracts.py`

Runs in CI job `cross-service-and-contract-tests` (explicit file list — verified). Placement in this file is
**mandatory**: a new sibling file would never execute in CI, and `rag-worker-service` is not in the integration
matrix (its `tests/integration/` is empty — verified).

| ID | Level | What / How | Key assertions |
|---|---|---|---|
| CT-1 | contract | worker→api persistence: build payload via the worker's builder (transient early-stage case + permanent late-stage case); feed through `run_transactional_update`'s failed branch against fakes | main doc `error == payload["error_message"]` (not `"Processing failed"`), `error_stage == payload["stage"]` (not None), `retryable == payload["retryable"]` |
| CT-2 | contract | subdocument mirror (same inputs as CT-1) | `processing/summary` error subdocument message and stage equal the payload; `error_code == "UNKNOWN"` |
| CT-3 | drift guard | pin the worker payload key set exactly | any added/removed/renamed worker payload key fails |
| CT-4 | drift guard | pin rag-api's failed-branch read keys (`error_message`, `stage`, `retryable`) using the file's existing fixture/AST patterns | any renamed/removed api read key fails |
| CT-5 | contract | passthrough: payload with `retryable=False` and distinctive message/stage | persisted `retryable` is `False` (api defaulting must not resurrect `True`); message/stage persist verbatim |
| CT-6 | optional | emulator-based variant | **only if** a hermetic emulator path already exists in the suite; not planned — the shared conftest mocks `firebase_admin`/`google.cloud.*` (verified), so emulator use would require conftest changes out of scope for this fix |

The contract test exercises the worker's failure-payload construction through the same builder the handler calls;
the handler→builder wiring is pinned by WU-3/WU-4, so the composed path is covered across the two levels. If
implementation shows worker `main.py` imports cleanly under the shared conftest, driving the handler directly in
CT-1 is an acceptable equivalent (record the choice in the test module docstring).

### Implementation-time seam check (not a committed test)

CT-0: before writing CT-1, confirm `run_transactional_update`'s signature and how the db/transaction are obtained;
record findings in the test module docstring. If not injectable, apply the plan's D5 contingent seam (minimal
optional parameter, default behavior unchanged) and note it as a plan deviation only if behavior changes.

## 4. Fakes design (hermeticity)

- Primary: in-memory fake capturing document writes keyed by Firestore path, shaped to what
  `run_transactional_update` needs (confirmed at CT-0). No network, no emulator, no real GCP.
- The shared conftest (`apps/ai-server/tests/integration/conftest.py`) already sets env defaults
  (`GCP_PROJECT=test-project`, fake credentials, `SHARED_INTERNAL_TOKEN`) and mocks `firebase_admin`,
  `google.cloud.*`, `pubsub_v1`, `structlog`, etc. (verified). Extend `sys.path` with the worker service dir; add
  mocks only if the D1 fallback is chosen.
- The builder module must stay free of worker-heavy imports — the cross job's dependency set (rag-api +
  agent-graph requirements only, verified) enforces this at collection time.
- No marker/torch/pypdf imports anywhere in the new tests (worker extraction internals are not under test).

## 5. Mutation verification protocol (proves the drift guard bites)

During Phase 2 development, apply each mutation temporarily and confirm the named test goes red, then revert:

1. Rename worker payload key `error_message` → expect CT-3 and CT-1 red.
2. Rename rag-api read key `stage` → expect CT-4 and CT-1 red.
3. Drop `retryable` from the worker payload → expect CT-3 red (and CT-1 red via the passthrough assertion).
4. Reintroduce api-side defaulting for `retryable` (simulate `details.get("retryable", True)` winning) → expect
   CT-5 red.

This directly discharges Definition acceptance criterion 4 ("must fail if either side's payload keys drift").

## 6. CI wiring (verified facts)

- `python-unit-tests`: runs `<service>/tests/unit/` for services in `UNIT_SERVICES`; `rag-worker-service` is
  included → WU-* run on worker changes.
- `cross-service-and-contract-tests`: runs the four named shared files including `test_api_contracts.py` → CT-*
  run there. Triggered when `apps/ai-server/tests/`, `rag-api-service`, `agent-graph-service`,
  `rag-worker-service`, or `flashcard-service` changes (or on any workflow edit) → this fix's PRs trigger it.
- `rag-worker-service` is **not** in `INTEGRATION_SERVICES` and its `tests/integration/` is empty → never place the
  contract test there.
- `backend-summary` aggregates all test jobs as the branch-protection gate.

## 7. Out of scope for testing

- ACK/NACK mechanics, retry/backoff, leases, heartbeats (only retryability *reporting* changes).
- Stale-lease sweep behavior (already contract-consistent; untouched).
- Frontend exposure (`ResourceResponse` already exposes `error`/`error_stage`).
- Error-code taxonomy (`error_code` stays `"UNKNOWN"`; no taxonomy tests).
- `classify_error` heuristic coverage beyond what existing worker tests already provide (widening it is a non-goal).

## 8. Acceptance mapping (Definition)

| Definition acceptance criterion | Discharged by |
|---|---|
| 1 — payload carries `error_message`/`stage`/`retryable`, no api fallback reliance | WU-1, WU-3, WU-4; CT-3 key pin |
| 2 — persisted `error`/`error_stage`/`retryable` equal worker values | CT-1, CT-5 |
| 3 — subdocument carries same message and stage | CT-2 |
| 4 — contract test exists, passes, fails on key drift either side | CT-1…CT-4 + Section 5 mutation protocol |

## 9. Local validation commands

```bash
cd apps/ai-server
python3 -m pytest rag-worker-service/tests/unit/ -v          # WU-*
python3 -m pytest tests/integration/test_api_contracts.py -v # CT-*
```

Both are the exact invocations CI uses (verified), so green locally implies green in the corresponding jobs.

## 10. Unknowns to resolve before/at test implementation

1. `run_transactional_update` signature/seam and the exact `processing/summary` error-subdocument field names
   (behavior per Definition F4; exact keys from code) — resolves CT-0.
2. `classify_error` return shape — WU-4's comparison form adapts.
3. Full ordered `process_document` body — fixes WU-3's early/late step choices and the tracker insertion points.
4. Existing fixture/AST helper conventions in `test_api_contracts.py` — CT-3/CT-4 follow them.
5. `rag-worker-service/tests/conftest.py` contents — whether WU-3/WU-4 need new fixtures/mocks.
6. Whether a hermetic emulator path already exists in the shared suite (decides CT-6; default: omitted).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>