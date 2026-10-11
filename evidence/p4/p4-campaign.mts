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
  readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, copyFileSync, appendFileSync, statSync,
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
import { assessReadiness, buildStepRequestsInCapture, type ReadinessAssessment, type UpstreamArtifactRecord, type RequiredOutputVerification } from './p4-readiness.mts';

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

// ─── REQUIRED native upstream outputs (the BUILD-input contract) ─────────────
// Derived from the FROZEN full-build definition: scoping.produce's declared
// outputArtifact (cycle-charter), design's and plan's authorizedOutputs, and
// the test step's authorized test directory. Each entry is verified against
// its EXACT storage row (type+ref), the disk bytes (row hash == disk sha256),
// and non-emptiness — at the confirm boundary these ARE the BUILD context.
const REQUIRED_EXEC_OUTPUTS = [
  { path: 'docs/cycle-charter.md', ref: 'doc:cycle-charter', rowType: 'cycle-charter', stepId: 'scoping.produce' },
  { path: 'docs/requirements.md', ref: 'produced-file:design:docs/requirements.md', rowType: 'produced-file', stepId: 'design' },
  { path: 'docs/architecture.md', ref: 'produced-file:design:docs/architecture.md', rowType: 'produced-file', stepId: 'design' },
  { path: 'docs/plan.md', ref: 'produced-file:plan:docs/plan.md', rowType: 'produced-file', stepId: 'plan' },
  { path: 'docs/test-plan.md', ref: 'produced-file:plan:docs/test-plan.md', rowType: 'produced-file', stepId: 'plan' },
];
const TEST_OUTPUT_DIR_PREFIX = 'apps/ai-server/tests/';

// ─── AUTHORITY: per-step worktree write authorization (review P1 #4) ─────────
// An out-of-policy upstream disk write is a campaign-terminal AUTHORITY-BYPASS
// STOP: detected at the stepRunner seam (before/after git-status delta per
// step), archived BEFORE worktree cleanup, never silently absorbed.
// Authorization derives from the FROZEN workflow definitions: define-work
// steps may write only under .sle/; full-build steps only their declared
// outputArtifact / authorizedOutputs (prefix entries end with '/').
class P4AuthorityBypassError extends Error {}

async function loadAuthorizedUpstreamWrites(): Promise<{ exact: Map<string, Set<string>>; prefixes: Map<string, string[]> }> {
  const { FULL_BUILD } = await import(`${STRATUM}/src/workflow/builtins/full-build.js`);
  const exact = new Map<string, Set<string>>();
  const prefixes = new Map<string, string[]>();
  for (const step of FULL_BUILD.steps as Array<{ id: string; authorizedOutputs?: string[]; outputArtifact?: { path?: string } }>) {
    const set = new Set<string>();
    const pre: string[] = [];
    if (step.outputArtifact?.path) set.add(step.outputArtifact.path);
    for (const p of step.authorizedOutputs ?? []) {
      if (p.endsWith('/')) pre.push(p); else set.add(p);
    }
    exact.set(step.id, set);
    prefixes.set(step.id, pre);
  }
  return { exact, prefixes };
}

// content identities for every dirty path in the target worktree
// (sha256 of current bytes; null for a deleted path). `-uall` enumerates
// EVERY untracked file — the default collapses untracked directories into
// one entry, which would hide individual out-of-policy files.
function gitWorktreeContentMap(): Map<string, string | null> {
  const status = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '-uall']).toString();
  const out = new Map<string, string | null>();
  for (const line of status.split('\n')) {
    const t = line.trim();
    if (t.length === 0 || t === '?? .sle/') continue;
    const p = t.startsWith('?? ') ? t.slice(3) : t.slice(3);
    const path = p.replace(/\/$/, '').split(' -> ').pop() as string;
    if (path === '.sle' || path.startsWith('.sle/')) continue;
    const abs = join(ROOT, path);
    out.set(path, existsSync(abs) ? sha256File(abs) : null);
  }
  return out;
}

// returns the out-of-policy paths a step wrote, using BEFORE/AFTER CONTENT
// IDENTITIES: a NEW path, a REWRITE of an already-dirty path (content sha
// changed), or a DELETION of a dirty path — each authorized only if the step
// (per the frozen workflow definitions) may write that path.
function authorityViolationsForStep(
  wf: string,
  step: string,
  before: Map<string, string | null>,
  auth: { exact: Map<string, Set<string>>; prefixes: Map<string, string[]> },
): Array<{ path: string; reason: string }> {
  const after = gitWorktreeContentMap();
  const violations: Array<{ path: string; reason: string }> = [];
  const classify = (p: string): string | null => {
    if (wf === 'define-work') return 'define-work steps may not write outside .sle/';
    if (wf === 'full-build') {
      const allowed = auth.exact.get(step) ?? new Set<string>();
      const prefixes = auth.prefixes.get(step) ?? [];
      if (allowed.has(p) || prefixes.some((x) => p.startsWith(x))) return null;
      return `not in ${step}'s authorized outputs [${[...allowed, ...prefixes].join(', ')}]`;
    }
    return `workflow ${wf} has no authorized worktree writes`;
  };
  const kindOf = (p: string): string => {
    const b = before.get(p);
    const a = after.get(p);
    if (b === undefined) return 'unauthorized write';
    if (a === undefined || a === null) return 'unauthorized deletion of already-dirty path';
    if (b === null || b !== a) return 'unauthorized rewrite of already-dirty path (before/after content identity mismatch)';
    return 'unchanged'; // present before and after with identical bytes — not this step's write
  };
  for (const [p] of after) {
    const kind = kindOf(p);
    if (kind === 'unchanged') continue;
    const why = classify(p);
    if (why) violations.push({ path: p, reason: `${kind}: ${why}` });
  }
  // deletions remove the path from the after map — scan before-entries too
  for (const [p, b] of before) {
    if (after.has(p) || !before.has(p)) continue;
    void b;
    const why = classify(p);
    if (why) violations.push({ path: p, reason: `unauthorized deletion of already-dirty path: ${why}` });
  }
  return violations;
}

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const safeRead = (p: string): string => { try { return readFileSync(p, 'utf-8'); } catch { return ''; } };
const statSize = (p: string): number => { try { return statSync(p).size; } catch { return -1; } };
// P3-style package identity: sha256 over the canonical (sorted) file-hash map
const canonicalHashMap = (m: Record<string, string>): string =>
  createHash('sha256').update(JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]))).digest('hex');

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

async function buildStack(
  guardedProvider: unknown,
  active: ActiveStepRef,
  opts?: { postStepCheck?: (wf: string, step: string, before: Map<string, string | null>) => Array<{ path: string; reason: string }> },
): Promise<Stack> {
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
          // AUTHORITY seam: snapshot BEFORE/AFTER CONTENT IDENTITIES for the
          // step's actual disk writes — new paths, rewrites of already-dirty
          // paths, and deletions, INCLUDING the exception path (the check
          // runs in finally; violations are recorded, then the original error
          // still propagates). An out-of-policy write is a campaign-terminal
          // STOP archived before worktree cleanup.
          const before = gitWorktreeContentMap();
          let result: unknown;
          let thrown: unknown = null;
          try {
            result = await (target as { run: (s: unknown, c: unknown) => Promise<unknown> }).run(step, ctx);
          } catch (e) {
            thrown = e; // exception path: the authority check still runs below
          }
          const violations = opts?.postStepCheck?.(String(ctx.workflowId), String(ctx.stepId), before) ?? [];
          if (violations.length > 0) {
            // the bypass takes precedence: the violations are recorded by the
            // check itself, and the typed error surfaces where possible
            throw new P4AuthorityBypassError(
              `AUTHORITY-BYPASS at ${ctx.workflowId}/${ctx.stepId}: ${violations.map((v) => `${v.path} (${v.reason})`).join('; ')}`,
            );
          }
          if (thrown !== null) throw thrown;
          return result;
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
  | { kind: 'AUTHORITY_BYPASS'; detail: string }
  | { kind: 'STALLED'; detail: string };

// calibration seams (L1 ONLY — qualification paths never set them):
//   onExecCheckpoint: invoked at an exec checkpoint BEFORE policy adjudication
//     (deterministic hook for required-artifact fault injection)
//   humanDecisionResolution: if present, the HARNESS (acting as the scripted
//     human operator — a role the campaign itself may never take) resolves the
//     pending decision through the real ResumeService so downstream native
//     shapes (apply-human-decision, post-human-readiness-review) can be
//     observed. Absent = the campaign NEVER approves (default).
export interface DriveHooks {
  onExecCheckpoint?: (cursor: string) => Promise<void> | void;
  onExecCheckpointResolved?: (cursor: string) => Promise<void> | void;
  humanDecisionResolution?: (pending: { id: string }) => unknown;
}

const APPROVE_RESOLUTION = (why: string) => ({
  selectedOptionId: 'approve',
  rationale: why,
  resolvedAt: new Date().toISOString(),
  resolvedBy: 'campaign-policy',
});

export async function driveWorkflow(stack: Stack, wiId: string, phase: 'define' | 'exec', adjudicated: string[], hooks?: DriveHooks): Promise<DriveOutcome> {
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
        if (hooks?.humanDecisionResolution) {
          // calibration only: the scripted HUMAN resolves through the real
          // ResumeService — the campaign itself never authors this resolution
          await stack.resume(p.id, hooks.humanDecisionResolution({ id: String(p.id) }));
          continue;
        }
        return { kind: 'HUMAN_DECISION' }; // NEVER synthetically approved
      }
      if (phase === 'exec') {
        if (cursor === 'confirm') return { kind: 'BOUNDARY' };
        if (cursor === 'scoping.checkpoint' || cursor === 'sharding_approval') {
          await hooks?.onExecCheckpoint?.(String(cursor));
          await stack.resume(p.id, APPROVE_RESOLUTION(`P4 preregistered determinate policy: ${cursor} approved (well-formed decision, guards passed)`));
          adjudicated.push(String(cursor));
          await hooks?.onExecCheckpointResolved?.(String(cursor));
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

  // storage-provenanced artifacts: the definition + EVERY produced upstream
  // output row (definition, cycle-charter, produced-file, applied-*)
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
    required: true,
  });
  for (const row of [...stack.artifacts(EXEC_WI)] as Array<{ type: string; ref: string; path: string; hash: string }>) {
    if (row.type !== 'cycle-charter' && row.type !== 'produced-file' && row.type !== 'applied-edit' && row.type !== 'applied-patch') continue;
    const p = join(ROOT, String(row.path));
    const txt = safeRead(p);
    upstreamArtifacts.push({
      stepId: String(row.ref).split(':')[1] ?? row.type, artifactType: String(row.type), ref: String(row.ref), path: p,
      existsOnDisk: existsSync(p), diskSha256: existsSync(p) ? sha256File(p) : null,
      storageHash: String(row.hash), bytes: Buffer.byteLength(txt), nonEmpty: txt.length > 0,
      required: REQUIRED_EXEC_OUTPUTS.some((r) => r.path === String(row.path)),
    });
  }

  // REQUIRED native BUILD-input verification: exact storage row (type+ref),
  // row hash == disk sha256, non-empty file. A required output with NO row is
  // recorded as failed verification — absence can never pass silently.
  const execRows = stack.artifacts(EXEC_WI) as Array<{ type: string; ref: string; path: string; hash: string }>;
  const requiredUpstreamOutputs: RequiredOutputVerification[] = REQUIRED_EXEC_OUTPUTS.map((spec) => {
    const rows = execRows.filter((r) => r.ref === spec.ref && r.type === spec.rowType);
    const row = rows[rows.length - 1];
    const abs = join(ROOT, spec.path);
    const onDisk = row !== undefined && existsSync(abs);
    const diskSha = onDisk ? sha256File(abs) : null;
    return {
      path: spec.path, ref: spec.ref, rowType: spec.rowType, stepId: spec.stepId,
      rowPresent: row !== undefined,
      diskPresent: onDisk,
      hashMatch: row !== undefined && diskSha !== null && String(row.hash) === diskSha,
      nonEmpty: onDisk && diskSha !== null ? statSize(abs) > 0 : false,
      diskSha256: diskSha,
      storageHash: row ? String(row.hash) : null,
    };
  });
  // test outputs: ≥1 produced-file row from the test step under the authorized dir
  const testRows = execRows.filter((r) => r.type === 'produced-file'
    && String(r.ref).startsWith(`produced-file:test:${TEST_OUTPUT_DIR_PREFIX}`)
    && String(r.path).startsWith(TEST_OUTPUT_DIR_PREFIX));
  let testOutputsPresent = testRows.length > 0;
  for (const r of testRows) {
    const abs = join(ROOT, String(r.path));
    if (!existsSync(abs) || sha256File(abs) !== String(r.hash)) { testOutputsPresent = false; break; }
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
      pendingConfirm: (() => {
        // DecisionRepository returns DOMAIN objects (subjectRef as a parsed
        // object); raw rows (subject_ref_json) only appear in direct SQL
        const p = stack.pendingDecisions(EXEC_WI)[0] as { id: string; type: string; subjectRef?: { stepId?: string }; subject_ref_json?: string } | undefined;
        if (!p) return null;
        const refStep = p.subjectRef?.stepId
          ?? (() => { try { return (JSON.parse(String(p.subject_ref_json ?? '{}')) as { stepId?: string }).stepId ?? null; } catch { return null; } })();
        return { id: String(p.id), type: String(p.type), subjectRefStepId: refStep ?? null };
      })(),
      pendingDecisionCount: stack.pendingDecisions(EXEC_WI).length,
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
      requiredUpstreamOutputs,
      testOutputsPresent,
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

// ─── per-attempt evidence package (P3-style FULL hash-bound packaging) ───────
// Every artifact is packaged and hash-bound into files.sha256.json; the
// package identity is package_sha256 = sha256(canonical(sorted file-hash map)),
// written into manifest.json. The archive self-verifies after write; an
// independent verifier (verifyEvidencePackage) is used by the tamper gate.
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
  reconstructed?: boolean; // count reconstructed from the campaign ledger — never re-executed
}

interface AuthorityViolationRecord { path: string; reason: string; sha256: string | null; bytes: number }

async function collectRuntimeArtifacts(dir: string): Promise<void> {
  // the engine's raw node outputs + run manifests = the runtime artifact class
  const runsDir = join(ROOT, '.sle', 'runs');
  if (!existsSync(runsDir)) return;
  const dest = join(dir, 'runs');
  mkdirSync(dest, { recursive: true });
  for (const runId of readdirSync(runsDir)) {
    const src = join(runsDir, runId);
    if (!statSync(src).isDirectory()) continue;
    copyDir(src, join(dest, runId));
  }
}

async function archiveAttempt(
  evidenceDir: string,
  rec: AttemptRecord,
  stack: Stack,
  assessment: ReadinessAssessment | null,
  definitionText: string,
  readinessText: string,
  opts?: { launchId?: string; authorityViolations?: AuthorityViolationRecord[] },
): Promise<{ dir: string; sha256: string; packageSha256: string }> {
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
  await collectRuntimeArtifacts(dir);
  // upstream files FROM THE STORAGE ROWS (storage-provenanced, incl. test
  // outputs): every produced/declared row's path is copied and hash-bound
  const upstreamIndex: Array<{ path: string; sha256: string; storage_hash: string; row_type: string; ref: string }> = [];
  const upstreamFilesDir = join(dir, 'upstream-files');
  for (const wiId of [DEFINE_WI, EXEC_WI]) {
    for (const row of stack.artifacts(wiId) as Array<{ type: string; ref: string; path: string; hash: string }>) {
      if (!['definition', 'definition-readiness', 'decision-application', 'cycle-charter', 'produced-file', 'applied-edit', 'applied-patch'].includes(String(row.type))) continue;
      const abs = join(ROOT, String(row.path));
      if (!existsSync(abs)) continue;
      const dest = join(upstreamFilesDir, String(row.path));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
      upstreamIndex.push({ path: String(row.path), sha256: sha256File(dest), storage_hash: String(row.hash), row_type: String(row.type), ref: String(row.ref) });
    }
  }
  writeFileSync(join(dir, 'upstream-files-index.json'), JSON.stringify(upstreamIndex, null, 2));
  if (definitionText) writeFileSync(join(dir, 'definition.md'), definitionText);
  if (readinessText) writeFileSync(join(dir, 'readiness.md'), readinessText);
  // authority violations are archived BEFORE worktree cleanup: the violating
  // bytes are preserved inside the package as evidence
  if (opts?.authorityViolations?.length) {
    for (const v of opts.authorityViolations) {
      const abs = join(ROOT, v.path);
      if (!existsSync(abs)) continue;
      const dest = join(dir, 'authority-violations', v.path);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(abs, dest);
    }
    writeFileSync(join(dir, 'authority-violations.json'), JSON.stringify(opts.authorityViolations, null, 2));
  }
  // hash-bind EVERY packaged file, then compute the package identity
  const fileHashes: Record<string, string> = {};
  const walk = (base: string, rel = ''): void => {
    for (const e of readdirSync(join(base, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(base, r);
      else fileHashes[r] = sha256File(join(base, r));
    }
  };
  walk(dir);
  const packageSha256 = canonicalHashMap(fileHashes);
  writeFileSync(join(dir, 'files.sha256.json'), JSON.stringify(fileHashes, null, 2));
  const manifest = {
    attemptId: rec.attemptId, index: rec.index, launchId: opts?.launchId ?? null,
    outcome: rec.outcome, failureClass: rec.failureClass, stopDetail: rec.stopDetail?.slice(0, 500) ?? null,
    target_pristine: targetPristine(), archived_at_utc: new Date().toISOString(),
    settings_sha256: FROZEN_SETTINGS_SHA256,
    capture_sha256: fileHashes['guard-capture.jsonl'] ?? null,
    db_records_sha256: fileHashes['db-records.json'] ?? null,
    upstream_files: upstreamIndex,
    authority_violations: opts?.authorityViolations?.map((v) => ({ path: v.path, reason: v.reason })) ?? [],
    package_file_count: Object.keys(fileHashes).length,
    package_files_sha256: `${dir}/files.sha256.json`,
    package_sha256: packageSha256,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // post-write self-verification: the package must verify cleanly at birth
  const verdict = verifyEvidencePackage(dir);
  if (!verdict.ok) throw new Error(`evidence package failed self-verification: ${verdict.violations.join('; ')}`);
  return { dir, sha256: fileHashes['guard-capture.jsonl'] ?? '', packageSha256 };
}

// independent package verifier: recomputes every file hash against
// files.sha256.json and the package identity against manifest.json
export function verifyEvidencePackage(dir: string): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const hashPath = join(dir, 'files.sha256.json');
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(hashPath) || !existsSync(manifestPath)) return { ok: false, violations: ['missing files.sha256.json or manifest.json'] };
  const fileHashes = JSON.parse(readFileSync(hashPath, 'utf-8')) as Record<string, string>;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { package_sha256: string; package_file_count: number };
  for (const [rel, expected] of Object.entries(fileHashes)) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) { violations.push(`missing packaged file: ${rel}`); continue; }
    const actual = sha256File(abs);
    if (actual !== expected) violations.push(`hash mismatch: ${rel}`);
  }
  // no unexpected extra files (except the two metadata files themselves)
  const walk = (rel = ''): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (r !== 'files.sha256.json' && r !== 'manifest.json' && !(r in fileHashes)) violations.push(`unbound extra file: ${r}`);
    }
  };
  walk();
  // package identity: the manifest's package_sha256 must equal the identity
  // of the archived file-hash map (any drift in the map's contents or the
  // manifest itself breaks this binding)
  const identity = canonicalHashMap(fileHashes);
  if (identity !== manifest.package_sha256) violations.push(`package identity mismatch (manifest ${manifest.package_sha256.slice(0, 12)} != recomputed ${identity.slice(0, 12)})`);
  if (Object.keys(fileHashes).length !== manifest.package_file_count) violations.push(`file count mismatch: ${Object.keys(fileHashes).length} != ${manifest.package_file_count}`);
  return { ok: violations.length === 0, violations };
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
  opts?: {
    captureToolSchemas?: boolean;
    onActive?: (active: ActiveStepRef) => void;
    launchId?: string;
    hooks?: DriveHooks;
  },
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
  const authorityStop = (detail: string): AttemptRecord => ({
    attemptId, index, outcome: 'STOPPED', failureClass: 'authority-bypass', stopDetail: detail,
    evaluable: false, capturePath, evidencePackagePath: null, evidencePackageSha256: null, assessment: null,
  });

  // AUTHORITY: per-step worktree write authorization (frozen workflow-derived).
  // Violations are recorded WITH the file's bytes still on disk so the archive
  // can preserve them BEFORE worktree cleanup.
  const auth = await loadAuthorizedUpstreamWrites();
  const authorityViolations: AuthorityViolationRecord[] = [];

  let stack: Stack;
  try {
    stack = await buildStack(provider, active, {
      postStepCheck: (wf, step, before) => {
        const violations = authorityViolationsForStep(wf, step, before, auth);
        for (const v of violations) {
          const abs = join(ROOT, v.path);
          authorityViolations.push({
            path: v.path, reason: v.reason,
            sha256: existsSync(abs) ? sha256File(abs) : null,
            bytes: existsSync(abs) ? statSize(abs) : 0,
          });
        }
        return violations;
      },
    });
  } catch (e) {
    if (e instanceof ConfigGuardViolation) return guardStop(e.message);
    throw e;
  }
  // AUTHORITY-BYPASS STOP: the engine catches step-level exceptions, so the
  // typed error may never reach drive()'s catch — the recorded violations are
  // the authoritative signal. Checked after every phase; archived BEFORE
  // worktree cleanup (the violating bytes travel inside the package).
  const authorityStopOfRecord = (): AttemptRecord | null => {
    if (authorityViolations.length === 0) return null;
    return authorityStop(`AUTHORITY-BYPASS: ${authorityViolations.map((v) => `${v.path} (${v.reason})`).join('; ')}`);
  };
  const adjudicated: string[] = [];
  let boundaryRefusals = 0;

  const archive = async (rec: AttemptRecord, assessment: ReadinessAssessment | null): Promise<AttemptRecord> => {
    let out: AttemptRecord;
    try {
      const pkg = await archiveAttempt(evidenceDir, rec, stack, assessment, safeRead(join(ROOT, '.sle', 'work', DEFINE_WI, 'definition.md')), safeRead(join(ROOT, '.sle', 'work', DEFINE_WI, 'readiness.md')), { launchId: opts?.launchId, authorityViolations: [...authorityViolations] });
      // package identity (not just the capture) is the durable evidence handle
      out = { ...rec, evidencePackagePath: pkg.dir, evidencePackageSha256: pkg.packageSha256 };
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

  // drive with procedure-class handling: guard violations AND authority
  // bypasses = STOP (consume nothing); unexpected engine errors = INCOMPLETE
  // (§10: archived as interrupted, never classified, resume continues the
  // terminal condition). NOTE: the engine catches step-level provider
  // exceptions and records them as step failures — so a guard STOP that fired
  // mid-step surfaces as a FAILED drive, not a thrown violation. The campaign
  // therefore derives the STOP from the CAPTURE (any g1 STOP record =
  // campaign-terminal, wherever it surfaced), never from the exception path
  // alone. The AUTHORITY-BYPASS is different: it throws at the stepRunner
  // seam AFTER the step completed, so it arrives here as a typed error.
  const drive = async (wiId: string, phase: 'define' | 'exec'): Promise<DriveOutcome | { kind: 'GUARD_STOP'; detail: string } | { kind: 'INTERRUPTED'; detail: string }> => {
    try {
      return await driveWorkflow(stack, wiId, phase, adjudicated, opts?.hooks);
    } catch (e) {
      if (e instanceof P4AuthorityBypassError) return { kind: 'AUTHORITY_BYPASS', detail: e.message };
      if (e instanceof ConfigGuardViolation) return { kind: 'GUARD_STOP', detail: e.message };
      return { kind: 'INTERRUPTED', detail: e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : String(e) };
    }
  };

  // ── phase 1: define-work ────────────────────────────────────────────────────
  const defineOutcome = await drive(DEFINE_WI, 'define');

  const defineAuthority = authorityStopOfRecord();
  if (defineAuthority) return archive(defineAuthority, null);
  if (defineOutcome.kind === 'GUARD_STOP') return guardStop(defineOutcome.detail);
  if (defineOutcome.kind === 'AUTHORITY_BYPASS') return archive(authorityStop(defineOutcome.detail), null);
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
  const execAuthority = authorityStopOfRecord();
  if (execAuthority) {
    // archive BEFORE cleanup — the violating bytes travel inside the package
    return archive(execAuthority, null);
  }
  if (execOutcome.kind === 'AUTHORITY_BYPASS') {
    // archive BEFORE cleanup — the violating bytes travel inside the package
    return archive(authorityStop(execOutcome.detail), null);
  }
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
  launchId?: string;
  outcome?: string;
  failureClass?: string | null;
  detail?: string | null;
  evaluable?: boolean;
  evidencePackageSha256?: string | null;
}

export function appendLedger(evidenceDir: string, entry: LedgerEntry): void {
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(join(evidenceDir, 'campaign-ledger.jsonl'), JSON.stringify(entry) + '\n');
}

// §10 — declare ledger-orphaned launches (attempt-start without a terminal
// event) incomplete; idempotent, keyed by slot index (all terminal events
// carry the slot index).
export function reconcileLedgerOnResume(evidenceDir: string): void {
  const entries = readLedger(evidenceDir);
  for (const e of entries) {
    if (e.event !== 'attempt-start' || e.index === undefined) continue;
    if (!entries.some((t) => t.index === e.index && ['attempt-counted', 'attempt-incomplete', 'attempt-stopped'].includes(t.event))) {
      appendLedger(evidenceDir, { ts: new Date().toISOString(), event: 'attempt-incomplete', attemptId: e.attemptId, index: e.index, launchId: e.launchId, detail: 'declared incomplete by resume: launch had no terminal event (process death)' });
    }
  }
}

// durable count reconstruction: the resuming process rebuilds its counted
// slots FROM THE LEDGER (never re-executing, never double-counting) — and
// VERIFIES each retained slot's evidence package identity. A conflicting
// ledger (duplicate counted indexes) or a retained package whose identity
// does not verify (missing, tampered, or ledger/package sha disagreement) is
// a fail-closed conflict: the campaign refuses to launch.
export interface ReconstructedCount {
  attempts: AttemptRecord[];
  readyCount: number;
  evaluableCount: number;
  maxIndex: number;
  priorStop: LedgerEntry | null;
  conflicts: string[];
}

export function reconstructCountedSlots(evidenceDir: string): ReconstructedCount {
  const entries = readLedger(evidenceDir);
  const attempts: AttemptRecord[] = [];
  let readyCount = 0;
  let evaluableCount = 0;
  let maxIndex = 0;
  let priorStop: LedgerEntry | null = null;
  const conflicts: string[] = [];
  const seenCountedIndexes = new Map<number, string>();
  for (const e of entries) {
    if (e.index !== undefined && e.index > maxIndex) maxIndex = e.index;
    if (e.event !== 'attempt-counted' || !e.attemptId || e.index === undefined) continue;
    // conflicting ledger counts: the same slot counted twice
    const priorAttempt = seenCountedIndexes.get(e.index);
    if (priorAttempt !== undefined) {
      conflicts.push(`ledger conflict: slot ${e.index} counted twice (${priorAttempt} and ${e.attemptId})`);
      continue;
    }
    seenCountedIndexes.set(e.index, e.attemptId);
    // retained package identity verification (fail closed)
    const pkgDir = join(evidenceDir, `attempt-${e.index}-${e.attemptId}`);
    let identityOk = false;
    let identityDetail = 'package absent';
    if (existsSync(join(pkgDir, 'manifest.json'))) {
      const manifest = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf-8')) as { package_sha256: string };
      if (e.evidencePackageSha256 != null && manifest.package_sha256 !== e.evidencePackageSha256) {
        identityDetail = `package identity ${manifest.package_sha256.slice(0, 12)} != ledger ${String(e.evidencePackageSha256).slice(0, 12)}`;
      } else {
        const verdict = verifyEvidencePackage(pkgDir);
        identityOk = verdict.ok;
        if (!verdict.ok) identityDetail = `package does not verify: ${verdict.violations.slice(0, 2).join('; ')}`;
      }
    }
    if (!identityOk) {
      conflicts.push(`retained slot ${e.index} (${e.attemptId}): ${identityDetail}`);
      continue;
    }
    const outcome = e.outcome as AttemptRecord['outcome'];
    if (outcome === 'READY') readyCount++;
    if (e.evaluable !== false) evaluableCount++;
    attempts.push({
      attemptId: e.attemptId, index: e.index, outcome, failureClass: e.failureClass ?? null,
      stopDetail: e.detail ?? null, evaluable: e.evaluable !== false, capturePath: '',
      evidencePackagePath: pkgDir, evidencePackageSha256: e.evidencePackageSha256 ?? null,
      assessment: null, reconstructed: true,
    });
  }
  const stops = entries.filter((e) => e.event === 'attempt-stopped');
  if (stops.length > 0) priorStop = stops[stops.length - 1];
  return { attempts, readyCount, evaluableCount, maxIndex, priorStop, conflicts };
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
  launchId: string;
}

// innerProviderFactory(launchIndex) supplies a FRESH inner provider per
// launch (L1: scripted; L3: the real resolved provider). Resume-from-ledger
// (§10): counted attempts are RECONSTRUCTED from the ledger (retained, never
// re-run, never double-counted); each launch carries a UNIQUE launchId; an
// INCOMPLETE launch consumes NOTHING and the loop CONTINUES (that is the
// resume — a fresh process re-invoking this function reads the ledger and
// proceeds toward the same preregistered terminal condition). STOPPED is
// sticky: a resume after a prior campaign-terminal STOP refuses to launch.
// The launch cap bounds the loop so repeated interrupts cannot spin forever.
export async function runP4Campaign(opts: {
  evidenceDir: string;
  shapes: PinnedShapes;
  innerProviderFactory: (index: number) => unknown;
  maxAttempts?: number;
  readyThreshold?: number;
  captureToolSchemas?: boolean;
  onActive?: (active: { stepId: string | null }) => void;
  hooks?: DriveHooks;
  launchId?: string;
}): Promise<CampaignResult> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const threshold = opts.readyThreshold ?? READY_THRESHOLD;
  const launchId = opts.launchId ?? randomUUID();
  const launchCap = maxAttempts + 2;
  // §10 resume: a prior process death leaves attempt-start entries without a
  // terminal event — the RESUMING process declares them incomplete (archived
  // runtime capture was preserved by the dead process's attempt; the launch
  // consumed nothing). Counted attempts stay counted — and are RECONSTRUCTED
  // here so the terminal condition is computed over the durable count.
  reconcileLedgerOnResume(opts.evidenceDir);
  const prior = reconstructCountedSlots(opts.evidenceDir);
  if (prior.conflicts.length > 0) {
    // fail closed: conflicting ledger counts or unverified retained packages
    // refuse the resume — the campaign never launches on disputed evidence
    appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'campaign-terminal', launchId, detail: `LEDGER-CONFLICT: ${prior.conflicts.slice(0, 3).join(' | ')}` });
    return { attempts: prior.attempts, readyCount: 0, evaluableCount: 0, supported: null, terminal: `STOPPED: ledger-conflict — ${prior.conflicts.slice(0, 3).join(' | ')}`, launchId };
  }
  // archive any interrupted runtime remnants, then restore the worktree —
  // the resuming campaign never inherits a dead attempt's runtime state
  const sle = join(ROOT, '.sle');
  if (existsSync(sle)) {
    const interruptedDir = join(opts.evidenceDir, `interrupted-runtime-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    try {
      const { cpSync } = await import('node:fs');
      cpSync(sle, interruptedDir, { recursive: true });
      appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'attempt-incomplete', launchId, detail: `interrupted runtime archived to ${interruptedDir}` });
    } catch { /* archival best-effort; the wipe below still discards */ }
  }
  if (!cleanupTargetWorktree()) {
    return { attempts: prior.attempts, readyCount: prior.readyCount, evaluableCount: prior.evaluableCount, supported: null, terminal: 'STOPPED: worktree could not be restored at resume', launchId };
  }
  if (prior.priorStop) {
    // sticky procedure-class terminal: a stopped campaign stays stopped
    appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'campaign-terminal', launchId, detail: `sticky STOP from prior launch: ${prior.priorStop.failureClass ?? ''} ${prior.priorStop.detail?.slice(0, 150) ?? ''}` });
    return { attempts: prior.attempts, readyCount: prior.readyCount, evaluableCount: prior.evaluableCount, supported: null, terminal: `STOPPED (sticky): ${prior.priorStop.failureClass ?? ''} ${prior.priorStop.detail?.slice(0, 150) ?? ''}`, launchId };
  }
  appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'campaign-start', launchId, detail: `resuming with ${prior.attempts.length} reconstructed counted slot(s)` });
  // the terminal condition is evaluated over the DURABLE count: if the
  // reconstructed slots already satisfy it, no further attempt is launched
  // (never execute beyond the preregistered N)
  if (prior.evaluableCount >= maxAttempts || prior.readyCount + (maxAttempts - prior.evaluableCount) < threshold) {
    const supported = prior.evaluableCount >= threshold ? prior.readyCount >= threshold : null;
    appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'campaign-terminal', launchId, detail: `ready=${prior.readyCount} evaluable=${prior.evaluableCount} supported=${String(supported)} (satisfied by reconstructed slots — no further launch)` });
    return { attempts: prior.attempts, readyCount: prior.readyCount, evaluableCount: prior.evaluableCount, supported, terminal: `complete: ready=${prior.readyCount}/${prior.evaluableCount} (threshold ${threshold})`, launchId };
  }
  const attempts = [...prior.attempts];
  let readyCount = prior.readyCount;
  let evaluableCount = prior.evaluableCount;
  for (let launched = prior.maxIndex + 1; launched <= prior.maxIndex + launchCap; launched++) {
    appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'attempt-start', index: launched, launchId });
    let rec: AttemptRecord;
    try {
      rec = await runP4Attempt(launched, opts.innerProviderFactory(launched), opts.evidenceDir, opts.shapes, { captureToolSchemas: opts.captureToolSchemas, onActive: opts.onActive, launchId, hooks: opts.hooks });
    } catch (e) {
      appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'attempt-incomplete', index: launched, launchId, detail: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      return { attempts, readyCount, evaluableCount, supported: null, terminal: `INTERRUPTED at launch ${launched}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, launchId };
    }
    attempts.push(rec);
    if (rec.outcome === 'READY') readyCount++;
    if (rec.evaluable) evaluableCount++;
    appendLedger(opts.evidenceDir, {
      ts: new Date().toISOString(),
      event: rec.outcome === 'INCOMPLETE' ? 'attempt-incomplete' : rec.outcome === 'STOPPED' ? 'attempt-stopped' : 'attempt-counted',
      attemptId: rec.attemptId, index: launched, launchId, outcome: rec.outcome, failureClass: rec.failureClass,
      evaluable: rec.evaluable,
      detail: rec.stopDetail?.slice(0, 300) ?? null, evidencePackageSha256: rec.evidencePackageSha256,
    });
    if (rec.outcome === 'STOPPED') {
      return { attempts, readyCount, evaluableCount, supported: null, terminal: `STOPPED: ${rec.failureClass ?? ''} ${rec.stopDetail?.slice(0, 200) ?? ''}`, launchId };
    }
    if (rec.outcome === 'INCOMPLETE') continue; // §10: consumed nothing — resume
    if (evaluableCount >= maxAttempts) break;
    if (readyCount + (maxAttempts - evaluableCount) < threshold) break;
  }
  const supported = evaluableCount >= threshold ? readyCount >= threshold : null;
  appendLedger(opts.evidenceDir, { ts: new Date().toISOString(), event: 'campaign-terminal', launchId, detail: `ready=${readyCount} evaluable=${evaluableCount} supported=${String(supported)}` });
  return { attempts, readyCount, evaluableCount, supported, terminal: `complete: ready=${readyCount}/${evaluableCount} (threshold ${threshold})`, launchId };
}
