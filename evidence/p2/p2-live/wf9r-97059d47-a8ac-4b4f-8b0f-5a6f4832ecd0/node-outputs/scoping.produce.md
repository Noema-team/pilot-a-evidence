 I have the authoritative definition pinned. The repository evidence in the Definition is already integrity-resolved, so I can produce the scoping charter directly from it without widening scope.

## Scope

This cycle fixes the worker→rag-api failure payload contract mismatch, and only that. The change surface is:

- `apps/ai-server/rag-worker-service/main.py` — the `process_document` exception handler's failure payload construction (`_publish_status_update` call), plus a stage tracker threaded through `process_document` so the failing pipeline stage is known at failure time. The payload gains `error_message` (actual exception message), `stage` (current pipeline stage, reusing the existing progress vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, with `"processing"` as the safe unknown value), and `retryable` (derived from `classify_error(e)` — transient → `true`, permanent/unclassified-unknown → `false`). The legacy `error` key is retained alongside `error_message` as a compatibility hedge.
- `apps/ai-server/tests/integration/test_api_contracts.py` (or a sibling test module following the same fixture/AST pattern) — a new contract test covering the worker failure → rag-api persistence path: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` failed branch (Firestore emulator or fakes), assert persisted `error`, `error_stage`, and `retryable` equal the worker's values, and include a key-set drift guard on both sides.

rag-api's `run_transactional_update` failed branch is **not modified** — it already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable`. The worker aligns to it.

## Purpose

Every worker-originated failure currently persists as the fallback string `"Processing failed"`, a null `error_stage`, and a silently-defaulted `retryable: true`, because the worker publishes `{"error": str(e)}` while rag-api reads `error_message`/`stage`/`retryable`. Users and support cannot disambiguate failures, and the persisted retryable flag contradicts the worker's actual ACK/NACK behavior. This cycle makes a failed RAG job persist the worker's true error message, the true failing stage, and a deliberately derived retryable flag — locked in by a contract test so the seam cannot silently drift again. No Firestore migration, rename, or backfill is involved; the persisted schema (`error`, `error_stage`, `retryable`) already matches three other write paths and both response models.

## Requirements

1. The worker's failed status payload must include `error_message` (actual exception message), `stage` (pipeline stage executing at failure time), and `retryable` (deliberately derived) — never relying on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` (tracker set immediately before each pipeline step); stage names reuse the existing progress-stage vocabulary, with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch persists the worker-provided values unchanged: main document `error` ← `error_message`, `error_stage` ← `stage`, `retryable` ← `retryable`; the processing/summary error subdocument carries the same message and stage (with `error_code` remaining "UNKNOWN" unless actually sent).
4. The `retryable` derivation must be explicit and aligned with the worker's ACK/NACK behavior: `classify_error(e)` transient → `true`; permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `false`.
5. A contract test must cover the worker failure → rag-api persistence path (emulator or fakes), asserting persisted `error`, `error_stage`, and `retryable` equal the worker's values, and must fail if either side's payload keys drift.
6. Prefer retaining the legacy `error` key in the worker's failure payload alongside `error_message` for continuity with unknown status-topic consumers and log tooling.

## Boundaries

**In scope:** the worker's failure-payload construction and stage tracking; the new contract test; retention of the legacy `error` key.

**Out of scope (non-goals):**
- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.
- Changing rag-api's reads or persisted schema in any way (no migration, rename, or backfill).
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment.

## Version bump

Patch-level. The change is a bug fix to a service-internal payload contract plus test additions: no public API surface changes (`ResourceResponse`/`Resource` model untouched), no schema migration, no new endpoints. If the repo uses semantic versioning per service, bump the rag-worker-service patch version; if it uses a monorepo-wide version, bump patch.

## Deferred items

- The companion D3 issue referenced by the Objective — its scope is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text.
- Dropping the legacy `error` key from the worker payload — deferred pending an audit confirming the worker is the only publisher and rag-api the only consumer of the status topic.
- Widening `classify_error` to recognize additional transient-but-unrecognized failure modes — accepted residual risk; manual reprocess via `POST /process` remains available.<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle fixes the worker→rag-api failure payload contract mismatch, and only that. The change surface is:

- `apps/ai-server/rag-worker-service/main.py` — the `process_document` exception handler's failure payload construction (`_publish_status_update` call), plus a stage tracker threaded through `process_document` so the failing pipeline stage is known at failure time. The payload gains `error_message` (actual exception message), `stage` (current pipeline stage, reusing the existing progress vocabulary: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, with `"processing"` as the safe unknown value), and `retryable` (derived from `classify_error(e)` — transient → `true`, permanent/unclassified-unknown → `false`). The legacy `error` key is retained alongside `error_message` as a compatibility hedge.
- `apps/ai-server/tests/integration/test_api_contracts.py` (or a sibling test module following the same fixture/AST pattern) — a new contract test covering the worker failure → rag-api persistence path: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` failed branch (Firestore emulator or fakes), assert persisted `error`, `error_stage`, and `retryable` equal the worker's values, and include a key-set drift guard on both sides.

rag-api's `run_transactional_update` failed branch is **not modified** — it already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable`. The worker aligns to it.

## Purpose

Every worker-originated failure currently persists as the fallback string `"Processing failed"`, a null `error_stage`, and a silently-defaulted `retryable: true`, because the worker publishes `{"error": str(e)}` while rag-api reads `error_message`/`stage`/`retryable`. Users and support cannot disambiguate failures, and the persisted retryable flag contradicts the worker's actual ACK/NACK behavior. This cycle makes a failed RAG job persist the worker's true error message, the true failing stage, and a deliberately derived retryable flag — locked in by a contract test so the seam cannot silently drift again. No Firestore migration, rename, or backfill is involved; the persisted schema (`error`, `error_stage`, `retryable`) already matches three other write paths and both response models.

## Requirements

1. The worker's failed status payload must include `error_message` (actual exception message), `stage` (pipeline stage executing at failure time), and `retryable` (deliberately derived) — never relying on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` (tracker set immediately before each pipeline step); stage names reuse the existing progress-stage vocabulary, with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch persists the worker-provided values unchanged: main document `error` ← `error_message`, `error_stage` ← `stage`, `retryable` ← `retryable`; the processing/summary error subdocument carries the same message and stage (with `error_code` remaining "UNKNOWN" unless actually sent).
4. The `retryable` derivation must be explicit and aligned with the worker's ACK/NACK behavior: `classify_error(e)` transient → `true`; permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `false`.
5. A contract test must cover the worker failure → rag-api persistence path (emulator or fakes), asserting persisted `error`, `error_stage`, and `retryable` equal the worker's values, and must fail if either side's payload keys drift.
6. Prefer retaining the legacy `error` key in the worker's failure payload alongside `error_message` for continuity with unknown status-topic consumers and log tooling.

## Boundaries

**In scope:** the worker's failure-payload construction and stage tracking; the new contract test; retention of the legacy `error` key.

**Out of scope (non-goals):**
- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.
- Changing rag-api's reads or persisted schema in any way (no migration, rename, or backfill).
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment.

## Version bump

Patch-level. The change is a bug fix to a service-internal payload contract plus test additions: no public API surface changes (`ResourceResponse`/`Resource` model untouched), no schema migration, no new endpoints. If the repo uses semantic versioning per service, bump the rag-worker-service patch version; if it uses a monorepo-wide version, bump patch.

## Deferred items

- The companion D3 issue referenced by the Objective — its scope is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree; the reference comes from the Objective text.
- Dropping the legacy `error` key from the worker payload — deferred pending an audit confirming the worker is the only publisher and rag-api the only consumer of the status topic.
- Widening `classify_error` to recognize additional transient-but-unrecognized failure modes — accepted residual risk; manual reprocess via `POST /process` remains available.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>