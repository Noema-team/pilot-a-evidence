<<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
# Cycle Charter

## Scope

**Intent:** `rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage`

**Problem:** When a RAG processing job fails, the worker's failure payload does not carry the keys `rag-api` expects. As a result, the failure record persists in Firestore without the worker's actual error message or the failing stage, leaving users and support unable to disambiguate failures. The worker's failure handler has no stage tracking today, so the failing stage cannot currently be reported at all.

**Chosen fix direction (worker side):** Change the worker's failure payload, not the API side. The persisted field names (`error_message`, `stage`) are already consistent across three other write paths and two API response models, so changing the API side would ripple; changing the worker requires no migration, no backfill, and no reader changes. `F11` confirms no other consumer parses the worker's failure payload keys, and other services/tooling sharing the topic are unaffected by key alignment on the worker side.

**In scope:**

1. **Failure payload alignment (worker).** Emit the failure payload with the keys `rag-api`'s status subscriber already expects, matching the persisted field names used across the other write paths and API response models (`error_message`, `stage`, plus the existing status/id fields the payload already carries).
2. **Stage tracking (worker).** `process_document` is one large try block, so at failure time nothing knows where it was. Introduce lightweight stage tracking (a current-stage marker updated as processing progresses through its phases) so that when a failure occurs, the failing stage is known and included in the failure payload.
3. **Error message propagation (worker).** Ensure the actual exception/error message from the failure handler is captured into `ProcessingMetrics.error_message` and forwarded in the payload, rather than persisting empty/missing.
4. **Derived retryable flag (worker).** Include the derived retryable classification (from the existing `_is_retryable`-style status-code logic: transient 429/5xx → retryable, other 4xx and unknown exceptions → permanent) in the failure payload. This flag is locked in by a contract test on the worker→rag-api failure path.
5. **Key-set drift guard.** Add a test that asserts the exact key sets on both sides of the contract (worker's emitted failure payload keys vs. rag-api's expected/persisted keys), so a future edit to either side's keys fails the build instead of silently re-creating this bug.
6. **Worker→rag-api failure-path contract test.** Add an integration contract test exercising the failure path end-to-end. Both services support a hermetic Firestore-emulator mode (`FIRESTORE_EMULATOR_HOST` branches), and existing patterns live in `apps/ai-server/tests/integration/test_api_contracts.py`, so the test is implementable with existing patterns. The test asserts the persisted failure record contains the real error message, the failing stage, and the derived retryable flag.

**Out of scope:**

- Any change to `rag-api`'s persisted field names, response models, or subscriber parsing (the API side is already correct/consistent).
- Backfill or migration of existing failure records lacking `error_message`/`stage`.
- Changes to other services or tooling that share the Pub/Sub topic (they do not parse these keys — `F11`).
- Refactoring `process_document` beyond what is needed to track the current stage.
- New retry/backoff behavior — the retryable flag is derived and reported, not acted upon differently in this cycle.

**Acceptance criteria:**

- A failed RAG job persists a failure record containing the worker's actual error message and failing stage.
- The failure payload includes the derived retryable flag consistent with existing status-code classification logic.
- The worker→rag-api failure-path contract test passes in hermetic Firestore-emulator mode.
- The key-set drift guard fails the build if either side's payload keys change without the other.
- No migration, backfill, or reader changes are required.

**Evidence anchors:** `apps/ai-server/tests/integration/test_api_contracts.py` (existing contract-test patterns), `rag-worker-service/main.py` (failure handler, `ProcessingMetrics.error_message`, retryable classification, single try block in `process_document`).
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>