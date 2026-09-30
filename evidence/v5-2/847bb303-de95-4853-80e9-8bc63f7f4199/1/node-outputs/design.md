<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api Failure Payload Contract Alignment

- **Run:** 847bb303-de95-4853-80e9-8bc63f7f4199 · Iteration 1 · Step: design
- **Scope source (authoritative):** WorkItem `wi-define-108-a8`, Definition artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document refines that Definition for implementation; where wording differs, the Definition wins. Requirement IDs trace to the Definition's facts (F#), constraints (C#), requirements (R#), and acceptance criteria (A#).
- **Change sites (per Definition evidence refs):** `apps/ai-server/rag-worker-service/main.py` (producer) and `apps/ai-server/tests/integration/` (contract test). rag-api production code is **not** changed (see FR-5).

## 1. Problem statement

The worker's exception handler in `process_document` publishes a failed status with a one-key payload (`{"error": str(e)}`), while rag-api's failed branch in `run_transactional_update` reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error`, `error_stage`, and `retryable`. Because of the key mismatch, every worker-originated failure currently persists the fallback string `"Processing failed"`, a null `error_stage`, and a silently defaulted `retryable: true` — on the main resource document and in the `processing`/`summary` error subdocument (with `error_code` always `"UNKNOWN"`). Users and support cannot disambiguate failures, and the persisted retryability does not reflect the worker's actual retry decision. Three other write paths (worker stale-lease sweep, rag-api enqueue-failure paths) and both response models already use the `error`/`error_stage`/`retryable` schema; the worker's status publisher is the only writer that does not speak it.

## 2. Scope

### 2.1 In scope
1. The worker's failure-status payload: keys, values, and construction (message, stage, retryable, legacy `error` key).
2. Stage tracking inside `process_document` so the failure handler can report where the job was.
3. Explicit derivation of `retryable` from the worker's existing error classification.
4. One contract test covering the worker failure → rag-api persistence seam, including a key-set drift guard, plus small supporting worker-side unit tests.

### 2.2 Out of scope (non-goals, from Definition)
- Changing rag-api's reads, persisted schema, or the `details.get(...)` fallbacks (C-1: the worker aligns to the API, never the reverse).
- Any Firestore migration, field rename, or backfill (C-2: must_not).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- The stale-lease sweep's direct failure write (already contract-consistent; keeps `retryable: true`).
- Structured error codes / failure taxonomy (`error_code` stays `"UNKNOWN"` unless actually sent; the worker sends none).
- Frontend/mobile changes (`ResourceResponse` already exposes `error`/`error_stage`).
- Anything the companion D3 issue covers beyond this payload alignment (its content is unavailable here; deferred), and reconciling with the D4 deviation note in `plans/upload-flow.md` (file verified absent from the `plans/` listing).

## 3. Normative data contract

### 3.1 Worker failure payload (producer side)

Published by the worker's existing failure path (`_publish_status_update`, status `"failed"` — mechanism and topic unchanged). The `details` keys:

| Key | Type | Source | Semantics |
|---|---|---|---|
| `error_message` | string | The caught exception's message (`str(e)`); if empty, the exception class name | The actual error message; never a generic fallback |
| `error` | string | Identical value to `error_message` | Legacy key retained for continuity with any unknown consumers of the status topic and existing log tooling (F11, C-4) |
| `stage` | string | The worker's stage tracker at failure time | The pipeline stage the job had reached; vocabulary locked to `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, with `processing` as the value when the stage is genuinely unknown (R-2, F9) |
| `retryable` | boolean | Derived from `classify_error(e)` | Transient-classified → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false` (F8, R-4) |

The payload must never rely on rag-api's fallback defaults for these keys, and `error` and `error_message` must always carry the same value.

### 3.2 Persisted failure fields (consumer side — unchanged rag-api behavior)

| Persisted field | Fed from | Fallback (remains in code, non-operative for worker failures) |
|---|---|---|
| `error` (main document) | payload `error_message` | `"Processing failed"` |
| `error_stage` (main document) | payload `stage` | `None` |
| `retryable` (main document) | payload `retryable` | `True` |
| `processing`/`summary` error subdocument | same message and stage | `error_code` defaults to `"UNKNOWN"` (worker sends no code) |

## 4. Functional requirements

- **FR-1 — Failure payload keys (R-1, C-3).** When document processing fails, the worker's failed status payload MUST include `error_message`, `stage`, and `retryable`, plus the legacy `error` key (FR-7). None of these values may be left to rag-api's fallback defaults.
- **FR-2 — Message fidelity (R-1).** `error_message` MUST be the actual exception message (`str(e)`). If `str(e)` is empty, the worker MUST use the exception class name so the field is never blank.
- **FR-3 — Stage tracking (R-2, F9).** `process_document` MUST maintain a stage tracker covering the whole pipeline body, updated at each pipeline step boundary (immediately before the next step begins), and the exception handler MUST report the tracker's value as `stage`. Stage names MUST reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`); `processing` is the initial/safe value when the stage is genuinely unknown (e.g., failure before the first boundary). The precise stage semantics (milestone-interval model) are specified in `docs/architecture.md` §4.1 and are binding for the contract test's expected values.
- **FR-4 — Retryable derivation (R-4, F7, F8, C-3).** `retryable` MUST be derived explicitly from `classify_error(e)`: errors classified transient → `true`; classified permanent — including unclassified-unknown exceptions, per `classify_error`'s conservative default — → `false`. The derivation MUST NOT silently default, and the API-side `details.get("retryable", True)` fallback MUST NOT be the operative mechanism for worker failures. This is a deliberate, documented behavior change for unclassified-unknown errors (previously effective `true`).
- **FR-5 — API persistence unchanged (R-3, C-1, C-2).** rag-api's failed branch MUST persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing`/`summary` error subdocument MUST carry the same message and stage. This is achieved with **zero rag-api production code changes**: the existing failed branch already implements the consumer side of this contract once the worker sends the keys.
- **FR-6 — Contract test (R-5, A-4).** A contract test MUST cover the worker failure → rag-api persistence path. It MUST (a) exercise the worker's real failure-payload construction code path (not a fixture restatement), (b) feed the captured payload through rag-api's failed-branch persistence (`run_transactional_update`) against the Firestore emulator or the suite's existing fakes, (c) assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and the `processing`/`summary` subdocument carries the same message and stage, (d) include a key-set drift guard that fails the build if either side's payload keys change, and (e) cover at least one early-stage failure and one late-stage failure.
- **FR-7 — Legacy key retention (C-4, F11).** The worker MUST retain the `error` key in the failure payload alongside `error_message`, with an identical value, as a compatibility hedge for unknown consumers of the status topic.

## 5. Constraints and non-functional requirements

- **NFR-1 (C-2, must_not).** No Firestore migration, field rename, or backfill of existing documents. Persisted fields `error`, `error_stage`, `retryable` keep their names and semantics.
- **NFR-2 (must_not).** No changes to Pub/Sub ACK/NACK policy, retry/backoff mechanics, processing leases, or heartbeat intervals.
- **NFR-3 (C-5, prefer_not).** No structured error-code taxonomy introduced; the worker sends no `error_code`, so the subdocument's `error_code` remains `"UNKNOWN"`.
- **NFR-4.** The stale-lease sweep (`_fail_if_still_stale`) is unchanged; its direct write of `error`/`error_stage`/`retryable` (with `retryable: true`) remains correct because a dead worker is a transient condition.
- **NFR-5.** All new tests MUST run hermetically: using the existing conftest stub/mock patterns (`apps/ai-server/tests/integration/conftest.py`, `apps/ai-server/rag-worker-service/tests/conftest.py`) and/or the services' `FIRESTORE_EMULATOR_HOST` branches. No live GCP dependencies.
- **NFR-6.** No frontend or mobile changes.

## 6. Acceptance criteria

- **AC-1.** A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. *(← FR-1, FR-2, FR-3, FR-4, FR-7)*
- **AC-2.** After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. *(← FR-5)*
- **AC-3.** The `processing`/`summary` error subdocument for the failed job carries the same message and stage as the main document. *(← FR-5)*
- **AC-4.** A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. *(← FR-6)*

## 7. Verification matrix

| Requirement | Verified by |
|---|---|
| FR-1, FR-2, FR-7 | Contract test, producer-side assertions (captured payload key set + values); worker unit tests |
| FR-3 | Contract test early/late failure scenarios (expected `stage` values); worker unit tests for boundary mapping |
| FR-4 | Contract test transient/permanent/unknown scenarios; worker unit tests for the classification→boolean mapping |
| FR-5 | Contract test, consumer-side persistence assertions (main document + subdocument) |
| FR-6 | The contract test itself, including the static key-set drift guard |
| NFR-1..NFR-6 | Design review; absence of changes verified by the drift guard and diff scope |

## 8. Edge cases (normative)

1. **Empty exception message** → `error_message`/`error` = exception class name (never blank).
2. **Failure before the first stage boundary** → `stage` = `"processing"` (same value the stale-lease sweep uses for `error_stage`; the field never regresses to null).
3. **Unclassified-unknown exception** → `retryable = false` (deliberate change from the previously effective silent `true`; manual reprocess via `POST /process` remains available).
4. **Failure in the vector-storage tail** (no dedicated vocabulary token exists) → `stage` = `"embeddings_complete"`, the opening milestone of the enclosing interval (see architecture §4.1); no new stage names may be invented.
5. **Legacy key consistency** → `error` and `error_message` are always identical strings.

## 9. Deferred

- The companion D3 issue referenced by the Objective (content unavailable in this context): anything it covers beyond this worker→rag-api failure payload alignment.
- Reconciling this analysis with the D4 deviation note in `plans/upload-flow.md` (file verified absent from the current `plans/` tree).
- Dropping the legacy `error` key, if a future audit confirms rag-api's status subscriber is the only consumer of the status topic.
- Widening `classify_error`'s heuristics or unifying it with any other classification mechanisms in the worker.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api Failure Payload Contract Alignment

- **Run:** 847bb303-de95-4853-80e9-8bc63f7f4199 · Iteration 1 · Step: design
- **Companion document:** `docs/requirements.md` (normative requirements FR-1..FR-7, NFR-1..NFR-6, AC-1..AC-4). Scope is bounded by Definition artifact `definition:obj-108` (WorkItem `wi-define-108-a8`).

## 1. Context: the seam as it is

```
process_document (rag-worker-service/main.py)
  └─ try: <pipeline steps, each publishing progress via _publish_status_update>
     └─ except: _publish_status_update(status="failed", details={"error": str(e)})   ← producer speaks 1 key
                                                                            │
                                                        Pub/Sub status topic (unchanged transport)
                                                                            │
run_transactional_update failed branch (rag-api-service/main.py)            ▼
  reads details: error_message, stage, retryable                            ← consumer speaks 3 keys
  persists:      error ← error_message (fallback "Processing failed")
                 error_stage ← stage   (fallback None)
                 retryable ← details.get("retryable", True)
  writes:        processing/summary error subdocument (message, stage, error_code default "UNKNOWN")
```

Every worker-originated failure therefore lands in Firestore as `"Processing failed"` / `None` / `true`. The established failure schema — `error`, `error_stage`, `retryable` — is already written directly by the worker's stale-lease sweep (`_fail_if_still_stale`) and rag-api's enqueue-failure paths, and exposed by `ResourceResponse` and the `Resource` model. The worker's status publisher is the only writer that does not speak it (F5, F6).

## 2. Design decision: the worker aligns to the API

**Decision.** Change only the worker's failure payload (keys + stage tracking + retryable derivation). rag-api's reads, fallbacks, and persisted schema are untouched.

**Rationale.** The persisted field names are consistent across three other write paths and two API response models; changing the API side is the change that ripples and would imply a migration/backfill (forbidden by C-2). The worker is the odd one out; fixing it is a self-contained producer change with zero consumer changes and zero schema impact.

**Diff shape.** Production changes are confined to `apps/ai-server/rag-worker-service/main.py` (stage tracker in `process_document`, failure-payload keys, retryable derivation). rag-api production code: none. Everything else is tests.

## 3. Target flow (to be)

```
process_document
  ├─ current_stage = "processing"                       ← tracker init
  ├─ [step boundary] current_stage = <milestone token>  ← updated before each step begins (§4.1)
  └─ except e:
       message   = str(e) or type(e).__name__
       retryable = classify_error(e) == transient        ← explicit derivation (§4.3)
       _publish_status_update(status="failed",
         details={"error_message": message,
                  "error": message,                      ← legacy hedge (FR-7)
                  "stage": current_stage,
                  "retryable": retryable})
                                                                            │
                                                        Pub/Sub status topic (unchanged)
                                                                            ▼
run_transactional_update failed branch (UNCHANGED code)
  persists error/error_stage/retryable + processing/summary subdoc from the now-present keys
```

Transport, topic, subscriber, transaction mechanism, and persisted schema are all unchanged. Only the `details` dict contents and the tracker are new.

## 4. Worker changes (`apps/ai-server/rag-worker-service/main.py`)

### 4.1 Stage tracker

**Mechanism.** A local variable in `process_document` (e.g. `current_stage`), initialized to `"processing"`, read by the exception handler, and updated at each pipeline step boundary — immediately before the next step's first `await`.

**Semantics (binding for tests).** Stages are the intervals between progress milestones, named after the milestone that opens the interval. The tracker holds the milestone the job has reached; a failure is reported at the stage the job was executing in. This makes the reported `stage` always consistent with the progress timeline clients already see: the reported token is always a milestone the job actually reached (or `"starting"`/`"processing"`), never a milestone that failed to happen.

**Assignment schedule** (boundaries mirror the existing `_publish_status_update` progress call sites in `process_document`; the implementer maps each assignment to the same phase the corresponding progress update describes):

| Boundary (tracker updated immediately before…) | Assignment | Failures thereafter report |
|---|---|---|
| Function entry, before first boundary | *(initial)* `"processing"` | `"processing"` (stage genuinely unknown) |
| First pipeline step (text retrieval) | `"starting"` | failures during text retrieval |
| Tagging step | `"text_retrieved"` | failures during content tagging |
| Summary-generation step | `"tagging_complete"` | failures during summary generation |
| Chunking step | `"summary_generated"` | failures during chunking |
| Embedding-generation step | `"chunking_complete"` | failures during embedding generation |
| Vector-storage / final persistence step | `"embeddings_complete"` | failures in the storage tail |

Notes:
- Each vocabulary token is used exactly once; no new stage names are introduced (R-2 locks the vocabulary). The vector-storage tail has no dedicated token, so it reports the opening milestone of its interval (`"embeddings_complete"`) — truthful ("all embedding work done; failure in persistence") and within the locked vocabulary.
- **Drift convention:** any future pipeline step MUST be bracketed by a tracker update at its opening boundary. Under the interval semantics, a step added without an update degrades gracefully — its failures report the enclosing interval's milestone rather than a wrong phase.
- The tracker is a plain local; the failure handler reads it without any operation that could itself throw.

### 4.2 Failure payload construction

Inside the existing exception handler in `process_document`, keeping the existing `_publish_status_update` call mechanism and `status="failed"`:

```python
# illustrative — exact shapes follow the current _publish_status_update signature
message = str(e) or type(e).__name__
details = {
    "error_message": message,              # FR-2
    "error": message,                      # FR-7 legacy hedge, identical value
    "stage": current_stage,                # FR-3
    "retryable": _is_transient(classify_error(e)),  # FR-4, see §4.3
}
```

`_is_transient` maps the classification result to a boolean per the rules in §4.3 (adapt to `classify_error`'s actual return shape — TransientError/PermanentError classes or equivalent — as found in the current code).

### 4.3 Retryable derivation

- Source of truth: `classify_error(e)` — the same classification that already drives ACK/NACK decisions in `run_worker` (F7). Transient-classified → `retryable: true` (Pub/Sub will redeliver); permanent-classified → `retryable: false` (acked; manual reprocess via `POST /process` remains).
- Unclassified-unknown exceptions classify as permanent by `classify_error`'s conservative default, so they now persist `retryable: false` (previously the silent `true` fallback). This is deliberate: it aligns the persisted record with the worker's actual no-auto-retry behavior and prevents infinite retry loops (F8).
- The stale-lease sweep's separate direct write keeps `retryable: true` — a dead worker is a transient condition by nature. Unchanged (NFR-4).
- **Verified nuance (do not silently deviate):** `apps/ai-server/rag-worker-service/exceptions.py` defines `PDFProcessingError` carrying a `retryable` *metadata* attribute, and its module docstring references a separate central retry-decision mechanism (`RetryHandler` classification). This design keeps `classify_error(e)` as the single derivation source for the payload flag per the adopted default (F8). Whether `classify_error` internally consults exception-carried metadata is an implementation detail of the current code; the contract pins only the observable mapping (transient → `true`, permanent/unknown → `false`). Unifying the classification mechanisms is out of scope.

### 4.4 rag-api: zero production changes

rag-api's failed branch already implements the consumer side: it reads `error_message`/`stage`/`retryable`, persists `error`/`error_stage`/`retryable` on the main document, and writes message/stage (with `error_code` defaulting to `"UNKNOWN"`) into the `processing`/`summary` subdocument (F4). With the worker sending all keys, the `details.get(...)` fallbacks become dead paths for worker-originated failures — they remain in code for any other publisher (unchanged behavior, out of scope). No reader, schema, or model changes.

## 5. Contract test architecture

**Placement.** New module in `apps/ai-server/tests/integration/` (e.g. `test_worker_failure_contract.py`), sharing the existing `conftest.py` (verified: it mocks `firebase_admin`, `google.cloud.*`, `structlog`, and puts `rag-api-service` on `sys.path`). Extending the existing `test_api_contracts.py` instead is acceptable; a dedicated module is preferred for focus. The existing suite's fixture- and AST-based static contract-test patterns (F10, verified: `tests/fixtures/api-contracts/` exists) are the house pattern to follow.

**Design principle.** Import both sides; never restate the contract in a fixture. The payload is built by the worker's real code path and consumed by rag-api's real failed branch.

### 5.1 Layer 1 — behavioral seam test (primary)

1. **Producer side.** Import the worker module with the stub set documented in `apps/ai-server/rag-worker-service/tests/conftest.py` (verified pattern: stubs for `google.cloud.pubsub_v1`, `firebase_admin`, `openai`, `langchain`, `langfuse`, `spacy`, `tiktoken`, `tenacity`, `google.cloud.*`). Drive `process_document` to failure by monkeypatching one pipeline step to raise; replace the worker's publish path with a capture stub. Assert on the captured failure details: exact key set `{error_message, error, stage, retryable}` (plus whatever non-details envelope the publish helper adds), `error_message ==` raised message, `error == error_message`, `stage ==` expected boundary value, `retryable ==` expected classification.
2. **Consumer side.** Feed the captured details through rag-api's `run_transactional_update` failed branch (imported from `rag-api-service/main.py`) against the Firestore emulator when `FIRESTORE_EMULATOR_HOST` is set (both services have emulator branches, F10), otherwise against the suite's existing fakes — asserting the fields written by the transactional update. Assert: main document `error ==` worker message (≠ `"Processing failed"`), `error_stage ==` worker stage (not `None`), `retryable ==` worker-derived boolean; `processing`/`summary` error subdocument message and stage equal the worker's values; `error_code == "UNKNOWN"` (worker sends none).

**Import-friction contingency.** The two conftest stub sets differ (api-side `MagicMock` mocks vs worker-side targeted stubs). If unifying them in one process proves brittle, the documented fallback is to extract the worker's failure-payload construction into a small pure function in the worker module, called by the exception handler and imported by the test — still real worker code, still no fixture restatement.

### 5.2 Layer 2 — key-set drift guard (static)

Following the existing AST-based pattern: AST-scan `rag-worker-service/main.py`'s failure-payload construction for the exact contracted key set, and AST-scan `rag-api-service/main.py`'s failed branch for reads of `error_message`/`stage`/`retryable` and writes of `error`/`error_stage`/`retryable`. Adding, removing, or renaming a key on either side fails the build instead of silently re-creating this bug. This ossification is intentional — it is the drift guard doing its job.

### 5.3 Scenarios

| Scenario | Intervention | Expected `stage` | Expected `retryable` |
|---|---|---|---|
| Early-stage failure | raise during text retrieval | `"starting"` | per raised error's classification |
| Late-stage failure | raise during embedding generation | `"chunking_complete"` | per raised error's classification |
| Transient error | raise a transient-classified error | — | `true` |
| Permanent error | raise a permanent-classified error | — | `false` |
| Unclassified-unknown | raise generic `Exception` | — | `false` (pins the deliberate behavior change) |
| Key drift | n/a (static guard) | — | build fails |

Two representative stage boundaries (early + late) are enough to catch the tracker being removed or bypassed without ossifying every step.

### 5.4 Supporting unit tests (secondary)

In `apps/ai-server/rag-worker-service/tests/unit/` (or the existing unit layout): stage-boundary mapping table, retryable classification→boolean mapping, empty-message class-name fallback. Cheap, fast, and they localize failures the seam test can only report.

## 6. Compatibility and rollout

- **Unknown consumers of the status topic:** only rag-api's status subscriber is a verified consumer; other tooling may share the topic. The legacy `error` key is retained with an identical value as a hedge (F11, FR-7). Dropping it later is trivial cleanup after an audit.
- **No migration window concerns:** persisted field names and semantics are unchanged; old worker payloads keep hitting the API fallbacks until the worker redeploys — a transient window with no corruption. Deploy order is irrelevant (the API side does not change).
- **Behavior change to communicate:** unclassified-unknown failures now persist `retryable: false` (was effective `true`). Manual reprocess via `POST /process` is unaffected.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown status-topic consumers read the old key set | Legacy `error` key retained; residual risk accepted as low |
| Stage-tracker drift as the pipeline evolves | Interval semantics degrade gracefully (enclosing milestone); "update at every step boundary" convention; early/late representative contract scenarios |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted per F8; widening `classify_error` is out of scope; manual reprocess remains |
| Contract test ossifies the payload | Intentional drift guard; adding a key means touching the test, which is the point |
| Cross-service import friction in the shared test process | Documented contingency: extract a pure payload-builder function in the worker module (§5.1) |

## 8. Out of scope / deferred

As listed in `docs/requirements.md` §2.2 and §9: retry/backoff mechanics, the sweep's behavior, error-code taxonomy, frontend work, the companion D3 issue's unavailable scope, `plans/upload-flow.md` D4 reconciliation (file verified absent), and legacy-key removal pending a consumer audit.

## 9. Evidence base and unknowns

- **Verified during investigation:** repo/service directory layouts; `rag-worker-service/exceptions.py` (exception taxonomy and retryable-metadata docstring); both test conftests (`tests/integration/conftest.py`, `rag-worker-service/tests/conftest.py`) and their stub/mock patterns; existence of `tests/integration/test_api_contracts.py` and `tests/fixtures/api-contracts/`; absence of `plans/upload-flow.md` from the `plans/` listing; pipeline phase order (retrieval → tagging → summary → chunking → embeddings → storage) per `apps/ai-server/docs/architecture/system-overview.md`.
- **Binding from the Definition (treated as exact):** facts F1–F12, including the producer/consumer key sets (F3, F4), current failure persistence behavior (F5), established schema (F6), `classify_error` semantics (F7), adopted retryable derivation (F8), progress-stage vocabulary and absence of stage tracking (F9), and test infrastructure (F10).
- **Unknowns left to implementation:** line-level insertion points inside the two `main.py` files (identified by the Definition's evidence refs: `process_document` exception handler; `run_transactional_update` failed branch) and `classify_error`'s concrete return shape — the implementer works from current file contents; the contract test pins observable behavior, not internal shapes.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>