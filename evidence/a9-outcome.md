# Pilot A9 — Outcome Record

**Date:** 2026-09-21. T0 18:47:49Z · terminal 19:01:37Z (13m48s).
**Execution revision:** `37c3acda6e8e248965ed88c2e2e1cc32c6c64298` (post-PR-#34, exactly as preregistered; the PR #35 merge commit is docs-only and outside the freeze).
**Driver:** `d9d699c2…` — verified at Gate A, after seed, and post-run: **byte-identical, zero mid-run edits**.
**Classification: DIAGNOSED FAILURE — turn-cap exhaustion at `synthesize-definition` (the A4 terminal class), with a new behavioral signature. Zero operator repairs (per the A9 prereg, none were permitted; none were needed for the transition — the run never reached it).**

## Run facts (run `b89c4a29-1cbf-491e-9731-3744aaad2718`)

- `turns_taken: 24` (cap) · `stop_reason: "tool_use"` — the cap hit MID-TOOL-USE; the model never emitted any Definition text (`text_length: 1`) and never reached `submit-result`. 1 format repair was consumed early (transport syntax, recovered).
- Tool activity: **43 calls — 31 `list_directory` (17 unique paths) + 12 `read_file` (6 unique paths)**.
- **Circling signature:** both key files (`rag-worker-service/main.py`, `rag-api-service/main.py`) were read **4 times each**; turns 22–23 spent 7 `list_directory` calls on directories already listed (e.g. `rag-worker-service` re-listed at turn 22 after `apps/ai-server` at the same turn).

## What this means

1. **Not an integration seam.** Every deterministic boundary held: Gate A 9/9 (including the E19 publication contract), schema-valid seed, budgets proven on the wire (5/5), 0 decisions, clean halted terminal, honest failure records. The failure is **model behavior variance inside the frozen define-work protocol** — the staircase has returned to the model-capability era at the synthesize step.
2. **Synthesize is a stochastic boundary with measured variance.** Same model, same prompt, same protocol: A6 converged in 9 turns/16 tools; A7 in 19 turns/27; A8 in ~8 min; **A9 circled and died at 24**. Cross-run record at synthesize-definition: **3 successes / 1 exhaustion (A4 was the same terminal class at the same step)** — i.e. 3/4 observed convergence under the current 24-turn cap and teaching.
3. **A4 vs A9 distinction for the record:** A4's 38 reads were all unique (thorough, unlucky); A9 repeated reads and re-listed directories (non-converging loop). Any future cap or teaching adjustment should target loop-breaking, not capacity.
4. **Per the frozen decision rule** ("define-work failure → preserve exactly, diagnose, STOP"; define-work and its protocol are frozen territory): no rerun, no cap change, no teaching change, no repairs were made. The A9 prereg's zero-repair rule was honored trivially — the transition was never reached, and nothing was mutated after the failure.

## State preserved

`wi-define-108-a9` failed · run halted at `synthesize-definition` · 0 decisions · archive `pilot-a9-sle-archive.tgz` (+ pre-seed backup `pilot-a8-sle-pre-a9-backup.tgz`).

## Evidence index

`gate-a-a9.md` · `a9-outcome.md` · `a9-manifest.json` · `a9-synthesize-loop.json` (43-call trace) · `a9-drive-console.log` · `a9-budget-probe.mts` · `pilot-a9-sle-archive.tgz`.

## Decision required (operator)

Options the evidence supports (no action taken):
- **Rerun A9 as-is** (frozen) — tests whether 3/4 variance lands a clean H1 transition this time; cheapest path to the pristine transition claim.
- **Cap/teaching amendment via a new prereg** — e.g. loop-breaking guidance (no re-reads of unchanged files; a listing budget) with a raised cap; this reopens the frozen define-work protocol and needs explicit authorization.
- **Accept A8 as the H1 evidence** and move the frontier question to where the operator already aimed: full-build's deeper seams or H2 itself.
