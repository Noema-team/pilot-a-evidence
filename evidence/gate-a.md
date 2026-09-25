# Gate A — initial checks, zero model calls

Frozen: stratum fa51e8a1dd64f74e72bd2cbb38d897e1cd6e21f3 (E5 merge commit, PR #24)
Target: 86ec0871d64ecca8732434c11d015fd8e08ddc7e (branch pilot-a/issue-108 created inside dedicated worktree)
Timestamp: 2026-09-19 (before any model call)

1. Frozen revisions exist: ✓
   - stratum worktree HEAD: fa51e8a1dd64f74e72bd2cbb38d897e1cd6e21f3
   - target worktree HEAD: 86ec0871d64ecca8732434c11d015fd8e08ddc7e; target origin/main: 86ec0871…
   - Defect present: rag-worker main.py:1097 publishes {"error": str(e)}; rag-api main.py:237-239 reads error_message/stage/retryable. ✓
   - Issue magtheo/student-platform#108 state: OPEN ✓ (re-checked at gate time)
2. Isolation: ✓
   - Dedicated worktrees: /home/theo/Documents/repos/pilot-a/{stratum,student-platform}
   - Ordinary checkouts untouched; both main refs at frozen SHAs (86ec087… target; fba9ca5…→fa51e8a stratum main post-merge, expected).
   - Target worktree clean before run (git status empty).
3. Credentials + baseline tests: ✓ with one recorded invocation correction
   - GLM_API_KEY present (existence only; value never printed).
   - Preregistered combined command `pytest rag-worker-service/tests rag-api-service/tests` fails as ONE process: ImportPathMismatchError on `tests.conftest` (both services ship a top-level `tests` package; per-service pytest.ini layout). Mechanical correction, recorded: suites run per-service from each service directory (their own pytest.ini).
   - rag-worker-service: 109 passed (19.3s) ✓
   - rag-api-service: 409 passed (2.6s) ✓
   - Environment: Python 3.13.5, pytest 9.0.2 (global; no deps install needed).

GATE A: PASS
