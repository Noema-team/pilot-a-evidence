---
schemaVersion: 1
targetFactId: f3
question: What failure-class taxonomy does the existing worker error surface actually support?
whyNotResolvableByReading: The taxonomy is determined by runtime behavior under failure injection, not by static reading.
requiredWork: Inject failures against the worker in a scratch environment and record the observable error payloads.
completionEvidence: A recorded set of observed failure payloads from which the taxonomy field set can be fixed.
---
