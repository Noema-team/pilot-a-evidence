All repository evidence needed for this design was verified during investigation (worker `process_document` handler, `_publish_status_update`, `classify_error`, `run_worker` ACK/NACK, `_fail_if_still_stale`, rag-api `run_transactional_update` failed branch, `_process_status_message`, both services' emulator branches, and the integration-test conftest/contract-test infrastructure). Producing the contracted artifacts now from that verified base; definition-asserted facts I could not personally re-read (e.g., `models/resource.py` internals) are labeled as such.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- WorkItem: `wi-define-108-a8` (authoritative Definition artifact `definition:obj-108`, sha256 `71f1c39c…`)
- Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- Status: design-phase requirements; binding for implement and verify steps.

## 1. Problem statement

The rag-worker's failure publisher and rag-api's failure consumer were written against different contracts. The worker's exception handler in `process_document` publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch in `run_transactional_update` reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error` / `error_stage` / `retryable`. Every worker-originated failure therefore lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true`. The `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures.

The established persisted failure schema (`error`, `error_stage`, `retryable`) is already used consistently by three other write paths (worker stale-lease sweep, rag-api enqueue-failure paths) and exposed by `ResourceResponse` and the `Resource` model. The worker's status publisher is the only writer that does not speak it. The fix direction is fixed by the Definition: **the worker aligns to rag-api's existing contract** — no rag-api read or schema changes, no migration.

## 2. Verified evidence base

Facts below marked **[V]** were directly verified in the repository during investigation. Facts marked **[D]** are asserted by the authoritative Definition (repository-claimed there) but were not independently re-read; they are treated as binding per the Definition's authority.

- [V] `apps/ai-server/rag-worker-service/main.py` — `process_document` exception handler publishes `await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)`.
- [V] `apps/ai-server/rag-api-service/main.py` — `run_transactional_update` failed branch: `main_update["error"] = details.get("error_message", "Processing failed")`, `main_update["error_stage"] = details.get("stage")`, `main_update["retryable"] = details.get("retryable", True)`; summary subdocument gets `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}` and top-level `stage = details.get("stage", "unknown")`, `progress = details.get("progress", 0)`, merged with `merge=True`.
- [V] Worker progress updates publish stage tokens: `starting`, `text_retrieved` (progress 20), `tagging_complete` (40), `summary_generated` (50), `chunking_complete` (60), `embeddings_complete` (80), final `completed` (100). No stage tracking exists in the failure handler.
- [V] `classify_error(e) -> bool` in worker `main.py`: `TransientError` → True; `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` → True; `httpx.HTTPStatusError` with status 429/500/502/503/504 → True; `PermanentError` → False; other `HTTPStatusError` (4xx) → False; **any unclassified exception → False (conservative: permanent)**.
- [V] `run_worker` uses `classify_error` for ACK/NACK: transient → omitted from `ack_ids` (redelivery), permanent → acked.
- [V] `_fail_if_still_stale` (stale-lease sweep) writes directly: `status="failed"`, `error="processing lease expired without heartbeat — worker died or stalled"`, `error_stage="processing"`, `retryable=True`.
- [V] `_publish_status_update` builds the envelope `{user_id, course_id, resource_id, status, details, timestamp, sequence}`, injects `jobId` into `details` when a `job_id` is provided and not already present, resets the sequence counter on terminal states (`completed`, `failed`), performs a lease heartbeat write (`status_updated_at`), and swallows its own publish exceptions (logged as `status_publish_failed`).
- [V] `process_document`'s `except` catches all pipeline exceptions and returns `metrics` normally; `run_worker`'s classifier therefore governs exceptions escaping that handler (claim errors, payload decode, regenerate-map), not in-pipeline failures.
- [V] rag-api `_process_status_message` parses `user_id/course_id/resource_id/status/details`, resolves canonical vs. legacy doc path, runs `run_transactional_update` in a thread, acks on success / nacks on error. `ALLOWED_TRANSITIONS` permits `processing → failed`.
- [V] Both services have hermetic branches: `FIRESTORE_EMULATOR_HOST` (rag-api `startup`, worker `_init_services`), `STORAGE_EMULATOR_HOST` (worker `_build_storage_client`), `PUBSUB_EMULATOR_HOST` (logged at worker startup).
- [V] Contract-test infrastructure exists: `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests, imports `main as rag_api_main`), with `conftest.py` that sets env, mocks `firebase_admin`/`google.cloud.*`, and puts `rag-api-service` on `sys.path`. `rag-worker-service/tests/conftest.py` demonstrates a complete stub set that makes the worker's `main.py` importable hermetically.
- [D] `ResourceResponse` and the `Resource` model expose `error`/`error_stage` (retryable defaults True) — Definition F6; not independently re-read.
- [D] rag-api enqueue-failure paths (`/process`, `POST /resources`) write `error`/`error_stage`/`retryable` directly — Definition F6.
- Unknown / deferred: contents of the companion D3 issue (Definition F12); `plans/upload-flow.md` is not present in the current tree.

## 3. Terms

- **Stage token**: one of the approved pipeline-stage strings reported in `details.stage`.
- **Failure payload**: the `details` dict the worker publishes with `status="failed"`.
- **Failed branch**: rag-api's `run_transactional_update` handling of `new_status == "failed"`.
- **Drift guard**: an assertion that pins the exact key set on either side of the seam so future key edits fail the build.

## 4. Functional requirements

### FR-1 (must) — Failure payload carries the full contract
When document processing fails inside `process_document`, the worker's failed-status `details` MUST contain, at minimum and with these values:
- `error_message`: the actual exception message (`str(e)`);
- `stage`: the stage token executing at failure time (per FR-2);
- `retryable`: a JSON boolean derived per FR-3.

The payload MUST NOT rely on rag-api's fallback defaults (`"Processing failed"`, null stage, `retryable=True`) for any of these keys. Recommended (should): if `str(e)` is empty, use the exception class name as `error_message` so the persisted `error` is never blank.

### FR-2 (must) — Stage tracking through `process_document`
The worker MUST track the currently executing pipeline step so the failure handler reports the true failing stage:
- A stage tracker is updated immediately before each pipeline step (update-before-await convention).
- Stage tokens MUST reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- The safe value when the stage is genuinely unknown is `"processing"` (matching the stale-lease sweep's `error_stage` value); it is also the tracker's initial value.
- Steps after the last tracked transition (old-vector deletion, vector storage, metadata persistence, completion bookkeeping) report the most recent token, `embeddings_complete`. No new stage names are introduced.

### FR-3 (must) — Deliberate `retryable` derivation
The worker MUST set `retryable` from `classify_error(e)`:
- Classified transient → `retryable: true`.
- Classified permanent — including unclassified-unknown exceptions, per `classify_error`'s conservative default → `retryable: false`.

`retryable` MUST always be present and MUST be a boolean; the API-side `details.get("retryable", True)` fallback MUST NOT be the operative mechanism for worker failures.

### FR-4 (must) — rag-api persists worker values unchanged
rag-api's failed branch MUST continue to persist, with no read or schema changes:
- main document: `error` ← `details.error_message`; `error_stage` ← `details.stage`; `retryable` ← `details.retryable`; `status="failed"` via the existing transition rules;
- `processing/summary` subdocument (merged): `error.message` and `error.stage` equal to the main document's persisted message and stage; `error.code` remains `"UNKNOWN"` unless a code is actually sent.

### FR-5 (prefer, adopted) — Legacy `error` key retained
The worker's failure payload MUST retain the legacy `error` key with the same value as `error_message`, as a hedge for unverified consumers of the status topic and for log tooling. rag-api ignores this key (verified: the failed branch reads only `error_message`, `stage`, `retryable`, `error_code`).

### FR-6 (must) — No structured error codes
The worker MUST NOT emit `error_code`; the summary `error.code` remains `"UNKNOWN"` for worker failures. Introducing an error-code taxonomy is out of scope.

## 5. Contract specification

### 5.1 Wire payload — worker → rag-api, `status="failed"` `details` (target)

```json
{
  "error_message": "<actual exception message>",
  "error": "<same string — legacy key, FR-5>",
  "stage": "<stage token per FR-2>",
  "retryable": true | false
}
```

`jobId` is injected into `details` by `_publish_status_update` when a job id exists (verified existing behavior, unchanged). Envelope keys (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`) are unchanged.

### 5.2 Persisted schema (unchanged, verified)

- Main document on failure: `status="failed"`, `error` (string), `error_stage` (string|null), `retryable` (bool), `status_updated_at`, `updated_at`, `schema_version=2`.
- `processing/summary` (merge): `stage`, `progress`, `updated_at`, `error: {code, message, stage}`.

### 5.3 Stage vocabulary and tracker assignment points

| Stage token | Tracker assigned immediately before | Progress update with same token |
|---|---|---|
| `processing` | initial value; genuinely unknown | — (sweep uses it for `error_stage`) |
| `starting` | `_validate_processing_request` | yes |
| `text_retrieved` | `_get_extracted_text` | yes (progress 20) |
| `tagging_complete` | `content_tagger.generate_tags` | yes (progress 40) |
| `summary_generated` | `generate_document_summary` (+ ragDescription write) | yes (progress 50) |
| `chunking_complete` | `_create_enhanced_chunks` | yes (progress 60) |
| `embeddings_complete` | `_generate_embeddings_with_openrouter`; remains through vector delete/store and completion bookkeeping | yes (progress 80) |

### 5.4 `retryable` derivation table (from verified `classify_error`)

| Exception | `classify_error` | `retryable` |
|---|---|---|
| `TransientError` subclasses | True | `true` |
| `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | True | `true` |
| `httpx.HTTPStatusError` status 429/500/502/503/504 | True | `true` |
| `PermanentError` subclasses | False | `false` |
| `httpx.HTTPStatusError` other 4xx | False | `false` |
| Any unclassified exception | False (conservative) | `false` |

## 6. Behavioral changes and compatibility

- **Deliberate change**: unclassified-unknown exceptions previously persisted `retryable: true` (silent API fallback); they now persist `false`, matching `classify_error`'s conservative default. Manual reprocess via `POST /process` is unaffected. Accepted per Definition F8.
- **No migration**: persisted field names and semantics (`error`, `error_stage`, `retryable`) are unchanged; no backfill of existing documents.
- **Unknown consumers**: only rag-api's status subscriber is a verified consumer; the legacy `error` key is retained (FR-5) as insurance.
- **Sweep consistency**: the stale-lease sweep's direct write (`retryable: true`, `error_stage: "processing"`) is unchanged and remains correct — a dead worker is a transient condition.

## 7. Test and verification requirements

- **TR-1 (must)**: A contract test covering the worker failure → rag-api persistence path MUST exist in `apps/ai-server/tests/integration/`. It MUST exercise the worker's failure-payload construction (real worker code, not a restated fixture) and feed the resulting payload through rag-api's `run_transactional_update` against Firestore fakes (or the Firestore emulator), asserting persisted `error`, `error_stage`, and `retryable` equal the worker's values, and that the summary error subdocument carries the same message and stage.
- **TR-2 (must)**: The test MUST include drift guards in both directions: exact key-set assertion on the worker's payload, and exact key-set assertions on the captured persisted main-document and summary writes. A key added, removed, or renamed on either side MUST fail the build.
- **TR-3 (must)**: Representative-stage coverage: an early-stage failure (transient-classified, e.g. at `text_retrieved`) and a late-stage failure (permanent-classified, e.g. at `embeddings_complete`), plus the unclassified-unknown case pinning `retryable: false`.
- **TR-4 (must)**: The stage-tracker mechanism MUST be tested by driving `process_document` with an injected mid-pipeline exception and asserting the reported stage — proving the tracker, not just the builder.
- **TR-5 (should)**: Hermetic execution following the existing mocking patterns (`tests/integration/conftest.py` for rag-api import; the `rag-worker-service/tests/conftest.py` stub set as the template for worker import). No external services required; emulator mode optional.
- **TR-6 (must)**: No regressions: existing contract tests, fixtures, and worker unit tests keep passing.

## 8. Constraints (from the authoritative Definition)

- **Must**: align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema.
- **Must not**: require a Firestore migration, field rename, or backfill; persisted fields keep names and semantics.
- **Must**: every worker-originated failure payload carries `retryable` explicitly; the API fallback must not be operative for worker failures.
- **Prefer**: retain the legacy `error` key alongside `error_message`.
- **Prefer not**: introduce a structured error-code taxonomy.

## 9. Acceptance criteria

| # | Criterion (from Definition) | Verified by |
|---|---|---|
| A1 | Worker's failed status message contains `error_message` (actual message), `stage` (failing stage), `retryable` (derived) — none relying on rag-api fallbacks | FR-1, FR-2, FR-3; TR-1/TR-3/TR-4 |
| A2 | Persisted resource has `error` = actual message (not `"Processing failed"`), `error_stage` = failing stage (not null), `retryable` = worker's derived value | FR-4; TR-1 |
| A3 | `processing/summary` error subdocument carries the same message and stage as the main document | FR-4; TR-1 |
| A4 | Contract test covering worker failure → rag-api persistence exists and passes; fails if either side's payload keys drift | TR-1, TR-2 |

## 10. Non-goals (from the authoritative Definition)

- Changing the stale-lease sweep's direct failure write.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error`/`error_stage` [D].
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this payload alignment (deferred, F12); reconciling with the D4 deviation note in `plans/upload-flow.md` (file absent from the tree).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

## 1. Design principles

1. **Fix the odd one out.** The persisted failure schema (`error`/`error_stage`/`retryable`) is already spoken by the worker's stale-lease sweep, rag-api's enqueue-failure paths [D], and the response models [D]. The worker's status publisher is the only non-conforming writer; it aligns to the API, never the reverse. No migration, no reader changes.
2. **Derive, don't default.** Every failure payload value is deliberately computed at the source; rag-api's fallbacks become dead code on the worker path rather than the operative mechanism.
3. **Pin the seam.** The bug existed because nothing tests the worker→rag-api boundary. The contract test imports both sides and asserts the handoff, with bidirectional key-set drift guards.
4. **Minimal blast radius.** One stage tracker local, one pure payload-builder function, one call-site change in the exception handler. rag-api: zero functional change.

## 2. System context (verified)

```
rag-worker                          Pub/Sub                      rag-api
┌──────────────────────────┐   rag-status-updates   ┌──────────────────────────────┐
│ run_worker               │                        │ _process_status_message      │
│  └─ process_document     │  ───────────────────▶  │  └─ run_transactional_update │
│      ├─ progress updates │     (status topic)     │      ├─ main doc update      │
│      └─ failure publish  │                        │      └─ processing/summary   │
├─ stale-lease sweep ──────┼── direct Firestore ────┼─▶ users/{uid}/resources/{rid}│
└──────────────────────────┘      (failure write)  └──────────────────────────────┘
```

- The worker claims the resource (`status="processing"`, transactional), runs the pipeline, and publishes status updates per stage; rag-api's subscriber applies them through `run_transactional_update` (transition `processing → failed` is allowed by `ALLOWED_TRANSITIONS`).
- `ResourceResponse` exposes `error`/`error_stage` to clients [D — Definition F6].

## 3. Seam analysis (current, verified)

**Worker side** — `process_document`'s single `except` block:
```python
await self._publish_status_update(user_id, course_id, resource_id, "failed",
                                  {"error": str(e)}, job_id)
```

**API side** — `run_transactional_update` failed branch:
```python
main_update["error"]      = details.get("error_message", "Processing failed")
main_update["error_stage"] = details.get("stage")
main_update["retryable"]  = details.get("retryable", True)
...
summary_update["error"] = {"code": details.get("error_code", "UNKNOWN"),
                           "message": details.get("error_message", "Processing failed"),
                           "stage": details.get("stage")}
```

Result: every worker failure persists `"Processing failed"` / `None` / `True`. Additionally, the failure handler has no stage awareness — `process_document` is one large `try` with sequential awaits, so at failure time nothing knows where it was.

## 4. Target design

### 4.1 Worker: stage tracker

A plain local variable in `process_document` (the pipeline is strictly sequential inside one `try`; no concurrency requires a context var):

```python
current_stage = "processing"          # initial / safe value (FR-2)
try:
    current_stage = "starting"
    await self._validate_processing_request(...)
    await self._publish_status_update(..., {"stage": "starting"}, job_id)

    current_stage = "text_retrieved"
    text_content, doc_metadata = await self._get_extracted_text(...)
    ...
    current_stage = "tagging_complete"
    tags, confidence_scores = await self.content_tagger.generate_tags(...)
    ...
    current_stage = "summary_generated"
    summary_data = await self.generate_document_summary(...)
    ...
    current_stage = "chunking_complete"
    chunks = await self._create_enhanced_chunks(...)
    ...
    current_stage = "embeddings_complete"
    vectors = await self._generate_embeddings_with_openrouter(chunks)
    # delete_old_vectors_via_service, store_chunks_via_service, metadata save,
    # completion bookkeeping: tracker remains "embeddings_complete"
    ...
except Exception as e:
    ...
```

Semantics (per FR-2 and §5.3 of requirements):
- Assignment is **immediately before the await** of the step it names (update-before-await convention). A failure in step *N* reports step *N*'s token.
- Tokens mirror the progress-update vocabulary 1:1, so a failure stage reads naturally next to the progress timeline clients already see.
- Post-last-transition steps (vector delete/store, metadata persistence, usage/resource-map — the latter three swallow their own exceptions today) report `embeddings_complete`, the most recent token. No new stage names are introduced.
- `_validate_processing_request` failures report `starting` (it is the first step; the `starting` progress update follows it).
- The initial `"processing"` value covers the theoretically-possible handler entry before any assignment and matches the sweep's `error_stage` value, so the field never regresses to null.

### 4.2 Worker: failure payload builder (pure, testable)

New module-level function in worker `main.py`, placed near `classify_error` for import simplicity:

```python
def build_failure_details(error: Exception, stage: str) -> dict:
    message = str(error) or type(error).__name__   # never blank (recommended, FR-1)
    return {
        "error_message": message,
        "error": message,            # legacy key — hedge for unknown consumers (FR-5)
        "stage": stage,
        "retryable": classify_error(error),   # deliberate derivation (FR-3)
    }
```

Properties:
- Pure and side-effect free → directly callable from the contract test without constructing `EnhancedDocumentProcessor` (whose `__init__` initializes Firebase/Pub/Sub).
- Emits exactly the four keys of §5.1; `jobId` injection remains the publisher's job (verified existing behavior, unchanged).
- `classify_error` is the single source of truth for retryability — the same function `run_worker` uses for delivery decisions.
- rag-api ignores `error` and receives no `error_code`, so summary `error.code` stays `"UNKNOWN"` (FR-6, verified API behavior).

### 4.3 Worker: handler and publisher integration

The exception handler becomes:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", ..., error=str(e),
                      stage=current_stage, retryable=classify_error(e))   # should
    await self._publish_status_update(user_id, course_id, resource_id, "failed",
                                      build_failure_details(e, current_stage), job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

`_publish_status_update` is unchanged: it injects `jobId`, stamps `timestamp`/`sequence`, resets the sequence on the terminal `failed` state, performs the lease heartbeat write, and swallows its own publish errors. No signature or envelope changes.

**Verified control-flow note (honesty about semantics):** `process_document` catches all in-pipeline exceptions and returns normally, so `run_worker` acks the message after a pipeline failure; `run_worker`'s `classify_error` ACK/NACK branch governs exceptions that escape that handler (claim errors, payload decode, regenerate-map). `retryable` therefore communicates "is this failure condition transient / safe to reprocess" — derived from the same classifier the worker uses for delivery decisions — exactly as the Definition specifies (transient → `true`, permanent/unknown → `false`). No ACK/NACK mechanics change.

### 4.4 rag-api: unchanged, pinned

Zero functional change. The verified failed branch already implements FR-4 exactly: main doc `error`/`error_stage`/`retryable` from `error_message`/`stage`/`retryable`; summary `error.{code,message,stage}` plus top-level `stage`/`progress` (fallbacks `0`/`"unknown"` become non-operative for worker failures because the worker always sends the keys). The contract test is the guard that keeps both sides honest; the fallbacks remain as defensive behavior for non-worker failure paths.

### 4.5 End-to-end failure sequence (target)

1. `run_worker` pulls a job; `_claim_resource_if_queued` transactionally sets `status="processing"`.
2. `process_document` advances the tracker before each step; progress updates publish stage tokens and renew the lease.
3. Step *N* raises → handler builds `build_failure_details(e, current_stage)` → `_publish_status_update("failed", details, job_id)` → envelope + `jobId` + sequence reset + heartbeat → publish to `rag-status-updates`.
4. rag-api `_process_status_message` resolves the doc path (canonical first, legacy fallback) → `run_transactional_update` in a thread → transition `processing → failed` allowed → main doc gets the worker's actual `error`, `error_stage`, `retryable`; `processing/summary` gets matching `error.{message,stage}` with `code="UNKNOWN"` → message acked.
5. Clients read `error`/`error_stage` via `ResourceResponse` [D].

**Backstop (unchanged):** if the failed-status publish itself fails (`_publish_status_update` swallows), the stale-lease sweep eventually marks the resource failed with `error_stage="processing"`, `retryable=true` — consistent with this contract. If a worker dies mid-run, the sweep or lease-stealing recovery handles it as today.

## 5. Compatibility and migration

- No Firestore migration, rename, or backfill; persisted names/semantics unchanged.
- Legacy `error` key retained in the payload (FR-5). Verified: rag-api's failed branch never reads it; it exists solely for unverified topic consumers and log tooling. Dropping it later is trivial cleanup after a consumer audit.
- `error_code` is not emitted; summary `error.code` remains `"UNKNOWN"` (verified default).
- The stale-lease sweep, enqueue-failure paths [D], and response models [D] already conform; no coordination needed.

## 6. Test architecture

### 6.1 Location and imports
- New module: `apps/ai-server/tests/integration/test_worker_failure_contract.py` (sibling of `test_api_contracts.py`, sharing its `conftest.py`).
- rag-api side: imported as `main as rag_api_main` per the existing conftest (env set, `firebase_admin`/`google.cloud.*` mocked, `rag-api-service` on `sys.path`). `run_transactional_update` is module-level and directly callable (verified).
- Worker side: import worker `main.py` hermetically using the stub pattern proven by `rag-worker-service/tests/conftest.py` (env defaults; stubs for langchain/openai/langfuse/spacy/tiktoken/tenacity/firebase/google.cloud as needed). Prefer self-contained stubbing inside the new test module before import so the existing rag-api contract tests are untouched; module-level worker code (`GCP_PROJECT`, subscriber construction) succeeds under those stubs (verified pattern).

### 6.2 Firestore fake (fakes path; emulator optional)
`run_transactional_update` needs a small surface — provide a minimal fake:
- `firestore.transactional` → pass-through decorator and `firestore.SERVER_TIMESTAMP` → sentinel, monkeypatched on the imported `rag_api_main.firestore` (the conftest replaces the real module with mocks).
- `FakeTransaction` records `update()` / `set()` calls (target, data).
- `FakeDocRef`: `.get(transaction=...)` returns a snapshot with `.exists` / `.to_dict()` from a seeded doc (seed `status="processing"`); `.id`; `.collection("processing").document("summary")` returns the summary ref.
- `db.transaction()` returns the fake transaction.

### 6.3 Drift guards (TR-2)
1. **Worker payload key set**: `set(build_failure_details(e, stage).keys()) == {"error", "error_message", "stage", "retryable"}` — exact.
2. **Persisted write key sets**: assert exact key sets of the captured `main_update` and `summary_update` dicts — catches API-side key additions/removals behaviorally.
3. **Fallback tripwires**: persisted `error != "Processing failed"`, `error_stage is not None`, `retryable is True/False` matching the worker's derivation — catches a worker-side key rename (API fallbacks would appear).
4. Optional belt-and-braces AST scan (house pattern exists in `test_api_contracts.py`): extract `details.get("…")` literals from the API failed branch and dict keys from the worker builder; assert the expected sets.

### 6.4 Test matrix

| # | Test | Pins |
|---|---|---|
| T1 | Early-stage transient failure: `TransientError`/`httpx.ConnectError` at `text_retrieved` → builder → `run_transactional_update` (fake Firestore) | main doc `error`/`error_stage="text_retrieved"`/`retryable=True`; summary `error.{message,stage}` match, `code="UNKNOWN"` (A1–A3) |
| T2 | Late-stage permanent failure: `ValueError` at `embeddings_complete` | `retryable=False`, `error_stage="embeddings_complete"` (A1–A3) |
| T3 | Unclassified-unknown exception | `retryable=False` — pins the deliberate behavior change (FR-3) |
| T4 | Builder key-set drift guard | exact 4-key payload (FR-1, FR-5) |
| T5 | Persisted-write key-set drift guards | exact main/summary write shapes (FR-4) |
| T6 | Stage-tracker mechanism: drive real `process_document` on a `__new__`-constructed processor (skip Firebase `__init__`; stub step methods; stub `_publish_status_update` with an async recorder; set `langfuse=None`, minimal config/logger attrs); raise inside `_get_extracted_text` → captured details `stage == "text_retrieved"`; raise inside `_generate_embeddings_with_openrouter` → `stage == "embeddings_complete"` | tracker mechanism, not just the builder (FR-2, TR-4) |
| T7 | Legacy key parity | `payload["error"] == payload["error_message"]` (FR-5) |

T6's captured details feed the same `run_transactional_update` assertions as T1/T2, closing the chain: real `process_document` → real handler → real builder → real failed branch → fake Firestore.

### 6.5 Hermeticity
No external services required (fakes path). The Firestore emulator may be substituted per the Definition's allowance; both services have verified emulator branches. CI runner configuration for the top-level integration suite is an implementation detail to confirm at implement time (unknown).

## 7. Risks and mitigations

| Risk | Mitigation | Residual |
|---|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained (FR-5) | Accepted low; audit can retire the key later |
| Stage-tracker drift as the pipeline evolves | Update-before-await convention documented; T6 representative-stage tests catch tracker removal/bypass | A new step without a tracker update reports the previous token — accepted; vocabulary is fixed by the Definition |
| `retryable=false` for genuinely-transient-but-unrecognized failures | Deliberate conservatism of `classify_error`; manual reprocess via `POST /process` unaffected; widening the classifier is out of scope | Accepted per Definition F8 |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key means touching the test | None (by design) |
| Worker import weight in the integration environment | Established stub pattern (`rag-worker-service/tests/conftest.py`); self-contained stubbing in the new module | Low |

## 8. Deferred / out of scope

- Companion D3 issue contents (unavailable here — Definition F12).
- Reconciliation with the D4 deviation note in `plans/upload-flow.md` (file absent from the tree).
- Structured error codes; ACK/NACK, lease, and heartbeat mechanics; sweep behavior; frontend changes.

## 9. Traceability

| Requirement | Design element | Tests |
|---|---|---|
| FR-1 | §4.2 builder; §4.3 handler | T1–T4, T7 |
| FR-2 | §4.1 tracker | T6 |
| FR-3 | §4.2 (`classify_error`), §5.4 table | T1–T3 |
| FR-4 | §4.4 (unchanged API, pinned) | T1, T2, T5 |
| FR-5 | §4.2 legacy key | T4, T7 |
| FR-6 | §4.2 (no `error_code`) | T1 (code == "UNKNOWN") |
| A1–A4 | §4, §6 | T1–T7 |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>