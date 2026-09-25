Investigation is complete; producing the contracted plan artifact from the verified evidence (worker `process_document`/`classify_error`/`_publish_status_update`, rag-api `run_transactional_update` failed branch, both conftest stub environments, the existing contract-test patterns in `test_api_contracts.py` and `test_processing_lease.py`, and the `Resource` model). Items I could not verify are flagged explicitly as unknowns rather than asserted.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-define-108-a8/plan.md">>>
# Plan: RAG failure payload contract alignment (rag-worker → rag-api)

WorkItem: wi-define-108-a8 (authoritative Definition artifact `definition:obj-108`, sha256 `71f1c39c…`)
Repo workflow: feature path per `AGENTS.md` — this change spans two services (rag-worker + shared
integration tests), so it does not qualify as a small change.

---

## Goal

When a RAG processing job fails, the worker's failed status payload carries `error_message` (the actual
exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately
derived from `classify_error`), so rag-api's failed branch persists the worker's real values instead of the
fallbacks `"Processing failed"` / `None` / `True`. A contract test pins the worker→rag-api failure seam so
key drift on either side fails the build.

## Verified background (the seam, from repository reads)

- **Worker publisher** (`apps/ai-server/rag-worker-service/main.py`): `process_document` is one large
  `try` block; its `except` handler does
  `metrics.error_message, metrics.end_time = str(e), time.time()` then
  `await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)`.
  `_publish_status_update` wraps `details` into `message_data` (`user_id`, `course_id`, `resource_id`,
  `status`, `details`, `timestamp`, `sequence`), injects `details["jobId"]` when a job_id exists, and
  publishes JSON to `rag_status_topic`. It catches all of its own exceptions (logs
  `status_publish_failed`).
- **Progress stage vocabulary published today**: `starting`, `text_retrieved`, `tagging_complete`,
  `summary_generated`, `chunking_complete`, `embeddings_complete`, then terminal `completed`. No stage
  state exists at failure time.
- **`classify_error(e) -> bool`** (worker, module-level): `True` = transient (`TransientError`,
  httpx connect/read/write/pool timeouts, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`,
  HTTP 429/500/502/503/504), `False` = permanent (`PermanentError`, other 4xx, and — conservatively —
  any unknown exception). `run_worker` uses this for ACK/NACK.
- **API consumer** (`apps/ai-server/rag-api-service/main.py`, module-level `run_transactional_update`):
  failed branch writes `main_update["error"] = details.get("error_message", "Processing failed")`,
  `main_update["error_stage"] = details.get("stage")`, `main_update["retryable"] = details.get("retryable", True)`,
  and `summary_update["error"] = {"code": details.get("error_code", "UNKNOWN"),
  "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}` plus
  `summary_update["stage"] = details.get("stage", "unknown")`. Transition gate: `processing → failed` is
  the only legal entry to the failed branch (`ALLOWED_TRANSITIONS`).
- **Established persisted schema** (already used by three other writers): worker stale-lease sweep
  `_fail_if_still_stale` writes `error`/`error_stage`/`retryable` directly (`retryable: True`,
  `error_stage: "processing"`); rag-api enqueue-failure paths write the same fields; `Resource`
  (`models/resource.py`) models them (`retryable: bool = True`) and `ResourceResponse` exposes
  `error`/`error_stage`.
- **Test infrastructure verified**: `apps/ai-server/tests/integration/test_api_contracts.py` imports
  rag-api's `main` under the stub environment built by `apps/ai-server/tests/integration/conftest.py`
  (MagicMocks for `firebase_admin*`, `google.cloud.*`, `google.oauth2.*`, `structlog`; env defaults for
  `GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `SHARED_INTERNAL_TOKEN`; `sys.path` gets
  rag-api-service). `apps/ai-server/rag-worker-service/tests/conftest.py` stubs the worker's heavy deps
  (langchain, openai, langfuse, spacy, tiktoken, tenacity, `google.cloud.*`, `google.auth.credentials`,
  firebase_admin) so `import main` works; `tests/unit/test_processing_lease.py` demonstrates the
  fake-Firestore pattern (FakeTx/FakeSnap/FakeRef/FakeDb + monkeypatching
  `main.firestore.transactional` to an identity and `main.firestore.SERVER_TIMESTAMP` to a sentinel)
  that makes `@firestore.transactional`-decorated nested functions run against fakes. Worker
  `pytest.ini` sets `asyncio_mode = auto`.

## Non-goals (from the Definition, binding)

- No changes to rag-api's reads, `run_transactional_update`, persisted field names, or models.
- No Firestore migration, rename, or backfill.
- No changes to the stale-lease sweep's direct failure write (already contract-conformant).
- No retry/backoff mechanics changes (ACK/NACK policy, leases, heartbeat intervals) — only the
  *reporting* of retryability changes.
- No frontend/mobile changes; no structured error-code taxonomy (`error.code` stays `"UNKNOWN"` unless
  a code is actually sent — none is).
- Anything the companion D3 issue covers beyond this payload alignment (its content is unavailable here;
  deferred per F12), and reconciling with the `plans/upload-flow.md` D4 note (file not present in tree).

## Constraints (from the Definition, binding)

- Worker aligns to rag-api: publish `error_message`/`stage`/`retryable`; do not change rag-api.
- No migration/rename/backfill; `error`/`error_stage`/`retryable` keep names and semantics.
- Every worker failure payload carries `retryable` explicitly; `details.get("retryable", True)` must not
  be the operative mechanism for worker failures.
- Retain the legacy `error` key in the worker failure payload (compat hedge, F11).
- No error-code taxonomy in this fix.

---

## Design decisions

### D1 — Worker aligns to the API; rag-api is untouched
The persisted schema is already consistent across the sweep, both enqueue-failure paths, and the models.
The worker's status publisher is the only non-conforming writer. Zero rag-api source changes in this plan.

### D2 — Stage tracker in `process_document`
A function-local `current_stage`, initialized to the safe value `"processing"` before the `try`
(the same value the stale-lease sweep uses for `error_stage`), then set immediately before each pipeline
step. Mapping (verified call sites):

| set `current_stage` to | immediately before | progress label later published after that step |
|---|---|---|
| `"starting"` | `_validate_processing_request` (first statement inside `try`) | `{"stage": "starting"}` |
| `"text_retrieved"` | `_get_extracted_text` | `{"stage": "text_retrieved", "progress": 20}` |
| `"tagging_complete"` | `self.content_tagger.generate_tags(...)` | `{"stage": "tagging_complete", ...}` |
| `"summary_generated"` | `self.generate_document_summary(...)` (also covers the `ragDescription` doc update in that step) | `{"stage": "summary_generated", ...}` |
| `"chunking_complete"` | `self._create_enhanced_chunks(...)` | `{"stage": "chunking_complete", ...}` |
| `"embeddings_complete"` | `self._generate_embeddings_with_openrouter(...)` (also covers the post-embedding tail: `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`) | `{"stage": "embeddings_complete", ...}` |

Known vocabulary limit (documented, accepted): failures in the post-embedding storage tail report
`"embeddings_complete"` — the vocabulary has no finer label; introducing one is out of scope.
The convention "set the tracker immediately before the await" is the documented drift-prevention rule;
the Phase 2 test pins the mechanism on an early and a late stage rather than every step.

### D3 — `retryable` derived from `classify_error`
In the exception handler: `retryable = classify_error(e)`. Transient → `True`; permanent/unknown →
`False`. This aligns the persisted record with the ACK/NACK decision already made by `run_worker`
(same function, same exception object). Deliberate behavior change: unclassified-unknown exceptions
flip from the silent persisted default `True` to `False` — this is `classify_error`'s designed
conservatism; manual reprocess via `POST /process` is unaffected. The sweep keeps its direct
`retryable: True` write (a dead worker is transient by nature) — untouched.

### D4 — Legacy `error` key retained
The builder emits `error` alongside `error_message` (same string) as the hedge for unknown consumers of
the status topic (F11: only rag-api's subscriber is a verified consumer). Removal later is trivial
cleanup after an audit.

### D5 — Contract test architecture: dual-import, fake Firestore, no contract restated in fixtures
- New test `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py` in the directory
  whose conftest already proves rag-api `main` imports under stubs (`test_api_contracts.py` proves this
  today).
- Worker module loaded in the same process under a unique name via `importlib.util.spec_from_file_location("rag_worker_main", .../rag-worker-service/main.py)` — required because both services have a `main.py` and the api conftest already owns the plain `main` name.
- Before loading the worker module, install the worker-only stubs not covered by the api conftest,
  mirroring the verified `rag-worker-service/tests/conftest.py` stub tables: `langchain` (+`langchain.text_splitter` re-exporting the real `RecursiveCharacterTextSplitter` when installed, else a stub, exactly as that conftest does), `langchain.schema`, `openai`, `langfuse`, `spacy`, `sklearn`/`sklearn.feature_extraction`/`sklearn.feature_extraction.text`, `tiktoken`, `tenacity`, `google.auth`/`google.auth.credentials`, and `google.cloud.firestore_v1.base_query` (a `from <MagicMock-module>.<sub> import X` fails because the mocked parent has no `__path__` — this is exactly why the worker conftest stubs that submodule explicitly). Only for names not already in `sys.modules`.
- Failure payloads are produced by driving the worker's real `process_document` on an instance built via
  `EnhancedDocumentProcessor.__new__(EnhancedDocumentProcessor)` (no `_init_services`), with
  `langfuse=None`, `openai_client=None`, a stub logger, a stub `_publish_status_update` that captures
  `(status, details)`, and instance-level async stubs for the pipeline methods (see Phase 2). The
  captured `"failed"` details are then fed as `details` into the real
  `rag_api_main.run_transactional_update` against the FakeDb shape proven in
  `test_processing_lease.py`, with `rag_api_main.firestore.transactional` monkeypatched to an identity
  and `SERVER_TIMESTAMP` to a sentinel. Assertions read the recorded transaction writes, so both sides
  are exercised through their real code paths and neither side's keys are restated in a fixture.
- All async code driven with `asyncio.run(...)` from sync tests — the integration directory has no
  verified pytest-asyncio configuration of its own, and this avoids depending on one.

---

## Phase 1 — Worker failure payload alignment (stage tracker + retryable derivation)

Status: NOT STARTED

### Scope

Files changed: `apps/ai-server/rag-worker-service/main.py` only. No rag-api changes.

1. **New module-level pure builder** in worker `main.py` (near `classify_error`):

   ```python
   def build_failure_payload(error_message: str, stage: str, retryable: bool) -> Dict[str, Any]:
       """Failed-status details for the rag-status topic, aligned with rag-api's
       run_transactional_update failed branch (error_message/stage/retryable).
       The legacy `error` key is retained for continuity with any existing
       consumers of the topic (rag-api's subscriber is the only verified one)."""
       return {
           "error": error_message,        # legacy key — compatibility hedge
           "error_message": error_message,
           "stage": stage,
           "retryable": retryable,
       }
   ```

   Returns a fresh dict (note: `_publish_status_update` mutates the details dict it is given —
   injecting `jobId` — so a fresh dict per call avoids shared-state surprises).

2. **Stage tracker in `process_document`** exactly per D2's mapping table:
   `current_stage = "processing"` as a local before the `try`; `current_stage = "starting"` as the
   first statement inside `try`; the five further assignments immediately before the corresponding
   awaits.

3. **Exception handler rewrite**:

   ```python
   except Exception as e:
       metrics.error_message, metrics.end_time = str(e), time.time()
       failure_details = build_failure_payload(str(e), current_stage, classify_error(e))
       self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                         resource_id=resource_id, error=str(e), stage=current_stage,
                         retryable=failure_details["retryable"])
       await self._publish_status_update(user_id, course_id, resource_id, "failed",
                                         failure_details, job_id)
       if trace: trace.update(output={"success": False, "error": str(e)})
       return metrics
   ```

   (The enriched log line is included: stage/retryable in structured logs is the same fact being fixed,
   at zero risk. `metrics.error_message` — the existing `ProcessingMetrics` field — is unchanged.)

4. **Worker unit tests** — new `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`
   (runs under the verified worker conftest stub env; `asyncio_mode = auto` per that service's
   `pytest.ini`):
   - `TestBuildFailurePayload`: output key set is exactly `{error, error_message, stage, retryable}`;
     `error == error_message` value; `stage`/`retryable` pass through.
   - `TestRetryableDerivation`: `classify_error` mapping pinned through the handler's expression —
     `TransientError` → True; `PermanentError` → False; `httpx.ConnectError` → True;
     `httpx.HTTPStatusError` with 500 → True and with 404 → False; `ValueError` → False; plain
     `Exception` → **False** (documents the deliberate behavior change from the silent `True` default).
   - `TestProcessDocumentStageTracker` (instance-stub technique): build the processor via
     `__new__`; set `config` (conftest env supplies the required settings), `logger`, `langfuse=None`,
     `openai_client=None`, `db` = minimal fake (`document(path).update(...)` no-op), and instance-level
     stubs shadowing `_publish_status_update` (capture), `_get_document_path`,
     `_validate_processing_request`, `_get_extracted_text`, `content_tagger.generate_tags`,
     `_create_enhanced_chunks`, `_generate_embeddings_with_openrouter`.
     - Early failure: `_validate_processing_request` raises `TransientError("validation exploded")`
       → captured failed details have `stage == "starting"`, `error_message == "validation exploded"`,
       `retryable is True`, and the legacy `error` key present.
     - Late failure: stubs succeed through chunking; `_generate_embeddings_with_openrouter` raises
       `ValueError("embedding boom")` → failed details have `stage == "embeddings_complete"`,
       `retryable is False`.

### Acceptance criteria

- Worker failed-status details contain exactly `error`, `error_message`, `stage`, `retryable`, with
  `error_message` the actual exception message, `stage` the tracker value per D2, and `retryable`
  derived from `classify_error(e)` — no fallback reliance.
- Stage tracker covers every pipeline step per the D2 table; safe default `"processing"` exists for the
  genuinely-unknown case.
- Worker unit tests listed above pass; existing worker unit suite still passes.

### Validation

```bash
cd apps/ai-server/rag-worker-service && python -m pytest tests/unit -q
```

---

## Phase 2 — Worker→rag-api failure-path contract test (the seam pin)

Status: NOT STARTED

### Scope

New file: `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py`. No other files
change in this phase.

1. **Module setup** (per D5): install worker-only stubs (union with the api conftest's, first-set-wins),
   then `import main as rag_api_main` (existing pattern), then exec the worker module as
   `rag_worker_main` via importlib.
2. **Fakes**: local copies of the FakeTx/FakeSnap/FakeRef/FakeCollection/FakeDb shape from
   `test_processing_lease.py` (with a `.id` attribute on FakeRef — `run_transactional_update` logs
   `doc_ref.id`), plus the `_tx_identity` stand-in for `firestore.transactional`.
   Monkeypatch `rag_api_main.firestore.transactional` → identity and
   `rag_api_main.firestore.SERVER_TIMESTAMP` → sentinel before each call.
3. **Contract scenarios** — for each of (early: `stage="starting"`, `TransientError` → retryable True)
   and (late: `stage="embeddings_complete"`, `ValueError` → retryable False):
   - Drive the worker's real `process_document` via the Phase-1 instance-stub technique (helper
     duplicated locally; the worker unit suite remains its primary home) and capture the `"failed"`
     details the worker actually publishes.
   - Seed the FakeDb doc with `{"status": "processing", ...}` (the only legal entry into the failed
     branch) and call `rag_api_main.run_transactional_update(db, doc_ref, "failed", details,
     rag_api_main.logger, "u1")`.
   - Assert from the recorded transaction writes:
     - main doc: `error == details["error_message"]`, `error_stage == details["stage"]`,
       `retryable == details["retryable"]`, `status == "failed"`;
     - `processing/summary` set: `error.message == details["error_message"]`,
       `error.stage == details["stage"]`, `stage == details["stage"]` (acceptance criterion 3).
   - These assertions are the drift guard: if the worker renames/drops `error_message`/`stage`/
     `retryable`, persisted values fall back and the equality asserts fail; if rag-api renames a read
     key, the same asserts fail. Either side's key drift fails the build.
4. **Explicit key-set pin on the worker payload**: assert the builder's output key set is exactly
   `{error, error_message, stage, retryable}` — removing the legacy `error` hedge or silently adding a
   key becomes a deliberate test change (intentional ossification per the Definition's analysis).
5. **API-side fallback pin (behavioral)**: run `run_transactional_update` with `details = {}` on a
   `processing` doc and assert the fallbacks (`error == "Processing failed"`, `error_stage is None`,
   `retryable is True`, summary `error.code == "UNKNOWN"`) — documents and pins what the fallback
   defaults are, so the contract scenario's non-reliance on them is meaningful.
6. **Stretch (include if cheap, drop if the fake machinery fights back):** a thin behavioral check that
   `_process_status_message` forwards `payload["details"]` verbatim into
   `run_transactional_update` (fake Pub/Sub message object, stubbed db path resolution). The core
   Definition requirement is the builder→`run_transactional_update` seam; this only covers the one-line
   pass-through between them.

### Acceptance criteria

- The contract test passes with Phase 1 merged and covers both a representative early-stage and
  late-stage failure.
- Mutation checks (performed once while authoring, not committed as tests): temporarily renaming a
  worker payload key, or an API read key, makes the contract test fail — verified manually by the
  implementer before opening the PR.

### Validation

```bash
cd apps/ai-server/tests/integration && python -m pytest test_worker_failure_payload_contract.py test_api_contracts.py -q
cd apps/ai-server/rag-worker-service && python -m pytest tests/unit -q
./dev/run ai-server   # per AGENTS.md; requires Docker Compose up
```

Manual (optional): with the hermetic compose stack up, force a worker failure (e.g. enqueue a resource
with a missing source), then inspect the Firestore resource doc and `processing/summary` to see real
message, real stage, derived retryable.

---

## Acceptance-criteria traceability (Definition → plan)

| Definition acceptance criterion | Covered by |
|---|---|
| 1. Worker failure payload has error_message/stage/retryable, no fallback reliance | Phase 1 (builder + tracker + handler); pinned by Phase 1 unit tests and Phase 2 key-set pin |
| 2. Persisted error = real message, error_stage = failing stage, retryable = derived | Phase 2 contract scenarios (main-doc asserts) |
| 3. processing/summary error subdocument carries same message and stage | Phase 2 contract scenarios (summary asserts) |
| 4. Contract test exists, passes, exercises both sides, fails on key drift | Phase 2 (dual-import behavioral test + key-set pin + fallback pin + mutation check) |

Constraint check: rag-api untouched (must ✔); no migration/rename/backfill (must_not ✔); retryable
always explicit from the worker (must ✔); legacy `error` retained (prefer ✔); no error-code taxonomy
(prefer_not ✔ — `error_code` is simply never sent).

## Risks and mitigations

- **Dual-import of two `main.py` modules in one pytest process** — main technical risk of Phase 2.
  Mitigations: importlib under a unique module name; stub-union table mirroring the two verified
  conftests; the api-side import pattern is already proven (`test_api_contracts.py`); the worker-side
  stub table is copied from the verified worker conftest. Fallback if interference proves unresolvable:
  keep the same test file but drive the worker side through a tiny in-test re-implementation *only of
  the instance-stub driver* while still importing the worker's real `build_failure_payload` and the
  api's real `run_transactional_update` — the Definition's "import both sides, don't restate the
  contract in fixtures" is preserved; the tracker's behavioral pinning remains fully covered by the
  Phase 1 unit tests, and the plan deviation is recorded below.
- **Stage-tracker drift as the pipeline evolves** — mitigated by the documented
  "set-immediately-before-the-await" convention, the early/late representative tests, and the enriched
  failure log making stale stages visible in operations.
- **retryable=False for unclassified-unknown errors** reduces auto-retry affordances — accepted per the
  Definition (F8); manual reprocess via `POST /process` remains; widening `classify_error` is out of
  scope.
- **Unknown consumers of the status topic** — mitigated by retaining the legacy `error` key; audit
  deferred (F11).
- **Contract ossification** — intentional; that is the drift guard. Adding a key means touching the
  test deliberately.

## Branch / workflow (per AGENTS.md)

- Branches: `feature/rag-failure-payload-contract` (from up-to-date `main`) hosting
  `plans/rag-failure-payload-contract.md` (this plan's content), draft PR to `main`, milestone
  `rag-failure-payload-contract`; phase branches `phase/rag-failure-payload-contract/01-worker-payload`
  and `.../02-contract-test` targeting the feature branch, one phase per PR, merge-commit merges.
- Phase 1 PR carries the worker change + worker unit tests; Phase 2 PR carries the seam contract test.
  No unrelated cleanup in either PR.

## Open questions / unverified items (flagged, not assumed)

- Whether `./dev/run ai-server`'s suite includes `apps/ai-server/tests/integration` — unverified; the
  direct `pytest` invocations above are authoritative for this plan either way.
- Whether the integration directory has its own pytest/asyncio config — unverified; mitigated by using
  `asyncio.run` from sync tests.
- Contents of the companion D3 issue (F12) and of `plans/upload-flow.md`'s D4 note — unavailable;
  deferred by the Definition.
- Any non-rag-api consumer of the status topic — none known (F11 assumption); legacy `error` key is the
  hedge; audit out of scope.

## Plan deviations

None yet. (If the Phase 2 dual-import fallback in Risks is exercised, record it here before merging
Phase 2.)

<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>