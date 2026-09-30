<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (definition artifact `definition:obj-108`, sha256 `71f1c39c…`). The Authoritative Definition is binding; this plan implements exactly its scope — no more, no less.

## 1. Problem (verified)

The worker's failure publisher and rag-api's failure consumer were written against different contracts:

- **Worker** (`apps/ai-server/rag-worker-service/main.py`, 2252 lines, sha256 `7d7718bc…`): the `process_document` exception handler publishes a one-key payload — `await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)`.
- **API** (`apps/ai-server/rag-api-service/main.py`, 2328 lines, sha256 `579b0bd…`): `run_transactional_update`'s failed branch reads three keys and persists them:
  - `main_update["error"] = details.get("error_message", "Processing failed")`
  - `main_update["error_stage"] = details.get("stage")`
  - `main_update["retryable"] = details.get("retryable", True)`
  - and into `processing/summary`: `stage = details.get("stage", "unknown")`, `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`.

Net effect (F5): every worker-originated failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (silent default), and the summary subdocument inherits the fallbacks with `error_code="UNKNOWN"`.

The rest of the system already speaks the persisted schema (F6, all verified):
- Worker `_fail_if_still_stale` writes `error` / `error_stage="processing"` / `retryable=True` directly.
- rag-api's enqueue-failure path in `POST /process` writes `error` / `error_stage="enqueue"` directly.
- `Resource` dataclass (`rag-api-service/models/resource.py`) exposes `error`, `error_stage`, `retryable` (default `True`); `ResourceResponse` exposes `error` and `error_stage`.

The worker's status publisher is the only writer that doesn't speak the schema. Fix the odd one out.

## 2. Direction (locked by the Definition)

The worker aligns to rag-api's existing contract: publish `error_message` / `stage` / `retryable`. No rag-api reader changes, no persisted-field rename, no migration, no backfill. The legacy `error` key is retained in the worker payload as a compatibility hedge (constraint "prefer", F11).

## 3. Design decisions

### D1 — Worker failure payload keys
New module-level pure helper in the worker:

```python
def build_failure_details(error: Exception, stage: str) -> Dict[str, Any]:
    message = str(error) or type(error).__name__
    return {
        "error_message": message,
        "stage": stage,
        "retryable": classify_error(error),
        "error": message,   # legacy key retained for unknown topic consumers (F11)
    }
```

- Exact key set: `{"error_message", "stage", "retryable", "error"}` — pinned by test (drift guard).
- No `error_code` is sent (constraint "prefer_not"); rag-api's summary `error.code` stays `"UNKNOWN"`.
- No `progress` key (current payload has none; rag-api defaults summary `progress` to 0 — unchanged behavior).
- Empty-message guard: `str(error) or type(error).__name__` keeps the persisted `error` non-empty and truthful; an empty string would disambiguate nothing and defeat the purpose of F1. This is a deliberate micro-decision, documented here.
- `_publish_status_update` injects `jobId` into details when a `job_id` is supplied (verified behavior) — the published envelope may therefore carry `jobId` in addition to the helper's keys. The key-set pin applies to the helper's output; the behavioral tests assert required keys are a subset of the published details.

### D2 — Stage tracking in `process_document`
A local `current_stage` initialized to `"processing"` (the safe value, identical to the stale-lease sweep's `error_stage`), set immediately before each pipeline await, reported by the exception handler.

Semantics (documented in code): **`error_stage` names the pipeline segment executing at failure time, using the vocabulary label of that segment** — the same label that segment's successful completion publishes in the progress timeline. Mapping, in verified code order of `process_document`:

| Tracker set before… | Value |
|---|---|
| (try entry, defensive default) | `"processing"` |
| `await self._validate_processing_request(...)` | `"starting"` |
| `await self._get_extracted_text(...)` | `"text_retrieved"` |
| `await self.content_tagger.generate_tags(...)` | `"tagging_complete"` |
| `await self.generate_document_summary(...)` (segment includes the `ragDescription` doc update) | `"summary_generated"` |
| `await self._create_enhanced_chunks(...)` | `"chunking_complete"` |
| `await self._generate_embeddings_with_openrouter(...)` | `"embeddings_complete"` — and remains through `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, and finalization (no further tracker writes; a failure there reports `"embeddings_complete"`, never `"completed"`) |

Convention against drift: *set the tracker immediately before the await*. A pipeline step added without a tracker write reports the previous segment — coarse but never null, never `"completed"` for a failure. The contract test pins the mechanism on representative stages (early and late failure), per the Definition.

### D3 — `retryable` derivation
`retryable = classify_error(e)` — the same function that drives ACK/NACK in `run_worker` (verified: transient → omitted from `ack_ids`, i.e. redelivered; permanent → acked). Verified `classify_error` semantics:
- `TransientError`, `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` → `True`
- `httpx.HTTPStatusError` with status in {429, 500, 502, 503, 504} → `True`; other 4xx → `False`
- `PermanentError` → `False`
- unknown exceptions → `False` (conservative default)

Deliberate behavior change (F8): unclassified-unknown failures persist `retryable=false` instead of the silent `true` fallback. Accepted by the Definition; manual reprocess via `POST /process` is unaffected. The stale-lease sweep's separate `retryable=true` write is untouched and stays correct (dead worker = transient condition).

### D4 — rag-api: zero code changes
`run_transactional_update` already reads and persists exactly what the Definition requires once the worker sends the right keys. The API side is pinned by the new contract test only. This satisfies the "must not change rag-api's reads or persisted schema" constraint trivially and safely.

### D5 — Exception handler rewiring (worker)
```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    failure_details = build_failure_details(e, current_stage)
    self.logger.error("document_processing_failed", ..., error=str(e),
                      stage=current_stage, retryable=failure_details["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```
`metrics.error_message`, trace output, and return value keep their existing shapes. `_publish_status_update`, `run_worker`, heartbeat, and the sweep are untouched.

## 4. Implementation steps

### Step 1 — Worker: payload helper + stage tracker (`rag-worker-service/main.py`)
1. Add `build_failure_details(error, stage)` near `classify_error` (module level, pure, no I/O).
2. In `process_document`: add `current_stage = "processing"` as the first statement of the `try`; insert the seven tracker assignments per the D2 table; rewire the `except` block per D5.
3. Add a short comment block documenting the tracker convention ("set immediately before the await") and the segment-label semantics, so future pipeline steps extend it correctly.
4. No changes to `_publish_status_update`, `run_worker`, `_heartbeat_loop`, `_fail_if_still_stale`, `_stale_lease_sweep_loop`, `ProcessingConfig`, or any env var.

### Step 2 — Worker unit tests (`rag-worker-service/tests/unit/test_failure_payload.py`, new)
Follows the existing worker test pattern (`sys.path.insert` + `import main`; the service `tests/conftest.py` stub table — verified — makes `import main` hermetic). Tests specified in `docs/test-plan.md` (W1–W8).

### Step 3 — Integration harness extensions (`tests/integration/conftest.py`)
The existing conftest (verified) sets env defaults, MagicMock's `firebase_admin`/`google.cloud.*`/`structlog`, and puts `rag-api-service` on `sys.path` so `import main as rag_api_main` works (the pattern `test_api_contracts.py` uses). Extend it to also load the worker:
1. Register the worker-specific stub modules (dotted-path explicit, mirroring the verified table in `rag-worker-service/tests/conftest.py`): `langchain`, `langchain.text_splitter`, `langchain.schema`, `openai`, `langfuse`, `spacy`, `tiktoken`, `tenacity` (identity-retry: `retry` → `lambda *a, **kw: (lambda f: f)` — a MagicMock `retry` would silently replace decorated methods), and an explicit `google.cloud.firestore_v1.base_query` stub exposing `FieldFilter`. Install only names not already provided by `required_mocks`.
2. `sklearn.feature_extraction.text` (`TfidfVectorizer` is a module-level import in worker main) is **not** currently provided by either stub table — at implementation time, prefer the real package if installed in the integration env; otherwise add a minimal stub (`TfidfVectorizer` attribute). Verify by importing worker main once in the harness.
3. Load the worker under a distinct module name to avoid collision with rag-api's `main` already in `sys.modules`:
   `importlib.util.spec_from_file_location("rag_worker_main", <rag-worker-service>/main.py)`, register in `sys.modules`, `exec_module`. Expose as a fixture. Worker main's module-level side effects (`GCP_PROJECT` from env, `PUBSUB_CREDS = service_account.Credentials.from_service_account_file(...)`, `SUBSCRIBER = pubsub_v1.SubscriberClient(...)`) are all safe under the stubs/env defaults.
4. Keep rag-api loaded exactly as today (`import main as rag_api_main`).

### Step 4 — Contract test (`tests/integration/test_worker_failure_contract.py`, new)
Exercises the real seam end-to-end with fakes (house pattern; the fake transaction infrastructure in `rag-worker-service/tests/unit/test_processing_leaase.py` — `FakeTx`/`FakeSnap`/`FakeRef`/`FakeCollection`/`FakeDb`, plus its transactional-identity handling (`_tx_identity`) — is the reference pattern):

- **Worker side**: build a processor without running `__init__` (`object.__new__(rag_worker_main.EnhancedDocumentProcessor)`), set only the attributes the failure path touches (`config` namespace with `gcp_project`/`rag_status_topic`, `db` fake whose `document(...).get()` returns `exists=False` so lease renewal is skipped, `pubsub_publisher` fake whose `publish` records the JSON envelope and returns a completed `concurrent.futures.Future` — `asyncio.wrap_future` requires a real one — `langfuse=None`), monkeypatch one pipeline method to raise, run `asyncio.run(proc.process_document(...))`, and capture the published envelope through the real `_publish_status_update` (so `jobId` injection and sequence behavior are exercised, not bypassed).
- **API side**: feed the captured `details` into `rag_api_main.run_transactional_update` against the fake db, with the doc preloaded `{"status": "processing", ...}` (transition `processing → failed` is allowed per the verified `ALLOWED_TRANSITIONS`). Patch `rag_api_main.firestore.transactional` to an identity decorator (it is a MagicMock under the conftest; unpatched, the transaction body would never execute — this patch is mandatory, not optional). `firestore.SERVER_TIMESTAMP` remains a harmless MagicMock sentinel stored by the fakes.
- Tests C1–C6 specified in `docs/test-plan.md`, including both drift guards.

### Step 5 — Verification
1. `cd apps/ai-server/rag-worker-service && python -m pytest tests/unit -q` — worker suite green, new W-tests pass.
2. `cd apps/ai-server && python -m pytest tests/integration -q` — existing contract tests still green (no rag-api model changes, so `MOBILE_RESOURCE_FIELDS` pins are unaffected), new C-tests pass.
3. `cd apps/ai-server/rag-api-service && python -m pytest tests -q` — API suite green (no API code changed; guards against accidental edits).
4. Optional manual hermetic check: run both services against Firestore/Pub/Sub emulators and force a failure. The API's `FIRESTORE_EMULATOR_HOST` branch is verified in `startup()`; the worker's emulator awareness is asserted by the Definition (F10) but only partially verified in code (the `emulator_host` log line) — see §7 Unknowns. The fake-based tests above are the primary, CI-routable verification.

### Step 6 — Release
Single change set: worker `main.py` + tests. Deploy rag-worker only; rag-api has no changes. No schema migration, no backfill, no config/env changes. After rollout, `document_processing_failed` logs carry `stage` and `retryable` for support triage.

## 5. Acceptance criteria mapping

| Acceptance (Definition) | Covered by |
|---|---|
| A1: failed status payload carries `error_message`/`stage`/`retryable`, never relying on API fallbacks | W1, W3, W4, W5, C3, C4 |
| A2: persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = derived value | C1, C2 |
| A3: `processing/summary` error subdocument carries same message and stage | C1, C2 |
| A4: contract test over worker failure → rag-api persistence exists, passes, fails on key drift on either side | C1–C6 (C4/C6 are the drift guards) |

## 6. Risks and mitigations

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error` alongside `error_message` (D1); residual risk accepted as low per the Definition.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention, the in-code comment, and representative early/late-stage tests (W4/W5, C1/C2).
- **`retryable=false` for unclassified-unknown errors** reduces auto-retry affordances for genuinely-transient-but-unrecognized failures — accepted per F8; widening `classify_error` is out of scope; manual reprocess unaffected.
- **Contract-test ossification** — intentional; adding a payload key later means touching the test, which is the drift guard working.
- **Integration-env dependency gaps** (e.g. scikit-learn for the worker's module-level import) — detected at Step 3 verification; stub fallback specified.
- **Mocked `firestore.transactional` silently no-op'ing the API transaction under test** — mitigated by the mandatory identity-decorator patch (Step 4); without it the assertions would pass vacuously, so C1/C2 also assert the transaction actually recorded writes.

## 7. Unknowns (preserved, not invented)

- Whether scikit-learn (and any other worker-only real dependency) is installed in the `tests/integration` environment — resolved during Step 3 with the specified stub fallback.
- Completeness of the worker's Firestore/Pub/Sub emulator mode: the Definition asserts it (F10); directly verified for rag-api's `startup()` branch and only the `PUBSUB_EMULATOR_HOST` log line for the worker. Emulator e2e is therefore optional/manual; fakes are the primary test route.
- The body of `_tx_identity` in `test_processing_lease.py` was not read; it is referenced as an existing identity-decorator pattern only.
- Whether any consumer besides rag-api's status subscriber parses the failure payload — unknown (F11 assumption); the legacy `error` key hedge covers it.

## 8. Out of scope (restated from the Definition)

Stale-lease sweep behavior; retry/backoff mechanics (ACK/NACK policy, leases, heartbeats — only the *reporting* of retryability changes); frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`); structured error codes / failure taxonomy (`error.code` stays `"UNKNOWN"`); anything the unavailable companion D3 issue covers beyond this payload alignment; reconciling with the absent `plans/upload-flow.md` D4 note.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker failure payload → rag-api persistence contract

Companion to `docs/plan.md`. Implements the Definition's test requirement: "A contract test must cover the worker failure → rag-api persistence path … and assert the persisted error, error_stage, and retryable equal the worker's values; it must fail if either side's payload keys drift."

## 1. Objectives

1. Prove the worker's failure payload carries `error_message`, `stage`, `retryable` (plus legacy `error`), derived deliberately — never relying on rag-api's fallbacks.
2. Prove rag-api's failed branch persists those exact values into the main document and the `processing/summary` error subdocument.
3. Pin both sides of the seam so future key drift on either side fails the build.

## 2. Test levels and locations

| Level | Location | Runs in |
|---|---|---|
| W — worker unit | `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` (new) | worker service env; existing `tests/conftest.py` stub table applies |
| C — cross-service contract | `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new) | `apps/ai-server` integration env; extended `tests/integration/conftest.py` |
| R — rag-api regression (existing) | `apps/ai-server/tests/integration/test_api_contracts.py`, `rag-api-service/tests` | unchanged; must stay green (no API code changes) |
| E — optional manual emulator e2e | not automated in this change | Firestore + Pub/Sub emulators; see plan §7 unknowns |

## 3. Test infrastructure

### 3.1 Fakes (pattern reused from `rag-worker-service/tests/unit/test_processing_lease.py`)
- `FakeTx` / `FakeSnap` / `FakeRef` / `FakeCollection` / `FakeDb`: transaction records `update`/`set` writes into an inspectable list; `get` returns current doc state. Adapted for rag-api's `run_transactional_update`, which needs `doc_ref.get(transaction=...)`, `transaction.update(doc_ref, main_update)`, `doc_ref.collection("processing").document("summary")`, `transaction.set(summary_ref, summary_update, merge=True)`.
- `FakePublisher`: `topic_path(project, topic) -> str`; `publish(topic_path, data)` decodes and records the JSON envelope, returns a **real completed `concurrent.futures.Future`** (the worker's `_publish_status_update` awaits it via `asyncio.wrap_future`, which requires a real future).
- Minimal db fake for `_publish_status_update`'s lease-renewal probe: `document(path).get()` returns an object with `exists=False` (lease write skipped — irrelevant to the contract under test).
- Processor construction: `object.__new__(rag_worker_main.EnhancedDocumentProcessor)`; set only `config` (namespace with `gcp_project`, `rag_status_topic`), `db`, `pubsub_publisher`, `langfuse=None`, plus whatever the patched pipeline methods need. No network, no Firestore, no Pub/Sub.

### 3.2 Module isolation
- rag-api: `import main as rag_api_main` (existing conftest path insert + mocks).
- worker: loaded via `importlib.util.spec_from_file_location("rag_worker_main", ...)` with explicit dotted-path stubs (langchain*, openai, langfuse, spacy, tiktoken, tenacity identity-retry, `google.cloud.firestore_v1.base_query.FieldFilter`; sklearn real-or-stub). Never imported as `main` — that name belongs to rag-api in this process.
- **Mandatory**: patch `rag_api_main.firestore.transactional` to an identity decorator before calling `run_transactional_update`. Under the integration conftest it is a MagicMock; unpatched, the transaction body never executes and assertions would pass vacuously. C1/C2 therefore also assert the fake transaction recorded writes.
- `firestore.SERVER_TIMESTAMP` remains a MagicMock sentinel; fakes store it verbatim.

### 3.3 Determinism
No sleeps, no real I/O, no emulator dependency, no time sensitivity (sequence numbers and timestamps are recorded but not asserted except structurally). Tests are plain sync pytest functions using `asyncio.run(...)` — no asyncio plugin assumption.

## 4. Test matrix

### W — worker unit (`test_failure_payload.py`)

| ID | Name | Asserts |
|---|---|---|
| W1 | `test_build_failure_details_exact_key_set` | `set(build_failure_details(exc, "starting")) == {"error_message", "stage", "retryable", "error"}` — worker-side drift guard (exact set: additions fail too) |
| W2 | `test_legacy_error_key mirrors error_message` | `details["error"] == details["error_message"]` |
| W3 | `test_retryable_derivation_matches_classify_error` | parametrized: `TransientError`→True; `httpx.ConnectError`→True; `TimeoutError`→True; `httpx.HTTPStatusError` (500 response)→True; `httpx.HTTPStatusError` (404)→False; `PermanentError`→False; `ValueError` (unclassified-unknown)→False — each equals `classify_error(exc)` and is a real `bool` |
| W4 | `test_stage_reported_early_failure` | drive `process_document` with `_validate_processing_request` patched to raise `TransientError`; captured failed-publish details have `stage == "starting"` |
| W5 | `test_stage_reported_late_failure` | patch validation to pass, `_get_extracted_text` to return `("text", {})`, `content_tagger.generate_tags` to raise `PermanentError` → `stage == "tagging_complete"`; second case: raise in `_generate_embeddings_with_openrouter` → `stage == "embeddings_complete"` |
| W6 | `test_empty_exception_message_falls_back_to_class_name` | `Exception()` → `error_message == "Exception"` |
| W7 | `test_published_envelope_shape` | captured envelope: `status == "failed"`, required keys `{"error_message","stage","retryable","error"} ⊆ details`, `jobId` present when `job_id` supplied (real `_publish_status_update` assembly exercised) |
| W8 | `test_metrics_error_message_preserved` | returned `ProcessingMetrics.error_message == str(exc)` (existing behavior intact) |

### C — cross-service contract (`test_worker_failure_contract.py`)

Fixtures: `worker_failure_payload(kind)` → drives `process_document` to failure (per §3.1) and returns the captured published `details`; `api_fake_db` → fake db with doc preloaded `{"status": "processing", "filename": "f.pdf", ...}`; helper `persist_failure(details)` → calls `rag_api_main.run_transactional_update(db, doc_ref, "failed", details, logger, user_id)` with the identity-`transactional` patch, returns the recorded writes.

| ID | Name | Asserts |
|---|---|---|
| C1 | `test_transient_failure_persists_worker_values_end_to_end` | early transient failure (`TransientError("simulated transient failure")`): main-doc write has `error == "simulated transient failure"` (exact string), `error_stage == "starting"`, `retryable is True`, `status == "failed"`; summary write has `stage == "starting"` and `error == {"code": "UNKNOWN", "message": "simulated transient failure", "stage": "starting"}`; transaction recorded both writes (anti-vacuity) |
| C2 | `test_permanent_failure_persists_worker_values_end_to_end` | late permanent failure: persisted `error`/`error_stage == "tagging_complete"`/`retryable is False` all equal the worker's payload values; summary subdocument matches |
| C3 | `test_legacy_error_key_retained_in_payload` | `"error" in details` and equals `error_message` (compatibility hedge pinned so it isn't silently dropped) |
| C4 | `test_worker_payload_key_set_pinned` | `set(build_failure_details(exc, "starting").keys()) == {"error_message","stage","retryable","error"}` via `rag_worker_main` — exact-set worker drift guard at the contract level |
| C5 | `test_values_are_not_fallback_defaults` | explicit canary: persisted `error != "Processing failed"`, `error_stage is not None`, and `retryable` is the worker's value by identity (`is True` / `is False`), not merely truthy — documents the failure mode this fix eliminates |
| C6 | `test_rag_api_failed_branch_read_keys_pinned` | AST walk over `rag-api-service/main.py` (house AST pattern from `test_api_contracts.py`): within `run_transactional_update`'s failed branch, the `details.get(...)` key literals include `error_message`, `stage`, `retryable` — API-side drift guard (renaming a read key fails the build) |

### R — regression (must remain green, no changes)
- `test_api_contracts.py`: `ResourceResponse` field pins (`error`, `error_stage`, etc.) — unaffected because rag-api models are untouched.
- `rag-worker-service/tests/unit/test_processing_lease.py` — sweep/lease behavior untouched; `_fail_if_still_stale` still writes `error`/`error_stage="processing"`/`retryable=True`.

## 5. Acceptance mapping

| Definition acceptance | Tests |
|---|---|
| A1 payload carries error_message/stage/retryable, no fallback reliance | W1, W3, W4, W5, C3, C4 |
| A2 persisted error/error_stage/retryable equal worker values | C1, C2, C5 |
| A3 summary error subdocument carries same message and stage | C1, C2 |
| A4 contract test exists, passes, fails on either side's key drift | C1–C6 (drift: W1/C4 worker-side, C6 API-side, C1/C2 behavioral) |

## 6. How to run

```bash
# Worker unit (W1–W8)
cd apps/ai-server/rag-worker-service && python -m pytest tests/unit -q

# Cross-service contract (C1–C6) + existing contract regressions
cd apps/ai-server && python -m pytest tests/integration -q

# rag-api suite (must be untouched-green)
cd apps/ai-server/rag-api-service && python -m pytest tests -q
```

Integration env needs: `pytest`, `fastapi`, `httpx`, `pydantic`, `pydantic-settings` (already required by the existing rag-api-importing tests). Worker-only heavy deps are stubbed per plan Step 3; scikit-learn real-or-stub resolved at implementation.

## 7. Intentionally not tested

- ACK/NACK redelivery mechanics, lease expiry/stealing, heartbeat intervals (non-goals — only payload reporting changes; existing lease tests already cover the sweep).
- The stale-lease sweep's failure write (already schema-correct; pinned indirectly by existing tests).
- `error_code` taxonomy (none is sent; C1/C2 pin `code == "UNKNOWN"` as the observed default, not as a taxonomy commitment).
- Emulator e2e (optional manual; worker emulator support asserted by the Definition but not fully verified in code — see plan §7).
- Log-emission assertions on `document_processing_failed` (structlog capture is brittle across the stubbed/mocked environments; the payload itself is what is contracted).

## 8. Drift-guard summary (the point of the whole plan)

- Worker adds/renames a payload key → W1 and C4 fail (exact key set).
- Worker drops a required key → C1/C2 fail (persisted value degenerates to rag-api's fallback, exact-equality asserts break).
- rag-api renames a read key → C6 fails (AST pin) and C1/C2 fail (fallback appears).
- rag-api changes persisted field names → C1/C2 fail (fake transaction records the writes it sees) and existing `ResourceResponse`/model pins fail.
- Someone deletes the stage tracker → W4/W5 and C1/C2 fail (`stage` regresses to `"processing"`/mismatch).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>