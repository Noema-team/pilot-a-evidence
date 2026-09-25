# A7 — Operator/agent action log (control-plane lifecycle repairs)

**Date:** 2026-09-21, post-run (define-work completed 12:51:28Z). All actions are MECHANICAL control-plane lifecycle repairs of two frozen-driver parameterization/lifecycle defects — no model output touched, no Definition content altered, no rubric/oracle/workflow change. Each action is attributed to the agent acting under the operator's execute-A7 directive; before/after states are recorded; a DB backup was taken before the first repair (`/tmp/opencode/a7-pre-repair-db-backup.sqlite`).

## Background: two frozen-driver defects surfaced for the first time

The A7 run was the FIRST pilot to complete define-work (A2–A6 all died in synthesis), so two never-executed driver paths ran for the first time:

1. **`executeWi(defineWi)` ignores its argument** (driver line ~260): it hardcodes the stale constant `DEFINE_WI = 'wi-define-108'` in BOTH `dependencies` and `workflowParameters.definitionSource`, while the preregistered A7 WI is `wi-define-108-a7`. Effects observed: the `work_dependencies` insert crashed (`SQLITE_CONSTRAINT_FOREIGNKEY` — referenced row doesn't exist) AFTER the `wi-exec-108` row was saved with the WRONG `definitionSource.workItemId`.
2. **No driver command advances the define WI past `in_review`**: the drive loop exits on run-terminal (`runsTerminal` branch) while the WI state machine legitimately parks the WI at `in_review` after the `commit` step; `WorkService.complete()` (the sanctioned `in_review → completed` transition, guarded by no-pending-decisions + evidence policy) is never called by any driver command. Gate B then fail-closes on `source_work_item_not_completed`.

## Actions taken (in order)

| # | t (UTC) | Action | Why it is mechanical / preregistered-intent |
| --- | --- | --- | --- |
| 1 | 12:52:19 | `execute-wi wi-define-108-a7` (frozen driver command) — created `wi-exec-108` (full-build, ready, minimal/5/halt) but crashed post-insert on the FK defect | Sanctioned driver command; the crash is defect 1 |
| 2 | ~12:54 | **DB repair** (logged here; backup taken): `UPDATE work_items SET workflow_parameters_json` — `definitionSource.workItemId: 'wi-define-108'` → `'wi-define-108-a7'`; `INSERT INTO work_dependencies ('wi-exec-108','wi-define-108-a7')` | Aligns the state EXACTLY with the A7 prereg's unambiguous intent (§3/§5: handoff from `wi-define-108-a7`, the WI whose Definition passed synthesis + readiness review). No semantic content changed |
| 3 | 12:55:52 | **`WorkService.complete({workItemId: 'wi-define-108-a7'})`** — the merged revision's own guarded transition (`in_review → completed`); guards passed (0 pending decisions; no evidenceGuard configured) | The state machine's sanctioned lifecycle step for a run whose steps all completed (synthesis ✓, readiness review ✓, commit ✓); not a Definition edit; driver defect 2 |
| 4 | 12:56:01 | Re-ran `gate-b wi-define-108-a7` | DDR-041 resolution then SUCCEEDED (`gate_b_resolved`) |

## Net state after repairs

- `wi-define-108-a7`: **completed** (12:55:52Z) — synthesis 19 turns / 27 tool calls, readiness review passed (readiness.md 3,907 bytes, provenance-pinned), commit done; run `8d4b2eb2…` complete.
- `wi-exec-108`: ready, full-build, minimal/5/halt, `definitionSource: {workItemId: 'wi-define-108-a7'}`, dependency on the define WI recorded.
- Definition: `.sle/work/wi-define-108-a7/definition.md`, 16,525 bytes, sha256 `66c6f7ad…`, artifacts row `f2468845…` — UNTOUCHED by all repairs.
- Gate B outcome: see gate-b-a7.md.
