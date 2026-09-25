# Gate A (A2) — initial checks, zero model calls

Frozen: stratum a4a1be5617de83575122b61ab9b0b94bd92a9b09 (E9 merge commit, PR #25)
Target: 86ec0871d64ecca8732434c11d015fd8e08ddc7e (dedicated worktree, branch pilot-a/issue-108)
Timestamp: 2026-09-19, before any model call. Clock NOT started.

1. Frozen revisions: ✓
   - stratum worktree HEAD: a4a1be5617de83575122b61ab9b0b94bd92a9b09 (detached; clean except untracked pilot driver)
   - target worktree HEAD: 86ec0871d64ecca8732434c11d015fd8e08ddc7e, branch pilot-a/issue-108
   - Defect present at frozen SHA: rag-worker main.py:1097 publishes {"error": str(e)}; rag-api main.py:237-239 reads details.error_message/stage/retryable. ✓ (grep-verified)
   - Issue magtheo/student-platform#108: OPEN ✓ (gh api, re-checked at gate time)
2. Fresh state: ✓
   - Pilot A .sle archived: evidence/pilot-a-sle-archive.tgz (21255 bytes, 2026-09-19 16:39); .sle REMOVED from target worktree. A2 starts fresh; WI ids wi-define-108-a2 / wi-exec-108-a2. Pilot A attempt-2 Definition is evidence only (inside archive), never input.
3. Isolation: ✓
   - stratum worktree list: ordinary /home/theo/Documents/repos/stratum @ 6df1735 [e8/a2-evidence-observability] (working branch, untouched during run); /home/theo/Documents/repos/pilot-a/stratum @ a4a1be5; /tmp/opencode/e5-docs @ 9799df6 (stale, untouched)
   - ordinary student-platform checkout @ 4b8f5c0 [fix/derived-progress-acceptance] (pre-existing, untouched); its main ref 7b70af7, origin/main 86ec087. Neither main moves during the run.
4. Credentials + baseline tests: ✓
   - GLM key file present (49 bytes; value never printed). Route: Z.ai Coding Plan, provider glm.
   - Per-service pytest (preregistered correction from Pilot A Gate A):
     - rag-worker-service: 109 passed (3.14s) ✓
     - rag-api-service: 409 passed (3.26s) ✓
5. Frozen driver hash: ✓
   - sha256(pilot-a-driver.ts) = 6095ffd90b64a5f0add544ab8cffa2fc0c6d4759c45f3de8b2e3dfe748c2a086 — exact match with preregistered value (recomputed at prep and again here). Any post-T0 change = experiment-integrity failure.
6. Deps: no package.json/package-lock.json changes fa51e8a..a4a1be5; existing node_modules used. Node 22 via nvm.

GATE A (A2): PASS
