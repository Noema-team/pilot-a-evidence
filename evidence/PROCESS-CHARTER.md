# EVALUATION PROCESS CHARTER — pilot-a / stratum experiment program

**Version:** 1.1 · **Adopted:** 2026-10-10 (v1.0); v1.1 adds §10 (crash-recovery policy, P3 closeout review) and updates §9 priority · **Authority:** operator ratification via journal · **Applies to:** all experiments from P4 onward, and all reviews immediately

---

## 1. Purpose and motivation

The program's objective is **empirical**: determine whether the Stratum engine can reliably produce and publish code changes under a real LLM with trustworthy supervision. The verification apparatus exists to make that evidence *trustworthy* — never as a substitute for obtaining it.

The P2–P3 experience exposed two systemic failure modes:

| Cycle | Machinery outcome | Empirical outcome |
| --- | --- | --- |
| P1-R | machinery qualified | **1/3 BUILD publications measured** (last real datum) |
| P2 | 9-workflow campaign executed cleanly | 0 BUILD opportunities (upstream fragility + config clobber) |
| P3 offline | 16/16 + 7 + 10 gates PASS | 0 real-model observations |
| P3 live | preflight STOP executed flawlessly | 0 attempts — 16-token probe structurally unreachable |

**Failure mode 1 — the empirical gap.** Every offline layer passed while the single live-dialed artifact (the preflight probe) had never been exercised against the real model before becoming load-bearing. Deterministic mocks cannot establish empirical properties (reasoning-token costs, completion viability, anchor comprehension).

**Failure mode 2 — coupling.** Operational readiness, protocol correctness, and scientific evaluation were fused into one instrument with one failure semantics. A readiness check's job is to be *cheap to pass and informative to fail*; ours was a strict generative test under scientific STOP rules, so its design defect terminated an entire campaign at maximum cost.

**Nuance to retain:** the machinery never blocked valid evidence — it refused to *certify* invalid evidence (P2's clobbered configuration would have measured nothing; transport-censoring and evidence-durability rules answered *observed* failure classes). The defect was proportionality, not rigor itself.

## 2. Non-negotiables (unchanged)

1. Fail-closed STOP semantics: ambiguity is never censored; STOPs terminate immediately and are reported, never retried unilaterally.
2. Frozen scientific protocol: BUILD treatment, authority rules, model regime, outcome definitions, and denominator rules freeze before execution and never change mid-campaign.
3. Evidence discipline: durable, hash-addressed, operator-visible records for every dial, decision, and termination.
4. **Engineering traffic is never counted toward any experimental denominator.** Not toward evaluable attempts, re-queues, or stop conditions.

## 3. Three test layers — never conflate them

| Layer | Establishes | Methods | May answer questions about |
| --- | --- | --- | --- |
| **L1 deterministic** | the code obeys the protocol | unit + integration with scripted providers, fixtures, replay | guard rules, classification, hashing, restoration, accounting |
| **L2 operational (real-provider)** | the external model can operate under the chosen conditions | small-N authorized live smoke tests; parameter calibration | connectivity, contract acceptance, completion viability, budget reachability |
| **L3 scientific (frozen)** | does the model succeed under the frozen protocol | the registered experiment | the hypothesis, and nothing else |

**Rules:**
- L1 passing **never** implies L2 viability; L2 viability **never** implies L3 success. No report may present one as another.
- Any artifact that will dial live traffic under L3 rules (probes, contracts, budgets) must have its *empirically sensitive parameters* validated at L2 **before** freezing (see §5).
- L2 evidence is kept in a separate namespace (`evidence/ops-qual/`) with its own journal entries, never merged into campaign evidence.

## 4. Standing engineering-traffic authorization class *(operator ratification required)*

Structural cause of the empirical gap: live contact required campaign-scale ceremony, so live-dialed artifacts were untested until GO. Fix: a **standing, pre-authorized class of engineering traffic** so L2 validation is cheap by design.

**Proposed defaults (ratify or amend by reply):**
- Scope: provider smoke tests, probe-budget calibration, contract acceptance checks — **never** BUILD-entry attempts or any L3 measured step.
- Cap: ≤ 10 completion calls and ≤ 100k total tokens per qualification round; each round journaled *before* dialing with its purpose and expected calls.
- Evidence: full captures archived under `evidence/ops-qual/`, hashes journaled; findings cited in freeze bindings.
- Hard rule: any dial that would measure the hypothesis converts it to L3 rules or is aborted.

With this class, the P3 probe-budget defect would have been discovered in one 16-token call at L2 for ~$0.00 — before freezing, not after a campaign STOP.

## 5. Parameter discipline — calibration over constants

1. **Never freeze a hand-picked LLM behavioral parameter** (token budgets, timeout floors, retry counts) without either (a) L2 calibration data at the frozen effort setting, or (b) an explicit margin argument against measured behavior recorded in the binding.
2. **Reasoning-aware budget accounting:** in this API family `max_tokens` is shared between the reasoning channel and visible output. Budgets are specified as `reasoning_headroom + visible_target`; headroom is a per-regime parameter derived from L2 data (P99 observed × 3–5).
3. **Regime registry (forward-looking):** model + effort + temperature + budgets + observed reasoning statistics pinned as one hash-addressed regime object; probe parameters derive from the registry, never from isolated constants.
4. **`finish_reason` as typed data:** normalized at the provider layer into a first-class result enum; each consumer (preflight, build loop, retry policy) interprets it explicitly and separately testably.

## 6. Review discipline — every major review answers two questions separately

1. **Is the implementation correct?** (does it match its specification)
2. **Is this the right thing to implement?** (is the specification fit for the empirical purpose)

Passing the first does not imply passing the second. A review that answers only (1) is incomplete and should be returned as such.

**Marginal-value gate:** every proposed new gate, guard, or freeze revision must state (a) the specific observed (not hypothetical) risk it prevents, and (b) its cost in delayed empirical feedback. Hypothetical edge cases without an observed failure class are recorded as known limitations, not blocking findings. Rigor is applied proportionally to what can invalidate the measurement.

## 7. Experiment lifecycle — declare the empirical target

Before an experiment is frozen, its registration must state:
- the **empirical target**: the specific real-model observation this cycle exists to obtain (e.g., "≥1 BUILD submission observed, classified");
- the **cheapest compliant path** to that target (fewest L1 artifacts between authorization and the first L3 attempt);
- which L2 validations were performed on every live-dialed artifact, with citations.

A cycle that terminates without obtaining (or being blocked from obtaining) its empirical target must report that as the *primary* outcome — machinery results are secondary.

## 8. Adoption

- **Immediate:** §3 separation rules, §6 review discipline (including the pending freeze-5 re-launch review), §7 declaration requirements, §2 and §5.
- **Pending operator ratification:** §4 standing engineering-traffic class (defaults above; effective on the operator's reply).
- **Scope:** P3 recovery remains narrow (freeze-5 probe-budget amendment only; no BUILD changes); this charter governs process from the P3 re-launch review onward and all subsequent experiments (P4+).
- **Codified from:** the P3 live terminal review discussion (2026-10-10) — external critique (empirical gap, coupling, metric drift, two-question rule) reconciled with implementer assessment (machinery certifies rather than blocks; observed vs hypothetical risks; standing-traffic class as the structural fix).

## 9. Priority statement

P3 is CLOSED (SUPPORTED — QUALIFIED; see `evidence/p3/p3-closeout.json`). The next objective is **P4: upstream reliability** — whether the upstream workflow can consistently deliver a valid BUILD entry *without* the deterministic fixture replay, directly addressing P2's largest unresolved failure. Infrastructure work yields to that objective until the first upstream-to-BUILD observation is obtained.

## 10. Crash-recovery policy (v1.1 — P3 closeout review)

Codified from the p3-live-run-2 operational interruption and its review ruling (an unplanned full restart is a scientific-procedure deviation even when it hides nothing). Prospective rules for every future campaign:

1. **Durable orchestration logs.** All orchestrator/console output is written under the campaign evidence directory from process start — never under `/tmp` or any cleaned location. A lost log is a protocol defect.
2. **The ledger is the source of truth for what counts.** An attempt with an `attempt-counted` ledger event is **retained** across any interruption: it is never re-executed, never re-classified, and never double-counted.
3. **Mid-flight attempts are declared `incomplete`.** If the orchestrator dies before an attempt's classification event, that attempt is archived for forensics, declared incomplete, and consumes NO slot — regardless of how far it progressed.
4. **Resume, don't restart.** A interrupted campaign resumes from its ledger: the campaign continues its original terminal condition (e.g., until 3 evaluable) with the retained slots carried forward. A full sample restart after an interruption is a registered protocol deviation and must be disclosed as a qualification on the result (as P3's restart now permanently is).
5. **Resume support is a preregistration item.** Any campaign whose runner lacks ledger-driven resume must say so in its preregistration, together with the rule that will apply if the orchestrator dies (so the recovery path is chosen *before* the interruption, not after).
