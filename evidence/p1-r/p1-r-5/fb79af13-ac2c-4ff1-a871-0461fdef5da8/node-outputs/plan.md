<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

Run: fb79af13-ac2c-4ff1-a871-0461fdef5da8 · Iteration 1 · Step: plan
Intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
Authoritative source: WorkItem `wi-define-108-a8` Definition artifact (sha256 `71f1c39c…`), reproduced verbatim in the task input. This plan implements exactly that scope.

---

## 1. Summary

The rag-worker's failure publisher and rag-api's failure consumer were written against different contracts. The worker's `process_document` exception handler publishes `{"error": str(e)}`; rag-api's `run_transactional_update` failed branch reads `error_message`, `stage`, and `retryable`. Every worker-originated failure therefore persists the fallback string `"Processing failed"`, `error_stage: None`, and a silently defaulted `retryable: true` — on both the main resource document and the `processing/summary` error subdocument.

The fix is entirely worker-side: the worker publishes `error_message` / `stage` / `retryable` (retaining the legacy `error` key as a compatibility hedge), with `stage` supplied by a new stage tracker in `process_document` and `retryable` derived from the existing `classify_error()`. rag-api receives **zero production changes** — its failed branch already implements the target contract. A cross-service contract test locks the seam so future key drift on either side fails the build.

## 2. Verified current state (repository evidence)

All of the following was read and verified during investigation:

**Worker — `apps/ai-server/rag-worker-service/main.py`**
- `classify_error(e) -> bool` (top of file): `TransientError` → True; `PermanentError` → False; httpx connect/timeout errors, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` → True; `httpx.HTTPStatusError` with status 429/500/502/503/504 → True, other 4xx → False; **unknown exceptions → False (conservative: permanent)**.
- `process_document(...)` is one large `try` block. Pipeline steps in order: `_validate_processing_request` → publish `"starting"` → `_get_extracted_text` → publish `"text_retrieved"` (progress 20) → `content_tagger.generate_tags` → publish `"tagging_complete"` (40) → `generate_document_summary` → publish `"summary_generated"` (50) → `_create_enhanced_chunks` → publish `"chunking_complete"` (60) → `_generate_embeddings_with_openrouter` → publish `"embeddings_complete"` (80) → `delete_old_vectors_via_service` → `store_chunks_via_service` → `_save_processing_metadata_to_subcollection` → publish `"completed"` (100) → `_update_user_usage` → `_generate_resource_map`.
- The exception handler currently does:
  `metrics.error_message, metrics.end_time = str(e), time.time()`, logs `document_processing_failed`, then
  `await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)`.
  **This one-key payload is the bug.** There is no stage tracking anywhere in the function.
- `_publish_status_update(...)` passes `details` through verbatim inside the published message (`details` key of the JSON payload), injects `details['jobId'] = job_id` when a job_id is present and not already set, resets the sequence counter on terminal states (`completed`/`failed`), and performs a best-effort lease heartbeat Firestore write. It swallows its own publish errors (logs `status_publish_failed`).
- `_fail_if_still_stale(...)` (stale-lease sweep) already writes the established schema directly to Firestore: `error`, `error_stage: "processing"`, `retryable: True`. **Unchanged by this plan.**
- `run_worker(...)` ACK/NACK: `is_transient = classify_error(e)`; transient → omitted from ack_ids (Pub/Sub redelivers); permanent → acked.
- Worker test infra (`rag-worker-service/tests/conftest.py`) stubs all heavy imports (openai, langfuse, firebase_admin, google.cloud.*, spacy, tiktoken, tenacity, langchain) and sets required env defaults, so `main.py` is importable in tests without cloud dependencies. Note: the `google.cloud.storage` stub has no `Client`, so constructing `EnhancedDocumentProcessor` via `__init__` fails under stubs (`_init_services` → `credentials.Certificate` on the empty stub) — tests must use `__new__` plus attribute injection (see test plan).

**API — `apps/ai-server/rag-api-service/main.py`**
- `run_transactional_update(db, doc_ref, new_status, details, logger, user_id)`: transition gate `processing → {completed, failed}`; failed branch:
  - `main_update["error"] = details.get("error_message", "Processing failed")`
  - `main_update["error_stage"] = details.get("stage")`
  - `main_update["retryable"] = details.get("retryable", True)`
  - summary subdocument (`processing/summary`, merge): `stage = details.get("stage", "unknown")`, `progress = details.get("progress", 0)`, and `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`.
- `_process_status_message(...)` parses `user_id`/`course_id`/`resource_id`/`status`/`details` from the status topic message, resolves canonical vs legacy doc path, and calls `run_transactional_update` in a thread.
- `models/resource.py`: `Resource` exposes `error`, `error_stage`, `retryable: bool = True`; `ResourceResponse` (in api `main.py`) exposes `error`/`error_stage` to clients (pinned by `tests/integration/test_api_contracts.py`).

**Test infra**
- `apps/ai-server/tests/integration/test_api_contracts.py` + its `conftest.py`: the house pattern for cross-service contract tests — conftest mocks `firebase_admin`/`google.cloud.*`/`structlog` and puts rag-api on `sys.path`; the file uses fixture-based and subprocess+AST-based static contract tests (see `_get_agent_graph_shapes()` for the subprocess pattern used when another service's `main` module must be loaded without a name collision).

**Coverage caveat (verification step, not a claim):** the reviewed ranges of worker `main.py` contain exactly one `"failed"` status publish (the `process_document` handler). Ranges ~400–700 and ~1300–1380 (ContentTagger internals, chunking helpers) were not read line-by-line. Implementation step 7.1 includes a grep to confirm no other worker site publishes a `failed` status payload before this plan is marked complete.

## 3. Scope, constraints, non-goals

**Must (from the Definition):**
- Worker aligned to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema untouched.
- No Firestore migration, field rename, or backfill; persisted fields stay `error`/`error_stage`/`retryable`.
- Every worker failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must no longer be operative for worker failures.
- `retryable` derivation aligned with ACK/NACK: `classify_error` transient → `true`; permanent (incl. unclassified-unknown conservative default) → `false`.
- Contract test covering worker failure-payload construction → rag-api failed-branch persistence, asserting persisted `error`/`error_stage`/`retryable` equal the worker's values, failing on key drift on either side.

**Prefer / prefer-not (honored):**
- Retain legacy `error` key alongside `error_message` (compat hedge, Fact F11).
- No structured error-code taxonomy; summary `error.code` stays `"UNKNOWN"` unless a code is actually sent (worker sends none).

**Non-goals (unchanged, per Definition):** stale-lease sweep behavior; retry/backoff mechanics (ACK/NACK policy, leases, heartbeats — only the *reporting* of retryability changes); frontend/mobile; error taxonomy; anything covered by the unavailable companion D3 issue.

## 4. Design

### 4.1 Target contract (worker payload → persisted state)

| Worker payload key (new) | rag-api read (existing, verified) | Persisted to | Notes |
|---|---|---|---|
| `error_message` | `details.get("error_message", "Processing failed")` | main doc `error`; summary `error.message` | actual `str(e)` |
| `stage` | `details.get("stage")` | main doc `error_stage`; summary `error.stage`; summary `stage` | from stage tracker |
| `retryable` | `details.get("retryable", True)` | main doc `retryable` | from `classify_error(e)` |
| `error` (legacy, retained) | **not read by rag-api** | — | compat hedge for unknown topic consumers |
| `error_code` | `details.get("error_code", "UNKNOWN")` | summary `error.code` | **not sent** by worker; stays `"UNKNOWN"` |
| `jobId` | injected by `_publish_status_update` when `job_id` present | summary `job_id` (on processing) | existing behavior, unchanged |

### 4.2 Stage tracking in `process_document`

A local variable `current_stage` is introduced, initialized to `"processing"` **before** the `try` block (so the handler can never hit `NameError`, and failures in genuinely untracked code report the safe value), then set immediately before each pipeline-step `await` using the existing progress-stage vocabulary:

| Tracker assignment (immediately before) | Value |
|---|---|
| (initialization, before `try`) | `"processing"` |
| `await self._validate_processing_request(...)` | `"starting"` |
| `await self._get_extracted_text(...)` | `"text_retrieved"` |
| `await self.content_tagger.generate_tags(...)` | `"tagging_complete"` |
| `await self.generate_document_summary(...)` | `"summary_generated"` |
| `await self._create_enhanced_chunks(...)` | `"chunking_complete"` |
| `await self._generate_embeddings_with_openrouter(...)` | `"embeddings_complete"` |
| post-embedding tail: `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, `_update_user_usage`, `_generate_resource_map` | **no assignment** — tracker holds `"embeddings_complete"` |

**Semantics (document this in a code comment at the tracker initialization):** `stage` names the pipeline milestone region the job was in at failure — the milestone the in-flight step was attempting to reach, or the most recently reached milestone for the un-named finalization steps. This keeps a failure stage reconcilable with the progress timeline clients already saw (the last progress event before a finalization failure is `embeddings_complete` / progress 80).

**Deliberate choice — validation failures report `"starting"`, not `"processing"`:** validation is the first act of the starting stage and is a knowable stage; `"processing"` remains the initializer for genuinely untracked code (e.g., anything before the first assignment). The Definition designates `"processing"` as the safe value for the genuinely-unknown case; it does not mandate that validation map to it. The contract tests pin early/late failures on named steps (`text_retrieved`, `embeddings_complete`), so this choice is not ossified by tests either way.

**Known drift risk (accepted, per Definition):** a future pipeline step added without a tracker assignment reports a stale stage. Mitigation: the "set immediately before the await" convention, a comment at the tracker, and representative early/late-stage test coverage (enough to catch the tracker being removed or bypassed without ossifying every step).

### 4.3 `retryable` derivation

The exception handler computes `retryable = classify_error(e)` — the same function that drives ACK/NACK in `run_worker` — so the persisted record tells the truth:

- transient-classified → `retryable: true` (Pub/Sub will redeliver);
- permanent-classified, including unclassified-unknown (conservative default) → `retryable: false` (acked; manual reprocess via `POST /process` remains).

**Accepted behavior change:** unclassified-unknown exceptions currently persist `retryable: true` (silent default) and will now persist `false`. This is the conservatism `classify_error` was written for; it is pinned by test so it cannot regress silently.

**Unchanged:** the stale-lease sweep keeps its direct `retryable: true` write (a dead worker is transient by nature); rag-api's `details.get("retryable", True)` fallback stays in code but becomes inert for worker failures because the worker always sends the key.

### 4.4 Compatibility hedge

The worker retains the legacy `error` key alongside `error_message` (one redundant string per failure message). Only rag-api's status subscriber is a verified consumer; other tooling may share the topic. Dropping the duplicate later, if an audit confirms rag-api is the only consumer, is trivial cleanup and out of scope here.

### 4.5 Testability seam: `build_failure_details`

The payload construction is extracted into a module-level helper next to `classify_error`:

```python
def build_failure_details(error_message: str, stage: str, retryable: bool) -> Dict[str, Any]:
    """Failure payload for the rag-status topic.

    Contract (consumed by rag-api run_transactional_update failed branch):
      error_message -> persisted `error` + summary error.message
      stage         -> persisted `error_stage` + summary error.stage/stage
      retryable     -> persisted `retryable` (derive via classify_error, never default)
    `error` is a legacy duplicate of error_message retained for unknown
    consumers of this topic; rag-api does not read it.
    """
    return {
        "error_message": error_message,
        "error": error_message,
        "stage": stage,
        "retryable": retryable,
    }
```

The handler delegates to it. This satisfies the Definition's test requirement to "import both sides rather than restate the contract in a fixture": the contract test calls the worker's real helper rather than rebuilding the dict by hand. It changes no behavior — the handler previously built the dict inline.

### 4.6 rag-api: zero production changes

Verified sufficient as-is: the failed branch already reads exactly `error_message`/`stage`/`retryable` (+`error_code`, unsent) and persists `error`/`error_stage`/`retryable` plus the summary error subdocument. The transition gate (`processing → failed`) already matches the worker's flow (worker publishes failed while the doc is `processing`). No edits to `rag-api-service/` production files.

## 5. File-by-file changes

### 5.1 `apps/ai-server/rag-worker-service/main.py` — the only production file touched

**(a) Add `build_failure_details` (§4.5)** near `classify_error` at the top of the file.

**(b) Stage tracker in `process_document`:**

```python
async def process_document(self, user_id, course_id, resource_id, job_id=None):
    metrics = ProcessingMetrics(start_time=time.time())
    trace = ...  # unchanged
    # Failure-stage tracker: set immediately before each pipeline-step await.
    # Values reuse the progress-stage vocabulary; "processing" is the safe
    # value for genuinely untracked code. Finalization steps (vector
    # delete/store, metadata save, usage, map) intentionally leave the
    # tracker at the last reached milestone ("embeddings_complete").
    current_stage = "processing"
    try:
        current_stage = "starting"
        await self._validate_processing_request(user_id, course_id, resource_id)
        await self._publish_status_update(..., {"stage": "starting"}, job_id)

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
        ...  # tail steps unchanged, no further tracker assignments
```

**(c) Exception handler rewrite:**

```python
    except Exception as e:
        metrics.error_message, metrics.end_time = str(e), time.time()
        failure_stage = current_stage
        retryable = classify_error(e)
        self.logger.error(
            "document_processing_failed",
            user_id=user_id, course_id=course_id, resource_id=resource_id,
            error=str(e), stage=failure_stage, retryable=retryable,
        )
        await self._publish_status_update(
            user_id, course_id, resource_id, "failed",
            build_failure_details(str(e), failure_stage, retryable),
            job_id,
        )
        if trace: trace.update(output={"success": False, "error": str(e)})
        return metrics
```

Notes:
- `_publish_status_update` is **unchanged** — it already passes `details` through and injects `jobId`.
- The log line gains `stage` and `retryable` (observability only).
- `metrics.error_message` handling is unchanged.

### 5.2 Tests (detailed in `docs/test-plan.md`)

- New: `apps/ai-server/rag-worker-service/tests/unit/test_failure_status_payload.py` (classify_error matrix; published failure payload keys/values; stage attribution early/late/unknown; legacy `error` key; `jobId` injection).
- New: `apps/ai-server/tests/integration/test_worker_failure_contract.py` (cross-service round-trip through `run_transactional_update` with fakes; AST key-set drift guards on both services).
- No changes to existing test files required.

## 6. Implementation order

1. Worker: add `build_failure_details`; add stage tracker; rewrite the `process_document` exception handler (§5.1).
2. Worker unit tests (`test_failure_status_payload.py`) — run worker suite.
3. Cross-service contract test + AST drift guards (`test_worker_failure_contract.py`) — run integration suite.
4. Verification steps (§7).

## 7. Verification steps

1. **Grep guard:** `grep -n '"failed"' apps/ai-server/rag-worker-service/main.py` — confirm the `process_document` handler is the only site publishing a `failed` status payload (the stale-lease sweep writes Firestore directly and is out of scope). If another site exists in the unreviewed ranges (~400–700, ~1300–1380), align it to `build_failure_details` under the same rules.
2. Grep `details.get(` in rag-api `run_transactional_update` — confirm no unexpected new reads; confirm no production diff exists under `apps/ai-server/rag-api-service/` (constraint: zero API-side changes).
3. Run worker unit suite and the `apps/ai-server/tests/integration` suite (existing CI invocations); all green including pre-existing `test_api_contracts.py`.
4. Walk the acceptance criteria in §9 against test results.

## 8. Risks and mitigations

- **Unknown consumers of the status topic** reading the old key set → mitigated by retaining `error`; residual risk accepted as low (Definition F11).
- **Stage-tracker drift** as the pipeline evolves → "set immediately before the await" convention, explanatory comment, representative-stage tests.
- **`retryable=false` for unclassified-unknown errors** may reduce auto-retry affordances for genuinely-transient-but-unrecognized failures → accepted per Definition F8; widening `classify_error` is out of scope; manual reprocess via `POST /process` unaffected.
- **Contract test ossifies the payload** → intentional; that is the drift guard. Adding a key later means touching the test.
- **Test-infra risks** (stub coverage, `main` module-name collision, `MagicMock` `@firestore.transactional` swallowing the update body, tenacity real-decorator retries in tests) → addressed concretely in `docs/test-plan.md` §6.

## 9. Acceptance criteria → implementation mapping

| Acceptance (from Definition) | Delivered by |
|---|---|
| A1: failed status payload contains `error_message`/`stage`/`retryable`, none relying on API fallbacks | Worker handler rewrite (5.1c) + worker unit tests T1/T2 + contract test T3 |
| A2: persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = derived value | Contract test T3 main-document assertions |
| A3: `processing/summary` error subdocument carries same message and stage | Contract test T3 summary assertions |
| A4: contract test exists, passes, fails on either side's key drift | T3 round-trip + T4 AST drift guards |

## 10. Out of scope / deferred

- Stale-lease sweep's direct failure write (already contract-consistent).
- ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend/mobile (`ResourceResponse` already exposes `error`/`error_stage`).
- Structured error codes / failure taxonomy (summary `error.code` stays `"UNKNOWN"`).
- Companion D3 issue (content unavailable in this context) and reconciliation with the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree) — deferred per Definition F12.
- Dropping the legacy `error` key (future cleanup after a consumer audit, if warranted).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker → rag-api failure payload contract

Run: fb79af13-ac2c-4ff1-a871-0461fdef5da8 · Companion to `docs/plan.md`.

Strategy (per the Definition): import both sides rather than restate the contract in a fixture — build the failure payload through the worker's real code, feed it through rag-api's real `run_transactional_update`, and assert the persisted `error`, `error_stage`, `retryable`. Add key-set drift guards so a future edit to either side's keys fails the build. Hermetic: fakes, not the Firestore emulator (the Definition allows either; fakes keep the suite fast and CI-simple).

---

## 1. Test inventory

| ID | Suite / file | Layer | What it pins |
|---|---|---|---|
| T0 | `apps/ai-server/rag-worker-service/tests/unit/test_failure_status_payload.py` | worker unit | `classify_error` → retryable mapping |
| T1 | same file | worker unit | published `failed` payload: keys, values, legacy `error`, `jobId` |
| T2 | same file | worker unit | stage attribution: early / late / unknown-stage failures |
| T3 | `apps/ai-server/tests/integration/test_worker_failure_contract.py` | cross-service contract | worker payload → rag-api `run_transactional_update` → persisted state |
| T4 | same file | static (AST) | key-set drift guards on both services |
| T5 | existing suites, unchanged | regression | no behavioral regressions elsewhere |

## 2. Environments and fixtures

**Worker unit suite** — runs under `apps/ai-server/rag-worker-service/tests/conftest.py` (verified): sets env defaults (`GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `RAG_STATUS_TOPIC`, etc.) and stubs openai/langfuse/firebase_admin/google.cloud.*/spacy/tiktoken/tenacity/langchain, so `main.py` imports without cloud dependencies.

**Integration suite** — runs under `apps/ai-server/tests/integration/conftest.py` (verified): env defaults, `MagicMock`s for `firebase_admin`/`google.cloud.*`/`structlog`, `sys.path` includes `rag-api-service`; existing tests import `main as rag_api_main`.

**No new infrastructure is required.** No emulator, no network, no real Pub/Sub.

## 3. T0 — `classify_error` matrix (worker unit)

Direct unit tests of the function the `retryable` derivation relies on (it currently has no dedicated test file in the verified tree):

| Exception | Expected (`retryable`) |
|---|---|
| `TransientError("...")` | `True` |
| `PermanentError("...")` | `False` |
| `httpx.ConnectError` / `httpx.ReadTimeout` / `ConnectionError` / `TimeoutError` | `True` |
| `httpx.HTTPStatusError` with response status 500 (and 429/502/503/504) | `True` |
| `httpx.HTTPStatusError` with status 404 | `False` |
| `ValueError("...")` (unclassified-unknown) | `False` — conservative default, **pins the deliberate behavior change** |

Construct `HTTPStatusError` with real `httpx.Request`/`httpx.Response` objects (httpx is a real dependency in both services' import graphs).

## 4. T1/T2 — worker failure payload and stage attribution (worker unit)

**Setup pattern** (required because `EnhancedDocumentProcessor.__init__` → `_init_services` cannot run under the stubs — the `firebase_admin.credentials` stub is empty and the `google.cloud.storage` stub has no `Client`):

- `processor = EnhancedDocumentProcessor.__new__(EnhancedDocumentProcessor)` (skips `__init__`).
- Inject attributes: `processor.langfuse = None`; `processor.logger = structlog.get_logger()` (or a capture stub); `processor.config = SimpleNamespace(gcp_project="test-gcp", rag_status_topic="test-topic")`; `processor.db = FakeDb()`; `processor.pubsub_publisher = FakePublisher()`; `processor.content_tagger = stub`.
- Patch step methods **on the instance** (`processor._get_extracted_text = AsyncMock(...)` etc.). Instance patching bypasses the `@retry` tenacity wrappers — important when real tenacity is installed (worker conftest only stubs tenacity if not already imported); otherwise a `PermanentError` test would retry 3× with 4–30 s exponential waits.
- `FakePublisher.publish(topic_path, data)` captures `data` (JSON bytes) and returns an already-completed `concurrent.futures.Future` (so `asyncio.wrap_future` in `_publish_status_update` works).
- `FakeDb.document(path)` returns a fake ref whose `.get()` reports `exists=False` (skips the lease-heartbeat write in `_publish_status_update`, avoiding the stubbed `firestore.SERVER_TIMESTAMP` on the empty `firebase_admin.firestore` module) and whose `.update()/.set()` are recorded no-ops.
- `_status_sequence` is a **class-level** dict on the processor — use unique resource_ids per test or reset it in teardown to avoid cross-test leakage.

**T1 — payload shape and values** (call `processor.process_document(...)` with patched steps raising):

| Case | Raised at | Assert on the published `failed` message `details` |
|---|---|---|
| transient | `_get_extracted_text` raises `TransientError("boom-transient")` | `error_message == "boom-transient"`; `retryable is True`; key set == `{"error_message", "error", "stage", "retryable"}`; `error == error_message` (legacy hedge); `stage == "text_retrieved"` |
| permanent | `_generate_embeddings_with_openrouter` raises `PermanentError("boom-permanent")` | `retryable is False`; `stage == "embeddings_complete"`; same key set |
| unknown | `content_tagger.generate_tags` raises `ValueError("boom-unknown")` | `retryable is False` (conservative default); `stage == "tagging_complete"` |
| job id | any of the above with `job_id="job-123"` | `details["jobId"] == "job-123"` (injected by `_publish_status_update`) |

Also assert the top-level published message keeps `status == "failed"` and the existing envelope keys (`user_id`, `course_id`, `resource_id`, `timestamp`, `sequence`) — the envelope is unchanged by this fix, and pinning it catches accidental envelope regressions.

**T2 — stage attribution (representative early/late pinning per the Definition):**

- Early failure (transient at text retrieval) → `stage == "text_retrieved"`.
- Late failure (permanent at embeddings) → `stage == "embeddings_complete"`.
- Validation failure (`_validate_processing_request` raises `PermanentError`) → `stage == "starting"` (documents the plan's §4.2 choice; intentionally not a hard contract point).
- The `"processing"` initializer is a defensive default for untracked code; it is not directly observable through `process_document`'s happy path and is covered by code review plus the drift guards, not a dedicated test.

## 5. T3/T4 — cross-service contract test (integration)

File: `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new, sibling of `test_api_contracts.py`, inheriting its conftest).

### 5.1 Worker side via subprocess (house pattern)

`import main` collides: the integration conftest already imported rag-api's `main`. The established house pattern for loading another service's module is a subprocess with an inline script (see `_get_agent_graph_shapes()` in `test_api_contracts.py`). The subprocess:

1. Loads `apps/ai-server/rag-worker-service/tests/conftest.py` by path (`importlib.util.spec_from_file_location` + exec) — reusing the existing stub/env infrastructure instead of duplicating it.
2. `sys.path.insert(0, <rag-worker-service dir>)`; `import main as worker_main` (fresh interpreter, no collision).
3. Builds the real payloads for each case:

```python
exc = worker_main.TransientError("boom-transient")
payload = worker_main.build_failure_details(str(exc), "text_retrieved", worker_main.classify_error(exc))
```

   Cases: transient@`text_retrieved` (→ True), permanent@`embeddings_complete` (→ False), unknown `ValueError`@`tagging_complete` (→ False).
4. **Worker-side drift guard (in-subprocess):** `assert set(payload) == {"error_message", "error", "stage", "retryable"}` — a renamed or dropped key fails here before the round-trip.
5. Prints the payloads as JSON; the parent test parses them.

### 5.2 API side: real `run_transactional_update` over fakes

**Critical pitfall:** under the integration conftest, `firebase_admin` is a `MagicMock`, so `@firestore.transactional` would replace the inner `update_logic` with a `MagicMock` — the failed-branch body would never execute and the test would assert nothing. Fix: rebind the name in the module under test:

```python
fake_firestore = SimpleNamespace(
    transactional=lambda fn: fn,                 # identity decorator
    SERVER_TIMESTAMP="SERVER_TIMESTAMP",          # sentinel
)
monkeypatch.setattr(rag_api_main, "firestore", fake_firestore)
```

(`main.py` does `from firebase_admin import firestore`, so `firestore` is a module-level name in `rag_api_main` — rebinding it is sufficient and touches no production code.)

Fakes (small hand-rolled classes, not `MagicMock`, so assertions are exact):

- `FakeSnapshot`: `.exists = True`, `.to_dict() -> {"status": "processing", "userId": user_id}` — seeds the valid `processing → failed` transition and exercises the transition gate.
- `FakeDocRef`: `.get(transaction=...)` → snapshot; `.collection("processing").document("summary")` → a recorded `summary_ref`; `.id` → resource id.
- `FakeTransaction`: `.update(ref, data)` and `.set(ref, data, merge=True)` record calls.
- `FakeDb`: `.transaction()` → `FakeTransaction()`.
- `logger`: pass `rag_api_main.logger` (a MagicMock under the conftest) or a stub.

Call: `rag_api_main.run_transactional_update(fake_db, doc_ref, "failed", payload_from_subprocess, logger, user_id)`.

### 5.3 T3 assertions (per case)

Main-document update (captured by `FakeTransaction.update`):
- `status == "failed"`
- `error == payload["error_message"]` (≠ the `"Processing failed"` fallback — proves the fallback is no longer operative)
- `error_stage == payload["stage"]` (not `None`)
- `retryable == payload["retryable"]` (for the permanent and unknown cases this is `False`, which **cannot** match the `details.get("retryable", True)` default — this is what makes retryable drift detectable; the transient-only case would not)

Summary subdocument (captured by `FakeTransaction.set` on `processing/summary`):
- `error == {"code": "UNKNOWN", "message": payload["error_message"], "stage": payload["stage"]}` (acceptance A3; code stays `"UNKNOWN"` because the worker sends no `error_code`)
- `stage == payload["stage"]`

Why drift fails the build (Definition requirement):
- Worker renames/drops a key → API reads the old name → persisted value becomes the fallback → equality assertions fail.
- API renames a read key → same fallback mismatch → fails.
- API renames a persisted field → assertion key missing from the captured update → fails.
- Worker drops `retryable` → permanent/unknown cases persist `True` vs derived `False` → fails.

### 5.4 T4 — AST key-set drift guards (static, house pattern)

Parse sources with `ast` (pattern already used in `test_api_contracts.py`):

- **Worker:** in `apps/ai-server/rag-worker-service/main.py`, locate the `build_failure_details` `FunctionDef`; collect the dict-literal keys of its returned dict; assert exactly `{"error_message", "error", "stage", "retryable"}`. (The handler delegates to the helper, so the helper is the single source of truth for the payload key set.)
- **API:** in `apps/ai-server/rag-api-service/main.py`, within `run_transactional_update`, collect all constants from `details.get("K", ...)` calls; assert `{"error_message", "stage", "retryable"} ⊆ reads`. Extra reads are permitted (e.g., `error_code`, `progress`, `jobId`) but any new read on the failed path must be accompanied by a test update — the behavioral round-trip in T3 enforces the values, T4 enforces the key vocabulary.

## 6. Known test-environment pitfalls (checklist for implementers)

1. **`main` module collision** in the integration suite → worker import must go through a subprocess (§5.1), never a second in-process `import main`.
2. **`MagicMock` `@firestore.transactional`** silently skips the update body → rebind `rag_api_main.firestore` (§5.2).
3. **Real tenacity in the test env** → patch step methods on the instance, not the class, to bypass `@retry` wrappers (§4).
4. **Worker `__init__` cannot run under stubs** → `__new__` + attribute injection (§4).
5. **Class-level `_status_sequence`** leaks between tests → unique resource ids or teardown reset (§4).
6. **`_publish_status_update` mutates the passed `details` dict** (injects `jobId`) → assert against the published JSON bytes, not the caller's dict object (§4).
7. **Worker `main.py` import-time requirements** (`GCP_PROJECT` env, `GOOGLE_APPLICATION_CREDENTIALS`, `service_account.Credentials.from_service_account_file`) → satisfied by loading the worker conftest first in the subprocess (§5.1).

## 7. T5 — existing suites that must keep passing (no edits expected)

- `apps/ai-server/rag-worker-service/tests/` (unit suite incl. `test_processing_lease.py`, chunking/tagging tests).
- `apps/ai-server/rag-api-service/tests/` (incl. `integration/test_endpoints.py`, `test_timeline_endpoints.py`).
- `apps/ai-server/tests/integration/` (incl. `test_api_contracts.py`, `test_search_pipeline.py`, `test_chat_pipeline.py`, `test_shared_algorithms_in_sync.py`).

## 8. Acceptance criteria mapping

| Acceptance (Definition) | Covered by |
|---|---|
| A1 payload contains `error_message`/`stage`/`retryable`, no fallback reliance | T1 (published bytes), T3 (round-trip), T4 (worker key set) |
| A2 persisted `error`/`error_stage`/`retryable` equal worker values | T3 main-document assertions (permanent/unknown cases make `retryable` drift detectable) |
| A3 summary error subdocument carries same message and stage | T3 summary assertions |
| A4 contract test exists, passes, fails on either side's key drift | T3 + T4 |

## 9. Out of test scope

- Stale-lease sweep behavior and its direct `retryable: true` write (unchanged; already covered by existing lease tests where applicable).
- ACK/NACK mechanics, lease/heartbeat timing (unchanged; only payload reporting changes).
- Firestore-emulator end-to-end run (fakes chosen; emulator mode remains an available upgrade path).
- Frontend/mobile response shapes (pinned by existing `test_api_contracts.py`).
- Full `process_document` success-path coverage (unchanged behavior; not this fix's contract).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>