# Gate B — Pilot A7 (live DDR-041 verification)

**Date:** 2026-09-21 12:52–12:56 UTC. Deterministic only — zero model calls.

## Attempt log

1. 12:52:02 — `gate-b wi-define-108-a7` (before `execute-wi`): FAIL `execution_work_item_not_found` — sequencing: Gate B validates against the exec WI, which must exist first. Driver-authoritative order restored: `execute-wi` → `gate-b`.
2. 12:52:19 — after `execute-wi`: FAIL `source_work_item_not_completed` — the define WI was `in_review` (frozen-driver lifecycle gap; see operator-actions-a7.md). Repaired via the sanctioned `WorkService.complete()` transition.
3. 12:56:01 — **`gate_b_resolved` — the DDR-041 resolution PASSED (first live resolution in the series):**

```json
{"event":"gate_b_resolved","sourceWorkItemId":"wi-define-108-a7",
 "artifactId":"f2468845-72ad-4fbf-ad32-f6b169831b5e","ref":"definition:obj-108",
 "path":".sle/work/wi-define-108-a7/definition.md",
 "sha256":"66c6f7ad3716d5370966184829013bb7088088d32444688f38be40a62bf11f60","bytes":16525}
```

Source WI completed ✓ · D.1 artifact provenance ✓ · sha256 pin matches the on-disk Definition ✓ · ref resolved ✓.

## Then: the context-assembly probe — new precise failure

`ContextManager.assemble('builder', …)` with the authoritative Definition injected THREW **`context_budget_exceeded`** (driver gateB line 245 → adapter seam). Deterministic measurement (same resolution, throwaway probe, no state change):

| Ceiling | Result |
| --- | --- |
| **4000 (frozen)** | **THROWS** `context_budget_exceeded` — "Fixed context components (system=0 state=33 **task=4282** failureContext=0; total **4315** tokens) exceed the configured hard_ceiling of 4000 for role='builder'" |
| 8000 | assembles: token_count 4315, verbatim definition included: **true** |
| 16384 | assembles: token_count 4315, verbatim definition included: **true** |

**Cause, exactly:** the verbatim canonical Definition (16,525 bytes ≈ 4,282 tokens) is carried in the `task` component alone — the Definition itself exceeds the frozen 4,000-token hard ceiling before any other context is added; total required = 4,315. The mechanism is correct (verbatim inclusion verified at higher ceilings); ONE frozen constant is incompatible with the empirically observed size of validated canonical Definitions (A6: 18,282 bytes; A7: 16,525 bytes).

**Status consequence:** DDR-041 handoff mechanics = LIVE-PROVEN (resolution, provenance, hash pin). Handoff INTO `full-build` execution = BLOCKED by the frozen ceiling — `wi-exec-108` left ready, never dispatched. H2/H3 not attempted (fail-closed, correctly).

Per the frozen closeout rules: new failure class, diagnosed independently, preserved exactly; the single-constant fix is a preregistered-protocol change requiring operator authorization — NOT applied.
