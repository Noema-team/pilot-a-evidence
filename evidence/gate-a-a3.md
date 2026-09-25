# Gate A (A3) — initial checks, zero model runs

Frozen: stratum ab9212927df6e5805701285dba21c0908530001c (post-#27 main; includes PR #26 bounded retry + PR #27 Coding Plan removal)
Target: 86ec0871d64ecca8732434c11d015fd8e08ddc7e (dedicated worktree, branch pilot-a/issue-108)
Timestamp: 2026-09-20, before T0. The 120-minute clock NOT started.

1. Frozen revisions: ✓
   - stratum worktree HEAD: ab9212927df6e5805701285dba21c0908530001c (detached; clean except untracked pilot driver; no package.json/lockfile changes vs main → existing node_modules used, Node 22)
   - target worktree HEAD: 86ec0871d64ecca8732434c11d015fd8e08ddc7e, branch pilot-a/issue-108; clean except .sle/
   - Defect present at frozen SHA: rag-worker main.py:1097 publishes {"error": str(e)}; rag-api main.py:237 reads details.get("error_message", …). ✓ (grep-verified)
   - Issue magtheo/student-platform#108: OPEN ✓ (gh api, re-checked at gate time)
2. Fresh state: ✓
   - Pilot A2 .sle archived: evidence/pilot-a2-sle-archive.tgz (10473 bytes, 2026-09-20); .sle REMOVED and re-seeded fresh (map.yaml bootstrapped, settings written, wi-define-108-a3 ready, 4 acceptance criteria). A2 Definition is evidence only, never input.
3. Frozen configuration (E11-amended prereg): ✓
   - settings.json: {"provider":"openrouter","model":"z-ai/glm-5.3-flash","base_url":"https://openrouter.ai/api/v1","max_tokens":16384,"api_key_env":"OPENROUTER_API_KEY"}
   - MAX_AGENT_TURNS 24 · MAX_RESULT_REPAIRS 1 · planning_depth minimal / max_iterations 5 / on_cap_hit halt · single UND_ERR_HEADERS_TIMEOUT retry (PR #26, define-work scoped)
4. Credentials + preregistered reachability probe: ✓
   - OPENROUTER key file present (73 bytes; value never printed). ~32.4 credits as of 2026-09-19.
   - Probe (pre-T0, mechanical): POST /chat/completions, model z-ai/glm-5.3-flash → HTTP 200; max_tokens 16 → content null (reasoning exhausted budget — known hybrid-reasoner trait, finish_reason 'length'); max_tokens 512 → content 'ok', 49 total tokens. Route reachable + authenticated.
5. Baseline suites (per-service pytest, preregistered invocation): ✓
   - rag-worker-service: 109 passed (3.04s) · rag-api-service: 409 passed (3.15s)
6. Isolation: ✓
   - ordinary stratum checkout @ 024d54b [e11 branch, working branch — NOT main]; /tmp/opencode/e5-docs @ 9799df6 (stale, untouched)
   - ordinary student-platform checkout @ 2f56f10 [fix/derived-progress-acceptance]; its origin/main/main ref at ef07145 (target drift beyond frozen 86ec087 — recorded per prereg §3; neither main moves during the run)
   - stratum origin/main: ab92129 (frozen execution revision; must not move during the run)
7. Frozen driver hash: ✓
   - sha256(pilot-a-driver.ts) = 09bd01f68a9637ae47b2364c1ace6c4837102688cecd7ae94b9a04a635f42654 — exact match with preregistered value (recomputed at prep and again here). Any post-T0 change = experiment-integrity failure.

GATE A (A3): PASS
