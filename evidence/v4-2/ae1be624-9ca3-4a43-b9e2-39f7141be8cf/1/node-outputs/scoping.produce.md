<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

- Run: `ae1be624-9ca3-4a43-b9e2-39f7141be8cf` · Iteration 1 · Step: `scoping.produce`
- Intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
- Authority: define-work WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This charter restates that Definition's bounded scope; it does not widen, narrow, or reinterpret it.

## Scope

**Worker side — `apps/ai-server/rag-worker-service/main.py` (only production code expected to change):**

1. **Failure payload construction** in `process_document`'s exception handler: the failed status published via `_publish_status_update` must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unverified consumers of the status topic.
2. **Stage tracking** through `process_document`: a local tracker set immediately before each pipeline step (the "update-before-await" convention), reported by the failure handler. Stage names reuse the existing progress-update vocabulary — `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` — with `"processing"` as the safe value when the stage is genuinely unknown (same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null).
3. **Retryable derivation** from `classify_error(e)`, the same classification that drives ACK/NACK in `run_worker`: transient-classified → `retryable: true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`. This is a deliberate behavior change for unclassified-unknown errors (previously the silent API-side default persisted `true`); it aligns the persisted record with actual Pub/Sub redelivery behavior.

**Test side — `apps/ai-server/tests/integration/`:**

4. **A worker→rag-api failure-path contract test**, following the existing fixture/AST-based pattern in `test_api_contracts.py`: it must import both sides rather than restate the contract in a fixture — build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes, and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must include a key-set drift guard on both sides so a future edit to either side's payload keys fails the build. Coverage pins the mechanism on representative stages (one early-stage failure, one late-stage failure) — enough to catch the tracker being removed or bypassed without ossifying every pipeline step.

## Purpose

A failed RAG processing job currently persists garbage: the worker's exception handler publishes a one-key payload (`{"error": str(e)}`) while rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true` — and the `processing`/`summary` error subdocuments inherit the same fallbacks with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures, and the persisted retryability flag lies about what Pub/Sub will actually do.

The fix direction is deliberate: the persisted `error`/`error_stage`/`retryable` schema is already spoken consistently by three other write paths (the worker's stale-lease sweep, rag-api's `/process` and `POST /resources` enqueue-failure paths) and exposed by `ResourceResponse` and the `Resource` model. The worker's status publisher is the only writer that doesn't speak it — so the worker aligns to the API, not the other way around. No migration, no backfill, no reader changes. The contract test locks the seam so this drift cannot silently recur.

## Requirements

1. The worker's failed status payload must include `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — never relying on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names reuse the existing progress-stage vocabulary, with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing`/`summary` error subdocument carries the same message and stage. (Expected to hold with no rag-api production change; the contract test verifies this invariant.)
4. The retryable derivation must be explicit and aligned with ACK/NACK behavior: `classify_error` transient → `true`; permanent (including unclassified-unknown) → `false`.
5. A contract test must cover the worker failure → rag-api persistence path (via Firestore emulator or fakes), asserting persisted `error`, `error_stage`, and `retryable` equal the worker's values, and failing if either side's payload keys drift.

Acceptance bar (from the Definition, all currently unmet): worker payload carries all three keys; persisted document shows the real message, real stage, and derived retryable; the error subdocument matches the main document; the contract test exists and passes.

## Boundaries

**Constraints (binding):**
- **Must:** the worker aligns to rag-api's existing contract; rag-api's reads and persisted schema are not changed.
- **Must not:** no Firestore migration, field rename, or backfill of existing documents; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must:** every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer:** retain the legacy `error` key in the worker's failure payload alongside `error_message`.
- **Prefer not:** no structured error-code taxonomy (`error_code` values) in this fix.

**Non-goals (out of scope):**
- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (its `retryable: true` stays correct: a dead worker is a transient condition).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing`/`summary` error `code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this payload alignment (its content is unavailable in this context; see Deferred items).

**Known risks accepted by this charter:** unknown consumers of the status topic reading the old key set (mitigated by retaining `error`; residual risk low); stage-tracker drift as the pipeline evolves (mitigated by the update-before-await convention and representative-stage test coverage); `retryable: false` for genuinely-transient-but-unrecognized failures (accepted; widening `classify_error` is out of scope and manual reprocess via `POST /process` remains); the contract test ossifying the payload (intentional — that is the drift guard working).

## Version bump

- **`rag-worker-service`: patch bump** of its pinned image tag in `apps/ai-server/docker-compose.yml` (`student-rag-worker-service:0.1.0` → `0.1.1`). It is the only service with production code changes, and the change is a behavior fix with no schema or interface migration — patch semantics.
- **`rag-api-service`: no bump** — no production code change is expected; the contract test verifies its existing failed-branch behavior. If implementation discovers rag-api truly needs a change to satisfy Requirement 3, that is a scope deviation to surface at review, not to absorb silently.
- **Tests: no service bump** — the new contract test lives under `apps/ai-server/tests/integration/` and ships with the worker change.
- Caveat: no versioning-policy document was verified in this cycle; the patch-bump recommendation above follows the observed convention of pinned `:0.1.0`-style tags in `docker-compose.yml`. Confirm at approval.

## Deferred items

- **Companion D3 issue** referenced by the Objective — its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling this analysis with deviation D4 in `plans/upload-flow.md`** — that file is not present in the current tree (verified: `plans/` contains only `README.md`, `ROADMAP.md`, and six unrelated plan files); the reference exists only in the Objective text.
- **Dropping the legacy `error` key** from the worker's failure payload — trivial cleanup if a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic.
- **Widening `classify_error`** to recognize more transient conditions — out of scope; the conservative permanent default for unknown exceptions is deliberate.
- **Structured error codes / failure taxonomy** — the summary `error.code` stays `"UNKNOWN"` unless a code is actually sent.
- **Frontend retry affordances** keyed off `retryable` — `ResourceResponse` already exposes the fields; any UX change is separate work.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>