<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- Work item: `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c…e89cac5`)
- Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- Status source of truth: the Authoritative Definition is binding. This document restates its scope as testable requirements; it does not widen, narrow, or reinterpret it.

## 1. Problem statement

When RAG processing fails, the worker's exception handler in `process_document` publishes a one-key failure payload (`{"error": str(e)}`) to the status topic (verified: `apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler, ~lines 1088–1093). rag-api's failed branch in `run_transactional_update` reads three keys — `error_message`, `stage`, `retryable` — and persists them as `error`, `error_stage`, `retryable` on the main resource document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary error subdocument (Definition facts F4).

Because of the key mismatch, every worker-originated failure currently persists (F5):
- `error` = fallback string `"Processing failed"` (the worker's real exception message is discarded),
- `error_stage` = `None`,
- `retryable` = `True` (rag-api's silent `details.get("retryable", True)` default, not a derived value).

Users and support cannot disambiguate failures; retryability is fabricated rather than reported. The persisted `error`/`error_stage`/`retryable` schema is already spoken consistently by three other write paths (worker stale-lease sweep `_fail_if_still_stale`, rag-api enqueue-failure paths `/process` and `POST /resources`) and exposed by `ResourceResponse` and the `Resource` model (`apps/ai-server/rag-api-service/models/resource.py`, verified: `error: Optional[str]`, `error_stage: Optional[str]`, `retryable: bool = True`) — the worker's status publisher is the only writer that does not speak it (F6).

## 2. Scope

**In scope**
- The worker's failure status payload construction in `process_document`'s exception handler.
- Stage tracking through `process_document` so the failing pipeline stage is reportable.
- Deliberate derivation of `retryable` in the worker's failure payload.
- A contract test pinning the worker→rag-api failure path (payload construction → failed-branch persistence).

**Out of scope (non-goals, binding)**
- Changing the stale-lease sweep's direct failure write (already contract-consistent).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Anything the companion D3 issue covers beyond this worker→rag-api payload alignment (its content is unavailable in this context; F12). Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` is also deferred (that file is not present in the current tree).

## 3. Functional requirements

### FR-1 — Failure payload carries the full contract (must)
When document processing fails, the worker's failed status payload MUST include:
- `error_message`: the actual exception message (`str(e)`),
- `stage`: the pipeline stage executing at failure time,
- `retryable`: a deliberately derived boolean.

The payload MUST NEVER rely on rag-api's fallback defaults for these keys: `error_message` and `stage` must always be present and non-null, and `retryable` must always be present and explicitly derived. In particular, the persisted result must never be the fallback `"Processing failed"` / `None` / silent-`True` triple for a worker-originated failure.

### FR-2 — Stage tracking through process_document (must)
The worker MUST track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.
- Stage names MUST reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown (e.g. failure before the first stage transition); `stage` must never be omitted or null.
- The stage vocabulary MUST be the progress-update vocabulary, not the `ProcessingStage` enum vocabulary in `rag-worker-service/models/processing_status.py` (`pdf_download`, `text_extraction`, …), which is a different, parallel vocabulary.

### FR-3 — rag-api persists worker-provided values unchanged (must)
rag-api's failed branch MUST persist the worker-provided values unchanged:
- main document: `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`;
- processing/summary error subdocument: the same message and stage.

This requirement is satisfied by worker-side alignment — rag-api's reads and persisted schema MUST NOT change (see C-1, C-2). The contract test (FR-5) pins that this passthrough holds.

### FR-4 — Explicit retryable derivation aligned with ACK/NACK behavior (must)
The worker's `retryable` value MUST be derived explicitly from `classify_error(e)`:
- errors classified **transient** → `retryable: true` (Pub/Sub will redeliver; the record tells the truth about the NACK/retry path);
- errors classified **permanent**, including unclassified-unknown (per `classify_error`'s conservative default) → `retryable: false` (acked, will not come back; manual reprocess via `POST /process` remains available).

The derivation MUST be the same classification that drives ACK/NACK decisions in `run_worker` (F7), so the persisted record and the worker's actual retry behavior cannot disagree.

### FR-5 — Contract test on the worker failure → rag-api persistence path (must)
A contract test MUST cover the seam end to end:
- It MUST exercise the worker's failure-payload construction (through the worker's real code path, not a restated fixture) and rag-api's failed-branch persistence (`run_transactional_update`), via the Firestore emulator or fakes.
- It MUST assert the persisted `error`, `error_stage`, and `retryable` equal the worker's payload values.
- It MUST fail the build if either side's payload keys drift (a key-set drift guard on both the worker's published keys and rag-api's read keys).
- It MUST cover at least a representative early-stage failure and a representative late-stage failure, so the stage tracker's mechanism is pinned without ossifying every pipeline step.

### FR-6 — Retain the legacy `error` key (should / prefer)
The worker's failure payload SHOULD retain the legacy `error` key alongside `error_message` (same string value), for continuity with any existing consumers of the status topic and log tooling (F11 hedge; constraint P-1). Dropping the duplicate later, if an audit confirms rag-api is the only consumer, is trivial cleanup and explicitly permitted future work.

## 4. Data contract (normative)

### 4.1 Worker → status topic, `status = "failed"` payload

| Key | Type | Presence | Value |
|---|---|---|---|
| `error_message` | string | always | actual exception message (`str(e)`) |
| `stage` | string | always | failing stage from the progress-stage vocabulary; `"processing"` if genuinely unknown |
| `retryable` | boolean | always | derived per FR-4 |
| `error` | string | always (legacy) | identical to `error_message` |

Expected exact key set: `{"error_message", "stage", "retryable", "error"}`.

### 4.2 rag-api persistence (unchanged reads, unchanged schema)

| Persisted location | Field | Source |
|---|---|---|
| main resource document | `error` | payload `error_message` |
| main resource document | `error_stage` | payload `stage` |
| main resource document | `retryable` | payload `retryable` |
| processing/summary error subdocument | `message` | payload `error_message` |
| processing/summary error subdocument | `stage` | payload `stage` |
| processing/summary error subdocument | `code` | `"UNKNOWN"` unless a code is actually sent (no taxonomy in this fix) |

No Firestore migration, field rename, or backfill is required or permitted (C-2).

## 5. Constraints

| ID | Type | Constraint |
|---|---|---|
| C-1 | must | The worker is aligned to rag-api's existing contract (publishing `error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed. |
| C-2 | must_not | No Firestore migration, field rename, or backfill of existing documents; persisted fields `error`, `error_stage`, `retryable` keep their names and semantics. |
| C-3 | must | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| P-1 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| P-2 | prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## 6. Acceptance criteria

| ID | Criterion | Verification |
|---|---|---|
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | Worker unit test on the failure path: published payload keys and values asserted; keys always present. |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | Contract test assertion on the persisted main document. |
| AC-3 | The processing/summary error subdocument for the failed job carries the same message and stage as the main document. | Contract test assertion on the subdocument. |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | Contract test presence + drift-guard assertions; run in CI. |

## 7. Traceability

| Requirement | Definition support |
|---|---|
| FR-1 | F1, F3, F4, F5; constraint C-3; acceptance item 1 |
| FR-2 | F9; acceptance items 1–2 |
| FR-3 | F4, F6; constraints C-1, C-2; acceptance items 2–3 |
| FR-4 | F7, F8; constraint C-3 |
| FR-5 | F10; acceptance item 4 |
| FR-6 | F11; constraint P-1 |

Known behavior change accepted by the Definition (F8): unclassified-unknown exceptions currently persist `retryable: true` via the silent default but classify as permanent, so they will now persist `false`. This is the conservatism `classify_error` was written for; manual reprocess via `POST /process` is unaffected. The stale-lease sweep's separate `retryable: true` write remains correct (a dead worker is a transient condition) and is untouched.

## 8. Deferred

- Companion D3 issue referenced by the Objective: content unavailable in this context; anything beyond the worker→rag-api payload alignment is out of scope (F12).
- Reconciliation with the D4 deviation note in `plans/upload-flow.md`: file not present in the current tree; deferred.
- Dropping the legacy `error` key after a consumer audit: permitted future cleanup, not this fix.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

## 1. Context: the seam as it exists today

```
rag-worker (process_document)                     rag-api (status subscriber)
┌───────────────────────────────┐                 ┌──────────────────────────────────────┐
│ one large try block;          │   Pub/Sub       │ run_transactional_update, failed     │
│ except Exception as e:        │   status        │ branch reads details:                │
│   _publish_status_update(     │ ── topic ─────► │   error_message, stage, retryable    │
│     ..., "failed",            │                 │ persists on main doc:                │
│     {"error": str(e)},        │                 │   error ← error_message              │
│      job_id)                  │                 │   error_stage ← stage                │
└───────────────────────────────┘                 │   retryable ← retryable              │
  sends: {"error": ...}           MISMATCH        │   (+ message/stage/code into         │
                                                  │    processing/summary subdoc,        │
                                                  │    error_code default "UNKNOWN")     │
                                                  └──────────────────────────────────────┘
```

Verified worker-side failure handler (`apps/ai-server/rag-worker-service/main.py`, ~lines 1088–1093):

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    self.logger.error("document_processing_failed", ...)
    await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
    if trace: trace.update(output={"success": False, "error": str(e)})
    return metrics
```

The API-side failed-branch behavior is taken from the Authoritative Definition (F4, evidenceRef `apps/ai-server/rag-api-service/main.py`, `run_transactional_update`); the implementer should re-confirm the exact code when writing the contract test.

Consequence today (F5): every worker failure persists `error = "Processing failed"`, `error_stage = None`, `retryable = True` (silent default), and the processing/summary subdocument inherits the fallbacks with `error_code = "UNKNOWN"`.

Everything downstream already speaks the persisted schema: the worker's stale-lease sweep (`_fail_if_still_stale`) and rag-api's enqueue-failure paths write `error`/`error_stage`/`retryable` directly, and `Resource`/`ResourceResponse` expose them (`models/resource.py` verified: `error`, `error_stage`, `retryable: bool = True`). The worker's status publisher is the only writer off-contract.

## 2. Design decisions

**D1 — The worker aligns to the API, not vice versa.** Three other write paths and two response models already use `error`/`error_stage`/`retryable`; changing the API side would ripple (and could require a migration, which is forbidden by C-2). Fix the odd one out. Expected result: **zero rag-api code changes**; the contract test pins the seam against future drift.

**D2 — Stage tracking: a local tracker with a set-before-await convention.** `process_document` is one large try block, so at failure time nothing knows where it was. The fix is a local stage variable in `process_document`:

- Initialized to `"processing"` (the safe "genuinely unknown" value — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null).
- Set to the stage's vocabulary name **immediately before each pipeline step's await**. Stage names reuse the existing progress-update vocabulary (F9): `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. Where a step corresponds to an existing `_publish_status_update` progress call site, the tracker uses that same stage string, so a failure stage reads naturally next to the progress timeline clients already see.
- The exception handler reports the tracker's current value. `stage` is never omitted and never null.

Drift risk and mitigation: a future pipeline step added without updating the tracker reports a stale stage. The convention ("set the tracker immediately before the await") plus the contract test's representative early-stage and late-stage failure cases is the mitigation — enough to catch the tracker being removed or bypassed without ossifying every step.

**Vocabulary warning for implementers:** `rag-worker-service/models/processing_status.py` defines a `ProcessingStage` enum with a *different* vocabulary (`pdf_download`, `text_extraction`, `markdown_conversion`, `chunking`, `embedding_generation`, `weaviate_storage`, `resource_map`, `completed`) and a `ProcessingError` model with `code/message/stage/retryable`. Neither is used for this fix: the failure `stage` uses the progress-update vocabulary per FR-2, and no error-code taxonomy is introduced (P-2). Likewise `exceptions.py`'s `PDFProcessingError.retryable` metadata attribute is pre-existing and untouched; the binding derivation for the payload is `classify_error`-based (D3).

**D3 — `retryable` is derived, not defaulted.** The worker already classifies every exception via `classify_error()` (TransientError/PermanentError plus type- and status-code heuristics; unknown exceptions classify as permanent), and that classification drives ACK/NACK in `run_worker` (F7). The payload derives `retryable` from the same function (F8):

```python
retryable = <True if classify_error(e) classifies e as transient else False>
# transient            → retryable: true   (Pub/Sub will redeliver)
# permanent / unknown  → retryable: false  (acked; manual reprocess via POST /process)
```

This makes the persisted record tell the truth about the worker's actual retry behavior. One deliberate behavior change follows: unclassified-unknown exceptions flip from persisted `true` (the silent default) to `false` — that is `classify_error`'s conservatism doing its job, and the manual reprocess path is unaffected. The stale-lease sweep's separate direct write keeps `retryable: true`, which stays correct (a dead worker is a transient condition); the sweep is not modified.

**D4 — Compatibility hedge: retain the legacy `error` key.** Only rag-api's status subscriber is a verified consumer of these payloads; other services and tooling share the topic. The worker therefore publishes both `error_message` and the legacy `error` (identical string) — one redundant string per failure message as insurance against an unknown reader (F11). If a later audit confirms rag-api is the only consumer, dropping the duplicate is trivial cleanup.

**D5 — The contract test is the drift guard.** The bug existed because nobody tests the seam. The test imports both sides rather than restating the contract in a fixture, so a future edit to either side's keys fails the build instead of silently re-creating this bug.

## 3. Target data flow

```
process_document
  ├─ current_stage = "processing"                    # safe fallback
  ├─ (per step)  current_stage = "<stage>"; await step(...)
  │              # set IMMEDIATELY BEFORE the await; stage names from the
  │              # progress vocabulary: starting, text_retrieved,
  │              # tagging_complete, summary_generated, chunking_complete,
  │              # embeddings_complete
  └─ except Exception as e:
       details = {
         "error_message": str(e),        # actual message — never the API fallback
         "stage": current_stage,          # failing stage — never null/omitted
         "retryable": derived(e),         # classify_error: transient→True, permanent/unknown→False
         "error": str(e),                 # legacy key retained (D4)
       }
       await self._publish_status_update(..., "failed", details, job_id)
            │
            ▼  Pub/Sub status topic
       rag-api run_transactional_update failed branch (UNCHANGED)
            ├─ main doc:      error ← error_message; error_stage ← stage; retryable ← retryable
            └─ processing/summary subdoc: message ← error_message; stage ← stage;
                                          code ← "UNKNOWN" (unless actually sent)
```

## 4. Changes by component

| Component | Change |
|---|---|
| `rag-worker-service/main.py` — `process_document` | Add local stage tracker; set before each step's await per D2. Rewrite the exception handler's `_publish_status_update` details dict to the FR-1 key set, with `retryable` derived per D3. |
| `rag-worker-service/main.py` — everything else | No change. `_publish_status_update` transport, `classify_error`, `run_worker` ACK/NACK logic, `_fail_if_still_stale` sweep, leases, heartbeats are untouched. |
| `rag-worker-service/exceptions.py` | No change (its `PDFProcessingError.retryable` metadata attribute is pre-existing and out of scope). |
| `rag-api-service/main.py` | No change expected. The failed branch already reads `error_message`/`stage`/`retryable` and persists them (F4); FR-3 is satisfied by worker alignment and pinned by the contract test. |
| `rag-api-service/models/resource.py` | No change (`error`/`error_stage`/`retryable` already present; `retryable` defaults `True`). |
| `apps/ai-server/tests/…` | New contract test (§5) plus worker unit tests for the payload builder, stage tracker, and retryable derivation. |

## 5. Test architecture

### 5.1 Layers

**Worker unit tests** (`apps/ai-server/rag-worker-service/tests/unit/`, new file, e.g. `test_failure_payload.py`):
- Failure-payload construction: invoke the exception path of `process_document` (or the payload-building unit extracted for testability) with a raised exception; assert the published details contain exactly `{"error_message", "stage", "retryable", "error"}`, `error_message == str(e)`, `error == error_message`, `stage` non-null.
- Stage tracker: an early-stage failure (exception before/at the first step → `stage == "processing"` or the first vocabulary stage, per where the tracker is set) and a late-stage failure (e.g. around embeddings → the corresponding vocabulary stage). This pins the mechanism without ossifying every step.
- Retryable derivation table: a transient-classified exception → `true`; a `PermanentError`/permanently-classified exception → `false`; an unclassified-unknown exception → `false` (conservative default). Assert the derivation uses `classify_error` (same source as ACK/NACK).
- Infrastructure precedent (verified): `tests/unit/test_processing_lease.py` already tests worker Firestore write paths with `FakeTx`/`FakeSnap`/`FakeRef`/`FakeDb` fakes and monkeypatches `main.firestore.SERVER_TIMESTAMP` / `main.firestore.transactional`; `tests/conftest.py` stubs `firebase_admin`, `google.cloud.pubsub_v1` (Publisher/Subscriber clients), openai, langchain, etc. Capture published status payloads via the stubbed/mocked publisher. `pytest.ini`: `asyncio_mode = auto`.

**Seam contract test** (recommended placement `apps/ai-server/tests/integration/`, alongside the existing `test_api_contracts.py`; exact filename at implementer's discretion):
- Build the failure payload through the **worker's** code path (import the worker module; trigger the exception handler or its extracted builder).
- Feed that payload through **rag-api's** `run_transactional_update` failed branch (import the rag-api module) against the Firestore emulator or fakes.
- Assert the persisted main document: `error == payload["error_message"]`, `error_stage == payload["stage"]`, `retryable == payload["retryable"]` — i.e. the worker's values, not `"Processing failed"`/`None`/silent-`True`.
- Assert the processing/summary error subdocument carries the same message and stage (AC-3).
- Drift guard (FR-5): assert the worker payload's key set equals the contract set exactly, and use a per-key canary (distinct sentinel value per key) so a renamed/dropped key on either side fails loudly. An AST-based check of both `main.py` files for the key literals is an optional complement — the fixture- and AST-based pattern already exists in `tests/integration/test_api_contracts.py` (F10) with JSON fixtures under `tests/fixtures/api-contracts/`.

### 5.2 Hermetic execution modes

- **Firestore emulator**: both services support `FIRESTORE_EMULATOR_HOST` branches. Verified for the worker (`_init_services` initializes `firebase_admin` with `projectId` from `GCP_PROJECT`, default `"demo-project"`, when `GOOGLE_APPLICATION_CREDENTIALS` is unset and the emulator host is set); for rag-api it is a Definition fact (F10). Set `FIRESTORE_EMULATOR_HOST` + a `demo-*` `GCP_PROJECT` before importing the modules.
- **Fakes**: the worker-side `FakeTx`/`transactional`-monkeypatch precedent is verified; its direct applicability to rag-api's `run_transactional_update` transaction shape has not been verified in this investigation — the implementer should confirm, and fall back to the emulator mode if the API transaction does not fit the fake.

### 5.3 Module-isolation notes for the seam test

- Both services expose top-level `main.py` modules; import each under a unique module name (e.g. `importlib.util.spec_from_file_location`) after applying the relevant stub environment, to avoid `main` name collisions.
- Each service's own `tests/conftest.py` stubs its heavy dependencies (verified for both: worker stubs firebase_admin/pubsub/langchain/openai/spacy/tiktoken/tenacity; rag-api mocks firebase_admin, google.cloud.*, structlog). The top-level `apps/ai-server/tests/conftest.py` exists but its contents were not readable during investigation — verify what it stubs before relying on it when importing service modules from the integration suite.

### 5.4 Observation (no action required)

The static contract fixture `tests/fixtures/api-contracts/resource_response.json` (verified) lists `error` and `error_stage` in `expected_fields` but not `retryable`, while the `Resource` model exposes `retryable` (default `True`). Updating that fixture is not part of this fix's scope; noted so response-shape assertions in the new test are not confused by the fixture's field list.

## 6. Compatibility and rollout

- No Firestore migration, rename, or backfill (C-2): the persisted field names and semantics are untouched; only the *values* arriving through the existing failed branch become correct.
- The only publishing change is additive on the wire (new keys `error_message`/`stage`/`retryable` alongside the retained `error`), so the change is safe to roll out and trivially revertible (revert the worker's payload builder).
- rag-api needs no coordinated deployment: old payloads keep hitting its fallbacks until the worker ships; new payloads persist fully either way.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained (D4, P-1); residual risk accepted as low; dropping the duplicate later is trivial cleanup. |
| Stage-tracker drift as the pipeline evolves | "Set immediately before the await" convention; contract test pins the mechanism on representative early/late stages. |
| `retryable: false` for genuinely transient-but-unrecognized failures reduces auto-retry affordances | Accepted per the Definition (F8): `classify_error`'s conservative default prevents infinite retry loops; manual reprocess via `POST /process` remains. Widening `classify_error` is out of scope. |
| Contract test ossifies the payload | Intentional — that is the drift guard doing its job; adding a key later means touching the test. |
| Seam-test infrastructure friction (module isolation, emulator availability, API transaction shape vs fakes) | Both emulator branches and both service conftest stub sets verified to exist; worker-side fake precedent verified; API-side fake applicability flagged for implementer confirmation (§5.2). |

## 8. Open items / unverified specifics (flagged for implementation)

- The full enumerated list of pipeline steps and their `_publish_status_update` progress call sites inside `process_document`: the stage vocabulary and its order are Definition facts (F9), but the implementer must enumerate the actual call sites when placing the tracker (the worker `main.py` read during investigation was partial).
- rag-api's failed-branch line-level code: specified here from the Authoritative Definition (F4); re-confirm the exact reads/writes when writing the contract test.
- Contents of `apps/ai-server/tests/conftest.py`: unreadable during investigation (path not permitted); verify before adding the top-level integration test.
- `RetryHandler`, referenced by the `exceptions.py` docstring as the central retry-decision owner: location not verified in this investigation; this fix does not touch retry decision logic regardless.
- Companion D3 issue content and `plans/upload-flow.md` D4 note: unavailable/absent; deferred per the Definition (F12).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>