/* V2 transport qualification — ONE narrow live check on merged Stratum main.
 * NOT an experimental attempt. No retries, no fallbacks, no policy changes.
 * Exercises: real SSE completion, streamed tool-call assembly, read_file
 * round trip, submit_result end-to-end, finish_reason mapping, usage
 * accounting, AgentLoop normal completion — against real OpenRouter.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  OpenAICompatibleMultiTurnProvider,
} from '/home/theo/Documents/coding/repos/stratum/src/llm-provider.js';
import {
  AgentLoop,
  type IMultiTurnProvider,
  type MultiTurnParams,
  type MultiTurnResult,
} from '/home/theo/Documents/coding/repos/stratum/src/agent-loop.js';
import { RunArtifactManager } from '/home/theo/Documents/coding/repos/stratum/src/run-artifacts.js';

const MODEL = 'z-ai/glm-5.3-flash';
const MAX_TOKENS = 8192;
let teeCounter = 0;
const MARKER = `V2QUAL-${randomUUID().slice(0, 8)}`;

const root = mkdtempSync(join(tmpdir(), 'qual-v2-'));
mkdirSync(join(root, 'pkg'), { recursive: true });
const targetRel = 'pkg/QUALIFICATION-TARGET.md';
const targetBody = `# Qualification target\n\nMarker token: ${MARKER}\n\nThis file exists so the streaming transport can be qualified end to end.\n`;
writeFileSync(join(root, targetRel), targetBody);
execFileSync('git', ['init', '-q'], { cwd: root });
execFileSync('git', ['config', 'user.email', 'qual@local'], { cwd: root });
execFileSync('git', ['config', 'user.name', 'qual'], { cwd: root });
execFileSync('git', ['add', '.'], { cwd: root });
execFileSync('git', ['commit', '-q', '-m', 'qualification fixture'], { cwd: root });
const expectedSha = createHash('sha256').update(targetBody).digest('hex');

class RecordingProvider implements IMultiTurnProvider {
  readonly turns: Array<{
    index: number;
    stop_reason: string;
    text_length: number;
    tool_uses: Array<{ name: string; input: unknown }>;
    tokens_used: number;
    duration_ms: number;
  }> = [];
  constructor(private inner: IMultiTurnProvider) {}
  async completeMultiTurn(params: MultiTurnParams): Promise<MultiTurnResult> {
    const t0 = Date.now();
    const result = await this.inner.completeMultiTurn(params); // NO retry — failures propagate
    this.turns.push({
      index: this.turns.length + 1,
      stop_reason: result.stop_reason,
      text_length: result.text.length,
      tool_uses: result.tool_uses.map((u) => ({ name: u.name, input: u.input })),
      tokens_used: result.tokens_used,
      duration_ms: Date.now() - t0,
    });
    return result;
  }
}

async function main(): Promise<void> {
  // DIAGNOSTIC ONLY: tee the raw SSE bytes of the completion response to disk
  const seen = new WeakSet<Response>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await realFetch(input, init);
    const url = String(input);
    if (url.endsWith('/chat/completions') && res.body && !seen.has(res)) {
      seen.add(res);
      const [a, b] = res.body.tee();
      const n = ++teeCounter;
      void new Response(b).text().then((t) => {
        appendFileSync(`/tmp/opencode/qual-v2-sse-turn${n}.txt`, t);
        console.error(`[tee] captured ${t.length} bytes of raw SSE (turn ${n})`);
      });
      return new Response(a, { status: res.status, headers: res.headers });
    }
    return res;
  }) as typeof fetch;

  const inner = new OpenAICompatibleMultiTurnProvider({
    provider: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    model: MODEL,
    api_key_env: 'OPENROUTER_API_KEY',
  });
  const provider = new RecordingProvider(inner);

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      marker: { type: 'string', description: 'The marker token found in the file' },
      content_sha256: { type: 'string', description: 'The sha256 field reported by read_file' },
      summary: { type: 'string', description: 'One sentence describing the file' },
    },
    required: ['marker', 'content_sha256', 'summary'],
  };

  const loop = new AgentLoop(provider, {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    projectRoot: root,
    role: 'explorer',
    workflowRunId: 'v2-qualification',
    iteration: 1,
    nodeId: 'qualification',
    runArtifacts: new RunArtifactManager({ projectRoot: root }),
    resultSchemaJson: schema,
    acceptResult: (value: unknown) => {
      const v = value as Record<string, unknown> | null;
      const shapeOk = !!v
        && typeof v.marker === 'string' && v.marker.length > 0
        && typeof v.content_sha256 === 'string'
        && typeof v.summary === 'string' && v.summary.length > 0;
      return shapeOk
        ? { ok: true as const }
        : { ok: false as const, repairInstruction: 'Result must be an object with non-empty string fields marker, content_sha256, summary.' };
    },
  });

  const t0 = Date.now();
  const result = await loop.run(
    'You are qualifying a streaming transport. Be precise and literal.',
    `Investigate the file ${targetRel}: read it with read_file, and obtain its authoritative ` +
      `sha256 with read_source_slice (read_source_slice reports the authoritative full-file sha256 ` +
      `field computed by the tool — never compute or guess a hash yourself). Then submit your ` +
      `structured result: marker = the marker token string in the file, content_sha256 = the exact ` +
      `sha256 field reported by read_source_slice, summary = one sentence about the file's purpose.`,
  );
  const wall_ms = Date.now() - t0;

  const checks: Array<{ id: string; pass: boolean; detail: string }> = [];
  const check = (id: string, pass: boolean, detail: string) =>
    checks.push({ id, pass, detail: `${pass ? 'PASS' : 'FAIL'}: ${detail}` });

  // 1. AgentLoop completes normally
  check('agent_loop_complete', result.success === true && !result.failure_observation,
    `success=${result.success}, failure_observation=${result.failure_observation ? JSON.stringify(result.failure_observation) : 'absent'}`);

  // 2. submit_result end-to-end: semantic proposal decoded against the contract
  const proposal = (result as { proposal?: { value?: Record<string, unknown> } }).proposal;
  const value = proposal?.value as Record<string, unknown> | undefined;
  check('submit_result_decoded', !!value && typeof value === 'object',
    `proposal present=${!!value}, value=${JSON.stringify(value ?? null)}`);

  // 3. marker round trip: model saw the file content via read_file
  check('marker_round_trip', value?.marker === MARKER,
    `expected=${MARKER}, got=${JSON.stringify(value?.marker ?? null)}`);

  // 4. read_file round trip with authoritative digest
  check('read_file_sha256', value?.content_sha256 === expectedSha,
    `expected=${expectedSha.slice(0, 16)}…, got=${JSON.stringify(value?.content_sha256 ?? null)}`);

  // 5. streamed tool-call assembly: a read_file call was issued and executed
  const readCall = provider.turns.flatMap((t) => t.tool_uses).find((u) => u.name === 'read_file');
  const readPath = (readCall?.input as { path?: string } | undefined)?.path;
  check('streamed_tool_call_assembled', !!readCall && (readPath === targetRel || readPath === `${targetRel}` || String(readPath).endsWith('QUALIFICATION-TARGET.md')),
    `read_file tool_uses found=${!!readCall}, path=${JSON.stringify(readPath ?? null)}`);

  // 6. finish_reason mapping: every turn mapped to a known stop_reason; read turn = tool_calls
  const knownReasons = new Set(['tool_calls', 'end_turn', 'stop', 'length', 'tool_use']);
  const allMapped = provider.turns.length > 0 && provider.turns.every((t) => knownReasons.has(t.stop_reason));
  // RecordingProvider records the provider's MAPPED stop_reason (finish_reason
  // 'tool_calls' maps to 'tool_use' — the documented, suite-pinned mapping).
  const readTurnReason = provider.turns.find((t) => t.tool_uses.some((u) => u.name === 'read_file'))?.stop_reason;
  check('finish_reason_mapped', allMapped && readTurnReason === 'tool_use',
    `stop_reasons=[${provider.turns.map((t) => t.stop_reason).join(', ')}], read_turn=${readTurnReason}`);

  // 7. usage/token accounting present and plausible on every turn
  const usageOk = provider.turns.every((t) => Number.isFinite(t.tokens_used) && t.tokens_used > 0);
  const total = result.tokens_used;
  check('usage_plausible', usageOk && total > 0,
    `per-turn=[${provider.turns.map((t) => t.tokens_used).join(', ')}], loop_total=${total}`);

  // 8. real SSE completed (>=2 provider turns: investigate + submit)
  check('sse_multi_turn_completed', provider.turns.length >= 2,
    `provider turns=${provider.turns.length}`);

  const allPass = checks.every((c) => c.pass);
  const report = {
    kind: 'v2_transport_qualification',
    verdict: allPass ? 'PASS' : 'FAIL',
    ts_started: new Date(t0).toISOString(),
    ts_finished: new Date().toISOString(),
    stratum_head: execFileSync('git', ['-C', '/home/theo/Documents/coding/repos/stratum', 'rev-parse', 'HEAD']).toString().trim(),
    config: { model: MODEL, max_tokens: MAX_TOKENS, temperature: 'provider default (unset)', retries: 0, fallbacks: 'none' },
    fixture: { target: targetRel, marker: MARKER, sha256: expectedSha, bytes: Buffer.byteLength(targetBody) },
    provider_turns: provider.turns,
    loop_result: {
      success: result.success,
      turns_taken: result.turns_taken,
      tokens_used: result.tokens_used,
      proposal_value: value ?? null,
      failure_observation: result.failure_observation ?? null,
    },
    wall_ms,
    checks,
  };
  const reportPath = '/home/theo/Documents/coding/repos/pilot-a/evidence/transport-qualification/v2-qualification-20260925.json';
  mkdirSync('/home/theo/Documents/coding/repos/pilot-a/evidence/transport-qualification', { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  rmSync(root, { recursive: true, force: true });

  for (const c of checks) console.log(c.detail);
  console.log(`VERDICT: ${report.verdict} — report: ${reportPath}`);
  if (!allPass) process.exitCode = 2;
}

main().catch((err) => {
  console.error('QUALIFICATION ERROR (no retry, stopping):', err);
  const reportPath = '/home/theo/Documents/coding/repos/pilot-a/evidence/transport-qualification/v2-qualification-20260925.json';
  try {
    mkdirSync('/home/theo/Documents/coding/repos/pilot-a/evidence/transport-qualification', { recursive: true });
    writeFileSync(reportPath, JSON.stringify({ kind: 'v2_transport_qualification', verdict: 'ERROR', error: String(err), stack: (err as Error).stack }, null, 2) + '\n');
  } catch { /* report write is best-effort */ }
  process.exitCode = 3;
});
