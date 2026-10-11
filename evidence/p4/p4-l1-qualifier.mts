// P4 L1 QUALIFIER — offline operational qualification (charter v1.1 §3 L1):
// the REAL two-WorkItem production path (native define-work + full-build
// engines, real runners/services/repositories, real definition-source
// validation) driven by SCRIPTED providers. Zero network traffic.
//
// Gates (final architecture review, corrections 1–4):
//   A  READY path end-to-end + request-shape calibration (pins
//      evidence/p4/p4-step-shapes.json from OBSERVED production shapes)
//   B  full attempt isolation: fresh DB/state, repository-visible artifact
//      isolation, frozen settings preserved across attempts (correction 4)
//   C  CONFIG-DRIFT: mid-attempt settings mutation → guard per-call
//      re-verification → campaign-terminal STOP (consumes nothing)
//   C2 the P2 request shape (runner transmitting 16384 against the frozen
//      32768 map) → guard STOP before any model call (direct mechanism test)
//   D  stale pinned shapes (wrong tool surface) → fail-closed STOP
//   F1 budget exhaustion at the CORRECT frozen budget → evaluable NOT-READY
//      budget-exhaustion-upstream (never censored, never a STOP)
//   F2 HUMAN_DECISION route → halt at human-decision-checkpoint, decision
//      left pending, NOT-READY; NO synthetic approval (correction 2)
//   F3 EXPLORE_AS_WORK route → committed definition carries an exploration
//      need → NOT-READY definition-exploration-required (correction 2)
//   F4 disk-corrupted definition after commit → provenance/authority fails
//      closed (corrections 2+3)
//   G  §10 kill-and-resume: interrupt mid-exec → INCOMPLETE (consumes
//      nothing); the campaign RESUMES and completes the terminal condition
//   H  code-inspection: exactly ONE settings write (init) in the campaign
//      path; BUILD is never dispatched
//
// Usage: npx tsx evidence/p4/p4-l1-qualifier.mts  (from the stratum repo)

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureRecord } from '../p3/config-guard.mts';
import {
  runP4Attempt, runP4Campaign, readLedger, targetPristine,
  ROOT, DEFINE_WI,
  type AttemptRecord,
} from './p4-campaign.mts';
import { DEFAULT_SHAPES, calibrationShapes, loadFrozenSettings, type PinnedShapes } from './p4-step-contracts.mts';

const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const L1_DIR = `${EVIDENCE}/p4/l1-qualification`;
const SHAPES_PATH = `${EVIDENCE}/p4/p4-step-shapes.json`;

const results: Array<{ gate: string; pass: boolean; detail: string }> = [];
function report(gate: string, pass: boolean, detail: string): void {
  results.push({ gate, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${gate} — ${detail}`);
}

// ─── scripted provider ───────────────────────────────────────────────────────
type Wire = 'completeMultiTurn' | 'complete' | 'completeStructured';
interface ScriptedCall { wire: Wire; step: string | null; params: Record<string, unknown> }

function scriptedProvider(behaviors: {
  multiTurn?: (step: string | null, calls: ScriptedCall[]) => unknown | undefined;
  complete?: (step: string | null, calls: ScriptedCall[]) => unknown | undefined;
  structured?: (step: string | null, params: Record<string, unknown>, calls: ScriptedCall[]) => unknown | undefined;
}) {
  const calls: ScriptedCall[] = [];
  // bound via runP4Attempt's onActive — the driver's live step view
  const bound: { active: { stepId: string | null } | null } = { active: null };
  return {
    calls,
    bind: (active: { stepId: string | null }): void => { bound.active = active; },
    provider: {
      async completeMultiTurn(params: Record<string, unknown>) {
        const step = bound.active?.stepId ?? null;
        const call: ScriptedCall = { wire: 'completeMultiTurn', step, params };
        calls.push(call);
        const r = behaviors.multiTurn?.(step, calls);
        if (r === undefined) throw new Error(`scripted gap: no multiTurn behavior for step=${step}`);
        return r;
      },
      async complete(params: Record<string, unknown>) {
        const step = bound.active?.stepId ?? null;
        const call: ScriptedCall = { wire: 'complete', step, params };
        calls.push(call);
        const r = behaviors.complete?.(step, calls);
        if (r === undefined) throw new Error(`scripted gap: no complete behavior for step=${step}`);
        // LLMCompletionResult envelope: {content, tokens_used, duration_ms}
        return { content: r, tokens_used: 64, duration_ms: 1 };
      },
      async completeStructured(params: Record<string, unknown>) {
        const step = bound.active?.stepId ?? null;
        const call: ScriptedCall = { wire: 'completeStructured', step, params };
        calls.push(call);
        const r = behaviors.structured?.(step, params, calls);
        if (r === undefined) throw new Error(`scripted gap: no structured behavior for step=${step}`);
        // StructuredCompletionResult envelope: {value, tokens_used, duration_ms}
        return { value: r, tokens_used: 64, duration_ms: 1 };
      },
    } as unknown,
  };
}

const mt = (over: Record<string, unknown>) => ({
  stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 64,
  wire_observation: { finish_reason: 'stop' }, ...over,
});
const submitToolUse = (value: unknown) => [{
  name: 'submit_result', id: 'scu_1', input: value,
}];

// archived P1-R upstream outputs (published under the same frozen code) —
// used for full-build legacy produce steps; no byte identity is REQUIRED by
// readiness, these are simply valid real-shaped engine inputs
const p1rRun = `${EVIDENCE}/p1-r/p1-r-1/91342881-eb32-47ff-8dfb-d8a7115dd371/node-outputs`;
const archivedText = (name: string): string => readFileSync(join(p1rRun, name), 'utf-8');

// definition semantic value — matches the projected definition contract
// EXACTLY (observed on the production wire in calibration: required
// goal/facts/bodyMarkdown; facts items {id,statement,status,source} with
// additionalProperties:false; constraints {description,type}; acceptance
// [{description,met?}])
const DEFINITION_VALUE = () => ({
  goal: 'Add a structured failure-payload contract to the RAG worker service so callers can distinguish failure classes programmatically.',
  facts: [
    { id: 'f1', statement: 'The worker service is apps/ai-server/rag-worker-service/main.py.', status: 'KNOWN', source: 'repository' },
    { id: 'f2', statement: 'The issue requests a failure-payload contract for the worker.', status: 'KNOWN', source: 'human' },
    { id: 'f3', statement: 'The exact payload schema field set is a design choice within the bounded scope.', status: 'ASSUMED', source: 'investigation' },
  ],
  constraints: [
    { description: 'Changes are confined to apps/ai-server/rag-worker-service/main.py.', type: 'must' },
    { description: 'No new runtime dependencies are introduced.', type: 'must_not' },
  ],
  requirements: [
    'The worker returns a structured JSON failure payload with a machine-readable failure class on handled failures.',
    'Existing success responses remain unchanged.',
  ],
  nonGoals: [
    'Reworking the worker indexing pipeline.',
    'Changing the upstream vector-store integration.',
  ],
  acceptance: [
    { description: 'A handled failure returns JSON whose body parses and carries a non-empty machine-readable failure class field.' },
  ],
  bodyMarkdown: '# Definition — Worker failure-payload contract\n\nThe bounded scope is the RAG worker service failure responses. See the canonical state for goal, ledger, constraints, requirements, non-goals, and acceptance.',
});

// observed readiness-review contract (calibration capture): required
// verdict + gaps + bodyMarkdown; gap items require target/description/
// classification/reason
const READINESS_PASS = () => ({ verdict: 'pass', gaps: [], bodyMarkdown: 'All seven readiness dimensions pass for the candidate bounded scope. (L1 scripted review.)' });
const READINESS_FAIL = (classification: string, factId: string) => ({
  verdict: 'fail',
  gaps: [{ target: 'scope question', factId, description: 'a gap for route calibration', classification, reason: 'L1 calibration route', closure: 'n/a' }],
  bodyMarkdown: 'Review failed with a classified gap for route calibration. (L1 scripted review.)',
});
// route artifact payloads — exact contract shapes (escalation-contracts.ts):
// decision-request {type, targetFactId, title, summary, options[{id,label,
// description}]}; exploration-need {targetFactId, question,
// whyNotResolvableByReading, requiredWork, completionEvidence}
const DECISION_REQUEST_VALUE = () => ({
  type: 'definition-scope',
  targetFactId: 'f3',
  title: 'Settle the failure-payload schema field set',
  summary: 'The readiness review classified the payload-schema field set as a choice only a human can authorize; decide include vs exclude.',
  options: [
    { id: 'include', label: 'Include', description: 'Treat the full payload field set as in scope for this increment.' },
    { id: 'exclude', label: 'Exclude', description: 'Ship the minimal class field; defer the remaining fields.' },
  ],
});
const EXPLORATION_NEED_VALUE = () => ({
  targetFactId: 'f3',
  question: 'What failure-class taxonomy does the existing worker error surface actually support?',
  whyNotResolvableByReading: 'The taxonomy is determined by runtime behavior under failure injection, not by static reading.',
  requiredWork: 'Inject failures against the worker in a scratch environment and record the observable error payloads.',
  completionEvidence: 'A recorded set of observed failure payloads from which the taxonomy field set can be fixed.',
});

function happyBehaviors() {
  return scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition' || step === 'refine-definition') {
        return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      }
      if (step === 'scoping.produce') return mt({ text: archivedText('scoping.produce.md'), tokens_used: 512 });
      if (step === 'design') return mt({ text: archivedText('design.md'), tokens_used: 512 });
      if (step === 'plan') return mt({ text: archivedText('plan.md'), tokens_used: 512 });
      if (step === 'test') return mt({ text: archivedText('test.md'), tokens_used: 512 });
      return undefined;
    },
    structured: (step) => (step !== null && step.endsWith('readiness-review') ? READINESS_PASS() : undefined),
    complete: (step) => (step === 'critique' ? JSON.stringify({ blocking_issues: [], warnings: [], suggestions: [], pass: true }) : undefined),
  });
}

// route legs: the review FAILS with a classified gap; the routed produce step
// submits the route artifact (shapes observed in calibration)
function humanRouteBehaviors() {
  return scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      if (step === 'prepare-human-decision') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DECISION_REQUEST_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      return undefined;
    },
    structured: (step) => (step !== null && step.endsWith('readiness-review') ? READINESS_FAIL('HUMAN_DECISION', 'f3') : undefined),
  });
}
function exploreRouteBehaviors() {
  return scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      if (step === 'record-exploration-need') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(EXPLORATION_NEED_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      return undefined;
    },
    structured: (step) => (step !== null && step.endsWith('readiness-review') ? READINESS_FAIL('EXPLORE_AS_WORK', 'f3') : undefined),
  });
}

// dump the last teaching message for calibration when a gate fails
function lastUserText(calls: ScriptedCall[]): string {
  for (let i = calls.length - 1; i >= 0; i--) {
    const msgs = (calls[i].params.messages ?? []) as Array<{ role: string; content: unknown }>;
    const last = [...msgs].reverse().find((m) => m.role === 'user');
    if (last) return typeof last.content === 'string' ? last.content.slice(0, 1200) : JSON.stringify(last.content).slice(0, 1200);
  }
  return '(no messages captured)';
}

// ─── gates ───────────────────────────────────────────────────────────────────

async function gateA(): Promise<PinnedShapes> {
  rmSync(L1_DIR, { recursive: true, force: true });
  mkdirSync(L1_DIR, { recursive: true });

  // phase 1 — CALIBRATION: frozen model/budget/effort/temperature enforced,
  // tool surfaces unpinned and observed (charter §5: calibration over
  // constants). The path must still EXECUTE end to end.
  const h1 = happyBehaviors();
  const rec1 = await runP4Attempt(1, h1.provider, L1_DIR, calibrationShapes(), { captureToolSchemas: true, onActive: h1.bind });
  if (rec1.evidencePackagePath === null) {
    report('A.calibration', false, `calibration attempt did not complete: ${rec1.outcome} ${rec1.stopDetail ?? ''} lastTeaching=${lastUserText(h1.calls)}`);
    return DEFAULT_SHAPES;
  }
  const capture = readFileSync(join(rec1.evidencePackagePath, 'guard-capture.jsonl'), 'utf-8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as CaptureRecord);
  const shapes: PinnedShapes = {};
  for (const r of capture) {
    if (r.kind !== 'request' || r.guard_verdict !== 'PASS' || r.wire !== 'completeMultiTurn') continue;
    const key = `${String(r.workflow_id)}/${String(r.step)}`;
    const defs = (r.tool_definitions ?? []) as Array<{ name: string; input_schema?: { properties?: Record<string, unknown>; required?: string[] } }>;
    const names = defs.map((t) => t.name).sort();
    const submit = defs.find((t) => t.name === 'submit_result');
    shapes[key] = {
      tool_sets: [names],
      submit_result: submit
        ? {
            schema_top_level_properties: Object.keys(submit.input_schema?.properties ?? {}).sort(),
            schema_required: submit.input_schema?.required ?? [],
            has_creates_property: false,
          }
        : null,
    };
  }
  for (const r of capture) {
    if (r.kind !== 'request' || r.wire !== 'completeStructured') continue;
    const key = `${String(r.workflow_id)}/${String(r.step)}`;
    shapes[key] = shapes[key] ?? { tool_sets: [[]], submit_result: null };
    shapes[key].structured_schema_name = (r.structured_schema_name as string | null) ?? undefined;
  }
  writeFileSync(SHAPES_PATH, JSON.stringify(shapes, null, 2));
  const calSteps = Object.keys(shapes).join(', ');
  report('A.calibration', Object.keys(shapes).length > 0, `observed+attempt1=${rec1.outcome}; pinned ${Object.keys(shapes).length} step shapes [${calSteps}] → ${SHAPES_PATH}`);

  // phase 1b/1c — calibration legs for the ROUTE steps the happy path never
  // reaches: the human-decision route (prepare-human-decision) and the
  // explore route (record-exploration-need). Observed, pinned, merged.
  for (const leg of [
    { name: 'human-route', behaviors: humanRouteBehaviors() },
    { name: 'explore-route', behaviors: exploreRouteBehaviors() },
  ]) {
    const h = leg.behaviors;
    const r = await runP4Attempt(1, h.provider, L1_DIR, calibrationShapes(), { captureToolSchemas: true, onActive: h.bind });
    if (r.evidencePackagePath === null) {
      report(`A.calibration.${leg.name}`, false, `leg did not complete: ${r.outcome} ${r.stopDetail ?? ''} lastTeaching=${lastUserText(h.calls)}`);
      continue;
    }
    const cap = readFileSync(join(r.evidencePackagePath, 'guard-capture.jsonl'), 'utf-8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as CaptureRecord);
    let added = 0;
    for (const x of cap) {
      if (x.kind !== 'request' || x.guard_verdict !== 'PASS' || x.wire !== 'completeMultiTurn') continue;
      const key = `${String(x.workflow_id)}/${String(x.step)}`;
      if (shapes[key]) continue;
      const defs = (x.tool_definitions ?? []) as Array<{ name: string; input_schema?: { properties?: Record<string, unknown>; required?: string[] } }>;
      const names = defs.map((t) => t.name).sort();
      const submit = defs.find((t) => t.name === 'submit_result');
      shapes[key] = {
        tool_sets: [names],
        submit_result: submit
          ? {
              schema_top_level_properties: Object.keys(submit.input_schema?.properties ?? {}).sort(),
              schema_required: submit.input_schema?.required ?? [],
              has_creates_property: false,
            }
          : null,
      };
      added++;
    }
    writeFileSync(SHAPES_PATH, JSON.stringify(shapes, null, 2));
    report(`A.calibration.${leg.name}`, added > 0, `leg outcome=${r.outcome} class=${r.failureClass ?? ''}; pinned +${added} route step shapes (total ${Object.keys(shapes).length})`);
  }

  // phase 2 — STRICT: re-run the READY path under the pinned shapes; every
  // request must now match its pinned production shape exactly
  const h2 = happyBehaviors();
  const rec2 = await runP4Attempt(2, h2.provider, L1_DIR, shapes, { onActive: h2.bind });
  if (rec2.outcome !== 'READY') {
    report('A.ready-path', false, `outcome=${rec2.outcome} class=${rec2.failureClass ?? ''} checks=${rec2.assessment ? JSON.stringify(rec2.assessment.checks) : 'null'} lastTeaching=${lastUserText(h2.calls)}`);
    return shapes;
  }
  const allPass = Object.values(rec2.assessment!.checks).every((x) => x.pass);
  const wires = [...new Set(h2.calls.map((x) => x.wire))].join(',');
  report('A.ready-path', allPass, `READY under PINNED shapes; R1–R6 all pass; scripted calls=${h2.calls.length} wires=[${wires}]`);
  return shapes;
}

async function gateB(shapes: PinnedShapes): Promise<void> {
  const h = happyBehaviors();
  const before = targetPristine();
  const rec = await runP4Attempt(2, h.provider, L1_DIR, shapes, { onActive: h.bind });
  const pkg = rec.evidencePackagePath;
  const db = pkg ? (JSON.parse(readFileSync(join(pkg, 'db-records.json'), 'utf-8')) as { work_items: Array<{ id: string }>; artifacts: unknown[] }) : null;
  const wiIds = (db?.work_items ?? []).map((w) => w.id).sort();
  const onlyThisAttempt = wiIds.length === 2 && wiIds.includes(DEFINE_WI) && wiIds.includes('wi-exec-108');
  report('B.isolation', rec.outcome === 'READY' && onlyThisAttempt && before && targetPristine(),
    `attempt2=${rec.outcome} workItems=[${wiIds.join(',')}] (fresh DB: ONLY this attempt's rows) pristine before=${before} after=${targetPristine()} settings=${loadFrozenSettings().settingsSha256.slice(0, 8)}`);
}

async function gateC(shapes: PinnedShapes): Promise<void> {
  // drift settings EXACTLY like the P2 seed() output — inside the inner
  // provider during the FIRST call; the guard's per-call re-verification
  // must STOP the second call before any model traffic
  const drifted = { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', base_url: 'https://openrouter.ai/api/v1', max_tokens: 16384, api_key_env: 'OPENROUTER_API_KEY' };
  const h = happyBehaviors();
  let driftWritten = false;
  const wrapped = {
    async completeMultiTurn(params: Record<string, unknown>) {
      if (!driftWritten) { driftWritten = true; writeFileSync(join(ROOT, '.sle', 'settings.json'), JSON.stringify(drifted, null, 2)); }
      return (h.provider as { completeMultiTurn: (p: Record<string, unknown>) => Promise<unknown> }).completeMultiTurn(params);
    },
    async complete(p: Record<string, unknown>) { return (h.provider as { complete: (x: Record<string, unknown>) => Promise<unknown> }).complete(p); },
    async completeStructured(p: Record<string, unknown>) { return (h.provider as { completeStructured: (x: Record<string, unknown>) => Promise<unknown> }).completeStructured(p); },
  };
  const rec = await runP4Attempt(3, wrapped, L1_DIR, shapes, { onActive: h.bind });
  // the drift STOP surfaces as G2 (the mid-call divergence left the response
  // unarchivable — fail closed) with the settings violation in the step
  // failure record; either way: campaign-terminal STOP, consumes nothing
  let stepFailureSaysSettings = false;
  if (rec.evidencePackagePath) {
    const db = JSON.parse(readFileSync(join(rec.evidencePackagePath, 'db-records.json'), 'utf-8')) as { step_executions?: Array<{ failure_json: string | null }> };
    stepFailureSaysSettings = (db.step_executions ?? []).some((s) => (s.failure_json ?? '').includes('settings sha256'));
  }
  const ok = rec.outcome === 'STOPPED' && rec.failureClass === 'guard-stop' && stepFailureSaysSettings;
  report('C.config-drift-stop', ok, `outcome=${rec.outcome} class=${rec.failureClass} stepFailureSaysSettings=${stepFailureSaysSettings} — mid-attempt drift (the exact P2 seed() output) STOPs the campaign (fail-closed evidence + settings violation)`);
}

async function gateC2(): Promise<void> {
  // direct mechanism test: a runner-shaped request carrying the P2 wire
  // (16384 against the frozen 32768 map for full-build/design) must be
  // refused BEFORE the model call
  const { createP4GuardProvider } = await import('./p4-transport-guard.mts');
  const { makeContractResolver } = await import('./p4-step-contracts.mts');
  const frozen = loadFrozenSettings();
  // restore the frozen settings file (gateC deliberately leaves it drifted)
  writeFileSync(join(ROOT, '.sle', 'settings.json'), readFileSync(`${EVIDENCE}/v11-frozen-config/settings.json`));
  const sentinel = {
    reached: false,
    async completeMultiTurn() { this.reached = true; return mt({}); },
  };
  const active = { workflowId: 'full-build' as string | null, stepId: 'design' as string | null };
  const guard = createP4GuardProvider(sentinel as object, makeContractResolver(frozen, DEFAULT_SHAPES, active), {
    capturePath: join(L1_DIR, 'gate-c2-probe.jsonl'),
    phase: 'gate-c2',
    settingsPath: join(ROOT, '.sle', 'settings.json'),
    expectedSettingsSha256: frozen.settingsSha256,
  });
  let refused = false;
  try {
    await (guard as { completeMultiTurn: (p: Record<string, unknown>) => Promise<unknown> }).completeMultiTurn({
      model: frozen.model, system: 's', messages: [{ role: 'user', content: 'x' }],
      max_tokens: 16384, temperature: frozen.temperature, tools: [],
    });
  } catch (e) {
    refused = String(e).includes('max_tokens') && String(e).includes('32768');
  }
  report('C2.budget-wire-stop', refused && !sentinel.reached,
    `P2-shaped request (16384 vs frozen 32768 for full-build/design) refused pre-call; inner provider reached=${sentinel.reached}`);
}

async function gateD(shapes: PinnedShapes): Promise<void> {
  const badShapes: PinnedShapes = { ...shapes, 'define-work/synthesize-definition': { tool_sets: [['nonexistent_tool']], submit_result: null } };
  const h = happyBehaviors();
  const rec = await runP4Attempt(5, h.provider, L1_DIR, badShapes, { onActive: h.bind });
  const reached = h.calls.filter((c) => c.step === 'synthesize-definition').length;
  const ok = rec.outcome === 'STOPPED' && rec.failureClass === 'guard-stop' && (rec.stopDetail ?? '').includes('tool set') && reached === 0;
  report('D.unpinned-shape-stop', ok, `outcome=${rec.outcome} class=${rec.failureClass} scripted calls for the step=${reached} (fail-closed request validation BEFORE any model call)`);
}

async function gateF1(shapes: PinnedShapes): Promise<void> {
  const h = scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      if (step === 'scoping.produce') return mt({ text: archivedText('scoping.produce.md'), tokens_used: 512 });
      if (step === 'design') return mt({ stop_reason: 'length', text: 'partial', tokens_used: 32768, wire_observation: { finish_reason: 'length' } });
      return undefined;
    },
    structured: (step) => (step !== null && step.endsWith('readiness-review') ? READINESS_PASS() : undefined),
  });
  const rec = await runP4Attempt(6, h.provider, L1_DIR, shapes, { onActive: h.bind });
  report('F1.budget-exhaustion-not-ready', rec.outcome === 'NOT-READY' && rec.failureClass === 'budget-exhaustion-upstream' && rec.evaluable === true,
    `outcome=${rec.outcome} class=${rec.failureClass} evaluable=${rec.evaluable} — genuine length terminus at the CORRECT budget = model-attributable NOT-READY, never a STOP`);
}

async function gateF2(shapes: PinnedShapes): Promise<void> {
  const h = humanRouteBehaviors();
  const rec = await runP4Attempt(7, h.provider, L1_DIR, shapes, { onActive: h.bind });
  const db = rec.evidencePackagePath ? (JSON.parse(readFileSync(join(rec.evidencePackagePath, 'db-records.json'), 'utf-8')) as { decisions?: Array<{ status: string }> }) : null;
  const pending = (db?.decisions ?? []).filter((x) => x.status === 'pending').length;
  report('F2.human-decision-pending', rec.outcome === 'NOT-READY' && rec.failureClass === 'definition-human-decision-required' && pending >= 1,
    `outcome=${rec.outcome} class=${rec.failureClass} pendingDecisions=${pending} — the semantic human question is NEVER synthetically approved`);
}

async function gateF3(shapes: PinnedShapes): Promise<void> {
  const h = exploreRouteBehaviors();
  const rec = await runP4Attempt(8, h.provider, L1_DIR, shapes, { onActive: h.bind });
  report('F3.explore-not-ready', rec.outcome === 'NOT-READY' && rec.failureClass === 'definition-exploration-required',
    `outcome=${rec.outcome} class=${rec.failureClass} — a committed definition reached via the explore route does NOT qualify (final readiness outcome verified, not just parse+resolve)`);
}

async function gateF4(shapes: PinnedShapes): Promise<void> {
  let corrupted = false;
  const h = scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      if (step === 'scoping.produce') {
        if (!corrupted) {
          corrupted = true;
          writeFileSync(join(ROOT, '.sle', 'work', DEFINE_WI, 'definition.md'), 'CORRUPTED BY L1 GATE F4');
        }
        return mt({ text: archivedText('scoping.produce.md'), tokens_used: 512 });
      }
      if (step === 'design') return mt({ text: archivedText('design.md'), tokens_used: 512 });
      if (step === 'plan') return mt({ text: archivedText('plan.md'), tokens_used: 512 });
      if (step === 'test') return mt({ text: archivedText('test.md'), tokens_used: 512 });
      return undefined;
    },
    structured: (step) => (step !== null && step.endsWith('readiness-review') ? READINESS_PASS() : undefined),
  });
  const rec = await runP4Attempt(9, h.provider, L1_DIR, shapes, { onActive: h.bind });
  const r2 = rec.assessment?.checks.R2_definition_chain;
  report('F4.authority-invalid', rec.outcome === 'NOT-READY' && r2?.pass === false,
    `outcome=${rec.outcome} class=${rec.failureClass ?? ''} R2=${String(r2?.pass)} (${(r2?.detail ?? '').slice(0, 140)}) — provenance/disk-integrity/admissibility fails closed`);
}

async function gateG(shapes: PinnedShapes): Promise<void> {
  const campaignDir = join(L1_DIR, 'gate-g-campaign');
  rmSync(campaignDir, { recursive: true, force: true });
  mkdirSync(campaignDir, { recursive: true });
  const { spawnSync } = await import('node:child_process');
  const childArgs = (killAt: number) => [
    'tsx', `${EVIDENCE}/p4/p4-l1-resume-child.mts`,
    '--evidence-dir', campaignDir, '--kill-at', String(killAt),
    '--attempts', '2', '--threshold', '2',
  ];
  // launch 1: real SIGKILL mid-attempt (the 3rd provider call, inside design)
  const k = spawnSync('npx', childArgs(3), { cwd: '/home/theo/Documents/coding/repos/stratum', encoding: 'utf-8', timeout: 300000 });
  const killed = k.status !== 0 || k.signal === 'SIGKILL';
  // launch 2: the RESUME — same campaign dir, no kill
  const r = spawnSync('npx', childArgs(0), { cwd: '/home/theo/Documents/coding/repos/stratum', encoding: 'utf-8', timeout: 600000 });
  const ledger = readLedger(campaignDir);
  const incomplete = ledger.filter((l) => l.event === 'attempt-incomplete');
  const counted = ledger.filter((l) => l.event === 'attempt-counted');
  const resumed = r.stdout.includes('supported=true') || r.stdout.includes('threshold 2');
  void resumed;
  const ok = killed && incomplete.length >= 1 && counted.length >= 2 && counted.every((l) => l.outcome === 'READY');
  const terminalLine = (r.stdout.trim().split('\n').pop() ?? '').slice(0, 90);
  report('G.kill-and-resume', ok,
    `killed=${killed} resumeTerminal="${terminalLine}" ledger incomplete=${incomplete.length} counted=${counted.length} allReady=${counted.every((l) => l.outcome === 'READY')} — a real process death consumed nothing; the resume declared it incomplete and completed the terminal condition`);
}

function gateH(): void {
  const src = readFileSync(`${EVIDENCE}/p4/p4-campaign.mts`, 'utf-8');
  const settingsWrites = [...src.matchAll(/writeFileSync\([^)]*settings/g)].length;
  const installFn = src.includes('function installFrozenSettings');
  const noBuildDrive = !src.includes("cursor === 'build'") && !src.includes("stepId === 'build'");
  report('H.code-inspection', settingsWrites === 1 && installFn && noBuildDrive,
    `settings writes=${settingsWrites} (init-only inside installFrozenSettings) present=${installFn} build never dispatched=${noBuildDrive}`);
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!targetPristine()) throw new Error('target not pristine — L1 refuses to run');
  console.log('=== P4 L1 qualification (offline; zero network traffic) ===');
  gateH();
  const shapes = await gateA();
  if (results.find((r) => r.gate === 'A.ready-path')?.pass) {
    await gateB(shapes);
    await gateC(shapes);
    await gateC2();
    await gateD(shapes);
    await gateF1(shapes);
    await gateF2(shapes);
    await gateF3(shapes);
    await gateF4(shapes);
    await gateG(shapes);
  } else {
    console.log('Gate A failed — remaining gates skipped (fix the READY path first).');
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`=== L1: ${passed}/${results.length} gates passed ===`);
  writeFileSync(`${EVIDENCE}/p4/p4-l1-qualification-output.txt`, JSON.stringify({ finished_at_utc: new Date().toISOString(), results }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => { console.error('L1 fatal:', e); process.exit(1); });
