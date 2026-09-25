I've verified the authoritative definition against the current tree: the worker's failure handler (`process_document` except block → `{"error": str(e)}`), rag-api's failed branch (`error_message`/`stage`/`retryable` reads with fallbacks), the stale-lease sweep's direct `error`/`error_stage`/`retryable` write, `classify_error()`, the progress-stage vocabulary, and both test infrastructures (worker unit-test stub conftest + fake-transaction pattern in `test_processing_lease.py`; shared integration contract suite in `tests/integration/test_api_contracts.py` with its MagicMock-based conftest and subprocess+AST pattern). The plan below is grounded in those exact files.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-define-108-a8/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (authoritative definition pinned at sha256 `71f1c39c…89cac5`)
Run: `8b06a314-f151-4c92-a50a-f2fee0c84232`, iteration 1, step `plan`

---

## 1. Scope summary

A failed RAG processing job currently persists garbage: the worker publishes `{"error": str(e)}`, rag-api reads
`error_message`/`stage`/`retryable` and falls back to `"Processing failed"` / `None` / `True`. The fix aligns the
**worker** to rag-api's existing contract (no rag-api code changes, no schema change), adds stage tracking to
`process_document`, derives `retryable` deliberately from `classify_error()`, retains the legacy `error` key as a
compat hedge, and locks the seam with a contract test that drives the worker's real failure-payload construction
through rag-api's real failed-branch persistence.

## 2. Verified current state (evidence in tree)

| Fact | Location |
|---|---|
| Worker failure publish: `await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)` | `apps/ai-server/rag-worker-service/main.py`, `process_document` except handler |
| Single try block, no stage tracking; progress stages published post-hoc: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed` | same file, `process_document` |
| `classify_error(e) -> bool` (True=transient, False=permanent; unknown → permanent) | same file, module level, defined before heavy imports |
| Failed branch reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`; persists `error`/`error_stage`/`retryable` on main doc and `error{code,message,stage}` (code default `"UNKNOWN"`) + `stage` on `processing/summary` | `apps/ai-server/rag-api-service/main.py`, `run_transactional_update` |
| Stale-lease sweep writes `error` / `error_stage: "processing"` / `retryable: True` directly — already conformant | worker `main.py`, `_fail_if_still_stale` |
| Persisted schema exposed by `Resource` model (retryable default True) and `ResourceResponse` | `apps/ai-server/rag-api-service/models/resource.py`, rag-api `main.py` |
| Worker unit-test infra: stub conftest making `import main` work; fake transaction pattern (`FakeTx`/`FakeSnap`/`FakeRef`/`FakeDb`, `firestore.transactional` identity patch) | `apps/ai-server/rag-worker-service/tests/conftest.py`, `tests/unit/test_processing_lease.py` |
| Integration contract-test infra: MagicMock conftest + `import main as rag_api_main`; subprocess+AST pattern for the non-importable side; fixture files with `_contract` metadata | `apps/ai-server/tests/integration/conftest.py`, `test_api_contracts.py`, `tests/fixtures/api-contracts/` |

Both services define `main.py`; two `main` modules cannot coexist under one name in one pytest process. This drives
the test-strategy split in §6.

## 3. Contract being implemented (frozen by this plan)

**Worker → status topic, `status == "failed"` `details` payload:**

| Key | Value | Notes |
|---|---|---|
| `error_message` | `str(exception)` | rag-api persists to main-doc `error` and summary `error.message` |
| `stage` | in-flight pipeline stage (§4 table) | rag-api persists to `error_stage` and summary `error.stage` / `stage` |
| `retryable` | `classify_error(e)` (§5 table) | deliberately derived; rag-api's `details.get("retryable", True)` fallback must never be operative for worker failures |
| `error` | `str(exception)` (duplicate) | legacy-key compat hedge (F11); rag-api ignores it |

Required key set is exactly `{error_message, stage, retryable, error}` at construction time (before
`_publish_status_update` may add `jobId`).

**rag-api persistence (unchanged code, pinned by test):** main doc `error ← error_message`, `error_stage ← stage`,
`retryable ← retryable`; `processing/summary` gets `error: {code: "UNKNOWN" (default), message: error_message,
stage: stage}` and top-level `stage ← stage`.

## 4. Stage tracking design

A local `stage` variable in `process_document`, initialized to `"processing"` **before** the `try`, set immediately
before each pipeline `await` (update-before-await convention), read by the except handler. Values reuse the
progress-stage vocabulary; the in-flight step is named by the stage label it is running toward:

| Code being executed | `stage` value set just before it |
|---|---|
| (initial value; failure before first assignment) | `"processing"` (safe fallback; also the stale-lease sweep's `error_stage` value, so the field never regresses to null) |
| `_validate_processing_request` | `"starting"` |
| `_get_extracted_text` | `"text_retrieved"` |
| `content_tagger.generate_tags` | `"tagging_complete"` |
| summary generation + `ragDescription` Firestore write | `"summary_generated"` |
| `_create_enhanced_chunks` | `"chunking_complete"` |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |
| post-embedding steps (delete/store vectors, metadata save, usage, resource map) | unchanged (`"embeddings_complete"` retained — truthful: failure occurred after embeddings completed; vocabulary has no storage-stage label and adding one is out of scope) |

Drift risk (a future step added without updating the tracker) is mitigated by the convention comment and
representative-stage tests (early + late failure), not by ossifying every step.

Sketch of the changed handler (helper defined next to `classify_error`, which it calls; no new imports):

```python
def build_failure_details(error: Exception, stage: str) -> Dict[str, Any]:
    """Canonical failure payload for the rag-api status subscriber.

    Keys are rag-api's failed-branch contract: error_message/stage/retryable.
    `retryable` is deliberately derived from classify_error — the same
    classification that drives ACK/NACK in run_worker — so the persisted
    record matches actual retry behavior (transient = Pub/Sub will
    redeliver; permanent/unknown = acked; manual reprocess via POST
    /process). Behavior change vs. the old silent default: unclassified
    exceptions now persist retryable=False, not True. `error` is retained
    for any unknown consumer of the status topic.
    """
    message = str(error)
    return {
        "error_message": message,
        "stage": stage,
        "retryable": classify_error(error),
        "error": message,  # legacy key; kept until consumers are audited
    }
```

```python
# process_document
    stage = "processing"
    try:
        stage = "starting"
        await self._validate_processing_request(...)
        ...
    except Exception as e:
        metrics.error_message, metrics.end_time = str(e), time.time()
        details = build_failure_details(e, stage)
        self.logger.error("document_processing_failed", ..., error=str(e),
                          stage=details["stage"], retryable=details["retryable"])
        await self._publish_status_update(user_id, course_id, resource_id,
                                          "failed", details, job_id)
        ...
```

## 5. retryable derivation (explicit, pinned)

| Exception class | `classify_error` | persisted `retryable` |
|---|---|---|
| `TransientError`, `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, `httpx.HTTPStatusError` with 429/500/502/503/504 | transient | `True` |
| `PermanentError`, `httpx.HTTPStatusError` other 4xx, **any unclassified/unknown exception** | permanent | `False` |

Deliberate behavior change accepted by the definition (F8): unclassified errors flip from the silent default
`True` to `False`, matching the worker's actual ACK behavior; manual reprocess via `POST /process` is unaffected.
The stale-lease sweep keeps its own direct `retryable: True` write (dead worker = transient by nature) — untouched.

## 6. Changes

### 6.1 `apps/ai-server/rag-worker-service/main.py` (the only production change)
1. Add `build_failure_details(error, stage)` (module level, adjacent to `classify_error`).
2. Add stage tracker per §4 (initializer before `try`; assignment before each mapped `await`).
3. Rewrite the except handler to publish `build_failure_details(e, stage)`; extend the failure log line with
   `stage` and `retryable`. Keep `metrics.error_message` as-is.
4. Add the update-before-await convention comment at the tracker declaration.
5. Nothing else in the worker changes: no ACK/NACK, lease, heartbeat, sweep, or `_publish_status_update` changes.

### 6.2 `apps/ai-server/rag-api-service/**` — **no changes**
`run_transactional_update` already implements the contract once the worker sends the right keys. Constraint
"don't change rag-api's reads or persisted schema" is satisfied by construction. The rag-api side gets only *test*
coverage (below), living under `apps/ai-server/tests/`, not the service tree.

### 6.3 New worker unit tests: `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`
House pattern: `import main` (stubs come from the existing tests/conftest.py), fakes adapted from
`test_processing_lease.py` (extend `FakeSnap.to_dict`, `FakeRef.collection(...).document(...)`, add `.id`;
`monkeypatch.setattr(main.firestore, "transactional", identity)`, `SERVER_TIMESTAMP` sentinel), processor built
via `object.__new__(EnhancedDocumentProcessor)` with instance-level stubs and an async recorder replacing
`_publish_status_update` (as in `test_vector_storage.py`).

Cases:
1. `build_failure_details`: transient (`httpx.ReadTimeout`) → keys exactly `{error_message, stage, retryable, error}`,
   `retryable is True`, message copied to both keys.
2. `build_failure_details`: `PermanentError` → `retryable is False`.
3. `build_failure_details`: unknown (`ValueError`) → `retryable is False` (pins the conservative flip).
4. `build_failure_details`: `httpx.HTTPStatusError` 429 → True; 404 → False.
5. `build_failure_details` with `stage="processing"` passes through unchanged (fallback is a pass-through value).
6. Early-failure scenario: validation passes via FakeDb doc (`userId` matches, `extractedText` present), replaced
   `_get_extracted_text` raises `httpx.ReadTimeout("read timed out")` → exactly one published `"failed"` payload:
   `error_message == "read timed out"`, `stage == "text_retrieved"`, `retryable is True`, legacy `error` present;
   `metrics.error_message` set.
7. Late-failure scenario: steps 1–4 stubbed to succeed, `store_chunks_via_service` raises
   `RuntimeError("partial vector write: 1/10 chunks stored")` → `stage == "embeddings_complete"`,
   `retryable is False`.
8. Validation failure (`_validate_processing_request` raises `ValueError`) → `stage == "starting"`.
9. Source guard (AST or text scan of `main.py`): `stage = "processing"` initializes before the `try` in
   `process_document`, and the except handler passes `build_failure_details(...)` to `_publish_status_update`
   (pins the fallback initializer and the helper wiring; see §7 rationale).

### 6.4 New contract test: `apps/ai-server/tests/integration/test_worker_failure_contract.py`
Lives beside `test_api_contracts.py`; uses the existing integration conftest (rag-api on `sys.path`,
google/firebase mocked) — **in-process for rag-api, subprocess for the worker** (two `main` modules cannot share a
pytest process; the subprocess+AST pattern is the established house solution, cf. `_get_agent_graph_shapes`).

**Worker side (subprocess, `sys.executable -c`, timeout 60s):** the script
- inserts `rag-worker-service/tests` then `rag-worker-service` on `sys.path`,
- `import conftest` (reuses the worker's proven stub/env module verbatim — no duplicated stub set to drift),
- `import main as worker_main`, builds the processor via `object.__new__` with the same instance stubs/recorder
  as §6.3,
- runs scenarios 6 (early/transient) and a permanent-classified failure (late `RuntimeError` or validation
  `ValueError`) under `asyncio.run`,
- prints a `===WORKER_PAYLOAD_JSON===` sentinel line followed by one JSON document (worker logging writes to
  stdout; the sentinel makes parsing robust),
- exits nonzero with stderr on any failure inside the scenario.

**rag-api side (in-process):** fake Firestore from the lease-test pattern (`db.transaction()` → capturing
`FakeTx`, `doc_ref.get` returns a `processing`-status doc so `ALLOWED_TRANSITIONS` permits `processing → failed`);
`monkeypatch.setattr(rag_api_main.firestore, "transactional", identity, raising=False)` and a `SERVER_TIMESTAMP`
sentinel; call `rag_api_main.run_transactional_update(db, doc_ref, "failed", payload, rag_api_main.logger, user_id)`.

Tests:
1. **Seam, transient:** worker scenario-6 payload → rag-api persistence: main doc `error == "read timed out"`
   (not `"Processing failed"`), `error_stage == "text_retrieved"` (not None), `retryable is True`; status `failed`.
2. **Seam, permanent/unknown:** worker permanent payload → persisted `retryable is False` (pins the deliberate
   F8 behavior change end to end).
3. **Summary subdocument:** `processing/summary` set-write carries `error.message`/`error.stage` equal to the main
   doc's `error`/`error_stage`, top-level `stage` equal, and `error.code == "UNKNOWN"`.
4. **Payload shape:** worker payload key set is exactly `{error_message, stage, retryable, error}` (before
   `jobId` injection, which the recorder bypasses).
5. **Drift detectability (negative control):** feed the *old* payload `{"error": "x"}` through
   `run_transactional_update` and assert the fallbacks appear (`error == "Processing failed"`,
   `error_stage is None`, `retryable is True`) — demonstrates this test fails on either side's key drift, which is
   exactly the pre-fix bug.
6. **Static drift guards** (in-process, AST over both `main.py` files, compared against a new shared fixture
   `apps/ai-server/tests/fixtures/api-contracts/worker_failure_payload.json` with `_contract` metadata per house
   convention): worker side declares required detail keys `{error_message, stage, retryable}` plus legacy `error`
   (via the `build_failure_details` dict literal); rag-api's failed branch reads `error_message`, `stage`,
   `retryable` from `details` and writes `error`, `error_stage`, `retryable`. Adding/removing a key on either side
   without updating the fixture fails the build.

### 6.5 Test fixtures
- New: `apps/ai-server/tests/fixtures/api-contracts/worker_failure_payload.json` (declared key sets, both
  directions, `_contract` metadata).
- No changes to existing fixtures or tests.

## 7. Notable design decisions & rationale
- **Fallback `"processing"` is defensive, not decorative:** with the §4 mapping the first tracker assignment
  precedes the first `await`, so today the fallback is reachable only if code is later inserted at the top of the
  `try`. It is still mandated (field must never regress to null) and is pinned by unit test 9 + the shared value
  with the sweep's `error_stage`.
- **Subprocess reuse of the worker conftest** (`import conftest` for stubs) avoids a second, drift-prone stub
  block; isolation guarantees no `sys.modules` pollution of the rag-api in-process tests.
- **Negative control (test 5)** is what makes the contract test self-evidently a drift guard rather than a
  tautology: it shows the harness detects the exact mismatch being fixed.

## 8. Constraints compliance
| Constraint | How satisfied |
|---|---|
| Align worker to rag-api's contract; don't change rag-api | §6.1 is the only production change; §6.2 explicitly none |
| No migration/rename/backfill; persisted names/semantics unchanged | rag-api writes untouched; `error`/`error_stage`/`retryable` unchanged |
| `retryable` always explicit from worker; API fallback not operative | `build_failure_details` always sets it; test 1–2 + 5 prove both the operative and fallback paths |
| Prefer retaining legacy `error` key | retained in payload; documented as removable after a consumer audit |
| Prefer no structured error-code taxonomy | no `error_code` sent; summary `error.code` stays `"UNKNOWN"` (asserted in test 3) |

## 9. Out of scope (per definition non-goals)
Stale-lease sweep behavior; ACK/NACK/lease/heartbeat mechanics; frontend/mobile (`ResourceResponse` already
exposes `error`/`error_stage`); error-code taxonomy; the companion D3 issue (content unavailable — deferred);
reconciling the absent `plans/upload-flow.md` D4 note; dropping the legacy `error` key (future cleanup after
consumer audit).

## 10. Risks & mitigations
- **Unknown status-topic consumers** reading the old key set → legacy `error` retained; residual risk accepted low.
- **Stage-tracker drift** as the pipeline evolves → update-before-await convention comment + early/late
  representative-stage tests + source guard.
- **`retryable=False` for unrecognized-but-transient failures** → accepted (conservatism of `classify_error`);
  widening classification explicitly out of scope; manual reprocess unaffected.
- **Subprocess brittleness** (worker import needs env + stubs) → reuse of the proven worker tests/conftest.py;
  sentinel-delimited JSON; 60s timeout; explicit nonzero-exit propagation so the test failure message carries
  stderr.
- **Contract test ossifies the payload** → intentional; that is the drift guard. Adding a key means touching the
  fixture deliberately.

## 11. Execution notes (repo workflow)
Cross-service seam with contract test: single branch `fix/rag-worker-failure-contract` → one PR to `main`
(confined to ai-server + its tests; no cross-client surface change — `ResourceResponse` untouched). If scope grows
beyond §6, escalate to the feature workflow per AGENTS.md. Validation before PR:
1. `python -m pytest apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py -q`
2. `python -m pytest apps/ai-server/rag-worker-service/tests -q` (no regressions, esp. `test_processing_lease.py`)
3. `python -m pytest apps/ai-server/tests/integration/test_worker_failure_contract.py -q`
4. `python -m pytest apps/ai-server/tests/integration -q` (suite health)
5. `./dev/run ai-server` (full gate; requires Docker Compose up)

## 12. Acceptance criteria mapping
| Definition acceptance | Proven by |
|---|---|
| Failed payload carries `error_message`/`stage`/`retryable`, none relying on API fallbacks | unit tests 1–8; contract tests 1, 2, 4 |
| Persisted `error` = actual message, `error_stage` = failing stage, `retryable` = derived value | contract tests 1, 2 (+5 negative control) |
| Summary error subdocument carries same message and stage | contract test 3 |
| Contract test exists, passes, exercises both sides, fails on key drift | contract tests 1–6 + fixture |

## 13. Implementation order
1. Worker: `build_failure_details` + stage tracker + handler rewrite (§6.1).
2. Worker unit tests (§6.3) — green.
3. Fixture + integration contract test (§6.4–6.5) — green against the new payload; negative control (test 5)
   validated by temporarily checking it against the pre-fix payload shape during development.
4. Full validation (§11), then PR.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>