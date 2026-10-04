Investigation complete. Verified evidence: rag-api's `run_transactional_update` failed branch (reads `error_message`/`stage`/`retryable`; persists `error`/`error_stage`/`retryable` on the main doc and `error.{code,message,stage}` + `stage` on the `processing/summary` subdocument), the `Resource` model's `error`/`error_stage`/`retryable` fields, the rag-api Firestore-emulator startup branch, the contract-test house pattern in `apps/ai-server/tests/integration/test_api_contracts.py`, and both services' test conftest stubbing patterns. Worker-side specifics (`process_document` handler, `classify_error`, `_publish_status_update`, stale-lease sweep) are taken from the authoritative Definition's repository-claims; the worker's exact internals beyond those claims remain unverified in this session and are treated as implementation details to confirm at implement time.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api Failure Payload Contract Alignment

WorkItem: `wi-define-108-a8` (definition artifact `definition:obj-108`, sha256 `71f1c39c…`)
Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

## 1. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG
processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately
derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## 2. Problem statement

The worker's `process_document` exception handler publishes a failed status whose details contain a single
key, `{"error": str(e)}` (F3). rag-api's failed branch in `run_transactional_update` reads three keys —
`error_message`, `stage`, `retryable` — and persists them as `error`, `error_stage`, and `retryable` on the
main resource document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the
`processing/summary` error subdocument (F4, verified against `apps/ai-server/rag-api-service/main.py`).

Because of the key mismatch, every worker-originated failure currently persists:

| Persisted field | Actual value today | Correct value |
|---|---|---|
| `error` | fallback `"Processing failed"` | worker's actual exception message |
| `error_stage` | `None` | failing pipeline stage |
| `retryable` | silent default `True` | deliberately derived value |

The `processing/summary` error subdocument inherits the same fallbacks, with `error_code` always `"UNKNOWN"`.
Three other write paths (worker stale-lease sweep `_fail_if_still_stale`, rag-api enqueue-failure paths, and
the `Resource` model with `ResourceResponse`) already use the `error`/`error_stage`/`retryable` schema (F6).
The worker's status publisher is the only writer that does not speak it.

## 3. Scope

### 3.1 In scope
- Worker failure-payload construction in `apps/ai-server/rag-worker-service/main.py` (`process_document`
  exception handler / `_publish_status_update` path): keys, stage tracking, retryable derivation.
- A contract test covering the worker failure → rag-api persistence seam.
- No rag-api reader or schema changes (the API already speaks the target contract).

### 3.2 Out of scope (non-goals)
- The stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable`
  consistently with this contract (F6).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the
  *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Structured error codes / a failure taxonomy — summary `error.code` remains `"UNKNOWN"` unless a code is
  actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api payload alignment (its content is
  unavailable in this context; deferred, F12).
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (file not present
  in the current tree; the reference comes from the Objective text).

## 4. Requirements

### FR-1 — Failure payload keys (worker)
When document processing fails, the worker's failed status payload `details` must include:
- `error_message`: the actual exception message (`str(e)`),
- `stage`: the pipeline stage executing at failure time,
- `retryable`: deliberately derived (see FR-4).

The payload must never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for these
keys. (Definition facts F1, F3, F4, F5.)

### FR-2 — Stage tracking (worker)
The worker must track the currently executing pipeline stage through `process_document` so the failure
handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary:
`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
`embeddings_complete`. When the stage is genuinely unknown (e.g. failure before the first stage
transition), the safe value is `"processing"` — the same value the stale-lease sweep uses for `error_stage`
— so the field never regresses to null. (F9, Definition requirement 2.)

### FR-3 — Pass-through persistence (rag-api, unchanged)
rag-api's failed branch must persist the worker-provided values unchanged:
- main document `error` ← payload `error_message`
- main document `error_stage` ← payload `stage`
- main document `retryable` ← payload `retryable`
- `processing/summary` error subdocument: `message` ← payload `error_message`, `stage` ← payload `stage`
  (`error.code` remains `"UNKNOWN"` since the worker sends no `error_code`).

No change to rag-api's reads, the persisted field names (`error`, `error_stage`, `retryable`), or the
`Resource`/`ResourceResponse` models. The API-side fallbacks remain in code for non-worker publishers but
must never be the operative mechanism for worker failures. (F4, F6, Definition requirement 3.)

### FR-4 — retryable derivation (worker)
The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified
**transient** by `classify_error(e)` → `retryable: true`; classified **permanent** — including
unclassified-unknown, per `classify_error`'s conservative default — → `retryable: false`. (F7, F8,
Definition requirement 4.)

Deliberate behavior change: unclassified-unknown exceptions currently persist `retryable: true` (the silent
API-side default) but classify as permanent; they will now persist `false`. This is the conservatism
`classify_error` was written for; manual reprocess via `POST /process` (failed → queued transition) is
unaffected.

### FR-5 — Compatibility hedge (worker)
The worker retains the legacy `error` key (same value as `error_message`) in the failure payload alongside
`error_message`, for continuity with any unknown consumers of the status topic and existing log tooling
(F11, constraint "prefer"). Only rag-api's status subscriber is a verified consumer (F11, ASSUMED).

### FR-6 — Contract test (verification)
A contract test must cover the worker failure → rag-api persistence path:
- It exercises the worker's failure-payload construction and rag-api's failed-branch persistence (via the
  Firestore emulator or fakes), asserting the persisted `error`, `error_stage`, and `retryable` equal the
  worker's values.
- It must fail if either side's payload keys drift (worker payload key-set guard; API-side read-key drift
  detected by value-equality assertions, optionally reinforced by a static/AST guard on the failed branch's
  `details.get(...)` keys, following the house pattern in
  `apps/ai-server/tests/integration/test_api_contracts.py`).
- It must cover an early-stage failure and a late-stage failure (representative stages) to pin the stage
  tracker without ossifying every pipeline step. (F10, Definition requirement 5.)

## 5. Constraints (binding)

| # | Type | Constraint |
|---|------|-----------|
| C1 | must | Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema. |
| C2 | must_not | No Firestore migration, field rename, or backfill; persisted fields `error`/`error_stage`/`retryable` keep names and semantics. |
| C3 | must | Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be operative for worker failures. |
| C4 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| C5 | prefer_not | Do not introduce a structured error-code taxonomy; summary `error.code` stays `"UNKNOWN"` unless a code is actually sent. |

## 6. Non-goals
- Changing the stale-lease sweep's direct failure write (already consistent; its `retryable=true` stays
  correct — a dead worker is a transient condition).
- Changing retry/backoff mechanics (Pub/Sub ACK/NACK policy, leases, heartbeats) — only the *reporting* of
  retryability changes.
- Frontend/mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this alignment (content unavailable; deferred).

## 7. Acceptance criteria

- **AC-1**: A failed job's status message published by the worker contains `error_message` (actual exception
  message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on
  rag-api's fallback defaults.
- **AC-2**: After a failed job, the persisted resource document has `error` = the worker's actual error
  message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the
  worker's derived value.
- **AC-3**: The `processing/summary` error subdocument for the failed job carries the same message and stage
  as the main document.
- **AC-4**: A contract test covering the worker failure → rag-api persistence path exists and passes: it
  exercises the worker's failure-payload construction through rag-api's failed-branch persistence and
  asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either
  side's payload keys drift.

## 8. Traceability

| Requirement | Definition facts | Definition constraints |
|-------------|------------------|------------------------|
| FR-1 | F1, F3, F4, F5 | C1, C3 |
| FR-2 | F9 | C1 |
| FR-3 | F4, F6 | C1, C2 |
| FR-4 | F7, F8 | C3 |
| FR-5 | F11 | C4 |
| FR-6 | F10 | C1, C2 |

Deferred (outside bounded scope): companion D3 issue contents (F12); reconciliation with the D4 deviation
note in `plans/upload-flow.md` (file not present in current tree).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api Failure Payload Contract Alignment

## 1. Context

The worker publishes processing status updates to the `rag-status-updates` Pub/Sub topic; rag-api's status
subscriber (`_process_status_message`) consumes them and persists outcomes via `run_transactional_update`.
The two sides were written against different failure contracts:

- **Worker (producer)**: `process_document`'s exception handler publishes
  `details = {"error": str(e)}` (F3).
- **rag-api (consumer)**: the failed branch of `run_transactional_update` reads
  `details.get("error_message", "Processing failed")`, `details.get("stage")`, and
  `details.get("retryable", True)`, persisting them as `error`, `error_stage`, and `retryable` on the main
  resource document, and writes `{"code": details.get("error_code", "UNKNOWN"), "message": ..., "stage": ...}`
  into the `processing/summary` error subdocument (F4; verified in
  `apps/ai-server/rag-api-service/main.py`).

Net effect today: every worker-originated failure persists `"Processing failed"` / `None` / `True` (F5).
The `error`/`error_stage`/`retryable` schema is already established across the worker's stale-lease sweep,
rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse` (F6) — the worker's status
publisher is the only non-conforming writer.

## 2. Design decision: the worker aligns to the API

The worker aligns its payload keys to `error_message`/`stage`/`retryable` — matching rag-api's reads and the
already-established persisted schema (F2). Changing the API side would ripple across three other write
paths and two response models; changing the worker ripples across none. No migration, no backfill, no
reader changes (C1, C2).

**rag-api requires zero code changes.** Its failed branch already reads exactly the keys the worker will
send; the fix is worker-side payload construction plus a contract test that pins the seam.

## 2.1 Target failure payload contract

Worker publishes `status="failed"` via the existing `_publish_status_update` mechanism (envelope keys
`user_id`, `course_id`, `resource_id`, `status`, `details` unchanged). The `details` dict for failures:

| Key | Value | Status |
|-----|-------|--------|
| `error_message` | `str(e)` — actual exception message | new (required) |
| `stage` | pipeline stage at failure time (vocabulary below) | new (required) |
| `retryable` | derived from `classify_error(e)` (see §4.3) | new (required) |
| `error` | `str(e)` — duplicate of `error_message` | retained legacy key (C4, F11) |
| `error_code` | — | **not sent**; summary `error.code` stays `"UNKNOWN"` (C5) |

Mapping through rag-api's failed branch (unchanged reads):

| Worker payload key | rag-api read (unchanged) | Persisted to |
|--------------------|--------------------------|--------------|
| `error_message` | `details.get("error_message", "Processing failed")` | main doc `error`; summary `error.message` |
| `stage` | `details.get("stage")` / `details.get("stage", "unknown")` | main doc `error_stage`; summary `stage`; summary `error.stage` |
| `retryable` | `details.get("retryable", True)` | main doc `retryable` |
| `error` (legacy) | not read by rag-api | not persisted; hedge for unknown topic consumers |

The API-side fallbacks (`"Processing failed"`, `True`) remain in the code for any non-worker publisher, but
must never be operative for worker failures (C3).

## 3. Component changes

### 3.1 rag-worker-service/main.py — stage tracking
`process_document` is one large try block; at failure time nothing knows where execution was (F9). Fix:

- Introduce a local stage tracker (e.g. `current_stage`), initialized to `"processing"` — the safe value
  used by the stale-lease sweep for `error_stage`, so the field never regresses to null.
- **Convention: set the tracker immediately before each pipeline step's `await`**, using the stage name of
  the progress update associated with that step. Stage vocabulary reuses the existing progress-update names:
  `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
  `embeddings_complete` (F9; `completed` is a terminal success state, not a failure stage).
- The exception handler reports the tracker value. A failure before the first transition reports
  `"processing"` — the stage is never null.

Drift risk: a future pipeline step added without updating the tracker reports a stale stage. Mitigated by
the set-before-await convention and representative-stage contract coverage (an early-stage and a late-stage
failure), which catches the tracker being removed or bypassed without ossifying every step.

### 3.2 rag-worker-service/main.py — failure payload construction
The exception handler in `process_document` builds the failure details as a small, pure, importable
construction (recommended: extract a helper so the contract test can call it directly without standing up
the worker loop):

```
classification = classify_error(e)          # existing classifier (F7)
retryable      = classification is transient
details = {
    "error_message": str(e),
    "stage":         current_stage,         # tracker value; "processing" if unknown
    "retryable":     retryable,             # always explicit (C3)
    "error":         str(e),                # legacy key retained (C4)
}
```

The exact shape of `classify_error`'s return (TransientError/PermanentError classes plus type- and
status-code heuristics; unknown → permanent, F7) is confirmed at implement time; the mapping rule is fixed:
**transient-classified → `retryable: true`; permanent-classified, including unclassified-unknown → `retryable: false`** (F8).

The publish mechanism (`_publish_status_update`, status `"failed"`) and the message envelope are unchanged;
only the `details` key set changes.

### 3.3 rag-api-service/main.py — no changes
`run_transactional_update`'s failed branch, `_process_status_message`, the transition table
(`processing → failed`, `failed → queued`), and the persisted schema (`error`, `error_stage`, `retryable`;
summary `error.{code,message,stage}`) are untouched (C1, C2). The `retryable` fallback default remains for
non-worker publishers but is no longer operative for worker failures (C3).

### 3.4 Unchanged by design
- Stale-lease sweep `_fail_if_still_stale`: keeps its direct write of
  `error`/`error_stage`/`retryable=true` — correct, because a dead worker is a transient condition (F8).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, leases, heartbeats — untouched; only the *reporting* of
  retryability changes.
- `Resource` model, `ResourceResponse`, frontend/mobile — already expose `error`/`error_stage`.

## 4. Failure-path data flow (target)

```
process_document (rag-worker)
  ├─ current_stage = "processing"            # init
  ├─ before each pipeline step: current_stage = <stage name>
  ├─ exception raised mid-step
  ├─ except: classification = classify_error(e)
  ├─ details = {error, error_message, stage, retryable}
  └─ _publish_status_update(status="failed", details=details)
          │
          ▼  Pub/Sub: rag-status-updates
rag-api subscriber _process_status_message
  └─ run_transactional_update(new_status="failed", details)
       ├─ main doc:   error ← error_message; error_stage ← stage; retryable ← retryable
       └─ processing/summary:
            stage ← stage; error ← {code: "UNKNOWN", message ← error_message, stage ← stage}
```

Observable outcomes after the fix:
- `error` = the worker's actual exception message (no more `"Processing failed"` fallback).
- `error_stage` = the true failing stage (never `None` for worker failures; `"processing"` when genuinely
  unknown).
- `retryable` = the worker's derived value, aligned with ACK/NACK reality: transient errors are ones Pub/Sub
  will redeliver (`true`); permanent errors were acked and will not return (`false`; manual reprocess via
  `POST /process` — the `failed → queued` transition — remains available).
- Summary `error.message`/`error.stage` match the main document; `error.code` stays `"UNKNOWN"`.

## 5. Behavior changes ledger

| Scenario | Before | After | Rationale |
|---|---|---|---|
| Any worker failure — persisted `error` | `"Processing failed"` (fallback) | actual exception message | FR-1 |
| Any worker failure — persisted `error_stage` | `None` | failing stage (or `"processing"`) | FR-2 |
| Transient-classified failure — `retryable` | `True` (silent default) | `True` (deliberate) | FR-4 |
| Permanent-classified failure — `retryable` | `True` (silent default) | `False` (deliberate) | FR-4 |
| Unclassified-unknown failure — `retryable` | `True` (silent default) | `False` (classify_error's conservative default) | F8; accepted; manual reprocess unaffected |
| Summary `stage` | `"unknown"` (default) | true failing stage | FR-2/FR-3 |
| Summary `error.code` | `"UNKNOWN"` | `"UNKNOWN"` (worker sends no code) | C5 — unchanged |
| Status-topic payload keys | `{error}` | `{error, error_message, stage, retryable}` | FR-1, FR-5 (hedge) |

## 6. Contract test architecture

**Location/pattern**: `apps/ai-server/tests/integration/` — a new focused module alongside
`test_api_contracts.py`, following its established style of importing the service modules directly
(`import main as rag_api_main` pattern) rather than restating the contract in fixtures (F10).

**Both sides imported, not restated:**
1. **Worker side**: build the failure payload through the worker's construction path. Preferred: drive
   `process_document` with a stubbed pipeline dependency that raises at a chosen step, capturing the
   published payload at the `_publish_status_update` seam; this exercises the stage tracker end-to-end.
   Fallback (if `process_document` is not cheaply drivable in-process): call the extracted payload-construction
   helper with an explicit exception and stage. The exact seam is confirmed at implement time against the
   worker's internals.
2. **API side**: feed the captured payload through `run_transactional_update(db, doc_ref, "failed",
   details, ...)` against the Firestore emulator (`FIRESTORE_EMULATOR_HOST` branch — verified present in
   rag-api's startup; both services support hermetic emulator mode per F10) or equivalent fakes.

**Implementation note (verified constraint):** rag-api's existing test conftest fully stubs
`firebase_admin.firestore`, which supports importing `main` but cannot execute real transaction semantics
(`@firestore.transactional`). The persistence leg therefore needs either the Firestore emulator (faithful
transactions; recommended primary) or a purpose-built fake implementing minimal transactional get/update
semantics. This is the main test-infrastructure decision to settle first at implement time.

**Scenarios:**
- **A. Late-stage permanent failure** — seed resource doc (canonical path `users/{uid}/resources/{rid}`) with
  `status: "processing"` (a valid transition source into `failed`); worker payload built from a
  permanent-classified exception at stage `tagging_complete`; assert persisted main-doc `error` == payload
  `error_message`, `error_stage` == `"tagging_complete"`, `retryable` is `False`; summary `error.message`/`error.stage`
  match; summary `error.code` == `"UNKNOWN"`. Choosing `retryable=False` is load-bearing: it proves the value
  came from the payload, not the API's `True` fallback.
- **B. Early-stage transient failure** — transient-classified exception at stage `text_retrieved`; assert
  persisted values equal payload, `retryable` is `True`.
- **C. Unknown-stage safety** — failure before any tracker transition; assert persisted `error_stage` ==
  `"processing"` (never null).

**Drift guards:**
- *Worker-side*: exact key-set assertion on the constructed payload —
  `set(details) == {"error", "error_message", "stage", "retryable"}`. Adding or removing a key fails the build.
- *API-side*: the value-equality assertions in A–C catch read-key renames (a renamed read key yields the
  `"Processing failed"`/`None`/`True` fallbacks, which differ from the worker's values). Optionally reinforced
  with a house-style AST check that `run_transactional_update`'s failed branch reads exactly
  `{error_message, stage, retryable, error_code}` from `details` — cheap, and matches the existing
  AST-based contract tests.

## 7. Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining the legacy
  `error` key (C4, F11); residual risk accepted as low. Dropping the duplicate later is trivial cleanup
  pending a consumer audit.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the set-before-await convention and
  representative-stage test coverage.
- **`retryable=false` for unclassified-unknown errors** reduces auto-retry affordances for genuinely
  transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope and manual
  reprocess via `POST /process` remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key
  later means touching the test, which is the point.

## 8. Out of scope

Structured error codes (summary `error.code` stays `"UNKNOWN"`); retry/backoff mechanics (ACK/NACK policy,
leases, heartbeats); the stale-lease sweep's behavior; frontend/mobile work (`ResourceResponse` already
exposes `error`/`error_stage`); the companion D3 issue's scope beyond this alignment (unavailable here;
deferred); reconciling with the D4 deviation note in `plans/upload-flow.md` (file not present in the current
tree).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>