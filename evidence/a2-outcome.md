# Pilot A2 — Outcome Record (E9)

Closed: 2026-09-19. Preregistration: docs/pilots/pilot-a2.md @ stratum a4a1be5 (PR #25 merge).
Frozen inputs verified: stratum a4a1be5 ✓ · target 86ec087 ✓ · branch pilot-a/issue-108 ✓ ·
driver sha256 6095ffd90b64a5f0add544ab8cffa2fc0c6d4759c45f3de8b2e3dfe748c2a086 (verified pre-T0 AND post-run) ✓ ·
fresh .sle / fresh WI ids ✓ · Pilot A Definition never touched as input ✓.

## 1. Timing

- T0 (first model call of define-work dispatch): **2026-09-19T14:43:48Z**
- End (step execution terminal): **2026-09-19T14:54:02Z**
- Wall time: **10 min 14 s of the 120-minute budget.** Budget was NOT the binding constraint; the run ended by provider failure 5 min 1 s into the failing call. No budget pressure occurred.

## 2. Gates

- **Gate A: PASS** (evidence/gate-a-a2.md — all zero-model checks green, baselines 109 + 409).
- **Gate B: NOT REACHED** (define-work did not complete).
- **Gate C: NOT EXERCISED** (no natural halt of the authorized kind occurred; do-not-manufacture rule respected).

## 3. A1 — define-work reproduction: **NOT REPRODUCED (single authorized attempt)**

- WorkItem `wi-define-108-a2`, workflow run `3dd9cc22-97b8-46c9-9f5f-9873cae76d26`, step execution `0bf0d4b8-8bd9-4780-8fcb-302479a3f1a5`.
- The model worked productively for 15 completed turns (16th call failed): 24 tool calls — read rag-worker/rag-api main.py at turn 1, explored plans/, tests/, docs/, dev/, AGENTS.md, service models — then the turn-16 provider call failed.
- No contract submission was ever made: **zero** contract rejections, zero repair attempts (`format_repairs: 0`, `result_repairs: 0`), so **no rejected-result evidence exists for this run** (nothing to preserve; the instrumentation would have captured it).
- Exact failure (captured by the PR #25 instrumentation in `synthesize-definition-loop.json`):

```json
{
  "duration_ms": 301237,
  "error_name": "TypeError",
  "cause_name": "HeadersTimeoutError",
  "cause_code": "UND_ERR_HEADERS_TIMEOUT",
  "cause_message": "Headers Timeout Error"
}
```

- Step-level DB error string remains coarse (`workflow_error: LLM call failed: fetch failed`) — the precision gap between the two records is exactly what the E7 extraction flagged, now closed by the loop-level record.

## 4. Diagnosis

**The Pilot A transport-failure class is now precisely diagnosed: the Z.ai Coding Plan gateway's ~300 s headers timeout kills long-conversation generation calls.** This run: 301,237 ms ≈ undici's 300 s HeadersTimeout. Same class as Pilot A r1 (turn 14) and r4 (turn 16); now with cause. This is a provider-route property, not a Stratum defect. Per prereg, no retries were added during A2; per the operator's recorded conditional, **bounded provider retry for long-conversation calls is now formally justified for a successor experiment** (cause metadata in hand: long-context request → gateway headers timeout).

## 5. H1 / H2 / H3: NOT REACHED

No Definition artifact (artifacts table: 0 rows), so no DDR-041 handoff, no execution dispatch, no delivery. `wi-exec-108-a2` was never created (its precondition never materialized).

## 6. Human Decisions and operator actions

- Semantic human Decisions: **0 of 2** (none requested).
- Operator actions (all routine mechanical, logged): launch dispatch, monitor, copy run artifacts to evidence, verify driver hash post-run. No target-code edits (worktree clean except `.sle/`), no Stratum changes, no frozen-input changes.

## 7. Integrity

- Driver hash re-verified after run end: exact match (6095ffd9…48c2a086). No post-T0 changes.
- Neither `main` moved; ordinary checkouts untouched; target branch pilot-a/issue-108 unchanged (86ec087).
- 0 mid-run changes to any frozen field.

## 8. Overall classification: **DIAGNOSED FAILURE**

Exact cause: provider-route headers timeout on a long-conversation call, at turn 16 of define-work, with no retries authorized. Positive sub-results preserved:

1. **Provider-failure diagnosis: complete.** The three-run failure class (Pilot A r1/r4 + A2) is a single reproducible phenomenon — Z.ai Coding Plan gateway headers timeout (~300 s) on long-generation calls — with captured cause metadata as evidence.
2. **Corrected harness fully functional.** Gate A passed; seed → map bootstrap → scheduler dispatch → 10-minute uninterrupted multi-turn conversation → run-artifact persistence all worked with zero operator intervention. The Pilot A attempt-2 harness crash class did not recur.
3. **Observability delta validated in production conditions.** The PR #25 transport_failure record captured in a real run precisely what Pilot A could not record.

## 9. Evidence index (a2- prefix)

- gate-a-a2.md · a2-define-drive.log · a2-run-journal.jsonl · a2-step-executions.json · a2-runs/3dd9cc22…/ (manifest, node-outputs incl. synthesize-definition-loop.json with transport_failure) · pilot-a-sle-archive.tgz (Pilot A state, evidence-only)

## 10. Next-action owner

**Operator.** Decision required: authorize a successor experiment with bounded provider retry (e.g., resume-on-headers-timeout with a small retry budget on the same route, or an alternate route) — preregistered before execution, as A2 was. No Stratum patches until A2 evidence is reviewed, per E9 §10.
