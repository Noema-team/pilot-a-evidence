<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api failure payload contract alignment

- Cycle: `652fa48d-0d0e-45e6-a7a1-6ea36aed926b` (iteration 1, step: design)
- Intent: rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage
- Authoritative source: WorkItem `wi-define-108-a8`, artifact `definition:obj-108`, sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`
- Requirement keywords MUST / MUST NOT / SHOULD / MAY are used with RFC 2119 semantics.

## 1. Problem statement

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and no test covers the seam. The worker's exception handler in `process_document` publishes a one-key payload `{"error": str(e)}` via `_publish_status_update` (F3); rag-api's failed branch in `run_transactional_update` reads three keys — `error_message`, `stage`, `retryable` (F4). Every worker-originated failure therefore persists in Firestore as the fallback string `"Processing failed"`, a null `error_stage`, and a fabricated `retryable: true` (F5). The `processing`/summary error subdocument inherits the same fallbacks with `error_code` always `"UNKNOWN"`.

The persisted failure schema `error` / `error_stage` / `retryable` is already established across three other write paths (worker stale-lease sweep `_fail_if_still_stale`, rag-api enqueue-failure paths `/process` and `POST /resources`) and two response/model surfaces (`ResourceResponse`, `Resource` model with `retryable` defaulting `True`) (F6). The worker's status publisher is the only writer that does not speak it.

## 2. Scope

### 2.1 In scope
- The worker's failure-status payload construction in `apps/ai-server/rag-worker-service/main.py` (`process_document` exception handler → `_publish_status_update`).
- Stage tracking through `process_document` so the failure handler can report the true failing stage.
- Deliberate derivation of `retryable` from the worker's existing `classify_error()` classification.
- A contract test covering the worker failure → rag-api persistence path, including a key-set drift guard.

### 2.2 Out of scope (non-goals, binding)
- Changing the stale-lease sweep's direct failure write (`_fail_if_still_stale`) — already consistent with the contract.
- Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeat intervals — only the *reporting* of retryability changes.
- Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage`.
- Introducing structured error codes or a failure taxonomy — the summary error `code` remains `"UNKNOWN"` unless a code is actually sent.
- Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred, F12). Reconciling with the original D4 deviation note in `plans/upload-flow.md` is likewise deferred (that file is not present in the current tree).

## 3. Terms and contract vocabulary

- **Failure status payload**: the `details` mapping the worker publishes with a failed status via `_publish_status_update` (F3).
- **Failed branch**: the failure-handling path of rag-api's `run_transactional_update` (F4).
- **Persisted failure fields**: `error`, `error_stage`, `retryable` on the main resource document (F6).
- **Stage vocabulary** (fixed set, from the worker's existing progress-update tokens, F9 + definition requirement): `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`, plus the safe value `processing`. The token `completed` is the success terminal and MUST NOT appear as a failure stage.
- **retryable (persisted semantics)**: `true` means the failure is classified transient and Pub/Sub redelivery is expected; `false` means the error was classified permanent (acked, will not return) and manual reprocess via `POST /process` remains available (F7, F8).

## 4. Functional requirements

### FR-1 — Failure payload carries the contract keys (MUST)
When document processing fails, the worker's failed status payload MUST include:
- `error_message` — the actual exception message,
- `stage` — the pipeline stage executing at failure time,
- `retryable` — a deliberately derived boolean.

The payload MUST NOT rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for any of these keys. Evidence: F1, F3, F4, F5. Verifies acceptance A1.

### FR-2 — `error_message` is the actual exception message (MUST)
`error_message` MUST be the message of the caught exception (`str(e)`), preserving the worker's current message-extraction behavior (F3). No fabricated fallback string MAY be introduced on the worker side. Edge case: if `str(e)` is empty, the persisted `error` will be empty — accepted (see §8); introducing a fallback would reintroduce the class of bug being removed.

### FR-3 — Stage tracking through `process_document` (MUST)
The worker MUST track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage. Constraints:
- Stage values MUST come from the stage vocabulary in §3 (reuse of existing progress tokens; no new tokens such as `tagging`).
- The safe value `processing` MUST be used when the stage is genuinely unknown (e.g., failure before the first stage transition) — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.
Evidence: F9, definition requirement 2. Verifies A1, A2.

### FR-4 — `retryable` is derived from `classify_error` (MUST)
The worker MUST derive `retryable` from `classify_error(e)`:
- errors classified **transient** → `retryable: true`;
- errors classified **permanent**, including unclassified-unknown exceptions (per `classify_error`'s conservative default) → `retryable: false`.

`retryable` MUST NOT be a constant or silently defaulted value. This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker` (F7, F8). The derivation table is normative (§5.4). Verifies A1, A2.

### FR-5 — Legacy `error` key retained (SHOULD)
The worker SHOULD retain the legacy `error` key in the failure payload alongside `error_message`, carrying the same message string, as a compatibility hedge for unknown consumers of the status topic and existing log tooling (F11, constraint "prefer"). rag-api's failed branch does not read this key (F4), so it is inert to the API.

### FR-6 — rag-api persistence mapping unchanged (MUST)
rag-api's failed branch MUST persist the worker-provided values unchanged:
- main document: `error` ← payload `error_message`; `error_stage` ← payload `stage`; `retryable` ← payload `retryable`;
- `processing`/summary error subdocument: `message` ← payload `error_message`; `stage` ← payload `stage`; `error_code` remains `"UNKNOWN"` when no code is sent (F4).

No rag-api code change is required to satisfy this — it is the existing behavior once the payload keys match — but it MUST be pinned by the contract test (TR-3, TR-4). Verifies A2, A3.

### FR-7 — No schema motion (MUST NOT)
The fix MUST NOT require a Firestore migration, field rename, or backfill of existing documents. Persisted field names (`error`, `error_stage`, `retryable`) and their semantics MUST NOT change. Existing failed documents are left as-is.

### FR-8 — API-side fallbacks non-operative for worker failures (MUST)
rag-api's `details.get(...)` fallbacks (e.g., `retryable` default `True`) MAY remain in code (constraint: do not change rag-api's reads), but MUST NOT be the operative mechanism for worker-originated failures. This is guaranteed by FR-1 (worker always sends the keys) and verified by TR-2/TR-3.

## 5. Data contract (normative)

### 5.1 Worker failure payload schema

| Key | Type | Required | Source | Notes |
|---|---|---|---|---|
| `error_message` | string | MUST | `str(e)` of the caught exception | actual exception message |
| `stage` | string | MUST | stage tracker in `process_document` | vocabulary token or `processing` |
| `retryable` | bool | MUST | `classify_error(e)` | deliberately derived, never defaulted |
| `error` | string | SHOULD (FR-5) | same string as `error_message` | legacy key; ignored by rag-api's failed branch |

The pinned key set is presence-based: the four keys above MUST (or SHOULD for `error`) be present with correct types/values. Additional keys are not forbidden (rag-api ignores unknown `details` keys per F4), but adding a pinned key later means touching the contract test — that is the drift guard working as intended.

### 5.2 Persistence mapping (rag-api failed branch, unchanged behavior per F4)

| Payload key | Main document field | `processing`/summary error subdocument |
|---|---|---|
| `error_message` | `error` | `message` |
| `stage` | `error_stage` | `stage` |
| `retryable` | `retryable` | not evidenced — do not assert |
| `error` (legacy) | not read; ignored | not read; ignored |
| (none sent) | — | `error_code` = `"UNKNOWN"` (API-side default) |

### 5.3 Stage vocabulary and tracker assignment

| Pipeline milestone (progress token, F9) | Token used as failure stage |
|---|---|
| Job start | `starting` |
| Text retrieval | `text_retrieved` |
| Tagging | `tagging_complete` |
| Summarization | `summary_generated` |
| Chunking | `chunking_complete` |
| Embeddings | `embeddings_complete` |
| (no assignment yet / genuinely unknown) | `processing` |
| Success terminal | `completed` — never a failure stage |

Assignment rule (normative): the tracker is a function-local in `process_document`, initialized to `processing`, and set immediately before each pipeline step's await to the milestone token whose progress update covers that work. The exact await→token marking is done at implementation by reading `process_document`'s body (its internal structure beyond F3/F9 is not further evidenced here).

### 5.4 `retryable` derivation table (normative; grounded in `classify_error`)

| Exception condition | `classify_error` result | Persisted `retryable` |
|---|---|---|
| Instance of `TransientError` | transient | `true` |
| Instance of `PermanentError` | permanent | `false` |
| `httpx.ConnectError`, `ConnectTimeout`, `ReadTimeout`, `WriteTimeout`, `PoolTimeout`, `ConnectionError`, `TimeoutError`, `asyncio.TimeoutError` | transient | `true` |
| `httpx.HTTPStatusError` with status 429/500/502/503/504 | transient | `true` |
| `httpx.HTTPStatusError` with other 4xx status | permanent | `false` |
| Anything else (including `PDFProcessingError` subclasses from `exceptions.py`, `ValueError`, etc.) | permanent (conservative unknown default) | `false` |

## 6. Verification requirements

### TR-1 — Contract test exists and passes (MUST)
A contract test covering the worker failure → rag-api persistence path MUST exist under `apps/ai-server/tests/integration/` (sibling of `test_api_contracts.py`; proposed name `test_worker_failure_contract.py`). It MUST exercise the worker's failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. Evidence: F10, definition requirement 5. Verifies A4.

### TR-2 — Worker-side key-set pin (MUST)
The test MUST assert the failure payload contains `error_message`, `stage`, `retryable` (and `error` per FR-5) with correct types and values for representative transient and permanent errors. A worker-side key rename/removal MUST fail the build.

### TR-3 — End-to-end value equality (MUST)
The test MUST feed the worker-built payload through rag-api's failed-branch persistence and assert:
- persisted `error` == payload `error_message` (and ≠ `"Processing failed"`);
- persisted `error_stage` == payload `stage` (and ≠ `None`);
- persisted `retryable` == payload `retryable` (and ≠ the silent default where the derived value differs, i.e., `false` cases).

This is the operative API-side drift guard: if rag-api stops reading a payload key, the persisted fallback diverges from the payload and the test fails.

### TR-4 — Subdocument assertions (MUST)
The test MUST assert the `processing`/summary error subdocument carries `message` == payload `error_message`, `stage` == payload `stage`, and `error_code` == `"UNKNOWN"`. Verifies A3.

### TR-5 — Representative stage coverage (MUST)
The test MUST pin the stage-tracker mechanism with an early-stage failure and a late-stage failure (e.g., first and last pipeline dependencies forced to raise), asserting the reported stage equals the expected milestone token in each case. This catches the tracker being removed or bypassed without ossifying every pipeline step.

### TR-6 — Derivation coverage (MUST)
The test MUST include at least one transient-classified error (assert `retryable: true`) and one permanent-classified error including one unclassified-unknown exception (assert `retryable: false`), per §5.4.

### TR-7 — Static API-read-key guard (SHOULD)
A static AST/subprocess check (house pattern of `_get_agent_graph_shapes` in `test_api_contracts.py`) SHOULD pin that rag-api's failed branch reads `error_message`, `stage`, `retryable` from `details`, scoped to the failed-branch region to limit false positives. If AST extraction proves brittle at implementation, TR-3's equality assertions stand as the API-side drift guard and TR-7 MAY be dropped with a documented note.

### TR-8 — Hermetic execution (MUST)
The test MUST run without live GCP services: Firestore emulator mode (both services support `FIRESTORE_EMULATOR_HOST` branches per F10) preferred for real transactional semantics; fakes acceptable where the emulator is unavailable in the environment. No live Pub/Sub is needed — the seam under test is payload→persistence, not transport.

## 7. Constraint compliance

| ID | Constraint (from definition) | Honored by |
|---|---|---|
| C-1 (must) | Align worker to rag-api's existing contract (`error_message`/`stage`/`retryable`); do not change rag-api's reads or persisted schema | FR-1..FR-4 (worker-only code change); FR-6 pins API behavior via test; architecture §5.4 |
| C-2 (must_not) | No Firestore migration, field rename, or backfill; persisted fields keep names/semantics | FR-7 |
| C-3 (must) | Every worker-originated failure payload carries `retryable` explicitly; API-side `details.get("retryable", True)` fallback never operative for worker failures | FR-1, FR-4, FR-8; TR-2, TR-3 |
| C-4 (prefer) | Retain legacy `error` key alongside `error_message` | FR-5 (SHOULD) |
| C-5 (prefer_not) | No structured error-code taxonomy | Non-goal §2.2; TR-4 asserts `error_code` stays `"UNKNOWN"` |

## 8. Deliberate behavior changes (accepted)

1. **Unclassified-unknown exceptions flip persisted `retryable` from `true` to `false`.** Previously the silent API default persisted `true`; now the conservative `classify_error` default (`false`) is persisted. This is the conservatism `classify_error` was written for — it prevents infinite retry loops — and manual reprocess via `POST /process` is unaffected. Accepted per F8 and the definition's risk acceptance.
2. **`PDFProcessingError` subclasses (from `rag-worker-service/exceptions.py`) persist `retryable: false`.** Derived from verified code: that hierarchy subclasses `Exception` directly and is neither `TransientError` nor `PermanentError` nor an httpx type, so it falls into `classify_error`'s conservative branch. This is existing ACK/NACK behavior (F7) now made visible in the payload. Widening `classify_error` is out of scope.
3. **Empty exception messages persist as empty `error`.** No fabricated fallback is introduced; fallbacks are the defect being removed. Potential follow-up, not in scope.

## 9. Acceptance criteria and verification map

| ID | Acceptance criterion (from definition) | Verified by |
|---|---|---|
| A1 | Worker's failed status message contains `error_message` (actual exception message), `stage` (failing pipeline stage), `retryable` (deliberately derived) — none relying on rag-api's fallback defaults | FR-1..FR-4; TR-1, TR-2, TR-6 |
| A2 | Persisted resource document has `error` = worker's actual message (not `"Processing failed"`), `error_stage` = failing stage (not `None`), `retryable` = worker's derived value | FR-6; TR-3 |
| A3 | `processing`/summary error subdocument carries the same message and stage as the main document | FR-6; TR-4 |
| A4 | Contract test covering worker failure → rag-api persistence exists and passes, failing if either side's payload keys drift | TR-1..TR-8 |

## 10. Traceability

| Definition fact | Consumed by |
|---|---|
| F1 (product intent: persist real message/stage/deliberate retryable) | FR-1, FR-2, FR-3, FR-4 |
| F2 (preferred direction: worker aligns to `error_message`/`stage`) | Architecture §1, §10 (alternative rejected) |
| F3 (worker publishes `{"error": str(e)}`) | FR-2, Architecture §3 |
| F4 (rag-api failed-branch reads/persists) | FR-6, §5.2 |
| F5 (fallback persistence today) | §1, TR-3 negative assertions |
| F6 (established `error`/`error_stage`/`retryable` schema) | FR-6, FR-7 rationale |
| F7 (classify_error drives ACK/NACK) | FR-4 |
| F8 (adopted retryable derivation, ASSUMED→adopted) | FR-4, §5.4, §8 |
| F9 (progress stage vocabulary; no failure-stage tracking today) | FR-3, §5.3 |
| F10 (contract-test infra + emulator modes) | TR-1, TR-7, TR-8 |
| F11 (legacy `error` key hedge, ASSUMED) | FR-5 |
| F12 (companion D3 issue deferred) | §2.2 non-goals |

## 11. Unknowns (preserved as unknown; not invented)

- Exact signatures/shapes of `_publish_status_update` and `run_transactional_update` beyond the descriptions in F3/F4 — to be read from the code at implementation.
- The Firestore document path(s) written by rag-api's failed branch. The `Resource` model documents `/users/{userId}/resources/{resourceId}` (verified in `models/resource.py`); other worker paths use course-scoped paths. The contract test MUST seed/read the location the failed branch actually touches, confirmed from rag-api's code at implementation (prefer seeding via rag-api's own helpers).
- Whether the `processing`/summary subdocument persists `retryable` — not evidenced; not asserted (§5.2).
- Import-time behavior of worker `main.py` in the shared integration-test environment (it imports langchain, openai, spacy, sklearn, firebase_admin, langfuse, tiktoken — verified import block). Determines the test import strategy (Architecture §7.2).
- Existence/identity of any status-topic consumers other than rag-api's subscriber — unknown (F11 is an assumption); the legacy `error` key hedge exists precisely because of this unknown.
- Clean mockability of `process_document`'s pipeline dependencies for forced-failure tests — determines TR-5's exact mechanism (Architecture §7.3, T4 fallback).
- Content of the companion D3 issue (F12, DEFERRED) and `plans/upload-flow.md` (absent from tree).
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api failure payload alignment

- Cycle: `652fa48d-0d0e-45e6-a7a1-6ea36aed926b` (iteration 1, step: design)
- Companion normative document: `docs/requirements.md` (FR-*/TR-* IDs referenced below are defined there)

## 1. Design principles

1. **Fix the odd writer out.** The persisted failure schema `error`/`error_stage`/`retryable` is already spoken by three write paths (worker stale-lease sweep, rag-api enqueue-failure paths) and two model surfaces (`ResourceResponse`, `Resource`) (F6). The worker's status publisher is the only deviating writer; the worker aligns to the API, not the reverse. No migration, no backfill, no reader changes.
2. **One source of truth for retryability.** `classify_error()` already decides ACK/NACK in `run_worker` (F7). Deriving the payload's `retryable` from the same function makes the persisted record tell the truth about what will happen next.
3. **Test the seam, don't restate it.** The contract test imports/drives both sides rather than duplicating the contract in a fixture, following the house patterns in `apps/ai-server/tests/integration/test_api_contracts.py` (F10).
4. **Minimal diff, pinned behavior.** rag-api is not modified; its existing failed-branch behavior is pinned by the test so drift fails the build.

## 2. System context and the seam

```
process_document (rag-worker-service/main.py)
    │  on exception: details payload
    ▼
_publish_status_update ──► Pub/Sub status topic ──► rag-api status subscriber
                                                        │
                                                        ▼
                                          run_transactional_update — failed branch
                                                        │
                                                        ▼
                                          Firestore resource document
                                            main: error, error_stage, retryable
                                            processing/summary subdoc: message, stage, error_code="UNKNOWN"
```

**Adjacent writers — explicitly untouched:**
- Worker stale-lease sweep `_fail_if_still_stale`: writes `error`/`error_stage`/`retryable` directly with `retryable=true` — correct as-is (a dead worker is a transient condition); non-goal.
- rag-api enqueue-failure paths (`/process`, `POST /resources`): already contract-consistent; untouched.
- Worker `utils/status_updater.py` (`StatusUpdater`): performs **direct Firestore writes** with a different, `processing`-prefixed field vocabulary (`processingStatus`, `processingStage`, `processingError` — e.g. `ProcessingStage.PDF_DOWNLOAD`). This is **not** part of the worker→rag-api Pub/Sub seam and its `ProcessingStage` enum is a **different vocabulary** from the progress tokens in `main.py`. Pitfall: do not source failure-stage tokens from `models/processing_status.py`; requirement FR-3 mandates the `main.py` progress vocabulary.

## 3. Current failure flow (defect)

1. `process_document` runs one large try block; no stage tracking exists (F9).
2. On any exception, the handler publishes `details = {"error": str(e)}` via `_publish_status_update` (F3).
3. rag-api's failed branch reads `error_message`, `stage`, `retryable` (F4) — none present.
4. Persisted result: `error = "Processing failed"` (fallback), `error_stage = None`, `retryable = True` (silent default); subdoc gets the same fallbacks with `error_code = "UNKNOWN"` (F5).

## 4. Target failure flow

1. `process_document` initializes a stage tracker local to `processing`.
2. Immediately before each pipeline step's await, the tracker is set to that step's milestone token (§6.1).
3. The existing exception handler catches the exception.
4. The handler computes `retryable = classify_error(e)`.
5. The handler builds the payload via a single construction point: `build_failure_payload(str(e), current_stage, retryable)` → `{error_message, stage, retryable, error}`.
6. The payload is published through the existing `_publish_status_update` call (call shape unchanged; exact signature per current code).
7. rag-api's subscriber → `run_transactional_update` failed branch reads the three keys and persists `error`/`error_stage`/`retryable` plus the subdoc `message`/`stage`/`error_code="UNKNOWN"` — unchanged code.
8. API-side fallbacks remain in code but are never operative for worker failures (FR-8).

## 5. Component changes

### 5.1 Worker `main.py` — stage tracker
- A function-local variable (proposed name `current_stage`), initialized to `"processing"` at `process_document` entry. Function-local is safe: one async task per job, no cross-task sharing.
- **Convention (normative):** assign the tracker immediately before every pipeline await, using the milestone token whose progress update covers that work (§6.1 table). Synchronous glue between awaits inherits the preceding assignment. Failures before the first assignment report `"processing"`.
- `completed` is never assigned as a failure stage (success terminal).
- Drift risk: a future pipeline step added without a tracker assignment reports a stale stage. Mitigation: the set-before-await convention documented in a code comment at the tracker declaration, plus representative-stage test coverage (TR-5: early + late failure) which catches the tracker being removed or bypassed without ossifying every step.
- Progress publishing is not refactored — the tracker is only read by the failure handler (minimal diff).

### 5.2 Worker `main.py` — failure payload builder
- New module-level function (proposed name `build_failure_payload(message: str, stage: str, retryable: bool) -> dict`) returning exactly:

  ```python
  {
      "error_message": message,
      "stage": stage,
      "retryable": retryable,
      "error": message,  # legacy key retained for unknown consumers of the status topic (F11)
  }
  ```

- Single construction point: the exception handler calls it, and the contract test drives it — so the test exercises the worker's real construction code, not a restatement.
- The legacy `error` key is inert to rag-api (its failed branch reads only the three contract keys per F4) and costs one redundant string per failure message as insurance against unknown topic consumers. If a later audit confirms rag-api is the only consumer, dropping it is trivial cleanup.
- Call site: the existing handler in `process_document` replaces `details={"error": str(e)}` with the builder call; the `_publish_status_update` invocation itself is unchanged.

### 5.3 Worker `main.py` — retryable derivation
- `retryable = classify_error(e)` computed in the handler; mapping table normative in requirements §5.4.
- **Do not** source `retryable` from `PDFProcessingError.retryable` (the metadata field on the `exceptions.py` hierarchy). Per FR-4, `classify_error(e)` is the single decision path; that metadata field serves other inspecting consumers per its own docstring and is not the ACK/NACK decision input.
- ACK/NACK behavior in `run_worker` is unchanged (F7) — only the *reporting* of retryability changes (non-goal).
- Consequence (accepted, requirements §8): unclassified-unknown exceptions and `PDFProcessingError` subclasses persist `retryable: false`; manual reprocess via `POST /process` remains available.

### 5.4 rag-api — no code changes
- The failed branch already reads `error_message`/`stage`/`retryable` and persists `error`/`error_stage`/`retryable` plus the subdoc `message`/`stage`/`error_code="UNKNOWN"` (F4). Constraint C-1 forbids touching its reads or schema.
- Its `details.get(...)` fallbacks (including `retryable` default `True`) remain in code but are non-operative for worker failures once the worker always sends the keys (FR-8), enforced by TR-2/TR-3.

### 5.5 Explicitly untouched (verified to exist; out of scope)
Stale-lease sweep `_fail_if_still_stale`; rag-api enqueue-failure paths; `StatusUpdater` and `models/processing_status.py` vocabulary; `Resource`/`ResourceResponse` models; Pub/Sub ACK/NACK policy, leases, heartbeats; frontend/mobile.

## 6. Data contract

Normative tables live in `docs/requirements.md` §5 (payload schema, persistence mapping, stage vocabulary, retryable derivation). Summary:

- Payload: `error_message` (str, `str(e)`), `stage` (str, vocabulary token or `"processing"`), `retryable` (bool, from `classify_error`), `error` (str, legacy duplicate of the message).
- Persistence: `error_message`→`error`/subdoc `message`; `stage`→`error_stage`/subdoc `stage`; `retryable`→`retryable`; `error_code` stays `"UNKNOWN"`.
- Stage tokens: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`; safe value `processing`; `completed` never a failure stage.

## 7. Contract test architecture

### 7.1 Placement and house patterns
- New module `apps/ai-server/tests/integration/test_worker_failure_contract.py`, sibling of `test_api_contracts.py` (which already imports rag-api's `main as rag_api_main` and reads `ResourceResponse.model_fields` — verified pattern).
- `apps/ai-server/tests/integration/conftest.py` exists and handles path setup; extend it if the worker import needs additional paths.
- Optional declarative fixture `apps/ai-server/tests/fixtures/api-contracts/worker_failure_payload.json` following the fixture convention; not required for the behavioral assertions.

### 7.2 Two-module import problem and decision tree
Both services name their entry module `main`. The existing tests import one `main` successfully; importing the worker's too requires care:
- **Preferred:** load the worker module by path with `importlib.util.spec_from_file_location` under a distinct module name. Risk: worker `main.py` imports heavy dependencies (langchain, openai, spacy, sklearn, firebase_admin, langfuse, tiktoken — verified import block) and may have import-time side effects; its availability in the shared integration-test env is unknown.
- **Fallback A:** extract `build_failure_payload` into a small dependency-light module (e.g., `rag-worker-service/utils/failure_payload.py`) imported by `main.py` — keeps the single construction point and makes the test trivially importable.
- **Fallback B:** subprocess-based payload generation, exactly the house `_get_agent_graph_shapes` pattern (subprocess + AST + JSON stdout, verified in `test_api_contracts.py`).
Decide at implementation based on observed import behavior; all three satisfy TR-1.

### 7.3 Test layers

- **T1 — payload construction (worker).** Drive the construction path for representative errors: `TransientError("boom")` → `{error_message:"boom", stage:<token>, retryable:True, error:"boom"}`; `PermanentError("bad")` → `retryable:False`; `ValueError("??")` (unclassified-unknown) → `retryable:False`. Assert key presence and types. [TR-2, TR-6]
- **T2 — persistence (the seam).** Seed a resource document (emulator or fake), then drive rag-api's failed branch with T1's payload as `details`. Entry point: the narrowest rag-api function covering the failed-branch reads + writes — prefer the status-subscriber handler with a realistic message; fall back to calling `run_transactional_update` directly if the handler requires live Pub/Sub infrastructure. Read the exact entry point and document path from rag-api's code at implementation (unknown here); prefer seeding via rag-api's own helpers so path details come from its code, not the test. Assert persisted `error`/`error_stage`/`retryable` equal the payload values, and explicitly ≠ the fallbacks (`"Processing failed"`, `None`). [TR-3, A2]
- **T3 — subdocument.** Assert the `processing`/summary error subdoc `message`/`stage` match the payload and `error_code == "UNKNOWN"`. [TR-4, A3]
- **T4 — stage tracker (representative).** Force an early failure (first pipeline dependency monkeypatched to raise) and a late failure (last dependency), driving `process_document` with externals mocked; assert the payload `stage` equals the expected milestone token in each case. If `process_document`'s internals prove not cleanly mockable (unknown), reduce to handler-path coverage via the builder plus a documented note — the early/late pairing is what pins the mechanism. [TR-5]
- **T5 — static API-read guard (should).** Subprocess+AST extraction of the `details`-read keys in rag-api's failed branch (scoped to that branch to limit false positives); assert ⊇ `{error_message, stage, retryable}`. If extraction proves brittle, drop with a documented note — T2's equality assertions are the operative API-side drift guard. [TR-7]
- **Hermeticity.** Set `FIRESTORE_EMULATOR_HOST` for real transactional semantics (both services support emulator branches per F10); fakes acceptable where the emulator is unavailable. No live Pub/Sub — transport is out of scope. [TR-8]

### 7.4 What fails the build (drift scenarios)

| Drift | Caught by |
|---|---|
| Worker renames/drops `error_message`/`stage`/`retryable` | T1 key-set assertions |
| Worker handler reverts to `{"error": str(e)}` or bypasses the builder | T4 (handler-path stage assertions), T1 via builder/handler coupling |
| rag-api stops reading a payload key | T2 equality fails (persisted value regresses to fallback) |
| rag-api renames a persisted field | T2/T3 fail; `test_api_contracts.py` independently pins `error`/`error_stage` exposure on `ResourceResponse` |
| Stage tracker removed/bypassed | T4 (stage regresses to `"processing"` ≠ expected token) |
| New pipeline step added without tracker assignment | Convention + code comment; T4 catches mechanism removal, not per-step omission (accepted residual, per definition) |

## 8. Compatibility and rollout

- No migration or backfill: existing failed documents keep their fallback-shaped values; only new failures persist correctly (FR-7).
- Legacy `error` key retained (FR-5); removal later is trivial cleanup after a consumer audit (F11 unknown).
- Behavior change to call out in PR/release notes: unclassified-unknown failures now persist `retryable: false` (requirements §8.1); manual reprocess via `POST /process` unaffected.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic read the old key set | Legacy `error` key retained (F11 hedge); residual risk accepted as low |
| Stage-tracker drift as the pipeline evolves | Set-before-await convention documented in code; representative-stage test (early + late) |
| `retryable=false` for genuinely transient-but-unrecognized failures | Accepted per definition; widening `classify_error` out of scope; `POST /process` manual reprocess remains |
| Contract test ossifies the payload | Intentional — that is the drift guard; adding a key means touching the test |
| Worker `main.py` heavy imports block test import | §7.2 decision tree (importlib → utils extraction → subprocess pattern) |
| AST guard brittleness (false positives on `details` reads) | Scope extraction to the failed branch; drop-with-note fallback, T2 equality remains operative |
| Vocabulary confusion with `StatusUpdater`'s `ProcessingStage` | Pitfall note §2 — failure stages use only the `main.py` progress vocabulary |
| Empty `str(e)` persists empty `error` | Accepted (no fabricated fallbacks); documented as potential follow-up |

## 10. Alternatives considered

1. **Rename rag-api's reads/persisted fields to the worker's `error` key.** Rejected: ripples across three write paths and two model surfaces (F6) and risks violating the no-migration constraint (C-2). The worker is the odd writer; fix the odd one out.
2. **Teach rag-api's failed branch to also accept `error` as a fallback.** Rejected: C-1 forbids API-side changes, and it masks the mismatch instead of removing it.
3. **Source `retryable` from `PDFProcessingError.retryable` metadata.** Rejected: FR-4 makes `classify_error(e)` the binding decision path, aligned with actual ACK/NACK behavior (F7/F8); the metadata field is not the retry decision input.
4. **Introduce structured error codes.** Rejected (prefer_not): subdoc `error_code` stays `"UNKNOWN"` unless a code is actually sent.
5. **Invent new failure-stage tokens (e.g., `tagging`).** Rejected: FR-3 mandates reusing the existing progress vocabulary so failure stages read naturally next to the progress timeline clients already see.

## 11. Files touched

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Stage tracker; `build_failure_payload`; handler call site; `retryable = classify_error(e)` |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` | New contract test (T1–T5) |
| `apps/ai-server/tests/integration/conftest.py` | Extend path setup if needed for the worker import |
| `apps/ai-server/tests/fixtures/api-contracts/worker_failure_payload.json` | Optional declarative fixture |
| `apps/ai-server/rag-worker-service/utils/failure_payload.py` | Contingency only (§7.2 Fallback A) |

No rag-api source files are modified.

## 12. Acceptance verification map

| Acceptance | Mechanism |
|---|---|
| A1 (payload keys, no fallback reliance) | §5.2/§5.3 worker changes; T1, T4, T6-derivation cases |
| A2 (persisted values equal worker's) | rag-api unchanged behavior + T2 equality assertions |
| A3 (subdoc message/stage match) | T3 |
| A4 (contract test exists, passes, drift-guarded) | §7 test architecture; TR-1..TR-8 |

## 13. Open questions (carried from requirements §11)

Exact `_publish_status_update` / `run_transactional_update` signatures; failed-branch Firestore write path; subdoc `retryable` persistence; worker `main.py` import behavior in the test env; other status-topic consumers; `process_document` mockability for T4; companion D3 issue content and `plans/upload-flow.md` reconciliation (deferred). Each is flagged at its point of use above with the decision rule to resolve it at implementation time.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>