# Pilot A8 — Outcome Record

**Date:** 2026-09-21. T0 14:31:55Z · define-work terminal 14:39:56Z · Gate B PASS 14:40:32Z · full-build scoping ran ~14:42–15:05 · halted at scoping.checkpoint (preserved).
**Execution revision:** `4161ddf488be738408eaa3efb4af8220ee1258ad` (PR #33; includes PR #32).
**Driver:** frozen `baa18ac7…` for the define-work phase; completed E17 executeWi correction applied mid-protocol after a latent patch failure was caught → `d9d699c2…` (deviation logged in operator-actions-a8.md; A9 must freeze the new hash).
**Classification:** DIAGNOSED FAILURE inside full-build — at the scoping publication seam. **H1 CROSSED for the first time in the series** (clean autonomous define-work + Gate B PASS + real full-build execution begun).

## What A8 proved

1. **Clean autonomous define-work chain (the A7 caveat, cleared):** synthesis → readiness PASS → commit → **`wi_completed_by_driver`** — the guarded lifecycle completed by the fixed driver with ZERO operator intervention. 8 minutes wall; definition 16,913 bytes, sha `71f1c39c…`, provenance-pinned; first-try accepted submission (3rd consecutive — the contract/teaching layer is now stable across runs).
2. **Gate B PASS:** DDR-041 resolution + hash pin + context probe `token_count 4213 / hard_ceiling 4000 / includes_definition true` — the PR #32 two-lane invariant carried a real Definition past the boundary that terminated A7.
3. **full-build entry + first real model calls:** scoping.produce executed live (past the deterministically-qualified entry boundary), producing a substantive 12,426-byte cycle charter (scope locked to `rag-worker-service/main.py` `process_document`; rag-api explicitly unchanged; claim-vs-tree verification table; test seam identified) — all bounded by the authoritative Definition.
4. **Deterministic resume-path seam found and preserved:** scoping.checkpoint raised the confirm decision; on resolve, `ScopingService.approve` failed `no_scoping_draft` — `docs/cycle-charter.md` was never materialized even though the step runner REPORTS `artifacts_written: ['docs/cycle-charter.md']` (full-build-step-runner.ts:403). The model's output (a) declared a different artifact path (`.sle/work/wi-define-108-a8/scoping.md`) in its SLE-OUTPUT envelope, and (b) uses heading style (`## 1. Scope statement`) that would fail approve's `^#{1,3}\s*scope\b` charter validation. Three distinct deterministic findings in one seam:
   - **F-a (materialization gap):** reported artifact never written; node output only reaches `.sle/runs/…/node-outputs/`.
   - **F-b (path contract):** model-declared artifact path vs step-declared path disagree — no reconciliation.
   - **F-c (format contract):** charter heading/style expectations of `approve` are not taught by the scoping prompt.
   Materializing the charter in-session would have required human translation (path choice + envelope stripping), so it was NOT done; state preserved exactly.

## Frontier after A8

```text
define-work (autonomous, clean)         ✓✓   DDR-041 + Gate B              ✓✓
full-build dispatch + entry             ✓    scoping.produce live model    ✓
scoping charter produced                ✓    checkpoint raise/resume       ✓ (mechanism)
scoping draft publication               ✗  F-a  artifact path contract     ✗  F-b
charter format contract                 ✗  F-c  planning/build/repair      untested
publication / CI / review (H3)          untested
```

## Decision required (operator)

The three findings (F-a/F-b/F-c) are deterministic Stratum seams — the next E-phase candidates, fixable and qualifiable with ZERO model calls (a stub-produced charter + the real A8 charter as fixtures). A9 then re-enters at the scoping seam. Driver `d9d699c2…` to be frozen. Per the frozen rules, A8 stops here; nothing repaired beyond the logged mechanical actions.

## Evidence index

`gate-a-a8.md` · `gate-b-a8.md` · `operator-actions-a8.md` · `a8-outcome.md` · `a8-drive-console.log` · `a8-fullbuild-console.log` · `a8-definition-materialized.md` (`71f1c39c…`) · `a8-scoping-charter-node-output.md` (12,426 B) · `a8-synthesize-loop.json` · `a8-manifest.json` · `pilot-a8-sle-archive.tgz` · DB backup `/tmp/opencode/a8-pre-repair-db-backup.sqlite`.
