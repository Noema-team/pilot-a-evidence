<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan: rag-worker → rag-api failure payload contract alignment

## Goal

Align the rag-worker's failed-status payload with rag-api's failed-branch contract so a failed RAG job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived `retryable` flag — locked in by a contract test on the worker→rag-api failure path.

No changes to rag-api's reads, persisted schema, or field names. No migration, no backfill.

## Current state (evidence-pinned)

- Worker `process_document` exception handler (`apps/ai-server/rag-worker-service/main.py`) publishes:
  `await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)`
- rag-api `run_transactional_update` failed branch reads `details["error_message"]`, `details["stage"]`, `details["retryable"]`, with fallbacks `"Processing failed"` / `None` / `True`, and persists `error` / `error_stage` / `retryable` on the main document plus `message` / `stage` (error_code default `"UNKNOWN"`) into the `processing/summary` subdocument.
- Net effect today: every worker failure persists `"Processing failed"`, `error_stage: None`, `retryable: True` (silent default).
- Other failure writers (stale-lease sweep `_fail_if_still_stale`, rag-api enqueue-failure paths) and both response models already use `error`/`error_stage`/`retryable`.

## Changes

### 1. rag-worker: stage tracking in `process_document`

Introduce a local `current_stage: str = "processing"` in `process_document` before the `try` block. Convention: **set `current_stage` immediately before each pipeline await** — never after — so an exception inside a step reports the stage that was executing.

Mapping (reuses existing progress-stage vocabulary):

| Pipeline step (start of) | `current_stage` |
|---|---|
| before `_validate_processing_request` / before first status publish | `"starting"` |
| before `_get_extracted_text` | `"text_retrieved"` (step is text retrieval; stage label published on completion is `text_retrieved` — the label is assigned before the await so a failure during retrieval is attributed to it) |
| before `content_tagger.generate_tags` | `"tagging_complete"` |
| before `generate_document_summary` (and the Firestore update + status publish that follow it, up to chunking) | `"summary_generated"` |
| before `_create_enhanced_chunks` | `"chunking_complete"` |
| before `_generate_embeddings_with_openrouter` (and through `delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save, final publish, usage update, resource-map generation) | `"embeddings_complete"` |

Notes:
- `embeddings_complete` covers steps 6a/6b (vector delete/store) and post-storage bookkeeping; no new stage names are invented.
- `"processing"` is only ever in effect before the first assignment — the safe value when the stage is genuinely unknown (matches the stale-lease sweep's `error_stage` value).
- After a failed publish, keep `current_stage` unchanged (it is only consumed by the exception handler).

### 2. rag-worker: failure payload in the exception handler

Replace:

```python
await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)
```

with construction of the aligned payload:

```python
error_message = str(e)
retryable = classify_error(e)   # transient → True, permanent/unknown → False
details = {
    "error_message": error_message,
    "error": error_message,      # legacy key retained for unknown consumers of the status topic
    "stage": current_stage,
    "retryable": retryable,
    "jobId": job_id,             # _publish_status_update also sets this if absent
}
await self._publish_status_update(user_id, course_id, resource_id, "failed", details, job_id)
```

Also log `stage` and `retryable` in the `document_processing_failed` structured-log line, and store `current_stage` / `retryable` on `ProcessingMetrics` (add optional fields `error_stage: Optional[str] = None` and `error_retryable: Optional[bool] = None` so the failure handler populates them; `success` semantics unchanged — `error_message is None`).

`classify_error(e)` derivation rule (binding):
- Transient-classified (`TransientError`, connection/timeout types, HTTP 429/5xx) → `retryable=True`.
- Permanent-classified (`PermanentError`, other 4xx, **unclassified-unknown** per its conservative default) → `retryable=False`.

This aligns the persisted flag with the ACK/NACK decision in `run_worker`. Deliberate behavior change: unclassified-unknown exceptions now persist `retryable=False` instead of the silent `True` default. Manual reprocess via `POST /process` is unaffected.

The legacy `error` key is retained (one redundant string) as a compatibility hedge for any unverified consumer of the status topic; rag-api ignores it.

### 3. rag-api: no functional change

The failed branch in `run_transactional_update` already reads the three keys and persists them. Verify (read-only, during review) that:
- main document: `error ← details.get("error_message", "Processing failed")`, `error_stage ← details.get("stage")`, `retryable ← details.get("retryable", True)`.
- `processing/summary` error subdocument: `message` / `stage` from the same payload keys, `error_code` defaulting to `"UNKNOWN"`.

The `details.get("retryable", True)` fallback stays (it serves enqueue-failure paths and malformed payloads) but must never be the operative mechanism for worker failures — the worker now always sends the key. This is enforced by the contract test's explicit-key assertion.

### 4. Contract test: worker failure → rag-api persistence

New test module `apps/ai-server/tests/integration/test_failure_payload_contract.py` (see `docs/test-plan.md` for full cases). Approach:

- Import the worker's payload-construction logic and rag-api's `run_transactional_update` failed branch — do not restate the contract in fixtures.
- Because importing `rag-worker-service/main.py` pulls heavy deps (langchain, marker, firebase) the conftest already mocks, extract the payload construction into a small, import-cheap helper in the worker (see Step 5) so the test exercises the real code path without loading the model stack.
- Exercise persistence against the Firestore emulator (`FIRESTORE_EMULATOR_HOST` branch both services already support) when available; otherwise against the fakes used by the existing contract tests. Assert the persisted `error`, `error_stage`, `retryable` on the main document and `message` / `stage` on `processing/summary` equal the worker's payload values.
- Add a key-set drift guard: assert the worker's failed-details key set is exactly `{error_message, error, stage, retryable, jobId}` and that rag-api's failed branch reads exactly `error_message`, `stage`, `retryable` (AST- or source-inspection based, following the house pattern in `test_api_contracts.py`). Either side's drift fails the build.

### 5. Refactor: extract worker failure-payload builder (test seam)

Add a module-level helper in the worker, e.g.:

```python
def build_failure_details(error: Exception, stage: str, job_id: Optional[str]) -> Dict[str, Any]:
    ...
```

containing the error_message / legacy-error / stage / retryable / jobId construction and the `classify_error`-based derivation. `process_document`'s exception handler calls it. The contract test calls it too, so the tested path is the production path, not a copy.

### 6. rag-api-side import seam for the test

If `run_transactional_update`'s failed branch is not directly callable with a fake transaction/db, factor the failure-persisting write into a small function (e.g. `_persist_failure(doc_ref, error_message, stage, retryable, ...)`) invoked from the failed branch, so the test can drive persistence through production code. Keep behavior byte-identical; no reader or schema changes.

## Order of work

1. Extract `build_failure_details` in the worker; wire the exception handler to it (no behavior change beyond payload keys).
2. Add stage tracking to `process_document` (assignment-before-await convention).
3. Extend `ProcessingMetrics` with `error_stage` / `error_retryable`; populate in the handler; enrich the failure log line.
4. (Only if needed for testability) extract rag-api's failure-persist write into a helper, unchanged in behavior.
5. Write the contract test module + drift guards.
6. Run the integration suite; confirm no other tests depend on the old `{"error": ...}`-only payload.

## Risks and mitigations

- **Unknown status-topic consumers** reading only `error`: mitigated — legacy key retained.
- **Stage-tracker drift** as pipeline steps are added: mitigated by the update-before-await convention and representative-stage contract tests (early-stage and late-stage failure).
- **`retryable=False` for unclassified-unknown errors** reduces auto-retry affordance: accepted; `classify_error`'s conservatism is intentional, and manual reprocess via `POST /process` remains.
- **Test ossifies the payload key set**: intentional drift guard — adding a key means touching the test, which is the point.

## Out of scope

- Stale-lease sweep behavior (already writes `error`/`error_stage`/`retryable` consistently; keeps `retryable=True`, correct for a dead-worker condition).
- ACK/NACK policy, leases, heartbeat intervals — only the *reporting* of retryability changes.
- Structured error-code taxonomy (`processing/summary` `error.code` stays `"UNKNOWN"` unless a code is sent).
- Frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`).
- Companion D3 issue scope (unavailable in this context; deferred).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan: worker failure → rag-api persistence contract

## Scope

Cover the seam the definition pins: the worker's failure-payload construction and rag-api's failed-branch persistence, asserting persisted `error`, `error_stage`, `retryable` (and the `processing/summary` error subdocument) equal the worker's values, with drift guards on both sides' key sets.

## Test infrastructure

- Location: `apps/ai-server/tests/integration/test_failure_payload_contract.py`, alongside the existing `test_api_contracts.py`; reuse `conftest.py` (env defaults + mocked cloud modules).
- Firestore: prefer the hermetic emulator branch (`FIRESTORE_EMULATOR_HOST`, already supported by both services) when the emulator is available in CI; otherwise use the fake transaction/db pattern established by the existing contract tests. The assertions are identical either way.
- Worker import seam: tests call the extracted `build_failure_details(error, stage, job_id)` helper (production code) — they must not restate the payload dict inline. rag-api persistence is driven through `run_transactional_update`'s failed branch (or the extracted `_persist_failure` helper if one is introduced per plan Step 6) — again production code, not a fixture copy.

## Test cases

### Class `TestWorkerFailurePayload`

1. `test_payload_contains_aligned_keys` — `build_failure_details(ValueError("boom"), "summary_generated", "job-1")` returns a dict containing `error_message == "boom"`, `stage == "summary_generated"`, and a boolean `retryable`.
2. `test_payload_retains_legacy_error_key` — legacy `error` key present and equal to `error_message` (compatibility hedge; contract-binds its presence so removal is a deliberate test change).
3. `test_payload_keys_exact_set` — drift guard: the returned dict's key set is exactly `{"error_message", "error", "stage", "retryable", "jobId"}`. Any added/removed key fails the build until the test is updated intentionally.
4. `test_transient_error_is_retryable` — a `TransientError` (and e.g. `httpx.ConnectTimeout`) yields `retryable is True`.
5. `test_permanent_error_is_not_retryable` — a `PermanentError` yields `retryable is False`.
6. `test_unknown_error_is_not_retryable` — an unrecognized exception type (e.g. `KeyError`) yields `retryable is False` (pins the deliberate behavior change vs. the old silent `True` default).
7. `test_http_5xx_is_retryable_4xx_is_not` — `httpx.HTTPStatusError` with a 503 response → `True`; with a 400 response → `False`.
8. `test_job_id_included` — `jobId` present when provided; helper tolerates `None` job_id without crashing.

### Class `TestWorkerStageTracking`

9. `test_early_stage_failure_reports_starting_or_text_stage` — with a stubbed processor where `_get_extracted_text` raises, the failed status payload's `stage` is the stage assigned immediately before that await (early pipeline stage), never `None` and never a late-stage name.
10. `test_late_stage_failure_reports_embeddings_stage` — with a stubbed processor where `store_chunks_via_service` raises, the payload's `stage == "embeddings_complete"`.
11. `test_stage_reuses_progress_vocabulary` — every stage value observable in failure payloads is a member of the existing progress-stage set `{starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete, processing}` (drift guard against invented stage names).
12. `test_unknown_stage_falls_back_to_processing` — a failure before the first stage assignment (if reachable) reports `"processing"`, not `None`.

(Implementation: subclass or monkeypatch `EnhancedDocumentProcessor` methods to raise; capture `_publish_status_update` calls via a spy — no real Pub/Sub.)

### Class `TestWorkerApiFailurePersistence`

13. `test_worker_failure_persists_actual_message` — build a worker failure payload via `build_failure_details(ValueError("boom: bad pdf"), "chunking_complete", "job-9")`, feed it through rag-api's failed branch against the emulator/fake resource document; assert persisted main-doc `error == "boom: bad pdf"` (not `"Processing failed"`).
14. `test_persisted_error_stage_equals_worker_stage` — persisted `error_stage == "chunking_complete"` (not `None`).
15. `test_persisted_retryable_equals_worker_value` — run the same payload twice, once with a transient-classified error and once with a permanent-classified error; persisted `retryable` equals the worker's derived boolean in both cases (proves the API fallback `True` is not the operative mechanism).
16. `test_processing_summary_error_subdocument_matches` — the `processing/summary` subdocument's error `message` and `stage` equal the worker's `error_message` and `stage`; `error_code == "UNKNOWN"` when no code was sent.
17. `test_end_to_end_stage_and_message_survive_the_seam` — combined case: stubbed processor fails at a known stage with a distinctive message; drive the produced payload through rag-api persistence; assert all three persisted fields match in one scenario (this is the canonical acceptance check).

### Class `TestFailureContractDriftGuards` (static, following the AST/source-inspection pattern of `test_api_contracts.py`)

18. `test_worker_publishes_aligned_keys_only` — inspect the worker's exception-handler source (AST): the failed `_publish_status_update` call routes through `build_failure_details` (or constructs all three keys `error_message`, `stage`, `retryable` inline). A regression to `{"error": str(e)}` alone fails.
19. `test_rag_api_failed_branch_reads_aligned_keys` — inspect rag-api's `run_transactional_update` failed-branch source: it reads `error_message`, `stage`, and `retryable` from details. Renaming either side's keys fails the build.
20. `test_persisted_schema_names_unchanged` — rag-api's failed branch (and/or `ResourceResponse` model fields via the existing cached-field helper) still persists/exposes `error`, `error_stage`, `retryable` — guarding the no-migration constraint.

## Acceptance mapping

- Definition acceptance #1 → tests 1–3, 8, 9–12, 18.
- Acceptance #2 → tests 13–15, 19.
- Acceptance #3 → test 16.
- Acceptance #4 → tests 17, 18–20 (full seam exercised + drift guards).

## Non-goals in testing

- No test of ACK/NACK mechanics, lease expiry, heartbeat intervals, or the sweep (unchanged behavior).
- No test asserting the legacy `error` key is *read* by rag-api — it is ignored there by design.
- No frontend/model fixture changes beyond the static guard on existing field names.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>