// P1 FREEZE PROOF — mechanical verification of the twelve operator items
// (P1 launch directive) against the actual implementation, plus the golden
// schema projection for the freeze. Zero model traffic: a scripted provider.
//
//  1  BUILD resolves actionArtifact.type = build-changeset
//  2  submit_result projection === frozen {edits, creates} schema (golden, hashed)
//  3  BUILD investigation turns: ordinary read tools + submit_result, nothing else
//  4  read_source_slice returns a run-scoped anchor bound to exact path/base/span bytes
//  5  BUILD synthesis turns expose only submit_result
//  6  BUILD receives no SLE-PATCH / unified-diff publication teaching
//  7  unknown / cross-run / colliding-duplicate / overlapping / stale anchors fail closed
//  8  creates cannot overwrite an existing file
//  9  a valid proposal alone cannot satisfy requiredEditPaths — only a staged edit can
// 10  action staging performs no disk mutation
// 11  audit diff + before/after hashes are evidence only, no model authority
// 12  legacy non-action workflow paths remain byte-identical (no submission tool, no anchors)

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { strict as assert } from 'node:assert';

import { AgentRunner, type AgentRunnerConfig } from '/home/theo/Documents/coding/repos/stratum/src/agent-runner.js';
import type { RunArtifactManager } from '/home/theo/Documents/coding/repos/stratum/src/run-artifacts.js';
import type { ArtifactRepository, ArtifactRecord } from '/home/theo/Documents/coding/repos/stratum/src/storage/repositories.js';
import { ContextManager, DEFAULT_CONFIG } from '/home/theo/Documents/coding/repos/stratum/src/context-manager.js';
import type { MultiTurnResult } from '/home/theo/Documents/coding/repos/stratum/src/agent-loop.js';
import { AGENT_TOOLS } from '/home/theo/Documents/coding/repos/stratum/src/tools.js';
import { SUBMIT_RESULT_TOOL_NAME } from '/home/theo/Documents/coding/repos/stratum/src/transport/step-result.js';
import {
  createBuildChangesetActionContract,
  BUILD_CHANGESET_ARTIFACT_TYPE,
} from '/home/theo/Documents/coding/repos/stratum/src/workflow/methodology/build-changeset-contract.js';
import { AnchorRegistry } from '/home/theo/Documents/coding/repos/stratum/src/workflow/anchored-edits.js';
import { toJsonSchema } from '/home/theo/Documents/coding/repos/stratum/src/workflow/contracts.js';
import { FULL_BUILD } from '/home/theo/Documents/coding/repos/stratum/src/workflow/builtins/full-build.js';

const EV = '/home/theo/Documents/coding/repos/pilot-a/evidence/v1-p1-freeze';
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const results: string[] = [];
const check = (n: number | string, label: string, pass: boolean, detail = '') => {
  results.push(`${pass ? 'PASS' : 'FAIL'} [${n}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) process.exitCode = 1;
};

const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';
const WORKER_ORIGINAL = 'DEFAULT_FAILURE_STAGE = "consume"\n\n\ndef process_document(doc):\n    return doc\n';
const WORKER_PATCHED =
  'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"\n\n\ndef process_document(doc):\n    return doc\n';
const NEW_FILE_PATH = 'apps/ai-server/rag-worker-service/failure_payload.py';
const NEW_FILE_CONTENT = 'FAILURE_STAGE = "processing"\n';

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'p1-freeze-'));
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

interface CapturedRequest {
  tools: string[];
  submitSchema: Record<string, unknown> | null;
  system: string;
  messageText: string;
  max_tokens: number;
  reasoning_effort?: string;
}

class CapturingProvider {
  private turn = 0;
  readonly requests: CapturedRequest[] = [];
  readonly toolResultContents: string[] = [];
  /** optional side-effect executed before returning scripted turn N */
  onTurn: ((turn: number) => void) | null = null;
  constructor(private readonly script: MultiTurnResult[]) {}
  async complete(): Promise<never> {
    throw new Error('freeze proof: single-turn path not expected');
  }
  async completeMultiTurn(params: {
    messages: Array<{ role: string; content: unknown }>;
    tools: ReadonlyArray<{ name: string; input_schema?: Record<string, unknown> }>;
    system: string;
    max_tokens: number;
    reasoning_effort?: string;
  }): Promise<MultiTurnResult> {
    if (this.onTurn) this.onTurn(this.turn);
    let submitSchema: Record<string, unknown> | null = null;
    for (const t of params.tools) if (t.name === SUBMIT_RESULT_TOOL_NAME) submitSchema = t.input_schema as Record<string, unknown>;
    let messageText = '';
    for (const m of params.messages) {
      if (typeof m.content === 'string') messageText += m.content + '\n';
      else if (Array.isArray(m.content))
        for (const b of m.content as Array<{ type: string; content?: string; text?: string }>) {
          if (typeof b.content === 'string') messageText += b.content + '\n';
          if (typeof b.text === 'string') messageText += b.text + '\n';
        }
    }
    this.requests.push({
      tools: params.tools.map((t) => t.name),
      submitSchema,
      system: params.system,
      messageText,
      max_tokens: params.max_tokens,
      reasoning_effort: params.reasoning_effort,
    });
    for (const m of params.messages) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const block of m.content as Array<{ type: string; content?: string }>) {
        if (block.type === 'tool_result' && typeof block.content === 'string') this.toolResultContents.push(block.content);
      }
    }
    return this.script[this.turn++] ?? { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
  }
}

const readSliceTurn = (id: string, path: string, startLine = 1, lineCount = 5): MultiTurnResult => ({
  stop_reason: 'tool_use',
  text: '',
  tool_uses: [{ type: 'tool_use', id, name: 'read_source_slice', input: { path, startLine, lineCount } }],
  tokens_used: 7,
});
const submitTurn = (id: string, proposal: unknown): MultiTurnResult => ({
  stop_reason: 'tool_use',
  text: '',
  tool_uses: [{ type: 'tool_use', id, name: SUBMIT_RESULT_TOOL_NAME, input: proposal }],
  tokens_used: 9,
});

function makeRunner(root: string, provider: CapturingProvider, repository: RecordingArtifactRepository): AgentRunner {
  const cm = new ContextManager(root, DEFAULT_CONFIG);
  return new AgentRunner(
    cm,
    provider as never,
    root,
    { updateNodeStatus: async () => {}, writeNodeOutput: async () => {} } as unknown as RunArtifactManager,
    { model: 'test', actionContracts: { [BUILD_CHANGESET_ARTIFACT_TYPE]: createBuildChangesetActionContract() } } satisfies Partial<AgentRunnerConfig> as AgentRunnerConfig,
    undefined,
    repository as unknown as ArtifactRepository,
  );
}
const buildCtx = (root: string, runId: string, threshold: number | null) =>
  ({
    workflowRunId: runId,
    workflowId: 'full-build',
    stepId: 'build',
    iteration: 1,
    revision: 0,
    goal: 'P1 freeze proof',
    projectRoot: root,
    instruction: 'Publish the failure-payload fix.',
    actionArtifact: { type: BUILD_CHANGESET_ARTIFACT_TYPE },
    ...(threshold !== null ? { synthesisGate: { thresholdTurns: threshold } } : {}),
    editPolicy: { allowedEditPaths: [WORKER_PATH, NEW_FILE_PATH], requiredEditPaths: [WORKER_PATH] },
  }) as never;

const expectedAnchorId = `src_${createHash('sha256')
  .update([WORKER_PATH, sha256(WORKER_ORIGINAL), '1', '1', sha256('DEFAULT_FAILURE_STAGE = "consume"')].join('\0'), 'utf8')
  .digest('hex')
  .slice(0, 16)}`;

mkdirSync(EV, { recursive: true });

// ─── [1] BUILD resolves actionArtifact.type = build-changeset ────────────────
{
  const build = FULL_BUILD.steps.find((s) => s.id === 'build');
  const declared = build?.actionArtifact?.type;
  const resolves = declared !== undefined && createBuildChangesetActionContract() !== undefined && declared === BUILD_CHANGESET_ARTIFACT_TYPE;
  check(1, 'BUILD resolves actionArtifact.type = build-changeset', resolves, `declared=${JSON.stringify(declared)}`);
}

// ─── [2] golden projection: submit_result schema is exactly {edits, creates} ──
const golden = toJsonSchema(createBuildChangesetActionContract().modelSchema) as Record<string, any>;
{
  const s = JSON.parse(JSON.stringify(golden));
  const topOk =
    s.type === 'object' &&
    Array.isArray(s.required) && s.required.length === 2 && s.required.includes('edits') && s.required.includes('creates') &&
    s.additionalProperties === false &&
    JSON.stringify(Object.keys(s.properties).sort()) === JSON.stringify(['creates', 'edits']);
  const e = s.properties.edits.items;
  const c = s.properties.creates.items;
  const editsOk =
    e.type === 'object' && e.additionalProperties === false &&
    JSON.stringify(Object.keys(e.properties).sort()) === JSON.stringify(['anchor_id', 'replacement']) &&
    JSON.stringify([...e.required].sort()) === JSON.stringify(['anchor_id', 'replacement']) &&
    e.properties.anchor_id.type === 'string' && e.properties.replacement.type === 'string';
  const createsOk =
    c.type === 'object' && c.additionalProperties === false &&
    JSON.stringify(Object.keys(c.properties).sort()) === JSON.stringify(['content', 'path']) &&
    JSON.stringify([...c.required].sort()) === JSON.stringify(['content', 'path']) &&
    c.properties.path.type === 'string' && c.properties.content.type === 'string';
  check('2a', 'projection declares exactly required {edits, creates}, closed objects', topOk && editsOk && createsOk);
}
const goldenJson = JSON.stringify(golden, null, 2) + '\n';
writeFileSync(join(EV, 'golden-submit-result-schema.json'), goldenJson);
check('2b', 'golden projection hashed', true, `sha256 ${sha256(goldenJson).slice(0, 16)}… → ${EV}/golden-submit-result-schema.json`);

// ─── [3][4][5][6][11-behavioral] one scripted BUILD run ──────────────────────
{
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const provider = new CapturingProvider([
    readSliceTurn('t1', WORKER_PATH, 1, 1),
    submitTurn('t2', {
      edits: [{ anchor_id: expectedAnchorId, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }],
      creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }],
    }),
  ]);
  let runError = '';
  let result: { success: boolean; error?: string; anchored_edits?: unknown[]; artifacts_written?: Set<string> } | undefined;
  try {
    result = (await makeRunner(root, provider, repository).run('builder', buildCtx(root, 'p1-freeze-main', 1))) as never;
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  }
  check('3', 'investigation turn 1 exposes exactly AGENT_TOOLS + submit_result',
    provider.requests[0]?.tools.length === AGENT_TOOLS.length + 1 &&
      provider.requests[0].tools.includes(SUBMIT_RESULT_TOOL_NAME) &&
      provider.requests[0].tools.includes('read_source_slice'),
    `tools=[${provider.requests[0]?.tools.join(', ')}]`);
  check('3b', 'investigation submit_result schema === golden projection',
    JSON.stringify(provider.requests[0]?.submitSchema) === JSON.stringify(JSON.parse(goldenJson)));
  check('5', 'synthesis turn exposes ONLY submit_result',
    provider.requests.length >= 2 && JSON.stringify(provider.requests[1].tools) === JSON.stringify([SUBMIT_RESULT_TOOL_NAME]),
    `turn2 tools=[${provider.requests[1]?.tools.join(', ')}]`);

  // [4] anchor in the read result: bound to path/base/span bytes, run-scoped
  const sliceJson = provider.toolResultContents.map((c) => { try { return JSON.parse(c); } catch { return null; } })
    .find((v): v is Record<string, any> => v !== null && typeof v.anchor === 'object');
  const a = sliceJson?.anchor;
  const anchorOk =
    !!a &&
    a.path === WORKER_PATH &&
    a.base_sha256 === sha256(WORKER_ORIGINAL) &&
    a.start_line === 1 && a.end_line === 1 &&
    a.content_sha256 === sha256('DEFAULT_FAILURE_STAGE = "consume"') &&
    a.anchor_id === expectedAnchorId &&
    new AnchorRegistry().resolve(a.anchor_id) === undefined;
  check(4, 'read_source_slice anchor is exact-binding and run-scoped', anchorOk,
    `anchor_id=${a?.anchor_id ?? 'NONE'} (fresh-registry resolve → undefined: run-scoped)`);

  // [6] no SLE-PATCH / unified-diff teaching anywhere BUILD looks
  const seen = provider.requests.map((r) => r.system + '\n' + r.messageText).join('\n');
  const clean = !/SLE-PATCH|SLE-ARTIFACT|unified diff|applyUnifiedDiff|hunk/i.test(seen);
  check(6, 'BUILD receives no SLE-PATCH / unified-diff publication teaching', clean,
    `scanned ${provider.requests.length} request(s), ${seen.length} chars`);

  // [11-behavioral] evidence files exist post-publication and were never shown to the model
  const evDir = join(root, '.sle', 'runs', 'p1-freeze-main', '1', 'node-outputs');
  const manifestExists = existsSync(join(evDir, 'build-anchors.json'));
  const diffExists = existsSync(join(evDir, 'build-anchored-diff.patch'));
  const evidenceLeak = /anchors\.json|anchored-diff/.test(seen);
  check('11b', 'audit diff + anchor manifest are post-hoc evidence, never model-visible',
    manifestExists && diffExists && !evidenceLeak && Array.isArray(result?.anchored_edits) && (result!.anchored_edits as unknown[]).length === 2,
    `manifest=${manifestExists} diff=${diffExists} leak=${evidenceLeak} anchored_edits=${(result?.anchored_edits as unknown[] | undefined)?.length}`);

  check('run', 'happy-path BUILD run succeeds with staged publication',
    result?.success === true && readFileSync(join(root, WORKER_PATH), 'utf-8') === WORKER_PATCHED && readFileSync(join(root, NEW_FILE_PATH), 'utf-8') === NEW_FILE_CONTENT,
    result?.success ? 'disk bytes verified' : result?.error ?? runError);
  cleanup();
}

// ─── [7] fail-closed anchor matrix (contract + registry level) ────────────────
{
  const contract = createBuildChangesetActionContract();
  const reg = new AnchorRegistry();
  const anchorA = reg.mint({ path: 'src/a.py', base_sha256: 'b1', start_line: 1, end_line: 3, content_sha256: sha256('l1\nl2\nl3') });
  const anchorB = reg.mint({ path: 'src/a.py', base_sha256: 'b1', start_line: 10, end_line: 12, content_sha256: sha256('x\ny\nz') });
  const v = (p: unknown) => contract.validate!(p as never, { resolveAnchor: (id) => reg.resolve(id) });
  const codes = (p: unknown) => v(p).map((d) => d.code).sort().join(',');
  const unknownOk = codes({ edits: [{ anchor_id: 'src_deadbeefdeadbeef', replacement: 'x' }], creates: [] }).includes('unknown-anchor');
  const crossRunOk = new AnchorRegistry().resolve(anchorA.anchor_id) === undefined &&
    contract.validate!({ edits: [{ anchor_id: anchorA.anchor_id, replacement: 'x' }], creates: [] } as never,
      { resolveAnchor: (id) => new AnchorRegistry().resolve(id) }).some((d) => d.code === 'unknown-anchor');
  const duplicateOk = codes({ edits: [{ anchor_id: anchorA.anchor_id, replacement: 'x' }, { anchor_id: anchorA.anchor_id, replacement: 'y' }], creates: [] }).includes('duplicate-anchor');
  const overlapAnchor = reg.mint({ path: 'src/a.py', base_sha256: 'b1', start_line: 2, end_line: 4, content_sha256: sha256('l2\nl3\nl4') });
  const overlappingOk = codes({ edits: [{ anchor_id: anchorA.anchor_id, replacement: 'x' }, { anchor_id: overlapAnchor.anchor_id, replacement: 'y' }], creates: [] }).includes('overlapping-edits');
  const untouched = reg.mint({ path: 'src/a.py', base_sha256: 'b1', start_line: 20, end_line: 20, content_sha256: sha256('q') });
  const disjointOk = v({ edits: [{ anchor_id: anchorB.anchor_id, replacement: 'x' }, { anchor_id: untouched.anchor_id, replacement: 'y' }], creates: [] }).length === 0;
  // stale: stage re-verifies against disk bytes
  let staleOk = false;
  try {
    const out = await contract.stage({ edits: [{ anchor_id: anchorA.anchor_id, replacement: 'new' }], creates: [] } as never, {
      io: { readFile: async () => 'DIFFERENT CURRENT BYTES\n', fileExists: async () => false },
      resolveStageAnchor: (id) => reg.resolve(id),
    });
    staleOk = !out.ok;
  } catch { staleOk = true; }
  // collision: identical binding mints one deterministic id — duplicate EDITS with it fail closed (above)
  const collisionOk = reg.mint({ path: 'src/a.py', base_sha256: 'b1', start_line: 1, end_line: 3, content_sha256: sha256('l1\nl2\nl3') }).anchor_id === anchorA.anchor_id && duplicateOk;
  check(7, 'unknown / cross-run / duplicate / overlapping / stale anchors fail closed; disjoint anchors validate; collisions dedupe to the fail-closed duplicate rule',
    unknownOk && crossRunOk && duplicateOk && overlappingOk && staleOk && disjointOk && collisionOk,
    `unknown=${unknownOk} crossRun=${crossRunOk} duplicate=${duplicateOk} overlap=${overlappingOk} stale=${staleOk} disjoint=${disjointOk} collision→duplicate=${collisionOk}`);
}

// ─── [8] creates cannot overwrite an existing file ───────────────────────────
{
  const contract = createBuildChangesetActionContract();
  const reg = new AnchorRegistry();
  const out = await contract.stage({ edits: [], creates: [{ path: 'apps/x.py', content: 'z\n' }] } as never, {
    io: { readFile: async () => '', fileExists: async () => true },
    resolveStageAnchor: (id) => reg.resolve(id),
  });
  check(8, 'staging a create onto an existing path fails closed', !out.ok, out.ok ? 'STAGED (BAD)' : `error: ${out.error}`);
}

// ─── [9] a valid proposal alone cannot satisfy requiredEditPaths ─────────────
{
  // 9a: proposal omits the required path entirely → step fails, nothing published
  {
    const { root, cleanup } = makeRoot();
    const repository = new RecordingArtifactRepository();
    const provider = new CapturingProvider([
      readSliceTurn('t1', WORKER_PATH, 1, 1),
      submitTurn('t2', { edits: [], creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }] }),
      submitTurn('t3', { edits: [], creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }] }),
    ]);
    const result = (await makeRunner(root, provider, repository).run('builder', buildCtx(root, 'p1-freeze-9a', null))) as never as { success: boolean; error?: string };
    const noAppliedEdit = !repository.saved.some((r) => r.ref.startsWith('applied-edit:'));
    check('9a', 'valid proposal WITHOUT the required path cannot satisfy requiredEditPaths',
      result.success === false && noAppliedEdit && !existsSync(join(root, WORKER_PATH + '.applied')) && readFileSync(join(root, WORKER_PATH), 'utf-8') === WORKER_ORIGINAL,
      `step success=${result.success} error=${(result.error ?? '').slice(0, 80)} applied-edit rows=0 base untouched`);
    cleanup();
  }
  // 9b: schema-valid proposal WITH the required path but a STALE anchor → staging fails authoritatively
  {
    const { root, cleanup } = makeRoot();
    const repository = new RecordingArtifactRepository();
    const provider = new CapturingProvider([
      readSliceTurn('t1', WORKER_PATH, 1, 1),
      submitTurn('t2', { edits: [{ anchor_id: expectedAnchorId, replacement: 'x = 2' }], creates: [] }),
      submitTurn('t3', { edits: [{ anchor_id: expectedAnchorId, replacement: 'x = 2' }], creates: [] }),
    ]);
    provider.onTurn = (turn) => {
      if (turn === 1) writeFileSync(join(root, WORKER_PATH), 'MUTATED AFTER THE ANCHOR WAS MINTED\n'); // disk drifts between mint and submit
    };
    const result = (await makeRunner(root, provider, repository).run('builder', buildCtx(root, 'p1-freeze-9b', null))) as never as { success: boolean; error?: string };
    const noAppliedEdit = !repository.saved.some((r) => r.ref.startsWith('applied-edit:'));
    const nothingWritten = readFileSync(join(root, WORKER_PATH), 'utf-8') === 'MUTATED AFTER THE ANCHOR WAS MINTED\n';
    check('9b', 'schema-valid proposal with a stale base fails closed — only a SUCCESSFULLY STAGED edit satisfies',
      result.success === false && noAppliedEdit && nothingWritten,
      `step success=${result.success} error=${(result.error ?? '').slice(0, 90)} applied-edit rows=0`);
    cleanup();
  }
}

// ─── [10] staging performs no disk mutation ──────────────────────────────────
{
  const { root, cleanup } = makeRoot();
  const snapshot = (): Map<string, { sha: string; mtimeMs: number }> => {
    const out = new Map();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { const st = statSync(p); out.set(p, { sha: sha256(readFileSync(p)), mtimeMs: st.mtimeMs }); }
      }
    };
    walk(root);
    return out;
  };
  const before = snapshot();
  const contract = createBuildChangesetActionContract();
  const reg = new AnchorRegistry();
  const anchor = reg.mint({ path: WORKER_PATH, base_sha256: sha256(WORKER_ORIGINAL), start_line: 1, end_line: 1, content_sha256: sha256('DEFAULT_FAILURE_STAGE = "consume"') });
  const out = await contract.stage({ edits: [{ anchor_id: anchor.anchor_id, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }], creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }] } as never, {
    io: {
      readFile: async (p: string) => readFileSync(join(root, p), 'utf8'),
      fileExists: async (p: string) => existsSync(join(root, p)),
    },
    resolveStageAnchor: (id) => reg.resolve(id),
  });
  const after = snapshot();
  const identical = before.size === after.size && [...before].every(([p, s]) => { const a2 = after.get(p); return a2 && a2.sha === s.sha && a2.mtimeMs === s.mtimeMs; });
  check(10, 'action staging performs NO disk mutation (in-memory changeset only; publication boundary remains the sole writer)',
    identical && out.ok && (out as { ok: true; changeset: { edits: unknown[] } }).changeset.edits.length === 2,
    `tree identical=${identical}, staged entries=${out.ok ? (out as { ok: true; changeset: { edits: unknown[] } }).changeset.edits.length : `ERROR: ${(out as { ok: false; error: string }).error}`}`);
  cleanup();
}

// ─── [11-static] evidence modules import no patch applier ────────────────────
{
  const modules = [
    '/home/theo/Documents/coding/repos/stratum/src/workflow/build-changeset-contract.ts',
    '/home/theo/Documents/coding/repos/stratum/src/workflow/methodology/build-changeset-contract.ts',
    '/home/theo/Documents/coding/repos/stratum/src/workflow/action-contracts.ts',
    '/home/theo/Documents/coding/repos/stratum/src/workflow/anchored-edits.ts',
  ].filter((p) => existsSync(p));
  const codeOf = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const offenders = modules.filter((p) => /patch\.js|applyUnifiedDiff|SLE-PATCH/.test(codeOf(p)));
  check('11a', 'anchored-edit modules contain no unified-diff applier or SLE-PATCH syntax (evidence diff is Stratum-generated, never applied)',
    offenders.length === 0, `scanned ${modules.length} module(s)`);
}

// ─── [12] legacy non-action path byte-identical ──────────────────────────────
{
  const { root, cleanup } = makeRoot();
  const repository = new RecordingArtifactRepository();
  const provider = new CapturingProvider([
    { stop_reason: 'end_turn', text: '<<<SLE-OUTPUT>>>\n<<<SLE-ARTIFACT path="docs/test-report.md">>>\n# Test Report\n\nAll checks passed.\n<<<END-SLE-ARTIFACT>>>\n<<<END-SLE-OUTPUT>>>', tool_uses: [], tokens_used: 5 },
  ]);
  const legacyCtx = {
    workflowRunId: 'p1-freeze-legacy', workflowId: 'full-build', stepId: 'test', iteration: 1, revision: 0,
    goal: 'P1 freeze proof — legacy', projectRoot: root, instruction: 'Produce the test report.',
    authorizedOutputs: ['docs/test-report.md'],
  } as never;
  const result = (await makeRunner(root, provider, repository).run('tester', legacyCtx)) as never as { success: boolean; error?: string; anchored_edits?: unknown[] };
  const report = readFileSync(join(root, 'docs/test-report.md'), 'utf-8');
  const noSubmitTool = !provider.requests.some((r) => r.tools.includes(SUBMIT_RESULT_TOOL_NAME));
  const noAnchors = provider.toolResultContents.every((c) => !c.includes('"anchor"'));
  const legacyProvenance = repository.saved.length > 0 && repository.saved.every((r) => !r.ref.startsWith('applied-edit:'));
  check(12, 'legacy non-action path: no submission tool, no anchors, no anchored_edits, unchanged provenance',
    result.success === true && report === '# Test Report\n\nAll checks passed.' && noSubmitTool && noAnchors &&
      (result.anchored_edits === undefined || (result.anchored_edits as unknown[]).length === 0) && legacyProvenance,
    `success=${result.success} error=${(result.error ?? '').slice(0, 120)} report=${JSON.stringify(report)} submit_result offered=${!noSubmitTool} anchor fields=${noAnchors ? 0 : '>0'} refs=[${repository.saved.map((r) => r.ref).join(', ')}]`);
  cleanup();
}

console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\nP1 FREEZE PROOF: ${results.length - fails}/${results.length} checks passed`);
if (fails > 0) process.exit(1);
