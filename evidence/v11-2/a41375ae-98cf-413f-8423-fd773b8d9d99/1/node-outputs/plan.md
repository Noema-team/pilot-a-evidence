<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

- Run: `a41375ae-98cf-413f-8423-fd773b8d9d99`
- Iteration: 1
- Intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- Authoritative spec: WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This plan implements exactly that scope; nothing wider, nothing narrower.

## 1. Problem (verified)

`apps/ai-server/rag-worker-service/main.py`'s `process_document` exception handler publishes a failed status whose `details` contain only `{"error": str(e)}` (Definition F3). `apps/ai-server/rag-api-service/main.py`'s `run_transactional_update` failed branch reads three different keys and persists:

```python
main_update["error"]      = details.get("error_message", "Processing failed")
main_update["error_stage"] = details.get("stage")
main_update["retryable"]  = details.get("retryable", True)
```

and writes into `processing/summary`:

```python
"error": {"code": details.get("error_code", "UNKNOWN"),
          "message": details.get("error_message", "Processing failed"),
          "stage": details.get("stage")}
```

Both verified verbatim in the current tree. Because the worker never sends `error_message`/`stage`/`retryable`, every worker-originated failure persists the fallback string `"Processing failed"`, `error_stage = None`, and a fabricated `retryable = True` (F5). Three other write paths already speak the persisted schema — the worker's stale-lease sweep, rag-api's `/process` and `POST /resources` enqueue-failure paths (both write `error`/`error_stage` directly, verified) — and `Resource` (`models/resource.py`, `error`/`error_stage`/`retryable: bool = True`, verified) plus `ResourceResponse` expose them. The worker's status publisher is the only writer that does not speak the contract.

## 2. The contract being implemented

Worker → `rag-status-updates` topic, `status = "failed"` message, `details` dict:

| key | value | notes |
|---|---|---|
| `error_message` | `str(e)` — actual exception message | required, consumed by rag-api |
| `stage` | pipeline stage executing at failure time | required, consumed by rag-api |
| `retryable` | `True` iff `classify_error(e)` classifies transient; `False` iff permanent (incl. unclassified-unknown) | required, deliberately derived — never a silent default |
| `error` | `str(e)` — legacy key, identical string | retained as compatibility hedge (constraint: prefer) |

rag-api's failed branch (unchanged) persists: main doc `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`; `processing/summary` error subdocument `{code: "UNKNOWN" (default), message ← error_message, stage ← stage}`.

Stage vocabulary (existing progress-update names, F9): `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, plus `"processing"` as the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.

## 3. Design decisions

### 3.1 Worker-only change; rag-api source untouched (constraint: must)
The fix aligns the worker's payload keys to `error_message`/`stage`/`retryable`. rag-api's reads, persisted field names (`error`, `error_stage`, `retryable`), and semantics stay exactly as they are. **No file under `rag-api-service/` is modified.** No Firestore migration, rename, or backfill (constraint: must_not). The API-side `details.get(...)` fallbacks remain in place for non-worker writers; after this fix they are simply never operative for worker failures (constraint: must).

### 3.2 Stage tracking in `process_document`
`process_document` is one large try block, so at failure time nothing knows where it was. Fix: a local stage tracker.

- Initialize `current_stage = "processing"` at the top of `process_document`.
- Immediately before each pipeline step's `await`, set `current_stage` to that step's named stage from the vocabulary in §2.
- The exception handler reports `current_stage` as `stage`.
- Convention (documented with a comment in the code): **set the tracker immediately before the await**. A future pipeline step added without updating the tracker reports a stale stage; the contract test pins the mechanism on representative early/late stages, which catches the tracker being removed or bypassed without ossifying every step.
- The exact number/order of await points in `process_document` is confirmed at implementation start (Step 0); the stage *names* are pinned by F9 and must not be renamed.

### 3.3 `retryable`: derive from `classify_error`, never default (constraints: must)
The worker already classifies every exception via `classify_error()` (F7: `TransientError`/`PermanentError` plus type- and status-code heuristics; unknown exceptions classify as permanent) and that classification drives ACK/NACK in `run_worker`. The failure payload derives `retryable` from the same function:

- transient-classified → `retryable: true` (Pub/Sub will redeliver)
- permanent-classified, including unclassified-unknown → `retryable: false` (acked; manual reprocess via `POST /process` remains)

Explicit notes:
- **Deliberate behavior change:** unclassified-unknown exceptions currently persist `retryable: true` (silent default) but classify as permanent → they will now persist `false`. This is `classify_error`'s conservatism working as designed; accepted per the Definition (F8 rationale).
- **Do not** read `PDFProcessingError.retryable` (the metadata attribute on the exception class in `rag-worker-service/exceptions.py`) to populate the payload. The binding requirement is `classify_error`-based derivation aligned with ACK/NACK behavior; the exception attribute is retryability *metadata* written by raisers and is not the ACK/NACK decision.
- Do not touch ACK/NACK policy, leases, heartbeats, or backoff — only the *reporting* changes (non-goal).
- The stale-lease sweep's separate direct write (`retryable=true`, `error_stage="processing"`) is untouched — a dead worker is transient by nature (F8, non-goal).

Implementation note: `classify_error`'s exact return shape (string label vs bool vs enum) is confirmed in Step 0; the mapping is then a one-line explicit comparison (e.g. `retryable = classify_error(e) == <transient-sentinel>`). The semantic requirement is fixed regardless of the return shape.

### 3.4 Extract a pure failure-payload builder
The exception handler currently inlines the payload construction. Extract a module-level pure function in `rag-worker-service/main.py`:

```
build_failure_details(exc, stage) -> dict
  returns {"error": str(exc), "error_message": str(exc),
           "stage": stage, "retryable": <derived from classify_error(exc)>}
```

Rationale: the contract test must exercise "the worker's failure-payload construction" without running the whole pipeline against real dependencies; a pure builder makes that a direct call, and the handler calling it is proven by a worker-local wiring test (test plan §Layer 2). The handler uses this builder and nothing else to assemble `details`.

### 3.5 Legacy `error` key retained (constraint: prefer)
Only rag-api's status subscriber is a verified consumer of these payloads; the topic is shared. The builder emits `error` alongside `error_message` (one redundant string) so any unknown consumer keeps working. Dropping it later is trivial cleanup after a consumer audit — out of scope here.

### 3.6 No structured error-code taxonomy (constraint: prefer_not honored)
The summary error subdocument's `code` stays `"UNKNOWN"` unless a code is actually sent; the worker sends none. No taxonomy introduced.

## 4. Change inventory

| File | Action | Content |
|---|---|---|
| `apps/ai-server/rag-worker-service/main.py` | modify | stage tracker in `process_document`; new `build_failure_details(exc, stage)`; exception handler builds details via the builder (adds `error_message`, `stage`, `retryable`, keeps legacy `error`) |
| `apps/ai-server/tests/fixtures/api-contracts/worker_failure_status.json` | new | fixture pinning the worker→rag-api failure contract (schema in test plan §4) |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | new | cross-service contract test + drift guards (test plan §Layer 1) |
| `apps/ai-server/tests/integration/conftest.py` | possibly extend | only if the scoped stubbing in the test file proves insufficient; see test plan §3 for why the default is *not* to touch it |
| `apps/ai-server/rag-worker-service/tests/integration/test_failure_payload_wiring.py` | new | worker-local wiring test proving the handler uses the builder with the live tracker (test plan §Layer 2) |
| `apps/ai-server/rag-api-service/**` | **no change** | explicit zero-change; contract already satisfied once keys align |

## 5. Implementation steps

### Step 0 — Discovery/verification (worker internals)
Worker `main.py` internals to confirm before editing (they were not fully re-verifiable this session; all are single-file reads):
1. `classify_error()` signature and return shape (F7 pins semantics, not the API).
2. `_publish_status_update()` exact signature (how `details` is passed; F3 pins the call site).
3. The full ordered list of pipeline steps/awaits in `process_document` and which vocabulary stage each maps to (names pinned by F9; mapping points located here).
4. How the worker's own tests import `main` (module style, intra-service imports like `exceptions`) — needed for cross-suite import mechanics in the contract test.

No code changes in this step.

### Step 1 — Stage tracker (`rag-worker-service/main.py`)
- Add `current_stage = "processing"` local at the top of `process_document`.
- Insert `current_stage = "<stage>"` immediately before each pipeline `await`, using the §2 vocabulary (progress-update names, F9). Every stage in the vocabulary that has a corresponding await point in the function gets a tracker assignment; comment the set-before-await convention at the first assignment.

### Step 2 — Failure payload (`rag-worker-service/main.py`)
- Add module-level `build_failure_details(exc, stage)` per §3.4, deriving `retryable` via `classify_error` (§3.3), emitting the four keys of §2.
- In `process_document`'s exception handler, replace the inline `{"error": str(e)}` details with `build_failure_details(e, current_stage)`. Keep the message envelope (`user_id`, `course_id`, `resource_id`, `status="failed"`) and the `_publish_status_update` call path unchanged.

### Step 3 — rag-api: verify zero-diff
Confirm `git diff` is empty under `rag-api-service/`. The failed branch already persists `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`, and the summary subdocument carries the same message/stage (verified verbatim in §1). Requirement 3 ("persist the worker-provided values unchanged") is met by construction.

### Step 4 — Contract fixture
Create `apps/ai-server/tests/fixtures/api-contracts/worker_failure_status.json` pinning: published `details` key set (`error_message`, `stage`, `retryable` required; `error` retained), the persisted-field mapping (`error`←`error_message`, `error_stage`←`stage`, `retryable`←`retryable`), summary error mapping (`code`←`error_code` default `"UNKNOWN"`, `message`←`error_message`, `stage`←`stage`), the API-side fallback values (`"Processing failed"`, `retryable=true`, `"UNKNOWN"`, stage null/`"unknown"`) — so the test can assert worker values *beat* every fallback — and the stage vocabulary. Schema detail and the note that this fixture must **not** be appended to `TestContractFixturesIntegrity`'s enumerated list (that list's metadata schema requires `mobile_file`, which does not apply) are in the test plan.

### Step 5 — Cross-service contract test
New `apps/ai-server/tests/integration/test_worker_failure_contract.py` per test plan §Layer 1: loads both services' `main` modules under unique names via `importlib` with scoped dependency stubs, builds the failure payload through the worker's real `build_failure_details` + `classify_error`, feeds it through rag-api's real `run_transactional_update` against an in-memory fake Firestore transaction, and asserts persisted `error`/`error_stage`/`retryable` equal the worker's values. Includes behavioral and static (AST) key-drift guards.

### Step 6 — Worker-local wiring test
New `apps/ai-server/rag-worker-service/tests/integration/test_failure_payload_wiring.py`: forces `process_document` to raise at a representative early stage and a representative late stage, captures the published status payload, asserts envelope keys, exact details keys/values, tracker-reported stage, and `retryable == classify_error` derivation. Runs inside the worker's existing hermetic pytest environment (`rag-worker-service/pytest.ini`, `tests/conftest.py` stubs — both verified present).

### Step 7 — Full suite runs
- Worker suite: `python -m pytest` from `apps/ai-server/rag-worker-service/` (`pytest.ini` sets `testpaths = tests`, `asyncio_mode = auto` — verified).
- Shared integration suite: run the existing `apps/ai-server/tests/integration` suite (invocation per repo docs — `docs/TESTING-STRATEGY.md` exists; its specifics were not verifiable this session, so follow the established command). All pre-existing tests must remain green; no pre-existing test asserts the old single-key worker payload (the shared suite tests model shapes and other services' contracts — verified by reading `test_api_contracts.py` in full).
- Re-check Step 3 zero-diff.

## 6. Acceptance criteria mapping

| AC (Definition) | How it is met |
|---|---|
| 1. Worker's failed-status message contains `error_message` (actual message), `stage` (failing stage), `retryable` (deliberately derived); no reliance on rag-api fallbacks | Steps 1–2; asserted by contract test (worker payload key set + values) and wiring test |
| 2. Persisted doc: `error` = actual message (not `"Processing failed"`), `error_stage` = failing stage (not None), `retryable` = worker's derived value | Step 3 (zero-diff, existing branch does this once keys align); asserted by contract test against fake Firestore |
| 3. `processing/summary` error subdocument carries same message and stage as main doc | Same branch, same details; asserted by contract test (summary assertions) |
| 4. Contract test covering worker failure → rag-api persistence exists and passes; fails if either side's keys drift | Step 5 (behavioral equality + AST key-set guards vs fixture + fallback-beaten assertions) |

## 7. Risks and mitigations

- **Unknown consumers of the status topic** reading the old key set → mitigated by retaining legacy `error` (§3.5); residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves → set-before-await convention commented in code; contract test pins representative early/late stages.
- **`retryable=false` for unclassified errors** reduces auto-retry affordances for unrecognized-but-genuinely-transient failures → accepted per Definition; widening `classify_error` is out of scope; manual reprocess via `POST /process` unaffected (verified endpoint exists and always allows re-enqueue of failed resources via `failed → queued` transition).
- **Contract test ossifies the payload** → intentional; that is the drift guard. Adding a key later means touching the fixture and test.
- **Shared conftest regressions** → default plan does not modify `tests/integration/conftest.py`; stubbing is scoped inside the new test file (test plan §3). Conftest extension is a fallback only.
- **Cross-suite import collisions** (two modules named `main`) → resolved with `importlib.util.spec_from_file_location` under unique module names (test plan §3); worker intra-service import style confirmed in Step 0.

## 8. Explicitly out of scope (per Definition non-goals)

- Stale-lease sweep behavior (already consistent with the contract).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, leases, heartbeats.
- Frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`; verified).
- Structured error codes / failure taxonomy; `summary.error.code` stays `"UNKNOWN"`.
- Anything the companion D3 issue covers beyond this payload alignment (content unavailable here; deferred), and reconciling with the D4 deviation note in `plans/upload-flow.md` (file not present in current tree).
- Adding `progress` to the failure payload (summary falls back to `0`; requirements do not ask for it).

## 9. Unknowns carried into implementation (to resolve in Step 0, none blocking design)

1. `classify_error` return shape (semantics pinned; API shape to read).
2. `_publish_status_update` exact parameter shape.
3. Exact await-point list in `process_document` for tracker insertion (names pinned).
4. Worker `main.py` intra-service import graph for cross-suite import mechanics.
5. Repo's canonical test invocation for the shared integration suite (docs exist; command not verifiable this session).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — rag-worker → rag-api failure payload contract

- Run: `a41375ae-98cf-413f-8423-fd773b8d9d99` · Iteration 1
- Companion to `docs/plan.md`. Implements Definition acceptance criterion 4 and provides the evidence for ACs 1–3.

## 1. Strategy overview

Three layers, all hermetic (no GCP project, no live Pub/Sub, no emulator required for the primary path):

| Layer | Location | Proves |
|---|---|---|
| 1. Cross-service contract test (**required**, AC4) | `apps/ai-server/tests/integration/test_worker_failure_contract.py` | worker's failure-payload construction → rag-api's failed-branch persistence, end to end, plus key-drift guards |
| 2. Worker-local wiring test | `apps/ai-server/rag-worker-service/tests/integration/test_failure_payload_wiring.py` | `process_document`'s exception handler actually uses the builder with the live stage tracker |
| 3. Regression | existing suites | nothing pre-existing breaks |

The contract test imports both sides rather than restating the contract in a fixture: the payload is built through the worker's real code, and persistence happens through rag-api's real `run_transactional_update`.

## 2. Verified seams the tests hang off

- `run_transactional_update(db, doc_ref, new_status, details, logger, user_id)` in `rag-api-service/main.py` uses: `@firestore.transactional` (applied at import time), `db.transaction()`, `doc_ref.get(transaction=...)` → `.exists`/`.to_dict()`, `transaction.update(doc_ref, main_update)`, `doc_ref.collection("processing").document("summary")` + `transaction.set(summary_ref, {...}, merge=True)`, and `firestore.SERVER_TIMESTAMP`. Failed branch persists `error`/`error_stage`/`retryable` (with fallbacks `"Processing failed"` / `None` / `True`) and the summary error subdocument (`code` default `"UNKNOWN"`). All verified verbatim.
- Transition guard: `ALLOWED_TRANSITIONS` permits `processing → failed` only (also `failed → queued`, `completed → queued`, etc.), and the function no-ops on missing docs, `deleted` status, or `new_status == current_status`. **Test docs must be seeded with `status: "processing"`.**
- Message envelope read by rag-api: `user_id`, `course_id`, `resource_id`, `status`, `details = payload.get("details", {})`.
- Shared integration conftest (`tests/integration/conftest.py`) sets env defaults and blanket-MagicMocks `firebase_admin` / `google.cloud.*` before importing rag-api's `main`. A blanket MagicMock makes `@firestore.transactional` a no-op that **never executes the function body** — hence the precise stubbing in §3.
- Worker test infra: `rag-worker-service/pytest.ini` (`testpaths = tests`, `asyncio_mode = auto`) and `tests/conftest.py` with env defaults plus a specific stub map for openai/langchain/firebase/google/spacy/tiktoken/tenacity/langfuse. The worker's `tests/integration/` package exists (currently empty).
- House patterns to reuse: fixture-driven contract tests and the subprocess AST-extraction script pattern in `tests/integration/test_api_contracts.py` (e.g. `_get_agent_graph_shapes`).
- `classify_error()` semantics: transient vs permanent, unknown → permanent (F7); `PDFProcessingError.retryable` is raiser-supplied metadata, **not** the source for the payload (plan §3.3).

## 3. Layer 1 — cross-service contract test (required)

File: `apps/ai-server/tests/integration/test_worker_failure_contract.py`

### 3.1 Module loading (self-contained; shared conftest untouched by default)

- Load rag-api's `main` and the worker's `main` under **unique module names** via `importlib.util.spec_from_file_location` (e.g. `rag_api_contract_main`, `rag_worker_contract_main`) — the two files share the basename `main`, and `main` may already be in `sys.modules` from other tests.
- Around each `exec_module`, install scoped dependency stubs in `sys.modules` and remove them afterwards (`try/finally` or fixture):
  - For the worker: mirror the stub map from `rag-worker-service/tests/conftest.py` (the verified working stub set), plus `rag-worker-service/` on `sys.path` so its intra-service imports resolve (exact import graph confirmed in plan Step 0).
  - For rag-api: keep the existing conftest mocks, but ensure the module object that rag-api's `main` binds as `firestore` exposes `transactional = lambda f: f` (pass-through decorator, installed **before** import so the decorator application at definition time is the real passthrough) and a `SERVER_TIMESTAMP` sentinel.
- Fallback (only if scoped stubbing proves impossible): extend `tests/integration/conftest.py` with the precise `firebase_admin.firestore` stub. Existing integration tests only read model fields at import time and never execute transactional bodies, so a passthrough `transactional` cannot change their outcomes — but any conftest change requires a green run of the full existing suite.

### 3.2 Fake Firestore (in-memory, matches the exact API used)

- `FakeSnapshot`: `.exists`, `.to_dict()` → seeded dict (seed `{"status": "processing", ...}`).
- `FakeDocRef`: `.id`; `.get(transaction=None)` → snapshot; `.collection("processing").document("summary")` → `FakeDocRef` for the summary doc.
- `FakeTransaction`: records `(op, ref, data)` for each `update`/`set(merge=True)` call.
- `FakeDB`: `.transaction()` → `FakeTransaction`.
- Optional cheap assertion: the main-doc update and the summary set were recorded on the **same** transaction (atomicity shape preserved).

### 3.3 Test cases

All cases call the worker's real `build_failure_details(exc, stage)` (which internally derives `retryable` via the real `classify_error`), then `run_transactional_update(FakeDB(), doc_ref, "failed", details, logger, user_id)` with the doc seeded at `status: "processing"`.

| # | Case | exc | stage | expect persisted main doc | expect summary error |
|---|---|---|---|---|---|
| C1 | early-stage transient failure | `TransientError("boom-transient")` (or the worker's actual transient type) | `text_retrieved` | `error == "boom-transient"`, `error_stage == "text_retrieved"`, `retryable is True` | `message == "boom-transient"`, `stage == "text_retrieved"`, `code == "UNKNOWN"` |
| C2 | late-stage permanent failure | `PermanentError("boom-permanent")` (or actual permanent type) | `embeddings_complete` | `error == "boom-permanent"`, `error_stage == "embeddings_complete"`, `retryable is False` | same message/stage, `code == "UNKNOWN"` |
| C3 | unclassified-unknown exception | plain `RuntimeError("surprise")` → classifies permanent | `chunking_complete` | `retryable is False` (pins the deliberate behavior change: silent default `True` is gone) | same |
| C4 | unknown-stage safety default | any exc | `"processing"` | `error_stage == "processing"` (never `None`) | same stage |
| C5 | legacy key hedge | any exc | any | payload `details` contains `error` with the same string as `error_message` | — |
| C6 | fallbacks beaten | any exc | any | persisted `error != "Processing failed"`; `error_stage is not None`; `retryable` is exactly the worker's bool (`isinstance(..., bool)`), never the API-side default | — |

Cross-cutting assertions for every case:
- `set(details.keys()) == {"error_message", "stage", "retryable", "error"}` (exact key set).
- `stage` ∈ stage vocabulary `{"starting", "text_retrieved", "tagging_complete", "summary_generated", "chunking_complete", "embeddings_complete", "processing"}`.
- Summary `stage`/`message` equal main doc `error_stage`/`error` (AC3).
- `status` transitioned to `"failed"` on the main doc; `schema_version == 2` present.

### 3.4 Drift guards (AC4: "must fail if either side's payload keys drift")

1. **Behavioral:** C6's fallback-beaten assertions fail if the worker drops `error_message`/`stage`/`retryable` or rag-api stops reading them.
2. **Static AST — worker side:** subprocess AST script (house pattern) extracts the dict keys of `build_failure_details`'s returned literal in `rag-worker-service/main.py`; assert equal to the fixture's pinned key set.
3. **Static AST — rag-api side:** subprocess AST script extracts the first-argument string constants of `details.get(...)` calls inside `run_transactional_update` in `rag-api-service/main.py`; assert the failed-branch key set matches the fixture (`error_message`, `stage`, `retryable`, `error_code`).
4. **Fixture integrity:** the new fixture carries `_contract` metadata (publisher/publisher_file/consumer/consumer_file/topic/endpoint) and its stage vocabulary equals the F9 list.

### 3.5 Fixture

`apps/ai-server/tests/fixtures/api-contracts/worker_failure_status.json`, following the house fixture shape (`_contract` metadata + expected key maps + a sample payload). **Do not** append it to `TestContractFixturesIntegrity.test_all_contract_fixtures_have_required_metadata`'s enumerated list — that list asserts `mobile_file` metadata, which does not apply to a service-to-service Pub/Sub contract. The new fixture gets its own integrity assertions (§3.4.4).

### 3.6 Optional emulator variant (stretch, default-skipped)

If cheap to add: a test gated on `pytest.mark.skipif(not os.getenv("FIRESTORE_EMULATOR_HOST"))` that seeds a real doc via the firebase_admin client (rag-api's emulator branch in `AppState.startup()` is verified; worker emulator support per F10) and re-asserts C1/C2 against real Firestore. The fake-based tests above are the primary, CI-deterministic path; the Definition requires "emulator or fakes" — fakes satisfy it.

## 4. Layer 2 — worker-local wiring test

File: `apps/ai-server/rag-worker-service/tests/integration/test_failure_payload_wiring.py` (runs under the worker's `pytest.ini`; `asyncio_mode = auto` supports async `process_document`).

- Monkeypatch `_publish_status_update` to capture payloads; monkeypatch the pipeline boundary function for a chosen stage to raise (exact patch targets confirmed in plan Step 0 against the current `process_document` body).
- Cases:
  - **W1 (early):** raise at the text-retrieval step → captured payload: envelope (`user_id`, `course_id`, `resource_id`, `status="failed"`) intact; `details` keys exactly `{"error_message", "stage", "retryable", "error"}`; `details["stage"] == "text_retrieved"`; `details["error_message"] == str(raised)`; `details["retryable"]` equals the `classify_error`-derived expectation for the raised type.
  - **W2 (late):** raise at the embeddings step → `details["stage"] == "embeddings_complete"`, same key/value assertions.
  - **W3:** raise a `PermanentError` subclass → `details["retryable"] is False`; raise a `TransientError` subclass → `is True` (proves the handler uses `classify_error`, not the exception's `.retryable` attribute — set the attribute to the *opposite* value in the fixture exception to make the distinction observable).
- These tests run inside the worker's existing hermetic conftest (verified stub map); no new infrastructure.

## 5. Layer 3 — regression

Must remain green, unchanged:
- `apps/ai-server/tests/integration/` existing suite (`test_api_contracts.py` and siblings).
- `apps/ai-server/rag-worker-service/tests/` existing unit + integration packages.
- `apps/ai-server/rag-api-service/tests/` existing packages (contents not inspected this session; require green before and after).

Invocation: follow the repo's established pytest invocation for these trees (see `docs/TESTING-STRATEGY.md`; the exact CI command was not verifiable this session). Standalone runs: `python -m pytest tests/integration/test_worker_failure_contract.py` from `apps/ai-server/` and `python -m pytest` from `apps/ai-server/rag-worker-service/`.

## 6. What the tests deliberately do NOT pin

- A per-step tracker assertion for every pipeline await (only representative early/late stages) — avoids ossifying the pipeline while still catching tracker removal/bypass.
- The `progress` key (failure payload does not carry it; summary falls back to `0`).
- Any `error_code` values (taxonomy explicitly out of scope; only the `"UNKNOWN"` default is pinned).
- Exact transient/permanent classification tables inside `classify_error` (only the transient→true / permanent+unknown→false mapping at the payload boundary is pinned).

## 7. Acceptance mapping

| AC | Evidence |
|---|---|
| 1 | Contract test C1–C6 key/value assertions + wiring tests W1–W3 |
| 2 | C1–C6 persisted main-doc assertions against rag-api's real failed branch |
| 3 | Per-case summary-vs-main equality assertions |
| 4 | Layer 1 as a whole: real worker builder → real `run_transactional_update` → persisted equality, with behavioral + AST drift guards backed by the fixture |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>