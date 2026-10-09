// P2 S3 — REQUEST OBSERVABILITY QUALIFICATION v2 (operator launch-gate review
// of binding v2 @ e272e2a: wrapper defects 1-3 + live-driver integration and
// fail-closed qualification).
//
// Offline at the frozen implementation (stratum 9f298f2, zero model traffic):
//   A. narrowed policy  -> captured submit_result schema has properties
//      ["edits"] ONLY, has_creates=false, zero create teaching
//   B. create-allowed policy -> captured ["creates","edits"], has_creates=true
//   C. response metadata read from result.wire_observation (the REAL
//      provider's field; src/sse-accumulator.ts WireObservation)
//   D. fail-closed capture: an unwritable capture file throws 'wire-capture:'
//      BEFORE the model call — the inner provider is never invoked
//   E. failed provider requests ARE archived (error record + propagation)
//   F. capability preservation with the REAL OpenAI-compatible provider class
//      (built via the same resolveLLMProvider call the live driver uses):
//      every prototype method reachable through the Proxy wrapper with its
//      ORIGINAL function reference; only complete/completeMultiTurn
//      overridden; completeStructured survives (operator defect 3)
// The capture records are verbatim JSONL — exactly what live runs archive
// into the run evidence directory (node-outputs/wire-capture.jsonl).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

import { AgentRunner, type AgentRunnerConfig } from '/home/theo/Documents/coding/repos/stratum/src/agent-runner.js';
import type { RunArtifactManager } from '/home/theo/Documents/coding/repos/stratum/src/run-artifacts.js';
import type { ArtifactRepository, ArtifactRecord } from '/home/theo/Documents/coding/repos/stratum/src/storage/repositories.js';
import { ContextManager, DEFAULT_CONFIG } from '/home/theo/Documents/coding/repos/stratum/src/context-manager.js';
import type { MultiTurnResult } from '/home/theo/Documents/coding/repos/stratum/src/agent-loop.js';
import { SUBMIT_RESULT_TOOL_NAME } from '/home/theo/Documents/coding/repos/stratum/src/transport/step-result.js';
import { createBuildChangesetActionContract, BUILD_CHANGESET_ARTIFACT_TYPE } from '/home/theo/Documents/coding/repos/stratum/src/workflow/methodology/build-changeset-contract.js';
import { resolveLLMProvider } from '/home/theo/Documents/coding/repos/stratum/src/application.js';
import { createLLMProvider } from '/home/theo/Documents/coding/repos/stratum/src/llm-provider.js';
import type { IMultiTurnProvider } from '/home/theo/Documents/coding/repos/stratum/src/agent-loop.js';
import { createWireCaptureProvider, type WireCaptureRecord } from './wire-capture-wrapper.mts';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';
const WORKER_ORIGINAL = 'DEFAULT_FAILURE_STAGE = "consume"\n\n\ndef process_document(doc):\n    return doc\n';
const NEW_FILE_PATH = 'apps/ai-server/rag-worker-service/failure_payload.py';
const NEW_FILE_CONTENT = 'FAILURE_STAGE = "processing"\n';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'p2-s3-'));
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER_PATH), WORKER_ORIGINAL);
  execSync('git init -q && git add -A', { cwd: root });
  return root;
}

class Repo implements Partial<ArtifactRepository> {
  saved: ArtifactRecord[] = [];
  findByWorkflowRunRefAndHash(_r: string, ref: string, hash: string) { return this.saved.find((x) => x.ref === ref && x.hash === hash); }
  listByWorkflowRun(runId: string) { return this.saved.filter((r) => r.workflowRunId === runId); }
  save(rec: ArtifactRecord): void { this.saved.push(rec); }
}

interface ToolUseShape { type: 'tool_use'; id: string; name: string; input: unknown }

class ScriptedProvider implements IMultiTurnProvider {
  private turn = 0;
  /** A prototype method (NOT an own property) — the spread-based wrapper v1 lost these. */
  completeStructured(): never {
    throw new Error('completeStructured is a prototype capability and must survive wrapping');
  }
  async complete(_params: unknown): Promise<never> { throw new Error('not expected'); }
  async completeMultiTurn(_params: unknown): Promise<MultiTurnResult> {
    return this.script[this.turn++] ?? { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
  }
  constructor(private readonly script: MultiTurnResult[]) {}
}

const sliceTurn = (id: string): MultiTurnResult => ({
  stop_reason: 'tool_use', text: '',
  tool_uses: [{ type: 'tool_use', id, name: 'read_source_slice', input: { path: WORKER_PATH, startLine: 1, lineCount: 2 } }],
  tokens_used: 7,
});
const submitTurn = (id: string, proposal: unknown): MultiTurnResult => ({
  stop_reason: 'tool_use', text: '',
  tool_uses: [{ type: 'tool_use', id, name: SUBMIT_RESULT_TOOL_NAME, input: proposal }], tokens_used: 9,
});

function expectedAnchorId(): string {
  const lines = WORKER_ORIGINAL.split('\n');
  const content = lines.slice(0, 2).join('\n');
  return 'src_' + createHash('sha256').update([WORKER_PATH, sha256(WORKER_ORIGINAL), '1', '2', sha256(content)].join('\0'), 'utf8').digest('hex').slice(0, 16);
}

async function runScenario(name: string, capturePath: string, editPolicy: Record<string, unknown> | undefined, proposal: (a: string) => unknown, scripted?: ScriptedProvider): Promise<void> {
  const root = makeRoot();
  try {
    const inner = scripted ?? new ScriptedProvider([
      sliceTurn('t1'),
      submitTurn('t2', proposal(expectedAnchorId())),
    ]);
    const provider = createWireCaptureProvider(inner, capturePath, 'offline-proof');
    const runner = new AgentRunner(
      new ContextManager(root, DEFAULT_CONFIG),
      provider as never,
      root,
      { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
      { model: 'offline-proof', actionContracts: { [BUILD_CHANGESET_ARTIFACT_TYPE]: createBuildChangesetActionContract() } } satisfies Partial<AgentRunnerConfig> as AgentRunnerConfig,
      undefined,
      new Repo() as unknown as ArtifactRepository,
    );
    const result = await runner.run('builder', {
      workflowRunId: 's3-' + name, workflowId: 'full-build', stepId: 'build', iteration: 1, revision: 0,
      goal: 's3 wire observability proof', projectRoot: root, instruction: 'Publish the fix.',
      actionArtifact: { type: BUILD_CHANGESET_ARTIFACT_TYPE },
      ...(editPolicy ? { editPolicy } : {}),
    } as never);
    assert.equal(result.success, true, `${name}: ${result.error}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const captured = (capturePath: string): WireCaptureRecord[] =>
  readFileSync(capturePath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as WireCaptureRecord);

// ─── A + B: narrowed / full surface capture (as before) ───────────────────────

const captureA = join(tmpdir(), `p2-s3v2-narrowed-${Date.now()}.jsonl`);
await runScenario('narrowed', captureA, { appliesToSteps: ['build'], allowedEditPaths: [WORKER_PATH], requiredEditPaths: [WORKER_PATH] }, (a) => ({
  edits: [{ anchor_id: a, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }],
}));
const recsA = captured(captureA);
const submitA = recsA.filter((r) => r.submit_result_surface?.offered);
assert.ok(submitA.length >= 1, 'run A: submit_result requests captured');
for (const r of submitA) {
  assert.deepEqual(r.submit_result_surface!.top_level_properties, ['edits']);
  assert.deepEqual(r.submit_result_surface!.required, ['edits']);
  assert.equal(r.submit_result_surface!.has_creates_property, false);
  assert.equal(r.teaching_markers!.has_creates_field_line, false);
  assert.ok(Array.isArray(r.tools) && (r.tools as unknown[]).length > 0, 'verbatim tools archived');
}
// every request record got its paired response record (proxy transparency through the live loop)
for (const req of recsA.filter((r) => r.phase === 'request')) {
  assert.ok(recsA.some((r) => r.phase === 'response' && r.request_id === req.request_id), 'paired response record present');
}
console.log(`PASS A (narrowed): ${recsA.length} records; schema ${JSON.stringify(submitA[0].submit_result_surface!.top_level_properties)}, has_creates=${submitA[0].submit_result_surface!.has_creates_property}; request/response pairs intact`);

const captureB = join(tmpdir(), `p2-s3v2-full-${Date.now()}.jsonl`);
await runScenario('full', captureB, { appliesToSteps: ['build'], allowedEditPaths: [WORKER_PATH, NEW_FILE_PATH], requiredEditPaths: [] }, (a) => ({
  edits: [{ anchor_id: a, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }],
  creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }],
}));
const recsB = captured(captureB);
const submitB = recsB.filter((r) => r.submit_result_surface?.offered);
for (const r of submitB) {
  assert.deepEqual(r.submit_result_surface!.top_level_properties, ['creates', 'edits']);
  assert.equal(r.submit_result_surface!.has_creates_property, true);
}
console.log(`PASS B (full): captured ${JSON.stringify(submitB[0].submit_result_surface!.top_level_properties)}, has_creates=${submitB[0].submit_result_surface!.has_creates_property}`);

// ─── C: response metadata read from result.wire_observation (defect 1) ───────

const captureC = join(tmpdir(), `p2-s3v2-obs-${Date.now()}.jsonl`);
{
  const inner = new ScriptedProvider([
    {
      stop_reason: 'tool_use', text: '',
      tool_uses: [{ type: 'tool_use', id: 't1', name: SUBMIT_RESULT_TOOL_NAME, input: { edits: [{ anchor_id: 'src_x', replacement: 'y' }] } }],
      tokens_used: 9,
      // the REAL provider carries wire metadata here (WireObservation):
      wire_observation: { finish_reason: 'tool_use', prompt_tokens: 4321, completion_tokens: 55, reasoning_chunks: 0, reasoning_bytes: 0, reasoning_fields: [], content_bytes: 10, tool_call_fragments: 1, reasoning_tokens: null, total_tokens: 4376, stream_id: 's', model: 'm', provider: 'p' },
    } as unknown as MultiTurnResult,
    { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 },
  ]);
  const provider = createWireCaptureProvider(inner, captureC, 'offline-proof');
  // drive the wrapper directly (no runner needed for metadata plumbing):
  await (provider as unknown as IMultiTurnProvider).completeMultiTurn({ messages: [{ role: 'user', content: 'go' }], tools: [{ name: SUBMIT_RESULT_TOOL_NAME, input_schema: { type: 'object', properties: { edits: { type: 'array' } }, required: ['edits'] } }] });
}
const recsC = captured(captureC);
const respC = recsC.find((r) => r.phase === 'response')!;
assert.equal(respC.response_finish_reason, 'tool_use', 'finish_reason read from wire_observation');
assert.equal(respC.response_prompt_tokens, 4321, 'prompt_tokens read from wire_observation');
console.log(`PASS C (response metadata): finish_reason=${respC.response_finish_reason}, prompt_tokens=${respC.response_prompt_tokens} — read from result.wire_observation`);

// ─── D: fail-closed capture — unwritable capture blocks the model call ───────

{
  // D1: construction fails loudly when the capture location cannot exist
  const blocker = join(tmpdir(), `p2-s3v2-blocker-${Date.now()}`);
  writeFileSync(blocker, 'this is a FILE, not a directory');
  const capturePath = join(blocker, 'out.jsonl'); // dirname() mkdir must fail
  let innerCalled = 0;
  const inner = {
    async completeMultiTurn(): Promise<MultiTurnResult> { innerCalled++; return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 }; },
  };
  assert.throws(() => createWireCaptureProvider(inner, capturePath, 'offline-proof'), /wire-capture:/, 'construction fails closed with the wire-capture marker');
  rmSync(blocker, { force: true });

  // D2: append-phase failure (read-only capture dir) throws 'wire-capture:'
  // BEFORE the model call — the inner provider is never invoked
  const roDir = join(tmpdir(), `p2-s3v2-ro-${Date.now()}`);
  mkdirSync(roDir, { recursive: true });
  const roCapture = join(roDir, 'out.jsonl');
  const provider = createWireCaptureProvider(inner, roCapture, 'offline-proof');
  // directory exists (construction mkdir succeeded silently); make it
  // non-writable so the first appendFileSync fails EACCES
  execSync(`chmod 500 '${roDir}'`);
  try {
    await assert.rejects(
      () => (provider as unknown as IMultiTurnProvider).completeMultiTurn({ messages: [{ role: 'user', content: 'go' }], tools: [] }),
      /wire-capture:/,
      'capture-write failure must throw a wire-capture error',
    );
    assert.equal(innerCalled, 0, 'fail-closed: the inner provider was NEVER called');
    console.log('PASS D (fail-closed): construction + append-phase capture failures throw the wire-capture marker BEFORE any model call; inner invocations = 0');
  } finally {
    execSync(`chmod 700 '${roDir}'`);
    rmSync(roDir, { recursive: true, force: true });
  }
}

// ─── E: failed provider requests are archived (defect 2) ─────────────────────

const captureE = join(tmpdir(), `p2-s3v2-err-${Date.now()}.jsonl`);
{
  const inner = {
    async completeMultiTurn(): Promise<never> { throw new Error('provider 503 upstream error'); },
  };
  const provider = createWireCaptureProvider(inner, captureE, 'offline-proof');
  await assert.rejects(() => (provider as unknown as IMultiTurnProvider).completeMultiTurn({ messages: [{ role: 'user', content: 'go' }], tools: [] }), /503/);
}
const recsE = captured(captureE);
const reqE = recsE.find((r) => r.phase === 'request')!;
const errE = recsE.find((r) => r.phase === 'error')!;
assert.ok(reqE && errE && errE.request_id === reqE.request_id, 'request+error records share the request_id');
assert.match(errE.error!, /503/);
console.log(`PASS E (failure archiving): request record + error record (same request_id, error='${errE.error}') archived and rethrown`);

// ─── F: capability parity with the REAL provider, EXACT frozen config ────────
// (operator finding P1-1: the qualification must use resolveLLMProvider() with
// the actual frozen 'openrouter' configuration — not 'openai_compatible' —
// and verify presence/absence parity, not merely reference availability)

{
  const root = mkdtempSync(join(tmpdir(), 'p2-s3-realprov-'));
  try {
    mkdirSync(join(root, '.sle'), { recursive: true });
    // THE EXACT FROZEN CONFIGURATION (evidence/v11-frozen-config/settings.json regime):
    writeFileSync(join(root, '.sle', 'settings.json'), JSON.stringify({
      provider: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      model: 'z-ai/glm-5.3-flash',
      api_key_env: 'OPENROUTER_API_KEY',
    }));
    const resolved = resolveLLMProvider(root);
    const real = resolved.provider as unknown as Record<string, unknown>;
    // presence truth of the REAL frozen-resolution provider:
    const realHas = {
      complete: typeof real.complete === 'function',
      completeMultiTurn: typeof real.completeMultiTurn === 'function',
      completeStructured: typeof real.completeStructured === 'function',
    };
    assert.deepEqual(realHas, { complete: true, completeMultiTurn: true, completeStructured: true },
      'the frozen openrouter resolution carries multi-turn AND structured-output capabilities');
    const wrapped = createWireCaptureProvider(real, join(tmpdir(), `p2-s3v3-real-${Date.now()}.jsonl`), resolved.model) as unknown as Record<string, unknown>;
    // parity: every present capability stays present (overridden or identical);
    // wrapped.completeStructured must be the ORIGINAL reference (not overridden):
    assert.equal(typeof wrapped.complete, 'function');
    assert.equal(typeof wrapped.completeMultiTurn, 'function');
    assert.equal(typeof wrapped.completeStructured, 'function');
    assert.equal(wrapped.completeStructured, real.completeStructured, 'completeStructured is the ORIGINAL function reference');
    assert.notEqual(wrapped.completeMultiTurn, real.completeMultiTurn, 'completeMultiTurn is the wrapper override');
    assert.notEqual(wrapped.complete, real.complete, 'complete is the wrapper override');
    // absence parity (defect: the v2 proxy manufactured capabilities): an
    // inner provider LACKING completeMultiTurn/completeStructured must expose
    // NEITHER through the wrapper:
    const singleTurnOnly = createLLMProvider({ provider: 'openai_compatible', base_url: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5.3-flash', api_key_env: 'OPENROUTER_API_KEY' });
    const wrappedSingle = createWireCaptureProvider(singleTurnOnly, join(tmpdir(), `p2-s3v3-absent-${Date.now()}.jsonl`), 'offline-proof') as unknown as Record<string, unknown>;
    assert.equal(typeof singleTurnOnly.completeMultiTurn, 'undefined', 'precondition: openai_compatible provider lacks multi-turn');
    assert.equal(typeof singleTurnOnly.completeStructured, 'undefined', 'precondition: openai_compatible provider lacks structured');
    assert.equal(typeof wrappedSingle.completeMultiTurn, 'undefined', 'absence parity: wrapper does NOT manufacture completeMultiTurn');
    assert.equal(typeof wrappedSingle.completeStructured, 'undefined', 'absence parity: wrapper does NOT manufacture completeStructured');
    assert.equal(typeof wrappedSingle.complete, 'function', 'present capability (complete) still wrapped');
    const protoNames = new Set<string>();
    let proto = Object.getPrototypeOf(real);
    while (proto && proto !== Object.prototype) {
      for (const n of Object.getOwnPropertyNames(proto)) {
        if (n !== 'constructor') protoNames.add(n);
      }
      proto = Object.getPrototypeOf(proto);
    }
    const lost: string[] = [];
    for (const n of protoNames) {
      const w = (wrapped as unknown as Record<string, unknown>)[n];
      const r = (real as unknown as Record<string, unknown>)[n];
      if (typeof r === 'function') {
        if (typeof w !== 'function') lost.push(n);
        else if (n !== 'complete' && n !== 'completeMultiTurn' && w !== r) lost.push(`${n} (rebound)`);
      }
    }
    assert.deepEqual(lost, [], `every real provider capability preserved: lost=${JSON.stringify(lost)}`);
    assert.notEqual(wrapped.completeMultiTurn, real.completeMultiTurn, 'completeMultiTurn is the wrapper override');
    assert.notEqual(wrapped.complete, real.complete, 'complete is the wrapper override');
    // completeStructured: the openai_compatible multi-turn provider does NOT
    // declare it at 9f298f2 (it lives on the opt-in structured subclass); the
    // guarantee is conditional-preservation — prototype methods survive with
    // identical references WHEN present. Prove the mechanism on the same
    // inheritance shape via the scripted harness class (completeStructured
    // IS a prototype method there) — runs A/B already executed through it.
    const scriptedWithStructured = new ScriptedProvider([]);
    const wrappedScripted = createWireCaptureProvider(scriptedWithStructured, join(tmpdir(), 'p2-s3v2-synth.jsonl'), 'offline-proof') as unknown as Record<string, unknown>;
    assert.equal(typeof wrappedScripted.completeStructured, 'function', 'completeStructured survives wrapping when the provider declares it');
    assert.equal(wrappedScripted.completeStructured, (scriptedWithStructured as unknown as Record<string, unknown>).completeStructured, 'completeStructured identical reference');
    // behavioral probe: preserved mutators/observers actually execute through
    // the proxy (the real class uses TS-private regular properties, not
    // #private fields, so proxy receivers are safe):
    wrapped.setProvider(real.getProvider());
    wrapped.syncMultiTurnCapability();
    assert.ok(typeof wrapped.getProvider() === 'object' || wrapped.getProvider() === undefined, 'getProvider executes through the proxy');
    console.log(`PASS F (capability parity, frozen openrouter config): real ${real.constructor?.name} — presence {complete:${realHas.complete}, completeMultiTurn:${realHas.completeMultiTurn}, completeStructured:${realHas.completeStructured}} preserved (overrides + original completeStructured reference); absence parity proven (no manufactured capabilities); prototype members [${[...protoNames].sort().join(', ')}] preserved by reference; behavioral probe OK`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── G: dual-failure path — provider error + error-record write failure ──────
// (operator finding P1-2: the capture-integrity failure must SURFACE as
// evidence-integrity STOP, carrying the original provider error as cause)

{
  const captureDir = mkdtempSync(join(tmpdir(), 'p2-s3v3-dual-'));
  const capturePath = join(captureDir, 'out.jsonl');
  const inner = {
    async completeMultiTurn(): Promise<never> {
      // sabotage the capture BETWEEN the request record and the error record:
      // replace the capture file with a directory so the error-record append
      // fails EISDIR
      rmSync(capturePath);
      mkdirSync(capturePath);
      throw new Error('provider 503 upstream error');
    },
  };
  const provider = createWireCaptureProvider(inner, capturePath, 'offline-proof');
  // the request record was appended (file existed) — then inner removes it
  // before throwing, so the error-record write fails:
  await assert.rejects(
    () => (provider as unknown as IMultiTurnProvider).completeMultiTurn({ messages: [{ role: 'user', content: 'go' }], tools: [] }),
    (err: Error) => {
      assert.match(err.message, /wire-capture: evidence-integrity failure/, 'capture-integrity failure surfaced');
      assert.match(err.message, /provider 503 upstream error/, 'original provider error preserved as cause');
      assert.match(err.message, /capture-integrity STOP/, 'classified as capture-integrity STOP');
      return true;
    },
    'dual failure must surface the capture-integrity failure, not swallow it',
  );
  // the observed error class PROVES the request record was archived first:
  // a request-phase write failure would have thrown the plain
  // 'wire-capture: capture write failed' marker BEFORE the provider call;
  // instead we reached the dual-failure branch, which requires a successful
  // request record followed by provider throw + error-record write failure.
  // (The sabotaged capture path is a directory now — its bytes are gone by
  // construction, which is exactly the failure being surfaced.)
  rmSync(captureDir, { recursive: true, force: true });
  console.log(`PASS G (dual failure): provider error + error-record write failure surfaced as 'wire-capture: evidence-integrity failure … capture-integrity STOP' with the provider 503 preserved as cause; the failure class proves the request record was archived before the sabotage`);
}

console.log('\nS3 REQUEST OBSERVABILITY v2: ALL PASS — actual emitted request surface archived (verbatim tools +');
console.log('input_schema + teaching), wire_observation metadata, failure archiving, fail-closed capture, and');
console.log('full capability preservation of the real provider class. In live runs the driver wraps the REAL');
console.log('provider with this same wrapper and copies the capture into node-outputs/wire-capture.jsonl.');
