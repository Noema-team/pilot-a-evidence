# Pilot A5 — Outcome Record (E14)

Closed: 2026-09-21. Preregistration: docs/pilots/pilot-a5.md @ stratum cc0ba2b (PR #29, docs-only, merged under the operator's E14 authorization).
Frozen inputs verified: stratum cc0ba2b ✓ · target 86ec087 (pilot-a/issue-108) ✓ ·
driver sha256 09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654 (pre-T0 AND post-run) ✓ ·
OpenRouter z-ai/glm-5.3-flash ✓ · fresh .sle / wi-define-108-a5 ✓ · no prior Definition as input ✓.

## 1. Timing

- T0 (first model call): **2026-09-21T08:28:10Z** (step started 08:28:11.146Z) · terminal: **08:45:01Z**
- Wall: **16 min 51 s of 120** (step 1,010.4 s). Budget NOT binding.

## 2. Gates

- **Gate A: PASS** (gate-a-a5.md — probe HTTP 200 'ok'; baselines 109 + 409; one mechanical slip recorded+corrected: a prep chain briefly moved the ordinary stratum checkout, restored before Gate A; no pilot state affected).
- **Gate B: NOT REACHED** · **Gate C: NOT EXERCISED**.

## 3. A1 — fresh Definition reproduction: **NOT REPRODUCED** (matrix row 4: a DIFFERENT failure)

Workflow run `d6aa4207-a51b-4ef3-a0f5-1501677515fb`, step execution `3b899f60…`, WorkItem `wi-define-108-a5`.

- 19/24 turns, 27 tool calls, all unique paths (third consecutive run with ZERO repeated calls).
- At turn 19 the provider call died with **`stop_reason: max_tokens`** — the entire 16,384 completion budget was consumed mid-generation with no result block. The loop's existing fail-closed max_tokens check fired: `workflow_error: "Agent exhausted max_tokens without producing a result block"`.
- Zero transport failures, zero retries (third consecutive clean run: 72 calls across A3–A5, zero headers timeouts).
- Zero contract rejections, zero repairs — again NO submission occurred. **The E12 teaching delta remains empirically untested (2 consecutive runs without a submission to validate).**
- Per the frozen matrix: this is the "Different failure" row — diagnosed on its own terms, NOT attributed to the turn cap (5 turns remained unused).

## 4. Diagnosis: completion-budget exhaustion on a hybrid reasoner

The signature matches the E2-era evidence recorded in the codebase (finish_reason length with reasoning consuming the entire completion budget): `max_tokens 16384` bounds REASONING + CONTENT together, and on a long tool conversation the reasoner's thinking can consume the whole budget before any content — the turn then produces nothing and the step fails closed. This is a model/wire characteristic interacting with a frozen budget, not a Stratum defect.

## 5. Cross-run picture (define-work, identical frozen limits except noted)

| Run | Turns | Calls | Outcome | Class |
| --- | --- | --- | --- | --- |
| A2 | 16 | 24 | transport death (headers timeout) | provider transport |
| A3 | 16 | 28 | submitted @15; 1-fault rejection ×2; repair exhausted | contract conformance |
| A4 | 24 | 38 | never submitted; turn cap | turn budget / non-convergence |
| A5 | 19 | 27 | max_tokens exhaustion mid-generation @19 | completion budget |

Four pilots, four distinct failure classes, zero accepted submissions. The recurring structural theme: define-work's final act is ONE enormous single-call generation by a hybrid reasoner, and any spike in reasoning length, generation length, or exploration breadth kills the step — via a different frozen limit each time.

## 6. H1 / H2 / H3: NOT REACHED — DDR-041's live handoff remains untested after 5 pilots

0 artifacts; `wi-exec-108-a5` never created. Tokens: NOT PERSISTED.

## 7. Human Decisions and operator actions

Semantic Decisions: **0 of 2**. Operator actions: mechanical only. Zero target-code changes; zero Stratum changes after T0; neither main moved; 0 frozen-field changes.

## 8. Overall classification: **DIAGNOSED FAILURE** — positive sub-results preserved

1. **Transport is now a resolved question on current evidence**: 72 long-conversation calls across A3–A5, zero headers timeouts (observation; the retry policy never had to fire).
2. **Zero repeated exploration in three consecutive runs** (A4+A5 ledgers, 65/65 unique paths) — the model does not loop; convergence, repetition, and budget pressure are separable phenomena.
3. **The evidence machinery is complete**: every failure since A3 has been captured with precise cause metadata.

## 9. Evidence index (a5- prefix)

gate-a-a5.md · a5-define-drive.log · a5-run-journal.jsonl · a5-step-executions.json · a5-runs/d6aa4207…/ (loop json: 27-call ledger, stop max_tokens) · pilot-a4-sle-archive.tgz

## 10. Next-action recommendation (narrowly justified, single-lever)

The bottleneck moved AGAIN — to the completion budget. Recommendation, in evidence order:
1. **A6 = raise `max_tokens` for define-work only (16,384 → 32,768, provider permitting)** — the direct, single-lever response to THIS run's demonstrated death cause; Z.ai-route evidence (E2/E3) showed the same reasoning-budget starvation, so this lever has now killed runs on BOTH routes. A3 proves the model CAN produce a full submission within 16,384 when reasoning happens to fit — A5 proves it cannot guarantee it. (Budget check: Gate A probe confirms the route accepts larger budgets; wall-clock impact bounded by the 120-min clock.)
2. Alternatively, an unchanged A6 would test variance of the max_tokens outcome itself — but unlike A4's cap question, this failure is a deterministic budget boundary, not a behavioral variance; re-rolling the same dice has lower expected value.
The turn-cap lever (24→40) stays OFF the table: A5 died at 19 turns — more turns would not have changed this run's outcome.
