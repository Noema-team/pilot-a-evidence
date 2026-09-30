<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan: rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (authoritative Definition, sha256 `71f1c39c…`). Planning depth: minimal. All file/line references below were verified against the current tree during investigation; anything not directly verified is marked as a verification step.

## 1. Problem (verified)

- `apps/ai-server/rag-worker-service/main.py` — `process_document`'s exception handler publishes the failed status with a one-key payload:
  ```python
  await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
  ```
- Per the authoritative Definition (F4), `rag-api-service/main.py`'s failed branch in `run_transactional_update` reads `details` keys `error_message`, `stage`, `retryable` and persists `error` / `error_stage` / `retryable` on the main resource document, plus `message` / `stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` subdocument.
- Consequence (F5): every worker-originated failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (silent API-side default).
- The established persisted schema is `error` / `error_stage` / `retryable` (F6): the worker's stale-lease sweep `_fail_if_still_stale` (verified: writes `error`, `error_stage: "processing"`, `retryable: True`), rag-api's enqueue-failure paths, `models/resource.py` (`Resource.error`, `Resource.error_stage`, `Resource.retryable: bool = True`), and the mobile contract fields in `tests/integration/test_api_contracts.py` (`MOBILE_RESOURCE_FIELDS` includes `error`, `error_stage`) all already speak it.
- The worker has no stage tracking: `process_document` is one large `try` block; the exception handler cannot know where the failure occurred (F9). The progress vocabulary published via `_publish_status_update` is: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`.
- The worker classifies every exception via `classify_error(e)` (verified, top of worker `main.py`): returns `True` (transient) for `TransientError`, connection/timeout exception types (`httpx.ConnectError`, `ConnectTimeout`, `ReadTimeout`, `WriteTimeout`, `PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`), and HTTP status codes 429/500/502/503/504; returns `False` (permanent) for `PermanentError`, other 4xx, and — conservatively — any unknown exception. `run_worker` uses this for ACK/NACK (F7).

## 2. Design

### 2.1 Direction (fixed by Definition constraints)

The worker aligns to rag-api's existing contract (`error_message` / `stage` / `retryable`). rag-api's reads and the persisted schema are **not** changed. No migration, no rename, no backfill.

### 2.2 New worker module: `failure_payload.py`

Create `apps/ai-server/rag-worker-service/failure_payload.py` containing (moved from `main.py`, re-exported so `main.py`'s namespace is unchanged):

- `ProcessingError`, `TransientError`, `PermanentError` (moved verbatim)
- `classify_error(e)` (moved verbatim)
- New: `build_failure_details(e: Exception, stage: Optional[str]) -> Dict[str, Any]`:
  ```python
  def build_failure_details(e: Exception, stage: Optional[str]) -> Dict[str, Any]:
      message = str(e)
      return {
          "error_message": message,          # contract key rag-api reads
          "error": message,                  # legacy key retained (F11 hedge)
          "stage": stage if stage else "processing",
          "retryable": classify_error(e),    # deliberate derivation, never a default
      }
  ```

Rationale for extraction: `main.py` imports heavy dependencies at module scope (langchain, openai, langfuse, spacy, sklearn, tiktoken) and executes module-level Pub/Sub setup (`GCP_PROJECT = os.environ["GCP_PROJECT"]`, `service_account.Credentials.from_service_account_file(...)`, `SubscriberClient(...)`). A dependency-light module lets the cross-service contract test import the worker's *actual* payload construction without the heavy import graph or the module-level GCP side effects. `main.py` re-exports via `from failure_payload import (ProcessingError, TransientError, PermanentError, classify_error, build_failure_details)` so `run_worker` and any other in-module references keep working unchanged.

`classify_error` uses `httpx` types; `httpx` is a light dependency already imported by rag-api's test harness, so `failure_payload.py` importing `httpx` is acceptable. (Verify during implementation; if even `httpx` is problematic in some harness, the httpx-type checks can be made lazy, but do not duplicate `classify_error`.)

### 2.3 Stage tracking in `process_document`

Add a local `current_stage: str = "processing"` immediately before the `try` block. Set it **immediately before each pipeline step** (the update-before-await convention), using the existing progress vocabulary. Verified insertion points in `process_document`:

| Set `current_stage` to | Immediately before |
|---|---|
| `"starting"` | `await self._validate_processing_request(...)` (the `{"stage": "starting"}` publish immediately follows validation) |
| `"text_retrieved"` | `await self._get_extracted_text(...)` |
| `"tagging_complete"` | `await self.content_tagger.generate_tags(...)` |
| `"summary_generated"` | `await self.generate_document_summary(...)` (the subsequent `ragDescription` Firestore update stays under this stage) |
| `"chunking_complete"` | `await self._create_enhanced_chunks(...)` |
| `"embeddings_complete"` | `await self._generate_embeddings_with_openrouter(chunks)` |

Semantics note (recorded deliberately): setting the tracker to the *milestone the in-progress step is working toward* distinguishes "failed during step N" from "failed during step N+1"; the alternative (last-completed milestone) would collapse a failure during text retrieval into `"starting"`, losing precision within the fixed vocabulary.

Accepted limitation: the post-embedding steps (delete-old-vectors, `store_chunks_via_service`, metadata save, resource map, usage update) remain under `"embeddings_complete"` — the vocabulary is fixed by the Definition and introducing new stage names (e.g. `"vector_storage"`) is out of scope. `"processing"` remains the defensive initial value / fallback for a genuinely unknown stage (same value the stale-lease sweep uses for `error_stage`).

### 2.4 Failure handler change

In `process_document`'s `except Exception as e:` block, replace:

```python
await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
```

with:

```python
details = build_failure_details(e, current_stage)
await self._publish_status_update(user_id, course_id, resource_id, "failed", details, job_id)
```

Everything else in the handler (`metrics.error_message = str(e)`, logging, trace update, `return metrics`) is unchanged. `_publish_status_update` already swallows its own publish failures (logs `status_publish_failed`) and adds `jobId` to `details` when a `job_id` is supplied — both behaviors are preserved and are accounted for in the drift guard (see test plan).

### 2.5 retryable derivation (adopted default, F8)

`retryable = classify_error(e)` directly (the function's `True` already means transient): transient → `True` (Pub/Sub will redeliver), permanent and unclassified-unknown → `False` (acked; manual reprocess via `POST /process` remains). This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.

**Deliberate behavior change:** unclassified-unknown exceptions previously persisted `retryable: true` (silent API default) and will now persist `false`. Accepted per the Definition; widening `classify_error` is out of scope. The stale-lease sweep's separate `retryable: True` write is untouched and stays correct (a dead worker is transient by nature).

### 2.6 rag-api side: zero code changes (expected)

Per the constraints, rag-api's reads are not modified. Required verification step (read-only, before signing off): read the failed branch of `run_transactional_update` in `apps/ai-server/rag-api-service/main.py` and confirm it matches Definition F4 — reads `details.get("error_message")`, `details.get("stage")`, `details.get("retryable", True)`; persists `error` / `error_stage` / `retryable` on the main document; writes `message` / `stage` (with `error_code` defaulting `"UNKNOWN"`) into `processing/summary`. If the branch differs materially from F4, **stop and re-scope** — do not "fix" rag-api inside this WorkItem. Once the worker sends all three keys, the `details.get(..., default)` fallbacks become dead paths for worker failures, which is exactly the intent (constraint: the fallback must not be the operative mechanism).

### 2.7 Compatibility hedge (F11)

The legacy `error` key is retained in the failure payload alongside `error_message` (same string value). Only rag-api's status subscriber is a verified consumer; the duplicate key is one redundant string of insurance for unknown topic readers and log tooling. Dropping it later is trivial cleanup after a consumer audit (out of scope here).

## 3. File-by-file changes

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/failure_payload.py` | **New.** Exception classes, `classify_error`, `build_failure_details` (§2.2). |
| `apps/ai-server/rag-worker-service/main.py` | (a) Import/re-export from `failure_payload.py`, delete the moved definitions; (b) `current_stage` tracker + six insertion points in `process_document` (§2.3); (c) exception handler builds payload via `build_failure_details` (§2.4). No changes to `_publish_status_update`, `run_worker`, `_fail_if_still_stale`, sweep, heartbeat, or config. |
| `apps/ai-server/rag-api-service/main.py` | **No changes.** Read-only verification of the failed branch (§2.6). |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | **New.** Unit tests for the payload builder and stage tracker (see test plan). |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | **New.** Cross-service contract test + AST drift guard (see test plan). |
| `apps/ai-server/tests/integration/conftest.py` | Extend only if needed: add `rag-worker-service` to `sys.path` and any additional mock pins required by the contract test harness (see test plan §3). Keep existing rag-api mocking intact. |

## 4. Implementation order

1. **Verify rag-api failed branch** against F4 (read-only). Record any drift; halt on material mismatch.
2. Create `failure_payload.py`; switch `main.py` to import from it (pure move + re-export). Run worker unit suite to confirm no regression.
3. Add `current_stage` tracker and the six update-before-await insertions in `process_document`.
4. Rewire the exception handler to `build_failure_details(e, current_stage)`.
5. Write worker unit tests (`test_failure_payload.py`).
6. Build the contract-test harness and tests in `tests/integration/test_worker_failure_contract.py` (enumerate `run_transactional_update`'s Firestore API surface first, then build the fake to match).
7. Run all three suites: `rag-worker-service/tests`, `rag-api-service/tests`, `tests/integration`. Grep for other publishers/consumers of the status topic as a cheap sanity check on the F11 assumption (informational only; the legacy `error` key already hedges it).

## 5. Risks and mitigations

- **Heavy-dep import of worker `main.py` in the integration environment** — mitigated by the `failure_payload.py` extraction; the contract test imports only the light module. Stage-tracker tests that need `process_document` run in the worker's own suite, which already exercises `main.py` code (verify its conftest harness during implementation).
- **`run_transactional_update` Firestore surface not yet enumerated** — the failed branch was pinned by the Definition (F4), not read line-by-line during investigation. Step 6 above enumerates its exact surface (transactional decorator, `transaction.get/update/set`, `SERVER_TIMESTAMP`, document/collection paths) before the fake is written.
- **Stage-tracker drift** as pipeline steps are added — mitigated by the update-before-await convention and representative early/late-stage tests that fail if the tracker is removed or bypassed.
- **`retryable=false` for unclassified-unknown errors** reduces auto-retry affordances for unrecognized-but-transient failures — accepted per Definition; manual reprocess unaffected.
- **AST drift-guard brittleness** — scope the AST extraction tightly to the failed branch / builder function so unrelated edits to either file don't cause false failures.

## 6. Out of scope (per Definition nonGoals)

Stale-lease sweep behavior; ACK/NACK policy, leases, heartbeats; structured error-code taxonomy (`processing/summary` `error.code` stays `"UNKNOWN"` unless a code is actually sent); frontend/mobile changes; the companion D3 issue's scope; reconciling with the absent `plans/upload-flow.md` D4 note.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan: worker → rag-api failure payload contract

Covers Definition acceptance criteria AC1–AC4. Three layers: (A) worker unit tests for the payload builder, (B) worker unit tests for stage tracking through `process_document`, (C) the cross-service contract test with a key-set drift guard.

## A. Worker unit tests — payload builder

File: `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`
Import target: `failure_payload.build_failure_details`, `failure_payload.classify_error`, exception classes (light module; no heavy deps, no module-level GCP side effects).

| # | Test | Asserts |
|---|---|---|
| A1 | `test_payload_exact_key_set` | `set(build_failure_details(exc, "text_retrieved").keys()) == {"error_message", "error", "stage", "retryable"}` — exact equality, so adding/removing a key fails loudly (drift guard on the producer side). |
| A2 | `test_payload_values_transient` | `httpx.ConnectError("weaviate timeout")` → `error_message == "weaviate timeout"`, `error == error_message` (legacy hedge), `stage == "text_retrieved"`, `retryable is True`. |
| A3 | `test_payload_retryable_permanent` | `PermanentError("bad input")` → `retryable is False`; `ValueError("unclassified")` → `retryable is False` (conservative default); `httpx.HTTPStatusError` with 503 response → `retryable is True`, with 400 → `retryable is False`. |
| A4 | `test_stage_fallback_when_unknown` | `build_failure_details(exc, "")` and `build_failure_details(exc, None)` → `stage == "processing"` (never null/empty). |
| A5 | `test_classify_error_unchanged_by_move` | Spot-check `classify_error` semantics post-move (`TransientError`→True, `PermanentError`→False, `TimeoutError`→True, unknown→False) so the pure-move refactor is pinned. |

## B. Worker unit tests — stage tracking in `process_document`

Same file (or sibling `test_process_document_stages.py` in the same suite). Harness: build `EnhancedDocumentProcessor` via `object.__new__(EnhancedDocumentProcessor)` (bypasses `_init_services` and `ProcessingConfig`), set the attributes `process_document` touches (`config` stub, `langfuse = None`, `content_tagger` stub, `db` MagicMock), stub `_publish_status_update` on the instance to capture `(status, details)` calls, and monkeypatch the pipeline step methods. This pins the tracker mechanism on representative stages without standing up Firebase/Pub/Sub.

| # | Test | Setup | Asserts |
|---|---|---|---|
| B1 | Early failure | `_validate_processing_request` raises `ValueError("doc missing")` | Exactly one `failed` publish; `details["stage"] == "starting"`; `details["error_message"] == "doc missing"`; `details["retryable"] is False` (ValueError → permanent). |
| B2 | Mid failure | `_get_extracted_text` raises `httpx.ConnectError("gcs down")` | `details["stage"] == "text_retrieved"`; `details["retryable"] is True`. |
| B3 | Late failure | Steps through chunking; `_generate_embeddings_with_openrouter` raises `RuntimeError("embedding boom")` | `details["stage"] == "embeddings_complete"`; `details["retryable"] is False`. |
| B4 | Success path emits no failure | All steps stubbed to succeed (summary stubbed to `None`, `db` mocked) | No `failed` publish; final publish has `status == "completed"`. |
| B5 | Tracker survives publisher failure | `_publish_status_update` raises inside the handler's call | Exception does not escape `process_document`'s contract (handler returns `metrics` with `error_message` set) — guards against the tracker refactor accidentally changing the swallow behavior. |

These tests fail if the tracker is removed, bypassed, or set *after* the await (the update-before-await convention), satisfying the Definition's representative-stage requirement (early + late) without ossifying every step.

## C. Cross-service contract test

File: `apps/ai-server/tests/integration/test_worker_failure_contract.py`
Extends the existing `tests/integration/conftest.py` pattern (env defaults, `MagicMock` of `firebase_admin` / `google.cloud.*` / `structlog`, `rag-api-service` on `sys.path`) with: `rag-worker-service` added to `sys.path` (for `failure_payload`), and — only if the real `run_transactional_update` needs them — pinning the firestore mocks the failed branch touches (e.g. `firebase_admin.firestore.transactional` as identity decorator, `SERVER_TIMESTAMP` sentinel). The exact pin list is produced by first enumerating the failed branch's Firestore API surface (plan step 6); the fake is built to match, no more.

### C.1 Fake Firestore (in-memory)

Minimal fakes scoped to the failed branch: `FakeDocumentRef` (path-keyed in-memory store; `get(transaction=...)` → snapshot with `exists` / `to_dict()`; `update()` / `set()` with merge semantics), `FakeTransaction` (applies queued writes on commit), `FakeCollection` / `collection("processing").document("summary")`. Injected into the mocked `firestore.client()` return value.

### C.2 Dynamic seam tests (AC2, AC3, AC4)

Import **both sides**: worker's `failure_payload.build_failure_details` (real producer code) and rag-api's `run_transactional_update` (real consumer code, via `main as rag_api_main`). No contract keys restated in fixtures.

| # | Test | Act | Assert |
|---|---|---|---|
| C1 | `test_transient_failure_persists_worker_values` | Seed a resource doc (`status: "processing"`); `details = build_failure_details(httpx.ConnectError("weaviate timeout"), "embeddings_complete")`; drive the failed branch of `run_transactional_update` with a status message `{"status": "failed", "details": details, ...}` | Main doc: `error == "weaviate timeout"` (≠ `"Processing failed"`), `error_stage == "embeddings_complete"` (not None), `retryable is True`. `processing/summary` subdoc: message `== "weaviate timeout"`, stage `== "embeddings_complete"`. |
| C2 | `test_permanent_failure_persists_retryable_false` | Same with `ValueError("invalid pdf")`, stage `"starting"` | Persisted `error == "invalid pdf"`, `error_stage == "starting"`, `retryable is False` — pins the deliberate behavior change for unclassified errors and proves the API's `retryable` default fallback is no longer operative for worker failures. |
| C3 | `test_fallbacks_not_operative` | Feed a payload built by the worker for an exception whose `str()` is non-empty | Persisted `error` equals the worker's message and `error_stage` equals the worker's stage — i.e. none of the API-side fallback defaults (`"Processing failed"`, None, `True`) appear anywhere in the persisted document (AC1 + AC2 end-to-end). |

### C.3 Static drift guard (AC4 "fail if either side's keys drift")

AST-based, following the house subprocess/AST pattern in `test_api_contracts.py` (`_get_agent_graph_shapes`):

- `test_rag_api_failed_branch_reads_exact_keys`: parse `rag-api-service/main.py`, locate the failed branch of `run_transactional_update`, extract every key read from `details` (`details.get("k", ...)` subscripts/attribute patterns) → must equal exactly `{"error_message", "stage", "retryable"}`.
- `test_worker_payload_covers_api_reads`: worker payload key set (from A1's builder, imported live) ⊇ the API's read set; the surplus (`{"error"}`) is asserted to be exactly the documented legacy hedge, so silently growing or shrinking either side fails the build.
- Account for `_publish_status_update`'s optional `jobId` injection: the guard applies to `build_failure_details` output (pre-publisher), with a comment noting `jobId` may be added downstream.

## D. Environment and execution

- Worker unit tests: `pytest apps/ai-server/rag-worker-service/tests` (uses the worker suite's existing conftest; verify its import/mocking harness during implementation).
- Contract tests: `pytest apps/ai-server/tests/integration` (extended conftest; hermetic — fakes, no emulator required).
- Regression: `pytest apps/ai-server/rag-api-service/tests` must pass unchanged (rag-api has no code changes).
- Firestore-emulator mode is a valid alternative to the fakes (both services have `FIRESTORE_EMULATOR_HOST` branches), but fakes are the default here: deterministic, no infra dependency, and the mocked-conftest house pattern already exists. If the hermetic stack's CI already boots the emulator, the dynamic seam tests (C.2) may be run against it instead — the assertions are identical.

## E. Acceptance mapping

| Acceptance criterion (Definition) | Covered by |
|---|---|
| AC1 — failed payload carries `error_message` / `stage` / `retryable`, no reliance on API fallbacks | A1–A4, B1–B3, C3 |
| AC2 — persisted `error` / `error_stage` / `retryable` equal worker's values | C1, C2 |
| AC3 — `processing/summary` subdocument carries same message and stage | C1 |
| AC4 — contract test exists, passes, fails on key drift on either side | C1–C3 + drift guard tests |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>