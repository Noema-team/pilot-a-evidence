# Gate A (A5) — initial checks, zero model calls

Frozen: stratum cc0ba2b78d4cdd6df32efee9b52ac6183103ec0a (PR #29 merge commit — A5 prereg only; code identical to A4's c957395)
Target: 86ec0871d64ecca8732434c11d015fd8e08ddc7e (dedicated worktree, branch pilot-a/issue-108)
Timestamp: 2026-09-20, before T0. The 120-minute clock NOT started.

1. Frozen revisions: ✓
   - stratum worktree HEAD: cc0ba2b78d4cdd6df32efee9b52ac6183103ec0a (detached; clean except untracked pilot driver)
   - PR #29 (A5 prereg, docs-only): CI verify ×2 PASS; merged under the operator's explicit E14 authorization of this exact protocol
   - target worktree HEAD: 86ec0871d64ecca8732434c11d015fd8e08ddc7e, branch pilot-a/issue-108; clean except .sle/
   - Defect present at frozen SHA: rag-worker main.py:1097 {"error": str(e)}; rag-api main.py:237 details.get("error_message", …). ✓
   - Issue magtheo/student-platform#108: OPEN ✓
2. Fresh state: ✓
   - Pilot A4 .sle archived: evidence/pilot-a4-sle-archive.tgz (2026-09-20); .sle REMOVED and re-seeded fresh (wi-define-108-a5 ready, 4 criteria). No prior Definition as input.
   - (Mechanical slip recorded + corrected: one prep chain ran in the ordinary stratum checkout instead of the pilot worktree — it moved that checkout to cc0ba2b detached; restored to its e12 branch at 5b44284 before Gate A. No pilot state touched; no frozen input affected.)
3. Frozen configuration (identical to A4, per prereg): ✓
   - settings.json: openrouter / z-ai/glm-5.3-flash / api/v1 / max_tokens 16384 / OPENROUTER_API_KEY
   - MAX_AGENT_TURNS 24 · MAX_RESULT_REPAIRS 1 · one headers-timeout retry · hard_ceiling 4000 · minimal/5/halt · budgets 2/3/2 · PR #28 amended teaching (in the frozen revision)
4. Credentials + preregistered reachability probe: ✓ (key file present, value never printed; probe HTTP 200, content 'ok')
5. Baseline suites (per-service pytest): ✓ rag-worker 109 passed (1.96s) · rag-api 409 passed (2.15s)
6. Isolation: ✓
   - ordinary stratum checkout @ 5b44284 [e12/a4-teaching-disambiguation] (restored)
   - ordinary student-platform @ 2f56f10 [fix/derived-progress-acceptance]; origin/main ef07145 (recorded drift; neither main moves during the run)
   - stratum origin/main: cc0ba2b (frozen execution revision; must not move during the run)
7. Frozen driver hash: ✓
   - sha256(pilot-a-driver.ts) = 09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654 — exact match (recomputed at prep and again here).

GATE A (A5): PASS
