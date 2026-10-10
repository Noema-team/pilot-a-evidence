// P3 LIVE CAMPAIGN RUNNER — the executable lifecycle for the frozen P3
// experiment (launch-review gate: the exact orchestration that decides what
// runs and what counts, qualified offline with scripted providers before any
// live GO).
//
// Lifecycle per the approved prereg + freeze-1 binding:
//   0. (GO time) preflight probe through the SEPARATE composed preflight
//      path — never counted, a preflight STOP aborts the campaign before
//      attempt 1; the probe capture is durably archived OUTSIDE .sle and
//      must show an ACCEPTABLE completion status (stop_reason end_turn AND
//      a non-error finish_reason — the P2 transport-censoring class is
//      rejected, freeze-3 review P1-2)
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
//        unambiguous transport failure -> TRANSPORT-REQUEUE: journaled,
//            consumes NO attempt (frozen denominator_rule: "Transport
//            failure mid-BUILD: journal + re-queue, consumes no attempt;
//            ambiguity is NOT censored; the archived capture decides")
//   4. BEFORE the attempt is counted and BEFORE the next fixture reset
//      destroys the runtime workspace: archive an immutable per-attempt
//      evidence package (guard capture, submission/rejection + provenance +
//      decision DB rows, staging/composition runtime artifacts, publication
//      outcome, diagnostics) self-verified by hash, then write a durable
//      campaign-ledger line (freeze-3 review P1-2)
//   5. stop after exactly MAX_ATTEMPTS evaluable attempts, or immediately
//      on a campaign STOP; transport re-queues are hard-capped at
//      MAX_REQUEUES (exceeding the cap = REQUEUE-EXHAUSTED STOP, return to
//      the operator — retries can never silently exceed the approved scope)
//   6. restore the target PRISTINE: pinned HEAD + worker bytes PLUS a full
//      `git status --porcelain` verification accounting explicitly for
//      .sle/ — any tracked modification or unexpected untracked file fails
//      closed (freeze-3 review P1-3)
//
// Campaign tooling only — Stratum src/ stays frozen at 9f298f2.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync, appendFileSync } from 'node:fs';
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
import { classifyGuardCapture, ConfigGuardViolation, type CaptureClassification } from './config-guard.mts';

const STRATUM = '/home/theo/Documents/coding/repos/stratum';
const ROOT = '/home/theo/Documents/coding/repos/student-platform';
const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const PUBLISHED_UPSTREAM = [
  'docs/cycle-charter.md', 'docs/requirements.md', 'docs/architecture.md',
  'docs/plan.md', 'docs/test-plan.md',
  'apps/ai-server/tests/integration/test_worker_failure_payload_contract.py',
];
const WORKER = P3_TARGET.worker_main_path;
const EXEC_WI = 'wi-exec-108';
const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const sha256String = (s: string): string => createHash('sha256').update(s).digest('hex');

export const MAX_ATTEMPTS = 3;
// freeze-3 review P1-1 — the approved campaign scope is THREE evaluable
// attempts. Transport re-queues consume no slot but are hard-capped: after
// MAX_REQUEUES non-consuming re-queues the campaign STOPs (REQUEUE-EXHAUSTED)
// and returns to the operator. The campaign can therefore never silently
// exceed the approved scope (evaluable <= 3; total attempts <= 3 + 3).
export const MAX_REQUEUES = 3;

export type AttemptOutcome = 'PUBLISHED' | 'MODEL-FAILURE' | 'TRANSPORT-REQUEUE' | 'STOPPED';
export type CampaignStopReason = 'G1' | 'G2' | 'FIXTURE-RESTORE' | 'REQUEUE-EXHAUSTED' | null;

// ─── transport adjudication (frozen denominator_rule, freeze-3 review P1-1) ──
//
// The preregistered rule: "Transport failure mid-BUILD: journal + re-queue,
// consumes no attempt (addendum-2 discipline: ambiguity is NOT censored; the
// archived capture decides)." The archived capture is the DECIDER: only an
// UNAMBIGUOUS infrastructure failure is re-queued without consuming the
// denominator; every ambiguous case remains an evaluable MODEL-FAILURE.
//
// Unambiguous transport classes, grounded in the frozen stack (llm-provider
// error shape `LLM API request failed: <status> <statusText>` and the undici
// fetch wrapper — the ONLY fetch user in the attempt path is the LLM HTTP
// transport; no model-attributable outcome can produce these records):
const TRANSPORT_ERROR_PATTERNS: RegExp[] = [
  /\bfetch failed\b/,                                   // undici network-layer wrapper (TypeError: fetch failed)
  /\bLLM API request failed: (?:5\d\d|408|429)\b/,      // HTTP 5xx / request timeout / rate limit
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|ECONNABORTED)\b/,
  /\bUND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)\b/,
  /\bsocket hang up\b/i,
  /\btimeout\b|\btimed out\b/i,
];

export interface TransportErrorRecord {
  error_name: string | null;
  error_message: string | null;
  step: string | null;
}

export interface TransportAdjudication {
  verdict: 'TRANSPORT-REQUEUE' | 'AMBIGUOUS' | 'NOT-TRANSPORT';
  detail: string;
  error_records: TransportErrorRecord[];
}

const isTransportErrorRecord = (r: TransportErrorRecord): boolean => {
  const hay = `${r.error_name ?? ''} ${r.error_message ?? ''}`;
  return TRANSPORT_ERROR_PATTERNS.some((re) => re.test(hay));
};

// The adjudication reads ONLY the archived capture (the decider per the
// frozen rule). Requirements for a qualifying re-queue:
//   (a) >= 1 archived provider error record,
//   (b) ZERO capture-integrity failures and ZERO guard STOPs (a tampered or
//       stopped capture can never decide a re-queue),
//   (c) EVERY archived error record matches an unambiguous transport class,
//   (d) the LAST archived outcome record is the error itself — the attempt's
//       proximate failure cause is the transport failure, not a later model
//       turn.
// Anything else is AMBIGUOUS (-> evaluable MODEL-FAILURE; never censored).
export function adjudicateTransportFailure(cls: CaptureClassification, capturePath: string): TransportAdjudication {
  const records: TransportErrorRecord[] = cls.errors.map((e) => ({
    error_name: typeof e.error_name === 'string' ? e.error_name : null,
    error_message: typeof e.error_message === 'string' ? e.error_message : null,
    step: typeof e.step === 'string' ? e.step : null,
  }));
  const verdict = (ver: TransportAdjudication['verdict'], detail: string): TransportAdjudication =>
    ({ verdict: ver, detail, error_records: records });

  if (records.length === 0) return verdict('NOT-TRANSPORT', 'no archived provider error records — the failure is not transport-attributable');
  if (cls.integrity_failures.length > 0 || cls.g2) {
    return verdict('AMBIGUOUS', `capture integrity failures present (${cls.integrity_failures.slice(0, 2).join(' | ')}) — a compromised capture cannot decide a re-queue`);
  }
  if (cls.stops.length > 0) return verdict('AMBIGUOUS', 'guard STOPs present in the capture — procedure class, not adjudicable as transport');
  const nonTransport = records.filter((r) => !isTransportErrorRecord(r));
  if (nonTransport.length > 0) {
    return verdict('AMBIGUOUS', `${nonTransport.length}/${records.length} archived error records are not unambiguous transport failures (first: ${nonTransport[0].error_name ?? '?'}: ${(nonTransport[0].error_message ?? '').slice(0, 100)}) — ambiguity is NOT censored (addendum-2)`);
  }

  // (d) — the terminal archived outcome must be the transport error
  const lines = readFileSync(capturePath, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  let lastOutcome: string | null = null;
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as { kind?: string };
      if (r.kind === 'response' || r.kind === 'error') lastOutcome = r.kind!;
    } catch { /* parse failures are integrity failures, rejected above */ }
  }
  if (lastOutcome !== 'error') {
    return verdict('AMBIGUOUS', `the last archived outcome is a ${lastOutcome ?? 'none'} record — the attempt's terminal failure is not the transport error`);
  }
  return verdict('TRANSPORT-REQUEUE',
    `all ${records.length} archived error records are unambiguous transport failures and the capture ends on the transport error — journaled re-queue, consumes no attempt (frozen denominator_rule)`);
}

// ─── preflight completion-status adjudication (freeze-3 review P1-2) ─────────
//
// The GO-time probe is only evidence if it archived an ACCEPTABLE completion:
// exactly one guarded request + response, zero stops/integrity failures, and
// a completion status that is not the P2 transport-censoring class
// (stop_reason end_turn + finish_reason "error" + partial content). The
// adjudication runs on the ARCHIVED copy of the probe capture (durable
// outside .sle), never on the live file alone.
export function adjudicatePreflightCapture(capturePath: string): { accepted: boolean; stop: CampaignStop; detail: string } {
  let cls: CaptureClassification;
  try {
    cls = classifyGuardCapture(capturePath);
  } catch (err) {
    return { accepted: false, stop: 'G2', detail: `preflight capture unreadable (${err instanceof Error ? err.message : String(err)})` };
  }
  if (cls.g1) {
    const first = cls.stops[0];
    const vs = Array.isArray(first?.violations) ? (first.violations as string[]).join('; ') : 'config violation';
    return { accepted: false, stop: 'G1', detail: `preflight guard STOP: ${vs}` };
  }
  if (cls.stops.length > 0 || cls.g2 || cls.integrity_failures.length > 0) {
    return { accepted: false, stop: 'G2', detail: `preflight capture integrity failure: ${(cls.integrity_failures[0] ?? 'unclassified').slice(0, 160)}` };
  }
  if (cls.passes.length !== 1 || cls.responses.length !== 1) {
    return { accepted: false, stop: 'G2', detail: `preflight must archive exactly one request+response (got ${cls.passes.length}/${cls.responses.length})` };
  }
  const resp = cls.responses[0];
  const wire = (resp.wire_observation ?? null) as { finish_reason?: unknown } | null;
  const finish = wire && typeof wire === 'object' ? wire.finish_reason : undefined;
  if (resp.stop_reason !== 'end_turn') {
    return { accepted: false, stop: 'G2', detail: `preflight stop_reason ${String(resp.stop_reason)} is not an acceptable completion status` };
  }
  if (finish !== 'stop' && finish !== 'end_turn') {
    return { accepted: false, stop: 'G2', detail: `preflight finish_reason ${String(finish)} is not acceptable — the P2 transport-censoring class (finish_reason error/length/absent with partial content) is rejected` };
  }
  if (typeof resp.text !== 'string' || resp.text.trim().length === 0) {
    return { accepted: false, stop: 'G2', detail: 'preflight response has no text — not accepted as evidence' };
  }
  return { accepted: true, stop: null, detail: `preflight ok (stop_reason end_turn, finish_reason ${String(finish)}, ${cls.provider_calls_observed} guarded provider call)` };
}

export interface AttemptRecord {
  attemptId: string;
  index: number; // 1-based sequential attempt counter (re-queues included)
  slot: number | null; // 1-based denominator slot (evaluable attempts only)
  outcome: AttemptOutcome;
  stop: CampaignStopReason;
  stopDetail: string | null;
  providerCallsObserved: number;
  capturePath: string;
  archivedCapturePath: string | null;
  evidencePackagePath: string | null;
  evidencePackageSha256: string | null;
  adjudication: TransportAdjudication | null;
  publicationHash: string | null;
  boundaryRefusals: number;
  evaluable: boolean;
}

export interface CampaignResult {
  attempts: AttemptRecord[];
  published: number;
  modelFailures: number;
  evaluable: number;
  requeues: number; // transport re-queues (consumed no slot)
  stop: CampaignStopReason;
  stopDetail: string | null;
  complete: boolean; // true iff the campaign ran to its terminal state (3 evaluable or STOP)
  targetRestoredPristine: boolean;
  ledgerPath: string;
}

export interface CampaignOptions {
  maxAttempts?: number;
  evidenceDir: string; // durable evidence archive: per-attempt packages + campaign ledger
  // offline-test override ONLY: the live campaign never passes this
  composeAttempt?: (attemptId: string) => {
    attemptId: string; capturePath: string; model: string; provider: unknown;
    classifyAttempt: () => { stop: CampaignStop };
  };
  // GO-time preflight; offline tests may override. Returns stop=null on pass.
  runPreflight?: () => Promise<{ stop: CampaignStop; detail: string | null }>;
}

// ─── durable campaign ledger (freeze-3 review P1-2) ──────────────────────────
// Every preflight verdict, attempt classification, transport re-queue, and
// terminal state is appended HERE — outside .sle, written BEFORE the next
// fixture reset — so the campaign record survives any runtime-workspace
// destruction and every re-queue is operator-visible per the frozen rule.
const ledgerPath = (evidenceDir: string): string => join(evidenceDir, 'campaign-ledger.jsonl');
function appendLedger(evidenceDir: string, entry: Record<string, unknown>): void {
  mkdirSync(evidenceDir, { recursive: true });
  appendFileSync(ledgerPath(evidenceDir), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
}

async function defaultRunPreflight(evidenceDir: string): Promise<{ stop: CampaignStop; detail: string | null }> {
  // GO-time implementation: ONE tiny completion through the SEPARATE
  // preflight composition. The guard enforces the frozen contract on the
  // wire (effort low, tiny budget, no tools); a successful, archived
  // response proves the provider accepted it. The probe capture is durably
  // archived OUTSIDE .sle and must pass completion-status adjudication
  // (freeze-3 review P1-2). A preflight STOP aborts the campaign BEFORE
  // attempt 1 and is never counted.
  const probe = composePreflight(ROOT);
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
    // durable preflight archive BEFORE any verdict — the first fixture
    // rebuild deletes .sle, so the probe capture must live outside it
    const preflightDir = join(evidenceDir, 'preflight');
    mkdirSync(preflightDir, { recursive: true });
    const archivedPath = join(preflightDir, 'preflight-guard.jsonl');
    if (!existsSync(probe.capturePath)) {
      return { stop: 'G2', detail: 'preflight: probe capture missing after completion — failing closed' };
    }
    copyFileSync(probe.capturePath, archivedPath);
    const archivedSha = sha256File(archivedPath);
    // completion-status adjudication on the ARCHIVED copy
    const adj = adjudicatePreflightCapture(archivedPath);
    writeFileSync(join(preflightDir, 'preflight-record.json'), JSON.stringify({
      probe_id: probe.probeId,
      live_capture_path: probe.capturePath,
      archived_capture: archivedPath,
      archived_capture_sha256: archivedSha,
      adjudication: adj,
      archived_at_utc: new Date().toISOString(),
    }, null, 1) + '\n');
    if (!adj.accepted) {
      return { stop: adj.stop, detail: `preflight: ${adj.detail}` };
    }
    return { stop: null, detail: adj.detail };
  } catch (err) {
    // archive what exists even on the failure path (evidence before verdict)
    try {
      if (existsSync(probe.capturePath)) {
        const preflightDir = join(evidenceDir, 'preflight');
        mkdirSync(preflightDir, { recursive: true });
        copyFileSync(probe.capturePath, join(preflightDir, 'preflight-guard.jsonl'));
      }
    } catch { /* the classification below fails closed regardless */ }
    const fromViolation = classifyViolation(err);
    if (fromViolation) return { stop: fromViolation, detail: `preflight guard STOP: ${err instanceof Error ? err.message : String(err)}` };
    return { stop: 'G2', detail: `preflight completion failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── pristine-target restoration (freeze-3 review P1-3) ──────────────────────
// Pristine means MORE than HEAD + worker bytes: the FULL worktree must be
// clean. The upstream artifacts are UNTRACKED new files (a `git rm` on them
// fails with "pathspec did not match any files"), so they are removed with
// filesystem operations; the complete `git status --porcelain` output must
// then be EMPTY except the explicitly accounted `.sle/` runtime workspace
// (rebuilt by the fixture). Any tracked modification, staged change, or
// unexpected untracked file fails closed (false), leaving the target for the
// operator — never silently "restored".
export async function restoreTargetPristine(): Promise<boolean> {
  try {
    execFileSync('git', ['-C', ROOT, 'checkout', '--', WORKER]);
    // untracked upstream artifacts: filesystem removal (git rm cannot see them)
    for (const f of PUBLISHED_UPSTREAM) {
      rmSync(join(ROOT, f), { force: true });
    }
    const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
    if (!head.startsWith('86ec0871')) return false;
    if (sha256File(join(ROOT, WORKER)) !== P3_TARGET.worker_main_sha256) return false;
    // FULL worktree verification — the ONLY permitted entry is the .sle/
    // runtime workspace
    const status = execFileSync('git', ['-C', ROOT, 'status', '--porcelain']).toString();
    const unexpected = status
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== '?? .sle/');
    return unexpected.length === 0;
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

// ─── immutable per-attempt evidence package (freeze-3 review P1-2) ───────────
// Archived BEFORE the attempt is counted and BEFORE the next buildFixture()
// destroys .sle. Contents per the review: the request/response guard capture,
// the submission/rejection + provenance + decision DB rows, the staging and
// composition runtime artifacts (.sle/runs), the publication outcome, and
// runtime diagnostics — sealed by a hash manifest that is self-verified.
interface AttemptEvidenceContext {
  attemptId: string;
  index: number;
  capturePath: string;
  stop: CampaignStopReason;
  publicationHash: string | null;
  boundaryRefusals: number;
  engineError: string | null;
  cls: CaptureClassification;
  adjudication: TransportAdjudication | null;
}

async function archiveAttemptEvidence(opts: CampaignOptions, ctx: AttemptEvidenceContext): Promise<{ dir: string; sha256: string }> {
  const dir = join(opts.evidenceDir, `attempt-${ctx.index}-${ctx.attemptId}`);
  if (existsSync(dir)) throw new Error(`attempt evidence package already exists (immutable): ${dir}`);
  mkdirSync(dir, { recursive: true });

  // 1. the request/response capture — fail closed on missing/empty
  if (!existsSync(ctx.capturePath)) throw new Error('guard capture missing at archive time');
  copyFileSync(ctx.capturePath, join(dir, 'guard-capture.jsonl'));
  if (readFileSync(join(dir, 'guard-capture.jsonl'), 'utf-8').trim().length === 0) {
    throw new Error('guard capture empty at archive time');
  }

  // 2. DB records: run row, artifacts (anchors, submissions, applied-edit
  //    provenance), decisions (the confirm approval)
  const { openDatabase } = await import(`${STRATUM}/src/storage/database.js`);
  const d = openDatabase(join(ROOT, '.sle', 'stratum.db'), { readonly: true } as never);
  const dbRecords = {
    workflow_runs: d.prepare('SELECT * FROM workflow_runs WHERE work_item_id = ? ORDER BY rowid').all(EXEC_WI) as Array<Record<string, unknown>>,
    artifacts: d.prepare('SELECT * FROM artifacts WHERE work_item_id = ? ORDER BY rowid').all(EXEC_WI) as Array<Record<string, unknown>>,
    decisions: d.prepare('SELECT * FROM decisions WHERE work_item_id = ? ORDER BY rowid').all(EXEC_WI) as Array<Record<string, unknown>>,
  };
  writeFileSync(join(dir, 'db-records.json'), JSON.stringify(dbRecords, null, 1) + '\n');

  // 3. runtime artifacts (staging + composition evidence + diagnostics)
  const runsDir = join(ROOT, '.sle', 'runs');
  let runsArchive: string | null = null;
  if (existsSync(runsDir)) {
    runsArchive = 'run-artifacts.tgz';
    execFileSync('tar', ['-czf', join(dir, runsArchive), '-C', ROOT, '.sle/runs']);
  } else if (ctx.publicationHash !== null) {
    throw new Error('publication without runtime artifacts — composition evidence absent, failing closed');
  }

  // 4. publication outcome + runtime diagnostics
  writeFileSync(join(dir, 'attempt-outcome.json'), JSON.stringify({
    attempt_id: ctx.attemptId,
    attempt_index: ctx.index,
    stop: ctx.stop,
    published: ctx.publicationHash !== null,
    publication_hash: ctx.publicationHash,
    boundary_refusals: ctx.boundaryRefusals,
    engine_error: ctx.engineError,
    capture_classification: {
      requests: ctx.cls.requests.length,
      passes: ctx.cls.passes.length,
      responses: ctx.cls.responses.length,
      errors: ctx.cls.errors.length,
      stops: ctx.cls.stops.length,
      provider_calls_observed: ctx.cls.provider_calls_observed,
      integrity_failures: ctx.cls.integrity_failures,
    },
    transport_adjudication: ctx.adjudication,
    archived_at_utc: new Date().toISOString(),
  }, null, 1) + '\n');

  // 5. hash manifest + self-verification (the package must prove itself)
  const files = ['guard-capture.jsonl', 'db-records.json', 'attempt-outcome.json', ...(runsArchive ? [runsArchive] : [])];
  const hashes: Record<string, string> = {};
  for (const f of files) hashes[f] = sha256File(join(dir, f));
  const packageSha = sha256String(JSON.stringify(hashes));
  writeFileSync(join(dir, 'evidence-manifest.json'), JSON.stringify({
    attempt_id: ctx.attemptId, attempt_index: ctx.index, files: hashes, package_sha256: packageSha,
  }, null, 1) + '\n');
  for (const f of files) {
    if (sha256File(join(dir, f)) !== hashes[f]) throw new Error(`evidence package self-verification failed for ${f}`);
  }
  const reread = (JSON.parse(readFileSync(join(dir, 'evidence-manifest.json'), 'utf-8')) as { files: Record<string, string>; package_sha256: string });
  if (sha256String(JSON.stringify(reread.files)) !== packageSha || reread.package_sha256 !== packageSha) {
    throw new Error('evidence manifest does not round-trip');
  }
  return { dir, sha256: packageSha };
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
  void publishedHook;
  const engine = await buildEngine(attempt, {
    onRefusal: () => boundaryRefusals++,
    onPublished: () => { publishedHook++; },
  });

  // find the pending confirm decision (the fixture leaves it pending)
  const { openDatabase } = await import(`${STRATUM}/src/storage/database.js`);
  const { DecisionRepository } = await import(`${STRATUM}/src/storage/repositories.js`);
  const d = openDatabase(join(ROOT, '.sle', 'stratum.db'), {} as never);
  const decisions = new DecisionRepository(d);
  const pending = decisions.listByWorkItem(EXEC_WI).find((x: { status: string }) => x.status === 'pending');
  if (!pending) {
    return {
      attemptId, index, slot: null, outcome: 'STOPPED', stop: 'FIXTURE-RESTORE',
      stopDetail: 'no pending confirm decision after fixture restore', providerCallsObserved: 0,
      capturePath: attempt.capturePath, archivedCapturePath: null,
      evidencePackagePath: null, evidencePackageSha256: null, adjudication: null,
      publicationHash: null, boundaryRefusals: 0, evaluable: false,
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

  // transport adjudication (frozen denominator_rule) — only the
  // no-publication, no-stop, clean-capture case can be transport-attributable
  let adjudication: TransportAdjudication | null = null;
  if (stop === null && publicationHash === null) {
    try {
      adjudication = adjudicateTransportFailure(cls, attempt.capturePath);
    } catch (err) {
      // the capture became unreadable after classification — tamper class
      return {
        attemptId, index, slot: null, outcome: 'STOPPED', stop: 'G2',
        stopDetail: `capture unreadable during transport adjudication — failing closed (${err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)})`,
        providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
        archivedCapturePath: null, evidencePackagePath: null, evidencePackageSha256: null,
        adjudication: null, publicationHash: null, boundaryRefusals, evaluable: false,
      };
    }
  }

  // durable evidence package — BEFORE counting, BEFORE the next fixture reset
  // destroys the runtime workspace (freeze-3 review P1-2); fail closed
  let evidencePackagePath: string | null = null;
  let evidencePackageSha256: string | null = null;
  try {
    const pkg = await archiveAttemptEvidence(opts, {
      attemptId, index, capturePath: attempt.capturePath, stop,
      publicationHash, boundaryRefusals,
      engineError: attemptError instanceof Error ? attemptError.message.slice(0, 300) : attemptError ? String(attemptError).slice(0, 300) : null,
      cls, adjudication,
    });
    evidencePackagePath = pkg.dir;
    evidencePackageSha256 = pkg.sha256;
  } catch (err) {
    return {
      attemptId, index, slot: null, outcome: 'STOPPED', stop: 'G2',
      stopDetail: `attempt evidence archive failed — failing closed (${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)})`,
      providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
      archivedCapturePath: null, evidencePackagePath: null, evidencePackageSha256: null,
      adjudication, publicationHash: null, boundaryRefusals, evaluable: false,
    };
  }
  const archivedCapturePath = join(evidencePackagePath!, 'guard-capture.jsonl');

  if (stop !== null) {
    return {
      attemptId, index, slot: null, outcome: 'STOPPED', stop,
      stopDetail: attemptError instanceof ConfigGuardViolation ? attemptError.message
        : `capture classification: ${JSON.stringify(cls.integrity_failures.slice(0, 3))}`,
      providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
      archivedCapturePath, evidencePackagePath, evidencePackageSha256,
      adjudication, publicationHash: null, boundaryRefusals, evaluable: false,
    };
  }

  if (publicationHash !== null) {
    return {
      attemptId, index, slot: null, outcome: 'PUBLISHED', stop: null, stopDetail: null,
      providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
      archivedCapturePath, evidencePackagePath, evidencePackageSha256,
      adjudication, publicationHash, boundaryRefusals, evaluable: true,
    };
  }

  // unambiguous transport failure: journaled re-queue, consumes NO attempt
  // (the campaign loop re-queues; bounded by MAX_REQUEUES)
  if (adjudication?.verdict === 'TRANSPORT-REQUEUE') {
    return {
      attemptId, index, slot: null, outcome: 'TRANSPORT-REQUEUE', stop: null,
      stopDetail: adjudication.detail,
      providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
      archivedCapturePath, evidencePackagePath, evidencePackageSha256,
      adjudication, publicationHash: null, boundaryRefusals, evaluable: false,
    };
  }

  // model-attributable failure: the build step failed, the capture is clean,
  // and the model was actually reached (>=1 provider call observed).
  // AMBIGUOUS error records stay HERE (evaluable) — never censored.
  if (cls.provider_calls_observed >= 1 && cls.stops.length === 0 && cls.g2 === false) {
    return {
      attemptId, index, slot: null, outcome: 'MODEL-FAILURE', stop: null, stopDetail:
      `build did not publish (provider calls: ${cls.provider_calls_observed}${adjudication ? `; transport adjudication: ${adjudication.verdict} — ${adjudication.detail.slice(0, 160)}` : ''}${attemptError ? `; engine error: ${attemptError instanceof Error ? attemptError.message.slice(0, 160) : String(attemptError).slice(0, 160)}` : ''})`,
      providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
      archivedCapturePath, evidencePackagePath, evidencePackageSha256,
      adjudication, publicationHash: null, boundaryRefusals, evaluable: true,
    };
  }
  // no model calls and no stop: the attempt never executed — fail closed
  return {
    attemptId, index, slot: null, outcome: 'STOPPED', stop: 'G2',
    stopDetail: `no publication, no guard stop, and ${cls.provider_calls_observed} provider calls — unclassifiable attempt`,
    providerCallsObserved: cls.provider_calls_observed, capturePath: attempt.capturePath,
    archivedCapturePath, evidencePackagePath, evidencePackageSha256,
    adjudication, publicationHash: null, boundaryRefusals, evaluable: false,
  };
}

// ─── the campaign ────────────────────────────────────────────────────────────
export async function runP3Campaign(opts: CampaignOptions): Promise<CampaignResult> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const attempts: AttemptRecord[] = [];
  const result: CampaignResult = {
    attempts, published: 0, modelFailures: 0, evaluable: 0, requeues: 0,
    stop: null, stopDetail: null, complete: false, targetRestoredPristine: false,
    ledgerPath: ledgerPath(opts.evidenceDir),
  };

  // 0 — preflight (separate path, never counted; durably archived + adjudicated)
  const preflight = opts.runPreflight ? await opts.runPreflight() : await defaultRunPreflight(opts.evidenceDir);
  appendLedger(opts.evidenceDir, {
    event: 'preflight', accepted: preflight.stop === null, stop: preflight.stop, detail: preflight.detail,
  });
  if (preflight.stop !== null) {
    result.stop = preflight.stop;
    result.stopDetail = `preflight: ${preflight.detail}`;
    result.complete = true;
    result.targetRestoredPristine = await restoreTargetPristine();
    appendLedger(opts.evidenceDir, { event: 'campaign-terminal', stop: result.stop, stopDetail: result.stopDetail, evaluable: 0, requeues: 0 });
    return result;
  }

  let index = 0;
  let requeues = 0;
  while (result.evaluable < maxAttempts) {
    index++;
    // scope guard (defensive): evaluable <= maxAttempts and requeues <=
    // MAX_REQUEUES bound the loop; reaching here means the accounting broke —
    // fail closed rather than exceed the approved scope
    if (index > maxAttempts + MAX_REQUEUES) {
      result.stop = 'G2';
      result.stopDetail = 'campaign scope guard tripped (attempt accounting diverged) — failing closed';
      result.complete = true;
      result.targetRestoredPristine = await restoreTargetPristine();
      appendLedger(opts.evidenceDir, { event: 'campaign-terminal', stop: result.stop, stopDetail: result.stopDetail, evaluable: result.evaluable, requeues });
      return result;
    }

    // 1 — restore + validate the pinned fixture (buildFixture re-verifies
    // every pinned boundary property; failure = campaign STOP, consumes nothing)
    try {
      await buildFixture();
    } catch (err) {
      result.stop = 'FIXTURE-RESTORE';
      result.stopDetail = `fixture restore/validation failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
      result.complete = true;
      result.targetRestoredPristine = await restoreTargetPristine();
      appendLedger(opts.evidenceDir, { event: 'campaign-terminal', stop: result.stop, stopDetail: result.stopDetail, evaluable: result.evaluable, requeues });
      return result;
    }

    // 2+3 — one attempt, classified before counting
    const rec = await runAttempt(index, opts);
    attempts.push(rec);

    // 4 — durable ledger line BEFORE anything else touches the runtime
    // workspace (the next iteration's buildFixture wipes .sle)
    appendLedger(opts.evidenceDir, {
      event: 'attempt', index: rec.index, attempt_id: rec.attemptId, outcome: rec.outcome,
      evaluable: rec.evaluable, stop: rec.stop, slot: rec.slot,
      provider_calls_observed: rec.providerCallsObserved,
      publication_hash: rec.publicationHash, boundary_refusals: rec.boundaryRefusals,
      transport_adjudication: rec.adjudication?.verdict ?? null,
      adjudication_detail: rec.adjudication?.detail ?? null,
      evidence_package: rec.evidencePackagePath,
      evidence_package_sha256: rec.evidencePackageSha256,
      stop_detail: rec.stopDetail,
    });

    // transport re-queue: journaled (operator-visible), consumes NO slot,
    // hard-capped so retries can never silently exceed the approved scope
    if (rec.outcome === 'TRANSPORT-REQUEUE') {
      requeues++;
      result.requeues = requeues;
      appendLedger(opts.evidenceDir, {
        event: 'transport-requeue', index: rec.index, attempt_id: rec.attemptId,
        requeues_used: requeues, requeues_cap: MAX_REQUEUES, detail: rec.stopDetail,
      });
      if (requeues > MAX_REQUEUES) {
        result.stop = 'REQUEUE-EXHAUSTED';
        result.stopDetail = `${requeues} unambiguous transport re-queues exceed the cap of ${MAX_REQUEUES} — returning to the operator (no attempt consumed by re-queues; ${result.evaluable} evaluable so far)`;
        result.complete = true;
        result.targetRestoredPristine = await restoreTargetPristine();
        appendLedger(opts.evidenceDir, { event: 'campaign-terminal', stop: result.stop, stopDetail: result.stopDetail, evaluable: result.evaluable, requeues });
        return result;
      }
      continue;
    }

    if (rec.stop !== null) {
      result.stop = rec.stop;
      result.stopDetail = rec.stopDetail;
      result.complete = true;
      result.targetRestoredPristine = await restoreTargetPristine();
      appendLedger(opts.evidenceDir, { event: 'campaign-terminal', stop: result.stop, stopDetail: result.stopDetail, evaluable: result.evaluable, requeues });
      return result;
    }

    // counted: the slot is assigned ONLY here — re-queues never consumed one
    if (rec.outcome === 'PUBLISHED') result.published++;
    else result.modelFailures++;
    result.evaluable++;
    rec.slot = result.evaluable;
    appendLedger(opts.evidenceDir, { event: 'attempt-counted', index: rec.index, slot: rec.slot, outcome: rec.outcome, evaluable_total: result.evaluable });
  }

  result.complete = true;
  result.targetRestoredPristine = await restoreTargetPristine();
  if (!result.targetRestoredPristine) {
    result.stop = 'G2';
    result.stopDetail = 'target failed pristine restoration after the campaign';
  }
  appendLedger(opts.evidenceDir, {
    event: 'campaign-terminal', stop: result.stop, stopDetail: result.stopDetail,
    evaluable: result.evaluable, published: result.published, model_failures: result.modelFailures,
    requeues, target_restored_pristine: result.targetRestoredPristine,
  });
  return result;
}
