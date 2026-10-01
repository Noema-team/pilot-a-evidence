Investigation complete. The worker-side evidence (one-key failure payload `{"error": str(e)}` in `process_document`, `classify_error()` semantics, `run_worker` ACK/NACK usage, the sweep's `error`/`error_stage="processing"`/`retryable=True` write, module-level import-time env requirements) and the API-side evidence (`run_transactional_update` failed branch reading `error_message`/`stage`/`retryable`, persisted schema, emulator branches) and the contract-test infrastructure (`tests/integration/test_api_contracts.py` patterns) were all verified directly. Producing the contracted charter now.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

This cycle fixes the worker→rag-api failure-payload contract mismatch by aligning the rag-worker's failed status payload to the contract rag-api's failed branch already reads, and by locking the seam with a contract test.

Changes land in:

- `apps/ai-server/rag-worker-service/main.py`
  - **Failure payload**: the `process_document` exception handler currently publishes a one-key payload (`{"error": str(e)}`). It will publish `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload never relies on rag-api's fallback defaults for these keys. The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic (rag-api's status subscriber is the only verified consumer today).
  - **Stage tracking**: a stage tracker in `process_document`, set immediately before each pipeline step (convention: set the tracker immediately before the await), reported by the failure handler. Stage names reuse the existing progress-update vocabulary — `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` — with `processing` as the safe value when the stage is genuinely unknown (the same value the stale-lease sweep `_fail_if_still_stale` already writes to `error_stage`, so the field never regresses to null).
  - **retryable derivation**: derived from the existing `classify_error()` — transient-classified errors → `true`; permanent-classified errors, including unclassified-unknown per `classify_error`'s conservative default, → `false`. This mirrors the ACK/NACK decisions `run_worker` already makes from the same function, so the persisted record agrees with what Pub/Sub actually does with the message.
- **A contract test** for the worker failure → rag-api persistence path, extending the existing contract-test infrastructure (`apps/ai-server/tests/integration/test_api_contracts.py` and its fixture-/static-contract patterns). It must import both sides rather than restate the contract in a fixture: construct the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes (both services have verified `FIRESTORE_EMULATOR_HOST` branches), assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and include a key-set drift guard (covering the new keys and the retained legacy `error` key) so a future key edit on either side fails the build. Coverage on representative stages — an early-stage failure and a late-stage failure — pins the stage-tracker mechanism without ossifying every pipeline step.

Explicitly not changed — rag-api is the fixed reference: `run_transactional_update`'s failed branch keeps reading `error_message`/`stage`/`retryable` and persisting `error`/`error_stage`/`retryable` on the main document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) in the `processing/summary` error subdocument. Verified current behavior that stays as-is: `error ← details.get("error_message", "Processing failed")`, `error_stage ← details.get("stage")`, `retryable ← details.get("retryable", True)`.

Verified implementation constraint for the test: importing the worker's `main.py` executes module-level code that requires `GCP_PROJECT` in the environment, raises `RuntimeError` if `GOOGLE_APPLICATION_CREDENTIALS` is unset, and constructs a Pub/Sub subscriber — so the contract test must seed environment variables or isolate the import for the worker side. The existing suite already imports rag-api's `main` module, so the pattern exists on that side; the worker-side import handling is an implementation detail to resolve during the build.

One deliberate behavior change, declared up front: unclassified-unknown exceptions currently persist `retryable: true` (rag-api's silent default) but classify as permanent — after this change they persist `retryable: false`. That is `classify_error`'s intended conservatism; manual reprocess via `POST /process` is unaffected.

## Purpose

Every worker-originated failure currently lands in Firestore as a lie. The worker's exception handler publishes `{"error": str(e)}` while rag-api's failed branch reads three keys it will never find, so every worker failure persists as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true` — on the main document and, inherited, in the `processing/summary` error subdocument with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures, and the retryable flag does not reflect what actually happens to the message.

The fix direction is chosen by the repository's own shape: `error`/`error_stage`/`retryable` are already the established persisted failure schema on three other write paths (the worker's stale-lease sweep, rag-api's `/process` and `POST /resources` enqueue-failure paths) and in the `Resource` model and `ResourceResponse` (retryable defaults `True`). The worker's status publisher is the only writer that doesn't speak this schema — align the odd one out. No Firestore migration, no field rename, no backfill, no reader changes.

The deeper goal is truthfulness and an enforced contract. Deriving `retryable` from `classify_error()` makes the persisted record agree with the worker's actual ACK/NACK behavior: transient means Pub/Sub will redeliver; permanent means the message was acked and manual reprocess via `POST /process` is the path. And the contract test converts this seam from implicit to enforced — this bug was created by two sides drifting apart with nobody testing the joint, and the drift guard ensures a future key edit fails the build instead of silently re-creating it.

## Requirements

1. **Worker failure payload.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived) — the payload must never rely on rag-api's fallback defaults for these keys.
2. **Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names must reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. Convention: set the tracker immediately before each awaited pipeline step.
3. **Persistence outcomes with no rag-api change.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage (with `error.code` remaining `"UNKNOWN"` since no code is sent). rag-api already implements this; this cycle must not alter it, only verify it.
4. **retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
5. **Contract test.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. It must fail if either side's payload keys drift, and it must cover representative stages (early-stage and late-stage failures) so the stage tracker cannot be removed or bypassed silently.

## Boundaries

Must:
- The worker aligns to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema.
- Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures.

Must not:
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- No changes to rag-api's failed-branch reads or persisted schema.

Prefer:
- Retain the legacy `error` key in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.

Prefer not:
- Introducing a structured error-code taxonomy (`error_code` values) in this fix.

Non-goals (out of scope):
- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage` (`"processing"`)/`retryable: true` consistently with this contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy — the `processing/summary` error.code remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here; deferred).

## Version bump

None. No version-bearing artifacts are touched: neither service tree contains package or version metadata (verified directory listings for `rag-worker-service` and `rag-api-service` show no version files; services are containerized and versioned by image build), and no changelog or semver surface exists in the changed scope. This cycle introduces no version convention.

## Deferred items

- **Companion D3 issue** — the Objective references a D3 issue filed alongside this one; its scope is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred.
- **Reconciling with the original D4 deviation note** in `plans/upload-flow.md` — that file is not present in the current tree; the reference exists only in the Objective text. Deferred.
- **Structured error codes / failure taxonomy** — the `processing/summary` `error.code` stays `"UNKNOWN"` unless a code is actually sent; a taxonomy is a prefer-not and out of scope.
- **Retry/backoff mechanics** — Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals; only the reporting of retryability changes.
- **Stale-lease sweep behavior** — unchanged by design; its write already matches the contract.
- **Frontend/mobile changes** — `ResourceResponse` already exposes `error`/`error_stage` (and `retryable` per the authoritative Definition) to clients.
- **Dropping the legacy `error` key** from the worker payload once a consumer audit confirms rag-api is the only consumer of the status topic — trivial follow-up cleanup, deliberately not in this cycle.
- **Widening `classify_error`** to recognize more transient conditions — accepted tradeoff: unrecognized-but-genuinely-transient failures will persist `retryable: false` until then; manual reprocess via `POST /process` remains available.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>