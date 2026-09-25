Reformatted: the artifact content previously contained `###` sub-headings, which the parser mistook for section paths. All headings inside the artifact are now bold text lines; the only `###`-prefixed line is the required artifact path.

<<<SLE-OUTPUT>>>
### .sle/work/wi-define-108-a8/design.md
# Design: rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` · Step: design · Iteration: 1
Authoritative source: `definition:obj-108` (sha256 `71f1c39c…`), resolved and pinned by the system. This design implements exactly that Definition; nothing here widens, narrows, or reinterprets it.

**1. Scope (binding, from the Definition)**

The worker's failed status payload must carry `error_message`, `stage`, and `retryable` — aligned to rag-api's existing failed-branch contract — with stage tracked through `process_document`, retryable derived deliberately from `classify_error`, the legacy `error` key retained as a hedge, and a contract test pinning the worker→rag-api failure seam. No Firestore migration, no rag-api schema/reader changes, no error-code taxonomy, no retry-mechanics changes.

**2. Verified evidence base (design inputs)**

All claims below were verified by reading the current tree:

| # | Fact | Where verified |
|---|------|----------------|
| V1 | Worker publishes failure with a one-key payload: `_publish_status_update(..., "failed", {"error": str(e)}, job_id)` | `rag-worker-service/main.py`, `process_document` except-handler |
| V2 | Progress publishes use stage labels `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, final `completed` | `rag-worker-service/main.py`, `process_document` |
| V3 | `classify_error(e)` returns bool (True=transient); unknown exceptions → `False` (conservative permanent); uses `TransientError`/`PermanentError`, httpx types, status-code heuristics | `rag-worker-service/main.py` |
| V4 | rag-api failed branch: `error ← details.get("error_message", "Processing failed")`, `error_stage ← details.get("stage")`, `retryable ← details.get("retryable", True)`; summary subdoc gets `error: {code: details.get("error_code","UNKNOWN"), message: details.get("error_message","Processing failed"), stage: details.get("stage")}` and top-level `stage: details.get("stage","unknown")`, `progress: details.get("progress",0)` | `rag-api-service/main.py`, `run_transactional_update` |
| V5 | Failed transition is allowed only from `processing` (`ALLOWED_TRANSITIONS`) | `rag-api-service/main.py` |
| V6 | Stale-lease sweep writes `error` / `error_stage="processing"` / `retryable=True` directly | `rag-worker-service/main.py`, `_fail_if_still_stale` |
| V7 | `Resource` model + `ResourceResponse` expose `error`, `error_stage` (retryable defaults `True` on the model) | `rag-api-service/models/resource.py`, `rag-api-service/main.py` |
| V8 | Enqueue-failure paths write `error`/`error_stage="enqueue"` | `rag-api-service/main.py` (`/process`, `POST /resources`) |
| V9 | Shared integration conftest mocks firebase/google modules and puts `rag-api-service` on `sys.path`; `test_api_contracts.py` imports `main as rag_api_main` and is pure static/fixture-based (no emulator) | `tests/integration/conftest.py`, `tests/integration/test_api_contracts.py` |
| V10 | The cross-service CI job installs **only** `rag-api-service` + `agent-graph-service` requirements and runs an **explicit file list** including `tests/integration/test_api_contracts.py` | `.github/workflows/backend-tests.yml`, `cross-service-and-contract-tests` |
| V11 | Worker unit tests import the heavy `main` module successfully via a stubbing conftest; fake Firestore harness pattern exists (`FakeDb/FakeTx/FakeRef` + `firestore.transactional` identity-patched) | `rag-worker-service/tests/conftest.py`, `tests/unit/test_processing_lease.py` |
| V12 | Worker `main.py` has import-time side effects (`os.environ["GCP_PROJECT"]`, `service_account.Credentials.from_service_account_file`, `SubscriberClient`) and heavy top-level imports (`langchain`, `spacy`, `sklearn`, `openai`, `tiktoken`) | `rag-worker-service/main.py` module level |
| V13 | `_publish_status_update` passes `details` through verbatim (injecting `jobId` when absent) and wraps it in the envelope `{user_id, course_id, resource_id, status, details, timestamp, sequence}` | `rag-worker-service/main.py`, `_publish_status_update` |
| V14 | Worker has an unrelated legacy `exceptions.py` (`PDFProcessingError.retryable` metadata) — **not** used by the `process_document` failure path; the Definition mandates `classify_error` as the derivation source, so it stays untouched | `rag-worker-service/exceptions.py` |

Consequence of V12 + V10 (design-shaping): the cross-service contract test **cannot** import worker `main` (spacy/sklearn/langchain are not installed in that job). The failure-payload construction must therefore live in a dependency-light module.

**3. Architecture**

**3.1 Data flow (unchanged topology, aligned payload)**

```
process_document (exception)
  └─ build_failure_details(e, current_stage)          # worker, pure function
       → {"error_message", "error", "stage", "retryable"}
  └─ _publish_status_update(..., "failed", details)   # unchanged plumbing (V13)
       → Pub/Sub rag-status-updates
         → rag-api _process_status_message (unchanged)
           → run_transactional_update failed branch (unchanged reads, V4)
             → main doc: error / error_stage / retryable
             → processing/summary: error{code,message,stage}, stage
```

**rag-api requires zero production changes.** Verified (V4): its failed branch already persists exactly what Requirement 3 mandates once the worker sends the right keys. The contract test pins its behavior; if a future edit drifts its reads, the test fails.

**3.2 Worker change 1 — extract a light contract module**

New file `rag-worker-service/failure_payload.py` containing, moved verbatim from `main.py`:

- `ProcessingError`, `TransientError`, `PermanentError`
- `classify_error(e) -> bool`
- `UNKNOWN_STAGE = "processing"` (same value the sweep uses for `error_stage`, V6)
- New pure function:

```python
def build_failure_details(error: Exception, stage: Optional[str] = None) -> Dict[str, Any]:
    message = str(error).strip() or type(error).__name__   # see note below
    return {
        "error_message": message,
        "error": message,                 # legacy hedge (F11) for unknown topic consumers
        "stage": stage or UNKNOWN_STAGE,  # never None
        "retryable": classify_error(error),  # deliberate derivation, never defaulted
    }
```

Imports: stdlib + `httpx` only. This module is the **producer half of the contract** and is the unit the cross-service test imports.

Empty-message note (small judgment call, flagged for review): `str(e)` can be `""` (e.g. `raise ValueError()`); the API's fallback only fires when the key is *missing*, so an empty string would persist as `error: ""` — indistinguishable noise, contrary to F1's disambiguation intent. Coalescing to the exception type name keeps the value truthful and non-empty. Implementers may drop this if reviewers prefer raw `str(e)`.

`main.py` re-exports for compatibility (no external-consumer breakage, V14-style):

```python
from failure_payload import (ProcessingError, TransientError, PermanentError,
                             classify_error, build_failure_details)
```

`run_worker`'s `classify_error` call site keeps working unchanged.

**3.3 Worker change 2 — stage tracker in `process_document`**

A local `current_stage` in `process_document`, following the convention **"set the tracker immediately before the await"** (the Definition's chosen mechanism and its named drift risk):

| Code point | `current_stage` value |
|---|---|
| Initialization (before `try`) | `"processing"` (safe value; failure genuinely has no stage — e.g. during `_validate_processing_request`) |
| Immediately before the initial `{"stage": "starting"}` publish | `"starting"` |
| Before `_get_extracted_text` | `"text_retrieved"` |
| Before `content_tagger.generate_tags` | `"tagging_complete"` |
| Before summary generation | `"summary_generated"` |
| Before `_create_enhanced_chunks` | `"chunking_complete"` |
| Before `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |
| Post-embedding tail (`delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save, usage, map) | inherits `"embeddings_complete"` — no new labels (vocabulary constraint) |

Semantics note (accepted by the Definition): labels are stage *identifiers*, not tense-bearing — a failure during tagging reports `tagging_complete`. A pipeline step added without updating the tracker reports the previous stage; the contract test pins representative early/late stages to catch tracker removal or bypass.

**3.4 Worker change 3 — failure handler wiring**

In `process_document`'s `except` block (everything else in the handler — `metrics.error_message`, trace update, logging — stays):

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    details = build_failure_details(e, current_stage)
    self.logger.error("document_processing_failed", user_id=user_id,
                      course_id=course_id, resource_id=resource_id,
                      error=str(e), stage=details["stage"],
                      retryable=details["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id,
                                      "failed", details, job_id)
    ...
```

**3.5 retryable semantics (Requirement 4, F8 — binding)**

`retryable = classify_error(e)` — the same function driving ACK/NACK in `run_worker`, so the persisted record matches actual redelivery behavior:

- `TransientError`, httpx connect/timeout types, `ConnectionError`/`TimeoutError`, HTTP 429/500/502/503/504 → `True`
- `PermanentError`, other 4xx, and **unclassified-unknown (conservative default)** → `False`

Deliberate behavior change (from the Definition): unclassified-unknown exceptions previously persisted the silent default `True`; they now persist `False`. Manual reprocess via `POST /process` (`failed → queued` transition, V5) is unaffected. The sweep's separate `retryable=True` write stays correct and untouched (non-goal).

**3.6 Compatibility hedge (F11)**

The legacy `error` key is retained alongside `error_message` (one redundant string per failure message). Only rag-api's subscriber is a verified consumer; if a later audit confirms the worker is the sole publisher, dropping the duplicate is trivial cleanup — explicitly *not* in this scope.

**4. Test architecture**

**4.1 Worker unit tests — `rag-worker-service/tests/unit/`**

New `test_failure_payload.py` (imports the light module; runs under the worker's pytest config, V11 conftest applies):

- Key-set + value shape of `build_failure_details` (exact keys, hedge key present).
- retryable mapping: `TransientError→True`, `PermanentError→False`, `ValueError (unknown)→False` (conservative), `httpx.ConnectError→True`, `httpx.HTTPStatusError` 429→`True` / 400→`False`.
- Empty-message coalescing (if kept).
- Stage fallback: `build_failure_details(e, None)` → `stage == "processing"`.

New stage-tracker/handler tests (import heavy `main` — fine in the worker leg):

- Stub `_get_extracted_text` to raise → captured failed publish has `error_message` = stub message, `stage == "text_retrieved"`, `retryable is False`, plus legacy `error` key. (`_publish_status_update` monkeypatched to capture; seed fake doc status `processing`.)
- Stub `store_chunks_via_service` to raise `httpx.ConnectError` → `stage == "embeddings_complete"`, `retryable is True` (late-stage pin).
- Failure before any tracker set (stub `_validate_processing_request` to raise) → `stage == "processing"`.

**4.2 Cross-service contract test — seam pin (Requirement 5 / acceptance 4)**

**Location: new classes inside existing `tests/integration/test_api_contracts.py`.** Rationale (verified constraints, V9/V10): the cross CI job runs that file by explicit name with rag-api deps installed — adding tests there requires **no workflow edit**, no emulator, and no new dependency decisions. (A separate file would require editing the workflow's explicit pytest file list and trusting the unread `ci-detect-changes.sh` cross flag — rejected for this iteration.)

Structure — **imports both sides; restates nothing**:

1. **Producer half**: import `failure_payload` from `rag-worker-service` **via `importlib.util.spec_from_file_location` with an explicit file path — never via `sys.path` insertion**. Verified pitfall: the shared conftest puts `rag-api-service` first on `sys.path` for `from models.resource import …`; inserting the worker dir would shadow `models` with the worker's `models` package (which has no `resource.py`) and break the module's existing imports. Path-based import is immune.
2. **Consumer half**: `rag_api_main.run_transactional_update` against local fakes (self-contained in the test module; same shape as the proven harness in `test_processing_lease.py`, V11): fake `db/doc_ref/tx/snapshot` supporting `get(transaction=…)`, `transaction.update`, `doc_ref.collection("processing").document("summary")`, `transaction.set(..., merge=True)`; seed doc `status="processing"` (failed transition requires it, V5); `monkeypatch` `rag_api_main.firestore.transactional` to identity and `SERVER_TIMESTAMP` to a sentinel.
3. **Round-trip assertions** (parametrized over a transient and a permanent/unknown exception): persisted main doc `error == message` (≠ `"Processing failed"`), `error_stage == stage` (≠ `None`), `retryable == derived` — the permanent case asserting `False` also proves the value came from the payload, not the API's `True` fallback; summary subdoc `error.message`/`error.stage` equal the main doc's, `error.code == "UNKNOWN"`; summary `stage` equals payload stage.
4. **Drift guards — the point of the test**:
   - Producer: exact key set of `build_failure_details(...)` == `{"error_message", "error", "stage", "retryable"}`. Adding/removing a key here fails the build.
   - Consumer: pass a `dict` subclass whose `get` records accessed keys into `run_transactional_update`'s failed branch; assert `{"error_message", "stage", "retryable"} ⊆ recorded`. If rag-api renames a read, this fails.

This satisfies the Definition's "Firestore emulator **or fakes**" option; the house pattern is fakes (V9), so fakes it is.

**4.3 Acceptance criteria → coverage map**

| Acceptance (Definition) | Covered by |
|---|---|
| 1. Worker failure payload carries error_message/stage/retryable, no API fallbacks relied on | Worker unit handler tests + producer key-set guard |
| 2. Persisted error = actual message, error_stage = failing stage, retryable = derived | Contract test round-trip assertions (both retryable polarities) |
| 3. processing/summary error subdoc carries same message and stage | Contract test summary assertions |
| 4. Contract test exercises construction → failed-branch persistence and fails on key drift | `test_api_contracts.py` new classes (4.2) |

**4.4 Validation commands**

```bash
python3 -m pytest apps/ai-server/rag-worker-service/tests/unit/ -v --tb=short
python3 -m pytest apps/ai-server/tests/integration/test_api_contracts.py -v --tb=short
./dev/run ai-server   # note: health-checks only (verified collector); pytest above is the real signal
```

**5. Risks & mitigations**

- **Unknown consumers of the status topic** reading the old key set → mitigated by retaining `error` (F11); residual risk accepted as low (Definition's position).
- **Stage-tracker drift** as the pipeline evolves → update-before-await convention documented at the tracker; early/late representative pins in tests.
- **`retryable=false` for unrecognized-transient failures** → accepted by the Definition; `classify_error` widening is out of scope; `POST /process` remains.
- **Contract test ossifies the payload** → intentional drift guard (Definition).
- **Cross-job import feasibility** → solved by the light-module extraction (V10/V12) + importlib-by-path (4.2). Residual assumption to verify at implementation: `httpx` present in `rag-api-service/requirements.txt` (inferred from `main.py` importing it in a service that runs — V10 installs only that service's reqs). If absent, add `httpx` to the cross job's pip line (one-line workflow change; escalate per AGENTS.md if that breaks the small-change criteria).
- **`ci-detect-changes.sh` unread** → adding to the already-executed `test_api_contracts.py` sidesteps cross-flag detection entirely; worker unit leg is an established per-service matrix (V11). Verify detection fires for `rag-worker-service/tests/**` at implementation time.

**6. Out of scope (non-goals, restated from the Definition)**

Sweep's direct failure write; ACK/NACK/lease/heartbeat mechanics; frontend/mobile (`ResourceResponse` already exposes `error`/`error_stage`); structured error codes (`error.code` stays `"UNKNOWN"`; worker sends no `error_code`); the legacy `exceptions.py` taxonomy (V14 — untouched, unused by this path); companion D3 issue content and `plans/upload-flow.md` reconciliation (D4) — unavailable/deferred per the Definition.

**7. Implementation outline (single small-change-style PR)**

Branch `fix/rag-worker-failure-payload-contract`:

1. `rag-worker-service/failure_payload.py`: move exception classes + `classify_error`; add `UNKNOWN_STAGE`, `build_failure_details`.
2. `rag-worker-service/main.py`: re-export; add `current_stage` tracker per 3.3; wire handler per 3.4.
3. Worker unit tests (4.1).
4. Contract test classes in `tests/integration/test_api_contracts.py` (4.2). No rag-api production edits.
5. Run 4.4; verify CI legs trigger as expected.
6. `rag-api-service` diff: **none expected** — any change found necessary there is a deviation from the Definition's constraint and must stop for review.

No data-model change, no migration/backfill, no new runtime dependencies (modulo the §5 httpx check), no client-facing shape change — persisted field names and semantics unchanged.
<<<END-SLE-OUTPUT>>>