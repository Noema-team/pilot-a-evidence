# Gate A — Pilot A6 (initial checks, zero model-driven run calls)

**Date:** 2026-09-21 (pre-T0). All checks performed before `drive` started. No model-driven generation was invoked during Gate A (the budget probe used a capturing stub provider; zero LLM calls).

## Frozen-input verification

| Check | Expected | Observed | Result |
| --- | --- | --- | --- |
| Stratum A6 execution revision | merge commit of PR #30 | `6f9e6c9f235c704eef3129ce689aa11c31e4e36f` (pilot worktree detached at this commit) | PASS |
| Pilot driver hash (pre-T0) | `09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654` | identical (sha256sum) | PASS |
| Target worktree | `86ec0871…`, branch `pilot-a/issue-108` | `86ec0871 Merge pull request #90 …`; clean except `.sle/` (pilot state, expected) | PASS |
| Issue | magtheo/student-platform#108 OPEN | OPEN — "rag-worker → rag-api: failure payload contract mismatch — failures persist without message or stage" | PASS |
| Issue seed JSON | `/tmp/opencode/pilot-a/issue-108.json` present | present (4172 bytes) | PASS |
| A5 `.sle` archived before removal | `evidence/pilot-a5-sle-archive.tgz` | created (10,594 bytes), then `.sle` removed → fresh state | PASS |
| Merged revision type-check | clean | `npm run type-check` exit 0 | PASS |
| Runtime | node 22 | v22.23.2 | PASS |

## Seeding (frozen driver `seed` subcommand) + the one mechanical pre-T0 action

1. `tsx pilot-a-driver.ts seed wi-define-108-a6` → seeded settings (openrouter, `z-ai/glm-5.3-flash`, `base_url` OpenRouter, `max_tokens` 16384, `api_key_env`), map.yaml, DB, objective (4 success criteria from the issue body), work item `wi-define-108-a6` (state ready). Journal: `seeded {"defineWi":"wi-define-108-a6","criteriaCount":4}`.
2. **Logged mechanical action (operator-authorized in the A6 prereg; the frozen driver cannot write this field):** added `"workflow_max_tokens": {"define-work/synthesize-definition": 32768}` to `.sle/settings.json`, preserving all seeded base fields byte-identically (global `max_tokens` stays 16384).

Final on-disk settings verified: `{"provider":"openrouter","model":"z-ai/glm-5.3-flash","base_url":"https://openrouter.ai/api/v1","max_tokens":16384,"api_key_env":"OPENROUTER_API_KEY","workflow_max_tokens":{"define-work/synthesize-definition":32768}}`.

## Operator safeguard — EFFECTIVE budget proof (not JSON presence)

Probe (`/tmp/opencode/a6-budget-probe.mts`, zero LLM calls): replicated the driver's exact order — `resolveLLMProvider(ROOT)` reads the real on-disk settings, THEN the 8-argument `buildAgentRunner(contextManager, provider, ROOT, runArtifacts, model, artifactRepository, maxTokens, decisionRepository)` — with only the provider swapped for a capturing stub. Settings were on disk before construction.

```
resolveLLMProvider(ROOT): {"model":"z-ai/glm-5.3-flash","globalMaxTokens":16384}
define-work/synthesize-definition: wire budgets=[32768,32768] expected=32768 -> PASS
define-work/definition-readiness-review: wire budgets=[16384,16384] expected=16384 -> PASS
```

The `[b,b]` pairs are the initial generation call plus the in-run format-repair continuation — both ride the same step-scoped lookup, matching the regression guarantee. Probe artifacts (`.sle/runs/probe`) were removed afterwards; the DB recorded zero workflow runs from the probe (`workflow_runs` count = 0).

Note for the record: the driver journals `provider_resolved {maxTokens: 16384}` — that is the GLOBAL budget read at construction; the 32768 override applies inside the runner per (workflow, step). A `provider_resolved` journal entry of 16384 at T0 is therefore EXPECTED and not an override failure.

## T0

- **T0 (clock start):** 2026-09-21T11:22:00Z (approx., at `drive` launch; driver journal timestamps are authoritative).
- Command: `OPENROUTER_API_KEY=<key> tsx pilot-a-driver.ts drive wi-define-108-a6`
- Frozen protocol: 120-min clock (driver-enforced), `MAX_AGENT_TURNS=24`, `MAX_RESULT_REPAIRS=1`, single `UND_ERR_HEADERS_TIMEOUT` retry, E12 teaching, budgets 2/3/2, hard ceiling 4000, minimal/5/halt.

Gate A: **all checks passed — A6 launched under the frozen protocol.**
