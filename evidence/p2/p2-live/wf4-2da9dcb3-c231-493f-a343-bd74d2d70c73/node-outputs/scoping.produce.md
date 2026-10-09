<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycles/worker-failure-payload-contract.md">>>
# Cycle Report — Worker Failure Payload Contract

**Issue:** #104 — Worker failure payload contract
**Status:** In progress
**Service:** rag-api (rag-api service)

## Summary

The rag-api worker publishes a failure payload to the `rag-failures` topic whenever a
document fails mid-pipeline (extraction, chunking, embedding, or vector cleanup). The
payload is consumed by the notification service, which emails the user and writes an
audit row. The contract between the worker's payload and the consumer's expectations
was never pinned down, and three fields have drifted:

1. `failure_stage` — the worker writes free-text strings (`"extraction failed"`,
   `"chunking"`, `"Embed"`); the consumer switches on a closed set of stage tokens
   (`extraction`, `chunking`, `embedding`, `cleanup`). Anything outside the set falls
   into the consumer's default branch, which skips the email entirely — so users get
   no notification for roughly a third of real failures (found live: `Embed` and
   `extraction failed` both landed in the default branch).
2. `resource_id` — the worker writes the Firestore document path
   (`users/{uid}/resources/{rid}`) in one branch and the bare id in another; the
   consumer's audit row and deep-link both assume the bare id.
3. `error` — sometimes a message, sometimes a bare exception class name
   (`ValueError`), which surfaces verbatim in the user email.

## Failure modes

- **Silent no-notification:** consumer's default branch on unknown stage tokens.
  Highest blast radius — a real user-visible regression with no error anywhere.
- **Audit-row id mismatch:** path-vs-bare-id drift breaks the consumer's
  `resource_id` uniqueness, producing duplicate audit rows and a broken deep link.
- **Unusable error text:** class-name-only `error` values give the user nothing to
  act on and give support nothing to grep.

## Contract being pinned

The worker must publish exactly this shape to `rag-failures`:

```json
{
  "failure_stage": "extraction" | "chunking" | "embedding" | "cleanup",
  "resource_id": "<bare Firestore resource id>",
  "user_id": "<bare uid>",
  "error": "<human-readable message, never a bare exception class name>"
}
```

- `failure_stage` must be one of the four closed tokens above — the worker maps its
  internal stage names onto them at publish time, never passes internal names through.
- `resource_id` and `user_id` must always be bare ids, never document paths. The
  consumer's audit row and deep-link contract depend on it.
- `error` must be a message string. If the underlying exception has no message, the
  worker substitutes `str(type(e).__name__) + ": " + repr(e)` rather than publishing
  the class name alone.

## Non-goals

- The consumer's side of the contract (closed token switch, audit row, email) is
  owned by the notification service and is not changed here.
- Retry semantics for the publish itself are unchanged: the worker already retries
  transient publish errors and logs-and-continues on permanent ones (a failure
  notification is best-effort and must never block vector cleanup).
- No change to the `rag-failures` topic name or to the existing fields the consumer
  already reads correctly (`user_id`, `job_id`).

## Plan

1. Add a `map_failure_stage()` helper in the worker that maps internal stage names
   onto the four closed tokens; unknown internal names map to the closest token
   rather than passing through.
2. Normalize `resource_id`/`user_id` to bare ids at every publish site (grep for the
   two branches writing the path form).
3. Normalize `error` to a message string with the class-name fallback.
4. Add a unit test asserting the published payload matches the pinned shape for each
   of the four stages, including the class-name-only `error` case.
5. Add a comment at the publish site cross-referencing the consumer's token switch so
   the next stage-name addition updates both sides.

## Risks

- Mapping unknown internal stage names to a "closest" token could misroute a genuinely
  new stage (e.g. a future `rerank` stage) into `embedding`. Mitigated by the
  cross-reference comment and the test asserting the token set.
- The path-form `resource_id` branch may have consumers other than the notification
  service reading the path form. Grep for readers of the `rag-failures` topic before
  normalizing; if a second consumer exists, its expectations must be checked first.
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>