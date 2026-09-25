---
schemaVersion: 1
gaps: []
---

**Readiness review — verdict: pass (all seven dimensions pass for the candidate bounded scope)**

**D.3d.4 — Contract compliance.** The Objective's stated facts are represented in the ledger with correct epistemic status and provenance: the product intent (align the failure payload so failures persist with real message, stage, and deliberate retryable semantics) is carried as KNOWN (source: human); the repository-behavior claims (worker publishes `{"error": ...}` at main.py:1097; rag-api's failed branch reads `error_message`/`stage`/`retryable` at main.py:223–226) are verified against the live code and recorded with repository provenance, not taken on the Objective's word alone. The salvaged-provenance items (plans/upload-flow.md deviation D4, companion D3 issue) are honestly recorded as unverifiable from here and explicitly non-blocking for this scope — appropriate bookkeeping, not silent weakening. No authoritative fact is absent, weakened, or misattributed.

1. **Outcome — pass.** The goal is a single concrete statement: worker and rag-api must agree on the failure payload keys so a failed job persists the worker's actual error message, the failing stage, and a deliberately-sent or deliberately-derived `retryable`. A reader can unambiguously tell whether eventual work satisfies it.

2. **Boundary — pass.** Non-goals meaningfully exclude adjacent scope: no error-code taxonomy, no API-side schema change or migration, no Pub/Sub redelivery-semantics work, no general retry-orchestration changes. Scope membership of these adjacents is settled by explicit recorded decisions (worker-side alignment chosen per the Objective), not left UNKNOWN. The provenance items (D4 plan file, companion issue) are later-phase/irrelevant bookkeeping and do not block this scope.

3. **Critical constraints — pass.** The shape-changing constraints are captured: align worker→API (not API→worker, avoiding a migration); `retryable` must be sent or deliberately derived, never silently defaulted; the contract test must fail when either side drifts in isolation. No exhaustive-constraint manufacturing beyond what authorization needs.

4. **Consistency — pass.** Requirements, constraints, non-goals, and goal are mutually consistent. The chosen `retryable` derivation is consistent with the acceptance criterion that forbids silent defaulting, and the worker-side alignment choice is consistent with the no-migration constraint.

5. **Risky assumptions — pass.** The material assumptions are handled definition-side: the `retryable` derivation default is recorded ASSUMED with rationale (always-`true` would preserve the fabrication the criteria call out), with a fallback/comment mitigation; the transactional-passthrough test approach carries the key-set-assertion fallback if it proves brittle. None of these, if false, invalidate the goal or a must constraint; none requires escalation.

6. **Acceptance — pass.** The acceptance model contains concrete, checkable criteria: keys match across worker and rag-api; a failed job persists the actual error message and failing stage; `retryable` is deliberate; a contract test covers the worker-failure → rag-api persistence path. Together these are sufficient to know when the authorized work is done.

7. **Remaining unknowns — pass.** No UNKNOWN fact blocks this bounded scope. The only acknowledged unknowns are the provenance items, which are explicitly DEFERRED and do not affect the mismatch fix, which is fully verifiable in live code on both sides. Feasibility is not in question: the work is a payload-key alignment with a contract test, not an uncertain capability.

**Conclusion.** All seven dimensions pass; there are no blocking gaps, no pending DEFERRED transitions, and no unresolved EXPLORE_AS_WORK facts. The Definition is ready to authorize the bounded scope. Zero gaps.
