<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

## Problem statement

When a RAG processing job fails, the worker's exception handler in `process_document` publishes a failed status payload with a single details key: `{"error": str(e)}` (apps/ai-server/rag-worker-service/main.py, process_document exception handler, via `_publish_status_update`). rag-api's failed branch in `run_transactional_update` (apps/ai-server/rag-api-service/main.py) reads `details` keys `error_message`, `stage`, and `retryable` and persists them as `error`, `error_stage`, and `retryable` on the main resource document, plus message/stage (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` subdocument.

Because of the key mismatch, every worker-originated failure currently persists:

- `error` = fallback string `"Processing failed"` (actual exception message lost)
- `error_stage` = `None`
- `retryable` = silent default `True` (not deliberately derived)

The `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

The established persisted failure schema is `error` / `error_stage` / `retryable` — written directly by the worker's stale-lease sweep (`_fail_if_still_stale`) and rag-api's enqueue-failure paths (`/process`, `POST /resources`), and exposed by `ResourceResponse` and the `Resource` model (`apps/ai-server/rag-api-service/models/resource.py`, `retryable` defaults `True`).

## Scope (binding, from the authoritative Definition)

### Must

1. **R-1 — Failure payload keys.** When document processing fails, the worker's failed status payload must include:
   - `error_message`: the actual exception message (`str(e)`)
   - `stage`: the pipeline stage executing at failure time
   - `retryable`: deliberately derived (see R-4)

   The payload must never rely on rag-api's fallback defaults for these keys.

2. **R-2 — Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. When the stage is genuinely unknown (e.g. failure before the first transition), the safe value is `"processing"` — the same value the stale-lease sweep uses for `error_stage` — so the field never regresses to null.

3. **R-3 — rag-api persistence unchanged.** rag-api's failed branch must persist the worker-provided values unchanged:
   - main document `error` ← payload `error_message`
   - main document `error_stage` ← payload `stage`
   - main document `retryable` ← payload `retryable`
   - `processing/summary` error subdocument carries the same message and stage (`error_code` remains `"UNKNOWN"` unless a code is actually sent)

4. **R-4 — Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior in `run_worker`, which uses `classify_error(e)`:
   - errors classified transient by `classify_error` → `retryable: true`
   - errors classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`

5. **R-5 — Contract test.** A contract test must cover the worker failure → rag-api persistence path. It must:
   - exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes)
   - assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values
   - fail if either side's payload keys drift (key-set drift guard)

### Must not

- **C-1.** The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. The worker aligns to rag-api's contract, not the reverse.

### Prefer

- **P-1.** Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling. Only rag-api's status subscriber is a verified consumer; other services/tooling share the topic, and the duplicate key is cheap insurance.

### Prefer not

- **PN-1.** Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

## Acceptance criteria

- **A-1.** A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
- **A-2.** After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value.
- **A-3.** The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
- **A-4.** A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift.

## Non-goals

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error `code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred). Reconciling with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree) is also deferred.

## Deliberate behavior change (accepted)

Unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent under `classify_error`; after this fix they will persist `retryable: false`. This is the conservatism `classify_error` was written for (prevents infinite retry loops); manual reprocess via `POST /process` remains unaffected. The stale-lease sweep's separate `retryable: true` write stays correct — a dead worker is a transient condition by nature.

## Known risks

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error` (P-1); residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention (see architecture) and representative-stage test coverage (an early-stage failure and a late-stage failure), which catches the tracker being removed or bypassed without ossifying every step.
- **Contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key later means touching the test.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

## 1. Current seam (verified)

```
rag-worker (process_document, one large try block)
    └─ except Exception as e:
         _publish_status_update(..., "failed", {"error": str(e)}, job_id)
              └─ Pub/Sub topic RAG_STATUS_TOPIC
                    └─ rag-api status subscriber
                         └─ run_transactional_update (failed branch)
                              reads: details["error_message"], details["stage"], details["retryable"]
                              persists: error, error_stage, retryable (main doc)
                                        message/stage/error_code="UNKNOWN" (processing/summary)
```

The worker publishes progress stages (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed`) but has no stage tracking in the failure handler. `classify_error()` (TransientError/PermanentError plus type- and status-code heuristics; unknown → permanent) already drives ACK/NACK in `run_worker` — a transient-classified exception omits the ack_id (Pub/Sub redelivers); permanent-classified is acked.

## 2. Change design

### 2.1 Worker: stage tracker in `process_document`

Introduce a local stage variable initialized to the safe value `"processing"`. Set it immediately **before** each pipeline step's `await` (the update-before-await convention — the tracker reflects the stage executing at failure time, not the stage just completed):

| Tracker set to | Before |
|---|---|
| `"starting"` | `_validate_processing_request` / initial status publish |
| `"text_retrieved"` | `_get_extracted_text` (Step 1) |
| `"tagging_complete"` | `content_tagger.generate_tags` (Step 2) |
| `"summary_generated"` | `generate_document_summary` (Step 3) |
| `"chunking_complete"` | `_create_enhanced_chunks` (Step 4) |
| `"embeddings_complete"` | `_generate_embeddings_with_openrouter` (Step 5) |

Names reuse the existing progress-stage vocabulary so a failure stage reads naturally next to the progress timeline clients already see. Failures before the first transition report `"processing"` (matching the stale-lease sweep's `error_stage` value), never null.

Convention note: a future pipeline step added without updating the tracker reports a stale stage; the contract test pins the mechanism on representative stages (early and late failure) rather than ossifying every step.

### 2.2 Worker: failure payload construction

The exception handler in `process_document` builds:

```python
retryable = classify_error(e)          # explicit derivation, same fn as ACK/NACK
details = {
    "error_message": str(e),           # new contract key
    "stage": current_stage,            # from the tracker
    "retryable": retryable,            # deliberately derived, never defaulted
    "error": str(e),                   # legacy key retained (P-1 hedge)
}
await self._publish_status_update(..., "failed", details, job_id)
```

Derivation rationale: `retryable` mirrors the worker's actual ACK/NACK behavior — transient = Pub/Sub will redeliver; permanent = acked, manual reprocess via `POST /process` remains. This makes the persisted record tell the truth. Behavior change: unclassified-unknown exceptions flip from persisted `True` (silent default) to `False` (conservative classification) — accepted.

The legacy `error` key is retained because only rag-api's status subscriber is a verified consumer; other services/tooling share the topic, and one redundant string is cheap insurance. Dropping it later is trivial cleanup if an audit confirms rag-api is the sole consumer.

### 2.3 rag-api: no changes

rag-api's failed branch already reads `error_message`/`stage`/`retryable` and persists them as `error`/`error_stage`/`retryable` plus the `processing/summary` error subdocument (`error_code` defaults `"UNKNOWN"` when absent — no code is sent, per PN-1). No reader changes, no schema migration, no backfill (C-1). The stale-lease sweep (`_fail_if_still_stale`) and rag-api's enqueue-failure paths are untouched (non-goals).

## 3. Contract test

Location: `apps/ai-server/tests/integration/` (alongside the existing `test_api_contracts.py`, which establishes the fixture- and AST-based static contract-test pattern; both services support hermetic Firestore-emulator mode via `FIRESTORE_EMULATOR_HOST` branches).

Strategy: import both sides rather than restate the contract in a fixture.

1. **Payload-construction leg:** drive the worker's failure path (a `process_document` run that raises, or the extracted payload-construction unit) and capture the published failed-status details. Cover two representative stages: an early-stage failure (tracker = `starting`/`text_retrieved`) and a late-stage failure (tracker = `embeddings_complete`), plus a pre-tracker failure asserting the `"processing"` safe value.
2. **Persistence leg:** feed the captured payload through rag-api's `run_transactional_update` failed branch against the Firestore emulator (or fakes) and assert the persisted main-document `error`, `error_stage`, `retryable` equal the worker's `error_message`, `stage`, `retryable`, and that the `processing/summary` error subdocument carries the same message and stage.
3. **Drift guard:** assert the exact key set of the worker's failure payload (AST-based or fixture-pinned, following the house pattern) so a future edit to either side's keys fails the build instead of silently re-creating the mismatch.

## 4. Data flow after the fix

```
failure in process_document
  → tracker holds failing stage
  → details = {error_message, stage, retryable=classify_error(e), error(legacy)}
  → Pub/Sub status topic
  → rag-api failed branch (unchanged reads)
  → persisted: error=<actual message>, error_stage=<failing stage|"processing">,
               retryable=<derived>, summary subdoc message/stage/error_code="UNKNOWN"
```

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Unknown status-topic consumers reading old keys | Legacy `error` key retained (P-1); residual risk accepted low |
| Stage-tracker drift as pipeline evolves | Update-before-await convention; representative-stage tests |
| `retryable=false` for unrecognized-but-transient failures | Accepted; widening `classify_error` is out of scope; manual reprocess unaffected |
| Test ossification | Intentional — it is the drift guard |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>