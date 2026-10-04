<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan: rag-worker → rag-api failure payload contract alignment

## Context

The rag-worker's exception handler publishes failed status with `details = {"error": str(e)}`. rag-api's `run_transactional_update` failed branch reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, and `details.get("retryable", True)`. Because of the key mismatch, every worker-originated failure persists:

- `error` = "Processing failed" (fallback string, not the actual message)
- `error_stage` = `None`
- `retryable` = `True` (silent default, not derived)

The `processing/summary` error subdocument inherits the same fallbacks (`message` = "Processing failed", `stage` = null, `error_code` = "UNKNOWN").

The persisted schema (`error` / `error_stage` / `retryable`) is already used consistently by three other write paths — the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths (`POST /process`, `POST /resources`) — and is exposed by `ResourceResponse` and the `Resource` model (`retryable` defaults `True`). The worker's status publisher is the only writer that doesn't speak it. The fix aligns the worker to the API's contract; rag-api's reads and persisted schema are unchanged. No migration, no rename, no backfill.

## Scope (from authoritative Definition)

**In scope:**
1. Worker failure payload carries `error_message`, `stage`, `retryable` explicitly.
2. Worker tracks the currently executing pipeline stage through `process_document`.
3. `retryable` derived from `classify_error(e)` (transient → true, permanent/unknown → false).
4. Contract test covering worker failure → rag-api persistence, with key-drift guard.

**Out of scope (non-goals):** stale-lease sweep behavior (already consistent), ACK/NACK policy / leases / heartbeats, frontend changes (`ResourceResponse` already exposes `error`/`error_stage`), structured error codes (`error.code` stays "UNKNOWN" unless sent), anything covered by the unavailable companion D3 issue.

## Changes

### 1. Worker: stage tracking in `process_document`

File: `apps/ai-server/rag-worker-service/main.py`, `EnhancedDocumentProcessor.process_document`.

- Introduce a local `current_stage` variable (or a small mutable holder, e.g. a one-element list or a helper closure, since the except block must read it).
- Set the tracker **immediately before each pipeline await**, reusing the existing progress-stage vocabulary:
  - `"starting"` — before `_validate_processing_request` / the initial "starting" status publish
  - `"text_retrieved"` — before `_get_extracted_text` (the stage label published *after* this step succeeds is `text_retrieved`; the tracker records the stage being *entered* — see naming note below)
  - `"tagging_complete"`, `"summary_generated"`, `"chunking_complete"`, `"embeddings_complete"` — before the corresponding steps (tagging, summary generation, chunking, embeddings)
  - Post-embedding steps (old-vector deletion, Weaviate storage, metadata save, resource-map generation, usage update) report `"embeddings_complete"` as the last tracked stage, or a value from the same vocabulary that best matches; the safe fallback `"processing"` applies when the stage is genuinely unknown.
- **Naming note (decision):** the Definition requires stage names to reuse the existing progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`) with `"processing"` as the safe unknown value. Whether the tracker records the stage *entered* or the last *completed* milestone must be resolved consistently; the convention adopted here is "set the tracker immediately before the await" — the tracker holds the name of the pipeline step about to execute, drawn from the vocabulary above. The contract test pins representative early- and late-stage failures so the convention is observable.
- Initialize `current_stage = "processing"` before the `try` so a failure before the first transition reports `"processing"` — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.

### 2. Worker: failure payload construction

File: `apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler (currently `await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)`).

Replace with a deliberately constructed payload:

```python
error_message = str(e)
stage = current_stage  # tracked per change 1
retryable = classify_error(e)  # transient → True, permanent/unknown → False
details = {
    "error_message": error_message,
    "stage": stage,
    "retryable": retryable,
    "error": error_message,   # legacy key retained for unknown topic consumers (hedge)
}
await self._publish_status_update(user_id, course_id, resource_id, "failed", details, job_id)
```

- `classify_error` already exists in the same file and drives ACK/NACK in `run_worker`; deriving `retryable` from it makes the persisted record match actual retry behavior (transient = Pub/Sub redelivers; permanent = acked, manual reprocess via `POST /process` remains).
- **Deliberate behavior change:** unclassified-unknown exceptions currently persist `retryable: true` (silent default) but classify as permanent; they will now persist `false`. Accepted per Definition (conservatism against infinite retry loops; manual reprocess unaffected).
- The legacy `error` key is retained alongside `error_message` per the Definition's compatibility hedge (only rag-api's subscriber is a verified consumer; other topic readers unknown).
- No structured error codes are introduced; rag-api's `error_code` default "UNKNOWN" stays.
- `metrics.error_message` assignment and logging in the handler are unchanged.

### 3. rag-api: no functional changes

`run_transactional_update`'s failed branch already reads exactly `error_message` / `stage` / `retryable` and persists them unchanged:

- main doc: `error` ← `error_message`, `error_stage` ← `stage`, `retryable` ← `retryable`
- `processing/summary`: `error.message` ← `error_message`, `error.stage` ← `stage`, `error.code` ← `error_code` (absent → "UNKNOWN")

With the worker now sending those keys, the fallbacks become inert for worker failures. **No edits to `apps/ai-server/rag-api-service/main.py` are required**; the failed branch is pinned by the contract test instead (change 4) so it cannot drift either.

### 4. Contract test: worker failure → rag-api persistence

New test in `apps/ai-server/tests/integration/` (house pattern: `test_api_contracts.py`, fixture- and AST-based static contract tests; `tests/integration/conftest.py` already mocks the cloud SDKs and puts rag-api-service on `sys.path`).

Design (import both sides, don't restate the contract in a fixture):

a. **Worker-side payload construction test.** Import the worker's failure-payload construction. Because `rag-worker-service/main.py` is a large module with import-time side effects (Pub/Sub subscriber construction at module scope requires `GOOGLE_APPLICATION_CREDENTIALS`), reuse the stubbing approach from `apps/ai-server/rag-worker-service/tests/conftest.py` (which stubs `google.cloud.*`, `openai`, `langchain`, etc. and sets required env defaults). Exercise `process_document`'s exception path against a processor instance with mocked internals (or extract the payload construction into a small pure helper function, e.g. `_build_failure_payload(e, stage)` — preferred if it keeps the diff minimal, since it makes the payload directly importable and testable). Assert:
   - keys include `error_message`, `stage`, `retryable` (and legacy `error`);
   - `error_message == str(exception)`;
   - `stage` equals the tracked stage for an early failure (e.g. validation/text retrieval) and a late failure (e.g. embeddings);
   - `stage == "processing"` when the failure occurs before the first transition;
   - `retryable is True` for a transient-classified error (`httpx.ConnectError` or `TransientError`), `False` for a permanent-classified error (`PermanentError`, plain `ValueError`), `False` for an unclassified-unknown exception.

b. **API-side persistence test.** Feed the worker-built payload through rag-api's `run_transactional_update` (imported from `rag-api-service/main.py`, already importable under `tests/integration/conftest.py`'s mocks) against a fake/emulator Firestore document. Seed a resource doc with `status = "processing"` (required for the allowed transition `processing → failed`). Assert after the update:
   - main doc `error == worker error_message` (not "Processing failed"),
   - `error_stage == worker stage` (not None),
   - `retryable == worker retryable`,
   - `processing/summary` subdoc `error.message` and `error.stage` equal the same values, `error.code == "UNKNOWN"`.

c. **Key-drift guard.** Static (AST or source-scan) assertions mirroring the existing `_get_agent_graph_shapes` pattern:
   - worker source: the failed-status publish site's `details` dict contains exactly the expected key set (`error_message`, `stage`, `retryable`, `error`);
   - rag-api source: the failed branch reads exactly `error_message`, `stage`, `retryable` (plus the pre-existing `error_code` with default) — a rename on either side fails the build.

   If the Firestore emulator is available in the test environment (both services have `FIRESTORE_EMULATOR_HOST` branches), the persistence test may run against the real emulator; otherwise fakes suffice per the Definition ("via the Firestore emulator or fakes"). Prefer fakes for hermeticity unless the emulator harness already exists and is trivially reusable.

## Files touched

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Stage tracking in `process_document`; failure payload keys (`error_message`/`stage`/`retryable` + retained `error`); optionally extract `_build_failure_payload` helper |
| `apps/ai-server/tests/integration/` (new test file, e.g. `test_failure_payload_contract.py`) | Worker payload construction tests, API persistence test, key-drift guard |
| `apps/ai-server/rag-api-service/main.py` | **No changes** (pinned by test) |

## Risks and mitigations

- **Unknown status-topic consumers reading the old key set** — mitigated by retaining `error` alongside `error_message`; residual risk accepted as low.
- **Stage-tracker drift** as pipeline steps are added — convention: set the tracker immediately before the await; contract test pins representative early/late stages.
- **`retryable=false` for unclassified-unknown errors** reduces auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope; `POST /process` manual reprocess remains.
- **Contract test ossifies the payload** — intentional; adding a key later means touching the test, which is the drift guard working.
- **Worker module import-time side effects in tests** — reuse the established stubbing conftest pattern from `rag-worker-service/tests/conftest.py`; extracting a pure payload-construction helper reduces the surface needing stubs.

## Acceptance criteria mapping

| Definition acceptance | Covered by |
|---|---|
| Worker failed payload contains `error_message`/`stage`/`retryable`, no reliance on API fallbacks | Change 2 + test 4a |
| Persisted `error` = actual message, `error_stage` = failing stage, `retryable` = derived value | Change 2 + test 4b |
| `processing/summary` error subdoc carries same message and stage | Test 4b |
| Contract test exists, passes, fails on key drift on either side | Test 4a–4c |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan: worker → rag-api failure payload contract

## Objective

Verify that a failed RAG processing job publishes a failure payload (`error_message`, `stage`, `retryable`) that rag-api persists verbatim as `error` / `error_stage` / `retryable` — and that the contract cannot silently drift on either side.

## Test environment

- Location: `apps/ai-server/tests/integration/` (new file, e.g. `test_failure_payload_contract.py`), following the existing static/fixture contract-test pattern in `test_api_contracts.py`.
- Imports:
  - rag-api side: `main.run_transactional_update` (rag-api-service already on `sys.path` via `tests/integration/conftest.py`, which mocks `firebase_admin`, `google.cloud.*`, etc.).
  - worker side: failure-payload construction from `rag-worker-service/main.py`, using the stubbing approach of `rag-worker-service/tests/conftest.py` (env defaults + module stubs for `google.cloud.*`, `openai`, `langchain`, `spacy`, `tiktoken`, `tenacity`, `langfuse`).
- Firestore: fakes by default for hermeticity; the Firestore emulator (`FIRESTORE_EMULATOR_HOST` branches exist in both services) is an acceptable alternative if a harness already exists. `run_transactional_update` requires a `firestore.transactional`-decorated function and a `db.transaction()` — the fake must support `@firestore.transactional`, `transaction.get/update/set`, and `doc_ref.collection("processing").document("summary")`. If the real `firestore.transactional` decorator is unavailable under mocks, patch it to a pass-through decorator in the test setup.

## Test cases

### A. Worker failure-payload construction

**A1 — payload keys are the contract keys.**
Trigger a failure inside `process_document` (mock an internal step to raise). Assert the published failed-status `details` dict contains `error_message`, `stage`, `retryable` — and that rag-api's fallbacks are never operative: `error_message` is present and non-empty, `stage` is present and non-null, `retryable` is a bool.

**A2 — error_message carries the actual exception message.**
Raise `ValueError("chunk embedding failed: dimension mismatch")` from a mocked pipeline step. Assert `details["error_message"] == "chunk embedding failed: dimension mismatch"` and the legacy `details["error"]` equals the same string (compatibility hedge).

**A3 — early-stage failure reports the early stage.**
Force a failure during validation / text retrieval (e.g. `_get_extracted_text` raises). Assert `details["stage"]` equals the tracked early-stage name from the progress vocabulary (e.g. `"text_retrieved"` per the tracker convention) — not `None`, not `"processing"`.

**A4 — late-stage failure reports the late stage.**
Force a failure during embedding generation or Weaviate storage. Assert `details["stage"]` equals the corresponding late-stage vocabulary name (e.g. `"embeddings_complete"`).

**A5 — unknown-stage failure reports the safe value.**
Force a failure before the first stage transition (e.g. `_validate_processing_request` raises before any tracker update beyond initialization). Assert `details["stage"] == "processing"` — matching the stale-lease sweep's `error_stage` value, never null.

**A6 — retryable derivation: transient.**
Raise `httpx.ConnectError("connection refused")` (or `TransientError`). Assert `details["retryable"] is True`.

**A7 — retryable derivation: permanent.**
Raise `PermanentError("invalid input")` (or a plain `ValueError`, which classifies permanent). Assert `details["retryable"] is False`.

**A8 — retryable derivation: unclassified-unknown.**
Raise a bare `RuntimeError("something unexpected")`. Assert `details["retryable"] is False` — pins the deliberate behavior change (previously the silent default `True`).

**A9 — derivation matches ACK/NACK behavior.**
For the same exception instances, assert `details["retryable"] == classify_error(e)`. This keeps the persisted flag aligned with `run_worker`'s ACK/NACK decision (transient → NACK/redeliver; permanent → ack).

### B. rag-api failed-branch persistence (contract seam)

**B1 — end-to-end persistence of worker values.**
Seed a fake resource document at `users/{uid}/resources/{rid}` with `status: "processing"`. Build the failure payload through the worker's code path (reuse A's construction — do not restate keys in a fixture), then run `run_transactional_update(db, doc_ref, "failed", details, logger, uid)`. Assert on the persisted main doc:
- `error == <worker error_message>` (and ≠ "Processing failed"),
- `error_stage == <worker stage>` (and ≠ None),
- `retryable == <worker retryable>` (exact bool equality, not truthiness),
- `status == "failed"`.

**B2 — summary subdocument mirrors the main doc.**
After B1's update, assert `processing/summary` contains `error.message == <worker error_message>`, `error.stage == <worker stage>`, and `error.code == "UNKNOWN"` (no error-code taxonomy introduced).

**B3 — retryable=false persists as false.**
Run B1 with a permanent-classified exception; assert persisted `retryable is False` (guards against any `or True`-style truthiness bug reintroducing the default).

**B4 — legacy-payload regression guard (optional, cheap).**
Run `run_transactional_update` with the *old* worker payload (`{"error": str(e)}`) and assert it still produces the fallback behavior ("Processing failed" / None / True). This documents the pre-fix behavior and proves the new test actually distinguishes the contracts — it fails if someone "fixes" the API side to read `error` instead, which would silently mask worker regressions.

### C. Key-drift guards (static, AST/source-scan — pattern from `_get_agent_graph_shapes`)

**C1 — worker failed-payload key set pinned.**
Parse `rag-worker-service/main.py`; locate the failed-status publish in the `process_document` exception handler (or the extracted `_build_failure_payload` helper). Assert the `details` dict literal contains exactly `{error_message, stage, retryable, error}`. Adding or removing a key fails the build.

**C2 — rag-api failed-branch reads pinned.**
Parse `rag-api-service/main.py`; within `run_transactional_update`, assert the failed branch reads `error_message`, `stage`, `retryable` from `details` (plus the pre-existing `error_code` default) and writes `error`, `error_stage`, `retryable` to the main update. A rename on the API side fails the build.

**C3 — stage vocabulary pinned.**
Assert the stage values assigned to the tracker in `process_document` are drawn from `{starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete, processing}` — a new pipeline step that forgets the tracker convention, or invents a stage name outside the vocabulary, is caught at the vocabulary boundary (full tracker-removal is caught by A3/A4).

## What is intentionally NOT tested

- ACK/NACK policy, lease/heartbeat mechanics, sweep behavior — out of scope; only *reporting* changes.
- `ResourceResponse` field exposure — already covered by `TestResourceResponseContract` in `test_api_contracts.py`.
- Full `process_document` happy path — unchanged.
- Structured error codes — non-goal; B2 only pins `code == "UNKNOWN"`.

## Pass criteria

- All A/B/C tests pass in CI alongside the existing integration suite.
- B1/B2 assert exact equality against values produced by the worker's own code path (no fixture duplication of the contract).
- C1/C2 fail on any key rename on either side of the seam.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>