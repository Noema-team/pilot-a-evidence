The parse failure came from `###`-level subheadings inside the artifact body colliding with the section delimiter. Re-issuing the same design with all internal subheadings demoted below the `###` level.

<<<SLE-OUTPUT>>>
### .sle/work/wi-design-108-a8/design.md
# Design — rag-worker → rag-api failure payload contract alignment

- Work item: `wi-design-108-a8` (step: design)
- Authoritative scope: WorkItem `wi-define-108-a8`, artifact `definition:obj-108`
  (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).
  This design implements exactly that Definition; nothing here widens, narrows, or reinterprets it.

---

## 1. Problem

The worker's failure publisher and rag-api's failure consumer were written against different contracts:

- **Worker** (`apps/ai-server/rag-worker-service/main.py`, `process_document` except handler):
  publishes status `"failed"` with `details = {"error": str(e)}` via `_publish_status_update`.
- **rag-api** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch):
  reads `details["error_message"]`, `details["stage"]`, `details["retryable"]` and persists
  `error` / `error_stage` / `retryable` on the main document, plus
  `processing/summary.error = {code, message, stage}`.

Because the keys don't intersect, every worker-originated failure persists the fallbacks:
`error = "Processing failed"`, `error_stage = None`, `retryable = True` (silent default), and
`summary.error.code = "UNKNOWN"`. The stale-lease sweep (`_fail_if_still_stale`), rag-api's
enqueue-failure paths, and the `Resource` model already use the `error`/`error_stage`/`retryable`
schema — the worker's status publisher is the only writer that doesn't speak it. Nothing tests the seam.

## 2. Scope

**In scope**
- Worker failure-payload construction: `error_message`, `stage`, `retryable` (+ legacy `error` retained).
- Stage tracking through `process_document` using the existing progress-stage vocabulary.
- `retryable` derived from `classify_error(e)` (transient → true, permanent/unknown → false).
- A contract test pinning the worker → rag-api failure path with key-drift guards.

**Out of scope (from the Definition's non-goals, restated)**
- Any change to rag-api's reads, persisted schema, or field names; no Firestore migration/backfill.
- The stale-lease sweep's direct failure write (already contract-consistent).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, leases, heartbeats — only the *reporting*
  of retryability changes.
- Structured error codes (`summary.error.code` stays `"UNKNOWN"` unless a code is actually sent).
- Frontend/mobile (`ResourceResponse` already exposes `error`/`error_stage`).
- The companion D3 issue (content unavailable here) and reconciling with the D4 deviation note in
  `plans/upload-flow.md` (file absent from the tree).

## 3. Contract specification

**3.1 Worker failure payload (`details` of the status `"failed"` message)**

| key             | type | produced by                        | consumed by rag-api (failed branch)                     |
|-----------------|------|------------------------------------|---------------------------------------------------------|
| `error_message` | str  | `str(e)` (see D1)                  | → main doc `error`; → `summary.error.message`           |
| `stage`         | str  | stage tracker (§4.3)               | → main doc `error_stage`; → `summary.error.stage`, `summary.stage` |
| `retryable`     | bool | `classify_error(e)` (§3.3)         | → main doc `retryable`                                  |
| `error`         | str  | duplicate of `error_message`       | **not read** — legacy key retained for unknown consumers of the status topic (F11 hedge) |
| `jobId`         | str  | added by `_publish_status_update`  | unchanged existing behavior                             |

Rules:
- The payload must **always** carry `error_message`, `stage`, and `retryable` explicitly. rag-api's
  `details.get(..., fallback)` defaults must never be the operative mechanism for worker failures.
- `stage` falls back to `"processing"` only if the tracker value is genuinely unavailable
  (empty/None) — the same value the stale-lease sweep uses for `error_stage`, so the field never
  regresses to null.

**3.2 Persistence mapping (rag-api side — unchanged code, pinned by test)**

| persisted location            | field         | value                          |
|-------------------------------|---------------|--------------------------------|
| main resource document        | `status`      | `"failed"`                     |
| main resource document        | `error`       | payload `error_message`        |
| main resource document        | `error_stage` | payload `stage`                |
| main resource document        | `retryable`   | payload `retryable`            |
| `processing/summary` subdoc   | `stage`       | payload `stage`                |
| `processing/summary` subdoc   | `error.code`  | payload `error_code` else `"UNKNOWN"` (worker sends none) |
| `processing/summary` subdoc   | `error.message` | payload `error_message`      |
| `processing/summary` subdoc   | `error.stage` | payload `stage`                |

**3.3 `retryable` derivation (explicit, aligned with ACK/NACK)**

`retryable = classify_error(e)` — the same function that decides ACK vs NACK in `run_worker`:

| exception                                      | `classify_error` | persisted `retryable` | worker ACK/NACK behavior       |
|------------------------------------------------|------------------|-----------------------|--------------------------------|
| `TransientError` subclass                      | True             | True                  | NACK → Pub/Sub redelivers      |
| `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | True | True | NACK |
| `httpx.HTTPStatusError` with 429/500/502/503/504 | True           | True                  | NACK                           |
| `PermanentError` subclass                      | False            | False                 | ACK (no redelivery)            |
| `httpx.HTTPStatusError` other 4xx              | False            | False                 | ACK                            |
| anything else (unclassified-unknown)           | False (conservative default) | **False** | ACK                            |

Deliberate behavior change: unclassified-unknown failures flip persisted `retryable` from the
silent default `True` to `False`. This matches what the worker actually does (acks, no auto-retry);
manual reprocess via `POST /process` is unaffected. The stale-lease sweep keeps writing
`retryable: true` — a dead worker is a transient condition — and is not touched.

## 4. Architecture

**4.1 Failure data flow (end to end)**

```
process_document (worker)
  └─ step executes ── exception raised
       └─ except handler:
            current_stage (local tracker) ──► build_failure_details(e, current_stage)
                 └─ _publish_status_update(..., "failed", details, job_id)
                      └─ Pub/Sub topic rag-status-updates
                           └─ rag-api _process_status_message
                                └─ run_transactional_update (FAILED BRANCH, unchanged)
                                     ├─ transaction.update(main doc: status/error/error_stage/retryable)
                                     └─ transaction.set(processing/summary: stage/progress/error{code,message,stage})
```

Only two files change; the seam is closed on the worker side and pinned on the API side.

**4.2 Worker: new leaf module `error_classification.py`**

New file `apps/ai-server/rag-worker-service/error_classification.py` — stdlib + `httpx` only, no
service imports, so it is hermetically importable by tests:

```python
"""Worker error classification and the worker→rag-api failure-payload contract.

This module is the single source of truth for the failed-status payload the
worker publishes and rag-api's run_transactional_update failed branch reads.
It is deliberately dependency-light (stdlib + httpx) so the contract test can
import it without importing worker main.py (which has module-import side
effects: env requirements, Pub/Sub subscriber construction, heavy ML imports).
"""

class ProcessingError(Exception): ...
class TransientError(ProcessingError): ...   # moved verbatim from main.py
class PermanentError(ProcessingError): ...   # moved verbatim from main.py

def classify_error(e: Exception) -> bool:    # moved verbatim from main.py
    ...  # unchanged heuristics; unknown → False (permanent)

# Progress-stage vocabulary (reused for error_stage reporting).
STAGE_STARTING         = "starting"
STAGE_TEXT_RETRIEVED   = "text_retrieved"
STAGE_TAGGING_COMPLETE = "tagging_complete"
STAGE_SUMMARY_GENERATED= "summary_generated"
STAGE_CHUNKING_COMPLETE= "chunking_complete"
STAGE_EMBEDDINGS_COMPLETE = "embeddings_complete"
STAGE_UNKNOWN          = "processing"       # safe fallback; matches _fail_if_still_stale
PIPELINE_STAGES = frozenset({
    STAGE_STARTING, STAGE_TEXT_RETRIEVED, STAGE_TAGGING_COMPLETE,
    STAGE_SUMMARY_GENERATED, STAGE_CHUNKING_COMPLETE, STAGE_EMBEDDINGS_COMPLETE,
})

def build_failure_details(e: Exception, stage: str) -> Dict[str, Any]:
    """Build the failed-status payload per the worker→rag-api failure contract."""
    message = str(e) or type(e).__name__          # D1
    resolved_stage = stage or STAGE_UNKNOWN
    return {
        "error_message": message,
        "error": message,        # legacy key retained (F11 compatibility hedge)
        "stage": resolved_stage,
        "retryable": classify_error(e),
    }
```

`main.py` replaces its inline exception-class + `classify_error` block with:

```python
from error_classification import (
    ProcessingError, TransientError, PermanentError,  # re-exported for continuity
    classify_error, build_failure_details,
    STAGE_STARTING, STAGE_TEXT_RETRIEVED, STAGE_TAGGING_COMPLETE,
    STAGE_SUMMARY_GENERATED, STAGE_CHUNKING_COMPLETE, STAGE_EMBEDDINGS_COMPLETE,
)
```

The move is behavior-preserving (`run_worker`'s `classify_error` reference resolves via the import;
no other module references these names). No `requirements.txt` change (`httpx` already imported).

**4.3 Worker: stage tracker + failure handler in `process_document`**

A **local** variable (per-job, concurrency-safe; matches the Definition's "a local") set
immediately before each pipeline step, using the step's progress-vocabulary milestone name:

```python
async def process_document(self, user_id, course_id, resource_id, job_id=None):
    metrics = ProcessingMetrics(start_time=time.time())
    trace = ... if self.langfuse else None
    current_stage = STAGE_STARTING                      # initialized BEFORE the try
    try:
        await self._validate_processing_request(...)    # stage: starting
        await self._publish_status_update(..., {"stage": "starting"}, job_id)

        current_stage = STAGE_TEXT_RETRIEVED            # set immediately before the await
        text_content, doc_metadata = await self._get_extracted_text(...)
        await self._publish_status_update(..., {"stage": "text_retrieved", ...}, job_id)

        current_stage = STAGE_TAGGING_COMPLETE
        tags, confidence_scores = await self.content_tagger.generate_tags(...)
        ...
        current_stage = STAGE_SUMMARY_GENERATED
        summary_data = await self.generate_document_summary(...)
        ...
        current_stage = STAGE_CHUNKING_COMPLETE
        chunks = await self._create_enhanced_chunks(...)
        ...
        current_stage = STAGE_EMBEDDINGS_COMPLETE
        vectors = await self._generate_embeddings_with_openrouter(chunks)
        ...
        # Post-embedding persistence steps (delete/store vectors, metadata subcollection,
        # completed publish, usage counter, resource map) intentionally stay at
        # embeddings_complete — the tracker never advances to "completed", which must
        # never appear as an error stage.
    except Exception as e:
        metrics.error_message, metrics.end_time = str(e), time.time()
        failure_details = build_failure_details(e, current_stage)
        self.logger.error("document_processing_failed",
                          user_id=user_id, course_id=course_id, resource_id=resource_id,
                          stage=current_stage, retryable=failure_details["retryable"],
                          error=str(e))
        await self._publish_status_update(user_id, course_id, resource_id,
                                          "failed", failure_details, job_id)
        if trace: trace.update(output={"success": False, "error": str(e),
                                       "stage": current_stage})
        return metrics
```

Semantics (documented in code): `error_stage` = the progress-vocabulary name of the pipeline step
executing when the exception was raised. The tracker is advanced through the six processing
milestones only; the terminal `"completed"` value is never assignable to an error stage.
Convention for future steps: **set the tracker immediately before the await.**

**4.4 rag-api: intentionally unchanged**

`run_transactional_update`'s failed branch already implements the target contract
(`error_message`→`error`, `stage`→`error_stage`, `retryable`→`retryable`, summary error subdoc).
The constraint "align the worker, don't change rag-api's reads or persisted schema" is satisfied by
making **zero** rag-api code changes; the contract test pins the branch so it cannot drift.

**4.5 Compatibility**

- The legacy `error` key rides along in the Pub/Sub payload (one redundant string per failure) for
  any unverified consumer of the status topic and for log tooling. rag-api ignores it.
- No schema migration, field rename, or backfill; `Resource` / `ResourceResponse` exposure of
  `error`/`error_stage` is untouched.
- Only verified consumer is rag-api's status subscriber; if a later audit confirms no other
  consumers, dropping the duplicate `error` key is trivial cleanup (out of scope here).

## 5. Contract test design

**5.1 Placement and infrastructure**

New file `apps/ai-server/tests/integration/test_worker_failure_contract.py`, alongside the house
pattern in `test_api_contracts.py`, reusing its `conftest.py` (mocked firebase/google modules,
`rag-api-service` on `sys.path`). The test **imports both sides rather than restating the contract
in a fixture**:

- Worker side: `import error_classification` (service root added to `sys.path` inside the module) —
  real payload construction, no mocks.
- API side: `import main as rag_api_main` (via conftest) and call
  `rag_api_main.run_transactional_update` directly.

Worker `main.py` is deliberately **not** imported by tests (module-import side effects: required
env vars, `SubscriberClient` construction, heavy ML imports) — see D2.

**5.2 Firestore fake (chosen over the emulator — see D3)**

`run_transactional_update` touches only: `firestore.transactional`, `firestore.SERVER_TIMESTAMP`,
`db.transaction()`, `doc_ref.get(transaction=...)` (snapshot with `.exists`, `.to_dict()`, `.id`),
`transaction.update(doc_ref, fields)`, `doc_ref.collection("processing").document("summary")`,
`transaction.set(ref, fields, merge=True)`. A minimal fake provides exactly that:

```python
class FakeFirestore:                       # patched in as rag_api_main.firestore
    SERVER_TIMESTAMP = "<SERVER_TIMESTAMP>"
    @staticmethod
    def transactional(func): return func   # pass-through: body runs against the fake transaction

class FakeTransaction:  # records update()/set() calls for assertions
class FakeDocRef:       # backing store dict; .id; .get(transaction=None) → FakeSnapshot
                        # .collection("processing").document("summary") → subdoc FakeDocRef
```

Each test patches `monkeypatch.setattr(rag_api_main, "firestore", FakeFirestore)` (function-scoped,
so the rest of the suite is unaffected), seeds the main doc with `status: "processing"`, and calls:

```python
rag_api_main.run_transactional_update(fake_db, doc_ref, "failed", details, stub_logger, user_id)
```

**5.3 Behavioral test cases**

| id  | case                                                                                                                                     | asserts                                                                                                  |
|-----|------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| T1  | payload key set is exact                                                                                                                 | `set(build_failure_details(...)) == {"error_message", "error", "stage", "retryable"}`                     |
| T2  | retryable derivation: `TransientError`, `httpx.ConnectError`, `HTTPStatusError(429/503)` → True; `PermanentError`, `HTTPStatusError(404)`, `ValueError` (unknown) → False | `payload["retryable"] is True/False` respectively |
| T3  | **round-trip, early stage**: `build_failure_details(TransientError("Embedding request timed out"), STAGE_TEXT_RETRIEVED)` → failed branch | main doc `error == "Embedding request timed out"` (not `"Processing failed"`), `error_stage == "text_retrieved"` (not None), `retryable is True`, `status == "failed"` |
| T4  | **round-trip, late stage**: `build_failure_details(ValueError("partial vector write: 3/50 chunks stored…"), STAGE_EMBEDDINGS_COMPLETE)` → failed branch | `error` == message, `error_stage == "embeddings_complete"`, `retryable is False` (the deliberate unknown→False change) |
| T5  | summary subdocument consistency                                                                                                          | `summary.error == {"code": "UNKNOWN", "message": <same as main error>, "stage": <same as main error_stage>}`; `summary.stage` equals it; `progress == 0` |
| T6  | legacy key retained                                                                                                                      | `payload["error"] == payload["error_message"]`                                                            |
| T7  | empty-message rule (D1)                                                                                                                  | `build_failure_details(ValueError(), "starting")["error_message"] == "ValueError"`                        |

T3/T4 are the drift tripwires: if the worker renames/drops `error_message`, or rag-api renames its
read key or stops persisting any of the three fields, the equality assertions fail.

**5.4 Static drift guards (AST, house pattern from `_get_agent_graph_shapes`)**

| id  | target                                   | assertion                                                                                                                                                                   |
|-----|------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| T8  | `rag-api-service/main.py` failed branch  | Within `run_transactional_update`, the two `if new_status == "failed":` blocks: (a) main-update assignments pair `error←details.get("error_message")`, `error_stage←details.get("stage")`, `retryable←details.get("retryable")`; (b) the exact set of `details.get(...)` keys across both blocks is `{"error_message", "stage", "retryable", "error_code"}` |
| T9  | `rag-worker-service/main.py` mechanism   | Within `process_document`: (a) `current_stage` initialized to `"starting"` before the `try`; (b) ≥ 4 assignments to `current_stage` inside the `try` (representative, not exhaustive — no per-step ossification); (c) the except handler's `_publish_status_update` details argument is a `build_failure_details(e, current_stage)` call |

T8 catches the API side silently switching keys (the round-trip alone can't, since the worker sends
both `error` and `error_message`); T9 catches the stage tracker being removed or bypassed.

**5.5 Deliberately not tested**

- Every pipeline step's tracker assignment (representative coverage only, per the Definition).
- The stale-lease sweep's write (out of scope; unchanged).
- Pub/Sub transport, lease/heartbeat behavior, ACK/NACK mechanics (out of scope).
- Live-emulator variant (the fake covers the branch; an emulator run can be added later if the
  hermetic stack wants a live-path duplicate).

## 6. Requirements (implementable form)

- **R1 (payload keys)** — The worker's failed-status payload must always include `error_message`
  (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately
  derived); rag-api's fallback defaults must never be operative for worker failures. *(→ A1; T1–T4)*
- **R2 (stage tracking)** — `process_document` must track the executing stage via a local set
  immediately before each pipeline step, using the existing progress vocabulary (`starting`,
  `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`,
  `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely
  unknown; `"completed"` must never be reported as an error stage. *(→ A1/A2; T3, T4, T9)*
- **R3 (persistence fidelity)** — rag-api's failed branch must persist worker-provided values
  unchanged (main doc `error`/`error_stage`/`retryable`; summary error subdoc carrying the same
  message and stage) — with zero rag-api code changes. *(→ A2/A3; T3–T5, T8)*
- **R4 (retryable derivation)** — `retryable` must come from `classify_error(e)`: transient → true;
  permanent, including unclassified-unknown (conservative default), → false — aligned with the
  worker's ACK/NACK behavior. *(→ A1/A2; T2, T4)*
- **R5 (legacy key)** — The worker retains the `error` key alongside `error_message` in the failure
  payload. *(→ F11 hedge; T1, T6)*
- **R6 (contract test)** — A contract test must exercise the worker's real failure-payload
  construction through rag-api's real failed-branch persistence (fakes or emulator) and assert the
  persisted `error`, `error_stage`, `retryable` equal the worker's values, failing on key drift on
  either side. *(→ A4; T1–T9)*
- **R7 (no migration)** — No Firestore migration, field rename, or backfill; persisted field names
  and semantics unchanged. *(constraint must_not; T3–T5 assert against the existing schema)*
- **R8 (worker-side extraction)** — Classification + payload construction live in a
  dependency-light leaf module (`error_classification.py`) so the contract test imports the real
  code path; `main.py` re-exports the moved names with unchanged behavior. *(→ enables R6; D2)*

## 7. Derived decisions

- **D1 — empty-message guard.** `str(e) or type(e).__name__`: a bare exception with no message
  would otherwise persist an empty `error`, defeating F1's disambiguation intent. The type name is
  the most informative value derivable when no message exists. Drop this line if strict
  `str(e)` is preferred; only T7 depends on it.
- **D2 — leaf-module extraction rather than importing worker `main.py` in tests.** Worker main has
  module-import side effects (required env vars, `SubscriberClient` construction, langchain/spacy/
  sklearn/tiktoken imports), so importing it would make the contract test environment-dependent.
  Moving `classify_error` + the exception classes verbatim into `error_classification.py` is
  behavior-preserving and makes the payload constructor hermetically importable.
- **D3 — Firestore fakes over the emulator for this test.** The failed branch needs only seven
  firestore surface points; a fake is hermetic, fast, and runs in any CI env, while the emulator
  mode remains available for a future live-path variant. The Definition explicitly permits either.
- **D4 — AST guard granularity.** T9 asserts tracker initialization, a ≥4-assignment mechanism
  check, and the handler wiring — enough to catch removal/bypass without ossifying every step
  (the Definition's stated concern). T8 pins the API-side key pairs exactly, closing the
  round-trip blind spot created by the retained legacy `error` key.

## 8. Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining
  `error`; residual risk accepted as low (per Definition F11).
- **Stage-tracker drift** as the pipeline evolves — mitigated by the set-before-await convention,
  the convention documented at the tracker, and the T9 mechanism guard.
- **`retryable=false` for unclassified errors** reduces auto-retry affordances for genuinely
  transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope and
  manual reprocess via `POST /process` remains.
- **Contract test ossifies the payload** — intentional; that is the drift guard. Adding a key means
  touching T1/T8, which is the point.
- **Fake-based persistence test could diverge from real Firestore semantics** — bounded: the fake
  mirrors exactly the seven surface points the branch uses; the emulator mode remains as an
  escalation path if the branch ever needs transactional semantics the fake can't express.

## 9. Files touched

| file | change |
|------|--------|
| `apps/ai-server/rag-worker-service/error_classification.py` | **new** — exception classes + `classify_error` (moved verbatim), stage vocabulary constants, `build_failure_details` |
| `apps/ai-server/rag-worker-service/main.py` | **modified** — import moved names; delete inline classification block; add stage tracker to `process_document`; rewrite failure handler to publish `build_failure_details(e, current_stage)` and log `stage`/`retryable` |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | **new** — T1–T9 (Firestore fakes + AST drift guards) |
| `apps/ai-server/rag-api-service/*` | **none** |

No dependency, config, Dockerfile, or schema changes.

## 10. Acceptance traceability

| acceptance (from the authoritative Definition) | satisfied by |
|------------------------------------------------|--------------|
| A1 — failed status payload carries `error_message`/`stage`/`retryable`, none relying on API fallbacks | R1, R2, R4 → T1–T4, T9 |
| A2 — persisted `error` = actual message (not "Processing failed"), `error_stage` = failing stage (not None), `retryable` = derived value | R1–R4 → T3, T4 |
| A3 — processing/summary error subdocument carries the same message and stage | R3 → T5 |
| A4 — contract test exists and passes, exercising worker construction through API persistence, failing on key drift either side | R6, R8 → T1–T9 |

Constraint check: worker aligns to the API (R3: zero API changes); no migration/rename/backfill
(R7); `retryable` always explicit, API fallback not operative (R1, R4); legacy `error` retained
(R5); no error-code taxonomy introduced (`error_code` absent from the payload; summary code stays
`"UNKNOWN"` — T5).

## 11. Implementation order

1. Create `error_classification.py` (move exception classes + `classify_error` verbatim; add stage
   constants and `build_failure_details`).
2. Update `main.py` imports; delete the moved block; confirm `run_worker`'s `classify_error`
   reference resolves.
3. Add the stage tracker to `process_document` and rewrite the failure handler.
4. Add `test_worker_failure_contract.py` (fakes, then behavioral cases, then AST guards).
5. Run the integration suite; verify no other test regresses (the moved names are re-exported; the
   firestore patch is function-scoped).
<<<END-SLE-OUTPUT>>>