<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements: rag-worker → rag-api failure payload contract alignment

**WorkItem scope:** Align the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

**Authoritative source:** definition artifact `definition:obj-108` (sha256 `71f1c39c…`), WorkItem `wi-define-108-a8`.

---

## 1. Problem statement

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test covers the seam.

- **Worker side (verified):** `process_document`'s exception handler in `apps/ai-server/rag-worker-service/main.py` publishes a failed status with `details = {"error": str(e)}` via `_publish_status_update`.
- **API side (verified):** rag-api's `run_transactional_update` failed branch in `apps/ai-server/rag-api-service/main.py` reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, and `details.get("retryable", True)`; it persists `error`, `error_stage`, `retryable` on the main resource document and writes `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument.

**Consequence (verified):** every worker-originated failure persists `error = "Processing failed"` (fallback), `error_stage = None`, and `retryable = True` (silent default). The `processing/summary` error subdocument inherits the same fallbacks with `error_code = "UNKNOWN"`. Users and support cannot disambiguate failures.

**Established schema (verified):** `error`/`error_stage`/`retryable` are already written consistently by three other paths — the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths (`/process`, `POST /resources`) — and exposed by `ResourceResponse` and the `Resource` model (`retryable` defaults `True`). The worker's status publisher is the only writer that does not speak this schema.

## 2. Functional requirements

### FR-1 — Failure payload completeness
When document processing fails, the worker's failed status payload `details` must include:
- `error_message`: the actual exception message (`str(e)`),
- `stage`: the pipeline stage executing at failure time,
- `retryable`: a deliberately derived boolean.

The payload must never rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for these keys.

### FR-2 — Stage tracking
The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.

- Stage names must reuse the existing progress-stage vocabulary (verified in `_publish_status_update` calls): `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown (e.g. failure before the first stage transition) — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.
- Convention: the stage tracker is set immediately before each pipeline step's `await`.

### FR-3 — rag-api persistence unchanged
rag-api's failed branch must persist the worker-provided values unchanged:
- main document: `error ← payload.error_message`, `error_stage ← payload.stage`, `retryable ← payload.retryable`;
- `processing/summary` error subdocument: same `message` and `stage`; `code` remains `"UNKNOWN"` unless a code is actually sent.

No changes to rag-api's reads, persisted field names, or semantics.

### FR-4 — Explicit retryable derivation
The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior (verified in `run_worker`):
- errors classified **transient** by `classify_error(e)` → `retryable: true` (Pub/Sub will redeliver after the ack deadline; the message is omitted from `ack_ids`);
- errors classified **permanent** — including unclassified-unknown exceptions, per `classify_error`'s conservative default returning `False` → `retryable: false` (the message is acked to avoid poison-pill loops; manual reprocess via `POST /process` remains available).

**Deliberate behavior change:** unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent; they will now persist `false`. This is accepted — it is the conservatism `classify_error` was written for, and it prevents infinite retry loops.

**Stale-lease sweep unchanged (verified):** `_fail_if_still_stale` writes `retryable: True` directly; this stays correct because a dead worker is a transient condition by nature. It is out of scope.

### FR-5 — Compatibility hedge
The worker must retain the legacy `error` key in the failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling. Only rag-api's status subscriber was verified as a consumer; other services and tooling share the topic, and auditing every potential reader is out of scope for this one-line fix.

### FR-6 — Contract test
A contract test must cover the worker failure → rag-api persistence path:
- It must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
- It must fail if either side's payload keys drift (a key-set drift guard, so a future edit to either side's keys fails the build instead of silently re-creating this bug).
- It must import both sides rather than restate the contract in a fixture.
- It must cover representative stages — at minimum an early-stage failure and a late-stage failure — sufficient to catch the stage tracker being removed or bypassed, without ossifying every pipeline step.
- Existing infrastructure supports this (verified): `apps/ai-server/tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests) and `FIRESTORE_EMULATOR_HOST` branches in both services.

## 3. Constraints

| # | Type | Constraint |
|---|------|-----------|
| C1 | must | The worker is aligned to rag-api's existing contract (`error_message`/`stage`/`retryable`) — rag-api's reads and persisted schema are not changed. |
| C2 | must_not | No Firestore migration, field rename, or backfill of existing documents; `error`, `error_stage`, `retryable` keep their names and semantics. |
| C3 | must | Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. |
| C4 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| C5 | prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## 4. Acceptance criteria

1. A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
2. After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value.
3. The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
4. A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift.

## 5. Non-goals

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error `code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred). Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` is likewise deferred (that file is not present in the current tree; the reference comes from the Objective text).

## 6. Known risks and accepted tradeoffs

| Risk | Mitigation | Residual |
|------|-----------|----------|
| Unknown consumers of the status topic reading the old key set | Retain legacy `error` key (FR-5) | Accepted as low; dropping the duplicate later is trivial cleanup if an audit confirms worker-only publisher / rag-api-only consumer. |
| Stage-tracker drift as the pipeline evolves | "Set the tracker immediately before the await" convention; contract test pins the mechanism on representative stages | Accepted; a new pipeline step added without updating the tracker reports a stale stage. |
| `retryable=false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures | Accepted per adopted default (F8); widening `classify_error` is out of scope; manual reprocess via `POST /process` remains | Accepted. |
| Contract test ossifies the payload | Intentional — that is the drift guard doing its job; adding a key later means touching the test | Intentional. |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>