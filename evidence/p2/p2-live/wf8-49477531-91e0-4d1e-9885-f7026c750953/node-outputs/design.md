<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

## Scope statement

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

## Verified current state (repository evidence)

- **F3 (verified):** The worker's `process_document` exception handler in `apps/ai-server/rag-worker-service/main.py` publishes failed status via `_publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)` — a one-key payload.
- **F4 (verified):** rag-api's `run_transactional_update` failed branch in `apps/ai-server/rag-api-service/main.py` reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, and `details.get("retryable", True)`; persists `error`, `error_stage`, `retryable` on the main resource document; and writes `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument.
- **F5 (verified consequence):** Every worker-originated failure currently persists `error = "Processing failed"` (fallback), `error_stage = None`, and `retryable = True` (silent default).
- **F6 (verified):** `error`/`error_stage`/`retryable` are the established persisted failure schema — used by the worker's stale-lease sweep, rag-api's enqueue-failure paths, `ResourceResponse`, and the `Resource` model (`apps/ai-server/rag-api-service/models/resource.py`, `retryable: bool = True`).
- **F7 (verified):** The worker classifies exceptions via `classify_error()` (`TransientError`/`PermanentError` plus type- and status-code heuristics; unknown exceptions classify as permanent) and uses that classification for ACK/NACK in `run_worker`.
- **F9 (verified):** The worker publishes progress stages `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, `completed` via `_publish_status_update` calls in `process_document` (confirmed by direct read of the pipeline body); there is no stage tracking in the failure handler today.
- **F10 (verified):** Contract-test infrastructure exists at `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests, direct `import main as rag_api_main` of the rag-api module), and both services have `FIRESTORE_EMULATOR_HOST` branches in their Firebase init paths — a hermetic contract test is implementable with existing patterns.

## Functional requirements

### FR-1 — Failure payload keys

When document processing fails, the worker's failed status payload must include:

- `error_message` — the actual exception message (`str(e)`), never a placeholder;
- `stage` — the pipeline stage executing at failure time;
- `retryable` — deliberately derived (see FR-4).

The payload must never rely on rag-api's fallback defaults for these keys (`"Processing failed"`, `None`, `True`).

### FR-2 — Stage tracking

The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.

- Stage names must reuse the existing progress-stage vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- When the stage is genuinely unknown (e.g. failure before the first stage transition or before the tracker is initialized), the safe value is `"processing"` — the same value the stale-lease sweep uses for `error_stage` — so the field never regresses to null.
- Convention: the tracker is set immediately before each pipeline `await`; a new pipeline step added without updating the tracker is a defect the contract test's representative-stage coverage is designed to catch.

### FR-3 — rag-api persistence unchanged

rag-api's failed branch must persist the worker-provided values unchanged:

- main document `error` ← payload `error_message`;
- main document `error_stage` ← payload `stage`;
- main document `retryable` ← payload `retryable`;
- `processing/summary` error subdocument `message` and `stage` carry the same values; `code` remains `"UNKNOWN"` unless a code is actually sent.

No reader changes, no schema migration, no field rename, no backfill.

### FR-4 — retryable derivation

The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior:

- errors classified **transient** by `classify_error(e)` → `retryable: true` (Pub/Sub will redeliver);
- errors classified **permanent** — including unclassified-unknown, per `classify_error`'s conservative default — → `retryable: false` (acked, manual reprocess via `POST /process` remains available).

Adopted default (F8, ASSUMED): this aligns the persisted record with actual retry behavior. Deliberate behavior change: unclassified-unknown exceptions currently persist `retryable: true` (silent default) but classify permanent, so they will now persist `false`. The stale-lease sweep's separate `retryable: true` write stays correct (a dead worker is a transient condition) and is out of scope.

### FR-5 — Legacy key compatibility hedge

The worker retains the legacy `error` key alongside `error_message` in the failure payload, as a hedge for unknown consumers of the status topic and existing log tooling. Only rag-api's status subscriber is a verified consumer; dropping the duplicate later is trivial cleanup if an audit confirms the worker is the only publisher.

### FR-6 — Contract test

A contract test must cover the worker failure → rag-api persistence path:

- It must exercise the worker's failure-payload construction (through the worker's code path, not a restated fixture) and rag-api's `run_transactional_update` failed-branch persistence (via the Firestore emulator or fakes).
- It must assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
- It must fail if either side's payload keys drift (key-set drift guard).
- It should cover representative stages: an early-stage failure and a late-stage failure, to pin the stage-tracker mechanism without ossifying every step.
- It must follow the existing house pattern in `apps/ai-server/tests/integration/test_api_contracts.py`.

## Constraints

| # | Type | Constraint |
|---|------|-----------|
| C1 | must | The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — not the reverse; rag-api's reads and persisted schema are unchanged. |
| C2 | must_not | No Firestore migration, field rename, or backfill of existing documents; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. |
| C3 | must | Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| C4 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| C5 | prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## Non-goals

- Changing the stale-lease sweep's direct failure write (it already persists `error`/`error_stage`/`retryable` consistently with this contract).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here; deferred). Reconciling with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree) is also deferred.

## Acceptance criteria

1. **AC-1:** A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
2. **AC-2:** After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value.
3. **AC-3:** The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
4. **AC-4:** A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload contract alignment

## System context

```
┌────────────────────┐   Pub/Sub topic        ┌────────────────────┐
│   rag-worker       │  "rag-status-updates"  │     rag-api        │
│  (process_document)│ ─────────────────────► │ (status subscriber │
│                    │   status="failed"      │  → run_transactional_update)
└────────────────────┘                        └────────────────────┘
                                                       │
                                                       ▼
                                            Firestore resource doc
                                            (error / error_stage / retryable)
                                            + processing/summary subdoc
```

The worker publishes status messages to the `rag-status-updates` Pub/Sub topic via `_publish_status_update`; rag-api's status subscriber (`_process_status_message`) consumes them and calls `run_transactional_update`, which routes `details` keys into persisted fields. The seam between the worker's payload construction and rag-api's payload consumption is the only thing this change touches.

## Current contract mismatch (the defect)

**Worker side (verified, `rag-worker-service/main.py`, `process_document` exception handler):**
```python
await self._publish_status_update(user_id, course_id, resource_id, "failed", {"error": str(e)}, job_id)
```

**API side (verified, `rag-api-service/main.py`, `run_transactional_update` failed branch):**
```python
main_update["error"] = details.get("error_message", "Processing failed")
main_update["error_stage"] = details.get("stage")
main_update["retryable"] = details.get("retryable", True)
...
summary_update["error"] = {
    "code": details.get("error_code", "UNKNOWN"),
    "message": details.get("error_message", "Processing failed"),
    "stage": details.get("stage"),
}
```

Every worker failure therefore persists the fallback `"Processing failed"`, `error_stage: None`, and a fabricated `retryable: true`.

## Target contract

### Worker failure payload (new)

```python
{
    "error_message": str(e),        # actual exception message
    "stage": current_stage,         # pipeline stage at failure time
    "retryable": classify_error(e), # deliberately derived, never defaulted
    "error": str(e),                # legacy key retained (compatibility hedge)
}
```

The payload is constructed in the `process_document` exception handler and published through the existing `_publish_status_update` path — no new publishing mechanism.

### Stage tracking mechanism

`process_document` is one large try block spanning the whole pipeline (verified: `_validate_processing_request` → text retrieval → tagging → summary → chunking → embeddings → old-vector deletion → Weaviate storage → metadata persistence → completed status). A local stage tracker is introduced:

1. A local variable (e.g. `current_stage`) initialized to `"processing"` (the safe, sweep-consistent value) before the try block.
2. Immediately before each pipeline step's `await`, the tracker is set to the stage name that step's subsequent progress update uses: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
3. The exception handler reads the tracker and places it in the failure payload's `stage` key.

Stage names reuse the existing progress-update vocabulary (verified present in `process_document`'s `_publish_status_update` calls), so a failure stage reads naturally next to the progress timeline clients already see. Drift risk — a future pipeline step added without updating the tracker — is mitigated by the "set the tracker immediately before the await" convention and by representative-stage contract-test coverage (early-stage and late-stage failure).

### retryable derivation

The worker already classifies every exception via `classify_error()` (verified: `TransientError`/`PermanentError` types, transient exception types like `httpx.ConnectError`/`TimeoutError`, transient HTTP status codes 429/5xx, conservative permanent default for unknown exceptions) and uses that classification for ACK/NACK in `run_worker`. The failure payload derives `retryable` from the same function:

- `classify_error(e) == True` (transient) → `retryable: true` — Pub/Sub will redeliver, so the persisted record honestly says retryable.
- `classify_error(e) == False` (permanent, including unclassified-unknown) → `retryable: false` — the message is acked and will not return; manual reprocess via `POST /process` remains.

Deliberate behavior change: unclassified-unknown exceptions flip from persisted `true` (silent default) to `false` (conservative classification). This prevents infinite retry loops and is the behavior `classify_error` was written for. The stale-lease sweep's separate `retryable: true` write is untouched and stays correct — a dead worker is transient by nature.

### rag-api side

No changes. `run_transactional_update`'s failed branch already reads exactly the keys the worker will now send, and the persisted field names (`error`, `error_stage`, `retryable`) match the schema used by the stale-lease sweep, rag-api's enqueue-failure paths, `ResourceResponse`, and the `Resource` model (all verified). The `processing/summary` error subdocument inherits the same `error_message`/`stage` values with `error_code` remaining `"UNKNOWN"` (no structured error-code taxonomy, per constraint C5).

## Compatibility hedge

Only rag-api's status subscriber is a verified consumer of these payloads; other services and tooling share the topic. The worker retains the legacy `error` key alongside `error_message` — one redundant string per failure message as insurance against an unknown reader. If a later audit confirms the worker is the only publisher and rag-api the only consumer, dropping the duplicate is trivial cleanup.

## Contract test design

Location: `apps/ai-server/tests/integration/` (new test alongside `test_api_contracts.py`, following its house pattern).

Principles:

1. **Import both sides, don't restate the contract.** The test imports the worker module (for the failure-payload construction) and `main as rag_api_main` (for `run_transactional_update`), the same direct-import pattern the existing contract tests use.
2. **Exercise the real seam.** Build the failure payload through the worker's code path (an induced failure in `process_document`, or the payload-construction helper extracted for testability), then feed it through `run_transactional_update` against the Firestore emulator (both services have verified `FIRESTORE_EMULATOR_HOST` branches) or fakes.
3. **Assert persistence.** After the failed-branch write, read back the resource document and assert `error == worker's error_message`, `error_stage == worker's stage`, `retryable == worker's retryable`; assert the `processing/summary` error subdocument carries the same message and stage.
4. **Key-set drift guard.** Assert the exact set of failure-payload keys the worker emits matches the exact set of keys rag-api's failed branch reads (AST-based or direct introspection, mirroring the existing AST-based drift guards in `test_api_contracts.py`). A future edit to either side's keys fails the build instead of silently re-creating this bug.
5. **Representative stages.** Cover an early-stage failure (e.g. text retrieval) and a late-stage failure (e.g. embeddings) to pin the stage-tracker mechanism without ossifying every pipeline step.

## Risks and tradeoffs

| Risk | Mitigation | Residual |
|------|-----------|----------|
| Unknown consumers of the status topic reading the old key set | Retain legacy `error` key | Accepted as low |
| Stage-tracker drift as the pipeline evolves | Update-before-await convention; representative-stage test coverage | Convention is documentation-enforced |
| `retryable=false` for unclassified errors reduces auto-retry affordances for genuinely transient-but-unrecognized failures | Accepted; widening `classify_error` is out of scope; manual reprocess via `POST /process` remains | Accepted |
| Contract test ossifies the payload | Intentional — the drift guard is the point; adding a key later means touching the test | None (by design) |

## Out of scope

- Stale-lease sweep behavior (already contract-consistent).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals.
- Frontend/mobile (`ResourceResponse` already exposes `error`/`error_stage`).
- Structured error codes / failure taxonomy (`error.code` stays `"UNKNOWN"`).
- Companion D3 issue scope beyond this payload alignment (unavailable in this context; deferred), and reconciliation with the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree; deferred).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>