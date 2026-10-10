# P4 DESIGN DRAFT — Autonomous Upstream Reliability

**Status:** DRAFT v2 — revised per P4 architecture review of `8962ab5` (approved in principle; four narrow corrections applied). For final architecture review. Not frozen, not preregistered, no GO.
**Directive:** operator authorization 2026-10-10 — "P4 design only"; STOP before implementation.
**Predecessor evidence:** P2 forensics (`evidence/p2/forensics/p2-upstream-forensics.md`), P3 closeout (`evidence/p3/p3-closeout.json`), charter v1.1.
**Review rulings applied:** R4 wire mismatch = campaign-terminal procedure STOP (never model-attributed NOT-READY) · native `define-work` + `full-build` workflows (no custom pipeline) · stop at confirm, decision pending, BUILD never executed · N=3 fixed issue-108, ≥2/3 READY accepted as engineering qualification only.

---

## 1. Research question

Can the real Stratum workflow, using a real LLM rather than scripted upstream fixture replay, consistently produce a valid BUILD-entry state?

P3 proved the BUILD intervention publishes reliably once a valid entry state is supplied (3/3, QUALIFIED SUPPORT). P2 showed the real upstream never supplied one (0/9 workflows reached BUILD). P4 removes the fixture replay: the model must drive the native workflows' upstream progression itself, and the endpoint is the **objective readiness of the halted-at-confirm state** — stop before executing BUILD.

## 2. The real two-WorkItem lifecycle (correction 1)

One attempt = one clean-initialized pass through Stratum's **native** workflow pair, both driven by the real model under the request-time guard:

```
define-work (real model)
  ├─ produce (definition artifact authored by the model)
  └─ review (engine single-turn step)              [define-work.ts:180]
        ↓ handoff
execution WorkItem created with
  definitionSource: { workItemId: <define-work WI id> }
  validated by resolveDefinitionSource()           [definition-source.ts:97]
  (strict ref shape; fail-closed; integrity-pinned sha256; ≤131 072 bytes)
        ↓
full-build (real model)
  scoping.gather → scoping.produce → scoping.checkpoint*
  → design → critique (single-turn review) → plan → test
  → sharding_approval* → confirm   ← HALT HERE; decision pending
                                     (* = intermediate checkpoints)
```

- **Definition-source handoff** uses the existing `resolveDefinitionSource` machinery unchanged — it is the authoritative validation (ref shape, integrity pin, byte cap, fail-closed, no fallback). P4 adds no validation of its own.
- **Intermediate checkpoint and human-decision handling (preregistered):** the engine checkpoints encountered upstream are `scoping.checkpoint` and `sharding_approval`. There is no human in the loop; the campaign adjudicates them by a **determinate preregistered policy**: approve the pending decision **iff** the decision object is well-formed and all state guards pass; otherwise the attempt is NOT-READY (`malformed-state`). The campaign never authors, edits, or improvises decision content. The **`confirm` decision is never adjudicated** — it is left pending; that pending state is the endpoint.
- Engine-internal review steps (`critique` in full-build; the review in define-work) are single-turn engine executions, not human decisions; they run or loop per the frozen workflow definitions (`on_fail → design`), untouched.

## 3. Primary endpoint — BUILD-entry readiness

One attempt terminates at the confirm gate. The attempt is **READY** iff ALL of:

| # | Check | Objective criterion | Closes |
|---|---|---|---|
| R1 | halted-at-confirm state (correction 2) | the engine is actually halted at step `confirm` (kind `checkpoint`) with a well-formed **pending** decision and no subsequent step executed; both upstream checkpoints were resolved under the preregistered policy | upstream never reached BUILD (P2: 0/9) |
| R2 | artifact + provenance + readability + BUILD admissibility (correction 2) | the definition artifact produced by THIS run's `define-work` WI: (a) exists and is bound to that WI in storage; (b) is readable and parses via the existing definition-artifact parser; (c) resolves through `resolveDefinitionSource` as the execution WI's authoritative definition — integrity-pinned sha256 recorded, ≤ 131 072 bytes, fail-closed — i.e., it is admissible to BUILD context assembly by the existing machinery | fixture replay was supplying this in P3 |
| R3 | configuration at every actual request (correction 4) | `settings.json` sha == `5634b2e8…` verified at every step transition AND the resolved per-request parameters archived per call; file installed exactly once per campaign | `seed()` clobbered settings 10/10 P2 runs |
| R4 | budget on the wire | every archived upstream request carries `max_tokens` from the frozen per-step map (`workflow_max_tokens`) and frozen effort keys. **Wire mismatch = campaign-terminal procedure STOP** (`budget-wire-mismatch`), never a model-attributed NOT-READY (review ruling). Genuine exhaustion at the correct budget remains a NOT-READY | P2 transmitted 16384 everywhere, unverified |
| R5 | BUILD edit policy present (parameters only) | workflowParameters carry `allowedEditPaths`/`requiredEditPaths` over the worker file — verified as **parameters only**; never enforced upstream (correction 3) | — |
| R6 | wire integrity | every upstream turn — including single-turn review executions — archived by the guard (request+response, `wire_observation`); zero unarchived provider calls | P2's wire-capture gap |

Assessment object per attempt: `READY` / `NOT-READY` + class + evidence pointers. **BUILD is never executed**; the confirm decision stays pending. No byte-identity comparison with P3's fixture; no subjective content grading — every check is structural and objective.

## 4. P2 failure analysis → P4 preventions

| P2 observed failure (forensics §) | P4 measure |
|---|---|
| `seed()` unconditionally overwrote frozen settings at every instantiate — 10/10 runs degraded (§1.3) | clean-init reset clears workflow state/artifacts ONLY; settings installed once, never rewritten by any campaign path; state-time sha guard + per-request verification (R3) — drift = `CONFIG-DRIFT` STOP |
| 5/9 slot-consuming failures were max_tokens termini at the perturbed 16384 budget (§1.1) | budgets frozen per-step and verified on the wire (R4): mismatch → procedure STOP; genuine exhaustion at the correct budget → evaluable NOT-READY |
| budget never verified at request construction — silent divergence (§4) | resolved per-request parameters archived per call via the P3 guard capture, reused upstream |
| 100% single-upstream routing with accounting anomalies (§2–3) | provider recorded per response; anomalies = observations; censoring only per addendum-2 discipline (ambiguity NOT censored) |
| mid-campaign misclassification → out-of-protocol wf9r (§5) | classification rules preregistered; post-hoc reclassification requires operator ruling, never a silent extra attempt |

## 5. Configuration integrity (correction 4) and guard coverage (correction 3)

**Clean per-attempt initialization.** Settings are installed exactly once at campaign start (the full frozen file, `5634b2e8…`). The per-attempt reset initializes a clean attempt namespace — fresh run dir, fresh workflow state, no generated artifacts — and writes **nothing** else: it must not touch `.sle/settings.json` or any file outside the attempt's own namespace. The no-clobber property is enforced by an L1 code-inspection gate (no settings/`seed()` write exists in the campaign path) plus the state-time guard.

**No inheritance.** An attempt cannot see a prior attempt's artifacts or workflow state: each attempt runs in its own state namespace, and a per-attempt pre-flight state check verifies the namespace is empty before the first request.

**Two-layer guarding.**
- **State-time:** before each step, verify settings sha == pinned; archive the verification with the step record. Drift → `CONFIG-DRIFT` STOP (procedure class, consumes nothing).
- **Request-time:** the P3 `createConfigGuardProvider` composition wraps **every** provider call of both native workflows — produce/gather steps, checkpoint adjudication reads, and **single-turn review executions** (define-work's review, full-build's `critique`) — with per-step contracts derived from the frozen settings (per-step budget map + effort + the step's own declared tool surface in flat `{name, description, input_schema}` format and step-specific `submit_result` schema). Single-turn reviews pass through the same transport path and are captured identically (request+response pairing, `wire_observation`).

**Step-authorized output paths vs BUILD-only editPolicy (correction 3).** Upstream steps may legitimately write artifacts outside BUILD's `allowedEditPaths` (the definition artifact itself is the obvious case). Therefore:
- Each upstream step's authority = its **own** declared tool surface + submit schema + the attempt namespace. The guard enforces per-step contracts; it does NOT apply BUILD's editPolicy to upstream steps. The prior draft's "STOP on upstream writes outside BUILD's allowedEditPaths" is **removed**.
- BUILD's `allowedEditPaths`/`requiredEditPaths` apply only to BUILD, which never executes in P4; R5 verifies their correct presence as parameters for BUILD admissibility.
- The STOP rule becomes: any disk write outside the **union of the current step's authorized surface and the attempt namespace** (out-of-band writes) → campaign-terminal `AUTHORITY-BYPASS` STOP — the P1/P2 authority rule, correctly scoped per step.

## 6. Sampling (#2) — prospective, not result-chosen (unchanged, accepted)

- **Task:** the single pinned input `evidence/p3/inputs/issue-108.json` (`dd401472…`) — the same task P3 exercised, now WITHOUT replay. Fixed-task repetition measures delivery reliability; generalization across tasks is out of scope.
- **Sample size:** N = 3 fresh, clean-initialized attempts.
- **Success threshold:** ≥ 2/3 READY — accepted as an **engineering qualification only** (review ruling), not a scientific estimate.
- **Denominator:** every launched attempt is evaluable: `READY` or `NOT-READY(<class>)`. NOT-READY classes: `budget-exhaustion-upstream` (genuine length terminus at the correct frozen budget), `authority-invalid` (`resolveDefinitionSource` failure codes), `workflow-abandoned` (cap-hit halt / max-iterations), `malformed-state` (halted state or pending decision malformed; checkpoint policy refusal), `provider-error-unresolved`. Procedure classes consume nothing: `CONFIG-DRIFT` STOP, `budget-wire-mismatch` STOP, `AUTHORITY-BYPASS` STOP, transport re-queue (bounded at 3), guard evidence STOP, §10 crash recovery.
- **Stop rules (immediate, campaign-terminal):** `CONFIG-DRIFT`; `budget-wire-mismatch`; `AUTHORITY-BYPASS` (out-of-band writes, per §5 scoping); guard STOP (G1/G2 semantics inherited); evidence-archive failure.

## 7. Crash recovery (#6) — charter §10, unchanged

Ledger-driven resume implemented in the P4 runner before launch (declared here per §10.5): ledger = counting source of truth; `attempt-counted` slots **retained**; mid-flight at crash = **incomplete** (runtime capture archived under `interrupted-*`, never classified, consumes nothing); resume continues the original terminal condition; all orchestration logs under the campaign evidence dir from process start.

## 8. Evidence (#5) — unchanged in shape

Per-attempt package: `guard-capture.jsonl` (all upstream turns incl. single-turn reviews), `db-records.json` (both work items, definition artifact + authority rows, decisions, adjudications), `readiness-assessment.json` (R1–R6 object), `run-artifacts.tgz`, `evidence-manifest.json` (+ `package_sha256`). Campaign ledger events: `preflight`, `attempt`, `checkpoint-adjudication`, `readiness`, `attempt-counted`, `config-verification`, `transport-requeue`, `campaign-terminal`. Terminal campaign report in the P3 format.

## 9. L1 / L2 / L3 qualification — small plan preserved, gates updated

- **L1 (offline, scripted providers — zero traffic):** (a) READY path through the full two-WorkItem lifecycle with scripted upstream completions, halting at confirm; (b) each NOT-READY class induced synthetically and classified correctly (incl. `resolveDefinitionSource` failure codes → `authority-invalid`); (c) clean-init regression: reset touches neither settings nor foreign paths; per-attempt namespace isolation (prior-attempt artifacts invisible); (d) scripted request with drifted budget → `budget-wire-mismatch` STOP; (e) settings-clobber simulation → `CONFIG-DRIFT` STOP; (f) §10 kill-and-resume (retained slot preserved, incomplete discarded); (g) code-inspection gates: no settings write / no `seed()` in the campaign path; checkpoint adjudication is the determinate policy only.
- **L2 (real-provider, one round ≤ 6 calls, ops-qual namespace):** (a) one define-work-shaped and one full-build-upstream-shaped turn accepted at the frozen per-step budgets; (b) reasoning-burn calibration at 32768 (P2 hidden-burn anomaly); (c) upstream tool-surface capture verification incl. a single-turn review-shaped call.
- **L3:** the N=3 campaign under the frozen preregistration.

## 10. Scope control (#8) — unchanged

Reused unchanged: native workflow registry entries (`define-work`, `full-build`), engine + decision repos, `resolveDefinitionSource` and the definition-artifact parser, config-guard capture machinery, evidence packaging, campaign ledger + adjudicators, restoration, qualification patterns. New thin code: campaign lifecycle driver (launch both native workflows, create the execution WI with the `definitionSource` ref, adjudicate checkpoints per the fixed policy), the R1–R6 readiness-assessment function (pure), clean-init/reset + ledger-resume in the runner. **No new general-purpose framework; no changes to Stratum (`9f298f2`) or the frozen P3 artifacts.**

## 11. Cheapest compliant path — unchanged

L1 gates → one L2 round → L3 attempt 1 (first genuine upstream-to-BUILD-entry observation expected here) → complete N=3 → terminal report → STOP for results review.

## 12. Review rulings incorporated

1. ~~Open question: R4 violation STOP vs readiness-only~~ → **RESOLVED**: `budget-wire-mismatch` = campaign-terminal procedure STOP, never model-attributed NOT-READY.
2. ~~Open question: upstream step set~~ → **RESOLVED**: native `define-work` + `full-build` only; no custom upstream pipeline (§2).
3. ~~Open question: confirm pending vs composite endpoint~~ → **RESOLVED**: stop at confirm, decision pending, BUILD never executed (§3).
4. ~~Open question: N=3 fixed-task~~ → **RESOLVED**: accepted as engineering qualification only (§6).
5. Correction 3 applied: per-step output-path authority separated from BUILD-only editPolicy; the incorrect upstream-editPolicy STOP removed (§5).
