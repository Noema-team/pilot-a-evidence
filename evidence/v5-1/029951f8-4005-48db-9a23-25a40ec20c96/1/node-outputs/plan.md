<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan: Align rag-worker failure payload with rag-api failed-branch contract

Run: 029951f8-4005-48db-9a23-25a40ec20c96
Authority: WorkItem `wi-define-108-a8` (Definition artifact pinned at sha256 `71f1c39c…`)

## 1. Problem (verified)

- rag-worker `process_document` (apps/ai-server/rag-worker-service/main.py, exception handler at end of method) publishes failed status with details `{"error": str(e)}` — the only failure writer that does not speak the `error_message`/`stage`/`retryable` contract.
- rag-api `run_transactional_update` failed branch (apps/ai-server/rag-api-service/main.py) reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`, persists them as `error`/`error_stage`/`retryable` on the main doc, and writes `error = {code: details.get("error_code", "UNKNOWN"), message, stage}` into `processing/summary`.
- Consequence (verified): every worker-originated failure persists error = "Processing failed", error_stage = None, retryable = True (silent default), and summary error.message = "Processing failed".
- The worker's stale-lease sweep `_fail_if_still_stale`, rag-api's enqueue-failure paths (POST /process rollback), and the `Resource` model already write/expose `error`/`error_stage`/`retryable`. These are unchanged.

## 2. Design

### 2.1 Extract a testable failure-payload builder (worker)

Add a module-level pure function in rag-worker `main.py`:

```python
def _build_failure_details(e: Exception, stage: str) -> dict:
    message = str(e)
    return {
        "error_message": message,     # new canonical key read by rag-api
        "error": message,             # legacy key retained for unknown consumers (compat hedge)
        "stage": stage,
        "retryable": classify_error(e),
    }
```

- `retryable` derivation: transient → True; permanent/unknown → False (matches `classify_error` semantics used by ACK/NACK in `run_worker`). Unknown exceptions classify permanent → retryable False. This is the adopted default from F8.
- The legacy `error` key is retained per the compat hedge (F11); it is one redundant string per failure message.
- No `error_code` is sent, so summary `error.code` stays "UNKNOWN" (per non-goal — no taxonomy).

### 2.2 Stage tracking in `process_document`

- Introduce a local `current_stage: str = "starting"` initialized at the top of the `try` block.
- Set it immediately **before** each pipeline step / `_publish_status_update` call, reusing the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`; the storage steps (delete-old-vectors / store-chunks / metadata-save / map generation / usage) map to the closest preceding/step-local stage using the same vocabulary (see 2.3).
- Convention (documented in a comment at the tracker declaration): "set `current_stage` immediately before the await of the step it covers" — a new pipeline step added without updating the tracker reports a stale stage; the contract test pins representative early and late stages.
- The exception handler calls `_build_failure_details(e, current_stage)` and publishes the result as the failed status details. `current_stage` initialization guarantees the key is always present; if a failure occurs before the first assignment, `current_stage` is `"starting"`. For defensive robustness (e.g. unexpected code reordering) the handler uses the safe fallback `"processing"` when the tracker is somehow unset — `"processing"` matches the value the sweep uses for `error_stage` (verified) so the persisted field never regresses to null.

### 2.3 Stage mapping (concrete)

| Pipeline step | stage value at failure |
|---|---|
| validate / initial publish | `starting` |
| `_get_extracted_text` | `text_retrieved` |
| `content_tagger.generate_tags` | `tagging_complete` |
| `generate_document_summary` + Firestore `update_data` write | `summary_generated` |
| `_create_enhanced_chunks` | `chunking_complete` |
| `_generate_embeddings_with_openrouter` | `embeddings_complete` |
| `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, `_update_user_usage`, `_generate_resource_map` | `embeddings_complete` (the last published stage; these steps are part of the storage/embedding tail) |
| completed publish onwards | never fails into the handler (returns/commits) |

Note: steps after the last progress publish intentionally report `embeddings_complete` — they are covered by the same tracker set before the embeddings await and remain inside the tracked region. This keeps the vocabulary to the existing names; no new stage names are introduced.

### 2.4 rag-api side — no changes

- Verified: `run_transactional_update` already reads exactly `error_message`/`stage`/`retryable` and persists them unchanged. The constraint "do not change rag-api's reads or persisted schema" is satisfied by construction.
- Residual check only: confirm no other branch in rag-api reads the worker's legacy `error` details key. (None found in verified evidence; the hedge key exists solely for hypothetical external consumers of the status topic.)

### 2.5 Unchanged on purpose (verified as already contract-conformant)

- `_fail_if_still_stale` sweep write (`error`, `error_stage: "processing"`, `retryable: True`) — matches the persisted schema.
- rag-api enqueue-failure writes in POST /process — already write `error`/`error_stage`.
- `Resource`/`ResourceResponse` models exposing `error`/`error_stage`/`retryable` (retryable default True at the model layer, which only applies to fields never written by a failure path — the failure branch always writes `retryable` explicitly).

## 3. Files touched

| File | Change |
|---|---|
| apps/ai-server/rag-worker-service/main.py | Add `_build_failure_details`; add stage tracker to `process_document`; rewrite exception handler to publish `_build_failure_details(e, current_stage)`; add convention comment. |
| apps/ai-server/tests/integration/test_api_contracts.py | New contract test class: worker failure payload → rag-api failed-branch persistence round trip (fakes, no emulator dependency for the core case), plus key-drift guards (see test plan). |
| apps/ai-server/rag-worker-service/tests/unit/ | New `test_failure_payload.py`: payload builder + stage tracking unit tests. |

No schema/migration changes. No changes to rag-api `main.py` logic.

## 4. Implementation steps

1. **Worker: payload builder.** Add `_build_failure_details(e, stage)` near `classify_error` (same file region). It depends only on `classify_error`, which is module-level — keep it module-level too so both unit tests and the cross-service contract test can import it without instantiating the processor.
2. **Worker: stage tracker.** In `process_document`: declare `current_stage = "starting"` before the `try` (or as the first statement inside it); assign before each step per the mapping in 2.3; in the `except` block replace `{"error": str(e)}` with `_build_failure_details(e, current_stage if isinstance(current_stage, str) else "processing")`. Keep the existing log line (`document_processing_failed`) and add `stage` to its structured fields.
3. **Worker tests.** Unit tests for the builder (transient, permanent, unknown exception classes — reuse the exception classes and `httpx` status-code heuristics already in `classify_error`) and for stage tracking at representative positions (early failure → `starting`/`text_retrieved`; late failure → `embeddings_complete`).
4. **Contract test.** In `tests/integration/test_api_contracts.py`:
   - Import the worker module (its conftest stubs heavy deps — reuse the pattern from `rag-worker-service/tests/conftest.py`) and call `_build_failure_details` with a representative exception and a stage.
   - Feed the resulting `details` dict through rag-api's `run_transactional_update` (already importable in this test file: `import main as rag_api_main`) against a fake db/doc-ref in the style of `test_processing_lease.py`'s `FakeDb`/`FakeTx` (patch `firestore.transactional` / `SERVER_TIMESTAMP` as those tests do).
   - Assert: main-doc `error == str(exception)`, `error_stage == stage`, `retryable == classify_error(e)`; summary `error.message == str(exception)`, `error.stage == stage`, `error.code == "UNKNOWN"`.
   - Drift guards (static, matching house style):
     a. AST scan of rag-worker `main.py`: the failed-status publish site's details must be constructed via `_build_failure_details` (a call node), and the literal `{"error": str(e)}` dict must no longer appear.
     b. Key-set assertions pinning the contract: the builder's output key set must be exactly `{"error_message", "error", "stage", "retryable"}`; rag-api's failed branch must read exactly `error_message`, `stage`, `retryable` (asserted via the round-trip values, not via string matching of the API source — the round trip itself is the drift guard).
   - One case exercising the "unknown exception" path asserting `retryable is False` (the deliberate behavior change), and one transient case asserting `retryable is True`.
5. **Manual/integration sanity (optional, existing patterns):** both services support `FIRESTORE_EMULATOR_HOST` hermetic mode; the fakes-based contract test above is sufficient and deterministic, so emulator wiring is not required for acceptance.

## 5. Risks and mitigations (verified or accepted)

- Unknown consumers of the status topic reading the legacy `error` key — mitigated: key retained in the payload.
- Stage-tracker drift as the pipeline evolves — mitigated: "set before await" convention documented at the tracker; contract test pins representative early/late stages.
- `retryable=False` for unclassified/unknown exceptions — deliberate (F8 rationale: aligns with ACK-permanent behavior; manual reprocess via POST /process unaffected). Accepted.
- Contract test ossifying the payload — intentional drift guard; adding a key requires touching the test.
- Unverified item preserved as unknown: the companion D3 issue referenced by the Objective is unavailable; its scope is deferred and not addressed here (per Definition F12).

## 6. Acceptance mapping

| Acceptance criterion | How met |
|---|---|
| Worker failed payload carries error_message, stage, retryable | `_build_failure_details` output; asserted by unit + contract tests |
| Persisted error/error_stage/retryable equal worker values | Contract test round trip through `run_transactional_update` |
| processing/summary error subdocument carries same message/stage | Contract test asserts summary `error.message`/`error.stage` |
| Contract test exists, passes, fails on key drift | New test class + AST/builder key-set drift guards |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>
<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan: worker→rag-api failure payload contract

Run: 029951f8-4005-48db-9a23-25a40ec20c96

## 1. Scope

Covers the worker's failure-payload construction and rag-api's failed-branch persistence for the worker→rag-api failure path. Out of scope: the stale-lease sweep (already tested in `rag-worker-service/tests/unit/test_processing_lease.py`, behavior unchanged), ACK/NACK mechanics, enqueue-failure writes, frontend.

## 2. Test layers

### 2.1 Unit tests — worker payload builder (rag-worker-service/tests/unit/test_failure_payload.py)

Run with existing `pytest.ini` config and conftest stubs (no network, no GCP).

Cases:
1. `TransientError` (worker's own class) → `retryable is True`, `error_message == str(e)`, `stage` echoed, legacy `error` key present and equal to `error_message`.
2. `PermanentError` → `retryable is False`, all other keys as above.
3. Unknown exception (plain `ValueError`) → `retryable is False` (conservative default of `classify_error`; pins the deliberate behavior change).
4. `httpx.HTTPStatusError` with status 503 → `retryable is True`; status 404 → `retryable is False` (pins the heuristic path; construct via a real `httpx.Response`, as `classify_error` reads `e.response.status_code`).
5. Payload key set is exactly `{"error_message", "error", "stage", "retryable"}` — hard assertion; adding/removing a key must fail this test (drift guard on the builder itself).

### 2.2 Unit tests — stage tracking (same file)

Invoke a minimal `process_document` execution with mocked collaborators (pattern exists: unit tests import `main` with the conftest stubs and monkeypatch `firestore.transactional`, `SERVER_TIMESTAMP`, etc.) and capture the failed `_publish_status_update` details:

6. Failure during `_get_extracted_text` → published details `stage == "text_retrieved"` (early-stage pin).
7. Failure during `store_chunks_via_service` → published details `stage == "embeddings_complete"` (late-stage pin).
8. Failure before any stage assignment in a reordered-handler scenario → `stage` never None/missing; assert `details.get("stage")` is a non-empty string within the allowed vocabulary.

Vocabulary guard:
9. Static/AST assertion that every literal `stage` value passed to failure reporting comes from the existing progress vocabulary `{starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete, processing}` (the sweep's `processing` value is the safe fallback).

### 2.3 Contract tests — worker → rag-api failure path (tests/integration/test_api_contracts.py)

New class `TestWorkerFailurePayloadContract`, following the file's existing patterns (direct imports of rag-api `main`; fakes modeled on `test_processing_lease.py`'s `FakeDb`/`FakeTx`/`FakeRef`; monkeypatch `firestore.transactional` to run inline and `SERVER_TIMESTAMP` to a sentinel).

Round trip:
10. Build a resource doc (`status: "processing"`, canonical path `users/u1/resources/r1`), import the worker module (conftest-stubbed), call `_build_failure_details(exc, "embeddings_complete")`, then call `rag_api_main.run_transactional_update(db, doc_ref, "failed", details, logger, "u1")`.
11. Assert main-doc write: `status == "failed"`, `error == str(exc)` (not `"Processing failed"`), `error_stage == "embeddings_complete"`, `retryable == classify_error(exc)` — i.e. the persisted values equal the worker's payload values with no fallback defaults operative. Assert by capturing the transaction update payload (FakeTx records writes).
12. Assert `processing/summary` write: `error == {"code": "UNKNOWN", "message": str(exc), "stage": "embeddings_complete"}`; also `stage == "embeddings_complete"` at the summary top level.
13. Transient variant: same round trip with a `TransientError`; assert persisted `retryable is True`.
14. No-fallback assertion: `details` deliberately contains no `error_code` key; assert summary `error.code == "UNKNOWN"` (pins the taxonomy non-goal) and that `main_update["error"]` equals the real message (would be `"Processing failed"` under the old contract — this is the regression test for the original bug).

Drift guards (fail the build if either side's keys change):
15. AST scan of rag-worker `main.py` (subprocess pattern already used in this file): the failed-status publish in `process_document`'s except handler must call `_build_failure_details`; assert the legacy literal dict form `{"error": str(e)}` is absent from the failure handler.
16. Key-set pin: worker failure payload keys == `{error_message, error, stage, retryable}`; rag-api failed branch is pinned behaviorally by tests 11–12 (any key rename on either side breaks the round trip and fails the build).

### 2.4 Optional emulator path (not required for acceptance)

Both services support `FIRESTORE_EMULATOR_HOST`; if the hermetic stack is available in CI, the same round-trip can run against the real emulator to cover `firestore.transactional` semantics beyond the fakes. Deferred as optional — the fakes-based contract test is deterministic and sufficient for the acceptance criteria.

## 3. Pass criteria

- All existing tests remain green (no rag-api behavior change; worker change is additive to the failure publisher).
- New unit tests (2.1–2.2) and contract tests (2.3) pass.
- Every acceptance criterion in the Definition maps to at least one numbered case: AC1 → cases 1–5; AC2 → cases 11, 13; AC3 → cases 12, 14; AC4 → cases 10–16.
- The drift guards fail (not skip) when keys are renamed on either side — verified by temporarily renaming a key during development.

## 4. Known gaps / preserved unknowns

- The companion D3 issue's content is unavailable; anything beyond the worker→rag-api failure payload alignment is deferred and untested here.
- Unknown consumers of the status topic reading the legacy `error` key cannot be tested from this repo; the key-retention hedge is covered only by asserting the key exists in the payload (case 1).
- The `tests/integration` conftest currently mocks rag-api's cloud deps with MagicMocks; the worker module import in that suite needs the richer stub pattern from `rag-worker-service/tests/conftest.py` — flagged as the main implementation risk for 2.3 (resolved by reusing that conftest's module-stub approach or running the contract test against the worker's stubbed modules via a dedicated fixture).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>