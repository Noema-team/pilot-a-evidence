Investigation is complete; producing the contracted artifacts from the verified evidence (worker `main.py` pipeline/except-handler/`classify_error`/sweep, rag-api `run_transactional_update` failed branch, `models/resource.py`, and the existing contract-test infrastructure).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

**Objective:** obj-108 — "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
**Authoritative scope:** Definition artifact `definition:obj-108` (sha256 `71f1c39c…`, WorkItem `wi-define-108-a8`). This plan implements exactly that scope. Nothing wider.

---

## 1. Summary

The rag-worker's failure publisher and rag-api's failure consumer were written against different contracts. The worker publishes a failed status whose details carry a single key (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error` / `error_stage` / `retryable`. Every worker-originated failure therefore lands in Firestore as the fallback string `"Processing failed"`, a null stage, and a fabricated `retryable: true`.

The fix aligns the worker to rag-api's existing contract (no rag-api changes, no migration): the worker gains (a) a stage tracker through `process_document`, (b) a deliberately derived `retryable` from the existing `classify_error()`, and (c) a payload builder that emits `error_message` / `stage` / `retryable` plus the legacy `error` key as a compatibility hedge. A cross-service contract test pins the seam.

## 2. Verified current state

All claims below were verified by reading the current tree.

### 2.1 Worker publisher — `apps/ai-server/rag-worker-service/main.py`

- `process_document` runs the entire pipeline in one `try`. The `except Exception` handler (~line 1093) publishes the failure with a single details key:
  `await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)`.
- Progress status updates publish the stage vocabulary: `starting`, `text_retrieved` (progress 20), `tagging_complete` (40), `summary_generated` (50), `chunking_complete` (60), `embeddings_complete` (80), and `completed` (100). Nothing tracks the in-flight stage for the failure handler.
- `classify_error(e)` (~lines 44–93) returns `True` for `TransientError`, httpx connect/timeout exception types, `ConnectionError` / `TimeoutError` / `asyncio.TimeoutError`, and `httpx.HTTPStatusError` with status 429/500/502/503/504; returns `False` for `PermanentError`, other 4xx statuses, and — conservatively — **any unknown exception**.
- `run_worker` uses `classify_error` for ACK/NACK: transient → message omitted from `ack_ids` (Pub/Sub redelivers); permanent → acked.
- The stale-lease sweep's `_fail_if_still_stale` writes `error` / `error_stage: "processing"` / `retryable: True` directly to Firestore — already on the target persisted schema. It does **not** go through the Pub/Sub payload.
- `_publish_status_update` wraps `details` in an envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`), injects `jobId` into `details` when missing, resets the sequence on terminal states, renews the processing lease, and **swallows its own publish errors** (a failed publish cannot trigger the exception handler).
- Import-time side effects: `GCP_PROJECT = os.environ["GCP_PROJECT"]`, module-level Pub/Sub subscriber construction from the service-account file, and heavy third-party imports (langchain, openai, langfuse, spacy, sklearn, tiktoken) at module top.

### 2.2 API consumer — `apps/ai-server/rag-api-service/main.py`

- `run_transactional_update` failed branch (~lines 237–240) on the main document:
  - `error` ← `details.get("error_message", "Processing failed")`
  - `error_stage` ← `details.get("stage")`
  - `retryable` ← `details.get("retryable", True)`
- Summary subdocument failed branch (~lines 281–286): `error.code` ← `details.get("error_code", "UNKNOWN")`, `error.message` ← `error_message` (same fallback), `error.stage` ← `stage`.
- Writes go through the transaction object: `transaction.update(doc_ref, main_update)` and `transaction.set(summary_ref, summary_update, merge=True)`. The transition gate (`ALLOWED_TRANSITIONS`) permits `processing → failed` only (also `failed → queued` for reprocess).
- `_process_status_message` parses `user_id`, `course_id`, `resource_id`, `status`, `details` from the envelope and resolves the canonical `users/{uid}/resources/{rid}` path (legacy course path as fallback).
- `AppState.startup` has a `FIRESTORE_EMULATOR_HOST` branch (hermetic mode exists).

### 2.3 Persisted schema & test infrastructure

- `apps/ai-server/rag-api-service/models/resource.py`: `Resource` exposes `error`, `error_stage`, `retryable` (default `True`) — the persisted schema this fix must preserve unchanged.
- `apps/ai-server/tests/integration/test_api_contracts.py` + its `conftest.py`: the existing cross-service contract-test home. The conftest stubs `firebase_admin`, `google.cloud.*`, `google.oauth2.*`, `structlog` in `sys.modules`, sets `GCP_PROJECT` / `GOOGLE_APPLICATION_CREDENTIALS` / `SHARED_INTERNAL_TOKEN`, and puts `rag-api-service` on `sys.path` so tests do `import main as rag_api_main`.
- `apps/ai-server/rag-api-service/tests/unit/test_service_contracts.py` establishes the house fake pattern: assert the *real* method's contract against minimal fakes; never mock the method under test; never restate a contract in a fixture.
- `apps/ai-server/rag-worker-service/pytest.ini`: `asyncio_mode = auto`; worker unit tests exist under `tests/unit/`.
- `apps/ai-server/rag-worker-service/exceptions.py` exists; its contents were **not** verified in this pass (see §10).

### 2.4 Root cause

The worker is the only failure writer that does not speak the `error_message` / `stage` / `retryable` payload dialect: the sweep, rag-api's enqueue-failure paths, and the `Resource` model all already use the `error` / `error_stage` / `retryable` persisted schema. Fix the odd one out.

## 3. Design

### 3.1 New module: `apps/ai-server/rag-worker-service/failure_payload.py`

**Rationale:** the contract test must exercise the worker's *real* payload construction, but `main.py` cannot be imported cheaply outside the worker venv (heavy third-party imports plus import-time Pub/Sub setup), and both services name their entry module `main` (a `sys.path` collision for `import main`). A dependency-light module (stdlib + `httpx` only — `httpx` is already a real dependency in the integration-test environment via rag-api) makes the worker side importable by the cross-service test with no new module mocks.

Contents — pure code motion plus one new function:

- **Move verbatim** from `main.py`: `ProcessingError`, `TransientError`, `PermanentError`, `classify_error` (zero behavior change; the classification logic is reused as-is for `retryable` derivation, per definition F8).
- Add `UNKNOWN_STAGE = "processing"` (same value the stale-lease sweep uses for `error_stage`).
- Add:

```python
def build_failure_payload(e: Exception, stage: Optional[str] = None) -> Dict[str, Any]:
    """Build the failed-status details payload for rag-api's failed branch.

    Contract (rag-api run_transactional_update, failed branch):
      error       <- error_message
      error_stage <- stage
      retryable   <- retryable
    `error` is retained deliberately as a legacy duplicate for any unknown
    consumers of the status topic. No error_code is sent; rag-api defaults
    the summary error.code to "UNKNOWN".
    """
    message = str(e)
    return {
        "error_message": message,
        "stage": stage or UNKNOWN_STAGE,
        "retryable": classify_error(e),
        "error": message,  # legacy key, kept on purpose — see docstring
    }
```

Module docstring documents the consumer contract and the intentional key set.

### 3.2 `main.py` re-export

Replace the moved definitions in place with:

```python
from failure_payload import ProcessingError, TransientError, PermanentError, classify_error
```

The names remain importable as `main.classify_error` etc., so `run_worker`'s ACK/NACK logic and any external importers keep working unchanged. A grep step (§7) covers other in-repo importers.

### 3.3 Stage tracker in `process_document`

A plain local, initialized before the `try`, set immediately before each pipeline step (the definition's stated convention), read by the exception handler.

| Tracker assignment point | Value | Covers failures in |
|---|---|---|
| function entry, before `try` | `"processing"` (defensive default) | — |
| before `_validate_processing_request` + initial publish | `"starting"` | validation, initial status publish |
| before `_get_extracted_text` | `"text_retrieved"` | text retrieval / PDF extraction |
| before `content_tagger.generate_tags` | `"tagging_complete"` | tagging |
| before `generate_document_summary` (and the description Firestore update) | `"summary_generated"` | summary generation / persist |
| before `_create_enhanced_chunks` | `"chunking_complete"` | chunking |
| before `_generate_embeddings_with_openrouter` | `"embeddings_complete"` | embeddings **and** the post-embedding steps below |
| post-embedding steps (delete old vectors, store chunks, metadata save, completed publish, usage update, resource map) | *(no new assignment)* → reports `"embeddings_complete"` | accepted stale-stage reporting per definition |

Notes:

- The vocabulary is exactly the six progress-stage names plus the `"processing"` fallback — no new stage names are introduced, satisfying the definition's vocabulary constraint.
- Post-embedding steps deliberately keep the last milestone value. The definition explicitly accepts stale-stage reporting for untracked steps ("a future pipeline step added without updating the tracker reports a stale stage") and reserves `"processing"` for when the stage is genuinely unknown.
- A one-line comment at the tracker init states the convention: *"set the tracker immediately before the await"* so future pipeline steps maintain it.
- Tracker semantics: the value is the milestone **whose work is in flight** (its completion-event name), set before the step — per the definition's "set immediately before each pipeline step".

### 3.4 Failure handler rewrite

Before (current):

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", user_id=..., course_id=..., resource_id=..., error=str(e))
    await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

After:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    failure_details = build_failure_payload(e, stage=current_stage)
    self.logger.error("document_processing_failed", user_id=..., course_id=..., resource_id=...,
                      error=str(e), stage=failure_details["stage"], retryable=failure_details["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e), "stage": failure_details["stage"]})
    return metrics
```

- `metrics.error_message`, the log event name, and the return value are unchanged.
- `_publish_status_update` may add `jobId` to the dict — harmless; rag-api reads `jobId` only on the processing branch. The contract test's exact-key-set assertion applies to `build_failure_payload`'s return value (pre-publish).
- An empty exception message (`str(e) == ""`) is sent as-is — it is the actual message; rag-api's fallback only applies when the key is *missing*, which can no longer happen for worker failures.

### 3.5 rag-api: intentionally unchanged

`run_transactional_update` already implements the target contract exactly: `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`, and the summary subdocument carries the same message and stage with `code` defaulting to `"UNKNOWN"`. Requirement 3 ("persist the worker-provided values unchanged") is satisfied by existing code and *proven* by the new contract test. No reader changes, no schema changes, no migration (constraints: must / must_not).

## 4. Deliberate behavior changes & compatibility

- **`retryable` for unclassified-unknown exceptions flips `True` → `False`.** Previously the silent API-side default produced `true`; now `classify_error`'s conservative "unknown = permanent" verdict is persisted. This is the definition's adopted default (F8): it aligns the persisted record with the worker's actual ACK/NACK behavior (permanent errors are acked and will not redeliver). Manual reprocess via `POST /process` is unaffected (`failed → queued` is an allowed transition).
- **Transient-classified errors persist `retryable: true`** — matching Pub/Sub redelivery semantics.
- **Legacy `error` key retained** in the payload alongside `error_message` (definition F11 hedge for unknown consumers of the status topic and existing log tooling). Dropping it later is trivial cleanup after a consumer audit.
- **No `error_code` is sent**; the summary `error.code` remains `"UNKNOWN"` (definition prefer_not on a taxonomy).
- **Stale-lease sweep untouched:** its direct Firestore write already persists `error` / `error_stage: "processing"` / `retryable: True`; a dead worker remains transient-by-nature.
- **ACK/NACK, leases, heartbeats untouched** — only the *reporting* of retryability changes.

## 5. Non-goals (from the definition)

- Changing the stale-lease sweep's direct failure write.
- Changing retry/backoff mechanics (Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals).
- Frontend or mobile changes (`ResourceResponse` already exposes `error` / `error_stage`).
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this payload alignment (content unavailable here; deferred), and reconciling with the D4 note in `plans/upload-flow.md` (file not present in the tree).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained; residual risk accepted as low per definition |
| Stage-tracker drift as the pipeline evolves | "Set immediately before the await" convention comment; contract test pins representative early/late stages |
| `retryable=false` for genuinely-transient-but-unrecognized failures reduces auto-retry affordances | Accepted per definition; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key means touching the test |
| Code motion of `classify_error` breaks an unknown importer | Re-export from `main` preserves `main.classify_error`; grep step + full worker unit suite run |
| Contract-test mock fragility (`firestore.transactional` patch) | Contained to the test; follows the existing fake-based house pattern |

## 7. Implementation steps (ordered)

1. **Read** `apps/ai-server/rag-worker-service/exceptions.py`. If it already defines equivalent exception classes / classification logic, consolidate there instead of creating a new module (keeping the names importable from `main`); otherwise proceed with `failure_payload.py` as designed in §3.1.
2. **Grep** `apps/ai-server/` for `classify_error|TransientError|PermanentError|ProcessingError` importers (workers/, subscribers/, examples/, algorithms/, utils/). Update them to import from the new module, or rely on the `main` re-export where they import from `main`.
3. **Create** `failure_payload.py`: move the four definitions verbatim; add `UNKNOWN_STAGE` and `build_failure_payload` (§3.1).
4. **Edit** `main.py`: re-export import (§3.2); add the stage tracker with the exact assignment points in §3.3 and the convention comment; rewrite the failure handler per §3.4.
5. **Add worker unit tests** (test-plan §2): `tests/unit/test_failure_payload.py`, `tests/unit/test_process_document_stage_tracking.py`.
6. **Add the cross-service contract test** (test-plan §3): `apps/ai-server/tests/integration/test_worker_failure_contract.py` + one `sys.path` line in that directory's `conftest.py`.
7. **Run** all suites (test-plan §4) and map results to the acceptance criteria (§8).
8. **Optional manual check** on the hermetic stack (test-plan §4).

## 8. Acceptance criteria mapping

| Acceptance criterion (definition) | Where satisfied |
|---|---|
| AC1 — failed status payload contains `error_message`, `stage`, `retryable`, none relying on API fallbacks | `build_failure_payload` (§3.1) + handler rewrite (§3.4); pinned by worker unit tests and contract test key-set assertion |
| AC2 — persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = worker-derived value | Existing rag-api failed branch consuming the new payload; proven by contract test dynamic assertions |
| AC3 — processing/summary error subdocument carries same message and stage | Existing rag-api summary failed branch; asserted in contract test |
| AC4 — contract test covering worker failure → rag-api persistence exists, passes, fails on key drift on either side | New `test_worker_failure_contract.py`: real payload → real `run_transactional_update` → persisted-value equality + exact key set (worker side) + AST read-key guard (rag-api side) |

## 9. Verification & rollout

- No environment variables, config, infra, or Firestore schema changes. No migration or backfill.
- Only `rag-worker-service` ships behavior changes; `rag-api-service` is untouched (redeploy unnecessary, harmless if it happens).
- Verification = the three test layers in `docs/test-plan.md` (worker unit, cross-service contract, regression suites) plus the optional manual hermetic-stack check.

## 10. Open items / implementation-time checks

- Contents of `rag-worker-service/exceptions.py` (unverified in this pass) — decides new module vs. consolidation (step 1).
- Any in-repo importer of the moved names beyond `main.py` itself (step 2 grep).
- Confirmed from the read: the only Pub/Sub `"failed"` publisher in the worker is `process_document`'s exception handler; the sweep writes Firestore directly. No other worker publish site needs the new payload.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker → rag-api failure payload contract

**Scope:** verifies the fix planned in `docs/plan.md` against the acceptance criteria of definition `definition:obj-108`. Guiding rule (house pattern from `rag-api-service/tests/unit/test_service_contracts.py`): assert **real** code against minimal fakes; never restate the contract in a fixture; never mock the method under test.

---

## 1. Strategy — three layers

1. **Worker unit tests** (worker venv, full deps installed): the payload-builder matrix, and the stage tracker exercised through the real `process_document` exception handler.
2. **Cross-service contract test** (hermetic, in the existing cross-service test home): the real worker payload builder → the real rag-api `run_transactional_update` failed branch → captured persistence, plus key-set drift guards on both sides.
3. **Regression + optional manual hermetic check.**

Division of labor (stated explicitly so the seam is honest): the contract test exercises the worker's **failure-payload construction** (`build_failure_payload`) and rag-api's **failed-branch persistence**; the worker unit tests exercise the **handler wiring and stage tracker** through `process_document` (which cannot run in the cross-service process). The exact-key-set assertion appears in both layers, so the two halves cannot drift apart independently.

## 2. Layer 1 — worker unit tests

Location: `apps/ai-server/rag-worker-service/tests/unit/` (pytest.ini: `asyncio_mode = auto`).

### 2.1 `tests/unit/test_failure_payload.py`

Covers `build_failure_payload`, plus a regression matrix on `classify_error` guarding the code motion out of `main.py`.

| Exception constructed | `stage` arg | expected `error_message` | expected `stage` | expected `retryable` |
|---|---|---|---|---|
| `TransientError("upstream 503")` | `"text_retrieved"` | `"upstream 503"` | `"text_retrieved"` | `True` |
| `PermanentError("unsupported document layout")` | `"tagging_complete"` | same | `"tagging_complete"` | `False` |
| `httpx.ConnectError("connection reset by peer")` | `"text_retrieved"` | same | `"text_retrieved"` | `True` |
| `httpx.ReadTimeout("timed out")` | `"embeddings_complete"` | same | `"embeddings_complete"` | `True` |
| `httpx.HTTPStatusError` w/ 500 response | any | same | as passed | `True` |
| `httpx.HTTPStatusError` w/ 404 response | any | same | as passed | `False` |
| `ValueError("PDF extraction resulted in empty text")` (unknown type) | any | same | as passed | **`False`** — pins the deliberate behavior change |
| any | `None` | same | `"processing"` | derived |
| any | `""` | same | `"processing"` | derived |

Additional assertions:

- **Exact key set (worker-side drift guard):** `set(payload) == {"error_message", "stage", "retryable", "error"}` — any added/removed key fails the build.
- `payload["error"] == payload["error_message"]` (legacy hedge is a true duplicate).
- `payload["retryable"]` is a real `bool` (not a truthy sentinel).
- `classify_error` regression: same transient/permanent/unknown matrix called directly.

### 2.2 `tests/unit/test_process_document_stage_tracking.py`

**Technique:** construct the processor without `__init__` and stub collaborators as instance attributes (instance attributes also bypass class-level `@retry` decorators — intended; retry mechanics are out of scope):

```python
processor = EnhancedDocumentProcessor.__new__(EnhancedDocumentProcessor)
processor.langfuse = None
processor.logger = MagicMock()
processor.db = MagicMock()
processor.embedding_cost_per_token = 0.0
processor._publish_status_update = AsyncMock()            # captures all publishes
processor._validate_processing_request = AsyncMock()
processor._get_extracted_text = AsyncMock(return_value=("text", {"title": "t"}))
processor.content_tagger = MagicMock(generate_tags=AsyncMock(return_value=([], {})))
processor.generate_document_summary = AsyncMock(return_value={"overview": "o", "bulletPoints": []})
processor._get_document_path = MagicMock(return_value="users/u/resources/r")
processor._create_enhanced_chunks = AsyncMock(return_value=[])
processor._generate_embeddings_with_openrouter = AsyncMock(return_value=[])
processor.delete_old_vectors_via_service = AsyncMock(return_value=0)
processor.store_chunks_via_service = AsyncMock(return_value={"successful_inserts": 0, "failed_inserts": 0})
processor._save_processing_metadata_to_subcollection = AsyncMock()
processor._update_user_usage = AsyncMock()
processor._generate_resource_map = AsyncMock()
```

Drive `await processor.process_document("u", "c", "r", "job-1")`; inspect `processor._publish_status_update.await_args_list` for the call with `status == "failed"` and read its `details`.

Cases:

1. **Early-stage failure:** `_get_extracted_text` raises `ValueError("PDF extraction resulted in empty text")` → failed details: `stage == "text_retrieved"`, `error_message == "PDF extraction resulted in empty text"`, `retryable is False`, `"error" in details`; `metrics.error_message` set on the returned metrics; no `"completed"` publish.
2. **Validation failure:** `_validate_processing_request` raises `PermissionError("user does not own document")` → `stage == "starting"`, `retryable is False`.
3. **Late-stage failure:** `_generate_embeddings_with_openrouter` raises `httpx.ReadTimeout("timed out")` → `stage == "embeddings_complete"`, `retryable is True`.
4. **Success path unchanged:** all stubs succeed → exactly one terminal publish with `status == "completed"` and `details["stage"] == "completed"`; no failed publish; the preceding progress publishes still use the unchanged stage names (timeline compatibility — the tracker must not leak into success payloads).
5. **Failure log fields:** the `document_processing_failed` log call receives `stage` and `retryable` kwargs (log-tooling continuity).

## 3. Layer 2 — cross-service contract test

### 3.1 Location & imports

New file: `apps/ai-server/tests/integration/test_worker_failure_contract.py` (alongside `test_api_contracts.py`).

One-line `conftest.py` addition in that directory to expose the worker's lightweight module:

```python
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "rag-worker-service")))
```

No new module mocks are required: `failure_payload.py` imports only stdlib + `httpx` (already real in this environment via rag-api). The existing `import main as rag_api_main` mechanism is untouched — worker code is imported under its own module name, so there is no `main` name collision.

### 3.2 Fakes for `run_transactional_update`

Verified detail: the failed branch writes through the **transaction** object (`transaction.update(doc_ref, main_update)`, `transaction.set(summary_ref, summary_update, merge=True)`), so the fakes capture there. The fake doc must read `status == "processing"` so `ALLOWED_TRANSITIONS` permits `processing → failed`.

```python
class FakeSnapshot:
    def __init__(self, data): self._data = data; self.exists = True
    def to_dict(self): return dict(self._data)

class FakeSummaryRef:
    def __init__(self): self.sets = []
    def set(self, data, merge=False): self.sets.append(data)

class FakeDocRef:
    def __init__(self, data):
        self.snapshot = FakeSnapshot(data); self.id = "res-fail"
        self._summary = FakeSummaryRef()
    def get(self, transaction=None): return self.snapshot
    def collection(self, name):
        assert name == "processing"
        return SimpleNamespace(document=lambda doc_id: self._summary)

class FakeTransaction:
    def __init__(self): self.updates = []; self.sets = []
    def update(self, ref, data): self.updates.append((ref, data))
    def set(self, ref, data, merge=False): self.sets.append((ref, data))

class FakeDb:
    def __init__(self): self.last_tx = None
    def transaction(self):
        self.last_tx = FakeTransaction()
        return self.last_tx
```

The `@firestore.transactional` decorator must be neutralized so the real `update_logic` body executes (rag-api's `firestore` is the conftest's stubbed module):

```python
@pytest.fixture
def real_transactional(monkeypatch):
    monkeypatch.setattr(rag_api_main.firestore, "transactional", lambda fn: fn)
```

`firestore.SERVER_TIMESTAMP` values inside captured dicts are MagicMock sentinels — assertions ignore timestamp fields. `rag_api_main.logger` (stubbed structlog) is passed through as-is.

Driver helper:

```python
def run_failed_branch(details):
    doc_ref = FakeDocRef({"status": "processing", "userId": "u1"})
    db = FakeDb()
    rag_api_main.run_transactional_update(db, doc_ref, "failed", details, rag_api_main.logger, "u1")
    return db.last_tx
```

### 3.3 Scenarios & assertions

Each dynamic test builds the payload with the **real** `failure_payload.build_failure_payload` and feeds it as `details` to the **real** `run_transactional_update`:

1. `test_transient_failure_persists_worker_values_end_to_end`
   - `build_failure_payload(httpx.ConnectError("connection reset by peer"), stage="text_retrieved")`
   - main update: `error == "connection reset by peer"`, `error_stage == "text_retrieved"`, `retryable is True`.
   - summary `error` subdoc: `message == "connection reset by peer"`, `stage == "text_retrieved"`, `code == "UNKNOWN"`.
2. `test_permanent_failure_persists_retryable_false`
   - `PermanentError("unsupported document layout")` at `"tagging_complete"` → `retryable is False` in the main update; summary consistent.
3. `test_unclassified_error_persists_retryable_false` — **pins the deliberate behavior change**
   - `RuntimeError("partial vector write: 3/5 chunks stored")` at `"embeddings_complete"` → `retryable is False` (previously the silent `True` default).
4. `test_unknown_stage_falls_back_to_processing`
   - payload built with `stage=None` → persisted `error_stage == "processing"`, summary `stage == "processing"` (never `None`).
5. `test_worker_payload_key_set_is_pinned` (worker-side drift guard)
   - `set(build_failure_payload(exc, "starting")) == {"error_message", "stage", "retryable", "error"}`.
6. `test_api_fallback_defaults_are_not_operative`
   - persisted `error != "Processing failed"`, `error_stage is not None`, and `retryable` equals the worker-derived value (explicit equality, not the API default).
7. `test_rag_api_failed_branch_reads_contract_keys` (rag-api-side drift guard, AST — house style of `test_api_contracts.py`)
   - Read `rag-api-service/main.py` source, `ast.parse`, locate the `run_transactional_update` FunctionDef, collect every string constant that is the first argument of a `details.get(...)` call; assert `{"error_message", "stage", "retryable"} ⊆ collected`. Catches rename/removal of the read keys while tolerating unrelated reads (`error_code`, `progress`, `jobId`).
8. `test_non_processing_doc_persists_nothing` (supporting)
   - Fake doc with `status == "completed"` → `failed` is not an allowed transition → `last_tx.updates == []` (transition gate intact).

### 3.4 Why fakes, not the Firestore emulator

The definition allows either. The shared conftest stubs `firebase_admin` / `google.cloud.*` globally in `sys.modules`, which precludes constructing a real emulator client in this process; the fakes keep the test hermetic and fast and follow the `test_service_contracts.py` precedent. An emulator-based variant would need a separate conftest strategy and is **not required** for acceptance.

## 4. Layer 3 — regression & manual verification

Run, in order:

```bash
cd apps/ai-server/rag-worker-service && pytest          # code motion + new unit tests; whole suite must stay green
cd apps/ai-server/rag-api-service && pytest             # untouched code — must stay green
cd apps/ai-server/tests/integration && pytest           # contract suite incl. new file; test_api_contracts.py unaffected
```

Optional manual hermetic-stack check (docker-compose, emulator profile): force a failure (e.g., a resource with neither `extractedText` nor a storage URL → `ValueError` at validation), then inspect Firestore: main doc `error` = the actual message, `error_stage` = `"starting"`, `retryable` = `false`; `processing/summary.error` carries the same message and stage with `code = "UNKNOWN"`.

## 5. Acceptance mapping

| Acceptance criterion | Verifying tests |
|---|---|
| AC1 — payload carries `error_message` / `stage` / `retryable`, no reliance on API fallbacks | §2.1 matrix + key-set guard; §2.2 handler cases; §3.3 #5, #6 |
| AC2 — persisted `error` / `error_stage` / `retryable` equal the worker's values | §3.3 #1–#4, #6 |
| AC3 — summary error subdocument carries same message and stage | §3.3 #1–#4 |
| AC4 — contract test exists, passes, fails on key drift on either side | §3.3 #5 (worker key set) + #7 (rag-api read keys) + dynamic equality #1–#4 |

## 6. Explicitly not covered

- Stale-lease sweep behavior (already conforms; untouched per definition non-goal).
- ACK/NACK policy, lease/heartbeat mechanics, `@retry` behavior.
- Structured error-code taxonomy (`error.code` stays `"UNKNOWN"`).
- Frontend/mobile response shapes.
- An automated emulator-based full-stack test (documented as optional in §3.4).
- Performance/load characteristics of the status topic.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>