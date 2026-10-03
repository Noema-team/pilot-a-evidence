Investigation is complete; producing the contracted design artifacts from the verified repository evidence (worker `main.py` failure handler/publisher/classifier/ACK-NACK/sweep, rag-api `run_transactional_update` failed branch and subscriber, `models/resource.py`, both test conftest stub sets, and `tests/integration/test_api_contracts.py` patterns), with anything not directly verified preserved as stated in the authoritative Definition or flagged as unknown.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- Work item: `wi-define-108-a8` (authoritative Definition artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`)
- Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- Step: design (requirements). Scope is exactly the Definition's bounded scope; nothing here widens, narrows, or reinterprets it.

## 1. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## 2. Problem statement (current behavior, verified in repository)

- The worker's `process_document` exception handler (`apps/ai-server/rag-worker-service/main.py`) publishes the failed status with a one-key payload: `_publish_status_update(..., "failed", {"error": str(e)}, job_id)`.
- rag-api's failed branch (`run_transactional_update` in `apps/ai-server/rag-api-service/main.py`) reads three keys — `error_message`, `stage`, `retryable` — and persists `error`, `error_stage`, `retryable` on the main resource document, plus `message`/`stage` (and `code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument.
- Because of the key mismatch, every worker-originated failure currently persists `error` as the fallback `"Processing failed"`, `error_stage` as `None`, and `retryable` as the silent default `True`. The `processing/summary` error subdocument inherits the same fallbacks, with `error_code` always `"UNKNOWN"`.
- The established persisted failure schema (`error`, `error_stage`, `retryable`) is already written directly by the worker's stale-lease sweep (`_fail_if_still_stale`, which writes `error_stage: "processing"`, `retryable: True`) and by rag-api's enqueue-failure paths, and is exposed by the `Resource` model (`retryable` defaults `True`) and `ResourceResponse` (`error`, `error_stage`). The worker's status publisher is the only failure writer that does not speak this contract.

## 3. Scope

### 3.1 In scope
- The worker's failed-status payload construction in `process_document`'s exception handler (keys, values, derivation).
- Stage tracking inside `process_document` so the failure handler can report the failing stage.
- The contract test covering the worker failure → rag-api persistence path.
- Verification that rag-api's existing failed branch persists worker-provided values unchanged (no rag-api code change required).

### 3.2 Out of scope (non-goals, from the Definition)
- Changing the stale-lease sweep's direct failure write (already consistent with the contract).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error `code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred), and reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## 4. Functional requirements

### FR-1 — Worker failure payload contract (MUST)
When document processing fails, the worker's failed status payload (`details` of the `"failed"` status message published to the status topic) MUST include:
- `error_message`: the actual exception message (`str(e)`), not a placeholder;
- `stage`: the pipeline stage executing at failure time (non-empty string, per FR-2);
- `retryable`: a boolean deliberately derived per FR-4.

The payload MUST NOT rely on rag-api's fallback defaults (`"Processing failed"`, `stage → None`, `retryable → True`) for any of these keys; all three MUST be present in every worker-originated failure payload.

### FR-2 — Stage tracking (MUST)
- The worker MUST track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.
- Stage names MUST reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown; it MUST be the normalized value whenever the tracked stage is missing or empty at failure time. (This matches the value the stale-lease sweep uses for `error_stage`, so the field never regresses to `null`.)
- The tracker MUST be assigned immediately before each pipeline step (the "set before the await" convention) so a failure inside a step reports that step's stage.

### FR-3 — rag-api persistence unchanged (MUST)
rag-api's failed branch MUST persist the worker-provided values unchanged:
- main document: `error` ← payload `error_message`; `error_stage` ← payload `stage`; `retryable` ← payload `retryable`;
- `processing/summary` error subdocument: `message` ← payload `error_message`; `stage` ← payload `stage`; `code` remains the `"UNKNOWN"` default (the worker sends no `error_code`).

This is the existing rag-api behavior (verified); the requirement is that it hold unchanged — no modification to rag-api's reads or persisted schema.

### FR-4 — retryable derivation (MUST)
The retryable derivation MUST be explicit and aligned with the worker's ACK/NACK behavior, using the same `classify_error()` the worker already uses in `run_worker`:
- errors classified transient by `classify_error` → `retryable: true`;
- errors classified permanent by `classify_error` — including unclassified-unknown exceptions, per `classify_error`'s conservative default — → `retryable: false`.

Every worker-originated failure payload MUST carry `retryable` explicitly; the API-side `details.get("retryable", True)` fallback MUST NOT be the operative mechanism for worker failures.

### FR-5 — Contract test (MUST)
A contract test MUST cover the worker failure → rag-api persistence path:
- It MUST exercise the worker's failure-payload construction (the real worker code path, not a restated fixture) and rag-api's failed-branch persistence (via the Firestore emulator or fakes).
- It MUST assert the persisted `error`, `error_stage`, and `retryable` equal the worker's payload values.
- It MUST fail if either side's payload keys drift (renaming/removing a contract key on either side breaks the build).
- It MUST cover at least an early-stage failure and a late-stage failure (representative stage coverage; it need not ossify every pipeline step).

## 5. Normative contract specification

### 5.1 Worker failure payload (`details` of the `"failed"` status message)

| Key | Type | Value | Status |
|---|---|---|---|
| `error_message` | string | `str(exception)` — the actual error message | new, required |
| `stage` | string | tracked pipeline stage (FR-2 vocabulary); normalized to `"processing"` if missing/empty | new, required |
| `retryable` | boolean | `classify_error(exception)` (FR-4) | new, required |
| `error` | string | `str(exception)` — legacy key retained for continuity with any existing consumers of the status topic and log tooling | retained (prefer-constraint) |

Keys the worker does NOT send: `error_code` (no taxonomy in this fix), `progress` (unchanged — the failed payload never carried it; rag-api's summary `progress` fallback of 0 is existing behavior).

### 5.2 rag-api persistence mapping (existing behavior, must hold)

| Payload key | Main document field | `processing/summary` |
|---|---|---|
| `error_message` | `error` | `error.message` |
| `stage` | `error_stage` | `error.stage` (and the summary's top-level `stage`) |
| `retryable` | `retryable` | — |
| `error` (legacy) | not read | not read |
| `error_code` (not sent) | — | `error.code` = `"UNKNOWN"` default |

### 5.3 Stage vocabulary and tracker semantics
- Tracker initialized to `"starting"` (covers validation/claim phase, matching the first progress update).
- Assigned immediately before each pipeline step to that step's vocabulary name: text extraction → `text_retrieved`; tagging → `tagging_complete`; summary generation + document update → `summary_generated`; chunking → `chunking_complete`; embeddings → `embeddings_complete`.
- The post-embeddings vector-storage phase has no name in the bounded vocabulary; the tracker retains the last assigned value there (see Architecture §3.1 for the interpretation and residual).
- `"processing"` is the defensive normalization for a missing/empty tracked stage.

## 6. Constraints (from the Definition, binding)

1. **MUST** — The worker is aligned to rag-api's existing contract (publishing `error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are NOT changed.
2. **MUST NOT** — No Firestore migration, field rename, or backfill of existing documents; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
3. **MUST** — Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side fallback is not the operative mechanism for worker failures.
4. **PREFER** — Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling.
5. **PREFER NOT** — Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

## 7. Deliberate behavior changes (accepted)

- **B1** — Persisted `error` for worker failures changes from the fallback `"Processing failed"` to the worker's actual exception message.
- **B2** — Persisted `error_stage` for worker failures changes from `None` to the actual failing stage (never `None` for worker failures).
- **B3** — Persisted `retryable` changes from the silent default `True` to the derived value: transient-classified errors keep the effective `True`; permanent-classified errors and unclassified-unknown exceptions flip to `False`. Rationale: aligns the persisted record with the worker's actual ACK/NACK retry behavior; the conservatism prevents infinite retry loops; manual reprocess via `POST /process` remains. The stale-lease sweep's separate `retryable: true` write stays correct (a dead worker is a transient condition).
- **B4** — `processing/summary` error subdocument gains the real `message` and `stage`; the summary's top-level `stage` changes from the `"unknown"` fallback to the actual stage; `error.code` remains `"UNKNOWN"`.

## 8. Acceptance criteria and verification

| # | Criterion (from the Definition) | Verification |
|---|---|---|
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | Contract test payload-shape cases (early-stage/permanent, late-stage/transient, unknown-exception) + exact key-set assertion on the builder output (FR-1, FR-2, FR-4). |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | Contract test persistence assertions through rag-api's failed branch (FR-3, FR-5). |
| AC-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | Contract test summary-subdocument assertions (FR-3). |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | The contract test itself, including the seam test and drift guards (FR-5; Architecture §4). |

## 9. Assumptions and open items

- **A1 (ASSUMED, adopted — Definition F8)** — retryable derivation maps `classify_error` output directly (transient → true, permanent/unknown → false). Rationale recorded in §7/B3.
- **A2 (ASSUMED — Definition F11)** — No consumer other than rag-api's status subscriber is known to parse the worker's failure payload keys; the legacy `error` key is retained as a hedge. Residual risk accepted as low; an audit confirming the worker is the only publisher and rag-api the only consumer would make dropping the duplicate trivial cleanup (out of scope here).
- **O1** — rag-api's enqueue-failure write shape for `POST /resources` is taken from the Definition (F6); this design pass directly verified the `/process` enqueue-failure write and the stale-lease sweep write. No requirement depends on the difference.
- **O2** — The set of all consumers of the status topic is unaudited (hedge in place per A2).
- **O3** — Companion D3 issue content unavailable; anything beyond this payload alignment is deferred (Definition F12).

## 10. Risks

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves (a future step added without updating the tracker reports a stale stage) — mitigated by the "set before the await" convention and representative-stage contract coverage.
- **`retryable: false` for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope, and manual reprocess via `POST /process` remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## 11. Non-functional requirements

- No new dependencies, configuration, environment variables, or network calls.
- No measurable latency impact: the fix adds one dict construction and reuses the existing `classify_error` call path and publisher.
- Logging unchanged in structure; the existing `document_processing_failed` log line keeps its `error` field.
- No changes to the publisher's sequencing, lease-heartbeat, or `jobId`-injection behavior in `_publish_status_update`.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

- Work item: `wi-define-108-a8` · Step: design (architecture) · Companion doc: `docs/requirements.md`
- All code locations below were verified in the current tree unless explicitly attributed to the Definition.

## 1. Context and current state (verified)

### 1.1 The seam
The worker and rag-api communicate job outcomes over the status topic (`RAG_STATUS_TOPIC` / `rag-status-updates-sub`):

```
rag-worker process_document                 rag-api _process_status_message
  exception handler                            (Pub/Sub subscriber callback)
  publishes "failed"      ── Pub/Sub ──▶        parses payload.details
  details={"error": str(e)}                    run_transactional_update(db, doc_ref,
                                                 "failed", details, ...)
                                               ├─ main doc:   error ← details["error_message"]
                                               │              error_stage ← details["stage"]
                                               │              retryable ← details["retryable"]
                                               └─ processing/summary:
                                                              error.code/message/stage
```

The worker sends `{"error": ...}`; rag-api reads `error_message`/`stage`/`retryable`. Every worker failure therefore persists the fallbacks: `error = "Processing failed"`, `error_stage = None`, `retryable = True` (silent default), and the summary subdocument inherits them with `error.code = "UNKNOWN"`.

### 1.2 Why the worker aligns to the API (decision)
The persisted schema (`error`, `error_stage`, `retryable`) is already written consistently by three other paths and exposed by two models:
- Worker stale-lease sweep `_fail_if_still_stale` writes `{"status": "failed", "error": "processing lease expired without heartbeat — worker died or stalled", "error_stage": "processing", "retryable": True, ...}` inside its transaction.
- rag-api's enqueue-failure path in `POST /process` writes `error` / `error_stage: "enqueue"` directly (per Definition F6, the `POST /resources` enqueue-failure path does the same).
- `models/resource.py` `Resource` carries `error: Optional[str]`, `error_stage: Optional[str]`, `retryable: bool = True` in both `to_dict`/`from_dict`; `ResourceResponse` exposes `error` and `error_stage` to clients.

Changing the API side would ripple through all of these; the worker's status publisher is the single outlier. Fix the outlier. No migration, no backfill, no reader changes.

### 1.3 Relevant verified mechanics
- `classify_error(e)` (worker `main.py`): returns `True` (transient) for `TransientError`, `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, and `httpx.HTTPStatusError` with status 429/500/502/503/504; returns `False` (permanent) for `PermanentError`, other 4xx `HTTPStatusError`, and — conservatively — any unknown exception.
- `run_worker` uses the same function for ACK/NACK: transient → omitted from `ack_ids` (Pub/Sub redelivers); permanent → acked. `retryable` in the payload is therefore the persisted mirror of the worker's actual retry decision.
- `process_document` is one large `try` block; progress updates publish the stage vocabulary `starting`, `text_retrieved` (20), `tagging_complete` (40), `summary_generated` (50), `chunking_complete` (60), `embeddings_complete` (80), final `completed` (100). The failure handler has no stage awareness today.
- `_publish_status_update` builds `message_data = {user_id, course_id, resource_id, status, details, timestamp, sequence}`, injects `jobId` into `details` when a job id is present, performs lease-heartbeat writes, resets the sequence on terminal states (`completed`/`failed`), and swallows its own publish errors (logs `status_publish_failed`). It is key-agnostic w.r.t. `details` — no publisher change is needed.
- rag-api's transition guard allows `processing → failed` (`ALLOWED_TRANSITIONS`); the subscriber resolves the canonical path `users/{uid}/resources/{rid}` first with the legacy course path as fallback, then calls `run_transactional_update` via `asyncio.to_thread` and acks.
- Both services support hermetic Firestore-emulator modes (`FIRESTORE_EMULATOR_HOST` branches in both `_init_services`/`startup`; the worker additionally handles `STORAGE_EMULATOR_HOST` and logs `PUBSUB_EMULATOR_HOST`).

## 2. Target design

### 2.1 Component changes

| Component | Change | Size |
|---|---|---|
| `rag-worker-service/main.py` | (a) stage tracker in `process_document`; (b) new module-level pure function `build_failure_details(exception, stage)` + stage constants; (c) exception handler builds the payload via (b) | small, single-file |
| `rag-api-service/main.py` | **none** — the failed branch already implements FR-3 | zero |
| `tests/integration/` | new contract test module (worker payload construction → rag-api failed-branch persistence) + stub reconciliation | new file |
| Models / schema / infra | none | zero |

### 2.2 Worker: stage tracker (FR-2)
A local `current_stage` in `process_document`, initialized to `"starting"` before the `try`, assigned immediately before each pipeline step (the "set before the await" convention):

| Tracker assignment point | Value |
|---|---|
| initialization (validation / claim phase) | `"starting"` |
| before `_get_extracted_text` | `"text_retrieved"` |
| before `content_tagger.generate_tags` | `"tagging_complete"` |
| before `generate_document_summary` + main-doc update | `"summary_generated"` |
| before `_create_enhanced_chunks` | `"chunking_complete"` |
| before `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |
| post-embeddings vector-storage phase (`delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`) | retains `"embeddings_complete"` (see residual below) |

**Interpretation (bounded by the Definition):** the stage vocabulary is fixed to the six progress names plus the `"processing"` fallback; no name exists for the vector-storage phase. The tracker therefore carries "last named milestone reached/being executed" semantics in that phase; the error message itself carries the specifics (e.g. `store_chunks_via_service`'s `"partial vector write: X/Y chunks stored..."`). The alternative — reporting `"processing"` there — was rejected because `"processing"` is defined as the value for a *genuinely unknown* stage, and the storage phase is known, just unnamed. This residual is documented deliberately; extending the vocabulary is out of scope for this fix.

**Drift risk and mitigation:** a future pipeline step added without updating the tracker reports a stale stage. The convention is "set the tracker immediately before the await"; the contract test pins the mechanism on representative stages (early + late), which catches the tracker being removed or bypassed without ossifying every step.

### 2.3 Worker: failure payload builder (FR-1, FR-4)
New module-level pure function in the worker's `main.py` (co-located with `classify_error`, which it calls):

```
build_failure_details(exception: Exception, stage: str) -> dict
```

Behavior:
- `error_message` = `str(exception)`
- `stage` = `stage` if truthy else `"processing"` (defensive normalization; the constant for the safe value is shared with the sweep's semantics)
- `retryable` = `classify_error(exception)` — the identical classification `run_worker` uses for ACK/NACK, so the persisted record tells the truth about whether Pub/Sub will redeliver (transient → `true`) or the job was acked as permanent (→ `false`, manual reprocess via `POST /process` remains)
- `error` = `str(exception)` — legacy key retained per the prefer-constraint (compatibility hedge for unaudited consumers of the status topic)

Output key set (normative, pinned by the contract test): `{"error", "error_message", "stage", "retryable"}`.

Purity is the point: the contract test can construct real worker payloads without running the pipeline, and the handler cannot diverge from the tested construction.

### 2.4 Worker: exception-handler wiring
The `except Exception as e:` block in `process_document` becomes:

- keep `metrics.error_message = str(e)` and the `document_processing_failed` log (unchanged);
- `details = build_failure_details(e, current_stage)`;
- `_publish_status_update(user_id, course_id, resource_id, "failed", details, job_id)` — unchanged call shape; the publisher keeps injecting `jobId`, sequencing, and heartbeat behavior.

Failure modes around the handler are unchanged and safe: `_publish_status_update` swallows its own errors, and the tail helpers (`_update_user_usage`, `_generate_resource_map`, `_save_processing_metadata_to_subcollection`, `delete_old_vectors_via_service`) catch their own exceptions, so they cannot mask or double-report failures. `store_chunks_via_service` raising on partial writes is a real failure path that now reports `error_stage = "embeddings_complete"` (last named milestone) with a descriptive message — see §2.2 residual.

### 2.5 rag-api: no change (FR-3)
`run_transactional_update`'s failed branch is already the contract consumer:
- main doc: `error ← details.get("error_message", "Processing failed")`, `error_stage ← details.get("stage")`, `retryable ← details.get("retryable", True)`;
- summary: `stage ← details.get("stage", "unknown")`, and on failure `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`.

With the worker always sending all three keys, the fallbacks become dead paths for worker failures (they remain for any non-worker publisher; removing them is out of scope per the must-not-change constraint). The worker sends no `error_code`, so `error.code` stays `"UNKNOWN"` — exactly the prefer-not-taxonomy outcome. The transition guard (`processing → failed`) is unaffected.

## 3. End-to-end failure flow (target)

1. Exception raised inside `process_document`'s try block → handler builds `details = build_failure_details(e, current_stage)`.
2. `_publish_status_update(..., "failed", details, job_id)` publishes JSON to the status topic (sequence reset, lease heartbeat, `jobId` injection — unchanged).
3. rag-api's subscriber `_process_status_message` parses the payload, resolves the resource path, and runs `run_transactional_update` in a thread.
4. Transition `processing → failed` is applied: main doc gets the worker's actual `error` / `error_stage` / derived `retryable`; `processing/summary` gets `error.{code="UNKNOWN", message, stage}` and top-level `stage`.
5. Clients read the failure via `ResourceResponse` (`error`, `error_stage`) — no client change.

## 4. Contract test architecture (FR-5, AC-4)

### 4.1 Location and house pattern
New test module in `apps/ai-server/tests/integration/` (sibling of `test_api_contracts.py`, reusing its conventions: direct imports over fixtures, AST-based static guards, subprocess isolation where needed). The existing integration `conftest.py` already stubs the cloud SDKs (`firebase_admin`, `google.cloud.*`, `structlog`) and puts `rag-api-service` on `sys.path`, so `run_transactional_update` is importable as `rag_api_main.run_transactional_update`.

### 4.2 Two halves, joined at the seam
**Worker half (payload construction).** Import the worker's `build_failure_details` and call it with representative exceptions. The worker's own test stubbing pattern (`rag-worker-service/tests/conftest.py`: env defaults + stub modules for `openai`, `firebase_admin`, `google.cloud.*`, `spacy`, `tiktoken`, `tenacity`, langchain, langfuse) makes worker `main.py` importable without heavy deps; the contract test applies that stub set (by reusing or replicating it) before importing the worker module. Where the two conftests stub the same modules (`firebase_admin`, `google.cloud`), the contract test owns the reconciliation explicitly.

**rag-api half (persistence).** Call `rag_api_main.run_transactional_update` against a fake Firestore surface. Key verified property that makes this clean: `@firestore.transactional` decorates `update_logic` **at call time** (the decorator line is inside `run_transactional_update`'s body), so the test can patch `transactional` to an identity decorator on the already-stubbed `firebase_admin.firestore` module object — no module reload needed.

**Minimal fake surface** (exactly what `run_transactional_update` touches, verified):
- `db.transaction()` → fake transaction;
- fake `doc_ref`: `.id`, `.get(transaction=...)` → snapshot with `.exists` / `.to_dict()`, `.collection("processing").document("summary")` → summary ref;
- fake transaction: `.update(doc_ref, dict)`, `.set(summary_ref, dict, merge=True)`;
- `firebase_admin.firestore.SERVER_TIMESTAMP` patched to a sentinel;
- a no-op `logger` stub.
Seed the document with `status = "processing"` so the `processing → failed` transition is allowed (a `queued` seed would be rejected by the transition guard and silently skip the write).

**Alternative fidelity path:** the Firestore emulator (both services have verified emulator branches) can replace the fake for a full-fidelity variant; the fake is the default because it is deterministic, fast, and pins the exact keys without booting infrastructure.

### 4.3 Test cases

| ID | Case | Assertions |
|---|---|---|
| TC-1 | Early-stage permanent failure: `ValueError("Document ... not found ...")`, stage `"starting"` | Payload keys/values correct; persisted `error` == worker message (not `"Processing failed"`), `error_stage == "starting"` (not `None`), `retryable is False`; summary `error.message`/`error.stage` match main doc; `error.code == "UNKNOWN"` |
| TC-2 | Late-stage transient failure: transient-classified exception (e.g. `httpx.ReadTimeout` or a `TransientError` subclass), stage `"embeddings_complete"` | Same persisted-equality assertions; `retryable is True` |
| TC-3 | Unclassified-unknown exception (e.g. `RuntimeError`) | `retryable is False` — pins the deliberate conservative default (behavior change B3) |
| TC-4 | Key-set drift guard on the builder | `set(payload) == {"error", "error_message", "stage", "retryable"}` — any addition or removal fails the build |
| TC-5 | Seam drift (implicit in TC-1/TC-2) | Persisted values are asserted equal to the *worker's* values; renaming a key on either side makes rag-api fall back (or drop a value) and the equality assertion fails |
| TC-6 (secondary) | Static AST guard, following the existing agent-graph AST pattern in `test_api_contracts.py` | Worker's builder emits `error_message`/`stage`/`retryable` (plus legacy `error`); rag-api's failed branch reads exactly those keys |

TC-1/TC-2/TC-3 run the *actual* builder output through the *actual* `run_transactional_update` — the seam itself, not a restated contract. TC-4/TC-6 are belt-and-suspenders drift guards for key-set changes the equality assertions might not surface (e.g. dropping the legacy `error` key).

### 4.4 CI placement
Runs in the existing integration suite; no emulator, credentials, or network required (fake-based path). The emulator variant, if added later, belongs to the hermetic stack, not this test's default path.

## 5. Compatibility and migration

- **No migration, rename, or backfill.** Persisted field names and semantics are untouched; existing documents are unaffected.
- **Legacy key hedge.** The worker retains `error` alongside `error_message`. Verified consumers of the payload keys are rag-api's subscriber; other services/tooling share the topic and were not audited (unknown, accepted). Dropping the duplicate after an audit is trivial cleanup and explicitly out of scope.
- **Publisher compatibility.** `_publish_status_update`'s envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`) and its `jobId` injection are unchanged; only the `details` content of the failed message grows.

## 6. Behavior change register

| # | Before | After | Deliberate |
|---|---|---|---|
| B1 | Persisted `error` = `"Processing failed"` | Worker's actual exception message | yes |
| B2 | Persisted `error_stage` = `None` | Actual failing stage (never `None` for worker failures) | yes |
| B3 | Persisted `retryable` = silent `True` | Derived: transient `True`; permanent and unclassified-unknown `False` | yes (Definition F8) |
| B4 | Summary `error.message`/`stage` = fallbacks; top-level `stage` = `"unknown"` | Real message and stage; `error.code` stays `"UNKNOWN"` | yes |

## 7. Risks and tradeoffs

- **Unknown status-topic consumers** reading the old key set — mitigated by retaining `error`; residual risk accepted as low (A2).
- **Stage-tracker drift** — mitigated by the set-before-await convention and representative-stage test coverage; the residual for the unnamed vector-storage phase is documented in §2.2.
- **`retryable: false` for unrecognized-but-transient failures** — accepted; widening `classify_error` is out of scope, manual reprocess via `POST /process` remains, and the flag now matches the worker's real ACK/NACK decision.
- **Test ossification** — intentional drift guard; adding a key means touching the test.

## 8. Out of scope / deferred

Stale-lease sweep behavior; ACK/NACK policy, leases, heartbeats; frontend/mobile; structured error codes; the companion D3 issue's scope (content unavailable — Definition F12); reconciling with the D4 deviation note in `plans/upload-flow.md` (file absent from the current tree); auditing/dropping the legacy `error` key.

## 9. Traceability matrix

| Acceptance criterion | Requirements | Architecture | Tests |
|---|---|---|---|
| AC-1 (payload carries all three keys, no fallback reliance) | FR-1, FR-2, FR-4 | §2.2, §2.3, §2.4 | TC-1, TC-2, TC-3, TC-4 |
| AC-2 (persisted main doc equals worker values) | FR-3, FR-5 | §2.5, §3 | TC-1, TC-2 (persisted assertions) |
| AC-3 (summary subdoc matches main doc) | FR-3 | §2.5 | TC-1 (summary assertions) |
| AC-4 (contract test exists, passes, catches drift) | FR-5 | §4 | TC-1–TC-6 |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>