<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (authoritative Definition artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This plan implements exactly that bounded scope. Iteration 1, step: plan.

## 0. Problem statement (verified against the repository)

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam.

**Worker side** — `apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler (single `try` wrapping the whole pipeline; handler at the end of the method, approx. lines 1095–1101):

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", ...)
    await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

One key: `error`. No stage tracking exists anywhere in `process_document`.

**API side** — `apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch (approx. lines 247–250 and 308–313):

```python
main_update["error"] = details.get("error_message", "Processing failed")
main_update["error_stage"] = details.get("stage")
main_update["retryable"] = details.get("retryable", True)
...
summary_update["error"] = {
    "code": details.get("error_code", "UNKNOWN"),
    "message": details.get("error_message", "Processing failed"),
    "stage": details.get("stage"),
}
```

Three keys read: `error_message`, `stage`, `retryable`. Because the worker sends none of them, **every worker-originated failure persists** `error = "Processing failed"`, `error_stage = None`, `retryable = True` (silent default), plus a `processing/summary` error subdocument with `code: "UNKNOWN"`, the fallback message, and a null stage.

**The rest of the system already speaks the persisted schema** (verified):
- Worker `_fail_if_still_stale` writes `error` / `error_stage: "processing"` / `retryable: True` directly.
- rag-api's enqueue-failure paths (`/process`, `POST /resources`) write the same fields directly (Definition F6).
- `models/resource.py` `Resource` carries `error` / `error_stage` / `retryable: bool = True`; `ResourceResponse` exposes `error` and `error_stage`.

The worker's status publisher is the only writer that doesn't speak the schema. **Fix the odd one out**: align the worker to the API. No migration, no rename, no backfill, no reader changes (Definition must/must_not constraints).

## 1. Design

### 1.1 New pure helper: `build_failure_payload` (worker)

Module-level function in `rag-worker-service/main.py`, placed immediately after `classify_error` (approx. line 90). Single owner of the failure-payload contract on the worker side:

```python
def build_failure_payload(error: Exception, stage: Optional[str] = None) -> Dict[str, Any]:
    """
    Build the `details` payload for a "failed" status update.

    Contract with rag-api's run_transactional_update failed branch:
      error_message → persisted as the resource's `error`
      stage         → persisted as `error_stage` (and summary error.stage)
      retryable     → persisted verbatim; derived from classify_error so the
                      record matches the worker's actual ACK/NACK behavior
    `error` is a legacy duplicate of the message, retained for any other
    consumer of the status topic. No error_code is emitted — summary
    error.code stays rag-api's "UNKNOWN" default.
    """
    message = str(error)
    return {
        "error": message,           # legacy key, retained for topic consumers (Definition F11 hedge)
        "error_message": message,   # rag-api contract key
        "stage": stage or "processing",
        "retryable": classify_error(error),
    }
```

Decisions pinned here:
- **Key set is exactly** `{error, error_message, stage, retryable}`. No `error_code` (Definition prefer-not: no taxonomy; summary `error.code` stays `"UNKNOWN"`).
- **`retryable` is always explicit**, derived from `classify_error(error)` — never defaulted. Adopted derivation (Definition F8): transient-classified → `true`; permanent-classified, including unclassified-unknown per `classify_error`'s conservative `return False`, → `false`.
- **`stage` normalization**: falsy stage (`None`, `""`) → `"processing"` — the same safe value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.
- **Legacy `error` key retained** alongside `error_message` (Definition prefer-constraint; one redundant string per failure as insurance for unknown status-topic consumers).

### 1.2 Stage tracker in `process_document` (worker)

`process_document` is one large `try`; at failure time nothing knows where it was. Add a local `current_stage` with the convention **"set the tracker immediately before the await of each pipeline step"**, reusing the existing progress-stage vocabulary so a failure stage reads naturally next to the progress timeline clients already see.

| Pipeline step (verified order in `process_document`) | Tracker value set immediately before the step's await |
|---|---|
| (function top, before `try`) | `"processing"` — safe value when genuinely unknown |
| `_validate_processing_request` (+ the `"starting"` progress publish) | `"starting"` |
| `_get_extracted_text` | `"text_retrieved"` |
| `content_tagger.generate_tags` | `"tagging_complete"` |
| `generate_document_summary` + `ragDescription` doc update | `"summary_generated"` |
| `_create_enhanced_chunks` | `"chunking_complete"` |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |
| `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection` (unnamed region between the `embeddings_complete` and `completed` publishes) | remains `"embeddings_complete"` — the pinned vocabulary has no distinct name for this region; re-reporting the last entered named stage is more informative than the null-ish fallback |

Semantics documented in a code comment: `error_stage` names the pipeline step **in flight** at failure, using that step's progress-vocabulary name. Known approximation: a failure in the post-embedding storage region reports `"embeddings_complete"`. Deliberate; pinned by contract tests on representative stages (early + late), which catch the tracker being removed or bypassed without ossifying every step.

`"completed"` is never a failure stage: the two post-completion calls (`_update_user_usage`, `_generate_resource_map`) swallow their own exceptions internally (verified), so nothing after the `completed` publish escapes to the handler.

### 1.3 Exception-handler rewiring (worker)

Replace the one-key publish; keep everything else in the handler intact:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error(
        "document_processing_failed",
        user_id=user_id, course_id=course_id, resource_id=resource_id,
        error=str(e), stage=current_stage, retryable=classify_error(e),
    )
    await self._publish_status_update(
        user_id, course_id, resource_id,
        "failed",
        build_failure_payload(e, current_stage),
        job_id,
    )
    if trace: trace.update(output={"success": False, "error": str(e), "stage": current_stage})
    return metrics
```

- `metrics.error_message` (field already exists on `ProcessingMetrics`, verified) keeps its current assignment.
- The failure log gains `stage` and `retryable` for operability — reporting only, no behavior change.
- `_publish_status_update` is otherwise untouched; it continues to add `jobId` to details (verified: `if job_id and 'jobId' not in details`), manage sequence numbers, and heartbeat the lease. Progress publishes (`processing` status with `stage`/`progress`) are unchanged.

This is the **only** worker site that publishes a `"failed"` status (verified): claim failures in `run_worker` ack without publishing; `_fail_if_still_stale` writes Firestore directly; `regenerate-map` failures go through `run_worker`'s ACK/NACK path without a failed publish. So "every worker-originated failure payload" is covered by this one change.

### 1.4 rag-api: zero code changes (verification target)

`run_transactional_update` already persists worker-provided values unchanged (verified code above): `error ← details["error_message"]`, `error_stage ← details["stage"]`, `retryable ← details["retryable"]` verbatim when present; summary `error.message`/`error.stage` carry the same values; `error.code` stays `"UNKNOWN"` because the worker sends no code. `models/resource.py` is untouched. The Definition's must-constraint ("align the worker … rather than changing rag-api's reads or persisted schema") is satisfied by construction; the contract test pins the API side so drift there fails the build.

### 1.5 Contract test (new file)

New file `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py`, next to the existing fixture/AST-based `test_api_contracts.py` (Definition F10 infrastructure; same directory, same house patterns). Dedicated file rather than an addition to `test_api_contracts.py` because that file binds `import main as rag_api_main` at module scope under the shared conftest's MagicMock stubs; a separate module controls its own import regime precisely (details in `docs/test-plan.md`).

Core property: **import/exercise both sides rather than restate the contract in a fixture.**

1. **Worker side (subprocess A)** — loads the worker's real module under the verified worker-conftest stub recipe, builds an `EnhancedDocumentProcessor` via `__new__` with fake collaborators, runs the **real `process_document`** with an injected failing step, and captures the actual Pub/Sub message envelope published by the real `_publish_status_update`. Injected failures at three representative stages:
   - tagging step raises `RuntimeError` → permanent → `retryable: false`, stage `"tagging_complete"`,
   - embeddings step raises `RuntimeError` → permanent → `retryable: false`, stage `"embeddings_complete"`,
   - extraction step raises `httpx.ConnectTimeout` → transient → `retryable: true`, stage `"text_retrieved"`.
2. **Seam handoff** — the captured envelope's `details` dict is written to a temp JSON file. The file stands in for the Pub/Sub message; the keys in that file are the contract.
3. **API side (subprocess B)** — loads rag-api's real module under the verified integration-conftest stub recipe, but with a fake `firebase_admin.firestore` overlay providing a real identity `transactional` decorator (the shared conftest's bare MagicMock would silently prevent the transactional body from executing — a MagicMock decorator result is never called), replays each captured `details` into the **real `run_transactional_update`** against fake Firestore objects (doc seeded `status: "processing"` so the `processing → failed` transition is allowed per `ALLOWED_TRANSITIONS`), and records the persisted main-doc update and `processing/summary` set.
4. **Assertions (parent test)** — for every scenario: persisted `error == payload["error_message"]`, `error_stage == payload["stage"]`, `retryable == payload["retryable"]`; `error != "Processing failed"`; `error_stage` non-null; summary `error.message`/`error.stage` equal the same values and `error.code == "UNKNOWN"`; worker key set (minus `jobId`) is exactly `{error, error_message, stage, retryable}`. Plus API-fallback seam probes and AST drift guards (full case list in `docs/test-plan.md`).

Why subprocesses: the two services have different, incompatible stub regimes (worker conftest uses precise `ModuleType` stubs; the shared integration conftest uses `MagicMock`), both `main.py` files are heavy and named `main`, and both packages ship a `models/` directory. Two isolated subprocesses joined by a JSON file exactly mirror the real Pub/Sub seam, avoid cross-import pollution, and follow the existing subprocess precedent in `test_api_contracts.py` (`_get_agent_graph_shapes`).

Why fakes instead of the Firestore emulator: both services have emulator branches (verified in worker `_init_services` and API `startup`), but the contract under test is the **payload-key** contract, not transaction semantics. Fakes are deterministic, need no running services, and keep the suite hermetic. The fake `firestore.transactional` is an identity decorator — the real decorator's semantics belong to the Firestore SDK, not to this contract. Documented tradeoff; the emulator remains a possible future escalation.

### 1.6 Worker unit tests (new file)

`apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`, running under the worker's existing `pytest.ini` + `conftest.py` stub regime (worker unit tests already import `main` under these stubs — e.g. `test_processing_lease.py` exercises lease functions that live in `main.py`). Covers the pure functions:

- `classify_error` → retryable mapping table (transient types/status codes → True; `PermanentError`, other 4xx, unknown exceptions → False).
- `build_failure_payload`: exact key set; `error == error_message == str(e)`; stage normalization to `"processing"`; no `error_code` key; `retryable == classify_error(e)`.

### 1.7 AST drift guards (in the contract-test file)

Supplementary static guards, following the AST pattern already used in `test_api_contracts.py`:

- **Worker**: parse `rag-worker-service/main.py`; inside `process_document`'s except handler assert the `_publish_status_update(..., "failed", ...)` call references `build_failure_payload` and the `current_stage` tracker variable; assert tracker assignments cover all six vocabulary names (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`).
- **API**: parse `rag-api-service/main.py`; inside `run_transactional_update` assert the set of `details.get("<key>")` constants includes `error_message`, `stage`, `retryable`.

These make key renames on either side fail statically even before the dynamic probes run. Ossification is intentional (Definition: "Adding a key later means touching the test, which is the point").

## 2. Files changed

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Add `build_failure_payload` after `classify_error`; add `current_stage` tracker to `process_document` (initializer + assignments per §1.2); rewire except handler per §1.3; enrich failure log. **No other worker changes.** |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | New: classify/retryable table + builder unit tests (§1.6). |
| `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py` | New: subprocess harness + persistence-equality + fallback probes + AST drift guards (§1.5; details in test plan). |

**Explicitly unchanged** (verified as already correct or out of scope): `rag-api-service/main.py` (incl. `run_transactional_update`, `_process_status_message`, enqueue paths), `rag-api-service/models/resource.py`, worker `_fail_if_still_stale` / `_stale_lease_sweep_loop` / `_heartbeat_loop` / `run_worker` ACK-NACK / `classify_error` / `exceptions.py`, `ResourceResponse`, all frontend/mobile surfaces, Pub/Sub retry policy, leases, heartbeats, `.env` files, Firestore indexes.

## 3. Implementation steps (ordered, each with verification)

1. **Worker: add `build_failure_payload`.** Pure function; no imports beyond what `main.py` already has. Verify: module imports cleanly under worker test stubs.
2. **Worker: add stage tracker + rewire handler.** Apply §1.2 table and §1.3 snippet. Verify: `cd apps/ai-server/rag-worker-service && pytest tests` — full existing worker suite passes (incl. `test_processing_lease.py`, chunking, tagger tests).
3. **Worker unit tests.** Add `tests/unit/test_failure_payload.py` per §1.6. Verify: `pytest tests/unit/test_failure_payload.py` green.
4. **Contract test.** Add `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py` per `docs/test-plan.md`. Verify: `pytest apps/ai-server/tests/integration/test_worker_failure_payload_contract.py` green.
5. **Regression.** Run the existing integration file (`test_api_contracts.py`) to prove no stub/import interference (the new file must not mutate global state at import time — subprocesses and AST reads only). Run rag-api's own suite (`cd apps/ai-server/rag-api-service && pytest tests`) — expected untouched-green since rag-api has no code changes.
6. **Acceptance review.** Walk the §6 mapping; confirm each acceptance criterion has a named test.

Note on `httpx` exception construction in tests: `httpx.HTTPStatusError` requires `request=`/`response=` kwargs and timeout exceptions may require `request=` depending on the installed httpx version — construct with real `httpx.Request`/`httpx.Response` objects where needed (httpx is a real dependency of the worker; verified imported by `main.py` and not stubbed by the worker conftest). Flagged so it doesn't surprise during implementation.

## 4. Behavior changes and edge cases

- **Intentional behavior change (surface in review/PR description):** unclassified-unknown exceptions previously persisted `retryable: true` (rag-api's silent default) but classify as permanent under `classify_error`; they will now persist `retryable: false`. This is the conservatism `classify_error` was written for (prevents infinite retry loops) and aligns the record with the worker's actual ACK behavior (permanent errors are acked; manual reprocess via `POST /process` remains available). Permanent-classified errors (e.g. `ValueError` "Document not found") likewise flip true→false. Transient-classified failures persist `true` as before. Widening `classify_error` itself is out of scope.
- **Validation failures** (doc not found / ownership mismatch) report stage `"starting"` — the tracker is set before the validation await. Truthful and in-vocabulary.
- **Empty exception messages** persist `error_message: ""` (key present, so rag-api's fallback does not fire). Truthful per the Definition ("the actual exception message"); a class-name fallback embellishment was considered and rejected as outside the bounded scope.
- **Progress publishes unchanged**: the API's `processing`/`completed` branches read `stage`/`progress`/`jobId`/metrics keys that remain intact; the contract test asserts no error keys leak into progress publishes.
- **`_publish_status_update` still swallows publish errors** (logs `status_publish_failed`) — a failure to publish the failure is existing behavior, out of scope.

## 5. Constraint & requirement compliance

| Definition constraint | How this plan satisfies it |
|---|---|
| must: align worker to API contract, don't change rag-api | Only worker `main.py` changes; rag-api is a verification target pinned by the contract test. |
| must_not: no migration/rename/backfill | Persisted fields `error`/`error_stage`/`retryable` keep names and semantics; no schema touch. |
| must: retryable always explicit, never the API fallback | `build_failure_payload` always sets `retryable` from `classify_error`; contract test asserts the fallback path is not operative for worker payloads. |
| prefer: retain legacy `error` key | Builder emits both `error` and `error_message`. |
| prefer_not: no error-code taxonomy | No `error_code` emitted; summary `error.code` stays `"UNKNOWN"`. |
| Requirements R1–R5 | R1/R2: §1.1–1.3 (payload keys, stage vocabulary + `"processing"` fallback). R3: §1.4 (API persists unchanged — pinned by test). R4: §1.1 derivation rule. R5: §1.5–1.7 (contract test + drift guards). |

## 6. Acceptance mapping

| Acceptance criterion | Covered by |
|---|---|
| A1: failed payload contains `error_message`/`stage`/`retryable`, none relying on API fallbacks | Unit tests (§1.6) + contract-test envelope assertions (scenario cases TC-1…TC-3 in test plan) |
| A2: persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = derived value | Contract-test persistence-equality assertions + negative fallback probe (TC-4) demonstrating the old failure mode |
| A3: processing/summary error subdocument carries same message and stage | Contract-test summary assertions (part of TC-1…TC-3) |
| A4: contract test exists, passes, fails on either side's key drift | New test file + key-set assertions + AST drift guards (TC-6, TC-7) |

## 7. Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error`; residual risk accepted as low (Definition F11).
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope, and manual reprocess via `POST /process` remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard doing its job.
- **Subprocess harness brittleness** if either `main.py`'s module-level import requirements change — mitigated by mirroring the existing conftest recipes exactly; failure mode is a loud import error, not a silent pass.

## 8. Out of scope (per Definition nonGoals)

Stale-lease sweep behavior; retry/backoff mechanics (ACK/NACK policy, leases, heartbeats — only the *reporting* of retryability changes); frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`); structured error codes (summary `error.code` stays `"UNKNOWN"` unless a code is actually sent); anything the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context — deferred), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (that file's presence was not verified in this session; the reference comes from the Objective text — deferred).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker failure payload → rag-api persistence contract

Scope: the tests required by Definition `wi-define-108-a8` requirement R5 and acceptance A1–A4. All paths relative to `apps/ai-server/`.

## 1. Test inventory

| # | File | Layer | What it pins |
|---|---|---|---|
| T1 | `rag-worker-service/tests/unit/test_failure_payload.py` | Worker unit | `classify_error` → retryable table; `build_failure_payload` key set/normalization |
| T2 | `tests/integration/test_worker_failure_payload_contract.py` | Cross-service contract | Worker failure-payload construction → rag-api failed-branch persistence, end to end through the real code on both sides |
| T3 | (inside T2) AST drift guards | Static | Payload keys and stage vocabulary on both sides |

Existing suites that must stay green (regression, no edits): worker `pytest tests` (incl. `test_processing_lease.py`), `tests/integration/test_api_contracts.py`, rag-api `pytest tests`.

## 2. T1 — worker unit tests

Environment: worker's own `pytest.ini` (`asyncio_mode = auto`) and `tests/conftest.py` stub regime (verified: precise `ModuleType` stubs for openai/langfuse/firebase_admin/google.cloud.*/spacy/tiktoken/tenacity; env defaults set; `import main` at module level is proven safe by `test_processing_lease.py`).

`from main import build_failure_payload, classify_error, TransientError, PermanentError`

### Cases

- **classify/retryable table** (parametrized):
  - `TransientError("x")` → True; `PermanentError("x")` → False.
  - `httpx.ConnectTimeout`, `httpx.ReadTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` → True.
  - `httpx.HTTPStatusError` with status 429/500/502/503/504 → True; 400/404 → False. Construct with real `httpx.Request("GET", "http://x")` and `httpx.Response(status_code, request=...)` (httpx is real in this env — the worker conftest does not stub it).
  - `RuntimeError("unexpected")` (unclassified-unknown) → False (conservative default).
- **builder key set**: `set(build_failure_payload(e, "tagging_complete")) == {"error", "error_message", "stage", "retryable"}` — exact equality, so adding/removing a key fails here first.
- **builder message duplication**: `payload["error"] == payload["error_message"] == str(e)`.
- **builder stage normalization**: `stage=None` → `"processing"`; `stage=""` → `"processing"`; `stage="chunking_complete"` → `"chunking_complete"`.
- **builder retryable derivation**: `payload["retryable"] == classify_error(e)` for a transient and a permanent example.
- **no error_code**: `"error_code" not in payload` (pins the prefer-not constraint).

## 3. T2 — cross-service contract test

File: `tests/integration/test_worker_failure_payload_contract.py` (new, in the existing integration directory beside `test_api_contracts.py`). The module must not import either service's `main` at module scope and must not mutate `sys.modules` at import time — all dynamic imports happen inside subprocesses — so it cannot interfere with `test_api_contracts.py` in the same pytest session.

### 3.1 Architecture: two subprocesses joined by a JSON file

```
subprocess A (worker)                     subprocess B (rag-api)
real process_document (fails)             real run_transactional_update
  → real _publish_status_update             fed details captured from A
  → fake PublisherClient captures             against fake Firestore objects
    the real Pub/Sub envelope                 → records main_update + summary set
        │                                                ▲
        └────────── details JSON (temp file) ────────────┘
```

Rationale (verified constraints that force this shape):
- The two services' conftest stub regimes are incompatible (worker: precise `ModuleType` stubs; shared integration conftest: `MagicMock`), both entry modules are named `main`, and both packages ship a `models/` directory — co-import in one process is fragile.
- **MagicMock trap**: under the shared conftest, `firebase_admin.firestore` is a MagicMock, so `@firestore.transactional` wraps `update_logic` into a MagicMock and the transaction body **never executes** — a naive in-process test would pass vacuously. Subprocess B therefore installs a fake `firebase_admin.firestore` module with `transactional = identity`, `SERVER_TIMESTAMP` sentinel, `Increment`, and a permissive `__getattr__` fallback, before importing rag-api's `main`. (Alternative if subprocesses prove brittle: mutate `sys.modules["firebase_admin"].firestore` in-process before importing `main` — same fake, same assertions; subprocesses preferred for isolation.)
- Subprocess precedent exists in-house: `test_api_contracts.py::_get_agent_graph_shapes` runs an AST script via `subprocess.run`.

### 3.2 Subprocess A — worker failure-payload construction

1. Set the worker conftest's env defaults (`GCP_PROJECT`, `RAG_PROCESS_SUB`, `RAG_STATUS_TOPIC`, `OPENROUTER_*`, `FIREBASE_*`, `SHARED_INTERNAL_TOKEN`, `WEAVIATE_SERVICE_URL`) and install the same stub modules the worker conftest installs (copy the recipe; do not import the worker conftest, to keep the parent process clean).
2. `import main as worker_main` (module-level `GCP_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS` reads and the stubbed `SubscriberClient` construction are covered by the recipe).
3. Build the processor without running `__init__`: `proc = worker_main.EnhancedDocumentProcessor.__new__(worker_main.EnhancedDocumentProcessor)`, then attach fakes:
   - `proc.config`: simple namespace with the attributes `process_document`'s executed path reads (`summary_model`, `summary_prompt_version`, `summary_max_chars`, `embedding_model`, `gcp_project`, `rag_status_topic`).
   - `proc.langfuse = None` (trace stays None).
   - `proc.db`: fake Firestore — `.document(path)` returns a fake ref whose `.get()` returns `.exists = False` (the lease-heartbeat block in `_publish_status_update` then skips cleanly) and which records `.update(...)` calls (needed by the summary-step document update).
   - `proc.pubsub_publisher`: fake with `topic_path(a, b) -> str` and `publish(topic, data) -> concurrent.futures.Future` (already `set_result(None)`; `_publish_status_update` does `await asyncio.wrap_future(future)`, which requires a real `concurrent.futures.Future`).
4. Monkeypatch pipeline steps on the instance (async functions): `_validate_processing_request` → no-op; `_get_extracted_text` → `("text", {"title": "t"})`; `content_tagger.generate_tags` → per scenario (raise or `([], {})`); `generate_document_summary` → `{"overview": "o", "bulletPoints": []}`; `_create_enhanced_chunks` → `[]`; `_generate_embeddings_with_openrouter` → per scenario (raise or `[[]]`); `delete_old_vectors_via_service` → `0`; `store_chunks_via_service` → `{"successful_inserts": 1, "failed_inserts": 0}`; `_save_processing_metadata_to_subcollection`, `_update_user_usage`, `_generate_resource_map` → no-ops.
5. **`_publish_status_update` is NOT patched** — the real method runs, so the captured envelope includes the real sequence/timestamp/jobId plumbing and the exact `details` dict the worker would put on the wire.
6. Run `asyncio.run(proc.process_document("u1", "__ungrouped__", "r1", "job-1"))` with the scenario's injected failure; assert the returned `metrics.error_message == str(injected)`; collect all published envelopes; write the `details` of the envelope with `status == "failed"` to the temp JSON file (plus, for scenario bookkeeping, the list of progress-envelope details).

### 3.3 Scenarios (representative-stage coverage)

| ID | Injected failure at | Exception | Expected stage | Expected retryable |
|---|---|---|---|---|
| TC-1 | `content_tagger.generate_tags` | `RuntimeError("tagger exploded")` | `tagging_complete` | false (permanent) |
| TC-2 | `_generate_embeddings_with_openrouter` | `RuntimeError("embedder exploded")` | `embeddings_complete` | false (permanent) |
| TC-3 | `_get_extracted_text` | `httpx.ConnectTimeout("upstream down")` (construct with `request=` if the installed httpx requires it) | `text_retrieved` | true (transient) |

Rationale: an early-stage and a late-stage permanent failure pin the tracker mechanism at both ends of the pipeline; the transient case pins the `classify_error` → `retryable` derivation end-to-end. This catches the tracker being removed or bypassed without ossifying every intermediate step (Definition's stated mitigation for stage-tracker drift).

### 3.4 Subprocess B — rag-api failed-branch persistence

1. Set the shared integration conftest's env (`GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `SHARED_INTERNAL_TOKEN`); install MagicMock stubs for the same module list, **except** `firebase_admin` and `firebase_admin.firestore`, which get the real-ish fake described in §3.1 (identity `transactional`, `SERVER_TIMESTAMP` sentinel, `Increment`, permissive `__getattr__`).
2. Add `rag-api-service` to `sys.path`; `import main as rag_api_main` (proven importable in this regime by the existing `test_api_contracts.py`, including the module-level `app_state = AppState(ApiConfig())`).
3. Build fake Firestore objects: fake db with `.transaction()` → token; fake `doc_ref` with `.get(transaction=...)` → snapshot(`exists=True`, `to_dict() -> {"status": "processing"}`) and `.collection("processing").document("summary")` → fake `summary_ref`; fake transaction recording every `.update(doc_ref, payload)` and `.set(summary_ref, payload, merge=True)` call.
4. For each scenario's captured `details`: call `rag_api_main.run_transactional_update(fake_db, doc_ref, "failed", details, stub_logger, "u1")` (stub logger = object with `.info`/`.warning`). Seeding `status: "processing"` makes `processing → failed` an allowed transition per `ALLOWED_TRANSITIONS` (verified), so the failed branch executes.
5. Emit the recorded `main_update` and `summary_update` as JSON for the parent test.

### 3.5 Parent-process assertions

For each of TC-1…TC-3, with `P` = captured worker payload and `M`/`S` = recorded API writes:

- **Envelope shape (A1)**: `P` keys (minus `jobId`) are exactly `{error, error_message, stage, retryable}`; `P["error"] == P["error_message"] == str(injected)`; `P["stage"]` is the scenario's expected stage; `P["retryable"]` is the scenario's expected value; `P` contains `retryable` as a real boolean (not absent).
- **Persistence equality (A2)**: `M["error"] == P["error_message"]`; `M["error_stage"] == P["stage"]`; `M["retryable"] == P["retryable"]`; `M["error"] != "Processing failed"`; `M["error_stage"] is not None`; `M["status"] == "failed"`.
- **Summary subdocument (A3)**: `S["error"]["message"] == P["error_message"]`; `S["error"]["stage"] == P["stage"]`; `S["error"]["code"] == "UNKNOWN"` (worker sends no code); `S["stage"] == P["stage"]`.
- **No leakage into progress publishes**: for each scenario, none of the captured `processing`-status envelopes contains `error_message`, `retryable`, or `error` in `details` (the API's processing branch must be unaffected).

### 3.6 Seam probes (API fallback behavior, pinning what the fix eliminates)

- **TC-4 (old payload)**: feed `details = {"error": "legacy failure"}` through subprocess B → assert `M["error"] == "Processing failed"`, `M["error_stage"] is None`, `M["retryable"] is True`. Documents the pre-fix failure mode as explicit, named behavior of the API's fallbacks — the exact values the fix removes for worker failures.
- **TC-5 (empty payload)**: `details = {}` → same fallback assertions. Pins that rag-api's fallbacks themselves are unchanged (API side pinned, per the must-constraint).

### 3.7 Static drift guards (T3)

- **TC-6 (worker AST)**: parse `rag-worker-service/main.py`. In `process_document`: (a) the `ExceptHandler` contains a Call to `_publish_status_update` with a `"failed"` constant argument, and that call's args reference a Call to `build_failure_payload` and the Name `current_stage`; (b) the set of string constants assigned to `current_stage` includes all of `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` (superset allowed — new stages may be added; removal of the mechanism fails).
- **TC-7 (API AST)**: parse `rag-api-service/main.py`. In `run_transactional_update`: the set of first-argument constants of `details.get(...)` calls includes `error_message`, `stage`, `retryable`. A rename on the API side fails here even before the dynamic probes run.

## 4. How to run

```
cd apps/ai-server/rag-worker-service && pytest tests            # T1 + worker regression
cd apps/ai-server && pytest tests/integration/test_worker_failure_payload_contract.py   # T2/T3
cd apps/ai-server && pytest tests/integration                   # proves no interference with test_api_contracts.py
cd apps/ai-server/rag-api-service && pytest tests               # rag-api regression (expect untouched-green)
```

CI note: the contract test needs no emulators or network — fakes only; `httpx`, `fastapi`, `pydantic(-settings)`, `structlog` must be importable in the test environment (they already are for the existing suites).

## 5. Failure modes this test design deliberately rejects

- **Restating the contract in a fixture** (e.g. hardcoding `{"error_message": ...}` in both directions without importing the code) — rejected: it can pass while both sides drift together. The harness runs the real `process_document` handler and the real `run_transactional_update`.
- **Vacuous transactional execution** — the MagicMock-decorator trap (§3.1) would make a naive API-side test pass without executing the failed branch; the identity-`transactional` fake plus assertions on recorded writes close it.
- **Silent fallback reliance** — TC-4/TC-5 keep the fallback behavior visible and pinned, so the operative-path assertions (persistence equality) cannot be satisfied by fallbacks.
- **Key drift on either side** — exact key-set assertions (T1, TC-1 shape) plus AST guards (TC-6/TC-7) fail the build on rename/addition/removal, which is the intended ossification.

## 6. Known limitations (accepted)

- The fake `firestore.transactional` is an identity decorator: Firestore transaction semantics (retries, snapshot isolation) are out of scope for this contract test; the emulator remains a possible future escalation (both services have verified emulator branches).
- Post-embedding storage-region failures report stage `"embeddings_complete"` (vocabulary limitation, documented in the plan); no dedicated test scenario pins that region — the two representative permanent scenarios pin the mechanism.
- The subprocess harness mirrors the current conftest recipes; if either service's module-level import requirements change, the harness fails loudly at import (acceptable — a loud failure is preferable to a silently vacuous contract test).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>