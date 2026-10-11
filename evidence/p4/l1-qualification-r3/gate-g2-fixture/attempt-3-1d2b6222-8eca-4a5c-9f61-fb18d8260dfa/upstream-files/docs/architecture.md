# Architecture — rag-worker → rag-api failure payload contract alignment

- **Run:** 91342881-eb32-47ff-8dfb-d8a7115dd371 · Iteration 1 · Step: design
- **Companion document:** `docs/requirements.md` (FR/TR numbering used below is defined there).
- **Evidence legend:** `[V]` verified by direct repository read · `[D]` asserted by the authoritative definition ·
  `[U]` unverified / unknown at design time.

## 1. Design direction and principles

1. **The worker aligns to the API, not the reverse.** The persisted failure schema (`error`, `error_stage`,
   `retryable`) is already consistent across the worker's stale-lease sweep `[V]`, rag-api's enqueue-failure
   paths `[D]`, and the `Resource` model `[V]` (`ResourceResponse` per definition `[D]`). The worker's status
   publisher is the single deviating writer. Fixing the API side would ripple across every other writer and both
   response models and would flirt with a schema change — violating the `must_not` constraint. Fixing the worker
   is a single-sided change with zero migration, backfill, or reader changes.
2. **Derive, don't default.** `retryable` must be computed from the classifier the worker already trusts for
   ACK/NACK decisions, so the persisted record tells the truth about what Pub/Sub will do next.
3. **The seam is pinned by a test that imports both sides**, rather than a fixture that restates the contract and
   drifts with it.
4. **Failure reporting must not itself fail.** The payload builder is total (defensive normalization); a failure
   in failure reporting must never suppress the failed-status publish.

## 2. Verified system context: the failure path today

```
process_document (rag-worker-service/main.py)
  └─ try: pipeline steps, each followed by _publish_status_update(..., "processing", {"stage": <milestone>, ...})
     ├─ milestones published [V]: starting, text_retrieved, tagging_complete,
     │                            summary_generated, chunking_complete, embeddings_complete,
     │                            then "completed" (stage "completed", progress 100)
     └─ except Exception as e:
          metrics.error_message = str(e)
          _publish_status_update(..., "failed", {"error": str(e)}, job_id)   ← the entire bug [V]

_publish_status_update [V]:
  - injects details["jobId"] when job_id provided
  - envelope: {user_id, course_id, resource_id, status, details, timestamp, sequence}
  - sequence reset on "completed"/"failed"; lease heartbeat write (status_updated_at)
  - publishes JSON to RAG_STATUS_TOPIC; swallows its own publish errors

Pub/Sub rag-status-updates
  └─ rag-api _process_status_message [V]:
       - parses payload; resolves canonical path users/{uid}/resources/{rid} first,
         legacy course path as fallback
       - run_transactional_update(db, doc_ref, new_status, details, logger, user_id) in a thread
            └─ ALLOWED_TRANSITIONS: processing → {completed, failed}  [V]
               failed branch [V]:
                 main:  error   = details.get("error_message", "Processing failed")
                        error_stage = details.get("stage")                # no fallback → None
                        retryable = details.get("retryable", True)
                 summary/processing subdoc:
                        stage = details.get("stage", "unknown"); progress = details.get("progress", 0)
                        error = {code: details.get("error_code", "UNKNOWN"),
                                 message: details.get("error_message", "Processing failed"),
                                 stage: details.get("stage")}
```

Also verified and relevant:
- `classify_error(e) -> bool` in the worker: `True` (transient) for `TransientError`, the listed httpx connection/
  timeout types, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, and `HTTPStatusError` with 429/500/
  502/503/504; `False` (permanent) otherwise, **including unclassified-unknown exceptions** (conservative default
  against infinite retry loops). `run_worker` uses it for ACK/NACK: transient → omitted from ack batch
  (redelivered); permanent → acked. `[V]`
- Stale-lease sweep `_fail_if_still_stale` writes directly: `error = "processing lease expired without heartbeat —
  worker died or stalled"`, `error_stage = "processing"`, `retryable = True`. `[V]` Unchanged by this design.
- Both services have `FIRESTORE_EMULATOR_HOST` initialization branches (hermetic mode). `[V]`
- Import-time constraints in the worker's `main.py`: `GCP_PROJECT = os.environ["GCP_PROJECT"]` (hard `KeyError` if
  absent) and a `RuntimeError` when `GOOGLE_APPLICATION_CREDENTIALS` is unset; a `SubscriberClient` is built at
  module import. `[V]` — this shapes the test architecture (§5).

## 3. Target failure path (after)

```json
// published details for status "failed" (example uses the verified partial-write message)
{
  "error_message": "partial vector write: 3/5 chunks stored, 2 failed — refusing to mark the resource searchable on a partial index",
  "error":         "partial vector write: 3/5 chunks stored, 2 failed — ... (legacy duplicate, same string)",
  "stage":         "embeddings_complete",
  "retryable":     false,
  "jobId":         "job_xyz_123"
}
```

Persisted by rag-api's **unchanged** failed branch:
- main document: `status: "failed"`, `error: <message>`, `error_stage: "embeddings_complete"`,
  `retryable: false`, `schema_version: 2`, timestamps.
- `processing/summary`: `stage: "embeddings_complete"`, `progress: 0`, `updated_at`,
  `error: {code: "UNKNOWN", message: <message>, stage: "embeddings_complete"}`.

## 4. Component design

### 4.1 New pure contract module (worker): `models/failure_payload.py`
New file `apps/ai-server/rag-worker-service/models/failure_payload.py` — sibling of the existing `models/`
package (`pubsub_messages.py`, `processing_status.py`, `resource_map.py` `[V]` exist; `processing_status.py`
contents `[U]`, hence a **new** file rather than coupling to unread contents). It must import only lightweight
dependencies (no firebase, no pubsub, no ML stack) so tests can import it in isolation despite `main.py`'s
import-time environment requirements `[V]`.

Contents:
- `FAILURE_STAGE_VOCABULARY`: frozenset `{starting, text_retrieved, tagging_complete, summary_generated,
  chunking_complete, embeddings_complete}` — the single source of truth for FR-2's vocabulary.
- `UNKNOWN_STAGE = "processing"` — the safe value; deliberately identical to the stale-lease sweep's
  `error_stage` sentinel so the field never regresses to null and both writer paths share the fallback `[V]`.
- `LEGACY_ERROR_KEY = "error"`.
- `build_failure_payload(error_message: str, stage: str, retryable: bool) -> dict`:
  - returns exactly `{"error_message": …, "stage": …, "retryable": …, "error": <same string as error_message>}`;
  - coerces `error_message` to `str`; coerces any `stage` outside
    `FAILURE_STAGE_VOCABULARY ∪ {UNKNOWN_STAGE}` to `UNKNOWN_STAGE` (defensive normalization — the handler must
    never raise while reporting a failure; tracker bugs are caught by tests, not by production coercion).
- Deliberately does **not** classify exceptions: `classify_error` stays in `main.py` (no circular import; the
  handler supplies the derived boolean).

### 4.2 Stage tracker in `process_document`
- A plain local `current_stage = UNKNOWN_STAGE` initialized before the `try` block.
- Assignments follow the mapping table in requirements §4.3, per the convention **"set the tracker immediately
  before the await"** of each pipeline step. Steps without a vocabulary entry (the post-embedding vector window:
  `delete_old_vectors_via_service`, `store_chunks_via_service`, metadata save) make no assignment and inherit
  `embeddings_complete` — this both implements the window decision and keeps the convention exception-free.
- Semantics note (intentional): `stage` names the failing *phase*; it may name a milestone whose progress event
  never fired (e.g. extraction failure → `text_retrieved`). `completed` is never a failure stage.
- Out-of-scope observation, documented as a boundary: the `langfuse` trace creation line sits **before** the
  `try`, so an exception there bypasses failure publishing entirely — pre-existing behavior, unchanged.

### 4.3 Failure handler rewrite (the only behavioral edit in the hot path)
The `except Exception as e:` block in `process_document` becomes:

```python
except Exception as e:
    metrics.error_message, metrics.end_time = str(e), time.time()
    retryable = classify_error(e)                     # existing classifier, unchanged [V]
    failure_details = build_failure_payload(str(e), current_stage, retryable)
    self.logger.error("document_processing_failed", ..., error=str(e), stage=current_stage, retryable=retryable)
    await self._publish_status_update(user_id, course_id, resource_id, "failed", failure_details, job_id)
    ...
```

`_publish_status_update` is untouched (it already passes `details` through, enriches `jobId`, resets the sequence,
and heartbeats the lease). Edge note: `str(e)` may be an empty string for exotic exceptions; the persisted
`error` is then `""` — truthful, and still not the API fallback. Accepted.

### 4.4 `retryable` derivation
- Reuses `classify_error` verbatim — no new classification logic, no drift between ACK/NACK behavior and the
  persisted flag. `run_worker`'s ACK/NACK code is untouched.
- Behavior change (deliberate, from definition F8): unclassified-unknown failures now persist `retryable: false`
  (previously the silent `True` default). Rationale: alignment with actual redelivery behavior; conservatism
  against retry loops; manual reprocess via `POST /process` `[D]` unaffected.
- The sweep's separate `retryable: true` write is untouched and remains correct (a dead worker is transient by
  nature).

### 4.5 Compatibility hedge (legacy `error` key)
The builder emits `error` duplicating `error_message`. rag-api ignores it (reads `error_message` `[V]`). Any
unknown consumer of the status topic continues to see the key it sees today. Cleanup path: if a later audit
confirms rag-api is the only consumer, deleting one line in the builder (and adjusting TR-4's expected key set)
is the entire change.

### 4.6 rag-api: zero production changes
`run_transactional_update`, `_process_status_message`, `models/resource.py`, and all endpoints are untouched.
The alignment constraint (`must`) is satisfied by construction; the contract is enforced by the test (§5).

## 5. Contract test architecture

**Location:** new file `apps/ai-server/tests/integration/test_worker_failure_contract.py`, sibling of
`test_api_contracts.py` `[V]`, sharing that directory's `conftest.py` and import bootstrap. The existing file
demonstrates the two house patterns this design reuses: importing `main as rag_api_main` and exercising real
model fields, and AST-based static checks over service sources. `[V]` Being in the same directory guarantees
discovery by whatever runner executes `test_api_contracts.py` today `[U]` (runner specifics unknown; same-dir
placement is the safe structural bet).

**Import strategy (two tiers):**
1. *Light tier (always available):* import `models/failure_payload.py` for the builder and vocabulary — no heavy
   deps, sidesteps `main.py`'s import-time env requirements `[V]`.
2. *Full tier (for `classify_error` in TR-3):* import worker `main.py` via the bootstrap the worker's unit tests
   already rely on (inferred from `tests/unit/test_processing_lease.py` targeting `main.py` functions; specifics
   `[U]`). Contingency, sanctioned if the bootstrap proves brittle: relocate `ProcessingError`/
   `TransientError`/`PermanentError`/`classify_error` into `models/failure_payload.py` and re-export from
   `main.py` (`from models.failure_payload import classify_error`) — behavior-identical, drift-safe, still
   worker-only.

**Persistence mode:** Firestore emulator primary (both services' `FIRESTORE_EMULATOR_HOST` branches verified
`[V]`); the test seeds `users/{test-user}/resources/{test-res}` with `status: "processing"` (required by the
`processing → failed` transition guard `[V]`), calls `rag_api_main.run_transactional_update(db, doc_ref,
"failed", details, logger, user_id)` directly (the verified persistence seam), then reads back the main document
and asserts:

- main document: `status == "failed"`, `error == <worker message>`, `error_stage == <worker stage>`,
  `retryable == <worker value>`;
- `processing/summary`: `stage == <worker stage>`, `error.message == <worker message>`,
  `error.stage == <worker stage>`, `error.code == "UNKNOWN"`.

A fake-Firestore fallback is sanctioned if the emulator cannot be provisioned in a given environment, but
emulator-first is preferred because it exercises the real transactional path. Either way, **production code from
both services is what runs** — only the transport is substitutable.

Sentinel discipline: test messages are distinctive strings (e.g. `"sentinel: contract probe 7f3a"`), never
`"Processing failed"`, so a fallback default can never satisfy an equality assertion; `retryable` values are
chosen opposite to the API default in each case (`True` in the early case, `False` in the late case) so a silent
default is detectable in both directions. This is what makes the test the API-side drift guard as well: any
rename of `error_message`/`stage`/`retryable` on the rag-api side collapses the persisted values to fallbacks
and fails the equality asserts.

### 5.1 Verification coverage matrix

| # | Level | Worker side | rag-api side | Catches |
|---|-------|-------------|--------------|---------|
| TR-1 | contract | `build_failure_payload("sentinel…", "text_retrieved", True)` through the real handler path | `run_transactional_update(..., "failed", details, …)` on emulator-seeded `processing` doc | early-stage seam; API-side key drift; summary parity |
| TR-2 | contract | same, stage `"embeddings_complete"`, `retryable=False` | same | late-stage seam incl. the inheritance window; `False` survives the `True` default |
| TR-3 | contract | real `classify_error` on `TransientError` / `PermanentError` / unclassified `ValueError` | payload-only assertion | retryable polarity (true / false / false) |
| TR-4 | contract | `set(build_failure_payload(...)) == {"error_message", "error", "stage", "retryable"}` | — | worker-side shape drift in either direction |
| TR-5 | static (AST) | `process_document` except-handler publishes `build_failure_payload(...)` with tracked stage + `classify_error` result; no inline dict | — | regression to `{"error": str(e)}`; tracker bypassed in handler |
| TR-6 | static (AST) | — | `_process_status_message` forwards `payload["details"]` unfiltered to `run_transactional_update` | envelope filtering that would drop keys |
| TR-7 | unit (worker test dir) | stubbed pipeline steps raising early and late; stubbed `_publish_status_update` captures details | — | tracker mechanism, set-before-await convention, inheritance rule |

TR-5's AST shape mirrors the static patterns already used in `test_api_contracts.py` `[V]`; TR-7 lives in
`apps/ai-server/rag-worker-service/tests/unit/` next to the existing lease unit tests.

## 6. Runtime sequence (after)

1. Pipeline step raises → `process_document`'s handler runs; `current_stage` holds the last set-before-await value
   (or `processing` if never set).
2. Handler calls `classify_error(e)` (existing, unchanged) → boolean.
3. Handler calls `build_failure_payload(str(e), current_stage, retryable)` → 4-key details dict.
4. `_publish_status_update(..., "failed", details, job_id)` (untouched) enriches `jobId`, resets the sequence,
   heartbeats the lease, publishes to `rag-status-updates`.
5. rag-api `_process_status_message` (untouched) resolves the doc path and calls `run_transactional_update`
   (untouched), whose failed branch persists the worker's values verbatim on main doc and `processing/summary`.

## 7. Why the payload construction lives in `process_document`'s handler

Two verified structural facts drive this:
- `process_document` catches all exceptions internally and returns `ProcessingMetrics`; it never re-raises. `[V]`
- `run_worker` applies `classify_error` for ACK/NACK inside its per-message except branch — reachable for errors
  raised outside `process_fn` (e.g. payload decode), not for pipeline failures. `[V]`

Consequences: the failure publish must be built in (or called from) the `process_document` handler — moving it to
`run_worker` would observe no pipeline exception at all. The published `retryable` is therefore a **policy
verdict from the same classifier the ACK/NACK machinery uses**, not a transport promise; retry mechanics (ACK/NACK
policy, redelivery) are an explicit non-goal of this fix and are not modified.

Design note: the `langfuse` trace creation sits before the `try` in `process_document` `[V]`; an exception there
bypasses failure publishing entirely. Pre-existing, out of scope, documented so it is not mistaken for a
regression introduced here.

## 8. Rollout and compatibility

- **Single-service deploy (rag-worker only).** rag-api is unchanged, so there is no cross-service ordering: the
  first worker deploy after the change immediately persists real values. In-flight status messages carry full
  payloads, so drain-on-restart is clean.
- **No migration/backfill.** Historical failed documents keep their fallback values; the `must_not` constraint
  forbids touching them.
- **Rollback.** Revert the worker deploy; the payload reverts to the legacy single-key shape, which unchanged
  rag-api tolerates (persisting fallbacks — the pre-fix behavior). The retained legacy `error` key keeps any
  unknown status-topic consumer working in both directions during the window.
- **CI.** The contract test rides the existing integration suite location; no new infrastructure beyond what
  `test_api_contracts.py` already relies on.

## 9. Alternatives considered and rejected

1. **Align rag-api to the worker** (read `details["error"]`) — rejected: violates the `must` constraint; would
   ripple to three already-consistent writers and both response models.
2. **Dual-read on rag-api** (`error_message` or `error`) — rejected: widens the contract instead of fixing the
   deviating writer; leaves two canonical keys; the test would pin a union, which is weaker than pinning one.
3. **Structured error-code taxonomy** — rejected (`prefer_not`); `error.code` stays `"UNKNOWN"`.
4. **Context-var or decorator-based stage tracking** — rejected: heavier than a plain local; the local plus the
   set-before-await convention is grep-able and pinned by TR-5/TR-7.
5. **Emitting the failure payload from `run_worker`** — rejected per §7: pipeline exceptions never reach it.

## 10. Unknowns carried into implementation

Same set as requirements §9 (conftest bootstrap; fixture-dir contents; `models/processing_status.py` and
`exceptions.py` contents; worker unit-test import mechanism; identities of other topic consumers). Each has a
sanctioned contingency in §5 (light-tier import, two-tier import with the `classify_error` relocation fallback,
same-directory placement). None blocks the design; all are resolvable during implementation without widening
scope.

## 11. Component → requirement traceability

| Component | Requirements served |
|-----------|---------------------|
| `models/failure_payload.py` (builder, vocabulary, `UNKNOWN_STAGE`, legacy key) | FR-1, FR-2, FR-5 |
| Stage tracker + handler rewrite in `process_document` | FR-1, FR-2, FR-4 |
| `classify_error` reuse (no new classification logic) | FR-4 |
| rag-api: zero production changes | FR-3 |
| `test_worker_failure_contract.py` (emulator seam + static guards) | FR-6 |
| Worker unit test (tracker mechanism) | FR-2 |