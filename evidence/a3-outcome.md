# Pilot A3 — Outcome Record (E12)

Closed: 2026-09-20. Preregistration: docs/pilots/pilot-a3.md @ stratum ab92129 (amended E11, merged).
Frozen inputs verified: stratum ab92129 ✓ · target 86ec087 (branch pilot-a/issue-108) ✓ ·
driver sha256 09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654 (pre-T0 AND post-run) ✓ ·
OpenRouter route z-ai/glm-5.3-flash ✓ · fresh .sle / fresh WI ids ✓ · no prior Definition used as input ✓.

## 1. Timing

- T0 (first model call): **2026-09-20T15:15:55Z** · terminal: **15:36:27Z** · wall: **20 min 32 s of 120**.
- Budget NOT the binding constraint. The step ran 1,231 s across 16 provider calls with ZERO transport failures.

## 2. Gates

- **Gate A: PASS** (gate-a-a3.md — incl. preregistered OpenRouter reachability probe: HTTP 200, clean completion at max_tokens 512; baselines 109 + 409).
- **Gate B: NOT REACHED** (define-work did not produce an accepted Definition).
- **Gate C: NOT EXERCISED** (no natural halt of the authorized kind; do-not-manufacture rule respected).

## 3. A1 — define-work reproduction: **NOT REPRODUCED** (closest attempt of the series; new failure class)

Workflow run `a1291db0-c410-4b11-921a-24ff59b35fef`, step execution `e9e69433…`, WorkItem `wi-define-108-a3`.

- 16 turns, 28 tool calls — the deepest investigation of the series (worker/api mains, subscribers, plans, tests layout).
- The model reached the **submit-result channel** (contract negotiated, tool offered with the real schema projection) and SUBMITTED a **15,550-byte canonical Definition proposal**.
- **The A2 bottleneck did not recur: zero transport failures, zero retries consumed** across 16 long-conversation calls on the OpenRouter route (A2 died at turn 16 on a headers timeout after 301 s).
- The submission was **rejected by the semantic contract on exactly one defect**: `facts[13].kind: 'artifact'` — invalid enum value, expected `'product-intent' | 'repository-claim'` (argument_bytes 15,550; repair instruction as issued).
- The 1/1 repair resubmitted; the resubmission was **also rejected** (enum conformance again) → repair exhausted → fail closed at turn 16.
- **The normalized rejected semantic payload was preserved by the PR #25 instrumentation** (the exact evidence A2's attempt-5 lost): 15,550 bytes, sha256 `5072e641cd62a2f4…`, sibling `synthesize-definition-rejected-result.json`, bounded `rejected_result` in `-loop.json`.

## 4. Diagnosis

The bottleneck has MOVED. Transport (A2) → **contract vocabulary conformance under repair (A3)**. The model's proposal is substantively correct — goal accurately restates #108's mismatch; design notes correctly derive worker-side alignment from the acceptance criteria, the dual rag-api sinks, `ResourceResponse` exposure, and the stale-lease sweeper's persisted vocabulary — but it invented fact-kind `'artifact'` outside the enum `{product-intent, repository-claim}` and repeated the violation on the single repair. One vocabulary slip in 15,550 otherwise-contract-shaped bytes, with repair budget 1, is fatal under fail-closed semantics.

This is a Stratum-observed failure (contract strictness × repair budget), not a provider failure. It is exactly the class the prereg's repair-budget "insufficient evidence to change" note anticipated: A2 said 1 repair had insufficient evidence; A3 demonstrates a case where 1 repair was spent on a single-fault near-miss.

## 5. H1 / H2 / H3: NOT REACHED

0 artifacts (no accepted Definition → no DDR-041 handoff, no execution dispatch, no delivery). `wi-exec-108-a3` never created.

## 6. Human Decisions and operator actions

- Semantic Decisions: **0 of 2** (none requested). Operator actions: mechanical only (launch, monitor, evidence copy, hash verification).
- Zero target-code changes; zero Stratum changes after T0; neither main moved; 0 frozen-field changes.

## 7. Overall classification: **DIAGNOSED FAILURE** — with the strongest positive sub-results of the series

1. **DDR-041's synthesize→submit channel works end-to-end for the first time live**: negotiation, tool offer with the real projection, submission, contract decode/validate, bounded rejection delivery, repair, and exhaustion all executed exactly as designed (D.34 semantics verified in production conditions).
2. **The A2 failure class is resolved in the combined configuration**: OpenRouter route + the system as-frozen completed 16 long-conversation calls with zero headers timeouts (A2: died at 300 s on call 16). Transport is no longer the bottleneck. (Confounded with the route change — recorded per prereg.)
3. **The evidence path is complete**: rejected payload preserved byte-exact with bounded observation — the exact gap A2's evidence review identified, now proven live.
4. **The near-miss is precise and actionable**: a single fact-kind vocabulary violation, twice, is the entire gap between this run and Gate B.

## 8. Evidence index (a3- prefix)

gate-a-a3.md · a3-define-drive.log · a3-run-journal.jsonl · a3-step-executions.json · a3-runs/a1291db0…/ (manifest, synthesize-definition-loop.json with rejected_result, synthesize-definition-rejected-result.json payload) · pilot-a2-sle-archive.tgz

## 9. Next-action owner

**Operator.** The demonstrated bottleneck is contract-vocabulary conformance under a 1-repair budget. Candidate successor levers (preregister, do not improvise): (a) raise MAX_RESULT_REPAIRS for define-work (A2+A3 now provide the evidence the "insufficient evidence to change" note required); (b) strengthen the schema teaching with an exhaustive fact-kind enumeration example; (c) both. Transport needs no further work on current evidence.
