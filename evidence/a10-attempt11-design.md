Design complete. The artifact below is grounded entirely in evidence verified this session (worker `main.py`, rag-api `main.py`, `models/resource.py`, both test conftests, the existing contract-test and fake-transaction patterns, and the CI workflow).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-design-108/design.md">>>
# Design: rag-worker → rag-api failure payload contract alignment

Run: 8fa0de05-74b7-442c-bebe-b6f77b3ba305 · Iteration 1 · Step: design
Authority: WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c…`). All requirements below are refinements of that Definition, never departures from it.

---

## 1. Verified evidence base (this session)

Every claim below was read directly from the tree; anything not confirmed is flagged in §9.

| # | Verified fact | Evidence |
|---|---|---|
| V1 | Worker's `process_document` exception handler publishes `await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)` — one key. | `rag-worker-service/main.py` |
| V2 | `process_document` is a single large `try`; publishes progress stages in order: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`. No stage tracking exists at failure time. | same |
| V3 | `classify_error(e) -> bool`: `TransientError`/`PermanentError` isinstance checks; transient type tuple (`httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`); `httpx.HTTPStatusError` with status in (429,500,502,503,504) → True, other 4xx → False; **unknown exceptions → False (permanent)**. Used by `run_worker` for ACK/NACK. | same |
| V4 | rag-api `run_transactional_update` failed branch: `error ← details.get("error_message", "Processing failed")`, `error_stage ← details.get("stage")`, `retryable ← details.get("retryable", True)`; summary writes `stage: details.get("stage", "unknown")`, `progress: details.get("progress", 0)`, and `error: {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`. | `rag-api-service/main.py` |
| V5 | Stale-lease sweep `_fail_if_still_stale` writes `error` / `error_stage: "processing"` / `retryable: True` directly — already contract-shaped. | `rag-worker-service/main.py` |
| V6 | Enqueue-failure paths (`POST /process`, `POST /resources`) write `error` / `error_stage: "enqueue"` directly. `ResourceResponse` exposes `error` + `error_stage` (not `retryable`); the `Resource` model exposes `error`, `error_stage`, `retryable: bool = True`. | `rag-api-service/main.py`, `rag-api-service/models/resource.py` |
| V7 | Worker tests import `main` under a full stub set (`tests/conftest.py`) and test transactional write paths with `FakeTx/FakeSnap/FakeRef/FakeDb` + `monkeypatch(main.firestore, "transactional", identity)` (proven in `tests/unit/test_processing_lease.py`). | `rag-worker-service/tests/` |
| V8 | Top-level `tests/integration/conftest.py` MagicMock-stubs cloud modules, sets env, and puts rag-api on `sys.path`; `test_api_contracts.py` imports `rag_api_main` directly and also uses subprocess+AST extraction (agent-graph). Its conftest comment explicitly invites extending the mock list. Both services have `FIRESTORE_EMULATOR_HOST` branches, but the worker also has module-level import-time side effects (`os.environ["GCP_PROJECT"]`, `Credentials.from_service_account_file`, `SubscriberClient(...)`). | `tests/integration/` |
| V9 | CI: `cross-service-and-contract-tests` installs **rag-api + agent-graph requirements only** and runs an **explicit file list** (`test_search_pipeline.py test_chat_pipeline.py test_shared_algorithms_in_sync.py test_api_contracts.py`); per-service jobs install one service's requirements. **Neither CI environment has both services' real dependencies installed** — importing both `main` modules in one process is dependency-infeasible without stubs. | `.github/workflows/backend-tests.yml` |

## 2. Requirements (binding, derived from the Definition)

- **R1 (payload keys)** — On any pipeline failure the worker's failed-status `details` must contain exactly: `error_message` (actual exception message), `stage` (pipeline stage in flight), `retryable` (deliberately derived), plus the legacy `error` key retained per the compatibility hedge. Key set pinned as `{error, error_message, stage, retryable}`; adding/removing a key must require a conscious test edit.
- **R2 (stage tracking)** — `process_document` maintains a stage local, assigned immediately before each pipeline step, using only the existing progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`) with `processing` as the safe value when the in-flight work has no named stage or is genuinely unknown. The failure handler reports that local; `stage` is never `None`.
- **R3 (retryable derivation)** — `retryable = classify_error(e)` exactly: transient-classified → `True`; permanent-classified, including unclassified-unknown → `False`. The pre-existing `PDFProcessingError.retryable` attribute (`exceptions.py`) is **not** consulted — the Definition's derivation is authoritative; do not conflate the two mechanisms.
- **R4 (API unchanged)** — rag-api's failed branch, persisted field names (`error`, `error_stage`, `retryable`), schema, and all other writers (sweep, enqueue paths) are read-only context. No edits, no migration, no backfill. The API-side `.get(...)` fallbacks remain for non-worker senders but must never be operative for worker failures.
- **R5 (contract test)** — A test must drive the worker's real failure-payload construction into rag-api's real `run_transactional_update` and assert persisted `error`/`error_stage`/`retryable` equal the worker's values, plus the summary `error.message`/`error.stage`; it must fail on key drift on **either** side, and on the worker's failure site no longer using the builder (wiring drift).
- **R6 (summary consistency)** — After a worker failure, the `processing/summary` subdocument carries the same message and stage as the main document, and `error.code` stays `"UNKNOWN"` (no error codes are sent).
- **R7 (no behavior creep)** — No changes to ACK/NACK policy, leases, heartbeats, the sweep, retry/backoff, `ResourceResponse`, or the frontend.

## 3. Architecture of the change

**Files touched (complete list):**
1. `apps/ai-server/rag-worker-service/main.py` — builder + stage tracker + failure site (§3.1–3.3)
2. `apps/ai-server/tests/integration/conftest.py` — extend mock list + loader (§3.4)
3. `apps/ai-server/tests/integration/test_failure_payload_contract.py` — new contract test (§3.5)
4. `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` — new worker-side tests (§3.6)
5. `.github/workflows/backend-tests.yml` — add the new file to the cross job's pytest list (§3.7)

`rag-api-service/main.py` and `models/resource.py`: **zero edits** (R4).

### 3.1 Pure payload builder (worker, module-level)

```python
def build_failure_payload(error: Exception, stage: Optional[str]) -> Dict[str, Any]:
    """Failed-status details for the rag-status topic.

    Contract (consumed by rag-api run_transactional_update failed branch):
      error_message -> main-doc `error` + summary error.message
      stage         -> main-doc `error_stage` + summary error.stage
      retryable     -> main-doc `retryable` (deliberately derived here, never
                       silently defaulted API-side)
      error         -> legacy key retained for unknown topic consumers
    """
    message = str(error) or type(error).__name__   # never persist ""
    return {
        "error": message,           # legacy hedge (F11)
        "error_message": message,   # rag-api failed-branch read
        "stage": stage or "processing",
        "retryable": classify_error(error),
    }
```

Design notes:
- **Must stay module-level and undecorated.** Under MagicMock stubbing (V8), decorated or class-bound callables can become Mocks; a plain module function always survives import in stub environments. This is the seam the contract test exercises.
- Empty-message fallback (`str(e) or type(e).__name__`): the payload still carries the worker's actual error description; it only prevents persisting a useless `""` in place of the API fallback. If key present with `""`, `details.get` returns `""` — worse than the class name, and equally non-fallback.
- `retryable` is truthiness-boolean from `classify_error` (already `bool`). `error_code` is deliberately absent → summary `error.code` stays `"UNKNOWN"` (R6, prefer_not on taxonomy).

### 3.2 Stage tracker in `process_document`

Initialize `stage = "processing"` immediately **before** the `try` (so the handler always has a defined value), then assign per the set-before-await convention:

| Insert point (immediately before) | Assignment |
|---|---|
| first statement inside `try` (covers `_validate_processing_request` + first publish) | `stage = "starting"` |
| `_get_extracted_text(...)` | `stage = "text_retrieved"` |
| `self.content_tagger.generate_tags(...)` | `stage = "tagging_complete"` |
| `generate_document_summary(...)` (and the summary doc write) | `stage = "summary_generated"` |
| `_create_enhanced_chunks(...)` | `stage = "chunking_complete"` |
| `_generate_embeddings_with_openrouter(chunks)` | `stage = "embeddings_complete"` |
| `delete_old_vectors_via_service(...)` — start of the unnamed vector-storage tail (delete-old → store-chunks → metadata save → final publish → usage → resource map) | `stage = "processing"` |

**Decision — the tail maps to `"processing"`:** after embeddings there is no progress-vocabulary name for vector storage. Carrying `embeddings_complete` into the tail would misreport a `store_chunks_via_service` failure (a real, code-commented failure mode: the partial-write `RuntimeError`) as an embeddings failure; inventing a new name violates the closed vocabulary; `"processing"` is the defined safe/generic value and matches the sweep's `error_stage` precedent (V5). Trade-off accepted and pinned by a test case (§3.6 Case C) so the mapping is deliberate, not accidental.

### 3.3 Failure site (worker, `except` in `process_document)

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    payload = build_failure_payload(e, stage)
    self.logger.error("document_processing_failed", user_id=user_id,
                      course_id=course_id, resource_id=resource_id,
                      error=str(e), stage=payload["stage"],
                      retryable=payload["retryable"])   # extended log fields
    await self._publish_status_update(user_id, course_id, resource_id,
                                      "failed", payload, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

Unchanged by design: `_publish_status_update` swallows its own publish errors (`status_publish_failed`), so a failed publish cannot mask the original exception; the lease heartbeat and sequence reset inside it are untouched.

**Documented observation (no scope change):** `process_document` swallows pipeline exceptions and returns metrics, so `run_worker`'s ACK/NACK classification fires for exceptions outside the pipeline `try` (payload parse, claim, regenerate-map). The Definition's derivation rule (`retryable = classify_error(e)`) is implemented verbatim in the payload regardless; this note exists so reviewers don't "simplify" the builder against the wrong call path.

### 3.4 Test-environment bridge (`tests/integration/conftest.py`)

- Extend `required_mocks` with the worker-only modules so `rag-worker-service/main.py` imports hermetically in the rag-api-style environment: `langchain`, `langchain.text_splitter`, `langchain.schema`, `openai`, `langfuse`, `spacy`, `tiktoken`, `tenacity`, `google.cloud.storage`, `google.auth`, `google.auth.credentials` (existing `firebase_admin`/`google.cloud.*` mocks already cover the rest; worker's import-time side effects in V8 degrade gracefully under MagicMocks).
- Load the worker module under an alias to avoid the `main` name collision with rag-api:
  `importlib.util.spec_from_file_location("rag_worker_main", <repo>/apps/ai-server/rag-worker-service/main.py)`. Worker's own imports are absolute stubbed names, and `workers.resource_map_generator` is imported lazily, so the alias load is clean.

### 3.5 Contract test (`tests/integration/test_failure_payload_contract.py`)

**Dynamic round-trip (the core):**
1. `payload = rag_worker_main.build_failure_payload(exc, stage)` — the worker's real construction code.
2. Seed a `FakeDb`/`FakeRef`/`FakeTx` (pattern lifted from `test_processing_lease.py`) with doc state `{"status": "processing"}`; `monkeypatch(rag_api_main.firestore, "transactional", identity, raising=False)` and `SERVER_TIMESTAMP` to a sentinel.
3. `rag_api_main.run_transactional_update(db, ref, "failed", payload, logger, user_id)` — rag-api's real failed branch.
4. Assert captured main-doc update: `error == <message>`, `error_stage == <stage>`, `retryable is <derived>`; captured summary write: `stage == <stage>`, `error == {"code": "UNKNOWN", "message": <message>, "stage": <stage>}`.

Cases (representative early + late, per the Definition):
- **T1 transient / early:** `rag_worker_main.TransientError("embedding service timeout")` at `stage="text_retrieved"` → persisted `retryable=True`.
- **T2 permanent / late:** `ValueError("PDF extraction resulted in empty text")` at `stage="embeddings_complete"` → persisted `retryable=False` (documents the intended behavior change for unclassified-unknown).
- **T3 tail:** permanent error at `stage="processing"` → persisted stage `"processing"`, never `None`.

**Drift guards:**
- **Key-set pin:** `set(payload) == {"error", "error_message", "stage", "retryable"}` — any key change fails loudly.
- **Wiring pin (AST):** parse worker `main.py`, find `process_document`'s exception handler, assert the `failed` `_publish_status_update` call's `details` argument is a call to `build_failure_payload`. This closes the one hole the dynamic test can't see (worker reverting to an inline `{"error": str(e)}` while the builder still passes its own test). Pattern precedent: `_get_agent_graph_shapes` in `test_api_contracts.py`.

Fakes over the Firestore emulator: both are allowed by the Definition; fakes are chosen because they are hermetic, need no Docker in the CI job, and the exact fake-transaction pattern is already proven in-tree (V7). The `ALLOWED_TRANSITIONS` check (`processing → failed`) is exercised for real by seeding `status: "processing"`.

### 3.6 Worker-side unit tests (`rag-worker-service/tests/unit/test_failure_payload.py`)

Runs in the per-service unit job on **every** worker change (defense against §3.7's detector risk):
- **Builder table:** transient types → `True`; `HTTPStatusError` 429/5xx → `True`; `HTTPStatusError` other 4xx → `False`; unknown (`ValueError`) → `False`; empty-message exception → class-name message.
- **Stage-tracker mechanism** (fakes per V7; `FakePublisher.publish` returns a resolved `concurrent.futures.Future` for `asyncio.wrap_future`; steps monkeypatched to raise at a chosen point; assert the details captured by the fake publisher):
  - Case A (early): `_validate_processing_request` raises → details `{error_message, stage="starting", retryable=False, error}`.
  - Case B (late): `_generate_embeddings_with_openrouter` raises `httpx.ReadTimeout` → `stage="embeddings_complete"`, `retryable=True`.
  - Case C (tail): `store_chunks_via_service` raises `RuntimeError("partial vector write…")` → `stage="processing"`, `retryable=False`.
  - Case D: failed-status publish never re-raises even when the publisher raises.

### 3.7 CI wiring

Add `tests/integration/test_failure_payload_contract.py` to the explicit pytest list in the `cross-service-and-contract-tests` job (V9). **Unverified dependency:** `ci-detect-changes.sh` was not read; if a worker-only change does not set `cross=true`, the contract test would be skipped on worker-only PRs. Mitigation already in place: the worker-side unit tests (§3.6) run on every worker change via the per-service unit job. Implementation step 1 is to read the detector script and, if needed, note the gap rather than widening the workflow edit.

## 4. Deliberate behavior change (surfaced, per Definition F8)

Unclassified-unknown exceptions currently persist `retryable: true` (silent API default) and will now persist `false`, matching `classify_error`'s conservative permanent classification. Accepted: prevents blind auto-retry of unrecognized failures; manual reprocess via `POST /process` is unaffected; the sweep keeps writing `retryable: true` (a dead worker is transient by nature) and is explicitly out of scope.

## 5. Compatibility hedge

The legacy `error` key is retained in every failure payload (R1) so any unverified consumer of the status topic keeps working; cost is one redundant string per failure. Retirement after a consumer audit is trivial cleanup and is explicitly out of scope here.

## 6. Acceptance traceability

| Definition acceptance criterion | Satisfied by |
|---|---|
| A1 payload carries `error_message`/`stage`/`retryable`, no reliance on API fallbacks | §3.1–3.3; builder key-set pin + §3.6 Cases A–D |
| A2 persisted `error`/`error_stage`/`retryable` equal worker values (not `"Processing failed"`/`None`/default) | §3.5 dynamic round-trip T1–T3 through real `run_transactional_update` |
| A3 summary subdocument carries same message + stage | §3.5 summary assertions (T1–T3) |
| A4 contract test exists, passes, fails on either-side drift | §3.5 dynamic key-drift failure modes + AST wiring pin; CI wiring §3.7 |

## 7. Risks & mitigations

- **Unknown status-topic consumers** → legacy `error` key retained (residual risk accepted low, per Definition).
- **Stage-tracker drift as the pipeline evolves** → set-before-await convention documented; representative-stage tests (early/late/tail) catch tracker removal; the AST wiring pin catches bypass.
- **Both-mains import infeasibility in CI** (V9) → stub bridge §3.4; builder constrained to module-level undecorated function.
- **`main` name collision** → importlib alias load.
- **Worker-only PRs may skip the cross job** (unverified detector) → worker unit tests cover the derivation and stage mechanism on every worker change.
- **`retryable=false` for unrecognized-transient failures** → accepted per Definition; `classify_error` widening is out of scope.

## 8. Non-goals restated (enforced by review)

No rag-api edits; no schema/rename/backfill; no error-code taxonomy; no ACK/NACK, lease, heartbeat, or sweep changes; no frontend work; companion D3 issue content and the absent `plans/upload-flow.md` deferred.

## 9. Open items (explicitly unverified this session)

1. `ci-detect-changes.sh` cross-flag behavior for worker-only changes (§3.7).
2. `rag-api-service/services/*` transitive import weight (not needed under the chosen stub bridge, but relevant if anyone later tries a direct rag-api import inside the worker env).
3. Consumer audit of the status topic (deferred by the Definition's hedge).

## 10. Implementation order

1. Read `ci-detect-changes.sh`; record detector behavior (§3.7 note).
2. Worker: add `build_failure_payload`; add stage tracker; rewire failure site; extend log fields.
3. Worker unit tests (§3.6) — green locally under existing worker conftest stubs.
4. Extend top-level conftest; add contract test + AST pin; add file to CI list.
5. Full `tests/integration/` run to confirm no regression in existing contract tests from the conftest extension (added mocks must not alter rag-api behavior — additive only).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>