<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- **Cycle intent:** `rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage`
- **Authoritative source:** WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c…89cac5`). This document restates and refines that Definition; where any wording here and the Definition disagree, the Definition wins.
- **Status:** design-step output (requirements + acceptance; architecture in `docs/architecture.md`).

---

## 1. Problem statement (verified)

The worker's exception handler in `process_document` (`apps/ai-server/rag-worker-service/main.py`, ≈L1093–1099) publishes the failed status with a one-key payload:

```python
await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)
```

rag-api's failed branch in `run_transactional_update` (`apps/ai-server/rag-api-service/main.py`, ≈L233–241 for the main document, ≈L325–331 for the `processing/summary` subdocument) reads three different keys:

```python
main_update["error"]       = details.get("error_message", "Processing failed")
main_update["error_stage"] = details.get("stage")
main_update["retryable"]   = details.get("retryable", True)
```

Consequence (verified): every worker-originated failure persists `error = "Processing failed"` (fallback string), `error_stage = None`, and `retryable = True` (silent default) — on both the main resource document and the `processing/summary` error subdocument (`error.code` always `"UNKNOWN"`). Users and support cannot disambiguate failures.

The persisted schema `error` / `error_stage` / `retryable` is already the established contract on every other write path (verified):

| Writer | Location | Notes |
|---|---|---|
| Worker stale-lease sweep `_fail_if_still_stale` | `rag-worker-service/main.py` ≈L2166–2196 | writes `error`, `error_stage: "processing"`, `retryable: True` |
| rag-api enqueue-failure paths (`/process`, `POST /resources`) | `rag-api-service/main.py` | write the same fields directly |
| `Resource` model / `ResourceResponse` | `rag-api-service/models/resource.py` ≈L48–52, ≈L103–107 | `error`, `error_stage`, `retryable` (default `True`) |

The worker's status publisher is the only writer that does not speak this contract. The fix aligns the worker to the API — not the API to the worker.

## 2. Normative contract

### 2.1 Worker → rag-api failure payload (`details` of the `failed` status message)

The worker's failed status payload (the `details` dict passed to `_publish_status_update` with `status="failed"`) MUST contain exactly:

| Key | Type | Value | Status |
|---|---|---|---|
| `error_message` | str | `str(e)` — the actual exception message | **new, required** |
| `stage` | str | the pipeline stage executing at failure time (see §2.2) | **new, required** |
| `retryable` | bool | derived from `classify_error(e)` (see §2.3) | **new, required** |
| `error` | str | `str(e)` — legacy key, identical to `error_message` | retained (compat hedge) |

Notes:
- The existing envelope produced by `_publish_status_update` (≈L1541–1608) is unchanged: `user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`, and the `jobId` injection when a `job_id` is present.
- rag-api's failed branch additionally reads `error_code` (default `"UNKNOWN"`). The worker deliberately does NOT send it (constraint: no error-code taxonomy in this fix); `summary.error.code` therefore remains `"UNKNOWN"`.
- The failure payload deliberately does NOT include `progress`; the summary subdocument's `progress` will therefore continue to default to `0` on failure (existing behavior, unchanged, out of scope).

### 2.2 Stage vocabulary and tracking

Stage names MUST reuse the worker's existing progress-update vocabulary (verified in `process_document`, ≈L1005–1092):

```
starting, text_retrieved, tagging_complete, summary_generated,
chunking_complete, embeddings_complete
```

plus the safe value `"processing"` when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage` (verified ≈L2183), so `error_stage` never regresses to `None`.

Tracking convention (binding): the tracker is set to a stage's vocabulary name **immediately before the awaited call that implements that stage**; a failure during that step reports that name. Mapping:

| Tracker value | Set immediately before |
|---|---|
| `starting` | `_validate_processing_request` (first statement inside the try) |
| `text_retrieved` | `_get_extracted_text` |
| `tagging_complete` | `content_tagger.generate_tags` |
| `summary_generated` | `generate_document_summary` (covers the summary doc write) |
| `chunking_complete` | `_create_enhanced_chunks` |
| `embeddings_complete` | `_generate_embeddings_with_openrouter` |
| *(no further assignment)* | `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection` — the tracker remains `"embeddings_complete"` through this trailing region |

Rationale for the trailing region: the vocabulary is closed by requirement (no new stage names in this fix), and `"embeddings_complete"` is the last named region the storage steps follow. Reporting `"processing"` there would misreport a known region as unknown.

### 2.3 `retryable` derivation (deliberate, never defaulted)

`retryable` MUST be derived from the worker's existing `classify_error(e)` (verified ≈L36–81) — the same classification that drives ACK/NACK in `run_worker` (verified ≈L2099–2117):

| `classify_error(e)` | payload `retryable` | Pub/Sub outcome |
|---|---|---|
| `True` (transient: `TransientError`, connect/timeout types, HTTP 429/500/502/503/504) | `true` | message NACKed, redelivered |
| `False` (permanent: `PermanentError`, other 4xx, **unclassified-unknown**) | `false` | message acked; manual reprocess via `POST /process` |

**Deliberate behavior change:** unclassified-unknown exceptions currently persist `retryable: true` (rag-api's silent default) but classify as permanent; after this fix they persist `false`. This is accepted — it makes the persisted record tell the truth about retry behavior and prevents infinite retry loops. The stale-lease sweep's separate direct write of `retryable: true` is untouched and stays correct (a dead worker is a transient condition).

## 3. Functional requirements

- **FR-1 (failure payload):** When document processing fails, the worker's failed status payload MUST include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived per §2.3). The payload MUST never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for these keys.
- **FR-2 (stage tracking):** The worker MUST track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage, using the §2.2 vocabulary and set-before-await convention, with `"processing"` as the safe value when the stage is genuinely unknown.
- **FR-3 (rag-api persistence unchanged):** rag-api's failed branch MUST persist worker-provided values unchanged: main document `error ← details["error_message"]`, `error_stage ← details["stage"]`, `retryable ← details["retryable"]`; the `processing/summary` error subdocument MUST carry the same message (`error.message`) and stage (`error.stage`), with `error.code` remaining `"UNKNOWN"` unless a code is actually sent. No rag-api read paths or persisted field names change.
- **FR-4 (retryable derivation):** The derivation MUST be explicit and aligned with ACK/NACK behavior: `classify_error(e) == True → retryable true`; `classify_error(e) == False (including unclassified-unknown) → retryable false`.
- **FR-5 (contract test):** A contract test MUST cover the worker failure → rag-api persistence path: it MUST exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It MUST fail if either side's payload keys drift (worker-side exact key-set assertion; rag-api-side read-key assertion — see architecture §6).
- **FR-6 (legacy key retention):** The worker MUST retain the legacy `error` key (equal to `error_message`) in the failure payload for continuity with any unknown consumers of the status topic and existing log tooling.

## 4. Constraints (binding, from the Definition)

1. **must** — Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema.
2. **must_not** — No Firestore migration, field rename, or backfill of existing documents; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
3. **must** — Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
4. **prefer** — Retain the legacy `error` key alongside `error_message` (adopted as FR-6).
5. **prefer_not** — Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

## 5. Non-goals

- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — already consistent with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy — `summary.error.code` stays `"UNKNOWN"` unless a code is actually sent.
- The map-only regeneration path (`regenerate_map_only`) and message-level failures in `run_worker` outside `process_document` (e.g., claim failures) — their error handling is untouched.
- Adding `progress` to the failure payload (summary `progress` continues to default to `0` on failure).
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## 6. Acceptance criteria

- **AC-1** — A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. *Verify: FR-1/FR-2 tests + contract test key-set guard.*
- **AC-2** — After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. *Verify: contract test persistence assertions.*
- **AC-3** — The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. *Verify: contract test summary assertions.*
- **AC-4** — A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. *Verify: new test module green in CI; mutation of either side's keys turns it red.*

## 7. Unknowns and deferred items

- Consumers of the `rag-status-updates` topic other than rag-api's status subscriber are unverified; the retained legacy `error` key (FR-6) is the hedge. A future audit may drop the duplicate.
- The full required-field list of `ProcessingConfig` beyond the prefix verified in `rag-worker-service/tests/conftest.py` is unverified; if additional required fields exist, test env defaults must be extended (implementation detail, see architecture §6.4).
- The companion D3 issue's content is unavailable; anything it covers beyond this alignment is deferred (F12).
- `plans/upload-flow.md` (original D4 deviation analysis) is not present in the current tree; not reconcilable here.

## 8. Traceability

| Definition fact | Addressed by |
|---|---|
| F1 (product intent) | FR-1, FR-2, FR-4 |
| F2 (preferred direction: worker aligns) | FR-1, FR-3, constraint 1 |
| F3 (worker publishes `{"error": ...}`) | FR-1, FR-6 |
| F4 (rag-api failed-branch reads) | FR-3 |
| F5 (fallback persistence today) | §1, AC-2 |
| F6 (established persisted schema) | §1 table, FR-3 |
| F7 (classify_error / ACK-NACK) | FR-4 |
| F8 (adopted retryable default) | §2.3, FR-4 |
| F9 (stage vocabulary, no tracking today) | FR-2, §2.2 |
| F10 (contract-test infrastructure exists) | FR-5 |
| F11 (legacy `error` hedge) | FR-6 |
| F12 (companion D3 issue deferred) | §5, §7 |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

- **Authoritative source:** WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256-pinned). Requirements in `docs/requirements.md`; this document specifies how to implement them.
- **Legend:** code locations marked **[V]** were verified by direct reads during investigation; line numbers are approximate (≈). Items marked **[D]** are design decisions made here, not pre-existing repository facts.

---

## 1. Current-state seam [V]

```
rag-worker-service/main.py                          rag-api-service/main.py
─────────────────────────────                       ────────────────────────────
process_document (≈L1004–1099)                      _process_status_message (≈L333–383)
  one large try block; 6 pipeline steps;            parses envelope, resolves doc path,
  progress publishes at each stage boundary;        calls run_transactional_update
  exception handler (≈L1093–1099):                            │
    publish "failed" details={"error": str(e)}  ── Pub/Sub topic ──▶ run_transactional_update (≈L162–345)
                                                                failed branch (≈L233–241):
                                                                  error       ← details["error_message"] (fb "Processing failed")
                                                                  error_stage ← details["stage"]          (fb None)
                                                                  retryable   ← details["retryable"]      (fb True)
                                                                summary failed block (≈L325–331):
                                                                  error.code    ← details["error_code"] (fb "UNKNOWN")
                                                                  error.message ← details["error_message"] (fb)
                                                                  error.stage   ← details["stage"]
```

Key mismatch [V]: worker sends `error`; rag-api reads `error_message`, `stage`, `retryable`. Result: fallback persistence on every worker failure.

Supporting verified context [V]:
- `classify_error()` (worker main.py ≈L36–81): `True` for `TransientError`, httpx connect/timeout types, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, `HTTPStatusError` with 429/500/502/503/504; `False` for `PermanentError`, other 4xx, and **unknown exceptions (conservative default)**.
- `run_worker` ACK/NACK (≈L2099–2117): `is_transient = classify_error(e)`; transient → omitted from `ack_ids` (redelivery); permanent → acked.
- `_publish_status_update` (≈L1541–1608): builds the envelope, injects `jobId` into `details` when `job_id` is present, assigns per-resource `sequence`, renews the processing lease, resets sequence on terminal states (`completed`/`failed`). It mutates the passed `details` dict in place (jobId injection) — the new builder must return a fresh dict per call.
- `_fail_if_still_stale` (≈L2166–2196): direct failure write with `error` / `error_stage: "processing"` / `retryable: True` — untouched by this fix.
- `models/resource.py` (≈L48–52, ≈L103–107): `error`, `error_stage`, `retryable: bool = True`.
- rag-api `AppState.startup` (≈L128–140) and worker `_init_services` (≈L739–752) both have `FIRESTORE_EMULATOR_HOST` branches; worker `_build_storage_client` has a `STORAGE_EMULATOR_HOST` branch — hermetic emulator mode exists on both sides.
- `rag-worker-service/exceptions.py` [V]: `PDFProcessingError` carries a `retryable` *metadata attribute*, but per the binding Definition the operative derivation for the payload is `classify_error(e)` — do not substitute the exception-attribute mechanism.
- Test infrastructure [V]: `tests/integration/conftest.py` (34 lines) mocks `firebase_admin` / `google.cloud.*` / `structlog` and puts `rag-api-service` on `sys.path` so `import main as rag_api_main` works; `test_api_contracts.py` (343 lines) establishes the fixture- and AST-based contract-test style. `rag-worker-service/tests/conftest.py` (120 lines) sets env defaults and stubs the worker's heavy deps so worker `main.py` is importable in tests. `rag-worker-service/tests/integration/` exists but is empty (only `__init__.py`).

## 2. Target design

### 2.1 Worker: stage tracker [D]

In `process_document`, introduce a local tracker and follow the set-before-await convention:

```python
async def process_document(self, user_id, course_id, resource_id, job_id=None):
    metrics = ProcessingMetrics(start_time=time.time())
    trace = ...  # unchanged (outside try; pre-existing behavior if this raises)
    current_stage = "processing"          # safe default; reported only if never set
    try:
        current_stage = "starting"        # set immediately before the await below
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
        ...  # summary doc write stays inside this stage region
        ...
        current_stage = "chunking_complete"
        chunks = await self._create_enhanced_chunks(...)
        ...
        current_stage = "embeddings_complete"
        vectors = await self._generate_embeddings_with_openrouter(chunks)
        ...
        # delete_old_vectors_via_service / store_chunks_via_service /
        # _save_processing_metadata_to_subcollection: tracker remains
        # "embeddings_complete" (vocabulary is closed; see requirements §2.2)
    except Exception as e:
        ...
```

Rules:
- Assignment goes on the line immediately preceding the awaited step it names; a comment at the tracker declaration points to the contract test so future pipeline steps inherit the convention.
- `"processing"` remains the value only if the handler is reached before any assignment (defensive; e.g., future refactors), matching the sweep's `error_stage` value.
- `metrics.error_message = str(e)` in the handler is unchanged.

### 2.2 Worker: failure payload builder [D]

Add a module-level pure function in `rag-worker-service/main.py` (next to `classify_error`, which it calls):

```python
def build_failure_payload(e: Exception, stage: Optional[str]) -> Dict[str, Any]:
    """Single source of truth for the worker→rag-api failure contract.

    Keys are pinned by tests/integration contract tests; do not rename
    without updating rag-api's failed branch AND the contract test.
    """
    message = str(e)
    return {
        "error": message,                       # legacy key retained (compat hedge)
        "error_message": message,               # rag-api reads this → persisted `error`
        "stage": stage if stage else "processing",
        "retryable": classify_error(e),         # deliberate derivation, never a default
    }
```

Rationale for module-level + pure: the contract test can exercise the real construction code path without driving the whole pipeline; `classify_error` is already module-level [V].

### 2.3 Worker: handler rewiring [D]

Replace the handler's publish call (≈L1093–1099):

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", ..., error=str(e))
    await self._publish_status_update(
        user_id, course_id, resource_id, "failed",
        build_failure_payload(e, current_stage), job_id,
    )
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

Everything else in `_publish_status_update` (sequence, lease renewal, `jobId` injection, terminal reset) applies to failure payloads exactly as today [V].

### 2.4 rag-api: unchanged

No edits to `run_transactional_update`, `_process_status_message`, models, or any read path. The failed branch already implements FR-3 exactly [V]; the worker is the odd writer out and is the only side changed. The legacy `error` key in the payload is inert to rag-api (its failed branch never reads `details["error"]`) [V].

## 3. Resulting payload example [D]

```json
{
  "user_id": "u1", "course_id": "__ungrouped__", "resource_id": "r1",
  "status": "failed", "timestamp": 1730000000.0, "sequence": 7, "jobId": "j-1",
  "details": {
    "error": "OpenRouter embedding call failed after 3 attempts: 502",
    "error_message": "OpenRouter embedding call failed after 3 attempts: 502",
    "stage": "embeddings_complete",
    "retryable": true
  }
}
```

Persisted after rag-api's failed branch: main doc `error` = the message (no longer `"Processing failed"`), `error_stage` = `"embeddings_complete"` (no longer `None`), `retryable` = `true` (derived, not defaulted); `processing/summary` gains `stage: "embeddings_complete"`, `progress: 0` (unchanged default), `error: {code: "UNKNOWN", message: <same>, stage: "embeddings_complete"}`.

## 4. Contract test architecture [D]

New module: `apps/ai-server/tests/integration/test_worker_failure_contract.py`, in the house style of `test_api_contracts.py` [V].

### 4.1 Module loading (two `main.py` collision)

Both services name their entry module `main.py` [V]; the existing conftest already imports rag-api's as `rag_api_main`. The worker side is loaded under a distinct alias:

1. Apply the env defaults and cloud-dep stubs mirroring `rag-worker-service/tests/conftest.py` (verified sufficient for importing worker `main.py`: `GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `RAG_PROCESS_SUB`, `RAG_STATUS_TOPIC`, `OPENROUTER_*`, `FIREBASE_*`, `SHARED_INTERNAL_TOKEN`, `WEAVIATE_SERVICE_URL`, plus stubs for `openai`, `langfuse`, `firebase_admin`, `google.cloud.*`, `spacy`, `tiktoken`, `tenacity`, langchain shims).
2. Load `rag-worker-service/main.py` via `importlib.util.spec_from_file_location("rag_worker_main", <path>)` — module-level worker code (env reads, `SUBSCRIBER` construction) then executes safely against the stubs [V: module-level block reads `os.environ["GCP_PROJECT"]`, requires `GOOGLE_APPLICATION_CREDENTIALS`, builds `pubsub_v1.SubscriberClient`].
3. Import rag-api `main` as the existing suite does (shared conftest mocks).
4. Unknown [V-gap]: `ProcessingConfig` fields beyond the verified prefix may be required if a test constructs `EnhancedDocumentProcessor`; extend env defaults if so. The payload-builder and persistence tests do not require constructing the processor.

### 4.2 Fake transaction harness (primary persistence vehicle)

`run_transactional_update`'s `update_logic` uses exactly this surface [V]: `firestore.transactional` (decorator), `firestore.SERVER_TIMESTAMP`, `db.transaction()`, `doc_ref.get(transaction=t)` → snapshot (`.exists`, `.to_dict()`), `transaction.update(doc_ref, main_update)`, `doc_ref.collection("processing").document("summary")`, `transaction.set(summary_ref, summary_update, merge=True)`, `doc_ref.id`. Build a minimal in-process fake implementing precisely this (patch `rag_api_main.firestore.transactional` to a pass-through decorator and `SERVER_TIMESTAMP` to a sentinel; seed the document with `status: "processing"` so the `processing → failed` transition is allowed by `ALLOWED_TRANSITIONS` [V]). This keeps the guard deterministic with zero infrastructure.

### 4.3 Test cases

1. **End-to-end persistence (transient):** `payload = rag_worker_main.build_failure_payload(TransientError("boom"), "text_retrieved")` → feed `payload` as `details` to `rag_api_main.run_transactional_update(fake_db, doc_ref, "failed", payload, logger, user_id)` → assert captured main update: `status=="failed"`, `error=="boom"`, `error_stage=="text_retrieved"`, `retryable is True`; captured summary update: `stage=="text_retrieved"`, `error=={"code":"UNKNOWN","message":"boom","stage":"text_retrieved"}`.
2. **End-to-end persistence (permanent / unclassified):** same with a plain `Exception` (classifies permanent [V]) at a late stage → `retryable is False`, `error_stage=="embeddings_complete"` (pins the trailing-region interpretation, requirements §2.2).
3. **Worker key-set drift guard:** `set(build_failure_payload(e, "starting").keys()) == {"error", "error_message", "stage", "retryable"}` — exact set; adding or removing a key fails the build (deliberate ossification).
4. **rag-api read-key drift guard (AST):** parse `rag-api-service/main.py`, extract the first-argument string literals of `details.get(<literal>, ...)` calls inside the two `if new_status == "failed":` blocks, and assert the extracted set equals `{"error_message", "stage", "retryable", "error_code"}` — same AST-walking style as the verified shapes extraction in `test_api_contracts.py` [V]. Renames, removals, or additions on the API side fail loudly.
5. **Stage-tracking tests (worker-side):** with the worker stubs applied, construct the processor (env defaults per §4.1), monkeypatch pipeline collaborators so an early step (`_get_extracted_text`) and a late step (`store_chunks_via_service`) raise, capture `_publish_status_update` calls (patch the method or the publisher), and assert the failed payload's `stage`, `error`/`error_message`, and `retryable` (early → `"text_retrieved"`; late → `"embeddings_complete"`; `retryable` equals `classify_error` of the raised error). Exact construction mechanics may need adjustment at implementation time if `ProcessingConfig`/constructor requirements differ from the verified prefix — the required coverage (early + late representative stage, both derivations) is fixed by FR-2/FR-4/FR-5 regardless.

### 4.5 Optional emulator variant

Where the hermetic stack is available (`FIRESTORE_EMULATOR_HOST` set — both services support it [V]), the same assertions can run against a real Firestore emulator instead of the fake, exercising the real `firestore.transactional` path. Keep it behind an environment gate so the always-on guard (§4.2–4.3) never depends on infrastructure.

## 5. End-to-end failure flow (after fix) [D]

1. Pipeline step raises inside `process_document`'s try; tracker holds the failing stage's vocabulary name.
2. Handler builds `details` via `build_failure_payload(e, current_stage)` — `error_message`/`error` = actual message, `stage` = failing stage, `retryable` = `classify_error(e)`.
3. `_publish_status_update` publishes on `rag-status-updates` with unchanged envelope semantics (sequence, lease renewal, `jobId`).
4. rag-api `_process_status_message` resolves the doc path and runs `run_transactional_update`; the `processing → failed` transition persists the worker's real values on the main doc and the `processing/summary` error subdocument.
5. `run_worker` ACK/NACK independently applies the same `classify_error` verdict to the message (unchanged); persisted `retryable` now matches that verdict.
6. Stale-lease sweep behavior unchanged (`retryable: true` for dead-worker failures — still correct).

## 6. File-by-file change plan [D]

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Add `build_failure_payload()` (module level); add `current_stage` tracker + set-before-await assignments in `process_document`; rewire the exception handler's publish call. No other worker changes. |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | New: cases §4.3, loading recipe §4.1, fake harness §4.2. |
| `apps/ai-server/rag-api-service/**` | **No changes.** |
| `apps/ai-server/tests/integration/conftest.py` | No changes expected; extend only if the worker-loading helper needs a shared fixture home. |

## 7. Risks and tradeoffs (from the Definition, with mitigations)

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error` (FR-6); residual risk accepted as low; dropping the duplicate later is trivial cleanup after an audit.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the set-immediately-before-the-await convention, a pointer comment at the tracker, and representative early/late stage tests (§4.3 case 5).
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted per F8; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.
- **Import-weight risk in the contract test** (worker `main.py` pulls heavy deps) — mitigated by the verified stub set (§4.1); fallback design: extract the builder + vocabulary into a small dependency-light module if import cost proves prohibitive (would require rewiring `main.py` to import it; keep `classify_error` semantics identical).

## 8. Out of scope / deferred

As listed in requirements §5: error-code taxonomy, retry/backoff mechanics, the sweep, frontend, `regenerate_map_only` and non-`process_document` failure paths, `progress` in failure payloads, the companion D3 issue's scope, and `plans/upload-flow.md` reconciliation (file absent from the tree).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>