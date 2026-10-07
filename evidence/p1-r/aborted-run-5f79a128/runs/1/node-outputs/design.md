Design complete. Both contracted artifacts follow, derived strictly from the repository evidence verified during investigation (worker `main.py`, rag-api `main.py`, `models/resource.py`, and the existing contract-test infrastructure), with unverified items explicitly marked.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` (definition artifact `definition:obj-108`, sha256 `71f1c39c…`)
Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

## 1. Overview

A failed RAG processing job must persist the worker's actual error message, the failing pipeline
stage, and a deliberately derived retryable flag. Today the worker publishes a one-key failure
payload (`{"error": str(e)}`) while rag-api's failed branch reads `error_message`, `stage`, and
`retryable`; the mismatch makes every worker-originated failure persist as the fallback string
"Processing failed", a null `error_stage`, and a silently defaulted `retryable: true`. The fix
aligns the worker to rag-api's existing contract. No API-side reads, persisted schema, or
migrations change.

## 2. Verified problem statement

- Worker (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler):
  publishes `status="failed"` with details `{"error": str(e)}` via `_publish_status_update`.
- API (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch):
  reads `details.get("error_message", "Processing failed")`, `details.get("stage")`,
  `details.get("retryable", True)`; persists `error`, `error_stage`, `retryable` on the main
  resource document; writes `stage` and `error = {code: error_code|"UNKNOWN", message, stage}`
  into the `processing/summary` subdocument.
- Consequence (verified): every worker failure persists `error="Processing failed"`,
  `error_stage=None`, `retryable=True` (silent default), and summary `error.code="UNKNOWN"`.
- The persisted failure schema `error` / `error_stage` / `retryable` is already written correctly
  by three other paths — the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's
  enqueue-failure path in `POST /process` — and is exposed by the `Resource` model
  (`models/resource.py`, `retryable` defaults `True`) and `ResourceResponse` (`error`,
  `error_stage`). The worker's status publisher is the only non-conforming writer.
- The worker's exception handler has no stage tracking today; `process_document` is one large
  try block, so the failing stage is unknowable at failure time.

## 3. Scope

In scope: the worker's failure-status payload construction (keys, values, stage tracking,
retryable derivation) and the contract test that pins the worker→rag-api failure seam.

Out of scope: see §12 (Non-goals). Deferred: see §13.

## 4. Functional requirements

### FR-1 — Failure payload contents (must)
When document processing fails, the worker's failed-status `details` payload MUST contain,
populated from actual runtime values and never relying on rag-api's fallback defaults:

| Key | Value | Rule |
|---|---|---|
| `error_message` | `str(e)` — the actual exception message | MUST be the real message, non-empty in practice |
| `stage` | the pipeline stage executing at failure time | see FR-2 vocabulary; `"processing"` when genuinely unknown |
| `retryable` | boolean derived from `classify_error(e)` | see FR-3; MUST always be present and explicit |
| `error` | duplicate of `error_message` | legacy key retained for unknown topic consumers (see FR-5) |

The existing `_publish_status_update` behavior is otherwise unchanged: it may add `jobId` to
details when a `job_id` is present, and continues to attach `sequence`, `timestamp`, and renew
the processing lease. Those behaviors are out of scope and MUST NOT regress.

### FR-2 — Stage tracking (must)
- `process_document` MUST maintain the currently executing pipeline stage in a tracker that the
  exception handler reads when building the failure payload.
- Convention: the tracker is set immediately before the await of each pipeline step, to the
  progress-stage label published when that step completes. The label therefore denotes the
  pipeline phase in progress at failure time.
- Stage vocabulary MUST reuse the existing progress-stage names exactly:
  `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
  `embeddings_complete`. No new stage names may be introduced by this fix.
- The tracker's initial value — and the value used whenever the stage is genuinely unknown
  (e.g., failure before the first assignment) — MUST be `"processing"`, matching the stale-lease
  sweep's `error_stage` value, so `error_stage` never regresses to null.
- Known granularity boundary (accepted): failures after the `embeddings_complete` publish but
  before the terminal `completed` publish (old-vector deletion, chunk storage, metadata save,
  final publish) report `"embeddings_complete"`, the last assigned vocabulary label. Failures
  during request validation report `"starting"`.

### FR-3 — Retryable derivation (must)
- The worker MUST set `retryable` from `classify_error(e)` — the same classification that drives
  ACK/NACK in `run_worker`. Verified mapping:
  - `TransientError` instances → `True`
  - `httpx.ConnectError`, `ConnectTimeout`, `ReadTimeout`, `WriteTimeout`, `PoolTimeout`,
    `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` → `True`
  - `httpx.HTTPStatusError` with status 429, 500, 502, 503, 504 → `True`
  - `httpx.HTTPStatusError` with any other (4xx) status → `False`
  - `PermanentError` instances → `False`
  - Any other (unclassified-unknown) exception → `False` (classify_error's conservative default)
- Rationale (adopted assumption F8): aligns the persisted record with actual retry behavior —
  transient errors are NACKed and redelivered by Pub/Sub; permanent errors are acked and require
  manual reprocess via `POST /process` (which exists and permits `failed → queued`).
- Deliberate behavior change, accepted: unclassified-unknown exceptions previously persisted
  `retryable=True` via the API's silent default and will now persist `False`.

### FR-4 — API-side persistence invariant (must, zero API changes)
rag-api's failed branch MUST persist worker-provided values unchanged:
- main document: `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`
- `processing/summary`: `stage ← stage`; `error.message ← error_message`; `error.stage ← stage`;
  `error.code ← error_code` when sent, else `"UNKNOWN"` (this fix sends no `error_code`).

This is an invariant, not a change request: rag-api's `run_transactional_update` is verified to
already behave this way. No rag-api source changes are required; the contract test proves the
invariant holds for the aligned payload.

### FR-5 — Compatibility hedge (prefer, adopted)
The worker's failure payload MUST retain the legacy `error` key alongside `error_message`, with
the same string value, for continuity with any unverified consumers of the status topic and
existing log tooling (assumption F11). Dropping it later is trivial cleanup after a consumer
audit.

### FR-6 — Contract test (must)
A contract test MUST cover the worker failure → rag-api persistence path:
- It MUST exercise the worker's real failure-payload construction (imported code, not a
  restatement of the contract in a fixture) and rag-api's real `run_transactional_update`
  failed-branch persistence (via fakes or the Firestore emulator).
- It MUST assert the persisted `error`, `error_stage`, and `retryable` equal the worker's payload
  values, and that the summary subdocument carries the same message and stage with
  `error.code == "UNKNOWN"`.
- It MUST fail if either side's payload keys drift (see architecture §8 for the three-layer
  drift-guard design).
- It MUST cover at least: an early-stage failure, a late-stage failure, the unknown-stage
  (`"processing"`) case, and both retryable polarities (transient→`True`, permanent/unknown→`False`).
- It MUST seed the fake resource document with `status="processing"` so the API's transition
  guard (`processing → failed`) admits the write (verified guard semantics; in production the
  worker's claim transaction already sets `processing` before any failure can occur).

## 5. Constraints (binding, from the authoritative definition)

- MUST: align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`) —
  not change rag-api's reads or persisted schema.
- MUST NOT: require a Firestore migration, field rename, or backfill; persisted fields
  (`error`, `error_stage`, `retryable`) keep their names and semantics.
- MUST: every worker-originated failure payload carries `retryable` explicitly; the API-side
  `details.get("retryable", True)` fallback MUST NOT be the operative mechanism for worker failures.
- PREFER: retain the legacy `error` key alongside `error_message`.
- PREFER NOT: introduce a structured error-code taxonomy (`error_code` values) in this fix.

## 6. Acceptance criteria

| # | Criterion (from definition) | Verified by |
|---|---|---|
| A1 | Worker's failed-status message contains `error_message` (actual exception message), `stage` (failing stage), `retryable` (deliberately derived) — none relying on rag-api fallbacks | Contract test, worker-side payload assertions + builder key-set pin |
| A2 | Persisted resource document has `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = worker's derived value | Contract test, main-document assertions |
| A3 | `processing/summary` error subdocument carries the same message and stage as the main document | Contract test, summary-subdocument assertions |
| A4 | Contract test covering worker failure → rag-api persistence exists and passes, failing on key drift on either side | Contract test presence + three-layer drift guards (architecture §8) |

## 7. Verification notes

- The contract test lives in the established cross-service seam home:
  `apps/ai-server/tests/integration/test_api_contracts.py` (its conftest already imports rag-api
  `main` with cloud-SDK mocks; an AST-subprocess pattern exists for static shape checks).
- The worker side is made importable for tests via a dependency-light module (see architecture
  §3.1); the test imports it directly with no heavy-SDK mocks.
- rag-api's `run_transactional_update` is a module-level function with a narrow Firestore surface
  (verified): `db.transaction()`, `@firestore.transactional`, `doc_ref.get(transaction=…)`,
  `transaction.update(doc_ref, dict)`, `transaction.set(summary_ref, dict, merge=True)`,
  `doc_ref.collection("processing").document("summary")` — all fakeable with the house
  FakeDoc/FakeRef pattern.

## 8. Non-goals

- Changing the stale-lease sweep's direct failure write (already contract-consistent:
  `error`/`error_stage="processing"`/`retryable=True`; a dead worker is transient by nature).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat
  intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy — summary `error.code` remains
  `"UNKNOWN"` unless a code is actually sent (none is).
- Any scope the companion D3 issue covers beyond this payload alignment (unavailable here).

## 9. Assumptions and deferred items

- ASSUMED (F8, adopted): retryable derivation from `classify_error` as specified in FR-3,
  including `False` for unclassified-unknown exceptions.
- ASSUMED (F11, adopted): legacy `error` key retained as a hedge; no consumer other than rag-api's
  status subscriber is verified.
- DEFERRED (F12): the companion D3 issue referenced by the Objective (content unavailable in this
  context); reconciling this analysis with deviation D4 in `plans/upload-flow.md` (file not
  present in the current tree).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

## 1. Design direction

The worker aligns to rag-api's contract; rag-api does not move. The persisted failure schema
(`error`, `error_stage`, `retryable`) is already written consistently by the stale-lease sweep,
rag-api's enqueue-failure path, and the `Resource` model — the worker's status publisher is the
only divergent writer. Fixing the worker is the change that ripples nowhere: no migration, no
backfill, no reader changes.

## 2. The seam today (verified)

```
process_document (worker)                    run_transactional_update (rag-api)
  except Exception as e:                        failed branch reads:
    publish("failed", {"error": str(e)})  ──✗──   error_message  → main.error      (fallback "Processing failed")
                                                  stage          → main.error_stage (fallback None)
                                                  retryable      → main.retryable   (fallback True)
                                                                  summary.stage, summary.error{code|UNKNOWN,message,stage}
```

Transport: worker `_publish_status_update` → Pub/Sub `RAG_STATUS_TOPIC` → rag-api subscriber
`_process_status_message` → `run_transactional_update` → Firestore. The publisher passes
`details` through verbatim (adding only `jobId`/`sequence`/`timestamp` and renewing the lease),
so the fix is confined to what the exception handler puts in `details`.

## 3. Worker changes (`apps/ai-server/rag-worker-service/`)

### 3.1 New dependency-light module: `failure_payload.py`

A small module with stdlib + `httpx` imports only, containing code mechanically moved out of
`main.py` plus the new payload builder:

- `TransientError`, `PermanentError` — moved verbatim (verified: used only by `classify_error`;
  no other references in `main.py`).
- `classify_error(e) -> bool` — moved verbatim, semantics unchanged (transient types, 5xx/429 →
  True; 4xx, PermanentError, unknown → False). `main.py` imports it back
  (`from failure_payload import classify_error, TransientError, PermanentError`) so `run_worker`'s
  ACK/NACK logic is untouched.
- `UNKNOWN_STAGE = "processing"` and the stage vocabulary constants
  (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
  `embeddings_complete`).
- `build_failure_details(error_message: str, stage: str, retryable: bool) -> Dict[str, Any]` —
  returns exactly:
  ```python
  {"error_message": error_message, "error": error_message, "stage": stage, "retryable": retryable}
  ```
  The legacy `error` key is the compatibility hedge (F11).

Rationale for extraction: `main.py` is import-hostile (module-level `os.environ["GCP_PROJECT"]`,
Pub/Sub subscriber construction, and heavy ML imports: langchain, spacy, sklearn, tiktoken,
langfuse, openai). A dependency-light module lets the contract test import and execute the real
builder with zero SDK mocks. The alternative — extending `tests/integration/conftest.py`'s mock
list to import all of `main.py` — was rejected as fragile (the conftest's own comment warns every
new cloud dependency must be hand-added).

### 3.2 Stage tracking in `process_document`

A local `current_stage` variable, initialized to `UNKNOWN_STAGE` (`"processing"`) before the
try block, set immediately before each pipeline await to the label published on that step's
completion:

| Set before | Value |
|---|---|
| `_validate_processing_request` (and the "starting" publish) | `starting` |
| `_get_extracted_text` | `text_retrieved` |
| `content_tagger.generate_tags` | `tagging_complete` |
| `generate_document_summary` + doc update | `summary_generated` |
| `_create_enhanced_chunks` | `chunking_complete` |
| `_generate_embeddings_with_openrouter` | `embeddings_complete` |

Semantics: the label denotes the pipeline phase in progress at failure time (the vocabulary is
completion-labeled; the tracker names the phase being executed). Accepted granularity boundary:
failures between the `embeddings_complete` publish and the terminal `completed` publish
(old-vector deletion, chunk storage, metadata save, final publish) report
`embeddings_complete`; failures before the first assignment report `processing`. `completed` is
never assigned to the tracker — it is a success label, not a failure stage.

### 3.3 Exception-handler wiring

The `process_document` except block replaces the one-key publish:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    ...
    details = build_failure_details(str(e), current_stage, classify_error(e))
    await self._publish_status_update(user_id, course_id, resource_id, "failed", details, job_id)
```

`_publish_status_update` itself is unchanged (it already forwards `details` verbatim and adds
`jobId` when a job id exists — an allowed extra key the API's failed branch ignores).

### 3.4 Unchanged worker surfaces

`run_worker` ACK/NACK (still `classify_error`), `_fail_if_still_stale` (already writes
`error`/`error_stage="processing"`/`retryable=True` — a dead worker is transient by nature),
lease/heartbeat mechanics, sequence numbering, and the progress-publish timeline.

## 4. rag-api changes

None. `run_transactional_update`'s failed branch already implements FR-4 exactly (verified):
main doc `error`/`error_stage`/`retryable` from `error_message`/`stage`/`retryable`; summary
`stage` plus `error = {code: error_code|"UNKNOWN", message, stage}`. The aligned payload flows
through unchanged. No `error_code` is sent, so `error.code` remains `"UNKNOWN"` (prefer-not
honored).

## 5. End-to-end data flow (target)

```
process_document except
  → build_failure_details(str(e), current_stage, classify_error(e))
      = {error_message, error(=message), stage, retryable}
  → _publish_status_update("failed", details)        [adds jobId, sequence; renews lease; resets sequence]
  → Pub/Sub RAG_STATUS_TOPIC
  → rag-api _process_status_message (path resolution unchanged)
  → run_transactional_update("failed", details)
      main doc:      status=failed, error=message, error_stage=stage, retryable=derived
      processing/summary: stage=stage, error={code:"UNKNOWN", message, stage}
```

Transition-guard note (verified): the failed write only applies from `status="processing"`.
In production this holds because the worker's claim transaction
(`_claim_resource_if_queued`) sets `processing` before the pipeline runs. The contract test must
seed `processing` for the same reason.

## 6. Compatibility hedge

Only rag-api's status subscriber is a verified consumer of these payloads; other services and
tooling share the topic unverified. The retained legacy `error` key (one redundant string per
failure message) insures unknown readers. If a later audit confirms worker→rag-api is the only
pair, dropping the duplicate is trivial cleanup touching `build_failure_details` and the test's
key-set pin.

## 7. Deliberate behavior change: retryable for unknown exceptions

Unclassified-unknown exceptions previously persisted `retryable=True` (the API's silent default)
but classify as permanent under `classify_error`, so they will now persist `False`. This is the
conservatism `classify_error` was written for — it prevents infinite redelivery loops and now the
persisted record tells the same truth as the ACK decision (permanent errors are acked; manual
reprocess via `POST /process` remains, and its `failed → queued` transition is verified in
`ALLOWED_TRANSITIONS`). Residual risk: a genuinely transient-but-unrecognized failure loses its
auto-retry affordance — accepted; widening `classify_error` is out of scope.

## 8. Contract test architecture

Location: `apps/ai-server/tests/integration/test_api_contracts.py` — the established cross-service
seam home (its conftest already imports rag-api `main` with `firebase_admin` / `google.cloud` /
`structlog` mocked and env pre-set; an AST-subprocess static-check pattern exists).

Worker side under test: import `rag-worker-service/failure_payload.py` directly (stdlib + httpx;
add its directory to `sys.path`). No heavy-SDK mocks required.

API side under test: `rag_api_main.run_transactional_update` executed for real against fakes:

- Fake Firestore surface (exactly what `run_transactional_update` uses — verified):
  `db.transaction()`; `firebase_admin.firestore.transactional` bound to identity on the conftest
  mock (rag-api does `from firebase_admin import firestore`, so the mock object is shared);
  `firestore.SERVER_TIMESTAMP` set to a sentinel on the same mock; `doc_ref.get(transaction=…)`;
  `transaction.update(doc_ref, dict)` and `transaction.set(summary_ref, dict, merge=True)`
  recorded for assertions; `doc_ref.collection("processing").document("summary")`. Follows the
  FakeDoc/FakeRef house pattern (`tests/unit/test_service_contracts.py`). The Firestore-emulator
  mode (both services have emulator branches) remains an optional variant; fakes keep CI hermetic.
- Seed the fake document with `status="processing"` (transition guard).

Test cases (parametrized):

1. Early-stage failure: exception during the text-retrieval phase
   (`tracker="text_retrieved"`), unclassified `ValueError` → expect persisted
   `error=message`, `error_stage="text_retrieved"`, `retryable=False`; summary matches,
   `error.code="UNKNOWN"`.
2. Late-stage failure: `httpx.ConnectTimeout` during the embeddings phase
   (`tracker="embeddings_complete"`) → `retryable=True`.
3. Unknown-stage failure: tracker never assigned → `stage="processing"`.
4. Transient-classified failure (`TransientError`) → `retryable=True`.
5. Builder key-set pin: `set(build_failure_details(...)) == {"error_message", "error", "stage",
   "retryable"}` — catches key additions/removals (e.g., the hedge key being dropped).

Drift guards (three layers, satisfying "fail if either side's payload keys drift"):

- Layer 1 — behavioral equality (primary, both sides): the persisted `error`/`error_stage`/
  `retryable` must equal the worker's values. If the worker stops sending `error_message`, the
  API persists "Processing failed" → fail. If rag-api renames a read key, the fallback value
  appears → fail. Either side's rename breaks the build.
- Layer 2 — builder key-set pin (worker additions/removals): test case 5.
- Layer 3 — bypass guard (static, AST-subprocess pattern already used for agent-graph shapes):
  assert worker `main.py`'s failed publish routes through `build_failure_details` with
  `classify_error` and the stage tracker, and that each vocabulary stage is assigned to the
  tracker ahead of its pipeline await — so the builder cannot be bypassed or the tracker removed
  without failing the build. Representative stages only (early + late), per the definition; this
  does not ossify every pipeline step.

Additionally: a `classify_error` truth-table unit pass (transient types, 429/5xx, 4xx,
unknown→False) is now directly importable from `failure_payload` without mocks.

## 9. Risks and tradeoffs

- Unknown status-topic consumers reading the old key set — mitigated by retaining `error`;
  residual risk accepted as low (F11).
- Stage-tracker drift as the pipeline evolves — mitigated by the set-immediately-before-the-await
  convention and the representative-stage Layer-3 guard.
- `retryable=false` for unrecognized-transient failures — accepted (§7); manual reprocess intact.
- Contract test ossifies the payload — intentional; adding a key means touching the test, which
  is the drift guard working.

## 10. Out of scope / deferred

As listed in requirements §8 and §9: sweep behavior, ACK/NACK and lease mechanics, error-code
taxonomy, frontend work, the companion D3 issue, and `plans/upload-flow.md` D4 reconciliation.

## 11. Traceability

| Requirement | Architecture element |
|---|---|
| FR-1 payload contents | §3.1 `build_failure_details`, §3.3 wiring |
| FR-2 stage tracking | §3.2 tracker + mapping table |
| FR-3 retryable derivation | §3.1 moved `classify_error`, §3.3 call site, §7 behavior change |
| FR-4 API invariant | §4 (no changes), §5 flow, §8 Layer-1 assertions |
| FR-5 legacy key | §3.1, §6 hedge |
| FR-6 contract test | §8 (location, fakes, cases, three-layer guards) |
| A1–A4 acceptance | §8 test cases 1–5 + Layer-3 static guard |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>