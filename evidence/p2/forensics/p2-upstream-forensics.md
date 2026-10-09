# P2 Upstream Forensics — budgets, settings provenance, provider routing, token accounting

Date: 2026-10-09 · Scope: offline reconstruction from archives + runtime code; zero model traffic
Frozen implementation: stratum `9f298f2` (tracked tree untouched throughout this audit)

## 1. DESIGN/PLAN request budgets — RESOLVED

**Finding: the frozen per-step budgets (32768 for design/plan/test/build) were NOT transmitted in ANY P2 workflow. Every P2 step ran at the global budget of 16384.**

Evidence chain:

1. **Terminal token counts.** All six P2 `finish_reason="length"` termini stopped at exactly
   `completion_tokens=16384` (the settings global `max_tokens`), never 32768:

   | run | stage | completion | streamed reasoning | visible content |
   |---|---|---|---|---|
   | wf2 | plan | 16384 | 38 | 116 B |
   | wf3 | scoping.produce | 16384 | 16384 | 1 B |
   | wf5 | design | 16384 | 106 | 83 B |
   | wf7 | design | 16384 | 16384 | 1 B |
   | wf8 | plan | 16384 | 46 | 97 B |
   | wf9r | design | 16384 | 16384 | 0 B |

2. **P1-R comparator under the SAME settings file (`5634b2e8…`):** P1-R's max_tokens termini
   stopped at exactly **32768** — ef573d80 (plan, OpenInference), 32b96f25 (design, Sail Research),
   99100d24 (build, OpenInference). The same upstream (OpenInference) honored 32768 for P1-R plan.
   The per-step override demonstrably reached the wire in P1-R and did not in P2.

3. **Settings provenance.** Every P1-R run archive contains the FULL frozen settings
   (`5634b2e8…`, with `workflow_max_tokens` + `workflow_reasoning_effort`), verified across all five
   `evidence/p1-r/p1-r-*/<run>/settings.json`.
   The P2 runtime file is the REDUCED five-key config
   (`{"provider","model","base_url","max_tokens":16384,"api_key_env"}` — sha `fcd35b658368…`),
   byte-identical to the output of the campaign driver's `seed()`
   (`pilot-a-driver.ts:76-83`), which **unconditionally overwrites `ROOT/.sle/settings.json`**
   on every `instantiate` (the per-workflow reset step). The frozen file was installed and verified
   pre-execution, then overwritten by the first `instantiate` — before wf1 — and re-overwritten at
   every subsequent reset.

4. **Runtime consequence (code path, unchanged at `9f298f2` and identical at the P1-R commit
   `c0060f09` — diff shows no budget-plumbing changes):**
   `resolveWorkflowBudgetOverridesFromSettings` finds no `workflow_max_tokens` key → the map is
   `undefined` → `completionBudgetFor(ctx)` returns the global 16384 for every step →
   `AgentLoop` sends `max_tokens: 16384` on every turn (agent-runner.ts:430,465; agent-loop.ts:667).

   Also absent in P2: `workflow_reasoning_effort` (`build`/`test` → "low"). Moot for the steps that
   ran: the frozen regime specifies no effort override for scoping/design/plan, and absence of the
   map produces the same no-reasoning-key request shape for those steps. No deviation materialized
   on the steps that executed; the exposure existed only for build/test, which were never reached.

## 2. Provider routing

| Campaign | provider distribution (archived stage observations) |
|---|---|
| P1-R | 11 distinct upstreams (Relace 6, Sail Research 4, OpenInference 3, Decart, SiliconFlow, StreamLake, Z.AI, Cloudflare, Morph, InferenceNet, Novita) |
| P2 | **100% OpenInference (20/20 observations; scoping 10, design 7, plan 3)** |

Freezing `model=z-ai/glm-5.3-flash` + base_url does not freeze the serving backend. P2's single-upstream
concentration is correlated with two serving-side anomalies (below) that P1-R's diverse routing did not
exhibit at these rates. Correlation, not proven causation.

## 3. Token-accounting anomalies (provider-side)

Two distinct length-terminus shapes in P2:

- **Visible reasoning burn** (wf3, wf7, wf9r): `reasoning_tokens=16384` streamed, ~0 content.
  Internally consistent: the model spent the entire budget on streamed reasoning.
- **Invisible burn** (wf2, wf5, wf8): the upstream REPORTED `completion_tokens=16384` while the
  streamed reasoning carried only 38–106 tokens and visible content was 83–116 bytes.
  ~16k reported tokens have no archived visible counterpart — consistent with a hidden/default
  reasoning lane that OpenRouter's usage accounting bills but the SSE stream barely surfaces
  (the wire-capture `reasoning_tokens` counts only STREAMED reasoning content).
  Not observed in any P1-R terminal stage.

No P2 workflow sent a `reasoning` key (frozen regime: none for these steps), so any reasoning
executed upstream was provider-default behavior.

## 4. Campaign-level implication

P2 did not run under the preregistered frozen regime in the budget dimension: nine of nine workflows
executed with design/plan budgets at half the frozen value, and the campaign's dominant failure class
(5/9 slot-consuming failures were max_tokens termini at 16384) sits exactly on the perturbed parameter.
P1-R precedent shows 32768-token design/plan completions were reachable and sometimes still insufficient
(32b96f25 burned all 32768); the 16384 cap could only make upstream progression strictly harder.

Classification: **campaign-procedure defect in the untracked campaign driver (`seed()` overwriting the
frozen settings), not a Stratum implementation defect** — `src/` at `9f298f2` is byte-identical to the
P1-R commit in every budget-plumbing path and remained untouched throughout. The Stratum lesson is
nevertheless real: like P1's unpolicied runtime, the frozen configuration was not *verified at the
point of request construction*; the runtime read a settings file that had silently diverged from the
frozen bytes. A launch gate that pins settings at request-construction time (or archives the resolved
per-step budgets per request) would have caught this before slot 1.

## 5. Corrected slot accounting (per the operator's ruling on `39d4bda2`)

- `39d4bda2` (wf9): RECLASSIFIED from transport-censored to a slot-consuming pre-BUILD failure.
  Archived evidence: 2,046 B of model-attributable content; `stop_reason="end_turn"` in the loop;
  the wire `finish_reason="error"` co-occurred with a normally-paired request/response (no thrown
  provider exception); the step failed through the ordinary format-repair path. Addendum 2 permits
  post-model infra censoring only narrowly (no model-attributable content archived; ambiguity is NOT
  censored). The exclusion did not satisfy the rule as written.
- `wf9r` (97059d47): OUT-OF-PROTOCOL tenth workflow. The campaign should have stopped at the
  preregistered nine-slot boundary; the retry exceeded the cap because of the run-time
  misclassification. Records preserved; it is excluded from every denominator.
- **Primary verdict unchanged**: slots 1–9 produced zero BUILD opportunities →
  `UNEVALUABLE_FOR_ENDPOINT` stands (a fortiori under the degraded-budget regime).
- Additional disclosure: ALL ten runs, including wf1–wf8 and the out-of-protocol wf9r, executed under
  the corrupted settings file; the frozen-regime deviation is campaign-wide.

## 6. Artifacts

- Runtime settings file (post-campaign, = `seed()` output): `ROOT/.sle/settings.json` sha
  `fcd35b658368…` (reproduced verbatim in section 1.3; also re-derivable from the driver source).
- P1-R archived settings (full frozen file): `evidence/p1-r/p1-r-*/<run>/settings.json` — all sha `5634b2e8…`.
- The wire-capture wrapper does not record outbound `max_tokens` (operator-noted gap); the budget
  reconstruction above is from terminal token counts + code path + cross-campaign comparison, which
  together are decisive (16384 is neither the frozen per-step value nor explainable as provider
  generosity, given P1-R's 32768 termini on the same upstream).
