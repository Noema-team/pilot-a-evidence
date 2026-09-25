<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
**Cycle Charter — rag-worker → rag-api failure payload contract alignment**
Run 8b06a314-f151-4c92-a50a-f2fee0c84232 · Iteration 1 · Step: scoping.produce
Authoritative scope source: WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c…e89cac5`). This charter encodes that Definition without widening, narrowing, or reinterpreting it.

## Scope

**In scope — implementation:**

- **`apps/ai-server/rag-worker-service/main.py` — failure publisher alignment:**
  - The failed-status payload published via `_publish_status_update` from `process_document`'s exception handler carries `error_message` (the actual exception message), `stage` (the pipeline stage executing at failure time), and `retryable` (deliberately derived). The payload never relies on rag-api's fallback defaults for these keys.
  - The legacy `error` key is retained alongside `error_message` as a compatibility hedge for any unknown consumer of the status topic (Definition constraint "prefer"; fact F11).
  - **Stage tracking:** a local stage tracker in `process_document`, set immediately before each pipeline step and reported by the failure handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`); `"processing"` is the safe value when the stage is genuinely unknown — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.
  - **Retryable derivation:** `retryable` is set from `classify_error(e)` — transient-classified errors map to `true`; permanent-classified errors, including unclassified-unknown per `classify_error`'s conservative default, map to `false`. `classify_error` remains the single derivation source; no additional derivation paths are introduced. Accepted behavior change: unclassified-unknown failures flip from the silently-defaulted `true` to a deliberate `false` (manual reprocess via `POST /process` remains available).
- **Contract test (new)**, following the house pattern in `apps/ai-server/tests/integration/test_api_contracts.py` (verified present during investigation; `rag-worker-service/tests/integration/` is currently empty, and this test spans both services, so the cross-service integration location is the right home):
  - Builds the failure payload through the worker's code path and feeds it through rag-api's `run_transactional_update` failed branch against the Firestore emulator or fakes — importing both sides rather than restating the contract in a fixture.
  - Asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, and that the processing/summary error subdocument carries the same message and stage.
  - Includes a key-set drift guard so a future edit to either side's payload keys fails the build.
  - Covers representative stages — an early-stage failure and a late-stage failure — pinning the tracker mechanism without ossifying every pipeline step.
  - Test-harness support is in scope: `apps/ai-server/tests/integration/conftest.py` currently places only `rag-api-service` on `sys.path` (verified); extending the import/stub setup so the worker module is importable there is part of this work.
- **`apps/ai-server/rag-api-service` runtime code: expected unchanged.** Its failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` (Definition F4). Any change is limited to what the contract test needs (test seams/fakes) and must not alter reads or the persisted schema.

**Investigation corroboration (directly verified this cycle, supporting the Definition's repository-claims):** `models/resource.py` exposes `error`, `error_stage`, and `retryable` (default `True`) on the `Resource` model and its dict serialization; `test_api_contracts.py` exists at the stated path; `plans/upload-flow.md` is absent from `plans/` (consistent with F12).

## Purpose

- The worker publishes failures as `{"error": str(e)}` while rag-api's failed branch reads `error_message`/`stage`/`retryable`. Every worker-originated failure therefore persists the fallback string `"Processing failed"`, `error_stage: None`, and a silently-defaulted `retryable: true` — users and support cannot disambiguate failures (F1, F5). The `processing`/`summary` error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.
- The fix direction is worker-side alignment because `error`/`error_stage`/`retryable` is already the established persisted schema across three other write paths (worker stale-lease sweep, rag-api's `/process` and `POST /resources` enqueue-failure paths) and both API response/model surfaces (F2, F6). Changing the worker is the change that does not ripple: no migration, no backfill, no reader changes.
- `retryable` becomes truthful: derived from the same `classify_error()` classification that drives ACK/NACK in `run_worker`, so the persisted record matches actual retry behavior — transient means Pub/Sub will redeliver; permanent means acked with manual reprocess available. The stale-lease sweep's separate `retryable: true` write stays correct (a dead worker is a transient condition).
- The seam gets pinned: the contract test turns future key drift on either side into a build failure instead of a silently re-created bug.
- Assumption status carried from the Definition: the `classify_error`-based retryable default (F8) and the legacy-`error`-key hedge (F11) are ASSUMED facts, adopted exactly as specified.

## Requirements

1. **Failure payload completeness** — when document processing fails, the worker's failed status payload includes `error_message` (actual exception message), `stage` (pipeline stage executing at failure time), and `retryable` (deliberately derived); it never relies on rag-api's fallback defaults for these keys.
2. **Stage tracking** — the worker tracks the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage; stage names reuse the existing progress-stage vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`), with `"processing"` as the safe value when the stage is genuinely unknown.
3. **rag-api persistence unchanged in behavior** — the failed branch persists the worker-provided values unchanged: main document `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`; the processing/summary error subdocument carries the same message and stage.
4. **Explicit retryable derivation** — aligned with the worker's ACK/NACK behavior: errors classified transient by `classify_error` → `retryable` true; classified permanent (including unclassified-unknown, per its conservative default) → `retryable` false.
5. **Contract test** — covers the worker failure → rag-api persistence path: exercises the worker's failure-payload construction through rag-api's failed-branch persistence (via the Firestore emulator or fakes) and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values; it fails if either side's payload keys drift.

**Binding constraints (from the Definition):**

- Must: align the worker to rag-api's existing contract — not change rag-api's reads or persisted schema; every worker-originated failure payload carries `retryable` explicitly.
- Must not: require a Firestore migration, field rename, or backfill; the persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics.
- Prefer: retain the legacy `error` key alongside `error_message`.
- Prefer not: introduce a structured error-code taxonomy (`error_code` values); the summary `error.code` remains `"UNKNOWN"` unless a code is actually sent.

## Boundaries

**Out of scope (Definition non-goals):**

- The stale-lease sweep (`_fail_if_still_stale`) — unchanged; it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- Retry/backoff mechanics — Pub/Sub ACK/NACK policy, processing leases, and heartbeat intervals are untouched; only the *reporting* of retryability in the payload changes.
- Frontend or mobile changes — none; `ResourceResponse` already exposes `error` and `error_stage` to clients.
- Structured error codes or a failure taxonomy — none introduced.
- rag-api's reads and persisted schema — unchanged; the worker aligns to the API, never the reverse.
- Widening `classify_error`'s classification heuristics — the `retryable=false`-for-unclassified behavior change is accepted as-is.
- Anything the companion D3 issue covers beyond this worker→rag-api failure payload alignment — deferred (see below).

**Accepted risks (from the Definition's analysis):** unknown consumers of the status topic reading the old key set (mitigated by retaining `error`; residual risk accepted as low); stage-tracker drift as the pipeline evolves (mitigated by the update-before-await convention and representative-stage test coverage); the contract test ossifying the payload (intentional — that is the drift guard working).

## Version bump

- **rag-worker-service:** patch-level bump recommended — failure-path behavior change (payload keys, stage reporting, retryable derivation) with no schema, migration, or client-facing API change.
- **rag-api-service:** no bump expected — no runtime behavior change; test-only additions.
- No repo-wide version manifest was verified during investigation; apply the bump wherever the affected services declare versions, to be confirmed at implementation time. No new runtime dependencies are introduced, so no dependency bumps are required.

## Deferred items

- **Companion D3 issue** referenced by the Objective — its content is unavailable in this context; anything it covers beyond the worker→rag-api failure payload alignment is outside this cycle (F12).
- **Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`** — that file is not present in the current tree (verified: absent from `plans/`); the reference exists only in the Objective text.
- **Dropping the legacy `error` key** from the worker's failure payload — future cleanup, trivial once an audit confirms rag-api's status subscriber is the only consumer of the status topic (F11 hedge).
- **Widening `classify_error`'s heuristics** (e.g., recognizing additional transient patterns) — a separate concern; out of scope for this cycle.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>