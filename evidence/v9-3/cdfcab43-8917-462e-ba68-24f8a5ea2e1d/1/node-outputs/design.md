Design complete. Requirements and architecture below are derived from the authoritative Definition (wi-define-108-a8) plus repository evidence verified this cycle (rag-api `run_transactional_update` failed branch, `Resource` model, status-subscriber envelope, transition map, and the existing contract-test/fake infrastructure). Worker-internals specifics not retained from evidence are flagged as implementation-time confirmations rather than invented.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

Authority: WorkItem `wi-define-108-a8`, Definition artifact `definition:obj-108`
(sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).
This document operationalizes that Definition for implementation. It does not widen,
narrow, or reinterpret it. Where a statement rests on the Definition's repository
claims rather than a direct read in this cycle, it is marked *(per Definition)*.

## 1. Problem statement

When a RAG processing job fails, the worker's exception handler publishes a failure
status whose `details` contain only `{"error": str(e)}` *(per Definition, F3)*.
rag-api's failed branch in `run_transactional_update` reads `error_message`, `stage`,
and `retryable` from `details` and persists them as `error`, `error_stage`, and
`retryable` on the resource document, plus `message`/`stage` (and `error_code`
defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument (verified
by direct read this cycle). Because the key sets do not intersect, every
worker-originated failure currently persists:

- `error` = the fallback string `"Processing failed"` (not the actual message)
- `error_stage` = `None`
- `retryable` = `True` (silent default, not a deliberate decision)

and the summary error subdocument inherits the same fallback message with
`error_code: "UNKNOWN"`. Users and support cannot disambiguate failures; the
persisted `retryable` does not reflect the worker's actual retry decision.

## 2. Scope

**In scope**
- rag-worker failure status payload: keys, semantics, and construction.
- Stage tracking through `process_document` so the failing stage is reported.
- Explicit derivation of `retryable` from the worker's existing error
  classification (`classify_error`).
- A contract test pinning the worker failure → rag-api persistence seam,
  including key-drift detection on both sides.

**Out of scope** — see §6 (Non-goals).

## 3. Constraints (binding)

| ID | Type | Constraint |
|----|------|------------|
| C-1 | must | The worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable`. rag-api's reads and persisted schema are **not** changed. |
| C-2 | must_not | No Firestore migration, field rename, or backfill of existing documents. Persisted fields `error`, `error_stage`, `retryable` keep their names and semantics. |
| C-3 | must | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived). rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| C-4 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling. |
| C-5 | prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values). The summary `error.code` remains `"UNKNOWN"` unless a code is actually sent (the worker sends none). |

## 4. Functional requirements

### FR-1 — Failure payload keys (worker)
When document processing fails, the worker's failed status payload `details` must
contain, at minimum and always:

- `error_message` (string): the actual exception message (`str(e)`).
- `stage` (string): the pipeline stage executing at failure time (see FR-2).
- `retryable` (bool): deliberately derived (see FR-4).

The payload must never rely on rag-api's fallback defaults for these keys — i.e.,
a consumed payload must never produce the `"Processing failed"` fallback, a `None`
`error_stage`, or a defaulted `retryable` for a worker-originated failure.
Per C-4, the payload additionally retains the legacy `error` key (string, same
value as `error_message`).

*Verification: contract test T1 (see docs/architecture.md §5), including an exact
key-set assertion on `details`.*

### FR-2 — Stage tracking (worker)
The worker must track the currently executing pipeline stage through
`process_document` so the failure handler reports the true failing stage.

- Stage names reuse the existing progress-update vocabulary:
  `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`,
  `chunking_complete`, `embeddings_complete` *(vocabulary per Definition, F9 —
  these are the worker's published progress stage names)*.
- Convention: the tracker is assigned immediately **before** each pipeline `await`
  (set-before-await), so a failure inside a step reports that step.
- `"processing"` is the safe value when the stage is genuinely unknown; it must
  never regress to `null`. This matches the stale-lease sweep's `error_stage`
  value *(per Definition)*.
- The exact inventory of awaited steps inside `process_document`, and the label
  mapped to each, is confirmed against `rag-worker-service/main.py` at
  implementation time (the proposed mapping is in docs/architecture.md §3.1).

*Verification: worker-side test T2 forces an early-stage failure and a late-stage
failure through `process_document` and asserts the reported stage.*

### FR-3 — rag-api persistence mapping (unchanged behavior, pinned)
rag-api's failed branch persists worker-provided values unchanged:

| Payload `details` key | Persisted location | Verified current behavior |
|---|---|---|
| `error_message` | main doc `error` | `details.get("error_message", "Processing failed")` |
| `stage` | main doc `error_stage` | `details.get("stage")` (no fallback → `None` if absent) |
| `retryable` | main doc `retryable` | `details.get("retryable", True)` |
| `error_message` | summary `error.message` | same fallback as above |
| `stage` | summary `error.stage` | `details.get("stage")` |
| `error_code` | summary `error.code` | `details.get("error_code", "UNKNOWN")` — worker sends none, so `"UNKNOWN"` |

The processing/summary error subdocument must carry the same message and stage as
the main document. **No rag-api code changes are made**; this mapping is a
preserved-behavior requirement pinned by the contract test.

*Verification: T1 asserts persisted values equal the worker's payload values and
explicitly asserts `error != "Processing failed"` and `error_stage is not None`.*

### FR-4 — retryable derivation (worker)
The derivation must be explicit and aligned with the worker's ACK/NACK behavior,
which is already driven by `classify_error()` *(per Definition, F7)*:

| `classify_error(e)` classification | `retryable` | Rationale |
|---|---|---|
| transient | `true` | Pub/Sub will redeliver (NACK path); the record says what the system does. |
| permanent | `false` | Message is acked, no redelivery; manual reprocess via `POST /process` remains (the `failed → queued` transition exists in rag-api's `ALLOWED_TRANSITIONS` — verified). |
| unclassified / unknown | `false` | `classify_error`'s conservative default *(per Definition, F7/F8)*; prevents infinite retry loops. |

**Deliberate behavior change:** unclassified-unknown exceptions currently persist
`retryable: true` via the silent default; they will now persist `false`. This is
accepted (see docs/architecture.md §7). The stale-lease sweep's separate
`retryable: true` write is unchanged and remains correct (a dead worker is a
transient condition) *(per Definition, F8)*.

Implementation note: the exact adapter to `classify_error`'s return shape is
confirmed against the code at implementation time; the rule table above is the
binding behavior.

*Verification: T1 covers transient-classified, permanent-classified, and generic
unclassified exceptions and asserts the derived `retryable` end-to-end through
persistence.*

### FR-5 — Legacy key retention (worker)
The failure payload retains `error` (legacy) alongside `error_message`, with the
same string value. rag-api ignores `error` in `details` (verified — the failed
branch reads only `error_message`/`stage`/`retryable`/`error_code`), so the
duplicate is pure compatibility insurance for unknown consumers of the status
topic *(per Definition, F11 — only rag-api's subscriber is a verified consumer)*.

### FR-6 — Contract test (worker failure → rag-api persistence)
A contract test must:

1. Exercise the worker's **real** failure-payload construction (import the worker
   code; do not restate the payload shape in a fixture).
2. Feed the constructed payload through rag-api's **real** `run_transactional_update`
   failed-branch persistence, against the Firestore emulator or fakes.
3. Assert the persisted `error`, `error_stage`, and `retryable` equal the worker's
   payload values, and that the summary error subdocument carries the same
   message and stage.
4. **Fail if either side's payload keys drift**: worker-side via an exact key-set
   assertion on `details`; rag-api-side structurally, because key drift on the
   reader makes the persisted values fall back to defaults and fail the equality
   assertions of (3).
5. Cover representative stages (an early-stage failure and a late-stage failure)
   so the stage tracker cannot be silently removed or bypassed.
6. Follow the house doctrine of `rag-api-service/tests/unit/test_service_contracts.py`:
   assert the real method's contract — no mock of the method under test.

*Verification: T1 + T2 pass in CI; see docs/architecture.md §5 for design.*

## 5. Acceptance criteria

| # | Criterion (from Definition) | Verified by |
|---|---|---|
| A-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | T2 (published payload capture) + T1 key-set assertion |
| A-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | T1 persistence assertions |
| A-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | T1 summary assertions |
| A-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | T1 (+ T2 for stage mechanism) present and green in CI |

## 6. Non-goals

- Changing the stale-lease sweep's direct failure write (already consistent with
  the contract) *(per Definition)*.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases,
  heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and
  `error_stage` to clients (verified); the `Resource` model already persists
  `retryable` (verified, defaults `True`).
- Introducing structured error codes or a failure taxonomy — summary
  `error.code` stays `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure
  payload alignment (its content is unavailable; deferred) *(per Definition, F12)*.
- Reconciling this analysis with the original D4 deviation note in
  `plans/upload-flow.md` (file not present in the current tree) *(per Definition, F12)*.

## 7. Assumptions and unknowns

| ID | Statement | Status |
|----|-----------|--------|
| AS-1 | `retryable` derivation default: transient → `true`, permanent (incl. unclassified-unknown) → `false`, aligned with ACK/NACK. | Adopted default *(per Definition, F8 — ASSUMED)* |
| AS-2 | Only rag-api's status subscriber is a verified consumer of the worker's failure payload; other consumers may exist, hence the legacy `error` hedge. | Assumption *(per Definition, F11)* |
| U-1 | Exact return shape/signature of `classify_error` (string vs bool, exact values). | To confirm at implementation; rule table FR-4 is binding regardless. |
| U-2 | Exact inventory and boundaries of awaited pipeline steps inside `process_document`, and the label mapped to each. | To confirm at implementation; proposed mapping in docs/architecture.md §3.1. |
| U-3 | Whether any tooling or service other than rag-api parses the worker's failure payload keys. | Unknown; mitigated by C-4/FR-5. |
| U-4 | Whether the Firestore emulator is wired into CI for the top-level integration suite. | Unknown; T1 is designed fakes-first so it runs without the emulator (docs/architecture.md §5). |

## 8. Deferred

- Companion D3 issue scope beyond this alignment (content unavailable) *(per Definition, F12)*.
- `plans/upload-flow.md` D4 reconciliation (file absent from tree) *(per Definition, F12)*.
- Dropping the legacy `error` key, if a future audit confirms the worker is the
  only publisher and rag-api the only consumer (trivial cleanup, explicitly out
  of this cycle).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

Companion to `docs/requirements.md`. Authority: Definition `definition:obj-108`
(wi-define-108-a8). Evidence markers: **[V]** = verified by direct repository read
this cycle; **[D]** = authoritative Definition claim (repository-claim fact);
**[U]** = unverified, to confirm at implementation.

## 1. Context and current behavior

### 1.1 The seam

```
rag-worker (process_document)                rag-api (status subscriber)
─────────────────────────────                ─────────────────────────────
exception in pipeline step
  └─ _publish_status_update(                 _process_status_message(message)
      status="failed",                         └─ payload keys: user_id, course_id,
      details={"error": str(e)})   [D: F3]        resource_id, status, details  [V]
                                               └─ run_transactional_update(db, ref,
                                                     "failed", details, ...)       [V]
                                                   ├─ main.error       ← details.get("error_message", "Processing failed")  [V]
                                                   ├─ main.error_stage ← details.get("stage")                            [V]
                                                   ├─ main.retryable   ← details.get("retryable", True)                  [V]
                                                   └─ summary.error    ← {code: details.get("error_code","UNKNOWN"),    [V]
                                                                          message: details.get("error_message","Processing failed"),
                                                                          stage: details.get("stage")}
```

Key mismatch: the worker publishes `error`; the API reads `error_message`,
`stage`, `retryable`. No key intersects, so every worker failure persists the
fallbacks. The `processing/summary` top-level `stage` falls back to `"unknown"`
and `progress` to `0` when absent [V].

### 1.2 Why the worker aligns to the API (not vice versa)

The persisted failure schema `error` / `error_stage` / `retryable` is already
written consistently by three other paths — the worker's stale-lease sweep
(`_fail_if_stale` path) [D: F6], rag-api's enqueue-failure paths (`/process`,
`POST /resources`) [D: F6] — and exposed by the `Resource` model
(`error: Optional[str]`, `error_stage: Optional[str]`, `retryable: bool = True`,
with matching `to_dict`/`from_dict`) [V] and `ResourceResponse`
(`error`, `error_stage`) [V]. The worker's status publisher is the only writer
that doesn't speak the schema. Aligning the worker requires no migration, no
backfill, and no reader changes — satisfying constraints C-1/C-2.

### 1.3 Relevant verified API-side facts the design relies on

- Transition map [V]: `"processing": {"completed", "failed"}` and
  `"failed": {"queued"}` — a failed resource can be manually reprocessed
  (supports the `retryable: false` semantics of FR-4).
- Envelope of status messages [V]: `user_id`, `course_id`
  (`"__ungrouped__"` marker for independent resources), `resource_id`,
  `status`, `details`. Canonical doc path
  `users/{uid}/resources/{rid}` preferred; legacy course-centric path as
  fallback.
- rag-api has a `FIRESTORE_EMULATOR_HOST` startup branch [V]; the top-level
  integration conftest (`apps/ai-server/tests/integration/conftest.py`) mocks
  cloud modules and puts `rag-api-service` on `sys.path` so `main` imports
  directly [V].
- House contract-test patterns exist: fixture- and AST-based static checks in
  `apps/ai-server/tests/integration/test_api_contracts.py` [V], and the
  "assert the real method, no mock of the method under test" fake-Firestore
  doctrine in `rag-api-service/tests/unit/test_service_contracts.py`
  (`FakeDoc`/`FakeCollection`/`FakeRef`) [V].
- Worker test tree: `rag-worker-service/tests/{unit,integration}/` with a
  conftest that stubs `google.cloud.*`, `firebase_admin.*`, langchain, openai,
  etc. and sets env defaults [V]; `tests/integration/` currently contains only
  `__init__.py` [V] — a ready home for worker-side failure-path tests.

## 2. Target contract (pinned)

Worker → rag-api status message, `status == "failed"`:

```json
{
  "user_id": "<uid>",
  "course_id": "<cid | __ungrouped__>",
  "resource_id": "<rid>",
  "status": "failed",
  "details": {
    "error_message": "<actual exception message>",
    "stage": "<pipeline stage, vocabulary below>",
    "retryable": true|false,
    "error": "<legacy duplicate of error_message>"
  }
}
```

| Key | Type | Required | Semantics | Consumer |
|---|---|---|---|---|
| `error_message` | str | yes | `str(e)` of the actual exception | rag-api → main `error`, summary `error.message` [V] |
| `stage` | str | yes | failing stage; never absent/empty for worker failures | rag-api → main `error_stage`, summary `error.stage` [V] |
| `retryable` | bool | yes | derived per FR-4 rule table | rag-api → main `retryable` [V] |
| `error` | str | yes (legacy hedge) | identical to `error_message` | ignored by rag-api [V]; insurance for unknown consumers [D: F11] |
| `error_code` | — | not sent | summary `error.code` stays `"UNKNOWN"` via API default [V] | — |

Drift policy: the `details` key set is pinned exactly to
`{"error_message", "stage", "retryable", "error"}` by T1. Adding or removing a
key intentionally fails the build; that is the drift guard working (C-4's hedge
included in the pin).

## 3. Component design

### 3.1 Worker: stage tracker in `process_document`

A function-local `current_stage` variable:

- Initialized to `"starting"` as the first statement of `process_document`.
- Assigned **immediately before each pipeline `await`** (set-before-await
  convention, per the Definition's drift-risk note), using the progress-vocabulary
  label of the step about to execute. A failure inside a step therefore reports
  the step that was executing.

Proposed mapping (labels from the verified progress vocabulary [D: F9]; exact
step inventory confirmed against `main.py` at implementation [U-2]):

| Pipeline phase | `current_stage` value |
|---|---|
| entry / download / init before first pipeline step | `"starting"` (initial value) |
| text extraction | `"text_retrieved"` |
| content tagging | `"tagging_complete"` |
| summary generation | `"summary_generated"` |
| chunking | `"chunking_complete"` |
| embedding generation | `"embeddings_complete"` |
| genuinely unknown | `"processing"` (safe value; matches stale-lease sweep [D]) |

Drift mitigation: any future pipeline step must set the tracker immediately
before its await; T2 pins the mechanism on an early and a late representative
stage so removing or bypassing the tracker fails the build.

### 3.2 Worker: failure payload builder

A single function in `rag-worker-service/main.py`, next to the existing error
classification (proposed name; exact placement at implementation):

```python
def build_failure_details(e: Exception, stage: str | None) -> dict:
    retryable = <classify_error(e) classifies as transient>   # FR-4 rule table
    message = str(e)
    return {
        "error_message": message,
        "stage": stage if stage else "processing",   # never null/empty
        "retryable": retryable,
        "error": message,                            # legacy hedge (C-4)
    }
```

- `retryable` adapter to `classify_error`'s exact return shape confirmed at
  implementation [U-1]; the FR-4 rule table is binding regardless of shape.
- The builder is the single construction point: the `process_document` exception
  handler calls it and passes the result as `details` to `_publish_status_update`
  (replacing today's `{"error": str(e)}` [D: F3]). No other failure payload is
  hand-built in the worker.
- The envelope (`user_id`/`course_id`/`resource_id`/`status`) is unchanged — it
  is already proven in production by the progress updates and matches the
  verified reader contract [V].

### 3.3 Worker: handler wiring

The `process_document` exception handler becomes, in effect:

```python
except Exception as e:
    _publish_status_update(..., status="failed",
                           details=build_failure_details(e, current_stage))
    raise   # ACK/NACK decision in run_worker remains classify_error-driven [D: F7]
```

ACK/NACK mechanics, leases, heartbeats: untouched (non-goal). Only the reported
payload changes.

### 3.4 rag-api: no changes

`run_transactional_update`'s failed branch is left exactly as verified [V]. The
worker's new keys land in the existing reads; the fallbacks
(`"Processing failed"`, `None`, `True`) remain in the code as defense for
non-worker publishers (e.g., enqueue-failure paths) but cease to be operative
for worker failures (C-3).

## 4. Data flow (to-be)

```
pipeline step k raises e
  └─ handler: build_failure_details(e, current_stage=step_k_label)
       → {error_message: msg, stage: step_k_label,
          retryable: transient? true : false, error: msg}
  └─ _publish_status_update(status="failed", details=…)  → Pub/Sub rag-status-updates
       └─ rag-api _process_status_message → run_transactional_update("failed", details)
            ├─ main:  error=msg, error_stage=step_k_label, retryable=derived
            └─ summary: error={code:"UNKNOWN", message:msg, stage:step_k_label},
                        stage=step_k_label, progress=0 (default, unchanged)
```

## 5. Test architecture

### T1 — Cross-service contract test (primary drift guard)

**Location:** `apps/ai-server/tests/integration/test_worker_failure_contract.py`
(new, alongside `test_api_contracts.py` — the established home for cross-service
seam tests [V]).

**Shape (fakes-first, per the `test_service_contracts.py` doctrine [V]):**

1. Import the worker's real `build_failure_details` (worker stubs applied
   idempotently before import, mirroring `rag-worker-service/tests/conftest.py`'s
   stub table [V]; both conftests guard with `if mod not in sys.modules`, so the
   test applies its stubs at module import time and is robust to ordering).
2. Build payloads for the case matrix below.
3. Feed each `details` through the **real** `run_transactional_update` against a
   transaction-capable fake:
   - Patch `rag_api_main.firestore.transactional` to a passthrough decorator and
     `rag_api_main.firestore.SERVER_TIMESTAMP` to a sentinel — necessary because
     the top-level conftest replaces `google.cloud.firestore` with a MagicMock,
     which would otherwise silently no-op the `@firestore.transactional` inner
     function [V]. This patch makes T1 robust regardless of which conftest's
     stubs won `sys.modules`.
   - `FakeTransaction` records `update(ref, data)`; db fake returns it from
     `.transaction()`.
   - `FakeDocRef` (extension of the verified `FakeRef` pattern [V]): `.id`,
     `.get(transaction=...)` → snapshot seeded with `status: "processing"`
     (so `processing → failed` is an allowed transition [V]), `.update(...)`,
     and `.collection("processing").document("summary")` recording the
     `merge=True` set.
4. Assert, per case:
   - `set(details.keys()) == {"error_message", "stage", "retryable", "error"}`
     (exact — worker-side drift guard).
   - main doc: `error == details["error_message"]`,
     `error_stage == details["stage"]`, `retryable == details["retryable"]`,
     `status == "failed"`.
   - `error != "Processing failed"` and `error_stage is not None`
     (explicit fallback regression guards).
   - summary: `error.message == details["error_message"]`,
     `error.stage == details["stage"]`, `error.code == "UNKNOWN"`,
     top-level `stage == details["stage"]`.
   - rag-api-side drift is caught structurally: if the reader's keys change,
     persisted values fall back to defaults and the equality assertions above
     fail.

**Case matrix:**

| Case | Exception | Stage input | Expected `retryable` |
|---|---|---|---|
| transient-classified, early stage | a `TransientError` (or equivalent) [D: F7] | early vocabulary label | `true` |
| permanent-classified, late stage | a `PermanentError` (or equivalent) [D: F7] | late vocabulary label | `false` |
| unclassified unknown, mid stage | generic `Exception("boom")` | any vocabulary label | `false` (conservative default) |

**Emulator option:** if the fake transaction shim proves brittle, the same test
logic can run against the real Firestore emulator (both services have emulator
branches [V, D: F10]). Fakes remain the default: hermetic, fast, no CI
dependency [U-4].

### T2 — Worker-side stage-tracking test

**Location:** `apps/ai-server/rag-worker-service/tests/integration/`
(directory exists and is empty [V]); proposed
`test_failure_stage_tracking.py`.

**Shape:** run the real `process_document` with the worker conftest's stub
environment [V]; replace the Pub/Sub publisher with a recorder; force (a) an
early pipeline dependency and (b) a late pipeline dependency to raise. Assert
the captured failure message's `details` contain the expected stage per the
§3.1 mapping, the derived `retryable`, `error_message == str(e)`, and the legacy
`error` key. Exact monkeypatch seams inside `main.py` are fixed at
implementation [U-2]; the test's acceptance (early + late representative stages,
real tracker, real handler, real publisher seam) is fixed here.

**Fallback:** if a full in-process `process_document` run proves impractical,
T2 may drive the exception-handler path via a narrowed entry (first external
dependency stubbed to raise) — still exercising the real tracker, handler, and
publisher seam.

### What is deliberately NOT tested

- No AST/static guard on payload keys: T1's behavioral path through real code on
  both sides already fails on drift, and the exact key-set assertion pins the
  worker side precisely. Avoids duplicating the contract in a scanner.
- No assertion on `progress` (defaults to 0 in the summary; not part of this
  contract).
- No pinning of every pipeline step's label — only representative early/late
  stages, per the Definition, to avoid ossifying the pipeline.

## 6. Compatibility and rollout

- **Wire format:** additive from the consumer's perspective — rag-api already
  reads the new keys; the legacy `error` key keeps the old field present for any
  unknown topic consumer [D: F11]. No schema migration, no backfill (C-2).
- **Persisted data:** documents failed *before* deploy keep their fallback
  values; no repair is attempted (out of scope). Documents failed *after* deploy
  carry real values.
- **Behavior change:** unclassified-unknown failures flip persisted
  `retryable` from `true` (silent default) to `false` (deliberate). Manual
  reprocess via `POST /process` is unaffected (`failed → queued` transition
  verified [V]).
- **Rollback:** revert the worker commit; rag-api is untouched, so the old
  fallback behavior resumes cleanly.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained (C-4/FR-5); residual risk accepted as low [D: F11]. |
| Stage-tracker drift as the pipeline evolves | Set-before-await convention documented; T2 pins early + late representative stages. |
| `retryable=false` for genuinely transient-but-unrecognized failures reduces auto-retry affordances | Accepted per Definition; manual reprocess remains; widening `classify_error` is out of scope. |
| Contract test ossifies the payload | Intentional — that is the drift guard. Adding a key later means touching T1, which is the point. |
| Cross-conftest stub conflicts in the top-level integration suite | T1 applies its stubs idempotently and patches `rag_api_main.firestore` explicitly, making it order-robust [V]. |
| Fake transaction shim diverges from real Firestore semantics | Emulator variant available as fallback (both services support it [V, D: F10]). |

## 8. Alternatives considered

| Alternative | Verdict |
|---|---|
| Change rag-api to read `error` (and derive stage/retryable) | Rejected: violates C-1; ripples across three consistent write paths and two response models; risks migration pressure. |
| Introduce `error_code` taxonomy now | Rejected (C-5, prefer_not); summary `error.code` stays `"UNKNOWN"`. |
| Drop the legacy `error` key immediately | Deferred; trivial cleanup after a consumer audit confirms rag-api is the only consumer. |
| Emulator-only contract test | Rejected as primary; fakes-first runs hermetically everywhere; emulator kept as fallback. |
| Restate the payload shape in a test fixture | Rejected; T1 imports the real builder so the contract has one source of truth (FR-6.1). |

## 9. Implementation sequence

1. Worker: add `build_failure_details` (with `classify_error` adapter [U-1]) and
   the `current_stage` tracker with set-before-await assignments [U-2]; rewire
   the `process_document` exception handler.
2. Worker: add T2 (early/late forced failures, publisher recorder).
3. Top-level integration: add T1 (builder → real `run_transactional_update` on
   transaction-capable fakes; case matrix; exact key-set pin).
4. Run both suites; confirm A-1…A-4 (docs/requirements.md §5).

Total production-code change: `rag-worker-service/main.py` only. rag-api: none.

## 10. Deferred

- Companion D3 issue scope beyond this alignment (unavailable here) [D: F12].
- `plans/upload-flow.md` D4 reconciliation (file absent from tree) [D: F12].
- Legacy `error` key removal after a consumer audit.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>