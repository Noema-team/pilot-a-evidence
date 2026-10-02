<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

## 1. Source of truth

This document implements the authoritative Definition artifact `definition:obj-108`
(WorkItem `wi-define-108-a8`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`).
It restates that Definition as verifiable requirement items and records the implementation
decisions the Definition left open (stage-to-step mapping, test layering). Nothing here
widens, narrows, or reinterprets the Definition. Where a statement could not be verified
against the repository during investigation, it is explicitly marked as unverified (§9).

## 2. Problem statement (verified against repository)

- `apps/ai-server/rag-worker-service/main.py` — `process_document`'s exception handler
  publishes the `failed` status with `details = {"error": str(e)}` via `_publish_status_update`.
- `apps/ai-server/rag-api-service/main.py` — `run_transactional_update`'s failed branch reads
  three keys from `details` and persists them:
  - main document: `error ← details.get("error_message", "Processing failed")`,
    `error_stage ← details.get("stage")`, `retryable ← details.get("retryable", True)`
  - `processing/summary` subdocument: `error = {code: details.get("error_code", "UNKNOWN"),
    message: details.get("error_message", "Processing failed"), stage: details.get("stage")}`
    and top-level `stage ← details.get("stage", "unknown")`.
- Because the worker sends only `error`, every worker-originated failure persists the fallback
  message `"Processing failed"`, `error_stage = None`, and a fabricated `retryable = true`;
  the summary error subdocument inherits the same fallbacks with `code = "UNKNOWN"`.
- The established persisted failure schema is `error` / `error_stage` / `retryable`: the
  worker's stale-lease sweep (`_fail_if_still_stale`) writes it directly
  (`error_stage: "processing"`, `retryable: True`), rag-api's enqueue-failure paths write it,
  and both `models/resource.py` (`Resource`, `retryable` defaults `True`) and rag-api's
  `ResourceResponse` (`error`, `error_stage`) expose it. The worker's status publisher is the
  only writer that does not speak this contract.

## 3. Scope

**In scope**
- The worker's failure-payload construction: keys, stage tracking, retryable derivation.
- A dependency-light worker-side module extraction so the contract surface is importable by
  tests without the worker's heavy ML/PDF dependencies (see architecture §3.4).
- Contract test(s) pinning the worker → rag-api failure seam on both sides.

**Out of scope** — see §8 (non-goals).

## 4. Functional requirements

### FR-1 — Failure payload keys (worker)
Every worker-originated `failed` status payload's `details` MUST contain exactly these
contract keys, populated at failure time:

| Key | Value | Source |
|---|---|---|
| `error_message` | the actual exception message (`str(e)`) | exception handler |
| `stage` | the pipeline stage executing at failure time (FR-2) | stage tracker |
| `retryable` | deliberately derived boolean (FR-3) | `classify_error(e)` |
| `error` | mirror of `error_message` (legacy hedge, FR-4) | exception handler |

The payload MUST NOT rely on rag-api's fallback defaults (`"Processing failed"`, `None`,
`True`) for any of `error_message`, `stage`, `retryable`. The existing message envelope
(`user_id`, `course_id`, `resource_id`, `status`, `details`, `timestamp`, `sequence`, and the
`jobId` key `_publish_status_update` injects into `details`) is unchanged.

### FR-2 — Stage tracking (worker)
- `process_document` MUST track the currently executing pipeline stage in a local variable
  that is set immediately before each pipeline step and read by the exception handler.
- Stage names MUST reuse the existing progress-stage vocabulary:
  `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`,
  `chunking_complete`, `embeddings_complete`.
- `"processing"` is the safe value when the stage is genuinely unknown; `stage` MUST never be
  absent or `None` in a failure payload.
- The step-to-stage mapping is fixed in architecture §3.2 and MUST be followed; in particular,
  failures during the post-embedding tail (old-vector deletion, vector storage, metadata save)
  report `embeddings_complete`, the last vocabulary entry of the executing phase.

### FR-3 — Retryable derivation (worker)
- `retryable` MUST be derived explicitly as `classify_error(e)`:
  - transient-classified errors → `retryable: true`
  - permanent-classified errors, including unclassified-unknown exceptions
    (`classify_error`'s conservative default) → `retryable: false`
- The derivation MUST use the same `classify_error` call that drives ACK/NACK decisions in
  `run_worker`, so the persisted record stays aligned with actual Pub/Sub redelivery behavior
  (transient = will be redelivered; permanent = acked, manual reprocess via `POST /process`
  remains available).

### FR-4 — Legacy key hedge (worker)
The failure payload MUST retain the legacy `error` key with the same string as
`error_message`, for continuity with any existing consumers of the `rag-status-updates`
topic and log tooling. rag-api ignores this key (it reads `error_message`); no behavior
change results on the API side.

### FR-5 — rag-api persistence unchanged (API)
- rag-api's failed branch MUST persist worker-provided values unchanged:
  main document `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`;
  `processing/summary` error subdocument `message` and `stage` carrying the same values.
- No change to rag-api's reads, persisted field names, transition table, or fallback defaults.
  The `details.get("retryable", True)` fallback remains in the code but MUST NOT be the
  operative mechanism for worker failures (FR-1 guarantees the key is always present).
- `summary.error.code` remains `"UNKNOWN"` unless an `error_code` key is actually sent
  (none is; see non-goal on error taxonomies).

### FR-6 — Contract test
A contract test MUST cover the worker failure → rag-api persistence path:
- It MUST exercise the worker's failure-payload construction and rag-api's failed-branch
  persistence using both sides' real code (no restated fixture constants for the contract keys).
- It MUST assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values.
- It MUST fail if either side's payload keys drift (worker key construction or API key reads).
- It MUST pin representative stages (an early-stage value and a late-stage value) so the
  stage tracker cannot be silently removed or bypassed.
- Layering and placement per architecture §4; the emulator-backed layer MUST run in CI.

### FR-7 — No migration
The fix MUST NOT require a Firestore migration, field rename, or backfill. Persisted fields
keep their names (`error`, `error_stage`, `retryable`) and semantics. Existing documents that
already hold fallback values are left as-is (historical data, not rewritten).

### FR-8 — Vocabulary discipline
Stage tracker values are limited to the FR-2 vocabulary plus `"processing"`. No new stage
names are introduced by this fix.

## 5. Constraints (from the Definition, binding)

- **MUST** align the worker to rag-api's existing contract (`error_message`/`stage`/`retryable`)
  rather than changing rag-api's reads or persisted schema.
- **MUST NOT** require a Firestore migration, field rename, or backfill.
- **MUST** send `retryable` explicitly on every worker failure payload; the API-side
  `details.get("retryable", True)` fallback must not be operative for worker failures.
- **PREFER** retaining the legacy `error` key alongside `error_message` (FR-4).
- **PREFER NOT** to introduce a structured error-code taxonomy (`error_code` values).

## 6. Acceptance criteria

| # | Criterion (from Definition) | Verified by |
|---|---|---|
| AC-1 | A failed job's published payload contains `error_message` (actual message), `stage` (failing stage), `retryable` (deliberately derived) — none relying on rag-api's fallbacks. | FR-1/2/3; contract-test layer L1 (builder key-set + derivation assertions, handler wiring guard) |
| AC-2 | After a failed job, the persisted resource document has `error` = actual message (not `"Processing failed"`), `error_stage` = failing stage (not `None`), `retryable` = the worker's derived value. | FR-5/6; contract-test layer L2 (emulator end-to-end, sentinel values) |
| AC-3 | The `processing/summary` error subdocument carries the same message and stage as the main document. | L2 assertions on `error.message` / `error.stage` / top-level `stage` |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes, failing if either side's payload keys drift. | FR-6; L1 + L2 combined; CI runs L2 against the Firestore emulator |

## 7. Deliberate behavior changes (accepted)

- Unclassified-unknown exceptions: previously persisted `retryable: true` (silent fallback);
  now persist `false` (they classify permanent under `classify_error`'s conservative default).
  This prevents infinite retry loops and matches the worker's actual ACK behavior; manual
  reprocess via `POST /process` is unaffected.
- Permanent-classified failures generally: `retryable` moves from the fabricated `true` to
  the derived `false`.
- `error` and `error_stage` move from fallback/`None` to the worker's actual values.
- The stale-lease sweep's direct write (`retryable: true`, `error_stage: "processing"`) is
  unchanged and remains correct: a dead worker is a transient condition by nature.

## 8. Non-goals

- Changing the stale-lease sweep's direct failure write.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat
  intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`
  to clients (it does not expose `retryable`; no client change is needed or made).
- Introducing structured error codes or a failure taxonomy — `summary.error.code` stays
  `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this payload alignment (its content is
  unavailable in this context; deferred).
- Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md`
  (that file is not present in the current tree; the reference comes from the Objective text).

## 9. Unverified items / to confirm at implementation

These were not verifiable during investigation and MUST be checked, not assumed:
- Contents of `apps/ai-server/rag-worker-service/exceptions.py` (file exists, unread). Before
  adding the new light module, check it for overlap with the exception classes /
  classification logic; consolidate there if it already houses equivalents (architecture §3.4).
- Layout and conftest behavior of `apps/ai-server/rag-api-service/tests/` — determines the
  final home of the emulator-backed test layer L2 (architecture §4.3).
- Whether the dev/CI environment already runs the Firestore emulator for tests — determines
  the CI wiring that makes L2 mandatory rather than skipped (architecture §4.4).
- Any consumers of the `rag-status-updates` topic other than rag-api's status subscriber —
  unaudited; FR-4 is the hedge. A later audit may retire the legacy `error` key (trivial
  cleanup: drop the key, update the L1 key-set assertion).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>