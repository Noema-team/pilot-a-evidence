I've inspected both services, the existing contract-test infrastructure, the `Resource` model, and the docs tree. The design below is grounded in the actual code: the worker's `process_document` exception handler, `_publish_status_update`, `classify_error`, the stale-lease sweep, rag-api's `run_transactional_update` failed branch, and the fixture/AST contract-test patterns in `tests/integration/test_api_contracts.py`.

Key design decisions (all traceable to the authoritative Definition):
- **Worker aligns to rag-api** — rag-api's failed branch and persisted schema (`error`/`error_stage`/`retryable`) are unchanged; only the worker's failure payload changes, plus a pinning contract test.
- **Stage tracker** — a local in `process_document`, set immediately before each awaited pipeline step using the existing progress-stage vocabulary; `"processing"` as the safe default; the vector-storage leg inherits `"embeddings_complete"` since the vocabulary has no storage-phase name and `"completed"` is reserved for success.
- **`retryable` derived from `classify_error(e)`** — one source of truth shared with the worker's ACK/NACK posture; the deliberate behavior change (unclassified-unknown now persists `false`) is called out explicitly.
- **Single construction point** — a worker-internal `build_failure_payload(e, stage)` helper so the contract test exercises the real seam and the AST drift guard has a stable target; the legacy `error` key is retained as the compatibility hedge.
- **Contract test imports both sides** — loaded under distinct module names (both services have `main.py`), driven through the real publish path and rag-api's `run_transactional_update` against a functional in-memory Firestore fake (emulator optional), with AST key-set drift guards on both files.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api Failure Payload Contract Alignment

**Status:** Approved for implementation
**Binding source:** define-work WorkItem `wi-define-108-a8`, artifact `definition:obj-108`
(sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`)
**Scope:** `apps/ai-server/rag-worker-service`, `apps/ai-server/tests/integration` (rag-api-service read-only)

The key words MUST, MUST NOT, SHOULD, MAY are to be interpreted as described in RFC 2119.

---

## 1. Problem statement

The rag-worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test guards the seam.

- The worker's `process_document` exception handler (`apps/ai-server/rag-worker-service/main.py`) publishes a failed status with a **one-key** payload: `{"error": str(e)}`.
- rag-api's failed branch (`run_transactional_update` in `apps/ai-server/rag-api-service/main.py`) reads **three** keys — `error_message`, `stage`, `retryable` — and persists them as `error`, `error_stage`, and `retryable` on the main resource document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument.

Because of the key mismatch, every worker-originated failure currently persists:
- `error` = the fallback string `"Processing failed"` (the worker's actual message is discarded),
- `error_stage` = `None` (no stage tracking exists in the failure handler),
- `retryable` = `True` (rag-api's silent default, not a worker decision).

Users and support cannot disambiguate failures, and the persisted retryability is fabricated rather than derived. The stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths (`POST /process`, `POST /resources`), and the `Resource` model (`apps/ai-server/rag-api-service/models/resource.py`) all already use the `error`/`error_stage`/`retryable` schema — the worker's status publisher is the only writer that does not speak it.

## 2. Goals

1. A failed RAG processing job persists the worker's **actual error message**, the **failing pipeline stage**, and a **deliberately derived** `retryable` flag.
2. The worker is aligned to rag-api's **existing** contract (`error_message`/`stage`/`retryable` payload keys → `error`/`error_stage`/`retryable` persisted fields). rag-api's reads and persisted schema are unchanged.
3. The worker→rag-api failure path is locked in by a contract test that fails the build if either side's payload keys drift.

## 3. Non-goals

- Changing the stale-lease sweep's direct failure write (it already persists `error`/`error_stage`/`retryable` consistently with this contract).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any Firestore migration, field rename, or backfill of existing documents.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred, per fact F12). Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` is likewise deferred (that file is not present in the current tree).

## 4. Functional requirements

### FR-1 — Worker failure payload keys (MUST)
When document processing fails, the worker's failed status payload `details` MUST include:
- `error_message`: the actual exception message (`str(e)`),
- `stage`: the pipeline stage executing at failure time (see FR-2),
- `retryable`: a boolean deliberately derived per FR-3.

The payload MUST never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for these keys. **Verification:** contract test (FR-7), unit test (FR-6).

### FR-2 — Stage tracking in `process_document` (MUST)
The worker MUST track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.
- Stage names MUST reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown (failure before the tracker's first assignment); it matches the stale-lease sweep's `error_stage` value, so `error_stage` never regresses to `null` for worker failures.
- Convention: the tracker is set **immediately before** each awaited pipeline step (update-before-await). Adding a pipeline step without updating the tracker reports a stale (last-known) stage rather than `null`.
- `"completed"` is never a failure stage: it is reserved for successful termination and is not part of the permitted failure vocabulary.
**Verification:** contract test pins an early-stage failure and a late-stage failure; code inspection for the update-before-await convention.

### FR-3 — Explicit `retryable` derivation (MUST)
The worker MUST derive `retryable` from `classify_error(e)` — the same classifier that drives the worker's ACK/NACK posture in `run_worker`:
- errors classified **transient** by `classify_error` → `retryable: true`;
- errors classified **permanent** — including unclassified-unknown exceptions, per `classify_error`'s conservative default — → `retryable: false`.

`retryable` MUST be sent explicitly on every worker-originated failure payload; rag-api's `details.get("retryable", True)` fallback MUST NOT be the operative mechanism for worker failures.
**Known deliberate behavior change:** unclassified-unknown exceptions previously persisted `retryable: true` (the silent default) and now persist `false`. This is accepted (Definition fact F8): it aligns the persisted record with the worker's actual retry posture, prevents unbounded retry loops, and manual reprocess via `POST /process` remains available.
**Verification:** unit test over the derivation mapping; contract test asserts the persisted value equals the derived value.

### FR-4 — rag-api failed-branch passthrough preserved (MUST, no code change)
rag-api's failed branch MUST persist the worker-provided values unchanged:
- main document: `error` ← payload `error_message`; `error_stage` ← payload `stage`; `retryable` ← payload `retryable`;
- `processing/summary` subdocument: `error.message` ← payload `error_message`; `error.stage` ← payload `stage`; `error.code` ← `"UNKNOWN"` (no `error_code` is sent); subdocument `stage` ← payload `stage`.

This is existing rag-api behavior that MUST be preserved and pinned — rag-api's reads and persisted schema MUST NOT change.
**Verification:** contract test asserts persisted values equal worker values.

### FR-5 — Legacy `error` key retention (SHOULD)
The worker's failure payload MUST retain the legacy `error` key alongside `error_message`, with the same string value, for continuity with any unknown consumers of the status topic and with log tooling (Definition facts F5/F11). Dropping it later is trivial cleanup after a consumer audit (out of scope here).
**Verification:** contract test asserts `payload["error"] == payload["error_message"]`.

### FR-6 — Single payload construction point (SHOULD)
The failure payload MUST be built at a single, named, worker-internal construction point (a module-level helper, e.g. `build_failure_payload(exception, stage) -> dict`) called from the `process_document` exception handler. The handler MUST NOT inline a second, divergent dict literal. The helper is worker-internal and introduces no external contract change.
**Verification:** unit test on the helper's shape and FR-3 mapping; AST drift guard targets the helper.

### FR-7 — Contract test on the worker→rag-api failure path (MUST)
A contract test MUST cover the worker failure → rag-api persistence path. It MUST:
1. exercise the worker's **failure-payload construction through the real worker code path** (not a restated fixture),
2. feed the produced payload through rag-api's `run_transactional_update` failed branch against the Firestore emulator **or fakes**,
3. assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values,
4. fail if either side's payload keys drift (key-set drift guard on both `main.py` files).

The test MUST import both sides rather than restate the contract in a fixture, following the existing pattern in `apps/ai-server/tests/integration/test_api_contracts.py`. It MUST run hermetically (fakes by default; no emulator required for CI).
**Verification:** the test itself; CI green.

### FR-8 — Failure log continuity (SHOULD)
The worker's `document_processing_failed` log event SHOULD gain `stage` and `retryable` fields (retaining `error`) so log tooling sees the same facts the payload carries.
**Verification:** code inspection; optional unit assertion on the log call.

## 5. Data contract (normative summary)

**Worker → Pub/Sub (`rag-status-updates`), `status: "failed"`, `details`:**

| Key | Type | Source | Required |
|---|---|---|---|
| `error_message` | string | `str(exception)` | yes |
| `stage` | string | stage tracker (FR-2) | yes |
| `retryable` | bool | `classify_error(exception)` (FR-3) | yes |
| `error` | string | legacy alias of `error_message` (FR-5) | yes (retained) |
| `jobId` | string | injected by `_publish_status_update` (existing) | when job_id present |

**rag-api persistence (failed branch, unchanged code):**

| Firestore target | Field | Reads | Value with new payload |
|---|---|---|---|
| main doc | `error` | `details["error_message"]` (fallback `"Processing failed"`) | worker's actual message |
| main doc | `error_stage` | `details["stage"]` (no fallback) | failing stage |
| main doc | `retryable` | `details["retryable"]` (fallback `True`) | derived bool |
| `processing/summary` | `stage` | `details["stage"]` (fallback `"unknown"`) | failing stage |
| `processing/summary` | `error.code` | `details["error_code"]` (fallback `"UNKNOWN"`) | `"UNKNOWN"` |
| `processing/summary` | `error.message` | `details["error_message"]` (fallback) | worker's actual message |
| `processing/summary` | `error.stage` | `details["stage"]` | failing stage |

## 6. Constraints

| Type | Constraint |
|---|---|
| MUST | The worker is aligned to rag-api's existing contract (`error_message`/`stage`/`retryable`) rather than changing rag-api's reads or persisted schema. |
| MUST NOT | Require a Firestore migration, field rename, or backfill; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. |
| MUST | Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback is not the operative mechanism for worker failures. |
| SHOULD (prefer) | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| SHOULD NOT (prefer_not) | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## 7. Non-functional requirements

- NFR-1: No new runtime dependencies, services, or infrastructure; the change is worker-side code plus tests.
- NFR-2: The contract test runs in the existing cross-service/contract CI job with no new emulator requirement (fakes by default).
- NFR-3: No measurable latency or payload-size impact beyond one redundant string (`error`) and two scalars (`stage`, `retryable`) per failure message.
- NFR-4: Progress (`processing`/`completed`) status payloads are unchanged; only the failure payload changes.

## 8. Acceptance criteria

| # | Criterion (from the Definition) | Verified by |
|---|---|---|
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | Contract test T1/T2 payload assertions; unit tests on `build_failure_payload` |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | Contract test T3 (fake-Firestore persistence assertions) |
| AC-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | Contract test T3 (subdocument assertions) |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | Contract test T1–T4 incl. AST drift guards; CI |

## 9. Assumptions

- A-1 (adopted, Definition F8): `retryable` is derived from `classify_error(e)` — transient → `true`; permanent/unclassified-unknown → `false`. The stale-lease sweep's separate `retryable: true` write stays correct (a dead worker is a transient condition).
- A-2 (Definition F11): no consumer other than rag-api's status subscriber is known to parse the worker's failure payload keys; the legacy `error` key is retained as a hedge. Residual risk accepted as low.
- A-3 (Definition F12): the companion D3 issue's scope is unavailable here; anything beyond this payload alignment is deferred.

## 10. Dependencies

- `classify_error()` and the `TransientError`/`PermanentError` hierarchy in `apps/ai-server/rag-worker-service/main.py` (used, not modified).
- rag-api's `run_transactional_update` failed branch and `_process_status_message` (pinned, not modified).
- Existing test infrastructure: `apps/ai-server/tests/integration/conftest.py`, `test_api_contracts.py` patterns, `apps/ai-server/rag-worker-service/tests/conftest.py` dependency stubs.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic reading the old key set | Legacy `error` key retained (FR-5); residual risk accepted as low (A-2). |
| Stage-tracker drift as the pipeline evolves | Update-before-await convention (FR-2); contract test pins representative early and late stages. |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted (A-1); widening `classify_error` is out of scope; manual reprocess via `POST /process` remains. |
| Contract test ossifies the payload | Intentional — the drift guard is the point; adding a key later means touching the test. |

## 12. Traceability

| Definition fact | Addressed by |
|---|---|
| F1 (product intent) | FR-1–FR-3, AC-1/AC-2 |
| F2 (preferred direction: align worker) | §2 Goal 2, Constraint MUST #1 |
| F3 (worker publishes `{"error": str(e)}`) | §1, FR-1 |
| F4 (rag-api failed branch reads/persists) | FR-4, §5 |
| F5 (current fallback persistence) | §1, AC-2 |
| F6 (established persisted schema) | §5, Constraint MUST NOT #1 |
| F7 (classify_error semantics) | FR-3 |
| F8 (adopted retryable default) | A-1, FR-3 |
| F9 (no stage tracking today; vocabulary) | FR-2 |
| F10 (contract-test infrastructure exists) | FR-7 |
| F11 (legacy `error` hedge) | FR-5, A-2 |
| F12 (companion D3 deferred) | §3 Non-goals, A-3 |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api Failure Payload Contract Alignment

**Status:** Approved for implementation
**Binding source:** define-work WorkItem `wi-define-108-a8`, artifact `definition:obj-108`
(sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`)
**Companion document:** `docs/requirements.md` (FR-/AC- references below resolve there)

---

## 1. Context: the broken seam

### 1.1 Failure path today

```
rag-worker                          Pub/Sub                        rag-api
-----------                         -------                        -------
process_document
  └─ except Exception as e:
       _publish_status_update(       rag-status-updates      _process_status_message
         status="failed",      ──►   topic, JSON      ──►      └─ run_transactional_update
         details={"error":str(e)})   envelope                failed branch reads:
                                                             details["error_message"]  → main.error
                                                             details["stage"]          → main.error_stage
                                                             details["retryable"]      → main.retryable
                                                             summary.error{code,message,stage}
```

The worker publishes one key (`error`); rag-api reads three (`error_message`, `stage`, `retryable`). Every miss falls through to rag-api's fallbacks: `error = "Processing failed"`, `error_stage = None`, `retryable = True` — and the `processing/summary` error subdocument inherits the same fallbacks with `error_code = "UNKNOWN"`.

### 1.2 Why the worker is the side that changes

The persisted field names (`error`, `error_stage`, `retryable`) are already consistent across three other write paths and two response models:

| Writer / reader | Location | Fields |
|---|---|---|
| Stale-lease sweep `_fail_if_still_stale` | `rag-worker-service/main.py` | writes `error`, `error_stage: "processing"`, `retryable: True` |
| Enqueue-failure rollback `POST /process` | `rag-api-service/main.py` | writes `error`, `error_stage: "enqueue"` |
| Enqueue-failure `POST /resources` | `rag-api-service/main.py` → `ResourceService.update_status` | writes `error`, `error_stage: "enqueue"` |
| `Resource` dataclass / `ResourceResponse` | `rag-api-service/models/resource.py`, `rag-api-service/main.py` | expose `error`, `error_stage` (`retryable` defaults `True`) |

Changing the API side would be the change that ripples; the worker is the odd one out. Fix the odd one out. No migration, no backfill, no reader changes.

## 2. Design decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Worker aligns to rag-api's payload keys (`error_message`/`stage`/`retryable`); rag-api unchanged | Avoids schema migration and reader changes (FR-4, constraint MUST #1) |
| D2 | `retryable` derived from `classify_error(e)` at the failure-reporting site | One source of truth shared with the worker's ACK/NACK posture; no silent defaults (FR-3, A-1) |
| D3 | Stage tracker: local in `process_document`, set immediately before each awaited step, vocabulary reused from progress publishes | Failure stage reads naturally next to the progress timeline clients already see (FR-2) |
| D4 | Single construction point `build_failure_payload(e, stage)`; legacy `error` key retained | Testable seam for the contract test; compatibility hedge for unknown topic consumers (FR-5, FR-6) |
| D5 | Contract test imports both sides and drives the real publish → persistence path; AST key-set drift guards on both `main.py` files | Locks the seam; a future key edit on either side fails the build (FR-7, AC-4) |

## 3. Target architecture

### 3.1 Component changes

| Component | Change |
|---|---|
| `rag-worker-service/main.py` — `process_document` | Add stage tracker; exception handler builds the failure payload via `build_failure_payload` and publishes it; failure log gains `stage`/`retryable` |
| `rag-worker-service/main.py` — new module-level helper | `build_failure_payload(exception, stage) -> dict` (the only place the failure payload shape is defined) |
| `rag-api-service/main.py` | **No change.** Failed branch, subscriber, and persisted schema are pinned as-is by the contract test |
| `tests/integration/conftest.py` | Extended with the worker dependency stubs (recipe from `rag-worker-service/tests/conftest.py`) so both services import in one process |
| `tests/integration/test_worker_failure_payload_contract.py` | New contract test (§5) |

### 3.2 Failure payload (worker → Pub/Sub)

`build_failure_payload(e, stage)` returns:

```python
{
    "error_message": str(e),        # actual exception message
    "stage": stage,                 # stage tracker value (never None)
    "retryable": classify_error(e), # deliberate derivation, always a bool
    "error": str(e),                # legacy key retained (same value) — FR-5
}
```

Published through the existing `_publish_status_update(status="failed", details=...)`, so the envelope is unchanged (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`; `jobId` injected when present; sequence reset on the terminal `failed` state; lease-heartbeat write unchanged). Example wire payload:

```json
{
  "user_id": "u-123",
  "course_id": "__ungrouped__",
  "resource_id": "r-abc",
  "status": "failed",
  "details": {
    "error_message": "PDF extraction resulted in empty text",
    "stage": "text_retrieved",
    "retryable": false,
    "error": "PDF extraction resulted in empty text",
    "jobId": "job-42"
  },
  "timestamp": 1730000000.0,
  "sequence": 4
}
```

Progress (`processing`) and success (`completed`) payloads are untouched.

### 3.3 Stage tracker

A local variable in `process_document`, initialized to `"processing"` (the safe value; identical to the stale-lease sweep's `error_stage`, so `error_stage` never regresses to `null`). Set immediately before each awaited pipeline step, using that step's completion-vocabulary name — i.e., the tracker names the leg **in progress**, labeled by the milestone its completion publish announces:

| # | Pipeline step (awaited) | Tracker set before step | Failure there reports |
|---|---|---|---|
| 0 | function entry (before `try`) | — (default) | `processing` |
| 1 | `_validate_processing_request` | `starting` | `starting` |
| 2 | `_get_extracted_text` | `text_retrieved` | `text_retrieved` |
| 3 | `content_tagger.generate_tags` | `tagging_complete` | `tagging_complete` |
| 4 | `generate_document_summary` + `ragDescription` write | `summary_generated` | `summary_generated` |
| 5 | `_create_enhanced_chunks` | `chunking_complete` | `chunking_complete` |
| 6 | `_generate_embeddings_with_openrouter` | `embeddings_complete` | `embeddings_complete` |
| 7 | `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection` | (no new assignment) | `embeddings_complete` (inherited) |

Boundary semantics (documented choices):
- **Step 1 (`starting`):** validation is the pipeline's first step and `starting` is the vocabulary's first name; a validation failure (e.g. document not found, ownership mismatch) reports `starting`.
- **Step 7 (storage leg):** the vocabulary has no storage-phase name and `completed` is reserved for successful termination (and is not in the permitted failure vocabulary), so the storage leg inherits `embeddings_complete` — the last named leg. This is the known stale-stage case the update-before-await convention accepts; a future storage-phase stage name would be added to the tracker and the vocabulary together.
- **Default (`processing`):** operative only if a failure precedes the tracker's first assignment (e.g. future code inserted ahead of validation); guarantees `error_stage` is always a non-null string for worker failures.

Drift risk and mitigation: a pipeline step added without a tracker assignment reports the last-known stage rather than `null`; the contract test pins the mechanism on representative stages (early and late), which catches the tracker being removed or bypassed without ossifying every step.

### 3.4 `retryable` derivation

`retryable = classify_error(e)` — the same classifier `run_worker` uses for ACK/NACK decisions, so the persisted flag and the worker's retry posture share one source of truth. No ACK/NACK, lease, or heartbeat mechanics change (non-goal).

| Exception at failure time | `classify_error` | Persisted `retryable` |
|---|---|---|
| `TransientError` subclass | `True` | `true` |
| `httpx.ConnectError` / `ConnectTimeout` / `ReadTimeout` / `WriteTimeout` / `PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | `True` | `true` |
| `httpx.HTTPStatusError` with status 429 / 500 / 502 / 503 / 504 | `True` | `true` |
| `PermanentError` subclass | `False` | `false` |
| `httpx.HTTPStatusError` other 4xx | `False` | `false` |
| `ValueError` (e.g. document not found / no content), `PermissionError` (ownership) | `False` | `false` |
| Any other exception (unclassified-unknown) | `False` (conservative default) | `false` |

**Deliberate behavior change:** unclassified-unknown exceptions previously persisted `retryable: true` via rag-api's silent default; they now persist `false`, matching `classify_error`'s conservatism. Manual reprocess via `POST /process` is unaffected. The stale-lease sweep's direct write keeps `retryable: true` — a dead worker is a transient condition by nature — and is explicitly out of scope.

### 3.5 Persisted Firestore shape (unchanged)

rag-api's failed branch persists, unchanged (pinned by the contract test):

| Target | Field | Value with the new payload |
|---|---|---|
| main doc | `status` | `"failed"` (+ `status_updated_at`, `updated_at`, `schema_version: 2`) |
| main doc | `error` | worker's actual message (fallback `"Processing failed"` no longer operative) |
| main doc | `error_stage` | failing stage (no longer `None`) |
| main doc | `retryable` | derived bool (silent `True` default no longer operative) |
| `processing/summary` | `stage` | failing stage |
| `processing/summary` | `error` | `{code: "UNKNOWN", message: <actual>, stage: <failing stage>}` |

Transition legality is unchanged: the worker publishes `failed` while the claimed doc is `processing` (`processing → failed` is an allowed transition); a duplicate `failed` (e.g. after the sweep) short-circuits on `new_status == current_status` as today.

## 4. Exception-handler flow (worker, after the change)

```
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    stage = current_stage                      # tracker local
    logger.error("document_processing_failed", ..., error=str(e), stage=stage,
                 retryable=classify_error(e))
    details = build_failure_payload(e, stage)  # single construction point (FR-6)
    await self._publish_status_update(..., "failed", details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

`run_worker`, `_publish_status_update`, the sweep, and heartbeat logic are untouched.

## 5. Contract test architecture

**File:** `apps/ai-server/tests/integration/test_worker_failure_payload_contract.py` (sibling of `test_api_contracts.py`; runs in the existing cross-service/contract CI job).

### 5.1 Harness

- **Both sides imported, contract not restated** (Definition test strategy). rag-api's `main` is imported by the existing `tests/integration/conftest.py`. The worker's `main.py` is loaded via `importlib.util.spec_from_file_location` under a distinct module name (e.g. `rag_worker_main`) — both services have a `main.py`, so a plain `import main` would collide. The worker's heavy-dependency stub set (the recipe in `rag-worker-service/tests/conftest.py`: langchain, openai, langfuse, firebase_admin, google.cloud.*, spacy, tiktoken, tenacity, …) is installed first, factored into a shared helper so the two conftests cannot drift.
- **Worker harness:** an `EnhancedDocumentProcessor` built via `__new__` (skipping `_init_services`) with injected config, `langfuse=None`, fake db, and a recording Pub/Sub publisher. The **real** `_publish_status_update` is used (fake publisher returns resolved `concurrent.futures.Future`s; fake db lease lookups miss), so the true publish path — including `jobId` injection and the failure envelope — is exercised.
- **Fake Firestore surface** for `run_transactional_update` (hermetic default; the Firestore emulator remains an optional env-gated alternative since both services already have `FIRESTORE_EMULATOR_HOST` branches):
  - functional `transactional` decorator (identity — invokes the wrapped function with the transaction) and a `SERVER_TIMESTAMP` sentinel, patched onto the `firebase_admin.firestore` module object rag-api's `main` bound at import (MagicMock mocks are insufficient: a Mock decorator would replace the transaction body);
  - a `FakeTransaction` recorder capturing `update(doc_ref, data)` and `set(ref, data, merge=True)` calls;
  - a fake document ref/snapshot seeded with `status: "processing"` (so `processing → failed` is allowed), `userId`, `filename`.

### 5.2 Cases

| ID | Case | Asserts |
|---|---|---|
| T1 | Early-stage failure: `_get_extracted_text` raises `httpx.ConnectTimeout("storage unreachable")` | Captured `failed` details: `error_message` exact, `stage == "text_retrieved"`, `retryable is True`, `error == error_message` |
| T2 | Late-stage failure: pipeline stubbed through chunking; `_generate_embeddings_with_openrouter` raises `ValueError("embedding request rejected")` | `stage == "embeddings_complete"`, `retryable is False` |
| T3 | Persistence: each captured payload fed through rag-api `run_transactional_update` on the fake Firestore | Main doc `error`/`error_stage`/`retryable` == payload `error_message`/`stage`/`retryable` (never `"Processing failed"`/`None`/silent-default); summary `error.message`/`error.stage` match main doc; `error.code == "UNKNOWN"`; summary `stage` == payload `stage` |
| T4 | Key-set drift guards (AST, in-process, pattern of `test_api_contracts.py`) | Worker failure-payload keys ⊇ `{error_message, stage, retryable, error}`; rag-api failed-branch `details` read keys ⊆ worker payload keys and ⊇ `{error_message, stage, retryable}`; failure message names the drifted side |
| T5 | Worker unit (service-local, e.g. `rag-worker-service/tests/unit/test_failure_payload.py`) | `build_failure_payload` shape; FR-3 derivation table (transient types → `True`; `PermanentError`/`ValueError`/unknown → `False`); stage-tracker early/late values |

### 5.3 CI placement

Joins the existing cross-service/contract job (5-job pipeline: unit → integration → node → cross-service/contract → deploy-trigger). No new infrastructure; fakes by default keep the job hermetic.

## 6. Compatibility & rollout

- **Deploy order:** worker-only change; rag-api already reads the new keys. Deploying the worker alone is sufficient; no coordinated rollout. Rollback is safe (behavior reverts to fallback persistence — degraded but harmless, no schema impact).
- **No migration/backfill:** existing failed documents keep their persisted values; only new failures carry real data.
- **Unknown consumers:** only rag-api's status subscriber is a verified consumer; the legacy `error` key is retained (one redundant string per failure message) as insurance. If a later audit confirms worker-publisher/rag-api-consumer exclusivity, dropping the duplicate is trivial cleanup.
- **Log tooling:** the failure log event gains `stage`/`retryable` alongside `error`, so logs and payloads agree.

## 7. Risks & tradeoffs

- **Unknown status-topic consumers on the old key set** — mitigated by retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage; drift yields a stale (non-null) stage, never `null`.
- **`retryable=false` for unrecognized-but-transient failures** — accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## 8. Out of scope

Structured error codes (`summary.error.code` stays `"UNKNOWN"` unless a code is actually sent); retry/backoff mechanics (ACK/NACK policy, leases, heartbeats — only the *reporting* of retryability changes); the stale-lease sweep's behavior; frontend/mobile work (`ResourceResponse` already exposes `error`/`error_stage`); the companion D3 issue's scope beyond this alignment; reconciling with the absent `plans/upload-flow.md` D4 deviation note.

## 9. Future work (not in this cycle)

- Audit status-topic consumers; if the worker is the only publisher and rag-api the only subscriber, drop the legacy `error` key.
- Introduce a storage-phase stage name (and tracker assignment) if support needs the vector-storage leg distinguished from `embeddings_complete`.
- Structured error-code taxonomy, if a consumer need emerges.
- Optional env-gated Firestore-emulator mode for the contract test if fakes ever lag real transaction semantics.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>