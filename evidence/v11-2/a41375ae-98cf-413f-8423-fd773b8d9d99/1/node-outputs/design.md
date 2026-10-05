<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- Cycle: `a41375ae-98cf-413f-8423-fd773b8d9d99` (iteration 1, step: design)
- Authority: WorkItem `wi-define-108-a8`, Definition artifact `definition:obj-108` (sha256 `71f1c39c…`). This document refines that Definition with verified repository evidence. It never widens, narrows, or reinterprets it. Where this document and the Definition disagree, the Definition wins.

## 1. Problem statement (verified)

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test covers the seam.

Verified current behavior:

- **Worker publisher** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler): publishes status `"failed"` with details `{"error": str(e)}` — a single key.
- **API consumer** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update`, failed branch): reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`; persists them on the main resource document as `error`, `error_stage`, `retryable`; and writes `processing/summary` with top-level `stage` (default `"unknown"`) and an `error` subdocument `{code: details.get("error_code", "UNKNOWN"), message: details.get("error_message", "Processing failed"), stage: details.get("stage")}`.
- **Consequence**: every worker-originated failure persists `error = "Processing failed"` (fallback string), `error_stage = None`, and `retryable = True` (silent default). The `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures.
- **Established schema**: `error` / `error_stage` / `retryable` are already written consistently by the worker's stale-lease sweep (`_fail_if_still_stale` writes `error_stage: "processing"`, `retryable: True`) and by rag-api's enqueue-failure paths, and are exposed by the `Resource` model and `ResourceResponse` (`apps/ai-server/rag-api-service/models/resource.py`; `retryable` defaults `True`). The worker's status publisher is the only non-conforming writer.
- **Retry machinery already exists**: the worker classifies every exception via `classify_error()` (`TransientError`/`PermanentError` plus type- and status-code heuristics; unknown exceptions conservatively classify as permanent) and uses that classification for ACK/NACK decisions in `run_worker`.

## 2. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

Fix direction (binding): the **worker** aligns to rag-api's existing contract (`error_message` / `stage` / `retryable`). rag-api's reads and persisted schema are **not** changed. No Firestore migration, field rename, or backfill.

## 3. Functional requirements

### FR-1 — Worker failure payload contract (must)

When document processing fails, the worker's failed status payload `details` MUST contain exactly these worker-supplied keys:

| Key | Value | Type |
|---|---|---|
| `error_message` | the actual exception message (`str(e)`) | string |
| `stage` | the pipeline stage executing at failure time (see FR-2) | string |
| `retryable` | deliberately derived (see FR-4) | bool |
| `error` | `str(e)` — legacy key, retained (see FR-6) | string |

The payload MUST NOT rely on rag-api's fallback defaults for `error_message`, `stage`, or `retryable`: after this change, a worker failure persisted as `"Processing failed"` / `null` stage / defaulted `retryable` is a bug.

*Anchor*: current handler publishes `{"error": str(e)}` — verified. `_publish_status_update` additionally injects `jobId` into details when a job id is present; that behavior is unchanged and harmless (rag-api reads `jobId` only in the `processing` branch).

### FR-2 — Stage tracking in `process_document` (must)

The worker MUST track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.

- Stage names MUST reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown (e.g., failure before the first stage transition, such as a validation failure). It matches the value the stale-lease sweep already writes for `error_stage`, so the field never regresses to null.
- Convention: the tracker is set immediately before the corresponding pipeline step's `await`, so an exception raised inside a step reports that step.

### FR-3 — Persistence passthrough (rag-api; pinned, unchanged)

rag-api's failed branch MUST persist worker-provided values unchanged:

- main document: `error` ← payload `error_message`; `error_stage` ← payload `stage`; `retryable` ← payload `retryable`.
- `processing/summary`: top-level `stage` ← payload `stage`; `error.message` ← payload `error_message`; `error.stage` ← payload `stage`; `error.code` remains `"UNKNOWN"` unless a code is actually sent.

**Verified**: rag-api's current `run_transactional_update` failed branch already implements exactly this mapping. Therefore FR-3 requires **no rag-api code change** — it is a pinning requirement enforced by FR-5. The `details.get("retryable", True)` fallback remains in the API for any publisher that omits the key, but it MUST NOT be the operative mechanism for worker failures (guaranteed by FR-1/FR-4).

### FR-4 — retryable derivation (must)

The worker MUST derive `retryable` explicitly from `classify_error(e)` — the same classifier `run_worker` uses for ACK/NACK decisions:

| Exception at failure time | `classify_error` | persisted `retryable` |
|---|---|---|
| `TransientError` instance | transient | `true` |
| `PermanentError` instance | permanent | `false` |
| `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | transient | `true` |
| `httpx.HTTPStatusError` with status 429/500/502/503/504 | transient | `true` |
| `httpx.HTTPStatusError` with any other 4xx | permanent | `false` |
| any other (unclassified-unknown) exception | permanent (conservative default) | `false` |

Deliberate behavior change (accepted per Definition F8): unclassified-unknown exceptions previously persisted `retryable: true` via the silent default; they will now persist `false`, matching `classify_error`'s conservative default. Manual reprocess via `POST /process` (`failed` → `queued` is an allowed transition, verified in `ALLOWED_TRANSITIONS`) is unaffected.

### FR-5 — Contract test with drift guard (must)

A contract test MUST cover the worker failure → rag-api persistence path:

- It MUST exercise the worker's failure-payload construction (call the worker's payload-building code) and rag-api's failed-branch persistence (`run_transactional_update` against the Firestore emulator or fakes).
- It MUST assert the persisted `error`, `error_stage`, and `retryable` equal the worker's payload values — including a `retryable: false` scenario, so the API-side `True` fallback cannot mask a missing key.
- It MUST assert the `processing/summary` error subdocument carries the same message and stage as the main document.
- It MUST fail if either side's payload keys drift: a static key-set guard (fixture/AST pattern per `apps/ai-server/tests/integration/test_api_contracts.py`) pins the worker's payload keys and rag-api's failed-branch reads, and runs without the emulator.
- It MUST cover a representative early-stage failure and a representative late-stage failure (pins the stage-tracker mechanism without ossifying every step).
- The emulator-backed layer is part of the required hermetic test run; in environments without the emulator it skips with an explicit reason rather than silently passing.

### FR-6 — Legacy key retention (prefer → adopted)

The worker retains the legacy `error` key (value `str(e)`) alongside `error_message` in the failure payload, as a hedge for any unknown consumer of the status topic and for log tooling. rag-api ignores it (verified: the failed branch reads only its three keys). Dropping the duplicate later is trivial cleanup if an audit confirms rag-api is the only consumer.

## 4. Contract specification

### 4.1 Failure payload (worker → status topic, `status: "failed"`)

```json
{
  "error_message": "<actual exception message>",
  "stage": "<failing pipeline stage>",
  "retryable": <bool, derived via classify_error>,
  "error": "<actual exception message>"
}
```

Envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`) and `_publish_status_update` mechanics (sequence numbering, terminal-state reset, lease heartbeat) are unchanged.

### 4.2 Stage vocabulary and tracker mapping

| Pipeline step in `process_document` | tracker value set before the step |
|---|---|
| (function entry) | `"processing"` |
| `_validate_processing_request` (pre-first-transition) | `"processing"` (initial value) |
| initial status publish (`stage: "starting"`) | `"starting"` |
| `_get_extracted_text` | `"text_retrieved"` |
| `content_tagger.generate_tags` | `"tagging_complete"` |
| `generate_document_summary` + `ragDescription` Firestore write | `"summary_generated"` |
| `_create_enhanced_chunks` | `"chunking_complete"` |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |
| vector-swap / finalization tail (`delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save, final publish, usage, map) | remains `"embeddings_complete"` (see Architecture §5.3) |

### 4.3 Persistence mapping (rag-api, verified conformant)

| Payload key | Main document field | `processing/summary` |
|---|---|---|
| `error_message` | `error` | `error.message` |
| `stage` | `error_stage` | top-level `stage`; `error.stage` |
| `retryable` | `retryable` | — |
| *(absent)* | — | `error.code` = `"UNKNOWN"`; `progress` = 0 (unchanged) |

## 5. Constraints (binding, from the Definition)

- **must**: align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema.
- **must_not**: no Firestore migration, field rename, or backfill; persisted fields keep their names (`error`, `error_stage`, `retryable`) and semantics.
- **must**: every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be operative for worker failures.
- **prefer**: retain the legacy `error` key alongside `error_message` (adopted as FR-6).
- **prefer_not**: no structured error-code taxonomy; `error_code` stays `"UNKNOWN"` unless actually sent.

## 6. Non-goals (out of scope)

- Changing the stale-lease sweep's direct failure write (already conformant, including its `retryable: true` — a dead worker is a transient condition).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error`/`error_stage`.
- Introducing structured error codes or a failure taxonomy.
- Widening `classify_error`'s heuristics.
- Anything the companion D3 issue covers beyond this payload alignment (its scope is unavailable here — Definition F12), and reconciling with the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## 7. Acceptance criteria

| # | Criterion (from Definition) | Verification |
|---|---|---|
| AC-1 | A failed job's published status message contains `error_message` (actual message), `stage` (failing stage), `retryable` (derived) — none relying on rag-api's fallbacks. | Worker unit tests on payload construction + stage tracker (early and late failure); contract-test key-set guard. |
| AC-2 | Persisted resource document has `error` = actual message (not `"Processing failed"`), `error_stage` = failing stage (not `None`), `retryable` = derived value. | Contract test, emulator layer: worker payload → `run_transactional_update` → read back main document. |
| AC-3 | `processing/summary` error subdocument carries the same message and stage as the main document. | Contract test, emulator layer: read back `processing/summary`. |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes, failing if either side's payload keys drift. | New contract test (static drift-guard layer always runs; emulator layer runs in the hermetic stack). |

## 8. Traceability

| Fact | Addressed by |
|---|---|
| F1 (product intent: persist real message/stage/retryable) | FR-1, FR-2, FR-4 |
| F2 (preferred direction: worker aligns) | §2, FR-3 |
| F3 (worker publishes `{"error": str(e)}`) | §1, FR-1 |
| F4 (rag-api reads error_message/stage/retryable) | §1, FR-3 |
| F5 (fallbacks land today) | §1, AC-2 |
| F6 (established persisted schema) | §1, FR-3 |
| F7 (classify_error + ACK/NACK) | FR-4 |
| F8 (adopted retryable default) | FR-4 |
| F9 (stage vocabulary exists; no failure-stage tracking) | FR-2 |
| F10 (contract-test infra + emulator modes) | FR-5 |
| F11 (legacy `error` key hedge) | FR-6 |
| F12 (companion D3 issue; plans/upload-flow.md absent) | §6 non-goals, §9 |

## 9. Unknowns and deferred items (carried honestly)

- Contents of `apps/ai-server/rag-worker-service/exceptions.py`, `subscribers/`, `models/`, and `tests/conftest.py` were **not read** in this pass; the implementation must reconcile the new leaf module with any existing exception definitions there (possible duplication with the classes defined in `main.py`).
- Whether any rag-api enqueue-failure publisher omits `retryable` in its status details was not verified; irrelevant to this fix — the API-side fallback stays as-is (non-goal to change).
- Other consumers of the status topic are unknown; mitigated by FR-6.
- How the hermetic stack (`apps/ai-server/docker-compose.yml`, contents not read) exposes `FIRESTORE_EMULATOR_HOST` to pytest is an implementation-time wiring detail.
- `plans/upload-flow.md` (D4 deviation note) is not in the tree; reconciliation deferred per F12.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

Cycle: `a41375ae-98cf-413f-8423-fd773b8d9d99` · step: design · authority: `definition:obj-108` (sha256 `71f1c39c…`)

## 1. Context: the seam today (verified)

```
rag-worker                                Pub/Sub                        rag-api
process_document                          rag-status topic               _process_status_message
  └─ except: publish("failed",              │  envelope: user_id,            └─ path resolution (canonical
               {"error": str(e)})  ────────┘  course_id, resource_id,          vs legacy course path)
                                              status, details, …              └─ run_transactional_update
                                                                                  failed branch reads:
                                                                                    error_message / stage / retryable
                                                                                  persists: error / error_stage /
                                                                                    retryable + processing/summary
```

The worker publishes one key (`error`); the API reads three (`error_message`, `stage`, `retryable`). Result: every worker failure persists `"Processing failed"` / `None` / `True`, and `processing/summary.error` inherits the fallbacks with `code: "UNKNOWN"`.

Three other write paths already speak the persisted schema — the worker's stale-lease sweep (`_fail_if_still_stale` → `error` / `error_stage: "processing"` / `retryable: True`) and rag-api's enqueue-failure paths — and `Resource` / `ResourceResponse` expose it. **The worker's status publisher is the odd one out; fix the odd one out.** Changing the API side would ripple across all of those; aligning the worker ripples nowhere and needs no migration.

## 2. Design principles

1. **Worker aligns to the API.** rag-api's failed branch is verified conformant; it gets zero functional changes and is pinned by the contract test.
2. **Derive, don't default.** `retryable` comes from `classify_error(e)` — the same classifier `run_worker` uses for ACK/NACK — so the persisted record and the worker's retry semantics share one source of truth. Note on placement: `process_document` handles its own pipeline exceptions and publishes the failure status itself (verified — pipeline exceptions do not escape to `run_worker`), so the derivation lives in the `process_document` exception handler, feeding the same `_publish_status_update` path.
3. **One construction point.** A single pure function builds the failure payload; both the worker handler and the contract test call it.
4. **Closed vocabulary.** Stage values are the existing progress-stage names plus the safe value `"processing"`.
5. **Pin the seam.** The contract test imports both sides rather than restating the contract in a fixture; a key-set drift guard turns silent contract drift into a red build.

## 3. Target data flow

```
process_document (worker)
  │ current_stage = "processing"                       ← tracker init
  │ … set current_stage before each pipeline step …    ← §4.2 mapping
  ▼ exception raised at step N
except handler:
  payload = build_failure_payload(e, current_stage)
      → {"error_message": str(e), "stage": current_stage,
         "retryable": classify_error(e), "error": str(e)}
  log("document_processing_failed", …, stage=…, retryable=…)   ← observability
  _publish_status_update(…, "failed", payload, job_id)
      → unchanged mechanics: jobId injection, sequence number,
        terminal-state sequence reset, lease heartbeat merge
                    │
                    ▼ (Pub/Sub rag-status topic)
_process_status_message (rag-api)  — unchanged
  └─ run_transactional_update(db, doc_ref, "failed", details, …)  — unchanged
        main doc:      error ← error_message; error_stage ← stage; retryable ← retryable
        processing/summary: stage ← stage; error ← {code: "UNKNOWN",
                            message ← error_message, stage ← stage}
```

Transition legality (verified): the claim sets status `"processing"`, and `ALLOWED_TRANSITIONS` permits `processing → failed`; manual reprocess uses `failed → queued`.

## 4. Component design

### 4.1 Worker: leaf contract module

Extract the failure-contract logic into a leaf module in `rag-worker-service` (candidate hosts: extend the existing `exceptions.py` — contents unverified this pass — or a new sibling such as `failure_payload.py`). Hard requirement: the module must be importable with **only stdlib + `httpx`** (no firebase/pubsub/langchain imports), because `main.py` has heavy import-time side effects (requires `GCP_PROJECT`, raises without `GOOGLE_APPLICATION_CREDENTIALS`, constructs a Pub/Sub subscriber at module scope — all verified).

Contents (moved, not duplicated; `main.py` imports them back with identical names so behavior is unchanged):

- `ProcessingError`, `TransientError`, `PermanentError`
- `classify_error(e)` — byte-for-byte the verified heuristic table
- `UNKNOWN_STAGE = "processing"`
- `build_failure_payload(exc: Exception, stage: str | None) -> dict` returning:
  ```python
  {
      "error_message": str(exc),
      "stage": stage or UNKNOWN_STAGE,   # guard against empty/None
      "retryable": classify_error(exc),  # deliberate derivation, never a default
      "error": str(exc),                 # legacy key, retained (FR-6)
  }
  ```

`main.py` uses a plain sibling import (`from failure_payload import …`), which works both when run as a script and when imported as module `main` by tests (the pattern `tests/integration/conftest.py` already uses for rag-api).

### 4.2 Worker: stage tracker in `process_document`

A local variable, per the Definition ("track the currently executing pipeline stage through `process_document`"):

- Initialized to `"processing"` at function entry.
- Set immediately before each step's `await`, per the mapping in `docs/requirements.md` §4.2. The value names the step about to execute, so an exception inside it reports that step (`text_retrieved` = "failed in the text-retrieval step", etc.). This reuses the exact vocabulary clients already see in the progress timeline.
- Failure during `_validate_processing_request` (before the first transition) reports the initial `"processing"` — the Definition's safe value, and consistent with the sweep's `error_stage` so the field never regresses to null.
- **Tail rule (explicit decision):** the post-embeddings steps (`delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save, final publish, usage, map) have no vocabulary name, so the tracker keeps `"embeddings_complete"` — the last milestone reached. Rationale: regressing to `"processing"` would discard the true signal that everything through embeddings succeeded, and `"embeddings_complete"` + the exception message disambiguates the tail (the only tail step that can raise is `store_chunks_via_service`; the others swallow their errors — all verified). Alternative considered and rejected: resetting to `"processing"` for the tail.
- Convention for future steps: **set the tracker immediately before the await.** A step added without updating the tracker reports a stale stage — the known drift risk, mitigated by representative-stage test coverage (FR-5), not by ossifying every step.

### 4.3 Worker: exception handler rewiring

The `except` block in `process_document` replaces `{"error": str(e)}` with `build_failure_payload(e, current_stage)` passed to the existing `_publish_status_update(..., "failed", …)` call. The failure log gains `stage` and `retryable` fields. Everything else in the handler (`metrics.error_message`, trace update, return) is unchanged. `_publish_status_update` itself is untouched: it injects `jobId`, manages sequence numbers, heartbeats the lease, and swallows its own publish errors (verified) — see §5.1.

### 4.4 rag-api: no functional change

Verified conformant: `run_transactional_update`'s failed branch already performs the exact mapping in FR-3. The only rag-api-side artifact of this cycle is the contract test that pins it. The `details.get(...)` fallbacks remain in the code for publishers that omit keys; after this change they are dead paths for worker failures — which is the point.

### 4.5 Contract test architecture

Location: `apps/ai-server/tests/integration/` (new sibling module, e.g. `test_worker_failure_contract.py`), following the house patterns in `test_api_contracts.py` (fixture- and AST-based static checks; subprocess isolation precedent). Two layers:

**Layer A — always runs (no emulator):**
- Import the worker leaf module directly (stdlib + `httpx` only, so no mock choreography) and assert `build_failure_payload` polarity: `TransientError`/timeout-style → `retryable True`; `PermanentError`/generic `ValueError`/unknown → `retryable False`; key set exactly `{error_message, stage, retryable, error}`; empty stage guarded to `"processing"`.
- AST drift guard (mirrors the existing AST key-extraction patterns): parse the worker leaf module and assert the payload dict literal's keys; parse `rag-api-service/main.py` and assert the failed branch's `details.get("error_message"|"stage"|"retryable")` reads. Either side renaming a key fails the build.

**Layer B — hermetic emulator run (Firestore emulator):**
- A subprocess (clean interpreter, no conftest mock pollution — the shared `conftest.py` mocks `firebase_admin`/`google.cloud`, which would neuter `@firestore.transactional`) sets `FIRESTORE_EMULATOR_HOST` + `GCP_PROJECT`, imports the worker leaf module and rag-api's `main` (real firebase-admin; rag-api's startup has a verified emulator branch, and `run_transactional_update` only needs the `db` passed in), seeds a resource document with `status: "processing"` at the canonical path, then for each scenario:
  1. build the payload via the worker's `build_failure_payload` from a real raised exception,
  2. call `run_transactional_update(db, doc_ref, "failed", details, logger, user_id)`,
  3. read back the main document and `processing/summary`.
- Scenarios (representative early + late, both retryable polarities):
  - early/permanent: `ValueError` at stage `"text_retrieved"` → persisted `error == "…"`, `error_stage == "text_retrieved"`, `retryable == False` (a `False` scenario is mandatory: if the API's `True` fallback were operative, this assertion fails);
  - late/transient: `TimeoutError` at stage `"embeddings_complete"` → `retryable == True`.
- Assertions: persisted `error`/`error_stage`/`retryable` equal the worker's payload values; `processing/summary.error.message`/`.stage` equal the main document's; no `"Processing failed"`, no `null` stage.
- Fallback persistence mechanism (permitted by the Definition): an in-memory fake db — only if it faithfully implements transactional get/update/set semantics under the real `@firestore.transactional` wrapper (wrapper internals unverified; the emulator is therefore the primary mechanism, matching F10).
- Skip semantics: without a reachable emulator, Layer B skips with an explicit reason; it is a required pass in the hermetic stack run (AC-4).

**Complementary worker unit tests** (`rag-worker-service/tests/unit/`): construct the processor with stubbed collaborators, monkeypatch a step to raise, capture `_publish_status_update`, and assert the published `details.stage`/`retryable` for an early and a late failure — pinning the tracker convention itself. (The worker test tree and its conftest exist; their contents were not verified this pass — harness details at implementation time.)

### 4.6 What deliberately does not change

- `_publish_status_update` mechanics: jobId injection, sequence numbers, terminal-state reset, lease heartbeat, best-effort error swallowing.
- `run_worker` ACK/NACK logic and `classify_error` heuristics (moved, not modified).
- The stale-lease sweep's write (`error` / `"processing"` / `True`) — already conformant; a dead worker is transient by nature.
- rag-api's failed branch, transitions, summary fallbacks (`stage: "unknown"`, `progress: 0`, `error_code: "UNKNOWN"`).
- Frontend/mobile — `ResourceResponse` already exposes `error`/`error_stage`.

## 5. Failure-mode and edge-case analysis

1. **Failure publish itself fails** — `_publish_status_update` swallows publish errors (verified). The resource stays `"processing"` until lease expiry, when the sweep marks it failed with the generic message. Existing backstop behavior; unchanged and out of scope.
2. **Pre-transition failure** (validation) → `stage: "processing"` — safe value, never null.
3. **Tail failures** (vector write) → `stage: "embeddings_complete"` (last milestone) — see §4.2 tail rule.
4. **retryable behavior change** — unclassified-unknown exceptions flip from persisted `True` (silent default) to `False` (classifier's conservative default). Accepted per Definition F8; prevents infinite retry loops; manual reprocess via `POST /process` unaffected.
5. **`jobId` injection** into the failure details is harmless — rag-api reads `jobId` only in the `processing` branch (verified).
6. **Summary `progress` on failure** stays `0` (payload carries no progress; API default) — identical to today, unchanged.

## 6. Compatibility

- **No migration, no backfill.** Persisted field names and semantics are untouched; only the *values* improve.
- **Legacy `error` key retained** in the payload for unknown topic consumers and log tooling (FR-6); rag-api ignores it. Dropping it later is trivial cleanup after a consumer audit.
- **Idempotence/ordering**: the failed publish flows through the same sequenced, lease-heartbeating path as every other status update.

## 7. Risks and tradeoffs

- **Unknown status-topic consumers** reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the set-before-await convention and representative-stage coverage.
- **`retryable=false` for unrecognized-but-transient failures** — accepted; widening `classify_error` is out of scope; manual reprocess remains.
- **Contract test ossifies the payload** — intentional; the drift guard is the deliverable. Adding a key later means touching the test, which is the point.
- **Worker import weight in tests** — mitigated by the leaf-module extraction (§4.1); `main.py`'s import-time side effects are never touched by the contract test.

## 8. Deferred

- Companion D3 issue scope (unavailable here) — anything beyond this payload alignment.
- Reconciliation with the D4 deviation note in `plans/upload-flow.md` (file absent from the tree).
- Dropping the legacy `error` key, pending a consumer audit.
- Extending the stage vocabulary (e.g., a named vector-storage stage) — forward-compatible worker-side change, outside this cycle's locked vocabulary.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>