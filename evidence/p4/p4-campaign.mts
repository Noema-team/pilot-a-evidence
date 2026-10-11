// P4 CAMPAIGN DRIVER — drives the REAL native two-WorkItem lifecycle
// (define-work -> definitionSource handoff -> full-build upstream to the
// confirm gate) through the frozen Stratum production path, under the P4
// transport guard, with clean per-attempt isolation and charter v1.1 §10
// ledger-driven crash recovery.
//
// Composition discipline (unchanged from P3): this module only WIRES
// approved frozen components — the engine, runners, services, repositories,
// and the definition-source validation are imported from stratum 9f298f2 and
// used exactly as the qualified P3 fixture/runner composition used them. The
// only new logic is the lifecycle drive loop, the checkpoint adjudication
// policy, the readiness assessment input assembly, and evidence packaging.
//
// Clean per-attempt initialization (review correction 4): each attempt wipes
// ROOT/.sle and reinstalls the FROZEN settings bytes from the pinned evidence
// path — the ONLY settings write in this module (L1 code-inspection gate).
// The fresh database means an attempt cannot inherit prior artifacts or
// workflow state. The settings sha is verified by the guard at construction
// and pinned into EVERY captured request (R3).

import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, copyFileSync, appendFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { classifyGuardCapture, ConfigGuardViolation } from '../p3/config-guard.mts';
import { createP4GuardProvider } from './p4-transport-guard.mts';
import {
  loadFrozenSettings, makeContractResolver,
  FROZEN_SETTINGS_PATH, FROZEN_SETTINGS_SHA256,
  type FrozenSettings, type PinnedShapes,
} from './p4-step-contracts.mts';
import { assessReadiness, buildStepRequestsInCapture, type ReadinessAssessment, type UpstreamArtifactRecord } from './p4-readiness.mts';

export const STRATUM = '/home/theo/Documents/coding/repos/stratum';
export const ROOT = '/home/theo/Documents/coding/repos/student-platform';
export const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const WORKER = 'apps/ai-server/rag-worker-service/main.py';
const WORKER_SHA = '7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988';
const TARGET_HEAD = '86ec0871';

export const WORKSPACE_ID = 'ws-pilot-a';
export const PROJECT_ID = 'proj-pilot-a';
export const OBJECTIVE_ID = 'obj-108';
export const DEFINE_WI = 'wi-define-108';
export const EXEC_WI = 'wi-exec-108';
export const MAX_ATTEMPTS = 3;
export const READY_THRESHOLD = 2;

export const FROZEN_EDIT_POLICY = {
  appliesToSteps: ['build'],
  allowedEditPaths: [WORKER],
  requiredEditPaths: [WORKER],
};

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const safeRead = (p: string): string => { try { return readFileSync(p, 'utf-8'); } catch { return ''; } };

// ─── target pristine verification (P3 semantics, read-only) ──────────────────
export function targetPristine(): boolean {
  try {
    const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
    if (!head.startsWith(TARGET_HEAD)) return false;
    if (sha256File(join(ROOT, WORKER)) !== WORKER_SHA) return false;
    const status = execFileSync('git', ['-C', ROOT, 'status', '--porcelain']).toString();
    const unexpected = status.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l !== '?? .sle/');
    return unexpected.length === 0;
  } catch { return false; }
}

// Upstream steps legitimately publish files into the worktree (docs/*.md —
// the P3 fixture's PUBLISHED_UPSTREAM class). After each attempt the campaign
// restores the pristine worktree: untracked non-.sle paths are removed and
// the worker file is re-checked out. Returns false if the worktree cannot be
// restored (→ campaign-terminal, never silent).
export function cleanupTargetWorktree(): boolean {
  try {
    execFileSync('git', ['-C', ROOT, 'checkout', '--', WORKER]);
    const status = execFileSync('git', ['-C', ROOT, 'status', '--porcelain']).toString();
    for (const line of status.split('\n')) {
      const t = line.trim();
      if (t.length === 0 || t === '?? .sle/') continue;
      if (t.startsWith('?? ')) {
        const p = t.slice(3).replace(/\/$/, '');
        if (p === '.sle') continue;
        rmSync(join(ROOT, p), { recursive: true, force: true });
      } else if (t.startsWith(' M ') || t.startsWith('M ') || t.startsWith(' D ') || t.startsWith('D ')) {
        const p = t.slice(3).trim();
        execFileSync('git', ['-C', ROOT, 'checkout', '--', p]);
      } else {
        return false; // staged/index state we do not understand — fail closed
      }
    }
    return targetPristine();
  } catch { return false; }
}

// ─── the ONLY settings write in the campaign path (L1 code-inspection gate) ──
function installFrozenSettings(): void {
  const bytes = readFileSync(FROZEN_SETTINGS_PATH);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== FROZEN_SETTINGS_SHA256) throw new Error(`p4-campaign: frozen settings source drifted: ${sha}`);
  writeFileSync(join(ROOT, '.sle', 'settings.json'), bytes);
}

// seed the initial runtime map (the P3 fixture's seeding, unchanged) — the
// engine's completion path reads .sle/map.yaml even for define-work-only runs
async function seedRuntimeMap(): Promise<void> {
  const mapPath = join(ROOT, '.sle', 'map.yaml');
  if (existsSync(mapPath)) return;
  const { createInitialMap, RuntimeMapSchema } = await import(`${STRATUM}/src/runtime-map.js`);
  const { dump: dumpYaml, load: loadYaml } = await import(`${STRATUM}/node_modules/js-yaml/dist/js-yaml.mjs`);
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

// ─── attempt namespace + seeding (fixture-builder pattern, fresh per attempt)
async function initAttemptNamespace(): Promise<void> {
  rmSync(join(ROOT, '.sle'), { recursive: true, force: true });
  mkdirSync(join(ROOT, '.sle'), { recursive: true });
  installFrozenSettings();
  await seedRuntimeMap();
  const { openDatabase } = await import(`${STRATUM}/src/storage/database.js`);
  const { WorkspaceRepository, ProjectRepository, ObjectiveRepository, WorkItemRepository } = await import(`${STRATUM}/src/storage/repositories.js`);
  const d = openDatabase(join(ROOT, '.sle', 'stratum.db'), {} as never);
  const now = new Date().toISOString();
  new WorkspaceRepository(d).save({ id: WORKSPACE_ID, name: 'pilot-a', createdAt: now } as never);
  new ProjectRepository(d).save({ id: PROJECT_ID, workspaceId: WORKSPACE_ID, name: 'student-platform', status: 'active', priority: 0, createdAt: now, updatedAt: now } as never);
  const issue = JSON.parse(readFileSync(`${EVIDENCE}/p3/inputs/issue-108.json`, 'utf-8')) as { title: string; body: string };
  const criteria = [...issue.body.matchAll(/- \[ \] (.+)/g)].map((m) => m[1]);
  new ObjectiveRepository(d).save({
    id: OBJECTIVE_ID, projectId: PROJECT_ID, title: issue.title, description: issue.body,
    priority: 0, status: 'active', constraints: [], successCriteria: criteria,
    createdAt: now, updatedAt: now,
  } as never);
  new WorkItemRepository(d).save({
    id: DEFINE_WI, projectId: PROJECT_ID, objectiveId: OBJECTIVE_ID, repositoryIds: [],
    title: issue.title, goal: issue.title, workflowId: 'define-work',
    state: 'ready', priority: 0,
    acceptanceCriteria: criteria, constraints: [], requiredEvidence: [],
    dependencies: [], createdAt: now, updatedAt: now,
  } as never);
}

async function createExecWi(d: unknown): Promise<void> {
  const { WorkItemRepository } = await import(`${STRATUM}/src/storage/repositories.js`);
  const issue = JSON.parse(readFileSync(`${EVIDENCE}/p3/inputs/issue-108.json`, 'utf-8')) as { title: string };
  const now = new Date().toISOString();
  new WorkItemRepository(d).save({
    id: EXEC_WI, projectId: PROJECT_ID, objectiveId: OBJECTIVE_ID, repositoryIds: [],
    title: issue.title, goal: issue.title, workflowId: 'full-build',
    state: 'ready', priority: 0,
    acceptanceCriteria: [], constraints: [], requiredEvidence: [],
    dependencies: [],
    workflowParameters: {
      planning_depth: 'minimal',
      max_iterations: 5,
      on_cap_hit: 'halt',
      definitionSource: { workItemId: DEFINE_WI },
      editPolicy: FROZEN_EDIT_POLICY,
    },
    createdAt: now, updatedAt: now,
  } as never);
}

// ─── production stack (the qualified composition; provider arrives guarded) ──
interface ActiveStepRef { workflowId: string | null; stepId: string | null }

interface Stack {
  active: ActiveStepRef;
  tick: () => Promise<unknown[]>;
  resume: (pendingId: string, resolution: unknown) => Promise<unknown>;
  runRow: (wiId: string) => Record<string, unknown> | undefined;
  pendingDecisions: (wiId: string) => Array<Record<string, unknown>>;
  artifacts: (wiId: string) => Array<Record<string, unknown>>;
  wi: (wiId: string) => Record<string, unknown> | undefined;
  db: unknown;
}

async function buildStack(guardedProvider: unknown, active: ActiveStepRef): Promise<Stack> {
  const { buildAgentRunner } = await import(`${STRATUM}/src/application.js`);
  const { RunArtifactManager } = await import(`${STRATUM}/src/run-artifacts.js`);
  const { AgentStepRunner } = await import(`${STRATUM}/src/execution/agent-step-runner.js`);
  const { FullBuildStepRunner } = await import(`${STRATUM}/src/execution/full-build-step-runner.js`);
  const { StratumAgentAdapter } = await import(`${STRATUM}/src/execution/stratum-agent-adapter.js`);
  const { ExecutorRegistry } = await import(`${STRATUM}/src/execution/registry.js`);
  const { ResumeService } = await import(`${STRATUM}/src/services/resume-service.js`);
  const { ScopingService } = await import(`${STRATUM}/src/scoping-service.js`);
  const { ConfirmService } = await import(`${STRATUM}/src/confirm-service.js`);
  const { ExecService, ValidationGateService } = await import(`${STRATUM}/src/exec-gate.js`);
  const { SnapshotService } = await import(`${STRATUM}/src/snapshot-service.js`);
  const { SummariseService } = await import(`${STRATUM}/src/summarise-service.js`);
  const { ShardingService } = await import(`${STRATUM}/src/sharding-service.js`);
  const { LinkIndexManager } = await import(`${STRATUM}/src/link-index.js`);
  const { TagService } = await import(`${STRATUM}/src/tag-service.js`);
  const { RuntimeMapManagerImpl } = await import(`${STRATUM}/src/runtime-map.js`);
  const { CriticAgent } = await import(`${STRATUM}/src/critic-agent.js`);
  const { Scheduler } = await import(`${STRATUM}/src/scheduler/scheduler.js`);
  const { openDatabase } = await import(`${STRATUM}/src/storage/database.js`);
  const { WorkItemRepository, ArtifactRepository, DecisionRepository, WorkflowRunRepository } = await import(`${STRATUM}/src/storage/repositories.js`);
  const { ContextManager } = await import(`${STRATUM}/src/context-manager.js`);

  const d = openDatabase(join(ROOT, '.sle', 'stratum.db'), {} as never);
  const mapManager = new RuntimeMapManagerImpl({ mapPath: join(ROOT, '.sle', 'map.yaml') });
  const runArtifacts = new RunArtifactManager({ projectRoot: ROOT });
  const model = (JSON.parse(readFileSync(join(ROOT, '.sle', 'settings.json'), 'utf-8')) as { model: string }).model;
  const artifactRepository = new ArtifactRepository(d);
  const contextManager = new ContextManager(ROOT);
  const agentRunner = buildAgentRunner(contextManager, guardedProvider, ROOT, runArtifacts, model, artifactRepository, 16384);
  const agentStepRunner = new AgentStepRunner(agentRunner);
  const scopingService = new ScopingService(agentRunner, mapManager, ROOT, undefined, new TagService(mapManager));
  const confirmService = new ConfirmService(mapManager, runArtifacts);
  const execService = new ExecService(mapManager, runArtifacts);
  const validationGateService = new ValidationGateService(mapManager, runArtifacts);
  const snapshotService = new SnapshotService(mapManager, runArtifacts, ROOT);
  const summariseService = new SummariseService(mapManager, runArtifacts, ROOT);
  const criticAgent = new CriticAgent(guardedProvider as never, model);
  const shardingService = new ShardingService(ROOT, new LinkIndexManager(ROOT, mapManager));
  // ALL gates halt: every engine checkpoint materializes a pending decision
  // row; the drive loop adjudicates per the preregistered determinate policy.
  const halt = { onCheckpoint: async () => 'halt' as const, onConfirmGate: async () => 'halt' as const, onShardingGate: async () => 'halt' as const };
  const innerRunner = new FullBuildStepRunner({
    agentStepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    criticAgent, confirmService, execService, validationGateService,
    snapshotService, summariseService, shardingService, scopingService,
  }, halt);
  // pin the EXECUTING step at the stepRunner boundary — the guard's contract
  // resolver reads this at provider-call time, so the active view is exact
  // (not a cursor approximation) for every wire call inside the step. All
  // other stepRunner members (checkpoint resolution seam, commit/execute
  // handlers) forward to the inner runner unchanged — ResumeService resolves
  // checkpoints THROUGH this object.
  const stepRunner = new Proxy(innerRunner as object, {
    get(target, prop, receiver) {
      if (prop === 'run') {
        return async (step: { id: string }, ctx: { workflowId: string; stepId: string }): Promise<unknown> => {
          active.workflowId = String(ctx.workflowId);
          active.stepId = String(ctx.stepId);
          return (target as { run: (s: unknown, c: unknown) => Promise<unknown> }).run(step, ctx);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const engineDeps = {
    stepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    workflowRunRepository: new WorkflowRunRepository(d), workItemRepository: new WorkItemRepository(d),
  };
  const adapter = new StratumAgentAdapter(engineDeps, { onCheckpoint: async () => 'halt' as const }, artifactRepository);
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const scheduler = new Scheduler(d, WORKSPACE_ID, registry);
  const resumeService = new ResumeService(d, WORKSPACE_ID, registry, {}, undefined, stepRunner as never);

  const runRepo = new WorkflowRunRepository(d);
  const decisions = new DecisionRepository(d);
  const refresh = (): void => {
    // lazily refreshed from whichever run is executing; the guard's contract
    // resolver and the scripted providers read this at call time
    for (const wiId of [DEFINE_WI, EXEC_WI]) {
      const run = (runRepo.listByWorkItem(wiId) as Array<Record<string, unknown>>)[0];
      if (run && run.status === 'running') {
        active.workflowId = String(run.workflow_id);
        active.stepId = run.current_step_id != null ? String(run.current_step_id) : active.stepId;
        return;
      }
    }
    const any = (runRepo.listByWorkItem(DEFINE_WI) as Array<Record<string, unknown>>)[0]
      ?? (runRepo.listByWorkItem(EXEC_WI) as Array<Record<string, unknown>>)[0];
    if (any) {
      active.workflowId = String(any.workflow_id);
      active.stepId = any.current_step_id != null ? String(any.current_step_id) : active.stepId;
    }
  };
  return {
    active,
    tick: async () => { refresh(); return (scheduler.tick() as Promise<unknown[]>); },
    resume: async (pendingId, resolution) => { refresh(); return resumeService.resume(pendingId, resolution); },
    runRow: (wiId) => (runRepo.listByWorkItem(wiId) as Array<Record<string, unknown>>)[0],
    pendingDecisions: (wiId) => (decisions.listByWorkItem(wiId) as Array<Record<string, unknown>>).filter((x) => x.status === 'pending'),
    artifacts: (wiId) => d.prepare('SELECT * FROM artifacts WHERE work_item_id = ? ORDER BY created_at').all(wiId) as Array<Record<string, unknown>>,
    wi: (wiId) => new WorkItemRepository(d).findById(wiId) as Record<string, unknown> | undefined,
    db: d,
  };
}

// ─── guard composition ───────────────────────────────────────────────────────
export function composeAttemptProvider(
  frozen: FrozenSettings,
  shapes: PinnedShapes,
  active: ActiveStepRef,
  innerProvider: unknown,
  attemptId: string,
  opts?: { captureToolSchemas?: boolean },
): { provider: unknown; capturePath: string } {
  const capturePath = join(ROOT, '.sle', 'p4-captures', attemptId, 'guard-capture.jsonl');
  const provider = createP4GuardProvider(innerProvider as object, makeContractResolver(frozen, shapes, active), {
    capturePath,
    phase: `p4-attempt:${attemptId}`,
    settingsPath: join(ROOT, '.sle', 'settings.json'),
    expectedSettingsSha256: FROZEN_SETTINGS_SHA256,
    captureToolSchemas: opts?.captureToolSchemas,
  });
  return { provider, capturePath };
}

// ─── the lifecycle drive loop ────────────────────────────────────────────────
export type DriveOutcome =
  | { kind: 'BOUNDARY' }       // confirm gate pending — the endpoint
  | { kind: 'HUMAN_DECISION' } // define-work halted at human-decision-checkpoint
  | { kind: 'COMPLETE' }
  | { kind: 'FAILED'; detail: string }
  | { kind: 'STALLED'; detail: string };

const APPROVE_RESOLUTION = (why: string) => ({
  selectedOptionId: 'approve',
  rationale: why,
  resolvedAt: new Date().toISOString(),
  resolvedBy: 'campaign-policy',
});

export async function driveWorkflow(stack: Stack, wiId: string, phase: 'define' | 'exec', adjudicated: string[]): Promise<DriveOutcome> {
  for (let round = 0; round < 400; round++) {
    const run = stack.runRow(wiId);
    if (run) {
      const status = String(run.status);
      if (status === 'complete') return { kind: 'COMPLETE' };
      if (status === 'failed') return { kind: 'FAILED', detail: `run failed at ${String(run.current_step_id)}` };
      // 'halted' with NO pending decision = a step-failure halt (the A9-style
      // clean halt) — the attempt ends NOT-READY via the caller's FAILED path
      if (status === 'halted' && stack.pendingDecisions(wiId).length === 0) {
        return { kind: 'FAILED', detail: `run halted without a pending decision at ${String(run.current_step_id)}` };
      }
    }
    const pending = stack.pendingDecisions(wiId);
    if (pending.length > 0) {
      const cursor = run && run.current_step_id != null ? String(run.current_step_id) : null;
      const p = pending[0] as { id: string };
      if (phase === 'define' && cursor === 'human-decision-checkpoint') {
        return { kind: 'HUMAN_DECISION' }; // NEVER synthetically approved
      }
      if (phase === 'exec') {
        if (cursor === 'confirm') return { kind: 'BOUNDARY' };
        if (cursor === 'scoping.checkpoint' || cursor === 'sharding_approval') {
          await stack.resume(p.id, APPROVE_RESOLUTION(`P4 preregistered determinate policy: ${cursor} approved (well-formed decision, guards passed)`));
          adjudicated.push(String(cursor));
          continue;
        }
      }
      return { kind: 'STALLED', detail: `pending decision at unexpected cursor ${String(cursor)} (${phase})` };
    }
    const dispatches = await stack.tick();
    if ((!dispatches || dispatches.length === 0) && round > 4) {
      const r = stack.runRow(wiId);
      if (r && ['complete', 'failed'].includes(String(r.status))) continue;
      return { kind: 'STALLED', detail: `no dispatches; run ${r ? `${String(r.status)}@${String(r.current_step_id)}` : 'absent'}` };
    }
  }
  return { kind: 'STALLED', detail: 'round cap exceeded' };
}

// ─── readiness input assembly (all I/O happens here, not in the assessor) ────
async function assembleReadinessInput(stack: Stack, adjudicated: string[], boundaryRefusals: number) {
  const { parseDefinition } = await import(`${STRATUM}/src/workflow/methodology/definition-artifact.js`);
  const { parseReadinessArtifact } = await import(`${STRATUM}/src/workflow/methodology/readiness-artifact.js`);
  const { resolveDefinitionSource } = await import(`${STRATUM}/src/execution/definition-source.js`);
  const { WorkItemRepository, ArtifactRepository } = await import(`${STRATUM}/src/storage/repositories.js`);
  const frozen = loadFrozenSettings();

  const defineRun = stack.runRow(DEFINE_WI) ?? { status: 'absent', current_step_id: null };
  const execRun = stack.runRow(EXEC_WI) ?? { status: 'absent', current_step_id: null, awaiting_checkpoint: null };
  const defineWi = stack.wi(DEFINE_WI) ?? { state: 'absent' };

  const defPath = join(ROOT, '.sle', 'work', DEFINE_WI, 'definition.md');
  const readyPath = join(ROOT, '.sle', 'work', DEFINE_WI, 'readiness.md');
  const definitionText = safeRead(defPath);
  const readinessText = safeRead(readyPath);

  let definitionParse: { ok: boolean; errorCode?: string; detail?: string } = { ok: false, errorCode: 'MISSING', detail: 'definition.md absent' };
  if (definitionText) {
    try { parseDefinition(definitionText); definitionParse = { ok: true }; }
    catch (e) { definitionParse = { ok: false, errorCode: 'PARSE', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) }; }
  }
  let finalReadiness: { parseError: string | null; gaps: unknown[] } = { parseError: 'readiness.md absent', gaps: [] };
  if (readinessText) {
    try { finalReadiness = { parseError: null, gaps: parseReadinessArtifact(readinessText).readiness.gaps as unknown[] }; }
    catch (e) { finalReadiness = { parseError: e instanceof Error ? e.message.slice(0, 200) : String(e), gaps: [] }; }
  }

  // storage-provenanced artifacts: definition + every exec-side produce output
  const upstreamArtifacts: UpstreamArtifactRecord[] = [];
  const defRows = stack.artifacts(DEFINE_WI).filter((a) => String(a.type) === 'definition');
  const defRow = defRows[defRows.length - 1] as { path: string; hash: string } | undefined;
  upstreamArtifacts.push({
    stepId: 'define-work', artifactType: 'definition',
    ref: defRow ? String(defRow.hash) : 'missing-row', path: defPath,
    existsOnDisk: existsSync(defPath),
    diskSha256: existsSync(defPath) ? sha256File(defPath) : null,
    storageHash: defRow ? String(defRow.hash) : null,
    bytes: Buffer.byteLength(definitionText), nonEmpty: definitionText.length > 0,
  });
  for (const type of ['scoping', 'design', 'plan', 'test', 'documentation']) {
    const rows = stack.artifacts(EXEC_WI).filter((a) => String(a.type) === type);
    const row = rows[rows.length - 1] as { path: string; hash: string } | undefined;
    if (!row) continue;
    const p = join(ROOT, String(row.path));
    const txt = safeRead(p);
    upstreamArtifacts.push({
      stepId: type, artifactType: type, ref: String(row.hash), path: p,
      existsOnDisk: existsSync(p), diskSha256: existsSync(p) ? sha256File(p) : null,
      storageHash: String(row.hash), bytes: Buffer.byteLength(txt), nonEmpty: txt.length > 0,
    });
  }

  const humanDecisionArtifactExists = stack.artifacts(DEFINE_WI).some((a) => String(a.type) === 'decision-request')
    || existsSync(join(ROOT, '.sle', 'work', DEFINE_WI, 'decision-request.json'));
  const explorationArtifactExists = stack.artifacts(DEFINE_WI).some((a) => String(a.type) === 'exploration-need')
    || existsSync(join(ROOT, '.sle', 'work', DEFINE_WI, 'exploration-need.md'));

  const execWi = stack.wi(EXEC_WI) ?? {};
  const wfParams = (execWi.workflowParameters ?? {}) as { definitionSource?: unknown; editPolicy?: Record<string, unknown> | null };
  let definitionSourceResolution: { ok: boolean; failureCode?: string; failureMessage?: string; resolvedSha256?: string; resolvedBytes?: number } = { ok: false, failureCode: 'NOT_RESOLVED', failureMessage: 'not attempted' };
  try {
    const res = await resolveDefinitionSource(
      wfParams.definitionSource, { workItemId: EXEC_WI },
      { workItemRepository: new WorkItemRepository(stack.db as never), artifactRepository: new ArtifactRepository(stack.db as never), projectRoot: ROOT },
    ) as
      | { ok: true; value: { sha256: string; content: string } }
      | { ok: false; failure: { code: string; message: string } };
    if (res.ok) definitionSourceResolution = { ok: true, resolvedSha256: res.value.sha256, resolvedBytes: Buffer.byteLength(res.value.content) };
    else definitionSourceResolution = { ok: false, failureCode: res.failure.code, failureMessage: res.failure.message.slice(0, 200) };
  } catch (e) {
    definitionSourceResolution = { ok: false, failureCode: 'THREW', failureMessage: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }

  return {
    input: {
      execRun: { status: String(execRun.status), current_step_id: execRun.current_step_id == null ? null : String(execRun.current_step_id), awaiting_checkpoint: execRun.awaiting_checkpoint },
      pendingConfirm: (stack.pendingDecisions(EXEC_WI)[0] as { id: string; type: string } | undefined) ?? null,
      intermediateDecisions: adjudicated.map((s) => ({ stepId: s, how: 'approve-policy' as const })),
      boundaryRefusals,
      buildStepRequestsInCapture: buildStepRequestsInCapture(captureOf()),
      defineRun: { status: String(defineRun.status), current_step_id: defineRun.current_step_id == null ? null : String(defineRun.current_step_id) },
      defineWiState: String(defineWi.state),
      definitionParse,
      finalReadiness,
      humanDecisionArtifactExists,
      explorationArtifactExists,
      definitionSourceResolution,
      upstreamArtifacts,
      frozenSettingsSha256: FROZEN_SETTINGS_SHA256,
      frozenModel: frozen.model,
      globalMaxTokens: frozen.globalMaxTokens,
      budgetOf: frozen.budgetFor,
      effortOf: frozen.effortFor,
      editPolicy: (wfParams.editPolicy as { appliesToSteps: string[]; allowedEditPaths: string[]; requiredEditPaths: string[] } | null) ?? null,
      frozenEditPolicy: FROZEN_EDIT_POLICY,
      capture: captureOf(),
    },
    definitionText,
    readinessText,
  };
}

// the caller binds the attempt's capture classifier; module-level indirection
// keeps assembleReadinessInput signature simple
let captureOf: () => ReturnType<typeof classifyGuardCapture> = () => { throw new Error('capture classifier not bound'); };

// ─── the definitionSource handoff gate (mechanical, correction 2) ────────────
// The completed source WorkItem does NOT qualify as ready merely because its
// artifact parses and resolves: the campaign refuses the WorkService
// completion unless the FINAL definition-readiness outcome is a PASS and no
// HUMAN_DECISION / EXPLORE_AS_WORK route artifact exists.
async function evaluateHandoffGate(stack: Stack): Promise<{ ok: boolean; failureClass: string | null; detail: string }> {
  const { parseReadinessArtifact } = await import(`${STRATUM}/src/workflow/methodology/readiness-artifact.js`);
  const readyText = safeRead(join(ROOT, '.sle', 'work', DEFINE_WI, 'readiness.md'));
  if (!readyText) return { ok: false, failureClass: 'authority-invalid', detail: 'readiness.md absent at handoff' };
  let gaps = 0;
  try { gaps = parseReadinessArtifact(readyText).readiness.gaps.length; } catch (e) {
    return { ok: false, failureClass: 'authority-invalid', detail: `readiness.md unparseable: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
  }
  if (gaps !== 0) return { ok: false, failureClass: null, detail: `final readiness verdict is not a clean pass (${gaps} classified gaps — route outcome preserved for assessment)` };
  const human = stack.artifacts(DEFINE_WI).some((a) => String(a.type) === 'decision-request') || existsSync(join(ROOT, '.sle', 'work', DEFINE_WI, 'decision-request.json'));
  if (human) return { ok: false, failureClass: 'definition-human-decision-required', detail: 'decision-request artifact exists — HUMAN_DECISION is never synthetically approved' };
  const explore = stack.artifacts(DEFINE_WI).some((a) => String(a.type) === 'exploration-need') || existsSync(join(ROOT, '.sle', 'work', DEFINE_WI, 'exploration-need.md'));
  if (explore) return { ok: false, failureClass: 'definition-exploration-required', detail: 'exploration-need artifact exists — EXPLORE_AS_WORK is never synthetically resolved' };
  const pending = stack.pendingDecisions(DEFINE_WI);
  if (pending.length > 0) return { ok: false, failureClass: 'malformed-state', detail: `${pending.length} pending decisions on the define WI at handoff` };
  return { ok: true, failureClass: null, detail: 'final readiness PASS, no HUMAN_DECISION/EXPLORE_AS_WORK artifacts, no pending decisions' };
}

// ─── per-attempt evidence package ────────────────────────────────────────────
export interface AttemptRecord {
  attemptId: string;
  index: number;
  outcome: 'READY' | 'NOT-READY' | 'STOPPED' | 'INCOMPLETE';
  failureClass: string | null;
  stopDetail: string | null;
  evaluable: boolean;
  capturePath: string;
  evidencePackagePath: string | null;
  evidencePackageSha256: string | null;
  assessment: ReadinessAssessment | null;
}

async function archiveAttempt(evidenceDir: string, rec: AttemptRecord, stack: Stack, assessment: ReadinessAssessment | null, definitionText: string, readinessText: string): Promise<{ dir: string; sha256: string }> {
  const dir = join(evidenceDir, `attempt-${rec.index}-${rec.attemptId}`);
  if (existsSync(dir)) throw new Error(`attempt evidence package already exists (immutable): ${dir}`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(rec.capturePath)) throw new Error('guard capture missing at archive time');
  copyFileSync(rec.capturePath, join(dir, 'guard-capture.jsonl'));
  const d = stack.db as { prepare: (s: string) => { all: (...a: unknown[]) => Array<Record<string, unknown>> } };
  const dbExport: Record<string, unknown> = {};
  for (const t of ['work_items', 'workflow_runs', 'decisions', 'artifacts', 'step_executions', 'events']) {
    try { dbExport[t] = d.prepare(`SELECT * FROM ${t}`).all(); } catch { dbExport[t] = `table unavailable: ${t}`; }
  }
  writeFileSync(join(dir, 'db-records.json'), JSON.stringify(dbExport, null, 2));
  writeFileSync(join(dir, 'readiness-assessment.json'), JSON.stringify(assessment ?? { note: 'no assessment (STOP before assessable state)' }, null, 2));
  const srcWork = join(ROOT, '.sle', 'work');
  if (existsSync(srcWork)) copyDir(srcWork, join(dir, 'sle-work'));
  const upstreamFilesDir = join(dir, 'upstream-files');
  for (const doc of ['docs/cycle-charter.md', 'docs/requirements.md', 'docs/architecture.md', 'docs/plan.md', 'docs/test-plan.md']) {
    const p = join(ROOT, doc);
    if (existsSync(p)) { mkdirSync(join(upstreamFilesDir, dirname(doc)), { recursive: true }); copyFileSync(p, join(upstreamFilesDir, doc)); }
  }
  if (definitionText) writeFileSync(join(dir, 'definition.md'), definitionText);
  if (readinessText) writeFileSync(join(dir, 'readiness.md'), readinessText);
  const manifest = {
    attemptId: rec.attemptId, index: rec.index, outcome: rec.outcome, failureClass: rec.failureClass,
    target_pristine: targetPristine(), archived_at_utc: new Date().toISOString(),
    capture_sha256: sha256File(join(dir, 'guard-capture.jsonl')),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (sha256File(join(dir, 'guard-capture.jsonl')) !== manifest.capture_sha256) throw new Error('evidence self-verification failed');
  return { dir, sha256: manifest.capture_sha256 };
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name); const t = join(dest, e.name);
    if (e.isDirectory()) copyDir(s, t); else copyFileSync(s, t);
  }
}

// ─── one attempt: the full two-WorkItem lifecycle ────────────────────────────
export async function runP4Attempt(
  index: number,
  innerProvider: unknown,
  evidenceDir: string,
  shapes: PinnedShapes,
  opts?: { captureToolSchemas?: boolean; onActive?: (active: ActiveStepRef) => void },
): Promise<AttemptRecord> {
  const attemptId = randomUUID();
  const frozen = loadFrozenSettings();

  if (!targetPristine()) {
    return { attemptId, index, outcome: 'STOPPED', failureClass: 'target-not-pristine', stopDetail: 'target worktree not pristine at attempt start', evaluable: false, capturePath: '', evidencePackagePath: null, evidencePackageSha256: null, assessment: null };
  }
  await initAttemptNamespace();

  const active: ActiveStepRef = { workflowId: null, stepId: null };
  const { provider, capturePath } = composeAttemptProvider(frozen, shapes, active, innerProvider, attemptId, opts);
  opts?.onActive?.(active); // L1 scripted providers bind to the live step view
  captureOf = () => classifyGuardCapture(capturePath);

  const guardStop = (detail: string): AttemptRecord => ({
    attemptId, index, outcome: 'STOPPED', failureClass: 'guard-stop', stopDetail: detail,
    evaluable: false, capturePath, evidencePackagePath: null, evidencePackageSha256: null, assessment: null,
  });

  let stack: Stack;
  try {
    stack = await buildStack(provider, active);
  } catch (e) {
    if (e instanceof ConfigGuardViolation) return guardStop(e.message);
    throw e;
  }
  const adjudicated: string[] = [];
  let boundaryRefusals = 0;

  const archive = async (rec: AttemptRecord, assessment: ReadinessAssessment | null): Promise<AttemptRecord> => {
    let out: AttemptRecord;
    try {
      const pkg = await archiveAttempt(evidenceDir, rec, stack, assessment, safeRead(join(ROOT, '.sle', 'work', DEFINE_WI, 'definition.md')), safeRead(join(ROOT, '.sle', 'work', DEFINE_WI, 'readiness.md')));
      out = { ...rec, evidencePackagePath: pkg.dir, evidencePackageSha256: pkg.sha256 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out = { ...rec, outcome: 'STOPPED' as const, failureClass: 'evidence-archive-failure', stopDetail: `archive failed (${msg}); original stopDetail: ${rec.stopDetail ?? 'none'}`, evaluable: false };
    }
    // the package is sealed — restore the pristine worktree for the next
    // attempt; a restoration failure is campaign-terminal (never silent)
    if (!cleanupTargetWorktree()) {
      return { ...out, outcome: 'STOPPED' as const, failureClass: 'worktree-restore-failure', stopDetail: `worktree could not be restored to pristine after the attempt (stopDetail: ${out.stopDetail ?? 'none'})`, evaluable: false };
    }
    return out;
  };

  // drive with procedure-class handling: guard violations = STOP (consume
  // nothing); unexpected engine errors = INCOMPLETE (§10: archived as
  // interrupted, never classified, resume continues the terminal condition).
  // NOTE: the engine catches step-level provider exceptions and records them
  // as step failures — so a guard STOP that fired mid-step surfaces as a
  // FAILED drive, not a thrown violation. The campaign therefore derives the
  // STOP from the CAPTURE (any g1 STOP record = campaign-terminal, wherever
  // it surfaced), never from the exception path alone.
  const drive = async (wiId: string, phase: 'define' | 'exec'): Promise<DriveOutcome | { kind: 'GUARD_STOP'; detail: string } | { kind: 'INTERRUPTED'; detail: string }> => {
    try {
      return await driveWorkflow(stack, wiId, phase, adjudicated);
    } catch (e) {
      if (e instanceof ConfigGuardViolation) return { kind: 'GUARD_STOP', detail: e.message };
      return { kind: 'INTERRUPTED', detail: e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : String(e) };
    }
  };

  // ── phase 1: define-work ────────────────────────────────────────────────────
  const defineOutcome = await drive(DEFINE_WI, 'define');

  if (defineOutcome.kind === 'GUARD_STOP') return guardStop(defineOutcome.detail);
  {
    const cls = captureOf();
    if (cls.g1 || cls.g2) {
      const detail = cls.g1
        ? `guard STOP record(s) in capture during define: ${JSON.stringify(cls.stops.map((s) => ({ step: s.step, wire: s.wire, violations: (s.violations as string[] | undefined)?.slice(0, 2) })))}`
        : `G2 capture-integrity failure during define: ${JSON.stringify(cls.integrity_failures.slice(0, 3))}`;
      return archive(guardStop(detail), null);
    }
  }
  if (defineOutcome.kind === 'INTERRUPTED') {
    return archive({ attemptId, index, outcome: 'INCOMPLETE', failureClass: null, stopDetail: defineOutcome.detail, evaluable: false, capturePath, evidencePackagePath: null, evidencePackageSha256: null, assessment: null }, null);
  }
  if (defineOutcome.kind !== 'COMPLETE') {
    let assessment: ReadinessAssessment | null = null;
    try { assessment = assessReadiness((await assembleReadinessInput(stack, adjudicated, boundaryRefusals)).input); } catch { assessment = null; }
    const failureClass = assessment?.failureClass
      ?? (defineOutcome.kind === 'HUMAN_DECISION' ? 'definition-human-decision-required'
        : defineOutcome.kind === 'FAILED' ? 'workflow-abandoned' : 'malformed-state');
    return archive({ attemptId, index, outcome: 'NOT-READY', failureClass, stopDetail: JSON.stringify(defineOutcome), evaluable: true, capturePath, evidencePackagePath: null, evidencePackageSha256: null, assessment }, assessment);
  }

  // ── phase 1.5: the authoritative definitionSource handoff ───────────────────
  // The engine left the define WI 'in_review' (run complete). The campaign
  // completes it through the EXISTING WorkService transition (the same
  // production act the control plane performs) — but ONLY after the
  // mechanical gate passes: final readiness verdict PASS (gaps empty), no
  // decision-request artifact (HUMAN_DECISION never occurred), no
  // exploration-need artifact (EXPLORE_AS_WORK never occurred), no pending
  // decisions. A failed gate refuses completion and classifies the attempt
  // NOT-READY — an unresolved semantic human question is NEVER approved.
  const handoffGate = await evaluateHandoffGate(stack);
  if (!handoffGate.ok) {
    let assessment: ReadinessAssessment | null = null;
    try { assessment = assessReadiness((await assembleReadinessInput(stack, adjudicated, boundaryRefusals)).input); } catch { assessment = null; }
    const failureClass = assessment?.failureClass ?? handoffGate.failureClass;
    return archive({ attemptId, index, outcome: 'NOT-READY', failureClass, stopDetail: `handoff gate refused: ${handoffGate.detail}`, evaluable: true, capturePath, evidencePackagePath: null, evidencePackageSha256: null, assessment }, assessment);
  }
  const { WorkService } = await import(`${STRATUM}/src/services/work-service.js`);
  new WorkService(stack.db as never, WORKSPACE_ID).complete({ workItemId: DEFINE_WI });

  // ── phase 2: definitionSource handoff + full-build upstream ─────────────────
  await createExecWi(stack.db);
  const execOutcome = await drive(EXEC_WI, 'exec');

  if (execOutcome.kind === 'GUARD_STOP') return guardStop(execOutcome.detail);
  {
    const cls = captureOf();
    if (cls.g1 || cls.g2) {
      const detail = cls.g1
        ? `guard STOP record(s) in capture during exec: ${JSON.stringify(cls.stops.map((x) => ({ step: x.step, wire: x.wire, violations: (x.violations as string[] | undefined)?.slice(0, 2) })))}`
        : `G2 capture-integrity failure during exec: ${JSON.stringify(cls.integrity_failures.slice(0, 3))}`;
      return archive(guardStop(detail), null);
    }
  }
  if (execOutcome.kind === 'INTERRUPTED') {
    return archive({ attemptId, index, outcome: 'INCOMPLETE', failureClass: null, stopDetail: execOutcome.detail, evaluable: false, capturePath, evidencePackagePath: null, evidencePackageSha256: null, assessment: null }, null);
  }
  if (execOutcome.kind !== 'BOUNDARY') {
    let assessment: ReadinessAssessment | null = null;
    try { assessment = assessReadiness((await assembleReadinessInput(stack, adjudicated, boundaryRefusals)).input); } catch { assessment = null; }
    // the assessor's classification is authoritative when available (it reads
    // the final artifacts + capture); the drive outcome only backstops
    const failureClass = assessment?.failureClass ?? (execOutcome.kind === 'FAILED' ? 'workflow-abandoned' : 'malformed-state');
    return archive({ attemptId, index, outcome: 'NOT-READY', failureClass, stopDetail: JSON.stringify(execOutcome), evaluable: true, capturePath, evidencePackagePath: null, evidencePackageSha256: null, assessment }, assessment);
  }

  // ── phase 3: readiness assessment at the boundary ────────────────────────────
  const { input, definitionText, readinessText } = await assembleReadinessInput(stack, adjudicated, boundaryRefusals);
  const assessment = assessReadiness(input);
  const rec: AttemptRecord = {
    attemptId, index,
    outcome: assessment.ready ? 'READY' : 'NOT-READY',
    failureClass: assessment.ready ? null : assessment.failureClass,
    stopDetail: assessment.ready ? null : JSON.stringify(assessment.checks),
    evaluable: true, capturePath, evidencePackagePath: null, evidencePackageSha256: null, assessment,
  };
  return archive(rec, assessment);
}

// ─── the campaign loop: ledger-driven, §10-aware, threshold ≥2/3 ─────────────
export interface LedgerEntry {
  ts: string;
  event: 'campaign-start' | 'attempt-start' | 'attempt-counted' | 'attempt-incomplete' | 'attempt-stopped' | 'campaign-terminal';
  attemptId?: string;
  index?: number;
  outcome?: string;
  failureClass?: string | null;
  detail?: string | null;
  evidencePackageSha256?: string | null;
}

export function appendLedger(evidenceDir: string, entry: LedgerEntry): void {
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(join(evidenceDir, 'campaign-ledger.jsonl'), JSON.stringify(entry) + '\n');
}

// §10 — declare ledger-orphaned launches (attempt-start without a terminal
// event) incomplete; idempotent.
export function reconcileLedgerOnResume(evidenceDir: string): void {
  const entries = readLedger(evidenceDir);
  const terminal = new Set(entries.filter((e) => ['attempt-counted', 'attempt-incomplete', 'attempt-stopped'].includes(e.event)).map((e) => `${e.event}:${e.index}`));
  for (const e of entries) {
    if (e.event !== 'attempt-start' || e.index === undefined) continue;
    if (!entries.some((t) => t.index === e.index && ['attempt-counted', 'attempt-incomplete', 'attempt-stopped'].includes(t.event))) {
      appendLedger(evidenceDir, { ts: new Date().toISOString(), event: 'attempt-incomplete', index: e.index, detail: 'declared incomplete by resume: launch had no terminal event (process death)' });
    }
  }
  void terminal;
}

export function readLedger(evidenceDir: string): LedgerEntry[] {
  const p = join(evidenceDir, 'campaign-ledger.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as LedgerEntry);
}

export interface CampaignResult {
  attempts: AttemptRecord[];
  readyCount: number;
  evaluableCount: number;
  supported: boolean | null; // null = campaign did not reach a terminal verdict
  terminal: string;
}

// innerProviderFactory(launchIndex) supplies a FRESH inner provider per
// launch (L1: scripted; L3: the real resolved provider). Resume-from-ledger
// (§10): counted attempts are retained (never re-run/double-counted); an
// INCOMPLETE launch consumes NOTHING and the loop CONTINUES (that is the
// resume — a fresh process re-invoking this function reads the ledger and
// proceeds toward the same preregistered terminal condition). STOPPED
// terminates the campaign (procedure class). The launch cap bounds the loop
// so repeated interrupts cannot spin forever.
export async function runP4Campaign(opts: {
  evidenceDir: string;
  shapes: PinnedShapes;
  innerProviderFactory: (index: number) => unknown;
  maxAttempts?: number;
  readyThreshold?: number;
  captureToolSchemas?: boolean;
  onActive?: (active: { stepId: string | null }) => void;
}): Promise<CampaignResult> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const threshold = opts.readyThreshold ?? READY_THRESHOLD;
  const launchCap = maxAttempts + 2;
  // §10 resume: a prior process death leaves attempt-start entries without a
  // terminal event — the RESUMING process declares them incomplete (archived
  // runtime capture was preserved by the dead process's attempt; the launch
  // consumed nothing). Counted attempts stay counted.
  reconcileLedgerOnResume(opts.evidenceDir);
  // archive any interrupted runtime remnants, then restore the worktree —
  // the resuming campaign never inherits a dead attempt's runtime state
  const sle = join(ROOT, '.sle');
  if (existsSync(sle)) {
    const interruptedDir = join(opts.evidenceDir, `interrupted-runtime-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    try {
      const { cpSync } = await import('node:fs');
      cpSync(sle, interruptedDir, { recursive: true });
      appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'attempt-incomplete', detail: `interrupted runtime archived to ${interruptedDir}` });
    } catch { /* archival best-effort; the wipe below still discards */ }
  }
  if (!cleanupTargetWorktree()) {
    return { attempts, readyCount: 0, evaluableCount: 0, supported: null, terminal: 'STOPPED: worktree could not be restored at resume' };
  }
  appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'campaign-start' });
  const attempts: AttemptRecord[] = [];
  let readyCount = 0;
  let evaluableCount = 0;
  for (let launched = 1; launched <= launchCap; launched++) {
    appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'attempt-start', index: launched });
    let rec: AttemptRecord;
    try {
      rec = await runP4Attempt(launched, opts.innerProviderFactory(launched), opts.evidenceDir, opts.shapes, { captureToolSchemas: opts.captureToolSchemas, onActive: opts.onActive });
    } catch (e) {
      appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'attempt-incomplete', index: launched, detail: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      return { attempts, readyCount, evaluableCount, supported: null, terminal: `INTERRUPTED at launch ${launched}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
    }
    attempts.push(rec);
    if (rec.outcome === 'READY') readyCount++;
    if (rec.evaluable) evaluableCount++;
    appendLedger(opts.evidenceDir, {
      ts: new Date().toISOString(),
      event: rec.outcome === 'INCOMPLETE' ? 'attempt-incomplete' : rec.outcome === 'STOPPED' ? 'attempt-stopped' : 'attempt-counted',
      attemptId: rec.attemptId, index: launched, outcome: rec.outcome, failureClass: rec.failureClass,
      detail: rec.stopDetail?.slice(0, 300) ?? null, evidencePackageSha256: rec.evidencePackageSha256,
    });
    if (rec.outcome === 'STOPPED') {
      return { attempts, readyCount, evaluableCount, supported: null, terminal: `STOPPED: ${rec.failureClass ?? ''} ${rec.stopDetail?.slice(0, 200) ?? ''}` };
    }
    if (rec.outcome === 'INCOMPLETE') continue; // §10: consumed nothing — resume
    if (evaluableCount >= maxAttempts) break;
    if (readyCount + (maxAttempts - evaluableCount) < threshold) break;
  }
  const supported = evaluableCount >= threshold ? readyCount >= threshold : null;
  appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'campaign-terminal', detail: `ready=${readyCount} evaluable=${evaluableCount} supported=${String(supported)}` });
  return { attempts, readyCount, evaluableCount, supported, terminal: `complete: ready=${readyCount}/${evaluableCount} (threshold ${threshold})` };
}
