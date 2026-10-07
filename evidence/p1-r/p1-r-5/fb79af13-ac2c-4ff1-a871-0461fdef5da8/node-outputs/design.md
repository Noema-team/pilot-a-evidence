Design complete. Both artifacts below are grounded in the authoritative Definition plus repository evidence verified this session (worker `main.py` handler/publisher/classifier/sweep, `models/resource.py`, and the existing contract-test patterns); rag-api failed-branch internals are taken from the Definition's pinned facts (F4) and are additionally pinned by the specified contract test.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api Failure Payload Contract Alignment

## 0. Source of truth and scope

- Authoritative specification: WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This document elaborates that Definition into implementable requirements; it does not widen, narrow, or reinterpret it.
- Cycle intent: rag-worker → rag-api failure payload contract mismatch — failures persist without message or stage.
- Affected components:
  - `apps/ai-server/rag-worker-service` (failure payload publisher — the fix site)
  - `apps/ai-server/rag-api-service` (failed-branch consumer — preservation only, no code changes)
  - `apps/ai-server/tests/integration` (new worker→rag-api failure-path contract test)

## 1. Problem statement (verified)

1. The worker's `process_document` exception handler publishes failed status with a one-key payload: `details = {"error": str(e)}` (`rag-worker-service/main.py`, `process_document` except-block, via `_publish_status_update`).
2. rag-api's failed branch (`run_transactional_update`, per Definition F4) reads details keys `error_message`, `stage`, `retryable` and persists `error`, `error_stage`, `retryable` on the resource document, with fallbacks `"Processing failed"` / `None` / `True`.
3. Consequence (F5): every worker-originated failure persists `error="Processing failed"`, `error_stage=None`, `retryable=True`; the `processing/summary` error subdocument inherits the fallbacks with `error_code` always `"UNKNOWN"`.
4. The persisted failure schema is already established on every other write path (F6, verified on the worker side): the worker's stale-lease sweep `_fail_if_still_stale` transactionally writes `error` / `error_stage="processing"` / `retryable=True`; rag-api's enqueue-failure paths write the same fields; the `Resource` model (`rag-api-service/models/resource.py`) carries `error: Optional[str]`, `error_stage: Optional[str]`, `retryable: bool = True` in both `to_dict`/`from_dict`.
5. The worker's status publisher is the only writer that does not speak this schema. The worker aligns to the API; the API side does not change.

## 2. Glossary

- **Failure payload / failure details**: the `details` dict inside the worker's `"failed"` status message published to `RAG_STATUS_TOPIC`.
- **Failed branch**: rag-api's `run_transactional_update` handling of `status == "failed"` (per Definition F4).
- **Stage tracker**: the local in `process_document` holding the pipeline stage in flight at failure time.
- **Stage vocabulary**: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` — the exact strings already used in the worker's progress status publishes (verified). `completed` is used only on success; `processing` is the unknown-stage fallback (same value the stale-lease sweep uses for `error_stage`).

## 3. Functional requirements

### FR-1 — Failure payload keys (must)
When a RAG processing job fails, the worker's failed status details MUST contain:
- `error_message`: the actual exception message (`str(e)`), non-empty;
- `stage`: the failing pipeline stage per FR-3;
- `retryable`: a boolean per FR-4.

The payload MUST NOT rely on rag-api's fallback defaults for any of these keys: the keys are always present and the values are always the worker's own (never the `"Processing failed"` fallback string, never a null stage, never a silently defaulted retryable).

### FR-2 — Legacy key retention (must; implements the Definition's prefer-constraint and F11 hedge)
The failure details MUST also include `error`, carrying the same string value as `error_message`, for continuity with any existing consumers of the status topic and with log tooling. This adopts the Definition's `prefer` constraint as committed in the design direction; dropping the duplicate later is trivial cleanup and explicitly out of scope for this cycle.

### FR-3 — Stage tracking (must)
- `process_document` MUST track the currently executing pipeline stage so the failure handler reports the true failing stage.
- Stage values MUST reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. No new stage names are introduced.
- When the stage is genuinely unknown, the value MUST be `"processing"` — the same value the stale-lease sweep writes to `error_stage` — so `error_stage` never regresses to null because of this fix.
- Convention: the tracker is set immediately before each tracked pipeline step ("set before the await"). The concrete step→stage mapping, including one documented imprecision for the post-embedding persistence phase, is specified in `docs/architecture.md` §4.1.

### FR-4 — retryable derivation (must)
- `retryable` MUST be derived explicitly from `classify_error(e)`: a transient classification maps to `true`; a permanent classification — including unclassified-unknown exceptions, per `classify_error`'s conservative default — maps to `false`.
- The key MUST always be present in the payload. rag-api's `details.get("retryable", True)` fallback MUST NOT be the operative mechanism for worker failures.
- Accepted behavior change (per Definition F8): unclassified-unknown exceptions now persist `retryable=false` (previously the silent `true` default). This aligns the persisted record with the worker's actual ACK behavior (acked, no redelivery; manual reprocess via `POST /process` remains available). Widening `classify_error` is out of scope.
- The stale-lease sweep's separate `retryable=true` write stays correct and unchanged: a dead worker is a transient condition by nature.

### FR-5 — rag-api persistence preservation (must)
- rag-api's failed branch MUST persist the worker-provided values unchanged: `error` ← `details.error_message`, `error_stage` ← `details.stage`, `retryable` ← `details.retryable`.
- The `processing/summary` error subdocument MUST carry the same message and stage as the main document.
- `error_code` remains `"UNKNOWN"` unless a code is actually sent (none is sent in this cycle — the prefer-not constraint on an error taxonomy is honored).
- No changes to rag-api's reads, persisted field names, or schema. No Firestore migration, field rename, or backfill.

### FR-6 — Contract test (must)
A contract test in `apps/ai-server/tests/integration/` MUST:
- exercise the worker's failure-payload construction through rag-api's failed-branch persistence, using the Firestore emulator or fakes (both services already support hermetic emulator branches, F10);
- assert the persisted `error`, `error_stage`, and `retryable` equal the worker's `error_message`, `stage`, and derived `retryable` values;
- assert `processing/summary` subdocument message/stage parity (acceptance A3);
- fail the build if either side's payload keys drift (drift guard, both directions — see `docs/architecture.md` §6.3);
- cover at least one early-stage failure and one late-stage failure, and both retryable branches (transient → `true`, permanent/unclassified → `false`).

### FR-7 — Envelope stability (must)
The status message envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`) and the existing behavior of injecting `jobId` into details when a `job_id` is present MUST remain unchanged, as must the lease-heartbeat write performed inside `_publish_status_update` and the sequence reset on terminal states (`completed`/`failed`).

### FR-8 — Other writers unchanged (must)
The stale-lease sweep (`_fail_if_still_stale`) and rag-api's enqueue-failure paths (`/process`, `POST /resources`) MUST NOT be modified; they already write the established schema consistently with this contract.

## 4. Data contract

Failure details payload (worker → status topic), target state:

| key | type | source | notes |
|---|---|---|---|
| `error_message` | string | `str(exception)` | new; the authoritative failure message |
| `error` | string | same value as `error_message` | legacy key retained (FR-2) |
| `stage` | string | stage tracker (FR-3) | vocabulary values, or `"processing"` fallback |
| `retryable` | bool | `classify_error(e)` (FR-4) | deliberately derived, never defaulted |
| `jobId` | string (optional) | `_publish_status_update` | existing behavior, unchanged; injected after the builder runs |

Message envelope unchanged: `user_id`, `course_id`, `resource_id`, `status="failed"`, `details`, `timestamp`, `sequence`.

Persisted mapping (rag-api failed branch, unchanged names per F4): `error` ← `error_message`; `error_stage` ← `stage`; `retryable` ← `retryable`; `processing/summary` error subdocument message/stage mirror the same values, `error_code` defaults to `"UNKNOWN"`.

## 5. Constraints (binding, restated from the Definition)

- **must**: align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`) rather than changing rag-api's reads or persisted schema.
- **must_not**: no Firestore migration, field rename, or backfill of existing documents; `error`/`error_stage`/`retryable` keep their names and semantics.
- **must**: every worker-originated failure payload carries `retryable` explicitly; the API-side fallback must not be operative for worker failures.
- **prefer**: retain the legacy `error` key alongside `error_message` (adopted as FR-2).
- **prefer_not**: no structured error-code taxonomy (`error_code` values) in this fix.

## 6. Non-goals (from the Definition)

- Changing the stale-lease sweep's direct failure write.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes (`ResourceResponse` already exposes `error` and `error_stage` to clients, per the Definition).
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context; deferred).

## 7. Acceptance criteria and verification

| id | criterion (from the Definition) | verified by |
|---|---|---|
| A1 | The worker's failed status message contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | Contract test worker-side assertions (FR-6) + worker-side key-set drift guard. |
| A2 | After a failed job, the persisted resource document has `error` = the worker's actual message (not `"Processing failed"`), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value. | Contract test persistence assertions through the failed branch (FR-5, FR-6). |
| A3 | The `processing/summary` error subdocument carries the same message and stage as the main document. | Contract test subdocument parity assertions (FR-5). |
| A4 | A contract test covering the worker failure → rag-api persistence path exists and passes, failing if either side's payload keys drift. | Existence + both drift guards (FR-6). |

## 8. Open items and unknowns carried forward

- The companion D3 issue referenced by the Objective is not available in this context; anything it covers beyond this alignment is deferred (Definition F12).
- `plans/upload-flow.md` (the original D4 deviation note) is not present in the current tree; reconciling this analysis with it is deferred.
- Consumers of the status topic other than rag-api's subscriber are unknown (F11 assumption); the retained legacy `error` key is the hedge.
- The exact rag-api entry point used by the contract test (direct call into the failed-branch persistence vs. an end-to-end publish through the Pub/Sub emulator) is an implementation decision within FR-6's bounds; rag-api's failed-branch internals themselves are taken from authoritative F4 and will be pinned by the test.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api Failure Payload Alignment

## 1. Context: the seam that broke

The failure path crosses one Pub/Sub topic and one transaction:

```
process_document (rag-worker)                    run_transactional_update (rag-api)
  except block ──► _publish_status_update ──► RAG_STATUS_TOPIC ──► subscriber ──► failed branch ──► Firestore
                   details = {"error": ...}                          reads error_message/stage/retryable
```

Verified current behavior on the worker side (`rag-worker-service/main.py`):

- `process_document` is one large `try` block; its single `except` handler publishes `status="failed"` with `details={"error": str(e)}`.
- rag-api's failed branch (per authoritative F4) reads `error_message`, `stage`, `retryable` — none of which the worker sends — so every worker failure persists the fallbacks: `error="Processing failed"`, `error_stage=None`, `retryable=True`, and the `processing/summary` subdocument inherits them with `error_code="UNKNOWN"`.

Everything downstream already speaks the established schema (verified):

- The worker's stale-lease sweep `_fail_if_still_stale` writes `{"status": "failed", "error": ..., "error_stage": "processing", "retryable": True}` transactionally.
- rag-api's `Resource` model (`models/resource.py`) defines `error` / `error_stage` / `retryable=True` and round-trips them.
- The worker's `classify_error()` plus `run_worker`'s ACK/NACK loop already implement the transient/permanent split: transient → omitted from `ack_ids` (Pub/Sub redelivers); permanent → acked (poison-pill protection).

The worker's status publisher is the only writer that doesn't speak the schema. **Fix the odd one out** — no migration, no reader changes, no backfill.

## 2. Design principles

1. **Worker aligns to the API** (binding constraint): publish `error_message`/`stage`/`retryable`; rag-api's reads and the persisted schema are untouched.
2. **Derive, don't default**: `retryable` comes from `classify_error(e)` — the same classification that already drives ACK/NACK — so the persisted record tells the truth about whether Pub/Sub will redeliver.
3. **No migration**: persisted field names (`error`, `error_stage`, `retryable`) keep their names and semantics.
4. **Hedge unknown consumers**: the legacy `error` key is retained alongside `error_message` (F11).
5. **Test the seam, not a restatement**: the contract test imports both sides and runs the real payload through the real persistence branch, with drift guards on both key sets.

## 3. Target contract

Failure details payload (worker → topic):

| key | value |
|---|---|
| `error_message` | `str(exception)` |
| `error` | same string (legacy, retained) |
| `stage` | stage-tracker value from the existing vocabulary, or `"processing"` |
| `retryable` | `classify_error(e)` |
| `jobId` | injected by `_publish_status_update` when a `job_id` is present (existing behavior) |

Persisted mapping (rag-api failed branch, unchanged): `error` ← `error_message`; `error_stage` ← `stage`; `retryable` ← `retryable`; `processing/summary` error subdocument gets the same message and stage with `error_code="UNKNOWN"` (no code is sent).

## 4. Worker-side design

### 4.1 Stage tracker

**Mechanism**: a plain local variable `current_stage` in `process_document`, initialized to `"processing"` before the `try` block and assigned immediately before each tracked pipeline step. Each invocation has its own frame, so no shared state or contextvar is needed; the `except` handler reads the local directly.

**Step→stage mapping** (the stage value is the completion-event label that step's progress publish already uses — verified strings):

| `process_document` step | tracker assignment | stage value |
|---|---|---|
| function entry (before `try`) | `current_stage = "processing"` | `processing` (fallback) |
| `_validate_processing_request` + initial status publish | set before | `starting` |
| `_get_extracted_text` (PDF download/extraction or stored text) | set before | `text_retrieved` |
| `content_tagger.generate_tags` | set before | `tagging_complete` |
| `generate_document_summary` + `ragDescription` document update | set before | `summary_generated` |
| `_create_enhanced_chunks` | set before | `chunking_complete` |
| `_generate_embeddings_with_openrouter` | set before | `embeddings_complete` |
| `delete_old_vectors_via_service`, `store_chunks_via_service`, `_save_processing_metadata_to_subcollection`, final publish, `_update_user_usage`, `_generate_resource_map` | no further assignment | remains `embeddings_complete` |

**Semantics**: the stage names the pipeline step in flight, using that step's completion-event label from the existing vocabulary. A failure during text retrieval reports `text_retrieved` — the step whose completion event is `text_retrieved` failed. This satisfies "the true failing stage" within the Definition's fixed vocabulary.

**Documented imprecision**: the post-embedding persistence phase (old-vector deletion, chunk storage, metadata save, resource map, usage update) keeps `embeddings_complete`. Failures there are genuinely late-stage; the error message disambiguates the exact sub-step (e.g. the partial-vector-write `RuntimeError` raised by `store_chunks_via_service`). Introducing a new stage name for storage would widen the vocabulary beyond the Definition's fixed list and is not done.

**Reachability note** (verified): several steps swallow their own exceptions and cannot reach the handler — `generate_tags` (returns `[], {}`), `delete_old_vectors_via_service` (returns 0), `_save_processing_metadata_to_subcollection`, `_save_content_to_subcollection`, `_update_user_usage`, `_generate_resource_map`, and `_publish_status_update` itself. Stages actually reachable at the handler today: `starting` (validation), `text_retrieved`, `summary_generated` (the `ragDescription` Firestore update), `chunking_complete`, and `embeddings_complete` (embedding call and the post-embedding storage phase). The tracker still covers every step per the convention, so future code that raises is reported correctly.

**Drift risk and mitigation**: the convention is "set the tracker immediately before the await"; the contract test pins the mechanism on representative early and late stages (§6.4), which catches the tracker being removed or bypassed without ossifying every step.

### 4.2 Failure payload builder

Extract the construction into a module-level pure function in `rag-worker-service/main.py` (name indicative):

```python
def build_failure_details(error: Exception, stage: str) -> dict:
    message = str(error)
    return {
        "error_message": message,
        "error": message,   # legacy key retained for unknown topic consumers (F11)
        "stage": stage,
        "retryable": classify_error(error),
    }
```

The `process_document` except-handler calls it with the tracker value:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    ... existing logging ...
    await self._publish_status_update(
        user_id, course_id, resource_id, "failed",
        build_failure_details(e, current_stage), job_id,
    )
```

Benefits: a single source of truth for the payload; trivially unit-testable without Firebase/Pub/Sub; a stable worker-side entry point for the contract test. `jobId` injection stays in `_publish_status_update` (unchanged), so the builder's key set is exactly the four contract keys — which is what the drift guard pins.

### 4.3 retryable derivation

`classify_error(e)` semantics (verified):

| exception | `classify_error` | persisted `retryable` | `run_worker` delivery behavior |
|---|---|---|---|
| `TransientError` instances | True | `true` | NACK — Pub/Sub redelivers |
| `httpx.ConnectError/ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | True | `true` | NACK |
| `httpx.HTTPStatusError` with status 429/500/502/503/504 | True | `true` | NACK |
| `httpx.HTTPStatusError` with other 4xx | False | `false` | ACK |
| `PermanentError` instances | False | `false` | ACK |
| anything else (unclassified) | False (conservative default) | `false` | ACK |

The persisted record now matches delivery reality: `retryable=true` ⇔ Pub/Sub will redeliver; `retryable=false` ⇔ acked, manual reprocess via `POST /process` remains.

**Deliberate behavior change**: unclassified-unknown exceptions flip from the silent persisted default `true` to `false`. This is `classify_error`'s documented conservatism (avoid infinite retry loops), accepted per Definition F8. The stale-lease sweep keeps its direct `retryable=true` write — a dead worker is a transient condition — and is untouched.

### 4.4 Unchanged on the worker

- Message envelope, sequence numbering, and terminal-state sequence reset (`completed`/`failed`) in `_publish_status_update`.
- The lease heartbeat inside `_publish_status_update`, `_heartbeat_loop`, and `PROCESSING_LEASE_SECONDS`.
- ACK/NACK logic in `run_worker` — `classify_error` is now reused for reporting as well as delivery decisions; the decision itself does not change.
- Claim logic (`_claim_resource_if_queued`), the `regenerate-map` action, and resource-map generation.

## 5. rag-api-side design

**No code changes.** The failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` (F4); once the worker sends the keys, the values flow through unchanged, and the `processing/summary` subdocument receives the real message and stage with `error_code="UNKNOWN"`.

The `details.get(...)` fallbacks remain in place and stay operative for:

- rag-api's enqueue-failure paths (`/process`, `POST /resources`), which construct their own details; and
- **deploy skew**: messages from not-yet-updated workers (old `{"error": ...}` payload) persist exactly as today until workers roll.

The fix is therefore backward-compatible in both directions and requires no coordinated deployment.

## 6. Contract test architecture

### 6.1 Location and pattern

New file under `apps/ai-server/tests/integration/` (e.g. `test_rag_failure_contract.py`), following the house pattern in `test_api_contracts.py`: import the service modules directly (that file does `import main as rag_api_main`; this test imports both rag-api's main and the worker module), and reuse the hermetic branches both services already support (`FIRESTORE_EMULATOR_HOST`; the worker additionally honors `STORAGE_EMULATOR_HOST`, `PUBSUB_EMULATOR_HOST`, and `PDF_EXTRACTION_BACKEND=pypdf` for offline runs). Fakes are the permitted fallback where the emulator is unavailable (Definition: "emulator or fakes").

### 6.2 Runtime path under test

1. **Worker side**: call `build_failure_details(exc, stage)` with a representative exception and stage — no processor instantiation needed, the builder is pure.
2. **API side**: feed the returned details through rag-api's failed-branch persistence (the `run_transactional_update` failed branch per F4) against the emulator/fake, using a seeded resource document.
3. **Read back** the persisted resource document and the `processing/summary` subdocument.
4. **Assert**: `error == str(exc)` (and ≠ `"Processing failed"`), `error_stage == stage` (not None), `retryable ==` the derived value; subdocument message/stage parity; `error_code == "UNKNOWN"`.

The exact api-side invocation (direct call into the persistence function vs. publishing a status message through the Pub/Sub emulator and letting the subscriber run) is an implementation decision; the direct call is preferred for hermeticity and pinpoint failure attribution.

### 6.3 Drift guards (both directions)

- **Worker-side key-set guard**: assert `set(build_failure_details(...).keys()) == {"error_message", "error", "stage", "retryable"}`. Adding or removing a key fails the build — intentional ossification; that is the drift guard doing its job. `jobId` is excluded because it is injected later by `_publish_status_update`.
- **API-side key guard**: an AST scan of `rag-api-service/main.py` (the same subprocess-AST pattern `test_api_contracts.py` uses for shape extraction) asserting that the failed branch's details reads are exactly `{error_message, stage, retryable}` and that the persisted failure field names are `error`/`error_stage`/`retryable`. A rename on either side fails the build instead of silently re-creating this bug.

### 6.4 Case matrix

| case | exception | stage | expected persisted |
|---|---|---|---|
| early-stage transient | `httpx.ReadTimeout` (or a `TransientError`) | `text_retrieved` | `error`=message, `error_stage`=`text_retrieved`, `retryable=true` |
| late-stage permanent/unclassified | `RuntimeError` (unclassified) | `embeddings_complete` | `retryable=false` |
| unknown-stage fallback | any | `processing` | `error_stage`=`processing` (matches the sweep's value; never null) |
| subdocument parity | any | any | `processing/summary` message/stage equal the main document; `error_code`=`UNKNOWN` |
| drift guards | — | — | key sets pinned on both sides |

## 7. Data flow after the fix

```
step raises
  └─► handler: build_failure_details(e, current_stage)
        {error_message, error, stage, retryable}
  └─► _publish_status_update (unchanged envelope: adds jobId, sequence;
        heartbeats lease; resets sequence on "failed")
  └─► Pub/Sub RAG_STATUS_TOPIC
  └─► rag-api subscriber ─► run_transactional_update failed branch (unchanged)
        resource doc:  {status: "failed", error, error_stage, retryable}
        processing/summary: {message, stage, error_code: "UNKNOWN"}
  └─► ResourceResponse exposes error / error_stage to clients (unchanged)
```

## 8. Invariants

- Persisted failure schema names and semantics unchanged: `error`, `error_stage`, `retryable` (Resource model defaults intact).
- `error_stage` is never null for worker-originated failures after this fix — `"processing"` is the floor.
- The stale-lease sweep's write (`error`, `error_stage="processing"`, `retryable=true`) is unchanged and remains consistent with the contract.
- Envelope and sequence semantics unchanged.
- No migration or backfill: existing failed documents keep their historical fallback values; only new failures carry real values.

## 9. Risks and mitigations

| risk | mitigation |
|---|---|
| Unknown topic consumers reading the old key set | Legacy `error` key retained (FR-2); residual risk accepted as low (F11). |
| Stage-tracker drift as the pipeline evolves | "Set before the await" convention; representative early/late-stage contract coverage. |
| `retryable=false` for unrecognized-but-transient errors | Accepted (F8); widening `classify_error` is out of scope; manual reprocess via `POST /process` remains. |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key later means touching the test. |
| Post-embedding failures report `embeddings_complete` | Documented imprecision (§4.1); the error message disambiguates; the vocabulary is fixed by the Definition. |

## 10. Out of scope

Same as the Definition's non-goals: the sweep's behavior; ACK/NACK/backoff/lease/heartbeat mechanics; frontend/mobile work; a structured error-code taxonomy; the companion D3 issue's scope; and reconciling with the D4 note in `plans/upload-flow.md` (file absent from the current tree).

## 11. Traceability

| acceptance | satisfied by |
|---|---|
| A1 | FR-1, FR-2, FR-3, FR-4 — worker-side contract-test assertions + worker key-set drift guard |
| A2 | FR-4, FR-5 — persistence assertions through the failed branch |
| A3 | FR-5 — subdocument parity assertions |
| A4 | FR-6 — test existence plus both drift guards |

## 12. Evidence basis and unverified items

Verified directly this session: worker `main.py` (exception-handler payload, `_publish_status_update` envelope/`jobId`/sequence/lease-heartbeat, progress-stage vocabulary, `classify_error` semantics, `run_worker` ACK/NACK, `_fail_if_still_stale` write, emulator branches for Firestore/Storage/Pub/Sub/extraction backend); rag-api `models/resource.py` failure fields; `tests/integration/test_api_contracts.py` patterns and the fixtures layout. rag-api's failed-branch internals are taken from the authoritative Definition (F4) and were not independently re-read this session; the contract test specified here pins them mechanically. Unverified and carried as unknown: `tests/integration/conftest.py` contents, any additional consumers of the status topic (F11 assumption stands), the companion D3 issue's content (F12), and `plans/upload-flow.md` (absent from the tree).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>