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