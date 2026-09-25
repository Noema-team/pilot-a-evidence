---
schemaVersion: 1
goal: >-
  Align the rag-worker's failure status payload with rag-api's failed-branch contract so that a failed RAG processing
  job persists the worker's actual error message, the failing pipeline stage, and a deliberately derived retryable flag
  — locked in by a contract test on the worker→rag-api failure path.
facts:
  - id: F1
    statement: >-
      A failed RAG processing job must persist the worker's actual error message and failing stage so users and support
      can disambiguate failures; retryable must be sent by the worker or derived deliberately, never silently defaulted.
    status: KNOWN
    source: human
    kind: product-intent
  - id: F2
    statement: >-
      The preferred fix direction is aligning the worker's payload keys to error_message/stage — matching rag-api's
      persisted fields — because it avoids a schema migration.
    status: KNOWN
    source: human
    kind: product-intent
  - id: F3
    statement: >-
      The worker publishes failed status with details {"error": str(e)} from process_document's exception handler via
      _publish_status_update.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py (process_document exception handler)
  - id: F4
    statement: >-
      rag-api's failed branch (run_transactional_update) reads details keys error_message, stage, and retryable;
      persists error, error_stage, and retryable on the main resource document; and writes message/stage (with
      error_code defaulting to "UNKNOWN") into the processing/summary subdocument.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-api-service/main.py (run_transactional_update failed branch)
  - id: F5
    statement: >-
      Because of the key mismatch, every worker-originated failure currently persists error as the fallback "Processing
      failed", error_stage as None, and retryable as the silent default True.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py + apps/ai-server/rag-api-service/main.py
  - id: F6
    statement: >-
      error/error_stage/retryable are the established persisted failure schema: the worker's stale-lease sweep
      (_fail_if_still_stale) and rag-api's enqueue-failure paths (/process, POST /resources) write them directly, and
      ResourceResponse plus the Resource model expose them (retryable defaults True).
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: >-
      apps/ai-server/rag-worker-service/main.py; apps/ai-server/rag-api-service/main.py;
      apps/ai-server/rag-api-service/models/resource.py
  - id: F7
    statement: >-
      The worker classifies exceptions as transient or permanent via classify_error() (TransientError/PermanentError
      plus type- and status-code heuristics; unknown exceptions classify as permanent) and uses that classification for
      ACK/NACK decisions in run_worker.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py (classify_error, run_worker)
  - id: F8
    statement: >-
      Adopted default for the retryable derivation: the worker sets retryable from classify_error(e) —
      transient-classified errors map to true, permanent-classified (including unclassified-unknown, per
      classify_error's conservative default) to false. Rationale: this aligns the persisted record with the worker's
      actual ACK/NACK retry behavior (transient = Pub/Sub will redeliver; permanent = acked, manual reprocess via POST
      /process remains), and the stale-lease sweep's separate retryable=true write stays correct because a dead worker
      is a transient condition.
    status: ASSUMED
    source: investigation
  - id: F9
    statement: >-
      The worker publishes named stages in its progress status updates (starting, text_retrieved, tagging_complete,
      summary_generated, chunking_complete, embeddings_complete, completed), but the failure handler has no stage
      tracking today, so the failing stage cannot currently be reported.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py (process_document, _publish_status_update calls)
  - id: F10
    statement: >-
      Contract-test infrastructure exists (apps/ai-server/tests/integration/test_api_contracts.py, fixture- and
      AST-based static contract tests) and both services support a hermetic Firestore-emulator mode
      (FIRESTORE_EMULATOR_HOST branches), so a worker→rag-api failure-path contract test is implementable with existing
      patterns.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/tests/integration/test_api_contracts.py
  - id: F11
    statement: >-
      No consumer other than rag-api's status subscriber is known to parse the worker's failure payload keys; as a
      hedge, the worker will retain the legacy `error` key alongside the new error_message key so any unknown consumer
      of the status topic keeps working.
    status: ASSUMED
    source: investigation
  - id: F12
    statement: >-
      The Objective references a companion D3 issue filed alongside this one (and original analysis in
      plans/upload-flow.md as deviation D4, a file not present in the current tree); that issue's scope is not available
      in this context, and anything it covers beyond the worker→rag-api failure payload alignment is outside this
      Definition's bounded scope.
    status: DEFERRED
    source: human
constraints:
  - description: >-
      The worker must be aligned to rag-api's existing contract — publishing error_message/stage/retryable — rather than
      changing rag-api's reads or persisted schema.
    type: must
  - description: >-
      The fix must not require a Firestore migration, field rename, or backfill of existing documents; the persisted
      fields (error, error_stage, retryable) keep their names and semantics.
    type: must_not
  - description: >-
      Every worker-originated failure payload must carry retryable explicitly (deliberately derived); the API-side
      details.get("retryable", True) fallback must not be the operative mechanism for worker failures.
    type: must
  - description: >-
      Prefer retaining the legacy `error` key in the worker's failure payload alongside error_message, for continuity
      with any existing consumers of the status topic and log tooling.
    type: prefer
  - description: Prefer not to introduce a structured error-code taxonomy (error_code values) in this fix.
    type: prefer_not
requirements:
  - >-
    When document processing fails, the worker's failed status payload must include error_message (the actual exception
    message), stage (the pipeline stage executing at failure time), and retryable (deliberately derived) — the payload
    must never rely on rag-api's fallback defaults for these keys.
  - >-
    The worker must track the currently executing pipeline stage through process_document so the failure handler reports
    the true failing stage; stage names must reuse the existing progress-stage vocabulary (starting, text_retrieved,
    tagging_complete, summary_generated, chunking_complete, embeddings_complete), with "processing" as the safe value
    when the stage is genuinely unknown.
  - >-
    rag-api's failed branch must persist the worker-provided values unchanged: main document error ← payload
    error_message, error_stage ← payload stage, retryable ← payload retryable; the processing/summary error subdocument
    must carry the same message and stage.
  - >-
    The retryable derivation must be explicit and aligned with the worker's ACK/NACK behavior: errors classified
    transient by classify_error → retryable true; classified permanent (including unclassified-unknown, per
    classify_error's conservative default) → retryable false.
  - >-
    A contract test must cover the worker failure → rag-api persistence path: it must exercise the worker's
    failure-payload construction and rag-api's failed-branch persistence (via the Firestore emulator or fakes) and
    assert the persisted error, error_stage, and retryable equal the worker's values; it must fail if either side's
    payload keys drift.
nonGoals:
  - >-
    Changing the stale-lease sweep's direct failure write — it already persists error/error_stage/retryable consistently
    with this contract.
  - >-
    Changing retry/backoff mechanics: Pub/Sub ACK/NACK policy, processing leases, or heartbeat intervals — only the
    reporting of retryability in the payload changes.
  - Frontend or mobile changes — ResourceResponse already exposes error and error_stage to clients.
  - >-
    Introducing structured error codes or a failure taxonomy — the processing/summary error.code remains "UNKNOWN"
    unless a code is actually sent.
  - >-
    Any scope the companion D3 issue covers beyond this worker→rag-api failure payload alignment (its content is
    unavailable here; deferred).
acceptance:
  - description: >-
      A failed job's status message published by the worker contains error_message (actual exception message), stage
      (failing pipeline stage), and retryable (deliberately derived) — none relying on rag-api's fallback defaults.
    met: false
  - description: >-
      After a failed job, the persisted resource document has error = the worker's actual error message (not "Processing
      failed"), error_stage = the failing stage (not None), and retryable = the worker's derived value.
    met: false
  - description: >-
      The processing/summary error subdocument for the failed job carries the same message and stage as the main
      document.
    met: false
  - description: >-
      A contract test covering the worker failure → rag-api persistence path exists and passes: it exercises the
      worker's failure-payload construction through rag-api's failed-branch persistence and asserts the persisted error,
      error_stage, and retryable equal the worker's values, failing if either side's payload keys drift.
    met: false
---

## What's actually broken

The worker's failure publisher and rag-api's failure consumer were written against different contracts and nobody tests the seam. The worker's exception handler in `process_document` publishes a one-key payload (`{"error": str(e)}`); rag-api's failed branch reads three keys (`error_message`, `stage`, `retryable`) and persists them as `error`/`error_stage`/`retryable`. Every worker failure therefore lands in Firestore as the fallback string "Processing failed", a null stage, and a fabricated `retryable: true`. The `processing/summary` error subdocument inherits the same fallbacks, with `error_code` always "UNKNOWN". The stale-lease sweep in the worker, rag-api's enqueue-failure paths, and the `Resource` model all already use the `error`/`error_stage`/`retryable` schema — the worker's status publisher is the only writer that doesn't speak it.

## Direction: the worker aligns to the API

The Objective prefers aligning the worker to `error_message`/`stage`, and the repository evidence makes that more than the cheap option: the persisted field names are already consistent across three other write paths and two API response models, so changing the API side would be the change that ripples. The worker is the odd one out; fix the odd one out. No migration, no backfill, no reader changes.

## Stage tracking

`process_document` is one large try block, so at failure time nothing knows where it was. The fix is a stage tracker: a local that is set immediately before each pipeline step and reported by the exception handler. Stage names reuse the existing progress-update vocabulary (`starting`, `text_retrieved`, `tagging_complete`, `summary_generated`, `chunking_complete`, `embeddings_complete`) so a failure stage reads naturally next to the progress timeline clients already see. When the stage is genuinely unknown (e.g. failure before the first transition), the safe value is `"processing"` — the same value the stale-lease sweep uses for `error_stage`, so the field never regresses to null.

Known drift risk: a future pipeline step added without updating the tracker reports a stale stage. The convention is "set the tracker immediately before the await"; the contract test pins the mechanism on representative stages (an early-stage failure and a late-stage failure), which is enough to catch the tracker being removed or bypassed without ossifying every step.

## retryable: derive, don't default

The worker already classifies every exception as transient or permanent via `classify_error()` — that classification drives ACK/NACK in `run_worker`. Deriving `retryable` from the same function makes the persisted record tell the truth: a transient error is one Pub/Sub will redeliver (retryable true); a permanent error was acked and will not come back (retryable false, manual reprocess via `POST /process` still available).

One deliberate behavior change falls out: unclassified-unknown exceptions currently persist `retryable: true` (the silent default) but classify as permanent, so they will now persist `false`. That is the conservatism `classify_error` was written for — it prevents infinite retry loops — and the manual reprocess path is unaffected. The stale-lease sweep's direct write keeps `retryable: true`, which stays correct: a worker dying mid-extraction is a transient condition by nature.

## Compatibility hedge

Only rag-api's status subscriber was verified as a consumer of these payloads; other services and tooling share the topic. Rather than audit every potential consumer for this one-line fix, the worker retains the legacy `error` key alongside `error_message` — one redundant string per failure message as insurance against an unknown reader. If a later audit confirms the worker is the only publisher and rag-api the only consumer, dropping the duplicate is trivial cleanup.

## Test strategy

The contract test should import both sides rather than restate the contract in a fixture: build the failure payload through the worker's code path, feed it through rag-api's `run_transactional_update` against the Firestore emulator (or fakes), and assert the persisted `error`, `error_stage`, and `retryable`. Add a key-set drift guard so a future edit to either side's keys fails the build instead of silently re-creating this bug. The house pattern already exists in `tests/integration/test_api_contracts.py`, and both services have emulator branches supporting hermetic runs.

## Risks and tradeoffs

- **Unknown consumers of the status topic** reading the old key set — mitigated by retaining `error`; residual risk accepted as low.
- **Stage-tracker drift** as the pipeline evolves — mitigated by the update-before-await convention and representative-stage test coverage.
- **retryable=false for unclassified errors** may reduce auto-retry affordances for genuinely transient-but-unrecognized failures — accepted; widening `classify_error` is out of scope, and manual reprocess remains.
- **The contract test ossifies the payload** — intentional; that is the drift guard doing its job. Adding a key later means touching the test, which is the point.

## Out of scope

A structured error-code taxonomy (summary `error.code` stays "UNKNOWN" unless a code is actually sent), retry/backoff mechanics (ACK/NACK policy, leases, heartbeats — only the *reporting* of retryability changes), the sweep's behavior, and any frontend work (`ResourceResponse` already exposes `error`/`error_stage`). The companion D3 issue referenced by the Objective is not available in this context; anything it covers beyond this payload alignment is deferred, as is reconciling this analysis with the original D4 deviation note in `plans/upload-flow.md` (that file is not present in the current tree — the reference comes from the Objective text).
