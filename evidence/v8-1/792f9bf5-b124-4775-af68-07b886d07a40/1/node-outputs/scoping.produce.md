I've verified the repository evidence backing the Definition: the worker's `classify_error()` (transient/permanent heuristics, conservative permanent default for unknowns) exists at the top of `rag-worker-service/main.py`, and the contract-test patterns live in `apps/ai-server/tests/integration/test_api_contracts.py`. The charter below is scoped strictly to the authoritative Definition — no widening or narrowing.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

## Scope

This cycle aligns the rag-worker's failure status payload with rag-api's failed-branch contract so a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag.

In scope:

1. **Worker failure payload (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler)** — publish failed status with `error_message` (actual exception message), `stage` (pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as a compatibility hedge for unknown consumers of the status topic.
2. **Stage tracking in `process_document`** — a stage tracker set immediately before each pipeline step, reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **Retryable derivation** — the worker sets `retryable` from `classify_error(e)`: transient-classified → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.
4. **Contract test** — a worker failure → rag-api persistence-path test in the existing integration suite (`apps/ai-server/tests/integration/test_api_contracts.py` patterns), exercising the worker's failure-payload construction through rag-api's `run_transactional_update` failed branch (via the Firestore emulator or fakes), asserting persisted `error`, `error_stage`, and `retryable` equal the worker's values, plus a key-set drift guard so edits to either side's payload keys fail the build. Coverage pins the mechanism on representative stages (an early-stage failure and a late-stage failure).

Out of scope is everything in Boundaries below.

## Purpose

The worker's exception handler publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads `error_message`, `stage`, and `retryable` and persists them as `error`/`error_stage`/`retryable`. Because of the key mismatch, every worker-originated failure currently lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a silently defaulted `retryable: true` — with `error_code` always "UNKNOWN" in the processing/summary subdocument. Users and support cannot disambiguate failures, and the persisted retryable flag does not reflect the worker's actual retry behavior.

The fix direction is the worker aligning to rag-api's existing contract rather than changing rag-api's reads or persisted schema: `error`/`error_stage`/`retryable` are already the established persisted schema across the worker's stale-lease sweep, rag-api's enqueue-failure paths (`/process`, `POST /resources`), and the `Resource`/`ResourceResponse` models. The worker's status publisher is the only writer that doesn't speak it — fix the odd one out. This requires no Firestore migration, field rename, or backfill.

## Requirements

1. The worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
4. The `retryable` derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Constraints binding the implementation:

- **Must**: align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`) rather than changing rag-api's reads or persisted schema.
- **Must not**: require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must**: every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer**: retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling.
- **Prefer not**: introduce a structured error-code taxonomy (`error_code` values) in this fix; the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.

## Boundaries

Non-goals — explicitly excluded from this cycle:

- **Stale-lease sweep**: changing `_fail_if_still_stale`'s direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract. Its separate `retryable=true` write stays correct (a dead worker is a transient condition).
- **Retry/backoff mechanics**: no changes to Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- **Frontend/mobile**: no changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **Structured error codes / failure taxonomy**: not introduced; the processing/summary `error.code` remains "UNKNOWN" unless a code is actually sent.
- **Widening `classify_error`**: the residual risk that genuinely transient-but-unrecognized failures now persist `retryable: false` is accepted; manual reprocess via `POST /process` remains available.
- **Consumer audit of the status topic**: only rag-api's status subscriber is verified as a consumer; the legacy `error` key retention is the hedge instead of an audit. Dropping the duplicate later is trivial cleanup if an audit confirms worker-only publisher / rag-api-only consumer.

## Version bump

**Patch** — `apps/ai-server/rag-worker-service` only.

Rationale: the change is a contained behavioral fix in the worker's failure reporting path (payload keys, stage tracker, retryable derivation) plus new test coverage. There is no schema migration, no persisted-field rename, no API-side change (rag-api's failed branch already reads the aligned keys and persists them unchanged), and no new public surface — so no minor bump is warranted. `rag-api-service` requires no version bump; the contract-test additions are test-suite-only.

## Deferred items

- **Companion D3 issue** referenced by the Objective: its scope is not available in this context; anything it covers beyond the worker→rag-api failure payload alignment is deferred (F12).
- **Reconciling this analysis with deviation D4 in `plans/upload-flow.md`**: that file is not present in the current tree; the reference comes from the Objective text only. Deferred until the file or its content is available.
- **Dropping the legacy `error` key** from the worker's failure payload: deferred pending an audit confirming the worker is the only publisher and rag-api the only consumer of the status topic.
- **Structured error-code taxonomy**: deferred per the prefer-not constraint; would be a separate cycle if ever needed.
- **Widening `classify_error`** to recognize more transient conditions: out of scope; the accepted tradeoff is `retryable: false` for unclassified-unknown exceptions, with manual reprocess via `POST /process` unaffected.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>