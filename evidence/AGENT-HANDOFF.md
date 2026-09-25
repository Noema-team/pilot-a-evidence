# AGENT HANDOFF — Stratum Pilot A / Issue #108 (attempt 19 → next)

**Written:** 2026-09-24, after attempt 19 closed. Written for an agent taking over on a NEW machine (or a fresh session). Read top to bottom before touching anything.

---

## 1. Mission and current state

**Objective:** Stratum (an orchestration engine) drives an LLM agent to fix a real issue (#108) in the `student-platform` repo, through a frozen 15-step full-build workflow. The research question at this phase (H2): **can the live builder AUTHOR and publish a correct, bounded source patch** that the independent test suite (owned by a prior TEST step) then judges. Publication safety (E27) is solved and merged — do not redesign it.

**Where things stand:**
- Stratum publication boundary **E27 merged**: ordinary repo = pilot repo @ `3cb3ab8` (merge of PR #44, approved head `f339af0`). Full verify: 1,713/0.
- **Attempt 19 is CLOSED**: run `2ec825a7-a170-4a51-93a3-f1c7e08d0c71` halted at `build`, WI state `failed`. Everything before BUILD worked (scoping/design/plan/test published with provenance; restore op seeded TEST's original + ownership). BUILD's synthesis completion degenerated: provider returned `stop_reason=max_tokens` with `text_length=0` — the entire 65,536-token output budget consumed with zero text. Probe-verified the wire budget was correct. This is live model behavior, NOT an orchestration defect.
- **H2 has no code to evaluate yet** (nothing published). Stopped for operator ruling: rerun the same frozen configuration (the failure looks stochastic), or treat the zero-text synthesis as itself a finding.
- Target repo untouched: worker `main.py` @ `7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988` (95,897 B), restored TEST artifact @ `b3b30497bfd8b219e1458b0e53d8ce01aece9226fea6ce317a86cd535f3a41ab` (24,350 B). No target merge, ever.

## 2. Migration checklist (what must be in place on the new machine)

| # | Item | Where it comes from | Why it's required |
|---|------|--------------------|-------------------|
| 1 | **stratum repo** @ `3cb3ab8` | clone `Noema-team/stratum`, checkout main | the engine. `npm install` — `better-sqlite3` is native (linux-x64 prebuilds exist; needs build tools if prebuild missing) |
| 2 | **pilot worktree of stratum** with **`pilot-a-driver.ts`** | ⚠️ `pilot-a-driver.ts` is **UNTRACKED — not in git** (removed from PR #44 by review). Copy it out-of-band from the old machine's `pilot-a/stratum/` | the only way to drive the pilot |
| 3 | **student-platform clone**, branch `pilot-a/issue-108` @ `86ec0871` | clone `magtheo/student-platform`, checkout the branch | the TARGET repo — Stratum reads it via real `fs` calls and runs `pytest` against its working tree. Nothing remote can substitute |
| 4 | **`evidence/` directory** — copy ENTIRE tree, especially `pilot-a10-attempt18-sle-archive.tgz` | old machine `pilot-a/evidence/` | journal continuity + the restore op extracts TEST's original bytes AND attempt-18's provenance DB from that tgz. Without it `restore-test-artifact` refuses (by design) |
| 5 | **A8 authority archive**: `a8-authority/.sle/` (definition `71f1c39c…` + its stratum.db) | old machine `/tmp/opencode/a8-authority/.sle` | `instantiate` transplants the frozen canonical Definition from it |
| 6 | **`issue-108.json`** | old machine `/tmp/opencode/pilot-a/issue-108.json` | seed/execute-wi fixture |
| 7 | **OpenRouter API key** | old machine `/tmp/opencode/.openrouter_key` | `export OPENROUTER_API_KEY=$(cat /tmp/opencode/.openrouter_key)`. Only network needs: openrouter.ai + GitHub |
| 8 | **Node 22** (nvm), **Python 3 + pytest** | install | Node runs everything; pytest needed only when validation runs (after a successful BUILD) — install the repo's `requirements.txt` deps for the full suite |

**RAM/disk:** trivial (Node + SQLite + pytest subprocesses; inference is remote). Any modest laptop works.

**⚠️ Hardcoded paths** in `pilot-a-driver.ts` (constants at top + `executeWi`): `ROOT=/home/theo/Documents/repos/pilot-a/student-platform`, `EVIDENCE=/home/theo/Documents/repos/pilot-a/evidence`, `DB_PATH=$ROOT/.sle/stratum.db`, and `/tmp/opencode/pilot-a/issue-108.json`. Either mirror this exact layout (symlink `/home/theo` if the username differs) or edit the ~4 constants — the driver is an untracked fixture file, but journal any edit as a fixture amendment (`fixture_migrated` event with old/new paths).

**Post-migration sanity, in order:**
1. `cd stratum-pilot-worktree && npm ci && npx tsc --noEmit` (clean) and `npm test` → expect **1,713/0** (one known flake family: fixed-port `EADDRINUSE :::19204` in auth/C.route API tests — pre-existing, unrelated, rerun to confirm).
2. Driver `npx tsc --noEmit --strict … pilot-a-driver.ts` shows exactly 6 pre-existing looseness errors — fine; it runs via tsx.
3. Journal a `fixture_migrated` entry (host, path layout, sha256 of the copied attempt-18 tgz).

## 3. Frozen experiment parameters — do NOT change

- Model `z-ai/glm-5.3-flash` via openrouter; per-step completion budgets (`workflow_max_tokens` in target `.sle/settings.json`): `define-work/synthesize-definition:32768`, `full-build/design:32768`, `full-build/plan:32768`, `full-build/test:65536`, `full-build/build:65536`. **instantiate reseeds settings.json without this block — re-apply after instantiate, before drive.**
- Synthesis gate: threshold 18 turns (tools withdrawn at 19); E23 read-result compaction 49,152 B newest-first.
- DEBUG step ungated. Max turns / repair budgets unchanged.
- editPolicy (in driver constant `ATTEMPT19_EDIT_POLICY`, frozen into the WI's workflowParameters): `{appliesToSteps:["build"], allowedEditPaths:["apps/ai-server/rag-worker-service/main.py"], requiredEditPaths:[same]}`.
- No orchestration changes mid-experiment; no target-repo merges; preregister every attempt in `run-journal.jsonl` before driving.

## 4. Run protocol (exact sequence)

Work in the pilot stratum worktree; `nvm use 22`; export the key. Target repo first:

```bash
cd <pilot-a>/student-platform
git reset --hard 86ec0871 && git clean -fdx     # frozen base, clean tree
```

Then, from the pilot stratum worktree:

```bash
npx tsx pilot-a-driver.ts instantiate /tmp/opencode/a8-authority/.sle wi-define-108-a8
# ^ seeds the DB internally — do NOT run `seed` first (PK collision)
# then re-apply workflow_max_tokens to <target>/.sle/settings.json (see §3)
npx tsx pilot-a-driver.ts execute-wi wi-define-108-a8
npx tsx pilot-a-driver.ts gate-b wi-define-108-a8          # must PASS, verbatim true
npx tsx pilot-a-driver.ts drive wi-exec-108                # runs scoping, exits 3 at scoping checkpoint
npx tsx pilot-a-driver.ts resolve <scopingDecisionId> approve "<rationale>"
#   ^ drives design→plan→test, exits 3 at CONFIRM with a second decision id
# NOW, before resolving confirm:
npx tsx pilot-a-driver.ts restore-test-artifact <runId>    # runId from journal run_status entry
npx tsx pilot-a-driver.ts resolve <confirmDecisionId> approve "<rationale>"
#   ^ BUILD runs. Exit 0 = run terminal (check journal drive_terminal)
```

**Pre-BUILD verification (mandatory):** worker sha256 = `7d7718bc…` (95,897 B); restored test on disk = `b3b30497…`; provenance row `produced-file:test:<path>` present in the CURRENT run (`sqlite3 .sle/stratum.db "SELECT ref,hash FROM artifacts WHERE workflow_run_id='<runId>' AND ref LIKE 'produced-file%'"`); budgets probe optional (`/tmp/opencode/a10-build-budget-probe.mts` if copied).

**Note:** `restore-test-artifact` sources historical rows from the attempt-18 archive DB (the current DB is rebuilt per attempt). It requires ≥1 exact archived row matching the extracted original and refuses otherwise; the archived BUILD replacement row (`6b026ca9…`) is tolerated evidence. Do not weaken this.

## 5. Evaluation rules once BUILD publishes

- Preserve BUILD's exact output and applied diff (archive node-outputs + console log + `.sle/runs/<runId>/` tgz into `evidence/` with `a10-attemptNN-` names; journal an `attemptNN_result` entry; update `a10-outcome.md`).
- Judge H2 against the **ORIGINAL independent suite** (the restored `b3b30497…` file) plus relevant runtime behavior — regardless of whether the larger workflow completes. AST/contract pass ≠ runtime correctness.
- rag-api must remain byte-unchanged: `579b0bdfff8f97ee81112251ec7380b392f4aa7c38d216cd56d1782a34ed2744`.
- The restored TEST artifact must survive BUILD byte-identically (ownership enforces; verify the hash after the run).
- **Stop rule:** once BUILD materializes code, orchestration hardening stops — remaining defects are H2 code-quality findings, not engine work. Model-side failures (e.g. attempt 19's zero-text `max_tokens`) are recorded as findings; never tune budgets/thresholds in response.

## 6. Key facts a fresh session will ask about

- Attempt ledger + full narrative: `evidence/a10-outcome.md`; machine-readable history: `evidence/run-journal.jsonl` (events: `attemptNN_preregistered`, `attemptNN_result`, `e27r_*`).
- E27 architecture (merged): `read_source_slice` tool (bounded excerpt + Stratum-computed full-file sha256; survives E23 compaction) → model emits `<<<SLE-PATCH path base=sha256>>>` with strict unified diff → zero-fuzz applier `src/patch.ts` → step-scoped positive `EditPolicy` (engine-validated; typo'd `appliesToSteps` fails dispatch) → per-run ownership via `produced-file:<stepId>:<path>` provenance rows (suffix-parsed, rowid-ordered) → staged pre-write validation → hashed `applied-patch` provenance → independent validation.
- Attempt 19 live observations worth carrying: the model adopted `read_source_slice` unprompted in BOTH build and test steps; E23 elided both full 95,897-byte worker reads while slices+digests survived; the degenerate synthesis (65,536 tokens, zero text) is the only failure on record at this step.
- Patch module invariants: byte-exact transport (never trim), 20-item changeset bound, 32 KB patch ceiling, literal-only `\ No newline at end of file`.
- Ordinary stratum repo and pilot worktree sit at the SAME commit (`3cb3ab8`); pilot worktree is checked out detached. Only untracked delta: `pilot-a-driver.ts` (+ any future fixture edits).
