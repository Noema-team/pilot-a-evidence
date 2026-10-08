// P1-R SEAM PROOF — production-shaped verification that a WorkItem-declared
// task editPolicy survives the REAL invocation seam and binds BUILD end-to-end:
//
//   ExecutionRequest/WorkItem editPolicy
//     → StratumAgentAdapter.execute (persistedRun?.resolvedParameters ?? request)
//     → resolveWorkflowInvocation → validateFullBuildParams (P1-R correction)
//     → engine.run(resolvedParameters) → WorkflowRun.resolvedParameters (frozen)
//     → validateEditPolicyTargets (definition-level, fail-closed)
//     → BUILD StepRunContext.editPolicy (per-step applicability)
//     → ActionContract validation/publication (unauthorized-create-path,
//       requiredEditPaths) via the real AgentRunner BUILD protocol v1 loop.
//
// Zero model traffic. Pins:
//   1  BUILD receives exactly the frozen policy allowing/requiring ONLY main.py
//   2  anchored main.py edit + create outside the policy → rejected in-loop,
//      repairable, writes NOTHING for the rejected create
//      [P2-B amendment 2026-10-08 (operator-review corrections): under the
//      frozen main.py-only policy the model-facing submit_result surface no
//      longer OFFERS creates at all, so an out-of-policy create is now an
//      unknown-key DECODE rejection — never decodable, never silently
//      discarded; the authoritative unauthorized-create-path validate check
//      remains as the second gate (unit pin P2B.A3).]
//   3  a main.py-only proposal stages and satisfies requiredEditPaths
//   4  every non-build step receives no editPolicy at all
//   5  resume uses exactly the frozen policy — a tampered request policy cannot leak
//   6  invalid / misspelled policies fail closed (never degrade to "no policy")

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { strict as assert } from 'node:assert';

import { openDatabase } from '/home/theo/Documents/coding/repos/stratum/src/storage/database.js';
import {
  WorkflowRunRepository,
  WorkspaceRepository,
  ProjectRepository,
  ObjectiveRepository,
  WorkItemRepository,
} from '/home/theo/Documents/coding/repos/stratum/src/storage/repositories.js';
import type { WorkItem } from '/home/theo/Documents/coding/repos/stratum/src/storage/repositories.js';
import { StratumAgentAdapter } from '/home/theo/Documents/coding/repos/stratum/src/execution/stratum-agent-adapter.js';
import type { WorkflowEngineDeps, WorkflowEngineOptions } from '/home/theo/Documents/coding/repos/stratum/src/workflow/engine.js';
import type { StepRunContext, StepResult } from '/home/theo/Documents/coding/repos/stratum/src/workflow/types.js';
import type { ExecutionRequest } from '/home/theo/Documents/coding/repos/stratum/src/execution/types.js';
import { AgentRunner, type AgentRunnerConfig } from '/home/theo/Documents/coding/repos/stratum/src/agent-runner.js';
import type { RunArtifactManager } from '/home/theo/Documents/coding/repos/stratum/src/run-artifacts.js';
import type { ArtifactRepository, ArtifactRecord } from '/home/theo/Documents/coding/repos/stratum/src/storage/repositories.js';
import { ContextManager, DEFAULT_CONFIG } from '/home/theo/Documents/coding/repos/stratum/src/context-manager.js';
import type { MultiTurnResult } from '/home/theo/Documents/coding/repos/stratum/src/agent-loop.js';
import { SUBMIT_RESULT_TOOL_NAME } from '/home/theo/Documents/coding/repos/stratum/src/transport/step-result.js';
import {
  createBuildChangesetActionContract,
  BUILD_CHANGESET_ARTIFACT_TYPE,
} from '/home/theo/Documents/coding/repos/stratum/src/workflow/methodology/build-changeset-contract.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';
const FROZEN_POLICY = {
  appliesToSteps: ['build'],
  allowedEditPaths: [WORKER_PATH],
  requiredEditPaths: [WORKER_PATH],
};
const FROZEN_PARAMS = {
  planning_depth: 'minimal',
  max_iterations: 10,
  on_cap_hit: 'halt',
  editPolicy: FROZEN_POLICY,
};

interface Harness {
  runRepo: WorkflowRunRepository;
  executionWiId: string;
}

function seededDb(): Harness {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  new WorkspaceRepository(db).save({ id: workspaceId, name: 'ws', createdAt: now });
  const projectId = randomUUID();
  new ProjectRepository(db).save({
    id: projectId, workspaceId, name: 'p', description: 'p',
    status: 'active', priority: 0, createdAt: now, updatedAt: now,
  });
  const objectiveId = randomUUID();
  new ObjectiveRepository(db).save({
    id: objectiveId, projectId, title: 'o', description: 'o', priority: 0,
    status: 'active', constraints: [], successCriteria: [], createdAt: now, updatedAt: now,
  });
  const executionWiId = randomUUID();
  const execution: WorkItem = {
    id: executionWiId, projectId, objectiveId,
    repositoryIds: [], title: 'Implement the work', goal: 'implement',
    workflowId: 'full-build', state: 'ready',
    priority: 0, acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  };
  new WorkItemRepository(db).save(execution);
  return { runRepo: new WorkflowRunRepository(db), executionWiId };
}

// ═══════════════════════════ Harness A: the real seam ═══════════════════════════

interface Captured { step: { id: string }; ctx: StepRunContext }

function stubStepRunner(captured: Captured[], failAtStep?: string): WorkflowEngineDeps['stepRunner'] {
  return {
    run: async (step: { id: string }, stepCtx: StepRunContext) => {
      captured.push({ step, ctx: stepCtx });
      if (failAtStep && step.id === failAtStep) {
        return { success: false, artifacts_written: [], tokens_used: 0, duration_ms: 1, error: `proof: fail at ${step.id}` } as StepResult;
      }
      return { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 1 } as StepResult;
    },
  } as unknown as WorkflowEngineDeps['stepRunner'];
}

function engineDepsWith(stepRunner: WorkflowEngineDeps['stepRunner'], runRepo: WorkflowRunRepository, projectRoot: string): WorkflowEngineDeps {
  return {
    stepRunner,
    mapManager: {
      read: async () => ({ cycle: { iteration: 1, max_iterations: 16 } }),
      update: async () => {},
    } as unknown as WorkflowEngineDeps['mapManager'],
    runArtifacts: {
      updateNodeStatus: async () => {},
      createRunDir: async () => {},
      createManifest: async () => {},
    } as unknown as WorkflowEngineDeps['runArtifacts'],
    projectRoot,
    workflowRunRepository: runRepo,
  } satisfies WorkflowEngineDeps;
}

function engineOpts(): WorkflowEngineOptions {
  return { onCheckpoint: async () => 'approve' };
}

function makeRequest(harness: Harness, workflowRunId: string, workflowParameters: Record<string, unknown>): ExecutionRequest {
  return {
    stepExecutionId: randomUUID(),
    workItemId: harness.executionWiId,
    workflowRunId,
    stepId: '__start__',
    workflowId: 'full-build',
    repositories: [],
    goal: 'P1-R seam proof',
    acceptanceCriteria: [],
    constraints: [],
    permissions: { pushBranch: false, createPr: false, merge: false },
    budget: {},
    workflowParameters,
  } as ExecutionRequest;
}

async function pin1_and_4(): Promise<StepRunContext> {
  console.log('── Pin 1+4: adapter → engine → StepRunContext wiring ──');
  const projectRoot = mkdtempSync(join(tmpdir(), 'p1r-seam-root-'));
  const harness = seededDb();
  const runRepo = harness.runRepo;
  const captured: Captured[] = [];
  const adapter = new StratumAgentAdapter(
    engineDepsWith(stubStepRunner(captured), runRepo, projectRoot),
    engineOpts(),
  );
  const runId = 'p1r-seam-run-1';
  const result = await adapter.execute(makeRequest(harness, runId, FROZEN_PARAMS));
  assert.equal(result.outcome, 'succeeded', `workflow must complete: ${JSON.stringify(result.failure ?? result)}`);

  // every step of full-build reached the stub
  const stepIds = captured.map((c) => c.step.id);
  for (const required of ['design', 'plan', 'test', 'build', 'evaluate', 'summarise']) {
    assert.ok(stepIds.includes(required), `step '${required}' must have executed (got: ${stepIds.join(',')})`);
  }

  // Pin 1 — BUILD receives EXACTLY the frozen policy (allowing/requiring only main.py)
  const buildEntry = captured.find((c) => c.step.id === 'build')!;
  assert.ok(buildEntry.ctx.editPolicy, 'BUILD StepRunContext must carry an editPolicy');
  assert.deepEqual(buildEntry.ctx.editPolicy, FROZEN_POLICY);
  assert.deepEqual(buildEntry.ctx.editPolicy!.allowedEditPaths, [WORKER_PATH]);
  assert.deepEqual(buildEntry.ctx.editPolicy!.requiredEditPaths, [WORKER_PATH]);
  assert.deepEqual(buildEntry.ctx.editPolicy!.appliesToSteps, ['build']);

  // Pin 4 — every other step receives NO policy
  for (const entry of captured) {
    if (entry.step.id === 'build') continue;
    assert.equal(entry.ctx.editPolicy, undefined, `step '${entry.step.id}' must be policy-free`);
  }

  // the frozen policy is persisted in WorkflowRun.resolvedParameters
  const row = runRepo.findById(runId)!;
  assert.ok(row, 'WorkflowRun row must exist');
  assert.deepEqual((row.resolvedParameters as Record<string, unknown>)['editPolicy'], FROZEN_POLICY);

  rmSync(projectRoot, { recursive: true, force: true });
  console.log('   ✓ build ctx.editPolicy === frozen policy; all other steps policy-free; resolvedParameters frozen');
  return buildEntry.ctx.editPolicy!;
}

async function pin5_resume(): Promise<void> {
  console.log('── Pin 5: resume uses exactly the frozen policy ──');
  const projectRoot = mkdtempSync(join(tmpdir(), 'p1r-seam-resume-'));
  const harness = seededDb();
  const runRepo = harness.runRepo;
  const runId = 'p1r-seam-run-resume';

  // Phase 1 — run until 'evaluate' fails; everything before it succeeds.
  const captured1: Captured[] = [];
  const adapter1 = new StratumAgentAdapter(
    engineDepsWith(stubStepRunner(captured1, 'evaluate'), runRepo, projectRoot),
    engineOpts(),
  );
  const r1 = await adapter1.execute(makeRequest(harness, runId, FROZEN_PARAMS));
  assert.equal(r1.outcome, 'failed', 'phase 1 must fail at evaluate');
  assert.ok(captured1.find((c) => c.step.id === 'build')!.ctx.editPolicy, 'phase 1 build carried the policy');

  // Phase 2 — resume with a TAMPERED request policy. The persisted run is
  // authoritative: the tampered policy must not reach ANY step context, and
  // the frozen policy must still bind the resumed steps.
  const TAMPERED = {
    planning_depth: 'deep',
    max_iterations: 99,
    on_cap_hit: 'force_pass',
    editPolicy: {
      appliesToSteps: ['summarise'],
      allowedEditPaths: ['docs/evil.md'],
      requiredEditPaths: [],
    },
  };
  const captured2: Captured[] = [];
  const adapter2 = new StratumAgentAdapter(
    engineDepsWith(stubStepRunner(captured2), runRepo, projectRoot),
    engineOpts(),
  );
  // a resume request names the persisted cursor step (as ResumeService does)
  const resumedRequest = makeRequest(harness, runId, TAMPERED);
  resumedRequest.stepId = runRepo.findById(runId)!.current_step_id;
  const r2 = await adapter2.execute(resumedRequest);
  assert.equal(r2.outcome, 'succeeded', `resume must complete: ${JSON.stringify(r2.failure ?? r2)}`);

  const resumedIds = captured2.map((c) => c.step.id);
  // note: 'snapshot' (kind 'commit') is completed engine-side without the stepRunner
  assert.deepEqual(resumedIds, ['evaluate', 'summarise'], `cursor must resume at evaluate (got: ${resumedIds.join(',')})`);
  for (const entry of captured2) {
    assert.equal(entry.ctx.editPolicy, undefined, `resumed step '${entry.step.id}' must not carry ANY policy (tamper leak)`);
    if (entry.step.id === 'summarise') {
      assert.notDeepEqual(entry.ctx.editPolicy, TAMPERED.editPolicy, 'tampered policy leaked into summarise');
    }
  }
  // and the persisted frozen parameters were never mutated by the resume
  const row = runRepo.findById(runId)!;
  assert.deepEqual((row.resolvedParameters as Record<string, unknown>)['editPolicy'], FROZEN_POLICY);
  assert.equal((row.resolvedParameters as Record<string, unknown>)['planning_depth'], 'minimal');

  rmSync(projectRoot, { recursive: true, force: true });
  console.log('   ✓ resume restored the frozen policy; tampered request policy never leaked; persisted row unchanged');
}

async function pin6_fail_closed(): Promise<void> {
  console.log('── Pin 6: invalid / misspelled policies fail closed ──');
  const projectRoot = mkdtempSync(join(tmpdir(), 'p1r-seam-bad-'));
  const harness = seededDb();
  const runRepo = harness.runRepo;
  const captured: Captured[] = [];
  const adapter = new StratumAgentAdapter(
    engineDepsWith(stubStepRunner(captured), runRepo, projectRoot),
    engineOpts(),
  );

  // (a) shape-malformed policy (missing requiredEditPaths) — rejected at the
  // seam, BEFORE the engine, before any step executes
  await assert.rejects(
    () => adapter.execute(makeRequest(harness, 'p1r-bad-shape', {
      planning_depth: 'minimal',
      editPolicy: { appliesToSteps: ['build'], allowedEditPaths: [WORKER_PATH] },
    })),
    /Invalid workflowParameters\.editPolicy \(requiredEditPaths must be a string array\)/,
  );

  // (b) misspelled appliesToSteps target — shape-valid, refused by the
  // engine's definition-level gate before any step executes
  await assert.rejects(
    () => adapter.execute(makeRequest(harness, 'p1r-bad-target', {
      planning_depth: 'minimal',
      editPolicy: { ...FROZEN_POLICY, appliesToSteps: ['buidl'] },
    })),
    /references unknown workflow step 'buidl'/,
  );

  // no step ran under either malformed policy
  assert.equal(captured.length, 0, 'no step may execute under an invalid policy');

  rmSync(projectRoot, { recursive: true, force: true });
  console.log('   ✓ malformed shape and misspelled target both fail closed; zero steps executed');
}

// ═══════════════════ Harness B: ActionContract, fed by the seam's policy ═══════════════════

const WORKER_ORIGINAL = 'DEFAULT_FAILURE_STAGE = "consume"\n\n\ndef process_document(doc):\n    return doc\n';
const WORKER_PATCHED =
  'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"\n\n\ndef process_document(doc):\n    return doc\n';
const OUTSIDE_CREATE_PATH = 'apps/ai-server/rag-worker-service/failure_payload.py';
const OUTSIDE_CREATE_CONTENT = 'FAILURE_STAGE = "processing"\n';

function makeBuildRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'p1r-build-'));
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER_PATH), WORKER_ORIGINAL);
  execSync('git init -q && git add -A', { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

class RecordingArtifactRepository implements Partial<ArtifactRepository> {
  saved: ArtifactRecord[] = [];
  findByWorkflowRunRefAndHash(_runId: string, ref: string, hash: string): ArtifactRecord | undefined {
    return this.saved.find((r) => r.ref === ref && r.hash === hash);
  }
  listByWorkflowRun(runId: string): ArtifactRecord[] {
    return this.saved.filter((r) => r.workflowRunId === runId);
  }
  save(record: ArtifactRecord): void {
    this.saved.push(record);
  }
}

interface ToolUseShape { type: 'tool_use'; id: string; name: string; input: unknown }

class ScriptedProvider {
  private turn = 0;
  readonly toolResultContents: string[] = [];
  constructor(public script: MultiTurnResult[]) {}
  async complete(): Promise<never> {
    throw new Error('p1r: single-turn path not expected');
  }
  async completeMultiTurn(params: {
    messages: Array<{ role: string; content: unknown }>;
    tools: ReadonlyArray<{ name: string }>;
  }): Promise<MultiTurnResult> {
    const last = params.messages[params.messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      for (const block of last.content as Array<{ type: string; content?: string }>) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          this.toolResultContents.push(block.content);
        }
      }
    }
    return this.script[this.turn++] ?? { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
  }
}

function readSliceTurn(id: string, path: string, startLine = 1, lineCount = 1): MultiTurnResult {
  return {
    stop_reason: 'tool_use',
    text: '',
    tool_uses: [{ type: 'tool_use', id, name: 'read_source_slice', input: { path, startLine, lineCount } }],
    tokens_used: 7,
  };
}

function submitTurn(id: string, proposal: unknown): MultiTurnResult {
  return {
    stop_reason: 'tool_use',
    text: '',
    tool_uses: [{ type: 'tool_use', id, name: SUBMIT_RESULT_TOOL_NAME, input: proposal }],
    tokens_used: 9,
  };
}

function makeBuildRunner(root: string, provider: ScriptedProvider, repository: RecordingArtifactRepository): AgentRunner {
  const cm = new ContextManager(root, DEFAULT_CONFIG);
  return new AgentRunner(
    cm,
    provider as never,
    root,
    { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    {
      model: 'test',
      actionContracts: { [BUILD_CHANGESET_ARTIFACT_TYPE]: createBuildChangesetActionContract() },
    } satisfies Partial<AgentRunnerConfig> as AgentRunnerConfig,
    undefined,
    repository as unknown as ArtifactRepository,
  );
}

function buildCtx(root: string, seamPolicy: unknown): unknown {
  return {
    workflowRunId: 'p1r-seam-run-1', // the SAME run identity harness A froze
    workflowId: 'full-build',
    stepId: 'build',
    iteration: 1,
    revision: 0,
    goal: 'P1-R seam proof — ActionContract binding',
    projectRoot: root,
    instruction: 'Publish the failure-stage fix.',
    actionArtifact: { type: BUILD_CHANGESET_ARTIFACT_TYPE },
    editPolicy: seamPolicy, // the EXACT object the seam/engine produced
  };
}

function mainPyAnchorId(): string {
  const base = sha256(WORKER_ORIGINAL);
  const line1 = 'DEFAULT_FAILURE_STAGE = "consume"';
  return `src_${createHash('sha256').update([WORKER_PATH, base, '1', '1', sha256(line1)].join('\0'), 'utf8').digest('hex').slice(0, 16)}`;
}

async function pin2_and_3(seamPolicy: unknown): Promise<void> {
  console.log('── Pin 2+3: ActionContract validation/publication under the seam policy ──');
  const anchorId = mainPyAnchorId();
  const mainEdit = { anchor_id: anchorId, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' };
  const outsideCreate = { path: OUTSIDE_CREATE_PATH, content: OUTSIDE_CREATE_CONTENT };

  const { root, cleanup } = makeBuildRoot();
  const repository = new RecordingArtifactRepository();
  const provider = new ScriptedProvider([
    readSliceTurn('t1', WORKER_PATH),
    // Turn 2 — anchored main.py edit PLUS a create outside the policy.
    // P2-B: the frozen main.py-only policy leaves zero legal create targets,
    // so the wire surface has NO creates field — this submission cannot even
    // decode (unknown-key rejection naming the key).
    submitTurn('t2', { edits: [mainEdit], creates: [outsideCreate] }),
    // Turn 3 — the repaired proposal in the CANONICAL NARROWED form: edits
    // only, no creates key at all.
    submitTurn('t3', { edits: [mainEdit] }),
  ]);
  try {
    const result = await makeBuildRunner(root, provider, repository).run('builder', buildCtx(root, seamPolicy));
    assert.equal(result.success, true, `repaired proposal must publish: ${result.error}`);

    // Pin 2 — the out-of-policy create was rejected IN-LOOP (repairable) and
    // wrote nothing. Under P2-B the rejection is the decode-layer unknown-key
    // error naming 'creates' (the operation is structurally inexpressible;
    // the authoritative unauthorized-create-path validate check remains as
    // the second gate — pinned by unit P2B.A3).
    const repairFeedback = provider.toolResultContents.find((c) => c.includes('Unrecognized key') && c.includes('creates'));
    assert.ok(repairFeedback, 'the loop must hand the model a repairable rejection for the inexpressible create');
    assert.ok(!existsSync(join(root, OUTSIDE_CREATE_PATH)), 'the rejected create must never touch the tree');
    assert.ok(!repository.saved.some((r) => r.path === OUTSIDE_CREATE_PATH), 'no provenance row for the rejected create');

    // Pin 3 — the main.py-only proposal staged and satisfied requiredEditPaths
    assert.equal(readFileSync(join(root, WORKER_PATH), 'utf-8'), WORKER_PATCHED);
    assert.deepEqual([...result.artifacts_written], [WORKER_PATH]);
    const appliedEdit = repository.saved.find((r) => r.type === 'applied-edit');
    assert.ok(appliedEdit, 'applied-edit provenance recorded');
    assert.equal(appliedEdit!.ref, `applied-edit:build:${WORKER_PATH}`);
    assert.ok(result.anchored_edits!.some((e) => e.op === 'replace' && e.path === WORKER_PATH));
  } finally {
    cleanup();
  }
  console.log('   ✓ out-of-policy create rejected in-loop + repairable + zero writes; main.py-only publish satisfied requiredEditPaths');
}

// ═══════════════════════════════════ run ═══════════════════════════════════

const seamPolicy = await pin1_and_4();
await pin5_resume();
await pin6_fail_closed();
await pin2_and_3(seamPolicy);
console.log('\nALL P1-R SEAM PINS PASS (production-shaped, zero model traffic)');
