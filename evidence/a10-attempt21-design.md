I've verified the seam directly against both services: the worker's `process_document` exception handler publishes `{"error": str(e)}`, while rag-api's `run_transactional_update` failed branch reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` (plus the `processing/summary` error subdocument with `error_code` defaulting to `"UNKNOWN"`). I also confirmed the supporting pieces the design relies on: `classify_error()` (unknown → permanent/False), the progress-stage vocabulary, the stale-lease sweep's direct `error`/`error_stage`/`retryable` write, the fake-Firestore test pattern in `rag-worker-service/tests/unit/test_processing_lease.py`, the contract-test house pattern in `tests/integration/test_api_contracts.py`, and both services' emulator branches. Below are the requirements and the architecture that implement the authoritative definition exactly — worker aligns to the API, no schema change, explicit retryable derivation, stage tracking, and a two-sided drift-guarded contract test.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- **Cycle intent:** rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage.
- **Authoritative source:** WorkItem `wi-define-108-a8`, Definition artifact `definition:obj-108`
  (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document
  operationalizes that definition; it does not widen, narrow, or reinterpret it.
- **Status:** design (iteration 1, step: design).

---

## 1. Problem statement

A failed RAG processing job must persist the worker's actual error message, the failing pipeline
stage, and a deliberately derived retryable flag. Today the worker's exception handler in
`process_document` publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch
(`run_transactional_update`) reads three keys (`error_message`, `stage`, `retryable`). Every
worker-originated failure therefore lands in Firestore as the fallback string `"Processing failed"`,
a null `error_stage`, and a fabricated `retryable: true`; the `processing/summary` error subdocument
inherits the same fallbacks with `error_code` always `"UNKNOWN"`. No test pins the seam, so the
mismatch is invisible to CI.

## 2. Scope

**In scope**
- The worker's failure status payload construction (keys, values, stage, retryable).
- Stage tracking inside `process_document` so the failure handler reports the true failing stage.
- A small, dependency-free worker module that names the payload contract and builds the payload.
- Worker unit tests (payload shape, retryable derivation, handler wiring).
- A cross-service contract test covering worker failure-payload construction → rag-api failed-branch
  persistence, with drift guards on both sides.

**Out of scope** — see §7 (Non-goals). Nothing outside the worker→rag-api failure payload alignment.

## 3. Contract vocabulary

### 3.1 Worker failure payload (the `details` dict of the `"failed"` status message)

| Key | Type | Source | Status |
|---|---|---|---|
| `error_message` | `str` (non-empty) | actual exception message; `str(e)`, or `type(e).__name__` when empty | **new, required** |
| `stage` | `str` | stage-tracker value at failure time; one of the stage vocabulary (§3.3) | **new, required** |
| `retryable` | `bool` | `classify_error(e)` (transient → `true`, permanent/unknown → `false`) | **new, required** |
| `error` | `str` | same string as `error_message` | legacy, retained (compatibility hedge) |
| `jobId` | `str` | injected by `_publish_status_update` when a `job_id` is present | existing, unchanged |

### 3.2 rag-api failed-branch persistence (reads unchanged)

| Payload key | → main document field | → `processing/summary` |
|---|---|---|
| `error_message` | `error` | `error.message` |
| `stage` | `error_stage` | `error.stage`, and `summary.stage` |
| `retryable` | `retryable` | — |
| *(not sent)* `error_code` | — | `error.code` = `"UNKNOWN"` (default preserved) |

Persisted field names and semantics (`error`, `error_stage`, `retryable`) are unchanged. No
migration, rename, or backfill.

### 3.3 Stage vocabulary

Reuses the worker's existing progress-stage names:
`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
`embeddings_complete`, `completed` — plus the safe value `processing` for when the stage is
genuinely unknown (same value the stale-lease sweep uses for `error_stage`).

## 4. Functional requirements

- **FR-1 — Failure payload keys (must).** When document processing fails, the worker's `"failed"`
  status payload MUST include `error_message` (the actual exception message), `stage` (the pipeline
  stage executing at failure time), and `retryable` (a deliberately derived boolean). None of these
  keys may be absent; the payload MUST NOT rely on rag-api's fallback defaults
  (`"Processing failed"`, `None`, `True`) for any of them.

- **FR-2 — Legacy key hedge (prefer).** The payload SHOULD retain the legacy `error` key with the
  same string as `error_message`, for continuity with any unverified consumers of the status topic
  and existing log tooling. The contract test pins the full key set (see FR-7 / D1), so dropping
  `error` later is a deliberate, test-visible change.

- **FR-3 — Stage tracking (must).** `process_document` MUST track the currently executing pipeline
  stage in a local initialized to `processing` and advanced according to the mapping in
  `docs/architecture.md` §3.2. Convention: the tracker is set immediately before the awaited step,
  to the stage name that step's progress update uses. Stage names MUST come from the §3.3
  vocabulary. `completed` is set only at the terminal completed publish; pipeline work that has no
  named milestone (vector delete/store, metadata save, usage, map generation) retains the previous
  value — a storage failure must never report `completed`. The failure handler MUST report the
  tracker value; `processing` is the safe value when the stage is genuinely unknown.

- **FR-4 — retryable derivation (must).** `retryable` MUST be derived explicitly from
  `classify_error(e)`: errors classified transient → `true`; classified permanent, including
  unclassified-unknown exceptions (classify_error's conservative default) → `false`. The value MUST
  be a JSON boolean, never absent, never `null`. This aligns the persisted record with the worker's
  ACK/NACK behavior and must not change that behavior.

- **FR-5 — Message quality (must).** `error_message` MUST be non-empty. When `str(e)` is empty
  (e.g. `Exception()`), the worker substitutes `type(e).__name__` so support can disambiguate the
  failure class. The legacy `error` key carries the same string.

- **FR-6 — rag-api passthrough preserved (must).** rag-api's failed branch MUST persist the
  worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage`
  ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument
  MUST carry the same message and stage, with `error.code` remaining `"UNKNOWN"` unless a code is
  actually sent. rag-api's reads, persisted field names, and schema MUST NOT change.

- **FR-7 — Contract test (must).** A cross-service contract test MUST exist at
  `apps/ai-server/tests/integration/test_worker_failure_contract.py` that:
  1. constructs the failure payload through the worker's real `build_failure_payload`
     (see architecture §3.1) — not a restated fixture;
  2. feeds that payload through rag-api's real `run_transactional_update` against fakes (or the
     Firestore emulator);
  3. asserts the persisted main-document `error`, `error_stage`, and `retryable` equal the worker's
     values, and that the `processing/summary` error subdocument carries the same message and stage;
  4. covers both a transient case (`retryable: true`) and a permanent case (`retryable: false`), and
     an early-stage failure and a late-stage failure;
  5. fails if either side's payload keys drift, via guards D1–D4 (architecture §8.3).

- **FR-8 — Worker unit tests (must).** `rag-worker-service` unit tests MUST pin:
  (a) `build_failure_payload` key set and value passthrough;
  (b) the `classify_error` → `retryable` mapping (transient types/status codes → true;
  permanent and unclassified-unknown → false);
  (c) handler wiring: an exception raised at a representative early stage and a representative late
  stage publishes a `"failed"` status whose details equal
  `build_failure_payload(message, tracker stage, classify_error-derived retryable)`, retain the
  legacy `error` key, coerce empty messages (FR-5), and preserve existing behavior
  (`jobId` injection, `metrics.error_message`, trace output).

- **FR-9 — No regression to other failure writers (must).** The worker's stale-lease sweep
  (`_fail_if_still_stale`) and rag-api's enqueue-failure paths (`POST /process`, `POST /resources`)
  MUST remain unchanged; they already write `error`/`error_stage`/`retryable` consistently with
  this contract.

- **FR-10 — Observability (should).** The failure log event (`document_processing_failed`) and the
  Langfuse trace output SHOULD include `stage` and `retryable` alongside `error`.

## 5. Constraints

| ID | Type | Constraint |
|---|---|---|
| C-1 | must | The worker is aligned to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed. |
| C-2 | must_not | No Firestore migration, field rename, or backfill; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. |
| C-3 | must | Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback is never the operative mechanism for worker failures. |
| C-4 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| C-5 | prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values); `processing/summary` `error.code` stays `"UNKNOWN"`. |

## 6. Acceptance criteria

| ID | Criterion (from the Definition) | Verified by |
|---|---|---|
| A1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | FR-1, FR-3, FR-4, FR-5; worker unit tests (FR-8c); contract test scenario 1 + D1. |
| A2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | FR-6; contract test scenario 2 (transient + permanent, early + late stage). |
| A3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | FR-6; contract test scenario 2 summary assertions. |
| A4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | FR-7; guards D1–D4. |

## 7. Non-goals

- NG-1: Changing the stale-lease sweep's direct failure write (already consistent with this contract).
- NG-2: Changing retry/backoff mechanics — Pub/Sub ACK/NACK policy, processing leases, heartbeat
  intervals. Only the *reporting* of retryability in the payload changes.
- NG-3: Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`
  to clients (`retryable` remains persisted-only).
- NG-4: Introducing structured error codes or a failure taxonomy.
- NG-5: Any scope the companion D3 issue covers beyond this worker→rag-api failure payload
  alignment (its content is unavailable in this context; deferred).

## 8. Behavior-change register

1. Persisted `error` becomes the worker's actual exception message (was the fallback
   `"Processing failed"`).
2. Persisted `error_stage` becomes the failing stage (was `null`).
3. Unclassified-unknown exceptions now persist `retryable: false` (was the silent default `true`).
   This is the conservatism `classify_error` was written for; ACK/NACK behavior is unchanged
   (those errors were already acked as permanent), and manual reprocess via `POST /process`
   (`failed → queued` is an allowed transition) is unaffected.
4. No other writer, reader, or schema change.

## 9. Traceability to Definition facts

| Fact | Addressed by |
|---|---|
| F1 (product intent) | FR-1, FR-3, FR-4 |
| F2 (preferred direction: worker aligns to API) | FR-6, C-1 |
| F3 (worker publishes `{"error": str(e)}`) | §1; architecture §1 |
| F4 (rag-api reads `error_message`/`stage`/`retryable`) | §3.2, FR-6 |
| F5 (fallback persistence today) | §1; A2 |
| F6 (established `error`/`error_stage`/`retryable` schema) | FR-9, NG-1 |
| F7 (`classify_error` drives ACK/NACK) | FR-4, FR-8b |
| F8 (adopted retryable derivation) | FR-4 (adopted decision, binding) |
| F9 (stage vocabulary exists; no failure-stage tracking) | FR-3, §3.3 |
| F10 (contract-test infra + emulator modes exist) | FR-7; architecture §8 |
| F11 (legacy `error` key hedge) | FR-2, C-4 |
| F12 (companion D3 issue out of scope) | NG-5, §10 |

## 10. Deferred

- Everything the companion D3 issue covers beyond this payload alignment (content unavailable here).
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`
  (file not present in the current tree; reference exists only in the Objective text).
- Dropping the legacy `error` key after a consumer audit (trivial follow-up cleanup).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

Companion to `docs/requirements.md`. Implements Definition `definition:obj-108`
(WorkItem `wi-define-108-a8`) without widening it.

---

## 1. Current state: the broken seam

**Producer — `apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler:**

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", ..., error=str(e))
    await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
```

**Consumer — `apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch:**

```python
main_update["error"]      = details.get("error_message", "Processing failed")
main_update["error_stage"] = details.get("stage")
main_update["retryable"]  = details.get("retryable", True)
...
summary_update["error"] = {
    "code": details.get("error_code", "UNKNOWN"),
    "message": details.get("error_message", "Processing failed"),
    "stage": details.get("stage"),
}
```

The worker is the only writer on the status topic that doesn't speak the established
`error`/`error_stage`/`retryable` schema — the sweep (`_fail_if_still_stale`), rag-api's
enqueue-failure paths, the `Resource` model, and `ResourceResponse` all already use it. Fix the odd
one out: **the worker aligns to the API.** No reader changes, no migration, no backfill.

## 2. Design overview

```
process_document (worker)
  ├─ stage tracker (local, advanced before each awaited step)
  ├─ ... pipeline steps ...
  └─ except Exception as e:
       message   = str(e) or type(e).__name__          # FR-5
       retryable = classify_error(e)                    # FR-4 (same fn run_worker uses for ACK/NACK)
       details   = build_failure_payload(message, stage, retryable)   # FR-1, FR-2
       └─ _publish_status_update(..., "failed", details, job_id)
            └─ Pub/Sub topic rag-status-updates
                 └─ rag-api _process_status_message
                      └─ run_transactional_update (UNCHANGED)
                           ├─ main doc:      error ← error_message, error_stage ← stage, retryable ← retryable
                           └─ processing/summary: error{code:"UNKNOWN", message, stage}, stage
```

## 3. Worker changes

### 3.1 New module: `rag-worker-service/failure_payload.py`

A dependency-free (stdlib-only) module that names the contract at the seam and gives the contract
test a stub-free import target:

```python
"""Worker → rag-api failure payload contract.

build_failure_payload is the single construction point for the `details` dict
published on a "failed" status message. rag-api's failed branch
(run_transactional_update) reads error_message/stage/retryable from it and
persists error/error_stage/retryable. The legacy `error` key is retained as a
hedge for unverified consumers of the status topic.
"""
from typing import Any, Dict

UNKNOWN_STAGE = "processing"

PIPELINE_STAGES: tuple = (
    "starting", "text_retrieved", "tagging_complete", "summary_generated",
    "chunking_complete", "embeddings_complete", "completed",
)

FAILURE_PAYLOAD_KEYS = ("error_message", "stage", "retryable", "error")

def build_failure_payload(message: str, stage: str, retryable: bool) -> Dict[str, Any]:
    return {
        "error_message": message,
        "stage": stage,
        "retryable": bool(retryable),
        "error": message,
    }
```

`classify_error` stays in `main.py` (it also drives ACK/NACK in `run_worker`); the derivation is
wired in the handler and pinned by worker unit tests, not re-derived by the contract test.

### 3.2 Stage tracker in `process_document`

A plain local, initialized to `UNKNOWN_STAGE`, set immediately before each awaited step to the
stage name that step's progress update uses:

| Code section (in execution order) | Tracker set to | When |
|---|---|---|
| function entry | `processing` | initialization (safe default; also the sweep's `error_stage` value) |
| `_validate_processing_request` + first status publish | `starting` | immediately before validation |
| `_get_extracted_text` | `text_retrieved` | immediately before the await |
| `content_tagger.generate_tags` | `tagging_complete` | immediately before the await |
| `generate_document_summary` + `ragDescription` doc update | `summary_generated` | immediately before the await |
| `_create_enhanced_chunks` | `chunking_complete` | immediately before the await |
| `_generate_embeddings_with_openrouter` | `embeddings_complete` | immediately before the await |
| `delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save, usage, map | *(retained)* `embeddings_complete` | no set — no dedicated milestone name exists in the vocabulary |
| final `"completed"` status publish | `completed` | immediately before the terminal publish |

**Semantics (state once, keep):** the tracker holds the milestone of the step currently executing;
work that produces no named milestone leaves the previous milestone in place; `completed` is set
only at the terminal transition. Consequence: a Weaviate-storage failure reports
`embeddings_complete` (the last milestone reached) — never a false `completed`. `_publish_status_update`
swallows its own errors and the post-completion calls (`_update_user_usage`,
`_generate_resource_map`) swallow theirs, so no failure path can report a stage past the step that
failed.

**Drift convention:** a future pipeline step MUST set the tracker immediately before its await.
The contract test pins the mechanism on representative stages (early + late), which catches the
tracker being removed or bypassed without ossifying every step.

### 3.3 Exception handler wiring

```python
except Exception as e:
    message = str(e) or type(e).__name__              # FR-5
    retryable = classify_error(e)                     # FR-4
    metrics.error_message, metrics.end_time = message, time.time()
    self.logger.error("document_processing_failed", ..., error=message,
                      stage=stage, retryable=retryable)          # FR-10
    await self._publish_status_update(
        user_id, course_id, resource_id, "failed",
        build_failure_payload(message, stage, retryable), job_id,
    )
    if trace:
        trace.update(output={"success": False, "error": message,
                             "stage": stage, "retryable": retryable})  # FR-10
    return metrics
```

Existing behavior preserved: `metrics.error_message`, `jobId` injection inside
`_publish_status_update`, sequence numbers, lease heartbeat.

### 3.4 What does NOT change

`classify_error`, `run_worker` ACK/NACK, claim/lease/heartbeat/sweep mechanics, the sweep's failure
write, rag-api's `run_transactional_update`, `models/resource.py`, response models, docker-compose,
and runtime dependencies (`failure_payload.py` is stdlib-only).

## 4. rag-api: unchanged consumer

rag-api's failed branch already implements FR-6 exactly. It is pinned — not modified — by the
contract test. Note for reviewers: `retryable` is persisted on the document but is not part of
`ResourceResponse`; that is pre-existing and out of scope (NG-3).

**Operational meaning of `retryable` (documented, not changed):** the flag mirrors
`classify_error`, the same classification that drives ACK/NACK. A transient failure is NACKed (one
Pub/Sub redelivery, which the claim guard typically acks because the doc is already `failed`);
`retryable: true` therefore signals "reprocessing is appropriate" — via redelivery where applicable
and reliably via `POST /process` (`failed → queued`). A permanent failure is acked; manual
reprocess remains. Changing claim/retry mechanics is out of scope (NG-2).

## 5. Data contract (pinned by tests)

| Worker payload key | Main doc field | `processing/summary` |
|---|---|---|
| `error_message` | `error` | `error.message` |
| `stage` | `error_stage` | `error.stage`; also top-level `stage` |
| `retryable` | `retryable` | — |
| `error` (legacy) | *(ignored by rag-api)* | — |
| `jobId` (transport-injected) | *(ignored for failed)* | — |
| *(absent)* `error_code` | — | `error.code` = `"UNKNOWN"` |

## 6. Compatibility hedge

Only rag-api's status subscriber is a verified consumer; other services/tooling share the topic.
The legacy `error` key is retained (C-4) — one redundant string per failure as insurance against an
unknown reader. Dropping it later is a deliberate, test-visible cleanup (D1 pins the key set).

## 7. retryable derivation table

| Exception | `classify_error` | Persisted `retryable` | ACK/NACK (unchanged) |
|---|---|---|---|
| `TransientError`, `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | transient | `true` | NACK (redelivery) |
| `httpx.HTTPStatusError` 429/500/502/503/504 | transient | `true` | NACK |
| `PermanentError`, other 4xx `HTTPStatusError`, `ValueError`, `RuntimeError`, **any unclassified exception** | permanent | `false` | ACK |

Behavior change (accepted, per Definition F8): unclassified-unknown failures move from the silent
`true` default to `false`. No retry mechanics change.

## 8. Test architecture

### 8.1 Worker unit tests — `rag-worker-service/tests/unit/test_failure_payload.py` (new)

Follows the proven patterns of `test_processing_lease.py` (service `conftest.py` already stubs the
heavy imports; `sys.path` insert + `import main`).

- `TestBuildFailurePayload`: exact key set `FAILURE_PAYLOAD_KEYS`; value passthrough for
  message/stage/`retryable` (True and False); `UNKNOWN_STAGE == "processing"`;
  `PIPELINE_STAGES` matches §3.3.
- `TestRetryableDerivation` (via `main.classify_error`): transient types → True; 5xx/429
  `HTTPStatusError` → True; `PermanentError`/`ValueError`/`RuntimeError`/404 → False.
- `TestHandlerWiring`: skeleton processor via
  `EnhancedDocumentProcessor.__new__(EnhancedDocumentProcessor)` with `langfuse=None`,
  `db=MagicMock()`, `config=SimpleNamespace(gcp_project=..., rag_status_topic=...)`, and a
  `FakePublisher` whose `publish()` returns an already-resolved `concurrent.futures.Future`
  (`_publish_status_update` does `asyncio.wrap_future(future)`). Pipeline steps are monkeypatched
  to raise. Cases:
  - early failure (`_get_extracted_text` raises `httpx.ConnectError`) → published details ==
    `build_failure_payload(msg, "text_retrieved", True)`, legacy `error` present;
  - late failure (`_generate_embeddings_with_openrouter` raises `RuntimeError`) → stage
    `embeddings_complete`, `retryable` False;
  - validation failure (`_validate_processing_request` raises `ValueError`) → stage `starting`,
    `retryable` False;
  - empty-message exception → `error_message == type name` (FR-5);
  - `jobId` injected, `metrics.error_message` set (existing behavior retained).

### 8.2 Cross-service contract test — `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new)

**Import strategy (critical):** both services name their entry module `main`, and the shared
`tests/integration/conftest.py` puts rag-api's dir on `sys.path` for `import main as rag_api_main`.
The contract test MUST NOT mutate `sys.path` before that import. It loads the worker's contract
module via `importlib.util.spec_from_file_location("worker_failure_payload",
<root>/rag-worker-service/failure_payload.py)` — stub-free, because the module is stdlib-only —
and reads `rag-worker-service/main.py` as text for the static guard. This avoids recreating the
worker's heavy stub set in the integration environment.

**Scenario 1 — worker payload construction (D1).**
`build_failure_payload("boom: connection reset", "text_retrieved", True)` → key set exactly
`{"error_message", "stage", "retryable", "error"}`; values passthrough. Repeated for the permanent
case (`retryable` False) and for an early (`starting`/`text_retrieved`) and a late
(`embeddings_complete`) stage.

**Scenario 2 — rag-api failed-branch persistence (A2, A3, D2, D3).**
Fake Firestore modeled on `test_processing_lease.py` (`FakeDb`/`FakeTx`/`FakeRef`/`FakeSnap`,
extended with `.id` and captured `processing/summary` sets). Monkeypatch
`rag_api_main.firestore.transactional` to an identity decorator and `SERVER_TIMESTAMP` to a
sentinel (the shared conftest's `MagicMock` firestore would otherwise no-op the transaction body).
Seed the doc with `status: "processing"` (allowed transition `processing → failed`). Call
`rag_api_main.run_transactional_update(db, doc_ref, "failed", payload, fake_logger, user_id)` with
the Scenario-1 payload. Assert:
- main doc: `status == "failed"`, `error == payload["error_message"]` (and explicitly
  `!= "Processing failed"`), `error_stage == payload["stage"]` (and `is not None`),
  `retryable is payload["retryable"]` — for both the `True` and the `False` case (the `False` case
  is the strongest guard against the silent default);
- summary: `stage == payload["stage"]`, `error == {"code": "UNKNOWN", "message": <same>,
  "stage": <same>}`.

**Scenario 3 — drift guards (A4).**
- **D1 (worker key set):** Scenario 1's exact-set assertion.
- **D2/D3 (api persistence):** Scenario 2's value-equality assertions — any rename of rag-api's
  read keys or of the persisted fields reverts to fallbacks and fails here.
- **D4 (handler wiring, static):** source scan of `rag-worker-service/main.py` asserting the failed
  handler references `build_failure_payload(` and `classify_error(`. (Precise wiring is pinned
  behaviorally by FR-8c; D4 is the cheap tripwire in the contract job.)

**Scenario 4 — envelope passthrough (optional hardening, not part of acceptance).** Wrap the
payload in the topic envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`) and call
`_process_status_message` with a fake message/app_state; assert persistence and `message.ack()`.
Include only if the fake-message plumbing stays stable.

**Emulator note:** fakes are the default (hermetic, matches the house pattern). If fakes ever prove
unfaithful, the same scenarios run against the Firestore emulator — both services have
`FIRESTORE_EMULATOR_HOST` branches (Definition F10).

### 8.3 CI wiring

- `rag-worker-service` unit job: runs `tests/unit/test_failure_payload.py` (existing pytest config).
- Cross-service/contract job: runs `tests/integration/test_worker_failure_contract.py`
  (same job as `test_api_contracts.py`).
- Full gates: `./dev/run ai-server`.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` retained (C-4); residual risk accepted as low (Definition F11). |
| Stage-tracker drift as the pipeline evolves | "Set immediately before the await" convention documented; representative early/late-stage tests; D4 tripwire. |
| `retryable: false` for genuinely transient-but-unrecognized failures | Accepted (Definition F8); ACK/NACK unchanged; manual reprocess via `POST /process` remains; widening `classify_error` is out of scope. |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key means touching the test. |
| Test-env import fragility (two `main` modules, heavy worker deps) | `failure_payload.py` is stdlib-only and loaded via `importlib` file location; worker `main` is imported only inside the worker suite where its conftest stubs live; static guard reads source as text. |
| Fake Firestore diverges from real transaction semantics | Fakes mirror the proven `test_processing_lease.py` pattern and only the operations `run_transactional_update` uses; emulator path documented as fallback. |

## 10. File change manifest

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/failure_payload.py` | **new** — contract constants + `build_failure_payload` (stdlib-only) |
| `apps/ai-server/rag-worker-service/main.py` | **modified** — import from `failure_payload`; stage tracker in `process_document`; handler builds payload via `build_failure_payload(message, stage, classify_error(e))`; empty-message coercion; log/trace fields |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | **new** — FR-8 tests |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | **new** — FR-7 contract test + D1–D4 guards |
| everything else | **unchanged** (rag-api service, models, sweep, enqueue paths, frontend, compose, deps) |

## 11. Validation

1. `pytest apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` — FR-8 green.
2. `pytest apps/ai-server/tests/integration/test_worker_failure_contract.py` — FR-7 green
   (scenarios 1–3, guards D1–D4).
3. `./dev/run ai-server` — full gates; no regressions in existing suites.
4. Manual spot-check (optional): run the hermetic stack, force a pipeline failure, confirm the
   persisted document shows the real message, the failing stage, and the derived `retryable`.

## 12. Future work (explicitly not this change)

- Drop the legacy `error` key after a consumer audit of the status topic (test-visible via D1).
- Structured error codes / failure taxonomy (C-5).
- Any automatic requeue semantics for `retryable: true` failures (NG-2).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>