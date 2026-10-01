Both artifacts follow, built strictly from the authoritative Definition and the repository evidence verified during investigation (rag-api `run_transactional_update` failed branch, `_process_status_message`, `Resource`/`ResourceResponse` models, worker conftest stub patterns, `test_api_contracts.py` and `test_processing_lease.py` test infrastructure, `exceptions.py`).

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` · Objective: `obj-108` · Definition sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`

This document elaborates the authoritative Definition. On any conflict, the Definition wins.

## 1. Problem statement (verified current state)

- The worker's `process_document` exception handler publishes failed status with `details = {"error": str(e)}` via `_publish_status_update` (apps/ai-server/rag-worker-service/main.py).
- rag-api's failed branch in `run_transactional_update` (apps/ai-server/rag-api-service/main.py) reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)` and persists them as `error`, `error_stage`, `retryable` on the main resource document; the `processing/summary` error subdocument gets `{"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", "Processing failed"), "stage": details.get("stage")}`.
- Net effect today: every worker-originated failure persists `error = "Processing failed"` (fallback string), `error_stage = None`, `retryable = True` (silent default), and `error_code = "UNKNOWN"`.
- The `error` / `error_stage` / `retryable` persisted schema is already established on three other write paths (worker stale-lease sweep `_fail_if_still_stale`; rag-api enqueue-failure paths in `POST /process` and `POST /resources`) and is exposed by the `Resource` model and `ResourceResponse`. The worker's status publisher is the only writer that does not speak it.
- The worker has no stage tracking today: `process_document` is one large try block, so the failing stage is unknowable at failure time.
- Nobody tests the seam; the contract drifted silently.

## 2. Functional requirements

### FR-1 — Worker failure payload carries the full contract
When document processing fails, the worker's failed status payload `details` MUST include:
- `error_message`: the actual exception message (`str(e)`), never a placeholder;
- `stage`: the pipeline stage executing at failure time (see FR-2);
- `retryable`: a deliberately derived boolean (see FR-4).

The payload MUST NOT rely on rag-api's fallback defaults for any of these three keys. All three keys must be present and non-fallback on every worker-originated failure.

*Verification: contract test asserts persisted values equal worker-supplied values; key-set drift guard (FR-6).*

### FR-2 — Stage tracking through process_document
The worker MUST track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.
- Stage names MUST reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `processing` is the safe value when the stage is genuinely unknown (e.g., failure before the first stage transition) — the same value the stale-lease sweep uses for `error_stage`, so `error_stage` never regresses to null.
- Convention: the tracker is set immediately before each pipeline `await`.

*Verification: contract test pins the mechanism on two representative stages (early failure, late failure) — enough to catch the tracker being removed or bypassed without ossifying every step.*

### FR-3 — rag-api persists worker-provided values unchanged
rag-api's failed branch MUST persist the worker-provided values unchanged:
- main document: `error` ← payload `error_message`; `error_stage` ← payload `stage`; `retryable` ← payload `retryable`;
- `processing/summary` error subdocument: `message` ← payload `error_message`, `stage` ← payload `stage` (same values as the main document); `code` remains `"UNKNOWN"` unless a code is actually sent.

No reader changes, no persisted-field renames, no schema migration, no backfill.

*Verification: contract test asserts the persisted document fields equal the worker's payload values.*

### FR-4 — retryable is derived, not defaulted
The derivation MUST be explicit and aligned with the worker's ACK/NACK behavior, using the existing `classify_error()`:
- errors classified **transient** → `retryable: true` (Pub/Sub will redeliver);
- errors classified **permanent**, including unclassified-unknown per `classify_error`'s conservative default → `retryable: false` (message was acked; manual reprocess via `POST /process` remains available).

`classify_error()` itself MUST NOT be modified. The stale-lease sweep's separate direct write of `retryable: true` is untouched and stays correct (a dead worker is a transient condition).

Accepted behavior change: unclassified-unknown exceptions previously persisted `retryable: true` (silent default) and will now persist `false`. This is the intended conservatism of `classify_error`.

### FR-5 — Legacy `error` key retained (compatibility hedge)
The worker's failure payload MUST retain the legacy `error` key (same string value as `error_message`) alongside the new key, so any unknown consumer of the `rag-status-updates` topic and existing log tooling keep working. rag-api ignores it (it reads `error_message`); the cost is one redundant string per failure message.

### FR-6 — Contract test on the worker failure → rag-api persistence path
A contract test MUST exist and pass that:
- exercises the worker's failure-payload **construction** (not a hand-written fixture restating the contract);
- feeds the constructed payload through rag-api's `run_transactional_update` failed-branch persistence (via Firestore fakes or the Firestore emulator — both services have `FIRESTORE_EMULATOR_HOST` hermetic branches);
- asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and that the summary error subdocument carries the same message and stage;
- includes a **key-set drift guard**: a future edit to either side's payload keys fails the build instead of silently re-creating this bug;
- covers at least an early-stage failure and a late-stage failure (representative stage-tracker coverage).

*House pattern: apps/ai-server/tests/integration/test_api_contracts.py (fixture- and AST-based static contract tests, subprocess AST extraction precedent).*

### FR-7 — No migration
The fix MUST NOT require a Firestore migration, field rename, or backfill. Persisted fields keep their names (`error`, `error_stage`, `retryable`) and semantics.

## 3. Binding constraints (from the Definition)

| Type | Constraint |
|---|---|
| must | Align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`) — not change rag-api's reads or persisted schema. |
| must_not | No Firestore migration, field rename, or backfill of existing documents. |
| must | Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| prefer | Retain the legacy `error` key alongside `error_message`. |
| prefer_not | No structured error-code taxonomy (`error_code` values) in this fix. |

## 4. Acceptance criteria

1. A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. → FR-1, FR-2, FR-4.
2. After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value. → FR-3.
3. The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. → FR-3.
4. A contract test covering the worker failure → rag-api persistence path exists and passes, failing if either side's payload keys drift. → FR-6.

## 5. Non-goals

- Changing the stale-lease sweep's direct failure write (already contract-consistent).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy (summary `error.code` stays `"UNKNOWN"` unless a code is actually sent).
- Anything the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred), and reconciling with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## 6. Open items / unknowns carried forward (do not invent; resolve at implementation)

- The exact call signature/return shape of `classify_error()` in the worker was not re-verified line-by-line during investigation (worker main.py read was elided); the implementer must read it and derive `retryable` from its existing semantics without modifying it. The Definition pins the mapping (transient→true, permanent/unknown→false), not the call syntax.
- `apps/ai-server/rag-worker-service/exceptions.py` defines `PDFProcessingError` with a `retryable` *metadata* attribute (distinct from the central retry decision). Its relationship to `classify_error()` was not traced; out of scope to change — do not conflate the two.
- Full inventory of consumers of the `rag-status-updates` topic is unknown; the legacy `error` key hedge (FR-5) is the accepted mitigation.
- Whether a docker-compose hermetic test profile already wires a Firestore emulator service was not verified (only the emulator-mode code branches in both services are verified, plus Definition fact F10).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` · Companion to docs/requirements.md

## 1. The seam today

```
rag-worker-service                          rag-api-service
process_document                            _process_status_message (Pub/Sub subscriber)
  try:                                        payload keys: user_id, course_id,
    ...pipeline...                               resource_id, status, details
  except Exception as e:                            │
    _publish_status_update(                         ▼
      status="failed",                    run_transactional_update(db, doc_ref,
      details={"error": str(e)})  ←──╳────        new_status, details, ...)   ←──╳
    )                                     failed branch reads:
                                              error_message  (fallback "Processing failed")
Pub/Sub topic: rag-status-updates             stage          (fallback None)
                                              retryable      (fallback True)
                                          persists main doc: error / error_stage / retryable
                                          persists processing/summary error:
                                              {code: "UNKNOWN", message, stage}
```

`╳` marks the mismatch: the worker publishes one key (`error`); the consumer reads three different keys (`error_message`, `stage`, `retryable`). The message envelope itself (`user_id`, `course_id`, `resource_id`, `status`, `details`) is correct and unchanged — only the `details` key set is wrong.

Direction of the fix: **the worker aligns to the API.** The persisted field names (`error`/`error_stage`/`retryable`) are already consistent across the stale-lease sweep, both enqueue-failure paths, the `Resource` model, and `ResourceResponse`; rag-api is the contract's anchor. rag-api requires **no code changes**.

## 2. Target contract (worker → rag-api failure payload)

Envelope unchanged; `details` for `status: "failed"` becomes:

| key | type | source | notes |
|---|---|---|---|
| `error_message` | str | `str(e)` from the exception handler | required; persisted as main-doc `error` and summary `error.message` |
| `stage` | str | stage tracker (§3.1) | required; persisted as main-doc `error_stage` and summary `error.stage`; vocabulary = existing progress stages, `"processing"` as unknown-safe value |
| `retryable` | bool | derived from `classify_error(e)` (§3.2) | required; persisted as main-doc `retryable` |
| `error` | str | duplicate of `error_message` | legacy key retained for unknown topic consumers / log tooling; ignored by rag-api |

rag-api's fallbacks (`"Processing failed"`, `retryable=True`) remain in its code for any other publisher but become dead paths for worker failures — enforced by the contract test, not by removing the fallbacks (that would be a rag-api change, which is out of scope).

## 3. Worker changes (apps/ai-server/rag-worker-service/main.py)

### 3.1 Stage tracker
- Introduce a local `current_stage` in `process_document`, initialized to `"processing"`.
- Immediately before each pipeline `await`, set `current_stage` to that step's stage name, reusing the existing progress vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- The exception handler reports `current_stage`. A failure before any assignment (or genuinely unknown) yields `"processing"` — the same safe value the stale-lease sweep writes — so `error_stage` never regresses to null.
- Drift convention (documented in code at the tracker): *set the tracker immediately before the await*. A future pipeline step added without updating the tracker reports a stale stage; the contract test's two representative-stage scenarios catch the tracker being removed or bypassed.

### 3.2 retryable derivation
- In the exception handler, derive `retryable` from the existing `classify_error(e)`: transient-classified → `True`; permanent-classified (including unclassified-unknown, per its conservative default) → `False`.
- `classify_error()` is not modified. The implementer must read its actual signature/return at implementation time (not restated here — see requirements §6) and map its existing semantics to the boolean.
- Alignment rationale: the persisted record then tells the truth about ACK/NACK — transient errors are ones Pub/Sub will redeliver; permanent errors were acked and leave `POST /process` manual reprocess as the path.

### 3.3 Failure-payload builder (testability seam)
- Extract the failure-`details` construction into a small pure helper (suggested name: `build_failure_details(message, stage, retryable)`) that returns the four-key dict of §2, always including `error_message`, `stage`, `retryable`, and legacy `error`.
- The exception handler: classify → derive `retryable` → call the builder with `current_stage` → pass the result to `_publish_status_update` (its signature/envelope unchanged).
- The contract test exercises this builder directly, so it tests the worker's real construction code path rather than a fixture copy of the contract.

### 3.4 What does not change
- `_publish_status_update` envelope and topic; progress-update payloads; stale-lease sweep (`_fail_if_still_stale` keeps writing `error`/`error_stage`/`retryable` directly, `retryable=True`); ACK/NACK policy, leases, heartbeats; `exceptions.py` (`PDFProcessingError.retryable` metadata is untouched and is not the derivation source).

## 4. rag-api changes

None. The failed branch of `run_transactional_update` already reads `error_message`/`stage`/`retryable`, persists `error`/`error_stage`/`retryable` on the main document, and writes `error.message`/`error.stage` (with `error_code` defaulting to `"UNKNOWN"`) into `processing/summary`. Constraint: no reader or persisted-schema changes; no migration or backfill.

## 5. Contract test design

New file: `apps/ai-server/tests/integration/test_rag_failure_contract.py`, following the house patterns in `test_api_contracts.py`.

### 5.1 Importing both sides (module-name collision)
Both services expose a module named `main`; `tests/integration/conftest.py` already puts rag-api on `sys.path` as `main` (imported as `rag_api_main` in the existing contract tests). The worker's `main` cannot also be imported under that name in the same pytest process. Options, in preference order:
1. **importlib under an alias** — load `rag-worker-service/main.py` as e.g. `rag_worker_main`, with the heavy-dependency stub set proven in `rag-worker-service/tests/conftest.py` (`openai`, `langfuse`, `langchain.*`, `spacy`, `tiktoken`, `tenacity`, `google.cloud.*`, `firebase_admin.*`, …) installed first.
2. **Subprocess** for the worker-side construction (precedent: `_get_agent_graph_shapes` runs a script via `subprocess` in `test_api_contracts.py`) — use if the stub set proves brittle in-process.

### 5.2 Firestore fakes (hermetic default)
`run_transactional_update` is a module-level function taking `db` as its first argument and only needs `db.transaction()` plus `firestore.transactional` and `firestore.SERVER_TIMESTAMP`. Reuse the fake pattern proven in `rag-worker-service/tests/unit/test_processing_lease.py`: `FakeTx`/`FakeSnap`/`FakeRef`/`FakeDb` plus monkeypatching `firestore.transactional` with an identity decorator and `SERVER_TIMESTAMP` with a sentinel.
- Seed the resource document with `status: "processing"` — `ALLOWED_TRANSITIONS` only permits `processing → failed`; other current statuses are silent no-ops, so the seed state is part of the test setup, not an incidental.
- Exercise the canonical document path (`users/{uid}/resources/{rid}`); the legacy course-path fallback is out of scope for this test.
- The Firestore-emulator variant (both services have `FIRESTORE_EMULATOR_HOST` branches) is optional; fakes are the default because they need no emulator dependency.

### 5.3 Scenarios
- **Early-stage failure**: stub the pipeline so the first step raises; assert persisted `error` == the exception message, `error_stage` == the tracker's stage (e.g. `"starting"`), and `retryable` per the classification of the raised exception; assert summary `error.message`/`error.stage` match the main document.
- **Late-stage failure**: raise at the embeddings step; assert `error_stage` == `"embeddings_complete"` and the opposite `retryable` polarity from scenario A (one transient-classified, one permanent/unknown-classified exception across the two scenarios covers both branches of the derivation).
- **Builder unit checks** (worker suite): the builder always emits all four keys; `error` == `error_message`; `stage` defaults to `"processing"` when passed unknown/None.

### 5.4 Drift guard
- Behavioral: assert `set(worker_failure_details.keys()) == {"error_message", "stage", "retryable", "error"}` — any added/removed/renamed key on the worker side fails.
- Static (optional, house-precedent AST pattern): scan rag-api's failed branch for `details.get("error_message"|"stage"|"retryable")` via a subprocess AST script, so a rename on the consumer side also fails the build.

## 6. Runtime behavior after the change

Failed-job sequence: worker claims resource (`processing`) → pipeline step N raises → handler classifies via `classify_error` → builds `{error_message, stage: current_stage, retryable, error}` → publishes on `rag-status-updates` → rag-api subscriber resolves the document path → `run_transactional_update` persists `error`/`error_stage`/`retryable` on the main doc and `error{code:"UNKNOWN", message, stage}` in `processing/summary` → ACK/NACK per existing policy (unchanged).

Deliberate behavior changes (both accepted per the Definition):
1. Persisted `error` becomes the real exception message instead of `"Processing failed"`; `error_stage` becomes the real stage instead of `None`.
2. Unclassified-unknown exceptions persist `retryable: false` instead of the silent `true` default.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained alongside `error_message`; residual risk accepted as low; dropping the duplicate later is trivial cleanup after an audit. |
| Stage-tracker drift as the pipeline evolves | "Set before the await" convention documented at the tracker; contract test pins the mechanism on representative early/late stages. |
| `retryable=false` for genuinely-transient-but-unrecognized failures | Accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains. |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key later means touching the test. |

## 8. Implementation checklist → acceptance mapping

1. Worker: stage tracker + builder + retryable derivation + legacy `error` key → acceptance 1.
2. rag-api: no changes; verify passthrough → acceptance 2, 3.
3. Contract test (fakes default, emulator optional) with drift guard and two stage scenarios → acceptance 4.
4. Run existing suites (`rag-worker-service/tests`, `rag-api-service/tests`, `tests/integration`) to confirm no regression; no migration step anywhere.

## 9. Unknowns preserved

See requirements §6: `classify_error` exact signature (read at implementation), `exceptions.py` relationship to classification (untraced, out of scope), status-topic consumer inventory (unknown, hedged), companion D3 issue contents (unavailable, deferred), hermetic compose profile for the emulator (unverified; fakes are the default path).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>