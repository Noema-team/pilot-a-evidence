 <<<SLE-OUTPUT>>>
<<<SLE-ARTIFACT path="docs/cycle-charter.md">>>
## Scope

**Intent:** rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage.

**Problem:** When a RAG processing job fails, the worker reports failure to rag-api, but rag-api persists a generic placeholder (`error = "Processing failed"`, `error_stage = None`) instead of the worker's actual error message, failing stage, and derived retryable flag. Users and support cannot disambiguate failures. The worker's `process_document` is one large try block with no stage tracking, so the failing stage cannot currently be reported; the API side's response models are the stable end of the contract, so the worker side must change to match.

**In scope:**
- Worker: track the currently executing pipeline stage through `process_document` and include it in the failure payload sent to rag-api.
- Worker: include the worker's actual error message (not a generic string) and its derived `retryable` value (from `classify_error`) in the failure payload.
- Worker→rag-api failure path: make the payload keys match what rag-api's status subscriber already parses and persists, so a failed job's resource document ends up with `error` = actual message, `error_stage` = failing stage, `retryable` = worker-derived value.
- Key-set drift guard: a contract test that fails the build if either side's failure-payload key set changes without the other, preventing silent re-creation of this mismatch. Both services already support hermetic Firestore-emulator mode (`FIRESTORE_EMULATOR_HOST` branches), so a worker→rag-api failure-path contract test is implementable with existing patterns (evidenceRef: `apps/ai-server/tests/integration/test_api_contracts.py`).

**Out of scope:**
- No Firestore migration, field rename, or backfill of existing documents.
- No changes to rag-api's response models or persistence readers — rag-api's side is the stable contract; the worker aligns to it.
- No changes to `classify_error` conservatism (it prevents infinite retry loops); the manual reprocess path is unaffected.
- No changes to other consumers of the shared Pub/Sub topic beyond the known rag-api status subscriber (no other consumers are known to parse the failure payload keys).
- The companion D3 issue referenced by the Objective is not available in this context and is not addressed here.

**Acceptance criteria (must):**
- After a failed job, the persisted resource document has `error` = the worker's actual error message (not `"Processing failed"`), `error_stage` = the failing stage (not `None`), and `retryable` = the worker's derived value. Currently `met: false`.
- A worker→rag-api failure-path contract test exists and passes in hermetic emulator mode, and locks in the retryable flag and payload key set.
- A key-set drift guard fails the build if either side's failure payload keys drift.
- No migration, no backfill, no reader changes required to ship.

**Type:** must
<<<END-SLE-ARTIFACT>>>
<<<END-SLE-OUTPUT>>>