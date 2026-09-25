# Gate A — Pilot A9 — ALL CHECKS PASS

**Date:** 2026-09-21 18:45–18:52 UTC. Deterministic only. Zero model calls (probe used a capturing stub).

| # | Check | Result |
| --- | --- | --- |
| 1 | Worktree detached at preregistered execution revision | ✅ `37c3acda6e8e248965ed88c2e2e1cc32c6c64298` (post-PR-#34 main; PR #35 merge `c0519e3` is docs-only and intentionally NOT part of the frozen revision) |
| 2 | Driver hash == preregistered freeze | ✅ `d9d699c2c4b5ff52a09e4aa23fd31eddd0f311533b3edba4a5dda62671ac6db9` (re-verified after seed) |
| 3 | Target @ `86ec0871…`, branch `pilot-a/issue-108`, issue #108 | ✅ OPEN |
| 4 | A8 archive present; fresh `.sle` | ✅ `pilot-a8-sle-pre-a9-backup.tgz` written, then `.sle` removed and re-seeded |
| 5 | Seed schema-validates; A9-scoped WI | ✅ `seeded: wi-define-108-a9 \| acceptance criteria: 4` (map parses: `project.type=custom`, `task_store.type=local`); sole WI `wi-define-108-a9` `ready`; 0 workflow runs |
| 6 | Step-scoped budget override on disk BEFORE runner construction; effective wire budgets (driver's exact resolution + construction order, stub provider) | ✅ settings.json carries `{"define-work/synthesize-definition": 32768}`; probe: synthesize `[32768,32768]` · readiness-review/refine-definition/full-build scoping.produce/build `[16384,16384]` — **5/5 PASS**; probe dirs removed, 0 runs in DB |
| 7 | E19 scoping publication contract present at this revision | ✅ `CYCLE_CHARTER_OUTPUT` declared on `FULL_BUILD.scoping.produce` (`outputArtifact: CYCLE_CHARTER_OUTPUT`, full-build.ts:48) with `{type: 'cycle-charter', ref: 'doc:cycle-charter', path: 'docs/cycle-charter.md'}`; scoping prompt teaches exact `## Scope`/`## Purpose` grammar (2 matches) |
| 8 | Lifecycle + dependency surface at this revision | ✅ E17 suite (WorkService dependency create/dedupe/reject + DDR-041 two-lane) + E19 suite (publication fail-closed + approval path): **14/14 pass** |
| 9 | Node 22 active; OpenRouter key resolvable | ✅ |

**Gate A verdict: PASS — T0 authorized per pilot-a9.md. Entry replay deferred to post-define-work (zero-cost, on the fresh Definition), per A8 protocol.**
