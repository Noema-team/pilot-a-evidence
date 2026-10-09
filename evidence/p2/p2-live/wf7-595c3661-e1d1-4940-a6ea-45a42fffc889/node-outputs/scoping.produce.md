I have the authoritative definition and verified the repository context (both service files exist as claimed). Now producing the cycle charter.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract mismatch

## Scope

This cycle aligns the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag.

In scope:

- **Worker failure payload (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler / `_publish_status_update` path).** The failed status payload must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
- **Stage tracking in `process_document`.** A stage tracker is set immediately before each pipeline step so the failure handler can report the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- **Retryable derivation.** The worker derives `retryable` from `classify_error(e)`: transient-classified errors → `true`; permanent-classified errors (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior.
- **rag-api failed branch (`apps/ai-server/rag-api-service/main.py`, `run_transactional_update`).** Verified, not modified: it persists main-document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`, and writes the same message/stage into the processing/summary error subdocument. The API side's reads and persisted schema stay unchanged.
- **Contract test (`apps/ai-server/tests/integration/test_api_contracts.py` patterns).** A worker→rag-api failure-path contract test that builds the failure payload through the worker's code path, feeds it through rag-api's failed-branch persistence (Firestore emulator or fakes), asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and includes a key-set drift guard so a future edit to either side's payload keys fails the build.

Out of scope (see Boundaries).

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test covers the seam. The worker publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore lands in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true` — the processing/summary error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures, and the persisted retryable flag is a silent default rather than a deliberate decision.

The fix direction is worker-side alignment: `error`/`error_stage`/`retryable` are already the established persisted schema across the worker's stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource` model / `ResourceResponse` — the worker's status publisher is the only writer that doesn't speak it. Aligning the worker requires no Firestore migration, no field rename, no backfill, and no reader changes.

The retryable derivation makes the persisted record tell the truth: a transient error is one Pub/Sub will redeliver (retryable true); a permanent error was acked and will not come back (retryable false, manual reprocess via `POST /process` remains). One deliberate behavior change falls out: unclassified-unknown exceptions currently persist `retryable: true` via the silent default but classify as permanent, so they will now persist `false` — that is the conservatism `classify_error` was written for, and the manual reprocess path is unaffected.

## Requirements

1. **Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. Convention: set the tracker immediately before the await of each pipeline step.
3. **API-side persistence unchanged.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. **Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
5. **Contract test.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

## Boundaries

Must constraints:

- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- Every worker-originated failure payload must carry `retryable` explicitly; the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

Must-not constraints:

- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.

Prefer constraints:

- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling.

Prefer-not constraints:

- Do not introduce a structured error-code taxonomy (`error_code` values); the processing/summary error `code` remains `"UNKNOWN"` unless a code is actually sent.

Non-goals:

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy.
- Widening `classify_error`'s classification heuristics — `retryable=false` for unclassified-unknown errors is accepted behavior; manual reprocess via `POST /process` remains.
- Dropping the legacy `error` key from the worker payload — that is deferred cleanup pending an audit of status-topic consumers.

## Version bump

Patch. The change is a bug fix within existing services: the worker's failure payload construction gains three keys and a stage tracker, plus a new contract test. No new public API surface, no schema or migration, no dependency changes, no behavior change to any successful-path flow. The one behavior change (unclassified-unknown failures now persist `retryable: false` instead of the silent default `true`) is a correction of a silent default to a deliberate value, consistent with patch-level semantics.

## Deferred items

- **Companion D3 issue.** The Objective references a companion D3 issue filed alongside this one; its scope is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle.
- **Reconciling with the original D4 deviation note.** `plans/upload-flow.md` (where deviation D4 was originally analyzed) is not present in the current tree; the reference comes from the Objective text only. Reconciliation is deferred.
- **Status-topic consumer audit / legacy `error` key removal.** Only rag-api's status subscriber is verified as a consumer of these payloads. If a later audit confirms the worker is the only publisher and rag-api the only consumer, dropping the duplicate `error` key is trivial cleanup — deferred.
- **Structured error-code taxonomy.** Deferred per the prefer-not constraint; `error_code` stays `"UNKNOWN"` unless a code is actually sent.
- **Widening `classify_error` heuristics.** Genuinely transient-but-unrecognized failures will now persist `retryable: false`; widening the classifier is out of scope, manual reprocess remains available.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>