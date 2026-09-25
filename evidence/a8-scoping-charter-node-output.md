<<<SLE-OUTPUT>>>
### .sle/work/wi-define-108-a8/scoping.md
# Scoping — wi-define-108-a8

- **Run:** a8be7146-e066-4a42-bcf7-7db9cc6cbaef
- **Iteration:** 1 · **Step:** scoping.produce
- **Intent:** rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage
- **Authoritative definition:** WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c…`). Everything below is bounded by that definition; nothing is widened, narrowed, or reinterpreted.

---

## 1. Scope statement

One production file changes: `apps/ai-server/rag-worker-service/main.py`, and only inside `process_document` (stage tracker + failure-payload construction). `rag-api-service` changes **not at all** — its failed branch already implements the required persistence, which is precisely why aligning the worker is the correct direction. The seam is locked by one new contract test plus one minimal worker-side unit test.

## 2. Repository verification (definition claims vs current tree)

| Claim | Status | Evidence (current tree) |
|---|---|---|
| F3 | ✅ verified | `rag-worker-service/main.py`, `process_document` except handler: `await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)` |
| F4 | ✅ verified | `rag-api-service/main.py`, `run_transactional_update`: failed branch reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`; writes `error`/`error_stage`/`retryable` on main doc; summary `error = {"code": details.get("error_code", "UNKNOWN"), "message": …, "stage": …}` |
| F5 | ✅ verified | Direct consequence of F3+F4 (key mismatch → fallbacks operative) |
| F6 | ✅ verified | Worker `_fail_if_still_stale` writes `error`/`error_stage:"processing"`/`retryable:True`; rag-api `/process` and `POST /resources` enqueue-failure paths write `error`/`error_stage:"enqueue"`; `models/resource.py` `Resource` has `error`/`error_stage`/`retryable` (default `True`); `ResourceResponse` exposes `error` + `error_stage` |
| F7 | ✅ verified | `classify_error(e) -> bool` (True=transient, False=permanent; unknown → `False`); used for ACK/NACK in `run_worker` |
| F9 | ✅ verified | Progress publishes use `starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete` (+ terminal `completed`); no stage tracking in the failure handler |
| F10 | ✅ verified | `tests/integration/test_api_contracts.py` (fixture + AST patterns); both services have `FIRESTORE_EMULATOR_HOST` branches; worker `tests/unit/test_processing_lease.py` provides the FakeDb/FakeTx transaction-fake pattern |
| F12 | ✅ consistent | `plans/upload-flow.md` absent from `plans/` (listing checked); companion D3 content unavailable — deferred |

## 3. Change plan

**3.1 Worker — stage tracker (`process_document`)**

- Local `current_stage = "processing"` initialized **before** the `try` (covers the genuinely-unknown window).
- Tracker is set **immediately before each pipeline step**, using the progress-stage vocabulary. Mapping (step → tracker value = the stage that step's success announces):

| Pipeline step (immediately before) | `current_stage` |
|---|---|
| `_validate_processing_request` | `"starting"` |
| `_get_extracted_text` | `"text_retrieved"` |
| `content_tagger.generate_tags` | `"tagging_complete"` |
| `generate_document_summary` (+ doc update) | `"summary_generated"` |
| `_create_enhanced_chunks` | `"chunking_complete"` |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |
| Post-embedding tail (`delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, `_update_user_usage`, `_generate_resource_map`) | remains `"embeddings_complete"` (last named milestone; reads as "failed after embeddings completed, during the storage/persist tail"). No new stage names are invented; `"processing"` stays reserved for the pre-first-transition window, matching the sweep's `error_stage` value. |

- No helper methods are modified — the tracker is only read by the handler in `process_document`.

**3.2 Worker — failure payload (`process_document` except handler)**

Replace `{"error": str(e)}` with:

```python
failure_details = {
    "error_message": str(e),          # rag-api reads this
    "stage": current_stage,           # rag-api reads this
    "retryable": classify_error(e),   # deliberately derived, never defaulted
    "error": str(e),                  # legacy key retained (definition constraint: prefer)
}
```

- `retryable` derivation is exactly `classify_error(e)`: transient-classified (incl. `TransientError`, connection/timeout types, HTTP 429/5xx) → `True`; permanent-classified (incl. `PermanentError`, non-429 4xx, **unclassified-unknown**) → `False`. This is the F8 adopted default; the deliberate behavior change (unknown errors now persist `retryable: false` instead of the silent `True`) is in scope and intended.
- No `error_code` key is sent → summary `error.code` stays `"UNKNOWN"` (constraint: prefer_not structured taxonomy).
- `_publish_status_update`, `metrics.error_message`, trace update, and return value are unchanged.

**3.3 rag-api — no change (verified)**

`run_transactional_update` already persists `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`, and mirrors message/stage into `processing/summary.error`. Requirement 3 is satisfied by existing code once the worker sends the right keys. Constraint "must_not change rag-api's reads or persisted schema" is met trivially. The stale-lease sweep is untouched (nonGoal).

**3.4 Contract test — NEW `apps/ai-server/tests/integration/test_worker_failure_contract.py`**

Follows the house pattern of `test_api_contracts.py` / `test_processing_lease.py`. Design decisions:

- **Import strategy:** the integration `conftest.py` already mocks cloud modules and exposes rag-api as `main`. The worker's `main.py` must be loaded under a **distinct module name** via `importlib.util.spec_from_file_location("rag_worker_main", …/rag-worker-service/main.py)` (both services name their entry module `main` — collision otherwise). Worker-only third parties (langchain, openai, langfuse, spacy, sklearn, tiktoken, tenacity) get guarded stubs (try real import, else stub), mirroring `rag-worker-service/tests/conftest.py`.
- **Worker side:** build a real `EnhancedDocumentProcessor` via `__new__` (skip `_init_services`), attach stub pipeline steps, and monkeypatch `_publish_status_update` with an async capture stub — this exercises the **real** failure-payload construction in `process_document`'s exception handler. Trigger an **early-stage failure** (`_get_extracted_text` raises) and a **late-stage failure** (`_generate_embeddings_with_openrouter` raises).
- **API side:** feed the captured failure `details` through the **real** `run_transactional_update` against the FakeDb/FakeTx fakes (pattern from `test_processing_lease.py`), with `firestore.transactional` monkeypatched to a passthrough and `firestore.SERVER_TIMESTAMP` stubbed. Fake doc state must be `{"status": "processing"}` (the only status from which `failed` is an allowed transition).
- **Persistence fakes, not the emulator:** fakes are hermetic and match the established pattern; the emulator branch exists but is unnecessary for this test (definition allows either).
- **Assertions:**
  1. Captured failure payload key set is exactly `{"error_message", "stage", "retryable", "error"}` (worker-side drift pin; `jobId` not present at construction).
  2. Persisted main doc: `error == worker's actual message` (a distinctive string, ≠ `"Processing failed"`), `error_stage == worker's stage`, `retryable == worker's derived value` — value round-trip is the primary drift guard for **both** sides (a key rename on either side makes fallbacks operative and breaks equality).
  3. `processing/summary` write (filtered by path suffix in `FakeTx.writes`): `error.message == same message`, `error.stage == same stage`, `error.code == "UNKNOWN"`.
  4. Derivation cases: transient (`httpx.ConnectError`) → `True`; unknown (`RuntimeError`) → `False`; stage reported = tracker value at raise point (`"text_retrieved"` early, `"embeddings_complete"` late).
  5. AST guard on `rag-api-service/main.py`: within `run_transactional_update`, `details.get(...)` calls include `error_message`, `stage`, `retryable` (source-level pin so deleting the reads fails even if fakes would mask it). Positive-only; the legacy `error` key's absence is not pinned.

**3.5 Worker unit test — NEW `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` (supporting, minimal)**

Pins the two new behaviors in the suite that owns `main.py` (worker pytest run is independent of the ai-server integration run): derivation mapping (`TransientError`/`PermanentError`/connection-type/unknown → expected `retryable`), stage reporting for an early failure and the pre-tracker `"processing"` value, and the payload key-set pin. Same stub-processor technique as 3.4; ~5 focused cases, no more.

## 4. Files touched

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Stage tracker + failure payload in `process_document` (only production change) |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | New contract test |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | New minimal unit test (supporting) |

No other files. No schema/migration/backfill. No rag-api, sweep, frontend, or retry-mechanics changes.

## 5. Acceptance criteria mapping

| Definition acceptance | How met |
|---|---|
| Failed status payload carries `error_message`/`stage`/`retryable`, none relying on API fallbacks | 3.2; pinned by contract-test assertions 1 & 4 |
| Persisted doc has real `error`, non-null `error_stage`, derived `retryable` | 3.3 (existing reads) + 3.2; pinned by contract-test assertion 2 |
| `processing/summary` error subdocument carries same message/stage | Existing rag-api behavior; pinned by contract-test assertion 3 |
| Contract test covers worker failure → rag-api persistence, fails on either side's key drift | 3.4 (round-trip value assertions + payload key pin + AST guard) |

## 6. Constraints conformance

- **must** (align worker to API contract): 3.2 — worker publishes `error_message`/`stage`/`retryable`.
- **must_not** (no migration/rename/backfill): persisted field names untouched; zero rag-api changes.
- **must** (retryable explicit, API fallback not operative): 3.2 derives it from `classify_error` on every failure.
- **prefer** (retain legacy `error` key): 3.2 keeps it.
- **prefer_not** (no error-code taxonomy): no `error_code` sent; summary `code` remains `"UNKNOWN"`.

## 7. Risks & mitigations (carried from definition)

- Unknown status-topic consumers → legacy `error` key retained; residual risk accepted.
- Stage-tracker drift as the pipeline evolves → "set immediately before the await" convention documented in-code; contract test pins early+late representative stages (mechanism, not every step).
- `retryable=false` for unclassified errors → deliberate (F8); manual reprocess via `POST /process` unaffected; widening `classify_error` is out of scope.
- Combined-test import hazards (`main` name collision, worker-only deps under MagicMock conftest) → importlib distinct module name + guarded stubs (3.4); flagged as the main implementation risk for the test itself.

## 8. Out of scope (definition nonGoals, restated for the implementer)

Stale-lease sweep behavior; ACK/NACK policy, leases, heartbeats; frontend/mobile; structured error codes; anything the companion D3 issue covers beyond this payload alignment; reconciling with the absent `plans/upload-flow.md` D4 note.

## 9. Validation

- Worker unit: `cd apps/ai-server/rag-worker-service && pytest tests/unit/test_failure_payload.py` (conftest supplies env/stubs).
- Contract: `pytest apps/ai-server/tests/integration/test_worker_failure_contract.py` (integration conftest supplies mocks/env).
- Canonical gate: `./dev/run ai-server` (requires Docker Compose up, per AGENTS.md).

## 10. Deferred / open items

- Companion D3 issue content unavailable here — anything beyond this alignment is deferred (F12).
- Dropping the legacy `error` key after a consumer audit → future cleanup, explicitly not now.
<<<END-SLE-OUTPUT>>>