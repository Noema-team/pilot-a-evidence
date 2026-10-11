---
schemaVersion: 1
goal: >-
  Add a structured failure-payload contract to the RAG worker service so callers can distinguish failure classes
  programmatically.
facts:
  - id: f1
    statement: The worker service is apps/ai-server/rag-worker-service/main.py.
    status: KNOWN
    source: repository
  - id: f2
    statement: The issue requests a failure-payload contract for the worker.
    status: KNOWN
    source: human
  - id: f3
    statement: >-
      The failure-payload schema field set is FIXED by the human decision (option "include"): the full payload field set
      is in scope for this increment.
    status: DECIDED
    source: decision
    decisionRef: 9e308f0f-0693-4d1f-90f1-ef3a6e328c80
constraints:
  - description: Changes are confined to apps/ai-server/rag-worker-service/main.py.
    type: must
  - description: No new runtime dependencies are introduced.
    type: must_not
requirements:
  - The worker returns a structured JSON failure payload with a machine-readable failure class on handled failures.
  - The payload carries the full decided field set (include option).
  - Existing success responses remain unchanged.
nonGoals:
  - Reworking the worker indexing pipeline.
  - Changing the upstream vector-store integration.
acceptance:
  - description: A handled failure returns JSON whose body parses and carries a non-empty machine-readable failure class field.
---

Records the human decision: the payload field set is in scope (option include). Other open questions remain for their own routes.
