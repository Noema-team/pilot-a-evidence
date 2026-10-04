Both artifacts follow from the verified evidence: the rag-api failed branch (`run_transactional_update`), the `Resource`/`ResourceResponse` schemas, the existing contract-test and fake-transaction harness patterns, and the binding Definition facts for the worker side.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (Definition artifact `definition:obj-108`, sha256 `71f1c39c…`). This document restates that Definition as implementable requirements. It does not widen, narrow, or reinterpret it.

## 1. Problem statement

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test covers the seam.

- **Worker side** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler): publishes failed status with `details = {"error": str(e)}` via `_publish_status_update` (Definition F3).
- **API side** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch — verified in source): reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`; persists `error`, `error_stage`, `retryable` on the main resource document; writes `error = {code: details.get("error_code", "UNKNOWN"), message, stage}` into the `processing/summary` subdocument (Definition F4, verified).

Consequence (Definition F5): every worker-originated failure persists `error = "Processing failed"`, `error_stage = None`, and a fabricated `retryable = True`. The `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

The persisted schema `error` / `error_stage` / `retryable` is already established by three other write paths and both response models (Definition F6): the worker's stale-lease sweep (`_fail_if_still_stale` — verified writing `retryable: True` in `rag-worker-service/tests/unit/test_processing_lease.py`), rag-api's enqueue-failure paths (`POST /process` verified writing `error` + `error_stage: "enqueue"`), the `Resource` model (`rag-api-service/models/resource.py` — verified: `error`, `error_stage`, `retryable: bool = True`), and `ResourceResponse` (verified: exposes `error`, `error_stage`). The worker's status publisher is the only writer that does not speak this contract. **The worker is the odd one out; the worker aligns to the API.**

## 2. Functional requirements

### FR-1 — Worker failure payload keys
When document processing fails, the worker's failed status payload `details` MUST contain exactly:

| key | type | source |
|---|---|---|
| `error_message` | string | `str(exception)` — the actual exception message |
| `stage` | string | the pipeline stage executing at failure time (FR-2) |
| `retryable` | bool | deliberately derived from `classify_error` (FR-4) |
| `error` | string | `str(exception)` — legacy key, retained for continuity (Definition F11 / prefer-constraint) |

The payload MUST NEVER rely on rag-api's fallback defaults (`"Processing failed"`, `stage → None`, `retryable → True`) for any of these keys. The key set is pinned by the contract test (FR-5); adding or removing a key requires touching the test, which is the intended drift guard.

### FR-2 — Stage tracking in `process_document`
- The worker MUST track the currently executing pipeline stage as a local in `process_document`, reported by the exception handler at failure time.
- Stage names MUST reuse the existing progress-stage vocabulary (Definition F9): `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `processing` is the safe value when the stage is genuinely unknown (the same value the stale-lease sweep uses for `error_stage`), so `error_stage` never regresses to `None`.
- Convention: the tracker is set **immediately before the `await`** of each pipeline step, labeled with that step's existing progress vocabulary label (the label whose progress `_publish_status_update` call fires on that step's completion). Semantic: "failure occurred while executing the pipeline step that produces `<label>`".
- Initialization: `current_stage = "processing"` before the `try`; first statement inside the `try` sets `current_stage = "starting"`; each subsequent step reassigns before its first await.

### FR-3 — rag-api persistence of worker-provided values (no API code change)
rag-api's failed branch MUST persist worker-provided values unchanged:
- main document: `error ← details["error_message"]`, `error_stage ← details["stage"]`, `retryable ← details["retryable"]`;
- `processing/summary` subdocument: `error.message ← details["error_message"]`, `error.stage ← details["stage"]`, top-level `stage ← details["stage"]`.

This is already the existing code's behavior once keys align (verified) — so **rag-api production code is unchanged**; FR-3 is a preservation requirement enforced by the contract test. The API-side fallbacks (`"Processing failed"`, `retryable → True`) remain in the code for non-conforming/legacy publishers but MUST NOT be the operative mechanism for worker failures. `error_code` stays `"UNKNOWN"` (worker sends no code — see prefer_not constraint).

### FR-4 — Deliberate retryable derivation
The worker MUST derive `retryable` from `classify_error(e)` — the same classification that drives ACK/NACK in `run_worker` (Definition F7):
- transient-classified → `retryable: true` (Pub/Sub will redeliver);
- permanent-classified, including unclassified-unknown per `classify_error`'s conservative default → `retryable: false` (acked; manual reprocess via `POST /process` remains).

This adopts Definition F8. **Deliberate behavior change:** unclassified-unknown exceptions previously persisted `retryable: true` (the API's silent default) and now persist `false`. This aligns the persisted record with actual ACK/NACK behavior. `classify_error` itself MUST NOT be modified (widening it is out of scope). The stale-lease sweep's separate `retryable: true` write is untouched and stays correct (a dead worker is a transient condition).

### FR-5 — Contract test on the worker → rag-api failure path
A contract test MUST exist and pass that:
1. exercises the worker's failure-payload construction (through the real code the handler uses) for at least one transient-classified and one permanent-classified exception;
2. feeds the produced payload through rag-api's `run_transactional_update` failed branch (via fakes or the Firestore emulator) against a resource document in `processing` status;
3. asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's `error_message`, `stage`, and `retryable` values (both `retryable` polarities covered);
4. asserts the `processing/summary` error subdocument carries the same message and stage, with `error.code == "UNKNOWN"`;
5. fails if either side's payload keys drift:
   - worker side: exact key-set assertion on the built payload (`{error_message, stage, retryable, error}`);
   - API side: persisted-value equality (catches read-key drift — wrong keys yield fallback values ≠ worker values) plus a source-level (AST) guard pinning the failed branch's `details.get("error_message"/"stage"/"retryable")` reads and the persisted field names;
6. includes a negative control: replaying the legacy payload shape (`{"error": …}` only) persists the fallback signature (`"Processing failed"`, `None`, `True`), demonstrating the assertions detect the original mismatch.

Supporting worker-local unit tests MUST additionally pin: (a) the handler wiring — the exception handler passes the built payload (with the tracker's stage) to `_publish_status_update`; (b) stage tracking through `process_document` for a representative early-stage failure (`starting`) and late-stage failure (late vocabulary label); (c) the retryable mapping for transient / permanent / unknown exception classes.

## 3. Data contracts

### 3.1 Worker → status topic (status `"failed"`), `details` object
```json
{
  "error_message": "<actual exception message>",
  "error":         "<actual exception message>  (legacy, retained)",
  "stage":         "<vocabulary label | \"processing\">",
  "retryable":     true | false
}
```
The message envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`) is unchanged — verified as exactly what rag-api's `_process_status_message` consumes. Only the `details` keys of the failure case change. Progress updates are untouched.

### 3.2 Persisted main resource document (failed)
| field | value |
|---|---|
| `status` | `"failed"` (transition `processing → failed`, verified allowed) |
| `error` | worker `error_message` (actual message — **not** `"Processing failed"`) |
| `error_stage` | worker `stage` (vocabulary label — **not** `None`) |
| `retryable` | worker-derived bool (**not** the silent default) |

### 3.3 `processing/summary` subdocument (failed, merge)
| field | value |
|---|---|
| `stage` | worker `stage` |
| `error.code` | `"UNKNOWN"` (no `error_code` sent) |
| `error.message` | same as main-doc `error` |
| `error.stage` | same as main-doc `error_stage` |

## 4. Stage vocabulary ↔ tracker assignment

| label | pipeline phase (per existing progress call sites) |
|---|---|
| `starting` | entry / initial setup |
| `text_retrieved` | text extraction step |
| `tagging_complete` | content tagging step |
| `summary_generated` | summary generation step |
| `chunking_complete` | chunking step |
| `embeddings_complete` | embedding generation step |
| `processing` | safe fallback when genuinely unknown (also the sweep's `error_stage` value) |

Exact await anchors are taken from the existing `_publish_status_update` progress call sites in `process_document` (Definition F9); implementation copies each site's label to a tracker assignment immediately preceding that step.

## 5. Acceptance criteria (from the Definition, made testable)

1. **AC-1** — A failed job's published `details` contains `error_message` (actual message), `stage` (failing stage), `retryable` (derived) — none relying on rag-api fallbacks. *Verified by: worker-local handler-capture tests + integration key-set assertion.*
2. **AC-2** — After a failed job, the persisted document has `error` = actual message (not `"Processing failed"`), `error_stage` = failing stage (not `None`), `retryable` = worker-derived value. *Verified by: integration persistence assertions, both retryable polarities.*
3. **AC-3** — The `processing/summary` error subdocument carries the same message and stage as the main document. *Verified by: integration summary assertions.*
4. **AC-4** — The contract test exists, passes, and fails on payload-key drift on either side. *Verified by: the integration contract test + drift guards + legacy-shape negative control.*

## 6. Constraints (binding, from the Definition)

- **must** — align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema.
- **must_not** — no Firestore migration, field rename, or backfill; persisted names (`error`, `error_stage`, `retryable`) and semantics unchanged.
- **must** — every worker failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be operative for worker failures.
- **prefer** — retain the legacy `error` key alongside `error_message`.
- **prefer_not** — no structured error-code taxonomy; summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.

## 7. Non-goals

- The stale-lease sweep's direct failure write (already consistent; verified writing `retryable: true`).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend/mobile changes — `ResourceResponse` already exposes `error` and `error_stage` (verified); exposing `retryable` to clients is not in scope.
- Structured error codes / failure taxonomy.
- Anything the companion D3 issue covers beyond this payload alignment (content unavailable; deferred per F12).

## 8. Deferred and implementation-time unknowns

Preserved honestly from investigation limits; none block the design:

- **`classify_error` exact signature/return shape** — behavior is fixed by Definition F7 (transient/permanent heuristics, unknown → permanent); the direct read of `rag-worker-service/main.py` was not retained in detail. `_derive_retryable` adapts to the existing return shape without modifying `classify_error`.
- **`_publish_status_update` exact signature and envelope fields** — preserve all existing arguments; only the failed-case `details` dict changes.
- **Exact collaborator stub points for early/late stage tests** — finalize against `process_document` at implementation, using the existing progress call sites as the label source (worker conftest stub set already supports importing worker `main`).
- **CI invocation for `apps/ai-server/tests/integration`** — existing contract tests run there per `docs/TESTING-STRATEGY.md` (Phase 3); confirm the workflow job picks up the new test file.
- **Companion D3 issue content; `plans/upload-flow.md` deviation D4** — file not present in the current tree (verified: absent from `plans/`); deferred per F12.

## 9. Traceability

| Requirement | Definition facts | Acceptance | Test |
|---|---|---|---|
| FR-1 | F1, F2, F3, F4, F5, F11 | AC-1 | worker-local payload tests; integration key-set |
| FR-2 | F9 | AC-1, AC-2 | worker-local stage-tracking tests |
| FR-3 | F4, F5, F6 | AC-2, AC-3 | integration persistence + summary assertions |
| FR-4 | F7, F8 | AC-1, AC-2 | worker-local retryable-mapping tests |
| FR-5 | F10 | AC-4 | `tests/integration/test_rag_failure_contract.py` |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

## 1. Design principle

Fix the odd one out. The persisted failure schema (`error` / `error_stage` / `retryable`) is already written consistently by three other paths (worker stale-lease sweep, rag-api enqueue-failure paths) and read by two models (`Resource`, `ResourceResponse` — verified). Changing the API side would ripple across all of them; changing the worker's status publisher is a single-sided fix with no migration, no backfill, no reader changes. **rag-api production code does not change** — the contract is locked in by a test instead.

## 2. Current seam (verified)

```
rag-worker process_document          Pub/Sub                rag-api
┌──────────────────────────┐   rag-status-updates   ┌─────────────────────────────────┐
│ except → _publish_       │ ───────────────────►  │ _process_status_message          │
│ status_update(           │                       │   → run_transactional_update     │
│   "failed",              │                       │     failed branch reads:         │
│   details={"error":      │                       │       error_message → "Processing│
│     str(e)} )            │                       │       stage         → None       │
└──────────────────────────┘                       │       retryable     → True(default)│
                                                   │     persists error/error_stage/  │
                                                   │     retryable + processing/summary│
                                                   └─────────────────────────────────┘
```
Every worker failure lands as `"Processing failed"` / `None` / `True`. The envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`) is correct — verified against `_process_status_message` — only the `details` keys mismatch. The failed transition `processing → failed` is allowed by `ALLOWED_TRANSITIONS` (verified), and `failed → queued` exists for reprocessing flows.

## 3. Target design — worker changes only

### 3.1 New pure module: `rag-worker-service/failure_payload.py`

Dependency-free (stdlib only) so the cross-service contract test can import it without pulling worker `main`'s heavy dependency graph:

```python
FAILURE_DETAILS_KEYS = ("error_message", "stage", "retryable", "error")

def build_failure_details(error_message: str, stage: str, retryable: bool) -> dict:
    """Single anchor for the worker→rag-api failure details contract."""
    return {
        "error_message": error_message,   # primary — rag-api persists as `error`
        "stage": stage,                   # rag-api persists as `error_stage`
        "retryable": retryable,           # deliberately derived, never defaulted
        "error": error_message,           # legacy key retained (compat hedge, F11)
    }
```

The constant gives the drift guard one canonical worker-side key list.

### 3.2 `main.py` changes

1. **Stage tracker** in `process_document`:
   ```python
   current_stage = "processing"            # safe fallback (matches sweep's value)
   try:
       current_stage = "starting"
       ...                                  # each pipeline step:
       current_stage = "<step-label>"       # set IMMEDIATELY before the step's first await
       await <step>
   ```
   Labels copied from the existing `_publish_status_update` progress call sites (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`). Update-before-await is the convention; a future step added without updating the tracker reports a stale-but-non-null stage, and the representative-stage tests catch the tracker being removed or bypassed.

2. **Retryable derivation** (new small helper in `main.py`, wrapping — not modifying — `classify_error`):
   ```python
   def _derive_retryable(e: Exception) -> bool:
       # transient → True; permanent (incl. unclassified-unknown, classify_error's
       # conservative default) → False. Mirrors run_worker's ACK/NACK decision.
   ```

3. **Handler rewiring** — the exception handler replaces `details={"error": str(e)}` with:
   ```python
   details = build_failure_details(str(e), current_stage, _derive_retryable(e))
   ```
   All other `_publish_status_update` arguments (envelope, status `"failed"`) are preserved exactly as today. Progress updates are untouched.

### 3.3 rag-api changes

None. The failed branch already implements FR-3 once keys align (verified): `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`; summary `error = {code: "UNKNOWN", message, stage}`. The fallbacks stay in the code as the contract for non-conforming publishers; the negative-control test pins them deliberately.

## 4. Deliberate behavior change (callout)

Unclassified-unknown exceptions: previously persisted `retryable: true` (API silent default); now `false` (classify_error default = permanent). This is the conservatism `classify_error` was written for — it prevents infinite retry loops — and matches the worker's own ACK (no redelivery) decision. Manual reprocess via `POST /process` is unaffected. The stale-lease sweep keeps its direct `retryable: true` write (a dead worker is transient by nature) — verified unchanged in `test_processing_lease.py`.

## 5. Compatibility hedge

Only rag-api's status subscriber is a verified consumer of these payloads; other tooling may share the topic. The legacy `error` key is retained alongside `error_message` — one redundant string per failure as insurance. If a later audit confirms worker→rag-api is the only flow, dropping the duplicate is trivial cleanup (and will require touching the pinned key set in the contract test — by design).

## 6. Test architecture

### 6.1 Worker-local unit tests — `rag-worker-service/tests/unit/test_failure_reporting.py` (new)

Runs under the existing worker conftest (verified: full stub set + env defaults enabling `import main`):
- **Payload builder**: exact key set `== {"error_message", "stage", "retryable", "error"}`; `error == error_message`; values passed through verbatim.
- **Retryable mapping** (`_derive_retryable`): transient-classified → `True`; `PermanentError` → `False`; generic unclassified `Exception` → `False`.
- **Handler wiring + stage tracking**: monkeypatch `_publish_status_update` to capture payloads; stub a pipeline collaborator to raise (a) at the first step → assert `stage == "starting"`; (b) at a late step (e.g., embeddings) → assert the late vocabulary label; (c) with a transient vs. permanent exception → assert `retryable` polarity. Exact stub points are finalized against `process_document` at implementation, using existing progress call sites as anchors.

### 6.2 Cross-service contract test — `apps/ai-server/tests/integration/test_rag_failure_contract.py` (new; THE contract test)

**Import strategy** (driven by a verified constraint): both services have a `main.py` and a `models/` package, so both cannot be imported in one process under the default names without package shadowing. Therefore:
- **Worker side**: import `failure_payload.py` in-process via `importlib.util.spec_from_file_location` under a unique name — no sys.path games, no heavy imports, no collision. (Full-handler construction is covered by the worker-local tests in §6.1.)
- **API side**: reuse the existing scaffolding in `tests/integration/conftest.py` (verified: env defaults, MagicMock stubs, `sys.path` insertion, `import main as rag_api_main` pattern proven by `test_api_contracts.py`).

**Persistence harness** — adapted from the fake-transaction pattern proven in `rag-worker-service/tests/unit/test_processing_lease.py` (`FakeTx`/`FakeSnap`/`FakeRef`/`FakeCollection`/`FakeDb` + `_tx_identity`):
- `monkeypatch.setattr(rag_api_main.firestore, "transactional", lambda fn: fn)` — the decorator is applied inside `run_transactional_update`'s body on every call (verified), so patching before the call takes effect.
- `monkeypatch.setattr(rag_api_main.firestore, "SERVER_TIMESTAMP", "TS")` — sentinel recorded in fake writes, ignored by assertions.
- Fake `db.transaction()` returns a recording `FakeTx`; `doc_ref.get(transaction=…)` returns a snapshot with `status == "processing"` (so `processing → failed` is allowed); `doc_ref` carries `.id` and the `collection("processing").document("summary")` chain (adaptations to the borrowed fakes: `.id` attribute, kwargs-tolerant methods).
- Logger argument: a `MagicMock` (the shared conftest mocks `structlog`; the api code calls `logger.info(..., **kwargs)` which a stdlib logger would reject).

**Tests**:
1. `test_worker_failure_payload_persists_error_stage_retryable[transient]` — build details via `build_failure_details` with a transient-derived `retryable=True`; run `run_transactional_update(db, doc_ref, "failed", details, logger, user_id)`; assert persisted main doc `error == details["error_message"]` (≠ `"Processing failed"`), `error_stage == details["stage"]` (not `None`), `retryable is True`; assert summary `error.message`/`error.stage` equal the same values, `error.code == "UNKNOWN"`, top-level summary `stage == details["stage"]`.
2. Same for the permanent case (`retryable=False`) — covers both polarities of AC-2.
3. `test_worker_failure_payload_key_set_is_pinned` — exact key-set assertion (worker drift guard).
4. `test_rag_api_failed_branch_reads_pinned_keys` — AST guard on `rag-api-service/main.py`: within `run_transactional_update`'s failed branch, `details.get` calls include `"error_message"`, `"stage"`, `"retryable"`, and the persisted dict keys are `error`/`error_stage`/`retryable` (API drift guard; follows the AST/subprocess precedent in `test_api_contracts.py`'s `_get_agent_graph_shapes`, simplified to in-process `ast.parse` — no import needed).
5. `test_legacy_payload_shape_persists_fallbacks` (negative control) — feed `{"error": "boom"}`; assert `"Processing failed"` / `None` / `True`. Proves the harness detects the original mismatch and pins the fallbacks' existence for legacy publishers.

**Why fakes over the Firestore emulator**: deterministic, no emulator dependency in CI, and the fake shape is already proven against this exact transactional code style. Both services support `FIRESTORE_EMULATOR_HOST` hermetic modes (verified for rag-api startup; F10 for the worker) — an emulator-based end-to-end variant (subprocess through `process_document` → captured payload → real transactional update) is optional future hardening, not required.

### 6.3 CI placement

The new file lives beside `test_api_contracts.py` in `apps/ai-server/tests/integration/`, which runs in the cross-service/contract stage of the existing per-service test pipeline (`docs/TESTING-STRATEGY.md`, Phase 3). Implementation must confirm the workflow's pytest invocation covers the directory for the new file (unverified exact invocation).

## 7. Alternatives considered and rejected

- **Change rag-api to read `error`** — rejected: ripples across three write paths and two models; contradicts the must-constraint.
- **API-side derivation of retryable from a stage/message heuristic** — rejected: the worker already owns the classification (F7); deriving at the source keeps the record aligned with ACK/NACK.
- **Contextvar / stage-tracker class** — rejected as over-engineering; a local string set before each await is sufficient and obvious.
- **In-process import of both `main` modules** — rejected: `models` package-name collision between the two services (verified both ship `models/`); the pure-module + existing-conftest split avoids it.
- **Structured error codes** — rejected per prefer_not; `error.code` stays `"UNKNOWN"`.

## 8. Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and representative early/late-stage tests.
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope; manual reprocess remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard. Adding a key means touching the test.
- **Stub drift between the worker conftest and any future subprocess harness** — avoided in this design (no subprocess needed); if the optional emulator variant is added later, it must replicate the worker conftest stub set with a cross-reference comment.

## 9. Touched files

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/failure_payload.py` | **new** — pure payload builder + key constant |
| `apps/ai-server/rag-worker-service/main.py` | stage tracker, `_derive_retryable`, handler rewiring, import of builder |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_reporting.py` | **new** — builder, mapping, handler wiring, stage tracking |
| `apps/ai-server/tests/integration/test_rag_failure_contract.py` | **new** — the contract test + drift guards + negative control |
| rag-api-service (all), `models/resource.py`, sweep, workflows | **unchanged** (workflow verification only) |

## 10. Verification plan → acceptance criteria

| AC | Mechanism |
|---|---|
| AC-1 | §6.1 handler-capture + stage tests; §6.2 test 3 (key set) |
| AC-2 | §6.2 tests 1–2 (both retryable polarities) |
| AC-3 | §6.2 tests 1–2 (summary assertions) |
| AC-4 | §6.2 tests 3–5 (drift guards + negative control); §6.1 wiring tests |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>