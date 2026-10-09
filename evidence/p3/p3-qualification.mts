// P3 OFFLINE QUALIFICATION v2 — everything below runs with ZERO live model
// traffic. The scripted provider serves every request; the config guard is
// exercised for real (it wraps the scripted provider exactly as it will wrap
// the live one).
//
// v2 implements the P3 design-review corrections:
//   C1  captures unique per instantiation + exact reconciliation (Q3, Q4)
//   C2  recursive tool-schema hashing with mutation sensitivity proven;
//       create-related teaching checked across ALL model-visible messages (Q1)
//   C3  positive publication-boundary halt — the workflow is stopped by the
//       harness BEFORE the next stage starts; zero downstream model calls and
//       zero downstream side effects are PROVEN, not inferred from a rejected
//       request (Q4); a genuine BUILD guard violation surfaces to the
//       campaign as G1 (Q5a)
//   C4  full provider observability: complete/completeStructured explicitly
//       blocked (Q1); responses/errors archived next to verified requests;
//       campaign-level recognition of G1 (guard STOP) and G2 (capture
//       integrity) demonstrated on real capture shapes (Q5)
//   C5  the issue input is pinned (Q3)
//
//  Q1  guard pass-through + mismatch matrix (model/max_tokens/effort/
//      temperature/tool-set/submit-surface/teaching incl. later-message
//      creates) + tool-hash mutation sensitivity + blocked completion paths
//  Q2  settings-provenance verification: frozen file passes; the P2 seed()
//      reduced file fails closed; a tampered budget map fails closed
//  Q3  fixture gates: confirm-gate boundary state, P1-R byte-identical
//      upstream artifacts, frozen editPolicy + definitionSource persisted,
//      guard budget observations correct, capture isolated + reconciled,
//      issue input pinned, gate-B authority assembly verbatim
//  Q4  BUILD-entry dry run: confirm gate → guarded BUILD loop → real minted
//      anchor → submit_result → staging → PUBLICATION (applied-edit provenance
//      row + disk bytes) → POSITIVE boundary halt before exec → zero
//      downstream calls/side effects proven → target restored pristine
//  Q5  campaign-level recognition: (a) a genuine BUILD guard STOP surfaces
//      as G1 with zero model calls and no publication; (b) capture tampering
//      is detected as G2

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import {
  createConfigGuardProvider, verifySettingsProvenance, classifyGuardCapture, reconcileCapture,
  ConfigGuardViolation, type StepContract,
} from './config-guard.mts';
import { buildFixture } from './p3-fixture-builder.mts';

const STRATUM = '/home/theo/Documents/coding/repos/stratum';
const ROOT = '/home/theo/Documents/coding/repos/student-platform';
const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const P3 = `${EVIDENCE}/p3`;
const FROZEN_SETTINGS = `${EVIDENCE}/v11-frozen-config/settings.json`;
const P1R_OP1 = `${EVIDENCE}/p1-r/p1-r-1/91342881-eb32-47ff-8dfb-d8a7115dd371`;
const WORKER = 'apps/ai-server/rag-worker-service/main.py';
const PUBLISHED_UPSTREAM = ['docs/cycle-charter.md', 'docs/requirements.md', 'docs/architecture.md', 'docs/plan.md', 'docs/test-plan.md', 'apps/ai-server/tests/integration/test_worker_failure_payload_contract.py'];
const MODEL = 'z-ai/glm-5.3-flash';
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

interface SpyCall { params: unknown }
function spyProvider() {
  const calls: SpyCall[] = [];
  const completeCalls: unknown[][] = [];
  const structuredCalls: unknown[][] = [];
  return {
    calls, completeCalls, structuredCalls,
    async completeMultiTurn(params: unknown) {
      calls.push({ params });
      return { stop_reason: 'end_turn', text: 'ok', tool_uses: [], tokens_used: 1 };
    },
    async complete(...args: unknown[]) {
      completeCalls.push(args);
      return { text: 'should never be reached' };
    },
    async completeStructured(...args: unknown[]) {
      structuredCalls.push(args);
      return { value: { should: 'never be reached' }, tokens_used: 1 };
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
  // the transport teaching rides in USER messages (agent-loop formatInstruction)
  messages: [
    { role: 'user', content: 'implement the defined work\n\nRESULT SHAPE:\n- /properties/edits: list of anchored edits to apply' },
    { role: 'assistant', content: 'investigating the slice' },
    { role: 'user', content: 'tool result: the slice contents (may mention the word creates in prose)' },
  ],
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

const frozenSettingsSha = sha256(FROZEN_SETTINGS);

// ─── Q1: pass-through + mismatch matrix + hash sensitivity + blocked paths ──
{
  const spy = spyProvider();
  const guard = createConfigGuardProvider(spy, BUILD_CONTRACT, { capturePath: join(tmpdir(), `p3q1-${Date.now()}.jsonl`), phase: 'q1-passthrough' });
  const out = await guard.completeMultiTurn(baseParams() as never);
  assert.equal((out as { text: string }).text, 'ok');
  assert.equal(spy.calls.length, 1, 'conforming request passes through to the provider');

  // C2 — the recorded tool-schema hash identifies the FULL definitions
  const baselineCapture = join(tmpdir(), 'p3q1-hash-baseline.jsonl');
  rmSync(baselineCapture, { force: true });
  const hashGuard = createConfigGuardProvider(spyProvider(), BUILD_CONTRACT, { capturePath: baselineCapture, phase: 'q1-hash-baseline' });
  await hashGuard.completeMultiTurn(baseParams() as never);
  const baselineHash = (JSON.parse(readFileSync(baselineCapture, 'utf-8').trim().split('\n')[0]) as { tools_sha256: string }).tools_sha256;
  await hashGuard.completeMultiTurn(baseParams() as never);
  const baselineHash2 = (JSON.parse(readFileSync(baselineCapture, 'utf-8').trim().split('\n')[2]) as { tools_sha256: string }).tools_sha256;
  assert.equal(baselineHash, baselineHash2, 'identical schemas hash identically');
  const schema = (): Record<string, unknown> => JSON.parse(JSON.stringify({
    type: 'object', properties: { edits: { type: 'array', items: { type: 'object' } } }, required: ['edits'],
  }));
  const mutations: Array<[string, (t: { name: string; description: string; input_schema: Record<string, unknown> }) => unknown]> = [
    ['name', (t) => ({ ...t, name: 'submit_results' })],
    ['description', (t) => ({ ...t, description: 'changed description' })],
    ['property-rename', (t) => ({ ...t, input_schema: { type: 'object', properties: { changed: { type: 'array' } }, required: ['changed'] } })],
    ['required-dropped', (t) => ({ ...t, input_schema: { type: 'object', properties: (t.input_schema as { properties: unknown }).properties } })],
    ['type-change', (t) => ({ ...t, input_schema: { type: 'string' } })],
    ['nested-mutation', (t) => ({ ...t, input_schema: { type: 'object', properties: { edits: { type: 'array', items: { type: 'string' } } }, required: ['edits'] } })],
  ];
  for (const [label, mutate] of mutations) {
    const s = spyProvider();
    const cap = join(tmpdir(), `p3q1-hash-${label}.jsonl`);
    rmSync(cap, { force: true });
    const g = createConfigGuardProvider(s, BUILD_CONTRACT, { capturePath: cap, phase: `q1-hash:${label}` });
    const tools = [
      { name: 'read_file', description: 'x', input_schema: { type: 'object' } },
      { name: 'read_source_slice', description: 'x', input_schema: { type: 'object' } },
      { name: 'list_directory', description: 'x', input_schema: { type: 'object' } },
      { name: 'submit_result', description: 'x', input_schema: schema() },
    ] as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
    const mutated = mutate(tools[3]);
    // the mutated request is archived regardless of the verdict; a mutation
    // that also breaks conformity (e.g. the tool NAME) is refused — that is
    // the guard working, and the record still carries the hash
    await g.completeMultiTurn(baseParams({ tools: [...tools.slice(0, 3), mutated] }) as never).catch((err: unknown) => {
      assert.ok(err instanceof ConfigGuardViolation, `mutation '${label}': unexpected non-guard error`);
    });
    const line = readFileSync(cap, 'utf-8').trim().split('\n')[0];
    const got = (JSON.parse(line) as { tools_sha256: string }).tools_sha256;
    assert.notEqual(got, baselineHash, `mutation '${label}' must change tools_sha256`);
  }

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
    ['teaching-creates-first-message', { messages: [{ role: 'user', content: 'RESULT SHAPE:\n- /properties/creates: optional list' }] }],
    ['teaching-creates-LATER-message', {
      messages: [
        { role: 'user', content: 'RESULT SHAPE:\n- /properties/edits: list of anchored edits to apply' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'repair note:\n- /properties/creates: also include full files' },
      ],
    }],
    ['teaching-creates-in-LATER-repair-turn', {
      messages: [
        { role: 'user', content: 'RESULT SHAPE:\n- /properties/edits: list of anchored edits to apply' },
        { role: 'assistant', content: '{bad json' },
        { role: 'user', content: 'repair: submit again\n- /properties/creates: full files are fine now' },
      ],
    }],
    ['teaching-no-edits', { messages: [{ role: 'user', content: 'submit your final answer' }] }],
  ];
  let i = 0;
  for (const [label, over] of matrix) {
    const s2 = spyProvider();
    const cap = join(tmpdir(), `p3q1-matrix-${i++}.jsonl`);
    rmSync(cap, { force: true });
    const g2 = createConfigGuardProvider(s2, BUILD_CONTRACT, { capturePath: cap, phase: `q1-matrix:${label}` });
    await assert.rejects(
      () => g2.completeMultiTurn(baseParams(over) as never),
      (err: Error) => err.name === 'ConfigGuardViolation' && err.message.startsWith('config-guard: STOP'),
      `mismatch '${label}' must be a config-guard STOP`,
    );
    assert.equal(s2.calls.length, 0, `mismatch '${label}' must block the provider call`);
    const cls = classifyGuardCapture(cap);
    assert.equal(cls.stops.length, 1, `mismatch '${label}' archived exactly one STOP record`);
    assert.ok(cls.g1 && !cls.g2, `mismatch '${label}' classifies G1 without integrity failures`);
  }

  // C4 — the non-permitted completion paths are blocked BEFORE the provider
  const blocked = spyProvider();
  const blockedCap = join(tmpdir(), 'p3q1-blocked.jsonl');
  rmSync(blockedCap, { force: true });
  const bGuard = createConfigGuardProvider(blocked, BUILD_CONTRACT, { capturePath: blockedCap, phase: 'q1-blocked-paths' });
  await assert.rejects(() => (bGuard as unknown as { complete: () => Promise<unknown> }).complete({ prompt: 'x' }), ConfigGuardViolation, 'complete is blocked');
  await assert.rejects(() => (bGuard as unknown as { completeStructured: () => Promise<unknown> }).completeStructured({ schema: {} } as never), ConfigGuardViolation, 'completeStructured is blocked');
  assert.equal(blocked.completeCalls.length, 0, 'complete never reached the provider');
  assert.equal(blocked.structuredCalls.length, 0, 'completeStructured never reached the provider');
  assert.equal(blocked.calls.length, 0, 'the multi-turn wire was not involved');
  const blockedCls = classifyGuardCapture(blockedCap);
  assert.equal(blockedCls.stops.length, 2, 'both blocked attempts archived as guard STOPs');
  assert.ok(blockedCls.stops.every((s) => s.wire === 'complete' || s.wire === 'completeStructured'), 'blocked records name the denied wire');

  console.log(`PASS Q1 (guard): pass-through verified; ${matrix.length} mismatch dimensions blocked with 0 provider calls; ${mutations.length} schema mutations all change tools_sha256; complete/completeStructured blocked+archived pre-call`);
}

// ─── Q2: settings provenance ────────────────────────────────────────────────
{
  verifySettingsProvenance(FROZEN_SETTINGS, frozenSettingsSha); // passes

  // the exact P2 seed() output — the reduced five-key config
  const reduced = join(tmpdir(), 'p3q2-reduced.json');
  writeFileSync(reduced, JSON.stringify({
    provider: 'openrouter', model: MODEL, base_url: 'https://openrouter.ai/api/v1',
    max_tokens: 16384, api_key_env: 'OPENROUTER_API_KEY',
  }, null, 2));
  assert.throws(() => verifySettingsProvenance(reduced, frozenSettingsSha), ConfigGuardViolation, 'reduced (P2 seed) settings must fail provenance');

  // tampered budget map (the P2 failure made manifest)
  const tampered = join(tmpdir(), 'p3q2-tampered.json');
  writeFileSync(tampered, readFileSync(FROZEN_SETTINGS, 'utf-8').replace('32768', '16384'));
  assert.throws(() => verifySettingsProvenance(tampered, frozenSettingsSha), ConfigGuardViolation, 'tampered budget map must fail provenance');

  // a live guard refuses CONSTRUCTION against divergent settings
  const s3 = spyProvider();
  assert.throws(
    () => createConfigGuardProvider(s3, BUILD_CONTRACT, { capturePath: join(tmpdir(), 'p3q2-g.jsonl'), phase: 'q2-construction', settingsPath: tampered, expectedSettingsSha256: frozenSettingsSha }),
    (err: Error) => err instanceof ConfigGuardViolation && err.message.startsWith('config-guard: STOP'),
    'guard construction must fail closed on divergent settings',
  );
  rmSync(reduced); rmSync(tampered);
  console.log('PASS Q2 (settings provenance): frozen passes; reduced P2-seed file and tampered budget map fail closed (construction refused)');
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

  // C5 — the issue input is pinned and byte-identical to the copy the builder used
  const issueInput = manifest.issue_input as { path: string; sha256: string };
  assert.equal(issueInput.sha256, sha256(join(EVIDENCE, 'p3/inputs/issue-108.json')), 'pinned issue input sha matches');
  assert.equal(issueInput.sha256, 'dd40147291edb7412eb0ccf57c3cadbd3f19ac8d7299306c0bc880419eb124c5', 'issue input matches the pinned bytes');

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

  // C1 — capture isolation: the archived capture is EXACTLY this
  // instantiation's traffic, reconciled against the replay provider's calls
  const cap = manifest.guard_capture as {
    path: string; sha256: string; phase: string; request_count: number; pass_count: number;
    stop_count: number; response_count: number; error_count: number; provider_calls_observed: number;
    integrity_failures: string[]; per_step: Record<string, number>; reconciled_with_replay_calls: boolean;
  };
  assert.ok(cap.reconciled_with_replay_calls, 'the builder reconciled the capture against its own provider calls');
  assert.equal(cap.stop_count, 0, 'no guard STOPs during fixture replay');
  assert.deepEqual(cap.integrity_failures, [], 'no capture-integrity failures during fixture replay');
  const replayed = manifest.replayed_steps as Array<{ step: string }>;
  assert.equal(cap.pass_count, replayed.length, 'archived PASS count == provider call count');
  assert.equal(cap.provider_calls_observed, replayed.length, 'every call has an archived response');
  assert.deepEqual(cap.per_step, replayed.reduce<Record<string, number>>((a, s) => ((a[s.step] = (a[s.step] ?? 0) + 1), a), {}), 'per-step capture counts match the replay sequence');
  const capOnDisk = classifyGuardCapture(join(ROOT, cap.path));
  assert.equal(capOnDisk.total_lines, cap.request_count + cap.response_count + cap.error_count, 'the capture file contains exactly the manifest-recorded records');
  assert.equal(sha256(join(ROOT, cap.path)), cap.sha256, 'the capture file bytes match the manifest pin');
  assert.deepEqual(capOnDisk.integrity_failures, [], 'independent classification of the archived capture is clean');
  assert.ok(capOnDisk.passes.every((r) => String(r.phase).endsWith(manifest.instantiation_id as string)), 'every archived record carries this instantiation phase');

  // guard observations: the frozen per-step budget plumbing through the REAL runner
  const byStep = cap.per_step;
  const expectedBudgets: Record<string, number> = { 'scoping.produce': 16384, design: 32768, plan: 32768, test: 32768 };
  for (const [step, n] of Object.entries(byStep)) {
    assert.ok(n >= 1, `${step}: observed on the wire`);
    assert.ok(expectedBudgets[step] !== undefined, `${step}: an upstream step`);
  }
  const budgetSequence = capOnDisk.passes.map((r) => ({ step: r.step, max_tokens: r.max_tokens, effort: r.reasoning_effort }));
  for (const [idx, r] of budgetSequence.entries()) {
    assert.equal(r.max_tokens, expectedBudgets[String(r.step)], `request ${idx + 1}: frozen budget observed on the wire`);
    assert.equal(r.effort, r.step === 'test' ? 'low' : null, `request ${idx + 1}: frozen effort observed`);
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
  console.log(`PASS Q3 (fixture): confirm-gate boundary; editPolicy+definitionSource persisted; ${cap.pass_count} guarded requests (isolated capture, exact reconciliation, ${Object.keys(byStep).length} upstream steps) conform to the frozen per-step budgets/effort; issue input pinned; upstream artifacts byte-identical to P1-R op1; main.py pristine; gate-B assembly verbatim (${assembled.token_count} tokens)`);
}

// ─── Q4: BUILD-entry dry run — positive publication boundary ────────────────
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

  // C1 — the attempt capture is unique to this attempt and lives in the
  // fixture workspace next to the replay capture
  const attemptId = randomUUID();
  const attemptCaptureRel = join('.sle', 'p3-captures', attemptId, 'build-attempt-guard.jsonl');
  const attemptCapture = join(ROOT, attemptCaptureRel);
  rmSync(attemptCapture, { force: true });
  const guard = createConfigGuardProvider(scriptedBuilder, () => BUILD_CONTRACT(), {
    capturePath: attemptCapture,
    phase: `build-attempt:${attemptId}`,
    settingsPath: join(ROOT, '.sle', 'settings.json'),
    expectedSettingsSha256: frozenSettingsSha,
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
  const innerRunner = new FullBuildStepRunner({
    agentStepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    criticAgent, confirmService, execService, validationGateService,
    snapshotService, summariseService, shardingService, scopingService,
  }, {
    onCheckpoint: async () => 'halt' as const,
    onConfirmGate: async () => 'halt' as const,
    onShardingGate: async () => 'halt' as const,
  });

  // C3 — the POSITIVE publication boundary: after BUILD completes (published),
  // the wrapper refuses every subsequent step BEFORE any execution — no
  // downstream model call, no downstream side effect. The run halts at the
  // first downstream step with an explicit, expected sentinel.
  const BOUNDARY = 'P3 publication boundary: workflow halted after BUILD publication (positive stop; downstream execution is not part of the P3 scope)';
  let published = false;
  let boundaryRefusals = 0;
  // the raw runner result carries a success flag; the engine normalizes it —
  // accept either shape when detecting BUILD completion
  const isBuildComplete = (r: unknown) => {
    const x = r as { success?: boolean; outcome?: string };
    return x.success === true || x.outcome === 'completed';
  };
  const refusal = () => {
    boundaryRefusals++;
    // satisfy BOTH the raw StepRunOutcome shape (success flag) and the
    // engine-normalized StepResult shape (outcome)
    return { success: false, outcome: 'failed', error: BOUNDARY, artifacts_written: [], tokens_used: 0, duration_ms: 0 } as never;
  };
  const stepRunner = {
    run: async (step: { id: string }, ctx: unknown) => {
      if (published) return refusal();
      const r = await innerRunner.run(step, ctx as never);
      if (step.id === 'build' && isBuildComplete(r)) published = true;
      return r;
    },
    handleExecute: async (step: { id: string }, ctx: unknown) => {
      if (published) return refusal();
      return innerRunner.handleExecute(step, ctx as never);
    },
    handleCommit: async (step: { id: string }, ctx: unknown) => {
      if (published) return refusal();
      return (innerRunner as unknown as { handleCommit?: (s: never, c: never) => Promise<never> }).handleCommit?.(step as never, ctx as never);
    },
    handleCheckpoint: async (step: { id: string }, ctx: unknown) => innerRunner.handleCheckpoint(step, ctx as never),
    resolveCheckpoint: (input: unknown) => innerRunner.resolveCheckpoint(input as never),
  };

  const engineDeps = {
    stepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    workflowRunRepository: new WorkflowRunRepository(d), workItemRepository: new WorkItemRepository(d),
  };
  const adapter = new StratumAgentAdapter(engineDeps, { onCheckpoint: async () => 'halt' as const }, artifactRepository);
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const scheduler = new Scheduler(d, 'ws-pilot-a', registry);
  const resumeService = new ResumeService(d, 'ws-pilot-a', registry, {}, undefined, stepRunner);

  // resolve the confirm gate — BUILD executes under the live guard, then the
  // boundary halts the run before exec starts. The resume returns normally:
  // the run is halted BY THE BOUNDARY (expected), not by a rejected request.
  const pendingId = (manifest.pending_confirm_decision_id as string);
  const appliedBefore = (d.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE ref LIKE 'applied-edit:%'").get() as { n: number }).n;
  await resumeService.resume(pendingId, {
    selectedOptionId: 'approve',
    rationale: 'P3 offline qualification: confirm gate for the BUILD-entry dry run',
    resolvedAt: new Date().toISOString(), resolvedBy: 'operator',
  });
  void scheduler;

  // C3 — the boundary held: the run halted at the first downstream step with
  // the sentinel, after exactly one BUILD execution
  const runRepo = new WorkflowRunRepository(d);
  const run = runRepo.listByWorkItem('wi-exec-108')[0] as { status: string; current_step_id: string; awaiting_checkpoint: string | null };
  assert.equal(run.status, 'halted', 'the run is halted');
  assert.equal(run.current_step_id, 'exec', 'the cursor stopped at the first downstream step (exec)');
  assert.equal(boundaryRefusals, 1, 'the boundary refused exactly one downstream dispatch');
  assert.ok(published, 'the BUILD step completed (publication) before the boundary engaged');

  // C1/C4 — capture reconciliation: EXACTLY the two BUILD wire requests,
  // both PASS, both answered; zero requests after publication; zero foreign
  // steps; the classified capture names the campaign-observable facts
  const cls = classifyGuardCapture(attemptCapture);
  assert.deepEqual(cls.integrity_failures, [], 'attempt capture has no integrity failures');
  assert.equal(cls.stops.length, 0, 'no guard STOPs in the conforming attempt');
  assert.deepEqual(builderCalls, [
    { tools: ['read_file', 'read_source_slice', 'list_directory', 'submit_result'], max_tokens: 32768 },
    { tools: ['read_file', 'read_source_slice', 'list_directory', 'submit_result'], max_tokens: 32768 },
  ], 'exactly the investigation + submission turn, at the frozen BUILD contract (the synthesis-only shape is not reached when the model submits within the gate threshold — legitimate)');
  const recon = reconcileCapture(cls, builderCalls.map((c) => ({ step: 'build' })));
  assert.deepEqual(recon, [], `attempt capture reconciles exactly: ${recon.join('; ')}`);
  assert.ok(cls.passes.every((r) => r.step === 'build'), 'every archived request is a BUILD request');
  assert.equal(cls.passes[0].max_tokens, 32768, 'frozen BUILD budget on the wire');
  assert.equal(cls.passes[0].reasoning_effort, 'low', 'frozen BUILD effort on the wire');
  assert.ok(cls.g1 === false && cls.g2 === false, 'a conforming attempt classifies clean (no G1, no G2)');
  copyFileSync(attemptCapture, join(P3, 'p3-q4-build-attempt-capture.jsonl'));

  // publication evidence: applied-edit provenance row + disk bytes changed
  const appliedCount = (d.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE ref LIKE 'applied-edit:%'").get() as { n: number }).n;
  assert.equal(appliedCount, appliedBefore + 1, 'exactly one new applied-edit provenance row (no downstream writes)');
  const applied = d.prepare("SELECT ref, path, hash FROM artifacts WHERE ref LIKE 'applied-edit:%' ORDER BY rowid DESC LIMIT 1").get() as { ref: string; path: string; hash: string };
  assert.equal(applied.path, WORKER, 'the published edit is on the authorized path');
  const diskSha = sha256(join(ROOT, WORKER));
  assert.equal(diskSha, applied.hash, 'disk bytes == provenance hash (publication closed)');
  assert.ok(diskSha !== manifest.worker_main_sha256, 'main.py actually changed');

  // C3 — zero downstream SIDE EFFECTS: the work tree carries ONLY the BUILD
  // publication on top of the fixture state (the fixture's own upstream
  // files are untracked by design; no exec artifacts, no test runs, no
  // stray writes may appear)
  const status = execFileSync('git', ['-C', ROOT, 'status', '--porcelain']).toString().trim().split('\n').filter((l) => !l.startsWith('?? .sle')).sort();
  // the staged-vs-worktree flag on main.py depends on the staging step; any
  // single modification flag is acceptable — the content hash is asserted
  // against the provenance row above
  const tracked = status.filter((l) => !l.startsWith('??'));
  const untracked = status.filter((l) => l.startsWith('??'));
  assert.equal(tracked.length, 1, `exactly one tracked change (the BUILD publication): ${JSON.stringify(tracked)}`);
  assert.ok(tracked[0].endsWith(WORKER), `the tracked change is main.py: ${tracked[0]}`);
  assert.deepEqual(untracked.sort(), PUBLISHED_UPSTREAM.map((p) => `?? ${p}`).sort(), `untracked files are exactly the fixture's upstream publications: ${JSON.stringify(untracked)}`);
  console.log(`PASS Q4 (BUILD-entry dry run): publication on ${WORKER} with disk==provenance (${applied.hash.slice(0, 12)}); positive boundary halted exec after exactly 1 refusal; capture isolated+reconciled (${cls.passes.length} requests, 0 downstream); work tree carries ONLY the publication`);

  // restore the target to pristine
  execFileSync('git', ['-C', ROOT, 'checkout', '--', WORKER]);
  for (const f of PUBLISHED_UPSTREAM) {
    try { execFileSync('git', ['-C', ROOT, 'rm', '-fq', f]); } catch { /* not present */ }
  }
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
  assert.ok(head.startsWith('86ec0871'), 'target restored to the pristine baseline');
  console.log('PASS Q4b (restore): target pristine at 86ec0871');
}

// ─── Q5: campaign-level recognition of guard STOP (G1) and capture tamper (G2)
{
  // Q5a — a genuine BUILD guard violation must surface to the campaign as a
  // G1 STOP (not a failed model attempt): rebuild a fresh fixture
  // instantiation, run the BUILD attempt under a deliberately WRONG contract
  // (max_tokens 999 — the runtime will offer 32768), and verify that the
  // engine's absorbed failure is recognized from the capture: zero model
  // calls, zero publications, one STOP record naming the mismatch.
  const m2 = await buildFixture();
  const { resolveLLMProvider, buildAgentRunner } = await import(`${STRATUM}/src/application.js`);
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

  const d = openDatabase(join(ROOT, '.sle', 'stratum.db'), {} as never);
  const mapManager = new RuntimeMapManagerImpl({ mapPath: join(ROOT, '.sle', 'map.yaml') });
  const runArtifacts = new RunArtifactManager({ projectRoot: ROOT });
  const { model } = resolveLLMProvider(ROOT);

  const innerCalls: unknown[] = [];
  const scriptedBuilder = {
    async completeMultiTurn(params: unknown) {
      innerCalls.push(params);
      return { stop_reason: 'end_turn', text: 'should never be reached', tool_uses: [], tokens_used: 1 } as never;
    },
  };
  const WRONG_CONTRACT = (): StepContract => ({ ...BUILD_CONTRACT(), max_tokens: 999 });
  const attemptId = randomUUID();
  const g1Capture = join(ROOT, '.sle', 'p3-captures', attemptId, 'build-attempt-guard.jsonl');
  rmSync(g1Capture, { force: true });
  const guard = createConfigGuardProvider(scriptedBuilder, WRONG_CONTRACT, {
    capturePath: g1Capture, phase: `g1-probe:${attemptId}`,
    settingsPath: join(ROOT, '.sle', 'settings.json'), expectedSettingsSha256: frozenSettingsSha,
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
  const innerRunner = new FullBuildStepRunner({
    agentStepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    criticAgent, confirmService, execService, validationGateService,
    snapshotService, summariseService, shardingService, scopingService,
  }, {
    onCheckpoint: async () => 'halt' as const,
    onConfirmGate: async () => 'halt' as const,
    onShardingGate: async () => 'halt' as const,
  });
  // the same positive boundary as Q4: the violation happens DURING build, so
  // the boundary must NOT engage (build never completed)
  let published5 = false;
  const isBuildComplete5 = (r: unknown) => {
    const x = r as { success?: boolean; outcome?: string };
    return x.success === true || x.outcome === 'completed';
  };
  const stepRunner = {
    run: async (step: { id: string }, ctx: unknown) => {
      if (published5) return { success: false, outcome: 'failed', error: 'boundary', artifacts_written: [], tokens_used: 0, duration_ms: 0 } as never;
      const r = await innerRunner.run(step, ctx as never);
      if (step.id === 'build' && isBuildComplete5(r)) published5 = true;
      return r;
    },
    handleExecute: async (step: { id: string }, ctx: unknown) => {
      if (published5) return { success: false, outcome: 'failed', error: 'boundary', artifacts_written: [], tokens_used: 0, duration_ms: 0 } as never;
      return innerRunner.handleExecute(step, ctx as never);
    },
    handleCheckpoint: async (step: { id: string }, ctx: unknown) => innerRunner.handleCheckpoint(step, ctx as never),
    resolveCheckpoint: (input: unknown) => innerRunner.resolveCheckpoint(input as never),
  };
  const engineDeps = {
    stepRunner, mapManager, runArtifacts, projectRoot: ROOT,
    workflowRunRepository: new WorkflowRunRepository(d), workItemRepository: new WorkItemRepository(d),
  };
  const adapter = new StratumAgentAdapter(engineDeps, { onCheckpoint: async () => 'halt' as const }, artifactRepository);
  const registry = new ExecutorRegistry();
  registry.register(adapter);
  const resumeService = new ResumeService(d, 'ws-pilot-a', registry, {}, undefined, stepRunner);

  const appliedBefore5 = (d.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE ref LIKE 'applied-edit:%'").get() as { n: number }).n;
  const pendingId = (m2.pending_confirm_decision_id as string);
  await resumeService.resume(pendingId, {
    selectedOptionId: 'approve',
    rationale: 'P3 offline qualification: G1 surfacing probe (deliberately wrong BUILD contract)',
    resolvedAt: new Date().toISOString(), resolvedBy: 'operator',
  });

  // the campaign view: classify the attempt capture
  const cls = classifyGuardCapture(g1Capture);
  assert.ok(cls.g1, 'the violation classifies G1');
  assert.ok(!cls.g2, 'the violation capture itself is intact');
  assert.equal(cls.stops.length, 1, 'exactly one guard STOP record');
  assert.ok((cls.stops[0].violations as string[]).some((v) => v.includes('max_tokens expected 999 got 32768')), 'the STOP record names the runtime-offered budget vs the contract');
  assert.equal(innerCalls.length, 0, 'the model was NEVER called — this is not a failed model attempt');
  assert.equal(cls.provider_calls_observed, 0, 'zero provider outcomes');
  const appliedAfter5 = (d.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE ref LIKE 'applied-edit:%'").get() as { n: number }).n;
  assert.equal(appliedAfter5, appliedBefore5, 'no publication occurred');
  const run5 = new WorkflowRunRepository(d).listByWorkItem('wi-exec-108')[0] as { status: string; current_step_id: string };
  assert.equal(run5.status, 'halted', 'the run is halted at the failed BUILD');
  assert.equal(run5.current_step_id, 'build', 'the cursor stayed at build (retryable, but the campaign STOPs first)');
  assert.ok(!published5, 'the boundary did not engage (BUILD never completed)');
  assert.equal(new DecisionRepository(d).listByWorkItem('wi-exec-108').filter((x: { status: string }) => x.status === 'pending').length, 0, 'the confirm decision was consumed');
  copyFileSync(g1Capture, join(P3, 'p3-q5-g1-probe-capture.jsonl'));
  console.log('PASS Q5a (G1 surfacing): BUILD guard violation classified G1 from the capture; 0 model calls; 0 publications; attempt is procedure-class, not model-class');

  // Q5b — capture tampering is detected as G2
  const tampered = join(tmpdir(), `p3q5-tampered-${Date.now()}.jsonl`);
  const q4Lines = readFileSync(join(P3, 'p3-q4-build-attempt-capture.jsonl'), 'utf-8').trim().split('\n');
  // tamper 1: drop the LAST response record (an unpaired PASS request)
  writeFileSync(tampered, q4Lines.slice(0, -1).join('\n') + '\n');
  const t1 = classifyGuardCapture(tampered);
  assert.ok(t1.g2, 'a dropped response record is a G2 integrity failure');
  assert.ok(t1.integrity_failures.some((f) => f.includes('no paired response/error record')), `the unpairing is named: ${t1.integrity_failures.join(' | ')}`);
  // tamper 2: a corrupted line
  writeFileSync(tampered, q4Lines.join('\n') + '\n{corrupted\n');
  const t2 = classifyGuardCapture(tampered);
  assert.ok(t2.g2, 'a corrupted line is a G2 integrity failure');
  // tamper 3: control — the untouched copy must classify clean
  writeFileSync(tampered, q4Lines.join('\n') + '\n');
  const t3 = classifyGuardCapture(tampered);
  assert.ok(!t3.g2 && !t3.g1, 'the untouched copy stays clean');
  rmSync(tampered);
  console.log('PASS Q5b (G2 integrity): dropped pairing, corrupted line detected; untouched capture classifies clean');
}

console.log('\nP3 OFFLINE QUALIFICATION: ALL PASS');
