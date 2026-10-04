<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle changes two things and nothing else:

**1. Worker failure payload + stage tracking — `apps/ai-server/rag-worker-service/main.py`**

- The `process_document` exception handler (which publishes failed status via `_publish_status_update`) must publish a payload carrying:
  - `error_message` — the actual exception message (`str(e)`);
  - `stage` — the pipeline stage executing at failure time;
  - `retryable` — deliberately derived from `classify_error(e)`: transient-classified → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`;
  - the legacy `error` key retained alongside `error_message` (compatibility hedge for unverified consumers of the status topic).
- Stage tracking through `process_document`: a tracker set immediately before each pipeline step and reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.

**2. Contract test — new module under `apps/ai-server/tests/integration/`** (suggested name `test_worker_failure_contract.py`)

- Builds the worker's failure payload through the worker's own code path (not a restated fixture), feeds it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes, and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
- Covers a transient-classified failure (`retryable` true) and a permanent-classified failure (`retryable` false), plus representative early-stage and late-stage failures for stage tracking.
- Includes a key-set drift guard over both sides' failure-path code (fixture/AST patterns per the existing `tests/integration/test_api_contracts.py`) so a key change on either side fails the build instead of silently re-creating this bug.

**Explicitly unchanged:** `apps/ai-server/rag-api-service/main.py` — its failed branch is the contract anchor; its reads and persisted schema stay exactly as they are. Also unchanged: `rag-api-service/models/resource.py`, the stale-lease sweep, rag-api's enqueue-failure paths, retry/ACK/NACK mechanics, and all client-facing models.

## Purpose

The worker→rag-api failure seam was written against different contracts and nothing tests it. The worker's exception handler publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable`. Every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`; the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures.

The fix direction is worker-side alignment because the persisted failure schema is already consistent everywhere else: the stale-lease sweep and rag-api's enqueue-failure paths write `error`/`error_stage`/`retryable` directly, and `ResourceResponse` plus the `Resource` model expose them (`retryable` defaults True). The worker's status publisher is the only writer that doesn't speak the schema; fix the odd one out. This was directly corroborated this cycle in `rag-api-service/main.py` (failed branch reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`; `FIRESTORE_EMULATOR_HOST` hermetic init exists) and `rag-api-service/models/resource.py` (`error`/`error_stage`/`retryable: bool = True`). Aligning the worker requires no migration, no field rename, no backfill, and no reader changes.

One deliberate behavior change is accepted: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent, so they will now persist `false`. That is the conservatism `classify_error` was written for; it aligns the persisted record with the worker's actual ACK/NACK behavior (transient = Pub/Sub will redeliver; permanent = acked, manual reprocess via `POST /process` remains). The stale-lease sweep's separate `retryable=true` write stays correct: a dead worker is a transient condition by nature.

## Requirements

Binding requirements, restated from the authoritative Definition:

- **R1 — Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys.
- **R2 — Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- **R3 — API persistence unchanged and pinned.** rag-api's failed branch must persist worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument carries the same message and stage (`error_code` stays "UNKNOWN" unless a code is actually sent). rag-api's existing failed branch already implements exactly this mapping (verified); this cycle changes no rag-api code — the contract test pins the behavior.
- **R4 — Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per its conservative default) → `retryable` false.
- **R5 — Contract test.** A contract test must cover the worker failure → rag-api persistence path: exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must fail if either side's payload keys drift.

Acceptance criteria to be met by cycle end (all currently `met: false` in the Definition):

- A failed job's published status message contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument carries the same message and stage as the main document.
- The contract test exists and passes, exercising worker payload construction through rag-api failed-branch persistence with the drift assertions above.

House test conventions to follow: assert the real code's contract without mocking the method under test (pattern of `rag-api-service/tests/unit/test_service_contracts.py`), and use the fixture/AST static-contract patterns of `tests/integration/test_api_contracts.py` for the drift guard.

## Boundaries

Constraints (from the Definition):

- **Must:** align the worker to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- **Must not:** require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must:** every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer:** retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **Prefer not:** introduce a structured error-code taxonomy (`error_code` values) in this fix.

Non-goals (out of scope):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains "UNKNOWN" unless a code is actually sent.
- Widening `classify_error`'s heuristics — the retryable=false-for-unclassified tradeoff is accepted this cycle; manual reprocess remains.
- Any scope the companion D3 issue covers beyond the worker→rag-api failure payload alignment.

Known residual risks accepted: unknown consumers of the status topic reading the old key set (mitigated by retaining `error`; residual risk low); stage-tracker drift as the pipeline evolves (mitigated by the set-the-tracker-immediately-before-the-await convention and representative-stage test coverage); reduced auto-retry affordances for genuinely transient-but-unrecognized failures (manual reprocess via `POST /process` remains).

## Version bump

Patch-level. This is a behavior fix in the worker's failure reporting plus a new test — no schema change, no migration, no client-facing model change (`ResourceResponse` untouched), no new runtime dependencies.

- `rag-worker-service`: patch bump (failure payload keys, stage tracking, retryable derivation).
- `rag-api-service`: no bump — its code is unchanged by design; the contract test only pins existing behavior.
- Caveat recorded honestly: no version manifest (CHANGELOG, package version, or per-service version field) was verified for either service during scoping. If the repo's convention carries no per-service version identifiers, no version-file change is required beyond the code change itself; if it does, apply the patch bump per that convention.

## Deferred items

- **Companion D3 issue (F12, DEFERRED).** The Objective references a companion D3 issue filed alongside this one; its content is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle.
- **Reconciling with `plans/upload-flow.md` deviation D4.** The reference comes from the Objective text only; that file is not present in the current tree (verified by directory listing of `plans/`), so no reconciliation is possible this cycle.
- **Dropping the legacy `error` duplicate key.** Trivial cleanup once an audit confirms the worker is the only publisher and rag-api the only consumer of the status topic.
- **Widening `classify_error`.** If unclassified-transient failures prove common in practice, widening the heuristics is a separate, explicitly scoped change.
- **Structured error-code taxonomy.** `summary.error.code` stays "UNKNOWN" unless a code is actually sent; any taxonomy is a future decision.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>