Design step complete. Producing the contracted artifacts from the authoritative definition (wi-define-108-a8) and the repository evidence verified during investigation (rag-api `run_transactional_update` failed branch, `_process_status_message` envelope keys, `POST /process` enqueue-failure write shape, `ResourceResponse` fields, `FIRESTORE_EMULATOR_HOST` startup branch, both services' test conftest stubbing, `tests/integration/test_api_contracts.py` patterns, and docs/TESTING-STRATEGY.md). Worker `main.py` internals were read but elided from working context; specifics not directly re-verified are marked as implementation-time determinations rather than asserted facts.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements — rag-worker → rag-api Failure Payload Contract Alignment

- **Cycle:** 7aa11988-bd39-4e4e-b95c-6bf5285a6454 (iteration 1, step: design)
- **Intent:** rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage
- **Authority:** WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5`). That definition is binding; this document restates and operationalizes it. It neither widens nor narrows scope.
- **Status:** Proposed (design step — pending implementation)

---

## 1. Problem statement (verified)

The worker's failure publisher and rag-api's failure consumer were written against different contracts, and nothing tests the seam:

- The worker's `process_document` exception handler publishes failed status with `details = {"error": str(e)}` (one key).
- rag-api's failed branch in `run_transactional_update` reads three keys — `error_message`, `stage`, `retryable` — and persists them as `error`, `error_stage`, and `retryable` on the main resource document, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the `processing/summary` error subdocument.
- Because of the key mismatch, every worker-originated failure currently persists:
  - `error = "Processing failed"` (fallback string),
  - `error_stage = None`,
  - `retryable = True` (silent default).
- The `processing/summary` error subdocument inherits the same fallback message and a null stage, with `error_code` always `"UNKNOWN"`.

The `error` / `error_stage` / `retryable` schema is already established across three other write paths (worker stale-lease sweep `_fail_if_still_stale`, rag-api `POST /process` and `POST /resources` enqueue-failure paths) and two response models (`ResourceResponse`, `Resource` model — `retryable` defaults `True`). The worker's status publisher is the only writer that does not speak it.

## 2. Scope

### 2.1 In scope

1. rag-worker failure-payload construction: publish `error_message`, `stage`, `retryable` (plus retained legacy `error`) on every worker-originated failed status.
2. Stage tracking through `process_document` so the failure handler reports the true failing pipeline stage.
3. Explicit `retryable` derivation from the worker's existing `classify_error()` classification.
4. A contract test covering the worker failure → rag-api persistence path, including a key-set drift guard on both sides.
5. rag-api: **no code changes** — its failed-branch reads and persisted schema are preserved exactly; the contract test pins them.

### 2.2 Out of scope (non-goals, from the authoritative definition)

- **NG-1:** Changing the stale-lease sweep's direct failure write — it already persists `error`/`error_stage`/`retryable` consistently with this contract.
- **NG-2:** Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the *reporting* of retryability in the payload changes.
- **NG-3:** Frontend or mobile changes — `ResourceResponse` already exposes `error` and `error_stage` to clients.
- **NG-4:** Introducing structured error codes or a failure taxonomy — the `processing/summary` `error.code` remains `"UNKNOWN"` unless a code is actually sent.
- **NG-5:** Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is unavailable in this context; deferred — see §8).

## 3. Functional requirements

Requirement IDs are stable and traceable (§9). "Must" = binding; "Should" = strong default, deviation requires recorded rationale.

### FR-1 — Failure payload keys (must)

When document processing fails, the worker's failed status payload `details` **must** include:

| Key | Type | Value | Presence |
|---|---|---|---|
| `error_message` | str | The actual exception message (`str(e)`) | always |
| `stage` | str | The pipeline stage executing at failure time (see FR-2/FR-3) | always |
| `retryable` | bool | Deliberately derived per FR-5 | always |
| `error` | str | Duplicate of `error_message` (legacy hedge, see FR-6) | always (should-level retention) |

The payload **must never** rely on rag-api's fallback defaults (`"Processing failed"`, `None`, `True`) for `error_message`, `stage`, or `retryable`. rag-api's fallbacks remain in its code as defense-in-depth but must not be the operative mechanism for worker failures.

### FR-2 — Stage tracking through `process_document` (must)

- The worker **must** track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.
- Mechanism: a stage tracker (local state) set **immediately before each pipeline step** and read by the exception handler at failure time. Convention: "set the tracker immediately before the await/step."
- Initial/safe value: `"processing"` — used when the stage is genuinely unknown (e.g., failure before the first tracked transition). This matches the stale-lease sweep's `error_stage` value so the field never regresses to null.
- The exact set-points are determined by the existing `_publish_status_update` progress call sites in `process_document` (implementation-time determination; the progress-publish vocabulary is verified per fact F9). Steps without a dedicated vocabulary name take the nearest applicable vocabulary name; **no new stage names may be invented** (vocabulary is pinned by FR-3).

### FR-3 — Stage vocabulary pinned (must)

Stage values **must** reuse the existing progress-stage vocabulary exactly:

```
starting, text_retrieved, tagging_complete, summary_generated,
chunking_complete, embeddings_complete
```

plus the safe value `"processing"` for genuinely-unknown. `"completed"` is a terminal status, not a failure stage, and is not part of the failure-stage vocabulary. `error_stage` values must always be non-null strings for worker-originated failures (clients read `error_stage` via `ResourceResponse`).

### FR-4 — rag-api persistence invariant (must; no code change)

rag-api's failed branch must persist worker-provided values **unchanged**. This is a preserved invariant of the existing `run_transactional_update` code, verified and pinned by the contract test — not a change:

| Persisted target | Source in payload |
|---|---|
| main doc `error` | `details["error_message"]` |
| main doc `error_stage` | `details["stage"]` |
| main doc `retryable` | `details["retryable"]` |
| `processing/summary` `error.message` | `details["error_message"]` |
| `processing/summary` `error.stage` | `details["stage"]` |
| `processing/summary` `error.code` | `details.get("error_code", "UNKNOWN")` → `"UNKNOWN"` (worker sends no `error_code`) |
| `processing/summary` top-level `stage` | `details["stage"]` (verified: summary always writes `details.get("stage", "unknown")`) |

Persisted field names (`error`, `error_stage`, `retryable`) and semantics are unchanged. No Firestore migration, field rename, or backfill.

### FR-5 — `retryable` derivation (must)

- The worker **must** derive `retryable` explicitly from its existing `classify_error()` classification — the same classification that drives ACK/NACK in `run_worker`:
  - classified **transient** → `retryable = true` (Pub/Sub will redeliver);
  - classified **permanent**, including unclassified-unknown per `classify_error`'s conservative default → `retryable = false` (acked, no auto-redelivery; manual reprocess via `POST /process` remains available).
- The key must always be present in the payload; the API-side `details.get("retryable", True)` fallback must never be operative for worker failures.
- The stale-lease sweep's separate direct write of `retryable=true` is unchanged and stays correct (a dead worker is a transient condition by nature) — see NG-1.

### FR-6 — Legacy `error` key retention (should)

The worker **should** retain the legacy `error` key (same string as `error_message`) in the failure payload, alongside `error_message`, for continuity with any unknown consumers of the status topic and existing log tooling. Only rag-api's status subscriber is a verified consumer; the duplicate is one string per failure message as insurance. If a later audit confirms worker→rag-api is the only producer→consumer pair, dropping the duplicate is trivial cleanup and explicitly not part of this cycle.

### FR-7 — No error-code taxonomy (must-not-derived)

The worker **must not** send `error_code` or introduce structured error codes. The `processing/summary` `error.code` remains `"UNKNOWN"` via rag-api's existing default.

### FR-8 — Contract test: behavioral seam (must)

A contract test **must** cover the worker failure → rag-api persistence path. It must:

1. **Import both sides** rather than restate the contract in a fixture: exercise the worker's failure-payload construction through its real code path, and feed the produced payload through rag-api's real `run_transactional_update`.
2. Run against the Firestore emulator or fakes (hermetic; see FR-11).
3. Assert the persisted main-document `error`, `error_stage`, and `retryable` **equal** the worker's payload values (i.e., not the fallbacks `"Processing failed"` / `None` / `True`).
4. Assert the `processing/summary` error subdocument carries the same message and stage.
5. Cover both a **transient-classified** failure (persisted `retryable == true`) and a **permanent-classified** failure (persisted `retryable == false`), at minimum one unclassified-unknown exception persisting `false`.

### FR-9 — Contract test: key-set drift guard (must)

The contract test **must** fail the build if either side's payload keys drift:

- Worker side: the failure-payload construction must contain the required keys `error_message`, `stage`, `retryable` (and the retained `error`). Extra keys are permitted; missing required keys fail.
- rag-api side: the failed branch must read `error_message`, `stage`, `retryable` from `details`. Removal or rename of any read fails.
- Mechanism: static source/AST assertions against the actual service sources (house pattern: fixture- and AST-based static contract tests in `apps/ai-server/tests/integration/test_api_contracts.py`). The guard pins presence of required keys, not the absence of everything else, so adding a key later means touching the test deliberately — that is the drift guard doing its job.

### FR-10 — Representative stage coverage (must)

The contract test **must** pin the stage-tracking mechanism on representative stages — at minimum an **early-stage failure** and a **late-stage failure** — asserting the persisted `error_stage` equals the stage the tracker held at failure time. This is enough to catch the tracker being removed or bypassed without ossifying every pipeline step.

### FR-11 — Hermetic, deterministic tests (must)

- Tests must run without real GCP credentials: both services support `FIRESTORE_EMULATOR_HOST` hermetic modes, and the existing integration conftest (`apps/ai-server/tests/integration/conftest.py`) already mocks the cloud SDK modules and puts rag-api-service on `sys.path` so `run_transactional_update` is importable.
- Tests must be deterministic (no sleeps, no network, no real Pub/Sub). The Pub/Sub envelope transport is out of the seam test's scope: the envelope (`user_id`, `course_id`, `resource_id`, `status`, `details`) is already proven by the working progress path and is unchanged.

### FR-12 — All worker failure-publish sites comply (must)

Every worker-originated failed-status publish (not the sweep, which writes Firestore directly — NG-1) **must** produce the FR-1 payload shape. Implementation must inventory all failed-status publish call sites in the worker and route them through the shared payload construction. Only the `process_document` exception handler is a verified publish site today (fact F3); the inventory is an implementation-time determination.

### FR-13 — Empty-message guard (should)

If `str(e)` is empty (exception raised with no message), the worker **should** fall back to the exception class name (e.g., `"ValueError"`) for `error_message`/`error`, so a persisted `error` is never an empty string. rag-api's fallback only applies when the key is *missing*, not when it is empty, so the worker must guard this itself.

## 4. Deliberate behavior change (notice)

Unclassified-unknown exceptions currently persist `retryable: true` (the silent API-side default) but classify as **permanent** under `classify_error`. After this change they persist `retryable: false`. This is intentional: it aligns the persisted record with the worker's actual ACK/NACK behavior (permanent errors are acked and will not be redelivered) and prevents infinite retry loops. Manual reprocess via `POST /process` is unaffected. Widening `classify_error` is out of scope.

## 5. Constraints (from the authoritative definition)

| ID | Type | Constraint |
|---|---|---|
| C-1 | must | The worker is aligned to rag-api's existing contract — publishing `error_message`/`stage`/`retryable` — rather than changing rag-api's reads or persisted schema. |
| C-2 | must_not | No Firestore migration, field rename, or backfill of existing documents; persisted fields (`error`, `error_stage`, `retryable`) keep their names and semantics. |
| C-3 | must | Every worker-originated failure payload carries `retryable` explicitly (deliberately derived); the API-side `details.get("retryable", True)` fallback must not be operative for worker failures. |
| C-4 | prefer | Retain the legacy `error` key in the worker's failure payload alongside `error_message`. |
| C-5 | prefer_not | Do not introduce a structured error-code taxonomy (`error_code` values) in this fix. |

## 6. Acceptance criteria

| ID | Criterion (from the definition) | Verified by |
|---|---|---|
| AC-1 | A failed job's status message published by the worker contains `error_message` (actual exception message), `stage` (failing pipeline stage), and `retryable` (deliberately derived) — none relying on rag-api's fallback defaults. | Contract test, worker-side payload assertions (FR-1, FR-8) |
| AC-2 | After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. | Contract test, persisted-doc assertions (FR-4, FR-8) |
| AC-3 | The `processing/summary` error subdocument for the failed job carries the same message and stage as the main document. | Contract test, summary-subdoc assertions (FR-4, FR-8) |
| AC-4 | A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted `error`, `error_stage`, and `retryable` equal the worker's values, failing if either side's payload keys drift. | New test in `apps/ai-server/tests/integration/`, green in CI (FR-8, FR-9, FR-10) |

## 7. Non-goals

See §2.2 (NG-1 … NG-5) — restated there and binding.

## 8. Deferred / out of context

- **D-1:** The companion D3 issue referenced by the Objective — its scope is unavailable in this context; anything it covers beyond this worker→rag-api failure payload alignment is deferred.
- **D-2:** Reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` — that file is not present in the current tree (the reference comes from the Objective text); deferred.
- **D-3:** Dropping the legacy `error` key after a consumer audit — trivial follow-up cleanup, explicitly not this cycle.

## 9. Traceability

| Fact (definition) | Requirement(s) |
|---|---|
| F1 (product intent: persist real message/stage/deliberate retryable) | FR-1, FR-2, FR-5; AC-1, AC-2 |
| F2 (preferred direction: align worker keys, avoid migration) | FR-1, FR-4; C-1, C-2 |
| F3 (worker publishes `{"error": str(e)}`) | FR-1, FR-12 |
| F4 (rag-api failed-branch reads/persists) | FR-4 |
| F5 (current fallback persistence) | §1; AC-2 |
| F6 (established persisted schema across sweep/enqueue/model) | FR-4; NG-1 |
| F7 (classify_error transient/permanent, unknown→permanent) | FR-5 |
| F8 (adopted retryable derivation default) | FR-5; §4 |
| F9 (progress stage vocabulary; no failure-stage tracking today) | FR-2, FR-3, FR-10 |
| F10 (contract-test infra + hermetic modes exist) | FR-8, FR-9, FR-11 |
| F11 (legacy `error` key hedge) | FR-6; C-4 |
| F12 (companion D3 issue out of context) | §8 (D-1); NG-5 |
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/architecture.md">>>
# Architecture — rag-worker → rag-api Failure Payload Alignment

- **Cycle:** 7aa11988-bd39-4e4e-b95c-6bf5285a6454 (iteration 1, step: design)
- **Authority:** WorkItem `wi-define-108-a8`, artifact `definition:obj-108` (sha256 `71f1c39c…`). Companion to `docs/requirements.md` (FR/AC IDs referenced from here).
- **Status:** Proposed (design step — pending implementation)

---

## 1. Current flow (verified) and where it breaks

```
rag-worker process_document
  └─ exception handler
       └─ _publish_status_update(status="failed", details={"error": str(e)})   ← F3
            │  Pub/Sub topic: rag-status-updates
            ▼
rag-api _process_status_message
  │  envelope keys: user_id, course_id, resource_id, status, details   (verified)
  ▼
run_transactional_update(db, doc_ref, "failed", details, logger, user_id)   (verified)
  ├─ main doc:  error      ← details.get("error_message", "Processing failed")
  │             error_stage ← details.get("stage")                → None
  │             retryable   ← details.get("retryable", True)      → True (fabricated)
  └─ processing/summary:
                error ← {code: details.get("error_code","UNKNOWN") → "UNKNOWN",
                         message: "Processing failed", stage: None}
                stage ← details.get("stage", "unknown")             → "unknown"
```

Every worker-originated failure lands as the fallback string, a null stage, and a fabricated `retryable: true`. The transition guard (`ALLOWED_TRANSITIONS`: `processing → failed`) and the envelope contract are already correct and unchanged by this work.

Other writers already speak the persisted schema (verified): the worker's stale-lease sweep writes `error`/`error_stage` (`"processing"`)/`retryable=true` directly; rag-api's `POST /process` enqueue-failure rollback writes `error`/`error_stage="enqueue"`. `ResourceResponse` exposes `error` and `error_stage` to clients. The worker's status publisher is the only misaligned writer.

## 2. Design principles

1. **Fix the odd writer.** The worker aligns to `error_message`/`stage`/`retryable`; rag-api's reads and the persisted schema are untouched (C-1, C-2). No migration, no backfill, no reader changes.
2. **Derive, don't default.** `retryable` comes from the worker's existing `classify_error()` — the same verdict that drives ACK/NACK — so the persisted record tells the truth about whether Pub/Sub will redeliver (FR-5).
3. **Test the seam, not a fixture copy.** The contract test imports both sides' real code; the contract is pinned by execution plus a static drift guard, never restated as a frozen JSON fixture (FR-8, FR-9).

## 3. Component changes

### 3.1 `apps/ai-server/rag-worker-service/main.py` — the only production code change

**a) Stage tracker (FR-2, FR-3).** A local in `process_document`:

- Initialized to `"processing"` (safe/unknown value, matching the sweep's `error_stage`).
- Set immediately before each pipeline step to that step's vocabulary stage name; convention: **set the tracker immediately before the await/step**. The set-points mirror the existing `_publish_status_update` progress call sites (fact F9); exact step-boundary mapping is an implementation-time determination guided by that rule — no new stage names.

| Tracker value | Set immediately before |
|---|---|
| `starting` | the first pipeline step (mirrors the `starting` progress publish) |
| `text_retrieved` | the text extraction/retrieval step |
| `tagging_complete` | the tagging step |
| `summary_generated` | the summary step |
| `chunking_complete` | the chunking step |
| `embeddings_complete` | the embeddings step |
| `processing` | initial value; reported only when the stage is genuinely unknown |

Semantics note: the vocabulary names are completion-flavored markers. The tracker value identifies the **pipeline phase executing at failure time** — e.g., a failure during tagging reports `tagging_complete` ("failed in the tagging phase, which completes with tagging_complete"). This keeps a 1:1 mapping between tracker set-points and the pipeline's progress-publish points, and it names the executing phase rather than the last *completed* one, which is what "the true failing stage" requires. The contract test's early/late-stage cases (FR-10) lock these semantics.

Known drift risk: a future pipeline step added without updating the tracker reports a stale stage. Mitigated by the set-before-await convention plus representative-stage test coverage — deliberately not by ossifying every step.

**b) Failure payload construction (FR-1, FR-5, FR-12).** A single module-level pure builder, e.g. `build_failure_details(exc, stage) -> dict`, used by the `process_document` exception handler (and by any other failed-status publish site found in the FR-12 inventory):

```python
{
  "error_message": str(e) or type(e).__name__,   # FR-13 empty-message guard
  "stage":          stage,                        # tracker value; "processing" if unknown
  "retryable":      <classify_error(e) is transient>,   # FR-5 mapping below
  "error":          str(e) or type(e).__name__,   # FR-6 legacy hedge
}
```

- No `error_code` key is emitted (FR-7); rag-api's summary `error.code` stays `"UNKNOWN"` via its existing default.
- No `progress` key is required; rag-api's summary write defaults it to 0 (verified) and progress is not part of this contract.

**c) `retryable` derivation (FR-5).**

| `classify_error(e)` verdict | `retryable` | Rationale |
|---|---|---|
| transient | `true` | Pub/Sub NACK → redelivery; persisted record matches actual retry behavior |
| permanent (incl. unclassified-unknown, `classify_error`'s conservative default) | `false` | acked, no redelivery; manual reprocess via `POST /process` remains |

Deliberate behavior change: unclassified-unknown exceptions flip persisted `retryable` from `true` (today's silent default) to `false` — see requirements §4. The stale-lease sweep keeps its direct `retryable=true` write (NG-1): a worker dying mid-extraction is transient by nature.

The exact call shape follows `classify_error`'s actual signature/return (verified to exist in worker `main.py` per fact F7; precise signature is an implementation-time determination).

**d) What does not change in the worker:** ACK/NACK policy, leases, heartbeats, the sweep, retry/backoff mechanics (NG-2), and the progress-update publishes (their vocabulary is reused, not altered).

### 3.2 `apps/ai-server/rag-api-service/` — no production code changes

`run_transactional_update`, `_process_status_message`, the enqueue-failure paths, `models/resource.py`, and `ResourceResponse` are all preserved exactly. The failed branch's fallbacks (`"Processing failed"`, `None`, `True`) remain in code as defense-in-depth for non-worker publishers but cease to be operative for worker failures (FR-4, C-3).

### 3.3 Contract test — new file(s) under `apps/ai-server/tests/integration/`

Naming per `docs/TESTING-STRATEGY.md` (e.g., `test_worker_failure_contract.py`; functions `test_<thing>_<condition>_<expected>`). Two layers:

**Layer 1 — behavioral seam test (FR-8).**

*Worker side:* import the worker module hermetically and invoke the real failure-payload construction. The proven stub inventory lives in `apps/ai-server/rag-worker-service/tests/conftest.py` (verified: stubs for `google.cloud.*`, `firebase_admin`, `openai`, `langfuse`, `spacy`, `tiktoken`, `tenacity`, langchain, etc.). The new test must establish an equivalent hermetic import context (replicate the stub set locally, or factor the stubs into a shared helper). Known risk: `tests/integration/conftest.py` already installs generic `MagicMock`s for overlapping modules ("first import wins"); if importing full worker `main.py` under those proves brittle, the fallback is extracting the pure builder (and only it) into a dependency-light module in the worker service — a behavior-preserving, test-enabling extraction within scope.

*rag-api side:* `tests/integration/conftest.py` (verified) already mocks the cloud SDK modules, sets `GCP_PROJECT`/fake credentials/`SHARED_INTERNAL_TOKEN`, and puts rag-api-service on `sys.path`, so `from main import run_transactional_update` works hermetically.

*Fake Firestore transactional harness.* `run_transactional_update` uses `@firestore.transactional`, `db.transaction()`, `doc_ref.get(transaction=…)`, `transaction.update/set`, and `firestore.SERVER_TIMESTAMP`. Under the conftest's MagicMocks the decorated body would not execute, so the harness patches the imported module's handles and supplies fakes:

```python
import main as rag_api_main                      # via existing integration conftest
rag_api_main.firestore.transactional = lambda fn: fn        # pass-through decorator
rag_api_main.firestore.SERVER_TIMESTAMP = "SERVER_TIMESTAMP" # sentinel

class FakeTransaction:   # records update()/set() calls
class FakeDocRef:        # .id; .get(transaction=…) → snapshot(.exists, .to_dict());
                         # .collection("processing").document("summary") → FakeDocRef
class FakeDB:            # .transaction() → FakeTransaction

# seed doc with status="processing" so processing→failed is an allowed transition
run_transactional_update(fake_db, doc_ref, "failed", worker_payload, stub_logger, "uid")
```

Then assert on the recorded main-doc update and summary-subdoc update:

- main doc: `error == payload["error_message"]`, `error_stage == payload["stage"]`, `retryable == payload["retryable"]`, `status == "failed"` — and explicitly **not** `"Processing failed"` / `None` / `True` (AC-2).
- summary subdoc: `error.message == payload["error_message"]`, `error.stage == payload["stage"]`, `error.code == "UNKNOWN"`, top-level `stage == payload["stage"]` (AC-3).

*Emulator alternative:* both services have verified `FIRESTORE_EMULATOR_HOST` branches, but the integration conftest's wholesale module mocking conflicts with loading the real `google.cloud.firestore`; the fake harness above is the primary design, the emulator route a documented alternative if the harness proves insufficient.

*Cases (FR-8, FR-10):*

1. Early-stage failure (e.g., exception raised at the first tracked step) → persisted `error_stage` equals the tracker's stage; message and derived `retryable` persisted verbatim.
2. Late-stage failure (e.g., exception raised at a late tracked step) → same assertions, pinning that the tracker advanced.
3. Transient-classified exception → persisted `retryable is True`.
4. Permanent-classified exception → persisted `retryable is False`.
5. Unclassified-unknown exception → persisted `retryable is False` (locks the deliberate behavior change, requirements §4).
6. Payload always contains `error_message`, `stage`, `retryable` (and retained `error`) — never relies on API fallbacks (AC-1).

**Layer 2 — static drift guard (FR-9).** AST/source assertions against the actual files (house pattern: `test_api_contracts.py` fixture/AST static tests):

- Worker source: the failure-payload construction contains the required keys `error_message`, `stage`, `retryable` (extra keys such as `error` permitted; missing required keys fail).
- rag-api source: the failed branch reads `error_message`, `stage`, `retryable` from `details` (removal/rename fails).
- Optional, cheap extension: pin the Pub/Sub envelope keys on both sides (worker publisher vs. rag-api reader: `user_id`, `course_id`, `resource_id`, `status`, `details`) — the envelope is verified on the rag-api side and unchanged; include only if the worker-side publish site is cleanly assertable.

**Worker-side unit tests (recommended, not binding):** per the house testing strategy, the new pure logic (builder output shape, `retryable` mapping for transient/permanent/unknown, empty-message guard) merits unit tests alongside the seam test; the contract test remains the binding requirement (AC-4).

**CI:** the new file lands in the existing integration/contract suite (`apps/ai-server/tests/integration/`), which the documented CI pipeline (`apps/ai-server/.github/workflows/test.yml`) already runs; no workflow changes required.

## 4. Data contracts

**Worker → status topic, failed-status `details` (changed — the fix):**

| Key | Type | Required | Notes |
|---|---|---|---|
| `error_message` | str | yes | actual exception message; class-name fallback if empty (FR-13) |
| `stage` | str | yes | vocabulary stage or `"processing"` (FR-2/FR-3); never null |
| `retryable` | bool | yes | derived from `classify_error` (FR-5); never silently defaulted |
| `error` | str | yes (should-level retention, FR-6) | legacy duplicate of `error_message` |
| `error_code` | — | **not sent** | summary `error.code` stays `"UNKNOWN"` (FR-7) |

**Envelope (unchanged):** `user_id`, `course_id`, `resource_id`, `status`, `details` — already proven by the working progress path.

**Persisted schema (unchanged, C-2):** main doc `error`/`error_stage`/`retryable`; `processing/summary` `error{code,message,stage}` + top-level `stage`/`progress`/`updated_at`. `ResourceResponse` continues to expose `error` and `error_stage`.

## 5. Compatibility

Only rag-api's status subscriber is a verified consumer of these payloads; other services/tooling share the topic. The retained legacy `error` key (FR-6) is insurance for unknown readers — one redundant string per failure message. rag-api ignores the `error` key in `details` (verified: it reads only the three contract keys), so the duplicate is harmless to the known consumer. Dropping it later is trivial cleanup (requirements §8, D-3).

## 6. Risks and tradeoffs (from the definition's analysis)

| Risk | Mitigation |
|---|---|
| Unknown consumers of the status topic reading the old key set | Retain `error` alongside `error_message`; residual risk accepted as low |
| Stage-tracker drift as the pipeline evolves | Set-before-await convention + representative early/late-stage contract coverage (FR-10) |
| `retryable=false` for genuinely transient-but-unrecognized failures reduces auto-retry affordances | Accepted; aligns with `classify_error`'s conservative ACK behavior; manual reprocess via `POST /process` unaffected; widening `classify_error` out of scope |
| Contract test ossifies the payload | Intentional — that is the drift guard working; adding a key means touching the test deliberately |
| Hermetic import of worker `main.py` under the integration conftest's generic MagicMocks | Primary: pure builder keeps the tested path light; fallback: local stub set mirroring the proven worker conftest (§3.3) |

## 7. Out of scope

Restated from requirements §2.2 (NG-1 … NG-5): the stale-lease sweep's write, retry/backoff mechanics (ACK/NACK policy, leases, heartbeats), frontend/mobile changes, structured error codes/taxonomy, and everything the unavailable companion D3 issue covers beyond this alignment.

## 8. Files touched (expected)

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | Stage tracker; failure-payload builder; `retryable` derivation; handler uses builder (FR-12 inventory of failed-publish sites) |
| `apps/ai-server/tests/integration/test_worker_failure_contract.py` (new) | Behavioral seam test + drift guard (FR-8/FR-9/FR-10) |
| `apps/ai-server/tests/integration/conftest.py` | Only if shared worker stubs are factored in (§3.3) |
| `apps/ai-server/rag-worker-service/tests/unit/…` (optional) | Unit tests for the new pure logic |
| rag-api production code, `models/resource.py`, sweep, workflows | **None** |

## 9. Process note

This change spans two services and alters an internal service-to-service contract, so it does not meet AGENTS.md's "small change" criteria (which require a single service and no contract changes); it should proceed on the feature/phase path — or an explicitly human-approved scoped branch — with the phase PR carrying the contract test as its acceptance evidence. Validation via `./dev/run ai-server` per repo rules.

## 10. Verification matrix

| Acceptance | Where verified |
|---|---|
| AC-1 (payload carries real message/stage/derived retryable) | Contract-test case 6 + per-case payload assertions |
| AC-2 (persisted main doc matches worker values, no fallbacks) | Contract-test main-doc assertions |
| AC-3 (summary subdoc carries same message/stage) | Contract-test summary-subdoc assertions |
| AC-4 (seam contract test exists, passes, fails on key drift) | New integration test file green in CI; drift guard Layer 2 |
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>