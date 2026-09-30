<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- **Source of truth:** Definition artifact `definition:obj-108` (WorkItem `wi-define-108-a8`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document operationalizes that definition for implementation and testing; where wording differs, the Definition wins. Nothing here widens or narrows its bounded scope.
- **Cycle intent:** "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage."
- **Run context:** run `80a69d92-dff3-4d01-8fb5-d8f7dc0a453e`, iteration 1. Line references are approximate (`~L`) and reflect the investigated tree state.

---

## 1. Problem statement

The two halves of the worker→rag-api failure path were written against different contracts:

- **Producer (rag-worker):** `process_document`'s exception handler (`apps/ai-server/rag-worker-service/main.py` ~L1039–1045) publishes the failed status with a one-key details payload: `{"error": str(e)}`.
- **Consumer (rag-api):** the failed branch of `run_transactional_update` (`apps/ai-server/rag-api-service/main.py` ~L238–241, ~L278–282) reads three keys — `error_message`, `stage`, `retryable` — and persists them as `error`, `error_stage`, `retryable` on the main resource document, plus `message`/`stage` (and `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument.

Because of the key mismatch, **every worker-originated failure currently persists**:
- `error = "Processing failed"` (the API's fallback string, not the actual exception message),
- `error_stage = None` (no `stage` key sent),
- `retryable = True` (the API's silent `.get(..., True)` default),
- and a `processing/summary` error subdocument carrying the same fallback message, a null stage, and `error_code = "UNKNOWN"`.

The `error`/`error_stage`/`retryable` schema is already the established failure schema everywhere else: the worker's stale-lease sweep (`_fail_if_still_stale`, ~L2085) writes all three directly, rag-api's enqueue-failure paths write them, and both `Resource` (`models/resource.py` ~L57–59) and the API response model expose them. The worker's status publisher is the only writer that does not speak this contract, and no test covers the seam.

## 2. Scope

**In scope**
1. The worker's failure-payload construction in `process_document`'s exception handler (keys, stage tracking, retryable derivation).
2. A contract test covering the worker failure → rag-api persistence path, including key-set drift guards.
3. Verification (test-only) that rag-api's failed branch persists worker-provided values unchanged.

**Out of scope** — see §8 (Non-goals) and §9 (Deferred).

## 3. Contract specification

### 3.1 Worker failure status payload (status `"failed"`, `details` object)

| Key | Type | Value | Rule |
|---|---|---|---|
| `error_message` | `str` | `str(exception)` | The actual exception message. MUST always be present. |
| `stage` | `str` | current-stage tracker value | MUST always be present and non-empty; never `null`. |
| `retryable` | `bool` | `classify_error(e)` | Deliberately derived per FR-4. MUST always be present. |
| `error` | `str` | `str(exception)` | Legacy key retained (FR-5); duplicates `error_message`. |

**Exact key set:** `error_message`, `stage`, `retryable`, `error`. No `error_code` key (per prefer-not constraint), no `progress` key (today's payload also omits it; rag-api defaults summary `progress` to 0 — unchanged behavior).

### 3.2 Stage vocabulary

Stage values MUST be drawn from the worker's existing progress-stage vocabulary plus one safe fallback:

```
starting | text_retrieved | tagging_complete | summary_generated |
chunking_complete | embeddings_complete | processing (fallback)
```

- `"processing"` is the safe value when the stage is genuinely unknown (tracker never assigned). It matches the value the stale-lease sweep already writes for `error_stage`, so the field never regresses to `null`.
- `"completed"` is a terminal success marker, not a failure stage; it is not part of the failure vocabulary.

### 3.3 rag-api failed-branch reads (unchanged; restated as the consumed contract)

With FR-1 satisfied, every one of rag-api's fallbacks (`"Processing failed"`, `None` stage, `True` retryable, `"UNKNOWN"` code) becomes a dead path for worker-originated failures:

- main doc: `error` ← payload `error_message`; `error_stage` ← payload `stage`; `retryable` ← payload `retryable`.
- summary: `error.message` ← payload `error_message`; `error.stage` ← payload `stage`; `error.code` ← `"UNKNOWN"` (worker sends no `error_code`); `stage` ← payload `stage`.

### 3.4 Persisted schema (unchanged)

No Firestore migration, field rename, or backfill is required or permitted. Persisted field names (`error`, `error_stage`, `retryable`) and their semantics stay exactly as they are today across the sweep, enqueue-failure paths, `Resource`, and `ResourceResponse`.

## 4. Functional requirements

**FR-1 — Failure payload completeness (must).**
When document processing fails inside `process_document`, the worker MUST publish status `"failed"` whose details object contains exactly the keys `error_message`, `stage`, `retryable`, `error` with the values specified in §3.1. The payload MUST never rely on rag-api's fallback defaults for `error_message`, `stage`, or `retryable`.

**FR-2 — Stage tracking (must).**
`process_document` MUST maintain a current-stage local variable that is (a) initialized to `"processing"` before the `try` block, (b) assigned immediately before each pipeline step's first `await` (the "set-before-await" convention), and (c) read by the exception handler when constructing the failure payload.

**FR-3 — Stage naming (must).**
Tracker values MUST use the §3.2 vocabulary only. Mapping (step → tracker value set before it):

| Pipeline step (await) | Tracker value |
|---|---|
| `_validate_processing_request` (+ the `"starting"` status publish) | `starting` |
| `_get_extracted_text` | `text_retrieved` |
| `content_tagger.generate_tags` | `tagging_complete` |
| `generate_document_summary` (+ `ragDescription` Firestore write) | `summary_generated` |
| `_create_enhanced_chunks` | `chunking_complete` |
| `_generate_embeddings_with_openrouter` | `embeddings_complete` |
| `delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save, usage/map generation | *(no new name — remains `embeddings_complete`)* |

**FR-4 — Retryable derivation (must).**
`retryable` MUST equal `classify_error(e)`: exceptions classified transient → `true`; classified permanent — including unclassified-unknown, per `classify_error`'s conservative default — → `false`. It MUST never be a constant and never be omitted. (`classify_error` semantics, verified: `TransientError` → true; `PermanentError` → false; httpx connect/timeout/pool errors, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` → true; `HTTPStatusError` with 429/500/502/503/504 → true; other `HTTPStatusError` → false; unknown → false.)

**FR-5 — Legacy key hedge (must, per adopted F11).**
The payload MUST retain the legacy `error` key with the same string as `error_message`, for continuity with any unknown consumers of the status topic and existing log tooling.

**FR-6 — rag-api unchanged (must, verification-only).**
rag-api's failed-branch reads, persisted field names and semantics, `ALLOWED_TRANSITIONS`, models (`Resource`, `ResourceResponse`), and the completed branch (which clears `error`/`error_stage` to `None`) MUST NOT change. The only rag-api "change" in this cycle is the contract test that pins it.

**FR-7 — Contract test (must).**
A new test at `apps/ai-server/tests/integration/test_worker_failure_contract.py` MUST:
- (a) drive the **real** `process_document` failure path on the worker side — via a processor instance constructed without service init and with pipeline collaborators mocked — for at least one **early-stage** failure and one **late-stage** failure, capturing the payload passed to `_publish_status_update`;
- (b) feed the captured payloads through rag-api's **real** `run_transactional_update` against a fake transactional Firestore or the Firestore emulator;
- (c) assert the persisted main-document `error`, `error_stage`, `retryable` equal the worker's `error_message`, `stage`, `retryable`, and that the `processing/summary` error subdocument carries the same message and stage with `code == "UNKNOWN"`;
- (d) assert the captured payload's key set equals the §3.1 key set exactly.

**FR-8 — Key-set drift guards (must).**
Static AST-based guards (house pattern: `tests/integration/test_api_contracts.py`) over both `main.py` files MUST assert the required key literals are present — worker side: the four payload keys in the failure-details construction and the six stage-name literals of FR-3; rag-api side: the `error_message`/`stage`/`retryable` reads and the persisted `error`/`error_stage`/`retryable` keys in the failed branch. Any key drift on either side fails the build.

**FR-9 — Single construction seam (must).**
Failure-payload construction MUST live in one importable pure function (e.g. `build_failure_details(e, stage)`) in the worker module, used by the exception handler, so tests exercise the production construction path rather than restating the contract in a fixture.

**FR-10 — No regression to sibling paths (must).**
The stale-lease sweep's direct failure write, rag-api's enqueue-failure paths, and `_publish_status_update` mechanics (sequence numbering, lease renewal on publish, internal error swallowing) MUST be unchanged.

**FR-11 — Failure log enrichment (should).**
The handler's `document_processing_failed` log event SHOULD gain `stage` and `retryable` fields so ops sees the same truth the API persists. Non-mandatory; same code site.

## 5. Observable behavior ledger

| Case | Before | After |
|---|---|---|
| Worker pipeline failure → main doc `error` | `"Processing failed"` | actual exception message |
| Worker pipeline failure → main doc `error_stage` | `None` | failing stage from §3.2 vocabulary |
| Worker pipeline failure → main doc `retryable` | always `True` (silent default) | `classify_error(e)` (unclassified-unknown now `False`) |
| `processing/summary.error.message` / `.stage` | fallback / `None` | actual message / stage |
| `processing/summary.error.code` | `"UNKNOWN"` | `"UNKNOWN"` (unchanged) |
| Stale-lease sweep failures | direct write, `retryable: True`, stage `"processing"` | unchanged |
| rag-api enqueue failures | direct write | unchanged |
| Successful reprocess after failure | completed branch clears `error`/`error_stage` | unchanged |

## 6. Constraints

1. **must** — The worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed.
2. **must_not** — No Firestore migration, field rename, or backfill; persisted fields keep the names `error`, `error_stage`, `retryable` and their semantics.
3. **must** — Every worker-originated failure payload carries `retryable` explicitly; the API-side `.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
4. **prefer** — Retain the legacy `error` key alongside `error_message` (FR-5).
5. **prefer_not** — No structured error-code taxonomy; `summary.error.code` remains `"UNKNOWN"` unless a code is actually sent (none is).

## 7. Acceptance criteria

| ID | Criterion (from Definition) | Verified by |
|---|---|---|
| AC-1 | The worker's failed status message contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | FR-7(a)+(d), FR-8 worker guard |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | FR-7(b)+(c) |
| AC-3 | The `processing/summary` error subdocument carries the same message and stage as the main document. | FR-7(c) |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes, failing if either side's payload keys drift. | FR-7, FR-8 |

## 8. Non-goals

- Changing the stale-lease sweep's direct failure write (already contract-consistent).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error`/`error_stage`.
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context).

## 9. Deferred

- The companion D3 issue referenced by the Objective: scope unavailable here; anything beyond the worker→rag-api payload alignment is deferred.
- Reconciling this analysis with deviation D4 in `plans/upload-flow.md`: that file is not present in the current tree; the reference exists only in Objective text.
- Dropping the legacy `error` key after a consumer audit (trivial cleanup later; explicitly out of scope now).
- The minor observation that the completed branch does not reset `retryable` on a successful reprocess: harmless (meaningful only when `status == "failed"`), left untouched.

## 10. Traceability

| Requirement | Acceptance | Test hook |
|---|---|---|
| FR-1, FR-3, FR-5 | AC-1 | captured-payload key-set + value assertions (FR-7a/d) |
| FR-2 | AC-1, AC-2 | early/late representative-stage failures (FR-7a) + stage-literal AST guard (FR-8) |
| FR-4 | AC-1, AC-2 | transient vs permanent exception pair in FR-7a; persisted `retryable` assertion (FR-7c) |
| FR-6 | AC-2, AC-3, AC-4 | FR-7b/c against real `run_transactional_update`; rag-api AST guard (FR-8) |
| FR-7, FR-8, FR-9 | AC-4 | the contract test itself |
| FR-10 | — | unchanged-diff review; existing sweep/enqueue behavior untouched |
<<<END-SLE-ARTIFACT>>>

<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

Implements `docs/requirements.md` (Definition `definition:obj-108`, sha256 `71f1c39c…`). Line references are approximate (`~L`) and reflect the investigated tree state (run `80a69d92`, iteration 1).

---

## 1. Verified current state

### 1.1 Worker pipeline and status publishing
`process_document` (`apps/ai-server/rag-worker-service/main.py` ~L938–1047) is one large `try` block. Progress publishes use this vocabulary (verified at the `_publish_status_update` call sites):

| After step | Published stage | progress |
|---|---|---|
| `_validate_processing_request` | `starting` | — |
| `_get_extracted_text` | `text_retrieved` | 20 |
| `content_tagger.generate_tags` | `tagging_complete` | 40 |
| `generate_document_summary` + `ragDescription` write | `summary_generated` | 50 |
| `_create_enhanced_chunks` | `chunking_complete` | 60 |
| `_generate_embeddings_with_openrouter` | `embeddings_complete` | 80 |
| terminal | `completed` | 100 |

There is no stage tracking today: at failure time nothing knows where the pipeline was.

The failure handler (verbatim, ~L1039–1045):

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                      resource_id=resource_id, error=str(e))
    await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

`_publish_status_update` (~L1527) builds the envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`), renews the processing lease, publishes to the status topic, and **swallows its own exceptions** (logs `status_publish_failed`) — so the failed publish is best-effort and never raises into the handler.

### 1.2 Worker error classification and ACK/NACK
`classify_error(e)` (~L44–92) returns `True` (transient) for `TransientError`, httpx connect/timeout/pool errors, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, and `HTTPStatusError` with 429/500/502/503/504; `False` (permanent) for `PermanentError`, other 4xx, and — conservatively — **unknown exceptions**. `run_worker` (~L1979) uses it for ACK/NACK. Control-flow nuance (verified): `process_document` swallows pipeline exceptions and returns, so `run_worker`'s classifier fires for claim/parse/loop-level errors; pipeline failures are acked after the failed publish. The `retryable` derivation below is nonetheless specified by the Definition (F8) as `classify_error`-based: it reports the failure class the worker's own retry machinery uses, and manual reprocess (`failed → queued` transition, verified in `ALLOWED_TRANSITIONS`; re-enqueue via `POST /process` per Definition F6) remains the universal recovery.

### 1.3 Stale-lease sweep (untouched)
`_fail_if_still_stale` (~L2085) writes directly, already contract-consistent:

```python
transaction.update(doc_ref, {
    "status": "failed",
    "error": "processing lease expired without heartbeat — worker died or stalled",
    "error_stage": "processing",
    "retryable": True,
    ...
})
```

### 1.4 rag-api consumer (unchanged)
`run_transactional_update` (`apps/ai-server/rag-api-service/main.py` ~L155) — failed branch reads `error_message`/`stage`/`retryable` (fallbacks `"Processing failed"`/`None`/`True`) into main-doc `error`/`error_stage`/`retryable`, and writes `summary.error = {code: error_code or "UNKNOWN", message, stage}` plus `summary.stage`. Transitions: `processing → {completed, failed}`, `failed → {queued}`. The completed branch clears `error`/`error_stage` to `None` (so a successful reprocess cleans up). `_process_status_message` (~L352) resolves the canonical path `users/{uid}/resources/{rid}` (legacy course path fallback) and runs the update in a thread.

### 1.5 Established schema and test infrastructure
`Resource` (`models/resource.py` ~L57–59): `error`, `error_stage`, `retryable=True`. Contract-test house pattern: `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based; imports `main as rag_api_main` under a `conftest.py` that mocks `firebase_admin`/`google.cloud.*` and inserts the rag-api service on `sys.path`). The worker side has an equivalent stub conftest (`apps/ai-server/rag-worker-service/tests/conftest.py`: env defaults + `sys.modules` stubs for langchain/openai/langfuse/firebase/google.cloud/…) that makes worker `main.py` importable for tests. Both services have `FIRESTORE_EMULATOR_HOST` init branches (verified in both `_init_services` and `AppState.startup`).

## 2. Design principles

1. **Fix the odd writer out.** Three write paths and two response models already use `error`/`error_stage`/`retryable`; the worker's publisher is the only deviant. Aligning the worker ripples nowhere; changing rag-api would ripple everywhere.
2. **Derive, don't default.** Every failure payload key is produced deliberately by the worker; API-side fallbacks become dead code for worker failures.
3. **Reuse the vocabulary.** Failure stages speak the same names as the progress timeline clients already see; no new taxonomy.
4. **Test the seam, not a fixture copy.** The contract test drives the real producer code path and the real consumer code path; the key set is pinned, so drift fails the build.
5. **Hedge cheaply.** One redundant legacy string (`error`) insures unknown topic consumers.

## 3. Component design

### 3.1 `build_failure_details` — the single construction seam (new, worker `main.py`, module-level, pure)

Placed next to `classify_error`:

```python
def build_failure_details(e: Exception, stage: Optional[str]) -> Dict[str, Any]:
    """Build the failed-status details payload.

    Contract (pinned by tests/integration/test_worker_failure_contract.py):
      error_message — the actual exception message (rag-api persists it as `error`)
      stage         — pipeline stage executing at failure time (persisted as `error_stage`)
      retryable     — classify_error(e): transient→True, permanent/unknown→False
      error         — legacy duplicate of error_message, retained for unknown
                      consumers of the status topic
    """
    message = str(e)
    return {
        "error_message": message,
        "stage": stage or "processing",
        "retryable": classify_error(e),
        "error": message,
    }
```

Properties: pure, importable under the existing worker stub conftest, defensive `stage or "processing"` so the field can never be empty/null, and `classify_error` is the *only* source of `retryable`.

### 3.2 Stage tracker in `process_document`

- Declare `current_stage = "processing"` immediately before the `try` (next to `metrics`), so the handler can always read a defined value.
- First statement inside the `try`: `current_stage = "starting"`; then set before each subsequent step's first `await` per the FR-3 mapping table. Convention: **set the tracker immediately before the await it guards.**
- Steps after the last named transition (old-vector deletion, `store_chunks_via_service`, metadata save, usage/map generation) run under the last-set value `embeddings_complete` — the vocabulary has no storage stage and the Definition forbids inventing one. Documented imprecision, accepted.
- Corner cases:
  - *Failure before the first assignment*: tracker reads `"processing"`.
  - *Failure after the `completed` publish* (`_update_user_usage`, `_generate_resource_map`): rag-api's transition table rejects `completed → failed` (verified), so persisted state does not change; the payload still reports `embeddings_complete`. Out of scope to add post-completion stages.

### 3.3 Handler wiring (after)

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    failure_details = build_failure_details(e, current_stage)
    self.logger.error("document_processing_failed", user_id=user_id, course_id=course_id,
                      resource_id=resource_id, error=str(e),
                      stage=failure_details["stage"], retryable=failure_details["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

`_publish_status_update` itself is untouched: same envelope, sequence handling, lease renewal, and error swallowing.

### 3.4 rag-api — no changes

The failed branch already implements the target contract (§1.4). Its fallbacks remain in code (untouched) but become dead paths for worker-originated failures because the worker now always sends all three keys. Verification-only side (FR-6).

## 4. Contract map

| Worker payload key | rag-api read (failed branch) | Persisted field | Model/response exposure |
|---|---|---|---|
| `error_message` | `details.get("error_message", …)` | main `error`; summary `error.message` | `Resource.error`, `ResourceResponse.error` |
| `stage` | `details.get("stage")` | main `error_stage`; summary `error.stage`, `summary.stage` | `Resource.error_stage`, `ResourceResponse.error_stage` |
| `retryable` | `details.get("retryable", True)` | main `retryable` | `Resource.retryable` |
| `error` (legacy) | *(unread by rag-api)* | — | — (hedge for unknown topic consumers) |
| *(not sent)* | `details.get("error_code", "UNKNOWN")` | summary `error.code` | stays `"UNKNOWN"` |

## 5. Failure data flow (after fix)

```
pipeline step raises (stage = tracker value)
  → process_document except:
      build_failure_details(e, current_stage)
        → {error_message, stage, retryable=classify_error(e), error}
      log document_processing_failed (+stage, +retryable)
  → _publish_status_update("failed", details)   [envelope + sequence + lease renewal; unchanged]
  → Pub/Sub rag-status-updates
  → rag-api _process_status_message → path resolution
  → run_transactional_update failed branch
      main doc:           error ← error_message; error_stage ← stage; retryable ← retryable
      processing/summary: error{code:"UNKNOWN", message ← error_message, stage ← stage}; stage ← stage
```

## 6. Compatibility and migration

- **No migration/backfill.** Persisted names and semantics unchanged; historical documents untouched.
- **Unknown consumers.** Only rag-api's subscriber is a verified consumer; the legacy `error` key is retained as a one-string insurance policy. Dropping it later is trivial cleanup after an audit (deferred).
- **Deliberate behavior change.** Unclassified-unknown exceptions previously persisted `retryable: True` (silent default) and now persist `False`, matching `classify_error`'s conservative default that prevents infinite retry loops. Manual reprocess is unaffected (`failed → queued` transition verified; `POST /process` re-enqueue per Definition F6).
- **Sweep unchanged.** A dead worker remains a transient condition; its direct `retryable: True` write stays correct.
- **Reprocess cleanup.** The completed branch already nulls `error`/`error_stage` on success; `retryable` is not reset (harmless; §9 of requirements).

## 7. Contract test architecture

**File:** `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new, alongside `test_api_contracts.py`).

### 7.1 Legs

**Leg A — worker failure-path harness (in-process).**
- Import worker `main.py` under the established stub-conftest technique (env defaults + `sys.modules` stubs; reuse/extend the set from `rag-worker-service/tests/conftest.py`).
- Construct the processor **without** `_init_services`: `EnhancedDocumentProcessor.__new__(EnhancedDocumentProcessor)`, then attach only what `process_document` touches (`logger`, `langfuse=None`, and monkeypatched collaborators). This is robust because `process_document` references a bounded, known set of attributes/methods (verified: `_validate_processing_request`, `_publish_status_update`, `_get_extracted_text`, `content_tagger`, `generate_document_summary`, `_create_enhanced_chunks`, `_generate_embeddings_with_openrouter`, `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, `_update_user_usage`, `_generate_resource_map`).
- Monkeypatch `_publish_status_update` to capture `(status, details)`; monkeypatch chosen pipeline steps to raise; drive with `asyncio.run(...)` (no pytest-asyncio dependency).
- Direct unit assertions on `build_failure_details` for the transient/permanent derivation pair (e.g. `httpx.ConnectError` → `retryable True`; `ValueError` → `retryable False`).

**Leg B — persistence through real rag-api code.**
`run_transactional_update` binds `@firestore.transactional` at import time, so the decorator — not just the client — must be real-or-fake at import. Two supported variants; the test harness implements one behind a small seam:

- **Variant B1 (primary, hermetic fakes, subprocess):** a `python -c` subprocess (house pattern from the AST scripts in `test_api_contracts.py`) that (i) installs a fake `firebase_admin.firestore` module exposing `transactional` as an identity decorator (executes the body directly; no retry-on-abort — acceptable for a contract test), `SERVER_TIMESTAMP`, and `client()`; (ii) stubs the remaining cloud modules per the existing integration conftest list; (iii) imports rag-api `main`, grabs `run_transactional_update`; (iv) seeds a fake in-memory Firestore (documents with `exists`/`to_dict`, `transaction.update`, `collection("processing").document("summary").set(merge=True)`) with a `processing`-status resource; (v) runs the failed-branch update with the captured payload; (vi) prints the resulting main doc + summary subdoc as JSON. Zero infrastructure; runs anywhere pytest runs.
- **Variant B2 (strengthening, Firestore emulator):** same subprocess shape but with real `firebase_admin` + `google-cloud-firestore`, `FIRESTORE_EMULATOR_HOST` set, app initialized in emulator mode (the branch both services already have). Use when the hermetic stack is running and the SDK is importable in the test environment. **Open item:** confirm at implementation time which variant the CI environment supports; B1 is the default because it has no service or SDK-availability dependencies.

Payload hand-off between legs: leg A writes captured payloads to a temp file (JSON); leg B's subprocess reads them — keeps each import environment clean.

### 7.2 Representative-stage matrix (FR-7a)

| Scenario | Raised at (monkeypatched) | Expected stage | Expected retryable |
|---|---|---|---|
| Early, transient | `_get_extracted_text` → `httpx.ConnectError` | `text_retrieved` | `True` |
| Early, permanent | `_validate_processing_request` → `PermissionError` | `starting` | `False` (unknown → conservative) |
| Late, transient | `_generate_embeddings_with_openrouter` → `httpx.ReadTimeout` | `embeddings_complete` | `True` |
| Late, permanent | `store_chunks_via_service` → `RuntimeError` (partial-write class) | `embeddings_complete` | `False` |

Two scenarios (one early, one late) are the mandatory minimum; the matrix above is the recommended full set. These pin the set-before-await mechanism — enough to catch the tracker being removed or bypassed without ossifying every step.

### 7.3 Assertions (FR-7c/d)

Per scenario, after leg B:
- main doc: `status == "failed"`; `error == payload["error_message"]`; `error_stage == payload["stage"]`; `retryable == payload["retryable"]` — and explicitly **not** `"Processing failed"` / `None` / an underived `True`.
- summary subdoc: `error.message == payload["error_message"]`; `error.stage == payload["stage"]`; `error.code == "UNKNOWN"`; `stage == payload["stage"]`.
- captured payload key set `== {"error_message", "stage", "retryable", "error"}` exactly.

### 7.4 Static drift guards (FR-8, in-process, pure `ast` — no service imports needed)

- **Worker guard:** parse `rag-worker-service/main.py`; assert the failure-details construction contains the literals `error_message`, `stage`, `retryable`, `error`, and that the six stage-name literals of FR-3 appear as tracker assignments in `process_document`.
- **rag-api guard:** parse `rag-api-service/main.py`; assert `run_transactional_update`'s failed branch reads `error_message`, `stage`, `retryable` and writes main-doc keys `error`, `error_stage`, `retryable`, and the summary error keys `code`/`message`/`stage`.
- Guards assert key **presence** (not code shape) to stay brittle only where brittleness is the point: key drift.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained (FR-5); residual risk accepted as low; audit-and-drop deferred |
| Stage-tracker drift as the pipeline evolves | Set-before-await convention documented; representative early/late tests + stage-literal AST guard |
| `retryable=False` for genuinely-transient-but-unrecognized failures | Accepted per Definition; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key later means touching the test |
| Fake `transactional` decorator diverges from real semantics (no abort/retry) | Acceptable for value-contract assertions; B2 emulator variant strengthens when available |
| Worker `main.py` import weight in tests (spacy/sklearn/tiktoken/langchain) | Established stub-conftest already makes it importable for unit tests; subprocess isolation prevents polluting the shared test process |

## 9. Alternatives considered

- **Change rag-api to read `error`** — rejected: rippling against three consistent write paths and two models; the Definition forbids it (constraint 1).
- **Invent a storage stage (e.g. `vector_storage`)** — rejected: the Definition pins the vocabulary; post-embeddings failures report `embeddings_complete`.
- **Structured error codes now** — rejected per prefer-not; `error.code` stays `"UNKNOWN"`.
- **Change the sweep or retry mechanics** — rejected; out of scope, already consistent.

## 10. Implementation checklist (touched files)

1. `apps/ai-server/rag-worker-service/main.py` — add `build_failure_details` (module-level, near `classify_error`); add `current_stage` tracker + set-before-await assignments in `process_document`; rewire the exception handler (§3.3); optionally enrich the failure log (FR-11).
2. `apps/ai-server/tests/integration/test_worker_failure_contract.py` — new contract test (legs A/B, §7).
3. `apps/ai-server/tests/integration/conftest.py` (or a test-local stub module) — extend with the worker stub set, additive only, keeping the existing rag-api setup intact.
4. **No changes:** `rag-api-service/main.py`, `rag-api-service/models/resource.py`, worker sweep/heartbeat/claim, `_publish_status_update` signature and mechanics, frontend.

## 11. Open questions (resolve at implementation)

- Which persistence variant (B1 fakes vs B2 emulator) the CI environment supports out of the box; B1 is the default.
- Exact reuse mechanism for the worker stub set (inline copy vs loading `rag-worker-service/tests/conftest.py` via importlib); duplication is a minor, acceptable cost.
- Companion D3 issue scope: unavailable in this context; deferred per the Definition.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>