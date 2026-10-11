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
    statement: The exact payload schema field set is a design choice within the bounded scope.
    status: DEFERRED
    source: investigation
constraints:
  - description: Changes are confined to apps/ai-server/rag-worker-service/main.py.
    type: must
  - description: No new runtime dependencies are introduced.
    type: must_not
requirements:
  - The worker returns a structured JSON failure payload with a machine-readable failure class on handled failures.
  - Existing success responses remain unchanged.
nonGoals:
  - Reworking the worker indexing pipeline.
  - Changing the upstream vector-store integration.
acceptance:
  - description: A handled failure returns JSON whose body parses and carries a non-empty machine-readable failure class field.
---

# Definition — Worker failure-payload contract

The bounded scope is the RAG worker service failure responses. See the canonical state for goal, ledger, constraints, requirements, non-goals, and acceptance.
