# Pilot A7 — Outcome Record

**Date:** 2026-09-21. **Define WI:** `wi-define-108-a7` (completed) · **Exec WI:** `wi-exec-108` (ready, not dispatched).
**Execution revision:** `184517ad69c34e39564dfe8ae8cf135d9c9e215e` (PR #31 merge commit).
**Driver:** `718374b4f334be5655d2d6b41c606917a87a221b3bf3c044a3522171ddc3f693` (corrected seed) — verified identical pre-T0 and post-run.
**Classification:** DIAGNOSED FAILURE at the full-build threshold — with the series' two largest milestones reached (define-work completed end-to-end; DDR-041 resolution live-proven).

## Run timeline (driver journal, UTC)

- 12:31:xx — Gate A complete (ten operator-pinned facts verified; see gate-a-a7.md); fresh seed `wi-define-108-a7`; mechanical settings action (step-scoped 32,768); safeguards: on-disk map parses (`custom`/`local`), wire budgets `[32768,32768]` / `[16384,…]` across synthesize / readiness / refine / full-build.
- 12:33:52 — T0: `drive wi-define-108-a7` (provider_resolved 16384 global — expected).
- 12:33:52 → 12:50:03 — `synthesize-definition` **complete**: 19 turns, 27 tool calls, 16m11s — **zero max_tokens stops, zero contract rejections, first-try accepted submission** (second consecutive run; A6's accepted-submission result reproduced).
- 12:50:03 — `refine-definition` skipped (routing); 12:50:03 → 12:51:28 — `definition-readiness-review` **complete** (readiness.md, 3,907 bytes, provenance-pinned `eae0c2a2…`); deferred/human-decision steps not triggered (0 decisions — budgets 2/3/2 unused); `commit` **complete**; run `8d4b2eb2…` **complete** at 12:51:28 (17m36s of the 120-min clock).
- 12:52–12:56 — post-run protocol: `execute-wi` → two frozen-driver lifecycle defects surfaced and were repaired mechanically (operator-actions-a7.md); **Gate B: `gate_b_resolved`** — DDR-041 provenance + hash pin verified LIVE (`66c6f7ad…`, 16,525 bytes) — then the context-assembly probe THREW `context_budget_exceeded` (see gate-b-a7.md).

## What A7 proved

1. **The A6 seed fix cleared the boundary it targeted:** the post-step map sync (`updateArtifactEntries` → `RuntimeMapSchema.parse`) admitted the artifacts and define-work ran to commit — the exact path that killed A6.
2. **define-work is now end-to-end complete on a real repository:** synthesis → (refine skipped by routing) → readiness review (PASSED — the Definition was accepted as ready without refine) → commit. 19/24 turns used; step-scoped 32,768 budget sufficient again; global 16,384 untouched for every other step.
3. **Accepted submission reproduced** (2nd consecutive): the E12 source/kind teaching holds across independent runs — no longer a one-off.
4. **First live DDR-041 resolution:** source-WI completion check, D.1 provenance join, sha256 pin, ref/path resolution — all verified against the real canonical Definition.

## The new failure (preserved exactly; diagnosed independently)

`ContextManager.assemble` for the full-build builder role **fail-closes**: fixed components total **4,315 tokens** (system 0, state 33, **task 4,282**, failureContext 0) vs the **frozen hard_ceiling 4,000**. The `task` component carries the verbatim canonical Definition (16,525 bytes) — the Definition ALONE exceeds the ceiling. At ceiling 8,000 the identical assembly succeeds with verbatim inclusion verified true. So: mechanism correct, ONE frozen constant incompatible with the empirically observed canonical Definition size (A6 18,282 B; A7 16,525 B — synthesis reliably produces ~16–18 KB Definitions).

## Narrowly stated hypothesis for the next intervention (for separate review — NOT applied)

The frozen `hard_ceiling: 4000` predates the existence of real canonical Definitions and is structurally incompatible with them: **no** Definition-sized artifact (≈4.1–4.6K tokens verbatim) can ever reach the builder context at 4,000. The single demonstrated-boundary fix is a preregistered raise of the full-build builder-role context ceiling (e.g. to 8,000 — verified sufficient with headroom in this run's measurement) as pilot A8's one variable, everything else frozen. Alternatives (summarized Definition injection, per-step slices) change the DDR-041 verbatim-inclusion guarantee and should NOT be chosen without explicit review. Per the operator's decision rule, if A8 crosses into full-build, the project moves to H2/H3 (implementation quality and delivery evidence).

## Accounting / protocol notes

- Decisions: 0 raised; budgets 2/3/2 unused. Escalations 0. Transport failures 0. Length exhaustions 0.
- Token spend not persisted by the runner (unchanged series limitation); activity counts above are authoritative.
- Frozen-driver defects logged for a FUTURE driver revision (NOT changed now, hash frozen): (a) `executeWi` ignores its defineWi argument for `definitionSource`/`dependencies` (stale `'wi-define-108'` constant; FK crash); (b) no command advances `in_review → completed` after a successful run; (c) gate-b requires `execute-wi` first (order not enforced by the driver).
- H1: resolution half PROVEN live; execution half blocked by the ceiling. H2/H3: not attempted.

## Evidence index

`gate-a-a7.md` · `gate-b-a7.md` · `operator-actions-a7.md` · `a7-drive-console.log` · `a7-manifest.json` · `a7-synthesize-loop.json` · `a7-definition-materialized.md` (sha `66c6f7ad…`) · `a7-readiness.md` (`eae0c2a2…`) · `pilot-a7-sle-archive.tgz` · `run-journal.jsonl` (appendix).
