Design notes for the plan:

- **Worker side**: add a mutable stage tracker local to `process_document`, set immediately before each pipeline step using the existing progress-vocabulary stage names, defaulting to `"processing"` pre-first-step. In the exception handler publish `{error_message, error, stage, retryable}` with `retryable = isinstance-derived from classify_error(e)` (transient→true, permanent/unclassified→false).
- **Rag-api side**: zero code changes — its failed branch already reads those keys.
- **Contract test**: extend `apps/ai-server/tests/integration/test_api_contracts.py` with a worker→rag-api failure-path case exercising real payload-construction functions and `run_transactional_update` under the Firestore emulator/fakes, asserting persisted `error`/`error_stage`/`retryable` equality, plus a key-drift guard on the emitted payload key set. Cover one early-stage and one late-stage failure representationally.

<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/requirements.md">>>
# Requirements & Architecture — Worker Failure Payload Contract Alignment

Run: 04d1e224-0ff1-4bd9-8dfe-6ed25afd1df6 · Iteration 1 · Step: design
Authoritative spec: wi-define-108-a8 (definition:obj-108)

## Goal

Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag — pinned by a contract test on the worker→rag-api failure path.

## Problem Statement

The worker's exception handler in `process_document` publishes `details={"error": str(e)}`, while rag-api's failed branch (`run_transactional_update`) reads `error_message`, `stage`, and `retryable`. Due to the key mismatch, every worker-originated failure persists:
- `error` = fallback `"Processing failed"`
- `error_stage` = `None`
- `retryable` = silent default `True`

The `processing/summary` error subdocument inherits the same fallbacks with `error_code` defaulting to `"UNKNOWN"`. Three other writers (worker stale-lease sweep `_fail_if_still_stale`, rag-api `/process` and `POST /resources` enqueue-failure paths) and two readers (`ResourceResponse`, `Resource` model) already use the `error`/`error_stage`/`retryable` schema. The worker's status publisher is the sole misaligned writer.

## Functional Requirements

### FR1 — Failure payload completeness (must)
When document processing fails, the worker's failed status payload MUST include:
- `error_message`: the actual exception message (`str(e)`)
- `stage`: the pipeline stage executing at failure time
- `retryable`: deliberately derived (see FR3)

The payload MUST NOT rely on rag-api's fallback defaults for any of these keys.

### FR2 — Stage tracking (must)
The worker MUST track the currently executing pipeline stage through `process_document` so the failure handler reports the true failing stage.
- Mechanism: a mutable local variable set immediately BEFORE each pipeline step (convention: "update the tracker right before the await").
- Stage name vocabulary MUST reuse the existing progress-status stages: `starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`.
- Safe fallback value when the stage is genuinely unknown (failure before the first tracked transition): `"processing"` — the same value the stale-lease sweep uses for `error_stage`, ensuring the field never regresses to null.

### FR3 — Deliberate retryable derivation (must)
The worker MUST set `retryable` from `classify_error(e)`:
- Transient-classified → `retryable: true` (Pub/Sub NACK/redelivery matches)
- Permanent-classified (including unclassified-unknown, per `classify_error`'s conservative default) → `retryable: false`

Accepted behavioral consequence: previously-silent-default `retryable: true` becomes `false` for unclassified-unknown exceptions. Manual reprocess via `POST /process` remains available. Widening `classify_error` itself is out of scope.

### FR4 — Rag-api passthrough fidelity (must)
Rag-api's failed branch MUST persist the worker-provided values unchanged:
- Main document: `error` ← payload `error_message`, `error_stage` ← payload `stage`, `retryable` ← payload `retryable`
- Processing/summary error subdocument: same message and stage; `error_code` remains `"UNKNOWN"` (no code is sent).

No reader or persisted-schema changes on the rag-api side.

### FR5 — Legacy key compatibility (prefer)
The worker MUST retain the legacy `error` key (same string as `error_message`) in the failure payload alongside `error_message`, hedging against unknown consumers/log tooling of the shared status topic. Dropping the duplicate is acceptable future cleanup once the only consumer (rag-api's status subscriber) is confirmed.

### FR6 — Contract test pinning the seam (must)
A contract test MUST exist covering the worker failure → rag-api persistence path:
- Import BOTH sides rather than restating the contract in fixtures.
- Exercise the worker's failure-payload construction (real code path) fed through rag-api's `run_transactional_update` failed branch, against the Firestore emulator or equivalent fakes (both services already support `FIRESTORE_EMULATOR_HOST` hermetic modes; house pattern lives in `apps/ai-server/tests/integration/test_api_contracts.py`).
- Assert persisted `error`, `error_stage`, and `retryable` EQUAL the worker's constructed values.
- Include a payload-key drift guard: any addition/removal/change to either side's key set fails the build.
- Coverage shape: representational, not exhaustive — at minimum one early-stage failure and one late-stage failure to verify the stage tracker isn't removed/bypassed, without ossifying every pipeline step.

## Constraints

| Type | Constraint |
|---|---|
| must | Fix direction: worker aligns to rag-api's existing contract (`error_message`/`stage`/`retryable`); no rag-api read/schema changes. |
| must_not | No Firestore migration, field rename, or backfill; `error`/`error_stage`/`retryable` keep names and semantics. |
| must | Every worker failure payload carries `retryable` explicitly; the API-side `.get("retryable", True)` fallback must not be operative for worker failures. |
| prefer | Retain legacy `error` key in the failure payload for continuity. |
| prefer_not | No structured error-code taxonomy introduced in this fix. |

## Non-Goals

- Stale-lease sweep behavior — its direct failure write already conforms.
- Retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, heartbeats — only the *reporting* of retryability changes.
- Frontend/mobile — `ResourceResponse` already exposes `error` and `error_stage`.
- Structured error codes / failure taxonomy — `summary.error.code` stays `"UNKNOWN"` unless a code is actually sent.
- Companion D3 issue scope (unavailable in this context) and reconciliation with plans/upload-flow.md D4 (file absent from tree) — deferred.

## Acceptance Criteria

1. ✅ A failed job's worker-published status message contains `error_message` (actual exception message), `stage` (failing stage), and `retryable` (derived) — none falling back to rag-api defaults.
2. ✅ Persisted resource document post-failure: `error` = actual worker message (≠ "Processing failed"); `error_stage` = failing stage (≠ null); `retryable` = worker-derived value. Processing/summary error subdocument carries the same message and stage.
3. ✅ Contract test over worker-failure → rag-api-persistence exists and passes, asserting persisted-field equality and failing on key drift on either side.

## Architecture Sketch

```
┌─────────────── rag-worker ───────────────┐        ┌────────────── rag-api ───────────────┐
│                                          │        │                                      │
│  process_document(document_id):          │        │  run_transactional_update(failed):   │
│    stage = "processing"                  │        │    err   = d["error_message"]        │
│    # before each step:                   │ PubSub │    stage = d["stage"]                │
│    stage = "<step-name>"; await step()   │──msg──▶│    ret   = d["retryable"]            │
│                                          │ topic  │    doc.update(error=err,             │
│  except Exception as e:                  │        │              error_stage=stage,      │
│    cls = classify_error(e)               │        │              retryable=ret)          │
│    _publish_status_update(               │        │    proc_doc.set(message=err,         │
│      stage="failed",                     │        │              stage=stage,            │
│      details={                           │        │              code="UNKNOWN")         │
│        "error_message": str(e),          │        │                                      │
│        "error": str(e),     # legacy     │        │  (unchanged — already compliant)     │
│        "stage": stage,                   │        │                                      │
│        "retryable": cls == TRANSIENT,    │        │                                      │
│    })                                    │        │                                      │
└──────────────────────────────────────────┘        └──────────────────────────────────────┘
```

Key components touched:
1. `apps/ai-server/rag-worker-service/main.py` — `process_document`: add stage tracker local; update before each awaited step; rewrite exception-handler detail dict to the four-key payload above.
2. `apps/ai-server/rag-api-service/main.py` — NO functional change (reads already match); surfaced only as the assertion target of the contract test.
3. `apps/ai-server/tests/integration/test_api_contracts.py` — new failure-path contract test importing both modules, running the worker's builder then rag-api's transactional update against emulator/fakes, asserting persisted triple and guarding the payload key set.

Risk register (carried forward):
- Unknown topic consumers of dropped/moved keys → mitigated by retained `error` key; residual risk low.
- Future pipeline steps forgetting the tracker → mitigated by "before the await" convention + representative-stage tests.
- Unclassified errors flip retryable true→false → intended conservatism; manual reprocess preserved.
- Contract test ossification → intentional drift-guard property.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>