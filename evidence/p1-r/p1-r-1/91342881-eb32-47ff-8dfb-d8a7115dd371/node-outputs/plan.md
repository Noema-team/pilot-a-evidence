<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

- WorkItem: `wi-define-108-a8` (authoritative Definition artifact, sha256 `71f1c39c…89cac5`)
- Intent: rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage
- Run: 91342881-eb32-47ff-8dfb-d8a7115dd371, iteration 1

## 1. Problem (verified)

- `apps/ai-server/rag-worker-service/main.py` — `process_document`'s exception handler publishes the failed status with a one-key payload: `_publish_status_update(..., "failed", {"error": str(e)}, job_id)`.
- `apps/ai-server/rag-api-service/main.py` — the failed branch of `run_transactional_update` reads `details["error_message"]`, `details["stage"]`, `details["retryable"]`, persists `error` / `error_stage` / `retryable` on the main resource document, and writes message/stage (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` subdocument.
- Net effect today: every worker-originated failure persists `error = "Processing failed"` (fallback), `error_stage = None`, `retryable = True` (silent default); the summary subdocument inherits the same fallbacks with `error_code = "UNKNOWN"`.
- The other write paths already speak the persisted schema: the worker's stale-lease sweep `_fail_if_still_stale` (writes `error` / `error_stage="processing"` / `retryable=True`), rag-api's enqueue-failure paths, and the `Resource` model (`models/resource.py`: `error`, `error_stage`, `retryable: bool = True`). The worker's status publisher is the only non-conforming writer.

## 2. Scope bounds

In scope:
1. Worker failure payload: `error_message`, `stage`, `retryable` (plus legacy `error` retained).
2. Stage tracking through `process_document`.
3. `retryable` derived from `classify_error(e)`.
4. Contract test on the worker→rag-api failure path + key-drift guard.

Out of scope (Definition nonGoals): stale-lease sweep behavior; ACK/NACK, lease, heartbeat mechanics; frontend; structured error-code taxonomy; the companion D3 issue's content; reconciling with the D4 note in `plans/upload-flow.md` (file not present in tree).

**rag-api-service production code: zero changes.** The worker aligns to the API's existing reads and persisted schema (constraint: no migration, rename, or backfill).

## 3. Design decisions

### D1 — Worker aligns to rag-api
The persisted field names (`error`/`error_stage`/`retryable`) are consistent across three write paths and two response models; the worker's publisher is the sole outlier. Fixing the worker touches one file; fixing the API would ripple. No reader changes.

### D2 — Stage tracker semantics
- A local `current_stage` in `process_document`, initialized to `"processing"` — the safe value for a genuinely unknown stage, and the same string the stale-lease sweep uses for `error_stage`, so the field never regresses to null.
- Convention: **set the tracker immediately before the awaited pipeline step**, to the progress-vocabulary milestone that step works toward. Vocabulary is exactly the existing progress-stage names: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.

Assignment table (insertion points verified against current source):

| # | Insert immediately before | Assignment | Failure coverage |
|---|---|---|---|
| 0 | first statement inside `try` | `current_stage = "starting"` | `_validate_processing_request` |
| 1 | `await self._get_extracted_text(...)` | `"text_retrieved"` | retrieval/extraction (GCS download, marker/pypdf) |
| 2 | `await self.content_tagger.generate_tags(...)` | `"tagging_complete"` | tagging |
| 3 | `await self.generate_document_summary(...)` | `"summary_generated"` | summary LLM call + `ragDescription` Firestore write |
| 4 | `await self._create_enhanced_chunks(...)` | `"chunking_complete"` | chunking |
| 5 | `await self._generate_embeddings_with_openrouter(chunks)` | `"embeddings_complete"` | embedding generation |
| — | post-embeddings steps (`delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, final publish, `_update_user_usage`, `_generate_resource_map`) | no re-assignment — tracker holds `"embeddings_complete"` | vector storage / finalization |

Rationale for row "—": the vocabulary has no vector-storage milestone; holding the last reached milestone is truthful ("embeddings had completed") and aligns `error_stage` with the last progress event clients saw. Introducing a new stage name would extend the vocabulary beyond the Definition's pinned set.

Do **not** use `models/processing_status.ProcessingStage` (the legacy StatusUpdater vocabulary, e.g. `PDF_DOWNLOAD`) — that is a different, older status system; the Definition pins the `main.py` progress vocabulary.

Drift risk & mitigation: new pipeline steps must follow the set-before-await convention; the contract test pins the mechanism on an early-stage and a late-stage failure.

### D3 — retryable derivation
- `retryable = classify_error(e)` — the same function that drives ACK/NACK in `run_worker` (transient → NACK/redeliver; permanent → ack). Transient → `True`; permanent, including unclassified-unknown (classify_error's conservative default), → `False`.
- Explicitly **not** `RetryHandler.is_retryable_error` (`utils/retry_handler.py`) and **not** `PDFProcessingError.retryable` (`exceptions.py`) — separate mechanisms; the Definition pins `classify_error`.
- Deliberate behavior change: permanent-classified and unclassified-unknown exceptions now persist `retryable=false` (previously the silent default `true`). Accepted per Definition F8; manual reprocess via `POST /process` is unaffected. Transient failures unchanged (`true`). The stale-lease sweep keeps writing `retryable=True` directly (a dead worker is a transient condition) — unchanged.

### D4 — Legacy `error` key retained (compat hedge)
The payload carries both `error_message` and `error` (same string). rag-api ignores `error`; unknown consumers of the status topic keep working. Cost: one redundant string per failure message. Drop later only after a consumer audit confirms the worker is the only publisher.

### D5 — Extract payload construction into a testable helper
New module-level function in `rag-worker-service/main.py`, placed adjacent to `classify_error`:

```python
def build_failure_details(exc: Exception, stage: str) -> Dict[str, Any]:
    """Failed-status details payload (consumed by rag-api's failed branch)."""
    message = str(exc)
    return {
        "error_message": message,   # rag-api persists as `error`
        "error": message,           # legacy key retained for unknown topic consumers
        "stage": stage,             # rag-api persists as `error_stage`
        "retryable": classify_error(exc),
    }
```

Module-level (not a method) so contract tests can exercise it without constructing `EnhancedDocumentProcessor`. Single source of truth for the payload shape; the `except` block calls it with the tracker value.

## 4. Changes by file

### 4.1 `apps/ai-server/rag-worker-service/main.py` (only production file touched)
1. Add `build_failure_details` (D5) next to `classify_error`.
2. `process_document`: add `current_stage = "processing"` before the `try`; add the assignments per table D2.
3. `process_document` except block:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    failure_details = build_failure_details(e, current_stage)
    self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                      resource_id=resource_id, error=str(e), stage=current_stage,
                      retryable=failure_details["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id, "failed",
                                      failure_details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

Everything in `_publish_status_update` is untouched and keeps working: `jobId` injection into details, sequence numbering and reset on terminal states, lease-heartbeat write. rag-api's failed branch ignores unknown detail keys.

### 4.2 `apps/ai-server/rag-api-service/` — no production changes
The failed branch already implements the required persistence (F4). The contract test imports/exercises it; nothing else changes.

### 4.3 Tests
- `apps/ai-server/tests/integration/test_api_contracts.py`: add round-trip contract tests and the AST drift guard (see docs/test-plan.md).
- `apps/ai-server/rag-worker-service/tests/`: unit tests for `build_failure_details` and stage tracking (placement per existing layout — test plan §7).

## 5. Resulting contract (single table)

| details key | producer (worker) | consumer (rag-api failed branch) | persisted as |
|---|---|---|---|
| `error_message` | `str(e)` | `details.get("error_message")` | main doc `error`; summary error message |
| `stage` | stage tracker | `details.get("stage")` | main doc `error_stage`; summary error stage |
| `retryable` | `classify_error(e)` | `details.get("retryable", True)` — fallback now dead for worker failures | main doc `retryable` |
| `error` | `str(e)` (legacy hedge) | not read | — |
| `jobId` | injected by `_publish_status_update` | not read by failed branch | — |
| summary `error_code` | not sent (prefer_not: no taxonomy) | defaults | `"UNKNOWN"` |

Note: `retryable=False` must survive the API's `.get("retryable", True)` — a present `False` is not the missing case, so it passes through unchanged. The contract test pins this with an identity assertion (`is False`), guarding against a future `or True`-style coercion bug.

## 6. Implementation order (each step gated)

1. **Worker change** — helper + stage tracker + except-block rewire. Gate: worker unit tests (T1/T2 in test plan) pass.
2. **Worker unit tests** — `build_failure_details` derivation mapping and stage passthrough; `process_document` stage tracking with fakes (early/late/start failure).
3. **Contract round-trip tests** — confirm `run_transactional_update`'s exact call signature and the subscriber's message shape from `rag-api-service/main.py`, and the hermetic harness pattern from `tests/integration/conftest.py` / `test_api_contracts.py` (see §9); implement the emulator/fake round-trip.
4. **AST drift guard** in `test_api_contracts.py`.
5. **Full verification** — worker pytest suite, rag-api suite, `tests/integration`; informational search for other `rag_status_topic` subscribers to validate the F11 hedge assumption (no code change expected either way).

## 7. Acceptance criteria mapping

| Acceptance (Definition) | Satisfied by |
|---|---|
| A1: failed payload carries error_message/stage/retryable, no fallback reliance | §4.1 change; T1, T2 |
| A2: persisted error = actual message, error_stage = failing stage, retryable = derived | T3 main-document assertions (incl. retryable=False case) |
| A3: summary subdocument carries the same message/stage | T3 subdocument assertions |
| A4: contract test exists, passes, fails on key drift | T3 (dynamic drift detection) + T4 (static drift guard) |

## 8. Risks / tradeoffs (from Definition, with mitigations)
- Unknown status-topic consumers reading the old key set → legacy `error` retained; residual risk accepted as low; consumer audit in step 5 is informational only.
- Stage-tracker drift as the pipeline evolves → set-before-await convention + representative-stage test coverage.
- `retryable=false` for unrecognized-but-transient failures → accepted; widening `classify_error` is out of scope; `POST /process` manual reprocess remains.
- The contract test ossifies the payload → intentional; that is the drift guard doing its job.

## 9. Open items to confirm at implementation time (not invented — unverified in this investigation)
1. Exact signature of `run_transactional_update` and how the status subscriber invokes it (`rag-api-service/main.py`; behavior pinned by Definition F4, signature not read here).
2. Exact key spellings inside the `processing/summary` error subdocument (Definition pins message/stage/error_code semantics, not spellings).
3. Which hermetic mechanism (`FIRESTORE_EMULATOR_HOST` vs fakes) the existing `tests/integration` harness uses, and its fixture names (`test_api_contracts.py` exists; contents not read here).
4. Worker unit-test placement/layout under `rag-worker-service/tests/`.
5. Verified constraint, handling unknown: importing the worker module has import-time side effects — module-level `GCP_PROJECT = os.environ["GCP_PROJECT"]` and a service-account JSON load from `GOOGLE_APPLICATION_CREDENTIALS` (subscriber init). Tests importing the module must supply env vars and a fixture credential file; follow existing worker-test precedent if present, otherwise add a minimal fixture service-account JSON.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker→rag-api failure payload contract

- WorkItem: `wi-define-108-a8`; companion to docs/plan.md
- Goal: pin the worker failure → rag-api persistence seam and guard both sides against key drift.

## 1. Objectives
1. End-to-end seam: worker failure-payload construction → rag-api failed-branch persistence; persisted `error`, `error_stage`, `retryable` must equal the worker's values.
2. Drift guard: a key change on either side fails the build instead of silently re-creating the fallback bug.
3. Pin the retryable derivation table (`classify_error` → payload) and the stage-tracker mechanism.
4. No regression in existing suites.

## 2. Strategy
Import both sides; never restate the contract in a fixture. Two complementary layers:
- **Dynamic round-trip (primary drift detection):** a renamed key on either side makes a persisted value fall back (`"Processing failed"` / `None` / `True`) → the value assertion fails and names the drifted field.
- **Static AST guard (diagnosability):** tells you *which* side drifted without running anything.

House pattern: `apps/ai-server/tests/integration/test_api_contracts.py` (exists; fixture- and AST-based static contract tests per Definition F10 — reuse its fixtures/conventions; contents to be consulted at implementation, see §7).

## 3. Harness prerequisites (verified constraints)
- **Worker module import side effects:** `rag-worker-service/main.py` reads `GCP_PROJECT` from `os.environ` and loads a service-account JSON from `GOOGLE_APPLICATION_CREDENTIALS` at import time (module-level subscriber init). Tests importing it must set env and point `GOOGLE_APPLICATION_CREDENTIALS` at a fixture service-account JSON — or reuse existing worker-test precedent if one exists (§7 U5).
- **Firestore hermetic mode:** both services have `FIRESTORE_EMULATOR_HOST` branches (worker's `_init_services` verified in source; rag-api per F10). Use the existing integration harness (emulator or fakes, per conftest).
- **Pub/Sub not required:** tests capture the payload by patching `EnhancedDocumentProcessor._publish_status_update` to record `(status, details)` calls. This also skips the lease-heartbeat write inside `_publish_status_update`, which is irrelevant under test.
- **rag-api side:** invoke the failed branch of `run_transactional_update` directly with a message dict shaped like the worker's verified `message_data` (`{user_id, course_id, resource_id, status, details, timestamp, sequence}`). Exact parameter names confirmed from rag-api source at implementation time (§7 U1); the *behavior* (keys read, fields persisted, summary subdocument, `error_code` default) is pinned by the authoritative Definition.

## 4. Test inventory

### T1 — `build_failure_details` unit tests (worker)
Location: worker tests directory (new or existing file per layout, §7 U4).
- **T1.1 transient:** `httpx.ConnectError("connection reset")` → `retryable is True`; `error_message` and legacy `error` both `"connection reset"`; `stage` passed through.
- **T1.2 permanent:** `ValueError("bad input")` → `retryable is False`.
- **T1.3 unclassified-unknown:** `RuntimeError("weird")` → `retryable is False` (conservative default pinned — this is the deliberate behavior change).
- **T1.4 explicit subclasses:** `TransientError(...)` → `True`; `PermanentError(...)` → `False`.
- **T1.5 safe stage value:** `stage="processing"` accepted and passed through unchanged.
- **T1.6 key set:** produced keys ⊇ `{error_message, error, stage, retryable}` (legacy `error` presence pinned deliberately).
- **T1.7 (optional) status-code heuristics at the derivation boundary:** `httpx.HTTPStatusError` with 429 → `True`; with 404 → `False`.

### T2 — `process_document` stage tracking (worker, fakes)
Construct the processor without real services: `object.__new__(EnhancedDocumentProcessor)` (or patch `_init_services`) plus attribute injection; patch `_publish_status_update` to capture calls.
- **T2.1 early failure:** patch `_get_extracted_text` to raise `TransientError("network blip")` → captured failed update: `status == "failed"`, `stage == "text_retrieved"`, `retryable is True`, `error_message == "network blip"`, legacy `error` present; `metrics.error_message == "network blip"`.
- **T2.2 late failure:** patch `_get_extracted_text` → `("text", {})`, `content_tagger.generate_tags` → `([], {})`, `generate_document_summary` → `None`, fake db for the `ragDescription` update, `_create_enhanced_chunks` → `[]`, then `_generate_embeddings_with_openrouter` raises `PermanentError("bad request")` → `stage == "embeddings_complete"`, `retryable is False`.
- **T2.3 start failure:** `_validate_processing_request` raises → `stage == "starting"`.
- **T2.4 (implicit tracker guard):** if the tracker assignments are removed or bypassed, the T2.1/T2.2 stage assertions fail — this is the representative early/late-stage pin the Definition requires.

### T3 — Round-trip contract tests (`tests/integration/test_api_contracts.py`)
Setup: hermetic Firestore (emulator or fakes per existing conftest); seed a resource document at `users/{uid}/resources/{rid}` with `status: "processing"` (the state the worker's claim flow leaves; confirm the failed branch's exact preconditions from rag-api source, §7 U1).
- **T3.1 transient round-trip:** run a T2.1-style worker failure → capture the failed details → feed the message through rag-api's failed branch → assert main document: `error == "network blip"` (≠ `"Processing failed"`), `error_stage == "text_retrieved"` (≠ `None`), `retryable is True`.
- **T3.2 permanent round-trip:** T2.2 payload → `error == "bad request"`, `error_stage == "embeddings_complete"`, `retryable is False` — identity assertion (`is False`), catching any future truthy-coercion bug such as `details.get("retryable") or True`.
- **T3.3 summary subdocument:** after T3.1/T3.2, the `processing/summary` error carries message == the worker's message and stage == the worker's stage, and `error_code == "UNKNOWN"` (worker sends no code — prefer_not honored). Exact subdoc key spellings confirmed from source (§7 U2).
- **T3.4 pure round-trip variant (fast):** `details = build_failure_details(exc, stage)` fed directly through the failed branch — same assertions for both retryable polarities; keeps the seam covered cheaply without pipeline fakes.
- Document in the test body: any rename on either side flips a persisted value to its fallback, so the value assertions are the drift detector.

### T4 — AST drift guard (static, same file)
- Parse `rag-worker-service/main.py`: extract the keys of the failure-payload dict in `build_failure_details` → set **W**.
- Parse `rag-api-service/main.py`: extract the `details.get("<key>", ...)` literals inside the failed branch → set **R**.
- Assert **R ⊆ W** — every key the API reads must be produced by the worker; a missing key is exactly what silently re-creates this bug.
- Assert `{error_message, stage, retryable} ⊆ R` and `⊆ W`; assert `"error" ∈ W` (legacy hedge deliberately pinned; removing it later means touching this test on purpose).
- If rag-api gains a new required details key later, the guard fails until the worker produces it — the intended ossification.

### T5 — Regression
- Worker suite (per `rag-worker-service/pytest.ini`), rag-api suite, and `tests/integration` all green.
- `_fail_if_still_stale` untouched (nonGoal) — no new test; behavior unchanged.

## 5. Acceptance mapping

| Acceptance (Definition) | Tests |
|---|---|
| A1 payload completeness (error_message/stage/retryable, no fallback reliance) | T1.6, T2.1–T2.3 |
| A2 persisted fields correct | T3.1, T3.2 |
| A3 summary subdocument carries same message/stage | T3.3 |
| A4 contract test exists, passes, fails on key drift | T3.1–T3.4, T4 |

## 6. Execution
- Worker unit tests: run via the worker's pytest configuration (`rag-worker-service/pytest.ini`).
- Contract tests: `pytest apps/ai-server/tests/integration/test_api_contracts.py` (with the harness's emulator/fake setup invoked the same way existing integration tests do).
- Full gate before completion: worker suite + rag-api suite + `tests/integration` directory.
- Exact invocations follow existing CI/scripts conventions — confirm at implementation.

## 7. Unknowns to resolve at implementation time (not invented — unverified in this investigation)
- **U1:** `run_transactional_update` signature and the subscriber's invocation shape (behavior pinned by Definition F4; signature not read here).
- **U2:** exact key spellings inside the `processing/summary` error subdocument.
- **U3:** existing harness mechanism (emulator vs fakes) and fixture names in `tests/integration/conftest.py` / `test_api_contracts.py`.
- **U4:** worker unit-test directory layout/conventions under `rag-worker-service/tests/`.
- **U5:** how existing tests satisfy the worker module's verified import-time env/credential requirements (module-level `GCP_PROJECT` read + service-account load); if no precedent exists, add a fixture service-account JSON and env fixture.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>