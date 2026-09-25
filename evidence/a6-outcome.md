# Pilot A6 — Outcome Record

**Date:** 2026-09-21. **Work item:** `wi-define-108-a6`. **Workflow run:** `7e8fae84-8fb0-41d6-8096-d5e31121c357`.
**Execution revision:** `6f9e6c9f235c704eef3129ce689aa11c31e4e36f` (PR #30 merge commit). **Driver sha256:** `09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654` — verified identical pre-T0 and post-run.
**Closeout classification per the frozen prereg rules: NEW FAILURE CLASS — diagnosed independently; not attributable to any prior class.**

## Timeline (driver journal, UTC)

- 11:16:38 — seed `wi-define-108-a6` (4 acceptance criteria); mechanical pre-T0 action added `workflow_max_tokens {"define-work/synthesize-definition": 32768}` (logged in gate-a-a6.md).
- 11:19:10.478 — T0: `provider_resolved` (model z-ai/glm-5.3-flash, global maxTokens 16384 — expected; the 32768 override applies inside the runner per step).
- 11:19:10.508 → 11:33:32.373 — `synthesize-definition` ran: **9 turns, 16 tool calls, 14 m 22 s** (read_file ×9, list_directory ×7, turns 1–8; final drafting turn 9).
- 11:33:32.373 — node **complete**; Definition artifact written: `.sle/work/wi-define-108-a6/definition.md` (18,282 bytes, 275 lines, sha256 `b21665981f6e1ec503a3ad7a55046ca5c3856946b88b5e4556456c7b7d056efb`); D.1 provenance row recorded in the artifacts table (type `definition`, ref `definition:obj-108`, hash matches).
- 11:33:32.388 — step_execution `167ffb5a…` recorded **failed** with `adapter_exception`.
- 11:33:32.393 — `drive_terminal`: WI state **failed**; run row left `active` (engine died before run-status update).

## The experimental variable: DID IT WORK? — YES

A5 died at turn 19 on `stop_reason=max_tokens` with the 16,384 completion budget exhausted mid-generation. A6's single delta — define-work/synthesize-definition → 32,768, step-scoped — let the SAME step **complete**: 9 turns (vs 19), zero max_tokens stops, zero format-repair spirals, **first-try ACCEPTED submission** — `submit_result` accepted the 18,282-byte payload with **zero rejections** (loop.json contains no reject/invalid/defect records; E12 source/kind teaching passed its first live test: 10 repository-claim facts + 4 product-intent facts all carried valid `source`/`kind` vocabulary). The budget was not exhausted — the failure below is downstream of step success and independent of completion budgets. The step-scoping guarantee held (pre-T0 probe: readiness-review at 16384; it never even ran).

## The new failure class (first reached in six pilots)

After node success, the engine's post-step map sync — `engine.ts:589` → `updateArtifactEntries` (artifact-utils.ts:3) → `mapManager.update` → `RuntimeMapSchema.parse` of `.sle/map.yaml` (runtime-map.ts:353-355, read-path parse at :321) — **strictly parsed the map file for the first time** and rejected the frozen driver's seeded values (Zod, 2 issues, exactly):

```json
[
  {"received": "python", "code": "invalid_enum_value", "options": ["api","ui","library","research","custom"], "path": ["project","type"]},
  {"received": "sqlite", "code": "invalid_enum_value", "options": ["beads","local"], "path": ["task_store","type"]}
]
```

The adapter caught the ZodError → `failure code "adapter_exception"` → WI failed at 11:33:32.389Z (event `work.state_changed`, reason = the Zod issues).

**Root cause:** the frozen driver's `seed` has written `projectType: 'python'` and `taskStore: {type: 'sqlite'}` since A2 via `dumpYaml(createInitialMap({...} as never))` — the `as never` cast bypasses type-checking and the write performs **no schema validation**. Every A2–A5 run died inside synthesize-definition (transport / contract rejection / turn cap / budget), so the post-success map path never executed. A6's budget fix unlocked the first successful Definition synthesis in the series — and with it, the first execution of this path, surfacing a latent **seed/Stratum-schema contract mismatch** that predates A6.

**Why this is not the A6 delta:** the override affects only the completion budget on generation requests inside synthesize-definition (regression-proven). The failure occurs after that step returned success, on a schema-validation path that no budget value can influence.

## Milestones reached (first in the series)

1. synthesize-definition completed within the turn cap (9/24 turns).
2. First **accepted** submission through the real `submit_result` channel — the A3 contract-vocabulary failure class (`facts[n].kind`) did not recur; E12 teaching is now empirically validated.
3. First canonical Definition materialized with D.1 provenance: 14 facts (KNOWN/ASSUMED/UNKNOWN, sourced, evidence-referenced), 6 constraints (must/must_not/prefer/prefer_not), 6 requirements, 5 non-goals, 5 acceptance criteria (met:false, pre-execution), prose rationale sections. Content quality: fact references resolve to real paths (rag-worker-service/main.py ≈L1097, rag-api-service/main.py ≈L223-226, exceptions.py, test_api_contracts.py, observability-aggregator); it even detects the absent `plans/upload-flow.md` cited by the issue and quarantines the unavailable "D3 companion issue" as UNKNOWN rather than absorbing it.

## Unchanged / frozen-protocol status

- H1 progressed materially (Definition synthesized + materialized) but the **DDR-041 handoff remains untested**: the run died before definition-readiness-review could execute.
- Token usage: not persisted by the runner (same as A5); turns/tool-calls above are the authoritative activity record.
- Transport: clean (no headers timeouts observed; consistent with the A3–A5 72-call record).
- Operator actions: seed + mechanical settings override + probe + archive — all logged in gate-a-a6.md; budgets 2/3/2 unused (no escalations; run never reached a checkpoint).

## Decision required (operator)

The blocker is a two-value seed correction in the frozen driver (`projectType: 'python'` → schema-valid, e.g. `custom`; `taskStore type: 'sqlite'` → `local`) — mechanical and non-behavioral, but it changes the frozen driver hash, so it requires a new freeze + prereg addendum under the operator's change-control rules. Alternative (Stratum-side tolerance for legacy seeds) would loosen a fail-closed schema and is NOT recommended. Per the frozen closeout rules, A6 stops here; no fix has been applied.
