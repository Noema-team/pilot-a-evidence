# Pilot A — Outcome Record

**Classification: DIAGNOSED FAILURE** (prereg §8; prereg: docs/pilots/pilot-a.md @ stratum fa51e8a)

**Run stopped:** 2026-09-19T10:26Z. Wall-clock consumed: 72 min of 120 (T0 = first model call 09:14:00Z).
**Stage reached:** define-work / `synthesize-definition`. Execution phase never dispatched; Gate B not reached; Gate C not exercised (no natural halt occurred — recorded as NOT EXERCISED, per operator interpretation).

## Frozen configuration (unchanged throughout — 0 mid-run changes)

- Stratum `fa51e8a1dd64f74e72bd2cbb38d897e1cd6e21f3` (E5 merge); target `86ec0871d64ecca8732434c11d015fd8e08ddc7e`, branch `pilot-a/issue-108`, dedicated worktrees.
- Provider `glm` → `https://api.z.ai/api/coding/paas/v4`, model `glm-5.3-flash`, max_tokens 16384, GLM_API_KEY. Verified live pre-run and still functional for short calls at stop time (HTTP 200, 10:2xZ) — the failures below are specific to long multi-turn calls.
- Objective: issue #108 text verbatim (title/body/acceptance criteria); no operator coaching; DDR-041 fixture never used.

## Attempt ledger (all at define-work synthesize-definition; evidence in runs/ and step-executions.json)

| # | WI | Window (UTC) | Turns | Outcome | Class |
|---|---|---|---|---|---|
| 1 | wi-define-108 | 09:14→09:27 | 14 | `LLM call failed: fetch failed` | Provider transport interruption #1 |
| 2 | wi-define-108-r2 | 09:35→09:47 | 13 | Model SUBMITTED a valid result; step crashed post-submission: driver failed to bootstrap `.sle/map.yaml` (production `stratum init` step my driver omitted) | Experiment-infrastructure defect (operator side) — FIXED after diagnosis; not a model or Stratum defect |
| 3 | wi-define-108-r3 | 09:49→09:58 | 24 | `Agent did not produce a result block within 24 turns` (explored until budget) | Model failure: over-exploration of the real repo |
| 4 | wi-define-108-r4 | 09:59→10:09 | 16 | `LLM call failed: fetch failed` | Provider transport interruption #2 |
| 5 | wi-define-108-r5 | 10:11→10:24 | 14 | Submitted result rejected by `definition` output contract (missing required `goal`); result repair (1 attempt) exhausted | Model failure: output-shape non-conformance |

## Diagnosis (specific, attributable)

1. **External dependency (systematic):** the Z.ai Coding Plan route drops long multi-turn calls (2/5 attempts, both at 14–16 turns after ~10 min of accumulated context; short calls fine). Same long-generation failure class E4-H recorded on OpenRouter. 2 of the preregistered >3-interruption budget consumed.
2. **Model (real-repo scale):** against a large unfamiliar repository, glm-5.3-flash spent the entire 24-turn budget on exploration in 1/4 non-transport attempts and, in 1/4, submitted a Definition missing the contract-required `goal` field with repair exhausted. In E4-G/E4-H these steps ran against small fixture repos; the real-repo context is materially harder. Notably the model read the exact defect files (`rag-api-service/main.py`, `rag-worker-service/main.py`, `models/resource.py`) — targeting was correct; convergence was not reached.
3. **Experiment infrastructure (operator-owned, fixed):** attempt 2's post-submission crash was my driver missing the production map bootstrap; no Stratum source was changed.

Per prereg §8 this is a **Diagnosed failure**: a specific, attributable model + external-dependency cause prevented completion. It is NOT undiagnosable: artifacts, authorities, and ownership of next action are fully established (below).

## Hypotheses

- **H1 (Authority/handoff): NOT TESTED.** No canonical Definition was ever produced, so the DDR-041 handoff could not be exercised live. Mechanism remains covered only by the merged regression suite (23 tests).
- **H2 (Implementation): NOT REACHED.** H2's review element was additionally preregistered (§3.1) as: no in-path independent model review exists; deterministic gate + external review are the channels.
- **H3 (Delivery): NOT REACHED.** No generated code existed to publish; no PR opened; nothing merged (per prereg, never merge the pilot PR).

## Budget / intervention accounting

- Wall-clock: 72/120 min. Provider interruptions: 2/3. Semantic human Decisions: 0/2 consumed (no Decision ever surfaced). Build/debug + review-fix rounds: 0 used (never reached). Mid-run config changes: 0.
- Token usage: per-step token evidence not persisted for failed/halted runs (known PASS-only persistence gotcha, recorded as NOT PERSISTED, not zero). Wall-model durations per attempt are in step-executions.json.
- Operator actions (all overhead, logged in run-journal.jsonl): driver authoring; infra fix (map bootstrap) after attempt 2; two identical-config relaunches; one self-inflicted node-ABI detour (node 20 vs 22, no run impact); evidence capture; stop decision at 10:26Z on 2-cause saturation + wall-clock infeasibility of full execution (48 min remaining vs ≥3 full define-work minutes-per-attempt and a multi-step full-build ahead).
- No Definition was ever authored, edited, or paraphrased by the operator. No manual code edits. No config changes. Gate A evidence: gate-a.md (per-service pytest invocation correction recorded there).

## State integrity at close

- Target worktree: clean except untracked `.sle/` (run state). HEAD = `86ec087…`; origin/main unchanged. No model-generated source changes exist; nothing to publish; no PR.
- Ordinary checkouts untouched; stratum main at `fa51e8a…`; both frozen baselines intact.
- Evidence: run-journal.jsonl, step-executions.json, runs/<runId>/node-outputs + manifest.json ×5, gate-a.md, credit-probe result (route functional for short calls).

## Next action ownership (operator)

Candidate remedies are protocol-level decisions, not pilot improvisations — e.g. raising the multi-turn turn budget for real-repo scale, a provider retry policy for mid-loop drops, or define-work scoping guidance; each changes frozen inputs and belongs to a new preregistration, not to this run.

## Closeout amendment (operator, 2026-09-19)

**Overall: DIAGNOSED FAILURE** — with one positive sub-result recorded so it is not lost under the failure label:

> **Define-work real-repository convergence: demonstrated once.** Attempt 2 produced a contract-valid canonical Definition for #108 in 13 turns (17,687 bytes, semantic contract passed, materialized by Stratum, provenance hash verified). The existing configuration succeeded; no turn-budget, repair-budget, prompt, or contract change is justified by this evidence.

H1: not tested. H2: not reached. H3: not reached. (Unchanged.)
