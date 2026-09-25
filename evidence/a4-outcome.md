# Pilot A4 — Outcome Record (E13)

Closed: 2026-09-20. Preregistration: docs/pilots/pilot-a4.md @ stratum c957395 (PR #28 merge commit; head 5b44284e verified MERGED, exact-head CI green).
Frozen inputs verified: stratum c957395 ✓ · target 86ec087 (pilot-a/issue-108) ✓ ·
driver sha256 09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654 (pre-T0 AND post-run) ✓ ·
OpenRouter z-ai/glm-5.3-flash ✓ · fresh .sle / wi-define-108-a4 ✓ · no prior Definition as input ✓.

## 1. Timing

- T0 (first model call): **2026-09-20T19:20:32Z** (step started 19:20:39.279Z) · terminal: **19:49:01Z**
- Wall: **28 min 29 s of 120** (step 1,701.8 s). Budget NOT binding.

## 2. Gates

- **Gate A: PASS** (gate-a-a4.md — incl. OpenRouter probe HTTP 200 'ok'; baselines 109 + 409; one recorded mechanical invocation slip: rag-api suite first launched from wrong cwd, re-run from the service directory before any model call).
- **Gate B: NOT REACHED** · **Gate C: NOT EXERCISED** (no natural halt of the authorized kind).

## 3. A1 — fresh Definition reproduction: **NOT REPRODUCED** (new failure class: turn-cap exhaustion)

Workflow run `051c2f65-cff7-472e-bda5-a4da12c78b8e`, step execution `35859f52…`, WorkItem `wi-define-108-a4`.

- **24/24 turns consumed, 38 tool calls** (vs A3: 16 turns, 28 calls, submitted at turn 15). The model ran a BROADER investigation — exploring `apps/ai-server/functions/src`, `docs/system-overview/…` (surfaces no prior attempt touched) — and never called `submit_result`.
- Terminal failure: `workflow_error: "Agent did not produce a result block within 24 turns"`.
- **Zero transport failures, zero retries consumed** (second consecutive clean run — 24 calls, no headers timeouts; still an observation, not proof).
- **Zero contract rejections, zero repairs consumed** — no submission ever occurred.

## 4. Critical honesty note: the E12/A4 delta was NOT exercised

The amended teaching (source/kind disambiguation) cannot be evaluated by this run: the model never submitted, so no contract validation of any submission occurred. A4 provides NO evidence for or against the teaching fix. What A4 DOES establish: investigation depth varies run-to-run under identical teaching, and 24 turns can be exhausted by exploration alone.

## 5. Cross-run picture (define-work stage, identical frozen limits)

| Run | Turns | Tool calls | Outcome | Class |
| --- | --- | --- | --- | --- |
| A2 (Coding Plan) | 16 | 24 | transport death (300 s headers timeout) at turn 16 | provider transport |
| A3 (OpenRouter+retry) | 16 | 28 | submitted turn 15; 1-fault rejection ×2; repair exhausted | contract conformance |
| A4 (OpenRouter+retry+teaching) | 24 | 38 | never submitted; turn cap | turn budget |

Transport: resolved in 2 consecutive runs (observation). Contract: 1 near-miss (A3), 1 no-show (A4). Turn budget: exhausted once with a thorough-but-unfocused investigation style.

## 6. H1 / H2 / H3: NOT REACHED

0 artifacts; DDR-041 handoff remains untested live (4 pilots). `wi-exec-108-a4` never created. Tokens: NOT PERSISTED (failed run).

## 7. Human Decisions and operator actions

Semantic Decisions: **0 of 2**. Operator actions: mechanical only (launch, monitor, evidence copy, hash verification, one pytest re-invocation from the correct directory — recorded). Zero target-code changes; zero Stratum changes after T0; neither main moved; 0 frozen-field changes.

## 8. Overall classification: **DIAGNOSED FAILURE** — positive sub-results preserved

1. Transport stability held for a second consecutive run (48 long-conversation calls across A3+A4, zero headers timeouts on OpenRouter).
2. The run was mechanically healthy to the end: 24 turns of clean tool execution, no failures of any kind except the cap itself.
3. Evidence chain complete (loop metadata, per-turn tool ledger, step failure).

## 9. Evidence index (a4- prefix)

gate-a-a4.md · a4-define-drive.log · a4-run-journal.jsonl · a4-step-executions.json · a4-runs/051c2f65…/ (manifest, synthesize-definition-loop.json with 38-call ledger) · pilot-a3-sle-archive.tgz

## 10. Next-action recommendation (narrowly justified)

The bottleneck is now the **turn budget vs investigation variance**: A3 submitted at turn 15; A4 explored 24 turns without converging. Two levers fit the evidence (preregister, do not combine):
1. **Raise `MAX_AGENT_TURNS` for define-work (24 → 40)** — directly targets the demonstrated cap; A2/A3 establish a converging run needs ≤16 turns, A4 shows a diverging one needs >24. Low risk: the cap only bounds a step that is otherwise healthy.
2. **A5 = A4 rerun unchanged** — a single reproduction datum (n=1) for the exploration-depth variance; if A5 submits by turn 24, A4's exhaustion is variance, not a cap problem, and the contract question returns to the foreground.

Recommendation: run the unchanged rerun (option 2) FIRST — it is free of new variables and disambiguates variance from systematic cap pressure; raise the cap only if a second consecutive exhaustion appears.
