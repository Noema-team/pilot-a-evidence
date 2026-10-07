<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- Cycle run: `99100d24-2150-4380-925c-936eb4c82869` (iteration 1, step: design)
- Authoritative source: define-work WorkItem `wi-define-108-a8`, artifact `definition:obj-108`
  (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).
  Every requirement below traces to that Definition. Nothing here widens, narrows, or reinterprets it.
- Code anchors marked **[verified]** were read in the repository during investigation. Anchors marked
  **[per Definition]** come from the authoritative Definition's facts and are binding even where not
  independently re-read.

## 1. Problem statement

The rag-worker and rag-api disagree on the failure-status contract, and no test guards the seam.

- The worker's `process_document` exception handler publishes a failed status with a one-key payload:
  `details = {"error": str(e)}` **[verified: `rag-worker-service/main.py`, process_document except block]**
- rag-api's failed branch (inside `run_transactional_update`) reads three keys — `error_message`,
  `stage`, `retryable` — and persists them as `error`, `error_stage`, and `retryable` on the main
  resource document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the
  `processing/summary` error subdocument **[per Definition F4]**.

Because of the key mismatch, every worker-originated failure currently persists:
- `error` = the API fallback string `"Processing failed"` (not the actual exception message),
- `error_stage` = `None`,
- `retryable` = the silent default `True`,
- and a `processing/summary` error subdocument that inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

Users and support cannot disambiguate failures; retryability is fabricated rather than derived.

The rest of the failure schema is already consistent: the worker's stale-lease sweep
(`_fail_if_still_stale` writes `error` / `error_stage="processing"` / `retryable=True`) **[verified]**,
rag-api's enqueue-failure paths **[per Definition F6]**, and the `Resource` model
(`error`, `error_stage`, `retryable: bool = True`) **[verified: `rag-api-service/models/resource.py`]**
all speak the persisted schema. The worker's status publisher is the only writer that does not.

## 2. Goals

- **G1** — A failed RAG processing job persists the worker's actual error message, the failing pipeline
  stage, and a deliberately derived retryable flag.
- **G2** — The worker→rag-api failure path is locked by a contract test that fails the build if either
  side's payload keys drift.

## 3. Scope

### 3.1 In scope
- The worker's failure-payload construction in `process_document`'s exception handler (via
  `_publish_status_update` with `status="failed"`).
- Stage tracking through `process_document` so the failure handler can report the failing stage.
- Derivation of `retryable` in the worker from the existing `classify_error()` classifier.
- A contract test covering worker failure-payload construction → rag-api failed-branch persistence.

### 3.2 Out of scope (non-goals, from the Definition)
- Changing rag-api's reads, the persisted field names (`error`, `error_stage`, `retryable`), or the
  `Resource`/`ResourceResponse` models.
- Any Firestore migration, field rename, or backfill of existing documents.
- The stale-lease sweep's direct failure write (already consistent).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the
  *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`
  (the mobile contract test already asserts `error_stage` presence **[verified:
  `tests/integration/test_api_contracts.py`, `MOBILE_RESOURCE_FIELDS`]**).
- Introducing structured error codes or a failure taxonomy — `processing/summary` `error_code` remains
  `"UNKNOWN"` unless a code is actually sent.
- Anything the companion D3 issue covers beyond this payload alignment (its content is unavailable in
  this context; deferred — see §9).

## 4. Binding constraints

| ID | Type | Constraint |
|----|------|------------|
| C-1 | must | The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema. |
| C-2 | must_not | No Firestore migration, field rename, or backfill; persisted fields keep their names and semantics. |
| C-3 | must | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| C-4 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling. (Adopted per Definition F11.) |
| C-5 | prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## 5. Functional requirements

### FR-1 — Failure payload keys (maps to Definition requirement 1; satisfies AC-1)
When document processing fails, the worker's failed status payload `details` MUST include:
- `error_message`: the actual exception message (`str(e)`),
- `stage`: the pipeline stage executing at failure time (see FR-2),
- `retryable`: a deliberately derived boolean (see FR-4).

The payload MUST NOT rely on rag-api's fallback defaults for any of these keys — i.e., all three keys
are always present in worker-originated failure payloads.

### FR-2 — Stage tracking (maps to Definition requirement 2; satisfies AC-1, AC-2)
The worker MUST track the currently executing pipeline stage through `process_document` so the failure
handler reports the true failing stage.
- Stage names MUST reuse the existing progress-stage vocabulary published by `_publish_status_update`
  calls: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
  `embeddings_complete`.
- `processing` is the safe value when the stage is genuinely unknown (same value the stale-lease sweep
  uses for `error_stage` **[verified]**), so `error_stage` never regresses to null.
- The tracker convention is "set the tracker immediately before the pipeline step" (see
  `docs/architecture.md` §4.1 for the exact step→stage mapping).

### FR-3 — rag-api persistence unchanged (maps to Definition requirement 3; satisfies AC-2, AC-3)
rag-api's failed branch MUST persist the worker-provided values unchanged:
- main document: `error` ← payload `error_message`; `error_stage` ← payload `stage`;
  `retryable` ← payload `retryable`;
- `processing/summary` error subdocument: carries the same message and stage as the main document
  (with `error_code` defaulting to `"UNKNOWN"` since no code is sent).

This is satisfied by *not changing* rag-api (C-1) and is verified by the contract test (FR-5).

### FR-4 — retryable derivation (maps to Definition requirement 4; satisfies AC-1, AC-2)
The retryable derivation MUST be explicit and aligned with the worker's ACK/NACK behavior, which is
driven by the same classifier `classify_error()` **[verified: `rag-worker-service/main.py`;
used in `run_worker`]**:
- errors classified **transient** by `classify_error(e)` → `retryable: true`;
- errors classified **permanent** — including unclassified-unknown exceptions, per
  `classify_error`'s conservative default (`return False`) **[verified]** → `retryable: false`.

Rationale (binding, Definition F8): this aligns the persisted record with the worker's actual retry
classification. The stale-lease sweep's separate `retryable=true` write stays correct and unchanged
(a dead worker is a transient condition by nature).

### FR-5 — Contract test (maps to Definition requirement 5; satisfies AC-4)
A contract test MUST cover the worker failure → rag-api persistence path:
- It MUST exercise the worker's failure-payload construction (through the worker's code path, not a
  restated fixture) and rag-api's failed-branch persistence (via the Firestore emulator or fakes).
- It MUST assert the persisted `error`, `error_stage`, and `retryable` equal the worker's
  `error_message`, `stage`, and `retryable` values.
- It MUST fail if either side's payload keys drift (key-set drift guard on both the worker's payload
  construction and rag-api's reads).
- It MUST follow the existing contract-test patterns in
  `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract
  tests; both services support hermetic Firestore-emulator mode) **[verified: test file and emulator
  branches exist; per Definition F10]**.

### FR-6 — Legacy key retention (adopted preference, C-4 / Definition F11)
The worker's failure payload MUST retain the legacy `error` key with the same value as
`error_message`, as a compatibility hedge for any unknown consumer of the status topic. Removal is
deferred pending a consumer audit (see §9).

## 6. Failure payload data contract

Status-message envelope published by `_publish_status_update` (unchanged, **[verified]**):
`user_id`, `course_id`, `resource_id`, `status` (`"failed"`), `details`, `timestamp`, `sequence`
(sequence resets on terminal states, including `failed`).

Failure `details` payload (the changed surface):

| Key | Type | Source | Status |
|-----|------|--------|--------|
| `error_message` | string | `str(e)` from the exception handler | **new, required** |
| `stage` | string | stage tracker value (FR-2 vocabulary + `"processing"` fallback) | **new, required** |
| `retryable` | bool | `classify_error(e)` mapping (FR-4) | **new, required** |
| `error` | string | same value as `error_message` | retained (legacy hedge, FR-6) |
| `jobId` | string | injected by `_publish_status_update` when a `job_id` is provided | pre-existing behavior, unchanged |

## 7. Acceptance criteria

| ID | Criterion (from the Definition, binding) |
|----|------------------------------------------|
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value. |
| AC-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. |

Traceability: FR-1 → AC-1; FR-2 → AC-1, AC-2; FR-3 → AC-2, AC-3; FR-4 → AC-1, AC-2; FR-5 → AC-4; FR-6 → C-4.

## 8. Deliberate behavior changes (accepted)

1. **Unclassified-unknown exceptions now persist `retryable: false`** (previously the silent `True`
   default). This is the conservatism `classify_error` was written for; manual reprocess via
   `POST /process` is unaffected.
2. **`error` now carries the real exception message** instead of the `"Processing failed"` fallback,
   and `error_stage` is populated instead of null.
3. No change to ACK/NACK policy, leases, heartbeats, or the sweep.

## 9. Deferred items and known unknowns

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context;
  anything beyond the worker→rag-api payload alignment is deferred (Definition F12).
- **`plans/upload-flow.md` deviation D4**: the file is not present in the current tree (reference
  comes from the Objective text); reconciliation is deferred.
- **Legacy `error` key removal**: deferred until an audit confirms the worker is the only publisher
  and rag-api the only consumer of the status topic.
- **Empty exception message edge** (`str(e) == ""`): behavior unspecified by the Definition; the
  worker sends `str(e)` as-is. Not addressed in this cycle.
- **rag-api failed-branch internals** beyond what Definition F4 states (exact read expressions,
  document paths) were not independently re-read; the contract test pins the observable contract,
  which is sufficient per FR-5.

## 10. Glossary

- **Failure payload** — the `details` dict inside the worker's failed status message on the
  `RAG_STATUS_TOPIC` Pub/Sub topic.
- **Failed branch** — the branch of rag-api's `run_transactional_update` that handles
  `status == "failed"` subscriber messages **[per Definition F4]**.
- **Stage vocabulary** — the progress-stage strings the worker already publishes:
  `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
  `embeddings_complete`, `completed`.
- **Persisted failure schema** — `error`, `error_stage`, `retryable` on the resource document.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload alignment

- Cycle run: `99100d24-2150-4380-925c-936eb4c82869` (iteration 1, step: design)
- Companion document: `docs/requirements.md` (FR/AC identifiers referenced below).
- Anchors marked **[verified]** were read in the repository; **[per Definition]** marks binding facts
  taken from the authoritative Definition.

## 1. Context and data flow

```
rag-worker (rag-worker-service/main.py)
  process_document()  ── fails ──▶ exception handler
                                      │  _publish_status_update(..., "failed", details, job_id)
                                      ▼
                            Pub/Sub topic RAG_STATUS_TOPIC
                                      │  (status subscriber)
                                      ▼
rag-api (rag-api-service/main.py)
  run_transactional_update() failed branch  [per Definition F4]
      reads details: error_message, stage, retryable
      persists main doc:      error, error_stage, retryable, status="failed"
      persists processing/summary subdoc: message, stage, error_code (default "UNKNOWN")
                                      ▼
                            Firestore resource document
                                      ▼
        ResourceResponse / Resource model expose error + error_stage to clients
        [verified: models/resource.py; test_api_contracts.py MOBILE_RESOURCE_FIELDS]
```

Other failure writers that already speak the persisted schema (all unchanged):
- Worker stale-lease sweep `_fail_if_still_stale`: `error="processing lease expired…"`,
  `error_stage="processing"`, `retryable=True` **[verified]**.
- rag-api enqueue-failure paths (`/process`, `POST /resources`) **[per Definition F6]**.

## 2. Design principle: the worker aligns to the API

The persisted field names are consistent across three other write paths and two API response models;
changing the API side would be the change that ripples. The worker is the odd one out. Therefore:

- **rag-api: zero code changes.** Its failed branch, fallback defaults, and persisted schema stay as
  they are. The `details.get("retryable", True)` fallback remains in the code but becomes
  non-operative for worker failures because the worker always sends the key (C-1, C-3).
- **Worker: the only production code changed** — `rag-worker-service/main.py` only.
- **No migration, no backfill** (C-2).

## 3. Target failure payload contract

Failure `details` published by the worker's exception handler:

```json
{
  "error_message": "<str(e)>",
  "stage": "<tracker value>",
  "retryable": true,
  "error": "<str(e)>",
  "jobId": "<job_id>"
}
```

Key roles: `error_message` (new) is the actual exception message; `stage` (new) is the failing
pipeline stage from the tracker (§4.1 vocabulary); `retryable` (new) is derived via
`classify_error(e)` (§4.3); `error` is the retained legacy key with the same value as
`error_message` (FR-6); `jobId` is the pre-existing injection by `_publish_status_update` when a
`job_id` is provided.

Envelope fields (`user_id`, `course_id`, `resource_id`, `status="failed"`, `timestamp`, `sequence`)
are unchanged. `_publish_status_update` already swallows its own publish errors (logs
`status_publish_failed`, does not re-raise) **[verified]**, so failure reporting stays best-effort with
no new failure paths. `failed` is terminal, so the per-resource sequence counter resets as today
**[verified]**.

## 4. Worker changes (rag-worker-service/main.py)

### 4.1 Stage tracker in `process_document`

`process_document` is one large `try` block; at failure time nothing currently knows where execution
was **[verified]**. The fix is a local stage tracker:

- A local variable (e.g. `current_stage`) initialized to `"processing"` **before** the `try`.
  In practice the handler always sees at least the first in-`try` assignment, so `"processing"` is a
  defensive fallback for the genuinely-unknown case — the same value the stale-lease sweep uses for
  `error_stage`, so `error_stage` never regresses to null.
- **Convention: set the tracker immediately before each pipeline step.** The tracker value is the
  vocabulary name of the step in flight (the name whose progress update announces that step's
  completion). A failure during a step therefore reports that step's stage; the progress timeline a
  client has seen ends at the previous stage, which reads correctly next to it.

Step → stage mapping (all anchors **[verified]** in `process_document`):

| Pipeline step | Tracker assigned | Stage value |
|---|---|---|
| function entry (validation `_validate_processing_request`, initial publish) | at entry | `starting` |
| `_get_extracted_text` (text retrieval / PDF extraction) | before call | `text_retrieved` |
| `content_tagger.generate_tags` | before call | `tagging_complete` |
| `generate_document_summary` + `ragDescription` doc update | before call | `summary_generated` |
| `_create_enhanced_chunks` | before call | `chunking_complete` |
| `_generate_embeddings_with_openrouter` | before call | `embeddings_complete` |
| `delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save, final publish | no new assignment | remains `embeddings_complete` |
| (unassigned edge — before first assignment) | init value | `processing` |

Notes:
- The progress vocabulary has no storage-specific stage name, so the vector-storage tail stays at
  `embeddings_complete`. This is a documented, bounded imprecision — not a reason to invent vocabulary
  outside the Definition's allowed set.
- The tail methods `_update_user_usage`, `_generate_resource_map`,
  `_save_processing_metadata_to_subcollection`, and `delete_old_vectors_via_service` swallow their own
  exceptions **[verified]**, so the meaningful tail failure surface is `store_chunks_via_service`
  (which raises on partial vector writes) — reported as `embeddings_complete`.
- `completed` is a terminal status, never a failure stage; the handler only runs on exception.
- **Do not conflate vocabularies:** `models/processing_status.py` defines a different
  `ProcessingStage` enum (`pdf_download`, `text_extraction`, …) used for Firestore processing
  metadata **[verified]**. The tracker deliberately uses the status-topic progress vocabulary per the
  Definition, not that enum.

Drift risk and mitigation: a future pipeline step added without updating the tracker reports a stale
stage. Mitigations: the set-before-step convention documented at the assignment sites, and contract
tests pinning an early-stage and a late-stage failure (§6), which catch the tracker being removed or
bypassed without ossifying every step.

### 4.2 Failure payload construction

- Factor the payload construction into a small module-level helper in `main.py`
  (e.g. `build_failure_details(error: Exception, stage: str) -> dict`) returning exactly:
  `{"error_message": str(e), "stage": stage, "retryable": <derived>, "error": str(e)}`.
  The exception handler calls it; this gives the contract test a stable seam and keeps the key set in
  one place for the AST drift guard.
- The handler keeps its existing behavior — `metrics.error_message = str(e)`, error log, trace update
  — and additionally reads the tracker and the derived flag. `ProcessingMetrics` already has an
  `error_message` field **[verified]**; no model changes.
- `_publish_status_update` itself is unchanged (signature, envelope, jobId injection, lease
  heartbeat, sequence handling).

### 4.3 retryable derivation

`retryable = classify_error(e)` — the same classifier `run_worker` uses for ACK/NACK decisions
**[verified: `classify_error`, `run_worker`]**. Semantics **[verified]**:

| Exception | classify_error | retryable persisted |
|---|---|---|
| `TransientError`, connection/timeout types (`httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`) | transient | `true` |
| `httpx.HTTPStatusError` with status 429/500/502/503/504 | transient | `true` |
| `PermanentError`; other 4xx status errors; **unclassified-unknown (conservative default)** | permanent | `false` |

This is the deliberate behavior change for unclassified errors (previously silent `true`); manual
reprocess via `POST /process` is unaffected. The stale-lease sweep keeps its direct
`retryable=True` write — a dead worker is transient by nature.

## 5. rag-api (no changes)

The failed branch of `run_transactional_update` continues to read `error_message`/`stage`/`retryable`
and persist `error`/`error_stage`/`retryable` plus the `processing/summary` subdocument
(`message`, `stage`, `error_code` defaulting to `"UNKNOWN"`) **[per Definition F4]**. Worker payloads
now satisfy those reads with real values; the fallbacks remain for robustness but are non-operative
for worker failures (C-3).

## 6. Contract test architecture

New module: `apps/ai-server/tests/integration/test_worker_failure_contract.py`, reusing the existing
integration conftest and the patterns of `test_api_contracts.py` (which already imports
`main as rag_api_main` and runs fixture- and AST-based static contract tests) **[verified]**.
Three layers:

**Layer A — worker behavioral (payload construction through the worker's code path).**
Build/stub a processor under hermetic env; stub `_publish_status_update` to capture `details`; stub a
pipeline step to raise at a chosen point; invoke `process_document`. Cases:
- early failure: `_get_extracted_text` raises `httpx.ConnectError` → captured details have
  `stage == "text_retrieved"`, `retryable is True`, `error_message == str(e)`, `error == error_message`;
- late failure: `store_chunks_via_service` raises `RuntimeError` (unclassified → permanent) →
  `stage == "embeddings_complete"`, `retryable is False`;
- typed permanent failure (e.g. `ValueError` / `PermanentError`) → `retryable is False`;
- key-set assertion: captured details keys == `{error_message, stage, retryable, error}`
  (+ `jobId` when a job_id is supplied).

**Layer B — seam behavioral (worker payload → rag-api persistence).**
Feed the captured/constructed details through rag-api's failed branch
(`run_transactional_update`) against the Firestore emulator (or fakes), with a seeded resource
document in the layout the branch expects; assert on the persisted main document:
`error == details["error_message"]`, `error_stage == details["stage"]`,
`retryable == details["retryable"]`, `status == "failed"`; and on the `processing/summary` subdoc:
message and stage equal the worker's values, `error_code == "UNKNOWN"` (AC-2, AC-3).

**Layer C — static key-set drift guard.**
Following the existing subprocess-AST pattern (`_get_agent_graph_shapes`) **[verified]**: an AST scan
of `rag-worker-service/main.py` extracting the failure-payload dict keys (from the helper/exception
handler), and an AST scan of `rag-api-service/main.py` extracting the keys the failed branch reads
from `details` (`details.get("…")` / `details["…"]` constants within `run_transactional_update`).
Assertions: worker set ⊇ `{error_message, stage, retryable}`; every API-read key is provided by the
worker. Either side drifting fails the build. (Exact AST predicates get pinned against the real
`rag-api` code at implementation time; the branch location is fixed by Definition F4.)

**Hermetic environment.** Both services have emulator branches — the worker initializes Firebase via
`FIRESTORE_EMULATOR_HOST`, storage via `STORAGE_EMULATOR_HOST`, and logs `PUBSUB_EMULATOR_HOST`
**[verified]**; rag-api's emulator mode is attested by Definition F10. Implementation consideration:
the worker module has import-time requirements — `GCP_PROJECT` from `os.environ`, and
`GOOGLE_APPLICATION_CREDENTIALS` (a loadable service-account JSON, used to construct the module-level
SubscriberClient) — which the test module or conftest must satisfy before importing it. Whether the
existing `tests/integration/conftest.py` already covers the worker import is **unverified**; resolve
against it during implementation. The AST layer (C) needs no import at all.

Supplementary (optional, non-mandated): a worker unit test for the payload helper's retryable mapping
table under `rag-worker-service/tests/unit/`.

## 7. Files touched

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Stage tracker in `process_document`; failure-payload helper + enriched exception handler; retryable derivation. No changes to `_publish_status_update`, `run_worker`, `_fail_if_still_stale`, `classify_error`, or any model. |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | New contract test (Layers A–C). |
| `apps/ai-server/rag-api-service/**` | **No changes.** |
| `apps/ai-server/rag-worker-service/models/**`, `rag-api-service/models/**` | **No changes.** |

## 8. Compatibility and risks

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining the
  legacy `error` key (FR-6); residual risk accepted as low; removal deferred pending audit.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the set-before-step convention and
  representative-stage contract coverage.
- **`retryable=false` for unclassified errors** may reduce auto-retry affordances for genuinely
  transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope and
  manual reprocess remains.
- **The contract test ossifies the payload** — intentional; adding a key later means touching the
  test, which is the drift guard doing its job.

## 9. Acceptance traceability

| AC | Satisfied by | Verified by |
|---|---|---|
| AC-1 | §4.1 tracker + §4.2 payload + §4.3 derivation (FR-1, FR-2, FR-4) | Layer A cases + key-set assertion |
| AC-2 | rag-api unchanged reads fed real values (FR-3) | Layer B main-doc assertions |
| AC-3 | rag-api summary-subdoc write (FR-3) | Layer B subdoc assertions |
| AC-4 | §6 test architecture (FR-5) | Layers A–C passing in CI |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>