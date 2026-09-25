# Gate A — Pilot A8 (initial checks, zero model-driven run calls)

**Date:** 2026-09-21 (pre-T0). Execution revision: `4161ddf488be738408eaa3efb4af8220ee1258ad` (PR #33 merge commit — includes PR #32). Zero LLM calls during Gate A.

| # | Check | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| 1 | Stratum revision | `4161ddf…` | pilot worktree detached at `4161ddf` (type-check exit 0) | PASS |
| 2 | Driver SHA256 | `baa18ac7996113c305b39d206ebc995a37f00f9b9672b26c5d37d4801fc159fb` | identical (E17-corrected driver) | PASS |
| 3 | Target / issue | `86ec0871…` / #108 OPEN | both verified | PASS |
| 4 | A7 archive + fresh state | archived, `.sle` removed | `pilot-a7-sle-archive.tgz` present; `.sle` removed pre-seed; no A7 Definition reuse | PASS |
| 5 | Seed (fixed driver) | schema-validated map + fresh WI | `map_bootstrapped {schema_validated: true}`; `seeded wi-define-108-a8` (4 criteria) | PASS |
| 6 | Mechanical settings action | 32,768 for define-work/synthesize-definition only | settings: base seed fields intact + `workflow_max_tokens {"define-work/synthesize-definition": 32768}` | PASS |
| 7 | On-disk map parses | `RuntimeMapSchema.parse` OK | `custom \| local` | PASS |
| 8 | Effective budgets | 32768 synth / 16384 everything else | `[32768,32768]` synthesize; `[16384,16384]` readiness-review, refine-definition, **full-build/scoping.produce**, full-build/build — via the driver's exact construction order | PASS |
| 9 | Lifecycle/dependency surface (PR #32) | create+deps+guarded lifecycle works | throwaway-DB chain: createWorkItem(dependencies) → markReady → startRunning → markInReview → complete executed without error; dependency edge persisted | PASS |
| 10 | Entry-replay machinery | available post-define-work | `/tmp/opencode/e17-final-gate.mts` harness (stub provider) ready to run on the fresh A8 Definition | PASS |
| 11 | Runtime / keys | node 22 + key | v22.23.2; key loaded | PASS |

Probe artifacts removed; `workflow_runs` count 0; sole WI `wi-define-108-a8` (ready).

## T0

- Command: `OPENROUTER_API_KEY=<key> tsx pilot-a-driver.ts drive wi-define-108-a8`
- Frozen: 120-min clock, 24/1, single retry, E12 teaching, hard ceiling 4000 + Definition lane 32768 (PR #32), minimal/5/halt, decisions 2/3/2.
- Post-define-work protocol: driver-driven lifecycle completion → zero-cost entry replay → `gate-b wi-define-108-a8` → `execute-wi wi-define-108-a8` → `drive wi-exec-108` (H2). H1 → continue into H2/H3 without stopping.

Gate A: **all checks passed — A8 launched.**
