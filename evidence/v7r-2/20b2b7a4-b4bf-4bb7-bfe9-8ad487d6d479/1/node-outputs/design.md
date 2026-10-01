Design complete. Both contracted artifacts follow, derived strictly from the authoritative Definition and the repository evidence verified this run (rag-api `run_transactional_update` failed branch, `_process_status_message` envelope, `models/resource.py`, the contract-test suite and its `conftest.py` mocking pattern, and the rag service architecture docs).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

| Field | Value |
| --- | --- |
| Cycle intent | rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage |
| Run / step | 20b2b7a4-b4bf-4bb7-bfe9-8ad487d6d479 · iteration 1 · step: design |
| Authoritative source | WorkItem `wi-define-108-a8`, artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5` (binding; this document restates it as numbered requirements without widening, narrowing, or reinterpreting it) |
| Key verified evidence | `apps/ai-server/rag-api-service/main.py` (sha256 `579b0bdf…`: `run_transactional_update` failed branch, `_process_status_message`, Firestore-emulator startup branch, `ResourceResponse`), `apps/ai-server/rag-api-service/models/resource.py`, `apps/ai-server/rag-worker-service/main.py` (sha256 `7d7718bc…`, inspected), `apps/ai-server/tests/integration/test_api_contracts.py` and `tests/integration/conftest.py`, `apps/ai-server/docs/architecture/backend-services/rag-services/*.md` |

## 1. Problem statement

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures (Definition fact F1). Today the two sides of the worker→rag-api seam were written against different contracts:

- The worker's `process_document` exception handler publishes failed status with details `{"error": str(e)}` via `_publish_status_update` (F3, verified evidence ref).
- rag-api's failed branch in `run_transactional_update` reads `details` keys `error_message`, `stage`, and `retryable`, and persists `error`, `error_stage`, and `retryable` on the main resource document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument (F4, verified in source).

Because of the key mismatch, every worker-originated failure currently persists `error` as the fallback `"Processing failed"`, `error_stage` as `None`, and `retryable` as the silent default `True` (F5). The `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

The persisted failure schema `error` / `error_stage` / `retryable` is already established across three other write paths (worker stale-lease sweep `_fail_if_still_stale`, rag-api enqueue-failure paths on `/process` and `POST /resources`) and is exposed by `ResourceResponse` and the `Resource` model (`retryable` defaults `True`) (F6, verified in `models/resource.py` and rag-api `main.py`). The worker's status publisher is the only writer that does not speak this contract.

## 2. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## 3. Functional requirements

### FR-1 — Failure payload completeness (worker)

When document processing fails, the worker's failed status payload `details` must include:

- `error_message`: the actual exception message (`str(e)`),
- `stage`: the pipeline stage executing at failure time,
- `retryable`: a deliberately derived boolean.

The payload must never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for these keys. Verification: contract test (FR-5) plus code inspection.

### FR-2 — Stage tracking through `process_document` (worker)

The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.

- Stage names must reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` (F9).
- `processing` is the safe value when the stage is genuinely unknown (e.g., failure before the first stage assignment); it is the same value the stale-lease sweep uses for `error_stage`, so the persisted field never regresses to `null`.
- Verification: contract test scenarios T-1, T-2, T-4 (see architecture doc §6).

### FR-3 — rag-api passthrough persistence (unchanged behavior, pinned)

rag-api's failed branch must persist the worker-provided values unchanged:

- main document: `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`;
- `processing/summary` error subdocument: `error.message` ← payload `error_message`, `error.stage` ← payload `stage` (same values as the main document).

The existing rag-api implementation already performs exactly this mapping (verified in `run_transactional_update`, rag-api `main.py` lines ~236–246 and ~288–294). No rag-api read or persisted-schema change is required; FR-3 is satisfied by preserving that behavior and pinning it with FR-5. The pre-existing `.get(...)` fallbacks remain in rag-api for other failure publishers; the requirement is only that worker failures never depend on them.

### FR-4 — Explicit retryable derivation (worker)

The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior in `run_worker` (F7):

| `classify_error(e)` outcome | Worker ACK/NACK behavior | Payload `retryable` |
| --- | --- | --- |
| Transient (TransientError or type/status-code heuristics) | NACK → Pub/Sub redelivers | `true` |
| Permanent (PermanentError or type/status-code heuristics) | ACK → no redelivery | `false` |
| Unclassified-unknown exception | Conservative default → permanent → ACK | `false` |

Rationale (adopted default, Definition fact F8): the persisted record must match the worker's actual retry behavior — transient errors are ones Pub/Sub will redeliver; permanent errors were acked and will not return (manual reprocess via `POST /process` remains available; the verified `ALLOWED_TRANSITIONS` include `failed → queued`). The stale-lease sweep's separate `retryable=true` write stays correct and unchanged: a dead worker is a transient condition by nature.

Deliberate behavior change: unclassified-unknown exceptions previously persisted `retryable: true` (silent default) and will now persist `false`. This is the conservatism `classify_error` was written for; it is accepted and must be documented in the change.

### FR-5 — Contract test on the worker→rag-api failure path

A contract test must cover the worker failure → rag-api persistence path. It must:

1. Exercise the worker's failure-payload construction through the worker's real code path (not a restated fixture).
2. Feed the produced payload through rag-api's `run_transactional_update` failed-branch persistence, via the Firestore emulator or fakes.
3. Assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and that the `processing/summary` error subdocument carries the same message and stage.
4. Fail if either side's payload keys drift (drift guard), so a future key edit breaks the build instead of silently re-creating this bug.
5. Pin the stage-tracking mechanism on representative stages (an early-stage failure and a late-stage failure) without ossifying every pipeline step.

The house pattern exists in `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests; direct import of rag-api `main` with mocked cloud dependencies via `conftest.py`), and both services support a hermetic Firestore-emulator mode (`FIRESTORE_EMULATOR_HOST` branches; verified in rag-api `startup()`) (F10).

## 4. Compatibility and integrity requirements

- **CR-1 (legacy key retained):** The worker retains the legacy `error` key alongside `error_message` in the failure payload, for continuity with any existing consumers of the status topic and log tooling (Definition prefer-constraint; hedge per F11 — only rag-api's status subscriber is a verified consumer).
- **CR-2 (no migration):** The fix must not require a Firestore migration, field rename, or backfill of existing documents; persisted fields `error`, `error_stage`, `retryable` keep their names and semantics (must-not constraint).
- **CR-3 (no error taxonomy):** No structured error-code taxonomy is introduced; the worker does not send `error_code`, so the summary `error.code` remains `"UNKNOWN"` (prefer-not constraint).
- **CR-4 (rag-api side untouched):** rag-api's reads and persisted schema are not changed (must constraint).
- **CR-5 (sweep untouched):** The stale-lease sweep's direct failure write is not changed (non-goal).
- **CR-6 (retry mechanics untouched):** Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals are not changed — only the *reporting* of retryability in the payload changes (non-goal).

## 5. Constraints (from the authoritative Definition)

| Type | Constraint |
| --- | --- |
| must | Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`), not the reverse. |
| must_not | No Firestore migration, field rename, or backfill; persisted fields keep names and semantics. |
| must | Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| prefer_not | Do not introduce a structured error-code taxonomy. |

## 6. Acceptance criteria

| ID | Criterion (from the Definition) | Satisfied by |
| --- | --- | --- |
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | FR-1, FR-2, FR-4; verified by FR-5 test |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | FR-3 + FR-1/2/4; verified by FR-5 test |
| AC-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | FR-3; verified by FR-5 test |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | FR-5 |

## 7. Assumptions (adopted design decisions, recorded ASSUMED in the Definition)

- **A-1 (= F8):** `retryable` is derived from `classify_error(e)`: transient → `true`; permanent, including unclassified-unknown per `classify_error`'s conservative default, → `false`.
- **A-2 (= F11):** The legacy `error` key is retained in the worker's failure payload as a compatibility hedge; no consumer other than rag-api's status subscriber is verified. If a later audit confirms the worker is the only publisher and rag-api the only consumer, dropping the duplicate is trivial cleanup (out of scope here).

## 8. Deferred

- **D-1 (= F12):** The companion D3 issue referenced by the Objective is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is out of scope. Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` is likewise deferred (that file is not present in the current tree; the reference comes from the Objective text).

## 9. Implementation-time confirmations (non-normative unknowns)

- **U-1:** Exact line-level insertion points and helper naming inside `rag-worker-service/main.py`. The Definition pins the seam (the `process_document` exception handler and the `_publish_status_update` call, per F3) and the stage vocabulary (F9); precise code placement is an implementation detail.
- **U-2:** The full import-time dependency list of `rag-worker-service/main.py` for the contract-test mock set. The mocking pattern is verified for rag-api (`tests/integration/conftest.py` mocks `firebase_admin`, `google.cloud.*`, `structlog`, …); the worker's equivalent list is enumerated during implementation.
- **U-3:** CI availability of the Firestore emulator for hermetic runs. Emulator support is verified in rag-api `startup()` and asserted for both services (F10); CI wiring is confirmed during implementation. A fake-based fallback is specified in the architecture doc (§6.2, Option C).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

| Field | Value |
| --- | --- |
| Scope | Worker→rag-api failure payload alignment per `definition:obj-108` (`wi-define-108-a8`, sha256 `71f1c39c…`); requirements in `docs/requirements.md` |
| Verified anchors | `apps/ai-server/rag-api-service/main.py` (sha256 `579b0bdf…`), `apps/ai-server/rag-api-service/models/resource.py`, `apps/ai-server/rag-worker-service/main.py` (sha256 `7d7718bc…`, inspected), `apps/ai-server/tests/integration/{test_api_contracts.py,conftest.py}` |

## 1. Context: the seam as verified

**Consumer side (rag-api, verified in source).** `_process_status_message` parses the status-topic envelope `{user_id, course_id, resource_id, status, details}` and calls `run_transactional_update(db, doc_ref, new_status, details, logger, user_id)` in a thread. The failed branch of `run_transactional_update`:

```python
# main document update (verified)
main_update["error"]       = details.get("error_message", "Processing failed")
main_update["error_stage"] = details.get("stage")
main_update["retryable"]   = details.get("retryable", True)

# processing/summary subdocument (verified)
summary_update["stage"] = details.get("stage", "unknown")
summary_update["error"] = {
    "code":    details.get("error_code", "UNKNOWN"),
    "message": details.get("error_message", "Processing failed"),
    "stage":   details.get("stage"),
}
```

The transition table allows `processing → failed` and `failed → queued` (verified), which is what keeps manual reprocess via `POST /process` available after a permanent failure.

**Producer side (worker, per Definition facts F3/F5/F7/F9).** `process_document`'s exception handler publishes failed status with details `{"error": str(e)}` via `_publish_status_update`; `classify_error()` classifies exceptions as transient/permanent (unknown → permanent, conservatively) and drives ACK/NACK in `run_worker`; progress updates already publish the stage vocabulary `starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete` — but the failure handler has no stage tracking today.

**Resulting bug:** every worker failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True` (fabricated), and a summary error subdocument with `code="UNKNOWN"` and fallback message.

**Design principle:** the persisted failure schema (`error`/`error_stage`/`retryable`) is already consistent across the stale-lease sweep, rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse` (all verified). The worker's status publisher is the odd one out — fix the odd one out. No migration, no backfill, no reader changes.

## 2. Design decisions

| ID | Decision | Source |
| --- | --- | --- |
| D1 | The worker aligns to rag-api's contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are unchanged. | Definition must-constraint |
| D2 | Stage tracking via a local tracker in `process_document`, set immediately before each pipeline await, reported by the exception handler; vocabulary reused; `"processing"` as safe unknown. | Definition FR-2 / F9 |
| D3 | `retryable` derived from `classify_error(e)` — the same classification that drives ACK/NACK — so the persisted record tells the truth about redelivery. | Definition FR-4 / F8 |
| D4 | Legacy `error` key retained alongside `error_message` as a hedge for unknown topic consumers. | Definition prefer-constraint / F11 |
| D5 | The seam is pinned by a contract test that imports both sides and round-trips a sentinel payload through real persistence (emulator preferred, fakes as fallback), with an exact key-set drift guard. | Definition FR-5 / F10 |

## 3. The failure contract (specification of the seam)

### 3.1 Envelope (unchanged)

Worker → `rag-status-updates` topic → rag-api `_process_status_message`. Envelope keys verified on the consumer side: `user_id`, `course_id`, `resource_id`, `status`, `details`. The failure message uses the same envelope and publisher (`_publish_status_update`) as the existing progress updates (F9); only the `details` contents for `status="failed"` change.

### 3.2 Failure `details` schema (worker emits; this is the change)

| Key | Type | Required | Content |
| --- | --- | --- | --- |
| `error_message` | str | yes | Actual exception message (`str(e)`); never omitted |
| `stage` | str | yes | Stage executing at failure time; vocabulary per §4.1; `"processing"` when genuinely unknown; never `None` |
| `retryable` | bool | yes | Deliberately derived per §4.2; a real boolean, never omitted |
| `error` | str | yes (legacy) | Duplicate of `error_message`, retained per D4/CR-1 |
| `error_code` | — | **must not be sent** | Keeps summary `error.code` at `"UNKNOWN"` (CR-3) |

The canonical emitted key set is exactly `{"error_message", "stage", "retryable", "error"}`. This set is pinned by the drift guard (§6.4): adding or removing a key requires touching the test, which is the point.

### 3.3 rag-api mapping (unchanged; pinned by the test)

| Payload key | Persisted location | Field | Fallback (remains for other publishers; never operative for worker failures) |
| --- | --- | --- | --- |
| `error_message` | main doc | `error` | `"Processing failed"` |
| `stage` | main doc | `error_stage` | `None` |
| `retryable` | main doc | `retryable` | `True` |
| `error_message` | `processing/summary` | `error.message` | `"Processing failed"` |
| `stage` | `processing/summary` | `error.stage` and top-level `stage` | `None` / `"unknown"` |
| *(not sent)* | `processing/summary` | `error.code` | `"UNKNOWN"` |
| *(not sent)* | `processing/summary` | `progress` | `0` (unchanged behavior: worker failure payloads never carried progress) |

### 3.4 Invariants

- **I-1:** Every worker failure payload contains `error_message`, `stage`, `retryable` (non-null; `retryable` is a bool).
- **I-2:** Persisted `error` for a worker failure is the actual message, never the `"Processing failed"` fallback (unless the real message literally equals it).
- **I-3:** Persisted `error_stage` for a worker failure is never `None`; worst case is `"processing"`.
- **I-4:** Persisted `retryable` for a worker failure always comes from the worker's derivation; the `.get(..., True)` default is never operative.
- **I-5:** The legacy `error` key is present in the payload until a consumer audit justifies dropping it.
- **I-6:** Persisted field names and semantics are unchanged; no migration or backfill.

## 4. Worker changes (`apps/ai-server/rag-worker-service/main.py`)

### 4.1 Stage tracking

- Introduce a local tracker (e.g., `current_stage`) in `process_document`, initialized to `"processing"`.
- **Convention — set the tracker immediately before the await.** Each pipeline phase maps to its progress-vocabulary name: the stage name the worker publishes upon completing a phase (per F9's call sites) identifies the phase that was executing. Concretely: `starting` at process_document entry; `text_retrieved` before the text-retrieval step; `tagging_complete` before the tagging/analysis step; `summary_generated` before the summary step; `chunking_complete` before the chunking step; `embeddings_complete` before the embeddings step. The exact step→name mapping is confirmed at implementation against the existing `_publish_status_update` progress call sites (F9 pins the vocabulary; the call sites define the pairing).
- The exception handler reports the tracker value verbatim. If a failure occurs before the first assignment, the handler reports `"processing"` — the same value the stale-lease sweep uses for `error_stage`, so the persisted field never regresses to `null` (FR-2, I-3).
- **Known drift risk:** a future pipeline step added without updating the tracker reports a stale stage. Mitigated by the update-before-await convention and representative-stage test coverage (T-1/T-2), which catch the tracker being removed or bypassed without ossifying every step.

### 4.2 Failure payload construction

In the `process_document` exception handler (the seam pinned by F3), replace the one-key payload with:

```python
# shape, not literal implementation; naming/placement confirmed at implementation (U-1)
details = {
    "error_message": str(e),
    "stage": current_stage,                       # tracker from §4.1
    "retryable": classify_error(e) is transient,  # derivation per §4.2
    "error": str(e),                              # legacy key, D4
}
```

Implementation note (non-normative): the handler's existing error log should include `stage` and the classification outcome as structured fields so failures are disambiguatable in logs too; no new log pipeline is introduced. If direct invocation of the handler from the contract test is impractical, extract the payload construction into a small module-level builder in the same file (suggested name `_build_failure_details(message, stage, retryable)`) — a pure function importable under the conftest mock pattern.

### 4.3 Retryable derivation

`retryable = (classify_error(e) classifies as transient)`, i.e. transient → `true`; permanent — including unclassified-unknown, per `classify_error`'s conservative default — → `false` (FR-4 table). This makes the persisted record match ACK/NACK reality: transient errors are ones Pub/Sub will redeliver; permanent errors were acked and will not return, with manual reprocess via `POST /process` still available (verified `failed → queued` transition).

**Documented behavior change:** unclassified-unknown exceptions move from persisted `retryable: true` (silent default) to `false`. Accepted per the Definition; widening `classify_error` is out of scope.

### 4.4 Explicitly unchanged on the worker

- ACK/NACK policy, processing leases, heartbeat intervals (CR-6).
- The stale-lease sweep `_fail_if_still_stale` and its direct `error`/`error_stage="processing"`/`retryable=true` write (CR-5) — a dead worker is a transient condition, so `true` stays correct.
- Progress-update payloads and the status-topic envelope.

## 5. rag-api changes

**None required.** The failed branch already implements the FR-3 mapping exactly (verified). rag-api's reads, persisted schema, `Resource` model, `ResourceResponse`, transition table, and the pre-existing `.get(...)` fallbacks (which still serve the enqueue-failure paths) are all untouched. The contract test exists to *pin* this side so future drift fails the build.

## 6. Contract test design

### 6.1 Location and pattern

New contract-test module alongside the existing suite (e.g., `apps/ai-server/tests/contract/test_worker_failure_contract.py`), following the verified house patterns in `tests/integration/test_api_contracts.py`: import the real modules rather than restating the contract in a fixture; reuse the conftest style of env-var seeding (`GCP_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `SHARED_INTERNAL_TOKEN` — verified) and targeted dependency mocking.

### 6.2 Hermetic execution — emulator preferred, fakes as fallback

A verified constraint shapes this: `tests/integration/conftest.py` replaces `google.cloud.firestore` (and `firebase_admin`, `pubsub_v1`, …) with `MagicMock` for the whole `tests/integration` tree, so a real-persistence test placed there cannot exercise `@firestore.transactional` semantics. Options, in preference order:

- **Option A (preferred) — dedicated test root + Firestore emulator.** A new test root with its own conftest that (i) does not inherit the blanket mocks, (ii) requires `FIRESTORE_EMULATOR_HOST` (skip with a clear reason if absent — the emulator branch is verified in rag-api `startup()`: `initialize_app(options={"projectId": GCP_PROJECT | "demo-project"})`), and (iii) mocks only the non-Firestore cloud deps needed to import both services (worker-side list per U-2). `run_transactional_update` is module-level and takes `db` as a parameter (verified), so the test needs no app startup — only an emulator-backed `firestore.client()`.
- **Option B — conditional mocking in the existing conftest.** Skip the `google.cloud.firestore`/`firebase_admin` mocks when `FIRESTORE_EMULATOR_HOST` is set, keeping the existing tests untouched. Smaller structural change, but touches shared fixture behavior; must verify no existing test depends on unconditional mocks.
- **Option C (fallback) — purpose-built fakes.** If the test environment intentionally avoids installing the cloud SDKs or CI cannot run the emulator: register a minimal fake for `firestore.transactional` (passthrough decorator), `firestore.SERVER_TIMESTAMP`, and a fake `db`/`doc_ref`/transaction implementing `get`/`update`/`set` semantics, injected before importing rag-api `main`. Tradeoff: re-implements Firestore transaction semantics, weakening the "real persistence" guarantee — documented so the downgrade is conscious.

### 6.3 Scenarios

| ID | Scenario | Setup | Asserted payload | Asserted persistence |
| --- | --- | --- | --- | --- |
| T-1 | Early-stage transient failure | Exception (transient-classified) raised in the first pipeline step; publisher captured via a mocked `_publish_status_update` sink | `stage` = text-retrieval phase name; `error_message` = sentinel; `retryable = true`; `error` = sentinel | main: `error`/`error_stage`/`retryable` == payload values; summary: `error.message`/`error.stage` == same, `error.code == "UNKNOWN"`, `stage` == same |
| T-2 | Late-stage permanent failure | Permanent-classified exception raised in the embeddings step | `stage` = embeddings phase name; `retryable = false` | main `retryable == false`, `error_stage` == stage |
| T-3 | Unclassified-unknown exception | Generic exception matching neither TransientError nor heuristics | `retryable = false` (pins the deliberate behavior change) | persisted `retryable == false` |
| T-4 | Unknown-stage fallback | Failure before the tracker's first assignment | `stage == "processing"` | persisted `error_stage == "processing"` (never `None`) |
| T-5 | Key-set drift guard (worker side) | Any failure scenario | emitted `details` key set == `{"error_message", "stage", "retryable", "error"}` exactly | — |
| T-6 | Read/write-key drift guard (rag-api side) | Sentinel message distinct from `"Processing failed"` | — | persisted `error == sentinel`, `error_stage == sentinel stage`, `retryable == derived`; any rename on either side breaks the round-trip and fails |

Also assert `retryable` is a real `bool` (`isinstance`), not a truthy string.

Mechanics: seed a resource document at `status="processing"` on the canonical path `users/{uid}/resources/{rid}` (verified path preference); build the payload through the worker's failure path (§4.2; drive `process_document` with a step mocked to raise, capturing the published payload — or invoke the extracted builder for the pure payload cases); call `run_transactional_update(db, doc_ref, "failed", details, logger, user_id)`; read back the main document and the `processing/summary` subdocument and assert per the table.

### 6.4 Drift guards

- **Worker emit drift:** T-5's exact key-set assertion — any added/removed/renamed key fails the build and forces a conscious contract decision.
- **rag-api read drift:** T-6's sentinel round-trip — if rag-api stops reading `error_message`/`stage`/`retryable` (or renames the read), the fallback values (`"Processing failed"`/`None`/`True`) land instead of the sentinels and the assertions fail.
- **rag-api write drift:** if the failed branch stops writing a field, the persisted sentinel mismatch fails.
- Optional hardening (P2): an AST guard extracting the `details.get(...)` key literals from `run_transactional_update`'s failed branch, mirroring the verified AST-subprocess pattern used for agent-graph-service in `test_api_contracts.py`. Behavioral coverage above is already sufficient for the Definition's drift requirement; the AST guard is belt-and-braces.

## 7. Failure-path data flow (after the fix)

1. Exception raised inside `process_document`'s try block; the stage tracker holds the phase executing at failure time (or `"processing"`).
2. Exception handler classifies via `classify_error(e)` and builds `details = {error_message, stage, retryable, error}` (§4.2).
3. `_publish_status_update` publishes `status="failed"` with those details in the existing envelope.
4. rag-api `_process_status_message` resolves the document path (canonical preferred, verified) and runs `run_transactional_update` in a thread.
5. The failed branch validates `processing → failed`, persists `error`/`error_stage`/`retryable` on the main document and `error {code:"UNKNOWN", message, stage}` plus `stage` on the `processing/summary` subdocument — all from the worker's values, fallbacks inoperative.
6. Clients read the truth via `ResourceResponse` (`error`, `error_stage` exposed — verified); `retryable` is available on the `Resource` model (verified default `True`, now always worker-derived for worker failures).

## 8. Risks and mitigations

| Risk | Mitigation | Residual |
| --- | --- | --- |
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained (D4/CR-1) | Low; accepted. Dropping the duplicate later is trivial cleanup after a consumer audit |
| Stage-tracker drift as the pipeline evolves | Update-before-await convention; representative-stage pins T-1/T-2 | Accepted; convention documented in code |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted per Definition; `classify_error` widening out of scope; manual reprocess via `POST /process` (verified `failed → queued`) unaffected | Accepted |
| Contract test ossifies the payload | Intentional — that is the drift guard doing its job; adding a key means touching the test | None (by design) |
| Blanket conftest mocks block real persistence in `tests/integration` | Dedicated test root (Option A) or conditional mocks (Option B); fakes fallback (Option C) documented | Low |
| Emulator unavailable in CI | Option C fallback with documented tradeoff (U-3) | Low |

## 9. Non-goals (from the Definition)

- Changing the stale-lease sweep's direct failure write (already consistent with this contract).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the reporting of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy — summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this payload alignment (content unavailable; deferred, D-1), and reconciling with the D4 deviation note in the absent `plans/upload-flow.md`.

## 10. Traceability

| Acceptance | Requirement | Architecture element | Test |
| --- | --- | --- | --- |
| AC-1 | FR-1, FR-2, FR-4 | §4.1 stage tracker, §4.2 payload construction, §4.3 derivation | T-1, T-2, T-3, T-4, T-5 |
| AC-2 | FR-3 (+ FR-1/2/4) | §3.3 mapping (unchanged rag-api), §5 | T-1, T-2, T-3, T-6 |
| AC-3 | FR-3 | §3.3 summary mapping | T-1, T-2 |
| AC-4 | FR-5 | §6 contract test design | T-1…T-6 |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>