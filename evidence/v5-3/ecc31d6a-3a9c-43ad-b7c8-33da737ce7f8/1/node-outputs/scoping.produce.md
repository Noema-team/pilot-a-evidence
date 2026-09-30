<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle fixes one seam and pins it with a test. Exactly three changes:

1. **Worker failure payload** — `apps/ai-server/rag-worker-service/main.py`, the exception handler of `EnhancedDocumentProcessor.process_document` (the `_publish_status_update(..., "failed", {"error": str(e)}, job_id)` call in the `except` block, verified during scoping). The failed-status details become:
   - `error_message` — the actual exception message (`str(e)`);
   - `stage` — the failing pipeline stage (change 2);
   - `retryable` — deliberately derived from `classify_error(e)` (transient → `true`, permanent/unknown → `false`);
   - `error` — legacy key retained alongside `error_message` with the same value (compatibility hedge).
2. **Stage tracking in `process_document`** — same file. A local stage tracker set immediately before each awaited pipeline step, so the failure handler reports the stage executing at failure time. Stage names reuse the existing progress vocabulary already published by the pipeline (verified): `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. `"processing"` is the safe value when the stage is genuinely unknown (failure before the first transition) — the same value the stale-lease sweep (`_fail_if_still_stale`) already persists for `error_stage`.
3. **Contract test** — a new test file under `apps/ai-server/tests/integration/`, alongside `test_api_contracts.py` (its conftest already puts rag-api on `sys.path` and mocks the cloud SDKs): build the failure payload through the worker's real code path, feed it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes, assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and guard the payload key set on both sides so drift fails the build.

rag-api's reads, field names, and persisted schema are **not** changed. Test scaffolding (conftest, mocks, emulator/fake wiring) may be adjusted only as needed to run the contract test hermetically.

## Purpose

Every worker-originated failure currently persists garbage: the worker publishes one key (`error`) while rag-api's failed branch reads three (`error_message`, `stage`, `retryable`), so Firestore records the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — on the main resource document and again in the `processing/summary` error subdocument, with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures, and retryability is silently defaulted instead of derived.

The worker is the odd writer out: the stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource` model already speak the `error`/`error_stage`/`retryable` schema (verified in `rag-api-service/models/resource.py` — the fields exist, `retryable` defaults `True`). This cycle aligns the worker to that contract — no migration, no backfill, no reader changes — and locks the seam with a contract test so neither side can drift silently again. The persisted `retryable` flag becomes truthful: it mirrors the worker's actual ACK/NACK behavior in `run_worker` (transient → Pub/Sub redelivers; permanent → acked, manual reprocess via `POST /process` remains).

## Requirements

- **R1 — Failure payload keys.** On failure, the worker's failed-status details must contain `error_message` (actual exception message), `stage` (tracked failing stage, R2), and `retryable` (derived per R4), plus the retained legacy `error` key. The payload must never rely on rag-api's `details.get(...)` fallbacks for these keys.
- **R2 — Stage tracking.** `process_document` must track the currently executing stage; convention: set the tracker immediately before each awaited pipeline step. Names come only from the existing vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` when genuinely unknown. The post-`embeddings_complete` steps (old-vector deletion, Weaviate storage, processing-metadata save, usage update, resource-map generation) have no vocabulary entry of their own; for failures there, keep the most recently set vocabulary stage (`embeddings_complete`) — the failure occurred after that transition — reserving `"processing"` for pre-first-transition failures. This choice is pinned by the late-stage contract-test case.
- **R3 — rag-api unchanged as consumer.** rag-api's failed branch persists the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument carries the same message and stage, with `error_code` staying "UNKNOWN" unless a code is actually sent. No changes to rag-api's reads, field names, or schema.
- **R4 — retryable derivation.** `retryable = classify_error(e)`: transient-classified → `true`; permanent-classified — including unclassified-unknown, per `classify_error`'s conservative default (`False`) → `false`. This aligns the persisted record with `run_worker`'s ACK/NACK decisions, which use the same function. Deliberate behavior change: unclassified-unknown failures now persist `retryable: false` (previously the silent default `true`); manual reprocess via `POST /process` is unaffected. The derivation source is `classify_error` — not the separate `PDFProcessingError.retryable` metadata attribute in `rag-worker-service/exceptions.py`.
- **R5 — Contract test.** The test must:
  - exercise the worker's failure-payload construction through its real code path (not a restated fixture) and rag-api's failed-branch persistence via `run_transactional_update` against the Firestore emulator or fakes;
  - assert persisted `error` == payload `error_message`, `error_stage` == payload `stage`, `retryable` == payload `retryable`, and that the `processing/summary` subdocument carries the same message and stage;
  - include a key-set drift guard: any addition, removal, or rename of the failure keys on either side fails the build;
  - cover at least one early-stage failure and one late-stage failure (representative stages — enough to catch the tracker being removed or bypassed without ossifying every step);
  - run hermetically (existing conftest mock pattern; both services have `FIRESTORE_EMULATOR_HOST` branches).

Acceptance mapping (Definition acceptance → requirements): payload carries the three keys without fallback reliance → R1/R2/R4; persisted `error`/`error_stage`/`retryable` equal the worker's values (not "Processing failed"/None/silent default) → R3 + R5; subdocument consistency → R3; contract test exists and passes → R5.

## Boundaries

**Binding constraints (from the Definition):**
- Align the worker to rag-api's existing contract — never the reverse; rag-api's reads and persisted schema stay untouched.
- No Firestore migration, field rename, or backfill; `error`/`error_stage`/`retryable` keep their names and semantics.
- Every worker failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- Retain the legacy `error` key (prefer); no structured error-code taxonomy (prefer_not).

**Out of scope / non-goals:**
- The stale-lease sweep (`_fail_if_still_stale`) — it already writes `error` / `error_stage: "processing"` / `retryable: true`, consistent with this contract (verified).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases (`PROCESSING_LEASE_SECONDS`), heartbeat intervals — only the *reporting* of retryability changes.
- Frontend/mobile — `ResourceResponse` already exposes `error`/`error_stage` (verified in `rag-api-service/models/resource.py`).
- Structured error codes or a failure taxonomy — `processing/summary` `error.code` stays "UNKNOWN" unless actually sent.
- Widening `classify_error`'s heuristics.
- Dropping the legacy `error` key (future cleanup after a consumer audit).
- Any scope the companion D3 issue covers beyond this alignment (see Deferred items).

**Accepted risks / tradeoffs:**
- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the set-before-await convention and representative-stage test coverage.
- `retryable: false` for unclassified-unknown errors reduces auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; manual reprocess remains.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job.

**Verified implementation anchors (from scoping):**
- The failure publish lives in the `except` block of `process_document`; the pipeline is one large `try` with six published stage transitions (`starting` … `embeddings_complete`) plus `completed` on success.
- `classify_error` (verified): `TransientError`, httpx connect/timeout types, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` → transient; `PermanentError`, non-429 4xx, and unknown exceptions → permanent; 429/5xx `HTTPStatusError` → transient. `run_worker` omits transient failures from `ack_ids` (redelivery) and acks permanent ones.
- Existing test patterns to build on: `apps/ai-server/tests/integration/test_api_contracts.py` + its `conftest.py` (cloud-SDK mocks, rag-api on `sys.path`), and `rag-worker-service/tests/` (unit/integration, `pytest.ini` with `asyncio_mode = auto`).

## Version bump

None prescribed. No version manifest was verified in the affected services during scoping, so this charter mandates no bump; if the release process requires one, treat the change as patch-level. The only behavior changes visible outside the worker are richer failure-record contents and `retryable: false` for unclassified-unknown failures.

## Deferred items

- **Companion D3 issue** referenced by the Objective — its content is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle (Definition F12).
- **Reconciling with the original D4 deviation note** in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text only.
- **Dropping the legacy `error` key** — trivial cleanup once a consumer audit confirms rag-api's status subscriber is the only consumer of the status topic.
- **Widening `classify_error`** to recognize more transient conditions — separate change; the `retryable: false`-for-unknown behavior is accepted as-is this cycle.
- **Structured error-code taxonomy** — not introduced; `error_code` remains "UNKNOWN" unless actually sent.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>