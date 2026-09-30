<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path. The worker aligns to rag-api's existing contract; rag-api's reads and persisted schema are not changed.

Work items:

- **Worker failure payload** (`apps/ai-server/rag-worker-service/main.py`, `process_document` exception handler): replace the one-key `{"error": str(e)}` details payload with one carrying `error_message` (the actual exception message), `stage`, and `retryable`. Retain the legacy `error` key alongside `error_message` as a compatibility hedge for any unverified consumers of the status topic.
- **Stage tracking** in `process_document`: a stage tracker set immediately before each pipeline step (the "set before the await" convention) so the failure handler reports the stage executing at failure time. Stage names reuse the existing progress-update vocabulary — `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` — with `processing` as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep writes to `error_stage`, so the field never regresses to null).
- **retryable derivation**: the worker sets `retryable` from `classify_error(e)` — transient-classified errors map to `true`, permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) to `false`. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker` (transient = Pub/Sub redelivers; permanent = acked, manual reprocess via POST /process remains).
- **rag-api-service: no functional change.** Its failed branch in `run_transactional_update` already reads `error_message`/`stage`/`retryable`, persists `error`/`error_stage`/`retryable` on the main document, and writes message/stage (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` subdocument. The worker aligns to this contract; rag-api's reads and persisted field names are untouched.
- **Contract test** in `apps/ai-server/tests/integration/` (alongside `test_api_contracts.py`, following its import-both-sides pattern rather than restating the contract in a fixture): build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` against the Firestore emulator or fakes, and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. Include a key-set drift guard on both sides so a future edit to either side's payload keys fails the build. Cover representative stages (an early-stage failure and a late-stage failure) — enough to catch the stage tracker being removed or bypassed without ossifying every pipeline step.

Implementation note (verified): the worker's `main.py` executes module-level Pub/Sub setup at import time and requires `GCP_PROJECT` and `GOOGLE_APPLICATION_CREDENTIALS` to be present, so the contract test must establish a hermetic environment (emulator env vars, dummy credential path, fakes) before importing the worker side. Both services already have `FIRESTORE_EMULATOR_HOST` branches supporting this.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker publishes `{"error": str(e)}`; rag-api's failed branch reads `error_message`, `stage`, and `retryable` and persists them as `error`/`error_stage`/`retryable`. Every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`. Users and support cannot disambiguate failures, and retryability is silently defaulted rather than decided.

The worker is the odd one out: the stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths, and the `Resource` model all already use the `error`/`error_stage`/`retryable` schema. Aligning the worker requires no migration, no field rename, no backfill, and no reader changes.

Deriving `retryable` from `classify_error(e)` makes the persisted record tell the truth about what Pub/Sub will do: a transient-classified error is one Pub/Sub will redeliver (`retryable: true`); a permanent-classified error was acked and will not return (`retryable: false`, manual reprocess via POST /process remains). One deliberate behavior change: unclassified-unknown exceptions currently persist `retryable: true` via the silent default but classify as permanent, so they will now persist `false` — the conservatism `classify_error` was written for. The stale-lease sweep's separate `retryable: true` write stays correct: a dead worker is a transient condition by nature.

The contract test is the drift guard: it imports both sides rather than restating the contract, so a future edit to either side's keys fails the build instead of silently re-creating this bug.

## Requirements

1. When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage.
4. The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable` false.
5. A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

Binding constraints:

- **Must**: the worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed.
- **Must not**: require a Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- **Must**: every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.
- **Prefer**: retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with existing consumers of the status topic and log tooling.
- **Prefer not**: introducing a structured error-code taxonomy (`error_code` values) in this fix.

## Boundaries

Out of scope (non-goals):

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract (`error_stage: "processing"`, `retryable: true`).
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; see Deferred items).
- Changing rag-api's failed-branch reads, persisted field names, or response models to accommodate the worker.

Accepted tradeoffs (deliberate, documented in the Definition):

- `retryable` becomes `false` for unclassified-unknown exceptions (previously the silent default `true`); manual reprocess via POST /process is unaffected.
- The legacy `error` key is duplicated alongside `error_message` — one redundant string per failure message as insurance against unknown consumers of the status topic.
- The contract test intentionally ossifies the payload key set; adding a key later means touching the test.

## Version bump

No version-bearing artifact (package version, CHANGELOG, or image-tag scheme) was verified for the affected services during scoping, so the exact bump mechanism is left to the project's release conventions. Semantically this is a patch-level bug fix localized to `rag-worker-service`: user-visible effects are that real error messages and failing stages persist instead of fallbacks, and `retryable` is derived (including the deliberate `retryable: false` change for unclassified-unknown errors). `rag-api-service` is expected to need no code change and therefore no bump. No data migration or schema version bump is in scope — the Definition explicitly forbids migrations, renames, or backfills, and the persisted schema (`error`, `error_stage`, `retryable`, `schema_version: 2` writes) is unchanged. Reconcile the bump label with the repository's actual versioning convention at implementation time; this was not verifiable during scoping.

## Deferred items

- **Companion D3 issue**: the Objective references a companion D3 issue filed alongside this one; its content is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **`plans/upload-flow.md` reconciliation**: the Objective references original analysis in that file (deviation D4), but the file is not present in the current tree; reconciling this analysis with it is deferred.
- **Dropping the legacy `error` key**: after a consumer audit confirms the worker is the only publisher and rag-api the only consumer of the status topic, dropping the duplicate is trivial cleanup — deferred.
- **Structured error-code taxonomy**: any `error_code` values beyond the existing `"UNKNOWN"` default are out of scope and deferred.
- **Widening `classify_error`**: widening its transient/permanent heuristics (e.g., for genuinely transient-but-unrecognized failures) is out of scope; manual reprocess remains available.
- **Retry/backoff mechanics**: Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals are untouched; only the reporting of retryability changes.
- **Stale-lease sweep behavior**: unchanged; its direct failure write already conforms to the contract.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>