Re-emitting both artifacts with strict, fully closed delimiter blocks.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- Run: `029951f8-4005-48db-9a23-25a40ec20c96` · Iteration 1 · Step: design
- Authoritative source: Definition artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`, WorkItem `wi-define-108-a8`). This document operationalizes that definition; where wording differs, the definition is binding.
- Companion doc: `docs/architecture.md` (how the requirements are met).

## 1. Problem statement

A failed RAG processing job loses its failure facts. The worker's exception handler in
`process_document` (`apps/ai-server/rag-worker-service/main.py`) publishes status `"failed"` with
details `{"error": str(e)}`, while rag-api's failed branch in `run_transactional_update`
(`apps/ai-server/rag-api-service/main.py`) reads `error_message`, `stage`, and `retryable`. Because
the keys do not intersect, every worker-originated failure persists:

| Persisted field | Value today | Should be |
|---|---|---|
| `error` (main doc) | fallback `"Processing failed"` | the worker's actual exception message |
| `error_stage` (main doc) | `None` | the pipeline stage executing at failure time |
| `retryable` (main doc) | silent default `True` | a deliberately derived value |
| `processing/summary.error` | `{code: "UNKNOWN", message: "Processing failed", stage: None}` | same message/stage as the main doc |

Users and support cannot disambiguate failures, and `retryable: true` is fabricated rather than
derived. The persisted failure schema (`error`/`error_stage`/`retryable`) is already consistent
across three other write paths (worker stale-lease sweep, rag-api `/process` and `POST /resources`
enqueue-failure paths) and both read models (`Resource`, `ResourceResponse`). The worker's status
publisher is the only writer that does not speak it.

## 2. Goal

Align the rag-worker's failure status payload with rag-api's existing failed-branch contract so a
failed job persists the worker's actual error message, the failing pipeline stage, and a
deliberately derived retryable flag — locked in by a contract test on the worker → rag-api failure
path.

## 3. Scope bounds

- **In scope**: `apps/ai-server/rag-worker-service/main.py` (failure payload construction + stage
  tracking), new worker unit tests, new cross-service contract test.
- **Out of scope (non-goals)**:
  - rag-api's reads, persisted schema, `Resource`/`ResourceResponse` models — unchanged.
  - The stale-lease sweep's direct failure write (`_fail_if_still_stale`) — already contract-consistent.
  - Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only
    the *reporting* of retryability changes.
  - Frontend/mobile — `ResourceResponse` already exposes `error`/`error_stage`.
  - Structured error codes / failure taxonomy — summary `error.code` stays `"UNKNOWN"` unless a
    code is actually sent (worker sends none).
  - The companion D3 issue referenced by the Objective (content unavailable here) and reconciling
    the original D4 deviation note in `plans/upload-flow.md` (file not present in tree).

## 4. Functional requirements

### FR-1 — Worker failure payload
When document processing fails, the worker's `"failed"` status payload details must contain:
- `error_message`: the actual exception message;
- `stage`: the pipeline stage executing at failure time (FR-2);
- `retryable`: deliberately derived (FR-3);
- `error`: a legacy duplicate of `error_message`, retained for continuity with any unknown
  consumers of the status topic and existing log tooling (hedge per Definition fact F11).

The payload must never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`)
for these keys. `jobId` injection remains the publisher's existing behavior and is not part of the
builder's key set.

### FR-2 — Stage tracking in `process_document`
- The worker must track the currently executing pipeline stage so the failure handler reports the
  true failing stage.
- Mechanism: a local tracker set immediately before each pipeline step (the "set before the await"
  convention) and read by the exception handler.
- Stage vocabulary is closed and reuses the existing progress-stage names:
  `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
  `embeddings_complete`.
- Initial/safe value `"processing"` — used when the stage is genuinely unknown (defensive
  initializer; also the value the stale-lease sweep uses for `error_stage`, so `error_stage` never
  regresses to null).
- Set-point mapping (full table in `docs/architecture.md` §3.2): `starting` before request
  validation; `text_retrieved` before text retrieval; `tagging_complete` before tagging;
  `summary_generated` before summary generation; `chunking_complete` before chunking;
  `embeddings_complete` before embedding generation. The vector-storage and post-completion steps
  report the last tracked value (`embeddings_complete`) — no new stage names may be introduced.

### FR-3 — retryable derivation
- `retryable` must be derived from the worker's existing `classify_error(e)` — the same function
  that drives ACK/NACK in `run_worker` — so the persisted record matches actual retry behavior:
  - transient-classified errors → `retryable: true` (Pub/Sub will redeliver);
  - permanent-classified errors, including unclassified-unknown (classify_error's conservative
    default) → `retryable: false` (message acked; manual reprocess via `POST /process` remains).
- The stale-lease sweep's separate `retryable: true` write is unchanged and stays correct (a dead
  worker is a transient condition).
- Deliberate behavior change (accepted): unclassified-unknown exceptions previously persisted
  `retryable: true` via the silent default and will now persist `false`. This is the conservatism
  `classify_error` was written for; it prevents infinite retry loops.

### FR-4 — rag-api unchanged
rag-api's failed branch must persist worker-provided values unchanged:
- main document: `error` ← `error_message`, `error_stage` ← `stage`, `retryable` ← `retryable`;
- `processing/summary` subdocument: top-level `stage` ← `stage`, and
  `error = {code: <"UNKNOWN" default>, message: ← error_message, stage: ← stage}` — the message and
  stage must equal the main document's.
No change to rag-api's reads, fallbacks, transitions, or models is permitted (Definition
constraint: align the worker to the API, not the reverse).

### FR-5 — Contract test (worker failure → rag-api persistence)
A contract test must cover the seam and:
- exercise the worker's real failure-payload construction path (the `process_document` exception
  handler, not a re-stated fixture);
- feed the captured payload through rag-api's real `run_transactional_update` failed branch against
  a fake Firestore transaction surface (fakes preferred; the Firestore emulator is an acceptable
  alternative — both services already have emulator branches);
- assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and that
  the summary error subdocument carries the same message and stage;
- cover at least one transient-classified failure (expect `retryable: true`) and one
  permanent/unknown-classified failure (expect `retryable: false`), at an early and a late pipeline
  stage respectively;
- fail if either side's payload keys drift: worker-side via an exact builder key-set pin; API-side
  via value-based fallback detection (persisted values must equal the payload values and must
  differ from every API fallback: not `"Processing failed"`, stage not `None`, and the permanent
  case's `retryable` not the default `True`).

### FR-6 — Empty-message guard
If `str(e)` is empty (exception raised with no args), `error_message`/`error` fall back to the
exception class name so a blank string is never persisted. This serves F1's intent (support must be
able to disambiguate failures); it is the only message-mangling permitted.

### FR-7 — Failure logging
The worker's `document_processing_failed` log must include the tracked stage and derived
`retryable` alongside the error message, so a failed job is diagnosable from logs alone.

### FR-8 — No migration
The fix must not require a Firestore migration, field rename, or backfill; persisted field names
(`error`, `error_stage`, `retryable`) and semantics are unchanged.

## 5. Constraints (from the Definition, binding)

| ID | Type | Constraint |
|---|---|---|
| C-1 | must | Worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed. |
| C-2 | must_not | No Firestore migration, field rename, or backfill of existing documents. |
| C-3 | must | Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| C-4 | prefer | Retain the legacy `error` key alongside `error_message` in the failure payload. |
| C-5 | prefer_not | Do not introduce a structured error-code taxonomy. |

## 6. Acceptance criteria

| ID | Criterion (from Definition) | Verified by |
|---|---|---|
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | Worker unit tests + contract test scenarios (captured payload assertions, FR-1/2/3). |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | Contract test scenarios 1–2 (persisted-field assertions). |
| AC-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | Contract test summary-subdoc assertions. |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes, exercising payload construction through failed-branch persistence and asserting persisted `error`/`error_stage`/`retryable` equal the worker's values; it fails if either side's payload keys drift. | New contract test (FR-5) passing in CI; drift guards D1 (builder key set) and D2 (fallback detection). |

## 7. Test requirements

- **TR-1** Worker unit tests (`apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py`):
  payload-builder mapping for the full `classify_error` table (TransientError, PermanentError,
  connection/timeout types, HTTPStatusError 429/5xx vs other 4xx, unknown exception); legacy-key
  parity; empty-message guard; stage-tracker attribution for representative early/late failures and
  the `starting`/`processing` values; retryable values match the FR-3 table.
- **TR-2** Contract test (`apps/ai-server/tests/integration/test_worker_failure_contract.py`):
  real `process_document` handler → captured failure details → real `run_transactional_update`
  against a fake Firestore transaction surface → persisted assertions + drift guards. Must run
  hermetically (no emulator, no network, no GCP credentials) using the existing conftest mock
  patterns, and must import both services' real code rather than restate the contract in a fixture.
- **TR-3** Tests must not pin: progress percentages, `jobId` injection, the Pub/Sub envelope keys
  beyond `details`, or exact pipeline exception message strings.

## 8. Traceability (Definition facts → requirements)

| Fact | Addressed by |
|---|---|
| F1 (intent: persist real message/stage/retryable) | FR-1, FR-2, FR-3, AC-1/2 |
| F2 (preferred direction: worker aligns to `error_message`/`stage`) | FR-1, FR-4, C-1 |
| F3 (worker publishes `{"error": str(e)}`) | §1, FR-1 |
| F4 (API reads `error_message`/`stage`/`retryable`) | FR-4, §1 |
| F5 (fallback `"Processing failed"`/`None`/`True` today) | §1, AC-2, D2 |
| F6 (established `error`/`error_stage`/`retryable` schema) | §1, FR-8 |
| F7 (classify_error drives ACK/NACK) | FR-3 |
| F8 (adopted retryable derivation, ASSUMED) | FR-3 (adopted as specified) |
| F9 (stage vocabulary exists; no failure-stage tracking) | FR-2 |
| F10 (contract-test infra + emulator branches exist) | FR-5, TR-2 |
| F11 (retain legacy `error` key, ASSUMED) | FR-1, C-4 |
| F12 (companion D3 issue out of scope, DEFERRED) | §3 non-goals |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

- Run: `029951f8-4005-48db-9a23-25a40ec20c96` · Iteration 1 · Step: design
- Implements: `docs/requirements.md` (which operationalizes Definition `definition:obj-108`).

## 1. System context

```
rag-api-service                         rag-worker-service
POST /resources, POST /process   --Pub/Sub: rag-process-->   run_worker (pull loop)
                                                                process_document
                                                                _publish_status_update
        |                                                              |
        | enqueue-failure writes (already correct):                    | Pub/Sub: rag-status-updates
        | error / error_stage:"enqueue" / retryable                    | details = {...}   THE SEAM
        v                                                              v
Firestore: users/{uid}/resources/{rid}
  main doc: status, error, error_stage, retryable
  processing/summary: stage, progress, error{code, message, stage}
        ^
        | run_transactional_update failed branch (unchanged reader)
        | also writes: stale-lease sweep (worker, direct, already correct)
```

The seam under repair is the `details` dict inside the worker's `"failed"` status message. Today it
carries `{"error": str(e)}`; the API reader wants `error_message`/`stage`/`retryable`.

## 2. Target contract

### 2.1 Worker publishes (status `"failed"`, `details`)

| Key | Value | Producer |
|---|---|---|
| `error_message` | `str(e)`, or exception class name when `str(e)` is empty (FR-6) | `build_failure_details(e, stage)` |
| `error` | identical to `error_message` (legacy hedge, F11/C-4) | `build_failure_details` |
| `stage` | tracked pipeline stage (FR-2) | `process_document` tracker |
| `retryable` | `classify_error(e)` (FR-3) | `build_failure_details` |
| `jobId` | injected by `_publish_status_update` when a `job_id` is present — existing behavior, publisher-owned, not part of the builder key set | `_publish_status_update` |

Builder key set is exactly `{"error_message", "error", "stage", "retryable"}` (drift guard D1).

### 2.2 rag-api reads (failed branch — no code change)

```python
main_update["error"]       = details.get("error_message", "Processing failed")
main_update["error_stage"] = details.get("stage")
main_update["retryable"]   = details.get("retryable", True)
summary_update["stage"]    = details.get("stage", "unknown")
summary_update["error"]    = {"code": details.get("error_code", "UNKNOWN"),
                              "message": details.get("error_message", "Processing failed"),
                              "stage": details.get("stage")}
```

With the worker payload above, every fallback becomes dead code on the worker path: `error` ← real
message, `error_stage` ← real stage, `retryable` ← derived, summary `error.message`/`error.stage`
match the main doc, `error.code` stays `"UNKNOWN"` (worker sends no code, per C-5).

### 2.3 Persisted schema (unchanged, FR-8/C-2)

Main doc: `error`, `error_stage`, `retryable` — same names/semantics as the sweep, the enqueue
failure paths, `Resource`, and `ResourceResponse`. No migration, no backfill.

## 3. Worker changes (`apps/ai-server/rag-worker-service/main.py` — the only production file touched)

### 3.1 New module-level pure function (placed next to `classify_error`)

```python
def build_failure_details(e: Exception, stage: str) -> Dict[str, Any]:
    """Failure payload aligned with rag-api's run_transactional_update failed branch."""
    message = str(e) or e.__class__.__name__   # FR-6: never persist an empty message
    return {
        "error_message": message,
        "error": message,          # legacy key retained for unknown topic consumers (F11)
        "stage": stage,
        "retryable": classify_error(e),
    }
```

Pure, importable, no I/O — the unit-testable core of the contract.

### 3.2 Stage tracker in `process_document`

A local `current_stage` initialized to `"processing"` (defensive safe value; no statement currently
sits between `try:` entry and the first set point, so it only fires if the code shape changes) and
set immediately before each step, per the "set before the await" convention:

| # | Set immediately before | Tracker value | Step's success publish |
|---|---|---|---|
| 0 | function entry (before `try`) | `"processing"` | — |
| 1 | `_validate_processing_request` | `"starting"` | `{"stage": "starting"}` |
| 2 | `_get_extracted_text` | `"text_retrieved"` | `{"stage": "text_retrieved", "progress": 20}` |
| 3 | `content_tagger.generate_tags` | `"tagging_complete"` | `{"stage": "tagging_complete", "progress": 40}` |
| 4 | `generate_document_summary` (+ its doc update + publish) | `"summary_generated"` | `{"stage": "summary_generated", "progress": 50}` |
| 5 | `_create_enhanced_chunks` | `"chunking_complete"` | `{"stage": "chunking_complete", "progress": 60}` |
| 6 | `_generate_embeddings_with_openrouter` | `"embeddings_complete"` | `{"stage": "embeddings_complete", "progress": 80}` |
| 7 | vector delete/store, metadata save, final publish, usage, map | unchanged (`"embeddings_complete"`) | `{"stage": "completed", "progress": 100}` |

Semantics: a failure inside a step reports the stage that step works toward — i.e., the stage name
identifies the failing step. Tenacity retries inside a step (`generate_document_summary`,
`_generate_embeddings_with_openrouter`, `store_chunks_via_service`) do not change the tracked
stage: the stage is the step, not the attempt.

Known, accepted limitation: the vector-storage block (steps 6a/6b — `delete_old_vectors_via_service`,
`store_chunks_via_service`) and post-completion steps have no vocabulary entry; they report
`"embeddings_complete"` (last tracked). Introducing new stage names would leak into the
client-visible progress timeline and is out of scope (FR-2 closes the vocabulary).

### 3.3 Exception handler rewrite

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                      resource_id=resource_id, error=str(e),
                      stage=current_stage, retryable=classify_error(e))   # FR-7
    await self._publish_status_update(user_id, course_id, resource_id, "failed",
                                      build_failure_details(e, current_stage), job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

`_publish_status_update` is untouched: it keeps injecting `jobId`, assigning sequence numbers,
resetting the sequence on terminal states, and renewing the processing lease; it already swallows
its own publish errors, so a failure to report cannot mask the original failure.

### 3.4 retryable ↔ ACK/NACK consistency invariant

`run_worker` classifies the same exception object with the same `classify_error` that produced the
payload's `retryable`. Therefore the persisted record always tells the truth about delivery:
transient → NACK → Pub/Sub redelivers → `retryable: true`; permanent/unknown → ACK → no redelivery
→ `retryable: false` (manual reprocess via `POST /process` unaffected). The sweep's separate
`retryable: true` write stays correct (dead worker = transient condition) and is not touched.

## 4. rag-api changes

None. `run_transactional_update`, `_process_status_message`, `models/resource.py`,
`ResourceResponse`, transition rules, and both enqueue-failure paths stay exactly as they are
(C-1, FR-4). The alignment is worker-side only; the API's fallbacks remain for any non-worker
failure publisher and become inert on the worker path.

## 5. Test architecture

### 5.1 Worker unit tests — `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` (new)

Runs under the existing worker `tests/conftest.py` stubs (pattern proven by
`test_processing_lease.py`, which imports `main` directly).

- Payload builder table (FR-3): `TransientError` → True; `PermanentError` → False;
  `httpx.ConnectTimeout`/`ConnectError`/`ReadTimeout` → True; `ConnectionError`/`TimeoutError` →
  True; `httpx.HTTPStatusError` 429/500/503 → True, 404 → False; `ValueError` (unknown) → False.
- Legacy key parity (FR-1): `payload["error"] == payload["error_message"]`.
- Empty-message guard (FR-6): `ValueError()` → message `"ValueError"`.
- Stage attribution (FR-2): drive the real `process_document` on a processor built via
  `object.__new__(EnhancedDocumentProcessor)` with stubbed collaborators (`langfuse=None`; stub
  `_validate_processing_request`, `_get_extracted_text`, `content_tagger.generate_tags`,
  `generate_document_summary`, `_create_enhanced_chunks`, `_generate_embeddings_with_openrouter`,
  `delete_old_vectors_via_service`, `store_chunks_via_service`,
  `_save_processing_metadata_to_subcollection`, `_update_user_usage`, `_generate_resource_map`,
  `_get_document_path`, a minimal fake `db` for the summary-step update, and a capturing async
  `_publish_status_update`). Cases: raise in `_get_extracted_text` → `stage == "text_retrieved"`;
  raise in `_create_enhanced_chunks` → `"chunking_complete"`; raise in
  `_validate_processing_request` → `"starting"`; builder called with `"processing"` pins the safe
  value.
- Handler wiring (FR-7): failure log call includes `stage` and `retryable`.

### 5.2 Contract test — `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new)

Lives beside `test_api_contracts.py` and reuses its `conftest.py` (mocked
`firebase_admin`/`google.cloud`/`structlog`, rag-api on `sys.path`). A preamble in the test file
installs the worker-style module stubs (langchain splitters/schema, openai, langfuse, spacy,
sklearn.feature_extraction.text, tiktoken, tenacity) only for modules not already importable, then
imports the worker's `main` — its module-level Pub/Sub init is safe under the conftest's mocks.
httpx is real on both sides (both services import it).

Fake Firestore surface (minimal, no emulator — FR-5/TR-2):
- `FakeTransaction` recording `update(ref, dict)` and `set(ref, dict, merge=True)` calls;
  `FakeDb.transaction()` returns one; `firebase_admin.firestore.transactional` is replaced with a
  pass-through decorator on the already-mocked module object (rag-api's `main.firestore` is that
  same object, so the real decorator call-site in `run_transactional_update` is exercised
  unmodified);
- `FakeDocRef.get(transaction=...)` → snapshot with `exists=True`,
  `to_dict() → {"status": "processing", ...}` (satisfies `ALLOWED_TRANSITIONS` `processing →
  failed`); `doc_ref.collection("processing").document("summary")` → fake summary ref;
  `doc_ref.id`/`.path` for logging; stub logger passed through.

Scenarios (each: drive the real handler → capture `(status, details)` → seed fake doc → call the
real `run_transactional_update(db, doc_ref, "failed", details, logger, user_id)` → assert):

1. Transient, early stage: stub raises `httpx.ConnectTimeout("weaviate unreachable")` inside
   `_get_extracted_text`. Assert main-doc update: `status == "failed"`,
   `error == "weaviate unreachable"`, `error_stage == "text_retrieved"`, `retryable is True`;
   summary subdoc: `stage == "text_retrieved"`, `error.message == "weaviate unreachable"`,
   `error.stage == "text_retrieved"`, `error.code == "UNKNOWN"` (AC-1/2/3).
2. Permanent/unknown, late stage: stub raises `ValueError("invalid summary format")` inside
   `_create_enhanced_chunks`. Assert `error == "invalid summary format"`,
   `error_stage == "chunking_complete"`, `retryable is False` (+ same summary assertions).

Drift guards:
- D1 (worker side, exact key pin): captured builder payload key set ==
  `{"error_message", "error", "stage", "retryable"}`. Reverting the handler to `{"error": str(e)}`
  fails D1 and the scenario assertions (persisted `error` would fall back to `"Processing failed"`).
- D2 (API side, value-based fallback detection): persisted values must equal the payload values
  and differ from every API fallback — `error != "Processing failed"`, `error_stage is not None`,
  and scenario 2's `retryable is False` (the default would be `True`). If the API stops reading a
  key, the fallback value appears and the assertion fails. One blind spot, benign by construction:
  an API swap from `error_message` to the legacy `error` key is invisible because the values are
  identical.
- AST-based key scans (house pattern from `_get_agent_graph_shapes`) are an optional supplement,
  not required: D1+D2 already fail the build on either side's key drift, per AC-4.

Invocation: `pytest apps/ai-server/tests/integration/test_worker_failure_contract.py` from the repo
root (conftest supplies env/mocks). Hermetic: no emulator, no network, no credentials.

### 5.3 What the tests deliberately do not pin (TR-3)

Progress percentages, `jobId` injection, the Pub/Sub envelope beyond `details`, sequence numbers,
exact pipeline exception strings, and tenacity retry counts (tenacity is a no-op decorator under
the worker stubs; the tracked stage is attempt-independent anyway).

## 6. Failure-path sequence (target state)

1. Step k raises inside `process_document` → caught by the single handler.
2. Handler logs `document_processing_failed` with `error`, `stage`, `retryable` (FR-7).
3. Handler publishes `status="failed"` with `build_failure_details(e, current_stage)`; publisher
   adds `jobId`, assigns terminal sequence reset, renews the lease; publish errors are swallowed.
4. `run_worker` ACKs (handler returned normally) — existing behavior, unchanged.
5. rag-api's status subscriber receives the message; `_process_status_message` resolves the doc
   path (canonical first, legacy fallback — unchanged) and calls `run_transactional_update`.
6. Failed branch persists `error`/`error_stage`/`retryable` from the payload (no fallbacks fire)
   and writes the matching summary error subdocument with `code: "UNKNOWN"`.
7. Client reads `error`/`error_stage` via `ResourceResponse` (unchanged); `retryable` is readable
   from the `Resource` model as before.

## 7. Change manifest

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Add `build_failure_details`; add `current_stage` tracker + set points; rewrite the `process_document` exception handler; enrich the failure log. (~25 lines) |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | New (TR-1). |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | New (TR-2, AC-4). |
| `apps/ai-server/rag-api-service/**` | No changes. |
| Sweep, retry/lease/heartbeat, compose/Dockerfiles, frontend | No changes. |

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic reading the old key set | Legacy `error` key retained (C-4/F11); residual risk accepted as low; dropping the duplicate later is trivial cleanup after a consumer audit. |
| Stage-tracker drift as the pipeline evolves | "Set before the await" convention documented at each set point; contract test pins representative early/late stages — catches tracker removal or bypass without ossifying every step. |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted per Definition F8; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains. |
| Contract test ossifying the payload | Intentional — that is the drift guard (D1/D2). Adding a key later means touching the test, which is the point. |
| Test-env fragility (worker's heavy imports under the integration conftest) | Stub preamble mirrors the worker's own proven `tests/conftest.py` stub table and only fills missing modules; worker import needs no Firebase/Pub/Sub reality (module-level init is mock-safe). |
| `@firestore.transactional` under mocked modules | Pass-through decorator installed on the mocked module object; the real decorator call-site in `run_transactional_update` is exercised unmodified. |

## 9. Deferred (explicitly out of scope)

- Companion D3 issue referenced by the Objective (content unavailable in this context).
- Reconciling the original D4 deviation note in `plans/upload-flow.md` (file absent from tree).
- Dropping the legacy `error` key (pending a consumer audit of the status topic).
- Emulator-based end-to-end variant of the contract test (fakes satisfy FR-5; both services'
  `FIRESTORE_EMULATOR_HOST` branches make the upgrade path available if hermetic infra is added).
- New stage names for the vector-storage block; structured error codes; any retry/lease mechanics.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>