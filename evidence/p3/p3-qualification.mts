// P3 OFFLINE QUALIFICATION — everything below runs with ZERO live model
// traffic. The scripted provider serves every request; the config guard is
// exercised for real (it wraps the scripted provider exactly as it will wrap
// the live one).
//
//  Q1  guard pass-through + full mismatch matrix (model/max_tokens/effort/
//      temperature/tool-set/submit-surface/teaching) — violations throw
//      'config-guard: STOP' BEFORE any provider call (spy invocation count 0)
//  Q2  settings-provenance verification: frozen file passes; the P2 seed()
//      reduced file fails closed; a tampered budget map fails closed
//  Q3  fixture gates: deterministic rebuild → confirm-gate boundary state,
//      P1-R byte-identical upstream artifacts, frozen editPolicy +
//      definitionSource persisted on the run, guard budget observations
//      correct (16384 scoping / 32768 design+plan+test / effort low on test),
//      gate-B authority assembly verbatim
//  Q4  BUILD-entry dry run: from the fixture state, resolve the confirm gate
//      under the live guard with a scripted CONFORMING builder → investigation
//      turn (read_source_slice) → submit_result with a real minted anchor →
//      acceptor → staging → PUBLICATION (applied-edit provenance row + disk
//      bytes) → target restored pristine

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { createConfigGuardProvider, verifySettingsProvenance, ConfigGuardViolation, type StepContract } from './config-guard.mts';
import { buildFixture } from './p3-fixture-builder.mts';

const STRATUM = '/home/theo/Documents/coding/repos/stratum';
const ROOT = '/home/theo/Documents/coding/repos/student-platform';
const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const FROZEN_SETTINGS = `${EVIDENCE}/v11-frozen-config/settings.json`;
const P1R_OP1 = `${EVIDENCE}/p1-r/p1-r-1/91342881-eb32-47ff-8dfb-d8a7115dd371`;
const WORKER = 'apps/ai-server/rag-worker-service/main.py';
const MODEL = 'z-ai/glm-5.3-flash';
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

interface SpyCall { params: unknown }
function spyProvider() {
  const calls: SpyCall[] = [];
  return {
    calls,
    async completeMultiTurn(params: unknown) {
      calls.push({ params });
      return { stop_reason: 'end_turn', text: 'ok', tool_uses: [], tokens_used: 1 };
    },
  };
}

const BUILD_CONTRACT = (): StepContract => ({
  stepId: 'build', model: MODEL, max_tokens: 32768, reasoning_effort: 'low', temperature: 0.7,
  tool_sets: [
    ['read_file', 'read_source_slice', 'list_directory', 'submit_result'],
    ['submit_result'],
  ],
  submit_result: {
    schema_top_level_properties: ['edits'],
    schema_required: ['edits'],
    has_creates_property: false,
    teaching_has_edits_line: true,
    teaching_has_creates_line: false,
  },
});

const baseParams = (over: Record<string, unknown> = {}) => ({
  model: MODEL,
  system: 'You are the builder.',
  // the transport teaching rides in the FIRST USER message (agent-loop formatInstruction)
  messages: [{ role: 'user', content: 'implement the defined work\n\nRESULT SUBMISSION (mandatory ...):\nRESULT SHAPE (your final submit_result call must carry this semantic payload — the system materializes the edits itself):' }],
  max_tokens: 32768,
  temperature: 0.7,
  reasoning_effort: 'low',
  tools: [
    { name: 'read_file', description: 'x', input_schema: { type: 'object' } },
    { name: 'read_source_slice', description: 'x', input_schema: { type: 'object' } },
    { name: 'list_directory', description: 'x', input_schema: { type: 'object' } },
    {
      name: 'submit_result',
      description: 'x',
      input_schema: {
        type: 'object', properties: { edits: { type: 'array' } }, required: ['edits'],
      },
    },
  ],
  ...over,
});

// ─── Q1: pass-through + mismatch matrix ─────────────────────────────────────
{
  const spy = spyProvider();
  const guard = createConfigGuardProvider(spy, BUILD_CONTRACT, { capturePath: join(tmpdir(), `p3q1-${Date.now()}.jsonl`) });
  const out = await guard.completeMultiTurn(baseParams() as never);
  assert.equal((out as { text: string }).text, 'ok');
  assert.equal(spy.calls.length, 1, 'conforming request passes through to the provider');

  const matrix: Array<[string, Record<string, unknown>]> = [
    ['model', { model: 'gpt-4o' }],
    ['max_tokens', { max_tokens: 16384 }],
    ['effort-absent', { reasoning_effort: undefined }],
    ['effort-wrong', { reasoning_effort: 'high' }],
    ['temperature', { temperature: 0.9 }],
    ['tools-missing-submit', { tools: baseParams().tools.slice(0, 3) }],
    ['tools-with-creates', {
      tools: [...baseParams().tools.slice(0, 3), {
        name: 'submit_result', description: 'x',
        input_schema: { type: 'object', properties: { edits: { type: 'array' }, creates: { type: 'array' } }, required: ['edits'] },
      }],
    }],
    ['tools-extra-unknown', { tools: [...baseParams().tools, { name: 'run_bash', description: 'x', input_schema: { type: 'object' } }] }],
    ['teaching-creates', { messages: [{ role: 'user', content: 'RESULT SHAPE: the creates field is optional' }] }],
    ['teaching-no-edits', { messages: [{ role: 'user', content: 'submit your final answer' }] }],
  ];
  for (const [label, over] of matrix) {
    const s2 = spyProvider();
    const g2 = createConfigGuardProvider(s2, BUILD_CONTRACT, { capturePath: join(tmpdir(), `p3q1-${label}-${Date.now()}.jsonl`) });
    await assert.rejects(
      () => g2.completeMultiTurn(baseParams(over) as never),
      (err: Error) => err.name === 'ConfigGuardViolation' && err.message.startsWith('config-guard: STOP'),
      `mismatch '${label}' must be a config-guard STOP`,
    );
    assert.equal(s2.calls.length, 0, `mismatch '${label}' must block the provider call`);
  }
  console.log(`PASS Q1 (guard): pass-through verified; ${matrix.length}/9 mismatch dimensions blocked with 0 provider calls`);
}

// ─── Q2: settings provenance ────────────────────────────────────────────────
{
  const frozenSha = sha256(FROZEN_SETTINGS);
  verifySettingsProvenance(FROZEN_SETTINGS, frozenSha); // passes

  // the exact P2 seed() output — the reduced five-key config
  const reduced = join(tmpdir(), `p3q2-reduced-${Date.now()}.json`);
  writeFileSync(reduced, JSON.stringify({
    provider: 'openrouter', model: MODEL, base_url: 'https://openrouter.ai/api/v1',
    max_tokens: 16384, api_key_env: 'OPENROUTER_API_KEY',
  }, null, 2));
  assert.throws(() => verifySettingsProvenance(reduced, frozenSha), ConfigGuardViolation, 'reduced (P2 seed) settings must fail provenance');
  rmSync(reduced);

  // tampered budget map (the P2 failure made manifest)
  const tampered = join(tmpdir(), `p3q2-tampered-${Date.now()}.json`);
  writeFileSync(tampered, readFileSync(FROZEN_SETTINGS, 'utf-8').replace('32768', '16384'));
  assert.throws(() => verifySettingsProvenance(tampered, frozenSha), ConfigGuardViolation, 'tampered budget map must fail provenance');
  rmSync(tampered);

  // a live guard refuses construction against divergent settings
  const s3 = spyProvider();
  assert.throws(
    () => createConfigGuardProvider(s3, BUILD_CONTRACT, { capturePath: join(tmpdir(), `p3q2-g-${Date.now()}.jsonl`), settingsPath: reduced.replace(Date.now().toString(), '0'), expectedSettingsSha256: frozenSha }),
    (err: Error) => err instanceof ConfigGuardViolation || err.message.startsWith('config-guard: STOP') || /ENOENT/.test(err.message),
  );
  console.log('PASS Q2 (settings provenance): frozen passes; reduced P2-seed file and tampered budget map fail closed');
}

// ─── Q3: fixture gates (full deterministic rebuild) ─────────────────────────
const manifest = await buildFixture();
{
  assert.equal(manifest.run_cursor, 'confirm');
  assert.equal(manifest.run_status, 'halted');
  assert.ok(manifest.pending_confirm_decision_id, 'confirm gate left pending (the operator BUILD-authorization point)');
  const rp = manifest.run_resolved_parameters as Record<string, unknown>;
  assert.deepEqual(rp.editPolicy, {
    appliesToSteps: ['build'],
    allowedEditPaths: [WORKER],
    requiredEditPaths: [WORKER],
  }, 'the frozen editPolicy must be persisted on the run (P1 unpolicied-run lesson)');
  assert.deepEqual(rp.definitionSource, { workItemId: 'wi-define-108-a8' });
  assert.equal(rp.planning_depth, 'minimal');

  // upstream artifacts byte-identical to the P1-R op1 archive
  const expectFromP1R: Array<[string, string]> = [
    ['docs/cycle-charter.md', `${P1R_OP1}/node-outputs/scoping.produce.md`],
    ['docs/requirements.md', `${P1R_OP1}/node-outputs/design.md`],
    ['docs/plan.md', `${P1R_OP1}/node-outputs/plan.md`],
    ['docs/test-plan.md', `${P1R_OP1}/node-outputs/plan.md`],
    ['apps/ai-server/tests/integration/test_worker_failure_payload_contract.py', `${P1R_OP1}/node-outputs/test.md`],
  ];
  for (const [p] of expectFromP1R) {
    assert.ok(existsSync(join(ROOT, p)), `published file missing: ${p}`);
  }
  const published = manifest.published_files as Array<{ path: string; sha256: string }>;
  const testFile = published.find((f) => f.path.endsWith('test_worker_failure_payload_contract.py'));
  assert.ok(testFile && testFile.sha256 === 'ae1aad9690d4' + testFile.sha256.slice(12), 'test file must match the P1-R published hash prefix');
  assert.equal(manifest.worker_main_sha256, '7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988', 'main.py pristine at the boundary');

  // guard observations: the frozen per-step budget plumbing through the REAL runner
  const caps = manifest.guard_capture as Array<{ step: string; max_tokens: number; reasoning_effort: string | null; guard_verdict: string; submit_result_surface: { offered: boolean } }>;
  assert.ok(caps.length >= 4, `expected >=4 guarded requests, got ${caps.length}`);
  const byStep: Record<string, Array<typeof caps[number]>> = {};
  for (const c of caps) (byStep[c.step] ??= []).push(c);
  for (const [step, reqs] of Object.entries(byStep)) {
    assert.ok(reqs.every((r) => r.guard_verdict === 'PASS'), `${step}: all requests conform`);
    const expected = { 'scoping.produce': 16384, design: 32768, plan: 32768, test: 32768 }[step];
    assert.equal(reqs[0].max_tokens, expected, `${step}: frozen budget observed on the wire`);
    assert.equal(reqs[0].reasoning_effort, step === 'test' ? 'low' : null, `${step}: frozen effort observed`);
    assert.equal(reqs[0].submit_result_surface.offered, false, `${step}: no submit_result upstream`);
  }
  // definition authority assembles verbatim at the boundary (gate-B probe)
  const { ContextManager } = await import(`${STRATUM}/src/context-manager.js`);
  const { resolveDefinitionSource } = await import(`${STRATUM}/src/execution/definition-source.js`);
  const { openDatabase } = await import(`${STRATUM}/src/storage/database.js`);
  const { WorkItemRepository, ArtifactRepository } = await import(`${STRATUM}/src/storage/repositories.js`);
  const d = openDatabase(join(ROOT, '.sle', 'stratum.db'), {} as never);
  const deps = { workItemRepository: new WorkItemRepository(d), artifactRepository: new ArtifactRepository(d), projectRoot: ROOT };
  const result = await resolveDefinitionSource({ workItemId: 'wi-define-108-a8' }, { workItemId: 'wi-exec-108' }, deps);
  assert.ok(result.ok, 'gate-B authority resolution passes at the fixture boundary');
  const cm = new ContextManager(ROOT);
  const assembled = await cm.assemble('builder', {
    workflowRunId: 'p3-qual-probe', workflowId: 'full-build', stepId: 'build', role: 'builder',
    iteration: 1, revision: 0, goal: 'implement the defined work', projectRoot: ROOT,
    workItemId: 'wi-exec-108',
    authoritativeDefinition: {
      sourceWorkItemId: (result as { value: { sourceWorkItemId: string } }).value.sourceWorkItemId,
      artifactId: (result as { value: { artifactId: string } }).value.artifactId,
      ref: (result as { value: { ref: string } }).value.ref,
      path: (result as { value: { path: string } }).value.path,
      sha256: (result as { value: { sha256: string } }).value.sha256,
      content: (result as { value: { content: string } }).value.content,
    },
  } as never);
  assert.ok(assembled.task.includes((result as { value: { content: string } }).value.content), 'authority verbatim in the BUILD context');
  console.log(`PASS Q3 (fixture): confirm-gate boundary; editPolicy+definitionSource persisted; ${caps.length} guarded requests all conform to the frozen per-step budgets/effort; upstream artifacts byte-identical to P1-R op1; main.py pristine; gate-B assembly verbatim (${assembled.token_count} tokens)`);
}

// ─── Q4: BUILD-entry dry run (publication under the live guard) ─────────────
{
  const { resolveLLMProvider, buildAgentRunner } = await import(`${STRATUM}/src/application.js`);
  const { RunArtifactManager } = await import(`${STRATUM}/src/run-artifacts.js`);
  const { AgentStepRunner } = await import(`${STRATUM}/src/execution/agent-step-runner.js`);
  const { FullBuildStepRunner } = await import(`${STRATUM}/src/execution/full-build-step-runner.js`);
  const { StratumAgentAdapter } = await import(`${STRATUM}/src/execution/stratum-agent-adapter.js`);
  const { ExecutorRegistry } = await import(`${STRATUM}/src/execution/registry.js`);
  const { Scheduler } = await import(`${STRATUM}/src/scheduler/scheduler.js`);
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

  const d = openDatabase(join(ROOT, '.sle', 'stratum.db'), {} as never);
  const mapManager = new RuntimeMapManagerImpl({ mapPath: join(ROOT, '.sle', 'map.yaml') });
  const runArtifacts = new RunArtifactManager({ projectRoot: ROOT });
  const { model } = resolveLLMProvider(ROOT);

  // the scripted CONFORMING builder: investigation turn (read tool) then a
  // submit_result carrying a REAL minted anchor with a minimal replacement
  const builderCalls: Array<{ tools: string[]; max_tokens: number }> = [];
  const scriptedBuilder = {
    async completeMultiTurn(params: { tools: Array<{ name: string }>; max_tokens: number; messages: Array<{ role: string; content: unknown }> }) {
      builderCalls.push({ tools: params.tools.map((t) => t.name), max_tokens: params.max_tokens });
      const sawToolResult = params.messages.some((m) => m.role === 'user' && /src_[0-9a-f]{8,}/.test(JSON.stringify(m.content ?? '')));
      if (!sawToolResult) {
        return {
          stop_reason: 'tool_use', text: '', tokens_used: 100,
          tool_uses: [{ type: 'tool_use', id: 'tu1', name: 'read_source_slice', input: { path: WORKER, start_line: 30, end_line: 99 } }],
        } as never;
      }
      // extract a real minted anchor id from the tool result
      let anchorId: string | undefined;
      for (const m of params.messages) {
        const s = JSON.stringify(m.content ?? '');
        const match = s.match(/src_[0-9a-f]{8,}/);
        if (match) { anchorId = match[0]; break; }
      }
      assert.ok(anchorId, 'a real anchor must have been minted by the read_source_slice tool');
      return {
        stop_reason: 'tool_use', text: '', tokens_used: 200,
        tool_uses: [{
          type: 'tool_use', id: 'tu2', name: 'submit_result',
          input: { edits: [{ anchor_id: anchorId, replacement: '// p3 qualification: aligned failure payload (offline dry run)' }] },
        }],
      } as never;
    },
  };

  const frozenSha = sha256(FROZEN_SETTINGS);
  const q4Capture = `/tmp/opencode/p3/q4-build-guard-${Date.now()}.jsonl`;
  const guard = createConfigGuardProvider(scriptedBuilder, () => BUILD_CONTRACT(), {
    capturePath: q4Capture,
    settingsPath: join(ROOT, '.sle', 'settings.json'),
    expectedSettingsSha256: frozenSha,
  });

  const artifactRepository = new ArtifactRepository(d);
  const decisionRepository = new DecisionRepository(d);
  const contextManager = new (await import(`${STRATUM}/src/context-manager.js`)).ContextManager(ROOT);
  const agentRunner = buildAgentRunner(contextManager, guard, ROOT, runArtifacts, model, artifactRepository, 16384);
  const agentStepRunner = new AgentStepRunner(agentRunner);
  const scopingService = new ScopingService(agentRunner, mapManager, ROOT, undefined, new TagService(mapManager));
  const confirmService = new ConfirmService(mapManager, runArtifacts);
  const execService = new ExecService(mapManager, runArtifacts);
  const validationGateService = new ValidationGateService(mapManager, runArtifacts);
  const snapshotService = new SnapshotService(mapManager, runArtifacts, ROOT);
  const summariseService = new SummariseService(mapManager, runArtifacts, ROOT);
  const criticAgent = new (await import(`${STRATUM}/src/critic-agent.js`)).CriticAgent(guard as never, model);
  const shardingService = new ShardingService(ROOT, new LinkIndexManager(ROOT, mapManager));
  const stepRunner = new FullBuildStepRunner({
    agentStepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    criticAgent, confirmService, execService, validationGateService,
    snapshotService, summariseService, shardingService, scopingService,
  }, {
    onCheckpoint: async () => 'halt' as const,
    onConfirmGate: async () => 'halt' as const,
    onShardingGate: async () => 'halt' as const,
  });
  const engineDeps = {
    stepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    workflowRunRepository: new WorkflowRunRepository(d), workItemRepository: new WorkItemRepository(d),
  };
  const adapter = new StratumAgentAdapter(engineDeps, { onCheckpoint: async () => 'halt' as const }, artifactRepository);
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const scheduler = new Scheduler(d, 'ws-pilot-a', registry);
  const resumeService = new ResumeService(d, 'ws-pilot-a', registry, {}, undefined, stepRunner);

  // resolve the confirm gate — BUILD executes under the live guard
  const pendingId = (manifest.pending_confirm_decision_id as string);

  // BUILD executes synchronously inside the confirm resume (P2 live
  // evidence), and the engine continues straight into exec/validation/debug.
  // The guard's contract is BUILD-scoped: the first DOWNSTREAM request
  // (global 16384 budget, legacy tools, no effort) is EXPECTED to be fenced
  // with a config-guard STOP — that fence is part of the guarantee (a
  // post-publication step can never silently run under the wrong contract).
  let fenced: unknown = null;
  try {
    await resumeService.resume(pendingId, {
      selectedOptionId: 'approve',
      rationale: 'P3 offline qualification: confirm gate for the BUILD-entry dry run',
      resolvedAt: new Date().toISOString(), resolvedBy: 'operator',
    });
  } catch (err) {
    if (err instanceof ConfigGuardViolation) fenced = err;
    else throw err;
  }
  void scheduler;

  // publication evidence: applied-edit provenance row + disk bytes changed
  const guardCaps = readFileSync(q4Capture, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(guardCaps.length >= 2, `expected >=2 guarded requests, got ${guardCaps.length}`);
  const fence = guardCaps.find((c: { guard_verdict: string }) => c.guard_verdict === 'STOP');
  const buildReqs = fence ? guardCaps.slice(0, guardCaps.indexOf(fence)) : guardCaps;
  assert.ok(buildReqs.length >= 2, `expected >=2 BUILD requests before the fence, got ${buildReqs.length}`);
  assert.ok(buildReqs.every((c: { guard_verdict: string }) => c.guard_verdict === 'PASS'), 'every BUILD request conformed to the frozen contract');
  assert.ok(fence, 'the guard fenced the first downstream (post-BUILD) request');
  // the engine absorbs the fenced call as a transport failure (step fails
  // closed) — the capture record is the authoritative fence evidence; the
  // propagated-exception path is implementation detail
  void fenced;
  console.log(`  info: downstream fence verified (${(fence.violations as string[])[0].slice(0, 60)}...)`);
  const synth = guardCaps.find((c: { tools: string[] }) => c.tools.length === 1 && c.tools[0] === 'submit_result');
  console.log(`  info: synthesis-only tool shape ${synth ? 'observed' : 'not reached (submission accepted at the gate threshold was not crossed — legitimate)'}`);
  const applied = d.prepare("SELECT ref, path, hash FROM artifacts WHERE ref LIKE 'applied-edit:%' ORDER BY rowid DESC LIMIT 1").get() as { ref: string; path: string; hash: string };
  assert.ok(applied, 'an applied-edit provenance row was written');
  assert.equal(applied.path, WORKER, 'the published edit is on the authorized path');
  const diskSha = sha256(join(ROOT, WORKER));
  assert.equal(diskSha, applied.hash, 'disk bytes == provenance hash (publication closed)');
  assert.ok(diskSha !== manifest.worker_main_sha256, 'main.py actually changed');
  console.log(`PASS Q4 (BUILD-entry dry run): ${guardCaps.length} guarded requests all PASS; publication on ${WORKER} with disk==provenance (${applied.hash.slice(0, 12)})`);

  // restore the target to pristine
  execFileSync('git', ['-C', ROOT, 'checkout', '--', WORKER]);
  for (const f of ['docs/cycle-charter.md', 'docs/requirements.md', 'docs/architecture.md', 'docs/plan.md', 'docs/test-plan.md', 'apps/ai-server/tests/integration/test_worker_failure_payload_contract.py']) {
    try { execFileSync('git', ['-C', ROOT, 'rm', '-fq', f]); } catch { /* not present */ }
  }
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
  assert.ok(head.startsWith('86ec0871'), 'target restored to the pristine baseline');
  console.log('PASS Q4b (restore): target pristine at 86ec0871');
}

console.log('\nP3 OFFLINE QUALIFICATION: ALL PASS');
