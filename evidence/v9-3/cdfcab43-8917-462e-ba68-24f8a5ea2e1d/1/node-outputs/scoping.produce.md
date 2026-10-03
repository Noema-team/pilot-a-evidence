The scoping evidence is verified against the tree: the worker's exception handler publishes `{"error": str(e)}` (rag-worker `main.py`, `process_document`), rag-api's failed branch reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` plus the `processing/summary` error subdocument, `classify_error()` drives ACK/NACK in `run_worker`, the stale-lease sweep already writes the target schema, and the contract-test harness exists in `apps/ai-server/tests/integration/`. The charter below is written strictly within the authoritative Definition's bounds.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

Work item: wi-define-108-a8 (definition artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`)

## Scope

Align the rag-worker's failed-status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path.

In scope:

- **Worker failure payload construction** — the `process_document` exception handler's `_publish_status_update(..., "failed", ...)` call must publish `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived), so rag-api's fallback defaults ("Processing failed", `None`, `True`) are never operative for worker failures. The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic.
- **Stage tracking in `process_document`** — a stage tracker set immediately before each pipeline step, reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown (matching the stale-lease sweep's `error_stage` value).
- **Retryable derivation** — the worker sets `retryable` from `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown (per `classify_error`'s conservative default), → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.
- **rag-api failed branch (verify-only)** — `run_transactional_update`'s failed branch persists worker values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument carries the same message and stage with `error_code` defaulting to `"UNKNOWN"`. No changes to rag-api's reads, persisted field names, or schema.
- **Contract test** — a test in the existing `apps/ai-server/tests/integration/` harness (fixture- and AST-based patterns, `test_api_contracts.py`) that builds the failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` against the Firestore emulator (or fakes), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and includes a key-set drift guard so a future edit to either side's payload keys fails the build.

Out of scope is everything listed under Boundaries and Deferred items below.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts and nothing tests the seam. The worker publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — users and support cannot disambiguate failures, and the persisted retryability is a silent default rather than a decision.

The fix direction is worker→API alignment because the persisted schema (`error`/`error_stage`/`retryable`) is already consistent across three other write paths (the worker's stale-lease sweep, rag-api's `/process` and `POST /resources` enqueue-failure paths) and both response models (`ResourceResponse`, `Resource` model with `retryable` defaulting `True`). The worker is the odd one out; aligning it requires no Firestore migration, field rename, or backfill, and no reader changes.

Deriving `retryable` from `classify_error` makes the persisted record tell the truth: a transient error is one Pub/Sub will redeliver (`retryable: true`); a permanent error was acked and will not return (`retryable: false`, manual reprocess via `POST /process` remains). One deliberate behavior change is accepted: unclassified-unknown exceptions previously persisted the silent default `true` but classify as permanent, so they will now persist `false` — the conservatism `classify_error` was written for.

## Requirements

1. **Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. Convention: set the tracker immediately before the awaited step.
3. **API-side passthrough.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage (`error_code` remains `"UNKNOWN"` unless a code is actually sent).
4. **Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`. The stale-lease sweep's separate `retryable: true` write stays correct and unchanged (a dead worker is a transient condition).
5. **Contract test.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift. Coverage on representative stages (an early-stage failure and a late-stage failure) pins the stage-tracker mechanism without ossifying every step.

Binding constraints:

- **Must:** align the worker to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- **Must not:** require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must:** every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer:** retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- **Prefer not:** introduce a structured error-code taxonomy (`error_code` values) in this fix.

## Boundaries

Non-goals (explicitly out of scope):

- **Stale-lease sweep** — `_fail_if_still_stale` already persists `error`/`error_stage`/`retryable` consistently with this contract; its direct failure write is unchanged.
- **Retry/backoff mechanics** — Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals are unchanged; only the *reporting* of retryability in the payload changes.
- **Frontend or mobile changes** — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **Structured error codes / failure taxonomy** — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- **Companion D3 issue scope** — anything that issue covers beyond this worker→rag-api failure payload alignment.

Accepted tradeoffs and residual risks:

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- `retryable: false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope and manual reprocess via `POST /process` remains.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job.

## Version bump

- **rag-worker-service: minor.** Observable behavior change in failure payloads: new keys (`error_message`, `stage`, `retryable`) and a derived `retryable` that can now be `false` where the silent default previously produced `true` (unclassified-unknown failures). No schema or persisted-field change.
- **rag-api-service: none (patch at most).** The failed branch's reads and persisted fields are unchanged; verification only. If any touch lands, it is patch-level with no contract change.
- **No Firestore migration, field rename, or backfill** of existing documents; existing failed documents keep their previously persisted values.

## Deferred items

- **Companion D3 issue** referenced by the Objective — its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling with the original D4 deviation note** in `plans/upload-flow.md` — that file is not present in the current tree (the reference comes from the Objective text); deferred.
- **Dropping the legacy `error` key** from the worker's failure payload — trivial cleanup if a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic.
- **Structured error-code taxonomy** — the `processing/summary` `error.code` stays `"UNKNOWN"` unless a code is actually sent; a taxonomy is a prefer-not for this fix and deferred beyond it.
- **Widening `classify_error`'s heuristics** — improving recognition of unrecognized-transient failures (which now persist `retryable: false`) is out of scope.
- **Frontend/mobile surfacing changes** — `ResourceResponse` already exposes `error`/`error_stage`; `retryable` exposure to clients, if ever wanted, is a separate concern.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>