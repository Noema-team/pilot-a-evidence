---
schemaVersion: 1
goal: >-
  Align the rag-worker's "failed" status payload with the keys rag-api's failed branch persists, so a failed job
  persists the worker's actual error message and failing stage with a deliberately-reported retryable — pinned by a
  contract test on the worker→rag-api persistence path.
facts:
  - id: F1
    statement: >-
      Failures must be disambiguatable from the persisted record: a failed job persists the worker's actual error
      message and failing stage, and retryable is reported deliberately rather than silently defaulted.
    status: KNOWN
    source: human
    kind: product-intent
  - id: F2
    statement: >-
      The alignment direction is worker → rag-api: the worker adopts rag-api's expected keys (error_message/stage),
      matching rag-api's persisted fields and avoiding a migration.
    status: KNOWN
    source: human
    kind: product-intent
  - id: F3
    statement: >-
      On processing failure the worker publishes status "failed" with details {"error": str(e)} — no error_message,
      stage, or retryable keys.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py
  - id: F4
    statement: >-
      rag-api's failed branch persists error = details.get("error_message", "Processing failed"), error_stage =
      details.get("stage"), retryable = details.get("retryable", True), and additionally writes a processing/summary
      error record from details' error_code/error_message/stage.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-api-service/main.py
  - id: F5
    statement: >-
      The combination of F3 and F4 means every worker-reported failure currently persists the fallback string
      "Processing failed", error_stage = None, and retryable = True regardless of the actual error.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-api-service/main.py
  - id: F6
    statement: >-
      The worker's progress path already publishes stage in details ("starting", "text_retrieved", "tagging_complete",
      "summary_generated", "chunking_complete", "embeddings_complete"); only the failure path omits it.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py
  - id: F7
    statement: >-
      The worker classifies exceptions as transient or permanent via classify_error(e), already used for Pub/Sub
      ACK/NACK decisions in run_worker.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py
  - id: F8
    statement: >-
      The persisted failure fields are consumed downstream: rag-api's Resource model and ResourceResponse expose
      error/error_stage (retryable is persisted on Resource but not exposed via ResourceResponse), the
      resource_response.json contract fixture expects error/error_stage, and mobile's Resource.fromJson reads
      error/error_stage.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-api-service/models/resource.py
  - id: F9
    statement: >-
      Two failure producers bypass the status pipeline and already write the persisted names directly to Firestore: the
      worker's stale-lease sweeper (_fail_if_still_stale writes error/error_stage/retryable) and rag-api's
      enqueue-failure rollbacks (error/error_stage="enqueue").
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py
  - id: F10
    statement: >-
      An integration test suite exists at apps/ai-server/tests/integration whose conftest mocks Firebase/Pub/Sub and
      imports rag-api main directly; test_api_contracts.py asserts model/fixture contract shapes. No existing test
      covers the worker failure → rag-api persistence path.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/tests/integration/conftest.py
  - id: F11
    statement: >-
      retryable will be derived in the worker from classify_error(e) — transient → true, permanent → false. Rationale:
      the acceptance criterion authorizes "sent or derived deliberately"; classify_error already exists (F7) and its
      transient/permanent distinction is exactly the retryability signal; deriving avoids fabricating retryable=true for
      permanent failures (invalid input, permission errors).
    status: ASSUMED
    source: investigation
  - id: F12
    statement: >-
      The worker will track the current pipeline stage in process_document (updated at each stage transition) and
      include it as stage in the failure payload. Rationale: stage values already exist on the progress path (F6);
      threading the last-entered stage into the exception handler is the minimal mechanism and keeps the persisted
      vocabulary identical to the progress events users already see.
    status: ASSUMED
    source: investigation
  - id: F13
    statement: >-
      The contract test will live in apps/ai-server/tests/integration and verify alignment between the worker's failure
      payload keys and run_transactional_update's failed-branch reads — e.g. by feeding a worker-shaped details payload
      through run_transactional_update with the mocked firestore.transactional made pass-through, or by asserting the
      key sets from both sources. Rationale: the suite already imports rag-api main with mocked cloud SDKs (F10); the
      exact mechanism is implementation latitude.
    status: ASSUMED
    source: investigation
  - id: F14
    statement: >-
      plans/upload-flow.md — cited by the Objective as recording the original analysis (deviation D4) — is not present
      in the current working tree (plans/ contains no such file). Provenance context only; the mismatch itself is fully
      verifiable in the live code on both sides.
    status: KNOWN
    source: repository
    evidenceRef: plans/
constraints:
  - description: >-
      The worker aligns to rag-api: the failure payload adopts the keys rag-api's failed branch reads (error_message,
      stage, retryable); rag-api's failed branch is not modified.
    type: must
  - description: >-
      The persisted failure field names on the resource document (error, error_stage, retryable) and their readers
      (Resource model, ResourceResponse, mobile Resource.fromJson, resource_response.json fixture) must not be renamed
      or reshaped.
    type: must_not
  - description: >-
      The status-message envelope (user_id, course_id, resource_id, status, details, timestamp, sequence) and the
      Pub/Sub topics must not change — only the failure details keys.
    type: must_not
  - description: >-
      Keep the change minimal: fix the single failure publish site in process_document's exception handler; do not
      refactor the status-publishing machinery or the stage vocabulary.
    type: prefer
  - description: >-
      Do not introduce failure-payload keys beyond error_message, stage, and retryable (no error_code taxonomy in this
      scope).
    type: prefer_not
requirements:
  - >-
    When document processing fails, the worker's "failed" status message details include the actual exception message
    under the key error_message (replacing the current error key).
  - >-
    The worker's "failed" status message details include the pipeline stage in progress at failure under the key stage,
    using the same stage vocabulary as the progress updates.
  - >-
    The worker's "failed" status message details include retryable, derived from the worker's existing
    transient/permanent error classification (classify_error) rather than omitted or hardcoded.
  - >-
    After rag-api applies a worker-reported failure, the resource document persists the worker's actual message in
    error, the failing stage in error_stage, and the worker-reported value in retryable — the "Processing failed"
    fallback and a null error_stage no longer occur for worker-reported failures.
  - >-
    A contract test in apps/ai-server/tests/integration covers the worker failure → rag-api persistence path and fails
    when the worker's failure payload keys or rag-api's failed-branch read keys change independently.
  - >-
    Existing contract coverage (test_api_contracts.py and the resource_response.json fixture) continues to pass
    unchanged.
nonGoals:
  - >-
    Renaming or migrating the persisted failure fields (error, error_stage, retryable) or changing rag-api's reader
    contract (Resource model, ResourceResponse, mobile Resource.fromJson, resource_response.json fixture).
  - >-
    Introducing an error-code taxonomy or sending error_code from the worker (rag-api's summary error.code keeps its
    "UNKNOWN" default).
  - >-
    Changing the retry/re-enqueue machinery itself (ALLOWED_TRANSITIONS failed→queued, POST /process) or the stale-lease
    sweeper's direct failure writes.
  - >-
    Changing the worker's Pub/Sub ACK/NACK behavior (classify_error handling in run_worker), the status-message
    envelope, or the topics.
  - Backfilling or correcting failure records already persisted for previously failed resources.
acceptance:
  - description: >-
      Given a simulated mid-pipeline failure, the worker's published "failed" status details contain error_message (the
      actual exception message), stage (the failing pipeline stage), and retryable (the classified transient/permanent
      value).
    met: false
  - description: >-
      Given that message, rag-api's failed branch persists error = the worker's actual message (not "Processing
      failed"), error_stage = the failing stage (not null), and retryable = the worker-reported value on the resource
      document, and the processing/summary error record carries the real message and stage.
    met: false
  - description: >-
      A contract test in apps/ai-server/tests/integration covers the worker failure → rag-api persistence path and
      demonstrably fails when either side's payload/read keys are changed in isolation.
    met: false
  - description: >-
      Existing contract coverage (test_api_contracts.py and the resource_response.json fixture) passes unchanged — no
      consumer-visible field or shape changes.
    met: false
---

## The shape of the fix

This mismatch has exactly one producer and one consumer. The worker's failure publish is a single call site — the `except` handler in `process_document` — and rag-api's reader (`run_transactional_update`'s failed branch) is already correct for the keys it reads. Those persisted names are load-bearing: rag-api's `Resource` model and `ResourceResponse`, the `resource_response.json` contract fixture, and mobile's `Resource.fromJson` all consume `error`/`error_stage`. So the fix is worker-side only: publish `error_message`, `stage`, and `retryable` in the failure details. rag-api's code does not change at all, and nothing downstream notices except that the values become real.

## Stage attribution

Progress updates already carry a `stage` value at every transition (`starting` → `text_retrieved` → … → `embeddings_complete`); the failure handler simply has no access to it. The minimal mechanism is a local "current stage" in `process_document`, updated alongside each progress publish and included in the failure payload. The persisted stage is therefore "the last stage entered before the exception" — the same vocabulary users already see streaming in progress events. Granularity note: an exception raised inside a helper (e.g. PDF extraction) attributes to the stage that invoked it, not the inner helper. That matches the progress-event vocabulary and is the right granularity for support triage; finer attribution would require a different stage taxonomy, which is out of scope.

## retryable: derived, not fabricated

The worker already classifies every exception as transient or permanent (`classify_error`) — that classification drives Pub/Sub ACK vs NACK in the message loop. Deriving the payload's `retryable` from the same function makes the persisted flag mean something: transient failures (network timeouts, 429/5xx) → `true`; permanent failures (invalid input, permission) → `false`.

One semantic nuance worth stating plainly: a transient failure inside the pipeline does **not** trigger automatic redelivery today — `process_document` catches the exception, publishes "failed", and returns normally, so the message is acked. `retryable=true` therefore means "re-enqueueing this resource is plausible" (the `failed → queued` transition exists and `POST /process` re-enqueues), not "Pub/Sub will redeliver". This change makes the flag honest about the error class; it does not alter redelivery behavior, and it must not be read as a redelivery guarantee.

## What this fixes for free

rag-api's failed branch also writes a `processing/summary` error record (`code`/`message`/`stage`) from the same `details` dict — aligning the keys repairs that record too. Its `error_code` stays at the `"UNKNOWN"` default: introducing an error-code taxonomy is explicitly a non-goal, and inventing one here would expand the contract beyond the two keys the Objective names.

Two failure producers bypass the status pipeline entirely and already write the persisted names directly: the worker's stale-lease sweeper (`_fail_if_still_stale` writes `error`/`error_stage`/`retryable`) and rag-api's enqueue-failure rollbacks (`error_stage: "enqueue"`). They corroborate the persisted naming, need no change, and are a useful consistency check when reviewing the aligned payload.

## The contract test

The integration suite already imports rag-api's `main` with mocked Firebase/Pub/Sub (conftest) and asserts contract shapes against fixtures (`test_api_contracts.py`) — the new test belongs there. It should pin the worker→rag-api failure path both ways: a worker-shaped failure payload fed through `run_transactional_update` must persist the actual message/stage/retryable, and the key sets on both sides must match.

One mechanical wrinkle: under the conftest's mocks, `firestore.transactional` is a `MagicMock`, so the decorator swallows the inner function and a naive call exercises nothing. The test must make the decorator pass through (a one-line mock configuration) or fall back to key-set assertions on both sources. The passthrough approach is preferred — it exercises the real branch logic — but if it proves brittle, key-set assertion still catches the drift this Objective exists to prevent, just less deeply.

## Risks

- **Key drift returns silently.** The entire bug is a silent key mismatch between two files with no shared constant. The contract test is the primary mitigation; it must fail when either side changes in isolation, not merely pass on the happy path.
- **retryable misread as redelivery.** Documented above — the flag is advisory for re-enqueue. The risk is a future reader assuming Pub/Sub semantics; a comment at the derivation site is cheap insurance.
- **Stage mis-attribution.** Low severity: worst case the persisted stage is the invoking stage rather than the inner helper, which is still far better than `null` and matches what progress events showed the user.
- **Test fragility under mocks.** The transactional-passthrough trick is mildly invasive of the conftest's mock setup; isolated to one test file, with the key-set fallback available.
- **Provenance gap (non-blocking).** The Objective cites `plans/upload-flow.md` (deviation D4) and a companion D3 issue; that plan file is not present in the current working tree and the issue is not verifiable from here. Neither affects this scope — the mismatch is fully verifiable in the live code on both sides.

## Tradeoffs

- **Worker-side vs API-side alignment.** Worker-side is chosen per the Objective: zero migration, zero consumer churn. The cost is that the worker now owns three payload keys it didn't before — small, and pinned by the contract test.
- **Deriving retryable vs always sending `true`.** Deriving is chosen; always-`true` would preserve exactly the fabrication the acceptance criteria call out, at zero savings.
- **No error-code taxonomy.** Keeps the diff to the keys the criteria name; the summary record's `"UNKNOWN"` code is no worse than today and can be revisited if support triage demands it.
