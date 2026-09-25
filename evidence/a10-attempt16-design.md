I've reviewed the worker, the API, the models, and the existing contract-test infrastructure. The authoritative definition is fully consistent with the code: the worker's `process_document` except-block publishes `{"error": str(e)}` while rag-api's `run_transactional_update` failed branch reads `error_message`/`stage`/`retryable`; `classify_error`, the stage vocabulary, and the fake-Firestore test patterns are all in place exactly as the definition's facts claim. I've designed the alignment around a small dependency-light payload module (so the cross-service contract test can import the worker side without main.py's heavy import side effects), a pre-await stage tracker, and a behavioral drift guard.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path=".sle/work/wi-define-108-a8/design.md">>>
# Design — rag-worker → rag-api failure payload contract alignment

WorkItem: `wi-define-108-a8` · Step: design · Iteration: 1
Authoritative source: definition artifact `definition:obj-108` (sha256-pinned). This design implements exactly that scope; nothing wider.

---

## 1. Problem and scope

The worker publishes `failed` status with `details = {"error": str(e)}` (`apps/ai-server/rag-worker-service/main.py`, `process_document` except handler). rag-api's failed branch (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update`) reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`. Every worker-originated failure therefore persists the fallback string, a null `error_stage`, and a fabricated `retryable: true`, mirrored into the `processing/summary` error subdocument with `code: "UNKNOWN"`.

Fix direction (pinned by the definition): **the worker aligns to the API**, not vice versa. No rag-api reader changes, no persisted-field renames, no migration or backfill. Non-goals are as listed in the definition (retry/backoff mechanics, stale-lease sweep, frontend, error-code taxonomy, companion D3 issue scope).

---

## 2. Requirements

| ID | Requirement | Source (definition) |
|----|-------------|---------------------|
| REQ-1 | The worker's `failed` status payload must carry `error_message` (actual exception message), `stage` (failing stage), and `retryable` (deliberately derived). rag-api's fallback defaults must never be the operative mechanism for worker failures. | Requirement 1, AC-1 |
| REQ-2 | `process_document` must track the currently executing stage; the failure handler reports the true failing stage. Stage names reuse the existing progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`); `"processing"` is the safe value when the stage is genuinely unknown. | Requirement 2, F9 |
| REQ-3 | rag-api's failed branch persists worker values unchanged: `error` ← `error_message`, `error_stage` ← `stage`, `retryable` ← `retryable`; the `processing/summary` error subdocument carries the same message and stage (code stays `"UNKNOWN"` — no `error_code` is sent). This mapping is verified in code and pinned by test, not modified. | Requirement 3, F4, AC-2, AC-3 |
| REQ-4 | `retryable` is derived explicitly from `classify_error(e)`: transient → `true`; permanent, including unclassified-unknown (classify_error's conservative default), → `false`. The same function and the same exception instance drive ACK/NACK in `run_worker`, so the persisted record equals the actual retry behavior. | Requirement 4, F7, F8 |
| REQ-5 | The payload retains the legacy `error` key (same value as `error_message`) as the compatibility hedge for unknown consumers of the status topic. | Constraint (prefer), F11 |
| REQ-6 | A contract test must exercise the worker's failure-payload construction and rag-api's failed-branch persistence end-to-end (fakes/emulator) and assert persisted `error`, `error_stage`, `retryable` equal the worker's values. It must fail if either side's payload keys drift. | Requirement 5, AC-4 |
| REQ-7 | No Firestore migration, field rename, or backfill; `error`/`error_stage`/`retryable` keep names and semantics on the persisted document. | Constraint (must_not) |

---

## 3. Architecture

### 3.1 End-to-end failure path (target)

```
process_document (worker)
  ├─ stage tracker local updated before each pipeline await   (REQ-2)
  └─ except Exception as e:
       details = build_failure_payload(e, current_stage)      (REQ-1, REQ-4, REQ-5)
         → {"error_message", "stage", "retryable", "error"}
       _publish_status_update(..., "failed", details, job_id)
             │  Pub/Sub topic rag-status-updates (message adds jobId, sequence, timestamp)
             ▼
_process_status_message (rag-api) → run_transactional_update
       main doc:      error ← error_message, error_stage ← stage, retryable ← retryable   (unchanged code)
       summary doc:   error{message, stage}, stage, code "UNKNOWN"                        (unchanged code)
```

### 3.2 New module: `apps/ai-server/rag-worker-service/failure_payload.py`

Extract the pure failure-contract logic out of `main.py` into a dependency-light module importing **only `httpx`** (plus stdlib):

- `ProcessingError`, `TransientError`, `PermanentError` — moved verbatim.
- `classify_error(e) -> bool` — moved verbatim (type checks, httpx transient types, 429/5xx status heuristic, conservative `False` for unknown).
- `UNKNOWN_STAGE = "processing"` — the safe stage value (same value the stale-lease sweep writes to `error_stage`).
- `build_failure_payload(exc: Exception, stage: Optional[str]) -> dict` — the single construction point for the failed-payload `details`:

```python
def build_failure_payload(exc, stage=None):
    message = str(exc)
    return {
        "error_message": message,
        "stage": stage or UNKNOWN_STAGE,
        "retryable": classify_error(exc),
        "error": message,   # legacy key retained (F11 hedge)
    }
```

Rationale:
1. **Test seam.** Importing worker `main.py` executes heavy module-level setup (Pub/Sub subscriber, credential loading, langchain/spacy/tiktoken imports). The contract test in the cross-service suite (`apps/ai-server/tests/integration/`) must import the worker side cheaply; `failure_payload.py` imports only `httpx`, which that suite already depends on.
2. **Single source of truth for the contract.** The drift guard and both call sites reference one function instead of a dict literal inside a 1,400-line module.
3. **Consistency by construction.** `run_worker`'s ACK/NACK and the payload's `retryable` call the same pure function on the same exception object.

`main.py` re-exports for compatibility: `from failure_payload import ProcessingError, TransientError, PermanentError, classify_error, build_failure_payload`. Existing references (`main.classify_error`, any `from main import …` elsewhere in the service) keep working unchanged; behavior of ACK/NACK is untouched.

### 3.3 Stage tracking in `process_document`

A local `current_stage: str = "processing"` initialized at the top of the `try`. Convention (pinned by the definition): **set the tracker immediately before the await of each step**, using the name of the stage whose completion that step publishes:

| Code position (before await of) | `current_stage` | Progress milestone published on success |
|---|---|---|
| `_validate_processing_request` | `"starting"` | `{"stage": "starting"}` |
| `_get_extracted_text` | `"text_retrieved"` | `{"stage": "text_retrieved", ...}` |
| `content_tagger.generate_tags` | `"tagging_complete"` | `{"stage": "tagging_complete", ...}` |
| summary generation + Firestore summary write | `"summary_generated"` | `{"stage": "summary_generated", ...}` |
| `_create_enhanced_chunks` | `"chunking_complete"` | `{"stage": "chunking_complete", ...}` |
| `_generate_embeddings_with_openrouter` | `"embeddings_complete"` | `{"stage": "embeddings_complete", ...}` |

Semantics: the reported stage names the **pipeline phase during which the failure occurred**, labeled by that phase's completion milestone. E.g. a failure inside `_get_extracted_text` reports `text_retrieved` ("failed during the text-retrieval phase"), which is the finest granularity the existing vocabulary supports.

Documented residual coarseness (accepted): the post-embedding steps (`delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save, resource-map generation, usage update) have no vocabulary entry after `embeddings_complete` and no new stage names may be introduced (definition constraint). The tracker therefore remains `"embeddings_complete"` through them. A late-stage failure from vector storage reports `embeddings_complete`; this is honest at vocabulary resolution and matches the last progress event clients saw.

The safe value `"processing"` fires only if a failure escapes on a path not covered by the convention (e.g. a future step added without a tracker update, or an exception before the first assignment) — the field never regresses to `null`, and it matches the stale-lease sweep's `error_stage` value, so the vocabulary stays closed.

### 3.4 Failure payload shape (worker → rag-api)

Except handler in `process_document` becomes:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    details = build_failure_payload(e, current_stage)
    self.logger.error("document_processing_failed", ..., error=str(e),
                      stage=details["stage"], retryable=details["retryable"])
    await self._publish_status_update(user_id, course_id, resource_id, "failed", details, job_id)
```

Published `details` (after `_publish_status_update` adds `jobId`):

```json
{
  "error_message": "<actual exception message>",
  "stage": "<pipeline stage | processing>",
  "retryable": true|false,
  "error": "<same as error_message — legacy>",
  "jobId": "<job id>"
}
```

No `error_code` is sent → summary `error.code` stays `"UNKNOWN"` (prefer-not constraint honored). No `progress` is sent → summary `progress` persists `0`, matching current behavior for failures.

### 3.5 rag-api side — verified unchanged

`run_transactional_update` already implements REQ-3 exactly; **zero code changes** in `rag-api-service`. Confirmed from source:
- `main_update["error"] = details.get("error_message", "Processing failed")`, `error_stage = details.get("stage")`, `retryable = details.get("retryable", True)`.
- Summary: `error = {"code": details.get("error_code", "UNKNOWN"), "message": details.get("error_message", ...), "stage": details.get("stage")}`; top-level summary `stage` becomes the failing stage (previously `"unknown"` fallback for worker failures).

Known pre-existing behaviors, deliberately untouched: the transition guard (`processing → failed` required — worker failures always occur post-claim, so this holds); a late worker failure arriving after the stale-lease sweep already wrote `failed` is rejected by the transition guard and logged (unchanged); the sweep keeps writing its direct `retryable: true` record (non-goal).

---

## 4. Test design

### 4.1 Contract test (cross-service) — `apps/ai-server/tests/integration/test_worker_failure_contract.py`

Follows the house pattern of `test_api_contracts.py` (same conftest: rag-api on `sys.path`, cloud SDKs mocked, `import main as rag_api_main`). The worker side is loaded via `importlib` from `rag-worker-service/failure_payload.py` under a distinct module name (light import: `httpx` only).

Firestore fake (adapted from the proven `FakeTx`/`FakeSnap`/`FakeRef`/`FakeDb` in `rag-worker-service/tests/unit/test_processing_lease.py`, extended with `collection()`/`document()` on refs): seeds a `{"status": "processing"}` doc; `firestore.transactional` monkeypatched to identity and `SERVER_TIMESTAMP` to a sentinel, exactly as the lease tests do. `run_transactional_update` is called directly with a stub logger.

Cases:
1. **Transient early-stage failure** — `build_failure_payload(TransientError("boom"), "text_retrieved")` fed through `run_transactional_update`. Assert main doc `error == "boom"` (not `"Processing failed"`), `error_stage == "text_retrieved"` (not None), `retryable is True`. Assert summary `error.message == "boom"`, `error.stage == "text_retrieved"`, `error.code == "UNKNOWN"` (AC-2, AC-3).
2. **Permanent late-stage failure** — `PermanentError` at stage `"embeddings_complete"` → `retryable is False` persisted (REQ-4, pins the deliberate behavior change for classified-permanent errors).
3. **Key-drift guard (behavioral, the core regression catcher)** — hand-craft a `details` dict where `error_message` and the legacy `error` deliberately differ. Feed it through and assert the persisted `error` equals `error_message`, **not** the legacy `error` and not the fallback. If the worker renames `error_message` (case 1/2 fail on fallback) or the API starts reading `error`/changes keys (this case fails), the build breaks.
4. **Worker payload key-set guard** — `set(build_failure_payload(...)) == {"error_message", "stage", "retryable", "error"}` and values pairwise consistent (`error == error_message`, `retryable == classify_error(exc)`, stage default `"processing"` for `None`). Adding/removing a key requires touching this test — intentional per the definition.
5. **Single-classifier identity guard** — assert `rag_worker_main_module.classify_error is failure_payload.classify_error` (worker suite side) so ACK/NACK and payload classification can never fork.

Emulator note: the fake path above is the default; the definition permits fakes *or* the Firestore emulator, and both services have emulator branches. Fakes are chosen: they are hermetic, already patterned in-repo, and exercise the exact code under test (`run_transactional_update`'s transaction body) without Pub/Sub transport.

### 4.2 Worker-side tests (`apps/ai-server/rag-worker-service/tests/`)

Run under the worker suite (existing stub conftest provides all heavy-SDK stubs; `asyncio_mode = auto`).

- `tests/unit/test_failure_payload.py` — pure-function tests: transient types (incl. `httpx.ConnectTimeout`, 429/503 `HTTPStatusError`) → `retryable True`; permanent types (4xx, `ValueError`) → `False`; unclassified-unknown (`RuntimeError("weird")`) → `False` (pins F8's deliberate change); `stage=None` → `"processing"`; legacy `error` key present and equal.
- `tests/unit/test_failure_stage_tracking.py` — exercises `process_document` on a stub-built processor instance (mocked `_publish_status_update` via AsyncMock recording calls):
  - **Early failure**: `_validate_processing_request` raises `TransientError` → published failed `details` carry `error_message`, `stage == "starting"`, `retryable is True`.
  - **Late failure**: stubs succeed until `_generate_embeddings_with_openrouter` raises a permanent error → `stage == "embeddings_complete"`, `retryable is False`.
  - **Exception parity**: for the same raised exception, the payload's `retryable` equals `classify_error(e)` (the ACK/NACK input).
  - Existing progress publishes untouched (non-failure paths assert no behavioral change).

---

## 5. Behavior changes and compatibility

1. **Deliberate**: unclassified-unknown exceptions now persist `retryable: false` (previously the silent `True` default). This matches `classify_error`'s conservatism and the worker's actual ack-and-skip behavior; manual reprocess via `POST /process` is unaffected. Widening `classify_error` is out of scope.
2. **Additive**: worker failed payloads gain `error_message`/`stage`/`retryable` and keep `error`; the only verified consumer (rag-api) reads the new keys; unknown consumers keep the old one (F11 hedge). Dropping the duplicate later is trivial cleanup after a consumer audit.
3. ** rag-api persisted schema**: unchanged (`error`, `error_stage`, `retryable`; summary `error{code,message,stage}`). `ResourceResponse`/`Resource` already expose the fields — no frontend work.

## 6. Risks and tradeoffs

- **Stage-tracker drift** as steps are added — mitigated by the update-before-await convention and the early/late representative-stage tests; accepted that a new step without a tracker update falls back to the last set stage.
- **Post-embedding coarseness** — failures after embedding generation all report `embeddings_complete`; accepted to keep the stage vocabulary closed.
- **`retryable=false` for unrecognized-transient errors** — accepted per definition F8; manual reprocess remains.
- **Module extraction regression risk** — mitigated by verbatim move + `main.py` re-export + the identity guard test; `run_worker`'s ACK/NACK code is unchanged.
- **Contract test ossification** — intentional; it is the drift guard.
- **conftest interference** — the cross-service test adds no global module stubs beyond what `tests/integration/conftest.py` already installs; the worker module is loaded under a private name so `main` still resolves to rag-api.

## 7. File change list

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/failure_payload.py` | **New** — exceptions, `classify_error`, `UNKNOWN_STAGE`, `build_failure_payload`. |
| `apps/ai-server/rag-worker-service/main.py` | Re-import the above (re-export); delete local duplicate definitions; add `current_stage` tracker with pre-await assignments; except handler uses `build_failure_payload(e, current_stage)` and logs stage/retryable. No other logic changes. |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | **New** — cross-service contract + drift guards (§4.1). |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` | **New** — payload/classification unit tests. |
| `apps/ai-server/rag-worker-service/tests/unit/test_failure_stage_tracking.py` | **New** — stage-tracker behavior through `process_document`. |

## 8. Validation plan

- `pytest apps/ai-server/rag-worker-service/tests` (worker suite; hermetic via existing stub conftest).
- `pytest apps/ai-server/tests/integration/test_worker_failure_contract.py apps/ai-server/tests/integration/test_api_contracts.py` (cross-service suite; existing conftest environment).
- `./dev/run ai-server` for the full gate before PR; CI Backend Tests on the PR.

## 9. Traceability — definition acceptance criteria

| Acceptance criterion | Satisfied by | Verified by |
|---|---|---|
| AC-1: failed payload carries `error_message`/`stage`/`retryable`, no reliance on API fallbacks | REQ-1/2/4 → §3.2, §3.3, §3.4 | `test_failure_payload.py`, `test_failure_stage_tracking.py`, contract cases 1–2 |
| AC-2: persisted `error` = actual message, `error_stage` = failing stage, `retryable` = derived | REQ-3/4 → §3.5 (unchanged API) + §3.2/§3.4 | Contract cases 1–2 main-doc asserts |
| AC-3: summary error subdocument carries same message and stage | REQ-3 → §3.5 | Contract case 1 summary asserts |
| AC-4: contract test exists, passes, fails on key drift either side | REQ-6 → §4.1 | `test_worker_failure_contract.py` cases 3–5 |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>