# E7 — Pilot A Evidence Extraction

Scope: persisted artifacts only (`.sle/stratum.db`, `.sle/runs/*`, `work/wi-define-108-r2/`, `run-journal.jsonl`, `step-executions.json`, driver source). No code changed, no model calls made. All 5 attempts ran on the **Z.ai Coding Plan route** (provider `glm`, `glm-5.3-flash`, max_tokens 16384) — the OpenRouter switch post-dates run closure and touches nothing here.

Constants (from source at the frozen revision): `MAX_AGENT_TURNS = 24` (agent-loop.ts:28), `MAX_RESULT_REPAIRS = 1` ("Do not raise", transport/step-result.ts:259).

## 1. Per-attempt ledger

All attempts terminated at step `synthesize-definition`, iteration 1. Token usage: NOT PERSISTED for every attempt (`step_executions.tokens` NULL).

| # | run id | start → end (UTC) | wall | turns/cap | valid `submit_result` emitted | passed transport parse | passed Definition contract | repair used | provider interruption | canonical bytes written | artifact/provenance row | failure owner |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `3a122aa1…` | 09:14:01→09:27:46 | 13m45s | 14/24 | No — no submission; fetch failed | n/a | n/a | 0 | Yes: `LLM call failed: fetch failed` | No | No | **provider** |
| 2 | `6da2d86c…` | 09:35:18→09:47:14 | 11m56s | 13/24 | **Yes** | **Yes** (format_repairs 0) | **Yes** | 0 | No | **Yes**: `.sle/work/wi-define-108-r2/definition.md` (17,687 B, sha256 `e4c59134aa114b47…`) | **Yes**: type `definition`, ref `definition:obj-108`, hash match verified, created 09:47:14.399Z | **pilot-driver** (post-validation infra) |
| 3 | `c22a7284…` | 09:49:32→09:58:05 | 8m33s | 24/24 (cap) | No — `Agent did not produce a result block within 24 turns` | n/a | n/a | 0 | No | No | No | **model** |
| 4 | `a65740c2…` | 09:59:08→10:09:11 | 10m03s | 16/24 | No — fetch failed | n/a | n/a | 0 | Yes: `LLM call failed: fetch failed` | No | No | **provider** |
| 5 | `06550f4e…` | 10:11:11→10:24:25 | 13m14s | 14/24 | Yes — syntactically: `submit_result`, argument_bytes 17,738 | Yes (`format_repairs: 0`) | **No** — `goal: Required` | 1/1, exhausted | No | No | No | **model** |

No attempt is owned by "Stratum" (no Stratum-defect failure occurred) and none is "mixed".

## 2. Attempt 2 — critical reconstruction

**Evidence the submitted result was valid — every system gate passed:**
- Loop observation: `failed` key ABSENT (contrast `failed: True` on r1/r3/r4/r5), `turns_taken: 13`, transport `submit-result`, 22 tool calls, turns 1–12.
- Manifest (`runs/6da2d86c…/1/manifest.json`): node `synthesize-definition` **`complete`**, `artifacts_written: ['.sle/work/wi-define-108-r2/definition.md']`.
- Contract materialization ran: canonical bytes on disk, 17,687 B / 258 lines, `schemaVersion: 1`, **`goal:` present** (lines 3–6), fact ledger of 17 facts (14 KNOWN, 2 ASSUMED, 1 DEFERRED), sections incl. "Chosen shape: worker adopts the consumer's keys", "Test strategy", "Explicitly out of scope".
- Provenance row committed: `artifacts` row (`type='definition'`, ref `definition:obj-108`, path, sha256 `e4c59134aa11…`) at 09:47:14.399Z. **sha256 of the on-disk file recomputed now: `e4c59134aa114b47…` — exact match.**
- The 276-byte `synthesize-definition.md` raw node output is the assistant's final TEXT ("…Now I'll compose the Definition and submit."), not the payload; the payload rode submit-result and was materialized by Stratum itself.

**Which step succeeded before the crash:** `synthesize-definition` — fully, including materialization. All 10 downstream steps (`refine-definition` → readiness reviews → decision checkpoint → … → `commit`) remained `pending`.

**Precise exception:** `step_executions.failure_json = {"code":"adapter_exception","message":"Error: ENOENT: no such file or directory, open '/home/theo/Documents/repos/pilot-a/student-platform/.sle/map.yaml'"}`, at 09:47:14.707Z — ~308 ms after the artifact row insert. `RuntimeMapManagerImpl.read()` (runtime-map.ts:316-326) throws on a missing file; production `stratum init` creates `map.yaml` via `createInitialMap` (init-service.ts:500-511); the driver omitted that bootstrap, so the first map access after the step crashed the run. Full stack beyond the message: NOT PERSISTED.

**Cursor state:** `workflow_runs` row `6da2d86c` = status `active`, `current_step_id = synthesize-definition`, `iteration 1`, `revision 0` — the cursor never advanced past the (completed) step; the crash hit during post-step continuation, before the next-step transition persisted.

**Would it have completed under correct bootstrap?** Observed fact: the step succeeded through every model-facing and validation gate, and canonical materialization + provenance committed. Hypothesis (not observed): the remaining 10 steps would also have passed. The extraction cannot claim a completed run — only unambiguous step-level model convergence.

**Minimal driver change (before → after):**
- Before: `seed()` wrote `.sle/settings.json`, then unconditionally `save()`d workspace/project/objective (failed on rerun: UNIQUE constraint), and never created `map.yaml`.
- After: `mkdirSync(.sle)`, `if (!existsSync(mapPath)) writeFileSync(mapPath, dump(createInitialMap({projectName:'student-platform', projectType:'python', codeRemote/issuesRemote/docsRemote/taskStore, agents:{}})))` — the exact production-init map bootstrap (`createInitialMap` + `js-yaml` dump imports added); workspace/project/objective saves made idempotent via `findById` guards. No other function touched.

**Classification of the repair:** changed ONLY production-environment bootstrap/setup. Unchanged: model prompt/context (byte-identical objective), model/provider settings (`glm` route untouched at that time), workflow semantics, Stratum source revision, budgets, and zero operator contact with Definition content.

**Conclusion supported:** attempt 2 demonstrates successful model convergence — a contract-valid, materialized, hash-pinned canonical Definition — lost to an experiment-infrastructure failure. Whether the full run would have completed is untested.

## 3. Attempts 3 and 5 — model failure detail

**Attempt 3 (r3):** 32 tool calls over 24 turns — 19 `list_directory`, 13 `read_file`; 32 unique paths, **zero repeated reads**. Sequence: defect files read first (turn 1: `rag-api-service/main.py`, `rag-worker-service/main.py`; turn 2 `models/resource.py`), then progressively broader survey: `plans/` (3 files incl. `upload-flow.md`), `AGENTS.md`, `docs/task-management`, `docs/system-overview`, `apps/ai-server` test tree (`test_api_contracts.py`, conftest, fixtures), `dev/journeys/specs/J1-upload-process-map.yaml`, `docker-compose.yml`, `rag-worker-service/exceptions.py`. At the cap (turn 24) the last recorded calls were still survey reads (`rag-worker-service` listing, `exceptions.py`, tests listing); **no submit attempt had been made** (`stop_reason: tool_use` at cap). Semantic work remaining at cap: composing the Definition, readiness self-review, and submission — i.e., the entire synthesis phase. Whether it was "close": not decidable from persisted evidence — no draft or compose signal was persisted; the record shows continuous acquisition without a convergence attempt.

**Attempt 5 (r5):**
- Final submitted payload: **NOT PERSISTED** — only its size (`tool_uses: [{name: 'submit_result', argument_bytes: 17738}]`) and the rejection are recorded. The 2,934 B `synthesize-definition.md` is a step-failure-observation JSON (`result_repairs: 1, format_repairs: 0`), not the payload.
- Exact validator error (failure_json, verbatim): `Submitted result was rejected by output contract 'definition' and result repair is exhausted (14 provider turn(s), 1 result-repair attempt(s)): Your submitted result was rejected by the output contract for 'definition'. Reason: the submitted result does not match the required semantic shape — goal: Required`
- Repair prompt (verbatim, from the same record): `Re-submit the complete corrected result in the same required shape. Do not change anything that was not rejected.`
- Repaired response: NOT PERSISTED (bytes never written; loop ended fail-closed after the 1 allowed repair).
- Why repair exhausted: `MAX_RESULT_REPAIRS = 1` (step-result.ts:259) — the first rejection consumed the only repair; the resubmission also failed validation (otherwise the step would have completed), and the decision function then fails closed.
- `goal` malformation type: **absent** — `goal: nonEmptyAfterTrim('goal')` (definition-contract.ts:88); zod reports `Required` for a missing key, not a type or location error. Context: attempt 2's accepted Definition (17,687 B) vs attempt 5's rejected payload (17,738 B) — comparable scale, top-level `goal` key missing.

## 4. Provider transport failures (r1, r4)

- Exact persisted error: `{"code":"workflow_error","message":"LLM call failed: fetch failed"}` — no HTTP status, no stack, no cause, no request metadata. Distinguishing timeout vs connection reset vs server error vs client failure: **NOT PERSISTED / NOT DETERMINABLE**. ("fetch failed" is the undici client-side TypeError surface; its cause was not captured.)
- r1: failure on provider call #14 (last completed tool turn 12); step total 825.9 s. r4: call #16 (last completed tool turn 14); step total 603 s. Per-call duration before failure: NOT PERSISTED.
- Phase: both failures occurred on the ordinary next-turn completion call after normal tool-result turns — not during a submit_result submission (no submission had been attempted in either run).
- Retries: none — the provider layer has no retry path; each turn was an independent successful call until the failing one, which was attempted once.
- Preceding turns: completed normally in both (tool calls + results recorded through turns 12 / 14).
- Comparison (facts only): short single-shot calls on the same route succeeded at 09:0x pre-run (HTTP 200, `finish: stop`, content "OK", usage 38 tokens) and at ~10:2x post-run (HTTP 200). Attempt 2's 13-turn conversation completed in full. No causality claimed.

## 5. Context / scale evidence

| | r1 | r2 | r3 | r4 | r5 |
|---|---|---|---|---|---|
| Assembled context tokens at first call | NOT PERSISTED | NOT PERSISTED | NOT PERSISTED | NOT PERSISTED | NOT PERSISTED |
| Largest in-loop context estimate | NOT PERSISTED | NOT PERSISTED | NOT PERSISTED | NOT PERSISTED | NOT PERSISTED |
| Tool calls (unique paths) | 19 (19) | 22 (22) | 32 (32) | 20 (20) | 20 (20) |
| Repeated reads within attempt | 0 | 0 | 0 | 0 | 0 |
| History growth | monotonic (append-only by design) | same | same | same | same |
| Truncation / context-limit events | none recorded (NOT PERSISTED) | same | same | same | same |

## 6. Timing decomposition (window 09:14:00–10:26Z ≈ 72 min; Gate A/setup was pre-window)

| Segment | Duration |
|---|---|
| r1 model time | 13m45s |
| gap (r1 failure diagnosis + node-ABI detour) | 7m32s |
| r2 model time | 11m56s |
| gap (ENOENT diagnosis + driver patch + syntax fix) | 2m17s |
| r3 model time | 8m33s |
| gap (relaunch decision) | 1m03s |
| r4 model time | 10m03s |
| gap (relaunch decision) | 1m59s |
| r5 model time | 13m14s |
| gap (closeout checks) | ~1m30s |

Model-occupied ≈ 57m31s (79.8%); operator overhead inside the window ≈ 14m24s (20.2%). Provider retry/wait: 0 (no retry mechanism existed). Budget-suitability facts: five attempts of model time alone consumed 57.5 min; a converged define-work (~12 min observed) plus Gate B plus a 10+-step full-build at observed per-step durations could not have fit in the remaining ~50 min — the 120-min end-to-end clock was a binding constraint independent of any single failure cause.

## 7. Experiment-integrity note

The mid-run driver fix (after attempt 2) was **inside experimental infrastructure and outside every preregistered frozen field**:

| Frozen field | Violated? |
|---|---|
| Model | No — `glm-5.3-flash` unchanged |
| Prompt | No — objective/issue bytes identical; no prompt edits |
| Provider | No — Coding Plan route unchanged during the run |
| Source revision | No — Stratum `fa51e8a` untouched; driver is untracked infra |
| Budget | No — wall-clock ran continuously; no limit altered |
| Stratum production source | No — zero source changes |
| Operator semantic intervention | No — operator never touched Definition content |

Recorded separately rather than treated as irrelevant: the fix WAS a mid-experiment change to experiment infrastructure, logged in `run-journal.jsonl` at the time. Its evidentiary effect is material — it converted attempt 2 from a routine step failure into the run's only model-convergence case — which is why §2 reconstructs it in full. The OpenRouter route switch occurred AFTER run closure, alters no Pilot A evidence, and is recorded in `route-decision.md`.

## 8. Final diagnosis matrix

| Cause | Evidence strength | Attempts affected | Prevented progress? | Candidate next experiment |
|---|---|---|---|---|
| Pilot-driver bootstrap defect (missing map.yaml init) | Direct — code + ENOENT + complete-step manifest | 2 | Yes — destroyed the only converged attempt | Rerun with the corrected bootstrap (fix already in place) |
| Provider long-call transport instability | Moderate — 2/5 attempts, no distinguishing metadata; short calls fine; same class seen on OpenRouter in E4-H | 1, 4 | Yes | Identical-config A/B across routes, or bounded provider-level retry; capture cause metadata |
| 24-turn exhaustion | Direct — loop observation, cap constant in source | 3 | Yes | Measure turns-to-submit distribution (r2: 13; r5: 14 incl. repair) against real-repo scale |
| Definition contract non-conformance / repair exhaustion | Direct — failure_json + submit_result argument_bytes; payload NOT PERSISTED | 5 | Yes | Persist rejected payload bytes (evidence capture change, not behavior change) |
| 120-minute end-to-end budget pressure | Arithmetic — but ONLY under failure recovery: 72 min = 5 attempts incl. 2 transport failures + 1 harness failure; a clean attempt took ~12 min | all (counterfactual) | Not proven — untested whether 12 min define-work + Gate B + full-build + publication fits a clean 120-min run | A2 answers it directly: one clean end-to-end run inside the unchanged 120-min clock |

Observed facts vs hypotheses are separated as marked. Extraction complete — STOP. No rerun, no E7 code changes, no new preregistration.

## E7 closeout amendment (operator, 2026-09-19)

- The 120-minute budget row above is corrected: insufficiency was NOT proven. The clock was consumed by recovering from failures, which is a different condition than intrinsic insufficiency. A2 tests the clean-run question with the clock unchanged.
- Supported-conclusions table stands as extracted: define-work real-repo convergence demonstrated once (attempt 2); DDR-041 handoff untested live; full-build not tested; provider long-call reliability a real unresolved risk; 24-turn cap and repair budget have insufficient evidence to change; harness defect mechanically fixed; observability weak around provider causes / rejected payloads (now instrumented for A2).
