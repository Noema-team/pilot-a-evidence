# Gate A — Pilot A7 (initial checks, zero model-driven run calls)

**Date:** 2026-09-21 (pre-T0). All checks performed before `drive` started. Zero LLM calls during Gate A (probe used a capturing stub provider).

## Operator-pinned facts — all verified

| # | Fact | Expected | Observed | Result |
| --- | --- | --- | --- | --- |
| 1 | Stratum execution revision | `184517ad69c34e39564dfe8ae8cf135d9c9e215e` | pilot worktree detached at `184517a` (PR #31 merge commit; type-check exit 0) | PASS |
| 2 | Target | `86ec0871…` | `86ec0871 Merge pull request #90 …` on `pilot-a/issue-108` | PASS |
| 3 | Driver SHA256 | `718374b4f334be5655d2d6b41c606917a87a221b3bf3c044a3522171ddc3f693` | identical (corrected seed: `'custom'`/`'local'`) | PASS |
| 4 | Issue | #108 OPEN | OPEN | PASS |
| 5 | A6 archive exists | `pilot-a6-sle-archive.tgz` | present (17,348 bytes, 18 entries) | PASS |
| 6 | Fresh A7 `.sle`, no A6 reuse | A6 `.sle` removed after archive | removed (`grep -c sle` = 0 pre-seed); fresh seed `wi-define-108-a7` (4 criteria); A6 Definition not present anywhere in the new state | PASS |
| 7 | Corrected map seed parses | `RuntimeMapSchema.parse` OK | on-disk seeded `.sle/map.yaml` parses: `project.type=custom`, `task_store.type=local` (SAFEGUARD 2 — the exact path that killed A6) | PASS |
| 8 | Effective synthesize-definition budget | 32768 | wire budgets `[32768, 32768]` (initial + repair continuation) via the driver's exact `resolveLLMProvider` → 8-arg `buildAgentRunner` order with settings on disk before construction (SAFEGUARD 1) | PASS |
| 9 | Readiness/refine/full-build budgets | 16384 | `definition-readiness-review` `[16384, 16384]`, `refine-definition` `[16384, 16384]`, `full-build/build` `[16384, 16384]` | PASS |
| 10 | Runtime / keys | node 22, key present | v22.23.2; `OPENROUTER_API_KEY` loaded from `/tmp/opencode/.openrouter_key` | PASS |

## Seeding + logged mechanical action

1. `tsx pilot-a-driver.ts seed wi-define-108-a7` → seeded settings (openrouter, `z-ai/glm-5.3-flash`, `max_tokens` 16384), map.yaml with the CORRECTED seed values (`custom`/`local`), DB, objective (4 criteria), WI `wi-define-108-a7` ready.
2. **Logged mechanical action:** added `"workflow_max_tokens": {"define-work/synthesize-definition": 32768}` to the freshly seeded `.sle/settings.json` — base fields byte-identical to the driver's seed.
3. Probe artifacts (`.sle/runs/probe`) removed; `workflow_runs` count 0; sole WI = `wi-define-108-a7` (ready).

Note: the driver journals `provider_resolved maxTokens 16384` (the global budget); the 32768 override applies inside the runner per (workflow, step) — expected, as in A6.

## A7 protocol (from the frozen driver)

`drive wi-define-108-a7` (define-work; exits 3 on a pending decision → resolve per the frozen decision policy, attributed to operator, then re-drive) → on define-work completion: `gate-b wi-define-108-a7` (DDR-041 `resolveDefinitionSource` + context-assembly probe: hard ceiling 4000, verbatim inclusion) = **H1** → `execute-wi wi-define-108-a7` (creates `wi-exec-108` full-build, `definitionSource: {workItemId: wi-define-108-a7}`, minimal/5/halt) → `drive wi-exec-108` (H2 implementation) — H3 delivery evidence from the resulting target-worktree state.

## T0

- **T0 (clock start):** at `drive` launch 2026-09-21 (driver journal timestamps authoritative).
- Command: `OPENROUTER_API_KEY=<key> tsx pilot-a-driver.ts drive wi-define-108-a7`
- Frozen: 120-min clock, `MAX_AGENT_TURNS=24`, `MAX_RESULT_REPAIRS=1`, single retry, E12 teaching, hard ceiling 4000, minimal/5/halt, budgets 2/3/2.

Gate A: **all ten facts verified — A7 launched under the frozen protocol.**
