<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan: rag-worker → rag-api failure payload contract alignment

Run: a4a2f15b-a102-4b06-a47e-e30707e8a8cd
Authoritative definition: WorkItem `wi-define-108-a8` (artifact `definition:obj-108`, sha256 `71f1c39c…`)

## 1. Problem summary

The rag-worker's `process_document` exception handler publishes a failed status with details `{"error": str(e)}` (verified at `apps/ai-server/rag-worker-service/main.py`, `process_document` except block, lines ~1105–1112). rag-api's failed branch in `run_transactional_update` reads `error_message`, `stage`, and `retryable` from the details dict. The key mismatch means every worker-originated failure persists:

- `error` = fallback `"Processing failed"`
- `error_stage` = `None`
- `retryable` = silent default `True`
- processing/summary error subdocument inherits the fallbacks, `error_code` = `"UNKNOWN"`

The persisted schema (`error`, `error_stage`, `retryable`) is already used consistently by the worker's stale-lease sweep (`_fail_if_still_stale`), rag-api's enqueue-failure paths, and the `Resource` model / `ResourceResponse`. The worker's status publisher is the only non-conforming writer.

## 2. Fix direction (locked by the Definition)

Align the **worker** to rag-api's contract — publish `error_message`, `stage`, `retryable` — not the other way around. No Firestore migration, no field rename, no backfill, no reader changes. rag-api's failed branch persists the worker-provided values unchanged.

## 3. Changes

### 3.1 Worker: stage tracking in `process_document`

File: `apps/ai-server/rag-worker-service/main.py`, `EnhancedDocumentProcessor.process_document`.

- Introduce a local variable, e.g. `current_stage = "processing"`, initialized before the `try` block.
- Immediately **before** each pipeline step (the "update-before-await" convention), set `current_stage` to the next stage name. Stage names reuse the existing progress-update vocabulary exactly:
  - `"starting"` (initial value before/at `_validate_processing_request`)
  - `"text_retrieved"` (before Step 1 `_get_extracted_text` — note: the progress update with this name is published *after* the step; the tracker must be set *before* the step so a failure inside the step reports the stage being executed. Concretely: set the tracker to the stage whose completion the following progress update announces, i.e. the stage the code is currently executing. For steps 2–6 the tracker value is the stage of the work about to run: tagging, summary, chunking, embeddings, vector storage.)
  - `"tagging_complete"`, `"summary_generated"`, `"chunking_complete"`, `"embeddings_complete"` — used as the tracker value for the corresponding executing steps, matching the vocabulary required by the Definition.
  - For the post-embeddings steps (`delete_old_vectors_via_service`, `store_chunks_via_service`, metadata subcollection write, resource map), keep the tracker at `"embeddings_complete"` (last named stage) unless a new stage name is warranted — no new names are introduced in this fix.
- Safe value: if the failure occurs before the first transition (genuinely unknown stage), report `"processing"` — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.

Known drift risk: a future pipeline step added without updating the tracker reports a stale stage. Mitigation: the update-before-await convention plus contract-test coverage on representative stages (early and late failure). Do not ossify every step in the test.

### 3.2 Worker: failure payload construction

File: same, `process_document` except block.

Replace:

```python
await self._publish_status_update(..., "failed", {"error": str(e)}, job_id)
```

with a payload built from a small helper (new function, e.g. `_build_failure_details(e, stage) -> Dict[str, Any]`, module-level or method — prefer module-level for testability) that returns:

```python
{
    "error_message": str(e),
    "error": str(e),        # legacy key retained (compatibility hedge, F11)
    "stage": current_stage,
    "retryable": classify_error(e),
}
```

- `retryable` derivation (F8, binding): `classify_error(e)` — `True` for transient-classified errors, `False` for permanent-classified, including unclassified-unknown (classify_error's conservative default). This aligns the persisted record with the worker's actual ACK/NACK behavior in `run_worker`.
- Deliberate behavior change: unclassified-unknown exceptions previously persisted `retryable: true` (silent default) and will now persist `false`. Accepted; manual reprocess via `POST /process` remains.
- The legacy `error` key is retained alongside `error_message` as a hedge for unknown consumers of the status topic (F11). Dropping it later is trivial cleanup after a consumer audit — out of scope here.
- No structured error codes are introduced (prefer_not constraint); the processing/summary `error.code` stays `"UNKNOWN"` unless a code is actually sent (it is not).

### 3.3 rag-api: no functional change

File: `apps/ai-server/rag-api-service/main.py`, `run_transactional_update` failed branch — **unchanged**. It already reads `error_message` / `stage` / `retryable`, persists `error` / `error_stage` / `retryable` on the main document, and writes `message` / `stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary error subdocument. With the worker aligned, the fallback defaults cease to be operative for worker failures, satisfying the "must not rely on fallbacks" constraint.

### 3.4 Out of scope (non-goals, per Definition)

- Stale-lease sweep (`_fail_if_still_stale`) — already conforms; its `retryable: true` stays correct (a dead worker is transient).
- Retry/backoff mechanics: ACK/NACK policy, leases, heartbeats — only the *reporting* of retryability changes.
- Frontend/mobile — `ResourceResponse` already exposes `error` / `error_stage`.
- Structured error-code taxonomy.
- Companion D3 issue scope (unavailable here) and reconciling with `plans/upload-flow.md` D4 (file not present in tree) — deferred.

## 4. Implementation steps (ordered)

1. **Worker stage tracker** — add `current_stage` local; set before each await per §3.1. No behavior change yet (tracker unused).
2. **Worker failure payload helper** — add `_build_failure_details(e, stage)` implementing §3.2, including the legacy `error` key and `classify_error(e)` derivation.
3. **Wire the handler** — in `process_document`'s except block, call the helper with the tracked stage and publish the new details dict. Keep the existing log line; optionally add `stage` and `retryable` to the `document_processing_failed` log fields for observability.
4. **Contract test** — per `docs/test-plan.md`: worker failure-payload construction → rag-api failed-branch persistence, plus key-set drift guards on both sides.
5. **Verify** — run worker unit tests, rag-api unit tests, and the integration contract suite (`apps/ai-server/tests/integration/`). Confirm no other tests assert on the old single-key `{"error": ...}` payload (search worker/api test trees; none were identified in the verified evidence, but re-verify at implementation time).

## 5. Acceptance criteria mapping

| Definition acceptance | How met |
|---|---|
| Worker failure payload carries `error_message`, `stage`, `retryable` explicitly | §3.2 helper; asserted by contract test |
| Persisted `error` = actual message, `error_stage` = failing stage, `retryable` = derived value | rag-api failed branch unchanged, fed correct keys; asserted end-to-end in contract test |
| processing/summary error subdocument carries same message/stage | rag-api failed branch behavior (verified claim F4); asserted in contract test |
| Contract test exists and fails on key drift on either side | §test-plan: functional path test + key-set drift guards |

## 6. Risks

- **Unknown status-topic consumers reading old keys** — mitigated by retaining `error`; residual risk accepted (low).
- **Stage-tracker drift** as pipeline evolves — mitigated by update-before-await convention + representative-stage tests.
- **`retryable: false` for unrecognized transient errors** — accepted; widening `classify_error` is out of scope; manual reprocess remains.
- **Contract test ossifies the payload** — intentional; it is the drift guard.

## 7. Unknowns / not verified

- Exact line-level content of rag-api's `run_transactional_update` failed branch and `_fail_if_still_stale` was taken from the Definition's repository claims (F4, F5, F6) with evidence refs; implementers should re-read both functions before editing to confirm key names and the `error_code: "UNKNOWN"` default at the source.
- Whether any test currently asserts the old `{"error": ...}` payload shape was not exhaustively verified; check both services' test trees in step 5.
<<<END-SLE-ARTIFACT>>>
<<<SLE-ARTIFACT path="docs/test-plan.md">>>
# Test Plan: worker→rag-api failure payload contract

Run: a4a2f15b-a102-4b06-a47e-e30707e8a8cd

## 1. Goal

A contract test must cover the worker failure → rag-api persistence path: exercise the worker's failure-payload construction and rag-api's failed-branch persistence, and assert the persisted `error`, `error_stage`, and `retryable` equal the worker's values. The test must fail if either side's payload keys drift.

## 2. Test location and patterns

- New test module: `apps/ai-server/tests/integration/test_failure_payload_contract.py` (alongside the existing `test_api_contracts.py`, which supplies the house patterns: fixture- and AST-based static contract tests, plus import-both-sides dynamic tests).
- Both services support hermetic Firestore-emulator branches (`FIRESTORE_EMULATOR_HOST` in both `main.py` files — verified). Prefer the emulator for the end-to-end persistence assertion; fall back to fakes/mocks of the Firestore transaction if emulator availability in CI is a problem (decide at implementation time; the Definition permits "Firestore emulator or fakes").
- Import both real modules rather than restating the contract in a fixture: import the worker's failure-payload builder and `classify_error` from `rag-worker-service/main.py` (the existing worker test conftest at `rag-worker-service/tests/conftest.py` already stubs the heavy deps — langchain, openai, firebase_admin, google.cloud.*, spacy, tiktoken, tenacity — and can be reused/extended for the integration conftest), and rag-api's `run_transactional_update` from `rag-api-service/main.py`.

## 3. Test cases

### 3.1 Functional path (the core contract test)

`test_worker_failure_persists_actual_message_stage_and_retryable`

1. Build a failure payload by invoking the worker's failure-payload construction (the new `_build_failure_details(e, stage)` helper, or by driving `process_document` with a stubbed pipeline step that raises — prefer the helper directly for determinism, plus one `process_document`-level test below).
2. Feed the resulting `details` dict through rag-api's `run_transactional_update` failed branch against the Firestore emulator (or fake transaction), for a seeded resource document.
3. Assert on the persisted main document:
   - `error == "<worker's actual exception message>"` (not `"Processing failed"`)
   - `error_stage == "<worker's stage>"` (not `None`)
   - `retryable == <worker's derived value>`
4. Assert on the processing/summary error subdocument:
   - `message` equals the same worker message
   - `stage` equals the same worker stage
   - (`error_code` remains `"UNKNOWN"` — no code is sent)

Parameterize over at least:
- a transient-classified error (e.g. `httpx.ConnectTimeout("connection timed out")`) → `retryable is True`
- a permanent-classified error (e.g. `PermanentError("bad document")`) → `retryable is False`
- an unclassified-unknown error (e.g. `ValueError("weird failure")`) → `retryable is False` (pins the deliberate behavior change from silent-default-true)

### 3.2 Worker-side unit tests

Location: `apps/ai-server/rag-worker-service/tests/unit/test_failure_payload.py` (new).

- `test_failure_payload_has_required_keys`: payload contains exactly/at least `error_message`, `error`, `stage`, `retryable`; `error_message == error == str(e)`.
- `test_failure_payload_stage_tracking`: drive `process_document` with a stub that raises at an early step (e.g. `_get_extracted_text`) and a late step (e.g. `_generate_embeddings_with_openrouter`); assert the published failed-status details carry the corresponding stage from the progress vocabulary (`text_retrieved`-side early failure and `embeddings_complete`-side late failure). Representative stages only — do not pin every step.
- `test_failure_payload_unknown_stage_defaults_to_processing`: failure before the first stage transition reports `stage == "processing"`.
- `test_retryable_matches_classify_error`: for each parameterized exception, payload `retryable == classify_error(e)` (property-style: the payload never contradicts the classifier).
- Existing worker unit tests must continue to pass unchanged (no payload-consumer tests were identified in the verified evidence; re-verify at implementation time).

### 3.3 Key-set drift guards

Two complementary guards so a future edit to either side's keys fails the build:

- **Worker-side static guard** (AST or source-scan, following the `_get_agent_graph_shapes` pattern in `test_api_contracts.py`): assert the worker's failure-details construction emits the expected key set `{"error_message", "error", "stage", "retryable"}` — via the functional test in 3.1/3.2 asserting the exact key set (exact-set equality, not subset, so added/removed keys fail).
- **API-side static guard**: assert rag-api's failed branch reads exactly the expected keys. Implementation options (choose at implementation time, whichever is least brittle against the actual code shape):
  - AST scan of `run_transactional_update` for `details.get("error_message"...)`, `details.get("stage"...)`, `details.get("retryable"...)` accesses; or
  - a functional probe: call `run_transactional_update` with a details dict containing sentinel values for all three keys and assert all three persist (a dropped read surfaces as the fallback value appearing instead of the sentinel).
- **Cross-side consistency assertion** (in 3.1): assert `set(worker_payload.keys()) ⊇ set(keys rag-api reads)` — i.e. after persistence, no fallback default was operative. Concretely: seed details *without* relying on defaults, persist, and assert no persisted field equals rag-api's fallback values (`"Processing failed"`, `None` stage).

### 3.4 Drift-failure demonstration (acceptance check)

Verify the guard actually guards: temporarily (locally, not committed) rename `error_message` → `error_msg` in the worker helper and confirm 3.1 fails; restore. Same for an API-side key read. This validates the test fails on drift, per the Definition's acceptance item 4.

## 4. Regression / suite runs

- `apps/ai-server/rag-worker-service/tests/` (unit + integration) — full pass.
- `apps/ai-server/rag-api-service/tests/` — full pass (no API code changes expected; guards only).
- `apps/ai-server/tests/integration/` — including existing `test_api_contracts.py` (must be unaffected: `ResourceResponse` fields `error`, `error_stage` are untouched) and the new `test_failure_payload_contract.py`.
- Confirm `MOBILE_RESOURCE_FIELDS` in `test_api_contracts.py` still matches — no model changes in this fix, so it must.

## 5. Coverage vs. Definition acceptance

| Acceptance item | Covered by |
|---|---|
| Payload carries error_message/stage/retryable, no fallback reliance | 3.1 + 3.2 key-set assertions |
| Persisted error/error_stage/retryable = worker values | 3.1 end-to-end assertions |
| processing/summary subdocument carries same message/stage | 3.1 subdocument assertions |
| Contract test exists, passes, fails on either side's key drift | 3.1 + 3.3 + 3.4 |

## 6. Unknowns

- Exact signature/shape of `run_transactional_update`'s transaction handling (how to invoke it against the emulator vs. fakes) — re-read the function at implementation time; the Definition's F4 claim pins its read/persist behavior but not its call signature.
- Whether CI runs the Firestore emulator for `apps/ai-server/tests/integration/` — if not, use fakes for the persistence step; the Definition permits either.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>