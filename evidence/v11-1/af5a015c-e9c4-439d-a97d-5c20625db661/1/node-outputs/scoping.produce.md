<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle aligns the rag-worker's failure status payload to rag-api's failed-branch contract (`error_message` / `stage` / `retryable`), adds stage tracking to the worker pipeline, derives `retryable` deliberately instead of silently defaulting it, and locks the worker→rag-api seam with a contract test. All changes live under `apps/ai-server`.

**1. Worker failure payload (`rag-worker-service/main.py`)** — the `process_document` exception handler currently publishes a one-key payload `{"error": str(e)}` via `_publish_status_update` (Definition F3). It will publish:
- `error_message` — the actual exception message (`str(e)`);
- `stage` — the pipeline stage executing at failure time (see item 2);
- `retryable` — deliberately derived from `classify_error(e)` (see item 3);
- the legacy `error` key retained alongside `error_message` — compatibility hedge for any unknown consumer of the status topic (Definition F11; constraint type: prefer).

**2. Stage tracking (`process_document`)** — a stage tracker set immediately before each pipeline step and reported by the failure handler. Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. `"processing"` is the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage` — so `error_stage` never regresses to null. Convention: set the tracker immediately before the await.

**3. retryable derivation** — aligned with the worker's ACK/NACK behavior in `run_worker`: `classify_error(e)` transient → `retryable: true`; permanent — including unclassified-unknown, per `classify_error`'s conservative default — → `retryable: false`. Verified this step: `classify_error` in `rag-worker-service/main.py` returns True for `TransientError`/connection-timeout types and HTTP 429/5xx, False for `PermanentError`/other 4xx, and False (permanent) for unknown exceptions. Deliberate behavior change: unclassified-unknown failures flip from the silently defaulted `true` to `false`; manual reprocess via `POST /process` is unaffected.

**4. rag-api-service — no production code change.** Its failed branch in `run_transactional_update` already reads `error_message`/`stage`/`retryable`, persists `error`/`error_stage`/`retryable` on the main resource document, and writes `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary subdocument (Definition F4). This cycle pins that behavior with a test; it does not modify it.

**5. Contract test (`tests/integration/`)** — new test following the house pattern in `tests/integration/test_api_contracts.py` (verified: direct import of rag-api `main`, JSON fixtures under `tests/fixtures/api-contracts/`, field-set assertions such as `error_stage` in `ResourceResponse`). The test must:
- import both sides rather than restate the contract in a fixture;
- exercise the worker's failure-payload construction through the worker's code path;
- feed the payload through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes;
- assert persisted `error`, `error_stage`, and `retryable` equal the worker's values;
- include a key-set drift guard so an edit to either side's payload keys fails the build;
- cover representative stages (an early-stage and a late-stage failure) without ossifying every pipeline step.

Implementation note (verified): the shared `tests/integration/conftest.py` currently puts only `rag-api-service` on `sys.path` and mocks the cloud SDKs (`firebase_admin`, `google.cloud.*`, `google.cloud.pubsub_v1`, …); the hermetic import setup must be extended to cover `rag-worker-service/main.py` the same way (or the test must set up its own path/mocks), since the worker's `main.py` imports the same cloud SDKs.

Evidence anchors (verified this step): `rag-worker-service/main.py` contains `classify_error` with `TransientError`/`PermanentError` and the conservative unknown→permanent default, the `ProcessingStatus` enum including `FAILED`, and the `_stale_lease_sweep_loop` / `run_worker(processor, process_fn=processor.process_document)` wiring at file end; the worker test tree has unit tests and an empty integration directory. `docker-compose.yml` builds `rag-api-service` (image `student-rag-api-service:0.1.0`) with `depends_on: rag-worker-service`.

## Purpose

Every worker-originated failure currently persists the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`, because the worker's one-key payload (`{"error": str(e)}`) does not match the three keys rag-api's failed branch reads (`error_message`, `stage`, `retryable`). Users and support cannot disambiguate failures, and retryability is silently defaulted rather than derived. The persisted schema (`error`/`error_stage`/`retryable`) is already written consistently by three other paths — the worker's stale-lease sweep and rag-api's enqueue-failure paths — and exposed by `Resource`/`ResourceResponse`; the worker's status publisher is the only writer that does not speak it. This cycle fixes the odd one out: the worker aligns to the API, with no Firestore migration, no field rename or backfill, no reader changes, and a contract test on the worker→rag-api failure path so key drift fails the build instead of silently re-creating this bug.

## Requirements

- **R1 — Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
- **R2 — Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- **R3 — API persistence unchanged.** rag-api's failed branch persists the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage (`error_code` remains `"UNKNOWN"` unless a code is actually sent).
- **R4 — Explicit retryable derivation.** Errors classified transient by `classify_error` → `retryable: true`; classified permanent, including unclassified-unknown per `classify_error`'s conservative default → `retryable: false`. The derivation must be explicit in the payload; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **R5 — Contract test.** A contract test must cover the worker failure → rag-api persistence path: exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes), assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and fail if either side's payload keys drift.

Acceptance checks (the cycle is done when all hold):
1. A failed job's published status message contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
2. After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
3. The processing/summary error subdocument for the failed job carries the same message and stage as the main document.
4. The contract test exists and passes, exercising the worker's failure-payload construction through rag-api's failed-branch persistence with the drift guard in place.

## Boundaries

Hard constraints (must / must_not, from the authoritative Definition):
- The worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields keep their names (`error`, `error_stage`, `retryable`) and semantics.
- Every worker-originated failure payload carries `retryable` explicitly; the API-side fallback must not be the operative mechanism for worker failures.

Out of scope (non-goals):
- The stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently; its `retryable=true` stays correct (a dead worker is a transient condition by nature).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Widening `classify_error` heuristics in this cycle.
- Anything the companion D3 issue covers beyond this worker→rag-api failure payload alignment.

Standing preferences (binding direction, not hard walls): prefer retaining the legacy `error` key in the worker's failure payload; prefer not introducing an error-code taxonomy.

## Version bump

- **rag-worker-service:** minor image bump recommended. The change is externally observable on the status topic (new payload keys; `retryable` flips to `false` for unclassified-unknown errors), which warrants a minor rather than patch increment under the repo's `student-rag-*:X.Y.Z` compose tagging convention. Note: the worker's current image tag in `docker-compose.yml` was not verified in this context (the compose read was truncated before the worker's service block; the sibling `rag-api-service` is at `0.1.0`) — confirm and increment the actual tag at implementation time.
- **rag-api-service:** no bump — no production code change; only test coverage is added.
- **Clients / frontend / data:** no bump — no schema, migration, or API-shape change.

## Deferred items

- **Companion D3 issue** referenced by the Objective — its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment (Definition F12).
- **Reconciling this analysis with deviation D4 in `plans/upload-flow.md`** — that file is not present in the current tree; the reference comes from the Objective text only.
- **Dropping the legacy `error` key** from the worker's failure payload — trigger: a consumer audit of the status topic confirms the worker is the only publisher and rag-api the only consumer; trivial cleanup afterward.
- **Widening `classify_error`** (recognizing more transient conditions) — trigger: evidence of unrecognized-but-transient failures being persisted `retryable: false`; manual reprocess via `POST /process` covers such cases in the meantime.
- **Structured error-code taxonomy** — trigger: a support need for machine-readable failure classes; currently a prefer-not.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>