---
schemaVersion: 1
goal: >-
  Make the rag-worker's failure status payload match rag-api's failed-branch contract — the worker publishes
  error_message, stage, and a deliberately derived retryable — so failed jobs persist the worker's actual error message
  and failing stage, verified by a contract test over the worker → rag-api persistence path.
facts:
  - id: repo-worker-failure-payload
    statement: >-
      On failure, process_document publishes status 'failed' with details containing only {"error": str(e)} (plus an
      injected jobId); it never sends error_message, stage, or retryable.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py — process_document exception handler (≈line 1097)
  - id: repo-api-failed-branch
    statement: >-
      rag-api's failed branch persists main-doc fields from details.get("error_message", "Processing failed"),
      details.get("stage"), and details.get("retryable", True); the processing/summary subcollection additionally gets
      error.code from details.get("error_code", "UNKNOWN").
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-api-service/main.py — run_transactional_update failed branch (≈lines 223–226)
  - id: repo-status-topic-wiring
    statement: >-
      The worker publishes status updates to the rag-status topic and rag-api's Pub/Sub subscriber is the service that
      consumes them and performs the Firestore status write — the mismatch is between exactly these two code paths.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: >-
      apps/ai-server/rag-worker-service/main.py (_publish_status_update) and apps/ai-server/rag-api-service/main.py
      (lifespan subscriber, _process_status_message)
  - id: repo-sweep-failure-shape
    statement: >-
      The worker's stale-lease sweeper writes the canonical failure shape directly to Firestore (status failed, error
      message, error_stage 'processing', retryable true) without going through the status-message payload, so it is
      unaffected by the mismatch but is a second failure writer that must stay consistent.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py — _fail_if_still_stale
  - id: repo-retryability-signal
    statement: >-
      The worker already classifies failures as transient vs. permanent (classify_error, used for ack/nack decisions)
      and PDFProcessingError carries retryable metadata in exceptions.py — a retryability signal exists at the failure
      site.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/rag-worker-service/main.py (classify_error) and apps/ai-server/rag-worker-service/exceptions.py
  - id: repo-contract-test-suite
    statement: >-
      Cross-service contract tests already exist at apps/ai-server/tests/integration/test_api_contracts.py (pydantic
      model-field assertions and AST-based shape checks against a fixtures directory), giving the new contract test an
      established home and pattern.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: apps/ai-server/tests/integration/test_api_contracts.py
  - id: repo-persisted-shape-consumers
    statement: >-
      The persisted failure fields (error, error_stage, retryable on the resource document) are surfaced through
      ResourceResponse and asserted by mobile-facing contract tests, so changing the persisted shape would ripple beyond
      this fix.
    status: KNOWN
    source: repository
    kind: repository-claim
    evidenceRef: >-
      apps/ai-server/rag-api-service/models/resource.py and apps/ai-server/tests/integration/test_api_contracts.py
      (MOBILE_RESOURCE_FIELDS)
  - id: intent-align-worker-to-reader
    statement: >-
      The Objective directs aligning the worker's failure payload to rag-api's read keys (error_message/stage) rather
      than changing rag-api's persisted fields, explicitly to avoid a migration.
    status: KNOWN
    source: human
    kind: product-intent
    evidenceRef: Objective — acceptance criteria (this run)
  - id: intent-persist-actual-message-stage
    statement: >-
      A failed job must persist the worker's actual error message and the stage where processing failed — users and
      support must be able to tell what failed and where from the persisted record.
    status: KNOWN
    source: human
    kind: product-intent
    evidenceRef: Objective — impact and acceptance criteria (this run)
  - id: intent-retryable-deliberate
    statement: >-
      retryable must be either sent by the worker or derived deliberately; silently defaulting it to True is not
      acceptable.
    status: KNOWN
    source: human
    kind: product-intent
    evidenceRef: Objective — acceptance criteria (this run)
  - id: intent-contract-test
    statement: A contract test must cover the worker failure → rag-api persistence path.
    status: KNOWN
    source: human
    kind: product-intent
    evidenceRef: Objective — acceptance criteria (this run)
  - id: default-retryable-from-classification
    statement: >-
      Adopted default: the worker sends retryable derived from its existing transient/permanent classification
      (classify_error(e): transient → true, permanent/unknown → false). Rationale: the retryability signal already
      exists at the failure site (repo-retryability-signal), permanent failures are acked to avoid poison-pill loops so
      they should not advertise retryability, and this stays reporting-only — Pub/Sub nack behavior is unchanged.
      Candidate for the risky-assumptions check.
    status: ASSUMED
    source: investigation
  - id: default-stage-tracking
    statement: >-
      Adopted default: the worker tracks the current pipeline stage locally during process_document (it already
      publishes per-stage updates: starting, text_retrieved, tagging_complete, summary_generated, chunking_complete,
      embeddings_complete) and includes it as `stage` in the failure payload, falling back to 'unknown' if no stage was
      entered. Ordinary reversible design instantiating intent-persist-actual-message-stage.
    status: ASSUMED
    source: investigation
  - id: default-no-other-consumers
    statement: >-
      Assumed no other in-repo consumer depends on the failure details' 'error' key: within apps/ai-server the inspected
      services show no status-topic subscriber besides rag-api (observability-aggregator only ingests
      agent-graph-service traces from Tempo, not these messages). Residual risk: other services/functions were not
      exhaustively audited; a consumer audit is part of the work.
    status: ASSUMED
    source: investigation
    kind: repository-claim
  - id: default-optional-error-code
    statement: >-
      Adopted default: the worker may additionally send a stable error_code (e.g. classification-based), since rag-api
      already reads details.get("error_code", "UNKNOWN") into processing/summary error.code. Optional enhancement, not
      required for the fix.
    status: ASSUMED
    source: investigation
  - id: unknown-d3-companion-issue
    statement: >-
      The Objective references a companion 'D3 issue' filed alongside this one whose content is not available here; if
      it carries additional retry-orchestration scope it must be triaged separately, not absorbed into this Definition.
    status: UNKNOWN
    source: investigation
  - id: missing-upload-flow-artifact
    statement: >-
      plans/upload-flow.md — the file the Objective cites for the original D4 deviation analysis — does not exist in the
      repository's plans/ directory; the salvage reference cannot be re-read.
    status: KNOWN
    source: investigation
    kind: repository-claim
    evidenceRef: plans/ directory listing (investigation)
constraints:
  - description: >-
      Align the worker to the reader: the worker sends error_message/stage/retryable and rag-api's failed-branch read
      keys stay as-is.
    type: must
  - description: >-
      must_not change rag-api's persisted Firestore field names (error, error_stage, retryable) or introduce any data
      migration.
    type: must_not
  - description: >-
      must_not remove rag-api's defensive fallbacks in the failed branch ('Processing failed', retryable default) — they
      remain as last-resort handling for malformed/legacy payloads; worker-originated failures just never hit them.
    type: must_not
  - description: >-
      must_not change the worker's ack/nack or transient/permanent retry behavior — retryable is reporting metadata only
      in this change.
    type: must_not
  - description: >-
      prefer the worker to also send a stable error_code so processing/summary error.code becomes meaningful instead of
      always 'UNKNOWN'.
    type: prefer
  - description: >-
      prefer_not to introduce a new shared runtime package/dependency coupling worker and rag-api for these keys; prefer
      a test-enforced contract (shared fixture or cross-module test in apps/ai-server/tests/integration/).
    type: prefer_not
requirements:
  - >-
    When a document fails during processing, the worker's published 'failed' status details must contain `error_message`
    (the actual exception message) and `stage` (the pipeline stage at the time of failure), matching the keys rag-api's
    failed branch reads in run_transactional_update.
  - >-
    The worker's failure details must include `retryable`, derived deliberately from the worker's existing
    transient/permanent classification (classify_error: transient → true, permanent/unknown → false), so rag-api never
    silently fabricates it.
  - >-
    After the fix, a failed job's persisted resource record must show the worker's actual error message in `error` and
    the failing stage in `error_stage` (and the actual message/stage in processing/summary's error object) —
    worker-originated failures must never fall back to the generic 'Processing failed' string or a null stage.
  - >-
    The fix must require no change to rag-api's persisted Firestore document shape and no data migration; existing
    readers (ResourceResponse, list/get status endpoints) keep working unchanged.
  - >-
    A contract test must cover the worker failure → rag-api persistence path: it fails if the failure-details keys the
    worker publishes drift from the keys rag-api's failed branch reads (error_message, stage, retryable), and it
    verifies persistence through run_transactional_update (or an equivalent seam) writes the actual message, stage, and
    derived retryable value.
  - >-
    Both failure paths — status-message failures and the stale-lease sweep — must keep persisting the same failure field
    names (error, error_stage, retryable) so records stay comparable.
nonGoals:
  - No backfill or repair of historically persisted generic 'Processing failed' records.
  - >-
    No automatic retry/requeue orchestration for failed jobs — any retry pipeline belongs to the companion D3 issue;
    this change only reports retryability truthfully.
  - No redesign of the worker's exception classification or ack/nack logic.
  - >-
    No changes to the status message envelope (user_id/course_id/resource_id/status/details/timestamp/sequence) or the
    Pub/Sub topic topology.
  - No extension of structured failure reporting to other pipelines or non-'failed' statuses.
acceptance:
  - description: >-
      The worker's published failure details contain `error_message` (the actual exception message), `stage` (the
      failing pipeline stage), and `retryable` (deliberately derived) — verified by inspection or unit test of the
      failure path.
    met: false
  - description: >-
      A failed job persists the worker's actual error message in `error` and the failing stage in `error_stage` on the
      resource document (and message/stage in processing/summary) — no 'Processing failed' fallback and no null stage
      for worker-originated failures.
    met: false
  - description: >-
      A contract test covers the worker failure → rag-api persistence path and fails on key drift between the worker's
      payload and rag-api's failed-branch reads.
    met: false
  - description: >-
      rag-api's persisted Firestore document shape is unchanged — no migration; ResourceResponse/mobile-facing contract
      tests still pass.
    met: false
  - description: >-
      Both failure paths (status-message failures and the stale-lease sweep) persist identical failure field names
      (error, error_stage, retryable).
    met: false
---

## The mismatch, in one breath

The worker's `process_document` exception handler publishes `"failed"` with `{"error": str(e)}` (repo-worker-failure-payload), while rag-api's `run_transactional_update` failed branch reads `error_message` / `stage` / `retryable` (repo-api-failed-branch). None of those keys exist in the payload, so every failure persists as the generic fallback string with `error_stage = None` and a fabricated `retryable = True`. The persisted record can't answer "what failed?" or "where?", and support can't distinguish a transient blip from a permanently broken document.

## Direction: the worker aligns to the reader

Two readers already pin the current shape, so changing the worker is strictly cheaper than changing the reader:

1. rag-api's read keys **are** the persisted Firestore field names (`error`, `error_stage`, `retryable`), which `ResourceResponse` serves and the mobile-facing contract tests assert (repo-persisted-shape-consumers). Re-keying the persistence layer would ripple into the API surface and mobile for zero product gain.
2. The worker's own stale-lease sweeper already writes the canonical shape directly to Firestore (repo-sweep-failure-shape). Aligning the status-message path makes all failure writers agree on one vocabulary instead of two.

This is also the direction the Objective states explicitly (intent-align-worker-to-reader), and it needs no migration — which is why "no persisted-shape change" is a hard boundary rather than a preference.

## Retryability: derive it, don't fabricate it

Today rag-api invents `retryable = True` for every failure. The worker already classifies failures as transient vs. permanent for its ack/nack decision (repo-retryability-signal), so the honest fix is to report that classification: transient → `retryable: true`, permanent/unknown → `retryable: false` (default-retryable-from-classification).

The tradeoff is deliberate: `classify_error` treats unknown exception types as permanent to avoid poison-pill loops, so some genuinely transient-but-untyped failures will be reported non-retryable. That is acceptable because `retryable` here is **reporting metadata, not the retry decision** — Pub/Sub nack behavior is untouched (a must_not constraint). If the companion D3 issue later defines a retry policy, this field becomes its truthful input instead of a constant.

## Stage: the pipeline already knows where it is

`process_document` publishes per-stage status updates (starting, text_retrieved, tagging_complete, summary_generated, chunking_complete, embeddings_complete). The adopted mechanism is a locally tracked current stage emitted in the failure payload, falling back to `"unknown"` if failure precedes any stage (default-stage-tracking). Granularity is coarse — a mid-extraction failure reports the stage it entered, not the line — but coarse is sufficient: the product need is disambiguation ("failed during extraction" vs. "failed during embedding"), not a stack trace.

## Contract test design

The new test lives in `apps/ai-server/tests/integration/`, next to `test_api_contracts.py`, which already does cross-service shape assertions (repo-contract-test-suite). Two layers:

- **Key-drift guard**: assert the failure-details keys the worker publishes satisfy exactly what rag-api's failed branch reads. The assertion should read the actual failed branch (import or AST, the pattern that suite already uses for agent-graph shapes) rather than a hand-copied key list — a copied list rots silently, which is precisely the failure mode being fixed.
- **Behavioral check**: push a representative failure payload through `run_transactional_update` (or an equivalent seam) and assert `error`, `error_stage`, and `retryable` persist the real values — no fallback string, no null stage.

A shared schema package was considered and rejected (prefer_not): three string/bool keys don't justify a new cross-service runtime dependency, and the test-enforced contract achieves the same guarantee inside an existing suite.

## Named risks

- **Unaudited consumers of `details["error"]`.** Within `apps/ai-server` the only verified status-topic consumer is rag-api's subscriber (observability-aggregator ingests agent-graph traces from Tempo, not these messages), but other services were not exhaustively audited (default-no-other-consumers). Mitigation: a consumer audit before merge; the default is to replace `error` with `error_message`, keeping `error` too if the audit finds a reader. The payload change is otherwise additive.
- **Companion D3 issue content unknown** (unknown-d3-companion-issue). If it carries retry-orchestration scope, it must be triaged on its own; this Definition deliberately excludes retry orchestration so the payload fix isn't blocked on it.
- **Cited analysis artifact missing.** `plans/upload-flow.md` (the D4 deviation analysis the Objective references) is not in the repository (missing-upload-flow-artifact); the salvage reasoning can't be re-read. This doesn't block the fix but means the original context lives only in the Objective text.
- **Historical failed records stay generic.** No backfill (explicit non-goal); new failures are distinguishable by populated stage/message.

## What this does not attempt

Retry orchestration, envelope/topology changes, ack/nack redesign, and backfill are all out of scope. The bounded outcome is narrow and mechanical: one payload, three keys, made true — plus the test that keeps it true.
