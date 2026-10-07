<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle aligns the rag-worker's failure reporting to rag-api's existing failed-branch contract and locks the worker→rag-api failure seam with a contract test. Five work items:

1. **Worker failure payload** — `apps/ai-server/rag-worker-service/main.py`, the `process_document` exception handler (published via `_publish_status_update`): the failed status payload must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for potential consumers of the status topic other than rag-api's verified subscriber.
2. **Stage tracking in `process_document`** — a local stage tracker set immediately before each pipeline step and reported by the failure handler. Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`; `"processing"` is the safe value when the stage is genuinely unknown (the field must never regress to null).
3. **retryable derivation** — the worker sets `retryable` from the existing `classify_error(e)` (verified in the worker source: `TransientError`/`PermanentError` types plus httpx/connection/timeout and HTTP-status heuristics; unknown exceptions classify as permanent): transient-classified → `true`; permanent-classified, including unclassified-unknown, → `false`. Accepted, deliberate behavior change: unclassified-unknown failures flip from the silently-defaulted `true` to `false`; manual reprocess via `POST /process` is unaffected.
4. **rag-api failed branch** — `apps/ai-server/rag-api-service/main.py` (`run_transactional_update`): no code change is expected or permitted. This cycle pins its existing behavior: persist main-document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`, and write the same message and stage into the processing/summary error subdocument (`error_code` remains "UNKNOWN" unless a code is actually sent).
5. **Contract test** — new test(s) in `apps/ai-server/tests/integration/`, following the verified fixture/AST-based pattern of `test_api_contracts.py`: build the failure payload through the worker's code path, feed it through rag-api's failed-branch persistence (Firestore emulator or fakes), assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and include a key-set drift guard on both sides so a future key edit on either service fails the build. Cover representative stages: an early-stage failure and a late-stage failure.

## Purpose

Every worker-originated failure currently persists the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`: the worker publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch reads `error_message`/`stage`/`retryable`. Users and support cannot disambiguate failures, and the persisted record misstates retry behavior. The worker is the only writer that does not speak the established `error`/`error_stage`/`retryable` schema — the stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource` model/`ResourceResponse` already use it — so aligning the worker fixes the seam with no Firestore migration, rename, backfill, or reader changes. The repo's contract-test suite has already proven effective against exactly this class of bug (per `docs/TESTING-STRATEGY.md`, API contract tests caught 12 real client↔backend mismatches); this cycle extends that guard to the worker→rag-api failure path.

## Requirements

- **R1 — Failure payload.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the stage executing at failure time), and `retryable` (deliberately derived) — it must never rely on rag-api's fallback defaults for these keys. The legacy `error` key is retained alongside `error_message`.
- **R2 — Stage tracking.** `process_document` must track the currently executing pipeline stage so the failure handler reports the true failing stage; stage names reuse the existing progress-stage vocabulary, with `"processing"` as the safe value when the stage is genuinely unknown.
- **R3 — rag-api persistence.** The failed branch must persist worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage. After a failed job, persisted `error` must be the worker's actual message (not "Processing failed"), `error_stage` the failing stage (not None), and `retryable` the worker's derived value.
- **R4 — retryable derivation.** Explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `true`; classified permanent (including unclassified-unknown, per its conservative default) → `false`.
- **R5 — Contract test.** A test must cover the worker failure → rag-api persistence path (via the Firestore emulator or fakes), exercise the worker's failure-payload construction through rag-api's failed-branch persistence, assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and fail if either side's payload keys drift.

Binding constraints:

- The worker is aligned to rag-api's existing contract; rag-api's reads and persisted schema are not changed.
- No Firestore migration, field rename, or backfill of existing documents; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- Prefer retaining the legacy `error` key; prefer not to introduce a structured error-code taxonomy.

## Boundaries

Out of scope — this cycle must not touch:

- The stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract, including its separate `retryable=true` write (a dead worker is a transient condition).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Any rag-api code change: reads, persisted schema, response models, or enqueue-failure paths.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Structured error codes or a failure taxonomy — the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.
- Widening `classify_error`'s heuristics (e.g., for unrecognized-but-transient failure modes).
- Any Firestore migration, field rename, or backfill.
- Any scope belonging to the companion D3 issue (see Deferred items).

## Version bump

None required. The change alters runtime payload construction and adds a test; the persisted schema, client-facing models, and API contract are unchanged, and no migration or backfill is involved. Verified: neither service directory contains a version manifest (listings show Dockerfile, requirements.txt, .python-version, pytest.ini; no VERSION/pyproject/package.json). Whether CI tags image versions was not verified in this cycle's read scope; if the release process nonetheless requires a bump, patch-level is the ceiling.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its content is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling with the original D4 deviation note** in `plans/upload-flow.md`: that file is not present in the current tree per the Definition; this cycle's reads confirmed `docs/documentation/plans/` contains no such file (a `docs/superpowers/plans/` hub exists but was outside read scope — its contents unknown).
- **Dropping the legacy `error` key** from the worker's failure payload, after an audit confirms the worker is the only publisher and rag-api the only consumer of the status topic.
- **Extending contract coverage** to the stale-lease sweep and rag-api's enqueue-failure paths (both already conform; not required this cycle).
- **Widening `classify_error`** to recognize more transient failure modes, reducing the retryable=false blast radius for unrecognized-but-transient errors.
- **Frontend retry affordances** reacting to `retryable=false` (e.g., suppressing auto-retry UI) — deferred to frontend work.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>