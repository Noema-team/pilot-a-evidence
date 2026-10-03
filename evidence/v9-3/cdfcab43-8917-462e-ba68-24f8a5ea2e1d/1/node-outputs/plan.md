<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api: failure payload contract alignment

Cycle: `rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage`
Authoritative source: WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c…`). Everything below implements exactly that Definition; nothing outside its bounded scope is touched.

---

## 1. Problem (verified in the tree)

- **Worker publisher is the odd one out.** `process_document`'s exception handler in `apps/ai-server/rag-worker-service/main.py` publishes:
  ```python
  await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
  ```
  One key: `error`. No stage, no retryable.
- **rag-api reads three keys.** `run_transactional_update` in `apps/ai-server/rag-api-service/main.py`, failed branch:
  ```python
  main_update["error"] = details.get("error_message", "Processing failed")
  main_update["error_stage"] = details.get("stage")
  main_update["retryable"] = details.get("retryable", True)
  ```
  and in the `processing/summary` subdocument:
  ```python
  summary_update["error"] = {
      "code": details.get("error_code", "UNKNOWN"),
      "message": details.get("error_message", "Processing failed"),
      "stage": details.get("stage"),
  }
  ```
- **Consequence (F5):** every worker-originated failure persists `error = "Processing failed"`, `error_stage = None`, `retryable = True` (silent default), and the summary subdocument inherits the fallbacks with `error_code = "UNKNOWN"`.
- **The persisted schema is already established elsewhere (F6):** the worker's stale-lease sweep `_fail_if_still_stale` writes `error / error_stage="processing" / retryable=True` directly; rag-api's enqueue-failure paths and `models/resource.py` (`Resource.error`, `Resource.error_stage`, `Resource.retryable: bool = True`) use the same names. Only the status publisher doesn't speak it.
- **No stage tracking exists (F9):** `process_document` is one large `try`; the handler has no idea where the failure happened. Progress publishes use the vocabulary `starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete, completed`.
- **Classification already exists (F7):** `classify_error(e)` returns `True` (transient) for `TransientError`, connection/timeout types, and HTTP 429/500/502/503/504; `False` (permanent) for `PermanentError`, other 4xx, and — conservatively — for unknown exceptions. `run_worker` already uses it for ACK/NACK.

## 2. Direction (locked by the Definition)

The worker aligns to rag-api's existing contract (`error_message` / `stage` / `retryable`). rag-api's reads and the persisted schema are **not** changed. No migration, no rename, no backfill.

## 3. Target contract (the pinned seam)

Worker publishes `status="failed"` with `details` containing exactly:

| key | value | consumed by rag-api as |
|---|---|---|
| `error_message` | `str(exception)` — the actual message | main doc `error`; summary `error.message` |
| `error` | `str(exception)` — **legacy duplicate, retained** (F11 compat hedge) | not read by rag-api |
| `stage` | failing pipeline stage (vocabulary below); `"processing"` when genuinely unknown | main doc `error_stage`; summary `error.stage` and `stage` |
| `retryable` | `classify_error(e)` — deliberately derived, never defaulted | main doc `retryable` |

`error_code` is **not** sent; summary `error.code` stays `"UNKNOWN"` (prefer-not taxonomy, non-goal).

## 4. Changes

### 4.1 rag-worker: new pure payload builder (module level, next to `classify_error`)

```python
def build_failure_details(error: Exception, stage: Optional[str] = None) -> Dict[str, Any]:
    """Build the failed-status details payload consumed by rag-api's
    run_transactional_update failed branch.

    Contract (pinned by tests/integration/test_worker_failure_contract.py):
      error_message -> persisted as main doc `error` and summary error.message
      stage         -> persisted as main doc `error_stage` and summary error.stage
      retryable     -> persisted as main doc `retryable` (derived, never defaulted)
      error         -> legacy duplicate of error_message, retained for any
                       non-rag-api consumers of the status topic
    """
    message = str(error)
    return {
        "error_message": message,
        "error": message,  # legacy key retained (compat hedge, F11)
        "stage": stage if stage else "processing",
        "retryable": classify_error(error),
    }
```

Pure function, no I/O — this is the exact seam the contract test imports.

### 4.2 rag-worker: stage tracking + handler rewiring in `process_document`

- Introduce a local `current_stage`, initialized to `"processing"` as the first statement inside the `try` (safe value if anything fails before the first assignment).
- **Convention: set the tracker immediately before the await it guards.** The assigned name is the progress-vocabulary marker that step produces:

| step (await) | `current_stage` set before it |
|---|---|
| `_validate_processing_request` | `"starting"` |
| `_get_extracted_text` | `"text_retrieved"` |
| `content_tagger.generate_tags` | `"tagging_complete"` |
| `generate_document_summary` (+ the `ragDescription` Firestore write and its progress publish, which are part of this region) | `"summary_generated"` |
| `_create_enhanced_chunks` | `"chunking_complete"` |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |
| `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection` | *(no rename)* remains `"embeddings_complete"` — the vocabulary has no vector-storage name (decision D2 below) |

- Exception handler becomes:
  ```python
  except Exception as e:
      metrics.error_message, metrics.end_time = str(e), time.time()
      self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                        resource_id=resource_id, error=str(e), stage=current_stage,
                        retryable=classify_error(e))
      await self._publish_status_update(
          user_id, course_id, resource_id, "failed",
          build_failure_details(e, current_stage), job_id,
      )
      if trace: trace.update(output={"success": False, "error": str(e)})
      return metrics
  ```
- `_publish_status_update` itself is **unchanged** (it transparently carries `details`; its `jobId` injection and sequence reset stay).

### 4.3 rag-api: **no code changes**

`run_transactional_update`'s failed branch already persists exactly the aligned keys (verified quotes in §1). The constraint "align the worker, don't change rag-api's reads or schema" is satisfied by doing nothing on that side.

### 4.4 Explicit non-changes (non-goals)

- `_fail_if_still_stale` sweep — already writes `error / error_stage="processing" / retryable=True`; a dead worker is transient by nature; untouched.
- `run_worker` ACK/NACK policy, `classify_error` heuristics, leases, heartbeats — only the *reporting* of retryability changes.
- Frontend/mobile — `ResourceResponse` already exposes `error` / `error_stage`.
- No structured error codes; summary `error.code` remains `"UNKNOWN"`.

## 5. Decisions log

- **D1 — stage semantics.** The tracker holds the name of the step *in flight*, using the progress marker that step produces ("set immediately before the await", per the Definition's convention). A failure during PDF extraction reports `text_retrieved` — the vocabulary's name for the text-retrieval stage.
- **D2 — vector-storage region.** After the `embeddings_complete` publish there is no named stage. Verified: `delete_old_vectors_via_service` and `_save_processing_metadata_to_subcollection` swallow their own exceptions (try/except, log-and-continue); only `store_chunks_via_service` can raise there (partial-write `RuntimeError`, httpx errors). That region inherits `"embeddings_complete"` — the last named checkpoint — rather than inventing a new name (vocabulary constraint) or downgrading to `"processing"` (which would hide more).
- **D3 — legacy `error` key retained** in the payload (F11 hedge for unknown status-topic consumers). Dropping it later is trivial cleanup after a consumer audit.
- **D4 — retryable derivation (F8).** `retryable = classify_error(e)`: transient → `true`; permanent, including unclassified-unknown (conservative default) → `false`. **Deliberate behavior change:** unclassified-unknown exceptions previously persisted `retryable: true` via the silent default; they now persist `false`. This matches the worker's actual ACK/NACK behavior (permanent → acked, no redelivery; manual reprocess via `POST /process` unaffected) and prevents infinite retry loops.
- **D5 — empty messages pass through.** `str(e) == ""` persists as `""` (key present, so rag-api's fallback is not operative). No message fabrication.
- **D6 — `"processing"` safe value** is produced only by the falsy-stage guard in `build_failure_details` and the local's initialization; it is the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to `null`.

## 6. Test strategy (details in docs/test-plan.md)

A new hermetic contract test, `apps/ai-server/tests/integration/test_worker_failure_contract.py`, **imports both sides rather than restating the contract**:

1. Calls the worker's `build_failure_details` (and, via a recorder-harnessed `process_document`, the real exception handler) to construct the failure payload.
2. Feeds that payload through rag-api's real `run_transactional_update` against an in-memory fake Firestore (house pattern from `rag-api-service/tests/unit/test_service_contracts.py`; `firestore.transactional` monkeypatched to identity under the existing conftest's mock regime).
3. Asserts persisted `error`, `error_stage`, `retryable` equal the worker's values, on the main document and the `processing/summary` subdocument.
4. Drift guards: exact key-set equality on the worker payload (runtime), a permanent-error case whose persisted `retryable=False` proves the API's `True` fallback is not operative, and two cheap AST guards (house pattern from `test_api_contracts.py`) pinning the API's `details.get` keys and the worker's handler/tracker wiring.

Fakes are the primary mechanism (explicitly sanctioned by the Definition; hermetic, no emulators needed). Both services' `FIRESTORE_EMULATOR_HOST` branches make an emulator-based variant possible later; not required for acceptance.

## 7. Acceptance mapping

| Acceptance criterion (Definition) | Satisfied by | Pinned by |
|---|---|---|
| A1: failed payload carries `error_message` / `stage` / `retryable`, no fallback reliance | §4.1, §4.2 | tests W1–W4, P1–P3 |
| A2: persisted `error` = actual message (not "Processing failed"), `error_stage` = stage (not None), `retryable` = derived | §4.1 + unchanged API branch | tests S1, S2 |
| A3: summary subdocument carries same message and stage | unchanged API branch fed worker values | tests S1–S3 |
| A4: contract test exists, passes, fails on key drift on either side | §6 | the new file; drift guards in W1, S2, G1, G2 |

## 8. Implementation steps

1. **Worker:** add `build_failure_details` next to `classify_error` (§4.1).
2. **Worker:** add `current_stage` tracking per the §4.2 table; rewire the exception handler; extend the failure log with `stage` and `retryable`.
3. **Tests:** add `apps/ai-server/tests/integration/test_worker_failure_contract.py` with the harness and tests W1–W4, S1–S3, P1–P3, G1–G2 (see docs/test-plan.md).
4. **Verify:** run the new file; then the regression suites (test-plan §8) must stay green — no rag-api change is expected to perturb them.
5. **Optional smoke:** hermetic docker-compose stack (both services have verified `FIRESTORE_EMULATOR_HOST` branches); force a failure (e.g., missing source text) and inspect the persisted document: `error` = raised message, `error_stage` set, `retryable` per classification.

## 9. Risks & tradeoffs (from the Definition, accepted)

- **Unknown status-topic consumers** reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and representative early/late-stage tests; adding a step without tracking reports the previous checkpoint, not a crash.
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope, manual reprocess remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard doing its job.

## 10. Out of scope

Structured error-code taxonomy; retry/backoff mechanics (ACK/NACK policy, leases, heartbeats); the stale-lease sweep's behavior; frontend work; anything the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context); reconciling with the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker failure → rag-api persistence contract

Target file: `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new), in the existing shared integration suite next to `test_api_contracts.py`. Fully hermetic: no Pub/Sub emulator, no Firestore emulator, no network.

## 1. Strategy

Import both real sides; exercise the seam; never restate the contract in a fixture.

- **Worker side:** call `build_failure_details` directly, and drive the real `process_document` exception handler with a recorder in place of `_publish_status_update` — proving the handler actually uses the builder with the tracked stage (closing the bypass hole a pure-function test alone would leave).
- **API side:** feed the worker-built payload through the real `run_transactional_update` against an in-memory fake Firestore. The equality assertions on persisted fields are themselves the primary drift guard: if either side renames a key, the persisted value regresses to the API fallback (`"Processing failed"` / `None` / `True`) and the test fails.
- **Static supplements:** two AST guards (house pattern of `test_api_contracts.py`) pin the API's `details.get(...)` keys and the worker's handler/tracker wiring.

## 2. Import harness (worker module)

`rag-worker-service/main.py` has import-time side effects (`os.environ["GCP_PROJECT"]`, service-account load, `SubscriberClient` construction). The existing `tests/integration/conftest.py` already covers the Google/Firebase/structlog stack via `sys.modules` mocks and env defaults (`GCP_PROJECT=test-project`, `GOOGLE_APPLICATION_CREDENTIALS=/tmp/fake-creds.json`), per its own comment inviting extensions for new imports. The new test file adds, **before** loading the worker module:

1. **Dependency-tolerant shims — real modules win.** For each heavy worker import, try `importlib.import_module`; only on `ImportError` insert a stub via `sys.modules.setdefault`:
   - `langchain`, `langchain.text_splitter`, `langchain.schema`, `openai`, `langfuse`, `spacy`, `sklearn`, `sklearn.feature_extraction.text`, `tiktoken` → `MagicMock`.
   - `tenacity` → a passthrough namespace (`retry=lambda **kw: (lambda f: f)`) — a plain MagicMock would replace `@retry`-decorated methods with MagicMocks; the passthrough keeps them real.
   - `google.auth`, `google.auth.credentials`, `google.cloud.storage`, `google.cloud.firestore_v1.base_query` → `MagicMock` (the worker's `AnonymousCredentials` / `FieldFilter` / GCS imports are not all pre-mocked by conftest; pre-registering full dotted names in `sys.modules` avoids parent-package import attempts).
2. **Collision-free module load.** rag-api is imported as `import main as rag_api_main` (conftest path-inserts `rag-api-service`). The worker is loaded via `importlib.util.spec_from_file_location("rag_worker_main", <rag-worker-service>/main.py)` so the two `main.py` modules never collide in `sys.modules`.

## 3. Fake Firestore harness for `run_transactional_update`

Modeled on `rag-api-service/tests/unit/test_service_contracts.py` (`FakeDoc`/`FakeRef`), extended for the transactional shape:

- `FakeDoc`: `exists=True`, `to_dict()`; seeded with `status: "processing"` — required so the API's `ALLOWED_TRANSITIONS` permits `processing → failed` and the failed branch is reachable.
- `FakeResourceRef`: `get(*_, **__)` returns the doc; `collection("processing").document("summary")` returns a `FakeSummaryRef` that records `set(data, merge)`.
- `FakeTransaction`: records `update(ref, data)` and `set(ref, data, merge)` calls.
- `FakeDB`: `transaction()` returns the `FakeTransaction`.
- Fixture `identity_transactional`: `monkeypatch.setattr(rag_api_main.firestore, "transactional", lambda f: f, raising=False)` — `rag_api_main.firestore` is the conftest's mocked `firebase_admin.firestore` module shared via `sys.modules`, so the decorator becomes identity and the real transaction body executes against the fakes. `firestore.SERVER_TIMESTAMP` remains a mock value in recorded payloads (asserted around, not on).
- `logger` argument: `MagicMock()`.

## 4. Pipeline-test harness (worker `process_document`)

- Construct via `EnhancedDocumentProcessor.__new__(...)` (bypasses `__init__` and its cloud clients); set `langfuse=None`, `logger=MagicMock()`, `db=MagicMock()` (only `.document(...).update(...)` is touched on the success-stub path), `config=MagicMock()`, `content_tagger=SimpleNamespace(generate_tags=async (…)->([], {}))`.
- Replace `_publish_status_update` with an async recorder appending `(status, dict(details))` — the transport (Pub/Sub publish, lease-renewal writes, sequence bookkeeping) is out of scope.
- Monkeypatch pipeline step methods per case; pass `job_id=None` so the recorder payload is exactly `build_failure_details` output (the real `_publish_status_update`'s `jobId` injection is not under test).

## 5. Test matrix

| id | test | level | pins | acceptance |
|---|---|---|---|---|
| W1 | `test_failure_payload_has_exactly_the_contract_keys` | unit (worker) | payload key set | A1, A4 |
| W2 | `test_transient_error_derives_retryable_true` | unit | derivation rule | A1 |
| W3 | `test_permanent_and_unknown_errors_derive_retryable_false` | unit | conservative default (F8) | A1 |
| W4 | `test_unknown_stage_falls_back_to_processing` | unit | safe value | A1 |
| S1 | `test_worker_transient_failure_persists_through_rag_api_failed_branch` | seam | persisted equality | A2, A3 |
| S2 | `test_worker_permanent_failure_persists_retryable_false` | seam | API default not operative | A2, A4 |
| S3 | `test_summary_error_subdocument_matches_main_document` | seam | subdocument consistency | A3 |
| P1 | `test_process_document_reports_starting_stage_on_validation_failure` | pipeline | early stage | A1 |
| P2 | `test_process_document_reports_text_retrieved_stage_on_extraction_failure` | pipeline | mid stage, transient | A1 |
| P3 | `test_process_document_reports_embeddings_stage_on_late_failure` | pipeline | late stage, permanent | A1 |
| G1 | `test_rag_api_failed_branch_reads_the_contract_keys` | AST | API-side key drift | A4 |
| G2 | `test_worker_handler_uses_builder_and_tracks_stages` | AST | worker-side wiring drift | A4 |

## 6. Test specifications

**W1** — `details = build_failure_details(TransientError("x"), "text_retrieved")`; assert `set(details) == {"error_message", "error", "stage", "retryable"}` (exact equality: adding or removing a key fails); `details["error_message"] == "x"`, `details["error"] == "x"`, `details["stage"] == "text_retrieved"`, `details["retryable"] is True`.

**W2** — `TransientError("storage 503")` → `retryable is True`; also an `httpx.ConnectTimeout("t")`-style case if httpx is importable (it is, rag-api depends on it) → `True`.

**W3** — `PermanentError("unsupported")` → `retryable is False`; `RuntimeError("mystery")` (unclassified-unknown) → `classify_error` conservative default → `retryable is False`. This pins the deliberate behavior change (was silent `True`).

**W4** — `build_failure_details(e, None)` and `build_failure_details(e, "")` → `stage == "processing"`.

**S1 (transient seam)** — `details = rag_worker_main.build_failure_details(TransientError("network hiccup"), "text_retrieved")`; act: `rag_api_main.run_transactional_update(db, ref, "failed", details, logger, "u1")`. Assert recorded main update equals, on the contract fields:
```python
{"status": "failed", "schema_version": 2,
 "error": "network hiccup", "error_stage": "text_retrieved", "retryable": True}
```
plus explicit guards: `error != "Processing failed"`, `error_stage is not None`. Assert recorded summary set payload:
```python
{"stage": "text_retrieved", "progress": 0,   # payload has no progress key → API default 0
 "error": {"code": "UNKNOWN", "message": "network hiccup", "stage": "text_retrieved"}}
```

**S2 (permanent seam)** — same with `PermanentError("unsupported file")`, stage `"embeddings_complete"`; assert persisted `retryable is False` — the strongest drift detector, since the API fallback would have written `True`.

**S3** — within S1/S2 recordings, assert `summary.error.message == main.error` and `summary.error.stage == main.error_stage` (acceptance A3).

**P1** — monkeypatch `_validate_processing_request` to raise `ValueError("doc missing")`; run `process_document`. Assert recorder saw exactly one `("failed", details)` with `stage == "starting"`, `error_message == "doc missing"`, `retryable is False` (ValueError unclassified → permanent), and the exact W1 key set.

**P2** — `_get_extracted_text` raises `TransientError("storage unavailable")` (validate stubbed no-op). Assert `stage == "text_retrieved"`, `retryable is True`.

**P3** — stub success through: `_get_extracted_text → ("text", {"title": "t"})`, tagger → `([], {})`, `generate_document_summary → None` (the `ragDescription: None` Firestore write hits the mocked `db`), `_create_enhanced_chunks → []`; `_generate_embeddings_with_openrouter` raises `PermanentError("invalid embedding input")`. Assert `stage == "embeddings_complete"`, `retryable is False`.

**G1 (AST, API)** — parse `rag-api-service/main.py`; locate `FunctionDef run_transactional_update`; collect every `details.get("<key>", …)` key constant. Assert `{"error_message", "stage", "retryable"} ⊆ keys` and `"error" ∉ keys` (pins that rag-api does not read the legacy key — the alignment direction).

**G2 (AST, worker)** — parse `rag-worker-service/main.py`; assert (a) module defines `build_failure_details` whose body calls `classify_error`; (b) inside `process_document`'s exception handler, the `_publish_status_update` call with status `"failed"` passes a **call to `build_failure_details`** as its details argument (not a dict literal); (c) the string constants assigned to the stage local inside `process_document` include all of `starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete` (catches the tracker being removed or bypassed without ossifying every step).

## 7. Optional emulator variant (not required for acceptance)

A `@pytest.mark.skipif(not os.getenv("FIRESTORE_EMULATOR_HOST"), ...)` test may later seed a real-emulator document and run `run_transactional_update` with a real client (both services have verified emulator branches). Deferred: the fake harness already exercises the real transaction body.

## 8. Regression suites that must stay green

- `apps/ai-server/tests/integration/test_api_contracts.py` (imports rag-api main; no API change expected to perturb it).
- `apps/ai-server/rag-api-service/tests/unit/` (all, including `test_service_contracts.py`, `test_models_resource.py`).
- `apps/ai-server/rag-api-service/tests/integration/` (endpoint tests).
- No worker-side test suite was identified in the verified tree; the new file is the first contract coverage of the worker failure path in the shared integration suite.

## 9. Explicitly not tested (out of scope)

Pub/Sub ACK/NACK mechanics and redelivery behavior; lease/heartbeat/sweep behavior (`_fail_if_still_stale` already writes the established schema and is a non-goal); `_publish_status_update` transport (topic path, sequencing, lease renewal); rag-api's fallback behavior for non-worker publishers (enqueue-failure paths keep their own explicit writes); summary `error.code` taxonomy (stays `"UNKNOWN"`); frontend rendering of `error`/`error_stage`.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>