Both services have a `models` package — first-import-wins would silently give one service the other's models. Mitigation: load each `main` via `importlib.util.spec_from_file_location` under unique module names, and pre-import each service's own `models`/local modules under namespaced names if needed — or simpler: load worker main FIRST is not enough; the robust approach is to namespace: since worker main does `from models.X import Y` (absolute), the `models` on sys.path must be the worker's at the moment worker main executes. And rag-api main does `from models.resource import Resource`? I didn't retain rag-api main's import block. Hmm.

Let me check what I know: rag-api main.py imports — not retained in detail. It's a FastAPI app with firebase_admin, pubsub, structlog, pydantic. Does it import models.resource? Plausible but UNVERIFIED. I must not invent. I'll write the plan to handle this defensively: "If both services' `main` modules import same-named local packages (e.g. `models`), sequence the imports or namespace them; the implementer must verify each main's local imports at implementation time and, if a collision exists, load the second service's main with its dependency dir temporarily fronted on sys.path (or pre-import its local modules under the names the main expects), then restore sys.path." That's honest about the unverified detail and gives a concrete strategy.

Actually — cleaner robust strategy that avoids the whole class of problems: run the two sides in SEPARATE pytest modules/processes? No — the round-trip needs both in one process (build payload via worker code, feed to rag-api code). Alternative: subprocess? Overkill. The importlib approach with careful sys.path ordering is standard; I'll specify:

1. sys.path: insert rag-api-service dir (already done by conftest).
2. Pre-import rag-api main as `import main` (module name "main") — matching existing integration tests' presumed pattern... unverified. Hmm.

Honestly, since I can't re-verify, the plan should present the import strategy with a primary approach and an explicit verification step: "Step 0 of implementation: confirm each main.py's local absolute imports; if both use a top-level `models` package, adopt [strategy]". Strategy: import worker main under a unique spec name while worker dir is front of sys.path, then import rag-api main (as "main" or unique name) while rag-api dir is front — but module identity for `models` gets fixed by whichever imported first and the OTHER service's main would then receive the wrong `models`. The bulletproof fix: since `exec_module` executes with current sys.path, and absolute `from models.resource import ...` inside rag-api main resolves via sys.path at exec time — so: exec rag-api main FIRST with rag-api dir at sys.path front (its `models` import binds rag-api's models into sys.modules["models"]); then exec worker main — worker's `from models.chunk_metadata import ...` would get the CACHED rag-api models. Broken.
   
   Real fix used in the wild: temporarily manipulate sys.path AND purge `models` from sys.modules between the two execs, plus unique top-level names. Since each main is executed exactly once, purging `models` (and any colliding subnames) from sys.modules before each exec, with the right dir at sys.path[0], gives each main its own models at exec time. The mains themselves hold direct references to the classes they imported, so post-exec cross-talk is limited to further lazy imports inside functions (rare; note it). This works. I'll spec exactly that as a small helper `_load_service_main(name, service_dir, colliding=("models",))` that: inserts service_dir at sys.path[0], purges colliding top-level module names from sys.modules, execs under unique name, and (optionally) snapshots/restores. Also note both conftests' MagicMock stubbing of google.* is compatible.

   Hmm — actually, hold on. Is worker main's local import style even `from models.X import ...`? I saw in test files: `sys.path.insert(0, worker_dir); from main import classify_error` — and worker has packages: algorithms/, models/, subscribers/, utils/, workers/. main.py almost certainly imports from some of these (e.g., `from models.pubsub_messages import ...`? that's subscribers/pdf_processor's import style: `from models.pubsub_messages import ProcessingMessage`). So yes, worker main likely does absolute `from models...`/`from utils...` imports. rag-api: has models/ package; main.py likely `from models.resource import Resource` (unverified). The purge-between-exec strategy handles both. Good — document it as the import bootstrap with the collision list computed at implementation time (verify step).

   Firestore emulator vs fakes: The Definition allows "via the Firestore emulator or fakes". Verified in-repo: the FakeTx/FakeDb transaction fakes in worker tests prove the transactional-write-shim pattern works for worker code; rag-api's `run_transactional_update` uses `db.transaction()` and `firestore.transactional` (verified pattern in the code I read: `transaction = db.transaction(); update_logic(transaction)` and inside `update_logic(transaction)` it calls `transaction.update(doc_ref, ...)`, `transaction.set(summary_ref, ..., merge=True)`, and reads `doc_ref.get(transaction=transaction)`? — hmm, I saw `transaction.update(doc_ref, main_update)` and `transaction.set(summary_ref, summary_update, merge=True)`; earlier in update_logic there's presumably a `doc_ref.get` — I saw at line ~245ish `app_state.db.document(canonical).get().exists` in _process_status_message (not the transaction). The top of update_logic (before line 230) I did NOT see — it likely does doc lookup + status validation. UNVERIFIED detail: exact signature/entry of run_transactional_update (args: db? doc_ref? user_id/course_id/resource_id/new_status/details?). From the slice: `run_transactional_update` encloses `update_logic(transaction)` closure using `doc_ref`, `details`, `new_status`, `db`. The plan must include a verification step: read the full `run_transactional_update` signature before writing the test harness. The fake needs: `db.transaction()` → FakeTx supporting `.update(ref, data)` and `.set(ref, data, merge=...)`; `firestore.transactional` decorator → identity (worker test pattern `_tx_identity` proves this shim works in-repo); `firestore.SERVER_TIMESTAMP` → sentinel. If update_logic reads the doc inside the tx (`transaction.get(ref)`), FakeTx needs `.get` — worker's FakeTx already has `.get(ref, transaction=None)`. Reuse that fake family — copy into the contract test module (tests/integration has no shared fakes module verified; simplest: define fakes in the new test file, crediting the pattern).

   Also the summary subdoc assertions: persisted summary `error` subdocument = {"code": "UNKNOWN" (no error_code sent — prefer_not constraint keeps it), "message": worker message, "stage": worker stage}. And main doc: error/error_stage/retryable + status="failed" (main_update presumably also sets status earlier — unverified portion; test asserts the fields we know).

   Also a variant test: payload WITHOUT retryable (simulating a hypothetical other publisher) → retryable persists True (fallback intact — proves we didn't change rag-api's fallbacks). And stage missing → error_stage None. These pin rag-api's unchanged fallback behavior. Good.

   And worker-side unit tests (in rag-worker-service/tests/unit/ — new file `test_failure_payload.py`):
   - `_build_failure_details` for TransientError → retryable True; PermanentError → False; generic RuntimeError → False (conservative default); httpx.ConnectError → True; ValueError → False.
   - keys exactly {"error_message","error","stage","retryable"}; error == error_message == str(e); legacy `error` retained.
   - empty-message guard → message falls back to exception type name.
   - stage-tracking integration: drive `process_document` with mocked processor? That's heavy (needs a RAGProcessor instance with db, langfuse None, content_tagger mock...). Alternative lighter approach: source-level assertion (AST/inspect) that `process_document` assigns `current_stage` before each milestone step — hmm, brittle. OR a focused behavioral test with the processor class heavily mocked: construct processor via `object.__new__(RAGProcessor)`-style or patch __init__ deps... The class name — I saw `self.logger`, `self.db`, `self.langfuse`, `self.config`, `self.content_tagger`, `self.text_splitter`, `self.tokenizer`. Class name unverified (something like DocumentProcessor/RAGProcessor). Plan: verification step to confirm class/ctor; test constructs instance with mocked deps (MagicMock db etc., langfuse=None), monkeypatches `_publish_status_update` to capture payloads (AsyncMock), monkeypatches the pipeline step methods: make `_get_extracted_text` raise → assert captured failed-payload stage == "text_retrieved", retryable per exception class; make `_generate_embeddings_with_openrouter` raise httpx.ReadTimeout → stage "embeddings_complete", retryable True; make validation raise → stage "starting". This behavioral test pins the tracker mechanism (the Definition's requirement: test pins mechanism on representative stages). Also assert the failure publish still happens exactly once and completed-publish not called.
   - Also assert `_publish_status_update` called with status "failed" and the details dict identity/equality.

   Existing regression guard: test_processing_lease.py already pins sweep retryable=True — untouched.

7. Also update: any docs? Not required. Keep scope tight.

8. Rollout/verification steps:
   - Run worker unit suite: `cd apps/ai-server/rag-worker-service && pytest` (pytest.ini testpaths=tests, asyncio_mode=auto).
   - Run integration contract tests: `cd apps/ai-server && python -m pytest tests/integration/test_worker_failure_contract.py -q` (conftest handles stubs; no emulator needed if fakes path chosen — prefer fakes for hermetic CI-less runs; emulator path optional manual verification).
   - Manual end-to-end (optional, if emulator available): FIRESTORE_EMULATOR_HOST + docker-compose pubsub emulator — describe briefly, mark optional since fakes satisfy acceptance.
   - Lint/import sanity: `python -c "import main"` under stubs? Not needed.

9. Risks/rollbacks: single-service code change (worker only), additive payload keys, no schema change → rollback = revert worker main.py. Feature flag not warranted.

10. Task breakdown with estimates & ordering:
   - T1: worker main.py — add `_build_failure_details` (+ empty-message guard), stage tracker assignments, rewrite except handler. 
   - T2: worker unit tests `test_failure_payload.py`.
   - T3: contract test `tests/integration/test_worker_failure_contract.py` (import bootstrap, fakes, round-trip, drift guards, rag-api-fallback-preservation tests).
   - T4: run full relevant suites; verify no other worker publish sites need alignment (grep `_publish_status_update(.*failed` — only the handler; sweep writes directly verified).
   - T5: (optional) note CI gap.

Also acceptance-criteria mapping table.

**test-plan.md structure:**
- Scope & strategy (layers: unit / contract round-trip / drift guards / preserved-behavior pins)
- Environments & how to run (commands; no new deps — pytest, pytest-asyncio already in both services' requirements)
- Detailed test cases with IDs (TC-xx): worker unit cases; contract cases; negative/drift cases; regression pins (sweep unchanged via existing tests)
- Fakes & fixtures design (FakeTx/FakeDb reuse, import bootstrap, AsyncMock capture of _publish_status_update)
- What must NOT be tested/changed (rag-api fallbacks stay; ACK/NACK untouched; no error_code taxonomy)
- Acceptance mapping
- Risks (import collisions, MagicMock over-stubbing hiding real logic — mitigate by stubbing only import-time deps and using real classify_error, real _build_failure_details, real failed-branch logic)
- Unverified items the implementer must confirm (exact run_transactional_update signature & pre-line-230 body; rag-api main's local imports; worker main's full local import list; class name/ctor of the processor)

Length: detailed but not bloated. Both files in Markdown. End with the exact delimiter blocks, one per path, in order docs/plan.md then docs/test-plan.md. No prose after? The instructions: "End your final message with the artifact wrapped in exactly these literal delimiters". So final message = maybe brief nothing, then the blocks. I'll output only the blocks (safe). Format:

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
...content...
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
...content...
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>

Wait — the format spec shows one artifact block example; "Emit exactly one artifact block for EACH of these paths" — so two SLE-ARTIFACT blocks inside one SLE-OUTPUT wrapper. The example shows `<<<SLE-OUTPUT>>>` then a single artifact then `<<<END-SLE-OUTPUT>>>`; with two artifacts I put both between SLE-OUTPUT and END-SLE-OUTPUT. Yes.

Now write the content. Keep verified line references where I have them (worker main.py ~1093-1099 handler; rag-api main.py 237-241 & 279-284; process_document body 1000-1086). Use approximate line refs with "~" honesty.

One more design point for the plan: naming — `_build_failure_details(error, stage)` module-level in worker main.py. Contract test imports it via the unique-name importlib load. Also expose the stage vocabulary as a module constant? Could add `PIPELINE_STAGES = (...)` — not required; skip (avoid ossifying). Actually a tiny constant could help the drift test... skip, keep minimal.

Also note behavior change callout: unclassified-unknown errors now persist retryable=false (was silent True) — per F8, accepted; document in plan's "Behavioral changes" section.

Also the legacy `error` key: rag-api ignores it (reads error_message) — harmless; retained per F11/constraint prefer.

Also `_publish_status_update` — check its details serialization: it publishes JSON with user_id/course_id/resource_id/status/details (unverified internals but rag-api's subscriber parses payload["details"] — consistent). No change needed.

Empty-message guard: `message = str(e).strip() or type(e).__name__`. Include.

Write it all now. Be careful: content inside markers is opaque Markdown; headings<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — Worker→rag-api Failure Payload Contract Alignment

Run: afc18a5b-f04f-49c6-a9c7-4f3f856203ea · Iteration 1 · Authoritative scope: WorkItem `wi-define-108-a8` (Definition artifact `definition:obj-108`, sha256 `71f1c39c…`).

## 1. Goal (bounded)

Make the rag-worker's `failed` status payload speak rag-api's contract — `error_message`, `stage`, `retryable` — so a failed RAG job persists the worker's real error message, the failing pipeline stage, and a deliberately derived retryable flag. Lock the seam with a contract test. **rag-api's code is not changed**; the worker is the only production code touched.

## 2. Verified current state (evidence)

| # | Fact | Evidence (verified this run) |
|---|------|------------------------------|
| V1 | Worker's `process_document` exception handler publishes a one-key payload: `await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)` | `apps/ai-server/rag-worker-service/main.py` ~lines 1093–1099 |
| V2 | `process_document` is one large `try`; progress publishes use stages `starting`, `text_retrieved` (20), `tagging_complete` (40), `summary_generated` (50), `chunking_complete` (60), `embeddings_complete` (80), final `completed` (100). No stage state exists at failure time. Post-embeddings steps (`delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, `_update_user_usage`, `_generate_resource_map`) run after the `embeddings_complete` publish with no distinct milestone | `main.py` ~lines 1000–1086 |
| V3 | rag-api failed branch: `main_update["error"] = details.get("error_message", "Processing failed")`; `main_update["error_stage"] = details.get("stage")`; `main_update["retryable"] = details.get("retryable", True)`; summary subdocument gets `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}` | `apps/ai-server/rag-api-service/main.py` lines ~237–241 and ~279–284 |
| V4 | `classify_error()` + `TransientError`/`PermanentError` exist and behave as: TransientError/ConnectionError/TimeoutError/asyncio.TimeoutError/httpx.ConnectError/ReadTimeout/HTTP 429/503 → transient; PermanentError/HTTP 400/404/ValueError/generic `Exception` → permanent (conservative default) | `main.py`; pinned by `rag-worker-service/tests/unit/test_utils.py::TestClassifyError` |
| V5 | Persisted failure schema `error` / `error_stage` / `retryable` (default `True`) on `Resource` | `apps/ai-server/rag-api-service/models/resource.py` |
| V6 | Stale-lease sweep writes `status="failed"`, `retryable=True` directly; pinned by existing tests | `rag-worker-service/tests/unit/test_processing_lease.py::TestSweepRace` |
| V7 | Transactional-write fakes pattern proven in-repo: `FakeTx`/`FakeSnap`/`FakeRef`/`FakeDb` + `_tx_identity` stand-in for `firestore.transactional`; `firestore.SERVER_TIMESTAMP` monkeypatched | `test_processing_lease.py` |
| V8 | Cross-service integration test infra exists: `apps/ai-server/tests/integration/conftest.py` stubs `firebase_admin`, `google.cloud.*`, `structlog`, etc. and puts `rag-api-service` on `sys.path`; house contract tests live in `tests/integration/test_api_contracts.py` | verified files |
| V9 | Worker test infra: `rag-worker-service/tests/conftest.py` stubs worker import-time deps (openai, langfuse, langchain*, tiktoken, spacy, tenacity, pubsub, firestore, storage); `pytest.ini` sets `asyncio_mode = auto`; worker tests import `main` directly | verified files |
| V10 | CI (`apps/ai-server/.github/workflows/deploy.yml`) currently runs only auth-service npm tests — Python suites are run locally/pre-merge, not in CI | verified file |
| V11 | `PDFProcessingError` carries a `retryable` metadata attribute; the retry *decision* lives elsewhere. Out of scope — derivation per Definition F8 uses `classify_error` only | `rag-worker-service/exceptions.py` docstring |

Consequence chain (matches Definition F5): worker sends `{"error": …}` → rag-api finds none of its three keys → persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (silent default), and summary `error.code="UNKNOWN"` with fallback message.

## 3. Design decisions

### D1 — Worker aligns to the API; rag-api untouched
rag-api's failed branch already implements Definition requirement 3 verbatim (V3). Its `.get(...)` fallbacks stay — they are defensive defaults for any non-worker status publisher and the Definition only forbids them being the *operative* mechanism for worker failures. **Zero rag-api source changes.**

### D2 — Stage tracker: set immediately before each pipeline step (Rule A)
A local `current_stage` in `process_document`, initialized to `"processing"` before the `try`, assigned immediately before each milestone-anchored step, using only the existing progress vocabulary:

| Assignment | Before step | Failure there reports |
|---|---|---|
| `current_stage = "starting"` | `_validate_processing_request` | validation failures → `"starting"` |
| `current_stage = "text_retrieved"` | `_get_extracted_text` | extraction failures → `"text_retrieved"` (step label) |
| `current_stage = "tagging_complete"` | `content_tagger.generate_tags` | tagging failures |
| `current_stage = "summary_generated"` | `generate_document_summary` (through the `ragDescription` Firestore update) | summary failures |
| `current_stage = "chunking_complete"` | `_create_enhanced_chunks` | chunking failures |
| `current_stage = "embeddings_complete"` | `_generate_embeddings_with_openrouter` | embedding failures |

Semantics: the milestone name labels the *step executing*, per the Definition's "set immediately before the await" convention. Two deliberate edge rulings:
- **Post-embeddings finalization** (old-vector deletion, Weaviate storage, metadata save, usage, resource map): the pinned vocabulary has no distinct label; `current_stage` stays at `"embeddings_complete"`, which reads truthfully as "failed after the embeddings milestone, during finalization". No new stage names are invented.
- **`"processing"` fallback** covers only genuinely-unknown failures (the window before the first assignment, or any untracked path). It matches the stale-lease sweep's `error_stage` value, so the field never regresses to null.

Drift convention for future steps: *assign the tracker immediately before the new step's first await*. The contract test pins the mechanism on an early and a late representative stage (§5), which catches the tracker being removed or bypassed without ossifying every step.

### D3 — `retryable` derived from `classify_error`, in a pure helper
New module-level pure function in worker `main.py` (module-level so both unit tests and the cross-service contract test can import it without constructing the processor class):

```python
def _build_failure_details(error: Exception, stage: str) -> dict:
    message = str(e := error).strip() or type(error).__name__  # empty-message guard, see D5
    return {
        "error_message": message,
        "error": message,        # legacy key retained — compat hedge (Definition F11)
        "stage": stage,
        "retryable": classify_error(error),
    }
```

Mapping (Definition F8, aligned with ACK/NACK in `run_worker`): transient classification → `retryable: true` (Pub/Sub will redeliver); permanent classification **including unclassified-unknown** → `retryable: false` (acked; manual reprocess via `POST /process` remains).

### D4 — Exception handler rewrite (only behavioral change site)
Replace the handler body's publish (V1) with:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    failure_details = _build_failure_details(e, current_stage)
    self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                      resource_id=resource_id, error=str(e), stage=current_stage,
                      retryable=failure_details["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e),
                                   "stage": current_stage, "retryable": failure_details["retryable"]})
    return metrics
```

`_publish_status_update` signature and transport unchanged; `run_worker` ACK/NACK logic untouched.

### D5 — Empty-message guard (micro-decision, flagged)
If `str(e)` is empty (e.g. `raise ValueError()`), the key's presence would disable rag-api's fallback and persist `error=""`. The guard substitutes the exception type name so the persisted error is never blank. This is worker-provided data, so requirement 3 ("persist worker-provided values unchanged") still holds. Drop this line only if strict literalism is preferred; the unit test covering it (TC-U7) would be dropped with it.

### D6 — Legacy `error` key retained
One redundant string per failure message as insurance for unknown consumers of the status topic (Definition F11 / prefer-constraint). rag-api ignores it. Trivial to drop later after a consumer audit — out of scope now.

### D7 — Contract test = behavioral round-trip + drift guards, new file
New `apps/ai-server/tests/integration/test_worker_failure_contract.py` (sibling of `test_api_contracts.py`, reusing its conftest). Rationale for a new file: the house file is fixture/AST *static* contract testing; this is a behavioral round-trip. It imports **both sides' real code** rather than restating the contract in a fixture:
- worker side: `_build_failure_details` (and `classify_error` transitively) — real logic;
- rag-api side: the real `run_transactional_update` executed against in-repo fakes (V7 pattern) — real persistence mapping.

**Import bootstrap (known hazard, explicit procedure).** Both services have a top-level package named `models` (worker: `rag-worker-service/models/`; rag-api: `rag-api-service/models/` — V5), and both services' entry module is `main.py`. Naive `import main` twice returns the cached first module; same-named packages are first-import-wins. Procedure:
1. Verification step first (§6 T0): read each `main.py`'s import block; list colliding top-level local package names (expected: `models`; possibly `utils`).
2. Load each side under a **unique module name** via `importlib.util.spec_from_file_location` (e.g. `"rag_worker_main"`, `"rag_api_main"`), executing in sequence: put the target service's dir at `sys.path[0]`, **purge colliding top-level names from `sys.modules`** before each exec so each main binds its own `models` at exec time, exec, then proceed to the other side. Each main holds direct references to what it imported, so post-exec cross-talk is limited to function-level lazy imports (flag any found in T0).
3. The integration conftest's MagicMock stubs (V8) satisfy rag-api's import-time deps; add the worker's import-time stubs from the worker conftest pattern (V9) — `openai`, `langfuse`, `langchain*`, `tiktoken`, `spacy`, `tenacity`, `google.cloud.storage`, pubsub client classes — before executing worker `main`. Both conftests stub `google.cloud.firestore` etc. with MagicMocks; overlap is benign.

**Fakes over emulator (default).** Reuse the V7 fake family (copied into the test module, pattern credited): `FakeTx` (records `update`/`set(merge=…)`, `get` returns current doc state), `FakeDb` (`transaction()` returns the tx; `document(path)` returns refs), `_tx_identity` for `firestore.transactional`, sentinel for `firestore.SERVER_TIMESTAMP`. This is hermetic, needs no emulator, and matches how the sweep's transactional writes are already tested. Firestore-emulator mode stays an optional manual check (both services have `FIRESTORE_EMULATOR_HOST` branches per Definition F10) — not required for acceptance.

**Unverified detail to confirm at T0:** the exact signature and pre-line-230 body of `run_transactional_update` (the verified slice shows the closure `update_logic(transaction)` using `doc_ref`, `details`, `new_status`, `db`, `transaction.update(...)`, `transaction.set(summary_ref, …, merge=True)`; whether it also does `transaction.get(...)` inside the tx must be checked so `FakeTx.get` is wired correctly). The fake harness is written against the confirmed signature.

### D8 — No structured error codes
No `error_code` is sent by the worker; summary `error.code` continues to persist as `"UNKNOWN"` via rag-api's existing default (prefer-not constraint). Not asserted as a *required* key anywhere; the drift guard pins the worker's exact key set so adding one later is a conscious test change.

## 4. Files changed

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Add `_build_failure_details`; add `current_stage` tracker (init + 6 assignments per D2); rewrite `process_document` except-handler per D4. **Only production file touched.** |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | New: unit tests for payload construction, retryable derivation, key-set drift guard, empty-message guard. |
| `apps/ai-server/rag-worker-service/tests/unit/test_process_document_stages.py` | New: behavioral stage-tracker tests driving `process_document` with mocked deps (§5, TC-U8…U10). |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | New: cross-service round-trip + drift guards + rag-api fallback-preservation pins (§5, TC-C1…C6). |

No changes to: rag-api sources, `models/resource.py`, sweep code, ACK/NACK/lease/heartbeat code, `exceptions.py`, frontend, CI (gap noted in §7).

## 5. Test cases (summary — full detail in docs/test-plan.md)

- **TC-U1…U6** `_build_failure_details` derivation: TransientError→true; PermanentError→false; `httpx.ConnectError`→true; `httpx` 503→true; ValueError→false; generic `RuntimeError`→false (conservative default — the deliberate behavior change).
- **TC-U7** empty-message guard → message = exception type name.
- **TC-U8 (key-set drift guard)** `set(_build_failure_details(...)) == {"error_message", "error", "stage", "retryable"}` — exact equality; any added/removed worker key fails.
- **TC-U9** `error == error_message == str(e)`; legacy key retained.
- **TC-U10…U12** stage tracker, behavioral: mocked processor, `_publish_status_update` captured via AsyncMock; `_get_extracted_text` raises `httpx.ReadTimeout` → failed payload `stage=="text_retrieved"`, `retryable is True`; `_generate_embeddings_with_openrouter` raises `PermanentError` → `stage=="embeddings_complete"`, `retryable is False`; `_validate_processing_request` raises → `stage=="starting"`. Also: exactly one failed publish, no `completed` publish.
- **TC-C1 (round-trip, early failure)** real `_build_failure_details(TransientError("Weaviate unreachable"), "text_retrieved")` fed through real `run_transactional_update` on fakes → persisted main doc `error=="Weaviate unreachable"`, `error_stage=="text_retrieved"`, `retryable is True`, `status=="failed"`; summary `error == {"code":"UNKNOWN","message":"Weaviate unreachable","stage":"text_retrieved"}`.
- **TC-C2 (round-trip, late failure)** permanent error at `"embeddings_complete"` → `retryable is False` persisted; message/stage as sent.
- **TC-C3 (rag-api-side drift guard)** payload missing `error_message` → persisted `error=="Processing failed"`; missing `stage` → `error_stage is None`; missing `retryable` → `retryable is True`. Pins that rag-api's fallbacks are unchanged (we did not touch them).
- **TC-C4 (AST/static, house pattern)** rag-api failed branch still reads exactly `error_message`/`stage`/`retryable` (and `error_code` default `"UNKNOWN"`); mirror the existing helpers in `test_api_contracts.py` — implementer mirrors the in-file helper style at implementation time.
- **TC-C5** legacy `error` key present in worker payload and ignored by rag-api (no `KeyError`, no persistence of the duplicate under another name).
- **TC-R1 (regression, existing)** `test_processing_lease.py` suite still passes untouched — sweep's `retryable=True` direct write unchanged.

## 6. Task breakdown (ordered)

- **T0 — Verify-then-code (blocking, ~0.5h):** read full `run_transactional_update` (signature + body above line 230) and both `main.py` import blocks; record colliding local package names and the processor class/ctor signature needed for TC-U10…U12. Write findings into the contract test module header.
- **T1 — Worker change (~1.5h):** `_build_failure_details`, tracker assignments, handler rewrite (D2–D5).
- **T2 — Worker unit tests (~1.5h):** `test_failure_payload.py`, `test_process_document_stages.py`.
- **T3 — Contract test (~2.5h):** import bootstrap, fakes, TC-C1…C5.
- **T4 — Full verification (~0.5h):**
  - `cd apps/ai-server/rag-worker-service && python -m pytest` (whole worker suite — catches regressions in lease/sweep/classify pins);
  - `cd apps/ai-server && python -m pytest tests/integration/test_worker_failure_contract.py -q` (and the existing `test_api_contracts.py` to prove no import-bootstrap interference).
- **T5 — Optional manual emulator run:** with `FIRESTORE_EMULATOR_HOST` set, run one real failure end-to-end if an emulator is available; acceptance is fully met by the fakes path.

## 7. Risks, tradeoffs, out of scope

- **Unknown status-topic consumers** reading the old key set → mitigated by retained legacy `error` key (D6); residual risk accepted low.
- **Tracker drift** as the pipeline evolves → update-before-await convention + representative-stage pins; a new untracked step reports the previous milestone (documented, non-fatal).
- **`retryable=false` for unclassified-unknown errors** (was silent `true`) → deliberate per F8; prevents infinite retry loops; manual `POST /process` reprocess unaffected. Call out in PR description.
- **Contract test ossifies the payload** → intentional drift guard; adding a key means touching the test.
- **Import-bootstrap fragility in the contract test** → T0 verification + purge-between-exec procedure (D7); if lazy cross-service imports surface, namespace them explicitly.
- **CI gap (V10):** Python suites are not in CI; the drift guard only protects the build if run. Adding a CI job is out of scope here (not in Definition); noted for follow-up.
- **Out of scope (Definition non-goals):** sweep behavior; ACK/NACK, leases, heartbeats, backoff; error-code taxonomy; frontend/mobile (`ResourceResponse` already exposes `error`/`error_stage`); companion D3 issue content; reconciling with the D4 note in `plans/upload-flow.md` (file absent from tree).

## 8. Acceptance mapping

| Acceptance criterion | Satisfied by |
|---|---|
| Failed status payload carries `error_message`/`stage`/`retryable`, no reliance on API fallbacks | D2–D4; TC-U1…U12 |
| Persisted `error` = actual message, `error_stage` = failing stage, `retryable` = derived | D3/D4 + unchanged rag-api branch (V3); TC-C1/C2 |
| processing/summary error subdocument carries same message and stage | rag-api branch unchanged (V3); asserted in TC-C1/C2 |
| Contract test exists, passes, fails on key drift either side | D7; TC-U8, TC-C1…C4 |

## 9. Rollback

Single-file production change, additive payload keys, no schema/migration/backfill. Revert `rag-worker-service/main.py` to restore prior behavior; tests may remain (TC-C3 would then fail loudly — correct signal).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — Worker→rag-api Failure Payload Contract

Run: afc18a5b-f04f-49c6-a9c7-4f3f856203ea · Companion to docs/plan.md (§5 summarizes; this document specifies).

## 1. Strategy

Three layers, cheapest first, all hermetic (no GCP, no emulator required):

1. **Unit (worker):** pure-function tests of `_build_failure_details` and behavioral tests of the stage tracker inside `process_document`, using the worker service's existing stub conftest (`rag-worker-service/tests/conftest.py`, `pytest.ini` with `asyncio_mode = auto`).
2. **Contract round-trip (cross-service):** build the failure payload with the worker's **real** `_build_failure_details`, push it through rag-api's **real** `run_transactional_update` against in-repo Firestore transaction fakes, assert persisted `error` / `error_stage` / `retryable` and the `processing/summary` error subdocument. Imports both sides rather than restating the contract in a fixture.
3. **Drift guards:** exact-key-set assertion on the worker payload (unit) + static/AST assertion on rag-api's failed branch reads (house pattern from `tests/integration/test_api_contracts.py`) + fallback-preservation pins proving rag-api was not altered.

New dependencies: none. `pytest`, `pytest-asyncio`, `pytest-mock` are already in both services' requirements.

## 2. How to run

```bash
# Worker unit + behavioral (worker stubs auto-apply via its conftest)
cd apps/ai-server/rag-worker-service && python -m pytest

# Cross-service contract tests (integration conftest stubs rag-api deps)
cd apps/ai-server && python -m pytest tests/integration/test_worker_failure_contract.py -q

# Prove no interference with existing house contract tests
cd apps/ai-server && python -m pytest tests/integration/test_api_contracts.py -q

# Regression: sweep/lease pins untouched
cd apps/ai-server/rag-worker-service && python -m pytest tests/unit/test_processing_lease.py -q
```

Optional manual (not required for acceptance): with `FIRESTORE_EMULATOR_HOST` set for both services, exercise one real failure end-to-end; both services have emulator branches (Definition F10).

## 3. Fixtures and fakes

### 3.1 Import bootstrap (contract test module) — hazard-driven
Both services expose top-level `main.py` and (at least) a top-level `models` package; `sys.modules` caching and first-import-wins would silently cross-wire them. Bootstrap helper in the test module:

```python
def _load_service_main(unique_name, service_dir, colliding=("models",)):
    # 1) service_dir -> sys.path[0]
    # 2) for name in colliding: sys.modules.pop(name, None) and purge submodules
    # 3) spec = importlib.util.spec_from_file_location(unique_name, service_dir/"main.py")
    #    sys.modules[unique_name] = mod; spec.loader.exec_module(mod)
```

Execute rag-api side first (integration conftest already fronts `rag-api-service` and stubs `firebase_admin`/`google.cloud.*`/`structlog`), then the worker side after adding the worker-specific import-time stubs mirrored from `rag-worker-service/tests/conftest.py` (`openai`, `langfuse`, `langchain`/`langchain.text_splitter`/`langchain.schema`, `tiktoken`, `spacy`, `tenacity`, `google.cloud.storage`, `google.cloud.pubsub_v1` with `PublisherClient`/`SubscriberClient`). Overlapping MagicMock stubs of `google.cloud.firestore` between the two bootstraps are benign. **T0 gate (from plan §6): confirm each `main.py`'s actual local import list and the exact `run_transactional_update` signature before writing the harness; record them in the module docstring.** If function-level lazy imports of colliding packages are found, namespace those imports explicitly.

### 3.2 Firestore transaction fakes (contract test module)
Copied pattern from `rag-worker-service/tests/unit/test_processing_lease.py` (credited in-file):
- `FakeTx`: records every `update(ref, data)` and `set(ref, data, merge=…)`; `get(ref, transaction=None)` returns current merged doc state (`FakeSnap` with `.exists`, `.to_dict()`).
- `FakeDb`: `transaction()` → the `FakeTx`; `document(path)` → `FakeRef`/`FakeCollection` graph; exposes `.document(...).collection("processing").document("summary")` so the summary-subdocument write lands in recorded state.
- `_tx_identity`: identity stand-in for `firestore.transactional` (monkeypatched on the loaded rag-api module's `firestore` stub, same as the worker tests do).
- `firestore.SERVER_TIMESTAMP` → sentinel string via monkeypatch.

Wire-up against the **confirmed** `run_transactional_update` signature (T0); if it performs `transaction.get(...)` inside the tx, `FakeTx.get` already covers it.

### 3.3 Worker behavioral harness (unit layer)
Construct the processor class without its real `__init__` cloud deps (T0 confirms class name/ctor; fallback: build via `object.__new__` and assign the attributes the pipeline touches — `db`, `logger`, `langfuse=None`, `config`, `content_tagger`, `text_splitter`, `tokenizer`). Then:
- `monkeypatch` `_publish_status_update` on the instance with an `AsyncMock` capturing `(status, details, job_id)` calls;
- `monkeypatch` pipeline step methods to raise scripted exceptions (`_validate_processing_request`, `_get_extracted_text`, `_generate_embeddings_with_openrouter`, `store_chunks_via_service`);
- real code under test: `process_document`, `_build_failure_details`, `classify_error`.

## 4. Test cases

### 4.1 Worker unit — `tests/unit/test_failure_payload.py`

| ID | Case | Assertion highlights |
|---|---|---|
| TC-U1 | `TransientError("pubsub down")` | `retryable is True`; `error_message == "pubsub down"` |
| TC-U2 | `PermanentError("bad payload")` | `retryable is False` |
| TC-U3 | `httpx.ConnectError("refused")` | `retryable is True` (transient heuristic) |
| TC-U4 | `httpx.HTTPStatusError` 503 / 429 | `retryable is True` |
| TC-U5 | `ValueError("invalid format")` | `retryable is False` |
| TC-U6 | generic `RuntimeError("boom")` | `retryable is False` — pins the deliberate behavior change (was silent `True` via rag-api default) |
| TC-U7 | `raise ValueError()` (empty `str(e)`) | message falls back to exception type name (guard D5; drop with D5 if rejected) |
| TC-U8 | **key-set drift guard** | `set(details) == {"error_message", "error", "stage", "retryable"}` — exact equality; any worker-side key added/removed/renamed fails here |
| TC-U9 | legacy key continuity | `details["error"] == details["error_message"] == str(e)` |

### 4.2 Worker unit — `tests/unit/test_process_document_stages.py` (stage tracker mechanism)

| ID | Case | Assertion highlights |
|---|---|---|
| TC-U10 | early failure: `_get_extracted_text` raises `httpx.ReadTimeout("read timeout")` | captured failed publish: `status=="failed"`; `details["stage"]=="text_retrieved"`; `details["retryable"] is True`; `details["error_message"]=="read timeout"`; exactly one failed publish; no `completed` publish |
| TC-U11 | late failure: `_generate_embeddings_with_openrouter` raises `PermanentError("bad chunk")` | `stage=="embeddings_complete"`; `retryable is False` |
| TC-U12 | start failure: `_validate_processing_request` raises `ValueError("not found")` | `stage=="starting"`; `retryable is False` |
| TC-U13 | post-embeddings failure: `store_chunks_via_service` raises `RuntimeError("weaviate 500")` | `stage=="embeddings_complete"` (standing milestone through finalization, per plan D2); `retryable is False` |
| TC-U14 | `metrics.error_message` still set; handler returns `metrics` (existing contract of the method preserved) |

### 4.3 Cross-service contract — `tests/integration/test_worker_failure_contract.py`

| ID | Case | Assertion highlights |
|---|---|---|
| TC-C1 | **Round-trip, early/transient:** payload = real `_build_failure_details(TransientError("Weaviate unreachable"), "text_retrieved")` → real `run_transactional_update` on `FakeDb` with a `processing` resource doc | main doc: `error=="Weaviate unreachable"` (not `"Processing failed"`), `error_stage=="text_retrieved"` (not None), `retryable is True`, `status=="failed"`; summary subdoc: `error == {"code": "UNKNOWN", "message": "Weaviate unreachable", "stage": "text_retrieved"}` |
| TC-C2 | **Round-trip, late/permanent:** `_build_failure_details(PermanentError("unsupported file"), "embeddings_complete")` | persisted `retryable is False`; message/stage equal worker values; summary subdoc matches |
| TC-C3 | **rag-api fallback preservation (we changed nothing):** hand-crafted payload `{"error_message": …}` only → `error_stage is None`, `retryable is True`; payload `{}` → `error=="Processing failed"`; payload missing `stage` → summary `error.stage is None` | pins that rag-api's `.get()` fallbacks remain intact for non-worker publishers |
| TC-C4 | **rag-api-side drift guard (static/AST, house pattern):** parse `rag-api-service/main.py`, assert the failed branch reads `error_message`, `stage`, `retryable` and writes main `error`/`error_stage`/`retryable` + summary `error.{code,message,stage}` with `"UNKNOWN"` default | a rename/removal on the rag-api side fails the build even if fallbacks would mask it behaviorally; mirror the existing helper style in `test_api_contracts.py` (implementer matches in-file conventions at T0) |
| TC-C5 | **Legacy key tolerance:** worker payload (incl. `error`) through rag-api | no exception; no field persisted from the legacy key; `error` on the doc equals `error_message`'s value via the `error_message` read |
| TC-C6 | **Idempotent-ish re-failure:** run the failed-branch update twice on the same FakeDb | second run overwrites with identical values (no merge artifacts in main doc; summary merge-safe via `set(merge=True)`) |

### 4.4 Regression pins (existing, must keep passing untouched)

| ID | Case | Source |
|---|---|---|
| TC-R1 | Sweep still fails stale leases with `retryable is True` | `test_processing_lease.py::TestSweepRace` (unchanged file) |
| TC-R2 | `classify_error` behavior table | `test_utils.py::TestClassifyError` (unchanged file) |
| TC-R3 | Existing house contract tests unaffected by the new module's import bootstrap | `test_api_contracts.py` |

## 5. Acceptance mapping

| Definition acceptance | Covered by |
|---|---|
| Payload carries `error_message`/`stage`/`retryable`; no fallback reliance | TC-U1…U9, TC-U10…U14 |
| Persisted `error`/`error_stage`/`retryable` equal worker values | TC-C1, TC-C2 |
| Summary subdocument carries same message/stage | TC-C1, TC-C2 (and TC-C3 negative) |
| Contract test exists, passes, fails on either side's key drift | TC-U8 (worker exact set), TC-C4 (rag-api reads), TC-C1/C2 (behavioral round-trip catches renames/removals) |

## 6. What this plan deliberately does NOT test

- rag-api fallback *values* as a contract for workers (TC-C3 pins them only as "unchanged");
- ACK/NACK decisions, lease/heartbeat timing, backoff (mechanics out of scope; only retryability *reporting* changed);
- `error_code` taxonomy (none sent; `code=="UNKNOWN"` asserted only as rag-api's unchanged default inside TC-C1/C2);
- the sweep's write path beyond the existing TC-R1 pins;
- emulator-based end-to-end (optional manual; fakes satisfy acceptance).

## 7. Risks specific to testing

- **Stub over-masking:** only import-time deps are stubbed; the code paths under test (`_build_failure_details`, `classify_error`, failed-branch mapping, tracker) run for real. If a stub accidentally replaces logic under test (e.g. `tenacity.retry` no-op is fine; `firestore` stub must be monkeypatched per-test for `SERVER_TIMESTAMP`/`transactional`), the case fails visibly — verify via T0 notes.
- **Import-order flakiness:** purge-between-exec bootstrap (§3.1) isolates `models`; running `test_api_contracts.py` after the new file in the same session (TC-R3) catches residue.
- **Signature drift in `run_transactional_update`:** T0 records the signature; TC-C1/C2 call it directly, so any future signature change fails loudly rather than silently skipping the seam.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>