# E17 — Pilot-Path Deterministic Qualification (report)

**Date:** 2026-09-21. **Mode:** NO model calls, NO spend (stub-captured provider). **Fixture:** the exact real A7 state — completed source WI `wi-define-108-a7`, its accepted canonical Definition (16,525 bytes, sha256 `66c6f7ad…`), provenance rows, seeded map, and an execution WI pointing at it via `definitionSource`.
**Execution revision audited:** `184517a` (main). **Implementation branch:** `e17/authoritative-context-lane` (PR #32).

## 1. The contract analysis (audit item A)

Two production contracts could not both hold:

| Contract | Says |
| --- | --- |
| `definition-source.ts` (`MAX_AUTHORITATIVE_DEFINITION_BYTES = 131_072`) | Definitions up to 128 KiB are valid authoritative inputs |
| DDR-041 | the Definition is included VERBATIM in the task context — never summarized, never truncated |
| `context-manager.ts` (`hard_ceiling` 4,000, DEFAULT_CONFIG) | ALL fixed context — including the verbatim Definition riding inside `task` — must fit 4,000 tokens, else fail closed |

Measured against reality: the only two Definitions ever to pass synthesis + readiness (A6: 18,282 B; A7: 16,525 B ≈ 4.1–4.6K tokens verbatim) exceed the 4,000-token total ceiling BY THEMSELVES. A7's assembled builder context: 4,315 tokens (task 4,282). Full-build's actual first step is `scoping.produce` (facilitator role) — also Definition-carrying: 4,353 tokens. Both fail closed before any model call. This is a structural cross-component invariant mismatch, not model variance and not "4k was slightly low."

**Resolution implemented (Option 1 — separate authoritative-input lane, per the operator's stated preference):**
- New `ContextManagerConfig.authoritative_definition_ceiling_tokens`, default **32,768** — DERIVED, not tuned: `MAX_AUTHORITATIVE_DEFINITION_BYTES (131,072) / CHARS_PER_TOKEN (4)`. The context lane and the resolver's byte contract are now the SAME contract: every Definition the resolver accepts fits its lane by construction.
- Ordinary focus budget (`hard_ceiling` 4,000) now applies to ordinary fixed components only (system + state + task-minus-Definition + failureContext); slices budget against the ordinary lane as before; non-Definition runs keep byte-identical legacy behavior.
- Both lanes fail closed before any model call with diagnosable errors; the Definition is still never truncated or summarized.
- Total model context = ordinary + Definition ≤ 4,000 + 32,768 — far inside the model window; cost accounting uses actual char counts and is unaffected.
- The three d35 DDR-041 tests that pinned the OLD single-lane contract were updated to the two-lane contract (they encoded the mismatch being fixed); new regressions in `tests/e17-downstream-qualification.test.ts` (7 tests): A7-sized Definition assembles at 4,000 with verbatim inclusion; beyond-lane Definition fails closed on the lane; ordinary overflow still fails closed; legacy behavior unchanged; derived-lane default pinned; dependency-surface behavior.

## 2. WorkItem lifecycle audit (item B)

Walked with supported services only (`WorkService` + `Scheduler`) against the real A7 state:

- create (draft) → markReady → **scheduler dispatch: OK** — dependency gate, WI state guards, workflow registration, run creation all function.
- `WorkService.complete()` (in_review → completed): OK — guards pass with zero pending decisions (proven in A7, re-confirmed).
- **FINDING (real missing surface): `WorkService.createWorkItem` hardcoded `dependencies: []` — no supported API could CREATE dependency edges**, while the dispatch gate READS them. The only writer was direct repository manipulation — precisely the A7 failure mode (stale-constant reference + FK crash). **Fixed in PR #32:** `CreateWorkItemRequest.dependencies` with validation mirroring the dispatch gate (must exist, not self, deduped).
- RESOLVED-AT-DB-LEVEL: `workflow_runs.resolved_parameters_json` IS frozen correctly at dispatch (verified: `{"planning_depth":"minimal","max_iterations":5,"on_cap_hit":"halt","definitionSource":{"workItemId":"wi-define-108-a7"}}`) — DDR-041 resume-safety intact. (An early audit printout suggesting `null` was a harness property-name mistake.)

## 3. Pilot driver integrity (item C) — fixed; new frozen hash

Driver defects logged in A7 are repaired in `pilot-a-driver.ts` (untracked experiment infrastructure; the new hash freezes at the A8 prereg):

1. Seed now crosses the SAME validation boundary as production: the written map is parsed against `RuntimeMapSchema` before the seed reports success (`map_bootstrapped {schema_validated: true}`) — the `createInitialMap({... as never})` blind write that carried invalid enums from A2 to A6 is gone.
2. `executeWi(defineWi)` now derives `dependencies` AND `definitionSource` from its argument (the stale `'wi-define-108'` constant is out of the data path).
3. `drive()` now advances the sanctioned lifecycle after a successful run: on run-terminal + WI `in_review`, it calls the WorkService's own guarded `complete()` and journals `wi_completed_by_driver` — removing the A7 operator intervention for the next clean run.

**New driver SHA256:** `baa18ac7996113c305b39d206ebc995a37f00f9b9672b26c5d37d4801fc159fb` — verified by a throwaway-root seed (`wi-define-108-a8`, 4 criteria, schema-validated map, clean WI state).

## 4. Full-build entry qualification (item D) — GREEN

Deterministic gate, run twice (harness ceiling override, then **production defaults only**):

```
create exec WI via WorkService (draft) → markReady → scheduler.tick()
→ dependency/registration gates OK → WorkflowRun created, resolvedParameters frozen
→ StratumAgentAdapter → resolveDefinitionSource (again, at dispatch) → WorkflowEngine
→ first step scoping.produce (facilitator) → ContextManager.assemble [two-lane invariant]
→ FIRST MODEL REQUEST CONSTRUCTED (stub-captured, zero spend):
   completeMultiTurn · z-ai/glm-5.3-flash · max_tokens 16384 (global, correct for scoping)
   verbatim Definition present in payload · initial + 1 format-repair continuation
```

The stub's empty replies then fail the step deterministically (expected — beyond this point the path is genuinely model-dependent). **With production defaults, full-build now reaches its first actual LLM request on the real A7 fixture. Before PR #32 it deterministically could not.**

## 5. Updated frontier

```text
OpenRouter transport                    ✓      multi-turn investigation        ✓
32k synthesis generation                ✓      submit_result contract          ✓
E12 source/kind teaching                ✓ reproduced
canonical Definition materialization    ✓      D.1 provenance                  ✓
post-step map sync                      ✓      readiness review                ✓
define-work commit                      ✓      Definition source resolution    ✓
DDR-041 provenance/hash authority       ✓      WI lifecycle (with fixed driver) ✓
resolvedParameters freeze at dispatch   ✓      full-build dispatch + entry     ✓ (this phase)

──────────── CURRENT FRONTIER ────────────
scoping.produce FIRST REAL MODEL CALL and everything beyond (planning → build →
validation → repair → commit → publication → CI/review evidence): untested —
requires the next live pilot (A8), now gated on PR #32 review/merge only.
```

## 6. A8 readiness statement

A8's preregistration can now be a near-pure repeat of A7's frozen protocol with: the PR #32 Stratum revision, the fixed driver (`baa18ac7…`), fresh `wi-define-108-a8`/exec WI, and the same A7 Gate A safeguards (effective budgets, seed schema parse, map parse) PLUS a new pre-T0 check: deterministic full-build entry replay on the seeded state (zero-cost, per §4). Expected first live divergence from A7: `scoping.produce`'s real model call. Per the operator's mode decision, A8 is NOT preregistered or executed until this phase is reviewed.
