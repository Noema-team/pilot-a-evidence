<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle aligns the rag-worker's failed-status payload to rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path. The worker is the only writer that does not speak the established `error`/`error_stage`/`retryable` persisted schema; this cycle fixes the worker, not the API.

Deliverables (all code changes land on the worker side plus shared test infrastructure; rag-api service code is unchanged):

- **Worker failure payload** — `apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler: the failed status published via `_publish_status_update` carries `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
- **Stage tracking** — same file, `process_document`: a local stage tracker set immediately before each pipeline step (convention: set the tracker immediately before the await) so the exception handler reports the true failing stage. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- **retryable derivation** — the worker sets `retryable` from `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (per `classify_error`'s conservative default), → `false`.
- **Contract test** — a new test in `apps/ai-server/tests/integration/` following the house pattern in `test_api_contracts.py`: it builds the failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes, asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and includes a key-set drift guard so a future edit to either side's payload keys fails the build.

Evidence basis: verified directly this cycle — the `Resource` model persists `error`/`error_stage`/`retryable` (retryable defaults `True`) in `apps/ai-server/rag-api-service/models/resource.py`; `classify_error()` with `TransientError`/`PermanentError`, transient type/status-code heuristics, and a conservative permanent default for unknown exceptions exists in `apps/ai-server/rag-worker-service/main.py`; `_publish_status_update` publishes JSON over Pub/Sub and heartbeats processing leases; fixture- and AST-based contract-test infrastructure exists at `apps/ai-server/tests/integration/test_api_contracts.py` with its own `conftest.py`; the worker test suite has hermetic stubbing (`tests/conftest.py`) and `pytest.ini` with `asyncio_mode = auto`; `docker-compose.yml` pins service image tags (e.g. `student-rag-api-service:0.1.0`). Taken on the authority of the pinned Definition (binding, not independently re-read): the current one-key failure payload `{"error": str(e)}`, rag-api's failed-branch read keys (`error_message`/`stage`/`retryable`) and fallback persistence, the progress-stage strings, and the stale-lease sweep / enqueue-failure write shapes.

## Purpose

Every worker-originated failure currently lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`, because the worker publishes `{"error": str(e)}` while rag-api's failed branch reads `error_message`/`stage`/`retryable`. The `processing`/`summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures, and the persisted retryable flag does not reflect the worker's actual ACK/NACK behavior.

The fix direction is deliberate: align the worker to rag-api's existing contract rather than changing rag-api, because `error`/`error_stage`/`retryable` is already the established persisted schema across the worker's stale-lease sweep, rag-api's enqueue-failure paths, and both the `Resource` model and `ResourceResponse`. Changing the API side would ripple; the worker is the odd one out. No migration, no backfill, no reader changes.

The outcome this cycle buys: a failed job's persisted record tells the truth — what failed (actual message), where it failed (pipeline stage consistent with the progress timeline clients already see), and whether Pub/Sub will redeliver it (retryable mirrors the worker's ACK/NACK classification) — and a contract test pins the seam so neither side's payload keys can drift silently again.

## Requirements

- **R1 — Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
- **R2 — Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- **R3 — API persistence passthrough (pinned invariant).** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage. No API code change is expected — the current behavior already satisfies this; the contract test pins it.
- **R4 — Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior in `run_worker`: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
- **R5 — Contract test.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift. Coverage should pin the stage-tracker mechanism on representative stages (an early-stage failure and a late-stage failure) without ossifying every pipeline step.

Acceptance criteria (all must hold at cycle close):

- A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The processing/summary error subdocument for the failed job carries the same message and stage as the main document.
- The contract test covering the worker failure → rag-api persistence path exists and passes, failing on payload-key drift on either side.

## Boundaries

Binding constraints:

- **Must:** the worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- **Must not:** no Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must:** every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer:** retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **Prefer not:** do not introduce a structured error-code taxonomy (`error_code` values) in this fix; the summary `error.code` remains "UNKNOWN" unless a code is actually sent.

Non-goals (explicitly out of scope):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy.
- Any rag-api service code change (the contract test imports its `main` module but does not modify it).

Accepted tradeoffs (deliberate, documented):

- Unclassified-unknown exceptions will now persist `retryable: false` instead of the silent default `true`. This matches `classify_error`'s conservatism (prevents infinite retry loops); manual reprocess via `POST /process` remains available. Widening `classify_error` is out of scope.
- Stage-tracker drift risk (a future pipeline step added without updating the tracker reports a stale stage) — mitigated by the update-before-await convention and representative-stage test coverage.
- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job.

## Version bump

- **rag-worker-service:** patch-level bump of its Docker image tag in `apps/ai-server/docker-compose.yml`. The change is a behavioral fix (new failure-payload fields plus the deliberate `retryable=false` behavior for unclassified errors) with no schema, public API, or configuration-surface change, which warrants a patch bump under the image-tag versioning pattern verified in that file.
- **rag-api-service:** no version bump — no runtime code change; the shared contract test imports its `main` module read-only.
- **Unknown (flagged):** the rag-worker-service's current image tag value in `docker-compose.yml` was not read during this cycle's investigation (only `student-rag-api-service:0.1.0` was confirmed for rag-api). The implementer should bump whatever tag is current for the worker, following the same pattern; if no worker image tag exists in `docker-compose.yml`, no bump surface exists and this section resolves to "no versioned artifact changes beyond the source commit".

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context. Anything it covers beyond this worker→rag-api failure payload alignment is deferred (Definition fact F12).
- **Reconciliation with deviation D4 in `plans/upload-flow.md`:** that file is not present in the current tree; the reference exists only in the Objective text. Deferred until the file or the companion issue is available.
- **Dropping the legacy `error` key** from the worker's failure payload: deferred until a consumer audit confirms rag-api's status subscriber is the only consumer of the status topic. Trivial cleanup afterward.
- **Widening `classify_error`** to recognize more transient failure modes (genuinely transient-but-unrecognized errors currently map to permanent/`retryable: false`): future hardening, out of scope this cycle.
- **Structured error-code taxonomy / failure taxonomy:** explicitly not in this fix (prefer-not constraint); revisitable in a future cycle if disambiguation beyond message/stage is ever needed.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>