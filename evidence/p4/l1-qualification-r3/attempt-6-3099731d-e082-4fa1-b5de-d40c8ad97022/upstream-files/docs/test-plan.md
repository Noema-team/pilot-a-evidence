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