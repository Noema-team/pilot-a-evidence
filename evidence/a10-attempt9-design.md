<<<SLE-OUTPUT>>>
### .sle/work/wi-define-108-a8/design.md
# Design — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (Definition artifact `definition:obj-108`, sha256 `71f1c39c…89cac5` — authoritative, binding)
Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
Step: design (planning depth: minimal)

---

## 1. Problem (verified)

Two code paths on the worker→rag-api failure seam were written against different contracts:

**Worker publisher** — `apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler (verified verbatim):

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", ...)
    await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
```

**API consumer** — `apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch (verified verbatim):

```python
if new_status == "failed":
    main_update["error"] = details.get("error_message", "Processing failed")
    main_update["error_stage"] = details.get("stage")
    main_update["retryable"] = details.get("retryable", True)
...
if new_status == "failed":
    summary_update["error"] = {
        "code": details.get("error_code", "UNKNOWN"),
        "message": details.get("error_message", "Processing failed"),
        "stage": details.get("stage"),
    }
```

Net effect (verified): every worker-originated failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (silent default), and the `processing/summary` error subdocument inherits the fallbacks with `code="UNKNOWN"`. Meanwhile three other write paths already speak the target schema directly: the worker's stale-lease sweep `_fail_if_still_stale` (writes `error`/`error_stage="processing"`/`retryable=True`), rag-api's enqueue-failure paths (`POST /process` rollback and `POST /resources`, both write `error`/`error_stage="enqueue"`), and the persisted models (`models/resource.py` `Resource.error/error_stage/retryable`, `ResourceResponse.error/error_stage`). The worker's status publisher is the only writer that doesn't speak the schema. Nothing tests the seam.

## 2. Verified repository facts the design rests on

| # | Fact | Evidence (read this cycle) |
|---|------|----------------------------|
| V1 | Worker publishes progress stages `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, then `completed` in `final_details`, via `_publish_status_update(..., "processing", {"stage": X, "progress": N}, job_id)` | `rag-worker-service/main.py` `process_document` |
| V2 | `_publish_status_update(user_id, course_id, resource_id, status, details, job_id=None)` wraps details into `message_data.details`; injects `details['jobId']` when `job_id` is truthy and absent; resets sequence on `("completed","failed")`; swallows its own publish exceptions | `rag-worker-service/main.py` `_publish_status_update` |
| V3 | `classify_error(e) -> bool` (True = transient): `TransientError`→True, `PermanentError`→False, httpx connect/timeout types, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`→True, `HTTPStatusError` with 429/500/502/503/504→True and other 4xx→False, **unknown exceptions→False (conservative)** | `rag-worker-service/main.py` `classify_error` |
| V4 | `process_document` is one large `try` with a single `except Exception` at the end; no stage tracking exists today; it *catches* pipeline exceptions and returns `metrics` normally, so `run_worker` acks the message after the handler runs (run_worker's own `classify_error` branch only sees exceptions outside `process_document`) | `rag-worker-service/main.py` `process_document`, `run_worker` |
| V5 | Tenacity decorators (`@retry(stop_after_attempt(3)…)`) on `generate_document_summary`, `_generate_embeddings_with_openrouter`, `store_chunks_via_service` have no `reraise=True`, so exhausted retries surface as `RetryError` (unclassified → permanent per V3) | `rag-worker-service/main.py` |
| V6 | `ALLOWED_TRANSITIONS` admits `processing → failed` only; `failed → failed` no-ops (`new_status == current_status` early return) | `rag-api-service/main.py` `run_transactional_update` |
| V7 | Rag-api reads only `details` keys `error_message`, `stage`, `retryable`, `error_code` (failed branch) plus `progress`; it never reads the legacy `error` key | `rag-api-service/main.py` |
| V8 | `ResourceResponse` exposes `error` and `error_stage` but **not** `retryable`; `Resource` model defaults `retryable=True` | `rag-api-service/main.py`, `models/resource.py` |
| V9 | Both services have `FIRESTORE_EMULATOR_HOST` init branches; existing test patterns are mock/fake-based: `tests/integration/conftest.py` mocks `firebase_admin`/`google.cloud`/`structlog` and imports rag-api `main` successfully; `rag-worker-service/tests/conftest.py` stubs the worker's heavy deps (langchain, openai, langfuse, firebase_admin, google.*, spacy, tiktoken, tenacity) with a proven try/except pattern; `tests/unit/test_processing_lease.py` proves the FakeDb/FakeTx/FakeRef + `monkeypatch(main.firestore, "transactional"/"SERVER_TIMESTAMP")` pattern for transactional code | `apps/ai-server/tests/integration/{conftest.py,test_api_contracts.py,test_search_pipeline.py}`, `rag-worker-service/tests/{conftest.py,unit/test_processing_lease.py}` |
| V10 | apps/ai-server/tests/integration has no verified asyncio pytest config; its existing tests are synchronous | directory listing + both test files |
| V11 | Worker `main.py` at import time requires `os.environ["GCP_PROJECT"]`, `GOOGLE_APPLICATION_CREDENTIALS`, and calls `service_account.Credentials.from_service_account_file` + `SubscriberClient(...)` — the worker test conftest's env defaults + stubs satisfy all of these; `ProcessingConfig()` is only instantiated in `main()`, not at import | `rag-worker-service/main.py` module tail |

## 3. Contract specification (the pinned seam)

**Worker publishes** (`details` dict of a `status="failed"` message on the rag-status topic):

| Key | Type | Value | Status |
|-----|------|-------|--------|
| `error_message` | str | `str(e)` — the actual exception message | **new (required)** |
| `error` | str | `str(e)` — legacy key, retained (Definition F11 hedge) | retained |
| `stage` | str | failing stage, see §4.2 vocabulary table | **new (required)** |
| `retryable` | bool | `classify_error(e)` — deliberately derived, see §4.3 | **new (required)** |
| `jobId` | str | injected by `_publish_status_update` when `job_id` provided (V2) | existing transport behavior |
| `error_code` | — | **not sent** (Definition prefer-not; rag-api defaults summary `code` to `"UNKNOWN"`) | absent |

**Rag-api persists** (unchanged code; values now arrive): main doc `error ← details["error_message"]`, `error_stage ← details["stage"]`, `retryable ← details["retryable"]` (all fallback defaults become non-operative for worker failures); `processing/summary` gets `stage ← details["stage"]`, `progress ← 0` (worker sends none — unchanged from today), `error.{code:"UNKNOWN", message ← error_message, stage ← stage}`.

**Persisted field names and semantics are untouched** — no migration, rename, or backfill (binding must-not).

## 4. Design decisions

**D1 — The worker aligns to the API; rag-api code does not change.**
`rag-api-service/main.py` receives **zero** code changes. Its reads and the persisted schema are already consistent across three other write paths and both response models (V7, V8); the worker's publisher is the single outlier. Changing the API side would be the change that ripples; aligning the worker requires no migration. Rag-api appears in this cycle only as the *tested* half of the contract.

**D2 — Stage tracker in `process_document`.**

*Mechanism.* A local `current_stage` in `process_document`, initialized to `"processing"` (the safe value for a genuinely unknown stage — same value the stale-lease sweep uses for `error_stage`, so `error_stage` never regresses to null), assigned `"starting"` immediately before the first pipeline step (`_validate_processing_request`), and thereafter updated at each milestone boundary — immediately before each stage-announcing `_publish_status_update` call (i.e., set to the milestone just earned, before announcing it). The exception handler reports `current_stage`.

*Semantics (pinned interpretation).* The progress vocabulary is milestone-named (`*_complete`), so a failure stage must never claim a milestone that wasn't reached. The reported value is therefore **the last milestone announced (or `"starting"` from pipeline entry, `"processing"` before entry)** — the truthful expression of "the stage executing at failure time" in that vocabulary: the executing step is the one following the named milestone. This is also what makes a failure stage "read naturally next to the progress timeline clients already see" (Definition direction): the persisted stage always equals a value actually published on the progress timeline, never an event that never fired.

*Assignment table* (exact code locations for the implementer):

| Tracker assignment | Placement in `process_document` | Failure window it covers |
|---|---|---|
| `"processing"` | initialization at top of `try` | metrics/trace construction only |
| `"starting"` | immediately before `await self._validate_processing_request(...)` | validation, text retrieval/extraction (`_get_extracted_text`) |
| `"text_retrieved"` | immediately before the `{"stage": "text_retrieved", "progress": 20}` publish | tagging (`content_tagger.generate_tags`) |
| `"tagging_complete"` | immediately before the `{"stage": "tagging_complete", "progress": 40}` publish | summary generation + `ragDescription` doc update |
| `"summary_generated"` | immediately before the `{"stage": "summary_generated", "progress": 50}` publish | chunking (`_create_enhanced_chunks`) |
| `"chunking_complete"` | immediately before the `{"stage": "chunking_complete", "progress": 60}` publish | embeddings (`_generate_embeddings_with_openrouter`) |
| `"embeddings_complete"` | immediately before the `{"stage": "embeddings_complete", "progress": 80}` publish | vector delete/store, metadata save, completed publish |

Post-`completed` helpers (`_update_user_usage`, `_generate_resource_map`) already swallow their own exceptions (verified) and cannot reach the handler; no tracker value beyond `"embeddings_complete"` is needed for failure reporting.

*Drift-risk convention* (mirrors the Definition): any future pipeline step must update the tracker at its milestone boundary. The contract test pins the mechanism on representative stages (§D6 scenarios S1 early / S2–S4 late), which catches the tracker being removed or bypassed without ossifying every step.

**D3 — `retryable` derived from `classify_error`, never defaulted.**
The failed-payload construction calls the existing module-level `classify_error(e)` (V3) on the exception the handler caught:

- transient-classified → `retryable: true`
- permanent-classified, **including unclassified-unknown** (conservative default) → `retryable: false`

Deliberate behavior changes this produces (all accepted per Definition F8; documented here so review isn't surprised):

1. Unclassified-unknown exceptions flip from persisted `true` (silent default) to `false` — the conservatism `classify_error` was written for; manual reprocess via `POST /process` is unaffected.
2. Non-429 `4xx` HTTPStatusErrors and exhausted-tenacity `RetryError` (V5) classify permanent → `false`, consistent with the classifier's existing verdicts.
3. The stale-lease sweep's separate direct write keeps `retryable: true` — a dead worker is a transient condition by nature. Sweep untouched (nonGoal).

Note for the test design (from V4): pipeline failures are caught inside `process_document` and the message is acked after the handler returns; the derivation is keyed to `classify_error`'s verdict on the caught exception, exactly as the Definition pins. `run_worker`'s ACK/NACK branch is not touched (nonGoal).

**D4 — Legacy `error` key retained.**
The payload carries `error` alongside `error_message` (Definition F11 / prefer-constraint): one redundant string per failure as insurance for unverified consumers of the shared status topic and log tooling. Only rag-api's status subscriber is verified as a consumer. Dropping the duplicate later is trivial cleanup after any consumer audit.

**D5 — No error-code taxonomy.**
`error_code` is not sent; summary `error.code` stays `"UNKNOWN"` (verified default path, V7). Out of scope per Definition.

**D6 — Contract test (the load-bearing deliverable).**

*File:* `apps/ai-server/tests/integration/test_worker_failure_contract.py` (sibling of `test_api_contracts.py`, which is the established home for exactly this kind of seam pinning — Definition F10).

*Placement rationale:* this directory verifiably imports rag-api `main` (V9) with fastapi/httpx present (V10). The worker's `main` is imported lazily inside a session-scoped fixture that first installs the stub set proven in `rag-worker-service/tests/conftest.py` (langchain try/except pattern, openai, langfuse, firebase_admin + submodules, google.cloud.*, google.oauth2, google.auth.credentials, spacy, tiktoken, tenacity; add a guarded `sklearn.feature_extraction.text` stub since its presence in this env is unverified). Conftest's existing `GCP_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS` env defaults satisfy worker import-time requirements (V11). Lazy import inside a fixture keeps the stubbing from leaking into the other test modules in this directory.

*Worker side — real code path.* Build a processor via `object.__new__(EnhancedDocumentProcessor)` (bypasses `_init_services`), set instance attrs the handler path touches (`langfuse=None`, a logger), and monkeypatch instance methods per scenario. Stub `_publish_status_update` with an async recorder capturing `(status, details, job_id)`. Call `asyncio.run(processor.process_document(...))` inside **synchronous** tests — sidesteps the unverified asyncio config (V10) without changing suite setup.

*API side — real code path.* Import `main as rag_api_main` (existing conftest handles it); call `run_transactional_update(db, doc_ref, "failed", details, logger, user_id)` directly (it is synchronous) against the FakeDb/FakeTx/FakeRef pattern proven in `test_processing_lease.py`, with `monkeypatch.setattr(rag_api_main.firestore, "transactional", identity)` and `SERVER_TIMESTAMP` patched. The fake doc's `status` is `"processing"` so `processing → failed` is an allowed transition (V6); the transaction's `update(main_update)` and `set(summary_ref, summary_update, merge=True)` writes are recorded.

*Scenario matrix* (each scenario: worker failure → captured payload → fed *unmodified* into rag-api's failed branch → persisted asserts):

| ID | Patched to raise | Expect worker payload | Expect persisted (main doc) |
|----|------------------|----------------------|------------------------------|
| S1 early/transient | `_get_extracted_text` → `TransientError("boom-early")` | `error_message="boom-early"`, `stage="starting"`, `retryable=True` | `error="boom-early"`, `error_stage="starting"`, `retryable=True` |
| S2 late/transient | `_generate_embeddings_with_openrouter` → `httpx.ConnectError("conn")` | `stage="chunking_complete"`, `retryable=True` | same values persisted |
| S3 late/permanent | `store_chunks_via_service` → `PermanentError("partial write")` (patch `_generate_embeddings_with_openrouter` → `[[0.1]]`, `delete_old_vectors_via_service` → `0`) | `stage="embeddings_complete"`, `retryable=False` | `retryable=False` |
| S4 unknown/permanent | `_create_enhanced_chunks` → `RuntimeError("weird")` | `stage="summary_generated"`, `retryable=False` | `retryable=False` |

Non-raised pipeline methods in S2–S4 are patched to minimal fakes (verified feasible against the real `process_document` flow: chunks need only a `token_count` attribute; `generate_document_summary` → `None`; db → simple fake with `.document(path).update(...)`).

*Assertions per scenario (this is the drift guard):*

1. Worker payload key set is exactly `{"error_message", "error", "stage", "retryable", "jobId"}` (scenarios run with `job_id="job-1"`; V2 guarantees the injection) — pins the hedge key so its removal is a deliberate, reviewed event, and pins that no key was dropped.
2. Persisted main doc `error == error_message`, `error_stage == stage`, `retryable == retryable`, all equal to the worker's **original** exception values — identity through both real code paths. Any key rename on either side breaks these equalities (worker omission → rag-api fallback `"Processing failed"`/`None`/`True` diverges; api-side rename → same divergence). Behavioral drift detection on both halves; no contract restated in a fixture.
3. `retryable` is exactly the worker-derived `bool` (and a real bool). **S3 and S4 are the silent-default canaries:** if the worker ever stops sending `retryable`, rag-api's `details.get("retryable", True)` yields `True` and the `is False` assertion fails — the transient scenarios alone cannot distinguish sent-vs-defaulted, which is why the matrix includes permanent cases.
4. `processing/summary` subdocument: `stage == worker stage` (not `"unknown"`), `error.message == worker message`, `error.stage == worker stage`, `error.code == "UNKNOWN"` (acceptance criterion 3; also pins that no error-code taxonomy crept in).
5. Worker recorder received `status == "failed"` with the correct user/course/resource ids.

Optionally (cheap, not required by the Definition): a worker-unit mirror of S1 in `rag-worker-service/tests/unit/` reusing the same recorder trick. Default: skip — the integration module already covers the handler, and the Definition asks for one contract test.

## 5. Files to change (implementation checklist)

1. **`apps/ai-server/rag-worker-service/main.py`** — only `process_document`:
   - add `current_stage` local + assignments per the §D2 table;
   - replace `{"error": str(e)}` in the exception handler with the §3 payload dict (`error_message`, `error`, `stage=current_stage`, `retryable=classify_error(e)`).
   No other worker code changes: `classify_error`, `run_worker`, `_publish_status_update`, heartbeat, lease, sweep, `_fail_if_still_stale` untouched.
2. **`apps/ai-server/tests/integration/test_worker_failure_contract.py`** — new, per §D6.
3. **`apps/ai-server/tests/integration/conftest.py`** — no changes expected (its env defaults already satisfy worker import; stubs are installed lazily by the new module's fixture). If the lazy fixture proves insufficient at implementation time, prefer in-module bootstrapping over widening shared conftest.

Nothing else: no rag-api source change, no model change, no frontend change, no schema/migration.

## 6. Edge cases and preserved behaviors (verified, unchanged by design)

- `_publish_status_update` swallows its own publish failures (`status_publish_failed`) — a failed job whose failure message can't be published still returns metrics; unchanged.
- Sequence reset on terminal states and `jobId` injection (V2) — unchanged; test tolerates the injected key explicitly.
- `failed → failed` no-op (V6): a failure publish racing an already-failed doc is safely ignored; a redelivered claim (`failed → queued → processing`) followed by failure is an allowed transition.
- `ResourceResponse` never exposed `retryable` (V8) — no client surface changes.
- Summary `progress` stays `0` on failure payloads (worker sends none today and after) — no regression.

## 7. Acceptance-criteria traceability

| Definition acceptance | Fulfilled by |
|---|---|
| A1: published failure payload carries error_message/stage/retryable, none defaulted | §D2, §D3, §4 payload table; test assertions 1–2 |
| A2: persisted error = actual message, error_stage = failing stage, retryable = derived value | §D1 (api persists unchanged), test seam assertions 2–3 |
| A3: processing/summary subdocument carries same message and stage | test assertion 4 |
| A4: contract test exists, passes, fails on either side's key drift | §D6 (scenarios S1–S4, key-set pin, behavioral identity chain) |

## 8. Out of scope (restated from binding Definition nonGoals)

Stale-lease sweep behavior; retry/backoff mechanics (ACK/NACK policy, leases, heartbeats — only *reporting* of retryability changes); frontend/mobile (ResourceResponse already exposes `error`/`error_stage`); structured error codes / failure taxonomy; everything the unavailable companion D3 issue covers beyond this payload alignment, including reconciling the D4 deviation note in `plans/upload-flow.md` (file absent from the current tree — reference exists only in Objective text; `plans/` was checked).

## 9. Risks / tradeoffs (mirrors Definition direction, with verified grounding)

- **Unknown consumers of the status topic** — mitigated by retaining `error` (D4); residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — convention documented in §D2; representative-stage scenarios S1/S2–S4 catch removal/bypass, not per-step ossification (per Definition's stated test strategy).
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances — accepted; widening `classify_error` is out of scope; `POST /process` manual reprocess unaffected.
- **Contract test ossifies the payload** — intentional drift guard; adding a key later means touching the test, which is the point.
- **Test-env unknowns** (mitigated in design): asyncio pytest config unverified → `asyncio.run` in sync tests (V10); sklearn presence unverified → guarded stub (V9 pattern); worker stub set reused verbatim from the proven worker conftest rather than reinvented.

## 10. Validation plan

- Targeted: `python -m pytest apps/ai-server/tests/integration/test_worker_failure_contract.py -v`
- Regression: `python -m pytest apps/ai-server/tests/integration -q` (contract + pipeline suites) and `cd apps/ai-server/rag-worker-service && python -m pytest tests/unit -q` (lease/claim/sweep fakes must stay green — worker module changed).
- Full: `./dev/run ai-server` (requires Docker Compose up, per AGENTS.md).
- Workflow: recommend small-change branch `fix/rag-worker-failure-payload-contract` (no schema/security/CI/dependency changes; no client-facing contract change — ResourceResponse untouched). Note honestly: the diff touches rag-worker-service plus the shared ai-server integration tests and imports rag-api without modifying it; if a reviewer judges "one service plus its tests" violated, escalate to the feature path per AGENTS.md's escalation rule rather than broadening silently.

## 11. Unknowns carried forward (not blocking)

- Whether the apps/ai-server integration environment has real sklearn/langchain installs (design is stub-safe either way).
- asyncio pytest configuration for `apps/ai-server/tests` (designed around via `asyncio.run`).
- Contents of the companion D3 issue (unavailable in this context; deferred by the Definition).
- Identity of any non-rag-api consumers of the status topic (hedged by D4; audit explicitly out of scope).
<<<END-SLE-OUTPUT>>>