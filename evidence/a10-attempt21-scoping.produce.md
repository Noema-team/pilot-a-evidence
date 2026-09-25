<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle touches exactly three areas, all bounded by the authoritative Definition (`wi-define-108-a8`):

**Worker side — `apps/ai-server/rag-worker-service/main.py`:**
- Failure-payload construction in `process_document`'s exception handler (published via `_publish_status_update`): the payload gains `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
- Stage tracking through `process_document`: a local stage tracker set immediately before each awaited pipeline step, reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage`.
- `retryable` derivation from the existing `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (classify_error's conservative default), → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.

**API side — `apps/ai-server/rag-api-service/main.py`:**
- No changes to `run_transactional_update`'s reads or to the persisted schema. The failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main document and `message`/`stage`/`code` in the `processing/summary` error subdocument; the requirement is that it persist the worker-provided values unchanged (verified: fallbacks are `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`; `error_code` defaults to `"UNKNOWN"`). The API side is the reference contract; the worker aligns to it.

**Tests — `apps/ai-server/tests/integration/`:**
- One new contract test covering the worker failure → rag-api persistence path, importing both sides rather than restating the contract in a fixture: build the failure payload through the worker's code path, feed it through `run_transactional_update` (Firestore emulator or fakes — both services have `FIRESTORE_EMULATOR_HOST` branches, and the house pattern in `test_api_contracts.py` + `conftest.py` already direct-imports rag-api with mocked cloud dependencies), and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
- A key-set drift guard asserting the worker's published failure-payload keys and rag-api's read keys, so a future edit to either side fails the build instead of silently re-creating this bug.
- Representative-stage coverage: an early-stage failure and a late-stage failure, pinning the stage-tracker mechanism without ossifying every pipeline step.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. Verified repository evidence: the worker's `process_document` exception handler publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch in `run_transactional_update` reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error`/`error_stage`/`retryable`. Every worker-originated failure therefore lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true`; the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

The persisted failure schema (`error`/`error_stage`/`retryable`) is already consistent across three other write paths — the worker's stale-lease sweep, rag-api's enqueue-failure paths (`/process`, `POST /resources`) — and is exposed by both the `Resource` model (`models/resource.py`, `retryable` defaults `True`) and `ResourceResponse`. The worker's status publisher is the only writer that doesn't speak it. This cycle fixes the odd one out: the worker aligns to the API's existing contract, so a failed job persists the worker's actual error message, the true failing stage, and a retryable flag that tells the truth about whether Pub/Sub will redeliver — locked in by a contract test so the seam cannot silently drift again. No migration, no backfill, no reader changes.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The `retryable` derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Acceptance criteria from the Definition map 1:1 onto these: worker payload carries all three keys; persisted document has the actual message (not `"Processing failed"`), the failing stage (not `None`), and the derived retryable; the summary subdocument matches the main document; and the contract test exists and passes.

## Boundaries

**Hard constraints (must / must_not):**
- The worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

**Preferences (prefer / prefer_not):**
- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix; the summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.

**Explicit non-goals:**
- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (its `retryable=true` stays correct: a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred).

**Known accepted tradeoffs (recorded, not open questions):** unclassified-unknown exceptions will now persist `retryable: false` instead of the silent default `true` — this is `classify_error`'s intended conservatism and the manual reprocess path (`POST /process`) is unaffected; the contract test intentionally ossifies the payload key set, so adding a key later means touching the test.

## Version bump

No version bump is required for this cycle. Verified state of the tree: neither `rag-worker-service` nor `rag-api-service` carries an independently released package version for this contract — the only version marker found is rag-api's static FastAPI app metadata (`version="1.0.0"` in `main.py`), which is not part of the worker→rag-api payload contract and is not consumer-facing for it. The change adds payload keys and a test; it introduces no schema migration, no new runtime dependencies, and no CI/build-config change, so none of the repo's bump triggers apply. If implementation reveals a service-level versioning convention this investigation did not find, treat it as a patch-level bump and note it in the implementation PR — do not treat that as a scope change.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its content is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle.
- **Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`**: that file is not present in the current tree (the reference comes from the Objective text); reconciliation is deferred until the file or the D3 issue's content is available.
- **Dropping the legacy `error` key** from the worker's failure payload: deferred pending a consumer audit confirming rag-api's status subscriber is the only reader of the status topic; dropping it afterward is trivial cleanup.
- **Widening `classify_error`** to recognize currently-unclassified-but-actually-transient error types: out of scope; the conservative permanent classification and manual reprocess path remain.
- **Structured error-code taxonomy** (`error_code` values beyond the `"UNKNOWN"` default): explicitly not this fix.
- **Exhaustive per-step stage-tracker test coverage**: the contract test pins the mechanism on representative early/late stages only; hardening beyond that (e.g., enumerating every pipeline step) is deferred to avoid ossifying the pipeline.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>