# P4 DESIGN DRAFT — Autonomous Upstream Reliability

**Status:** DRAFT v3.2 — L2 operational round EXECUTED (OPERATIONAL-CAP-STOP, honestly reported); all three pre-freeze corrections implemented + proven (L1-r3 24/24). STOPPED for independent scientific-freeze review. §13 v3 as-built · §14 r2 corrections · §15 L2 round + r3 pre-freeze corrections.
**Directive:** operator conditional implementation GO (final architecture review): implement + L1 offline qualification only; STOP before L2 provider traffic, freeze, or L3.
**Predecessor evidence:** P2 forensics, P3 closeout, charter v1.1. Review rulings + four binding corrections applied and BUILT (§13).

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

---

## 13. AS-BUILT IMPLEMENTATION + L1 QUALIFICATION EVIDENCE (v3 addition)

Implementation modules (evidence/p4/, campaign tooling only; stratum 9f298f2 and all P3 artifacts byte-unchanged):

| Module | Role |
|---|---|
| `p4-transport-guard.mts` | correction 1 — guarded capture on ALL THREE native wires (`completeMultiTurn`, `complete`, `completeStructured`); per-call settings sha re-verification (R3 at request granularity); response/error provenance per wire's ACTUAL result shape (no fabricated streaming metadata on the single-turn wires — `wire_observation: null` recorded as fact); fail-closed archival-before-verdict; capture v3 records are `classifyGuardCapture`-compatible (P3 classifier + G1/G2 reused unchanged) |
| `p4-step-contracts.mts` | fail-closed frozen-settings derivation (budget/effort per `workflowId/stepId`, STRICTER than the engine: the campaign refuses to run under an unparsable frozen map); pinned per-step request-shape table (`p4-step-shapes.json`) observed on the production path (charter §5 calibration-over-constants); unknown steps fail closed |
| `p4-readiness.mts` | corrections 2+3 — the PURE R1–R6 assessor: halted-at-confirm state, definition chain (provenance sha, disk bytes, final readiness verdict PASS, no HUMAN_DECISION/EXPLORE_AS_WORK artifacts, `resolveDefinitionSource` admissibility), settings/budget re-verification FROM THE CAPTURE, edit policy as parameters only, wire integrity |
| `p4-campaign.mts` | the lifecycle driver: clean per-attempt init (fresh `.sle`, frozen settings installed exactly once — the module's ONLY settings write), real define-work → WorkService-complete handoff gated on the final readiness verdict (never synthetic approval of unresolved human questions) → execution WI with `definitionSource` → full-build to the confirm boundary; determinate checkpoint policy; capture-derived G1/G2 campaign-terminal STOPs; §10 ledger + resume (orphaned launches declared incomplete by the resuming process; interrupted runtime archived; worktree restored); evidence packages (capture + db export incl. step failures/events + readiness assessment + artifacts + self-verifying manifest) |
| `p4-l1-qualifier.mts` + `p4-l1-resume-child.mts` | the 14 offline gates below — scripted providers through the REAL engine, zero network traffic |

### L1 qualification — 14/14 PASS (`p4-l1-qualification-output.txt`, 2026-10-11T13:51:55Z)

- **A.calibration (+human/explore route legs)** — observed production request shapes for 8 steps pinned from real engine runs (`p4-step-shapes.json`); frozen model/budget/effort enforced even in calibration mode.
- **A.ready-path** — READY at the confirm boundary under PINNED shapes; R1–R6 all pass; wires exercised: `completeMultiTurn` + `completeStructured` (the review wire).
- **B.isolation** — correction 4: second attempt sees a fresh DB (only its own 2 work-item rows), pristine worktree before/after, frozen settings constant.
- **C.config-drift-stop** — the EXACT P2 `seed()` output written mid-attempt → per-call settings re-verification fails closed (response unarchivable → G2) → campaign-terminal STOP with the settings violation in the step failure evidence.
- **C2.budget-wire-stop** — a P2-shaped request (16384 vs frozen 32768 for full-build/design) refused BEFORE the model call.
- **D.unpinned-shape-stop** — wrong pinned tool surface → guard STOP, zero model calls reached.
- **F1** — genuine length terminus at the CORRECT budget → evaluable NOT-READY `budget-exhaustion-upstream` (never censored, never a STOP).
- **F2** — HUMAN_DECISION route: the run halts at `human-decision-checkpoint`, the decision row stays PENDING, attempt = NOT-READY `definition-human-decision-required`. NO synthetic approval.
- **F3** — EXPLORE_AS_WORK route: the committed definition via the explore route does NOT qualify — handoff gate refuses, NOT-READY `definition-exploration-required` (the final readiness outcome is verified, not merely parse+resolve).
- **F4** — disk-corrupted definition after commit → provenance/disk-integrity/admissibility fail closed (`authority-invalid`, R2 false).
- **G.kill-and-resume** — a REAL `SIGKILL` mid-attempt (child process) → the resume declares the orphaned launch INCOMPLETE from the ledger, archives the interrupted runtime, restores the worktree, and completes the terminal condition (ready=2/2, retained slots preserved).
- **H.code-inspection** — exactly ONE settings write in the campaign path (init); BUILD is never dispatched.

### As-built decisions recorded for review

1. **Handoff completion act**: the engine leaves the define WI `in_review`; the campaign completes it via the existing `WorkService.complete` transition (the production control-plane act) — gated mechanically on the final readiness verdict PASS + no HUMAN_DECISION/EXPLORE artifacts + no pending decisions. `resolveDefinitionSource` then enforces `source_work_item_not_completed` fail-closure against any attempt to skip the gate.
2. **Guard STOPs surface inside engine step-catch**: a mid-step guard violation becomes a step failure (engine behavior, unchanged). The campaign therefore derives campaign-terminal STOPs from the CAPTURE (any G1 STOP record or G2 integrity failure), wherever they surfaced — never from the exception path alone.
3. **Pinned shapes** are L1-observed production shapes, not assumptions; the L2/L3 contracts load the committed `p4-step-shapes.json`.

---

## 14. R2 — IMPLEMENTATION-REVIEW CORRECTIONS (v3.1 addition)

The implementation review held L1 for four targeted corrections; all are now BUILT and the full L1 suite re-run (additive: `l1-qualification/` from the first run is preserved untouched; r2 evidence in `l1-qualification-r2/`, output `p4-l1-qualification-output-r2.txt`).

### P1 corrections, as built

1. **Readiness — required native BUILD inputs.** `assembleReadinessInput` no longer guesses artifact types: the REQUIRED set is derived from the frozen full-build definition — the `cycle-charter` row (exact ref `doc:cycle-charter`), `produced-file` rows for `docs/requirements.md` + `docs/architecture.md` (design), `docs/plan.md` + `docs/test-plan.md` (plan), and ≥1 `produced-file:test:` row under `apps/ai-server/tests/`. Each is verified against its EXACT storage row (type+ref), row hash == disk sha256, non-empty file; a required output with no row can never pass silently. Missing AND corrupted artifacts fail closed as `build-inputs-incomplete`, naming the path (gates `E2.missing-artifact`, `E2.corrupted-artifact`).
2. **Recovery — durable count reconstruction.** `runP4Campaign` now reconstructs counted slots FROM THE LEDGER (`reconstructCountedSlots`) with unique per-launch `launchId`s; the terminal condition is evaluated over the durable count BEFORE any new launch (a satisfied campaign never executes beyond N); procedure-class STOPPED is sticky across resumes. Gate `G` proves the exact demanded scenario: REAL SIGKILL after slot 1 counted, crash during slot 2 → resume reconstructs slot 1 (counted exactly once, package byte-identical), declares slot 2 incomplete, completes `ready=2/2` with counted indexes `[1,3]`.
3. **Evidence — full-package hash binding.** ArchiveAttempt now packages and hash-binds EVERYTHING: DB records, readiness assessment, upstream files (derived from storage rows, including test outputs), runtime artifacts (`.sle/runs`), authority-violation bytes, capture, definition/readiness. `files.sha256.json` binds each file; `manifest.package_sha256` = sha256 over the canonical sorted file-hash map IS the package identity; the archive self-verifies at birth and `verifyEvidencePackage` independently re-verifies. Gate `T` flips one byte in a COPY and the verifier names the file.
4. **Authority — AUTHORITY-BYPASS STOP.** Per-step worktree write authorization is derived from the frozen workflow definitions (define-work: `.sle/` only; full-build steps: declared `outputArtifact`/`authorizedOutputs`, prefix entries for directories), enforced at the stepRunner seam via before/after `git status --porcelain -uall` deltas. An out-of-policy write STOPs the campaign (`authority-bypass`), and the violating bytes are archived INSIDE the package BEFORE worktree cleanup (gate `AUTH`: `docs/rogue.md` authored inside design → STOPPED, `authority-violations/docs/rogue.md` in the package, worktree pristine afterwards).

### Secondary corrections

- **Route-shape coverage without wire weakening:** the refine-definition route (a full READY attempt through a second native route) and the human-resolution chain (`apply-human-decision` + `post-human-readiness-review`, driven by a SCRIPTED HUMAN OPERATOR resolving through the real ResumeService — a role the campaign itself never takes; the handoff gate still refuses on the decision-request artifact) are now calibrated; 10 shapes pinned, every call in every leg guard-validated.
- **R1 asserts the actual state:** exec run `status=halted`, cursor `confirm`, `awaiting_checkpoint=confirm`, exactly ONE pending decision whose `subjectRef.stepId === 'confirm'`, zero boundary refusals, zero BUILD requests, intermediates policy-conform.
- **Settings installation reconciled (prereg v3.1):** per attempt `.sle` is wiped and the frozen settings bytes are installed exactly once at init; the guard verifies the sha at construction and at EVERY captured request; never rewritten mid-attempt.

### L1-r2 result — 20/20 gates PASS (2026-10-11T16:36:13Z)

H · A.calibration (+refine-route, human-route, explore-route, human-resolution legs) · A.ready-path · B.isolation · C.config-drift-stop · C2.budget-wire-stop · D.unpinned-shape-stop · E2.missing-artifact · E2.corrupted-artifact · F1 · F2 · F3 · F4 · T.post-archive-tamper · AUTH.authority-bypass-stop · G.kill-and-resume.

stratum 9f298f2 and all P3 artifacts remain byte-unchanged; the target worktree is pristine after qualification.

---

## 15. L2 OPERATIONAL ROUND + r3 PRE-FREEZE CORRECTIONS (v3.2 addition)

### L2 — one bounded real-provider round (operator GO; max 6 calls)

Evidence namespace: `evidence/p4/l2-qualification/` (separate; NO P4 trial counted). Pre-dial: the executable request-construction path verified OFFLINE (attempt-0: scripted provider through the real engine under pinned shapes → READY, R1–R6 all pass) + provider identity + pre-dial accounting (realCalls=0).

**Result: OPERATIONAL-CAP-STOP** — reported as-is:
- 6 real dials, all on the **define-work produce wire** (`completeMultiTurn`, `synthesize-definition`); every request guard-validated against the frozen contract; real usage observed (tokens 4857 → 11321, `stop_reason=tool_use`); the transport, request shapes, and budget map behaved exactly as qualified offline.
- The real model spent all 6 turns in repository **investigation without submitting** the definition; the **7th request was captured and refused pre-dial** (traffic cap). The structured-review and upstream-producer wires were therefore NOT reached in this round. (Real produce steps run 16–20-turn investigation loops per P1-R history — the cap landing mid-define is consistent with that profile.)
- The frozen treatment was **never adapted**: no retries, no prompt changes, single round.

**Disclosed execution incident:** the L2 module self-executes on import; an import-based syntax check inadvertently ran a first full round before the intended invocation, and the second invocation's `rmSync` overwrote the first round's evidence directory. The surviving complete evidence is the second invocation; total real dials across both invocations exceeded the single-round intent (~12–14, each round within its 6-call cap, all guard-captured at the time). No third round was run. Recorded in `l2-report.json.execution_incident`.

### r3 — the three pre-freeze corrections (offline, all proven)

1. **Unauthorized rewrites of already-dirty paths + exception paths** — the per-step authority check now uses BEFORE/AFTER CONTENT IDENTITIES: new paths, rewrites of already-dirty paths (content sha changed), and deletions, each authorized only per the frozen workflow definitions; the stepRunner seam runs the check on success AND exception paths (violations recorded; the original error still propagates; the attempt-level stop derives from the recorded violations). Gates `AUTH2.dirty-rewrite-stop` + `AUTHEXC.exception-path-stop` PASS. Documented layering: the engine's role ceilings already drop unauthorized doc sections (layer 1); the campaign check is the backstop.
2. **Remaining native definition routes** — the DEFER route is calibrated end-to-end (`apply-deferred-gaps` → `post-defer-readiness-review` → READY through legitimate native defer semantics), and the human-resolution chain now submits the NARROW `DecisionApplicationProposal` so `apply-human-decision` → `post-human-readiness-review` is genuinely reached (the deterministic contract, not the model, performs the ledger transition). 13 shapes pinned; no tool authority broadened.
3. **Retained identities + conflicting counts** — `reconstructCountedSlots` verifies each retained counted slot's package identity (manifest `package_sha256` vs ledger entry, full package verification) and rejects duplicate counted indexes; any conflict is a fail-closed `LEDGER-CONFLICT` stop — the resume never launches on disputed evidence. Gate `G2.ledger-conflict-rejection` PASS.

### L1-r3 — 24/24 gates PASS

`evidence/p4/l1-qualification-output-r3.txt`; packages in `l1-qualification-r3/`; prior evidence (r1 14/14, r2 20/20) preserved untouched.

stratum 9f298f2 and all P3 artifacts remain byte-unchanged; the target worktree is pristine.
