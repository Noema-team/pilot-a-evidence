<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (definition artifact `definition:obj-108`, sha256 `71f1c39c…`)
Intent: worker's failed-status payload must carry `error_message` / `stage` / `retryable` so rag-api persists the real error, failing stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

---

## 1. Summary

The worker's exception handler in `process_document` publishes a one-key failure payload (`{"error": str(e)}`); rag-api's failed branch in `run_transactional_update` reads three keys (`error_message`, `stage`, `retryable`). Net effect today: every worker-originated failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (silent default). The fix is entirely on the worker side: track the failing pipeline stage, derive `retryable` from the existing `classify_error()`, and publish the API's key names (retaining the legacy `error` key as a compatibility hedge). rag-api is verify-only — its failed branch already implements the target contract. A new contract test drives the worker's real payload construction through rag-api's real persistence path and asserts the persisted fields, with key-set drift guards on both sides.

## 2. Binding scope (from the authoritative definition)

Must:
- Align the **worker** to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema.
- No Firestore migration, field rename, or backfill; persisted fields stay `error`, `error_stage`, `retryable`.
- Every worker failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must never be the operative mechanism for worker failures.
- Stage names reuse the progress vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` (plus `completed`), with `"processing"` as the safe unknown-stage value.
- `retryable` derivation: `classify_error(e)` → transient ⇒ `true`; permanent (including unclassified-unknown, per `classify_error`'s conservative default) ⇒ `false`.
- A contract test covers worker failure-payload construction → rag-api failed-branch persistence, asserting persisted `error`/`error_stage`/`retryable` equal the worker's values, failing on key drift on either side.

Prefer / prefer-not:
- Retain legacy `error` key alongside `error_message` (compat hedge for unknown status-topic consumers).
- No structured error-code taxonomy; `error_code` stays `"UNKNOWN"` unless actually sent.

Non-goals (do not touch): stale-lease sweep's direct failure write; ACK/NACK policy, leases, heartbeats; frontend/mobile (`ResourceResponse` already exposes `error`/`error_stage`); error-code taxonomy; anything the unavailable companion D3 issue covers beyond this alignment.

## 3. Current state — verified evidence

Verified by direct repository read during investigation:

| Evidence | Location | What it establishes |
|---|---|---|
| `classify_error()` semantics | `apps/ai-server/rag-worker-service/main.py` (~lines 46–95) | `TransientError`→True; `PermanentError`→False; `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`→True; `httpx.HTTPStatusError` with 429/500/502/503/504→True, other HTTP→False; **unknown exceptions→False (conservative)**. Used for ACK/NACK in `run_worker`. |
| Worker config surface | `apps/ai-server/rag-worker-service/main.py` (`ProcessingConfig`) | Required env (aliases): `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_PROJECT_ID`, `GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `RAG_PROCESS_SUB`, `RAG_STATUS_TOPIC`, `SHARED_INTERNAL_TOKEN`, `WEAVIATE_SERVICE_URL`; optionals incl. `WEAVIATE_API_KEY`, Langfuse keys. Relevant for stubbing env in tests. |
| Persisted failure schema | `apps/ai-server/rag-api-service/models/resource.py` | `Resource` dataclass: `error: Optional[str]`, `error_stage: Optional[str]`, `retryable: bool = True`; round-tripped in `to_dict()`/`from_dict()`; doc path `/users/{userId}/resources/{resourceId}`. |
| House contract-test patterns | `apps/ai-server/tests/integration/test_api_contracts.py` | Imports `main as rag_api_main` directly; fixture JSONs under `tests/fixtures/api-contracts/`; AST shape extraction via subprocess; field-set assertions (e.g. `MOBILE_RESOURCE_FIELDS` includes `error`, `error_stage`); `TestContractFixturesIntegrity`. |
| Separate status subsystem (out of scope) | `apps/ai-server/rag-worker-service/utils/status_updater.py`, `models/processing_status.py` | A distinct Firestore status-tracking path (`users/{u}/courses/{c}/courseResources/{r}`) with its **own** `ProcessingStage` vocabulary (`pdf_download`, `text_extraction`, …). Not the payload path in scope — do not conflate its stage names with the progress vocabulary mandated by the definition. |
| Test scaffolding exists | `apps/ai-server/tests/integration/conftest.py` (present, contents not read); `rag-worker-service/tests/unit/` (9 unit test files); `rag-worker-service/tests/integration/` (empty except `__init__.py`); `pytest.ini` in both services; `docker-compose.yml` at `apps/ai-server/` | Where new tests live and which config files exist. |

Binding facts taken from the authoritative definition (treated as verified; corroborated by the reads above where possible):
- **F3**: worker publishes failed status with `details={"error": str(e)}` from `process_document`'s exception handler via `_publish_status_update`.
- **F4**: rag-api's failed branch reads `details` keys `error_message`, `stage`, `retryable`; persists `error`, `error_stage`, `retryable` on the main resource document; writes `message`/`stage` (with `error_code` defaulting `"UNKNOWN"`) into the processing/summary subdocument.
- **F5**: net effect today is fallback `"Processing failed"` / `None` / `True`.
- **F6**: `error`/`error_stage`/`retryable` is the established schema across the stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths, `ResourceResponse`, and `Resource`.
- **F9**: worker publishes progress stages `starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete, completed`; the failure handler has no stage tracking today.
- **F10**: both services have `FIRESTORE_EMULATOR_HOST` hermetic branches; contract-test infrastructure exists.

Unverified — must be confirmed at implementation time (do not assume):
- Whether `rag-worker-service/main.py` performs module-scope initialization (Firebase/Pub/Sub init, `ProcessingConfig()` instantiation) that would make it non-hermetic to import in tests, and what `tests/integration/conftest.py` currently sets up.
- Exact signatures/bodies of `_publish_status_update` (worker) and `run_transactional_update` (rag-api) — trusted via F3/F4 but must be re-read immediately before editing/testing.
- Whether `docker-compose.yml` already provides a Firestore emulator service.

## 4. Design

### 4.1 Target worker failure payload

The exception handler in `process_document` builds, via a single module-level builder:

```python
{
    "error_message": str(e),        # NEW — actual exception message
    "stage": current_stage,         # NEW — tracked stage; "processing" fallback
    "retryable": classify_error(e), # NEW — deliberately derived, always present
    "error": str(e),                # RETAINED — legacy key, compat hedge (definition prefer-constraint)
}
```

The surrounding envelope (`status="failed"`, topic routing via `_publish_status_update`) is unchanged; only the `details` dict gains keys. rag-api's failed branch then persists, unchanged: main doc `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`; processing/summary subdoc `message`/`stage` with `error_code="UNKNOWN"`.

### 4.2 Stage tracking in `process_document`

- Add a local `current_stage: str = "processing"` at the top of the try block.
- Immediately **before each pipeline step's await**, assign `current_stage = "<stage>"` using the same name that step's progress publish uses (F9 vocabulary). Convention comment in code: *"set current_stage immediately before the await it describes"* — this is the anti-drift convention the definition mandates.
- The exception handler reports `current_stage`; the builder normalizes any falsy stage to `"processing"` (defensive; matches the stale-lease sweep's `error_stage` value, so `error_stage` never regresses to null).
- Do **not** use the `ProcessingStage` enum from `models/processing_status.py` — that is the separate status-updater subsystem with a different vocabulary; the binding requirement pins the progress vocabulary.

### 4.3 `retryable` derivation

- `retryable = classify_error(e)` in the handler. Mapping (verified semantics): transient exception types / 429+5xx HTTP → `True`; `PermanentError`, other 4xx, and unclassified-unknown → `False`.
- **Deliberate behavior change**: unclassified-unknown exceptions previously persisted `retryable=True` via rag-api's silent default; they will now persist `False`. Accepted per definition F8 — this matches the worker's actual ACK behavior (unknown ⇒ acked, no redelivery; manual reprocess via `POST /process` remains).
- The stale-lease sweep's separate `retryable=true` write is untouched and stays correct (dead worker = transient condition).

### 4.4 rag-api side — verify-only

Zero code changes expected. Implementation includes a read-back verification of `run_transactional_update`'s failed branch confirming exactly F4's behavior (three reads, three main-doc writes, subdoc `message`/`stage`, `error_code` default `"UNKNOWN"`). If verification finds any deviation, fix it minimally **against this contract** — no schema, reader, or naming changes.

### 4.5 Payload builder placement

- Primary: add `_build_failure_payload(exc: Exception, stage: str) -> dict` at module level in `rag-worker-service/main.py`; the exception handler is its only caller. Single source of truth; the contract test imports the worker's real construction path.
- Contingency (only if direct import of worker `main.py` proves non-hermetic in tests despite stubbed env — see §3 unknowns): move the builder plus a `FAILURE_STAGES` constant tuple into `rag-worker-service/failure_payload.py`, imported by `main.py`, and add the AST guard from §5 Step 6 (DG-3) so a handler that bypasses the builder fails the build. Decide after attempting the direct-import route.

## 5. Implementation steps

**Step 1 — Stage tracker** (`apps/ai-server/rag-worker-service/main.py`, `process_document`)
- Re-read `process_document` and its `_publish_status_update` calls (F3/F9) to map each pipeline step to its progress-stage name.
- Initialize `current_stage = "processing"`; insert an assignment before each step's await mirroring the progress vocabulary.
- Done when: every pipeline step in the try block is preceded by a tracker assignment; no step is reachable without one.

**Step 2 — Payload builder + handler wiring** (same file)
- Add `_build_failure_payload(exc, stage)` returning the §4.1 dict (normalizing falsy `stage` → `"processing"`; `retryable=classify_error(exc)`; legacy `error` key = `str(exc)`).
- Replace the handler's `details={"error": str(e)}` with `details=_build_failure_payload(e, current_stage)`.
- Done when: the handler no longer constructs payload keys inline; grep shows no other `details=` failure construction in `process_document`.

**Step 3 — rag-api verification (read-only)** (`apps/ai-server/rag-api-service/main.py`)
- Re-read `run_transactional_update`'s failed branch; confirm F4 exactly. Record confirmation in the PR description. Expected diff: none.

**Step 4 — Worker unit tests** (`apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`, new)
- Cases U-1…U-6 per test plan (transient/permanent/unknown/HTTP-status mapping, legacy-key parity, stage normalization).
- Env stubs from the verified `ProcessingConfig` field list if module import requires them.

**Step 5 — Contract test** (`apps/ai-server/tests/integration/test_failure_payload_contract.py`, new; sibling of `test_api_contracts.py`, same conventions)
- Import both sides (worker builder; `rag_api_main.run_transactional_update`), drive worker payload → api failed branch → Firestore emulator (primary) or fakes (fallback), assert persisted `error`/`error_stage`/`retryable` and the processing/summary subdoc. Cases CT-1…CT-5 per test plan.
- Extend `tests/integration/conftest.py` with env stubs / emulator fixture as needed (its current contents are unverified — inspect first, extend minimally).

**Step 6 — Drift guards** (inside the contract-test file)
- DG-1: exact worker payload key set assertion.
- DG-2: explicit negative assertions in CT cases (`error != "Processing failed"`, `error_stage is not None`) so api-side key drift fails loudly.
- DG-3: AST guard that `process_document`'s exception handler references `_build_failure_payload` (guards handler bypassing the builder; mandatory if the §4.5 contingency is used, cheap regardless).
- DG-4 (optional, house-style): AST scan of rag-api's failed branch for the three `details` reads. CT runtime assertions already catch api-side drift; DG-4 only improves failure messages.

**Step 7 — Stage-tracking tests + full run** (`apps/ai-server/rag-worker-service/tests/unit/test_stage_tracking.py`, new)
- Cases S-1…S-4 per test plan (early-stage failure, late-stage failure, pre-first-step failure → `"processing"`, handler→builder integration).
- Run all new tests plus the existing suites (`test_api_contracts.py`, worker unit suite, rag-api integration suite) to confirm no regressions.

## 6. Files touched

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Stage tracker in `process_document`; `_build_failure_payload`; handler wiring. Only production code change. |
| `apps/ai-server/tests/integration/test_failure_payload_contract.py` | **New** — contract test CT-1…CT-5 + drift guards DG-1…DG-4. |
| `apps/ai-server/tests/integration/conftest.py` | Extend (minimally) with env stubs / Firestore-emulator fixture — after inspecting current contents. |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | **New** — builder unit tests U-1…U-6. |
| `apps/ai-server/rag-worker-service/tests/unit/test_stage_tracking.py` | **New** — tracker tests S-1…S-4. |
| `apps/ai-server/rag-api-service/main.py` | None expected (verify-only, Step 3). |
| `apps/ai-server/rag-worker-service/failure_payload.py` | Only if §4.5 contingency triggers. |

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic reading the old key set | Legacy `error` key retained (binding prefer-constraint); residual risk accepted as low per definition. |
| Stage-tracker drift as pipeline evolves | "Set before the await" convention + code comment; S-1/S-2 representative-stage tests; contract test pins the mechanism without ossifying every step. |
| `retryable=false` for unrecognized-but-genuinely-transient errors | Accepted per definition; manual reprocess via `POST /process` unaffected; widening `classify_error` is out of scope. |
| Contract test ossifies the payload | Intentional — that is the drift guard. Adding a key later means touching DG-1, which is the point. |
| Worker `main.py` import side effects break hermetic tests (unverified) | Stub the verified required env vars in conftest; if still non-hermetic, invoke §4.5 contingency (pure helper module + DG-3 AST guard). |
| `run_transactional_update` signature details unverified | Step 3 re-read before writing CT; emulator path preferred because it exercises the real transaction semantics. |

## 8. Acceptance criteria mapping

| Definition acceptance | Satisfied by |
|---|---|
| Worker failure payload contains `error_message`/`stage`/`retryable`, none relying on api fallbacks | Steps 1–2; U-1…U-6, CT-5, DG-1 |
| Persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = worker-derived | CT-1…CT-3, DG-2 |
| processing/summary error subdocument carries same message and stage | CT-4 |
| Contract test exists, passes, fails on either side's key drift | Step 5 + DG-1…DG-4 |

## 9. Definition of done

- [ ] All four acceptance criteria demonstrably met by passing tests listed above.
- [ ] `rag-api-service` diff is empty (or, if Step 3 found drift, a minimal contract-conforming fix with justification).
- [ ] No changes to: sweep, ACK/NACK/lease/heartbeat mechanics, `ResourceResponse`, frontend, error-code taxonomy.
- [ ] Existing suites green: `tests/integration/test_api_contracts.py`, worker unit suite, rag-api integration suite.
- [ ] Behavior change documented in PR: unclassified-unknown failures now persist `retryable=false`.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan — worker→rag-api failure payload contract

Scope: verify the failure payload contract end-to-end (worker construction → rag-api persistence), pin it against key drift on both sides, and cover the new stage tracker and `retryable` derivation at unit level. Everything else (ACK/NACK mechanics, sweep, frontend, error codes) is explicitly untested here — non-goals per the binding definition.

---

## 1. Core anti-drift property

The contract test must **build the payload through the worker's real code path and persist it through rag-api's real code path** — never restate the contract in a hand-written fixture dict. If the worker renames a key, rag-api persists fallbacks and the test fails; if rag-api renames a read key, same result. A fixture dict would make both drifts invisible. This mirrors the house pattern in `tests/integration/test_api_contracts.py`, which imports `main as rag_api_main` rather than duplicating model shapes.

## 2. Test layers

| Layer | Location | What it proves |
|---|---|---|
| L1 — builder units | `rag-worker-service/tests/unit/test_failure_payload.py` | `_build_failure_payload` key set, `retryable` mapping, legacy-key parity, stage normalization. |
| L2 — stage tracking | `rag-worker-service/tests/unit/test_stage_tracking.py` | `process_document` reports the true failing stage through the real handler path (representative early/late stages + unknown fallback). |
| L3 — contract test (mandated) | `apps/ai-server/tests/integration/test_failure_payload_contract.py` | Worker payload → rag-api `run_transactional_update` failed branch → persisted `error`/`error_stage`/`retryable` + processing/summary subdoc. |
| L4 — drift guards | inside L3 file | Exact worker key set; handler-uses-builder AST guard; optional api-side AST scan. |

## 3. Test cases

### L1 — `_build_failure_payload` units (U-x)

| ID | Given / When / Then |
|---|---|
| U-1 | `httpx.ConnectError("upstream unavailable")`, stage `"text_retrieved"` → payload `retryable is True`, `error_message == "upstream unavailable"`, `stage == "text_retrieved"`. |
| U-2 | `PermanentError("invalid document structure")`, stage `"summary_generated"` → `retryable is False`. |
| U-3 | `ValueError("boom")` (unclassified-unknown) → `retryable is False` — **pins the deliberate behavior change** (was silent `True` via api default). |
| U-4 | `httpx.HTTPStatusError` with response status 500 → `True`; with 404 → `False` (pins the verified status-code heuristics). |
| U-5 | Legacy parity: `payload["error"] == payload["error_message"] == str(exc)` for all cases. |
| U-6 | Stage normalization: falsy/`None` stage → `"processing"` (never `None`, never empty string). |

### L2 — stage tracking through `process_document` (S-x)

Monkeypatch the pipeline collaborators so a chosen step raises; invoke `process_document` and capture the payload passed to `_publish_status_update` (patch the publisher).

| ID | When | Then |
|---|---|---|
| S-1 | First tracked pipeline step raises `httpx.ConnectError` | published `stage` equals that step's progress-stage name (early-stage representative, e.g. `text_retrieved`); `retryable is True`. |
| S-2 | Late pipeline step (embeddings) raises `PermanentError` | `stage == "embeddings_complete"`; `retryable is False`. |
| S-3 | Failure inside the try block before any tracker assignment | `stage == "processing"` (fallback; never `None`). |
| S-4 | Any failure path | published payload contains exactly the builder's keys — proves the handler routes through `_build_failure_payload` (bridges L2→L1; complements DG-3). |

Note: importing worker `main.py` requires the verified `ProcessingConfig` env vars (see §5). If module-scope init defeats env stubbing, invoke the plan's §4.5 contingency and re-point L1/L2 imports accordingly — L2's monkeypatch approach is unchanged.

### L3 — contract test (CT-x)

Setup: import worker builder (or drive L2-style handler capture — preferred if import is hermetic, since it exercises the *handler*, not just the builder); import `rag_api_main`; seed a resource document at `/users/{userId}/resources/{resourceId}` (verified path from `models/resource.py`); drive `run_transactional_update`'s failed branch with `status="failed"` and the worker payload; read back the persisted document.

| ID | Worker payload under test | Assert persisted on main doc | Assert subdoc |
|---|---|---|---|
| CT-1 | transient, early stage: `httpx.ConnectError("weaviate connection refused")`, stage `"text_retrieved"` | `error == "weaviate connection refused"`, `error_stage == "text_retrieved"`, `retryable is True` | — |
| CT-2 | permanent, late stage: `PermanentError("corrupt pdf stream")`, stage `"embeddings_complete"` | `error == "corrupt pdf stream"`, `error_stage == "embeddings_complete"`, `retryable is False` | — |
| CT-3 | unknown: `ValueError("unexpected shape")`, stage `"chunking_complete"` | `retryable is False` (pins behavior change), message/stage persisted verbatim | — |
| CT-4 | (each of CT-1…CT-3) | — | processing/summary error subdoc: `message ==` main-doc `error`, `stage ==` main-doc `error_stage`, `error_code == "UNKNOWN"` |
| CT-5 | (pre-assertion on the payload itself) | payload contains all of `error_message`, `stage`, `retryable`, `error` before touching rag-api — proves no reliance on api fallback defaults | — |

Anti-fallback negatives folded into CT-1…CT-3: `error != "Processing failed"`, `error_stage is not None`, `retryable` key was explicitly present.

### L4 — drift guards (DG-x)

| ID | Mechanism | Assertion |
|---|---|---|
| DG-1 | Direct (import worker builder) | `set(payload.keys()) == {"error_message", "stage", "retryable", "error"}` — exact set; any addition/removal fails with a message naming the diff. |
| DG-2 | Runtime (CT-1…CT-3) | api-side read-key drift surfaces as fallback persistence → explicit negative assertions fail loudly. |
| DG-3 | AST scan of `rag-worker-service/main.py` (house subprocess/AST pattern from `test_api_contracts.py`) | `process_document`'s exception handler references `_build_failure_payload` — guards a future handler edit that bypasses the builder. Mandatory if the helper-module contingency is used. |
| DG-4 | Optional AST scan of rag-api `main.py` failed branch | `details.get("error_message")`, `details.get("stage")`, `details.get("retryable")` present. CT runtime coverage already catches drift; DG-4 only improves the failure message. Implement only if cheap under the existing AST helpers. |

## 4. What is deliberately not tested

- Stale-lease sweep behavior, Pub/Sub ACK/NACK policy, leases, heartbeats (non-goals).
- rag-api enqueue-failure paths beyond what CT already touches incidentally.
- Frontend/mobile response shapes (existing `test_api_contracts.py` coverage is untouched and must stay green).
- Error-code taxonomy (`error_code == "UNKNOWN"` is asserted as-is in CT-4; no new codes introduced).
- The separate `status_updater.py` / `models/processing_status.py` subsystem — different path, different vocabulary, out of scope.

## 5. Environment & fixtures

- **Firestore emulator (primary for L3)**: both services have `FIRESTORE_EMULATOR_HOST` hermetic branches (definition F10). Fixture sets `FIRESTORE_EMULATOR_HOST`, ensures an emulator is running (check `apps/ai-server/docker-compose.yml` for an existing service before adding one), seeds the resource doc, tears down per test. If the emulator cannot run in a given CI context, fall back to minimal fakes of the transaction/document surface that `run_transactional_update` actually uses — build the fake **against its real body** (re-read in plan Step 3), not against an assumed signature.
- **Worker import env stubs** (L1/L2, and worker side of L3): set dummy values for the verified required vars — `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_PROJECT_ID`, `GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `RAG_PROCESS_SUB`, `RAG_STATUS_TOPIC`, `SHARED_INTERNAL_TOKEN`, `WEAVIATE_SERVICE_URL` — before importing `rag-worker-service/main.py`. Inspect `apps/ai-server/tests/integration/conftest.py` first (contents unverified) and extend the existing import-path/env mechanism rather than inventing a parallel one.
- **Isolation**: no real GCP credentials anywhere; tests must pass offline except for the emulator process.

## 6. Commands

```bash
# from apps/ai-server/
python -m pytest tests/integration/test_failure_payload_contract.py -v
python -m pytest tests/integration/test_api_contracts.py -v          # regression: existing contracts

# from apps/ai-server/rag-worker-service/ (has its own pytest.ini)
python -m pytest tests/unit/test_failure_payload.py tests/unit/test_stage_tracking.py -v

# rag-api regression (verify-only change should not move these)
cd apps/ai-server/rag-api-service && python -m pytest tests/ -v
```

## 7. Acceptance mapping

| Definition acceptance | Tests |
|---|---|
| Payload carries `error_message`/`stage`/`retryable`, no fallback reliance | U-1…U-6, CT-5, DG-1, DG-3 |
| Persisted `error`/`error_stage`/`retryable` = worker values | CT-1…CT-3 (+DG-2 negatives) |
| processing/summary subdoc carries same message and stage | CT-4 |
| Contract test exists, passes, fails on either side's key drift | CT-1…CT-5, DG-1…DG-4 |

## 8. Testing unknowns / implementation-time checks

- Contents of `apps/ai-server/tests/integration/conftest.py` and import-path mechanics for worker `main.py` (rag-api main import is proven by the existing contract test; worker main import is not).
- Module-scope side effects in `rag-worker-service/main.py` (Firebase/Pub/Sub init) — determines primary vs. contingency import strategy (plan §4.5).
- Exact body/signature of `run_transactional_update` and of `_publish_status_update` — re-read before writing CT and S tests; trusted via definition F3/F4 until then.
- Whether a Firestore emulator service already exists in `apps/ai-server/docker-compose.yml`.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>