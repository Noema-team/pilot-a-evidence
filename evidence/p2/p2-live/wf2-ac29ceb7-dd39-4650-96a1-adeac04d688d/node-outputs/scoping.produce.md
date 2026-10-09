 The authoritative definition fully specifies the scope; I'll produce the cycle charter at the declared path.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle fixes the worker→rag-api failure-payload contract mismatch for RAG processing jobs, bounded to the following work:

1. **Worker failure payload alignment** (`apps/ai-server/rag-worker-service/main.py`)
   - The failed-status payload published by `process_document`'s exception handler (currently `{"error": str(e)}` via `_publish_status_update`) must carry the keys rag-api's failed branch reads: `error_message` (the actual exception message), `stage` (the failing pipeline stage), and `retryable` (deliberately derived).
   - The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unknown consumers of the status topic.
   - A stage tracker is added inside `process_document`: a local set immediately before each pipeline step, reported by the exception handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
   - `retryable` is derived explicitly from `classify_error(e)`: transient-classified errors → `true`; permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.

2. **rag-api failed-branch persistence (unchanged code, verified)** (`apps/ai-server/rag-api-service/main.py`)
   - rag-api's `run_transactional_update` failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main document and `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) on the processing/summary subdocument. No reader changes are made; the worker is aligned to this contract.

3. **Contract test** (`apps/ai-server/tests/integration/`, following `test_api_contracts.py` patterns)
   - A contract test covering the worker failure → rag-api persistence path: it imports both sides rather than restating the contract, builds the failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` against the Firestore emulator (or fakes), and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
   - The test pins representative stages (an early-stage failure and a late-stage failure) and includes a key-set drift guard so a future edit to either side's payload keys fails the build.

## Purpose

Every worker-originated RAG failure currently persists in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true`, because the worker's failure publisher speaks a one-key contract (`{"error": …}`) while rag-api's failed branch reads three (`error_message`, `stage`, `retryable`). Users and support cannot disambiguate failures, and retryability is silently defaulted rather than derived.

The purpose of this cycle is to close that seam: a failed job must persist the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — aligned to rag-api's existing persisted schema (`error`/`error_stage`/`retryable`), which is already consistent across the stale-lease sweep, rag-api's enqueue-failure paths, the `Resource` model, and `ResourceResponse`. Locking the contract in with a test prevents the mismatch from silently re-creating itself.

## Requirements

- When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
- The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
- rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument must carry the same message and stage.
- The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
- A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

## Boundaries

**Must:**
- The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.

**Must not:**
- The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Every worker-originated failure payload must carry `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

**Prefer:**
- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.

**Prefer not:**
- Do not introduce a structured error-code taxonomy (`error_code` values) in this fix.

**Out of scope (non-goals):**
- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the processing/summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred).

## Version bump

Minor. The change is behavior-visible but additive and non-breaking at the API surface: worker failure payloads gain keys (`error_message`, `stage`, `retryable`) alongside the retained legacy `error` key, rag-api's reader and persisted schema are unchanged, and no migration or backfill is required. The one deliberate behavior change — unclassified-unknown exceptions now persist `retryable: false` instead of the silent default `true` — is a bug-fix-level semantic correction consistent with a minor bump, not a breaking contract change.

## Deferred items

- **Companion D3 issue**: The Objective references a companion D3 issue filed alongside this one; its scope is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciliation with the original D4 deviation note**: The original analysis referenced `plans/upload-flow.md` (deviation D4), a file not present in the current tree. Reconciling this analysis with that note is deferred.
- **Dropping the legacy `error` key**: If a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic, removing the duplicate key is trivial cleanup — deferred beyond this cycle.
- **Widening `classify_error`**: Genuinely transient-but-unrecognized failures will now persist `retryable: false`; widening the classifier is out of scope, and manual reprocess via `POST /process` remains available.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>