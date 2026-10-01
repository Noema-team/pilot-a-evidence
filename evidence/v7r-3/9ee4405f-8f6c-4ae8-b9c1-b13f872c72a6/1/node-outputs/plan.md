<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

Run: 9ee4405f-8f6c-4ae8-b9c1-b13f872c72a6 · Iteration 1 · Step: plan
Authoritative scope: WorkItem `wi-define-108-a8` → artifact `definition:obj-108` (sha256 `71f1c39c…`), reproduced verbatim in the task. This plan implements exactly that Definition; nothing wider, nothing narrower.

---

## 1. Summary

The rag-worker's failure publisher and rag-api's failure consumer speak different payload contracts. The worker's `process_document` exception handler publishes `details = {"error": str(e)}`; rag-api's `run_transactional_update` failed branch reads `error_message`, `stage`, and `retryable`. Every worker-originated failure therefore persists the fallback string `"Processing failed"`, `error_stage: null`, and a silently defaulted `retryable: true` — on both the main resource document and the `processing/summary` error subdocument (`error_code` always `"UNKNOWN"`).

The fix aligns the worker (the odd one out) to rag-api's existing contract:

1. **Stage tracking** in `process_document` so the failure handler reports the pipeline stage executing at failure time, using the existing progress-stage vocabulary.
2. **Deliberate `retryable` derivation** from the worker's existing `classify_error()` — the same classification that already drives ACK/NACK in `run_worker`.
3. **A `build_failure_details()` payload builder** that emits `error_message` / `stage` / `retryable` plus the legacy `error` key (compatibility hedge), wired into the exception handler.
4. **Zero production changes in rag-api** — its reads and persisted schema are already correct; a cross-service contract test pins the seam so key drift on either side fails the build.

No Firestore migration, field rename, or backfill. No changes to the stale-lease sweep, ACK/NACK policy, leases, heartbeats, or frontend.

---

## 2. Verified evidence base

Directly read and verified during investigation (sha256-pinned where noted):

- `apps/ai-server/rag-api-service/main.py` (sha256 `579b0bdf…`):
  - `run_transactional_update(db, doc_ref, new_status, details, logger, user_id)` — module-level function. Failed branch: `main_update["error"] = details.get("error_message", "Processing failed")`, `main_update["error_stage"] = details.get("stage")`, `main_update["retryable"] = details.get("retryable", True)`; summary write: `stage = details.get("stage", "unknown")`, `progress = details.get("progress", 0)`, and `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`. Uses `@firestore.transactional`, `ALLOWED_TRANSITIONS` (`processing → {completed, failed}`), `transaction.update(doc_ref, …)` + `transaction.set(summary_ref, …, merge=True)`.
  - `_process_status_message` — parses `user_id` / `course_id` / `resource_id` / `status` / `details = payload.get("details", {})`, resolves canonical `users/{uid}/resources/{rid}` path (legacy course path fallback), acks/nacks.
  - `startup()` has a `FIRESTORE_EMULATOR_HOST` branch (hermetic mode confirmed).
  - `POST /process` enqueue-failure rollback writes `status/error/error_stage("enqueue")` directly (no `retryable` key — unchanged by this work).
- `apps/ai-server/rag-api-service/models/resource.py`: `Resource` dataclass exposes `error: Optional[str]`, `error_stage: Optional[str]`, `retryable: bool = True` in `to_dict`/`from_dict`. `ResourceResponse` (in rag-api `main.py`) exposes `error` and `error_stage`.
- `apps/ai-server/tests/integration/test_api_contracts.py` + `conftest.py`: the house contract-test pattern — fixture- and AST-based static checks; conftest mocks `firebase_admin`, `google.cloud.*`, `structlog`, puts rag-api's dir on `sys.path`, and tests do `import main as rag_api_main`. Subprocess-based extraction of remote-service facts already exists (`_get_agent_graph_shapes`).
- `apps/ai-server/rag-worker-service/tests/conftest.py`: env defaults + module stubs (`google.cloud.pubsub_v1`, `google.cloud.firestore`, `openai`, `langfuse`, `spacy`, `tiktoken`, …) that make `import main` hermetic for the worker.
- `apps/ai-server/rag-worker-service/tests/unit/test_processing_lease.py`: the established fake-Firestore pattern for worker code paths (`FakeTx`/`FakeSnap`/`FakeRef`/`FakeCollection`/`FakeDb`, `monkeypatch(main.firestore, "transactional", _tx_identity)`, `SERVER_TIMESTAMP` sentinel). It also pins the stale-lease sweep's `retryable is True` write — confirming F6 and guarding the non-goal.
- Directory layout: `rag-worker-service/exceptions.py` exists; `rag-worker-service/tests/integration/` contains only `__init__.py` (empty — available for new tests); `rag-api-service/tests/` has `conftest.py`, `fixtures/`, `integration/`, `unit/`.

Worker-side behavior (F3, F5, F7, F9: `{"error": str(e)}` publication, `classify_error()` with TransientError/PermanentError + heuristics and conservative permanent default for unknowns, the progress-stage vocabulary, one-large-try-block shape of `process_document`) is taken from the Definition's repository-claim facts, which are authoritative for this plan. Two implementation-time confirmations are listed in §12 (exact `classify_error` return convention; exact `_publish_status_update` signature) — the design is structured so these affect only a thin adapter, not the plan's shape.

---

## 3. Scope

**In scope (from the Definition):**
- Worker failure payload carries `error_message` (actual exception message), `stage` (failing pipeline stage), `retryable` (deliberately derived) — never relying on rag-api's fallbacks.
- Stage tracking through `process_document`; stage names reuse the progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe unknown value.
- rag-api persists worker-provided values unchanged (`error ← error_message`, `error_stage ← stage`, `retryable ← retryable`; summary error subdocument carries the same message and stage).
- `retryable` derivation aligned with ACK/NACK behavior: `classify_error` transient → `true`; permanent (including unclassified-unknown) → `false`.
- A contract test covering worker failure-payload construction → rag-api failed-branch persistence, with key-drift guards on both sides.

**Out of scope (non-goals, restated for enforcement):**
- The stale-lease sweep's direct failure write (already consistent; `retryable: true` there stays correct — a dead worker is a transient condition).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals.
- Frontend/mobile changes (`ResourceResponse` already exposes `error` / `error_stage`).
- Structured error codes / failure taxonomy (summary `error.code` stays `"UNKNOWN"` unless a code is actually sent).
- Anything the companion D3 issue covers beyond this payload alignment (content unavailable here; deferred), and reconciling with the D4 note in `plans/upload-flow.md` (file not present in the tree).

---

## 4. Design

### 4.1 The target contract (worker → rag-api, `status: "failed"`)

Worker publishes (via the existing `_publish_status_update` path, inside `details`):

| Key | Value | Notes |
|---|---|---|
| `error_message` | `str(exc)` (or `type(exc).__name__` if `str(exc)` is empty) | Contract key; rag-api persists to main `error` and summary `error.message` |
| `stage` | current pipeline stage label | Contract key; rag-api persists to main `error_stage` and summary `error.stage` + top-level summary `stage` |
| `retryable` | `bool` from `classify_error` | Contract key; rag-api persists verbatim |
| `error` | same string as `error_message` | **Legacy key retained** — compatibility hedge for unknown consumers of the status topic (F11) |

rag-api's failed branch reads exactly these keys today; with the worker aligned, none of the fallbacks (`"Processing failed"`, `None`, `True`, `"UNKNOWN"`) is operative for worker failures. The fallbacks themselves remain in rag-api untouched (constraint: do not change rag-api's reads).

### 4.2 Worker change 1 — stage tracker in `process_document`

`process_document` is one large try block; at failure time nothing knows where it was. Add a local tracker following the **set-immediately-before-the-await** convention:

```python
current_stage = "starting"          # initialized at the top of the try block
...
current_stage = "text_retrieved"    # set immediately BEFORE the extraction await
...
current_stage = "tagging_complete"  # set immediately BEFORE the tagging await
...                                  # (same for summary_generated, chunking_complete,
...                                  #  embeddings_complete)
```

Semantics: the label names the **stage whose work is in flight** at failure time. The vocabulary is completion-flavored (that is the existing progress-event naming); the label identifies the stage, not its completion. This reads naturally next to the progress timeline clients already see and satisfies "the pipeline stage executing at failure time".

- Initialization: `"starting"` (first progress event; covers failures during initial setup before the first transition).
- Guard: the exception handler reports `current_stage` if truthy, else `"processing"` (same safe value the stale-lease sweep uses for `error_stage`, so the field never regresses to null).
- Known drift risk (a future pipeline step added without updating the tracker) is mitigated by the convention, a mapping-table comment at the tracker, and representative-stage test coverage (§5, early + late failure). It is deliberately **not** mitigated by ossifying every step in a test.

Stage mapping table (single source of truth; also placed as a comment above the tracker):

| Pipeline step (in execution order) | Tracker value set immediately before its await |
|---|---|
| function entry / initial setup | `starting` |
| text extraction | `text_retrieved` |
| content tagging | `tagging_complete` |
| summary generation | `summary_generated` |
| chunking | `chunking_complete` |
| embeddings | `embeddings_complete` |
| genuinely unknown / tracker unset | `processing` |

### 4.3 Worker change 2 — deliberate `retryable` derivation

The worker already classifies every exception via `classify_error()` (TransientError/PermanentError + type- and status-code heuristics; unknown → permanent conservative default) and uses that classification for ACK/NACK in `run_worker`. Derive `retryable` from the same function:

| Exception classification | `retryable` | Rationale |
|---|---|---|
| Transient (TransientError or transient heuristic) | `true` | Pub/Sub will redeliver (NACK path) — persisted record tells the truth |
| Permanent (PermanentError or permanent heuristic) | `false` | Acked, will not redeliver; manual reprocess via `POST /process` remains |
| Unclassified-unknown | `false` | `classify_error`'s conservative default; **deliberate behavior change** — was silently `true` via rag-api's fallback |

Adapter: add a one-line module-level helper `_derive_retryable(exc) -> bool` in worker `main.py` that maps `classify_error`'s return convention to a bool (exact return shape confirmed at implementation start, §12). `run_worker`'s ACK/NACK logic is **not** touched — only the *reporting* of retryability changes.

Stale-lease sweep: untouched; its direct `retryable: true` write stays correct (dead worker = transient condition). rag-api's enqueue-failure paths: untouched (they write `error`/`error_stage` directly and set no `retryable`; the model default `True` covers reads — unchanged).

### 4.4 Worker change 3 — `build_failure_details()` + handler rewiring

New module-level pure function in worker `main.py` (pure ⇒ trivially unit-testable ⇒ stable seam for the contract test):

```python
def build_failure_details(exc: Exception, stage: str | None) -> dict:
    """Failure payload for the rag-status topic.

    Contract (read by rag-api run_transactional_update failed branch):
      error_message -> persisted as main doc `error` + summary error.message
      stage         -> persisted as main doc `error_stage` + summary error.stage
      retryable     -> persisted verbatim (derived from classify_error)
    `error` is retained as a legacy key for unknown consumers of this topic.
    """
    message = str(exc) or type(exc).__name__
    return {
        "error": message,             # legacy key — compatibility hedge (F11)
        "error_message": message,     # contract key
        "stage": stage or "processing",
        "retryable": _derive_retryable(exc),
    }
```

The `process_document` exception handler is rewired from `details = {"error": str(e)}` to `details = build_failure_details(e, current_stage)` and publishes through the existing `_publish_status_update` call shape (signature reused as-is; §12 confirmation only affects argument passing, not design). The failure log line gains `stage` and `retryable` fields for ops visibility — log-only, no behavior change.

### 4.5 rag-api — zero production changes

`run_transactional_update` already implements requirement 3 verbatim once the keys align: main `error ← details["error_message"]`, `error_stage ← details["stage"]`, `retryable ← details["retryable"]`; summary `error.message`/`error.stage` read the same payload keys, `error_code` defaults `"UNKNOWN"` (no code is sent — per prefer-not constraint, none is introduced), top-level summary `stage` becomes the real stage instead of `"unknown"`. The fallbacks stay (constraint: don't change rag-api's reads; and the fallback contract itself gets pinned by a test so any future change is conscious). **No file in `rag-api-service/` is modified.**

### 4.6 Compatibility & rollout

- **Deploy ordering:** rag-api is unchanged, so a worker-only deploy fixes the seam immediately. No coordination, no migration, no backfill (existing failed documents keep their historical fallback values — explicitly out of scope).
- **Legacy `error` key:** retained alongside `error_message` (one redundant string per failure message) as insurance for unverified consumers of the status topic. If a later audit confirms rag-api is the only consumer, dropping the duplicate is trivial cleanup — and will require touching the contract test, which is the drift guard doing its job.
- **Behavior change to acknowledge in the PR description:** unclassified-unknown failures flip persisted `retryable` from `true` (silent fallback) to `false` (conservative classification). Accepted per the Definition (F8); manual reprocess via `POST /process` is unaffected; widening `classify_error` is out of scope.

---

## 5. Implementation steps

All paths relative to `apps/ai-server/`.

**Step 1 — Worker: `_derive_retryable` adapter** (`rag-worker-service/main.py`)
Module-level `_derive_retryable(exc) -> bool`. Confirm `classify_error`'s exact return convention first (§12); map transient → `True`, permanent/unknown → `False`. Do not duplicate heuristics — delegate entirely to `classify_error`.

**Step 2 — Worker: `build_failure_details`** (`rag-worker-service/main.py`)
Exactly as spec'd in §4.4 (four keys, empty-message guard, stage guard). Docstring documents the contract and the legacy-key hedge.

**Step 3 — Worker: stage tracker** (`rag-worker-service/main.py`, `process_document`)
Introduce `current_stage` local at the top of the try block; insert the set-before-await assignments per the §4.2 mapping table; add the mapping table as a comment. Keep the tracker in the main function body scope (the handler reads it directly). If any step turns out to live in a helper closure, use a nonlocal or a one-element holder — do not restructure the pipeline.

**Step 4 — Worker: rewire the failure handler** (`rag-worker-service/main.py`, `process_document` except block)
Replace `{"error": str(e)}` with `build_failure_details(e, current_stage)`; pass through the existing `_publish_status_update` call unchanged otherwise; extend the failure log record with `stage` and `retryable`.

**Step 5 — Worker unit tests** (`rag-worker-service/tests/unit/test_failure_payload.py`, new)
Cover the builder and derivation (detailed in `docs/test-plan.md` §2.1): transient → `retryable True`, permanent → `False`, unknown (`ValueError`) → `False`, message passthrough + empty-message guard, stage passthrough + `None → "processing"`, legacy `error` key equality, exact key set.

**Step 6 — Worker stage-reporting tests** (`rag-worker-service/tests/integration/test_failure_stage_reporting.py`, new — the dir exists and is empty; if `rag-worker-service/pytest.ini` restricts `testpaths`, place in `tests/unit/` instead, §12)
Monkeypatch the pipeline collaborators so an exception propagates from an early step and from a late step; monkeypatch `_publish_status_update` to capture calls; assert `status == "failed"` and `details["stage"]` equals the expected vocabulary label for each representative stage, and that `details` came from `build_failure_details` (all four keys present).

**Step 7 — Cross-service contract test** (`tests/integration/test_rag_failure_contract.py`, new — sibling of `test_api_contracts.py`, sharing its conftest mocks)
The core deliverable; full spec in `docs/test-plan.md` §2.2–2.4. Worker side executes in a subprocess (worker stubs installed by exec'ing the worker's `tests/conftest.py`, then `import main; main.build_failure_details(...)` — the established subprocess pattern from `_get_agent_graph_shapes`); rag-api side runs in-process against fake Firestore transaction objects with `firestore.transactional` identity-patched and `SERVER_TIMESTAMP` sentinel-patched (the established pattern from `test_processing_lease.py`). Asserts persisted `error` / `error_stage` / `retryable` equal the worker's values for transient and permanent cases, pins the fallback contract, and adds AST drift guards on both sides.

**Step 8 — Full suite verification**
- `rag-worker-service`: `python -m pytest tests/unit -q` (and `tests/integration` if collected) — all green, especially `test_processing_lease.py` (sweep untouched, `retryable is True` assertion must hold).
- `tests/integration`: `python -m pytest test_api_contracts.py test_rag_failure_contract.py -q` — existing contract tests untouched and green; new contract tests green.
- `rag-api-service`: existing unit/integration suites green (no production change, so this is a no-op guard).

**Step 9 — (optional) emulator smoke**
Both services have `FIRESTORE_EMULATOR_HOST` branches. If the hermetic stack is running, a manual end-to-end pass (enqueue → force a failure → inspect persisted doc + `processing/summary`) is a nice-to-have; the fakes-based contract test is the shipped, CI-safe mechanism and fully satisfies the Definition's acceptance item.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained; residual risk accepted as low (F11) |
| Stage-tracker drift as the pipeline evolves | Set-before-await convention + mapping-table comment + representative early/late-stage tests (not per-step ossification) |
| `retryable=false` for genuinely-transient-but-unrecognized failures reduces auto-retry affordances | Accepted per Definition; manual reprocess via `POST /process` remains; widening `classify_error` is out of scope |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key later means touching the test |
| `classify_error` return shape differs from assumption | Confined to the `_derive_retryable` adapter (Step 1); confirmed before anything else is built on it |
| Worker `import main` side effects in the contract-test subprocess | Subprocess installs the worker's own stub set (exec its `tests/conftest.py`); helper documented so unstubbed imports are extendable without touching other tests |

---

## 7. Acceptance criteria mapping

| Definition acceptance item | Delivered by |
|---|---|
| AC1 — worker failure payload carries `error_message`/`stage`/`retryable`, no fallback reliance | Steps 2–4; tests: worker unit builder tests + contract payload-shape tests |
| AC2 — persisted main doc: real error (not `"Processing failed"`), real stage (not `None`), derived retryable | Step 7 persistence tests (transient + permanent paths) |
| AC3 — `processing/summary` error subdocument carries same message and stage | Step 7 summary assertions (message, stage, `code == "UNKNOWN"`, top-level summary `stage`) |
| AC4 — contract test exists and passes, exercising worker construction → rag-api persistence, failing on key drift | Step 7 (whole file), including exact-key-set and AST drift guards |

---

## 8. Open items to confirm at implementation start (before Step 1)

1. **`classify_error` return convention** (worker `main.py`): exact return type/shape (bool vs. enum vs. tuple). Affects only `_derive_retryable`. Also enumerate its heuristics to add representative unit cases beyond the three certain ones (TransientError / PermanentError / unknown).
2. **`_publish_status_update` signature**: exact parameters/order; the handler rewiring reuses the existing call shape.
3. **Progress payload `stage` key**: whether progress updates already use `"stage"` in `details` (expected, since rag-api's summary reads it for all statuses); if so, the failure payload's `stage` key is consistent with existing traffic.
4. **`rag-worker-service/pytest.ini` collection config**: whether `tests/integration/` is collected; determines Step 6 placement (fallback: `tests/unit/`).
5. **`exceptions.py` exports**: confirm `TransientError`/`PermanentError` are importable for tests (file exists; class names per F7).

These are confirmation tasks, not design risks — each is confined to a thin adapter or a test-placement decision.

---

## 9. Explicitly not doing (enforcement checklist for review)

- ❌ No edits to `run_transactional_update`, `_process_status_message`, `ResourceResponse`, or anything else in `rag-api-service/`.
- ❌ No edits to `_fail_if_still_stale`, `run_worker` ACK/NACK, lease/heartbeat constants.
- ❌ No Firestore schema change, rename, backfill, or new index.
- ❌ No `error_code` values introduced; summary `error.code` stays `"UNKNOWN"` for worker failures.
- ❌ No frontend/mobile changes.
- ❌ No scope from the companion D3 issue beyond this payload alignment.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — rag-worker → rag-api failure payload contract alignment

Companion to `docs/plan.md` (same run/scope). Implements the Definition's test requirement: *"A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted error, error_stage, and retryable equal the worker's values; it must fail if either side's payload keys drift."*

---

## 1. Strategy and layers

Three layers, all hermetic (no cloud dependencies, no emulator required in CI):

| Layer | Location | Mechanism | What it pins |
|---|---|---|---|
| L1 — worker unit | `rag-worker-service/tests/unit/test_failure_payload.py` (new) | Direct import of worker `main` under the existing worker conftest stubs | Payload builder: keys, values, retryable derivation |
| L2 — worker stage reporting | `rag-worker-service/tests/integration/test_failure_stage_reporting.py` (new; fallback `tests/unit/` per plan §8.4) | Monkeypatched pipeline collaborators + captured `_publish_status_update` calls | Tracker wiring: real failing stage reaches the published payload |
| L3 — cross-service contract | `tests/integration/test_rag_failure_contract.py` (new, sibling of `test_api_contracts.py`) | Worker payload built in a subprocess (real worker code, real stubs); rag-api failed branch executed in-process against fake Firestore transactions | The seam itself: persisted values equal worker values; key drift on either side fails the build |

Design principle (per the Definition's direction): the contract test **imports both sides rather than restating the contract in a fixture**. The only literal expectations in tests are the ones the Definition pins (key names, fallback strings, derivation mapping) — everything else flows from executing real code on both sides.

Existing infrastructure reused:
- `tests/integration/conftest.py` already mocks `firebase_admin` / `google.cloud.*` / `structlog` and puts rag-api on `sys.path` → `import main as rag_api_main` works in-process.
- `rag-worker-service/tests/conftest.py` already stubs every heavy worker dependency → exec'ing it inside a subprocess makes `import main` hermetic there too (the subprocess pattern already exists in `_get_agent_graph_shapes`).
- The fake-transaction pattern (`FakeTx`/`FakeSnap`/`FakeRef`/`FakeCollection`/`FakeDb`, `firestore.transactional` identity patch, `SERVER_TIMESTAMP` sentinel) is proven in `test_processing_lease.py` and is compatible with rag-api's call shape (`doc_ref.get(transaction=…)`, `transaction.update`, `transaction.set(…, merge=True)`, `doc_ref.collection("processing").document("summary")`, `db.transaction()`).

Emulator note: both services support `FIRESTORE_EMULATOR_HOST`, but the integration conftest mocks `firebase_admin` globally, so an emulator-based variant would need to live outside that conftest. Fakes are the shipped mechanism (they satisfy the Definition's "emulator **or fakes**"); an emulator smoke run is optional manual verification (plan Step 9).

---

## 2. New test specifications

### 2.1 L1 — `rag-worker-service/tests/unit/test_failure_payload.py`

Imports: `sys.path.insert(0, <worker root>)`; `import main` (worker conftest stubs apply). Resolve exception classes from `main` / `exceptions` module (plan §8.5).

Class `TestBuildFailureDetails`:
- `test_payload_has_exact_contract_key_set` — `build_failure_details(ValueError("boom"), "tagging_complete")` → keys **exactly** `{"error", "error_message", "stage", "retryable"}`. Exact-set assertion is the worker-side drift guard: adding or renaming a key must fail here.
- `test_error_message_carries_actual_exception_message` — `error_message == "boom"` and legacy `error == "boom"` (hedge key present and equal).
- `test_empty_exception_message_falls_back_to_class_name` — exception whose `str()` is `""` → `error_message == "ValueError"` (keeps persisted `error` non-empty).
- `test_stage_passthrough` — stage `"embeddings_complete"` → `stage == "embeddings_complete"`.
- `test_unknown_stage_defaults_to_processing` — `stage=None` → `"processing"` (same safe value the stale-lease sweep uses; the field never regresses to null).

Class `TestRetryableDerivation` (the certain cases; heuristic cases added after plan §8.1 confirmation):
- `test_transient_error_is_retryable` — `TransientError("…")` → `retryable is True`.
- `test_permanent_error_is_not_retryable` — `PermanentError("…")` → `retryable is False`.
- `test_unclassified_unknown_error_is_conservatively_not_retryable` — `ValueError("…")` → `retryable is False`. This pins the deliberate behavior change (was silently `true` via rag-api's fallback) so it cannot silently regress in either direction.
- (post-confirmation) one transient-heuristic case and one permanent-heuristic case mirroring `classify_error`'s actual type/status-code rules.

### 2.2 L2 — stage reporting through `process_document`

File: `rag-worker-service/tests/integration/test_failure_stage_reporting.py` (if `rag-worker-service/pytest.ini` does not collect `tests/integration`, place in `tests/unit/` as `test_failure_stage_reporting.py` — same content).

Setup pattern: monkeypatch the pipeline collaborators so a raised exception propagates out of `process_document`'s try block into the failure handler; monkeypatch `main._publish_status_update` with a recorder `(status, details)` list; drive `process_document` with a minimal valid job payload (shape confirmed from the existing handler signature at implementation time).

Tests (representative stages only — per the Definition, the mechanism is pinned, not every step):
- `test_early_failure_reports_extraction_stage` — make the text-extraction step raise `ValueError("parse blew up")` → captured failed publish has `status == "failed"`, `details["stage"] == "text_retrieved"`, `details["error_message"] == "parse blew up"`, all four contract keys present.
- `test_late_failure_reports_embeddings_stage` — make the embeddings step raise → `details["stage"] == "embeddings_complete"`.
- `test_failure_before_first_transition_reports_starting` — raise during initial setup (before the first tracker transition) → `details["stage"] == "starting"`.
- `test_failure_payload_comes_from_builder` — captured failed details key set is exactly the four contract keys (catches the handler being rewired around `build_failure_details`).

These tests intentionally do **not** enumerate the remaining stages; a future step added without tracker coverage is caught by review against the mapping-table comment, not by test ossification (explicit Definition tradeoff).

### 2.3 L3 — `tests/integration/test_rag_failure_contract.py` (the contract test)

**Worker-side payload extraction (subprocess helper).**

```python
WORKER_DIR = .../apps/ai-server/rag-worker-service
WORKER_CONFTEST = WORKER_DIR + "/tests/conftest.py"

def _worker_failure_payload(exc_kind: str, stage: str | None) -> dict:
    # subprocess script:
    #   1. importlib-load WORKER_CONFTEST and exec it  -> env defaults + module stubs installed
    #   2. sys.path.insert(0, WORKER_DIR); import main
    #   3. resolve exc: "transient" -> main.TransientError, "permanent" -> main.PermanentError,
    #      "unknown" -> ValueError (names resolved against main/exceptions at runtime)
    #   4. print(json.dumps(main.build_failure_details(exc, stage)))
    # capture_output=True, timeout=30; nonzero exit -> RuntimeError with stderr
    # returns json.loads(stdout)
```

Rationale: executes the real worker builder (including real `classify_error`) without polluting the pytest process with worker stubs that would collide with the rag-api mocks. If a worker import is not covered by the exec'd stub set, extend the stub env inside this helper only (documented in the helper docstring).

**rag-api-side fake Firestore (in-file helpers, adapted from `test_processing_lease.py`).**

- `FakeSnap` (`.exists`, `.to_dict()`), `FakeTx` (records `("update"|"set", ref, data)` writes; `get(ref, transaction=None)` returns current doc state; `update`/`set(merge=)` mutate it), `FakeRef` (`.get(transaction=…)`, `.collection("processing")`), `FakeCollection` (`.document("summary")`), `FakeDb` (`.transaction()`, `.document(path)`).
- `_tx_identity(fn)` — identity stand-in for `@firestore.transactional`.
- `_run_failed_branch(monkeypatch, details, seed=None)`:
  1. `monkeypatch.setattr(rag_api_main.firestore, "transactional", _tx_identity, raising=False)`
  2. `monkeypatch.setattr(rag_api_main.firestore, "SERVER_TIMESTAMP", "TS", raising=False)`
  3. seed doc `{"status": "processing", "filename": "f.pdf", ...}` (processing → failed is an allowed transition)
  4. `db = FakeDb(seed)`; `ref = db.document("users/u1/resources/r1")`
  5. `rag_api_main.run_transactional_update(db, ref, "failed", details, rag_api_main.logger, "u1")` (logger is the conftest's structlog mock — safe to pass through)
  6. return `db._tx` for assertions.

**Tests.**

Class `TestWorkerPayloadContract` (worker side, via subprocess):
- `test_payload_key_set_is_pinned` — keys exactly `{"error", "error_message", "stage", "retryable"}` for an unknown-exception payload.
- `test_transient_payload_is_retryable` — transient exception → `retryable is True`.
- `test_unknown_payload_is_not_retryable` — `ValueError` → `retryable is False`.
- `test_stage_defaults_when_unknown` — `stage=None` → `"processing"`.

Class `TestFailurePathPersistence` (the seam — worker payload → rag-api failed branch):
- `test_permanent_worker_failure_persists_verbatim` — payload = `_worker_failure_payload("unknown", "text_retrieved")` → run failed branch → main doc: `error == payload["error_message"]` (the real message, **not** `"Processing failed"`), `error_stage == payload["stage"]`, `retryable is False`; summary: `error.message == payload["error_message"]`, `error.stage == payload["stage"]`, `error.code == "UNKNOWN"`, top-level `stage == payload["stage"]`.
- `test_transient_worker_failure_persists_retryable_true` — payload = `_worker_failure_payload("transient", "embeddings_complete")` → persisted `retryable is True`, `error_stage == "embeddings_complete"`, summary mirrors message/stage.
- `test_persisted_values_equal_worker_values_exactly` — parametrized over both payloads: assert persisted `error == payload["error_message"]`, `error_stage == payload["stage"]`, `retryable == payload["retryable"]` with **no transformation** (requirement: "persist the worker-provided values unchanged").
- `test_fallback_contract_is_pinned` — `details = {}` → `error == "Processing failed"`, `error_stage is None`, `retryable is True`, summary `error.code == "UNKNOWN"`. This documents the fallback behavior so any future change to rag-api's fallbacks or read keys fails here and forces a conscious update (the fallbacks must remain non-operative for worker failures — this test proves they exist only for key-less payloads).

Class `TestContractDriftGuards`:
- `test_rag_api_failed_branch_reads_exactly_the_contract_keys` (AST, static — house pattern): parse `rag-api-service/main.py`; locate `FunctionDef run_transactional_update`; within every `If` whose test is `new_status == "failed"`, collect first-arg string constants of `details.get(...)` calls; assert the collected set **equals** `{"error_message", "stage", "retryable", "error_code"}`. Catches: a read key being renamed (worker values would silently fall back), a key being dropped, or a new key being added — all must fail the build.
- `test_worker_failure_handler_uses_the_builder` (AST, static): parse `rag-worker-service/main.py`; locate `FunctionDef process_document`; assert some `ExceptHandler` body contains a `Call` to `build_failure_details`. Catches the handler being rewired to an inline dict that bypasses the builder (which is how this bug was originally created).

No fixture files are added — the contract is enforced by executing both sides, not by restating it in JSON.

---

## 3. Existing tests that must remain green (regression envelope)

- `rag-worker-service/tests/unit/test_processing_lease.py` — untouched; critically `test_genuinely_stale_lease_is_failed` still asserts `retryable is True` for the sweep (non-goal: sweep behavior unchanged).
- `rag-worker-service/tests/unit/*` — all other units unaffected (no chunking/tagging/vector logic touched).
- `tests/integration/test_api_contracts.py` — untouched; rag-api models unchanged, so all mobile-contract assertions hold.
- `rag-api-service/tests/` (unit + integration) — no production change; green by construction, run as a guard.
- `apps/ai-server/tests/test_combined_features.py`, `test_general_chat.py` — unaffected; run if they are part of the standard local suite.

---

## 4. Run instructions

```bash
# L1 + L2 (worker)
cd apps/ai-server/rag-worker-service
python -m pytest tests/unit -q
python -m pytest tests/integration -q        # if collected; else the unit fallback path

# L3 (cross-service contract)
cd apps/ai-server/tests/integration
python -m pytest test_rag_failure_contract.py -q
python -m pytest test_api_contracts.py -q    # guard: existing contracts untouched

# rag-api guard
cd apps/ai-server/rag-api-service
python -m pytest tests -q
```

Environment: no GCP credentials, no emulator, no network required. The L3 subprocess needs only the Python env already used for the integration suite (worker third-party imports are stubbed by the exec'd worker conftest).

---

## 5. Acceptance mapping (Definition → tests)

| Acceptance item | Tests |
|---|---|
| AC1 — payload carries `error_message`/`stage`/`retryable`, no fallback reliance | §2.1 all; §2.2 all; §2.3 `TestWorkerPayloadContract` |
| AC2 — main doc persists real error / real stage / derived retryable | §2.3 `TestFailurePathPersistence` (both transient and permanent paths) |
| AC3 — summary error subdocument carries same message and stage | §2.3 summary assertions in `test_permanent_worker_failure_persists_verbatim` and `test_transient_worker_failure_persists_retryable_true` |
| AC4 — contract test exists, passes, exercises construction → persistence, fails on key drift | §2.3 entire file, esp. `TestContractDriftGuards` + exact-key-set assertions |

---

## 6. Test-side risks and notes

- **Subprocess flakiness**: bounded by `timeout=30` and a clear `RuntimeError` on nonzero exit; the helper is the only place worker stubs are manipulated, so failures are diagnosable in one file.
- **AST guards are intentionally strict**: the rag-api read-key set is asserted with equality, not subset — adding a details key to the failed branch must touch the test. That is the Definition's stated intent ("the contract test ossifies the payload — intentional").
- **Derivation cases pending confirmation**: the three certain retryable cases (transient/permanent/unknown) ship immediately; heuristic cases are added once `classify_error`'s exact rules are confirmed (plan §8.1). Until then the conservative unknown→`false` case is the load-bearing assertion.
- **No backfill tests**: existing failed documents keep historical fallback values by design (constraint: no migration/backfill); nothing asserts on old data.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>