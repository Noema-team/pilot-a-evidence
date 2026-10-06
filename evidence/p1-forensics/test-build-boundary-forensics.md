# P1 TEST→BUILD boundary — offline forensic analysis

Frozen implementation inspected: `315d37178a98917b0c5de79ac851fa6083acfad7` (read-only).
No model calls; no source or config changes. Evidence: `evidence/p1-1..p1-3/` run archives + DBs.

---

## 0. Mechanical wiring findings ( prerequisites for everything below )

### 0.1 `StepRunContext.sourceFiles` is never populated on the real full-build path
- Declared: `src/workflow/types.ts:420` (`sourceFiles?: string[]`).
- Sole consumer: `src/context-manager.ts:233-237` — builder `getRoleSlices()` appends a `full` slice per entry.
- Sole would-be producer: `engine.makeStepRunContext` (`src/workflow/engine.ts:909-1026`) — **does not set it**; no other production file assigns it (repo-wide grep).
- **Reconciliation of the BUILDER_SLICES comment** (`context-manager.ts:147` "doc:test-script:{category} and source_files added dynamically in getRoleSlices()"): the *mechanism* exists (the `if (ctx.sourceFiles)` hook) but has **no producer on the live path** — the comment describes intent that was never wired. Consequence: BUILD's assembled initial context contains **no source files at all**; every file must be discovered via tools. Observed behavior matches (5–19 tool reads per BUILD execution).

### 0.2 BUILD's actual assembled context (planning_depth = `minimal`, all three runs)
Builder slices = requirements (full) + architecture (full) + test-plan (full) + plan/build-plan (deep only).
- `doc:test-plan` **never existed** in any P1 run (no `test-plan.md` node-output was ever produced).
- `doc:plan`/`doc:build-plan` are `requires_depth: 'deep'` → **excluded** at minimal depth.
- ⇒ BUILD's initial context = **published `docs/requirements.md` + published `docs/architecture.md`** (+ task/definition/teaching). **No plan, no test-plan, no TEST executable artifact, no source.**

### 0.3 ⚠ the task editPolicy was silently dropped at the adapter seam — campaign-wide
- The WorkItem carries it: `workflow_parameters_json.editPolicy = {appliesToSteps:['build'], allowedEditPaths:[worker main.py], requiredEditPaths:[worker main.py]}` — present in **all three P1 runs and V11-1**.
- `resolveWorkflowInvocation` → `validateFullBuildParams` (`src/execution/workflow-parameters.ts`) **reconstructs a whitelist** `{planning_depth, max_iterations, on_cap_hit, definitionSource}` and **silently drops `editPolicy`**; the adapter passes `invocation.normalizedParams` to the engine.
- The run rows prove it: `resolved_parameters_json` in all three P1 DBs (and the V11-1 dump) contains no `editPolicy` → `resolveEditPolicy` → `undefined`.
- Live consequences at 315d371:
  1. `validate`'s `unauthorized-create-path` (build-changeset-contract.ts) **never fired** — any `*.py` create anywhere passed validate;
  2. `requiredEditPaths` enforcement (agent-runner §6e) **was inert** — the "required authorized source edit" was never mechanically required in ANY campaign run;
  3. `allowedEditPaths` §6e gates inert.
- Materiality: V11 was 0/3 publications (gates never reached), and both P1 publications voluntarily edited worker `main.py` — the primary endpoints are unaffected. But every "required/authorized" claim in V8–P1 was enforced only by model choice + the (independent) ownership gate.

### 0.4 Validation-set selection is collection-based, not ownership-based
`.sle/rules/validation.yaml` absent → default categories `['correctness','performance','security']`; the VGS reads `runs/{runId}/tests/{cat}/result.json` produced by the exec runner, which executes the standard test tree. **Any file under `apps/ai-server/tests/integration/` joins the oracle set** — including BUILD-created, TEST-unreviewed tests.

---

## 1. Per-run evidence table

| | P1-1 (`7aa11988…`) | P1-2 (`9a74bb9f…`) | P1-3 (`a4a2f15b…`) |
|---|---|---|---|
| BUILD outcome | staging rejection (create-exists) | **PUBLISHED** (3 edits + 1 create) | **PUBLISHED** (2 edits + 1 create) |
| exact object at issue | attempted create `apps/ai-server/tests/integration/test_worker_failure_contract.py` | validation failure on TEST's `test_failure_payload_contract.py` (`e3255ae702eb…`) | validation failure on BUILD-created `test_worker_failure_contract.py` (`d48b5c5423b3…`) |
| prior step owning/creating it | **TEST**, same run — `produced-file:test:…test_worker_failure_contract.py` → `ca6817be4fcd8d121d94cc0aab8c7d9dcfc08c5577346d764e1f0a40599e7452` | TEST (authoritative oracle) | TEST published its own oracle `test_worker_failure_payload_contract.py` (`fb7287561b3a…`) for the SAME requirement |
| path/file in BUILD's initial context? | **No.** The path appears only in `design.md`/`plan.md` — neither is a builder slice at minimal depth (§0.2); source files never in context (§0.1) | **No.** requirements/architecture carried the *semantic* contract richly (49/50 shape-term hits), but never the executable oracle | **No** (same mechanics) |
| discovered it via tools? | `list_directory tests/integration` at turn 8 **listed the file's name**; **never read it** (reads: worker main.py ×7, test_api_contracts.py ×4, conftest.py, rag-api main.py) | never read `test_failure_payload_contract.py`; dir listing turn 5 | never read TEST's `test_worker_failure_payload_contract.py`; dir listings turns 6–7 |
| why authorized | editPolicy dropped (§0.3) → `unauthorized-create-path` inert; `.py` allowed; ownership gate not reached — stage `create-exists` fired first | n/a (edit+create both passed; no editPolicy to violate) | same as P1-1; target path didn't exist → stage create passed |

---

## 2. The exact TEST→BUILD information actually available to BUILD

**Present in BUILD's initial context (all runs):**
- requirements + architecture (published docs) — including, in P1-2, the full payload-shape contract (`error_message` new/required, `error` legacy retained, the defective publish call quoted verbatim);
- the anchored-edit teaching (schema, ownership semantics of anchors).

**Never present, by mechanism:**
- the implementation plan (deep-only slice, minimal depth) — P1-1/P1-2 plans name the exact test path and the "must publish error_message/stage/retryable" contract;
- any test-plan document (never generated);
- **TEST's executable artifact** — no slice carries it, `sourceFiles` is dead (§0.1), and no BUILD execution ever read it through repository tools (read targets enumerated above);
- any deterministic manifest of TEST-published files (the provenance rows existed in the DB but nothing renders them into BUILD's context or gates).

**The precise semantic disagreements:**
- **P1-1**: pure cross-step path coordination. TEST published oracle `test_worker_failure_contract.py`; BUILD independently chose the same filename for "a new contract test" and submitted a `create`. The protocol failed closed exactly as designed; the model had seen the name in a turn-8 directory listing but had no ownership signal.
- **P1-2**: TEST's oracle `_details_node` requires the except-handler's `_publish_status_update('failed', …)` call to contain an **`ast.Dict` literal** argument. BUILD's published code passes `failure_details` — a **`Name` node** bound to `build_failure_payload(e, current_stage)`, which returns exactly the documented keys `{error_message, stage, retryable, error}`. **Semantically equivalent to the contract in BUILD's own context documents; syntactically short of the oracle's literal-dict requirement.** BUILD met the documented contract and lost to the oracle's stricter shape.
- **P1-3**: BUILD's created test stubs `firebase_admin` + `firebase_admin.firestore` via `sys.modules` but **not `firebase_admin.storage`**; the import chain needs `.storage` → `ImportError` at collection → the whole validation gate aborts before TEST's own (hermetic, scenario-based) oracle is ever reached.

---

## 3. Would a deterministic TEST-output handoff / ownership contract have prevented each failure?

| run | prevented? | mechanism |
|---|---|---|
| P1-1 | **YES, twice over** | (a) ownership rule on creates: `creates` validated against the run's `produced-file:*` provenance rows (already persisted) → in-loop **repairable** "path owned by test — read it or choose another name" instead of an authoritative stage abort; (b) even a passive manifest of TEST-published paths in BUILD's context would likely have changed the filename choice. |
| P1-2 | **YES (this instance)** | handing BUILD the executable oracle (or its extracted expectations) exposes the literal-dict requirement; BUILD demonstrated it implements documented semantics faithfully — with the oracle visible, inlining the dict literal is mechanical. Residual risk (oracle *strictness* beyond the documented contract) remains a TEST-quality question a handoff does not by itself solve. |
| P1-3 | **YES, under oracle-ownership isolation** | if BUILD-created tests gated validation only after TEST adoption/ownership, the collection error could not fail the gate; TEST's own hermetic artifact would be the oracle. (BUILD's test would still be individually defective — a quality issue, not a gate-blocking one.) |

Cross-run: all three failures live in the same boundary — **TEST's outputs (paths, oracles, ownership) are invisible to BUILD's context and unenforced as authority**. The anchored-edit protocol itself behaved flawlessly in all three runs (3/3 structured submissions; both staging-relevant failures were boundary failures, not protocol failures).

---

## 4. Narrowest candidate P2 intervention (design only — NOT preregistered)

**Deterministic TEST→BUILD handoff + oracle-ownership rule**, three mechanical pieces, no change to the anchored-edit publication protocol (keeping the P1-supported mechanism untouched as the control):

1. **Oracle manifest in context** — render the run's `produced-file:test:*` provenance rows (path + hash, already persisted) into BUILD's assembled initial context as a read-only "TEST-published oracle files" list. (Also incidentally the natural place to finally give `sourceFiles` a producer, if ever desired.)
2. **Ownership check on `creates`, in-loop** — the action contract's `validate` gains a deterministic check: a create whose path matches any same-run `produced-file:*` row is a **repairable** defect ("owned by <step>; read it with read_source_slice or choose another path"). Moves the P1-1 failure from authoritative-stage to bounded repair.
3. **Oracle isolation** — files created by BUILD under test trees are recorded as `produced-file:build:*` (already the case) and the validation gate treats only TEST-owned (or TEST-adopted) artifacts as gating oracles; BUILD-authored tests join the set only via an explicit TEST adoption step. Removes the P1-3 gate-abort class.

Minimal core if only one thing changes: **(1)+(2)** — pure information plus one deterministic gate, both driven by evidence that already exists in the artifacts table.

---

*Forensic aids archived alongside: P1-2 audit diff hunks (publish-site edits), P1-3 audit diff new-file hunk (stub lines 137–153), offline pytest reproductions, per-run DB dumps with provenance rows.*
