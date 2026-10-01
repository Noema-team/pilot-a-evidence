Investigation complete. Producing the contracted charter from the verified evidence.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter — rag-worker → rag-api failure payload contract alignment

Cycle intent: "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"

Authoritative source: WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). This charter scopes the cycle from that Definition; it does not widen, narrow, or reinterpret it.

## Scope

**Statement.** Align the rag-worker's failed-status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — locked in by a contract test on the worker→rag-api failure path. The worker aligns to the API; rag-api's reads and persisted schema are untouched.

**Deliverables** (all within `apps/ai-server`):

1. **rag-worker-service/main.py — failure payload.** The `failed` status published by `process_document`'s exception handler currently carries only `{"error": str(e)}` (verified). It must carry `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The legacy `error` key is retained alongside `error_message` as the compatibility hedge for unknown consumers of the status topic.
2. **rag-worker-service/main.py — stage tracking.** `process_document` is one large try block with no stage state at failure time (verified). Add a stage tracker set immediately before each pipeline await; stage names reuse the existing progress-update vocabulary — `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete` — with `"processing"` as the safe value when the stage is genuinely unknown (the same value the worker's stale-lease sweep writes for `error_stage`). The vocabulary is closed for this cycle: no new stage names.
3. **rag-worker-service/main.py — retryable derivation.** Derive `retryable` from `classify_error(e)` in the failure handler (the exception object is in scope there): transient classification → `true`; permanent classification, including unclassified-unknown (`classify_error`'s conservative default returns False — verified), → `false`.
4. **Contract test.** A new test under `apps/ai-server/tests/integration/` that imports both sides rather than restating the contract in a fixture: builds the worker's failure payload through the worker's code path, feeds it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes, and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values. Includes a payload key-set drift guard so a future edit to either side's keys fails the build. House pattern: `tests/integration/test_api_contracts.py` (fixture- and AST-based static contract tests) with `conftest.py`'s mocked cloud dependencies; both services support hermetic emulator modes (verified for rag-api's `FIRESTORE_EMULATOR_HOST` startup branch).
5. **rag-api-service: no production code change.** Its failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` on the main document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) in the `processing/summary` error subdocument (verified). It is the alignment target and is exercised by the test as-is.

**Verified evidence anchors** (read during investigation; line numbers approximate):
- `rag-worker-service/main.py`: `classify_error` (~L35–80, unknown → False); `process_document` pipeline and exception handler publishing `{"error": str(e)}` (~L975–1129); progress-stage vocabulary in `_publish_status_update` calls (~L979–1090); `_publish_status_update` message envelope (~L1527); `run_worker` ACK/NACK decisions via `classify_error` (~L2136–2160); `_fail_if_still_stale` direct write of `error` / `error_stage="processing"` / `retryable=True` (~L2193–2216).
- `rag-api-service/main.py`: `run_transactional_update` failed branch — main-doc keys and fallbacks (`details.get("error_message", "Processing failed")`, `details.get("stage")`, `details.get("retryable", True)`) (~L233–236) and summary `error` subdocument with `error_code` default `"UNKNOWN"` (~L265–269); emulator startup branch (~L82–97).
- `rag-api-service/models/resource.py`: `Resource` exposes `error`/`error_stage`/`retryable` with `retryable` defaulting True (~L52–55).
- `tests/integration/test_api_contracts.py` + `tests/integration/conftest.py`: existing contract-test pattern and cloud-dependency mocking.

## Purpose

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam. The worker publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`). Every worker-originated failure therefore lands in Firestore as the fallback string "Processing failed", a null `error_stage`, and a fabricated `retryable: true`; the `processing/summary` error subdocument inherits the same fallbacks with `error_code` always "UNKNOWN". Users and support cannot disambiguate failures, and the persisted `retryable` misrepresents what the worker actually decided — it already classifies every exception as transient or permanent for ACK/NACK purposes but never reports that classification.

The fix direction is deliberate: `error`/`error_stage`/`retryable` is already the established persisted failure schema — the worker's stale-lease sweep, rag-api's enqueue-failure paths, and the `Resource` model / `ResourceResponse` all speak it. The worker's status publisher is the only writer that doesn't. Aligning the worker requires no schema migration, field rename, or backfill, and makes the persisted record tell the truth: transient errors are ones Pub/Sub will redeliver (`retryable: true`); permanent errors were acked and will not return (`retryable: false`, with manual reprocess via `POST /process` unaffected). One deliberate, accepted behavior change follows: unclassified-unknown exceptions currently persist `retryable: true` via the silent default and will now persist `false` — the conservatism `classify_error` was written for.

## Requirements

Binding requirements, carried from the authoritative Definition:

- **R1 — Failure payload completeness.** When document processing fails, the worker's failed status payload must include `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload must never rely on rag-api's fallback defaults for these keys. (Legacy `error` key retained alongside `error_message` per the adopted hedge.)
- **R2 — Stage tracking.** The worker must track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown. Convention: set the tracker immediately before the await. Implementation note: pipeline steps without a dedicated vocabulary name (e.g., old-vector deletion and vector storage, which run after `embeddings_complete` is published) report the last-set stage under this convention; the contract test pins representative early- and late-stage failures rather than every step.
- **R3 — rag-api persistence fidelity.** rag-api's failed branch must persist the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the `processing/summary` error subdocument must carry the same message and stage. (No rag-api code change: the existing branch already does this once the payload speaks its keys — the requirement is that the test prove it.)
- **R4 — Explicit retryable derivation.** The derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable: true`; classified permanent (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`.
- **R5 — Contract test with drift guard.** A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it must fail if either side's payload keys drift.

**Acceptance bar** (the cycle is done when all hold):

- A1: A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults.
- A2: After a failed job, the persisted resource document has `error` = the worker's actual error message (not "Processing failed"), `error_stage` = the failing stage (not None), and `retryable` = the worker's derived value.
- A3: The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document.
- A4: The contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift.

## Boundaries

**Hard constraints (must / must_not):**

- The worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`); rag-api's reads and persisted schema are not changed.
- No Firestore migration, field rename, or backfill of existing documents; the persisted fields `error`, `error_stage`, `retryable` keep their names and semantics.
- Every worker-originated failure payload carries `retryable` explicitly; rag-api's `details.get("retryable", True)` fallback must not be the operative mechanism for worker failures. (The fallback code itself stays — rag-api is unchanged — it simply never fires for worker failures.)

**Adopted preferences:**

- The legacy `error` key is retained in the worker's failure payload alongside `error_message`, for continuity with any existing consumers of the status topic and log tooling.
- No structured error-code taxonomy is introduced; the summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.

**Out of scope (non-goals):**

- Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Changing retry/backoff mechanics — Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the reporting of retryability in the payload changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Introducing structured error codes or a failure taxonomy.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable here; deferred).

**Accepted tradeoffs:**

- Unknown consumers of the status topic reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- Stage-tracker drift as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- `retryable: false` for unclassified-unknown errors may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope and manual reprocess via `POST /process` remains.
- The contract test ossifies the payload key set — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Version bump

- **rag-worker-service: patch.** Changes are corrective and additive: the failure payload gains `error_message`/`stage`/`retryable` while retaining legacy `error`; persisted `retryable` for unclassified-unknown failures flips from the silent `true` to the derived `false`. No schema change, no client-facing field rename (`ResourceResponse` untouched), no breaking contract change.
- **rag-api-service: none.** No production code change; the service is only exercised by the new test.
- **tests: additive only**, no bump.
- Caveat: no version manifest or release-versioning file was verified during investigation. The binding content of this section is the bump level per component; if release tooling tracks service versions elsewhere, apply the patch bump at that location.

## Deferred items

- **Companion D3 issue.** The Objective references a companion D3 issue filed alongside this one; its scope is not available in this context. Anything it covers beyond the worker→rag-api failure payload alignment is deferred (Definition F12).
- **plans/upload-flow.md D4 reconciliation.** The Objective cites original analysis in `plans/upload-flow.md` as deviation D4; the Definition states that file is not present in the current tree (not independently verified during investigation — the reference comes from the Objective text). Reconciling this cycle's analysis with that note is deferred.
- **Structured error-code taxonomy / failure taxonomy.** Deferred; `error_code` stays "UNKNOWN" unless actually sent.
- **Retry/backoff mechanics.** ACK/NACK policy, processing leases, heartbeat intervals — deferred beyond the reporting change in scope.
- **Stale-lease sweep behavior.** Its direct failure write already matches the contract; any change to it is deferred.
- **Frontend/mobile work.** Deferred; `ResourceResponse` already exposes `error`/`error_stage`.
- **Dropping the legacy `error` key.** If a later audit confirms the worker is the only publisher and rag-api the only consumer of the status topic, dropping the duplicate is trivial cleanup — deferred, not part of this cycle.
- **Widening `classify_error` coverage.** Recognizing additional transient shapes is deferred; the `retryable: false`-for-unclassified tradeoff is accepted this cycle.

**Carried unknowns** (preserved, not resolved by this charter): whether any undocumented consumer of the status topic exists (assumed none per the Definition's F11 — the hedge is retained regardless); whether a version manifest exists in-repo (see Version bump); the full content of the companion D3 issue.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>