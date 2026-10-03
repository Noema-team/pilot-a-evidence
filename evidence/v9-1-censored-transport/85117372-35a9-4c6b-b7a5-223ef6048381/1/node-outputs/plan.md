<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

- Run: 85117372-35a9-4c6b-b7a5-223ef6048381 · Iteration 1 · Step: plan
- Intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- Authoritative spec: WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c…`). Everything below implements that definition; nothing widens or narrows it.
- Companion docs: `docs/test-plan.md` (test matrix, harnesses, drift-coverage table).

---

## 1. Verified problem statement (repository evidence)

All claims below were verified by reading the current tree; line numbers are approximate anchors and will drift.

| # | Verified fact | Anchor |
|---|---|---|
| V1 | Worker's `process_document` exception handler publishes `"failed"` with details `{"error": str(e)}` only. `_publish_status_update` additionally injects `jobId` into details. | `rag-worker-service/main.py`, `process_document` except handler; `_publish_status_update` |
| V2 | rag-api's `run_transactional_update` failed branch reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`; persists them as `error` / `error_stage` / `retryable` on the main doc; writes `summary.error = {"code": details.get("error_code", "UNKNOWN"), "message": …, "stage": …}` and `summary.stage = details.get("stage", "unknown")`. | `rag-api-service/main.py`, `run_transactional_update` |
| V3 | Consequence of V1+V2: every worker-originated failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (silent default), summary `code="UNKNOWN"`. | derived |
| V4 | Three other write paths already speak the persisted schema: worker's stale-lease sweep `_fail_if_still_stale` (`error`, `error_stage="processing"`, `retryable=True`), rag-api enqueue-failure rollback in `POST /process` and `POST /resources` (`error`, `error_stage="enqueue"`), and the `Resource` model / `ResourceResponse` expose `error`/`error_stage` (`retryable` defaults True on the model). | worker `main.py` (`_fail_if_still_stale`); rag-api `main.py` (`process_document_endpoint`); `rag-api-service/models/resource.py` |
| V5 | `classify_error(e)` is module-level in worker `main.py`, pure, and already drives ACK/NACK in `run_worker`: `TransientError`, httpx connect/timeout errors, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, and `HTTPStatusError` with 429/500/502/503/504 → transient (True); `PermanentError`, other 4xx, and **unknown exceptions → False (conservative permanent)**. | worker `main.py` (top-of-file definitions, `run_worker`) |
| V6 | `process_document` is one large `try` with no stage tracking; progress publishes use the vocabulary `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`. | worker `main.py`, `process_document` |
| V7 | `run_transactional_update` is a module-level function taking `(db, doc_ref, new_status, details, logger, user_id)`; `ALLOWED_TRANSITIONS` allows `processing → failed`. It touches only `firestore.transactional` and `firestore.SERVER_TIMESTAMP` from the firestore namespace (which rag-api imports as `from firebase_admin import firestore`). | rag-api `main.py` |
| V8 | Test infrastructure: `apps/ai-server/tests/integration/conftest.py` mocks `firebase_admin`, `google.cloud.*`, `google.oauth2.*`, `structlog` and puts `rag-api-service` on `sys.path`; `test_api_contracts.py` then does `import main as rag_api_main` — proving `fastapi`, `pydantic`, `pydantic_settings`, `httpx` are real in that environment. The same file establishes a subprocess+AST pattern (`_get_agent_graph_shapes`). | `tests/integration/conftest.py`, `tests/integration/test_api_contracts.py` |
| V9 | Consequence of V8: under the shared MagicMock `firestore`, `@firestore.transactional` is a MagicMock, so `run_transactional_update`'s inner logic never executes in-process — the behavioral seam test must run in a subprocess with a functional fake (see test-plan §4). | derived |
| V10 | `rag-worker-service/exceptions.py` exists; its contents were **not** verified. Worker unit tests exist under `rag-worker-service/tests/unit/` (e.g. `test_processing_lease.py`), implying worker `main.py` is importable in the worker service's own test environment. | directory listings |

## 2. Design decisions

### D1 — Worker aligns to rag-api; rag-api gets **zero code changes**
The definition constrains the fix to the worker's payload keys (`error_message` / `stage` / `retryable`) matching rag-api's existing reads and persisted schema (`error` / `error_stage` / `retryable`). Verified against V2/V4: once the worker sends the three keys, every read in the failed branch resolves to worker-provided values. No reader, model, response, or schema change; no migration, rename, or backfill (constraint `must_not` honored). The API-side `details.get("retryable", True)` fallback **remains in the code** (we do not touch rag-api's reads) but is no longer the operative mechanism for worker failures because the worker always sends `retryable` — exactly what the definition's constraint requires.

### D2 — Stage tracker in `process_document`
A local `current_stage` is introduced, initialized to `"processing"` **before** the `try` block (so the except handler can never see an unbound name), then set to `"starting"` as the first statement inside `try`, and thereafter set **immediately before each pipeline step's `await`** to that step's vocabulary name. Convention (verbatim rule for future edits): *"set `current_stage` immediately before the await it describes."*

| Pipeline step (anchor) | `current_stage` set to | When set |
|---|---|---|
| (init) | `"processing"` | before `try` — safe value when stage genuinely unknown |
| `_validate_processing_request` | `"starting"` | first statement inside `try` |
| `_get_extracted_text` | `"text_retrieved"` | immediately before its `await` |
| `content_tagger.generate_tags` | `"tagging_complete"` | immediately before its `await` |
| `generate_document_summary` (+ summary doc update) | `"summary_generated"` | immediately before its `await` |
| `_create_enhanced_chunks` | `"chunking_complete"` | immediately before its `await` |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` | immediately before its `await` |
| `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, final bookkeeping | *(unchanged)* `"embeddings_complete"` | — (post-embeddings tail keeps the last named stage) |
| except handler | reads `current_stage` | — |

Notes:
- The tracker value equals the name that step's **success publish** uses, so a failure *during* step N reports step N's vocabulary name — the true failing step. This is deliberate; do not "fix" it into last-announced semantics (that would misreport the failing step).
- `"completed"` is terminal and excluded from the failure vocabulary.
- The post-embeddings tail (old-vector deletion, vector storage, metadata save) has no vocabulary name; it keeps `"embeddings_complete"` — the last named stage. `"processing"` is reserved for genuinely-unknown, per the definition. This is the one judgment call in the mapping; test A11 pins it so it stays a visible, single-place decision.
- Known drift risk (a new pipeline step added without updating the tracker) is mitigated by the convention above plus representative early/late-stage tests (A8–A11), not by ossifying every step in AST — per the definition's own guidance.

### D3 — Extract a lightweight, importable failure-payload module
`classify_error`, `ProcessingError`, `TransientError`, `PermanentError` move **verbatim** out of worker `main.py` into a small module, and a new pure builder is added there:

```python
# rag-worker-service/failure_payload.py   (default location; see below)
"""Worker failure-payload construction.

Lightweight on purpose: importable without the worker's heavy ML deps
(langchain/spacy/sklearn/tiktoken/langfuse/firebase) so the worker→rag-api
contract test can exercise the real builder
(apps/ai-server/tests/integration/test_worker_failure_contract.py).
Only stdlib + httpx may be imported here.
"""
import httpx
from typing import Any, Dict

class ProcessingError(Exception): ...
class TransientError(ProcessingError): ...
class PermanentError(ProcessingError): ...

def classify_error(e: Exception) -> bool:
    # moved verbatim from main.py — no behavior change
    ...

def build_failure_details(e: Exception, stage: str) -> Dict[str, Any]:
    message = str(e) or f"{type(e).__name__} (exception message empty)"
    return {
        "error_message": message,   # rag-api persists → error / summary.error.message
        "stage": stage,             # rag-api persists → error_stage / summary.stage
        "retryable": classify_error(e),  # deliberately derived, never defaulted
        # Legacy key retained (definition constraint: prefer) for unknown
        # consumers of the status topic and existing log tooling.
        # rag-api's failed branch ignores it (verified).
        "error": message,
    }
```

- **Placement rule (implementation-time decision):** `rag-worker-service/exceptions.py` exists but was not readable during planning (V10). Step 0 below reads it and greps `subscribers/`, `workers/`, `utils/`. If it already canonically defines these exception classes / classifier, host (or re-export into) the builder there instead of creating `failure_payload.py`. The binding requirements are: (a) exactly one canonical definition, (b) importable with only stdlib + httpx, (c) all previous `main.py` names keep working.
- `main.py` replaces the inline definitions with:
  `from failure_payload import ProcessingError, TransientError, PermanentError, classify_error, build_failure_details`
  — placed where the old definitions stood. Re-exporting keeps every existing reference (e.g. `run_worker`'s `classify_error`, any raiser of `TransientError`/`PermanentError` elsewhere) working without needing to enumerate them.
- **Empty-message guard (micro-decision, flagged):** `str(e)` can be empty for bare exceptions; persisting `""` would defeat the definition's "actual error message … so support can disambiguate". The builder substitutes `f"{type(e).__name__} (exception message empty)"`. Small, contained, and in the spirit of F1; strike it here if reviewers disagree.

### D4 — `retryable` derived from `classify_error`, never defaulted
`build_failure_details` sets `retryable = classify_error(e)`:

| Exception class | `classify_error` | persisted `retryable` | worker ACK/NACK today (V5) |
|---|---|---|---|
| `TransientError`, httpx connect/timeout, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, `HTTPStatusError` 429/5xx | True | `true` | NACK → Pub/Sub redelivers |
| `PermanentError`, `HTTPStatusError` other 4xx | False | `false` | ACK → manual reprocess via `POST /process` |
| **unknown (conservative default)** | False | `false` | ACK |

- **Deliberate behavior change (per definition F8):** unclassified-unknown exceptions previously persisted `retryable: true` via the silent API default; they now persist `false`, aligning the record with the worker's actual ACK behavior. Test A3/B1-scenario-1 pins this so it cannot regress silently.
- The stale-lease sweep's direct write (`retryable=True`) is untouched and stays correct: a dead worker is a transient condition (definition non-goal).

### D5 — Legacy `error` key retained (compatibility hedge)
Only rag-api's status subscriber is a verified consumer (F11). The builder emits both `error_message` and the legacy `error` (same string). rag-api ignores the extra key (verified in V2). Dropping the duplicate later is a one-line cleanup if an audit confirms no other consumers — explicitly out of scope here.

### D6 — Failure payload stays minimal otherwise
No `progress` key (rag-api defaults summary `progress` to 0 — existing behavior, untouched), no `error_code` (summary `code` stays `"UNKNOWN"` via rag-api's default — honors the `prefer_not` constraint on a taxonomy). `jobId` injection remains `_publish_status_update`'s job (V1), unchanged.

### D7 — Test architecture (details in `docs/test-plan.md`)
- **Worker unit tests** live in `rag-worker-service/tests/unit/` where the service's full dependency set is installed (V10) — no mock gymnastics needed to import `main.py`.
- **Cross-service behavioral contract test** lives in `apps/ai-server/tests/integration/test_worker_failure_contract.py` and runs the rag-api persistence leg in a **subprocess** with a functional fake for `firebase_admin.firestore` (only `transactional` + `SERVER_TIMESTAMP` are needed, V7) — because the shared in-process MagicMock firestore neutralizes `@firestore.transactional` (V9). The subprocess pattern has house precedent (`_get_agent_graph_shapes`).
- **AST drift guards** (source-only, no imports needed) pin (a) the worker's except handler routing through `build_failure_details`, and (b) rag-api's failed branch still reading the three keys.

## 3. Changes by file

### 3.1 `rag-worker-service/failure_payload.py` (new, or consolidated into `exceptions.py` — see D3)
- `ProcessingError` / `TransientError` / `PermanentError` moved verbatim.
- `classify_error` moved verbatim.
- New `build_failure_details(e, stage)` per D3/D4/D5/D6.
- Import restriction: stdlib + `httpx` only (enforced by test B5's blocked-import check).

### 3.2 `rag-worker-service/main.py`
1. Delete the inline exception-class + `classify_error` block; insert the re-export import from `failure_payload` at the same location.
2. In `process_document`:
   - `current_stage = "processing"` immediately before `try:` (next to `metrics = ProcessingMetrics(...)` / `trace = ...`).
   - `current_stage = "starting"` as first statement inside `try` (before `_validate_processing_request`).
   - Insert the per-step assignments from the D2 table immediately before each awaited step.
3. Rewire the except handler (only the publish-details argument changes):

```python
        except Exception as e:
            metrics.error_message, metrics.end_time = str(e), time.time()
            self.logger.error("document_processing_failed", user_id=user_id,
                              course_id=course_id, resource_id=resource_id, error=str(e))
            await self._publish_status_update(
                user_id, course_id, resource_id,
                "failed",
                build_failure_details(e, current_stage),
                job_id,
            )
            if trace: trace.update(output={"success": False, "error": str(e)})
            return metrics
```

4. **Untouched:** `_publish_status_update` (generic; jobId injection, sequence, lease renewal), `run_worker` ACK/NACK, `_heartbeat_loop`, `_stale_lease_sweep_loop` / `_fail_if_still_stale`, `regenerate_map_only`, all config/env/Dockerfile/requirements.

### 3.3 `rag-api-service/*` — **no changes**
Verification checklist (all verified, V2/V4/V7):
- Failed branch reads exactly `error_message`, `stage`, `retryable` (+ optional `error_code`) → matches builder output; the extra legacy `error` details key is ignored.
- `ALLOWED_TRANSITIONS` already permits `processing → failed`.
- `summary.stage` fallback `"unknown"` can no longer fire for worker failures (stage always sent).
- Persisted field names `error` / `error_stage` / `retryable` unchanged → `Resource` model, `ResourceResponse`, mobile contract tests, and both enqueue-failure paths unaffected.
- No Firestore migration/backfill (constraint honored).

## 4. Implementation steps (ordered)

| Step | Action | Done when |
|---|---|---|
| 0 | Recon: read `rag-worker-service/exceptions.py`; grep worker service (`subscribers/`, `workers/`, `utils/`, `examples/`) and repo for other publishers/consumers of the status topic and for importers of `classify_error`/exception classes from `main`; discover how `tests/integration` and the two service suites are invoked (`.github/`, `scripts/`, per-service `pytest.ini`). **Report-only** — findings adjust D3 placement at most; no scope expansion. | Placement decision locked; no unknown importer broken by the move |
| 1 | Create `failure_payload.py` (or consolidate into `exceptions.py`): move classes + `classify_error` verbatim; add `build_failure_details`. | Module imports with only stdlib+httpx; `main.py` still passes its own suite |
| 2 | Rewire `main.py`: re-export import; stage tracker per D2; except handler per 3.2.3. | `python -m compileall` / import clean; grep shows no remaining inline definitions |
| 3 | Worker unit tests A1–A11 (`docs/test-plan.md` §3.A). | All pass in `rag-worker-service/tests/unit/` |
| 4 | Integration contract test B1–B5 + AST guards (`docs/test-plan.md` §3.B). | All pass; drift guards demonstrably fail on a seeded mutation (see §5 of test-plan) |
| 5 | Full regression: worker unit suite, rag-api unit suite, `apps/ai-server/tests/integration` (existing files unaffected — no rag-api changes). Wire the new integration file into whatever CI invocation Step 0 discovered, if suites are enumerated. | Suites green; new file collected |
| 6 | Optional: grep `apps/ai-server/docs/` for failure-payload documentation and update if referenced; optional hermetic-stack smoke (force a failure, inspect persisted doc) if the emulator stack is runnable. | Optional; skip without ceremony if not applicable |

## 5. Acceptance criteria mapping

| Acceptance (definition) | Satisfied by | Pinned by |
|---|---|---|
| AC1 — failed payload contains `error_message`/`stage`/`retryable`, none relying on API fallbacks | Steps 1–2 (builder always sets all three; tracker guarantees non-empty stage) | A1–A7, B1 |
| AC2 — persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = derived value | Step 2 + rag-api unchanged reads (D1) | B1, A8–A11 |
| AC3 — processing/summary error subdocument carries same message and stage | rag-api existing behavior (V2), now fed real values | B1 summary assertions |
| AC4 — contract test exists, passes, fails on key drift on either side | Step 4 | B1 (behavioral seam), B2/B3 (AST guards), A6 (key-set pin) |

## 6. Risks & tradeoffs

- **Unknown consumers of the status topic** — mitigated by retaining legacy `error` (D5); residual risk accepted low per definition. Step 0 grep is due-diligence, not a change driver.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the set-before-await convention and representative-stage tests (A8–A11); deliberately not AST-ossified per step.
- **`retryable=false` for unclassified-unknown** may reduce auto-retry affordances for genuinely-transient-but-unrecognized failures — accepted per F8; widening `classify_error` is out of scope; manual reprocess via `POST /process` unaffected.
- **Contract test ossifies the payload** — intentional (drift guard); adding a key means touching A6/B1, which is the point.
- **Subprocess harness fragility** (V9) — the fake only needs `transactional` + `SERVER_TIMESTAMP` (V7), keeping the surface tiny; an emulator-based variant (B4) is the escalation path if the fake ever diverges from real transaction semantics. Scope note: the test targets the *branch contract*, not Firestore transaction mechanics.
- **`tenacity`/heavy-dep availability in the integration env** — irrelevant by construction: worker behavioral tests run in the worker service's own env; only the lightweight `failure_payload` module is imported in the integration env.
- **Empty-message guard (D3)** — tiny deliberate addition beyond the literal definition text; flagged for reviewer sign-off.

## 7. Out of scope / deferred (restated from the definition)

- Stale-lease sweep behavior; Pub/Sub ACK/NACK policy, leases, heartbeats (only *reporting* of retryability changes).
- Frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`; it does not expose `retryable` — unchanged).
- Structured error codes / failure taxonomy (`summary.error.code` stays `"UNKNOWN"`).
- Companion D3 issue content (unavailable here) and reconciling with `plans/upload-flow.md` D4 (file not present in tree).
- Removing the legacy `error` key (future cleanup after a consumer audit).

## 8. Unknowns carried into implementation (do not invent — verify in Step 0)

- Contents of `rag-worker-service/exceptions.py` (V10) — decides D3 placement.
- Contents of `rag-worker-service/subscribers/`, `utils/`, `algorithms/`, `examples/` — grep only.
- How CI invokes the three test suites; whether the hermetic emulator stack is runnable for optional B4.
- `rag-worker-service/tests/conftest.py` contents — follow its env-setup pattern (precedent: `test_processing_lease.py` imports `main`).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker failure payload → rag-api persistence contract

- Run: 85117372-35a9-4c6b-b7a5-223ef6048381 · Iteration 1 · Step: plan
- Implements acceptance AC4 of `wi-define-108-a8` and pins AC1–AC3; companion to `docs/plan.md` (D3, D7).

---

## 1. Testable properties

| ID | Property (from the definition) |
|---|---|
| P1 | Worker failure payload contains exactly `error_message` (actual message), `stage` (tracker value), `retryable` (derived), plus legacy `error` — the key set is pinned. |
| P2 | `retryable` == `classify_error(e)`: transient→true; permanent and **unclassified-unknown→false** (deliberate behavior change, pinned). |
| P3 | Stage tracker reports the true failing stage: early-stage failure, late-stage failure, pre-first-step failure (`starting`), post-embeddings tail (`embeddings_complete`). |
| P4 | End-to-end seam: builder output fed through rag-api's `run_transactional_update` failed branch persists `error`/`error_stage`/`retryable` equal to the worker's values on the main doc, and the same message+stage in `processing/summary` (`error.code` stays `"UNKNOWN"`). |
| P5 | Drift guards: worker handler cannot bypass the builder; rag-api's failed branch cannot stop reading the three keys; `failure_payload` stays lightweight-importable. |

## 2. Environments & verified harness constraints

- **Worker unit env** — `rag-worker-service/tests/unit/` runs with the service's full deps installed; `test_processing_lease.py` is precedent for importing worker `main.py` there. Follow `rag-worker-service/tests/conftest.py`'s env setup (contents unverified — check at implementation; worker `main.py` requires `GCP_PROJECT` and `GOOGLE_APPLICATION_CREDENTIALS` at import).
- **Integration env** — `apps/ai-server/tests/integration/conftest.py` mocks `firebase_admin`, `google.cloud.*`, `google.oauth2.*`, `structlog` (MagicMock) and puts `rag-api-service` on `sys.path`; `test_api_contracts.py` imports `import main as rag_api_main` successfully → `fastapi`, `pydantic`, `pydantic_settings`, `httpx` are real there.
- **Critical consequence:** under the shared MagicMock `firestore`, `@firestore.transactional` is a MagicMock and `run_transactional_update`'s inner logic never executes in-process. Therefore the behavioral seam test (B1) runs in a **subprocess** with a functional fake for `firebase_admin.firestore` (rag-api imports `from firebase_admin import firestore`; the failed branch touches only `firestore.transactional` and `firestore.SERVER_TIMESTAMP`). Subprocess pattern precedent: `_get_agent_graph_shapes` in `test_api_contracts.py`.
- **Subprocess env requirements (verified):** set `GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `SHARED_INTERNAL_TOKEN` (same three the conftest sets — rag-api `main.py` instantiates `AppState(ApiConfig())` at module import, which requires them); run from a neutral CWD (no `.env` pickup); `structlog` may be MagicMock (module-level `structlog.configure(...)` and `get_logger()` tolerate it); `google.cloud`/`google.oauth2` MagicMock; `firebase_admin` replaced by the functional fake below; `httpx`/`fastapi`/`pydantic`/`pydantic_settings` real.

## 3. Test matrix

### A. Worker unit — `rag-worker-service/tests/unit/test_failure_payload.py`

**A1–A7: builder (`build_failure_details`) — pure, no processor needed**

| ID | Setup | Assert |
|---|---|---|
| A1 | `httpx.ConnectError("connection reset by peer")`, stage `"text_retrieved"` | `error_message == "connection reset by peer"`; `retryable is True`; `stage == "text_retrieved"`; `error == error_message` |
| A2 | `PermanentError("unsupported page layout")` | `retryable is False` |
| A3 | `RuntimeError("weaviate rejected chunk payload")` (unclassified-unknown) | `retryable is False` — **pins the deliberate behavior change** (was silent `true` via API default) |
| A4 | parametrize `httpx.HTTPStatusError` with `httpx.Response(500)` / `httpx.Response(429)` → True; `httpx.Response(404)` → False (construct with `request=httpx.Request("POST", "http://x")`) | classification passthrough |
| A5 | `Exception()` (empty message) | `error_message == "Exception (exception message empty)"` (non-empty; D3 guard) |
| A6 | any exception | **Key-set pin:** `set(payload.keys()) == {"error_message", "stage", "retryable", "error"}` — adding/removing a key must fail this test |
| A7 | stage `"processing"` passed in | builder returns stage unchanged (fallback is the caller's job, not the builder's) |

**A8–A11: stage tracker through the real `process_document`**

Harness recipe (no Firebase, no Pub/Sub):
- Instantiate via `EnhancedDocumentProcessor.__new__(EnhancedDocumentProcessor)` (skips `__init__`/`_init_services` entirely).
- Set attributes: `langfuse = None` (trace stays None), `db = FakeDb` (needs `document(path).get().exists` and `document(path).update(...)` for the summary-update step), `embedding_cost_per_token = 0.0`, `content_tagger = stub` with `async generate_tags(...) -> ([], {})`.
- Stub as async on the instance: `_validate_processing_request`, `_get_extracted_text`, `generate_document_summary` (return `None` → skips config-dependent branch), `_create_enhanced_chunks` (return `[]`), `_generate_embeddings_with_openrouter`, `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, `_update_user_usage`, `_generate_resource_map`, and `_publish_status_update` → capture `(status, details)` calls into a list.
- Call `await processor.process_document("u", "__ungrouped__", "r", job_id=None)` with one stubbed step raising the scenario exception; inspect the captured call with `status == "failed"`. The **real** except-handler code, real tracker, and real `build_failure_details`/`classify_error` execute end-to-end. `job_id=None` keeps assertions clean (jobId injection is `_publish_status_update`'s existing behavior, out of scope).

| ID | Raising step (exception) | Assert on captured failed details |
|---|---|---|
| A8 | `_get_extracted_text` raises `httpx.ReadTimeout("marker extraction timed out")` | `stage == "text_retrieved"`; `error_message == "marker extraction timed out"`; `retryable is True` |
| A9 | `_generate_embeddings_with_openrouter` raises `RuntimeError("embedding provider 500")` | `stage == "embeddings_complete"`; `retryable is False` (late-stage + unknown-class) |
| A10 | `_validate_processing_request` raises `PermanentError("resource deleted")` | `stage == "starting"` |
| A11 | `_generate_embeddings_with_openrouter` succeeds; `store_chunks_via_service` raises `RuntimeError("partial vector write")` | `stage == "embeddings_complete"` (pins the post-embeddings-tail decision from plan D2) |

### B. Cross-service contract — `apps/ai-server/tests/integration/test_worker_failure_contract.py`

**B1 (behavioral seam, subprocess).** One pytest test (or parametrized scenarios) launches `sys.executable -c <script>` (or a helper script file) that:

1. Sets the three env vars; installs mocks: `google`, `google.cloud`, `google.cloud.pubsub_v1`, `google.oauth2`, `google.oauth2.service_account`, `structlog` (MagicMock, mirroring the existing conftest list); replaces `firebase_admin` with a namespace whose `firestore` is the functional fake, `credentials`/`auth` stubs, `_apps = {}`.
2. Functional fake (all `run_transactional_update` needs):

```python
SERVER_TIMESTAMP = object()
def transactional(fn): return fn          # identity: body runs against our fakes
fake_firestore = types.SimpleNamespace(transactional=transactional,
                                       SERVER_TIMESTAMP=SERVER_TIMESTAMP)
```

3. `sys.path` += rag-api-service, rag-worker-service; `import main as rag_api_main`; `from failure_payload import build_failure_details`.
4. Fakes: `FakeSnapshot(exists=True, to_dict=lambda: {"status": "processing"})`; `FakeDocRef(id="res-1", get(transaction=None)→snapshot, collection("processing").document("summary")→sentinel)`; `FakeTransaction` recording `update(ref, data)` and `set(ref, data, merge=)` payloads; `FakeDb.transaction()→FakeTransaction`; capture-logger with `info/warning/error`.
5. Builds the worker payload **through the real builder**: `details = build_failure_details(exc, stage)`, then calls `rag_api_main.run_transactional_update(fake_db, doc_ref, "failed", details, capture_logger, "user-1")`.
6. Prints `json.dumps({"main": recorded_update, "summary": recorded_set})`; parent asserts.

Scenarios & assertions:

| Scenario | exception / stage | Persisted main doc (recorded `transaction.update`) | Persisted summary (recorded `transaction.set`) |
|---|---|---|---|
| S1 permanent/unknown | `RuntimeError("weaviate rejected chunk payload")` @ `"embeddings_complete"` | `status=="failed"`; `error == "weaviate rejected chunk payload"` (≠ `"Processing failed"`); `error_stage == "embeddings_complete"` (not None); `retryable is False` | `stage == "embeddings_complete"`; `error == {"code": "UNKNOWN", "message": <same as main error>, "stage": "embeddings_complete"}` |
| S2 transient | `httpx.ReadTimeout("read timed out while generating embeddings")` @ `"text_retrieved"` | `error`/`error_stage` match payload; `retryable is True` | same message+stage as main |

Notes:
- Seed status `"processing"` exercises the valid `processing → failed` transition path.
- S2's `retryable is True` is value-indistinguishable from rag-api's silent default — transmission of the key is proven by A6 (key-set pin) and B3 (read guard), not by S2's persisted value. Document this in the test's comment.
- Deliberately **not** asserted: `summary.progress` (rag-api's 0-default is incidental), `status_updated_at`/`updated_at` sentinels.
- Optional negative cases (cheap, recommended): seed status `"completed"` → invalid transition → assert **nothing** recorded; missing doc → warning, nothing recorded.

**B2 (AST guard — worker wiring, source-only, in-process).** Parse `rag-worker-service/main.py` with `ast`: locate `process_document`; inside its `ExceptHandler`, find the `_publish_status_update` call whose status argument is the literal `"failed"`; assert its details argument is a call to `build_failure_details`. Also assert a module-level `build_failure_details` def exists (in `main.py` via import/re-export or in the lightweight module — assert the handler references the name regardless of where it's defined). Catches a revert to inline `{"error": str(e)}`.

**B3 (AST guard — API reads, source-only, in-process).** Parse `rag-api-service/main.py`; extract `run_transactional_update`'s source segment (`ast.get_source_segment`); slice the `if new_status == "failed":` block(s); assert the literals `"error_message"`, `"stage"`, `"retryable"` are read from `details` in the main-update block and `"error_message"`, `"stage"` in the summary-error block. Catches rag-api drifting to different keys while values coincidentally match.

**B4 (optional, conditional).** If Step 0 of the plan confirms a runnable hermetic Firestore emulator (`FIRESTORE_EMULATOR_HOST`), an emulator-backed variant of B1 may be added (real `firebase_admin` against the emulator — both services have verified emulator branches). Not required; the fake-based B1 is the committed approach.

**B5 (lightweightness guard, in-process subprocess).** In a subprocess, install a `sys.meta_path` finder that raises `ImportError` for a blocklist (`spacy`, `sklearn`, `langchain`, `tiktoken`, `langfuse`, `openai`, `firebase_admin`, `google`, `tenacity`), then `import failure_payload` (worker service on `sys.path`). Must import cleanly — fails fast if someone adds a heavy dependency to the contract-critical module.

### C. Regression suite (must stay green)

- `rag-worker-service/tests/unit/` (existing files incl. `test_processing_lease.py`) — the classify/exception move is verbatim; re-exports keep all names.
- `rag-api-service/tests/unit/` and `tests/integration/` — **no rag-api changes**, so these are pure regression.
- `apps/ai-server/tests/integration/` existing files (`test_api_contracts.py` etc.) — unaffected; the new file must not alter shared module state (it doesn't import rag-api `main` in-process beyond what conftest already does; B1 is subprocess-isolated).

## 4. Drift-coverage table (what catches what)

| Future drift | Caught by |
|---|---|
| Worker renames/drops `error_message` or `stage` | B1 (persisted falls back to `"Processing failed"`/None ≠ actual), A6 |
| Worker drops `retryable` | A6 key-set pin (B1 transient value alone is indistinguishable from the API default — noted in-test) |
| Worker handler bypasses builder (reverts to `{"error": str(e)}`) | B2 |
| rag-api reads different keys | B1 + B3 |
| rag-api renames persisted fields | B1 + existing mobile contract tests (`test_api_contracts.py`) |
| Tracker removed/bypassed in handler | A8–A11 |
| New pipeline step added without tracker update | Not mechanically caught (per definition: convention + representative stages); mitigated by A11 tail pin and the set-before-await convention |
| `failure_payload` gains a heavy import | B5 |
| Taxonomy creep (`error_code` sent by worker) | A6 (key-set pin rejects the extra key) |

## 5. Verification of the guards themselves

Before signing off, demonstrate the drift guards work: temporarily (a) rename `error_message`→`message` in the builder → B1 fails; (b) revert the handler to inline `{"error": str(e)}` → B2 fails; (c) change rag-api's read to `details.get("message", …)` → B1/B3 fail; (d) drop `retryable` from the builder → A6 fails. Revert all mutations. (Local, pre-commit exercise; not committed as tests.)

## 6. CI / collection wiring

- Verify collection: `python -m pytest apps/ai-server/tests/integration/test_worker_failure_contract.py -q` and the worker unit suite via the service's `pytest.ini`.
- Step 0 of the plan discovers how CI enumerates suites (`.github/`, `scripts/` — unverified during planning); if suites are listed explicitly, add the new integration file.

## 7. Harness risks & mitigations

- **Identity-`transactional` fake vs real Firestore semantics** — scope is the branch contract (key reads → persisted fields), not transaction mechanics; B4 emulator variant is the escalation if this ever matters.
- **Worker `main.py` import side effects in unit env** (`os.environ["GCP_PROJECT"]`, subscriber client construction) — already survived by existing unit tests; follow the service conftest's env setup.
- **`ApiConfig` instantiation in subprocess** — proven fine by existing integration imports given the same three env vars; run from a neutral CWD to avoid `.env` pickup.
- **structlog as MagicMock in subprocess** — module-level `configure(...)`/`get_logger()` tolerate it; `run_transactional_update` receives an explicit capture logger anyway.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>