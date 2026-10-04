<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

Objective: `wi-define-108-a8` (definition artifact `definition:obj-108`, sha256 `71f1c39c…`). Intent: align the rag-worker's failure status payload with rag-api's failed-branch contract so failed RAG jobs persist the real error message, failing stage, and a deliberately derived `retryable` — locked in by a contract test on the worker→rag-api failure path.

## 1. Problem (verified)

- **Worker side** (`apps/ai-server/rag-worker-service/main.py`): `process_document`'s exception handler publishes failed status with details `{"error": str(e)}` via `_publish_status_update` (F3). There is no stage tracking (F9), and no retryable derivation.
- **API side** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch — verified in source):
  - `main_update["error"] = details.get("error_message", "Processing failed")`
  - `main_update["error_stage"] = details.get("stage")`
  - `main_update["retryable"] = details.get("retryable", True)`
  - Summary subdocument (`processing/summary`, `merge=True`): `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`, plus `stage: details.get("stage", "unknown")` and `progress: details.get("progress", 0)`.
- **Result** (F5): every worker-originated failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (silent default), and the summary error subdocument inherits the same fallbacks with `error_code="UNKNOWN"`.
- **Established schema** (F6): `error` / `error_stage` / `retryable` are already written directly by the worker's stale-lease sweep (`_fail_if_still_stale`) and rag-api's enqueue-failure paths, and exposed by `Resource` (`apps/ai-server/rag-api-service/models/resource.py` — verified: `error: Optional[str]`, `error_stage: Optional[str]`, `retryable: bool = True`) and `ResourceResponse`. The worker's status publisher is the only writer that doesn't speak this schema.

## 2. Direction

The worker aligns to the API's existing contract (`error_message` / `stage` / `retryable`). rag-api's reads and persisted schema are **not** changed (constraint: must). No Firestore migration, rename, or backfill (constraint: must_not). The stale-lease sweep is untouched (non-goal).

## 3. Design

### 3.1 New leaf module: `apps/ai-server/rag-worker-service/failure_payload.py`

Stdlib-only (no heavy imports) so both the worker and the integration contract test can import it directly:

- `UNKNOWN_STAGE = "processing"` — safe stage value when the stage is genuinely unknown (same value the stale-lease sweep uses, so `error_stage` never regresses to null).
- `build_failure_details(error_message: str, stage: str, retryable: bool) -> dict`
  Returns exactly:
  ```python
  {
      "error": error_message,        # legacy key retained (constraint: prefer) for
                                     # unknown consumers of the status topic (F11)
      "error_message": error_message,
      "stage": stage,
      "retryable": bool(retryable),
  }
  ```
- Optional module constant `FAILURE_PAYLOAD_KEYS = {"error", "error_message", "stage", "retryable"}` for the drift guard to import.

Single source of truth for the payload shape: the exception handler calls it; the contract test imports it; nothing restates the key set in a fixture.

### 3.2 Stage tracking in `process_document` (`rag-worker-service/main.py`)

- Initialize `current_stage = UNKNOWN_STAGE` (`"processing"`) at function entry.
- Set the tracker **immediately before each pipeline step's await**, reusing the existing progress-stage vocabulary (F9). Mapping (pin this table in code as a comment):

  | Pipeline phase (code order)      | Tracker value           |
  |----------------------------------|-------------------------|
  | Function entry / initial work    | `starting`              |
  | Text extraction                  | `text_retrieved`        |
  | Content tagging                  | `tagging_complete`      |
  | Summary generation               | `summary_generated`     |
  | Chunking                         | `chunking_complete`     |
  | Embeddings                       | `embeddings_complete`   |
  | (tracker unset / truly unknown)  | `processing`            |

  Semantics: the value names the phase during which the failure occurred, using the same label clients already see on the progress timeline. A failure during text extraction reports `text_retrieved`.
- Convention: "set the tracker immediately before the await." A future pipeline step added without updating the tracker reports the stale previous stage — accepted risk, mitigated by representative-stage contract coverage (see test plan), not by ossifying every step.

### 3.3 Failure payload in the exception handler

Replace the current `{"error": str(e)}` publication with:

```python
retryable = derive_retryable_from_exception(e)   # see 3.4
details = build_failure_details(str(e), current_stage, retryable)
# publish via the existing _publish_status_update path (unchanged mechanics)
```

- The payload **always** carries `error_message`, `stage`, `retryable` explicitly — rag-api's `details.get(...)` fallbacks must never be the operative mechanism for worker failures (constraint: must).
- Legacy `error` key retained with the same value as `error_message` (F11 hedge; constraint: prefer).
- The handler's log line should include `stage` and `retryable` fields (small, optional, aids support triage).
- No structured error codes introduced; rag-api's summary `error.code` stays `"UNKNOWN"` (constraint: prefer_not honored).

### 3.4 retryable derivation — `derive_retryable_from_exception(exc) -> bool`

- New thin helper in `rag-worker-service/main.py`, placed next to `classify_error()`:
  - transient-classified → `True`; permanent-classified → `False`.
- `classify_error()` itself is **unchanged** (F7): TransientError/PermanentError plus type/status-code heuristics; unknown exceptions classify as permanent (conservative default).
- The helper exists so `run_worker`'s ACK/NACK decision and the failure payload's `retryable` share **one** mapping — they cannot drift.
- **Deliberate behavior change** (per F8, accepted): unclassified-unknown exceptions previously persisted `retryable=True` via rag-api's silent default; they now persist `retryable=False`, matching the worker's actual ACK (no redelivery) behavior. Manual reprocess via `POST /process` remains available. The stale-lease sweep's separate `retryable=true` write stays correct and untouched (a dead worker is transient by nature).
- Implementation note: `classify_error`'s exact return shape was not re-verified in this pass (worker `main.py` read was not retained in detail). Step 1 of implementation confirms the shape; the helper maps whatever designation `run_worker` already consumes (transient→True / permanent→False) without duplicating heuristic logic.

### 3.5 rag-api service

**Zero production-code changes.** The failed branch already reads exactly `error_message` / `stage` / `retryable` and persists them unchanged into `error` / `error_stage` / `retryable` and the summary error subdocument (verified in source). The contract test is the locking mechanism.

## 4. Files changed

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/failure_payload.py` | **New.** Stage constant + `build_failure_details` (§3.1) |
| `apps/ai-server/rag-worker-service/main.py` | Stage tracker in `process_document`; exception handler publishes via `build_failure_details`; new `derive_retryable_from_exception` (§3.2–3.4) |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | **New.** Builder + stage-tracking + retryable-derivation unit tests |
| `apps/ai-server/tests/integration/test_rag_failure_contract.py` | **New.** AST drift guard + worker→rag-api persistence contract test (new file, same dir/patterns as `test_api_contracts.py`) |
| `apps/ai-server/tests/integration/conftest.py` | Possibly adjusted (see Step 1) |

Not changed: `rag-api-service/main.py`, `rag-api-service/models/resource.py`, worker retry/ACK mechanics, `_fail_if_still_stale`, frontend/mobile.

## 5. Implementation steps

1. **Verify two unknowns before coding** (honest gaps from investigation):
   a. Read `apps/ai-server/tests/integration/conftest.py` (existence verified; contents not). Confirm whether it stubs `google.cloud.firestore` wholesale (the rag-api service conftest does) — if so, scope the stubs so the contract test can construct a **real** Firestore client against the emulator, or gate the persistence tests onto the fake path in that environment.
   b. Confirm `classify_error`'s return shape in worker `main.py` and implement `derive_retryable_from_exception` against it (§3.4).
2. Add `failure_payload.py` + builder unit tests.
3. Modify worker `main.py`: tracker (§3.2), handler payload (§3.3), derivation helper (§3.4). Add/extend worker unit tests.
4. Add `tests/integration/test_rag_failure_contract.py` (AST drift guard + emulator/fake persistence tests; full case list in `docs/test-plan.md`).
5. Run all suites (commands in test plan); wire the new integration module into the existing integration-test invocation path (how `test_api_contracts.py` is triggered in CI was not verified — follow the existing job's pattern; flag if the new module needs explicit addition).
6. Optional cleanup note for later (out of scope): if an audit confirms rag-api's status subscriber is the only consumer, drop the legacy `error` key.

## 6. Risks & tradeoffs

- **Unknown consumers of the status topic** reading the old key set → mitigated by retaining `error`; residual risk accepted low (F11).
- **Stage-tracker drift** as the pipeline evolves → update-before-await convention + representative-stage (early/late) contract coverage.
- **`retryable=false` for unclassified-unknown errors** reduces auto-retry affordances for genuinely-transient-but-unrecognized failures → accepted per F8; widening `classify_error` is out of scope; manual reprocess via `POST /process` unaffected.
- **Contract test ossifies the payload** → intentional; that is the drift guard. Adding a key later means touching the test.
- **Integration conftest stubbing may block a real Firestore client** → resolved in Step 1a; fake-path fallback keeps the test runnable hermetically either way.

## 7. Non-goals / deferred

- Stale-lease sweep behavior; retry/backoff mechanics (ACK/NACK policy, leases, heartbeats) — only the *reporting* of retryability changes.
- Structured error codes / failure taxonomy (summary `error.code` stays `"UNKNOWN"` unless a code is actually sent).
- Frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`).
- Companion D3 issue (content unavailable in this context) and reconciling with the D4 deviation note in `plans/upload-flow.md` (file not present in tree) — deferred per F12.

## 8. Acceptance mapping

| Acceptance (from Definition) | Covered by |
|---|---|
| A1: worker failure payload carries `error_message`/`stage`/`retryable`, none relying on API fallbacks | Worker unit tests (payload shape, per-stage, per-classification) + AST worker key-set drift guard |
| A2: persisted doc has real `error`, non-null `error_stage`, worker-derived `retryable` | Emulator/fake persistence contract tests (main-document assertions) |
| A3: summary error subdocument carries same message and stage | Persistence contract tests (summary assertions) |
| A4: contract test exists, passes, fails on key drift on either side | `test_rag_failure_contract.py` in full (drift guard + persistence path) |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — rag-worker → rag-api failure payload contract

Scope: verify and lock the worker failure → rag-api persistence path per `wi-define-108-a8`. Two new test surfaces: worker unit tests and an integration contract test with an AST drift guard. Existing suites must stay green.

## 1. Environments & setup

- **Worker unit tests** run under `apps/ai-server/rag-worker-service/tests/conftest.py` (verified: stubs `google.cloud.pubsub_v1`, `firebase_admin`, openai, langchain, etc., and sets env defaults). New unit tests live in `apps/ai-server/rag-worker-service/tests/unit/` and inherit this stubbing.
- **Integration contract tests** live in `apps/ai-server/tests/integration/` alongside `test_api_contracts.py` (verified pattern: imports `main as rag_api_main` directly; AST extraction runs in a subprocess via `sys.executable -c <script> <path>`, per `_get_agent_graph_shapes`).
- **Firestore emulator mode**: rag-api supports `FIRESTORE_EMULATOR_HOST` (verified in `AppState.startup`: initializes `firebase_admin` with `options={"projectId": os.getenv("GCP_PROJECT", "demo-project")}`). Contract tests construct a real `google.cloud.firestore.Client(project="demo-project")` with `FIRESTORE_EMULATOR_HOST=localhost:8085` and `GCP_PROJECT=demo-project`.
- **Fallback (no emulator)**: a transaction-capturing fake — substitute `firestore.transactional` with a passthrough decorator and a fake transaction recording `update`/`set` calls; capture the `main_update` and `summary_update` dicts. Both paths share one assertion helper so they cannot diverge. (The Definition sanctions "emulator or fakes".)
- **Pre-implementation check (Step 1 of plan)**: `apps/ai-server/tests/integration/conftest.py` contents were not verified. If it stubs `google.cloud.firestore` globally (as `rag-api-service/tests/conftest.py` does), scope stubs so the contract test can build a real client, or route persistence tests to the fake path in that environment.
- **Importing worker code into integration tests**: the new `rag-worker-service/failure_payload.py` leaf module is stdlib-only, so the integration test imports `build_failure_details` directly with no stub preamble. Heavier worker `main.py` is only touched by AST (no import) in the integration root.

## 2. Worker unit tests — `rag-worker-service/tests/unit/test_failure_payload.py`

Mechanism: patch the pipeline dependency used by each phase to raise; capture the details dict passed to the status publisher (exact patch points resolved against `main.py` during implementation — worker source details were not retained in this pass; intent and assertions are pinned here). Where the builder is tested directly, call `build_failure_details`.

| # | Case | Asserts |
|---|---|---|
| U1 | Payload shape | Keys exactly `{error, error_message, stage, retryable}`; `payload["error"] == payload["error_message"] == str(exc)` (legacy key retained) |
| U2 | Stage per phase | Failure raised in each of the six phases → published `stage` equals the phase's vocabulary value (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`) |
| U3 | Unknown-stage fallback | Exception before the tracker is set → `stage == "processing"` (never `None`) |
| U4 | Transient → retryable true | Raise `TransientError` (from `rag-worker-service/exceptions.py`) → `retryable is True` |
| U5 | Permanent → retryable false | Raise `PermanentError` → `retryable is False` |
| U6 | Unclassified-unknown → retryable false | Raise generic `RuntimeError` → `classify_error`'s conservative permanent default → `retryable is False`. Documents the deliberate behavior change (previously silent `True` via API default) |
| U7 | No silent defaults | In every U2–U6 case: `error_message` equals the actual message (never `"Processing failed"`), `stage` is a non-empty string, `retryable` is a `bool` — rag-api's `details.get(...)` fallbacks are never operative |
| U8 | Derivation shares one mapping | `derive_retryable_from_exception` agrees with the classification `run_worker` uses for ACK/NACK for the same exception (guards against the two mappings drifting) |

## 3. Integration contract tests — `tests/integration/test_rag_failure_contract.py`

### 3.1 Key-set drift guard (AST, no I/O, always runs)

Subprocess AST scripts over both `main.py` files (pattern: `_get_agent_graph_shapes`). Module constants (house style: hardcoded sets like `MOBILE_RESOURCE_FIELDS`):

```python
WORKER_FAILURE_PAYLOAD_KEYS = {"error", "error_message", "stage", "retryable"}
RAG_API_FAILED_READ_KEYS    = {"error_message", "stage", "retryable"}
RAG_API_PERSISTED_TARGETS   = {"error", "error_stage", "retryable"}
SUMMARY_ERROR_KEYS          = {"code", "message", "stage"}
```

| # | Case | Asserts |
|---|---|---|
| C1 | Worker payload keys | Dict-literal keys of the worker's failure-payload construction (in `failure_payload.py` / handler) == `WORKER_FAILURE_PAYLOAD_KEYS` |
| C2 | Derivation present | The worker's failure handler references `classify_error` (call present in the handler region) — pins "derived, not defaulted"; removing the derivation fails the build |
| C3 | rag-api reads | `details.get("…")` keys within rag-api's failed branch(es) ⊇/== `RAG_API_FAILED_READ_KEYS`; assignments target `error`, `error_stage`, `retryable`; summary error dict keys == `SUMMARY_ERROR_KEYS` |

Any key added/renamed/removed on either side fails these tests — the drift guard doing its job.

### 3.2 Persistence path (emulator primary, fake fallback)

Setup (emulator): seed `users/{uid}/resources/{rid}` with `status: "processing"` (required — rag-api's `ALLOWED_TRANSITIONS` permits `processing → failed`; verified), then call `run_transactional_update(db, doc_ref, "failed", details, logger, uid)` directly (it is synchronous). Read back the main document and `processing/summary`.

Shared assertion helper `_assert_failed_persistence(main_doc, summary_doc, message, stage, retryable)` — ignores timestamp sentinel fields (`SERVER_TIMESTAMP` arrives as real timestamps via the emulator, as sentinels via the fake).

| # | Case | details (via `build_failure_details`) | Asserts on persisted state |
|---|---|---|---|
| C4 | Late-stage transient failure | `("Weaviate timeout after 120s", "embeddings_complete", True)` | main: `error == message`, `error_stage == "embeddings_complete"`, `retryable is True`; summary `error.message == message`, `error.stage == "embeddings_complete"`, `error.code == "UNKNOWN"` |
| C5 | Permanent failure | `("Unsupported file layout", "text_retrieved", False)` | main `retryable is False`; rest per helper |
| C6 | Early-stage failure (representative) | message X, `stage="text_retrieved"` | `error_stage == "text_retrieved"` — pins the tracker mechanism at an early stage |
| C7 | Unknown-stage failure | `stage="processing"` | `error_stage == "processing"` (never null) |
| C8 | Values persisted unchanged | any | rag-api persists worker-provided values verbatim — no transformation, no fallback substitution |

### 3.3 Drift scenarios proven by construction

- Rename `error_message` → `error_msg` on the worker → C1 fails.
- Remove `stage` from rag-api's reads → C3 fails.
- Replace the derivation with a hardcoded `True` → C2 fails.
- Remove the stage tracker → U2/U3 and C6 fail.

## 4. Regression suites (must stay green)

- `apps/ai-server/tests/integration/test_api_contracts.py` (existing mobile/API contract tests)
- `apps/ai-server/rag-worker-service/tests/` (unit + integration)
- `apps/ai-server/rag-api-service/tests/`

## 5. Commands

```bash
# Worker unit tests
cd apps/ai-server/rag-worker-service && pytest tests/unit -q

# rag-api suite
cd apps/ai-server/rag-api-service && pytest tests -q

# Contract tests (emulator mode)
FIRESTORE_EMULATOR_HOST=localhost:8085 GCP_PROJECT=demo-project \
  pytest apps/ai-server/tests/integration/test_rag_failure_contract.py -q

# Full integration root (regression)
pytest apps/ai-server/tests/integration -q
```

CI wiring: mirror however `test_api_contracts.py` is invoked today (not verified in this pass — confirm in Step 5 of the plan; add the new module to the existing integration job if enumeration is explicit). Emulator availability in CI follows the existing hermetic-stack pattern; the fake fallback keeps the persistence tests runnable where no emulator exists.

## 6. Acceptance traceability

| Acceptance | Tests |
|---|---|
| A1 payload carries the three keys, no fallback reliance | U1–U8, C1, C2 |
| A2 persisted main doc = worker values | C4–C8 (main-document assertions) |
| A3 summary subdoc carries same message/stage | C4–C8 (summary assertions) |
| A4 contract test exists, passes, fails on drift | C1–C8 |

## 7. Unknowns to resolve at implementation time

1. `apps/ai-server/tests/integration/conftest.py` stubbing behavior (exists; contents unread) → determines emulator vs fake wiring for §3.2.
2. `classify_error` return shape in worker `main.py` → shapes `derive_retryable_from_exception` (U8).
3. Exact `_publish_status_update` signature and pipeline patch points for U2 → resolved against `main.py` during Step 3.
4. CI invocation path for `apps/ai-server/tests/integration/` → Step 5.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>