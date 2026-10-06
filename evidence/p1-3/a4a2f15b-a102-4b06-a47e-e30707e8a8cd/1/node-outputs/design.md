<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- **Cycle intent:** `rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage`
- **Authoritative source:** WorkItem `wi-define-108-a8`, Definition artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document operationalizes that definition. Where wording differs, the Definition is binding; this document may not widen, narrow, or reinterpret it.
- **Companion document:** `docs/architecture.md` (design, component changes, test architecture).

---

## 1. Problem statement

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test covers the seam:

- **Worker (producer):** `process_document`'s exception handler publishes a failed status whose details contain a single key, `{"error": str(e)}` (`apps/ai-server/rag-worker-service/main.py`).
- **rag-api (consumer):** the failed branch of `run_transactional_update` reads three keys — `error_message`, `stage`, `retryable` — and persists them as `error`, `error_stage`, and `retryable` on the main resource document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument (`apps/ai-server/rag-api-service/main.py`).

Consequence (F5): every worker-originated failure currently persists `error` as the fallback string `"Processing failed"`, `error_stage` as `None`, and `retryable` as the silent default `True`. The `processing/summary` error subdocument inherits the same fallbacks, with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures (F1).

The persisted failure schema (`error` / `error_stage` / `retryable`) is already established everywhere else (F6): the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths (`POST /process`, `POST /resources`), the `Resource` model, and `ResourceResponse` all use it. The worker's status publisher is the only writer that does not speak it.

## 2. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's **actual error message**, the **failing pipeline stage**, and a **deliberately derived retryable flag** — locked in by a contract test on the worker→rag-api failure path.

## 3. Scope

### 3.1 In scope
- The worker's failed-status payload construction in `process_document`'s exception handler (`apps/ai-server/rag-worker-service/main.py`).
- Stage tracking through `process_document` so the failure handler can report the failing stage.
- Extraction of the contract-critical failure-payload logic into a dependency-light module so it is directly testable (see architecture §Component design).
- A contract test covering the worker failure → rag-api persistence path (`apps/ai-server/tests/integration/`), plus worker-side unit tests for the payload builder and derivation.

### 3.2 Out of scope (non-goals)
- **N-1:** Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- **N-2:** Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- **N-3:** Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **N-4:** Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- **N-5:** Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred — see §10).

## 4. Functional requirements

### FR-1 — Failure payload keys (worker → rag-api)
When document processing fails, the worker's failed status payload **must** include:
- `error_message` — the actual exception message (`str(e)`), not a fallback string;
- `stage` — the pipeline stage executing at failure time (see FR-2);
- `retryable` — a deliberately derived boolean (see FR-4).

The payload **must never rely on rag-api's fallback defaults** for these keys (i.e., rag-api's `details.get("error_message", "Processing failed")`, `details.get("stage")` → `None`, and `details.get("retryable", True)` must never be the operative mechanism for a worker-originated failure).

*Verification: T1, T3, T4, T5, T6 (see §11).*

### FR-2 — Stage tracking and stage vocabulary
The worker **must** track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Constraints on stage values:
- Stage names **must** reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown (the same value the stale-lease sweep writes for `error_stage`, so the field never regresses to null).
- No new stage names may be introduced by this fix.

*Verification: T3, T4, T7 (wiring guard).*

### FR-3 — rag-api persistence of worker-provided values (consumer side preserved)
rag-api's failed branch **must** persist the worker-provided values unchanged:
- main document: `error` ← payload `error_message`; `error_stage` ← payload `stage`; `retryable` ← payload `retryable`;
- `processing/summary` error subdocument: `error.message` ← payload `error_message`; `error.stage` ← payload `stage` (so the subdocument carries the same message and stage as the main document); `error.code` remains `"UNKNOWN"` unless a code is actually sent.

This is a **preservation** requirement: rag-api's failed-branch reads and the persisted schema are frozen as the contract's consumer side. No rag-api code change is required or permitted by this fix.

*Verification: T3, T4, T5.*

### FR-4 — retryable derivation (explicit, aligned with ACK/NACK behavior)
The worker **must** derive `retryable` explicitly from `classify_error(e)` — never by omission/default:
- errors classified **transient** by `classify_error` → `retryable: true`;
- errors classified **permanent** (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.

Rationale (F8): this aligns the persisted record with the worker's actual retry behavior — a transient error is one Pub/Sub would redeliver; a permanent error is acked and will not come back (manual reprocess via `POST /process` remains available). The stale-lease sweep's separate `retryable=true` write stays correct because a dead worker is a transient condition.

Deliberate behavior change: unclassified-unknown exceptions previously persisted `retryable: true` via rag-api's silent default; they now persist `false`. This is intended conservatism, not a regression.

*Verification: T2, T3, T4.*

### FR-5 — Contract test on the worker failure → rag-api persistence path
A contract test **must** cover the worker failure → rag-api persistence path. It must:
- exercise the **worker's failure-payload construction** (the real code path the handler uses, including the `classify_error` derivation) and **rag-api's failed-branch persistence** (`run_transactional_update`), via the Firestore emulator or fakes;
- assert the persisted `error`, `error_stage`, and `retryable` **equal the worker's values** (main document and summary error subdocument);
- **fail if either side's payload keys drift** — both a behavioral drift guard (fallback values reappearing fails the test) and an explicit key-set/wiring guard.

*Verification: T3–T7.*

## 5. Contract snapshot

Worker failure payload (`details` inside the standard status envelope; envelope itself unchanged):

| Key | Type | Value |
|---|---|---|
| `error_message` | str | `str(e)` — the actual exception message |
| `error` | str | same string — **legacy key retained** (compat hedge, A-2) |
| `stage` | str | tracker value from the existing progress vocabulary; `"processing"` if unknown |
| `retryable` | bool | `classify_error(e)` |

rag-api persistence (unchanged consumer behavior): `error` ← `error_message`, `error_stage` ← `stage`, `retryable` ← `retryable`; summary `error.{message,stage}` mirror the same two values, `error.code` defaults `"UNKNOWN"`. Full tables and the stage-attribution map are in `docs/architecture.md`.

## 6. Constraints

| # | Type | Constraint |
|---|---|---|
| C-1 | must | The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema. |
| C-2 | must_not | The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. |
| C-3 | must | Every worker-originated failure payload must carry `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| C-4 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling. |
| C-5 | prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## 7. Acceptance criteria

| # | Criterion | Met when |
|---|---|---|
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | T1, T3, T4, T6 pass; payload keys verified against the builder's output. |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | T3, T4, T5 pass against the fake (or emulator) Firestore. |
| AC-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | T3, T4 assert summary `error.message`/`error.stage` equality. |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | `apps/ai-server/tests/integration/test_worker_failure_contract.py` exists and passes (T3–T7). |

## 8. Assumptions

- **A-1 (F8, ASSUMED):** Adopted default for the `retryable` derivation — the worker sets `retryable` from `classify_error(e)` (transient → `true`; permanent, including unclassified-unknown, → `false`). Rationale as in FR-4.
- **A-2 (F11, ASSUMED):** No consumer other than rag-api's status subscriber is known to parse the worker's failure payload keys; as a hedge, the worker retains the legacy `error` key alongside `error_message` so any unknown consumer of the status topic keeps working. If a later audit confirms rag-api is the only consumer, dropping the duplicate is trivial cleanup (out of scope now).

## 9. Facts relied upon

| ID | Status | Summary (evidence) |
|---|---|---|
| F1 | KNOWN | Failed jobs must persist actual message + failing stage; retryable must be sent or derived deliberately, never silently defaulted. (human, product-intent) |
| F2 | KNOWN | Preferred fix direction: align worker payload keys to `error_message`/`stage` — avoids a schema migration. (human, product-intent) |
| F3 | KNOWN | Worker publishes failed status with `{"error": str(e)}` from `process_document`'s exception handler. (`rag-worker-service/main.py`) |
| F4 | KNOWN | rag-api's failed branch reads `error_message`/`stage`/`retryable`; persists `error`/`error_stage`/`retryable` on the main doc; writes `message`/`stage` (+ `error_code` default `"UNKNOWN"`) into `processing/summary`. (`rag-api-service/main.py`) |
| F5 | KNOWN | Key mismatch ⇒ every worker failure persists fallback `"Processing failed"`, `error_stage=None`, silent `retryable=True`. (both mains) |
| F6 | KNOWN | `error`/`error_stage`/`retryable` is the established persisted schema (sweep, enqueue-failure paths, `Resource`, `ResourceResponse`). (worker main; api main; `models/resource.py`) |
| F7 | KNOWN | Worker classifies exceptions via `classify_error()` (TransientError/PermanentError + type/status-code heuristics; unknown → permanent) and uses it for ACK/NACK in `run_worker`. (`rag-worker-service/main.py`) |
| F9 | KNOWN | Worker publishes named stages in progress updates (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`); the failure handler has no stage tracking today. (`rag-worker-service/main.py`) |
| F10 | KNOWN | Contract-test infrastructure exists (`tests/integration/test_api_contracts.py`, fixture/AST-based static contract tests) and both services support a hermetic Firestore-emulator mode (`FIRESTORE_EMULATOR_HOST` branches). |
| F12 | DEFERRED | A companion D3 issue is referenced by the Objective; its scope is unavailable here and outside this Definition's bounded scope. |

## 10. Deferred

- **D-1:** Anything the companion D3 issue covers beyond this worker→rag-api failure payload alignment (content unavailable in this context).
- **D-2:** Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text.

## 11. Verification matrix

| Test ID | Artifact | Covers |
|---|---|---|
| T1 | `rag-worker-service/tests/unit/test_failure_payload.py` — payload key set & legacy `error` retention | FR-1, AC-1 |
| T2 | `rag-worker-service/tests/unit/test_failure_payload.py` — `classify_error` → `retryable` mapping (transient/permanent/unclassified) | FR-4 |
| T3 | `tests/integration/test_worker_failure_contract.py` — transient failure, early stage → persisted values (main + summary) | FR-1, FR-3, FR-4, FR-5, AC-1–AC-4 |
| T4 | `tests/integration/test_worker_failure_contract.py` — permanent failure, late stage → persisted values (main + summary) | FR-1, FR-3, FR-4, FR-5, AC-1–AC-4 |
| T5 | `tests/integration/test_worker_failure_contract.py` — regression guard: persisted `error != "Processing failed"`, `error_stage is not None` | FR-1, FR-3, AC-2 |
| T6 | `tests/integration/test_worker_failure_contract.py` — payload key-set drift guard | FR-1, FR-5, AC-1, AC-4 |
| T7 | `tests/integration/test_worker_failure_contract.py` — AST wiring guard: handler routes through the payload builder and reports the tracker; rag-api's failed branch reads `error_message`/`stage`/`retryable` | FR-2, FR-5, AC-4 |
| T8 (optional) | Emulator-marked variant of T3/T4 against a real Firestore emulator (`FIRESTORE_EMULATOR_HOST`), skipped when unset | FR-5 |
| — | Existing `rag-worker-service/tests/unit/test_processing_lease.py` must keep passing (sweep untouched, N-1) | N-1 |
| — | Existing `tests/integration/test_api_contracts.py` must keep passing (rag-api models untouched, C-1/C-2) | C-1, C-2 |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

- **Cycle intent:** `rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage`
- **Authority:** Operationalizes Definition `definition:obj-108` (WorkItem `wi-define-108-a8`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). Requirements live in `docs/requirements.md`; on any conflict, the Definition wins.

---

## 1. Context and problem

`process_document` (`apps/ai-server/rag-worker-service/main.py`) is one large `try` block. Its exception handler publishes a failed status with a one-key payload:

```python
await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)
```

rag-api's failed branch (`run_transactional_update`, `apps/ai-server/rag-api-service/main.py`) reads a different contract:

```python
main_update["error"]      = details.get("error_message", "Processing failed")
main_update["error_stage"] = details.get("stage")
main_update["retryable"]   = details.get("retryable", True)
...
summary_update["error"] = {
    "code":    details.get("error_code", "UNKNOWN"),
    "message": details.get("error_message", "Processing failed"),
    "stage":   details.get("stage"),
}
```

Every worker failure therefore lands in Firestore as `"Processing failed"` / `None` / `True`, and the `processing/summary` error subdocument inherits the fallbacks with `error_code="UNKNOWN"`. Three other write paths (stale-lease sweep, both enqueue-failure paths) and both response models already use the `error`/`error_stage`/`retryable` schema — the worker's status publisher is the only writer that doesn't speak it.

## 2. Design direction and principles

1. **The worker aligns to the API.** The persisted field names are consistent across three write paths and two response models; changing the API side is the change that ripples. rag-api is **frozen** as the contract's consumer side (§4.2) — no code change there.
2. **Derive, don't default.** `retryable` is computed by the worker from `classify_error(e)` — the same function that drives ACK/NACK — so the persisted record tells the truth about retry behavior.
3. **No migration.** No Firestore field renames, no backfill; existing failed documents keep their historical fallback values.
4. **The seam gets a test.** The contract test imports both sides rather than restating the contract in a fixture, so key drift on either side fails the build.

## 3. Target contract specification

### 3.1 Worker failure payload (producer side — changed)

Built by the worker's exception handler and published inside the **unchanged** status envelope (`user_id`, `course_id`, `resource_id`, `status: "failed"`, `details`, `timestamp`, `sequence`; the publisher adds `jobId` when a job id exists — existing behavior for all statuses):

```python
{
    "error_message": str(e),            # actual exception message
    "error":         str(e),            # legacy key retained (compat hedge, A-2)
    "stage":         <tracker value>,   # existing progress vocabulary; "processing" if unknown
    "retryable":     classify_error(e), # deliberately derived, never defaulted
}
```

The builder's key set is exactly `{"error_message", "error", "stage", "retryable"}`. `jobId` is added later by `_publish_status_update` and is not part of the builder's contract.

### 3.2 rag-api failed branch (consumer side — frozen, unchanged)

| Payload key | Main document field | `processing/summary` error field |
|---|---|---|
| `error_message` | `error` | `error.message` |
| `stage` | `error_stage` | `error.stage` |
| `retryable` | `retryable` | — |
| *(not sent)* `error_code` | — | `error.code` (default `"UNKNOWN"`) |

rag-api's fallbacks (`"Processing failed"`, `None`, `True`, `"UNKNOWN"`) remain in its code untouched — the requirement is that worker-originated payloads always carry the three keys so the fallbacks are never operative. The transition guard is unchanged: `processing → failed` is allowed; `completed → failed` is rejected (relevant to §5, post-completion steps).

### 3.3 Stage vocabulary and phase attribution

The tracker is a local in `process_document`, initialized to `"processing"` immediately before the `try`, and **set immediately before each pipeline `await`** (the convention: *set the tracker immediately before the await*). Values come only from the existing progress vocabulary plus the `"processing"` fallback; `"completed"` is never a valid `error_stage` (a failure cannot be at a stage that succeeded).

| Tracker set immediately before | Value | Progress published on success |
|---|---|---|
| start of `try` (before `_validate_processing_request`) | `starting` | `starting` |
| `_get_extracted_text` | `text_retrieved` | `text_retrieved` (20) |
| `content_tagger.generate_tags` | `tagging_complete` | `tagging_complete` (40) |
| `generate_document_summary` + main-doc summary update | `summary_generated` | `summary_generated` (50) |
| `_create_enhanced_chunks` | `chunking_complete` | `chunking_complete` (60) |
| `_generate_embeddings_with_openrouter` | `embeddings_complete` | `embeddings_complete` (80) |
| storage tail: `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection` | *(no change — remains `embeddings_complete`)* | `completed` (100) |
| post-completion: `_update_user_usage`, `_generate_resource_map` | *(no change)* | — (after the terminal publish) |

Boundary rules (documented, deliberate):
- The tracker names the **phase in progress**, using the vocabulary's milestone name for that phase. A failure during text extraction reports `text_retrieved`; during tagging, `tagging_complete`; etc.
- The storage tail (vector delete/store, metadata persistence) has no vocabulary name; it lives in the `embeddings_complete → completed` interval of the published timeline, so the tracker stays at `embeddings_complete`. This is the honest coarse attribution the fixed vocabulary allows — e.g. the real partial-vector-write `RuntimeError` from `store_chunks_via_service` reports `embeddings_complete`.
- Post-completion steps cannot produce a worker failed publish that persists: `_update_user_usage` and `_generate_resource_map` swallow their own exceptions, and rag-api rejects `completed → failed` anyway.
- `"processing"` (the same value the stale-lease sweep writes) is the fallback when the stage is genuinely unknown; because the tracker is initialized to it, the fallback is automatic and `error_stage` never regresses to `None`.

### 3.4 retryable derivation

`retryable = classify_error(e)` — the exact function already used for ACK/NACK in `run_worker`:

| Exception | `classify_error` | Persisted `retryable` |
|---|---|---|
| `TransientError` | transient | `true` |
| `httpx.ConnectError` / `ConnectTimeout` / `ReadTimeout` / `WriteTimeout` / `PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | transient | `true` |
| `httpx.HTTPStatusError` with status 429/500/502/503/504 | transient | `true` |
| `PermanentError` | permanent | `false` |
| `httpx.HTTPStatusError` with other 4xx | permanent | `false` |
| anything else (unclassified-unknown) | permanent (conservative default) | `false` |

Deliberate behavior change: unclassified-unknown exceptions previously persisted `retryable: true` via rag-api's silent default; they now persist `false` — the conservatism `classify_error` was written for (prevents infinite retry loops). Manual reprocess via `POST /process` is unaffected. Widening `classify_error` (e.g. unwrapping tenacity `RetryError`) is explicitly out of scope.

Note on alignment semantics: `process_document`'s handler converts pipeline exceptions into a failed status and returns, so the message is acked regardless; `retryable` reports what the classification says about the failure class (transient conditions vs. permanent ones), consistent with the ACK/NACK rule for exceptions that do escape. The stale-lease sweep's separate `retryable=true` write is untouched and stays correct (a dead worker is a transient condition).

### 3.5 Legacy `error` key (compat hedge)

Only rag-api's status subscriber is a verified consumer of these payloads; other services/tooling share the topic. The worker retains the legacy `error` key (same string as `error_message`) — one redundant string per failure message as insurance against unknown readers and log tooling. rag-api ignores it (it reads `error_message`). Dropping the duplicate later is trivial cleanup after a consumer audit and is out of scope now.

## 4. Component design

### 4.1 New module: `rag-worker-service/failure_payload.py` (dependency-light)

Extracts the contract-critical logic so it is importable and testable **without** the worker's heavy dependency stack (langchain/openai/spacy/tiktoken/firebase stubs). Imports: stdlib + `httpx` only.

```python
"""Worker → rag-api failure payload contract (dependency-light)."""
import httpx

class ProcessingError(Exception): ...
class TransientError(ProcessingError): ...   # moved verbatim from main.py
class PermanentError(ProcessingError): ...   # moved verbatim from main.py

def classify_error(e: Exception) -> bool:
    ...  # moved verbatim from main.py (same heuristics, same conservative default)

UNKNOWN_STAGE = "processing"

def build_failure_details(exception: Exception, stage: str | None) -> dict:
    message = str(exception)
    resolved_stage = stage if stage else UNKNOWN_STAGE
    return {
        "error_message": message,
        "error": message,        # legacy key retained for unknown topic consumers
        "stage": resolved_stage,
        "retryable": classify_error(exception),
    }
```

Moving `TransientError`/`PermanentError`/`classify_error` is mechanical: `main.py` re-exports them (`from failure_payload import ProcessingError, TransientError, PermanentError, classify_error, build_failure_details`), so `run_worker`'s `classify_error` reference and any `main.TransientError` users keep working against the same class objects. `exceptions.py` (the `PDFProcessingError` family) is unrelated and untouched.

**Architectural rule:** this module must stay dependency-light — it is the seam the cross-service contract test imports.

### 4.2 `rag-api-service/main.py` — no changes

The failed branch of `run_transactional_update` is frozen as the consumer side of the contract (§3.2). Its current reads and persisted schema are exactly what the worker now targets. Any future edit to that branch must update the contract test — that is the drift guard doing its job.

### 4.3 `rag-worker-service/main.py` — changes

1. **Re-export** the moved names (§4.1); delete the inline definitions.
2. **Stage tracker** in `process_document`: initialize `current_stage = "processing"` immediately before the `try`; assign it immediately before each pipeline step per the §3.3 table.
3. **Exception handler** rewrite:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    failure_details = build_failure_details(e, current_stage)
    self.logger.error("document_processing_failed", user_id=..., course_id=..., resource_id=...,
                      error=str(e), stage=failure_details["stage"], retryable=failure_details["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e), "stage": failure_details["stage"]})
    return metrics
```

4. **Unchanged:** `_publish_status_update` (sequence numbering, lease heartbeat, terminal-state reset, `jobId` injection), `ProcessingMetrics` (already has `error_message`; no new fields), the stale-lease sweep, claim/lease logic, ACK/NACK policy, and all pipeline steps themselves.

### 4.4 Data flow (unchanged transport, new payload)

```
process_document step raises
  → handler: build_failure_details(e, current_stage)      # error_message/error/stage/retryable
  → _publish_status_update("failed", details, job_id)      # envelope + jobId + sequence (unchanged)
  → Pub/Sub rag-status-updates topic
  → rag-api subscriber _process_status_message             # unchanged
  → run_transactional_update failed branch                 # unchanged reads
  → Firestore: main doc {status, error, error_stage, retryable, ...}
             + processing/summary {stage, progress, error:{code,message,stage}}
```

### 4.5 Edge cases and error handling

- **Publish failure inside the handler:** `_publish_status_update` catches and logs (`status_publish_failed`) — unchanged; a publish failure must not crash the handler.
- **Stage genuinely unknown:** tracker initialized to `"processing"`; builder maps a falsy stage to `"processing"` as defense in depth.
- **Empty exception message:** `str(e) == ""` is persisted verbatim — the requirement is the *actual* exception message; no synthesis. Accepted minor case.
- **Post-completion failures:** cannot produce a persisted worker failure (steps swallow internally; rag-api rejects `completed → failed`) — see §3.3.
- **Pre-`process_document` failures** (payload parse, claim failure): no failed status is published by the worker today; those paths and their ACK/NACK handling are out of scope.

## 5. Testing architecture

### 5.1 Unit tests — `rag-worker-service/tests/unit/test_failure_payload.py` (new)

Runs under the worker's existing stub conftest. Asserts:
- **T1:** `build_failure_details` returns exactly `{"error_message", "error", "stage", "retryable"}`; `error == error_message`; falsy/`None` stage resolves to `"processing"`.
- **T2:** derivation mapping — `TransientError` → `True`; `httpx.ConnectError`/`TimeoutError` → `True`; `httpx.HTTPStatusError` 429 → `True`, 404 → `False`; `PermanentError` → `False`; `ValueError` (unclassified) → `False`.

### 5.2 Contract test — `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new)

Location follows the house pattern (`test_api_contracts.py`); the existing `tests/integration/conftest.py` mocks cover the rag-api import. The worker side is imported **only** as `failure_payload` (dependency-light, §4.1) — the test must not import the worker's heavy `main.py`.

Imports and patches:
- `sys.path` insert for `rag-worker-service`; `import failure_payload`.
- `import main as rag_api_main` (rag-api-service), then monkeypatch `rag_api_main.firestore.transactional` → identity decorator and `SERVER_TIMESTAMP` → sentinel — the same pattern `test_processing_lease.py` uses for the worker's transactions.

Fake Firestore (tx-scoped, keyed by document path so main doc and summary subdoc have separate state):

```python
state: dict[path, dict]
db.transaction()      → FakeTx   # get(ref) → snapshot(state[ref.path]); update(ref, data) → merge; set(ref, data, merge=True) → merge
db.document(path)     → FakeRef  # .collection("processing").document("summary") → FakeRef("<path>/processing/summary")
```

Seed the main document with `status: "processing"` (so `processing → failed` is an allowed transition) plus ownership fields.

Cases and assertions:

| Case | Exception | Stage | Expected persisted |
|---|---|---|---|
| T3 transient / early | `httpx.ConnectTimeout("...")` | `text_retrieved` | `retryable=True`, `error_stage="text_retrieved"`, `error=<message>` |
| T4 permanent / late | `RuntimeError("partial vector write: 40/41 chunks stored, 1 failed — ...")` | `embeddings_complete` | `retryable=False` (unclassified → conservative), `error_stage="embeddings_complete"` |
| T3b/T4b unclassified / early | `ValueError("Document ... not found ...")` | `starting` | `retryable=False` — pins the deliberate behavior change (A-1) |

Per case (flow: `payload = failure_payload.build_failure_details(exc, stage)` → `rag_api_main.run_transactional_update(fake_db, doc_ref, "failed", payload, logger, user_id)`):
- main doc: `status == "failed"`; `error == str(exc)`; `error_stage == stage`; `retryable == expected`;
- summary: `error.message == str(exc)`; `error.stage == stage`; `error.code == "UNKNOWN"`;
- **T5 regression guard:** `error != "Processing failed"` and `error_stage is not None` — if either side's keys drift, rag-api's fallbacks reappear and these assertions fail.

Drift guards:
- **T6 key-set guard:** `set(payload) == {"error_message", "error", "stage", "retryable"}` and `"error" == "error_message"` (legacy key retained per C-4).
- **T7 AST wiring guard** (house AST pattern, in-process `ast.parse`):
  - worker `main.py`: `process_document`'s exception handler references `build_failure_details` and passes its result to the `"failed"` `_publish_status_update` call; the stage tracker is assigned in `process_document` (each vocabulary stage appears as an assignment value) and read by the handler — pins the wiring without ossifying line positions;
  - rag-api `main.py`: the failed branch's `details.get(...)` keys include `error_message`, `stage`, `retryable` — pins the consumer side.
- **T8 (optional):** emulator-marked variant running the same flow through a real Firestore client when `FIRESTORE_EMULATOR_HOST` is set (both services already support that branch), `skipif` otherwise. Fakes are the default; the emulator path is a bonus, not a gate.

### 5.3 Existing tests that must keep passing

- `rag-worker-service/tests/unit/test_processing_lease.py` — sweep/claim untouched (N-1); the fake-db pattern there is the template for §5.2's fake.
- `tests/integration/test_api_contracts.py` — rag-api models untouched (C-1/C-2).

## 6. Rollout and compatibility

- **Deploy:** rebuild/redeploy `rag-worker-service` only. rag-api is untouched.
- **Data:** no migration, no rename, no backfill (C-2). Historical failed documents keep their fallback values; only new failures persist real values.
- **Consumers:** legacy `error` key retained (C-4/A-2); rag-api ignores it; unknown topic consumers keep working.
- **Observability:** `document_processing_failed` structured log gains `stage` and `retryable` fields; `status_update_published` already logs details.

## 7. Risks and tradeoffs

| Risk | Mitigation / stance |
|---|---|
| Unknown consumers of the status topic reading the old key set | Legacy `error` retained; residual risk accepted as low (A-2). |
| Stage-tracker drift as the pipeline evolves | "Set the tracker immediately before the await" convention + representative-stage contract coverage (early/late) + T7 wiring guard. |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains. |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key later means touching the test. |
| Extraction churn (moving `classify_error`/exception classes) | Mechanical move with re-exports; `run_worker` and any `main.*` references keep resolving to the same objects. |

## 8. Rejected alternatives

- **Change rag-api to read `error`** (align API to worker): ripples across the established persisted schema, three write paths, and two response models; would invite a migration. Rejected (C-1).
- **New stage names for the storage tail** (e.g. a `vector_storage` stage): introduces vocabulary outside the Definition's fixed set. Rejected; the tail reports `embeddings_complete` (§3.3).
- **Drop the legacy `error` key now:** trivial later cleanup after a consumer audit; premature today (C-4).
- **Import the worker's heavy `main.py` in the contract test:** requires replicating the worker's 150-line stub wall in the integration env; fragile. Rejected in favor of the dependency-light `failure_payload` extraction (§4.1).
- **Structured error-code taxonomy:** explicitly a non-goal (N-4, C-5); `error.code` stays `"UNKNOWN"` unless a code is actually sent.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>