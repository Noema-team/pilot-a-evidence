Investigation is complete; the charter below is grounded entirely in the verified repository evidence (worker failure publisher, `classify_error`, rag-api's `run_transactional_update` failed branch, `Resource` model, contract-test infrastructure, emulator branches) and the authoritative Definition.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle fixes one seam: the rag-worker's failure status payload vs. rag-api's failed-branch consumer. In scope:

1. **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler). Today it publishes `{"error": str(e)}` and nothing else. It must publish:
   - `error_message` — the actual exception message (`str(e)`);
   - `stage` — the pipeline stage executing at failure time;
   - `retryable` — deliberately derived from the worker's own `classify_error(e)`: transient-classified → `true`, permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`;
   - the legacy `error` key retained alongside `error_message` as a compatibility hedge for unverified consumers of the status topic.
2. **Stage tracking in `process_document`**. The pipeline is one try block, so at failure time nothing knows where it was. Add a stage tracker set immediately before each pipeline step (convention: set the tracker immediately before the `await`), reusing the existing progress-stage vocabulary — `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` — with `"processing"` as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null).
3. **rag-api side unchanged** (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch). The worker aligns to the API, not the reverse. The failed branch already reads `details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)` and persists `error`/`error_stage`/`retryable` on the main document plus a `processing/summary` error subdocument `{code, message, stage}` — these reads and the persisted schema stay exactly as they are. The API-side fallbacks remain for non-worker writers but must never be the operative mechanism for worker failures.
4. **Contract test** in/alongside `apps/ai-server/tests/integration/test_api_contracts.py`, following its existing fixture- and AST-based patterns. It must import both sides rather than restate the contract in a fixture: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` (Firestore emulator or fakes — both services have `FIRESTORE_EMULATOR_HOST` branches supporting hermetic runs), and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. Include a key-set drift guard so a future edit to either side's payload keys fails the build.

Verified evidence anchors from this cycle's investigation: the worker's failure publish `{"error": str(e)}` in `process_document`'s exception handler; rag-api's failed-branch reads and persistence exactly as above; `classify_error` returns True for `TransientError`, httpx connect/timeout errors, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError`, and HTTP 429/500/502/503/504, and False otherwise including unknown exceptions; `_fail_if_still_stale` already writes `error`/`error_stage: "processing"`/`retryable: True`; the `Resource` model (`models/resource.py`) exposes `error`/`error_stage`/`retryable` with `retryable` defaulting `True`.

## Purpose

Every worker-originated failure currently lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — because the worker publishes `{"error": ...}` while rag-api reads `error_message`/`stage`/`retryable`. Users and support cannot disambiguate failures, and retryability is silently defaulted instead of derived. The persisted `error`/`error_stage`/`retryable` schema is already consistent across three other write paths (the worker's stale-lease sweep, rag-api's `/process` and `POST /resources` enqueue-failure paths) and both response models — the worker's status publisher is the only writer that doesn't speak it. Fixing the odd one out requires no migration, no backfill, and no reader changes, and the contract test locks the seam so this class of drift fails the build instead of shipping again.

## Requirements

Binding requirements (from the authoritative Definition):

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Acceptance (cycle done when):

- A failed job's published status message contains `error_message`, `stage`, and `retryable`, none relying on rag-api's fallback defaults.
- After a failed job, the persisted resource document has `error` = the worker's actual message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- The `processing/summary` error subdocument carries the same message and stage as the main document.
- The contract test exists and passes, exercising worker payload construction through rag-api failed-branch persistence with the key-drift guard.

## Boundaries

Must / must-not constraints:

- The worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed.
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- Prefer retaining the legacy `error` key alongside `error_message` (continuity for status-topic consumers and log tooling). Prefer not to introduce a structured error-code taxonomy (`error_code` values); the summary `error.code` stays "UNKNOWN" unless a code is actually sent.

Out of scope (non-goals):

- The stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract, including its separate `retryable: true` (a dead worker is a transient condition by nature).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Structured error codes or a failure taxonomy.
- Anything the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context).

Accepted deliberate behavior change: unclassified-unknown exceptions currently persist `retryable: true` via the silent default but classify as permanent under `classify_error`, so they will now persist `retryable: false`. This is the conservatism `classify_error` was written for; manual reprocess via `POST /process` is unaffected.

Known drift risk: a future pipeline step added without updating the stage tracker reports a stale stage. Mitigated by the "set the tracker immediately before the await" convention and representative-stage contract coverage (an early-stage failure and a late-stage failure), which catches the tracker being removed or bypassed without ossifying every step.

## Version bump

Patch-level behavior fix; no version file changes are required by this scope. No versioning scheme for these two services was verified during investigation (rag-api's FastAPI app metadata hardcodes `version="1.0.0"` and is not consumed as a contract; no version file was verified for rag-worker), so no bump target beyond patch-level can be asserted. Do not modify the FastAPI metadata version as part of this fix.

## Deferred items

- The companion D3 issue referenced by the Objective — its content is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text.
- Dropping the legacy `error` key from the worker's failure payload — only after an audit confirms the worker is the sole publisher and rag-api the sole consumer of the status topic.
- A structured error-code taxonomy / failure taxonomy.
- Widening `classify_error`'s heuristics (e.g., recognizing additional transient conditions) — out of scope; `retryable: false` for unrecognized errors is accepted, and manual reprocess remains available.
- Auditing other potential consumers of the status topic beyond rag-api's verified subscriber.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>