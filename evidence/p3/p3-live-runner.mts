// P3 LIVE CAMPAIGN RUNNER — the executable lifecycle for the frozen P3
// experiment (launch-review gate: the exact orchestration that decides what
// runs and what counts, qualified offline with scripted providers before any
// live GO).
//
// Lifecycle per the approved prereg + freeze-1 binding:
//   0. (GO time) preflight probe through the SEPARATE composed preflight
//      path — never counted, a preflight STOP aborts the campaign before
//      attempt 1
//   1. restore + validate the pinned BUILD-entry fixture (the builder
//      re-verifies every pinned boundary property; a restore failure is a
//      campaign STOP — S6/G2 class, consumes nothing)
//   2. one BUILD-entry attempt through composeBuildAttempt() — the sole
//      model path — wired into the real workflow engine under
//      publicationBoundaryRunner()
//   3. classify the attempt BEFORE counting:
//        G1/G2 (capture or exception)  -> campaign STOP, attempt NOT counted
//        publication (provenance+disk) -> counted, PUBLISHED
//        model-attributable failure    -> counted, MODEL-FAILURE
//   4. restore the target; archive the attempt evidence (fail closed if
//      evidence is missing)
//   5. stop after exactly MAX_ATTEMPTS evaluable attempts, or immediately
//      on a campaign STOP
//
// Campaign tooling only — Stratum src/ stays frozen at 9f298f2.

import { readFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  composeBuildAttempt, composePreflight, publicationBoundaryRunner,
  classifyAttempt, classifyViolation,
  P3_TARGET, PUBLICATION_BOUNDARY_SENTINEL,
  type CampaignStop,
} from './p3-live-driver.mts';
import { buildFixture } from './p3-fixture-builder.mts';
import { ConfigGuardViolation } from './config-guard.mts';

const STRATUM = '/home/theo/Documents/coding/repos/stratum';
const ROOT = '/home/theo/Documents/coding/repos/student-platform';
const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const PUBLISHED_UPSTREAM = [
  'docs/cycle-charter.md', 'docs/requirements.md', 'docs/architecture.md',
  'docs/plan.md', 'docs/test-plan.md',
  'apps/ai-server/tests/integration/test_worker_failure_payload_contract.py',
];
const WORKER = P3_TARGET.worker_main_path;
const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

export const MAX_ATTEMPTS = 3;

export type AttemptOutcome = 'PUBLISHED' | 'MODEL-FAILURE';
export type CampaignStopReason = 'G1' | 'G2' | 'FIXTURE-RESTORE' | null;

export interface AttemptRecord {
  attemptId: string;
  index: number; // 1-based slot in the campaign
  outcome: AttemptOutcome | 'STOPPED';
  stop: CampaignStopReason;
  stopDetail: string | null;
  providerCallsObserved: number;
  capturePath: string;
  archivedCapturePath: string | null;
  publicationHash: string | null;
  boundaryRefusals: number;
  evaluable: boolean;
}

export interface CampaignResult {
  attempts: AttemptRecord[];
  published: number;
  modelFailures: number;
  evaluable: number;
  stop: CampaignStopReason;
  stopDetail: string | null;
  complete: boolean; // true iff the campaign ran to its terminal state (3 evaluable or STOP)
  targetRestoredPristine: boolean;
}

export interface CampaignOptions {
  maxAttempts?: number;
  evidenceDir: string; // attempt evidence archive (captures + records)
  // offline-test override ONLY: the live campaign never passes this
  composeAttempt?: (attemptId: string) => {
    attemptId: string; capturePath: string; model: string; provider: unknown;
    classifyAttempt: () => { stop: CampaignStop };
  };
  // GO-time preflight; offline tests may override. Returns stop=null on pass.
  runPreflight?: () => Promise<{ stop: CampaignStop; detail: string | null }>;
}

async function defaultRunPreflight(): Promise<{ stop: CampaignStop; detail: string | null }> {
  // GO-time implementation: ONE tiny completion through the SEPARATE
  // preflight composition. The guard enforces the frozen contract on the
  // wire (effort low, tiny budget, no tools); a successful, archived
  // response proves the provider accepted it. A preflight STOP aborts the
  // campaign BEFORE attempt 1 and is never counted.
  const probe = composePreflight(ROOT);
  const { resolveLLMProvider } = await import(`${STRATUM}/src/application.js`);
  void resolveLLMProvider;
  const provider = probe.provider as {
    completeMultiTurn: (p: unknown) => Promise<{ stop_reason?: string; text?: string }>;
  };
  try {
    const res = await provider.completeMultiTurn({
      model: probe.model,
      system: 'P3 preflight capability probe. Reply with the single word: ok',
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 16,
      temperature: 0.7,
      reasoning_effort: 'low',
      tools: [],
    });
    if (!res || !res.text || res.text.length === 0) {
      return { stop: 'G2', detail: 'preflight response missing text (not accepted as evidence)' };
    }
    return { stop: null, detail: `preflight ok (${(res.text ?? '').trim().slice(0, 20)})` };
  } catch (err) {
    const fromViolation = classifyViolation(err);
    if (fromViolation) return { stop: fromViolation, detail: `preflight guard STOP: ${err instanceof Error ? err.message : String(err)}` };
    return { stop: 'G2', detail: `preflight completion failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function restoreTargetPristine(): Promise<boolean> {
  try {
    execFileSync('git', ['-C', ROOT, 'checkout', '--', WORKER]);
    for (const f of PUBLISHED_UPSTREAM) {
      try { execFileSync('git', ['-C', ROOT, 'rm', '-fq', f]); } catch { /* not present */ }
    }
    const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
    if (!head.startsWith('86ec0871')) return false;
    if (sha256File(join(ROOT, WORKER)) !== P3_TARGET.worker_main_sha256) return false;
    return true;
  } catch {
    return false;
  }
}

interface EngineCtor {
  resume: (pendingId: string, resolution: unknown) => Promise<unknown>;
  appliedEditCount: () => number;
}

async function buildEngine(attempt: { provider: unknown }, hooks: { onRefusal: () => void; onPublished: () => void }): Promise<EngineCtor> {
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
  const { openDatabase } = await import(`${STRATUM}/src/storage/database.js`);
  const { WorkItemRepository, ArtifactRepository, DecisionRepository, WorkflowRunRepository } = await import(`${STRATUM}/src/storage/repositories.js`);
  const { ContextManager } = await import(`${STRATUM}/src/context-manager.js`);

  const d = openDatabase(join(ROOT, '.sle', 'stratum.db'), {} as never);
  const mapManager = new RuntimeMapManagerImpl({ mapPath: join(ROOT, '.sle', 'map.yaml') });
  const runArtifacts = new RunArtifactManager({ projectRoot: ROOT });
  const { model } = resolveLLMProviderModel();
  function resolveLLMProviderModel(): { model: string } {
    // the guard already resolved and verified the model; the runner needs the
    // id only for the runner construction
    const settings = JSON.parse(readFileSync(join(ROOT, '.sle', 'settings.json'), 'utf-8')) as { model: string };
    return { model: settings.model };
  }
  void model;

  const artifactRepository = new ArtifactRepository(d);
  const decisionRepository = new DecisionRepository(d);
  const contextManager = new ContextManager(ROOT);
  const agentRunner = buildAgentRunner(contextManager, attempt.provider, ROOT, runArtifacts, resolveLLMProviderModel().model, artifactRepository, 16384);
  const agentStepRunner = new AgentStepRunner(agentRunner);
  const scopingService = new ScopingService(agentRunner, mapManager, ROOT, undefined, new TagService(mapManager));
  const confirmService = new ConfirmService(mapManager, runArtifacts);
  const execService = new ExecService(mapManager, runArtifacts);
  const validationGateService = new ValidationGateService(mapManager, runArtifacts);
  const snapshotService = new SnapshotService(mapManager, runArtifacts, ROOT);
  const summariseService = new SummariseService(mapManager, runArtifacts, ROOT);
  const criticAgent = new (await import(`${STRATUM}/src/critic-agent.js`)).CriticAgent(attempt.provider as never, resolveLLMProviderModel().model);
  const shardingService = new ShardingService(ROOT, new LinkIndexManager(ROOT, mapManager));
  const innerRunner = new FullBuildStepRunner({
    agentStepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    criticAgent, confirmService, execService, validationGateService,
    snapshotService, summariseService, shardingService, scopingService,
  }, {
    onCheckpoint: async () => 'halt' as const,
    onConfirmGate: async () => 'halt' as const,
    onShardingGate: async () => 'halt' as const,
  });
  const stepRunner = publicationBoundaryRunner(innerRunner as never, {
    onPublished: hooks.onPublished,
    onRefusal: hooks.onRefusal,
  });
  const engineDeps = {
    stepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    workflowRunRepository: new WorkflowRunRepository(d), workItemRepository: new WorkItemRepository(d),
  };
  const adapter = new StratumAgentAdapter(engineDeps, { onCheckpoint: async () => 'halt' as const }, artifactRepository);
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const resumeService = new ResumeService(d, 'ws-pilot-a', registry, {}, undefined, stepRunner);
  return {
    resume: (pendingId, resolution) => resumeService.resume(pendingId, resolution),
    appliedEditCount: () =>
      (d.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE ref LIKE 'applied-edit:%'").get() as { n: number }).n,
  };
}

// ─── one BUILD-entry attempt ─────────────────────────────────────────────────
async function runAttempt(
  index: number,
  opts: CampaignOptions,
): Promise<AttemptRecord> {
  const attemptId = randomUUID();
  const attempt = opts.composeAttempt
    ? opts.composeAttempt(attemptId)
    : composeBuildAttempt(ROOT, attemptId);

  let boundaryRefusals = 0;
  let publishedHook = 0;
  const engine = await buildEngine(attempt, {
    onRefusal: () => boundaryRefusals++,
    onPublished: () => publishedHook++,
  });

  // find the pending confirm decision (the fixture leaves it pending)
  const { openDatabase } = await import(`${STRATUM}/src/storage/database.js`);
  const { DecisionRepository } = await import(`${STRATUM}/src/storage/repositories.js`);
  const d = openDatabase(join(ROOT, '.sle', 'stratum.db'), {} as never);
  const decisions = new DecisionRepository(d);
  const pending = decisions.listByWorkItem('wi-exec-108').find((x: { status: string }) => x.status === 'pending');
  if (!pending) {
    return {
      attemptId, index, outcome: 'STOPPED', stop: 'FIXTURE-RESTORE',
      stopDetail: 'no pending confirm decision after fixture restore', providerCallsObserved: 0,
      capturePath: attempt.capturePath, archivedCapturePath: null, publicationHash: null,
      boundaryRefusals: 0, evaluable: false,
    };
  }

  const appliedBefore = engine.appliedEditCount();
  let attemptError: unknown = null;
  try {
    await engine.resume(pending.id, {
      selectedOptionId: 'approve',
      rationale: `P3 live campaign attempt ${index} (frozen confirm approval)`,
      resolvedAt: new Date().toISOString(), resolvedBy: 'operator',
    });
  } catch (err) {
    attemptError = err; // engine-level failures are recorded, then classified
  }

  // classify BEFORE counting — capture first, then exceptions
  const { cls, stop: captureStop } = attempt.classifyAttempt();
  const violationStop = attemptError ? classifyViolation(attemptError) : null;
  const stop: CampaignStopReason = captureStop === 'G1' || violationStop === 'G1' ? 'G1'
    : captureStop === 'G2' || violationStop === 'G2' ? 'G2' : null;

  // publication evidence (provenance row + disk == provenance)
  let publicationHash: string | null = null;
  const appliedAfter = engine.appliedEditCount();
  if (appliedAfter === appliedBefore + 1) {
    const applied = d.prepare("SELECT hash, path FROM artifacts WHERE ref LIKE 'applied-edit:%' ORDER BY rowid DESC LIMIT 1").get() as { hash: string; path: string };
    if (applied.path === WORKER && sha256File(join(ROOT, applied.path)) === applied.hash) {
      publicationHash = applied.hash;
    }
  }

  // evidence archive — fail closed if the capture is missing/empty
  mkdirSync(opts.evidenceDir, { recursive: true });
  const archivedCapturePath = join(opts.evidenceDir, `attempt-${index}-${attemptId}.jsonl`);
  let evidenceOk = false;
  if (existsSync(attempt.capturePath)) {
    try {
      if (readFileSync(attempt.capturePath, 'utf-8').trim().length > 0) {
        copyFileSync(attempt.capturePath, archivedCapturePath);
        evidenceOk = true;
      }
    } catch { evidenceOk = false; }
  }
  if (!evidenceOk && stop === null) {
    return {
      attemptId, index, outcome: 'STOPPED', stop: 'G2',
      stopDetail: 'attempt evidence missing or empty — failing closed',
      providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
      archivedCapturePath: null, publicationHash: null, boundaryRefusals, evaluable: false,
    };
  }

  if (stop !== null) {
    return {
      attemptId, index, outcome: 'STOPPED', stop,
      stopDetail: attemptError instanceof ConfigGuardViolation ? attemptError.message
        : `capture classification: ${JSON.stringify(cls.integrity_failures.slice(0, 3))}`,
      providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
      archivedCapturePath: evidenceOk ? archivedCapturePath : null,
      publicationHash: null, boundaryRefusals, evaluable: false,
    };
  }

  // model-attributable failure: the build step failed, the capture is clean,
  // and the model was actually reached (>=1 provider call observed)
  if (publicationHash === null) {
    if (cls.provider_calls_observed >= 1 && cls.stops.length === 0 && cls.g2 === false) {
      return {
        attemptId, index, outcome: 'MODEL-FAILURE', stop: null, stopDetail:
        `build did not publish (provider calls: ${cls.provider_calls_observed}${attemptError ? `; engine error: ${attemptError instanceof Error ? attemptError.message.slice(0, 160) : String(attemptError).slice(0, 160)}` : ''})`,
        providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
        archivedCapturePath: archivedCapturePath, publicationHash: null, boundaryRefusals, evaluable: true,
      };
    }
    // no model calls and no stop: the attempt never executed — fail closed
    return {
      attemptId, index, outcome: 'STOPPED', stop: 'G2',
      stopDetail: `no publication, no guard stop, and ${cls.provider_calls_observed} provider calls — unclassifiable attempt`,
      providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
      archivedCapturePath: evidenceOk ? archivedCapturePath : null, publicationHash: null,
      boundaryRefusals, evaluable: false,
    };
  }

  return {
    attemptId, index, outcome: 'PUBLISHED', stop: null, stopDetail: null,
    providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
    archivedCapturePath: archivedCapturePath, publicationHash,
    boundaryRefusals, evaluable: true,
  };
}

// ─── the campaign ────────────────────────────────────────────────────────────
export async function runP3Campaign(opts: CampaignOptions): Promise<CampaignResult> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const attempts: AttemptRecord[] = [];
  const result: CampaignResult = {
    attempts, published: 0, modelFailures: 0, evaluable: 0,
    stop: null, stopDetail: null, complete: false, targetRestoredPristine: false,
  };

  // 0 — preflight (separate path, never counted)
  const preflight = opts.runPreflight ? await opts.runPreflight() : await defaultRunPreflight();
  if (preflight.stop !== null) {
    result.stop = preflight.stop;
    result.stopDetail = `preflight: ${preflight.detail}`;
    result.complete = true;
    result.targetRestoredPristine = await restoreTargetPristine();
    return result;
  }

  for (let index = 1; index <= maxAttempts; index++) {
    // 1 — restore + validate the pinned fixture (buildFixture re-verifies
    // every pinned boundary property; failure = campaign STOP, consumes nothing)
    try {
      await buildFixture();
    } catch (err) {
      result.stop = 'FIXTURE-RESTORE';
      result.stopDetail = `fixture restore/validation failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
      result.complete = true;
      result.targetRestoredPristine = await restoreTargetPristine();
      return result;
    }

    // 2+3 — one attempt, classified before counting
    const rec = await runAttempt(index, opts);
    attempts.push(rec);

    if (rec.stop !== null) {
      result.stop = rec.stop;
      result.stopDetail = rec.stopDetail;
      result.complete = true;
      result.targetRestoredPristine = await restoreTargetPristine();
      return result;
    }
    if (rec.outcome === 'PUBLISHED') result.published++;
    else result.modelFailures++;
    result.evaluable++;

    // 4/5 — stop at exactly maxAttempts evaluable attempts
    if (result.evaluable >= maxAttempts) break;
  }

  result.complete = true;
  result.targetRestoredPristine = await restoreTargetPristine();
  if (!result.targetRestoredPristine) {
    result.stop = 'G2';
    result.stopDetail = 'target failed pristine restoration after the campaign';
  }
  return result;
}
