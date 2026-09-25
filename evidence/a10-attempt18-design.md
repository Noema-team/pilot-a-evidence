<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — Worker → rag-api failure payload contract alignment

Authoritative source: WorkItem `wi-define-108-a8` (definition `definition:obj-108`). Scope below is exact and binding.

## 1. Problem statement

When `process_document` in `rag-worker-service/main.py` raises, its exception handler publishes a failed status with `details = {"error": str(e)}`. rag-api's failed branch in `run_transactional_update` reads `details["error_message"]`, `details["stage"]`, and `details["retryable"]`. Because of the key mismatch, every worker-originated failure persists:

- `error` = `"Processing failed"` (API fallback, never the actual message)
- `error_stage` = `None`
- `retryable` = `True` (silent API default, not derived from the worker's ACK/NACK decision)

The `processing/summary` error subdocument inherits the same fallbacks with `error_code = "UNKNOWN"`.

## 2. Must requirements

### R1 — Worker failure payload keys
When document processing fails, the worker's failed status payload must include:

- `error_message` — the actual exception message (`str(e)`),
- `stage` — the pipeline stage executing at failure time,
- `retryable` — deliberately derived, never defaulted.

The payload must never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for these keys.

### R2 — Stage tracking in `process_document`
The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-status vocabulary:

`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.

`"processing"` is the safe value when the stage is genuinely unknown (e.g. failure before the first transition) — the same value the stale-lease sweep uses for `error_stage`.

### R3 — rag-api persists worker-provided values unchanged
rag-api's failed branch must persist, with no changes to its reads or persisted schema:

- main doc `error` ← payload `error_message`
- main doc `error_stage` ← payload `stage`
- main doc `retryable` ← payload `retryable`
- `processing/summary` `error.message` ← same message; `error.stage` ← same stage (`error.code` remains `"UNKNOWN"` unless a code is actually sent).

### R4 — Explicit retryable derivation aligned with ACK/NACK behavior
`retryable` must be derived from `classify_error(e)`:

- transient-classified → `retryable = true`
- permanent-classified, including unclassified-unknown (classify_error's conservative default) → `retryable = false`

Rationale: a transient error is one Pub/Sub will redeliver; a permanent error was acked and manual reprocess via `POST /process` remains. Deliberate behavior change: unclassified-unknown exceptions move from the silent default `true` to `false`. The stale-lease sweep's separate `retryable: true` write stays unchanged and correct (a dead worker is a transient condition).

### R5 — Contract test on the worker failure → rag-api persistence path
A contract test must:

- exercise the worker's failure-payload construction (through the worker's code path, not a restated fixture),
- feed that payload through rag-api's failed-branch persistence (`run_transactional_update`, via Firestore emulator or fakes),
- assert persisted `error`, `error_stage`, and `retryable` equal the worker's values,
- include a key-set drift guard that fails if either side's payload keys change.

It must cover at least an early-stage failure and a late-stage failure (representative stages), pinning the tracker mechanism without ossifying every step.

## 3. Should / prefer

- **R6 (prefer)** — Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any unknown consumers of the status topic and log tooling.
- **R7 (prefer_not)** — Do not introduce a structured error-code taxonomy; `error_code` stays `"UNKNOWN"` unless actually sent.

## 4. Must-not constraints

- No change to rag-api's reads, persisted field names (`error`, `error_stage`, `retryable`), or response models.
- No Firestore migration, field rename, or backfill of existing documents.
- No change to retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals. Only the *reporting* of retryability changes.
- No change to the stale-lease sweep's direct failure write — it already writes `error`/`error_stage`/`retryable` consistently.

## 5. Non-goals

- Structured error codes / failure taxonomy.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- The stale-lease sweep's behavior.
- Anything the companion D3 issue covers beyond this payload alignment (its content is unavailable here; deferred), and reconciling with the original D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## 6. Acceptance criteria

| # | Criterion |
|---|-----------|
| A1 | A failed job's worker-published status details contain `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. |
| A2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. |
| A3 | The `processing/summary` error subdocument carries the same message and stage as the main document. |
| A4 | A contract test covering the worker failure → rag-api persistence path exists and passes, exercising failure-payload construction through failed-branch persistence and asserting persisted `error`, `error_stage`, `retryable` equal the worker's values, failing if either side's payload keys drift. |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — Worker → rag-api failure payload contract alignment

## 1. Current seam

```
rag-worker                                  rag-api
process_document (one large try)            _process_status_message
  └─ except Exception as e:                 └─ run_transactional_update
       _publish_status_update("failed",          failed branch reads:
         {"error": str(e)})  ✗ MISMATCH          details["error_message"],
                                                 details["stage"],
                                                 details["retryable"]
                                               persists:
                                                 doc.error, doc.error_stage,
                                                 doc.retryable
                                                 summary.error{code,message,stage}
```

All other write paths (stale-lease sweep `_fail_if_still_stale`, enqueue-failure branches in `/process` and `POST /resources`) and both response models (`ResourceResponse`, `Resource`) already use the `error`/`error_stage`/`retryable` schema. The worker's status publisher is the only writer that doesn't speak it.

## 2. Fix direction: worker aligns to API

The worker changes its payload keys to `error_message`/`stage`/`retryable`. rag-api's failed branch, persisted fields, models, and the mobile contract all stay untouched. Zero migration, zero backfill.

## 3. Changes — rag-worker-service/main.py

### 3.1 Stage tracker
A local variable (`current_stage`) initialized to `"processing"` at the top of `process_document`, set immediately before each pipeline step (convention: **set the tracker immediately before the `await`**):

| Assignment point | Value |
|---|---|
| Before `_validate_processing_request` / first publish | `"starting"` |
| Before `_get_extracted_text` completes → after | `"text_retrieved"` |
| Before `generate_tags` | `"tagging_complete"` |
| Before `generate_document_summary` | `"summary_generated"` |
| Before `_create_enhanced_chunks` | `"chunking_complete"` |
| Before `_generate_embeddings_with_openrouter` | `"embeddings_complete"` |

Failure before the first transition leaves `"processing"` — the same value the stale-lease sweep uses, so `error_stage` never regresses to null.

### 3.2 Failure handler
Replace the exception handler's publish:

```python
await self._publish_status_update(
    user_id, course_id, resource_id, "failed",
    {
        "error_message": str(e),        # actual message (R1)
        "stage": current_stage,          # tracker value (R2)
        "retryable": classify_error(e),  # explicit derivation (R4)
        "error": str(e),                 # legacy key retained (R6 hedge)
    },
    job_id,
)
```

`classify_error` already exists (TransientError/PermanentError, httpx type/status heuristics, unknown → permanent) and drives ACK/NACK in `run_worker`; the persisted `retryable` now matches what Pub/Sub actually does. No new machinery.

### 3.3 Untouched
`_fail_if_still_stale`, `_publish_status_update` mechanics (sequence numbers, lease heartbeat), `run_worker` ACK/NACK, all retry/lease/heartbeat configuration.

## 4. Changes — rag-api-service/main.py

None. `run_transactional_update`'s failed branch already reads the right keys and persists the right fields; the `details.get(...)` fallbacks become dead paths for worker-originated failures and remain as defensive defaults for other publishers. This is the explicit no-change boundary: any diff to rag-api's reader in this fix is out of contract.

## 5. Contract test

Location: `apps/ai-server/tests/integration/test_api_contracts.py` (existing fixture- and AST-based static contract test patterns) or a sibling module reusing its conventions.

Structure:

1. **Worker side (real code path).** Build the failure payload by invoking the worker's failure-payload construction — e.g. a small extractable helper (or the exception-handler branch of `process_document` via a stubbed processor) — with a forced exception at a chosen stage. Assert payload keys `{error_message, stage, retryable}` (plus retained legacy `error`) and the derived `retryable` for a transient-classified and a permanent-classified exception.
2. **API side (real code path).** Feed that payload as `details` into `run_transactional_update` with a resource document at status `"processing"` in the Firestore emulator (both services already branch on `FIRESTORE_EMULATOR_HOST`; fakes are acceptable where the emulator is unavailable).
3. **Assertions.** Persisted doc: `error == payload["error_message"]`, `error_stage == payload["stage"]`, `retryable == payload["retryable"]`. `processing/summary` `error.message` and `error.stage` equal the same values.
4. **Drift guard.** A static (AST- or fixture-based) assertion pinning the worker's published key set and rag-api's `details.get(...)` key set to the contract (`error_message`, `stage`, `retryable`); any edit to either side's keys fails the build.
5. **Coverage.** At least two scenarios: early-stage failure (tracker = `"starting"` or `"processing"`) and late-stage failure (e.g. `"embeddings_complete"`), plus one transient and one permanent classification.

Known drift risk — a future pipeline step added without updating the tracker — is mitigated by the update-before-await convention and the representative-stage coverage; the drift guard makes silent removal of the tracker a build failure.

## 6. Data flow after the fix

```
process_document exception at stage S
  → failed status details: {error_message, stage: S, retryable: classify_error(e), error (legacy)}
  → Pub/Sub rag-status-updates
  → rag-api _process_status_message
  → run_transactional_update failed branch
  → doc: status=failed, error=<message>, error_stage=S, retryable=<derived>
  → processing/summary.error: {code: "UNKNOWN", message: <message>, stage: S}
  → GET /resources/{id}/status (ResourceResponse) exposes error + error_stage
```

## 7. Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old single-key payload — mitigated by retaining `error` alongside `error_message`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention + representative-stage test.
- **`retryable=false` for unclassified-unknown errors** (was silently `true`) — accepted; this is `classify_error`'s intended conservatism against infinite retry loops, and manual reprocess via `POST /process` is unaffected. Widening `classify_error` is out of scope.
- **Contract test ossifies the payload** — intentional; it is the drift guard.

## 8. Deferred / out of scope

Structured error codes; retry/backoff mechanics; stale-lease sweep behavior; frontend work; the companion D3 issue's scope beyond this alignment; reconciliation with `plans/upload-flow.md` D4 (file not present in the current tree).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>