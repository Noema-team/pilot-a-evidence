The authoritative Definition is complete and self-contained — it pins the contract mismatch, the fix direction, the stage vocabulary, the retryable derivation, and the test strategy. I've verified the target tree exists (`apps/ai-server` with `rag-worker-service`, `rag-api-service`, `tests/`) and that `docs/` is the right home for the charter. No repository evidence contradicts the Definition, so I'm producing the scope charter exactly as bounded — no widening (no API-side schema changes, no error-code taxonomy, no retry mechanics) and no narrowing (worker payload keys + stage tracking + retryable derivation + contract test all in).

## Scope
Align the rag-worker's failure status payload to rag-api's existing failed-branch contract. The worker's `process_document` exception handler currently publishes only `{"error": str(e)}` via `_publish_status_update`; rag-api's `run_transactional_update` failed branch reads `error_message`, `stage`, and `retryable` and persists them as `error`, `error_stage`, and `retryable` on the main resource document (plus message/stage into the processing/summary error subdocument, `error_code` defaulting to `"UNKNOWN"`). Because of the key mismatch, every worker-originated failure today persists the fallback string "Processing failed", a null `error_stage`, and a silently-defaulted `retryable: true`.

In scope:
1. **Worker payload keys** — the worker's failed status payload publishes `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
2. **Stage tracking** — `process_document` tracks the currently executing pipeline stage in a local set immediately before each pipeline step; the exception handler reports it. Stage names reuse the existing progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown (matching the stale-lease sweep's convention).
3. **retryable derivation** — derived explicitly from `classify_error(e)`: transient-classified → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior.
4. **Contract test** — a test in `apps/ai-server/tests/integration/` covering the worker failure → rag-api persistence path: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` (Firestore emulator or fakes, per existing hermetic patterns in `test_api_contracts.py`), and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. Include a key-set drift guard so edits to either side's payload keys fail the build.

Out of scope (explicitly): changing rag-api's reads or persisted schema; any Firestore migration, field rename, or backfill; the stale-lease sweep's direct failure write; retry/backoff mechanics (ACK/NACK policy, leases, heartbeats); frontend/mobile changes; structured error codes or a failure taxonomy; the companion D3 issue's scope beyond this alignment; reconciling the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## Purpose
A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures — locked in by a contract test on the worker→rag-api failure path. Today the seam between the two services is untested and the contracts diverge: failures land in Firestore as "Processing failed" / null stage / fabricated `retryable: true`, which is useless for diagnosis and dishonest about retryability. The fix direction is deliberate: the worker is the odd writer out (the sweep, rag-api's enqueue-failure paths, and the `Resource` model all already use `error`/`error_stage`/`retryable`), so aligning the worker avoids any migration, backfill, or reader changes. The retryable derivation makes the persisted record tell the truth about what Pub/Sub will actually do — transient errors redeliver (retryable true), permanent errors are acked (retryable false, manual reprocess via `POST /process` remains). One deliberate behavior change is accepted: unclassified-unknown exceptions move from the silent `retryable: true` default to `false`, which is the conservatism `classify_error` was written for and prevents infinite retry loops.

## Requirements
- When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
- The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
- The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown) → `retryable` false.
- A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.
- Constraint: the worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema (must).
- Constraint: no Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics (must_not).
- Constraint: every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures (must).
- Preference: retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling (prefer).
- Preference: do not introduce a structured error-code taxonomy (`error_code` values) in this fix (prefer_not).

## Boundaries
Non-goals, unchanged from the Definition:
- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here; deferred).

Accepted risks and tradeoffs (from the Definition's analysis):
- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the "set the tracker immediately before the await" convention and representative-stage test coverage (an early-stage failure and a late-stage failure), enough to catch the tracker being removed or bypassed without ossifying every step.
- `retryable=false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope and manual reprocess remains.
- The contract test ossifies the payload — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Version bump
Patch. The change is confined to failure-payload construction in the worker (new keys, stage tracking, retryable derivation), a contract test, and no API-side schema or persisted-field changes. No migration, no backfill, no reader changes — the persisted field names and semantics are unchanged, so no minor or major bump is warranted.

## Deferred items
- The companion D3 issue referenced by the Objective (filed alongside this one) — its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text.
- Dropping the legacy `error` key from the worker's failure payload — trivial cleanup if a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic.
- Widening `classify_error` to recognize additional transient failure modes — out of scope; the conservative default stands for this fix.
- Any structured error-code taxonomy or failure classification beyond `classify_error`'s existing transient/permanent split.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api: failure payload contract mismatch

## Scope

Align the rag-worker's failure status payload to rag-api's existing failed-branch contract. The worker's `process_document` exception handler currently publishes only `{"error": str(e)}` via `_publish_status_update`; rag-api's `run_transactional_update` failed branch reads `error_message`, `stage`, and `retryable` and persists them as `error`, `error_stage`, and `retryable` on the main resource document (plus message/stage into the processing/summary error subdocument, `error_code` defaulting to `"UNKNOWN"`). Because of the key mismatch, every worker-originated failure today persists the fallback string "Processing failed", a null `error_stage`, and a silently-defaulted `retryable: true`.

In scope:

1. **Worker payload keys** — the worker's failed status payload publishes `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
2. **Stage tracking** — `process_document` tracks the currently executing pipeline stage in a local set immediately before each pipeline step; the exception handler reports it. Stage names reuse the existing progress vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown (matching the stale-lease sweep's convention).
3. **retryable derivation** — derived explicitly from `classify_error(e)`: transient-classified → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior.
4. **Contract test** — a test in `apps/ai-server/tests/integration/` covering the worker failure → rag-api persistence path: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` (Firestore emulator or fakes, per existing hermetic patterns in `test_api_contracts.py`), and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. Include a key-set drift guard so edits to either side's payload keys fail the build.

Out of scope (explicitly): changing rag-api's reads or persisted schema; any Firestore migration, field rename, or backfill; the stale-lease sweep's direct failure write; retry/backoff mechanics (ACK/NACK policy, leases, heartbeats); frontend/mobile changes; structured error codes or a failure taxonomy; the companion D3 issue's scope beyond this alignment; reconciling the D4 deviation note in `plans/upload-flow.md` (file not present in the current tree).

## Purpose

A failed RAG processing job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag so users and support can disambiguate failures — locked in by a contract test on the worker→rag-api failure path. Today the seam between the two services is untested and the contracts diverge: failures land in Firestore as "Processing failed" / null stage / fabricated `retryable: true`, which is useless for diagnosis and dishonest about retryability.

The fix direction is deliberate: the worker is the odd writer out (the sweep, rag-api's enqueue-failure paths, and the `Resource` model all already use `error`/`error_stage`/`retryable`), so aligning the worker avoids any migration, backfill, or reader changes. The retryable derivation makes the persisted record tell the truth about what Pub/Sub will actually do — transient errors redeliver (retryable true), permanent errors are acked (retryable false, manual reprocess via `POST /process` remains). One deliberate behavior change is accepted: unclassified-unknown exceptions move from the silent `retryable: true` default to `false`, which is the conservatism `classify_error` was written for and prevents infinite retry loops.

## Requirements

- When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
- The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
- The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown) → `retryable` false.
- A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.
- Constraint: the worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema (must).
- Constraint: no Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics (must_not).
- Constraint: every worker-originated failure payload carries `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures (must).
- Preference: retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling (prefer).
- Preference: do not introduce a structured error-code taxonomy (`error_code` values) in this fix (prefer_not).

## Boundaries

Non-goals, unchanged from the Definition:

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here; deferred).

Accepted risks and tradeoffs (from the Definition's analysis):

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the "set the tracker immediately before the await" convention and representative-stage test coverage (an early-stage failure and a late-stage failure), enough to catch the tracker being removed or bypassed without ossifying every step.
- `retryable=false` for unclassified errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope and manual reprocess remains.
- The contract test ossifies the payload — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Version bump

Patch. The change is confined to failure-payload construction in the worker (new keys, stage tracking, retryable derivation), a contract test, and no API-side schema or persisted-field changes. No migration, no backfill, no reader changes — the persisted field names and semantics are unchanged, so no minor or major bump is warranted.

## Deferred items

- The companion D3 issue referenced by the Objective (filed alongside this one) — its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text.
- Dropping the legacy `error` key from the worker's failure payload — trivial cleanup if a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic.
- Widening `classify_error` to recognize additional transient failure modes — out of scope; the conservative default stands for this fix.
- Any structured error-code taxonomy or failure classification beyond `classify_error`'s existing transient/permanent split.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>