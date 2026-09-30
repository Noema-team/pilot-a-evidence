<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api Failure Payload Contract Alignment

- Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- Authoritative source: Definition `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). All facts (F1–F12) below reference that Definition; repository claims were verified against `apps/ai-server/rag-worker-service/main.py`, `apps/ai-server/rag-api-service/main.py`, `apps/ai-server/rag-api-service/models/resource.py`, and `apps/ai-server/tests/integration/test_api_contracts.py`.
- Status: design-phase output. Scope is fixed by the Definition — do not widen or narrow during implementation planning.

---

## 1. Problem Statement

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test pins the seam.

| Concern | Worker publishes today (verified: `process_document` exception handler) | rag-api failed branch reads (verified: `run_transactional_update`) |
|---|---|---|
| Error message | `details["error"] = str(e)` | `details.get("error_message", "Processing failed")` |
| Failing stage | *(key absent)* | `details.get("stage")` (None if absent) |
| Retriability | *(key absent)* | `details.get("retryable", True)` (silent default) |

Consequence (F5, verified): every worker-originated failure persists `error` as the fallback string `"Processing failed"`, `error_stage` as `None`, and `retryable` as the silently defaulted `True`. The `processing/summary` error subdocument inherits the same fallbacks, with `error_code` defaulting to `"UNKNOWN"` (F4).

Meanwhile the `error` / `error_stage` / `retryable` schema is already established everywhere else (F6, verified): the worker's stale-lease sweep (`_fail_if_still_stale` writes `error`, `error_stage: "processing"`, `retryable: True`), rag-api's enqueue-failure paths (`/process`, `POST /resources`), and the `Resource` model (`models/resource.py`: `error: Optional[str] = None`, `error_stage: Optional[str] = None`, `retryable: bool = True`) all speak it. **The worker's status publisher is the only writer that does not.**

## 2. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's **actual error message**, the **failing pipeline stage**, and a **deliberately derived retryable flag** — locked in by a contract test on the worker→rag-api failure path.

## 3. Constraints (binding, from the Definition)

| Type | Constraint |
|---|---|
| MUST | Align the **worker** to rag-api's existing contract (publish `error_message` / `stage` / `retryable`). Do not change rag-api's reads or the persisted schema. |
| MUST NOT | Require a Firestore migration, field rename, or backfill. Persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. |
| MUST | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived). rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| PREFER | Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling (F11 hedge). |
| PREFER_NOT | Do not introduce a structured error-code taxonomy; the summary `error.code` remains `"UNKNOWN"` unless a code is actually sent. |

## 4. Functional Requirements

### FR-1 — Failure payload completeness
When document processing fails, the worker's failed status payload MUST include:
- `error_message` — the actual exception message (`str(e)`);
- `stage` — the pipeline stage executing at failure time (see FR-2);
- `retryable` — a deliberately derived boolean (see FR-4).

The payload MUST NOT rely on rag-api's fallback defaults for any of these keys, under any failure path reachable from `process_document`'s exception handler.

### FR-2 — Stage tracking in `process_document`
The worker MUST track the currently executing pipeline stage through `process_document` so the exception handler reports the true failing stage.
- Stage names MUST reuse the existing progress-stage vocabulary (F9, verified against the `_publish_status_update` call sites): `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage` (verified in `_fail_if_still_stale`), so `error_stage` never regresses to null.
- The tracker is a function-local of `process_document` (no cross-request or shared mutable state).

### FR-3 — rag-api passthrough fidelity (behavior pinned, code unchanged)
rag-api's failed branch in `run_transactional_update` MUST persist the worker-provided values unchanged:
- main document: `error` ← payload `error_message`; `error_stage` ← payload `stage`; `retryable` ← payload `retryable`;
- `processing/summary` error subdocument: `message` ← payload `error_message`, `stage` ← payload `stage` (same values as the main document), `code` ← payload `error_code` if sent, else `"UNKNOWN"`.

This restates rag-api's existing verified behavior (F4) as a requirement so that the worker-alignment strategy demonstrably leaves the API side untouched.

### FR-4 — Explicit retryable derivation aligned with error classification
The worker MUST derive `retryable` from its existing classifier `classify_error(e)` (F7, verified: `TransientError`/`PermanentError` types, httpx connection/timeout types, HTTP 429/5xx heuristics; unknown exceptions conservatively permanent):
- classified **transient** → `retryable: true`;
- classified **permanent** (including unclassified-unknown, per the classifier's conservative default) → `retryable: false`.

Adopted default (F8): this aligns the persisted record with the worker's own error-classification semantics — the same classifier drives ACK/NACK decisions in `run_worker`. The stale-lease sweep's separate direct write of `retryable: true` remains correct (a dead worker is a transient condition) and is out of scope.

Deliberate behavior change to be surfaced to reviewers/operators: unclassified-unknown exceptions currently persist `retryable: true` via the silent default; they will now persist `false`. This is intentional (it is the conservatism `classify_error` was written for); manual reprocess via `POST /process` is unaffected.

### FR-5 — Legacy key retention (compatibility hedge)
The worker's failure payload MUST retain the legacy `error` key alongside `error_message`, carrying the identical message string — insurance for any unknown consumer of the status topic (only rag-api's status subscriber is a verified consumer; F11). Dropping the duplicate after a future consumer audit is trivial cleanup and explicitly out of this cycle's scope.

### FR-6 — Contract test on the worker failure → rag-api persistence path
A contract test MUST exist and pass, covering the seam end-to-end at the data level:
- It MUST exercise the worker's failure-payload **construction** (through the worker's code path, not a restated fixture) and rag-api's failed-branch **persistence** (`run_transactional_update`), via the Firestore emulator or fakes (F10: both services have hermetic `FIRESTORE_EMULATOR_HOST` branches; the house fake-based pattern exists in `rag-worker-service/tests/unit/test_processing_lease.py`).
- It MUST assert the persisted `error`, `error_stage`, and `retryable` equal the worker's constructed values.
- It MUST fail if either side's payload keys drift: the worker's payload key set is asserted exactly (`error`, `error_message`, `stage`, `retryable`), and the retryable assertion must use at least one permanent-classified case so that rag-api falling back to `retryable: True` (default) is distinguishable from reading the key.
- It MUST cover a representative early-stage failure and a representative late-stage failure (pins the stage tracker without ossifying every step).

## 5. Non-Functional Requirements

- NFR-1 (Zero migration): no schema evolution, renames, or backfills of existing Firestore documents.
- NFR-2 (Blast radius): changes confined to the worker's `process_document` failure-reporting path (tracker locals + the `_publish_status_update` failed-details dict); no rag-api changes; no signature changes to `_publish_status_update`, `run_worker`, `_fail_if_still_stale`, or the Pub/Sub message envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`).
- NFR-3 (Truthful observability): after the fix, persisted `error`/`error_stage`/`retryable` reflect the worker's actual failure state, so `ResourceResponse` consumers (which already expose `error` and `error_stage`) see real failure data.

## 6. Out of Scope (non-goals, from the Definition)

1. Changing the stale-lease sweep's direct failure write — already contract-consistent.
2. Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
3. Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
4. Structured error codes / failure taxonomy — summary `error.code` stays `"UNKNOWN"` unless a code is actually sent.
5. Anything the companion D3 issue covers beyond this payload alignment (its scope is unavailable in this context; F12 — deferred).
6. Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree; F12 — deferred).

## 7. Acceptance Criteria (from the Definition; all currently `met: false`)

| AC | Criterion | Where verified |
|---|---|---|
| AC-1 | Failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | Worker-side behavioral assertions + contract test payload capture |
| AC-2 | Persisted resource document: `error` = worker's actual message (not `"Processing failed"`), `error_stage` = failing stage (not None), `retryable` = worker-derived value. | Contract test persistence assertions |
| AC-3 | `processing/summary` error subdocument carries the same message and stage as the main document. | Contract test subdocument assertions |
| AC-4 | Contract test covering worker failure-payload construction → rag-api failed-branch persistence exists and passes; asserts persisted `error`/`error_stage`/`retryable` equal the worker's values; fails if either side's payload keys drift. | New contract test in the integration suite, run in CI |

## 8. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Unknown status-topic consumers reading only the legacy `error` key | Retain `error` alongside `error_message` (FR-5); residual risk accepted as low per the Definition. |
| `retryable=false` for unclassified errors reduces auto-retry affordances for genuinely-transient-but-unrecognized failures | Accepted per the Definition; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains. |
| Stage-tracker drift as the pipeline evolves (new step added without updating the tracker → stale stage) | Convention "set the tracker immediately before the await" (see architecture §4.1); contract test pins representative early/late stages, enough to catch the tracker being removed or bypassed. |
| Contract test ossifies the payload | Intentional — that is the drift guard doing its job; adding a key later means touching the test. |

## 9. Open Questions / Deferred (preserved from the Definition, not fabricated)

- OQ-1: Contents/scope of the referenced companion D3 issue are unavailable in this context (F12) — deferred.
- OQ-2: `plans/upload-flow.md` (original D4 analysis) is not present in the current tree (F12) — treated as an informational pointer only; reconciliation deferred.
- OQ-3: No consumer other than rag-api's status subscriber is *known* to parse the worker's failure payload keys (F11); a future audit may enable dropping the legacy `error` key — out of scope.

---
End of requirements document.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api Failure Payload Contract Alignment

Scope source: Definition `wi-define-108-a8`. All code references below were verified in the current tree unless explicitly marked otherwise.

---

## 1. Current failure flow (verified)

```
process_document (rag-worker-service/main.py, EnhancedDocumentProcessor)
  └─ except Exception as e:
       metrics.error_message = str(e)
       _publish_status_update(..., "failed", {"error": str(e)}, job_id)
            └─ Pub/Sub topic (RAG_STATUS_TOPIC) → JSON envelope
                 {user_id, course_id, resource_id, status, details, timestamp, sequence}
                      └─ rag-api _process_status_message (status subscriber)
                           └─ run_transactional_update(db, doc_ref, "failed", details, ...)
                                ├─ main doc:  error ← details.get("error_message", "Processing failed")
                                │             error_stage ← details.get("stage")        # None
                                │             retryable ← details.get("retryable", True) # silent default
                                └─ processing/summary: error = {code: details.get("error_code","UNKNOWN"),
                                                                message: details.get("error_message","Processing failed"),
                                                                stage: details.get("stage")}
```

Key mismatch: the worker sends one key (`error`); rag-api reads three (`error_message`, `stage`, `retryable`). Every other failure writer in the system (worker's `_fail_if_still_stale` sweep, rag-api's enqueue-failure paths, `Resource` model) already uses the `error`/`error_stage`/`retryable` persisted schema.

## 2. Design principles

1. **Fix the odd one out.** The worker aligns to `error_message`/`stage`/`retryable`; rag-api's reads and the persisted schema are untouched. No migration, no backfill, no reader changes.
2. **Derive, don't default.** `retryable` comes from `classify_error(e)` — the single classifier the worker already trusts for ACK/NACK — never from a consumer-side fallback.
3. **Report the truth about where it failed.** A stage tracker local to `process_document`, reusing the progress-stage vocabulary.
4. **Hedge cheaply.** Keep the legacy `error` key for unknown topic consumers (F11).
5. **Test the seam, not a copy of it.** The contract test drives the worker's real payload-construction path and rag-api's real failed branch; it asserts persisted equality and exact key sets.

## 3. Target failure flow (after fix)

Only the `details` dict changes; envelope, topic, subscriber, and persisted field names are identical to §1:

```
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    await self._publish_status_update(
        user_id, course_id, resource_id, "failed",
        {
            "error":         str(e),              # legacy key retained (FR-5 / F11)
            "error_message": str(e),              # contract key read by rag-api
            "stage":         current_stage,       # FR-2 tracker; never None (§4.1)
            "retryable":     classify_error(e),   # FR-4 deliberate derivation
        },
        job_id,
    )
```

Notes on verified mechanics preserved unchanged:
- `_publish_status_update` adds `jobId` to `details` when a job_id is supplied, assigns the per-resource `sequence`, resets the sequence on terminal states (`completed`/`failed`), performs the lease `status_updated_at` merge, and publishes JSON to the status topic. None of this changes.
- rag-api's transition gate (`processing → {completed, failed}`) is unchanged; a worker `failed` publish still lands only from `processing`. (Existing behavior: a failure published after the terminal `completed` publish — e.g. from post-completion housekeeping — is ignored by the gate; that remains true and is out of scope.)

## 4. Worker-side design

### 4.1 Stage tracker

`current_stage` is a local in `process_document`, initialized to `"processing"` (the safe unknown value; matches the sweep's `error_stage` so the field never regresses to null), and assigned immediately before each pipeline await (the convention stated in the Definition: "set the tracker immediately before the await").

Assignment table (step names verified in `process_document`):

| Code point | Assignment | Rationale (vocabulary semantics) |
|---|---|---|
| function entry | `current_stage = "processing"` | Safety net for genuinely-unknown stage |
| before `_validate_processing_request` | `"starting"` | Job startup phase (matches the initial `{"stage": "starting"}` publish) |
| before `_get_extracted_text` | `"starting"` (unchanged) | Text acquisition precedes the `text_retrieved` milestone; claiming `text_retrieved` before it happens would be false |
| before `content_tagger.generate_tags` | `"text_retrieved"` | Last milestone reached; tagging is in flight |
| before `generate_document_summary` + doc update | `"tagging_complete"` | Summary in flight |
| before `_create_enhanced_chunks` | `"summary_generated"` | Chunking in flight |
| before `_generate_embeddings_with_openrouter` | `"chunking_complete"` | Embeddings in flight |
| before `delete_old_vectors_via_service` / `store_chunks_via_service` / `_save_processing_metadata_to_subcollection` | `"embeddings_complete"` | Vector storage/metadata in flight |
| before final `"completed"` publish | `"completed"` | Post-completion housekeeping (`_update_user_usage`, `_generate_resource_map`) |

Semantics: the tracker holds the **last milestone reached** — the honest description of the executing phase within the mandated completion-token vocabulary. A failure during tagging reports `text_retrieved` ("text was retrieved; tagging failed"); a failure during vector storage reports `embeddings_complete`. This avoids the actively false alternative (assigning a *target* milestone before the step would make a vector-storage failure report `completed`).

Known drift risk (from the Definition): a future pipeline step added without updating the tracker reports a stale stage. Mitigations: the update-before-await convention documented at the tracker; the contract test pinning an early-stage and a late-stage failure (enough to catch the tracker being removed or bypassed, without ossifying every step). Accepted coarseness: the vocabulary has no "extracting"/"storing" tokens, so in-flight phases report the preceding milestone — mandated by FR-2's vocabulary constraint.

### 4.2 retryable derivation

`retryable = classify_error(e)` — the exact function and exception object used by the worker's error-classification machinery (F7): `TransientError` and known-transient httpx/OS/timeout types and HTTP 429/5xx → `True`; `PermanentError`, other 4xx, and unclassified-unknown (conservative default) → `False`.

Behavior change (deliberate, per F8): unclassified-unknown failures move from persisted `True` (silent default) to `False`. The stale-lease sweep's direct `retryable: True` write is untouched and stays correct (dead worker = transient condition).

Mechanics note (verified, for implementer clarity — not a change): `process_document`'s handler reports the failure and returns normally (it does not re-raise), so messages whose failure is caught inside `process_document` are acked by `run_worker`'s normal path; `run_worker` separately applies `classify_error` to exceptions that escape to the message loop. Both paths draw from the same classifier, which is the alignment F8 adopts: one source of truth for retry semantics, now also reflected in the persisted `retryable` field.

### 4.3 Touch points summary

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` — `process_document` | Add `current_stage` local + assignments; replace the failed `details` dict per §3. Nothing else in the method changes. |
| `apps/ai-server/rag-worker-service/main.py` — everything else | No changes: `_publish_status_update`, `run_worker`, `classify_error`, `_fail_if_still_stale`, claim/lease/heartbeat logic, `ProcessingMetrics` (`error_message` field already exists and is still set). |
| `apps/ai-server/rag-api-service/**` | No changes. Behavior pinned by FR-3 and asserted by the contract test. |
| New contract test | See §5. |

Deployment is single-sided (worker only); no config changes; old/new worker and API combinations are compatible because the API is untouched and the worker only adds keys to `details`.

## 5. Contract test architecture

### 5.1 Shape and placement

- New integration test module alongside the house pattern (e.g. `apps/ai-server/tests/integration/test_worker_failure_contract.py`, sibling of `test_api_contracts.py`), plus worker-side behavioral tests in the worker's existing suite (its `tests/unit/` already imports `main` successfully — evidenced by `test_processing_lease.py`).
- Import mechanics: both services expose `main.py`, so a single process cannot `import main` twice under one name. Use `importlib.util.spec_from_file_location` with distinct module names (e.g. `rag_api_under_test`, `rag_worker_under_test`) loaded from explicit paths — or reuse the house subprocess/AST extraction pattern (`test_api_contracts.py` already cross-examines agent-graph-service this way) as fallback.
- Import-time environment: worker `main.py` requires `GCP_PROJECT` and a readable `GOOGLE_APPLICATION_CREDENTIALS` service-account file at import (verified: module-level `os.environ["GCP_PROJECT"]`, `RuntimeError` if the credentials env is missing, `Credentials.from_service_account_file` at import). The worker's existing unit suite demonstrates `main` is importable under test; the harness reuses whatever env/conftest provisioning makes that work (conftest contents were not inspected — verify at implementation time). Fallback ladder if the shared integration env cannot import worker `main` economically: (a) run worker-side behavioral cases in the worker's own test env and drive the seam test's worker side through a small dependency-light payload-construction helper extracted from the handler (single source of truth, imported by `main.py`); (b) subprocess-isolated execution per the house pattern.

### 5.2 Harness: fakes first, emulator optional

- **Fakes (primary, deterministic):** reuse the established fake-transaction pattern from `rag-worker-service/tests/unit/test_processing_lease.py` (`FakeDb`/`FakeTx`/`FakeSnap`/`FakeRef`, monkeypatch `firestore.transactional` to an identity decorator and `SERVER_TIMESTAMP` to a sentinel). Worker side: build the processor instance without full service init (e.g. via `object.__new__(EnhancedDocumentProcessor)` with stubbed `logger`, `langfuse = None`, config, and monkeypatched step methods + `_publish_status_update` capture — the publisher's Pub/Sub and lease writes are faked out), monkeypatch one pipeline step to raise, and capture the published `details`. rag-api side: call `run_transactional_update` directly with a doc in `processing` status and assert the main-doc update and the `processing/summary` set.
- **Firestore emulator (optional higher-fidelity variant):** both services have verified `FIRESTORE_EMULATOR_HOST` hermetic branches (worker `_init_services`; rag-api `AppState.startup`), so an emulator-mode variant can be added wherever CI already runs the hermetic stack. Not required for AC-4; fakes satisfy "via the Firestore emulator or fakes".

### 5.3 Test cases (binding AC-1…AC-4)

1. **Transient early-stage failure.** `_get_extracted_text` raises a transient-classified error (e.g. `TransientError` or `httpx.ConnectError`). Assert captured payload: keys exactly `{error, error_message, stage, retryable}`; `error_message == error == str(e)`; `stage == "starting"`; `retryable is True`. Feed through `run_transactional_update`: persisted `error == str(e)` (≠ `"Processing failed"`), `error_stage == "starting"` (not None), `retryable is True`; summary `error.message`/`error.stage` match the main doc and `error.code == "UNKNOWN"`.
2. **Permanent late-stage failure.** `_generate_embeddings_with_openrouter` (or `store_chunks_via_service`) raises a permanent-classified error. Assert `stage == "chunking_complete"` (or `"embeddings_complete"`), and persisted `retryable is False` — this is the case that proves rag-api reads the key rather than defaulting (`True ≠ False` catches drift).
3. **Subdocument consistency.** For both cases: `processing/summary.error.message == main.error` and `error.stage == main.error_stage`.
4. **Key-set drift guard.** Exact-set assertion on the worker payload keys; explicit `error != "Processing failed"` and `error_stage is not None` assertions so a reverted worker (one-key payload) or a reverted API read fails the build.
5. **Optional static guard.** AST scan (house pattern) asserting the worker's failed publish call site contains the four keys and rag-api's failed branch references `details.get("error_message")`, `details.get("stage")`, `details.get("retryable")` — belt-and-braces for branches the behavioral cases don't exercise.

### 5.4 What the test deliberately pins (and does not)

Pins: payload key names and equality of persisted values; stage vocabulary tokens at two representative points; retryable polarity for both classifications. Does not pin: incidental internals (helper signatures, metrics fields), progress values, or every pipeline step — per the Definition's drift-risk tradeoff.

## 6. Data contract (normative summary)

Worker failed-status `details` (published on the status topic):

| Key | Type | Source | Required |
|---|---|---|---|
| `error` | string | `str(e)` (legacy, retained) | yes (FR-5) |
| `error_message` | string | `str(e)` | yes (FR-1) |
| `stage` | string | stage tracker; one of the progress vocabulary or `"processing"` | yes (FR-1/FR-2) |
| `retryable` | bool | `classify_error(e)` | yes (FR-1/FR-4) |

rag-api failed-branch persistence (unchanged code, pinned by FR-3):

| Persisted location | Field | Bound to |
|---|---|---|
| main resource doc | `error` | payload `error_message` |
| main resource doc | `error_stage` | payload `stage` |
| main resource doc | `retryable` | payload `retryable` |
| `processing/summary` | `error.message` / `error.stage` | payload `error_message` / `stage` (same as main doc) |
| `processing/summary` | `error.code` | payload `error_code` if sent, else `"UNKNOWN"` (no taxonomy introduced) |

Retryable semantics: transient classification → `true`; permanent classification (including unclassified-unknown) → `false`; stale-lease sweep's independent write → `true` (unchanged, correct for a dead worker).

## 7. Risks and tradeoffs (carried from the Definition)

- Unknown status-topic consumers of the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- `retryable=false` for unclassified errors may reduce auto-retry affordances for genuinely-transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains.
- Contract test ossifies the payload — intentional; that is the drift guard. Adding a key later means touching the test.
- Implementation-time unknowns flagged honestly: worker `tests/conftest.py` contents (env provisioning for importing `main`) were not inspected; test-env dependency weight for dual-importing worker `main` in the shared integration suite is unverified. §5.1's fallback ladder covers both without changing scope.

## 8. Traceability

| Requirement | Code touch point | Test | AC |
|---|---|---|---|
| FR-1 payload completeness | `process_document` except block | Cases 1–2, 4 | AC-1 |
| FR-2 stage tracking | `current_stage` local + assignments | Cases 1–2 (early/late), 4 | AC-1, AC-2 |
| FR-3 rag-api passthrough | none (pinned) | Cases 1–3 | AC-2, AC-3 |
| FR-4 retryable derivation | `classify_error(e)` in payload | Case 2 (`False` proves read), Case 1 (`True`) | AC-1, AC-2 |
| FR-5 legacy key | `error` alongside `error_message` | Case 4 exact key set | AC-1 |
| FR-6 contract test | new test module(s) | Cases 1–5 | AC-4 |

Deferred (unchanged from Definition): companion D3 issue scope; `plans/upload-flow.md` D4 reconciliation (file absent from tree); status-topic consumer audit enabling eventual removal of the legacy `error` key.

---
End of architecture document.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>