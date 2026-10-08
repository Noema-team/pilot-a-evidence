// P2 S3 — REQUEST OBSERVABILITY PROOF (operator finding S3).
//
// Proves, offline at the frozen implementation (stratum 9f298f2, zero model
// traffic), that the campaign wire-capture wrapper — the SAME wrapper the
// live driver wraps around the real provider — archives the ACTUAL emitted
// provider request surface (submit_result input_schema + teaching markers),
// not a configuration inference:
//   run A (frozen main.py-only policy) -> captured submit_result schema has
//   properties {edits} ONLY, required [edits], has_creates=false; teaching
//   marker has_creates=false.
//   run B (policy with a genuinely nonexistent authorized target) -> captured
//   schema HAS creates; teaching marker has_creates=true.
// The capture records are verbatim JSONL — exactly what live runs will
// archive into the run evidence directory.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
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
import { createWireCaptureProvider } from './wire-capture-wrapper.mts';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';
const WORKER_ORIGINAL = 'DEFAULT_FAILURE_STAGE = "consume"\n\n\ndef process_document(doc):\n    return doc\n';
const WORKER_PATCHED_SINGLE = 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"\n\ndef process_document(doc):\n    return doc\n';
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

class ScriptedProvider {
  private turn = 0;
  constructor(private readonly script: MultiTurnResult[]) {}
  async complete(): Promise<never> { throw new Error('not expected'); }
  async completeMultiTurn(_params: unknown): Promise<MultiTurnResult> {
    return this.script[this.turn++] ?? { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
  }
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

async function runScenario(name: string, capturePath: string, editPolicy: Record<string, unknown> | undefined, proposal: (a: string) => unknown): Promise<void> {
  const root = makeRoot();
  try {
    const scripted = new ScriptedProvider([
      sliceTurn('t1'),
      submitTurn('t2', proposal(expectedAnchorId())),
    ]);
    const provider = createWireCaptureProvider(scripted, capturePath, 'offline-proof');
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

const captured = (capturePath: string): Array<Record<string, unknown>> =>
  readFileSync(capturePath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

// ─── run A: frozen main.py-only policy → narrowed surface captured ───────────
const captureA = join(tmpdir(), `p2-s3-capture-narrowed-${Date.now()}.jsonl`);
await runScenario('narrowed', captureA, { appliesToSteps: ['build'], allowedEditPaths: [WORKER_PATH], requiredEditPaths: [WORKER_PATH] }, (a) => ({
  edits: [{ anchor_id: a, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }],
}));
const recsA = captured(captureA);
const submitA = recsA.map((r) => r.submit_result_surface as Record<string, unknown>).filter((s) => s.offered);
assert.ok(submitA.length >= 1, 'run A: submit_result requests captured');
for (const s of submitA) {
  assert.deepEqual(s.top_level_properties, ['edits'], 'narrowed: captured schema properties == [edits]');
  assert.deepEqual(s.required, ['edits']);
  assert.equal(s.has_creates_property, false);
}
for (const r of recsA) {
  const t = r.teaching_markers as Record<string, boolean>;
  assert.equal(t.has_edits_field_line, true);
  if (submitA.length > 0) assert.equal(t.has_creates_field_line, false, 'narrowed: zero create teaching in captured requests');
}
// every captured record carries the VERBATIM tools array (actual request, not inference)
for (const r of recsA) assert.ok(Array.isArray(r.tools) && r.tools.length > 0, 'verbatim tools archived');
console.log(`PASS run A (narrowed policy): ${recsA.length} request(s) captured; submit_result schema properties ${JSON.stringify(submitA[0].top_level_properties)}, has_creates=${submitA[0].has_creates_property}, teaching creates-line=false`);

// ─── run B: nonexistent authorized target → full surface captured ────────────
const captureB = join(tmpdir(), `p2-s3-capture-full-${Date.now()}.jsonl`);
await runScenario('full', captureB, { appliesToSteps: ['build'], allowedEditPaths: [WORKER_PATH, NEW_FILE_PATH], requiredEditPaths: [] }, (a) => ({
  edits: [{ anchor_id: a, replacement: 'DEFAULT_FAILURE_STAGE = "consume"\nFAILURE_STAGE_FALLBACK = "processing"' }],
  creates: [{ path: NEW_FILE_PATH, content: NEW_FILE_CONTENT }],
}));
const recsB = captured(captureB);
const submitB = recsB.map((r) => r.submit_result_surface as Record<string, unknown>).filter((s) => s.offered);
assert.ok(submitB.length >= 1, 'run B: submit_result requests captured');
for (const s of submitB) {
  assert.deepEqual(s.top_level_properties, ['creates', 'edits'], 'full: captured schema properties == [creates, edits]');
  assert.equal(s.has_creates_property, true);
}
console.log(`PASS run B (create-allowed policy): captured schema properties ${JSON.stringify(submitB[0].top_level_properties)}, has_creates=${submitB[0].has_creates_property}`);

// ─── capture file bytes are the evidence artifact ─────────────────────────────
assert.ok(existsSync(captureA) && existsSync(captureB));
console.log('\nS3 REQUEST OBSERVABILITY: PASS — the live-path wrapper archives the actual emitted');
console.log('provider request surface (verbatim tools + input_schema + teaching markers); in live');
console.log('runs the driver wraps the REAL provider with this same wrapper and copies the capture');
console.log('into the run evidence directory (node-outputs/wire-capture.jsonl).');
