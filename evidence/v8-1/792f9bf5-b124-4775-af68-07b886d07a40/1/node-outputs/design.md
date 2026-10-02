Both artifacts are ready from the verified evidence. Below is a summary of what was produced, followed by the artifacts in the required format.

**Verified basis:** worker `main.py` (`classify_error` table, `process_document` single-try pipeline with stage publishes, failure handler publishing `{"error": str(e)}`, `_publish_status_update` envelope/jobId injection/sequence reset, `_fail_if_still_stale` direct write, `run_worker` ACK/NACK); rag-api `main.py` (`run_transactional_update` failed branch with `error_message`/`stage`/`retryable` reads and fallbacks, `ALLOWED_TRANSITIONS`, summary subdocument writes, `_process_status_message` path resolution, enqueue-failure writes in `/process` and `POST /resources`); `models/resource.py` (`error`/`error_stage`/`retryable` schema, `retryable` default `True`, not exposed in `ResourceResponse`); contract-test infrastructure in `apps/ai-server/tests/integration/` (mock-based conftest, fixture + AST patterns). Unverified items (worker test conftest contents, other status-topic consumers, companion D3 issue content, CI heavy-dep availability) are preserved as explicit unknowns rather than invented.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (definition artifact `definition:obj-108`, sha256 `71f1c39c…`). This document restates and operationalizes that authoritative definition; where wording differs, the definition wins.

## 1. Purpose

A failed RAG processing job must persist the worker's **actual error message**, the **failing pipeline stage**, and a **deliberately derived retryable flag**. Today the worker's failure publisher and rag-api's failure consumer were written against different contracts, so every worker-originated failure lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true`. This fix aligns the worker to rag-api's existing contract and locks the seam with a contract test.

## 2. Verified problem statement

All of the following were verified in the repository:

- **Worker publisher (the odd one out).** `EnhancedDocumentProcessor.process_document` wraps the whole pipeline in one `try`. Its exception handler publishes status `"failed"` with details `{"error": str(e)}` — a single key — via `_publish_status_update`.
- **API consumer (the established contract).** `run_transactional_update`'s failed branch reads three detail keys and persists them:
  - main doc `error` ← `details.get("error_message", "Processing failed")`
  - main doc `error_stage` ← `details.get("stage")` (no fallback → `None`)
  - main doc `retryable` ← `details.get("retryable", True)`
  - `processing/summary` (merge write): `stage` ← `details.get("stage", "unknown")`, `progress` ← `details.get("progress", 0)`, and on failure `error` ← `{"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`.
- **Consequence.** Because the worker sends only `error`, every worker failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True`, and the summary subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.
- **The schema is already established elsewhere.** Three other write paths write `error`/`error_stage`/`retryable` directly and correctly:
  - worker stale-lease sweep `_fail_if_still_stale` (writes `error`, `error_stage="processing"`, `retryable=True`);
  - rag-api `POST /process` enqueue-failure rollback (`error`, `error_stage="enqueue"`);
  - rag-api `POST /resources` enqueue-failure path (same shape via `ResourceService.update_status`).
  The `Resource` model (`models/resource.py`) carries `error`, `error_stage`, `retryable: bool = True` in both `to_dict`/`from_dict`; `ResourceResponse` exposes `error` and `error_stage` (it does **not** expose `retryable`).
- **Classification already exists.** The worker's `classify_error(e)` returns `True` (transient) for `TransientError`, connection/timeout-type exceptions (`httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`), and `httpx.HTTPStatusError` with status ∈ {429, 500, 502, 503, 504}; returns `False` (permanent) for `PermanentError`, other HTTP statuses, and — conservatively — any unknown exception. `run_worker` uses this for ACK/NACK decisions.
- **Stage vocabulary already exists.** The worker's progress updates publish stages `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, and finally `completed`. The failure handler has no stage tracking today.
- **Test infrastructure exists.** `apps/ai-server/tests/integration/test_api_contracts.py` demonstrates the house patterns (fixture-based and AST-in-subprocess static contract tests); its `conftest.py` sets `GCP_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS`/`SHARED_INTERNAL_TOKEN`, mocks the cloud SDK modules, and puts `rag-api-service` on `sys.path` so `main` imports cleanly. Both services have `FIRESTORE_EMULATOR_HOST` branches (the worker additionally supports `STORAGE_EMULATOR_HOST` and logs `PUBSUB_EMULATOR_HOST`), so hermetic runs are supported.

## 3. Scope

**In scope**
- Worker failure-payload construction (keys, values, derivation).
- Stage tracking inside `process_document`.
- The worker→rag-api failure-path contract test and the test scaffolding it needs.
- Documentation of the contract so both sides have a single written reference.

**Out of scope (non-goals — must not be attempted by this fix)**
- Any change to rag-api's reads, persisted schema, `ResourceResponse`, or models.
- The stale-lease sweep's direct failure write (already conformant).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals. Only the *reporting* of retryability changes.
- Frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`).
- A structured error-code taxonomy; `processing/summary` `error.code` stays `"UNKNOWN"` unless a code is actually sent.
- Anything the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context — deferred), and reconciling this analysis with the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## 4. Contract specification

### 4.1 Worker failure payload (status `"failed"`, `details` object)

| Key | Type | Value | Status |
|---|---|---|---|
| `error_message` | str | `str(e)` of the caught exception; if `str(e)` is empty, the exception class name (never an empty string) | **new, required** |
| `stage` | str | stage-tracker value at failure time (§4.3) | **new, required** |
| `retryable` | bool | `classify_error(e)` (§4.4) | **new, required** |
| `error` | str | identical duplicate of `error_message` | **retained (legacy compatibility)** |
| `jobId` | str | injected by `_publish_status_update` when a `job_id` is present | existing, unchanged |

The message envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`; sequence reset on terminal states) is unchanged.

### 4.2 rag-api persistence mapping (unchanged — documented as the contract)

| Persisted location | Field | Expression (existing code) |
|---|---|---|
| main doc | `status` | `"failed"` (transition-guarded: `processing → failed` per `ALLOWED_TRANSITIONS`) |
| main doc | `error` | `details.get("error_message", "Processing failed")` |
| main doc | `error_stage` | `details.get("stage")` |
| main doc | `retryable` | `details.get("retryable", True)` |
| `processing/summary` (merge) | `stage` | `details.get("stage", "unknown")` |
| `processing/summary` | `progress` | `details.get("progress", 0)` → `0` for worker failure payloads (existing behavior, unchanged) |
| `processing/summary` | `error.code` | `details.get("error_code", "UNKNOWN")` |
| `processing/summary` | `error.message` | `details.get("error_message", "Processing failed")` |
| `processing/summary` | `error.stage` | `details.get("stage")` |

The `details.get(...)` fallbacks remain in rag-api's code for non-worker publishers; the requirement is that they **never fire for worker failures** because the worker always sends the keys.

### 4.3 Stage vocabulary and tracker semantics

- Tracker values reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown (no tracker assignment has executed yet) — the same value the stale-lease sweep uses for `error_stage`, so `error_stage` never regresses to `null`.
- Semantics: the tracker holds the milestone the *currently executing* step is producing; it is assigned immediately before each step (see architecture doc §4.2 for the assignment table).

### 4.4 retryable derivation (fixed rule)

`retryable = classify_error(e)`:

| Exception at failure time | `retryable` |
|---|---|
| `TransientError` instance | `true` |
| `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | `true` |
| `httpx.HTTPStatusError` with status 429/500/502/503/504 | `true` |
| `PermanentError` instance | `false` |
| `httpx.HTTPStatusError` with any other status | `false` |
| Any other (unclassified) exception — `classify_error`'s conservative default | `false` |

Deliberate behavior change: unclassified-unknown failures previously persisted `retryable: true` via the silent default; they now persist `false`. Manual reprocess via `POST /process` is unaffected.

## 5. Functional requirements

- **FR-1 — Failure payload keys.** When document processing fails, the worker's failed status payload MUST include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload MUST NOT rely on rag-api's fallback defaults for any of these keys.
- **FR-2 — Stage tracking.** `process_document` MUST maintain a current-stage tracker, initialized to `"processing"`, assigned immediately before each pipeline step, using only the vocabulary in §4.3. The failure handler MUST report the tracker value.
- **FR-3 — retryable derivation.** The worker MUST derive `retryable` from `classify_error(e)` per §4.4 — transient-classified → `true`; permanent-classified, including the unclassified-unknown conservative default → `false`. No silent defaults.
- **FR-4 — rag-api persistence preserved.** rag-api's failed branch MUST persist worker-provided values unchanged: main doc `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument MUST carry the same message and stage. rag-api's code MUST NOT be modified by this fix; this requirement is "must hold and must not regress".
- **FR-5 — Legacy key retention.** The worker MUST retain the legacy `error` key in the failure payload with the same value as `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **FR-6 — No schema change.** The persisted field names `error`, `error_stage`, `retryable` keep their names and semantics. No Firestore migration, field rename, or backfill of existing documents.
- **FR-7 — Contract test.** A contract test MUST cover the worker failure → rag-api persistence path: it MUST exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It MUST fail if either side's payload keys drift.
- **FR-8 — Sweep unchanged.** The stale-lease sweep's direct failure write (`error`, `error_stage="processing"`, `retryable=True`) MUST remain as is.
- **FR-9 — Envelope unchanged.** The status-message envelope and `_publish_status_update` behaviors (sequence numbering and reset on terminal states, lease-heartbeat write, `jobId` injection) MUST remain unchanged.
- **FR-10 — Other failure writers unchanged.** rag-api's enqueue-failure paths (`POST /process`, `POST /resources`) MUST remain unchanged; they already write the persisted schema directly.

## 6. Edge-case requirements

- **ER-1 — Empty exception message.** If `str(e)` is empty, `error_message` MUST fall back to the exception class name so a persisted `error` is never an empty string.
- **ER-2 — No truncation.** Exception messages are persisted as-is (no truncation), matching the existing write paths (sweep, enqueue failures).
- **ER-3 — Publish is best-effort.** If publishing the failed status itself fails, the existing swallow-and-log behavior of `_publish_status_update` MUST be preserved (it must not mask the original failure).
- **ER-4 — API-side guards unchanged.** If the resource document is missing or deleted, or the status transition is invalid, rag-api's existing skip/log behavior applies; the worker still publishes the payload regardless.
- **ER-5 — jobId injection.** The failure details may gain `jobId` downstream of the payload builder (existing `_publish_status_update` behavior); the builder's own key set is pinned without it (see TR-3).
- **ER-6 — Post-embedding failures.** Steps after the last vocabulary milestone (vector delete/store, metadata save, usage, resource map) keep the last tracked value (`embeddings_complete`); no new stage token may be invented (vocabulary is closed per §4.3).

## 7. Test & verification requirements

- **TR-1 — Contract test location/pattern.** A new test module in `apps/ai-server/tests/integration/` (alongside `test_api_contracts.py`, reusing its `conftest.py`), importing **both** services' code rather than restating the contract in a fixture.
- **TR-2 — Behavioral equality.** The test MUST build the failure payload through the worker's construction path (including the `classify_error` derivation) and feed it through rag-api's `run_transactional_update` against a fake transactional Firestore or the Firestore emulator, asserting persisted `error`, `error_stage`, `retryable` equal the worker's values — for both a transient-classified exception (`retryable=true`) and a permanent/unknown-classified exception (`retryable=false`).
- **TR-3 — Key-set drift guard.** The test MUST pin the builder's output key set to exactly `{error_message, error, stage, retryable}` so adding/removing keys on the worker side fails the build; the persisted-equality assertions catch key drift on the rag-api side (a renamed read key degrades to the fallback and fails equality).
- **TR-4 — Stage-tracker coverage.** Worker-side unit tests MUST pin the tracker on representative stages: an early-stage failure and a late-stage failure report the correct vocabulary token, and a failure before any assignment reports `"processing"`.
- **TR-5 — Hermetic execution.** The default run MUST be hermetic (fakes; no emulator process required). An emulator-backed variant MAY be supported via `FIRESTORE_EMULATOR_HOST`, which both services already branch on.
- **TR-6 — Optional static guard.** An AST-based drift guard in the house style (subprocess AST parse, as in `test_api_contracts.py`) MAY additionally pin the key literals on both sides; it is supplementary to TR-2/TR-3, not a replacement.

## 8. Constraints (binding)

- **must** — Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema.
- **must_not** — No Firestore migration, field rename, or backfill of existing documents.
- **must** — Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **prefer** — Retain the legacy `error` key alongside `error_message`.
- **prefer_not** — Do not introduce a structured error-code taxonomy.

## 9. Acceptance criteria and traceability

| # | Criterion (from definition) | Verified by |
|---|---|---|
| AC-1 | A failed job's status message contains `error_message`, `stage`, `retryable` — none relying on rag-api's fallback defaults | FR-1/2/3; TR-2, TR-3; TR-4 |
| AC-2 | Persisted resource doc has `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = worker's derived value | FR-1/3/4; TR-2 |
| AC-3 | `processing/summary` error subdocument carries the same message and stage as the main document | FR-4; TR-2 |
| AC-4 | Contract test covering worker failure → rag-api persistence exists and passes, failing on key drift on either side | FR-7; TR-1–TR-3 |

## 10. Open items / unknowns (preserved, not invented)

- **Other status-topic consumers.** Only rag-api's status subscriber is verified as a consumer of these payloads. Whether other services/tooling parse the worker's failure keys is unknown; the retained legacy `error` key (FR-5) is the hedge. A future audit may confirm the duplicate can be dropped.
- **Worker test scaffolding details.** `apps/ai-server/rag-worker-service/tests/` (with `conftest.py`, `fixtures/`, `integration/`, `unit/`) exists, but its conftest contents were not inspected; TR-4 must follow whatever fixture patterns it establishes (to be confirmed at implementation).
- **Integration-test environment dependencies.** Whether the `apps/ai-server/tests/integration` environment can import the worker's heavy third-party dependencies (langchain, spacy, sklearn, tiktoken, langfuse) unmocked is unverified; the architecture doc specifies a mock-extension approach with a documented fallback.
- **Companion D3 issue.** Referenced by the Objective; content unavailable here. Anything it covers beyond this payload alignment is deferred.
- **`plans/upload-flow.md` D4 note.** File not present in the current tree; reconciliation deferred.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

## 1. Design summary

The worker is the odd one out: three other write paths and two response/model surfaces already speak the `error`/`error_stage`/`retryable` persisted schema, while the worker's status publisher sends a single legacy `error` key that rag-api's failed branch does not read. The fix is therefore one-sided and additive:

1. The worker builds its failure payload with a new pure helper `build_failure_payload(e, stage)` that produces `{error_message, error (legacy duplicate), stage, retryable}` — `retryable` derived from the existing `classify_error(e)`.
2. `process_document` gains a stage tracker (a local assigned immediately before each pipeline step) so the failure handler reports the true failing stage.
3. rag-api is untouched: its failed branch already maps `error_message → error`, `stage → error_stage`, `retryable → retryable` and writes the summary error subdocument.
4. A cross-service contract test drives the worker's payload construction through rag-api's `run_transactional_update` against a fake transactional Firestore and pins the payload key set, so the seam cannot silently drift again.

No migration, no backfill, no reader changes.

## 2. System context (verified)

```
rag-api                          Pub/Sub                        rag-worker
───────                          ───────                        ──────────
POST /resources ──publish────▶ vector-process ──pull──────▶ run_worker (pull loop)
POST /process   ──publish────▶   (jobs)                       _claim_resource_if_queued
                                                                process_document pipeline
                                                              _heartbeat_loop / _stale_lease_sweep_loop
                                                                 │
rag-api subscriber                               ◀──publish──── _publish_status_update
  (_process_status_message)            rag-status-updates topic   (progress + terminal statuses)
    └─ run_transactional_update
         main doc + processing/summary
```

- Status topic/sub names: `rag_status_topic = "rag-status-updates"`, `rag_status_sub = "rag-status-updates-sub"` (rag-api config); the worker publishes to the topic from `RAG_STATUS_TOPIC`.
- Envelope published by `_publish_status_update`: `{user_id, course_id, resource_id, status, details, timestamp, sequence}`; `details["jobId"]` injected when a `job_id` is present; sequence counter reset on terminal states (`completed`, `failed`); each publish also refreshes the processing lease (`status_updated_at`) — all unchanged.
- Resource doc paths: canonical `users/{uid}/resources/{rid}` preferred, legacy `users/{uid}/courses/{cid}/courseResources/{rid}` as fallback (same resolution in worker claim, worker reads, and rag-api subscriber — verified in all three).
- `INDEPENDENT_RESOURCE_MARKER = "__ungrouped__"` shared by both services.

## 3. Current-state seam (what is broken, code-level)

- **Worker:** `process_document`'s `except` block does
  `await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)`.
- **rag-api:** `run_transactional_update` failed branch reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`.
- **Net effect:** every worker failure persists the fallback message, `error_stage = None`, `retryable = True` (fabricated), and `processing/summary.error = {code: "UNKNOWN", message: "Processing failed", stage: None}`.
- The worker's own `_fail_if_still_stale` sweep writes the correct schema directly to Firestore (`error`, `error_stage="processing"`, `retryable=True`) — evidence that the worker *knows* the schema; only its Pub/Sub publisher doesn't speak it.

## 4. Target design

### 4.1 Worker: failure-payload construction

Add a module-level pure helper in `rag-worker-service/main.py`, placed adjacent to `classify_error` (which already lives in the dependency-light head of the module):

```python
def build_failure_payload(e: Exception, stage: str) -> dict:
    message = str(e) or type(e).__name__   # never persist an empty error
    return {
        "error_message": message,   # contract key rag-api reads
        "error": message,           # legacy key retained for unknown consumers
        "stage": stage,             # failing pipeline stage (tracker value)
        "retryable": classify_error(e),  # deliberately derived, never defaulted
    }
```

The exception handler in `process_document` becomes:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", ...)
    details = build_failure_payload(e, current_stage)
    await self._publish_status_update(user_id, course_id, resource_id, "failed", details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

Rationale for co-locating derivation and construction: the contract test can exercise derivation + key construction in a single call, and there is exactly one construction site to keep conformant.

### 4.2 Worker: stage tracker

`process_document` is one large `try`; at failure time nothing currently knows where it was. Add a local `current_stage` initialized to `"processing"` before the `try`, assigned immediately before each pipeline step (set-before-await convention):

| Assignment point (immediately before…) | Tracker value |
|---|---|
| start of pipeline work (validation + first status publish) | `"starting"` |
| `_get_extracted_text` (text/PDF extraction) | `"text_retrieved"` |
| `content_tagger.generate_tags` | `"tagging_complete"` |
| `generate_document_summary` + `ragDescription` write | `"summary_generated"` |
| `_create_enhanced_chunks` | `"chunking_complete"` |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |
| vector delete/store, metadata save, usage update, resource map, final publish | (no new token — tracker remains `"embeddings_complete"`) |
| before any assignment (init; pre-`try` window) | `"processing"` (fallback) |

Design decisions, stated explicitly:

- **In-progress semantics.** The value names the milestone the executing step is producing (e.g., a failure during embedding generation reports `"embeddings_complete"` — read as "failure in the embeddings phase"). This reuses the exact existing progress vocabulary as mandated; no new tokens are invented.
- **Validation counts as `"starting"`.** `_validate_processing_request` is the first pipeline step, so a validation failure reports `"starting"` — the stage is genuinely known there. `"processing"` remains the safe value for the genuinely-unknown window (before the tracked body begins).
- **Post-embedding coarseness accepted.** Failures in the vector-storage phase report the last tracked value (`"embeddings_complete"`). The vocabulary is closed by requirement; adding a token would be scope creep. The contract/unit tests pin early- and late-stage representative failures, which catches the tracker being removed or bypassed without ossifying every step.
- **Drift convention.** "Set the tracker immediately before the await." A future pipeline step added without a tracker assignment reports the previous stage — the documented convention plus representative-stage tests are the mitigation.

### 4.3 rag-api: unchanged consumer

`run_transactional_update` already implements the target behavior exactly (verified): transition guard `processing → failed` via `ALLOWED_TRANSITIONS`, main-doc writes `error`/`error_stage`/`retryable`, and the merged `processing/summary` write with `stage`, `progress` (falls back to `0` for failure payloads — existing behavior, unchanged), and `error = {code: "UNKNOWN", message, stage}`. The fallbacks (`"Processing failed"`, `retryable=True`) remain in code for non-worker publishers of the topic but will never fire for worker failures once FR-1 holds. **No rag-api file is modified.**

### 4.4 Compatibility hedge (legacy `error` key)

Only rag-api's status subscriber is a *verified* consumer of these payloads; other services and tooling share the topic. Rather than audit every potential consumer for a one-line fix, the worker retains the legacy `error` key alongside `error_message` — one redundant string per failure message as insurance. If a later audit confirms rag-api is the only consumer, dropping the duplicate is trivial cleanup (and will be caught by the key-set pin, which is the drift guard doing its job).

## 5. Failure data flow (target)

```
rag-worker (process_document)                       rag-api (status subscriber)
─────────────────────────────                       ───────────────────────────
step k raises exception e
  (current_stage = S_k was set before step k)
  handler:
    payload = build_failure_payload(e, current_stage)
        error_message = str(e) or type name
        error         = error_message        (legacy)
        stage         = S_k
        retryable     = classify_error(e)    true: transient-classified
                                             false: permanent/unknown
    _publish_status_update("failed", payload, job_id)
      envelope {user_id, course_id, resource_id, status,
                details(+jobId), timestamp, sequence}; lease touch
      ─────────────▶ Pub/Sub rag-status-updates ─────────────▶ _process_status_message
                                                                resolve doc path (canonical → legacy)
                                                                run_transactional_update(db, doc_ref, "failed", details, …)
                                                                  guard: processing → failed allowed
                                                                  main doc:  error    ← details["error_message"]
                                                                             error_stage ← details["stage"]
                                                                             retryable  ← details["retryable"]
                                                                  processing/summary (merge):
                                                                             stage  ← details["stage"]
                                                                             progress ← 0 (no progress key sent)
                                                                             error  ← {code:"UNKNOWN",
                                                                                       message: details["error_message"],
                                                                                       stage: details["stage"]}
                                                                ack
```

Notes: the worker publishes the failure regardless of whether rag-api's update succeeds; rag-api nacks on internal errors (Pub/Sub redelivery) and skips (logs) on missing/deleted docs or invalid transitions — all existing behavior, unchanged.

## 6. Precise semantics of `retryable`

- The derivation adopts `classify_error` as the single source of truth for retryability reporting, aligning the persisted record with the worker's transient/permanent classification (the same function driving ACK/NACK decisions in `run_worker`).
- Precision note (verified): `process_document` catches its own exceptions and returns normally, so for **in-pipeline** failures the message is acked and the persisted `retryable` flag is informational — the retry affordance is manual reprocess via `POST /process` (which re-enqueues and re-runs the pipeline). For exceptions that escape `process_document` (e.g., message decode errors, `regenerate-map` failures), `classify_error` governs actual NACK/redelivery. Changing the re-raise behavior would be a retry-mechanics change and is a non-goal.
- The stale-lease sweep's separate `retryable=True` write stays correct and untouched: a worker dying mid-extraction is a transient condition by nature.
- `retryable` is persisted on the main document and present on the `Resource` model (default `True`), but is **not** exposed in `ResourceResponse` today; exposing it to clients is out of scope (frontend non-goal).

## 7. Test architecture

### 7.1 Cross-service contract test (`apps/ai-server/tests/integration/`)

New module (e.g., `test_failure_payload_contract.py`) beside `test_api_contracts.py`, reusing its `conftest.py` (env vars, cloud-SDK mocks, `sys.path` for rag-api).

**Module loading.** Both services name their entry module `main`; the existing `import main as rag_api_main` pattern occupies `sys.modules["main"]`. Load the worker explicitly to avoid the collision:

```python
import importlib.util
def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
rag_worker = _load("rag_worker_main", ".../rag-worker-service/main.py")
```

The worker's module-level code is import-safe under mocks: `os.environ["GCP_PROJECT"]` and `GOOGLE_APPLICATION_CREDENTIALS` are already set by conftest; `service_account.Credentials.from_service_account_file` and `pubsub_v1.SubscriberClient` resolve against the existing `MagicMock` modules; `workers.resource_map_generator` is imported lazily inside functions (verified), so no package context is needed. Extend `conftest.py`'s `required_mocks` with the worker's heavy third-party imports (`langchain.text_splitter`, `langchain.schema`, `openai`, `langfuse`, `spacy`, `sklearn.feature_extraction.text`, `tiktoken`, `tenacity`) so the imports resolve. Note: `@retry(...)`-decorated *methods* become MagicMocks under this loading — acceptable, because the test only calls module-level functions (`build_failure_payload`, `classify_error`, `TransientError`), which are undecorated. **Documented fallback:** if the heavy-mock import proves brittle in CI, extract `classify_error` + `build_failure_payload` into a dependency-light module (e.g., `rag-worker-service/failure_payload.py`) that `main.py` imports — a mechanical, behavior-preserving move.

**Fake transactional Firestore.** `run_transactional_update(db, doc_ref, new_status, details, logger, user_id)` is dependency-injected, so a behavioral test needs only:

- patch `rag_api_main.firestore` with a fake exposing `transactional` (identity decorator) and `SERVER_TIMESTAMP` (sentinel) — `run_transactional_update` resolves `firestore` as a module global, so the patch is local to the test and touches no production code;
- `FakeDb.transaction()` → token object; `FakeDocRef.get(transaction=…)` → snapshot with `exists=True`, `to_dict() → {"status": "processing"}` (so the `processing → failed` transition is allowed); `FakeDocRef.update(dict)` and the `processing/summary` ref's `set(dict, merge=True)` recorded for assertions;
- a logger stub (`.info`/`.warning`).

The Firestore **emulator** variant (both services branch on `FIRESTORE_EMULATOR_HOST` — verified) is supported as an opt-in higher-fidelity mode; the fake is the default hermetic path (TR-5).

**Test cases.**

1. `test_transient_failure_persists_worker_values` — `payload = rag_worker.build_failure_payload(rag_worker.TransientError("boom"), "embeddings_complete")`; run rag-api's failed branch; assert main doc `error == "boom"`, `error_stage == "embeddings_complete"`, `retryable is True`; assert summary `error.message == "boom"`, `error.stage == "embeddings_complete"`, `error.code == "UNKNOWN"`, `stage == "embeddings_complete"`.
2. `test_permanent_unknown_failure_persists_retryable_false` — same with a plain `ValueError` (exercises the conservative unknown → permanent default); assert `retryable is False` end-to-end.
3. `test_payload_key_set_pinned` — `set(payload) == {"error_message", "error", "stage", "retryable"}` (worker-side drift guard; `jobId` is added downstream by the publish path and is out of scope for the builder pin).
4. `test_legacy_error_key_matches_error_message` — `payload["error"] == payload["error_message"]` (hedge continuity, FR-5).
5. (Supplementary) `test_fallbacks_remain_for_non_worker_payloads` — a details dict lacking the new keys still persists `"Processing failed"` / `None` / `True`, documenting that rag-api's fallbacks survive for legacy publishers while no longer firing for worker failures.

Drift detection is behavioral: a renamed read key on the rag-api side degrades persistence to the fallback and fails case 1/2's equality assertions; a renamed/removed worker key fails case 3. An optional AST guard in the house subprocess style (TR-6) may additionally pin the key literals in both sources.

### 7.2 Worker-side stage-tracker unit tests

New unit tests under `apps/ai-server/rag-worker-service/tests/unit/` (the worker's own test environment, where its real dependencies are installed; `pytest.ini` sets `asyncio_mode = auto`):

- early-stage failure: force `_get_extracted_text` to raise a connection-type error → captured failed details have `stage == "text_retrieved"`, `retryable is True`, `error_message` = the actual message;
- late-stage failure: force `_generate_embeddings_with_openrouter` to raise `ValueError` → `stage == "embeddings_complete"`, `retryable is False`;
- unknown-stage failure: raise before any tracker assignment → `stage == "processing"`.

Capture via a stubbed `_publish_status_update`. The exact fixture approach must follow the existing patterns in `rag-worker-service/tests/conftest.py` (contents not inspected in this cycle — to be confirmed at implementation).

### 7.3 What the tests pin — and deliberately don't

- **Pinned:** payload key set and values; derivation polarity for both classification outcomes; rag-api's mapping of all three keys (main doc + summary subdocument); tracker correctness on representative early/late stages and the fallback.
- **Deliberately not pinned:** every intermediate pipeline step's tracker assignment (representative coverage only, per the definition); envelope fields (`timestamp`, `sequence`, lease writes); the sweep's write; ACK/NACK mechanics.

## 8. Observable behavior changes

1. Persisted `error` for worker failures changes from the fallback `"Processing failed"` to the actual exception message.
2. Persisted `error_stage` changes from `None` to the failing stage token (or `"processing"` when genuinely unknown — never `None`).
3. Persisted `retryable` for permanent/unclassified-unknown failures changes from `true` (silent default) to `false` — deliberate, aligning with `classify_error`'s conservatism; manual reprocess via `POST /process` unaffected.
4. `processing/summary.error` now carries the real message and stage; `error.code` remains `"UNKNOWN"` (no taxonomy introduced).
5. `processing/summary.stage` on failure changes from `"unknown"` to the actual stage; `progress` remains `0` (no progress key in failure payloads — existing behavior).
6. Worker failure payloads additionally carry `error` (legacy duplicate) — no consumer-visible removal.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained (FR-5); residual risk accepted as low; trivial cleanup later if audit confirms single consumer |
| Stage-tracker drift as the pipeline evolves | Set-before-await convention documented in code; representative early/late-stage tests (TR-4) |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted per definition; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key later means touching the test, which is the point |
| Worker heavy-dep import brittleness in the integration environment | importlib loading + extended `required_mocks`; documented fallback: extract `classify_error`/`build_failure_payload` into a dependency-light module |
| Empty exception strings persisting as empty `error` | `str(e) or type(e).__name__` rule (ER-1) |

## 10. Alternatives considered and rejected

- **Align rag-api to the worker (`details.get("error")`)** — rejected: forbidden by the must-constraint, and `error`/`stage` are the *richer* contract already spoken by three write paths and the `Resource` model; changing the API side is the change that ripples.
- **Firestore schema migration / new fields / backfill** — forbidden by must_not.
- **Structured error codes** — prefer_not; `error.code` stays `"UNKNOWN"`.
- **Re-raise from `process_document` so `run_worker`'s ACK/NACK governs in-pipeline failures** — a retry-mechanics change (non-goal); not needed for the payload fix; noted in §6 for semantic precision.
- **Adding `progress` to failure payloads** — not required by the definition; summary `progress` fallback `0` is existing behavior, left unchanged.

## 11. Files touched (implementation notes)

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Add `build_failure_payload(e, stage)` next to `classify_error`; add stage tracker to `process_document` (init + per-step assignments); exception handler builds payload via the helper. Nothing else in the file changes. |
| `apps/ai-server/tests/integration/conftest.py` | Extend `required_mocks` with the worker's heavy third-party imports (list in §7.1). |
| `apps/ai-server/tests/integration/test_failure_payload_contract.py` | New contract test (cases in §7.1). |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_stage_tracking.py` | New stage-tracker unit tests (§7.2); filename indicative. |

**No changes:** `rag-api-service/**` (all files), worker sweep/heartbeat/`run_worker`/claim logic, `_publish_status_update` envelope behavior, models, frontend.

## 12. Deferred / out of scope

Same list as requirements §3 (non-goals), plus: reconciling with the companion D3 issue (content unavailable) and the D4 deviation note in the absent `plans/upload-flow.md`; auditing non-verified status-topic consumers; exposing `retryable` in `ResourceResponse`.

## 13. Open questions

1. Do any undiscovered consumers parse the worker's failure payload keys? (Hedge in place; audit deferred.)
2. Can the integration environment import the worker module under extended mocks, or is the dependency-light extraction fallback needed? (Decided at first test run; both paths specified.)
3. What does the companion D3 issue cover? (Unavailable in this context; deferred.)
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>