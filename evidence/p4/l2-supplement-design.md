# P4 L2-SUPPLEMENT DESIGN — the two wires L2 could not reach

**Status: DESIGN ONLY — NOT AUTHORIZED.** This document prepares a narrow
supplement; it authorizes nothing and ships no executable dialing code
(deliberately, after the L2 import incident — any supplement driver will be
import-safe and written only against an explicit operator GO). No additional
provider traffic is authorized by the freeze review.

## What the L2 round actually established

The surviving L2 round (invocation 2, `evidence/p4/l2-qualification/`) exercised
exactly one wire family with real traffic: the **define-work produce wire**
(`completeMultiTurn` on `synthesize-definition`, 6 real dials, guard PASS on
every request, real usage observed, 7th request refused pre-dial at the cap).
The real model spent its turns on repository investigation without submitting.
Two wire families were therefore **not reached** and remain unqualified:

- **W1 — structured-review wire** (`completeStructured` against the
  definition-readiness-review contracts, with real traffic).
- **W2 — full-build producer wires** (`scoping.produce` → `design` → `plan` →
  `test` multi-turn investigation loops, SLE-ARTIFACT materialization, and the
  full-build budget profile).

The L2 endpoint is **OPERATIONAL-CAP-STOP** — a preregistered procedure
endpoint, not a provider failure and not a P4 scientific result. That
conclusion is preserved unchanged; this supplement only completes wire
qualification.

## Non-negotiable design constraints

1. **Native-path derivation.** Every request must be produced by the actual
   native execution path: the frozen engine builtins (`define-work` /
   `full-build` workflows) driven through the same `runP4Attempt` machinery the
   campaign and L2 used, with the **published pins**
   (`evidence/p4/p4-step-shapes.json`) as the only step-shape source. No
   hand-authored prompts, no synthetic tool surfaces, no replayed requests.
2. **Pinned guarded provider.** The same composition as L2:
   `createLLMProvider(openrouter, frozen settings, sha-checked)` → P4 guarded
   transport (fail-closed request validation, full capture) → engine. Pinned
   model `z-ai/glm-5.3-flash`, pinned budgets, temperature 0.7.
3. **Bounded.** One invocation. Per-phase caps, enforced pre-dial by the same
   capped-transport pattern (the cap-refused request is captured, never
   dialed):
   - Phase W1: ≤ 4 real calls (real define-synthesis turns until the
     structured review is reached, plus ≤ 2 real review calls).
   - Phase W2: ≤ 6 real calls into the full-build producer.
   - Global supplement cap: ≤ 10 real calls. A cap-stop is a valid endpoint,
     reported as-is.
4. **Separate namespace.** `evidence/p4/l2-supplement/invocation-<ts>/` —
   unique, immutable run directories (never overwrite); no P4 trial counted;
   operational qualification only.
5. **Pre-dial discipline.** Attempt-0 offline verification (scripted provider
   through the real engine under pinned shapes → READY, R1–R6) before any
   dial; pre-dial traffic accounting = 0; provider identity + settings sha
   recorded; target pristine before and after.
6. **Stop rules.** Cap pre-dial refusal; guard STOP; authority-bypass;
   target-not-pristine; any evidence-integrity failure; no treatment
   adaptation of any kind (no retries, no prompt changes).
7. **Evidence.** Full P3-style packaging per attempt (`files.sha256.json` +
   `manifest.package_sha256` identity over DB records / readiness /
   upstream files / runs / authority / guard capture); report regenerated
   offline from the capture (`--report-only` pattern), with complete
   request/response/error pairing and usage observations.

## What "complete" means for the supplement

- W1: ≥ 1 real `completeStructured` request/response pair on a
  definition-readiness-review step, guard PASS, whose wire shape matches the
  pinned review shape — OR an honest cap-stop before the review is reached.
- W2: ≥ 1 real full-build producer multi-turn request reaching either
  SLE-ARTIFACT materialization (provenance-verified on disk) or an honest
  investigation-only cap-stop.
- Both reached and cap-stop outcomes are reportable results; only guard,
  safety, or evidence-integrity failures are failures. The frozen treatment is
  never adapted to reach either wire.

## Authorization

Execution requires a new, explicit operator GO naming this document. Absent
that, nothing dials.
