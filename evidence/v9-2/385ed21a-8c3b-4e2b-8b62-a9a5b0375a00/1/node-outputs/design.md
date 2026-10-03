<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- Cycle intent: `rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage`
- Authoritative source: WorkItem `wi-define-108-a8`, Definition artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document restates that Definition as implementable requirements; it does not widen, narrow, or reinterpret it.
- Step: design (planning depth: minimal), Run 385ed21a-8c3b-4e2b-8b62-a9a5b0375a00, Iteration 1.

## 1. Problem statement

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam.

- The worker's `process_document` exception handler (`apps/ai-server/rag-worker-service/main.py`, ≈L1139–1144, verified) publishes failed status with a one-key details payload: `{"error": str(e)}` via `_publish_status_update(user_id, course_id, resource_id, "failed", details, job_id)`.
- rag-api's failed branch (`run_transactional_update`, `apps/ai-server/rag-api-service/main.py`, per Definition F4) reads the details keys `error_message`, `stage`, and `retryable`, persists them as `error` / `error_stage` / `retryable` on the main resource document, and writes `message` / `stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary error subdocument.
- Net effect (Definition F5): every worker-originated failure persists `error = "Processing failed"` (fallback string), `error_stage = None`, and `retryable = True` (silent default). The processing/summary subdocument inherits the same fallbacks, with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures.
- The persisted failure schema `error` / `error_stage` / `retryable` is already established across every other write path: the worker's stale-lease sweep `_fail_if_still_stale` (verified via `tests/unit/test_processing_lease.py`, which asserts the sweep writes `retryable is True`), rag-api's enqueue-failure paths (`/process`, `POST /resources`), and the `Resource` model / `ResourceResponse` (Definition F6). The worker's status publisher is the only writer that does not speak this schema.

## 2. Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## 3. Scope

### 3.1 In scope
- The worker's failed-status payload: key set, stage tracking through `process_document`, and retryable derivation.
- A preservation specification for rag-api's failed branch (the code does not change; its behavior is pinned by test).
- A contract test covering the worker failure → rag-api persistence path, wired so CI actually runs it.

### 3.2 Out of scope / non-goals (binding, from the Definition)
- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred — see §9).

## 4. Functional requirements

**FR-1 — Failure payload keys.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys. (Definition requirement 1; facts F1, F3, F4, F5.)

**FR-2 — Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. (Definition requirement 2; facts F9, F8.)

**FR-3 — rag-api persistence preservation.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage. rag-api's reads and the persisted schema are NOT modified (see C-1/C-2); this requirement pins existing behavior so the contract test can enforce it. (Definition requirement 3; fact F4.)

**FR-4 — Retryable derivation.** The retryable value must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`. (Definition requirement 4; facts F7, F8.)

**FR-5 — Contract test.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must fail if either side's payload keys drift. It must run in CI on changes to either service (see docs/architecture.md §6.3 for the verified CI wiring). (Definition requirement 5; fact F10.)

**FR-6 — Legacy key retention** (prefer-grade, from constraint C-4). The worker retains the legacy `error` key in the failure payload alongside `error_message`, with the same value, for continuity with any existing consumers of the status topic and log tooling. (Definition constraint "prefer"; fact F11.)

## 5. Contract specification (normative)

### 5.1 Worker → status topic: failed-status details keys

| Key | Value | Status |
|---|---|---|
| `error_message` | `str(e)` — the actual exception message | new (contract key) |
| `stage` | stage-tracker value at failure time (§5.3) | new (contract key) |
| `retryable` | deliberately derived boolean (§5.4) | new (contract key) |
| `error` | `str(e)` — identical to `error_message` | retained (legacy hedge, FR-6) |

### 5.2 rag-api persistence mapping (unchanged behavior, pinned by FR-3/FR-5)

| Payload key | Persisted target |
|---|---|
| `error_message` | main document `error` |
| `stage` | main document `error_stage` |
| `retryable` | main document `retryable` |
| `error_message`, `stage` | processing/summary error subdocument `message`, `stage` |
| (absent) | subdocument `error_code` defaults to `"UNKNOWN"` |

rag-api's `details.get(...)` fallbacks (`"Processing failed"` / `None` / `True`) remain in the code for other/legacy publishers but must be dead paths for worker-originated failures.

### 5.3 Stage vocabulary and tracker semantics

| Pipeline phase | Tracker value (set immediately before the phase's await) |
|---|---|
| Function entry / validation / claim / early setup | `starting` |
| PDF/text extraction | `text_retrieved` |
| Tagging | `tagging_complete` |
| Summary generation | `summary_generated` |
| Chunking | `chunking_complete` |
| Embedding generation | `embeddings_complete` |
| Post-embedding steps (vector delete/store, metadata save) | no distinct vocabulary name — tracker holds `embeddings_complete` |
| Genuine unknown / failure before any tracked assignment | `processing` (safe fallback; the same value the stale-lease sweep uses for `error_stage`) |

Semantics: the tracker names the pipeline phase in progress, identified by that phase's completion-milestone name from the existing progress-update vocabulary (verified progress updates publish exactly these names, e.g. `{"stage": "embeddings_complete", "progress": 80}`). Convention: set the tracker immediately before the await of each phase.

### 5.4 Retryable derivation rule

| `classify_error(e)` classification | Payload `retryable` |
|---|---|
| transient | `true` |
| permanent | `false` |
| unclassified-unknown (conservative default → permanent) | `false` |

Rationale (Definition F8): this aligns the persisted record with the worker's actual ACK/NACK behavior — transient errors are redelivered by Pub/Sub (retryable true); permanent errors are acked and will not return (retryable false; manual reprocess via `POST /process` remains). The stale-lease sweep's separate `retryable=true` write stays correct: a dead worker is a transient condition by nature (verified: `test_processing_lease.py` asserts the sweep writes `retryable is True`).

## 6. Constraints (binding, from the Definition)

- **C-1 (must):** The worker must be aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- **C-2 (must_not):** The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **C-3 (must):** Every worker-originated failure payload must carry `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **C-4 (prefer):** Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **C-5 (prefer_not):** Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

## 7. Accepted behavior change

Unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent under `classify_error`; after this change they persist `retryable: false`. This is the conservatism `classify_error` was written for (it prevents infinite retry loops); the manual reprocess path (`POST /process`) is unaffected. This flip is deliberate and accepted (Definition F8).

## 8. Acceptance criteria

- **AC-1:** A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. *Verification: worker unit tests on payload construction + derivation; contract-test key-set guard.*
- **AC-2:** After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. *Verification: contract-test persistence equality asserts.*
- **AC-3:** The processing/summary error subdocument for the failed job carries the same message and stage as the main document. *Verification: contract-test subdocument asserts.*
- **AC-4:** A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. *Verification: the contract test, executed by the `cross-service-and-contract-tests` CI job (see docs/architecture.md §6.3).*

## 9. Deferred items

- The companion D3 issue referenced by the Objective: its scope is not available in this context; anything it covers beyond this payload alignment is deferred (Definition F12).
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree per the Definition (not independently re-verified).
- Dropping the legacy `error` key: trivial future cleanup, contingent on a consumer audit of the status topic (fact F11).
- Widening `classify_error`'s heuristics: out of scope; only the *reporting* of retryability changes.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

Companion to docs/requirements.md (FR-1…FR-6, C-1…C-5, AC-1…AC-4). Design step output for Run 385ed21a, Iteration 1.

## 1. Context: the seam today (verified evidence)

- **Worker side** — `apps/ai-server/rag-worker-service/main.py` (2,252 lines, sha256 `7d7718bc…`): `process_document` is one large `try` block. Its exception handler (≈L1139–1144, verified) does:
  ```python
  except Exception as e:
      metrics.error_message, metrics.end_time = str(e), time.time()
      self.logger.error("document_processing_failed", ...)
      await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
      if trace: trace.update(output={"success": False, "error": str(e)})
      return metrics
  ```
  No stage tracking exists at failure time (Definition F9). Progress updates do publish stage milestones — verified example at Step 5: `await self._publish_status_update(..., "processing", {"stage": "embeddings_complete", "progress": 80}, job_id)` — so the vocabulary already exists on the topic.
- **API side** — `apps/ai-server/rag-api-service/main.py` (91,214 bytes): the failed branch of `run_transactional_update` reads details keys `error_message` / `stage` / `retryable` with fallbacks, persists `error` / `error_stage` / `retryable` on the main document, and writes `message` / `stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary subdocument (Definition F4, binding).
- **Conforming writers already in place** — the worker's stale-lease sweep `_fail_if_still_stale` (verified via `rag-worker-service/tests/unit/test_processing_lease.py`: the sweep failure path asserts `retryable is True`), rag-api's enqueue-failure paths, and the `Resource` model / `ResourceResponse` (Definition F6).
- **Classification machinery** — `classify_error()` (TransientError/PermanentError plus type- and status-code heuristics; unknown exceptions classify as permanent) drives ACK/NACK in `run_worker` (Definition F7, binding). Related but distinct: `rag-worker-service/exceptions.py` (verified) defines `PDFProcessingError` carrying a `retryable` *metadata* attribute, with the docstring noting the retry *decision* lives elsewhere. Per the Definition, `classify_error` is the single derivation source for the payload's `retryable`; do not create a second source of truth from the exception attribute.
- **Emulator support** — both services have `FIRESTORE_EMULATOR_HOST` branches; the worker's is verified in `_init_services` (initializes `firebase_admin` with `projectId` from `GCP_PROJECT`).

## 2. Design decisions

- **D1 — The worker aligns to the API.** The persisted field names (`error`/`error_stage`/`retryable`) are already consistent across three other write paths and two response models; changing the API side is the change that ripples. The worker is the odd one out. No migration, no backfill, no reader changes (C-1, C-2).
- **D2 — Derive `retryable`, don't default it.** Reuse `classify_error`, the same function that drives ACK/NACK, so the persisted record tells the truth about whether Pub/Sub will redeliver (FR-4, C-3).
- **D3 — Stage tracker with an update-before-await convention.** A local in `process_document`, using the existing progress-milestone vocabulary; `"processing"` as the safe unknown value (FR-2).
- **D4 — Retain the legacy `error` key.** Only rag-api's status subscriber is a verified consumer; the duplicate key is cheap insurance against unknown readers of the shared topic (FR-6, F11).
- **D5 — Behavioral contract test in the existing shared suite, with a stdlib-only worker payload builder.** The test imports both sides rather than restating the contract in a fixture. Because the shared CI job does not install worker dependencies (§6.3), the worker's failure-payload construction is factored into a dependency-free module that both `main.py` and the contract test import.

## 3. Worker changes (`apps/ai-server/rag-worker-service`)

### 3.1 New module: `failure_payload.py` (stdlib-only)

```python
FAILURE_PAYLOAD_KEYS = frozenset({"error", "error_message", "stage", "retryable"})

def build_failure_payload(*, stage: str, error_message: str, retryable: bool) -> dict:
    return {
        "error": error_message,        # legacy key, retained (FR-6)
        "error_message": error_message,
        "stage": stage,
        "retryable": retryable,
    }
```

- No imports beyond `typing` at most. This is what makes the payload construction importable from `apps/ai-server/tests/integration/` without `openai`/`langfuse`/`firebase_admin` (the shared CI job installs only rag-api and agent-graph requirements — verified, §6.3).
- `FAILURE_PAYLOAD_KEYS` is the single source of truth for the worker-side key set; the contract test imports it for the drift guard.
- Placement is a recommendation; the binding properties are: (a) it is the worker's real payload-construction code, (b) it imports nothing heavy, (c) it lives under `rag-worker-service/`.

### 3.2 Stage tracker in `process_document`

- Initialize `current_stage = "processing"` immediately before the `try` (safe unknown; the same value the stale-lease sweep uses for `error_stage`, so `error_stage` never regresses to `null`).
- First tracked assignment inside the try: `current_stage = "starting"`.
- Immediately before each phase's `await`, assign that phase's milestone name per the table in docs/requirements.md §5.3: extraction → `"text_retrieved"`, tagging → `"tagging_complete"`, summary → `"summary_generated"`, chunking → `"chunking_complete"`, embeddings → `"embeddings_complete"`.
- Steps without a distinct vocabulary name (post-embedding vector delete/store, metadata save) do not advance the tracker; it correctly holds the most recent phase boundary.
- Semantics: the tracker names the phase *in progress*, identified by its completion-milestone name — a failure during extraction reports `text_retrieved`, reading naturally next to the progress timeline clients already see.
- **Convention (drift guard):** set the tracker immediately before the await. A future pipeline step added without a tracker assignment reports a stale stage; the contract test pins representative early and late stages to catch the tracker being removed or bypassed without ossifying every step.

### 3.3 Retryable derivation in the exception handler

- Rule (FR-4): transient-classified → `True`; permanent-classified, including unclassified-unknown → `False`, using `classify_error(e)`.
- Implementation note: `classify_error`'s exact return shape (bool / enum / string) was not independently verified in this step; Definition F7 is authoritative on its semantics. Adapt the comparison expression to the real signature at implementation time, and pin the mapping with unit tests (§6.1) so any future change to `classify_error`'s default surfaces immediately.

### 3.4 Exception handler rewrite

Before (verified current code):
```python
await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
```
After:
```python
retryable = <derive from classify_error(e): transient→True, permanent/unknown→False>
payload = build_failure_payload(stage=current_stage, error_message=str(e), retryable=retryable)
await self._publish_status_update(user_id, course_id, resource_id, "failed", payload, job_id)
```
Unchanged: `metrics.error_message` assignment, the `document_processing_failed` log line, the trace update, and the `return metrics`. Logging and metrics already capture the raw message; only the published payload is enriched.

## 4. rag-api: intentionally unchanged

No code changes to `rag-api-service`. FR-3 is a preservation specification: the failed branch already reads `error_message`/`stage`/`retryable` and persists them as specified. After the worker change, the `details.get(...)` fallbacks (`"Processing failed"` / `None` / `True`) become dead paths for worker-originated failures but remain for any other/legacy publisher. `error_code` stays `"UNKNOWN"` unless a code is actually sent (C-5). Because the API does not change, there are no deploy-ordering constraints: the fix ships as a worker-only deploy, and the seam goes from broken to aligned the moment the new worker is live.

## 5. Message and persistence contract

Normative tables live in docs/requirements.md §5.1–§5.4. Summary of the seam after the change:

```
worker process_document (except)
  └─ build_failure_payload(stage=current_stage, error_message=str(e), retryable=<classify_error>)
       └─ _publish_status_update(..., "failed", payload, job_id)   → status topic
            └─ rag-api run_transactional_update (failed branch, unchanged)
                 ├─ main doc:      error ← error_message, error_stage ← stage, retryable ← retryable
                 └─ processing/summary subdoc: message ← error_message, stage ← stage, error_code "UNKNOWN"
```

## 6. Test architecture

### 6.1 Worker unit tests (`rag-worker-service/tests/unit/`)

Run automatically in CI: the `python-unit-tests` matrix includes `rag-worker-service` (verified in `.github/scripts/ci-detect-changes.sh` `UNIT_SERVICES`), and existing unit tests already import `main` successfully.

- **Payload builder:** exact key set equals `FAILURE_PAYLOAD_KEYS`; `payload["error"] == payload["error_message"]`; values pass through unchanged.
- **Derivation mapping (FR-4):** a transient-classified exception → `retryable True`; a permanent-classified exception → `False`; an unrecognized exception type → `False` (conservative default). Pins the behavior change from §7 of requirements.
- **(Optional, design intent) stage tracker:** force an early failure through `process_document` with the FakeDb/FakeTx pattern from `test_processing_lease.py` and assert the payload's `stage == "starting"`.

### 6.2 Contract test (added to `apps/ai-server/tests/integration/test_api_contracts.py`)

Location rationale: this file is the designated contract-test home (Definition F10) and is already executed by CI (§6.3). It follows the house fixture/AST pattern today; this addition is behavioral, which the Definition's FR-5 requires ("exercise … via the Firestore emulator or fakes").

- **Cases (representative stages, per the Direction):**
  1. Early-stage failure: `stage="starting"`, `retryable=False`, error message ≠ `"Processing failed"`.
  2. Late-stage failure: `stage="embeddings_complete"`, `retryable=True`.
  Choosing `retryable=False` in at least one case and a non-fallback message ensures the API's silent defaults would fail the asserts.
- **Flow:** build the payload through the worker's real `build_failure_payload` → feed it through rag-api's failed-branch persistence (`run_transactional_update`) against fakes → assert the persisted `error`, `error_stage`, and `retryable` equal the payload's `error_message`, `stage`, and `retryable`; assert the processing/summary subdocument `message`/`stage` match the main document and `error_code == "UNKNOWN"`.
- **Drift guards (FR-5 "fail if either side's keys drift"):**
  - Worker side: assert `set(payload) == FAILURE_PAYLOAD_KEYS` — any key added/removed/renamed in the builder fails the build.
  - API side: the behavioral equality asserts — if rag-api stops reading `error_message`/`stage`/`retryable`, persistence reverts to the fallbacks (`"Processing failed"`/`None`/`True`), which mismatch the chosen values and fail.
- **Fakes:** adapt the `FakeTx`/`FakeSnap`/`FakeRef`/`FakeDb` + `_tx_identity` + `SERVER_TIMESTAMP` monkeypatching pattern verified in `rag-worker-service/tests/unit/test_processing_lease.py` to `run_transactional_update`'s actual Firestore surface. **Implementation-time unknown:** `run_transactional_update`'s exact call pattern was not fully read in this step — shape the fake against the real calls during implementation. The Firestore-emulator variant (both services support it; worker branch verified) is available for local runs, but the CI cross job runs no emulator, so fakes are the CI path.
- **Imports:** rag-api's `main` imports cleanly under the existing `apps/ai-server/tests/integration/conftest.py` (verified: it mocks `firebase_admin`, `google.cloud.*`, `google.cloud.pubsub_v1`, `google.oauth2.*`, `structlog`, sets `GCP_PROJECT`/`GOOGLE_APPLICATION_CREDENTIALS`/`SHARED_INTERNAL_TOKEN`, and puts `rag-api-service` on `sys.path`; its comment explicitly invites extending the mock list if imports grow). The worker helper is stdlib-only, so no new mocks or dependencies are needed.

### 6.3 CI wiring (verified topology — no workflow edits required)

From `.github/workflows/backend-tests.yml` and `.github/scripts/ci-detect-changes.sh`:

- The `cross-service-and-contract-tests` job runs `pytest tests/integration/test_api_contracts.py` explicitly (working directory `apps/ai-server`).
- The change detector sets `cross=true` when `rag-worker-service/` **or** `rag-api-service/` changes (both are explicitly listed). This change touches `rag-worker-service` → the contract test runs.
- The cross job pip-installs `rag-api-service/requirements.txt` and `agent-graph-service/requirements.txt` (CPU-torch script) plus pytest/httpx — **not** `rag-worker-service/requirements.txt`. Hence D5: the payload builder must stay stdlib-only; do not import worker `main.py` from the shared suite. If that is ever needed, extend the conftest mock list per its own instruction and/or add worker requirements to the job — out of scope here.
- **Trap 1:** `rag-worker-service` is absent from `INTEGRATION_SERVICES`, so `pytest rag-worker-service/tests/integration/` never runs in CI (that directory is empty today, containing only `__init__.py`). Do not place the contract test there.
- **Trap 2:** editing `backend-tests.yml` sets the change detector to "everything changed" for that run. This design requires zero workflow edits; keep it that way.
- Worker unit tests (§6.1) run in the `python-unit-tests` leg for `rag-worker-service` automatically.

## 7. Compatibility and rollout

- No Firestore migration, rename, or backfill (C-2). Persisted field names and semantics unchanged.
- Legacy `error` key retained in the payload (FR-6/D4); dropping it later is trivial cleanup after a consumer audit of the status topic (F11).
- Deploy is worker-only (§4); no cross-service coordination, no ordering constraints.
- Residual risk of unknown topic consumers reading the old key set is mitigated by the retained `error` key and accepted as low.

## 8. Risks and tradeoffs

| Risk | Mitigation / disposition |
|---|---|
| Unknown consumers of the status topic read only the old `error` key | Legacy key retained alongside `error_message`; residual risk accepted as low (F11) |
| Stage-tracker drift as the pipeline evolves | Update-before-await convention + representative early/late-stage contract cases |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted (Definition F8); widening `classify_error` is out of scope; manual reprocess via `POST /process` remains |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key later means touching the test |
| Fake fidelity for `run_transactional_update` | Shape the fake against the real calls at implementation; lease-test fakes as the template; emulator variant available locally |
| `classify_error` signature assumption | Semantics pinned by Definition F7/F8; expression adapted at implementation; unit tests pin the mapping |

## 9. Traceability matrix

| Requirement | Design element | Verification |
|---|---|---|
| FR-1 payload keys | §3.1 builder, §3.4 handler | unit builder test; contract key-set guard |
| FR-2 stage tracking | §3.2 tracker | contract early/late-stage cases; optional unit test |
| FR-3 rag-api preservation | §4 (no change) | contract persistence equality asserts |
| FR-4 retryable derivation | §3.3 | unit derivation-mapping tests |
| FR-5 contract test | §6.2 | contract test in `cross-service-and-contract-tests` job |
| FR-6 legacy `error` key | §3.1 | unit builder test asserts key present |
| AC-1…AC-4 | §3, §6 | mapped in docs/requirements.md §8 |

## 10. Evidence and uncertainty ledger

**Verified directly by file reads this step:** worker exception-handler payload `{"error": str(e)}` and `_publish_status_update(...)` call signature; progress-update stage-details shape (`{"stage": "embeddings_complete", "progress": 80}`); worker `FIRESTORE_EMULATOR_HOST` branch in `_init_services`; `exceptions.py` (`PDFProcessingError.retryable` metadata); `test_processing_lease.py` (sweep writes `retryable is True`; FakeTx/FakeDb pattern); `tests/integration/conftest.py` (mock list, sys.path, env); `backend-tests.yml` (job topology, cross-job pytest command, installs); `ci-detect-changes.sh` (UNIT/INTEGRATION service lists, `cross` triggers); `docs/` layout (no pre-existing requirements.md/architecture.md).

**Taken from the authoritative Definition (binding; not independently re-read in full):** rag-api failed-branch key reads, fallbacks, and persistence mapping (F4); model/`ResourceResponse` exposure (F6); `classify_error` semantics and ACK/NACK role (F7); consumer landscape of the status topic (F11); absence of `plans/upload-flow.md` (F12).

**Implementation-time unknowns to resolve during implement:** `classify_error`'s exact signature/return shape; `run_transactional_update`'s exact Firestore call surface (for fake construction); detailed contents of `rag-worker-service/tests/conftest.py` (read this step but not retained in detail).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>