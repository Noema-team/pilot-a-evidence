// L2 OPERATIONAL QUALIFICATION — real-provider engineering round
// (PROCESS-CHARTER.md §3 layer L2, §4 standing engineering-traffic class,
// §5 calibration-over-constants; ratified by the operator's task assignment)
//
// PURPOSE: establish EMPIRICAL properties the offline layers cannot:
//   Q-A  wire reachability + auth + a properly terminated completion at the
//        frozen effort setting
//   Q-B  viability of the FROZEN probe contract (max_tokens 512): 3/3
//        acceptable completions (stop_reason end_turn AND finish_reason stop
//        AND non-empty text — the frozen adjudication criteria), plus
//        reasoning-cost calibration for the probe budget
//   Q-C  acceptance of a BUILD-shaped tool-calling request (frozen model/
//        effort/temperature, frozen tool names, small budget)
//
// CAPS (charter §4): 5 completion calls total, <= ~5k completion tokens.
// This evidence NEVER counts toward any experimental denominator (L3).

import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveLLMProvider } from '/home/theo/Documents/coding/repos/stratum/src/application.js';
import { createConfigGuardProvider, type StepContract } from '/home/theo/Documents/coding/repos/pilot-a/evidence/p3/config-guard.mts';

const ROOT = '/home/theo/Documents/coding/repos/student-platform';
const OPS = '/home/theo/Documents/coding/repos/pilot-a/evidence/ops-qual';
const SETTINGS_SHA = '5634b2e897eeb56467deae26da0dd9146c36dc192a61ded23196ee21b55925a2';
const EXPECTED_MODEL = 'z-ai/glm-5.3-flash';

const settingsPath = join(ROOT, '.sle', 'settings.json');
if (!existsSync(settingsPath) || createHash('sha256').update(readFileSync(settingsPath)).digest('hex') !== SETTINGS_SHA) {
  console.error('FATAL: pinned settings not present in the target workspace — aborting before any dial');
  process.exit(1);
}

const roundId = `l2-round-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const roundDir = join(OPS, roundId);
mkdirSync(roundDir, { recursive: true });
const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

const { provider, model } = resolveLLMProvider(ROOT) as { provider: { completeMultiTurn: (p: unknown) => Promise<unknown> }; model: string };
if (model !== EXPECTED_MODEL) { console.error(`FATAL: resolved model ${model} != ${EXPECTED_MODEL}`); process.exit(1); }

// Stratum/guard flat tool format: { name, description, input_schema }
const tools = [
  { name: 'read_file', description: 'Read a file from the repository.', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'repository-relative path' } }, required: ['path'] } },
  { name: 'submit_result', description: 'Submit the final structured result.', input_schema: { type: 'object', properties: { edits: { type: 'array', items: { type: 'object' } } }, required: ['edits'] } },
];

const contracts: Record<string, () => StepContract> = {
  'qa-connectivity': () => ({ stepId: 'l2-connectivity', model, max_tokens: 512, reasoning_effort: 'low', temperature: 0.7, tool_sets: [[]], submit_result: null }),
  'qb-probe-viability': () => ({ stepId: 'l2-probe', model, max_tokens: 512, reasoning_effort: 'low', temperature: 0.7, tool_sets: [[]], submit_result: null }),
  'qc-build-tool-smoke': () => ({
    stepId: 'l2-toolsmoke', model, max_tokens: 2048, reasoning_effort: 'low', temperature: 0.7,
    tool_sets: [['read_file', 'submit_result']],
    // faithful mirror of the frozen BUILD submission surface
    submit_result: { schema_top_level_properties: ['edits'], schema_required: ['edits'], has_creates_property: false, teaching_has_edits_line: true, teaching_has_creates_line: false },
  }),
};

interface CallResult {
  label: string; capture: string; capture_sha256: string; ms: number;
  stop_reason: string | null; finish_reason: string | null; text_len: number;
  reasoning_tokens: number | null; completion_tokens: number | null; tool_calls: number; acceptable: boolean; error?: string;
}

async function dial(label: string, params: Record<string, unknown>): Promise<CallResult> {
  const capturePath = join(roundDir, `${label}-capture.jsonl`);
  const contractKey = label.replace(/-\d+$/, '');
  const guarded = createConfigGuardProvider(provider, contracts[contractKey], {
    capturePath, phase: `l2:${label}`, settingsPath, expectedSettingsSha256: SETTINGS_SHA,
  }) as { completeMultiTurn: (p: unknown) => Promise<unknown> };
  const t0 = Date.now();
  let err: string | undefined;
  try { await guarded.completeMultiTurn(params); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const ms = Date.now() - t0;

  let stop_reason: string | null = null, finish_reason: string | null = null, text_len = 0,
      reasoning_tokens: number | null = null, completion_tokens: number | null = null, tool_calls = 0;
  if (existsSync(capturePath)) {
    for (const line of readFileSync(capturePath, 'utf-8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as Record<string, never>;
      if (r['kind'] === 'response') {
        stop_reason = r['stop_reason'] as string | null;
        const wo = (r['wire_observation'] ?? {}) as Record<string, number | string | null>;
        finish_reason = (wo['finish_reason'] as string | null) ?? null;
        reasoning_tokens = (wo['reasoning_tokens'] as number | null) ?? null;
        completion_tokens = (wo['completion_tokens'] as number | null) ?? null;
        text_len = String(r['text'] ?? '').length;
        tool_calls = Array.isArray(r['tool_uses']) ? (r['tool_uses'] as unknown[]).length : 0;
      }
    }
  }
  const acceptable = stop_reason === 'end_turn' && finish_reason === 'stop' && text_len > 0;
  const captureOk = existsSync(capturePath);
  return { label, capture: capturePath, capture_sha256: captureOk ? sha256File(capturePath) : 'absent', ms, stop_reason, finish_reason, text_len, reasoning_tokens, completion_tokens, tool_calls, acceptable, ...(err ? { error: err.slice(0, 200) } : {}) };
}

const userMsg = (content: string) => [{ role: 'user', content }];
const results: CallResult[] = [];

console.log(`[l2] round ${roundId} — 5 dials authorized (Q-A:1, Q-B:3, Q-C:1), caps per charter §4`);

results.push(await dial('qa-connectivity', {
  model, system: 'You are a careful coding agent.', messages: userMsg('Reply with the single word READY.'),
  max_tokens: 512, temperature: 0.7, reasoning_effort: 'low', tools: [],
}));
console.log(`[l2] Q-A done: ${JSON.stringify(results.at(-1))}`);

for (let i = 1; i <= 3; i++) {
  results.push(await dial(`qb-probe-viability-${i}`, {
    model, system: 'You are a careful coding agent.', messages: userMsg('Reply with the single word READY.'),
    max_tokens: 512, temperature: 0.7, reasoning_effort: 'low', tools: [],
  }));
  console.log(`[l2] Q-B#${i} done: ${JSON.stringify(results.at(-1))}`);
}

results.push(await dial('qc-build-tool-smoke', {
  model, system: 'You are a careful coding agent working in a git repository.',
  messages: userMsg('Use the read_file tool to read the file main.py at the repository root, then reply DONE.\nResult shape:\n- /properties/edits: the list of anchored edits to apply (required).'),
  max_tokens: 2048, temperature: 0.7, reasoning_effort: 'low', tools,
}));
console.log(`[l2] Q-C done: ${JSON.stringify(results.at(-1))}`);

// calibration per charter §5: recommended probe budget = max observed reasoning x 4, rounded up to 64
const probeReasoning = results.filter(r => r.label.startsWith('qb')).map(r => r.reasoning_tokens ?? 0);
const allReasoning = results.map(r => r.reasoning_tokens ?? 0);
const maxProbe = Math.max(...probeReasoning, 0);
const recommended = Math.ceil((maxProbe * 4) / 64) * 64;
const currentProbeBudget = 512;

const report = {
  report: 'L2 OPERATIONAL QUALIFICATION ROUND',
  round_id: roundId,
  charter_basis: 'PROCESS-CHARTER.md §3 (L2), §4 (standing engineering-traffic class), §5 (calibration)',
  purpose: 'validate empirically: wire acceptance of the frozen probe contract; probe-budget reachability; BUILD-shaped tool-call acceptance; reasoning-cost calibration. Engineering evidence only — NEVER counted toward any L3 denominator.',
  model, settings_sha256: SETTINGS_SHA,
  verdicts: {
    'QA-connectivity': results[0].acceptable ? 'PASS' : `FAIL (${results[0].stop_reason}/${results[0].finish_reason}/text=${results[0].text_len})${results[0].error ? ` err=${results[0].error}` : ''}`,
    'QB-probe-viability': `${results.filter(r => r.label.startsWith('qb') && r.acceptable).length}/3 acceptable` + (results.filter(r => r.label.startsWith('qb')).every(r => r.acceptable) ? ' PASS' : ' FAIL'),
    'QC-build-tool-smoke': results.at(-1)!.stop_reason !== null ? `PASS (wire accepted; stop_reason=${results.at(-1)!.stop_reason}; tool_calls=${results.at(-1)!.tool_calls})` : `FAIL (no wire response archived${results.at(-1)!.error ? `: ${results.at(-1)!.error}` : ''})`,
  },
  calibration: {
    probe_reasoning_tokens_observed: probeReasoning,
    max_reasoning_tokens_any_call: Math.max(...allReasoning, 0),
    rule: 'recommended = max observed probe reasoning x 4 (rounded to 64)',
    recommended_probe_budget: recommended,
    current_probe_budget: currentProbeBudget,
    sufficient: currentProbeBudget >= recommended,
  },
  totals: { calls: results.length, completion_tokens: results.reduce((a, r) => a + (r.completion_tokens ?? 0), 0), wall_ms: results.reduce((a, r) => a + r.ms, 0) },
  calls: results,
};
writeFileSync(join(roundDir, 'l2-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log('=== L2 ROUND VERDICTS ===');
console.log(JSON.stringify(report.verdicts, null, 2));
console.log(JSON.stringify(report.calibration, null, 2));
