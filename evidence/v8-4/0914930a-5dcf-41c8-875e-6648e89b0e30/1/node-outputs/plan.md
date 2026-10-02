<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/plan.md">>>
# Implementation Plan — rag-worker → rag-api Failure Payload Contract Alignment

**Cycle intent:** "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage"
**Authoritative spec:** wi-define-108-a8 (sha256 71f1c39c…89cac5)
**Status:** plan | **Planning depth:** minimal

---

## 1. Problem Statement

When a RAG processing job fails:

- The worker's exception handler in `process_document` (`apps/ai-server/rag-worker-service/main.py`) publishes `_publish_status_update(...)` with a single-key details payload `{"error": str(e)}`.
- rag-api's failed branch in `run_transactional_update` (`apps/ai-server/rag-api-service/main.py`) reads `details["error_message"]`, `details["stage"]`, and `details.get("retryable", True)` and persists them onto the main resource document as `error`, `error_stage`, `retryable`, plus `message`/`stage` (with `error_code` defaulting to `"UNKNOWN"`) into the processing/summary error subdocument.

Because the worker speaks `{error}` while rag-api reads `{error_message, stage, retryable}`, **every worker-originated failure persists**:
- `error` = the fallback string `"Processing failed"`
- `error_stage` = `None`
- `retryable` = `True` (silently fabricated by the API's `.get()` default)

This destroys user-facing diagnosability and misrepresents the worker's actual retry decision. Three other writers (worker's stale-lease sweep `_fail_if_still_stale`, rag-api's `/process` and `POST /resources` enqueue-failure paths) and both exposed models (`ResourceResponse`, `Resource` in `apps/ai-server/rag-api-service/models/resource.py`) already use the `error`/`error_stage`/`retryable` schema correctly. Only the worker's status publisher does not.

No contract test exists between the worker's failure publication and rag-api's failed-branch consumption, so key drift on either side goes undetected until runtime.

## 2. Solution Overview & Rationale

Align the worker to rag-api's contract — publish `error_message`, `stage`, and an explicitly-derived `retryable`; do not touch rag-api's readers or the persisted schema.

Why this direction wins:
- **Zero-migration constraint satisfied:** `error`/`error_stage`/`retryable` remain the persisted field names everywhere (constraint: must-not-change-schema).
- **Smallest ripple:** four call sites and two models already use those names; changing the API side would force coordinated edits across all of them.
- **Semantics improve:** the persisted record finally reflects reality — real message, true failing stage, and a `retryable` flag that matches the worker's own ACK/NACK behavior under `classify_error`.
- **Hedge preserved:** the legacy `error` key stays in the worker's outgoing payload for continuity with any unknown consumers/log tooling sharing the status topic (fact F11).

One deliberate, accepted behavior change: unclassified-unknown exceptions previously persisted `retryable: true` (silent default) but classify as *permanent* under `classify_error`; after this change they persist `retryable: false`. This is intentional conservatism preventing infinite retry loops; manual reprocess via `POST /process` remains unaffected. The stale-lease sweep's independent `retryable: true` write stays correct (dead worker = transient condition).

## 3. Detailed Design

### 3.1 Worker: stage tracking in `process_document`

Today `process_document` is one large `try` block; at failure time nothing records which pipeline step was running.

Add a mutable local stage tracker initialized once at function entry:

```python
current_stage = ["processing"]
```

A one-element list (or equivalent closure-friendly container) lets nested helpers update it without `nonlocal` gymnastics. Immediately **before** each pipeline step, assign the stage name corresponding to that step. Stage names MUST reuse the existing progress-status vocabulary observed in the worker's progress updates (facts F9):

| Value | Meaning |
|---|---|
| `starting` | initial fetch/setup phase |
| `text_retrieval` boundary steps up to retrieval completion |
| `tagging_complete` | during tagging/completion transitions |
| `summary_generated` | during summarization |
| `chunking_complete` | during chunking |
| `embeddings_complete` | during embedding generation |

(Implementation detail: the precise assignment point per step follows wherever each matching `_publish_status_update` progress call sits in `process_document`; the tracker mirrors that sequence.)

Safety rule: if a failure occurs before the very first transition, the reported stage must fall back to `"processing"` — the same sentinel value the worker's own `_fail_if_still_stale` uses for `error_stage`, guaranteeing the persisted `error_stage` never regresses to `null`.

### 3.2 Worker: retryable derivation

Use the existing classifier, which already drives ACK/NACK in `run_worker` (fact F7):

```python
classification = classify_error(exc)
retryable = isinstance(classification, TransientError)   # or bool(transient-marker)
```

Contract:
- Errors classified **transient** → `retryable=True` (Pub/Sub NACK ⇒ will be redelivered; persisted flag agrees).
- Errors classified **permanent**, including unclassified-unknown (conservative default of `classify_error`) → `retryable=False` (acked; manual reprocess via `POST /process` remains).
- Derivation is unconditional: the payload ALWAYS carries `retryable`; rag-api's `details.get("retryable", True)` fallback must never become the operative mechanism for worker failures (constraint: must).

### 3.3 Worker: failure payload shape

Replace the current one-key emission inside the `except` block with:

```python
_publish_status_update(
    resource_id,
    "failed",
    {
        "error":         str(exc),          # legacy key retained (prefer constraint)
        "error_message": str(exc),
        "stage":         current_stage[0],
        "retryable":     retryable,
    },
)
```

Rules:
- `error_message` = the raw `str(exc)` — the actual exception message, verbatim.
- `stage` = tracked value, guaranteed non-empty (initialized to `"processing"`).
- Legacy `error` key kept **in addition to** `error_message` (preference honored; harmless duplication for forward compatibility).
- No structured error codes introduced (prefer-not constraint); rag-api continues writing `error_code: "UNKNOWN"` since the worker sends no code.

### 3.4 rag-api: no functional change

Verify-only adjustments permitted within scope:
- The failed branch of `run_transactional_update` is left semantically intact: `error ← error_message`, `error_stage ← stage`, `retryable ← retryable`, processing/summary subdoc gets `message` + `stage`, `error_code` default `"UNKNOWN"`.
- If review reveals incidental hardening opportunities strictly needed for the contract test harness (e.g., making the transaction callable independently of a live subscription), those are allowed ONLY if they don't alter persisted field names, semantics, or defaults.

Explicitly untouched (per non-goals):
- Stale-lease sweep `_fail_if_still_stale` (already conforms).
- Enqueue-failure paths in `/process` and `POST /resources` (already conform).
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, leases, heartbeats.
- Frontend/mobile (no client-visible schema change whatsoever).
- Error taxonomies/codes.

## 4. Files To Modify

| File | Change |
|---|---|
| `apps/ai-server/rag-worker-service/main.py` | ① add stage-tracking local(s) to `process_document`; ② rewrite exception-handler payload to `{error, error_message, stage, retryable}`; ③ derive `retryable` via `classify_error`. Possibly extract payload-building into a small helper for unit-testability (optional, internal refactor only). |
| `apps/ai-server/tests/integration/test_api_contracts.py` | New contract test (see §5). |

Files NOT modified: everything else. Zero DB/index/migration artifacts touched.

## 5. Testing Strategy

### 5.1 Existing suite health
Run pre-existing suites first to establish baseline greenness:
- `apps/ai-server/rag-worker-service/pytest.ini`-driven unit tests (incl. `test_processing_lease.py`)
- `apps/ai-server/rag-api-service` pytest config
- Repo-wide integration fixtures under `apps/ai-server/tests/`

Baseline results noted; regressions attributable to this change must show zero delta.

### 5.2 New contract test (REQUIRED by acceptance criterion C4)

Location: extend `apps/ai-server/tests/integration/test_api_contracts.py` following its existing pattern (fixture-driven static checks + optional emulator-backed dynamic checks — fact F10 confirms infra readiness).

Test design principles:
- Import BOTH modules (`rag-worker.main.process_document-or-equivalent payload builder` and `rag-api.run_transactional_update`) rather than restating the contract inline in a fixture.
- Path exercised end-to-end at the logical level:
  1. Trigger/construct a representative failure through the worker's code path (either invoke a refactored pure "build failure payload" helper OR simulate the except-block result deterministically using a stubbed dependency chain).
  2. Feed resulting dict directly into rag-api's `run_transactional_update` against the Firestore emulator (`FIRESTORE_EMULATOR_HOST` branch) — falling back to a faithful fake ONLY if emulator startup proves flaky in CI; prefer emulator.
  3. Read back the persisted resource doc and assert ALL THREE:
     - `persisted.error == worker_payload.error_message` (NOT `"Processing failed"`)
     - `persisted.error_stage == worker_payload.stage` (NOT `None`)
     - `persisted.retryable == worker_payload.retryable`
  4. Also inspect the processing/summary error subdocument: same `message` and `stage`; `error_code == "UNKNOWN"`.

Drift guards (must exist per acceptance):
- Static assertion enumerating the exact expected key set `{error, error_message, stage, retryable}` emitted by the worker — e.g., introspect the built payload object itself post-hoc in an isolated invocation, asserting `set(payload.keys()) == EXPECTED_KEYS` byte-for-byte.
- Mirror-guard reading rag-api's failed-branch key expectations (either via parsing constants/imported symbols or via a second emulator round-trip feeding mutated payloads and confirming strictness).
- Both directions covered: adding/removing a key on EITHER side causes test failure, not silent pass-through.

Additional targeted unit coverage (new, colocated with worker tests dir shown above):
- `test_failure_payload.py`: given various synthetic exceptions routed through `classify_error` mapping table, verify `(payload.message, payload.stage, payload.retryable)` triples match expectation matrix {transient→true, permanent→false, unknown-type→false}.
- Verify stage-fallback logic: exception raised before ANY stage-transition line yields `stage == "processing"`, never empty/null.

Existing-behavior regression checks embedded in the same PR:
- Confirm successful-completions still route identical progress/status messages (snapshot diff of happy-path payload keys shows NO unintended additions).
- Confirm stale-sweep writes unchanged.

## 6. Acceptance Criteria Mapping

Each AC below maps to concrete deliverables above; all must hold post-build.

1. ✅ Failed-job status payload includes `error_message`, `stage`, `retryable`, none relying on API fallbacks. → §3.3 + §5.2 assertions.
2. ✅ Persisted doc has real `error` ≠ `"Processing failed"`, non-null `error_stage`, correct `retryable`. → §5.2 emulator round-trip verification.
3. ✅ Processing/summary subdoc mirrors message+stage. → §5.2 sub-document check.
4. ✅ Contract test exercising worker→API path passing, drifting detection both ways. → §5.2 full flow incl. mutation-based drift traps.

## 7. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Unknown downstream consumers break due to extra keys | Low | Very low | Keys ADDitive only; legacy `error` retained (§3.3); extras ignored by tolerant parsers typical of pub/sub JSON handlers. |
| Emulator instability inflates CI flakes | Medium | Low | Deterministic seed data; documented skip-with-warning escape hatch logged loudly if triggered ≥ twice consecutively, prompting switch to hardened fake. |
| Refactor touches unrelated logic accidentally | Medium | Low | Strict surgical diffs confined to identified hunks; reviewer checklist tied to §4 file-list exhaustiveness. |
| Behavior change surprises operators (retry=false on unknowns) | Low | Certain-by-design | Called out prominently in commit message + changelog notes referencing rationale paragraph in §2. |

## 8. Out-of-Scope Items Explicitly Deferred

Per Definition non-goals and fact F12 (DEFERRED):
- Companion D3 issue contents (unavailable here) — excluded entirely.
- Reconciling historical dev-note D4 (referenced in obsolete `plans/upload-flow.md`, absent from current tree) — skipped.
- Any broader observability/alerting instrumentation beyond the mandated contract test.
- Any restructuring of `process_document`'s control flow beyond inserting stage trackers and rewriting the except clause.

## 9. Execution Order Summary

1. Baseline test runs (green confirmation).
2. Implement worker changes (§3.1–3.3) + focused unit tests (§5.2 tail bullets).
3. Implement contract test (§5.2 core) wired to updated worker module.
4. Full-suite rerun; confirm zero unrelated deltas.
5. Manual smoke (emulator-up locally): inject artificial PermanentException mid-run; visually inspect Firestore doc showing corrected triple + sub-doc mirroring.
6. Final self-check against AC list (§6) before hand-off.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>