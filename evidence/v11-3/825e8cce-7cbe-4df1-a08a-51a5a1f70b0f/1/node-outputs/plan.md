Investigation complete. The plan below is grounded in the verified repository reads: the worker's `process_document` exception handler (~L1103), `_publish_status_update` (~L1533), `classify_error` (~L44), the sweep `_fail_if_still_stale` (~L2148), rag-api's `run_transactional_update` failed branch (~L176–290), the `Resource` model, and the existing contract-test/fake patterns (`test_api_contracts.py`, `test_processing_lease.py`, both services' `tests/conftest.py`).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api Failure Payload Contract Alignment

Objective: make a failed RAG processing job persist the worker's actual error message, the failing
pipeline stage, and a deliberately derived `retryable` flag. The worker aligns to rag-api's existing
failed-branch contract (`error_message`/`stage`/`retryable`); rag-api is not changed. Locked in by a
contract test on the worker→rag-api failure path.

Authoritative scope: WorkItem `wi-define-108-a8`, artifact `definition:obj-108`
(sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). Everything in that
definition is binding; anything it defers (F12, companion D3 issue) stays deferred.

---

## 1. Verified repository evidence

All claims below were verified by direct reads during investigation. Line numbers are approximate
(`~`) and pinned by symbol name.

| Claim | Verified at | Notes |
|---|---|---|
| F3 — worker publishes `{"error": str(e)}` on failure | `apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler (~L1103–1110) | The only `status="failed"` publish in the worker. Handler also sets `metrics.error_message`, logs `document_processing_failed`, updates trace, returns metrics. |
| F4 — rag-api failed branch reads `error_message`/`stage`/`retryable` | `apps/ai-server/rag-api-service/main.py`, `run_transactional_update` (~L176–290) | Persists `error = details.get("error_message", "Processing failed")`, `error_stage = details.get("stage")`, `retryable = details.get("retryable", True)` on the main doc; writes summary `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`. Summary `stage` defaults `"unknown"`, `progress` defaults `0`. |
| F5 — fallbacks operative today | Follows from F3 + F4 | Every worker failure persists "Processing failed" / None / True. |
| F6 — established persisted schema | Worker `_fail_if_still_stale` (~L2148) writes `error`/`error_stage="processing"`/`retryable=True`; `apps/ai-server/rag-api-service/models/resource.py` (~L52–54, `to_dict` ~L80, `from_dict` ~L120) exposes `error`/`error_stage`/`retryable` (default True) | The worker status publisher is the only writer that doesn't speak this schema. |
| F7 — classification drives ACK/NACK | `classify_error` (worker main.py ~L44–88); `run_worker` (~L2078–2115) | TransientError, httpx connect/timeout errors, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, HTTP 429/500/502/503/504 → transient (True). PermanentError, other 4xx, unclassified-unknown → permanent (False). Transient → omitted from ack_ids (redelivered); permanent → acked. |
| F9 — progress stage vocabulary, no failure-stage tracking | `process_document` body | Progress publishes use tokens: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`. |
| F10 — contract-test infrastructure exists | `apps/ai-server/tests/integration/test_api_contracts.py` (fixture-based + subprocess/AST patterns, e.g. `_get_agent_graph_shapes`); both services have `FIRESTORE_EMULATOR_HOST` branches (worker `_init_services` ~L743; rag-api `AppState.startup` ~L138) | Hermetic implementation is possible with existing patterns. |
| Worker test fake pattern | `apps/ai-server/rag-worker-service/tests/unit/test_processing_lease.py` (~L119–241) | `FakeDb/FakeTx/FakeRef/FakeSnap` + monkeypatching `main.firestore.transactional` → identity and `SERVER_TIMESTAMP` → sentinel. Reuse for the rag-api half of the contract test. |
| Worker import stubs | `apps/ai-server/rag-worker-service/tests/conftest.py` | Full stub table for langchain/openai/langfuse/firebase_admin/google.*/spacy/tiktoken/tenacity; `httpx` intentionally NOT stubbed (real, needed by `classify_error` isinstance checks). |
| rag-api import stubs | `apps/ai-server/tests/integration/conftest.py` + `apps/ai-server/rag-api-service/tests/conftest.py` | MagicMock `firebase_admin`, `google.cloud.*`, `structlog`; sys.path insertion for rag-api-service; env defaults (`GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `SHARED_INTERNAL_TOKEN`). |
| F1/F2/F8/F11 | Product intent / adopted defaults from the definition | Implemented exactly as specified (see D2/D3/D5). |
| F12 | Companion D3 issue unavailable in this context | Deferred; out of scope. |

---

## 2. Design

### D1 — Stage tracker in `process_document` (worker)

A local `current_stage` initialized **before** the `try` block (so the handler can always read it),
assigned immediately before each pipeline step's await. Convention (pinned as a code comment at the
init site): *"assign `current_stage` immediately before the await of the pipeline step this token
describes; the failure handler reports it verbatim."*

| Code point in `process_document` | Assignment |
|---|---|
| Before `try` (after `metrics`/`trace` init) | `current_stage = "starting"` |
| Immediately before `await self._get_extracted_text(...)` | `current_stage = "text_retrieved"` |
| Immediately before `await self.content_tagger.generate_tags(...)` | `current_stage = "tagging_complete"` |
| Immediately before `await self.generate_document_summary(...)` (and the `ragDescription` Firestore update) | `current_stage = "summary_generated"` |
| Immediately before `await self._create_enhanced_chunks(...)` | `current_stage = "chunking_complete"` |
| Immediately before `await self._generate_embeddings_with_openrouter(...)` | `current_stage = "embeddings_complete"` |
| Vector-storage / finalization steps (`delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, final publish, `_update_user_usage`, `_generate_resource_map`) | No further assignment — tracker remains `"embeddings_complete"` (last token of the mandated vocabulary; no dedicated token exists) |

Semantics: the token identifies the pipeline step **in progress** (or most recently reached). A
failure during text extraction reports `text_retrieved` — that step's vocabulary token — not
`starting`. `"processing"` remains the reserved safe value for a genuinely unknown stage (the value
the stale-lease sweep uses); because the tracker is unconditionally initialized, the handler never
emits it — documented, not dead weight.

Known drift risk (future step added without updating the tracker) is mitigated by the
before-the-await convention comment and the CT-6 AST guard (see test-plan).

### D2 — Failure payload (worker exception handler)

Replace the single-key payload in the `except` block of `process_document`:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                      resource_id=resource_id, error=str(e))
    failure_details = {
        "error_message": str(e),         # rag-api contract key → persisted as `error`
        "error": str(e),                 # legacy key retained (F11 compat hedge)
        "stage": current_stage,          # failing pipeline stage (D1)
        "retryable": classify_error(e),  # deliberate derivation (D3)
    }
    await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

- `_publish_status_update` is **unchanged**; it still injects `details["jobId"]` when `job_id` is
  provided (existing verified behavior), still publishes the envelope
  `{user_id, course_id, resource_id, status, details, timestamp, sequence}`, and still resets the
  sequence on terminal states.
- `progress` is deliberately omitted from the failure payload; rag-api defaults summary `progress`
  to 0 on failure (unchanged behavior).
- Resulting published failure payload (example):

```json
{
  "user_id": "u1", "course_id": "__ungrouped__", "resource_id": "r1",
  "status": "failed",
  "details": {
    "error_message": "openrouter 503",
    "error": "openrouter 503",
    "stage": "embeddings_complete",
    "retryable": true
  },
  "timestamp": 1730000000.0,
  "sequence": 7
}
```

### D3 — `retryable` derivation

`retryable = classify_error(e)` — the same function that drives ACK/NACK in `run_worker`:

| Exception classification | `retryable` | Rationale |
|---|---|---|
| Transient (TransientError, httpx connect/timeout, ConnectionError, TimeoutError, HTTP 429/500/502/503/504) | `true` | Pub/Sub will redeliver; the record says so. |
| Permanent (PermanentError, non-429 4xx) | `false` | Acked; will not come back. Manual reprocess via `POST /process` remains. |
| Unclassified-unknown (conservative default) | `false` | **Deliberate behavior change**: previously persisted `true` via rag-api's silent default. This is the conservatism `classify_error` was written for — it prevents infinite retry loops. |

The stale-lease sweep's separate direct write (`retryable=True`, `error_stage="processing"`) is
untouched and stays correct: a dead worker is a transient condition.

### D4 — rag-api: zero code change

Verified: once the worker sends `error_message`/`stage`/`retryable`, the existing failed branch
persists `error`/`error_stage`/`retryable` unchanged and writes the summary error subdocument with
the same message and stage. All three `details.get(...)` fallbacks become non-operative for worker
failures — satisfying the constraint "the API-side fallback must not be the operative mechanism"
without touching rag-api's reads or schema. `error_code` stays `"UNKNOWN"` (worker sends none —
per non-goal: no error-code taxonomy).

### D5 — Compatibility hedge

Legacy `error` key retained alongside `error_message` with an equal value — one redundant string per
failure message as insurance for unknown consumers of the status topic (F11). Dropping it later is
trivial cleanup after a consumer audit (out of scope here).

---

## 3. Tasks

| ID | Task | Files | Acceptance |
|---|---|---|---|
| T1 | Stage tracker: add `current_stage` init + the five before-the-await assignments + convention comment (D1 table) | `apps/ai-server/rag-worker-service/main.py` (`process_document`) | WT-2/WT-3 stage assertions pass; CT-6 passes; success-path progress publishes byte-identical to today (WT-6) |
| T2 | Failure payload: rewrite the except-handler publish per D2 (T1+T2 land together — the handler references `current_stage`) | same file | WT-1..WT-5 pass; CT-4 passes |
| T3 | rag-api verification — **no code change**; confirm via CT that the failed branch persists worker values unchanged | `apps/ai-server/rag-api-service/main.py` (read-only) | CT-1..CT-3 pass; `git diff` shows zero rag-api-service changes |
| T4 | Worker unit tests for the failure path | `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` (new) | WT-1..WT-6 green in the worker suite |
| T5 | Integration contract test + import bootstrap + fakes | `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new) | CT-1..CT-4 green; no Firestore emulator required |
| T6 | AST drift guards (in the CT file) | same as T5 | CT-5, CT-6 green; mutation check performed (see test-plan §8) |
| T7 | (Optional, recommended) rag-api unit test of the failed branch with fakes | `apps/ai-server/rag-api-service/tests/unit/test_failed_branch_persistence.py` (new) | AT-1 green in rag-api suite |

Order: T1 → T2 → T4 (worker green) → T5/T6 (seam green) → T3/T7.

### T1/T2 edit sketch (worker `process_document`)

```python
async def process_document(self, user_id, course_id, resource_id, job_id=None):
    metrics = ProcessingMetrics(start_time=time.time())
    trace = ...
    # Stage tracker: assign current_stage immediately before the await of the
    # pipeline step this token describes; the failure handler reports it verbatim.
    current_stage = "starting"
    try:
        await self._validate_processing_request(user_id, course_id, resource_id)
        await self._publish_status_update(..., "processing", {"stage": "starting"}, job_id)

        current_stage = "text_retrieved"
        text_content, doc_metadata = await self._get_extracted_text(...)
        ...
        current_stage = "tagging_complete"
        tags, confidence_scores = await self.content_tagger.generate_tags(...)
        ...
        current_stage = "summary_generated"
        summary_data = await self.generate_document_summary(...)
        ...
        current_stage = "chunking_complete"
        chunks = await self._create_enhanced_chunks(...)
        ...
        current_stage = "embeddings_complete"
        vectors = await self._generate_embeddings_with_openrouter(chunks)
        ...  # steps 6a/6b and finalization: tracker intentionally stays here
        ...
    except Exception as e:
        # D2 payload (see above)
```

No other worker changes: `_publish_status_update`, `ProcessingMetrics`, the sweep, `run_worker`,
and `_init_services` are untouched.

---

## 4. Compatibility & rollout

- **Single-service deploy** (worker only). Forward/backward compatible with today's rag-api: the new
  keys are exactly what rag-api already reads; the legacy `error` key is retained.
- **No Firestore migration, field rename, or backfill** (binding constraint). Persisted names
  `error`/`error_stage`/`retryable` keep their names and semantics.
- **No client impact**: `ResourceResponse` and the `Resource` model are untouched; mobile contract
  fields (`error`, `error_stage`) already exist and are now populated with real values.
- Other failure writers (stale-lease sweep, rag-api enqueue-failure paths) untouched.

---

## 5. Risks & tradeoffs

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic reading the old key set | Legacy `error` retained (D5); residual risk accepted as low. |
| Stage-tracker drift as the pipeline evolves | Before-the-await convention comment; CT-6 AST guard pins the token set; representative early/late stage coverage in CT/WT. |
| `retryable=false` for unclassified-unknown reduces auto-retry affordances | Accepted per F8; widening `classify_error` is out of scope; manual reprocess via `POST /process` unaffected. |
| Contract test ossifies the payload | Intentional — that is the drift guard. Adding a key later means touching the test. |
| Cross-service import fragility in the integration test env (worker main needs langchain/openai/etc.) | Idempotent stub bootstrap mirroring the worker conftest (test-plan §4.1); documented subprocess fallback reusing the house `_get_agent_graph_shapes` pattern. |
| Imprecise stage for vector-storage/finalization failures (reported as `embeddings_complete`) | Accepted: the mandated vocabulary has no token for those steps; last-named-milestone is strictly more informative than `"processing"`. Documented in D1. |

---

## 6. Non-goals (binding)

- Changing rag-api's reads, persisted schema, or the stale-lease sweep's direct failure write.
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only
  the *reporting* of retryability changes.
- Frontend or mobile changes.
- Structured error codes / failure taxonomy (summary `error.code` stays `"UNKNOWN"` unless sent).
- Anything the companion D3 issue covers beyond this payload alignment (F12 — deferred), and
  reconciling with the D4 deviation note in `plans/upload-flow.md` (file not present in tree).

---

## 7. Unknowns / open items

- **Integration-env package availability** for importing worker main: `fastapi`, `pydantic`,
  `pydantic_settings`, `httpx` are known-required by the existing integration suite (rag-api main
  imports them); `tenacity`/`sklearn`/`langchain`/`openai`/`langfuse`/`tiktoken`/`google.auth` are
  handled by the stub bootstrap whether present or not. Verify at T5; subprocess fallback documented.
- **Firestore-emulator provisioning in CI** unverified — fakes are the primary strategy; the
  emulator variant is optional.
- **Exact pytest invocation conventions** per service (`pytest.ini` files exist in both services;
  contents not read) — confirm at T4/T5.
- Companion D3 issue content — deferred (F12).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker → rag-api failure payload contract

## 1. Goals & acceptance mapping

| Definition acceptance criterion | Proven by |
|---|---|
| AC-1: worker failure payload carries `error_message` (actual message), `stage` (failing stage), `retryable` (derived) — never relying on rag-api fallbacks | WT-1..WT-5, CT-4 |
| AC-2: persisted main doc has `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = worker's value | CT-1, CT-2, CT-3 (AT-1) |
| AC-3: `processing/summary` error subdocument carries the same message and stage | CT-1, CT-2, CT-3 (AT-1) |
| AC-4: contract test exists, passes, exercises worker construction → rag-api persistence, fails on key drift | CT-1..CT-6 |

## 2. Test layers

- **L1 — Worker unit tests** (`apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`):
  fast feedback in the worker's native test env (its `tests/conftest.py` already provides all import
  stubs and env defaults — verified).
- **L2 — Integration contract test**
  (`apps/ai-server/tests/integration/test_worker_failure_contract.py`): the required seam test.
  Imports **both sides' real code** — no fixture restates the contract.
- **L3 — Static AST drift guards** (inside the L2 file): parse both `main.py` files with `ast`
  (in-process file read + `ast.parse`; no subprocess needed for these).

No Firestore emulator is required: fakes are primary (pattern proven in
`tests/unit/test_processing_lease.py`). An emulator variant is optional and unverified regarding CI
provisioning.

## 3. L1 — Worker unit tests (WT)

### 3.1 Fake kit (worker side)

- **`FakePublisher`**: `topic_path(project, topic) -> str`; `publish(topic_path, data: bytes)` records
  `(topic_path, data)` and returns a **resolved `concurrent.futures.Future`** (required:
  `_publish_status_update` calls `await asyncio.wrap_future(future)`).
- **`FakeDb` / `FakeRef` / `FakeSnap`**: `document(path) -> ref`; `ref.get() -> snap` with
  `exists=False`, `to_dict() -> {}` (drives `_validate_processing_request` to raise
  `ValueError(f"Document {resource_id} not found at path {doc_path}")` and makes
  `_get_document_path` fall back to the legacy path — both fine); `ref.update(data)` records.
  The lease-heartbeat read in `_publish_status_update` sees `exists=False` and skips — no extra wiring.
- **Processor construction**: `EnhancedDocumentProcessor.__new__(EnhancedDocumentProcessor)` (bypasses
  `_init_services` entirely), then set instance attributes:
  `config = SimpleNamespace(gcp_project="test-gcp", rag_status_topic="test-topic")`,
  `langfuse = None`, `db = FakeDb()`, `pubsub_publisher = FakePublisher()`.
  For late-failure cases, shadow pipeline steps with instance-attribute async stubs, e.g.:
  ```python
  async def _ok_text(*a, **k): return ("hello world", {"title": "T"})
  proc._validate_processing_request = _noop_async
  proc._get_extracted_text = _ok_text
  proc.content_tagger = SimpleNamespace(generate_tags=_noop_tags)   # -> ([], {})
  proc.generate_document_summary = _none_async                      # -> None
  proc._create_enhanced_chunks = _empty_chunks_async                # -> []
  proc._generate_embeddings_with_openrouter = _raising_async        # raises the case's exception
  ```
  Instance attributes shadow the (retry-wrapped) bound methods — verified shadowing works for plain
  attribute assignment.
- **Run**: sync test bodies call `asyncio.run(proc.process_document("u1", "__ungrouped__", "r1", job_id=None))`.
  **No pytest-asyncio dependency is assumed** (pytest.ini contents unverified) — `asyncio.run` only.
- **Capture**: `envelope = json.loads(publisher.published[-1][1])`; `details = envelope["details"]`.
- **Hygiene**: `EnhancedDocumentProcessor._status_sequence` is a class-level dict shared across
  tests; clear it in a fixture between tests (`_reset_sequence` already runs on terminal states, but
  explicit cleanup avoids cross-test sequence bleed).

### 3.2 Cases

| ID | Setup | Assert |
|---|---|---|
| WT-1 | No instance stubs → `_validate_processing_request` raises `ValueError("Document r1 not found at path users/u1/resources/r1")` (deterministic: `course_id="__ungrouped__"` → canonical path, verified in `_get_document_path`) | `envelope["status"] == "failed"`; `set(details) == {"error_message", "error", "stage", "retryable"}` (exact — `job_id=None` so no `jobId` injection); `details["error_message"] == "Document r1 not found at path users/u1/resources/r1"`; `details["error"] == details["error_message"]`; `details["stage"] == "starting"`; `details["retryable"] is False` (ValueError → unclassified → permanent) |
| WT-2 | `_get_extracted_text` raises `httpx.ConnectError("boom")` (real httpx — required for `classify_error` isinstance) | `details["stage"] == "text_retrieved"`; `details["retryable"] is True`; `details["error_message"] == "boom"` |
| WT-3 | `_generate_embeddings_with_openrouter` raises `main.TransientError("openrouter 503")` | `details["stage"] == "embeddings_complete"`; `details["retryable"] is True` |
| WT-4 | `_generate_embeddings_with_openrouter` raises `main.PermanentError("bad document structure")` | `details["stage"] == "embeddings_complete"`; `details["retryable"] is False` |
| WT-5 | `_generate_embeddings_with_openrouter` raises `RuntimeError("unclassified failure")` | `details["retryable"] is False` — **pins the deliberate behavior change** from silent-default `True` to derived `False` for unclassified-unknown |
| WT-6 | All steps stubbed to succeed (`store_chunks_via_service -> {"successful_inserts": 1, "failed_inserts": 0}`, etc.) | Final publish `status == "completed"`; progress publishes retain today's `stage`/`progress` tokens (tracker change must not alter the progress timeline payload) |

## 4. L2 — Integration contract tests (CT)

File: `apps/ai-server/tests/integration/test_worker_failure_contract.py`

### 4.1 Worker-side import bootstrap

`install_worker_import_stubs()` — idempotent, runs at test-module import (after the directory
conftest, which has already MagicMock'd `firebase_admin`, `google.cloud*`, `structlog` — leave those
as-is; they are sufficient for worker main's module-level code, and `_init_services` is bypassed via
`__new__`):

- For each name in `["langchain", "langchain.text_splitter", "langchain.schema", "openai",
  "langfuse", "spacy", "sklearn", "sklearn.feature_extraction",
  "sklearn.feature_extraction.text", "tiktoken", "tenacity", "google.auth",
  "google.auth.credentials"]`: if not importable, install a minimal stub copied from the patterns in
  `rag-worker-service/tests/conftest.py` (tenacity: no-op `retry` decorator; tiktoken:
  `get_encoding`; openai: `AsyncOpenAI`/`APIError`; langfuse: `Langfuse`; sklearn:
  `TfidfVectorizer` stub; langchain: `RecursiveCharacterTextSplitter`/`Document`;
  google.auth.credentials: `AnonymousCredentials`).
- **Never stub `httpx`** — `classify_error` does `isinstance` checks against real httpx exception
  classes.
- Real packages required even with stubs: `httpx`, `pydantic`, `pydantic_settings` (worker main's
  class definitions; also required by rag-api main, hence present in this suite's env).
- Load worker main under an alias — rag-api owns the name `main`- Load worker main under an alias — rag-api owns the name `main` in this suite (the existing
  `test_api_contracts.py` does `import main as rag_api_main` after the directory conftest inserts
  the rag-api-service path). Use `importlib.util.spec_from_file_location("worker_main",
  <path to rag-worker-service/main.py>)` + `module_from_spec` + `exec_module`, with the
  rag-worker-service directory appended to `sys.path` first. Module-level side effects verified safe
  under the directory conftest: `os.environ["GCP_PROJECT"]` is set (KeyError otherwise — conftest
  covers it), `GOOGLE_APPLICATION_CREDENTIALS` is set to `/tmp/fake-creds.json` and
  `service_account.Credentials.from_service_account_file` is a MagicMock, `SUBSCRIBER` construction
  hits the `pubsub_v1` MagicMock. `_init_services` is never called (construction via `__new__`), so
  no Firebase init runs at import or test time.

### 4.2 Fake kit (rag-api side)

Copy the `FakeTx/FakeSnap/FakeRef/FakeDb` pattern from
`apps/ai-server/rag-worker-service/tests/unit/test_processing_lease.py` (verified house pattern),
extended for `run_transactional_update`'s needs:

- `FakeRef` gains an `id` attribute (rag-api logs `doc_ref.id`) and `.collection(name)` returning a
  collection whose `.document("summary")` yields a **separate tracked ref** so main-doc writes
  (`transaction.update`) and summary writes (`transaction.set(..., merge=True)`) land in two
  inspectable dicts: `state["main"]`, `state["summary"]`.
- `FakeTx.get(ref, transaction=None)` returns a snapshot over the current main-doc dict
  (`exists=True`, `to_dict()`); `update(ref, data)` merges into main; `set(ref, data, merge=...)`
  merges into summary.
- `FakeDb.transaction()` returns the tx; monkeypatch `rag_api_main.firestore.transactional` to the
  identity wrapper (`_tx_identity`) and `rag_api_main.firestore.SERVER_TIMESTAMP` to a sentinel —
  exactly the monkeypatching style verified in `test_processing_lease.py`.
- Seed the main doc with `{"status": "processing"}` so the `processing → failed` transition in
  `ALLOWED_TRANSITIONS` is valid (a doc seeded `"completed"` would silently no-op the write — the
  test would then fail loudly on the assertion, which is the desired failure mode if seeding is
  wrong).
- Logger: pass `structlog.get_logger()` from the MagicMock'd structlog (all log calls no-op).

### 4.3 Cases

| ID | Setup | Assert |
|---|---|---|
| CT-1 | Worker processor with `_get_extracted_text` raising `httpx.ConnectError("weaviate connection refused")`; capture failure envelope from `FakePublisher`; seed rag-api FakeDb doc `status="processing"`; call `rag_api_main.run_transactional_update(db, doc_ref, "failed", envelope["details"], logger, "u1")` | Main doc: `error == "weaviate connection refused"` (not "Processing failed"), `error_stage == "text_retrieved"` (not None), `retryable is True`. Summary: `error.message == "weaviate connection refused"`, `error.stage == "text_retrieved"`, `error.code == "UNKNOWN"`, `stage == "text_retrieved"`, `progress == 0` |
| CT-2 | Worker pipeline stubbed to fail at `_generate_embeddings_with_openrouter` with `worker_main.PermanentError("invalid chunk payload")`; same rag-api flow | Persisted `error == "invalid chunk payload"`, `error_stage == "embeddings_complete"`, `retryable is False`; summary mirrors message and stage |
| CT-3 | Fail at tagging with `RuntimeError("kaboom")` (unclassified-unknown); same rag-api flow | Persisted `retryable is False`, `error_stage == "tagging_complete"` — pins the deliberate behavior change (was silent-default `True`) end-to-end |
| CT-4 | Captured envelope from CT-1 (job_id=None) | `set(envelope["details"]) == {"error_message", "error", "stage", "retryable"}` — exact key set on the worker side; combined with CT-1..3 reading exactly `error_message`/`stage`/`retryable`, both sides of the seam are pinned |
| CT-5 | AST guard, worker side: `ast.parse` worker `main.py`, locate `FunctionDef process_document`, find its `ExceptHandler`, walk for `ast.Dict` nodes | A dict containing Constant keys `"error_message"`, `"stage"`, `"retryable"` (and legacy `"error"`) exists inside the handler. Failure message: "worker failure payload keys drifted — update test_worker_failure_contract.py intentionally" |
| CT-6 | AST guards, both files: (a) rag-api `run_transactional_update` — collect first-arg Constants of `details.get(...)` calls; (b) worker `process_document` — collect Constant values assigned to Name `current_stage` | (a) `{"error_message", "stage", "retryable"} ⊆ collected` — rag-api's reads drift → build fails. (b) collected set `== {"starting", "text_retrieved", "tagging_complete", "summary_generated", "chunking_complete", "embeddings_complete"}` and the except handler references Name `current_stage` — tracker removal or vocabulary drift → build fails |
| CT-7 (optional) | Same flow as CT-1 against a real Firestore emulator, `pytest.mark.skipif(not os.getenv("FIRESTORE_EMULATOR_HOST"))` | Same persisted-field assertions. Emulator CI provisioning unverified — strictly optional; fakes (CT-1..6) are the required gate |

## 5. Mutation checks (prove the tests can fail)

Run once during T5/T6; each mutation must turn the named tests red, then be reverted:

| Mutation | Must fail |
|---|---|
| Revert worker payload to `{"error": str(e)}` | CT-1, CT-4, CT-5 |
| Rename rag-api's `details.get("error_message")` to `details.get("message")` | CT-1 (persisted error falls back), CT-6(a) |
| Delete the stage tracker (handler reads a missing local) | WT-2/WT-3 stage asserts, CT-2, CT-6(b) |
| Replace `classify_error(e)` with literal `True` in the payload | WT-4, WT-5, CT-2, CT-3 |
| Add a new pipeline step without a tracker assignment | CT-6(b) vocabulary set mismatch |

## 6. Invocation & CI wiring

- Worker unit: `cd apps/ai-server/rag-worker-service && pytest tests/unit/test_failure_payload.py`
  — the service `tests/conftest.py` (verified) supplies env defaults and all import stubs; no new
  fixtures needed.
- Integration: `cd apps/ai-server && pytest tests/integration/test_worker_failure_contract.py` —
  the directory `conftest.py` (verified) mocks `firebase_admin`/`google.cloud*`/`structlog`, sets
  env defaults, and path-inserts rag-api-service; the module-level bootstrap (§4.1) adds worker
  stubs idempotently. Import order matters: rag-api `main` first (existing convention), then worker
  main under the `worker_main` alias.
- `pytest.ini` exists in both services but its contents were not read — confirm markers/async mode
  at T4/T5; the plan assumes no pytest-asyncio (sync bodies + `asyncio.run`), which works under any
  asyncio-mode setting.

## 7. Acceptance trace & residual unknowns

- AC-1 ← WT-1..WT-5, CT-4. AC-2 ← CT-1..CT-3 (+ optional AT-1). AC-3 ← CT-1..CT-3 summary asserts.
  AC-4 ← CT-1..CT-6 existence + green, drift failure demonstrated by §5 mutations.
- Residual unknowns (carried from plan §7): emulator CI provisioning (CT-7 optional), pytest.ini
  contents, availability of `fastapi`/`pydantic`/`pydantic_settings`/`httpx` in the integration env
  (rag-api main already imports them, so they must already be present for the existing suite — high
  confidence, verify at first run). Nothing in the acceptance criteria depends on the unknowns.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>