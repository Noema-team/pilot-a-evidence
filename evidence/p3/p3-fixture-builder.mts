// P3 BUILD-ENTRY FIXTURE BUILDER — deterministic construction of a legitimate
// BUILD boundary through real Stratum mechanisms, with zero live model traffic.
//
// Method (the a8 pattern, extended one stage):
//   1. instantiate the a8 authority fixture (define WI completed, definition
//      71f1c39c…) into a fresh ROOT/.sle;
//   2. re-install the FROZEN settings bytes (5634b2e8…) AFTER seeding — the
//      P2 defect (seed() overwriting settings) is here neutralized BY ORDER
//      and verified by sha;
//   3. create wi-exec-108 (frozen workflowParameters incl. the main.py-only
//      editPolicy);
//   4. drive the full-build workflow with a SCRIPTED provider that replays
//      the byte-exact P1-R op1 upstream SLE texts (archived, gate-proven
//      under the same frozen code) — every request passes the P3 config
//      guard with per-step frozen expectations (budgets 16384/32768, effort
//      low on test, temperature 0.7, legacy tool set);
//   5. auto-resolve every checkpoint decision with the frozen P1-R regime
//      rationale;
//   6. STOP deterministically when the run cursor reaches 'build' — the
//      BUILD step itself never executes here;
//   7. archive .sle + the work-tree files the upstream steps published into
//      an immutable fixture tgz with a manifest of hashes.
//
// Campaign tooling only — Stratum src/ stays frozen at 9f298f2.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import { ContextManager } from '/home/theo/Documents/coding/repos/stratum/src/context-manager.js';
import { resolveLLMProvider, buildAgentRunner } from '/home/theo/Documents/coding/repos/stratum/src/application.js';
import { RunArtifactManager } from '/home/theo/Documents/coding/repos/stratum/src/run-artifacts.js';
import { AgentStepRunner } from '/home/theo/Documents/coding/repos/stratum/src/execution/agent-step-runner.js';
import { FullBuildStepRunner } from '/home/theo/Documents/coding/repos/stratum/src/execution/full-build-step-runner.js';
import { StratumAgentAdapter } from '/home/theo/Documents/coding/repos/stratum/src/execution/stratum-agent-adapter.js';
import { ExecutorRegistry } from '/home/theo/Documents/coding/repos/stratum/src/execution/registry.js';
import { resolveDefinitionSource } from '/home/theo/Documents/coding/repos/stratum/src/execution/definition-source.js';
import { Scheduler } from '/home/theo/Documents/coding/repos/stratum/src/scheduler/scheduler.js';
import { ResumeService } from '/home/theo/Documents/coding/repos/stratum/src/services/resume-service.js';
import { ScopingService } from '/home/theo/Documents/coding/repos/stratum/src/scoping-service.js';
import { ConfirmService } from '/home/theo/Documents/coding/repos/stratum/src/confirm-service.js';
import { ExecService, ValidationGateService } from '/home/theo/Documents/coding/repos/stratum/src/exec-gate.js';
import { SnapshotService } from '/home/theo/Documents/coding/repos/stratum/src/snapshot-service.js';
import { SummariseService } from '/home/theo/Documents/coding/repos/stratum/src/summarise-service.js';
import { CriticAgent } from '/home/theo/Documents/coding/repos/stratum/src/critic-agent.js';
import { ShardingService } from '/home/theo/Documents/coding/repos/stratum/src/sharding-service.js';
import { LinkIndexManager } from '/home/theo/Documents/coding/repos/stratum/src/link-index.js';
import { TagService } from '/home/theo/Documents/coding/repos/stratum/src/tag-service.js';
import { RuntimeMapManagerImpl, RuntimeMapSchema, createInitialMap } from '/home/theo/Documents/coding/repos/stratum/src/runtime-map.js';
import { dump as dumpYaml, load as loadYaml } from '/home/theo/Documents/coding/repos/stratum/node_modules/js-yaml/dist/js-yaml.mjs';
import { openDatabase } from '/home/theo/Documents/coding/repos/stratum/src/storage/database.js';
import {
  WorkItemRepository, ArtifactRepository, DecisionRepository, WorkflowRunRepository,
  WorkspaceRepository, ProjectRepository, ObjectiveRepository,
} from '/home/theo/Documents/coding/repos/stratum/src/storage/repositories.js';
import type { WorkflowEngineDeps } from '/home/theo/Documents/coding/repos/stratum/src/workflow/engine.js';
import type { MultiTurnParams, MultiTurnResult } from '/home/theo/Documents/coding/repos/stratum/src/agent-loop.js';
import { createConfigGuardProvider, classifyGuardCapture, reconcileCapture, type CaptureClassification, type StepContract } from './config-guard.mts';

const STRATUM = '/home/theo/Documents/coding/repos/stratum';
const ROOT = '/home/theo/Documents/coding/repos/student-platform';
const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const P3 = `${EVIDENCE}/p3`;
const A8_ARCHIVE = `${EVIDENCE}/pilot-a8-sle-archive.tgz`;
const P1R_OP1 = `${EVIDENCE}/p1-r/p1-r-1/91342881-eb32-47ff-8dfb-d8a7115dd371`;
const FROZEN_SETTINGS = `${EVIDENCE}/v11-frozen-config/settings.json`;
const DEFINE_WI = 'wi-define-108-a8';
const EXEC_WI = 'wi-exec-108';
const WORKSPACE_ID = 'ws-pilot-a';
const PROJECT_ID = 'proj-pilot-a';
const OBJECTIVE_ID = 'obj-108';
// C5 — the issue input is PINNED with the qualification sources (evidence/p3/inputs/);
// the ephemeral /tmp copy is no longer consulted.
const ISSUE = `${P3}/inputs/issue-108.json`;
const WORKER_MAIN = 'apps/ai-server/rag-worker-service/main.py';
// frozen task configuration (identical to the P1-R/P2 dispatch shape)
const ATTEMPT19_EDIT_POLICY = {
  appliesToSteps: ['build'],
  allowedEditPaths: [WORKER_MAIN],
  requiredEditPaths: [WORKER_MAIN],
};
const FROZEN_WORKFLOW_PARAMETERS = {
  planning_depth: 'minimal',
  max_iterations: 5,
  on_cap_hit: 'halt',
  definitionSource: { workItemId: DEFINE_WI },
  editPolicy: ATTEMPT19_EDIT_POLICY,
};

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const journal = (entry: Record<string, unknown>): void => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  (globalThis as { __p3Journal?: unknown[] }).__p3Journal = [];
  console.log('[p3]', line);
};

// ─── frozen per-step expectations (from evidence/v11-frozen-config/settings.json) ──
const LEGACY_TOOLS = ['read_file', 'read_source_slice', 'list_directory'] as const;
const FROZEN_TEMPERATURE = 0.7;
const STEP_CONTRACTS: Record<string, (model: string) => StepContract> = {
  'scoping.produce': (m) => ({ stepId: 'scoping.produce', model: m, max_tokens: 16384, temperature: FROZEN_TEMPERATURE, tool_sets: [LEGACY_TOOLS], submit_result: null }),
  design: (m) => ({ stepId: 'design', model: m, max_tokens: 32768, temperature: FROZEN_TEMPERATURE, tool_sets: [LEGACY_TOOLS], submit_result: null }),
  plan: (m) => ({ stepId: 'plan', model: m, max_tokens: 32768, temperature: FROZEN_TEMPERATURE, tool_sets: [LEGACY_TOOLS], submit_result: null }),
  test: (m) => ({ stepId: 'test', model: m, max_tokens: 32768, reasoning_effort: 'low', temperature: FROZEN_TEMPERATURE, tool_sets: [LEGACY_TOOLS], submit_result: null }),
};

// byte-exact archived upstream outputs (P1-R op1 — published under the same frozen code)
const REPLAY_TEXTS: Record<string, string> = {
  'scoping.produce': readFileSync(`${P1R_OP1}/node-outputs/scoping.produce.md`, 'utf-8'),
  design: readFileSync(`${P1R_OP1}/node-outputs/design.md`, 'utf-8'),
  plan: readFileSync(`${P1R_OP1}/node-outputs/plan.md`, 'utf-8'),
  test: readFileSync(`${P1R_OP1}/node-outputs/test.md`, 'utf-8'),
};

function db() {
  return openDatabase(path.join(ROOT, '.sle', 'stratum.db'));
}

// Review round 2 (P2) — the FULL fixture-capture acceptance gate, exported so
// the qualification can regression-test it (a corrupted trailing record must
// fail acceptance even when every call count still reconciles).
export function validateFixtureCapture(capturePath: string, replayCalls: Array<{ step?: string }>): CaptureClassification {
  const cls = classifyGuardCapture(capturePath);
  const discrepancies = reconcileCapture(cls, replayCalls.map((c) => ({ step: c.step })));
  if (discrepancies.length > 0) throw new Error(`fixture capture reconciliation failed: ${discrepancies.join('; ')}`);
  if (cls.stops.length > 0) throw new Error(`fixture capture contains guard STOPs: ${cls.stops.length}`);
  if (cls.g2 || cls.integrity_failures.length > 0) {
    throw new Error(`fixture capture has integrity failures: ${cls.integrity_failures.join(' | ')}`);
  }
  return cls;
}

function seed(defineWi: string): void {
  mkdirSync(path.join(ROOT, '.sle'), { recursive: true });
  // NOTE (P2 forensic lesson): seed() in the P2 driver overwrote the frozen
  // settings here. This builder does NOT write settings at all — the frozen
  // bytes are installed once, below, and verified by sha at every use.
  const mapPath = path.join(ROOT, '.sle', 'map.yaml');
  if (!existsSync(mapPath)) {
    const seededMap = dumpYaml(createInitialMap({
      projectName: 'student-platform', projectType: 'custom',
      codeRemote: { url: 'https://github.com/magtheo/student-platform', branch: 'pilot-a/issue-108' },
      issuesRemote: { type: 'git', url: 'https://github.com/magtheo/student-platform', branch: 'main' },
      docsRemote: { url: 'https://github.com/magtheo/student-platform', pending: true },
      taskStore: { type: 'local' },
      agents: {},
    } as never));
    writeFileSync(mapPath, seededMap, 'utf-8');
    RuntimeMapSchema.parse(loadYaml(seededMap));
  }
  const d = db();
  const now = new Date().toISOString();
  const workspaces = new WorkspaceRepository(d);
  if (!workspaces.findById(WORKSPACE_ID)) workspaces.save({ id: WORKSPACE_ID, name: 'pilot-a', createdAt: now });
  const projects = new ProjectRepository(d);
  if (!projects.findById(PROJECT_ID)) {
    projects.save({ id: PROJECT_ID, workspaceId: WORKSPACE_ID, name: 'student-platform', status: 'active', priority: 0, createdAt: now, updatedAt: now });
  }
  const objectives = new ObjectiveRepository(d);
  const issue = JSON.parse(readFileSync(ISSUE, 'utf8'));
  const body: string = issue.body;
  const criteria = [...body.matchAll(/- \[ \] (.+)/g)].map((m) => m[1]);
  if (!objectives.findById(OBJECTIVE_ID)) {
    objectives.save({
      id: OBJECTIVE_ID, projectId: PROJECT_ID, title: issue.title, description: body,
      priority: 0, status: 'active', constraints: [], successCriteria: criteria,
      createdAt: now, updatedAt: now,
    } as never);
  }
  new WorkItemRepository(d).save({
    id: defineWi, projectId: PROJECT_ID, objectiveId: OBJECTIVE_ID, repositoryIds: [],
    title: issue.title, goal: issue.title, workflowId: 'define-work',
    state: 'ready', priority: 0,
    acceptanceCriteria: criteria, constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  });
  journal({ event: 'p3_seeded', defineWi });
}

function instantiateAuthority(): void {
  rmSync(path.join(ROOT, '.sle'), { recursive: true, force: true });
  const tmp = '/tmp/opencode/p3-a8';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execFileSync('tar', ['-xzf', A8_ARCHIVE, '-C', tmp]);
  seed(DEFINE_WI);
  const d = db();
  const workDir = path.join(ROOT, '.sle', 'work', DEFINE_WI);
  mkdirSync(workDir, { recursive: true });
  for (const f of ['definition.md', 'readiness.md']) {
    writeFileSync(path.join(workDir, f), readFileSync(path.join(tmp, '.sle', 'work', DEFINE_WI, f)));
  }
  const defHash = sha256(path.join(workDir, 'definition.md'));
  if (!defHash.startsWith('71f1c39c97ec')) throw new Error(`fixture authority drift: ${defHash}`);
  const archiveDb = openDatabase(path.join(tmp, '.sle', 'stratum.db'), { readonly: true } as never);
  const archRun = archiveDb.prepare('SELECT * FROM workflow_runs WHERE work_item_id = ?').all(DEFINE_WI) as Array<Record<string, unknown>>;
  const archArtifacts = archiveDb.prepare('SELECT * FROM artifacts WHERE work_item_id = ? ORDER BY created_at').all(DEFINE_WI) as Array<Record<string, unknown>>;
  const archWi = archiveDb.prepare('SELECT * FROM work_items WHERE id = ?').get(DEFINE_WI) as Record<string, unknown>;
  if (archRun.length !== 1 || archArtifacts.length < 2 || !archWi) throw new Error('archive authority incomplete');
  d.prepare("UPDATE work_items SET state='completed', updated_at=? WHERE id=?").run(archWi.updated_at as string, DEFINE_WI);
  const r = archRun[0];
  d.prepare('INSERT INTO workflow_runs (run_id, workflow_id, work_item_id, status, current_step_id, iteration, revision, awaiting_checkpoint, started_at, updated_at, resolved_parameters_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(r.run_id, r.workflow_id, r.work_item_id, r.status, r.current_step_id, r.iteration, r.revision, r.awaiting_checkpoint, r.started_at, r.updated_at, r.resolved_parameters_json ?? '{}');
  for (const a of archArtifacts) {
    d.prepare('INSERT INTO artifacts (id, work_item_id, workflow_run_id, step_execution_id, type, ref, path, hash, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.work_item_id, a.workflow_run_id, a.step_execution_id, a.type, a.ref, a.path, a.hash, a.created_at);
  }
  const defRow = d.prepare('SELECT hash FROM artifacts WHERE type=? AND work_item_id=?').get('definition', DEFINE_WI) as { hash: string };
  const readyRow = d.prepare('SELECT hash FROM artifacts WHERE type=? AND work_item_id=?').get('definition-readiness', DEFINE_WI) as { hash: string };
  if (defRow.hash !== defHash) throw new Error(`definition hash mismatch: artifact ${defRow.hash} vs bytes ${defHash}`);
  journal({ event: 'p3_authority_instantiated', definition_sha256: defHash });
}

function executeWi(defineWi: string): void {
  const d = db();
  const issue = JSON.parse(readFileSync(ISSUE, 'utf8'));
  const now = new Date().toISOString();
  new WorkItemRepository(d).save({
    id: EXEC_WI, projectId: PROJECT_ID, objectiveId: OBJECTIVE_ID, repositoryIds: [],
    title: issue.title, goal: issue.title, workflowId: 'full-build',
    state: 'ready', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [], workflowParameters: FROZEN_WORKFLOW_PARAMETERS,
    createdAt: now, updatedAt: now,
  });
  journal({ event: 'p3_execution_wi_created', wiId: EXEC_WI, workflowParameters: FROZEN_WORKFLOW_PARAMETERS });
}

// ─── scripted replay provider (upstream steps only; zero live traffic) ──────
type Ctx = { workItemId: string; stepId?: string; resolveAnchor?: (id: string) => unknown };
interface ReplayHarness {
  currentStep: () => string | undefined;
  calls: Array<{ step: string | undefined; model: string; max_tokens: number; reasoning_effort?: string; tools: string[] }>;
}

function makeReplayProvider(harness: ReplayHarness, model: string) {
  return {
    async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
      const step = harness.currentStep();
      harness.calls.push({ step, model: params.model, max_tokens: params.max_tokens, reasoning_effort: params.reasoning_effort, tools: params.tools.map((t) => t.name) });
      const text = step ? REPLAY_TEXTS[step] : undefined;
      if (text === undefined) {
        throw new Error(`p3 fixture replay: no scripted text for step ${step} — the BUILD boundary was crossed or a step was misidentified`);
      }
      return { stop_reason: 'end_turn', text, tool_uses: [], tokens_used: 512, wire_observation: { finish_reason: 'stop' } as MultiTurnResult['wire_observation'] };
    },
  };
}

export async function buildFixture(): Promise<Record<string, unknown>> {
  if (!existsSync(ISSUE)) throw new Error(`missing ${ISSUE}`);
  // pre-clean: whatever a previous qualification run left in the work tree
  try { execFileSync('git', ['-C', ROOT, 'checkout', '--', WORKER_MAIN]); } catch { /* pristine already */ }
  for (const f of ['docs/cycle-charter.md', 'docs/requirements.md', 'docs/architecture.md', 'docs/plan.md', 'docs/test-plan.md', 'apps/ai-server/tests/integration/test_worker_failure_payload_contract.py']) {
    try { execFileSync('git', ['-C', ROOT, 'rm', '-fq', f]); } catch { /* not present */ }
  }
  const targetHead = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
  if (!targetHead.startsWith('86ec0871')) throw new Error(`target HEAD ${targetHead} != pristine baseline`);
  instantiateAuthority();
  // frozen settings installed AFTER seeding (P2-defect neutralization by order)
  const frozenBytes = readFileSync(FROZEN_SETTINGS);
  writeFileSync(path.join(ROOT, '.sle', 'settings.json'), frozenBytes);
  const frozenSha = createHash('sha256').update(frozenBytes).digest('hex');
  executeWi(DEFINE_WI);

  const d = db();
  const mapManager = new RuntimeMapManagerImpl({ mapPath: path.join(ROOT, '.sle', 'map.yaml') });
  const runArtifacts = new RunArtifactManager({ projectRoot: ROOT });
  const { provider: liveProvider, model } = resolveLLMProvider(ROOT);
  void liveProvider; // never dialed: the replay provider serves every step

  const harness: ReplayHarness = { currentStep: () => undefined, calls: [] };
  const runRepo = new WorkflowRunRepository(d);
  const replay = makeReplayProvider(harness, model);
  // C1 — the replay guard capture is UNIQUE to this instantiation and lives
  // inside the fixture workspace (archived in the tgz, sha-pinned in the
  // manifest). No append-only shared file exists anymore.
  const instantiationId = randomUUID();
  const captureRel = path.join('.sle', 'p3-captures', instantiationId, 'fixture-replay-guard.jsonl');
  const capturePath = path.join(ROOT, captureRel);
  rmSync(capturePath, { force: true });
  const guard = createConfigGuardProvider(replay, () => {
    const step = harness.currentStep();
    const mk = step ? STEP_CONTRACTS[step] : undefined;
    if (!mk) throw new Error(`config-guard: no frozen contract for step ${step}`);
    return mk(model);
  }, { capturePath, phase: `fixture-replay:${instantiationId}` });

  const artifactRepository = new ArtifactRepository(d);
  const decisionRepository = new DecisionRepository(d);
  const contextManager = new ContextManager(ROOT);
  const agentRunner = buildAgentRunner(contextManager, guard, ROOT, runArtifacts, model, artifactRepository, 16384);
  const agentStepRunner = new AgentStepRunner(agentRunner);
  const scopingService = new ScopingService(agentRunner, mapManager, ROOT, undefined, new TagService(mapManager));
  const confirmService = new ConfirmService(mapManager, runArtifacts);
  const execService = new ExecService(mapManager, runArtifacts);
  const validationGateService = new ValidationGateService(mapManager, runArtifacts);
  const snapshotService = new SnapshotService(mapManager, runArtifacts, ROOT);
  const summariseService = new SummariseService(mapManager, runArtifacts, ROOT);
  const criticAgent = new CriticAgent(guard as never, model);
  const shardingService = new ShardingService(ROOT, new LinkIndexManager(ROOT, mapManager));
  const callbacks = {
    onCheckpoint: async () => 'halt' as const,
    onConfirmGate: async () => 'halt' as const,
    onShardingGate: async () => 'halt' as const,
  };
  const stepRunner = new FullBuildStepRunner({
    agentStepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    criticAgent, confirmService, execService, validationGateService,
    snapshotService, summariseService, shardingService, scopingService,
  }, callbacks);
  const engineDeps: WorkflowEngineDeps = {
    stepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    workflowRunRepository: runRepo, workItemRepository: new WorkItemRepository(d),
  };
  const adapter = new StratumAgentAdapter(engineDeps, { onCheckpoint: async () => 'halt' as const }, artifactRepository);
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const scheduler = new Scheduler(d, WORKSPACE_ID, registry);
  const resumeService = new ResumeService(d, WORKSPACE_ID, registry, {}, undefined, stepRunner);

  harness.currentStep = () => runRepo.listByWorkItem(EXEC_WI)[0]?.current_step_id;

  // drive to the BUILD boundary = the CONFIRM gate LEFT PENDING: resolving
  // confirm synchronously dispatches BUILD (P2 live evidence), so the
  // fixture's boundary state is the pending confirm decision — the same
  // operator authorization point the P1-R/P2 live runs used (resolve3).
  for (let round = 0; round < 60; round++) {
    const pending = decisionRepository.listByWorkItem(EXEC_WI).find((x: { status: string }) => x.status === 'pending');
    if (pending) {
      const cursorNow = runRepo.listByWorkItem(EXEC_WI)[0]?.current_step_id;
      if (cursorNow === 'confirm') {
        journal({ event: 'p3_fixture_confirm_gate_pending', decisionId: pending.id, type: pending.type });
        break;
      }
      journal({ event: 'p3_fixture_decision', decisionId: pending.id, type: pending.type, cursor: cursorNow });
      await resumeService.resume(pending.id, {
        selectedOptionId: 'approve',
        rationale: 'P3 fixture replay: frozen P1-R upstream approval (deterministic fixture construction)',
        resolvedAt: new Date().toISOString(), resolvedBy: 'operator',
      });
      continue;
    }
    const run = runRepo.listByWorkItem(EXEC_WI)[0];
    if (!run) { /* first tick dispatches */ }
    else if (run.current_step_id === 'build') {
      journal({ event: 'p3_fixture_build_boundary_reached', round, cursor: run.current_step_id });
      break;
    } else if (['complete', 'failed'].includes(run.status)) {
      throw new Error(`fixture run terminated early: ${run.status} at ${run.current_step_id}`);
    }
    const dispatches = await scheduler.tick();
    if (dispatches.length === 0 && round > 2) {
      const r2 = runRepo.listByWorkItem(EXEC_WI)[0];
      throw new Error(`fixture replay stalled: no dispatches, run ${r2?.status} at ${r2?.current_step_id}`);
    }
  }

  const run = runRepo.listByWorkItem(EXEC_WI)[0];
  if (run.current_step_id !== 'confirm') throw new Error(`fixture failed to reach the confirm gate (cursor: ${run.current_step_id})`);
  const pendingConfirm = decisionRepository.listByWorkItem(EXEC_WI).find((x: { status: string }) => x.status === 'pending');
  if (!pendingConfirm) throw new Error('fixture boundary invalid: no pending confirm decision');
  const wi = new WorkItemRepository(d).findById(EXEC_WI);

  // work-tree files the upstream steps published
  const published = ['docs/cycle-charter.md', 'docs/requirements.md', 'docs/architecture.md', 'docs/plan.md', 'docs/test-plan.md', 'apps/ai-server/tests/integration/test_worker_failure_payload_contract.py']
    .filter((p) => existsSync(path.join(ROOT, p)));
  const mainSha = sha256(path.join(ROOT, 'apps/ai-server/rag-worker-service/main.py'));
  if (!mainSha.startsWith('7d7718bcbeb2')) throw new Error(`main.py drifted during fixture build: ${mainSha}`);

  // archive the fixture
  mkdirSync(P3, { recursive: true });
  const tgz = `${P3}/p3-build-entry-fixture.tgz`;
  rmSync(tgz, { force: true });
  const fileArgs = ['.sle', ...published];
  execFileSync('tar', ['-czf', tgz, '-C', ROOT, ...fileArgs]);
  const manifest = {
    fixture: 'p3-build-entry-fixture',
    built_at_utc: new Date().toISOString(),
    target_head: targetHead,
    worker_main_sha256: mainSha,
    settings_sha256: frozenSha,
    definition_sha256: sha256(path.join(ROOT, '.sle', 'work', DEFINE_WI, 'definition.md')),
    readiness_sha256: sha256(path.join(ROOT, '.sle', 'work', DEFINE_WI, 'readiness.md')),
    run_cursor: run.current_step_id,
    run_status: run.status,
    pending_confirm_decision_id: pendingConfirm.id,
    run_resolved_parameters: (run as unknown as { resolvedParameters?: Record<string, unknown> }).resolvedParameters ?? {},
    wi_state: wi?.state ?? null,
    replayed_steps: harness.calls.map((c) => ({ step: c.step, max_tokens: c.max_tokens, reasoning_effort: c.reasoning_effort ?? null, tools: c.tools })),
    instantiation_id: instantiationId,
    issue_input: { path: 'evidence/p3/inputs/issue-108.json', sha256: sha256(ISSUE) },
    // C1 — capture identity + EXACT reconciliation against this
    // instantiation's provider calls (the builder fails otherwise)
    guard_capture: (() => {
      const cls = validateFixtureCapture(capturePath, harness.calls);
      const perStep: Record<string, number> = {};
      for (const r of cls.passes) perStep[r.step as string] = (perStep[r.step as string] ?? 0) + 1;
      return {
        path: captureRel,
        sha256: sha256(capturePath),
        phase: `fixture-replay:${instantiationId}`,
        request_count: cls.requests.length,
        pass_count: cls.passes.length,
        stop_count: cls.stops.length,
        response_count: cls.responses.length,
        error_count: cls.errors.length,
        provider_calls_observed: cls.provider_calls_observed,
        integrity_failures: cls.integrity_failures,
        per_step: perStep,
        reconciled_with_replay_calls: true,
      };
    })(),
    published_files: published.map((p) => ({ path: p, sha256: sha256(path.join(ROOT, p)) })),
    fixture_sha256: sha256(tgz),
  };
  writeFileSync(`${P3}/p3-build-entry-fixture-manifest.json`, JSON.stringify(manifest, null, 1) + '\n');
  journal({ event: 'p3_fixture_built', fixture_sha256: manifest.fixture_sha256.slice(0, 12), cursor: run.current_step_id, replayed: harness.calls.length });
  return manifest;
}

const invokedDirectly = process.argv[1]?.replace(/\.mts$/, '.ts') === undefined
  ? false
  : import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const cmd = process.argv[2];
  if (cmd === 'build') {
    await buildFixture();
    console.log('P3 fixture built.');
  } else {
    console.error('usage: p3-fixture-builder.mts build');
    process.exit(2);
  }
}
