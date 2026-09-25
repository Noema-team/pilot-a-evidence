Design complete. Basis: the pinned definition (authoritative), plus directly verified evidence — rag-api's `run_transactional_update` failed branch and emulator startup branch (`rag-api-service/main.py`), the `Resource` model's `error`/`error_stage`/`retryable` fields (`models/resource.py`), the fixture/AST contract-test patterns in `tests/integration/test_api_contracts.py`, the worker's hermetic stub conftest (`rag-worker-service/tests/conftest.py`), and the verified directory layout of both services. Worker-internals claims (F3, F5–F7, F9) rest on the authoritative definition. Unavailable items (companion D3 issue, `plans/upload-flow.md`) are preserved as unknown/deferred.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

Authoritative source: Definition artifact `definition:obj-108` (WorkItem `wi-define-108-a8`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document restates that bounded scope as implementable, testable requirements. It does not widen, narrow, or reinterpret the Definition; where the Definition is binding, this document is restatement.

## 1. Problem statement

The rag-worker's failure publisher and rag-api's failure consumer were written against different payload contracts, and no test covers the seam.

- The worker's `process_document` exception handler publishes failed status with a one-key payload: `{"error": str(e)}` (Definition F3).
- rag-api's failed branch in `run_transactional_update` reads three keys and persists them (verified in `apps/ai-server/rag-api-service/main.py`):
  - `error` ← `details.get("error_message", "Processing failed")`
  - `error_stage` ← `details.get("stage")`
  - `retryable` ← `details.get("retryable", True)`
  - and writes the `processing/summary` error subdocument as `{code: details.get("error_code", "UNKNOWN"), message: details.get("error_message", "Processing failed"), stage: details.get("stage")}`.
- Because of the key mismatch, every worker-originated failure persists the fallback string `"Processing failed"`, `error_stage: null`, and a fabricated `retryable: true` (Definition F5). The summary error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

The persisted failure schema (`error`, `error_stage`, `retryable`) is already consistent across three other write paths — the worker's stale-lease sweep, rag-api's enqueue-failure paths (`/process`, `POST /resources`) — and is exposed by the `Resource` model and `ResourceResponse` (Definition F6; `Resource` fields verified in `apps/ai-server/rag-api-service/models/resource.py`, including `retryable: bool = True`). The worker's status publisher is the only writer that does not speak this contract.

## 2. Scope

### 2.1 In scope
- The worker's failed-status payload keys and values (`error_message`, `stage`, `retryable`, plus the retained legacy `error` key).
- Stage tracking inside `process_document` so the failure handler can report the true failing stage.
- Deliberate derivation of `retryable` from the worker's existing error classification.
- A contract test covering the worker failure → rag-api persistence path, including a key-set drift guard.

### 2.2 Out of scope / non-goals (binding, from Definition)
- Changing the stale-lease sweep's direct failure write (already consistent).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals. Only the *reporting* of retryability changes.
- Frontend or mobile changes (`ResourceResponse` already exposes `error` and `error_stage`).
- Introducing structured error codes or a failure taxonomy; `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context; deferred).
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (that file is not present in the current tree; the reference comes from the Objective text).

## 3. Functional requirements

### FR-1 — Worker failure payload keys
When document processing fails, the worker's failed status payload published via `_publish_status_update` MUST include:
- `error_message` — the actual exception message (`str(e)` of the caught exception);
- `stage` — the pipeline stage executing at failure time, as a non-null string;
- `retryable` — a deliberately derived boolean (see FR-4).

The payload MUST also retain the legacy `error` key, set to the same string as `error_message` (adopted hedge per Definition F11 and the prefer-constraint on consumer continuity).

The payload MUST NOT rely on rag-api's fallback defaults for any of `error_message`, `stage`, or `retryable`: after this change, no worker-originated failure may persist `"Processing failed"`, a null stage, or a defaulted `retryable` because a key was absent.

### FR-2 — Stage tracking in `process_document`
- `process_document` MUST maintain a current-stage tracker (a local variable) that the exception handler reads at failure time.
- The tracker MUST be set immediately before each pipeline step executes (the "set before the await" convention).
- Stage names MUST reuse the existing progress-status vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. No new stage names may be invented for failure reporting.
- When the stage is genuinely unknown (e.g., failure before the first transition), the tracker MUST report `"processing"` — the same safe value the stale-lease sweep uses for `error_stage` — so `error_stage` never regresses to null.

### FR-3 — rag-api persistence mapping (unchanged behavior, pinned)
rag-api's failed branch MUST persist worker-provided values unchanged:
- main document: `error` ← payload `error_message`; `error_stage` ← payload `stage`; `retryable` ← payload `retryable`;
- `processing/summary` error subdocument: `message` ← payload `error_message`; `stage` ← payload `stage`; `code` remains `"UNKNOWN"` (the worker sends no `error_code`).

rag-api's reads and persisted schema MUST NOT change (constraint: worker aligns to the API, not vice versa). The API-side fallbacks (`"Processing failed"`, `retryable` default `True`) remain in code for the enqueue-failure paths but MUST NOT be the operative mechanism for worker failures.

### FR-4 — retryable derivation
- The worker MUST set `retryable` from `classify_error(e)` — the same classification that drives ACK/NACK in `run_worker`:
  - errors classified transient → `retryable: true`;
  - errors classified permanent, including unclassified-unknown exceptions (per `classify_error`'s conservative default) → `retryable: false`.
- Every worker-originated failure payload MUST carry `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must never be operative for worker failures.
- The stale-lease sweep's separate `retryable: true` write is unchanged and remains correct (a dead worker is a transient condition).

### FR-5 — Contract test on the worker → rag-api failure path
A contract test MUST exist and pass that:
- exercises the worker's failure-payload construction through its real code path (not a restated fixture), and feeds the resulting payload through rag-api's `run_transactional_update` failed-branch persistence, using the Firestore emulator or fakes;
- asserts the persisted main-document `error`, `error_stage`, and `retryable` equal the worker's payload values, and that the `processing/summary` error subdocument carries the same message and stage;
- includes a key-set drift guard that fails the build if either side's payload keys change (worker publish keys; rag-api read keys);
- pins the stage tracker on representative stages: at least one early-stage failure and one late-stage failure;
- pins the retryable derivation with at least one transient-classified exception (expect `true`) and one permanent-classified exception, plus an unclassified-unknown exception (expect `false`).

### FR-6 — No schema migration
The fix MUST NOT require a Firestore migration, field rename, or backfill of existing documents. The persisted field names `error`, `error_stage`, `retryable` keep their names and semantics.

## 4. Constraints (binding, from Definition)

| Type | Constraint |
|---|---|
| must | Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema. |
| must_not | No Firestore migration, field rename, or backfill of existing documents. |
| must | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side fallback must not be operative for worker failures. |
| prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## 5. Acceptance criteria

| ID | Criterion (from Definition) | Satisfied by |
|---|---|---|
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | FR-1, FR-2, FR-4; verified by FR-5 test |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not null), and `retryable` = the worker's derived value. | FR-3, FR-4; verified by FR-5 test |
| AC-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | FR-3; verified by FR-5 test |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes, exercising the worker's failure-payload construction through rag-api's failed-branch persistence and asserting the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | FR-5 |

## 6. Deferred and unknown (preserved, not invented)

- **Companion D3 issue**: referenced by the Objective; its content is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is out of scope (Definition F12).
- **`plans/upload-flow.md`**: not present in the current tree; the D4 deviation reference cannot be reconciled here and is deferred.
- **Status-topic consumer audit**: only rag-api's status subscriber is a verified consumer of worker failure payloads (Definition F11, assumed hedge). A full audit of other readers of `rag-status-updates` is deferred; the legacy `error` key is retained as insurance in the meantime.
- **`classify_error` interface shape**: the Definition pins its semantics (transient vs. permanent; unknown → permanent) and its use in `run_worker` ACK/NACK. The exact return shape (boolean/enum/class) is to be confirmed against `apps/ai-server/rag-worker-service/main.py` / `exceptions.py` at build time; the derivation reuses whatever classification the ACK/NACK decision already consumes, mapped transient→`true`, permanent→`false`.

## 7. Verification matrix

| Requirement | Verified by |
|---|---|
| FR-1 | Contract test: worker payload key-set drift guard + value assertions |
| FR-2 | Contract test: early-stage and late-stage failure cases assert reported stage |
| FR-3 | Contract test: persisted main doc + summary subdoc equal worker values; rag-api code unchanged (diff review) |
| FR-4 | Contract test: transient → `true`; permanent → `false`; unknown → `false` |
| FR-5 | The contract test itself (new module under `apps/ai-server/tests/integration/`) |
| FR-6 | No migration artifacts in change set; persisted field names unchanged (diff review + existing `Resource` model tests) |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure contract alignment

## 1. System context (as-is)

Failure-path data flow today:

```
rag-api (/process, POST /resources)
   │  publish to Pub/Sub topic "vector-process"
   ▼
rag-worker  run_worker → process_document
   │  exception handler → _publish_status_update(status="failed",
   │                       details={"error": str(e)})          ← the mismatch
   ▼
Pub/Sub topic "rag-status-updates"  (sub: "rag-status-updates-sub")
   │
   ▼
rag-api status subscriber → run_transactional_update(db, doc_ref, "failed", details, …)
   │  reads error_message / stage / retryable  (verified)
   ▼
Firestore: users/{uid}/resources/{rid}
   ├── main doc:      error, error_stage, retryable, status="failed"
   └── processing/summary: error{code, message, stage}
```

The mismatch, concretely (worker key → rag-api read → persisted result today):

| Worker publishes | rag-api reads | Persisted today |
|---|---|---|
| `error` = str(e) | `error_message` (missing) | `error` = `"Processing failed"` (fallback) |
| — | `stage` (missing) | `error_stage` = `null`; summary `stage` = `null` |
| — | `retryable` (missing) | `retryable` = `True` (silent default) |
| — | `error_code` (missing) | summary `error.code` = `"UNKNOWN"` |

Verified anchors in the tree:
- `apps/ai-server/rag-api-service/main.py` — `run_transactional_update` failed branch reads `error_message`/`stage`/`retryable` with the fallbacks above; `ALLOWED_TRANSITIONS` permits `processing → failed` and `failed → queued`; startup has a `FIRESTORE_EMULATOR_HOST` hermetic branch.
- `apps/ai-server/rag-api-service/models/resource.py` — `Resource` persists `error`, `error_stage`, `retryable` (default `True` on read).
- `apps/ai-server/tests/integration/test_api_contracts.py` — house contract-test patterns: direct `import main as rag_api_main`, fixture JSON contracts, and AST/subprocess shape extraction.
- `apps/ai-server/rag-worker-service/tests/conftest.py` — hermetic import pattern for the worker: `sys.modules` stubs for `google.cloud.*`, `firebase_admin.*`, langchain, openai, etc.
- Worker internals per the authoritative Definition (F3, F5–F7, F9): `process_document` exception handler publishes `{"error": str(e)}`; `classify_error()` classifies transient/permanent (unknown → permanent) and drives ACK/NACK in `run_worker`; progress updates already use the stage vocabulary; the stale-lease sweep (`_fail_if_still_stale`) writes `error`/`error_stage`/`retryable` directly with stage `"processing"`.

## 2. Design principles

1. **Fix the odd writer out.** The persisted schema (`error`/`error_stage`/`retryable`) is consistent across the sweep, both enqueue-failure paths, and two response models. The worker's status publisher is the single deviant writer. Aligning it requires no migration, no backfill, and no reader changes.
2. **Derive, don't default.** `retryable` must be a deliberate output of the worker's existing classification, never a silent API-side default.
3. **Test the seam, not a copy of it.** The contract test imports both sides and runs the real construction → persistence path; it does not restate the contract in a fixture.
4. **Zero schema change.** Persisted field names and semantics are frozen.

## 3. Target failure payload contract

The worker's failed-status payload (`details` passed to `_publish_status_update` with status `"failed"`):

| Key | Type | Required | Source | Consumed by rag-api as |
|---|---|---|---|---|
| `error_message` | string | yes | `str(e)` of the caught exception | main `error`; summary `error.message` |
| `stage` | string | yes | stage tracker (FR-2) | main `error_stage`; summary `error.stage` |
| `retryable` | bool | yes | derived from `classify_error(e)` (§6) | main `retryable` |
| `error` | string | yes (legacy hedge) | same string as `error_message` | none (compatibility only) |
| `error_code` | — | not sent | — | summary `error.code` stays `"UNKNOWN"` |

Pinned key set (drift guard target): `{error, error_message, stage, retryable}`.

## 4. Component changes

### 4.1 rag-worker: stage tracker in `process_document`
- Add a local `current_stage`, initialized to `"processing"`.
- Immediately before each pipeline step's await, set `current_stage` to that step's vocabulary name. Binding rule is the convention ("set the tracker immediately before the await"), not any particular call-site list. Indicative application against the existing progress vocabulary:
  - job start → `starting`
  - text extraction → `text_retrieved`
  - content tagging → `tagging_complete`
  - summary generation → `summary_generated`
  - chunking → `chunking_complete`
  - embedding generation → `embeddings_complete`
- The exception handler reads `current_stage` and reports it as `stage`. Failure before the first transition reports `"processing"` (never null).
- Drift risk: a future pipeline step added without updating the tracker reports a stale stage. Mitigation: the convention plus representative-stage contract coverage (early + late failure). The test intentionally does not ossify every step.

### 4.2 rag-worker: failure payload construction
In the `process_document` exception handler, replace the one-key payload with:

```python
message = str(e) or type(e).__name__   # an empty message is not an "actual" message
details = {
    "error_message": message,
    "stage": current_stage,
    "retryable": is_transient(classify_error(e)),  # transient→True, permanent/unknown→False
    "error": message,                              # legacy key retained (hedge)
}
```

- `is_transient(...)` is a thin adapter over whatever shape `classify_error` already returns for the ACK/NACK decision in `run_worker` (see Requirements §6, unknown item). It must not re-implement classification.
- Publication continues through the existing `_publish_status_update` with status `"failed"`; no new topic, no new message envelope.
- No `error_code` is sent; summary `error.code` remains `"UNKNOWN"`.

### 4.3 rag-api: zero functional change
- The failed branch already maps `error_message → error`, `stage → error_stage`, `retryable → retryable` and writes the summary subdocument accordingly (verified). No code change on the API side.
- The fallbacks (`"Processing failed"`, `retryable=True`, `stage=None`) remain in place for the enqueue-failure paths (`/process`, `POST /resources`), which are out of scope; after this change they are simply never operative for worker-originated failures.
- The existing behavior is pinned from the outside by the contract test (§8), so a future edit to rag-api's read keys fails the build.

### 4.4 Unchanged writers (consistency check)
- Stale-lease sweep (`_fail_if_still_stale`): keeps its direct write of `error`/`error_stage`/`retryable` with stage `"processing"` and `retryable=true` — consistent with this contract; a dead worker is transient by nature.
- Enqueue-failure paths in rag-api: unchanged.

## 5. To-be failure flow

```
process_document
  │ current_stage = "starting" … "embeddings_complete"   (set before each await)
  │ exception raised
  ▼
exception handler
  │ classification = classify_error(e)          (same call used for ACK/NACK)
  │ details = {error_message, stage: current_stage, retryable, error(legacy)}
  │ _publish_status_update("failed", details)
  ▼
Pub/Sub "rag-status-updates"
  ▼
rag-api subscriber → run_transactional_update("failed", details)
  │ main:      error ← error_message; error_stage ← stage; retryable ← retryable
  │ summary:   error{code:"UNKNOWN", message ← error_message, stage ← stage}
  ▼
Firestore persisted with the worker's true message, stage, and derived retryability
  ▼
run_worker ACK/NACK per classification (unchanged mechanics):
  transient → NACK → Pub/Sub redelivers (retryable=true is truthful)
  permanent → ACK   → no redelivery; manual reprocess via POST /process (retryable=false is truthful)
```

## 6. retryable derivation semantics

| `classify_error(e)` outcome | `retryable` | Pub/Sub outcome (unchanged) | User affordance |
|---|---|---|---|
| transient | `true` | NACK → redelivery | automatic retry |
| permanent | `false` | ACK → no redelivery | manual reprocess via `POST /process` |
| unclassified-unknown (conservative default: permanent) | `false` | ACK → no redelivery | manual reprocess via `POST /process` |

Deliberate behavior change: unclassified-unknown exceptions previously persisted `retryable: true` (the silent default) but classify as permanent; they will now persist `false`. This aligns the persisted record with actual ACK/NACK behavior and prevents fabricated auto-retry affordances. Widening `classify_error` to recognize more transient shapes is out of scope.

## 7. Compatibility and rollout

- **Legacy key hedge**: `error` is retained alongside `error_message` (one redundant string per failure message) so any unknown consumer of the status topic or log tooling keyed on the old payload keeps working. `error_message` is the single source of truth; `error` duplicates it. If a later audit confirms rag-api is the only consumer, dropping the duplicate is trivial cleanup.
- **No migration/backfill**: existing failed documents are untouched; the change affects only new failure writes. Old documents keep whatever fallback values they already persisted.
- **Consumers**: only rag-api's status subscriber is a verified consumer. Consumer audit is deferred (Requirements §6).

## 8. Contract test architecture

**Location**: new module alongside the house contract tests, e.g. `apps/ai-server/tests/integration/test_rag_failure_contract.py`, reusing the existing `conftest.py` and the patterns verified in `test_api_contracts.py`.

**Imports both sides — no restated fixture:**
- Worker side: import the worker's `main` under the hermetic stub pattern already proven in `apps/ai-server/rag-worker-service/tests/conftest.py` (`sys.modules` stubs for `google.cloud.*`, `firebase_admin.*`, langchain, openai, spacy, tiktoken, tenacity).
- rag-api side: `import main as rag_api_main` (already proven in `test_api_contracts.py`).

**Exercise the real path:**
1. Build a synthetic `ProcessingMessage` (model verified in `rag-worker-service/models/pubsub_messages.py`).
2. Invoke `process_document` with one pipeline dependency monkeypatched to raise at a chosen point; capture the `details` dict passed to `_publish_status_update` via a fake publisher.
3. Feed the captured payload verbatim into `rag_api_main.run_transactional_update` with status `"failed"`, against either:
   - the **Firestore emulator** (preferred: real transactional semantics; rag-api's startup already supports `FIRESTORE_EMULATOR_HOST` + `GCP_PROJECT`, verified), or
   - a **fake db/doc_ref** implementing the `@firestore.transactional` + `get(transaction=…)` surface (fallback if the emulator is unavailable in CI).

**Cases and assertions:**

| Case | Injected failure | Assert |
|---|---|---|
| Early-stage, transient-classified exception | raise during text extraction | payload `stage` == early vocabulary name; persisted `error` == `str(exc)`, `error_stage` == stage, `retryable` is `True`; summary `error.message`/`error.stage` match |
| Late-stage, permanent-classified exception | raise during embedding generation | payload `stage` == late vocabulary name; persisted values equal worker's; `retryable` is `False` |
| Unclassified-unknown exception | raise bare `RuntimeError("…")` at a known stage | persisted `retryable` is `False` (conservative default) |
| Key-set drift guard (worker) | every case above | `set(payload) == {"error", "error_message", "stage", "retryable"}` — exact equality |
| Key-set drift guard (rag-api) | static, AST-based (house `_get_agent_graph_shapes` pattern) | `run_transactional_update`'s failed branch reads exactly `error_message`, `stage`, `retryable` (plus optional `error_code`) via `details.get(...)` |

The drift guards are the point of the test: adding or renaming a key on either side must fail the build rather than silently re-create this bug.

## 9. Risks and mitigations

| Risk | Mitigation | Residual |
|---|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained; `error_message` is authoritative | Accepted as low; audit deferred |
| Stage-tracker drift as the pipeline evolves | "Set before the await" convention documented in code; representative early/late-stage test coverage | A new untracked step reports a stale (but non-null) stage |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted per Definition F8; manual reprocess via `POST /process` unaffected; widening `classify_error` is out of scope | Accepted |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key means touching the test | None (by design) |
| Emulator unavailable in CI | Fake db/doc_ref fallback implementing the transactional surface | Slightly weaker fidelity than the emulator |

## 10. Future work (explicitly not this change)

- Drop the legacy `error` key once a consumer audit confirms rag-api is the sole reader.
- Structured error-code taxonomy (currently `prefer_not`; summary `error.code` stays `"UNKNOWN"`).
- Widen `classify_error`'s transient heuristics if unknown-exception misclassification is observed in practice.
- Reconcile with the original D4 deviation note if `plans/upload-flow.md` reappears; ingest the companion D3 issue's scope if it becomes available.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>