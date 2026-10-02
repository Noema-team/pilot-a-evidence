Design is complete from the verified evidence (worker `main.py` publisher/handler/classifier, rag-api `run_transactional_update` failed branch, `Resource`/`ResourceResponse` models, and the existing contract-test + conftest patterns). Producing the contracted artifacts now.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- **Authoritative source:** define-work WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document operationalizes that definition; where wording differs, the definition is binding.
- **Cycle intent:** rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage.
- **Phase:** design (iteration 1, planning depth: minimal)

## 1. Problem statement (verified repository evidence)

- The worker's `process_document` exception handler publishes the failed status with a one-key payload: `{"error": str(e)}` (`apps/ai-server/rag-worker-service/main.py`).
- rag-api's failed branch in `run_transactional_update` reads three keys with fallbacks — `error_message` (fallback `"Processing failed"`), `stage` (no fallback → `None`), `retryable` (fallback `True`) — and persists them as `error`, `error_stage`, `retryable` on the main resource document; the `processing/summary` subdocument receives `error{code, message, stage}` from the same keys (`apps/ai-server/rag-api-service/main.py`).
- Consequence: every worker-originated failure persists the fallback message, a null `error_stage`, and a fabricated `retryable: true`; the summary error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.
- The persisted failure schema (`error` / `error_stage` / `retryable`) is already established by other writers and readers: the worker's stale-lease sweep `_fail_if_still_stale` writes all three directly (`error_stage: "processing"`, `retryable: True` — verified), rag-api's enqueue-failure rollback in `POST /process` writes `error` / `error_stage: "enqueue"` directly (verified), and the `Resource` model plus `ResourceResponse` expose `error` / `error_stage` (verified; `Resource.retryable` defaults `True`).
- The worker's status publisher is the only failure writer that does not speak this schema.

## 2. Scope

### 2.1 In scope
1. Worker failure-payload construction: keys `error_message`, `stage`, `retryable` (contract) plus retained legacy `error` key.
2. Stage tracking inside `process_document` so the failure handler reports the true failing stage, using the existing progress-stage vocabulary.
3. Deliberate derivation of `retryable` from the worker's existing `classify_error()` classification.
4. A contract test covering the worker failure → rag-api persistence path, including two-directional key-drift guards.
5. Verification (not modification) that rag-api's failed branch persists worker-provided values unchanged.

### 2.2 Out of scope / non-goals (from the definition — binding)
- Changing the stale-lease sweep's direct failure write (already contract-consistent).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — summary `error.code` remains `"UNKNOWN"` unless a code is actually sent (the worker will not send one).
- Any Firestore migration, field rename, or backfill of existing documents.
- Anything the companion D3 issue covers beyond this payload alignment (content unavailable; deferred), and reconciling this analysis with the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## 3. Functional requirements

Priority values: **MUST** (required for acceptance) / **SHOULD** (strongly desired; droppable without affecting acceptance).

### FR-1 — Failure payload contract keys (MUST)
When document processing fails, the worker's failed status `details` payload MUST include:
- `error_message`: the actual exception message;
- `stage`: the pipeline stage executing at failure time (see FR-2);
- `retryable`: a deliberately derived boolean (see FR-3);
- `error`: legacy key, same string as `error_message` (compatibility hedge per definition constraint "prefer").

The payload MUST NOT rely on rag-api's fallback defaults for any of the three contract keys, and MUST NOT include `error_code` (keeps summary `error.code` at its `"UNKNOWN"` default; honors the prefer-not constraint on error taxonomies).

### FR-2 — Stage tracking (MUST)
- `process_document` MUST maintain a stage tracker (a local variable) that identifies the pipeline phase executing at failure time.
- The tracker MUST be assigned immediately before the `await` of each tracked pipeline step, using the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- The tracker's initial/safe value MUST be `"processing"` — the same value the stale-lease sweep uses for `error_stage` — so the reported stage is never absent and `error_stage` never regresses to `null`.
- The failure handler MUST pass the tracker's current value as the payload's `stage`.
- Stage names MUST NOT introduce new vocabulary beyond the six listed names plus the safe value `"processing"`.

### FR-3 — retryable derivation (MUST)
- The worker MUST set `retryable` from `classify_error(e)` evaluated on the caught exception: errors classified transient → `true`; classified permanent — including unclassified-unknown exceptions, per `classify_error`'s conservative default → `false`.
- The derivation MUST be explicit in the payload on every failure; the API-side `details.get("retryable", True)` fallback MUST NOT be the operative mechanism for worker failures.
- The derivation MUST remain aligned with the worker's ACK/NACK behavior in `run_worker` (same function, same exception instance): transient = Pub/Sub will redeliver; permanent = acked, manual reprocess via `POST /process` remains available.
- The stale-lease sweep's separate `retryable: true` write is unchanged (a dead worker is a transient condition).

### FR-4 — rag-api persistence unchanged (MUST)
- rag-api's failed branch MUST persist worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`.
- The `processing/summary` error subdocument MUST carry the same message and stage (`error.message` ← `error_message`, `error.stage` ← `stage`, `error.code` ← `"UNKNOWN"` default), and the summary `stage` field MUST receive the same stage value.
- No code changes to rag-api's reads, persisted field names, transition rules, or fallbacks.

### FR-5 — Contract test (MUST)
A contract test MUST cover the worker failure → rag-api persistence path:
- It MUST exercise the worker's real failure-payload construction (import the production code — not a fixture copy) and feed the resulting payload through rag-api's real `run_transactional_update` failed-branch persistence (via fakes or the Firestore emulator).
- It MUST assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, for at least one transient-classified failure and one permanent-classified failure.
- It MUST fail if either side's payload keys drift:
  - worker side: assert the exact key set of the constructed failure payload;
  - API side: pin the keys the failed branch reads by asserting the fallback behavior when keys are absent (`"Processing failed"` / `None` / `True`).
- It MUST run hermetically (no emulator, network, or cloud credentials required), consistent with the existing `apps/ai-server/tests/integration/` conftest pattern.

### FR-6 — Failure log includes stage (SHOULD)
The worker's `document_processing_failed` log line SHOULD include the failing stage, so support can triage from logs alone. Trivially removable; not required for acceptance.

### FR-7 — No schema or mechanics changes (MUST)
- Persisted fields keep their names and semantics (`error`, `error_stage`, `retryable`); no migration, rename, or backfill.
- No changes to: stale-lease sweep behavior, ACK/NACK policy, leases, heartbeats, message envelope keys (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`), `jobId` injection, or sequence reset on terminal states.
- No frontend changes.

### FR-8 — Empty-message guard (SHOULD)
If `str(e)` is empty (degenerate exceptions), the payload's `error_message`/`error` SHOULD fall back to the exception class name so a persisted `error` is never blank. Applies to payload construction only; internal `ProcessingMetrics.error_message` handling is unchanged.

## 4. Non-functional requirements

- **NFR-1 Performance neutral:** payload construction adds O(1) work (one `classify_error` call, one dict) and no I/O on the failure path.
- **NFR-2 No new runtime dependencies:** the extracted payload/classification module depends only on `httpx` (already imported by both services) and the standard library.
- **NFR-3 Negligible payload growth:** one duplicated message string (legacy `error` key) per failure message.
- **NFR-4 Hermetic, fast tests:** the new contract test uses in-process fakes, runs in seconds, and must not import the worker's `main.py` (whose import-time graph includes Pub/Sub client construction and heavy ML dependencies).
- **NFR-5 Compatibility:** no consumer of the status topic is required to change; the legacy `error` key is retained for unknown readers and log tooling.

## 5. Constraints (from the definition — binding)

| # | Constraint | Type | Addressed by |
|---|---|---|---|
| C1 | Align worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema | must | FR-1, FR-4, §3.4 of architecture |
| C2 | No Firestore migration, field rename, or backfill; persisted fields keep names/semantics | must_not | FR-7 |
| C3 | Every worker failure payload carries `retryable` explicitly; API fallback must not be operative for worker failures | must | FR-1, FR-3, FR-5 (T3) |
| C4 | Retain legacy `error` key alongside `error_message` | prefer | FR-1 |
| C5 | No structured error-code taxonomy | prefer_not | FR-1 (no `error_code` sent) |

## 6. Acceptance criteria (mirrors the definition; all currently `met: false`)

| AC | Description (abridged from definition) | Verified by |
|---|---|---|
| AC-1 | Worker's failed status message contains `error_message` (actual exception message), `stage` (failing stage), `retryable` (deliberately derived) — none relying on rag-api fallbacks | FR-1/2/3 + contract test T1/T2/T3; code inspection of handler |
| AC-2 | Persisted resource has `error` = actual message (not `"Processing failed"`), `error_stage` = failing stage (not `None`), `retryable` = worker-derived value | Contract test T2 (transient) and T3 (permanent; proves the `retryable` fallback is not operative) |
| AC-3 | `processing/summary` error subdocument carries the same message and stage as the main document | Contract test T2/T3 summary assertions |
| AC-4 | Contract test covering worker failure → rag-api persistence exists and passes, failing on either side's key drift | Contract test T1–T4 (+ recommended T5) |

## 7. Unknowns and deferred items (honest inventory)

- **`apps/ai-server/rag-worker-service/exceptions.py` contents were not inspected.** If it already houses the classification classes, the extraction target consolidates there instead of a new module (implementation-time check; see architecture §3.3).
- **Other consumers of the status topic:** only rag-api's status subscriber is verified; any other reader is unknown. Mitigated by retaining the legacy `error` key (definition F11).
- **Worker tests `conftest.py` contents were not inspected;** the new test is placed under `apps/ai-server/tests/integration/` to reuse the verified rag-api conftest pattern (mocked firebase/google-cloud modules + `sys.path` insertion).
- **Companion D3 issue** content unavailable — deferred per definition F12. `plans/upload-flow.md` absent from tree — D4 reconciliation deferred.
- **Existing-behavior observation (out of scope, flagged for awareness):** after a transient failure is persisted as `failed`, a Pub/Sub redelivery may find the resource in terminal state `failed` and be acked without reprocessing by `_claim_resource_if_queued` (terminal states include `"failed"`); whether a redelivered transient failure actually reprocesses is timing-dependent on the existing async status write. Unchanged by this fix; belongs to retry-mechanics work explicitly excluded by the definition.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

- **Authoritative source:** definition artifact `definition:obj-108` (WorkItem `wi-define-108-a8`, sha256 `71f1c39c…`). Binding where wording differs.
- **Companion document:** `docs/requirements.md` (FR/AC identifiers referenced below).

## 1. Context

```
run_worker (pull loop, ACK/NACK via classify_error)
   └─▶ process_document  ── one large try block over pipeline steps 1..6
          │  except e:
          │    build_failure_payload(e, current_stage)
          │      → { error, error_message, stage, retryable }
          ▼
   _publish_status_update("failed", details)
          │  (injects jobId; sequence reset on terminal state; lease heartbeat)
          ▼
   Pub/Sub topic  rag-status-updates
          ▼
   rag-api _process_status_message (subscriber)
          │  doc path resolve: users/{uid}/resources/{rid} first, legacy course path fallback
          ▼
   run_transactional_update   (transition: processing → failed)
      ├─ main doc update:  status="failed", error ← error_message,
      │                    error_stage ← stage, retryable ← retryable
      └─ processing/summary (merge set): stage, progress=0,
                           error{ code:"UNKNOWN", message ← error_message, stage ← stage }
```

The only broken link is the worker's failure publisher (one key, `error`) versus rag-api's failed-branch reader (three keys, `error_message`/`stage`/`retryable`). Everything downstream of the payload — transitions, persistence, models, responses — is already correct and is not modified.

## 2. The contract (single source of truth)

Worker failure `details` payload (as built; `_publish_status_update` may additionally inject `jobId`, existing behavior):

| Key | Type | Value | Status |
|---|---|---|---|
| `error_message` | str | actual exception message (class name if `str(e)` is empty — FR-8) | contract key, read by rag-api |
| `stage` | str | failing pipeline stage (vocabulary below; safe value `"processing"`) | contract key, read by rag-api |
| `retryable` | bool | `classify_error(e)`: transient → `true`, permanent/unknown → `false` | contract key, read by rag-api |
| `error` | str | same string as `error_message` | legacy key, retained (hedge) |

Exactly these four keys; no `error_code` (summary `error.code` stays `"UNKNOWN"`).

## 3. Design decisions

### 3.1 Worker: stage tracker (FR-2)

A local `current_stage: str = "processing"` in `process_document`, assigned immediately before the `await` of each tracked step. Semantic: the value names the pipeline phase whose work was executing at failure time, labeled by that phase's completion milestone from the existing progress vocabulary (the same string the phase's success publish uses).

| Pipeline step (verified in `process_document`) | Tracker assignment (immediately before) | Label |
|---|---|---|
| `_validate_processing_request` + initial `"processing"` publish | yes | `starting` |
| `_get_extracted_text` (PDF download/extraction or stored text) | yes | `text_retrieved` |
| `content_tagger.generate_tags` | yes | `tagging_complete` |
| `generate_document_summary` + `ragDescription` Firestore update | yes | `summary_generated` |
| `_create_enhanced_chunks` | yes | `chunking_complete` |
| `_generate_embeddings_with_openrouter` | yes | `embeddings_complete` |
| Tail: `delete_old_vectors_via_service` → `store_chunks_via_service` → metadata save → usage → resource map → final publish | no re-assignment (retains previous) | `embeddings_complete` |
| Before first assignment (defensive only) | initial value | `processing` |

Rationale for the tail: the post-embedding storage phase has no vocabulary name (the definition fixes the vocabulary to the six names plus `"processing"`), and it is the last named milestone region. Note which steps can actually raise to the handler (verified): validation, `_get_extracted_text`, the `ragDescription` document update, chunking, embedding generation, and `store_chunks_via_service` (partial-write guard). `generate_tags`, `generate_document_summary`, `delete_old_vectors_via_service`, `_save_processing_metadata_to_subcollection`, `_update_user_usage`, and `_generate_resource_map` swallow their own exceptions internally and cannot fail the pipeline — so the tail imprecision is confined to `store_chunks_via_service` failures reporting the coarse `embeddings_complete` label. Accepted; extending the vocabulary is out of scope.

Drift risk (a future step added without updating the tracker) is managed by the convention "assign immediately before the await", the representative-stage contract coverage, and an optional static guard (§7, T5).

### 3.2 Worker: retryable derivation (FR-3)

`retryable = classify_error(e)` — the same function, evaluated on the same exception instance that drives ACK/NACK in `run_worker`. Verified classification mapping:

| Exception | `classify_error` | `retryable` persisted | ACK/NACK (unchanged) |
|---|---|---|---|
| `TransientError` subclasses | transient | `true` | NACK → redelivery |
| `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | transient | `true` | NACK |
| `httpx.HTTPStatusError` with 429/500/502/503/504 | transient | `true` | NACK |
| `PermanentError` subclasses | permanent | `false` | ACK |
| `httpx.HTTPStatusError` other 4xx | permanent | `false` | ACK |
| Any other exception (incl. `ValueError`, `PermissionError` from validation) | permanent (conservative default) | `false` | ACK |

Deliberate behavior change: unclassified-unknown exceptions previously persisted `retryable: true` (the API's silent default) and now persist `false`, matching `classify_error`'s conservatism and the worker's actual ack-and-skip behavior. Manual reprocess via `POST /process` (verified present) is unaffected. The stale-lease sweep keeps its direct `retryable: true` write (dead worker = transient condition).

### 3.3 Worker: payload construction and module extraction (FR-1, FR-8)

New module `apps/ai-server/rag-worker-service/failure_payload.py`:

```python
import httpx

class ProcessingError(Exception): ...
class TransientError(ProcessingError): ...
class PermanentError(ProcessingError): ...

def classify_error(e: Exception) -> bool:
    ...  # moved verbatim from main.py (types, status-code heuristics,
         #  conservative permanent default for unknown)

def build_failure_payload(exc: Exception, stage: str) -> dict:
    message = str(exc) or type(exc).__name__   # FR-8 guard
    return {
        "error": message,            # legacy key retained (compat hedge)
        "error_message": message,    # contract key read by rag-api
        "stage": stage,              # contract key read by rag-api
        "retryable": classify_error(exc),  # deliberately derived, never defaulted
    }
```

`main.py` changes (minimal):
- `from failure_payload import ProcessingError, TransientError, PermanentError, classify_error, build_failure_payload` — a move, not a copy; the re-export keeps every existing in-file reference (`run_worker` ACK/NACK) and any external importer working. `failure_payload.py` must not import `main.py` (no circularity).
- `process_document`: add the `current_stage` local with assignments per §3.1; the exception handler becomes:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", ..., stage=current_stage)  # FR-6
    await self._publish_status_update(
        user_id, course_id, resource_id, "failed",
        build_failure_payload(e, current_stage), job_id,
    )
```

Why extract instead of testing `main.py` directly: worker `main.py` at import time requires env vars, constructs a Pub/Sub subscriber client, and pulls in the heavy ML stack (langchain, spacy, sklearn, tiktoken). Importing it in the shared integration-test environment is fragile and slow. The extraction gives the contract test the *real* construction logic with only `httpx` + stdlib as dependencies — both verified available in the test env (rag-api `main.py` imports `httpx` and the existing contract tests import it successfully).

Implementation note: `apps/ai-server/rag-worker-service/exceptions.py` was not inspected; if it already contains these classes, consolidate the move there instead of creating `failure_payload.py` (single sentence of slack, decision made at implementation time).

### 3.4 rag-api: zero code changes (FR-4)

The failed branch of `run_transactional_update` already implements the receiving side (verified). The design only pins it with tests. Verified reads, unchanged:

- Main document: `error = details.get("error_message", "Processing failed")`; `error_stage = details.get("stage")`; `retryable = details.get("retryable", True)`.
- `processing/summary` (merge set): `stage = details.get("stage", "unknown")`; `progress = details.get("progress", 0)` (worker failure payload sends no `progress` → `0`, unchanged); on failure `error = {code: details.get("error_code", "UNKNOWN"), message: details.get("error_message", "Processing failed"), stage: details.get("stage")}`.
- Transition gate unchanged: `processing → failed` is allowed; the worker's claim has already set `status: "processing"`, so the failure message lands cleanly.

The API's fallbacks remain in code (they must, per constraint C1) but become inoperative for worker failures because the worker always sends the keys — proven by test T3 (permanent failure persists `retryable: false`, which the `True` fallback would have produced).

## 4. Failure-path data flow (after the fix)

1. `run_worker` pulls a job → `_claim_resource_if_queued` sets `status: "processing"` → `process_document` runs.
2. A step raises; the exception propagates to `process_document`'s handler with `current_stage` holding the executing phase.
3. Handler logs (with stage), builds the payload via `build_failure_payload(e, current_stage)` — four keys, `retryable` derived — and publishes `"failed"` through `_publish_status_update` (which injects `jobId`, resets the sequence, heartbeats the lease; existing behavior, unchanged).
4. rag-api's subscriber resolves the document path (canonical first, legacy course path fallback) and runs `run_transactional_update`.
5. Transition `processing → failed` applies: main document persists the worker's actual message, stage, and derived retryable; the summary subdocument receives the same message/stage with `error.code = "UNKNOWN"` and `progress = 0`.
6. Subscriber acks the status message. In parallel, `run_worker`'s outer handler classifies the same exception for ACK/NACK — unchanged; `retryable` now mirrors it in the persisted record.

## 5. Persisted schema (unchanged)

Main resource document (`users/{uid}/resources/{rid}`, or legacy course path):

| Field | Failure value after fix | Before fix (worker failures) |
|---|---|---|
| `status` | `"failed"` | `"failed"` |
| `error` | worker's actual message | `"Processing failed"` (fallback) |
| `error_stage` | failing stage | `None` |
| `retryable` | worker-derived (`true`/`false`) | `True` (silent default) |
| `status_updated_at`, `updated_at`, `schema_version` | server timestamps / `2` | unchanged |

`processing/summary` subdocument (merge): `stage` = failing stage (was `"unknown"`), `progress` = `0`, `error.code` = `"UNKNOWN"`, `error.message` = actual message (was fallback), `error.stage` = failing stage (was `None`).

`ResourceResponse` continues to expose `error` and `error_stage` (verified); `Resource.retryable` (default `True`) is persisted but not surfaced in `ResourceResponse` — existing behavior, out of scope.

## 6. Compatibility and behavior changes

- **No migration/backfill:** field names and semantics unchanged (C2).
- **Legacy `error` key retained** in the payload for unknown status-topic consumers and log tooling (C4). Dropping it later is trivial cleanup if an audit confirms rag-api is the only consumer.
- **Behavior change (deliberate):** permanent-classified and unclassified-unknown worker failures now persist `retryable: false` (previously the silent `True` default). Aligns the record with ACK-and-skip reality; manual reprocess via `POST /process` intact.
- **Message envelope unchanged:** `user_id`/`course_id`/`resource_id`/`status`/`details`/`timestamp`/`sequence`; `jobId` injection and sequence reset unchanged.
- **Existing-behavior note (out of scope):** whether a NACKed transient failure actually reprocesses on redelivery depends on the existing claim logic (`"failed"` is a terminal claim state) and the timing of the async status write — unchanged by this fix; recorded in requirements §7 for the deferred retry-mechanics work.

## 7. Test architecture (FR-5, AC-4)

**Location:** new file `apps/ai-server/tests/integration/test_worker_failure_contract.py`, inheriting the existing `conftest.py` (verified: sets `GCP_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS`/`SHARED_INTERNAL_TOKEN`, mocks `firebase_admin`/`google.cloud`/`structlog`, inserts `rag-api-service` on `sys.path`). The test module adds one `sys.path` insertion for `rag-worker-service` and imports:

- `from failure_payload import build_failure_payload, classify_error` (worker side; pure module — no heavy imports);
- `import main as rag_api_main` → `run_transactional_update` (existing proven pattern).

**Fakes (in-process, hermetic):** a `RecordingTx` recording `update(ref, data)` / `set(ref, data, merge)` calls; a `FakeSnapshot` (`exists=True`, `to_dict()` → `{"status": "processing"}` so the transition gate passes); a `FakeDocRef` exposing `id`, `get(transaction=...)`, and `collection("processing").document("summary")`; a `FakeDb` whose `transaction()` returns a fresh `RecordingTx`. The `firestore.transactional` decorator bound in `rag_api_main` is patched to identity (`rag_api_main.firestore.transactional = lambda f: f`) so the inner `update_logic` executes against the fakes; `firestore.SERVER_TIMESTAMP` remains a mock sentinel and is ignored by assertions.

**Test matrix:**

| # | Test | Asserts | Drift guarded |
|---|---|---|---|
| T1 | Worker payload construction: `build_failure_payload` on a `TransientError`, a `PermanentError`, and a generic `Exception` (with representative stages, e.g. `"text_retrieved"` early / `"embeddings_complete"` late) | Exact key set `{error, error_message, stage, retryable}`; `error_message == str(e)`; `stage` passthrough; `retryable` mapping true/true/false per §3.2 | Worker-side key drift (T1 fails if a key is renamed/removed) |
| T2 | End-to-end transient failure: T1's payload fed as `details` through `run_transactional_update(db, doc_ref, "failed", details, logger, user_id)` | Recorded main-doc update: `error` == worker message, `error_stage` == worker stage, `retryable is True`; recorded summary set: `error.message` == message, `error.stage` == stage, `error.code` == `"UNKNOWN"`, `stage` == stage | Both sides' key/value drift |
| T3 | End-to-end permanent/unknown failure (generic exception) | Same equality assertions with `retryable is False` — proves the API's `retryable` fallback is not operative for worker failures (C3) | API fallback regression |
| T4 | API key-read pin: `details` missing all three contract keys | Persisted fallbacks `"Processing failed"` / `None` / `True` — pins exactly which keys the failed branch reads | API-side key rename |
| T5 (recommended) | Static AST guard on worker `main.py` (house pattern from `test_api_contracts.py`'s agent-graph analysis): the failed `_publish_status_update` call site routes through `build_failure_payload`, and `current_stage` assignments precede the tracked step awaits | Call-site shape | Handler bypassing the builder; tracker removal |

Stage-tracker *placement* is pinned by the §3.1 convention plus code review, with T5 as the optional automated tripwire; the contract test intentionally covers representative stages rather than ossifying every step (per the definition's test scope). Note for implementers: T1 asserts the builder's exact key set *before* `_publish_status_update`'s `jobId` injection, which is downstream existing behavior and not part of the failure contract.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic reading the old key set | Legacy `error` key retained with identical value; residual risk accepted as low (definition F11) |
| Stage-tracker drift as the pipeline evolves | "Assign immediately before the await" convention; representative-stage coverage; optional T5 static guard |
| `retryable: false` for genuinely transient-but-unrecognized failures | Accepted — `classify_error`'s conservatism prevents infinite retry loops; widening it is out of scope; manual reprocess via `POST /process` remains |
| Contract test ossifies the payload | Intentional drift guard; adding a key later means touching the test, which is the point |
| Failure publish itself fails (swallowed/logged by `_publish_status_update`) | Existing behavior; the stale-lease sweep remains the backstop; unchanged |
| Redelivered transient failure may be acked without reprocessing (terminal `"failed"` claim state) | Existing timing-dependent behavior, explicitly out of scope; documented in requirements §7 |

## 9. Traceability

| Definition requirement | FR | Design | Tests |
|---|---|---|---|
| R1 payload carries `error_message`/`stage`/`retryable`, never fallback-reliant | FR-1, FR-3 | §2, §3.3 | T1, T2, T3 |
| R2 stage tracking with existing vocabulary + `"processing"` safe value | FR-2 | §3.1 | T1 (passthrough), T5 (optional), review |
| R3 rag-api persists worker values unchanged; summary carries same message/stage | FR-4 | §3.4, §5 | T2, T3, T4 |
| R4 retryable derivation aligned with ACK/NACK | FR-3 | §3.2 | T1, T3 |
| R5 contract test on worker failure → rag-api persistence with drift guards | FR-5 | §7 | T1–T4 (+T5) |

Constraints C1–C5 → requirements §5; acceptance AC-1..AC-4 → requirements §6.

## 10. Open items (carried into implementation)

1. Inspect `rag-worker-service/exceptions.py`; consolidate the classification move there if compatible (§3.3).
2. Optional: decide whether to add T5's static guard in the same change or as a fast-follow.
3. Deferred (per definition): companion D3 issue scope; `plans/upload-flow.md` D4 reconciliation; any audit of non-rag-api status-topic consumers.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>