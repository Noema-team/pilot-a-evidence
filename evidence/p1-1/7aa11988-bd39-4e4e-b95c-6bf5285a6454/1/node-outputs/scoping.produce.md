Investigation complete. The authoritative Definition's claims were corroborated against the tree where readable: `classify_error()` in `apps/ai-server/rag-worker-service/main.py` (transient/permanent classes, httpx and status-code heuristics, conservative permanent default for unknown exceptions), the fixture/AST contract-test patterns in `apps/ai-server/tests/integration/test_api_contracts.py`, the `Resource` model file, and the confirmed absence of `plans/upload-flow.md`. Producing the contracted charter now.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
**Cycle charter — rag-worker → rag-api failure payload contract alignment**
Run 7aa11988-bd39-4e4e-b95c-6bf5285a6454 · Iteration 1 · Step scoping.produce
Authoritative source: WorkItem wi-define-108-a8, artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5` — binding; this charter does not widen, narrow, or reinterpret it.

## Scope

Align the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

Concrete work items:

1. **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler publishing via `_publish_status_update`): replace the one-key payload `{"error": str(e)}` with a payload carrying
   - `error_message` — the actual exception message;
   - `stage` — the pipeline stage executing at failure time;
   - `retryable` — deliberately derived from `classify_error(e)`: transient-classified → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`;
   - the legacy `error` key retained alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic.

2. **Stage tracking** (same file): a stage-tracker local in `process_document`, set immediately before each pipeline step and reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.

3. **rag-api failed branch** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update`): persists worker-provided values unchanged — main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage, with `error_code` remaining "UNKNOWN" unless a code is actually sent. No reader or schema changes on this side; it is pinned by test, not rewritten.

4. **Contract test** (`apps/ai-server/tests/integration/test_api_contracts.py` or a sibling following its fixture- and AST-based patterns): imports both sides rather than restating the contract in a fixture — builds the failure payload through the worker's code path, feeds it through rag-api's failed-branch persistence against the Firestore emulator or fakes (both services have `FIRESTORE_EMULATOR_HOST` hermetic branches), and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. Includes a key-set drift guard so a future edit to either side's keys fails the build. Covers representative stages: an early-stage failure and a late-stage failure.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts and nothing tests the seam. Because of the key mismatch, every worker-originated failure currently lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — users and support cannot disambiguate failures, and retryability is silently defaulted rather than derived. The persisted `error`/`error_stage`/`retryable` schema is already established across three other write paths (the worker's stale-lease sweep `_fail_if_still_stale`, rag-api's `/process` and `POST /resources` enqueue-failure paths) and exposed by `ResourceResponse` and the `Resource` model — the worker's status publisher is the only writer that does not speak it. This cycle fixes the odd one out: the worker aligns to the API, requiring no Firestore migration, field rename, backfill, or reader changes.

Deliberate behavior change to surface for review: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent under `classify_error`; after this cycle they persist `retryable: false`, aligning the persisted record with the worker's actual ACK/NACK behavior (permanent errors are acked and not redelivered; manual reprocess via `POST /process` remains available). The stale-lease sweep's separate `retryable: true` write stays correct: a dead worker is a transient condition by nature.

## Requirements

From the authoritative Definition (binding):

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → retryable true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → retryable false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Constraints honored: the worker is aligned to rag-api's existing contract, not the reverse (must); no Firestore migration, field rename, or backfill of existing documents — persisted fields keep their names and semantics (must_not); every worker-originated failure payload carries `retryable` explicitly, so the API-side `details.get("retryable", True)` fallback is never the operative mechanism for worker failures (must); the legacy `error` key is retained (prefer); no structured error-code taxonomy is introduced (prefer_not).

## Boundaries

Non-goals, per the Definition:

- **Stale-lease sweep unchanged** — `_fail_if_still_stale`'s direct failure write already persists `error`/`error_stage`/`retryable` consistently with this contract.
- **No retry/backoff mechanics changes** — Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals are untouched; only the *reporting* of retryability in the payload changes. Widening `classify_error`'s heuristics is likewise out of scope.
- **No frontend or mobile changes** — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **No structured error codes or failure taxonomy** — the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.
- **No rag-api reader or persisted-schema changes** — no migration, rename, or backfill; the API side is only pinned by the contract test.
- **Companion D3 issue** — anything it covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context).

Accepted risks, for reviewer awareness: unknown consumers of the status topic reading the old key set (mitigated by retaining `error`; residual risk accepted as low); stage-tracker drift as the pipeline evolves (mitigated by the set-the-tracker-immediately-before-the-await convention and representative-stage test coverage — the test pins the mechanism without ossifying every step); `retryable: false` for genuinely transient-but-unrecognized failures (accepted; manual reprocess via `POST /process` remains); the contract test ossifying the payload keys (intentional — that is the drift guard doing its job; adding a key later means touching the test).

## Version bump

None. No version-bearing manifest was verified in the affected services during investigation (`rag-worker-service` and `rag-api-service` carry `requirements.txt`, `Dockerfile`, and `pytest.ini` but no verified version file), and the change is internal service behavior plus tests with no consumer-facing API shape change (`ResourceResponse` fields are untouched). If the repository's release process requires a bump for service-image changes, that requirement is unknown from verified evidence and should be raised at review rather than guessed here.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred (Definition fact F12, status DEFERRED).
- **`plans/upload-flow.md` deviation D4 reconciliation**: that file is not present in the current tree (verified: `plans/` contains README.md, ROADMAP.md, and other feature plans, but no upload-flow.md); the reference comes from the Objective text. Deferred until the file exists or the reference is re-anchored.
- **Dropping the legacy `error` key** from the worker's failure payload: deferred pending a consumer audit of the status topic; trivial cleanup if the worker is confirmed the only publisher and rag-api the only consumer.
- **Structured error-code taxonomy**: deferred (prefer_not this cycle); `error.code` stays "UNKNOWN".
- **Widening `classify_error`** to recognize more transient conditions (reducing `retryable: false` for unrecognized-but-transient failures): deferred; out of scope this cycle.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>