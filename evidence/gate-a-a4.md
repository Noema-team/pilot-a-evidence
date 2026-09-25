# Gate A (A4) — initial checks, zero model calls

Frozen: stratum c9573951937d4a9d95e2a1bc327cfcf9c528e5c6 (actual merge commit of PR #28 — head 5b44284e… verified MERGED with green exact-head CI before merge detection)
Target: 86ec0871d64ecca8732434c11d015fd8e08ddc7e (dedicated worktree, branch pilot-a/issue-108)
Timestamp: 2026-09-20, before T0. The 120-minute clock NOT started.

1. Frozen revisions: ✓
   - stratum worktree HEAD: c9573951937d4a9d95e2a1bc327cfcf9c528e5c6 (detached; clean except untracked pilot driver; no package.json/lockfile changes vs main → existing node_modules, Node 22)
   - PR #28 state at execution decision: MERGED, head 5b44284e60ce564bcc381032d0a87e69509e40b0 (exact match), exact-head CI verify ×2 + ai-review PASS
   - target worktree HEAD: 86ec0871d64ecca8732434c11d015fd8e08ddc7e, branch pilot-a/issue-108; clean except .sle/
   - Defect present at frozen SHA: rag-worker main.py:1097 {"error": str(e)}; rag-api main.py:237 details.get("error_message", …). ✓
   - Issue magtheo/student-platform#108: OPEN ✓
2. Fresh state: ✓
   - Pilot A3 .sle archived: evidence/pilot-a3-sle-archive.tgz (16543 bytes, 2026-09-20); .sle REMOVED and re-seeded fresh (wi-define-108-a4 ready, 4 criteria). No prior Definition used as input.
3. Frozen configuration: ✓
   - settings.json: {"provider":"openrouter","model":"z-ai/glm-5.3-flash","base_url":"https://openrouter.ai/api/v1","max_tokens":16384,"api_key_env":"OPENROUTER_API_KEY"}
   - MAX_AGENT_TURNS 24 · MAX_RESULT_REPAIRS 1 · one UND_ERR_HEADERS_TIMEOUT retry (define-work scoped) · hard_ceiling 4000 · minimal/5/halt · budgets 2/3/2 · amended Definition teaching (PR #28)
4. Credentials + preregistered reachability probe: ✓
   - OPENROUTER key file present (73 bytes; value never printed)
   - Probe: POST /chat/completions, z-ai/glm-5.3-flash, max_tokens 512 → HTTP 200, content 'ok'
5. Baseline suites (per-service pytest): ✓
   - rag-worker-service: 109 passed (29.16s) · rag-api-service: 409 passed (4.11s)
   - (One mechanical invocation slip recorded: the rag-api suite was first launched from the wrong cwd — "no tests ran"; re-run from the service directory, the preregistered invocation. Corrected before any model call.)
6. Isolation: ✓
   - ordinary stratum checkout @ 5b44284 [e12/a4-teaching-disambiguation] (working branch); /tmp/opencode/e5-docs @ 9799df6 (untouched)
   - ordinary student-platform @ 2f56f10 [fix/derived-progress-acceptance]; origin/main ef07145 (recorded drift; neither main moves during the run)
   - stratum origin/main: c957395 (frozen execution revision; must not move during the run)
7. Frozen driver hash: ✓
   - sha256(pilot-a-driver.ts) = 09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654 — exact match with preregistered value (recomputed at prep and again here).

GATE A (A4): PASS
