<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (authoritative Definition artifact `definition:obj-108`, sha256 `71f1c39c…`)
Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

## 1. Problem statement

When RAG processing fails, the worker's exception handler in `process_document`
(`apps/ai-server/rag-worker-service/main.py`) publishes a failed status with a
one-key payload `{"error": str(e)}`. rag-api's failed branch in
`run_transactional_update` (`apps/ai-server/rag-api-service/main.py`) reads three
keys — `error_message`, `stage`, `retryable` — and persists them as
`error` / `error_stage` / `retryable` on the resource document, plus
`message` / `stage` (with `error_code` defaulting to `"UNKNOWN"`) into the
`processing/summary` error subdocument.

Because of the key mismatch, every worker-originated failure currently persists:

| Persisted field | Value today | Why |
|---|---|---|
| `error` | `"Processing failed"` (fallback) | API reads `error_message`; worker sends `error` |
| `error_stage` | `None` | API reads `stage`; worker sends nothing |
| `retryable` | `True` (silent default) | API falls back to `True`; worker sends nothing |

The `processing/summary` error subdocument inherits the same fallback message and
a null stage, with `error_code` always `"UNKNOWN"`. Users and support cannot
disambiguate failures. Three other failure write paths (the worker's stale-lease
sweep `_fail_if_still_stale`, rag-api's enqueue-failure paths) and both response
models (`ResourceResponse`, `Resource` in
`apps/ai-server/rag-api-service/models/resource.py`) already use the
`error` / `error_stage` / `retryable` schema — the worker's status publisher is
the only writer that does not speak it.

## 2. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch
contract so that a failed RAG processing job persists the worker's actual error
message, the failing pipeline stage, and a deliberately derived `retryable`
flag — locked in by a contract test on the worker→rag-api failure path.

## 3. Scope

### In scope
- `apps/ai-server/rag-worker-service/main.py`: failure-payload construction in
  `process_document`'s exception handler; stage tracking through the pipeline;
  `retryable` derivation from `classify_error()`.
- A contract test covering the worker failure → rag-api persistence seam.
- No rag-api code changes are required (its failed branch already reads the
  target keys); rag-api's behavior is pinned by the contract test.

### Out of scope (non-goals)
- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`)
  — it already persists `error` / `error_stage` / `retryable` consistently with
  this contract (`error_stage: "processing"`, `retryable: True`).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases,
  heartbeat intervals — only the *reporting* of retryability in the payload
  changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and
  `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the
  `processing/summary` error `code` remains `"UNKNOWN"` unless a code is
  actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure
  payload alignment (its content is unavailable in this context; deferred), and
  reconciling this analysis with the D4 deviation note referenced in
  `plans/upload-flow.md` (that file is not present in the current tree).
- Widening `classify_error()`'s classification heuristics.

## 4. Functional requirements

### FR-1 — Worker failure payload keys
When document processing fails, the worker's failed status payload MUST include:
- `error_message`: the actual exception message (`str(e)`),
- `stage`: the pipeline stage executing at failure time (see FR-2),
- `retryable`: a deliberately derived boolean (see FR-3),

and MUST retain the legacy `error` key carrying the same message string
(compatibility hedge for unverified consumers of the status topic). The payload
MUST NEVER rely on rag-api's fallback defaults (`"Processing failed"`, `None`,
`True`) for these keys — i.e., all three keys are always explicitly present.

### FR-2 — Stage tracking
The worker MUST track the currently executing pipeline stage through
`process_document` so the failure handler reports the true failing stage:
- Stage names MUST reuse the existing progress-stage vocabulary: `starting`,
  `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
  `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown (same
  value the stale-lease sweep uses for `error_stage`); `error_stage` MUST never
  regress to null for a worker-originated failure.
- Convention: the tracker is set immediately before the `await` of each pipeline
  step (see architecture doc for the assignment table and granularity notes).

### FR-3 — retryable derivation
The `retryable` derivation MUST be explicit and aligned with the worker's
ACK/NACK behavior in `run_worker`, which already uses `classify_error(e)`:
- Errors classified **transient** by `classify_error()` → `retryable: true`
  (Pub/Sub will redeliver).
- Errors classified **permanent** by `classify_error()` → `retryable: false`
  (message is acked; manual reprocess via `POST /process` remains).
- Unclassified-unknown exceptions classify as permanent under
  `classify_error()`'s conservative default and therefore persist
  `retryable: false`. This is a deliberate behavior change from today's silent
  `True` fallback; it prevents infinite retry loops and matches the worker's
  actual ACK decision.
- The stale-lease sweep's separate `retryable: true` write is unchanged and
  stays correct (a dead worker is a transient condition).

### FR-4 — rag-api persistence (unchanged, pinned)
rag-api's failed branch MUST persist the worker-provided values unchanged:
- main document: `error` ← payload `error_message`, `error_stage` ← payload
  `stage`, `retryable` ← payload `retryable`;
- `processing/summary` error subdocument: `message` ← payload `error_message`,
  `stage` ← payload `stage`, `code` ← `error_code` with its existing `"UNKNOWN"`
  default.

This is satisfied by the existing rag-api code once the worker sends the right
keys; no rag-api change is made. The API-side `details.get("retryable", True)`
fallback remains in the code for non-worker writers but MUST NOT be the
operative mechanism for worker failures.

### FR-5 — Contract test
A contract test MUST cover the worker failure → rag-api persistence path:
- It MUST exercise the worker's failure-payload construction (through the
  worker's real code path, not a restated fixture) and rag-api's failed-branch
  persistence (`run_transactional_update` via the Firestore emulator or fakes).
- It MUST assert the persisted `error`, `error_stage`, and `retryable` equal the
  worker's values, using test values that discriminate against the fallbacks
  (message ≠ `"Processing failed"`, stage ≠ `None`, and at least one case with
  derived `retryable: false`).
- It MUST fail if either side's payload keys drift: worker dropping/renaming a
  key or rag-api changing a read key must break the build.
- It MUST pin the stage tracker mechanism on representative stages (an
  early-stage failure and a late-stage failure).

### FR-6 — No migration
The fix MUST NOT require a Firestore migration, field rename, or backfill of
existing documents; the persisted fields (`error`, `error_stage`, `retryable`)
keep their names and semantics.

## 5. Data requirements

### 5.1 Worker failure payload (status topic, `details` for `status: "failed"`)
| Key | Type | Source | Status |
|---|---|---|---|
| `error_message` | str | `str(e)` | new (required) |
| `stage` | str | stage tracker (FR-2 vocabulary) | new (required) |
| `retryable` | bool | `classify_error(e)` | new (required) |
| `error` | str | `str(e)` | retained legacy key |
| `jobId` | str | injected by `_publish_status_update` when `job_id` provided | existing behavior, unchanged |

### 5.2 Persisted schema (unchanged)
- Main resource document: `error` (str), `error_stage` (str, never null for
  worker-originated failures), `retryable` (bool).
- `processing/summary`: `error: {code, message, stage}` with `code` defaulting
  to `"UNKNOWN"`; top-level `stage` / `progress` per existing failed-branch
  behavior.

## 6. Constraints

| Type | Constraint |
|---|---|
| must | Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`) — do not change rag-api's reads or persisted schema. |
| must_not | No Firestore migration, field rename, or backfill; persisted fields keep names and semantics. |
| must | Every worker-originated failure payload carries `retryable` explicitly; the API-side fallback must not be operative for worker failures. |
| prefer | Retain the legacy `error` key alongside `error_message` for continuity with unknown consumers and log tooling. |
| prefer_not | Do not introduce a structured error-code taxonomy. |

## 7. Acceptance criteria

| ID | Criterion | Definition source |
|---|---|---|
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | acceptance[0] |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | acceptance[1] |
| AC-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | acceptance[2] |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | acceptance[3] |

## 8. Traceability

| Requirement | Supported by (Definition facts) |
|---|---|
| FR-1 | F1 (product intent), F3 (worker publishes `{"error": str(e)}`), F4 (API reads `error_message`/`stage`/`retryable`), F5 (current fallback persistence), F11 (legacy `error` key hedge) |
| FR-2 | F1, F9 (no stage tracking today; progress vocabulary verified) |
| FR-3 | F1, F7 (`classify_error` drives ACK/NACK), F8 (adopted derivation default) |
| FR-4 | F4 (failed-branch semantics verified), F6 (established persisted schema) |
| FR-5 | F10 (contract-test infrastructure and emulator modes exist) |
| FR-6 | F2 (preferred direction avoids schema migration), constraint must_not |

## 9. Known unknowns and deferred items

- **Unknown consumers of the status topic**: only rag-api's status subscriber is
  a verified consumer. Other services/tooling sharing the topic are not audited;
  the retained legacy `error` key is the hedge (F11, assumption). Residual risk
  accepted as low.
- **Companion D3 issue**: referenced by the Objective but its content is not
  available in this context; anything beyond the payload alignment is deferred
  (F12).
- **`plans/upload-flow.md` D4 deviation note**: file not present in the current
  tree; reconciliation deferred (F12).
- **Empty exception messages**: `str(e)` may be empty for bare exceptions; the
  actual message is persisted as-is. No normalization requirement is imposed.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` · Companion to `docs/requirements.md`

## 1. System context and the broken seam

```
rag-worker (process_document)                    rag-api
┌──────────────────────────────┐   Pub/Sub status topic   ┌──────────────────────────────┐
│ try:                          │  (rag-status-updates)    │ subscriber callback           │
│   ...pipeline steps...        │                          │   _process_status_message     │
│ except Exception as e:        │                          │     └─ run_transactional_update│
│   _publish_status_update(     │ ───────────────────────▶ │          failed branch:       │
│     "failed",                 │   JSON message:           │   error      ← error_message  │
│     {"error": str(e)})  ✗     │   {status, details, …}    │   error_stage← stage          │
└──────────────────────────────┘                           │   retryable  ← retryable      │
                                                           │   summary.error ← {code,      │
                                                           │      message, stage}          │
                                                           └──────────────────────────────┘
```

Verified current behavior:

- **Worker producer** (`rag-worker-service/main.py`, `process_document`
  exception handler): publishes `details = {"error": str(e)}` — one key.
- **API consumer** (`rag-api-service/main.py`, `run_transactional_update`
  failed branch): `error ← details.get("error_message", "Processing failed")`,
  `error_stage ← details.get("stage")`,
  `retryable ← details.get("retryable", True)`; summary subdocument gets
  `error = {code: details.get("error_code", "UNKNOWN"), message: …, stage: …}`.
- **Result**: every worker failure persists the fallback message, a null stage,
  and a fabricated `retryable: true` (Definition fact F5).
- **The rest of the failure schema already agrees**: the worker's stale-lease
  sweep (`_fail_if_still_stale`) writes `error` / `error_stage: "processing"` /
  `retryable: True` directly; rag-api's enqueue-failure paths and
  `models/resource.py` (`Resource`: `error`, `error_stage`, `retryable=True`
  default) use the same names. The worker's status publisher is the only
  dissenting writer.

## 2. Design principle: the worker aligns to the API

The persisted field names are consistent across three write paths and two API
response models; changing the API side would ripple. The worker is the odd one
out. Fixing the worker requires **no migration, no backfill, no reader
changes**, and matches the Objective's preferred direction (F2).

## 3. Worker changes (`apps/ai-server/rag-worker-service/main.py`)

### 3.1 Extract a pure failure-payload builder

New module-level function so the contract test can exercise the payload
construction without instantiating the full processor (whose `_init_services`
needs Firebase/Storage wiring):

```python
def build_failure_details(exc: Exception, stage: str) -> dict:
    return {
        "error_message": str(exc),
        "stage": stage,
        "retryable": classify_error(exc),
        "error": str(exc),   # legacy key retained for unknown topic consumers
    }
```

- `classify_error` already exists at module top (verified: `TransientError` →
  True; `PermanentError` → False; connection/timeout types and HTTP 429/5xx →
  True; other 4xx → False; **unknown → False**, conservative).
- The legacy `error` key is the compatibility hedge (F11): one redundant string
  per failure message as insurance for unverified consumers of the status topic.
  Dropping it later is trivial cleanup if an audit confirms rag-api is the only
  consumer.
- `_publish_status_update` injects `jobId` into `details` when a `job_id` is
  supplied (verified existing behavior) — unchanged.

### 3.2 Stage tracker in `process_document`

A local variable initialized before the `try` block, assigned immediately before
each pipeline step's `await`, read by the exception handler:

| Assignment point (immediately before) | Tracker value |
|---|---|
| top of `process_document` (before `try`) | `"processing"` (safe fallback) |
| `_validate_processing_request` | `"starting"` |
| `_get_extracted_text` | `"text_retrieved"` |
| `content_tagger.generate_tags` | `"tagging_complete"` |
| `generate_document_summary` (+ summary doc write) | `"summary_generated"` |
| `_create_enhanced_chunks` | `"chunking_complete"` |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |
| post-embedding steps (`delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save, final publish) | tracker retains `"embeddings_complete"` (nearest vocabulary milestone; no dedicated label exists) |

Semantics and granularity (deliberate decisions):

- The tracker value names the step in flight, using the vocabulary label that
  step's completion progress-update publishes — so a failure during text
  extraction reports `text_retrieved`, reading naturally next to the progress
  timeline clients already see (F9).
- Granularity is milestone-level: failures inside a step group report that
  group's label (e.g., a Firestore failure while persisting the summary reports
  `summary_generated`). This is accepted because the vocabulary has no finer
  labels and the field must never be null.
- The post-embedding storage steps keep `embeddings_complete` — truthful at the
  vocabulary's granularity.
- **Drift risk convention**: a future pipeline step must set the tracker
  immediately before its `await`. The contract test pins the mechanism on
  representative stages (early + late) rather than ossifying every step.

### 3.3 Exception handler rewrite

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", …)
    await self._publish_status_update(
        user_id, course_id, resource_id, "failed",
        build_failure_details(e, current_stage), job_id)
    …
```

`metrics.error_message` handling, logging, trace update, and return are
unchanged. `_publish_status_update` mechanics (sequence numbers, lease
heartbeat, terminal-state sequence reset) are unchanged.

### 3.4 Explicitly unchanged in the worker

- `run_worker` ACK/NACK logic (already uses `classify_error`).
- `_fail_if_still_stale` / `_stale_lease_sweep_loop` (already writes
  `error` / `error_stage: "processing"` / `retryable: True` — a dead worker is
  transient by nature).
- `_heartbeat_loop`, lease constants, `_publish_status_update` transport.

## 4. rag-api changes: none

`run_transactional_update`'s failed branch already implements the target
contract (verified). The API-side `details.get(...)` fallbacks remain in code
for defensive robustness but cease to be operative for worker failures because
the worker now always sends all three keys. rag-api's behavior is pinned by the
contract test (FR-4/AC-4) rather than modified.

## 5. Data contracts

### 5.1 Failure payload (worker → status topic)
See requirements §5.1. Pinned key set for `build_failure_details` output:
exactly `{error_message, stage, retryable, error}` (`jobId` is injected later by
`_publish_status_update` and is not part of the pinned builder set).

### 5.2 Persisted schema (unchanged, verified)
- Main doc: `status: "failed"`, `error`, `error_stage`, `retryable`,
  `status_updated_at`, `updated_at`, `schema_version: 2`.
- `processing/summary` (merge): `stage` (payload `stage`, default `"unknown"`),
  `progress` (payload `progress`, default `0` — worker failure payload sends no
  progress, so `0`, as today), `error: {code: "UNKNOWN" unless sent, message,
  stage}`, `updated_at`.

### 5.3 retryable derivation table

| Exception class | `classify_error` | `retryable` persisted | ACK/NACK in `run_worker` |
|---|---|---|---|
| `TransientError`, connection/timeout types, HTTP 429/500/502/503/504 | transient | `true` | NACK → Pub/Sub redelivers |
| `PermanentError`, other HTTP 4xx, **unclassified-unknown** | permanent | `false` | ACK → manual reprocess via `POST /process` |
| stale lease (sweep, not this path) | n/a | `true` (direct write, unchanged) | n/a |

Deliberate behavior change: unclassified-unknown failures move from persisted
`true` (silent fallback) to `false` (conservative classification). This aligns
the record with the worker's actual ACK decision and prevents infinite retry
loops; widening `classify_error` is out of scope.

## 6. Compatibility and rollout

- **Single-service deploy, no coordination**: current rag-api already reads
  `error_message`/`stage`/`retryable`. Deploying the worker alone fixes
  persistence. An old worker against current rag-api behaves exactly as today
  (fallbacks) until the worker deploys. There is no breaking ordering.
- **Unknown topic consumers**: legacy `error` key retained (§3.1). Residual risk
  accepted as low (F11).
- **No data migration**: existing documents are untouched; new failures simply
  populate the fields correctly.

## 7. Test architecture

### 7.1 Location and harness
New module in the existing shared suite, e.g.
`apps/ai-server/tests/integration/test_worker_failure_contract.py`, reusing the
directory's `conftest.py` (verified: env defaults `GCP_PROJECT`,
`GOOGLE_APPLICATION_CREDENTIALS`, `SHARED_INTERNAL_TOKEN`; cloud-dependency
mocks; `sys.path` insert of `rag-api-service`).

Verified constraints the harness must respect:
- Both services expose modules named `main` with module-level side effects.
  rag-api's `main.py` builds `app_state = AppState(ApiConfig())` at import
  (requires the three env vars above — provided by conftest). The worker's
  `main.py` requires `GCP_PROJECT` and `GOOGLE_APPLICATION_CREDENTIALS` at
  import and constructs a `SubscriberClient` from a service-account file.
- Import strategy: import rag-api via the existing conftest-enabled path; load
  the worker module under a distinct module name via
  `importlib.util.spec_from_file_location` (avoids the `main` name collision),
  installing the worker-side stub set mirrored from
  `rag-worker-service/tests/conftest.py` (verified stubs: `langchain.*`,
  `openai`, `langfuse`, `firebase_admin.*`, `google.cloud.*` incl.
  `pubsub_v1.SubscriberClient` and `service_account.Credentials`, `spacy`,
  `tiktoken`, `tenacity`) before loading, for modules the shared conftest does
  not already provide.

### 7.2 Fakes over emulator (primary)
`run_transactional_update` reaches Firestore through the module-global
`firestore.transactional` decorator, `firestore.SERVER_TIMESTAMP`,
`db.transaction()`, `doc_ref.get(transaction=…)`, `transaction.update(...)`, and
`transaction.set(summary_ref, …, merge=True)` (all verified). The Firestore
emulator mode exists in both services (verified `FIRESTORE_EMULATOR_HOST`
branches), but the fakes path is simpler and matches the suite's mocked-cloud
regime:

- Patch `rag_api_main.firestore.transactional` to an identity decorator and
  `SERVER_TIMESTAMP` to a sentinel.
- Fake `db.transaction()`, fake doc snapshot (`.exists`, `.to_dict()` with
  `status: "processing"` so the transition is allowed — verified
  `ALLOWED_TRANSITIONS`), fake `doc_ref` recording `update()` payloads, fake
  `processing/summary` ref recording `set()` payloads.

### 7.3 Test cases

| ID | Case | Asserts |
|---|---|---|
| T1 | Transient seam: `build_failure_details(TransientError("boom-transient"), "text_retrieved")` fed through `run_transactional_update` | persisted `error == "boom-transient"`, `error_stage == "text_retrieved"`, `retryable is True`; summary `error.message`/`error.stage` match main doc; `error.code == "UNKNOWN"` |
| T2 | Permanent seam: same with a permanent-classified exception (e.g. `ValueError`) | `retryable is False` (discriminates against the API's `True` fallback) |
| T3 | Worker-side drift guard | `set(build_failure_details(...))` equals the pinned key set exactly — any worker key rename/drop fails |
| T4 | Early-stage failure through `process_document` (processor built via `__new__` with stubbed steps; `_get_extracted_text` raises) | failed payload `stage == "text_retrieved"`, `error_message` actual message, `retryable` derived (False for `ValueError`) |
| T5 | Late-stage failure through `process_document` (`_generate_embeddings_with_openrouter` raises `httpx.ConnectError`) | failed payload `stage == "embeddings_complete"`, `retryable is True` |
| T6 | API-side drift guard (implicit in T1/T2) | if rag-api stops reading `error_message`/`stage`/`retryable`, persisted fallbacks (`"Processing failed"` / `None` / `True`) fail the equality asserts |

Test values are chosen to discriminate against every fallback
(`"boom-transient"` ≠ `"Processing failed"`, stages ≠ `None`, T2's `False` ≠
default `True`), so any key drift on either side breaks the build (AC-4).

Notes:
- T4/T5 use a partially initialized `EnhancedDocumentProcessor` (`__new__` +
  attribute stubs: `langfuse=None`, logger, stubbed pipeline steps and a
  recording `_publish_status_update`) so no Firebase/Pub/Sub wiring is needed.
- API-side drift in the *additive* direction (a new key read) is safe and not
  guarded — intentional; the guard targets the breaking direction.
- An optional AST-based check of the failed branch's `details.get(...)` keys
  (house pattern from `test_api_contracts.py`) may be added later; the
  behavioral asserts above are the required guard.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained; residual risk accepted as low (F11) |
| Stage-tracker drift as the pipeline evolves | "Set immediately before the await" convention; T4/T5 pin the mechanism on representative stages |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted; matches the worker's actual ACK behavior; manual reprocess via `POST /process` unaffected; widening `classify_error` is out of scope |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key means touching the test |

## 9. Alternatives considered (rejected)

- **Change rag-api to read `error`** (or add `error` as an alias): ripples
  against three consistent write paths and two models; rejected (F2, F6).
- **Firestore schema migration / backfill**: explicitly forbidden (constraint
  must_not).
- **Structured error codes**: rejected per `prefer_not`; summary `error.code`
  stays `"UNKNOWN"` unless a code is actually sent.

## 10. Deferred

- Companion D3 issue scope (content unavailable here) — anything beyond this
  payload alignment (F12).
- Reconciliation with the D4 deviation note in `plans/upload-flow.md` (file not
  present in the current tree) (F12).
- Auditing non-rag-api consumers of the status topic; dropping the legacy
  `error` key if the audit confirms it is redundant.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>