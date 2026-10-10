# P4 DESIGN DRAFT — Autonomous Upstream Reliability

**Status:** DRAFT v1 — for architecture review. Not frozen, not preregistered, no GO.
**Directive:** operator authorization 2026-10-10 — "P4 design only"; STOP before implementation.
**Predecessor evidence:** P2 forensics (`evidence/p2/forensics/p2-upstream-forensics.md`), P3 closeout (`evidence/p3/p3-closeout.json`), charter v1.1.

---

## 1. Research question

Can the real Stratum workflow, using a real LLM rather than scripted upstream fixture replay, consistently produce a valid BUILD-entry state?

P3 proved the BUILD intervention publishes reliably once a valid entry state is supplied (3/3, QUALIFIED SUPPORT). P2 showed the real upstream never supplied one (0/9 workflows reached BUILD). P4 removes the fixture replay: the model must drive define → scoping → design → plan itself, and the endpoint is the **objective readiness of the confirm-gate state** — stop before executing BUILD.

## 2. Primary endpoint — BUILD-entry readiness

One attempt = one fresh workflow instance from a pinned task input, upstream steps executed by the real model under the request-time guard, terminating at the confirm checkpoint. The attempt is **READY** iff ALL of:

| # | Check | Objective criterion | P2 failure it closes |
|---|---|---|---|
| R1 | workflow state | execution WorkItem live; cursor at `confirm`; a well-formed pending checkpoint decision exists | upstream never reached BUILD (0/9) |
| R2 | authority | a definition artifact exists with recorded `definition_sha256`, produced by THIS run's model output; the execution WI references it as `definitionSource` | fixture replay was doing this in P3 |
| R3 | configuration | `.sle/settings.json` sha == `5634b2e8…` verified at EVERY step transition AND the frozen file is installed once at campaign start; NO campaign code rewrites it | `seed()` clobbered settings 10/10 runs |
| R4 | budget on the wire | every archived upstream request carries `max_tokens` from the frozen per-step map (`workflow_max_tokens`: design/plan 32768; global 16384 elsewhere) and the frozen effort keys | P2 transmitted 16384 everywhere; budgets never verified at request construction |
| R5 | edit policy | workflowParameters carry `allowedEditPaths`/`requiredEditPaths` over the worker file (equivalent to the P3 fixture's policy) | — |
| R6 | wire integrity | every upstream turn archived by the guard (request+response pairing, wire_observation present); zero unarchived provider calls | P2's wire-capture gap (outbound max_tokens not recorded) |

Assessment is a recorded object per attempt: `READY` / `NOT-READY` + failure classification + evidence pointers. **BUILD is never executed** — the confirm decision stays pending; the endpoint is the state, which keeps attempts cheap and isolates the upstream question.

## 3. P2 failure analysis → P4 preventions

| P2 observed failure (forensics §) | P4 measure |
|---|---|
| `seed()` unconditionally overwrote frozen settings at every instantiate — 10/10 runs degraded (global 16384, no per-step map) (§1.3) | **No `seed()`/reset in the campaign path.** Settings installed once, state-guarded at every transition (R3); any drift = immediate STOP with the archived diff — the P2 mechanism becomes impossible to miss rather than silent |
| 5/9 slot-consuming failures were max_tokens termini at the perturbed 16384 budget (§1.1) | budgets are frozen per-step (32768 design/plan) and **verified on the wire** (R4); a genuine exhaustion at the correct budget is an evaluable NOT-READY (budget exhaustion is part of the frozen regime), never censored |
| budget never verified at request construction — silent divergence (§4) | per-request archival of resolved `max_tokens`/effort (the P3 guard already captures these — reused upstream) |
| 100% single-upstream routing (OpenInference) with accounting anomalies (§2–3) | provider recorded per response (P3 captures already do); anomalies classified as observations; censoring only per addendum-2 discipline (ambiguity NOT censored) |
| mid-campaign misclassification → out-of-protocol wf9r (§5) | classification rules preregistered below; post-hoc reclassification requires operator ruling, never a silent extra attempt |

## 4. Configuration integrity (#4)

- The **state-time guard**: before each upstream step, verify `settings.json` sha == pinned; archive the verification with the step record. Drift → STOP `CONFIG-DRIFT` (procedure class, campaign-terminal, zero slots consumed).
- The **request-time guard**: the same `createConfigGuardProvider` composition proven in P3 wraps every upstream step's provider, with per-step contracts derived from the frozen settings (budget map + effort + no tool surface except the step's declared tools). Captures identical in format to P3 (`guard-capture.jsonl`).
- Campaign code NEVER writes `.sle/settings.json` after installation. The workflow engine itself may only read it (verified: P2's clobber came from the untracked campaign driver, not `src/`).

## 5. Sampling (#2) — prospective, not result-chosen

- **Task:** the single pinned task input `evidence/p3/inputs/issue-108.json` (`dd401472…`) — the same task P3 exercised, now WITHOUT replay. Fixed-task repetition measures delivery reliability and avoids task-difficulty confounds; generalization across tasks is explicitly out of scope.
- **Sample size:** N = 3 fresh workflow instances (P1-R/P3 convention; smallest sufficient for a first upstream observation per charter §7).
- **Success threshold:** ≥ 2/3 attempts READY (matches the P3 convention; a lower bar than "all 3" is honest about upstream difficulty: P2 was 0/9).
- **Denominator:** every launched workflow instance is an evaluable attempt with outcome `READY` or `NOT-READY(<class>)`. NOT-READY classes (from P2's observed failures): `budget-exhaustion-upstream`, `authority-invalid`, `workflow-abandoned` (cap-hit halt / max-iterations), `malformed-state`, `provider-error-unresolved`. Procedure classes consume nothing: `CONFIG-DRIFT` STOP, transport re-queue (bounded at 3, P3 discipline), guard evidence STOP, §10 crash recovery.
- **Stop rules (immediate, campaign-terminal):** CONFIG-DRIFT; any disk write outside allowedEditPaths during upstream; guard STOP (G1/G2 semantics inherited); evidence-archive failure. Same shape as P3's frozen rules.

## 6. Crash recovery (#6) — charter §10 implemented

The P4 campaign runner implements ledger-driven resume BEFORE launch (declared here, satisfying §10.5):
- append-only campaign ledger is the counting source of truth;
- an attempt with `attempt-counted` is **retained** (never re-run, never double-counted);
- a mid-flight attempt at crash time is **declared incomplete** (runtime capture archived under `interrupted-*`, never classified, consumes nothing);
- resume continues the original terminal condition (3 evaluable or a STOP);
- all orchestration logs written under the campaign evidence dir from process start.
P3's restart qualification must not be repeatable unpreregistered — in P4 the recovery path is in the preregistration before dialing.

## 7. Evidence (#5)

Per-attempt package (P3 packaging reused): `guard-capture.jsonl` (all upstream turns), `db-records.json` (work items, decisions, artifacts, authority rows for the run), `readiness-assessment.json` (the R1–R6 object), `run-artifacts.tgz` (run dir), `evidence-manifest.json` (+ `package_sha256`). Campaign ledger with events: `preflight`, `attempt`, `readiness`, `attempt-counted`, `config-verification`, `transport-requeue`, `campaign-terminal`. Terminal campaign report in the P3 format.

## 8. L1 / L2 / L3 qualification — smallest sufficient (#7)

- **L1 (offline, scripted providers — zero traffic):** the real workflow engine driven end-to-end to the confirm gate on scripted upstream completions: (a) READY path — all six checks pass; (b) each NOT-READY class induced synthetically and classified correctly; (c) settings-clobber simulation → CONFIG-DRIFT STOP; (d) a scripted request with a drifted budget → request-time guard STOP; (e) §10 resume: kill mid-attempt, resume from ledger, retained slot preserved, incomplete attempt discarded; (f) fixture-INDEPENDENCE proof: no `seed()`/replay call exists in the campaign path (code inspection gate).
- **L2 (real-provider, one round ≤ 6 calls, ops-qual namespace):** (a) one define-shaped and one design-shaped turn accepted at the frozen upstream budgets; (b) reasoning-burn calibration at 32768 (P2's hidden-burn anomaly makes this the one budget worth measuring before campaign); (c) verify the guard archives upstream tool surfaces correctly.
- **L3:** the N=3 campaign under this preregistration.

## 9. Scope control (#8)

Reused unchanged: workflow engine + decision repos (Stratum `9f298f2`), config-guard capture machinery, evidence packaging, campaign ledger + adjudicators, restoration, qualification harness patterns. New code (thin, single-purpose): upstream per-step contract derivation from the frozen settings; the R1–R6 readiness-assessment function (pure); ledger-resume in the campaign runner. **No new general-purpose orchestration framework.**

## 10. Cheapest compliant path to the first observation

L1 gates → one L2 round → L3 attempt 1 (first genuine upstream-to-BUILD-entry observation expected here) → complete N=3 → terminal report → STOP for results review.

## 11. Open questions for the architecture review

1. **Endpoint strictness:** is R4 (per-request budget verification) a readiness criterion or a campaign STOP criterion? Drafted as STOP-if-violated + READY-if-clean (strictest, and the direct anti-P2 rule) — confirm.
2. **Upstream step set:** P4 lets the model run the workflow's own upstream steps (define/scoping/design/plan as defined by the frozen workflow definition), NOT a custom pipeline — confirm the frozen workflow definition itself is the treatment.
3. **Confirm decision:** left pending at readiness (drafted). Alternative: approve and continue into BUILD for a composite endpoint — rejected for scope control (BUILD is P3's closed result).
4. **Sample size:** N=3 fixed-task is a reliability probe, not an estimate — confirm acceptable, or name the task-mix alternative.
