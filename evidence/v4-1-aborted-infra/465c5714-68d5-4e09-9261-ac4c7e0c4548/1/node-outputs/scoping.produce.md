<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle aligns the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag. The work items:

**1. Worker failure payload** — `apps/ai-server/rag-worker-service/main.py`, the `process_document` exception handler's status publish. On failure the worker publishes `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived — see item 3). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic.

**2. Stage tracking** — `process_document` gains a stage tracker, set immediately before each pipeline step (convention: set the tracker immediately before the await). Stage names reuse the existing progress-update vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`. When the stage is genuinely unknown (e.g. failure before the first transition), the payload reports `"processing"` — the same safe value the stale-lease sweep uses for `error_stage` — so the persisted field never regresses to null.

**3. retryable derivation** — the worker sets `retryable` from the existing `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (which `classify_error` conservatively treats as permanent to avoid infinite retry loops), → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker` (transient = Pub/Sub redelivers; permanent = acked, manual reprocess via `POST /process` remains). This is a deliberate behavior change for unclassified-unknown failures: they previously persisted the silent default `true` and will now persist `false`.

**4. rag-api failed branch** — no behavioral change. It already reads `error_message`, `stage`, and `retryable` from the status payload and persists `error`, `error_stage`, and `retryable` on the main resource document, writing message/stage (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary subdocument. This cycle verifies that worker-provided values persist unchanged and pins that with a test. If the test exposes drift, the fix is made on the worker side; rag-api's reads and persisted schema are not edited in this cycle.

**5. Contract test** — a new test under `apps/ai-server/tests/integration/`, following the house pattern in `test_api_contracts.py`. It must import both sides rather than restate the contract in a fixture: build the failure payload through the worker's code path, feed it through rag-api's failed-branch persistence (`run_transactional_update`) against the Firestore emulator or fakes, and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It includes a key-set drift guard so a future edit to either side's payload keys fails the build. Coverage pins the stage-tracker mechanism on representative stages — an early-stage failure and a late-stage failure — without ossifying every pipeline step. The existing integration `conftest.py` already mocks the Google Cloud SDK surface (firebase_admin, google.cloud.*, structlog) and puts rag-api-service on `sys.path`; extending that setup to import the worker's payload-construction code is in scope.

Expected touched files: `apps/ai-server/rag-worker-service/main.py` (payload, stage tracker, derivation) and the contract test (plus conftest support) under `apps/ai-server/tests/integration/`. rag-api-service source is expected to be unchanged.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker's exception handler publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error`/`error_stage`/`retryable`. Every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null stage, and a fabricated `retryable: true`; the processing/summary error subdocument inherits the same fallbacks, with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures, and retryability is silently defaulted instead of derived.

The persisted failure schema is already established everywhere else: the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths (`/process`, `POST /resources`), and the `Resource` model / `ResourceResponse` (which exposes `error` and `error_stage`, with `retryable` defaulting true) all use `error`/`error_stage`/`retryable`. The worker's status publisher is the only writer that doesn't speak it. This cycle fixes the odd one out: the worker aligns to the API's existing contract — no migration, no field rename, no backfill, no reader changes — and a contract test locks the seam so the two sides cannot silently drift again.

## Requirements

**R1 — Failure payload completeness.** When document processing fails, the worker's failed status payload includes `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload never relies on rag-api's fallback defaults for these keys.

**R2 — Stage tracking.** The worker tracks the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.

**R3 — Persistence fidelity.** rag-api's failed branch persists the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage.

**R4 — Explicit retryable derivation.** The derivation is explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent, including unclassified-unknown (per `classify_error`'s conservative default), → `retryable: false`.

**R5 — Contract test.** A contract test covers the worker failure → rag-api persistence path: it exercises the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it fails if either side's payload keys drift.

**Binding constraints:**
- The worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema. (must)
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. (must not)
- Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. (must)
- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling. (prefer)
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. (prefer not)

**Done when (acceptance):**
- A failed job's status message published by the worker contains `error_message`, `stage`, and `retryable` — none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The processing/summary error subdocument for the failed job carries the same message and stage as the main document.
- The contract test exists and passes: it exercises worker payload construction through rag-api's failed-branch persistence, asserts the three persisted values equal the worker's values, and fails on key drift on either side.

## Boundaries

**Out of scope:**
- The stale-lease sweep (`_fail_if_still_stale` / `_stale_lease_sweep_loop`) is unchanged — it already persists `error`/`error_stage`/`retryable` consistently with this contract, and its `retryable: true` write stays correct because a dead worker is a transient condition.
- Retry/backoff mechanics are unchanged: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals. Only the *reporting* of retryability in the payload changes. Widening `classify_error`'s heuristics is out of scope.
- No frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- No structured error codes or failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- rag-api's reads and persisted schema are not modified.

**Accepted tradeoffs (explicit, per the Definition):**
- Unclassified-unknown failures will persist `retryable: false` where the silent default previously produced `true`. This matches `classify_error`'s conservatism and the worker's ack-without-redelivery behavior; manual reprocess via `POST /process` is unaffected.
- Unknown consumers of the status topic reading the old key set are hedged by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves is mitigated by the set-immediately-before-the-await convention and representative-stage test coverage, not eliminated.
- The contract test intentionally ossifies the payload key set — that is the drift guard doing its job; adding a key later means touching the test.

## Version bump

None. This cycle changes failure reporting and adds a test; it requires no Firestore migration, field rename, backfill, or client-facing API shape change (`ResourceResponse` is untouched), so no version bump is warranted. Per the repo branch model (AGENTS.md), the change fits the small-change path — a single `fix/<slug>` branch and PR targeting `main` — consistent with the verified small-change criteria (no schema/migration changes, no cross-client contract changes, no security behavior); the branch decision is confirmed at implementation time. No version manifest was verified in the investigated files, so no version file edit is proposed; if the team's release process requires a bump for service images, patch-level is the ceiling. Validation before review: `./dev/run ai-server` and the integration suite, per the repo workflow.

## Deferred items

- **Companion D3 issue.** The Objective references a companion D3 issue filed alongside this one; its content is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **`plans/upload-flow.md` D4 reconciliation.** The Objective names that file as the location of the original deviation analysis; the file is not present in the current tree, so reconciling this charter with that note is deferred until the file's fate is established.
- **Dropping the legacy `error` key.** Deferred cleanup, conditional on a future audit confirming rag-api's status subscriber is the only consumer of the worker's status topic. Trivial once confirmed.
- **Widening `classify_error`.** Recognizing additional transient conditions (so fewer failures land `retryable: false`) is out of scope this cycle; the accepted tradeoff above covers it.
- **Structured error-code taxonomy / failure taxonomy.** Deferred (prefer-not this cycle; `error_code` stays `"UNKNOWN"` unless a code is actually sent).
- **Frontend/mobile surfacing beyond existing fields.** Not needed for this contract; `ResourceResponse` already exposes `error`/`error_stage`. Deferred unless consumers request more.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>