# Pilot A10 — Outcome Record

**Date:** 2026-09-21. First T0 19:25:57Z · final terminal 20:42:30Z. Six frozen attempts, zero run-repairs, driver `0ffea302…` byte-identical throughout (verified per attempt).
**Execution revisions:** attempt 1 at preregistered `37c3acd`; attempts 2–6 at `a95bb58` (post-PR-#37 — the sanctioned seam-qualification loop).
**Classification: FRONTIER ADVANCED — scoping publication CLOSED (deterministically repaired, live-proven), DESIGN COMPLETED (first post-scoping artifact step ever), then held by the measured stochastic turn-cap class at `plan`.**

## Attempt ledger

| # | Rev | Scoping | Checkpoint | Design | Plan | Terminal cause | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `37c3acd` | ✓ 6 turns, charter at exact declared path | — | — | — | charter rejected on grammar (`## In scope`) → **F-d**: E19's template teaching is inert in the execution path; **F-e**: begin() throw left run ACTIVE/node RUNNING | **E20** (PR #37): grammar taught in the assembled task channel; failures as clean outcomes |
| 2 | `a95bb58` | ✗ 24-cap (35 calls, no repeats) | — | — | — | **fixture residue (my error)**: attempt-1 `docs/cycle-charter.md` survived the `.sle` wipe | fixture hygiene: clean docs/ too |
| 3 | `a95bb58` | ✓ 13 turns, **grammar-perfect charter** | ✓ approve | 17 turns → `stop_reason: max_tokens` @16,384 | — | **A5 class at design** | sanctioned E15 pattern: step-scoped `full-build/design: 32768` (probe 4/4 PASS) |
| 4 | `a95bb58` | ✗ 24-cap (32 calls, no repeats) | — | — | — | stochastic turn-cap | frozen rerun |
| 5 | `a95bb58` | ✗ 24-cap (37 calls, no repeats) | — | — | — | stochastic turn-cap | frozen rerun |
| 6 | `a95bb58` | ✓ 14 turns | ✓ approve | **✓ 11 turns — design COMPLETED** | ✗ 24-cap (42 calls, no repeats) | stochastic turn-cap at plan | STOP — report |

Decisions consumed: ≤1 per run (2/3/2 honored). No DB/driver/state repairs at any point.

## What A10 proved

1. **The scoping publication seam is CLOSED and live-proven** (attempt 6, end-to-end): declared output → exact-path materialization (`docs/cycle-charter.md`) → grammar-perfect charter (`## Scope`/`## Purpose`/`## Requirements`/`## Boundaries`/`## Version bump`/`## Deferred items` — E20's channel works) → begin()-time validation → checkpoint → approve → design. A8's F-a/F-b and the A10 F-d/F-e findings are all fixed and verified on real model runs.
2. **DESIGN completed for the first time in the series** — an 27,981-byte design document of striking quality: correct two-sided contract diagnosis (worker publishes `{"error": str(e)}`; api reads `error_message`/`stage`/`retryable`), silent-default analysis (`"Processing failed"`, `error_stage=None`, `retryable=True`, `code="UNKNOWN"`), recognition that the stale-lease sweep and Resource model already speak the right schema, provenance-pinned to the authoritative Definition and explicitly bounded by it. **This is the first direct H2-capability evidence: the model understands the real defect and designs the right fix.**
3. **The binding constraint is now measured, and it is not seams**: per-step convergence under the frozen 24-turn protocol for broad-access artifact steps is stochastic — scoping 2/5 on clean fixtures (attempts 2–6), plan 0/1, synthesize 3/4 (A-series). All failures share one signature: exhaustive unique exploration (25–42 calls, near-zero repeats) that never transitions to synthesis — wandering into `docs/system-overview/`, `README.md`, `AGENTS.md` beyond the bounded seam. This is the A9 class generalized, now blocking the full-build pipeline.
4. **The deterministic budget seam at design** (A5 class) was fixed with the already-sanctioned step-scoped mechanism and verified on the wire (4/4 probe) — and design then completed on its first post-fix invocation (attempt 6).

## Pipeline state after A10

```text
authority (frozen A8 Definition) → DDR-041 → Gate B       ✓✓ live
scoping.produce (model)                                   ✓ stochastic (~40–50%/attempt)
charter publication + validation + checkpoint + approve   ✓✓ deterministic, closed
design (model, 32,768 budget)                             ✓ demonstrated (completed once)
plan / test / build / validation / delivery               reachable; plan blocked by the same stochastic class
H2 — correct code                                         first evidence: the A10 design document (quality: high)
H3 — trustworthy delivery                                 UNKNOWN
```

## Decision required (operator)

The stochastic per-step convergence is now the single blocker between here and BUILD. Options, nothing taken:
1. **Continue frozen reruns** — each full attempt is ~5–20 min; the compounding per-step dice make a BUILD arrival possible but unreliable.
2. **Extend the deferred protocol work** (loop-breaking teaching / exploration-progress triggers / step-scoped turn budgets) to the full-build artifact steps — this is the same intervention you deferred for define-work, now measurably blocking H2/H3 answers. The A10 evidence (near-zero repeats, wandering into general docs, cap mid-tool-use) gives it a concrete target.
3. **Judge H2 capability from the design document now** — the first downstream artifact already demonstrates defect comprehension at the required level.

## Attempt 10 (orphaned by operator abort — no result)
- Run `d92f2f9e` @ `97017c2`, driver `0ffea302…`, T0 2026-09-22T10:26:51Z. First configuration with `full-build/plan: 32768` (probe 5/5 PASS).
- scoping.produce ✓ 5 turns (gate never activated); checkpoint decision `8d722c05` resolved approve 10:30:53Z; design orphaned ~1s into execution by operator abort of the resolve process; no design work persisted; no mid-step resume path exists. Archived `pilot-a10-attempt10-orphan-archive.tgz`. Not a model-behavior data point; fixture rebuilt for attempt 11.

## Attempts 11–13 (E22 era, rev `2ba4908`, driver `0ffea302…`)

| Attempt | scoping | design | plan | test | outcome |
|---|---|---|---|---|---|
| 11 | ✓ 2t | ✓ 19t (20,021 B, **E22 marker framing live**) | ✓ 19t (24,181 B — **PLAN COMPLETE**) | ✗ 17t `max_tokens` @16,384 | A5 at test |
| 12 | ✓ 11t | ✓ 17t | ✓ 20t | ✗ 19t `max_tokens` @32,768, 31,997 chars, 0 repairs | A5 at test (32k) |
| 13 | ✓ 11t | ✓ 15t | ✓ 15t | ✗ 19t `max_tokens` @65,536 request, 27,984 chars, 0 repairs | **context saturation** |

Upstream of test the pipeline is now uniformly convergent under E21 (scoping 2–11t, design 15–19t, plan 15–20t; plan complete twice consecutively). TEST is the last seam, and attempts 12→13 prove it is NOT a completion-budget problem: the cut point moved DOWN (31,997 → 27,984 chars) as the requested budget moved UP (32,768 → 65,536, probe-verified on the wire). The provider truncates the completion against remaining context. The test step's ~18 investigation turns accumulate full file contents into the conversation (~100k+ tokens); the synthesis turn cannot fit. Zero repairs in all three failures — the gate delivers the model to synthesis cleanly every time; the window does not hold the reply.

Archives: `pilot-a10-attempt{11,12,13}-sle-archive.tgz`, per-attempt loop JSONs, budget probes `a10-{plan,test,test64}-budget-probe.mts` (6/6 PASS each). Budget extensions applied: plan 32,768 (attempt 9 basis), test 65,536 (attempt 12 basis — now known inert against this seam).

## Attempt 14 (E23 era, rev `6fb4f67`) — THE MILESTONE RUN

Configuration identical to attempt 13 except E23 (synthesis-boundary compaction, preregistered 49,152-byte newest-first budget). Clean attribution.

| Step | Turns | Result |
|---|---|---|
| scoping.produce | 13 | ✓ charter published |
| design | 13 | ✓ |
| plan | 20 | ✓ |
| **test** | **19** | **✓ COMPLETE — compaction record: 263,336 → 48,518 bytes retained, 4 largest oldest reads elided (both 91–96 KB main.py files among them), exactly the preregistered behavior** |
| sharding_approval | — | skipped |
| CONFIRM | — | operator approve (2/2 decisions used) |
| **BUILD** | 24 | ✗ cap — 33 exploration calls (16 list / 17 read), **zero write calls**, `max_tokens` mid-tool-use (A4-class convergence at the deliberately ungated step) |

E23 verdict: **successful** — attempt 13 (truncation at 27,984 chars) vs attempt 14 (test completes) differ only by compaction. The context-saturation diagnosis is confirmed and closed.

Pilot state: the full-build pipeline has, for the first time in the program, traversed scoping → design → plan → test in a single run. BUILD is the only step that has never produced code; its failure is the pre-E21 convergence disease on the one step the operator deliberately excluded from the gate ("BUILD has different tool and workspace-mutation requirements and needs separate assessment"). Per the standing directive, orchestration hardening stops here; whether BUILD gets the gate (or any other treatment) is an operator decision, and H2 code judgment awaits a BUILD that writes.

Archives: `pilot-a10-attempt14-sle-archive.tgz` + per-loop JSONs + test observation.

## Attempt 16 (E25 era: BUILD completion 16,384 → 65,536, rev `ef3e54f`)

Single variable vs attempt 15, probe-gated (6/6 wire rows on exact production construction order + real-route 65,536 capacity check). scoping 19t; design 13t; plan 18t; test 19t ✓ (fourth consecutive); CONFIRM approved.

| Node | Result |
|---|---|
| **build (loop)** | **✓ complete, 19 turns — gate fired exactly at 19; compaction 236,153 → 49,042 B (2 elided); NO max_tokens — attempt 15's failure mode closed** |
| build (artifact) | ✓ 29,107-byte parseable artifact: full implementation spec for #108 (rag-worker `_derive_retryable` + failure-payload helpers + stage tracking; worker→rag-api contract test; rag-api reads/schema untouched per must-constraint) |
| materialization | ✗ the artifact's section (`.sle/work/wi-define-108-a8/implementation.md`) never landed on disk; no artifacts-table row; `git status` clean |
| exec | "complete" on a clean tree |
| validation_gate | ✗ failed |
| debug | ✗ ungated, 24-turn exploration cap mid-tool-use (`Agent did not produce a result block within 24 turns`) — the pre-E21 disease on the workflow's own debug step |

Closeout mapping: neither preregistered outcome (a) nor (b). The completion-capacity question is CLOSED (solved at 65,536; never raise again on this route). The new independent failure is **artifact materialization/publication** for the build step's open artifact set, followed by downstream validation/debug machinery that itself lacks the qualified convergence gate. Per directive: no orchestration changes; stopping for operator review.

Frontier: authority/DDR-041/scoping/design/plan/test/checkpoints ✓ · E21 ✓ live · E22 ✓ live · E23 ✓ clean A/B · E24 gate-on-BUILD ✓ (fired 19/24, compaction exact) · E25 BUILD capacity ✓ (loop completes) · **BUILD code output: artifact complete, materialization gap** · H2: blocked on materialization, not on the model.

## Attempt 17 (E25 era, rev `0c1b8d4`) — the fail-closed gate's first catch

scoping ✓ 12t (charter materialized). design ✗ 20t at the new §6d gate: `Step produced no usable output sections; parse warnings: Path not permitted for role 'designer': .sle/work/wi-define-108-a8/design.md (section dropped)`.

**Discovery:** the designer ceiling (`docs/requirements.md`, `docs/architecture.md`) never permitted the `.sle/work/…` path the transport taught. The same mismatch exists for planner and tester. Conclusion: in every attempt since the role ceiling shipped (8–16), design/plan/test sections were dropped at parse, the steps silently succeeded with zero materialized files — the exact pathology E25 closed for BUILD — and the pipeline actually ran on raw run-artifact outputs, not the materialized tree. Only scoping ever landed a file. E25's BUILD fix is validated; its fail-closed principle has now made a program-wide latent defect visible on its first live step.

## Attempts 17–18 (E26 era, revs `0c1b8d4` → `0910d49`) — FIRST DURABLE SOFTWARE

Attempt 17: E25's fail-closed gate caught design publishing zero files — exposing that ALL design/plan/test completions since the role ceiling shipped were silent zero-output successes. Mechanical replay: 8/8 preserved producer replies declared `.sle/work/…` paths the ceiling drops.

Attempt 18 (E26 live): scoping 1t ✓; design 3t ✓; plan 4t ✓; test 4t ✓; build 19t ✓ (gate 19, compaction 379,223 → 42,686 B). **The target tree received, for the first time: docs/requirements.md, docs/architecture.md, docs/plan.md, docs/test-plan.md, docs/cycle-charter.md, and an executable AST-based contract test** (`test_worker_failure_payload_contract.py`), each with hashed `produced-file` provenance rows.

H2 first evidence: the published test is high-quality — parses both real `main.py` sources, pins the worker→rag-api failure-payload seam (error_message/stage/retryable + legacy error hedge), guards drift, derives retryable via classify_error, keeps rag-api untouched per the Definition's must-constraint. It FAILS exactly where it should: the worker's `process_document` lacks `error_message`/`retryable` — the test detects the unimplemented fix. The implementation itself was never written; DEBUG (ungated) died at its 24-turn cap.

Program state: the delivery boundary works end-to-end (produce → publish → verify-on-disk → validate → fail-closed). What remains is inside the model's own loop: finishing test-first work — which is the workflow's DEBUG step, explicitly deferred by ruling ("assess debugging only when it receives a genuine failed implementation and useful validation evidence" — that condition is NOW met). Orchestration hardening remains stopped; the next move is the operator's H2 ruling.

## E27 (post-A18) — protected tests + bounded source edits

Phase A audit: 8/8 historical producer replies confirmed dropped (attempts 6–16); attempt 18's TEST→BUILD overwrite verified by hash (b3b30497… → 6b026ca9…); rag-api must-constraint was honored but unenforced. Phase B/C: inter-step ownership over provenance rows; SLE-PATCH (pinned base sha256 + strict unified diff, zero-fuzz applier); staged pre-write validation; explicit partial-failure evidence; rag-api denied by declaration; requiresSourceEdit on BUILD. Phase D: 18 zero-model tests, verify 1,696/0 ×2. PR #44. **Stopped for merge review before the live H2 continuation.**

### E27r (merge-review amend of PR #44, supersedes b3b784 state)

Merge review verdict: keep branch, amend, do not merge. Four changes: (1) authorability — `read_source_slice` (bounded excerpt + authoritative digest, survives E23) with an attempt-18 zero-model reconstruction proving the synthesis request holds exact context + base digest; (2) `EditPolicy` from frozen `workflowParameters` (positive allow + require, exact paths) replacing FULL_BUILD-hardcoded deny/require; (3) `restore-test-artifact` fixture op seeding archived TEST bytes + `produced-file:test:…` ownership (legacy rows proven non-protecting); (4) patch transport byte-exact (no trim), 20-patch / 32 KB bounds, literal no-newline marker only. The three automated blockers were dismissed by the operator. Verify 1,708/0. Awaiting second merge review; attempt 19 still gated on it.

### E27r round 2 (PR #44 @ 4dcaa24) — awaiting third merge review

Review blockers resolved: EditPolicy now step-scoped (appliesToSteps; upstream producers unaffected — R4/R4b), restore-test-artifact seeds ownership into the explicit DESTINATION run with exact archived-row matching (original b3b30497… required, BUILD replacement 6b026ca9… tolerated, attempt-18 rows untouched — R5 cross-run proof), pilot driver removed from the PR (untracked fixture; attempt-19 policy preregistered in its workflowParameters), ownership refs suffix-parsed and listByWorkflowRun rowid-ordered (R6 tie proof). Verify 1,712/0 ×2 (one pre-existing EADDRINUSE flake in the auth API family, present on baseline too). CI green.

### E27r final amend (PR #44 @ f339af0) — merge-ready

Final blocker closed: appliesToSteps targets validated against the selected WorkflowDefinition once, in run(), before any step executes — a misspelled target ('buid') now fails at dispatch with no step-runner invocation (R4c); duplicates/empty rejected; R4's per-step projection unchanged. PR description rewritten to the final architecture and current qualification. Verify 1,713/0 ×2; CI green. Awaiting operator merge; attempt 19 follows it.

## Attempt 19 (E27 live continuation) — run 2ec825a7…, revision 3cb3ab8

**First attempt with the full E27 boundary live.** Scoping/design/plan/test all completed with provenance (E26 contract held); the restore op seeded TEST's original `b3b30497…` bytes + ownership into the run scope between CONFIRM and BUILD (archive-DB sourced; BUILD's replacement row tolerated). BUILD's model adopted `read_source_slice` unprompted (turns 5–9) — the authorability mechanism worked live: E23 elided both full 95,897-byte worker reads while the slices + authoritative digests survived to the synthesis turn. At the gate turn the provider returned `max_tokens` with **zero text** over the full probe-verified 65,536-token budget — a degenerate reasoning-only completion (model-side, not orchestration). The loop failed closed; nothing was written; worker base `7d7718bc…` and the restored TEST artifact are untouched. **H2 has no code to evaluate this attempt.** No orchestration change is justified by this outcome (stop rule). Stopped for operator ruling; DEBUG not invoked.
