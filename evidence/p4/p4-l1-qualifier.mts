// P4 L1 QUALIFIER (r2) — offline operational qualification (charter v1.1 §3
// L1): the REAL two-WorkItem production path (native define-work + full-build
// engines, real runners/services/repositories, real definition-source
// validation) driven by SCRIPTED providers. Zero network traffic.
//
// r2 — implementation-review corrections (additive: prior L1 evidence in
// l1-qualification/ is preserved untouched):
//   A  READY path end-to-end + request-shape calibration, now covering the
//      legitimate reachable native route shapes (refine-definition route,
//      apply-human-decision + post-human-readiness-review via a SCRIPTED
//      HUMAN operator through the real ResumeService) without weakening the
//      wire contract (the guard validates every call in every leg)
//   B  full attempt isolation (correction 4)
//   C  CONFIG-DRIFT mid-attempt → campaign-terminal STOP
//   C2 the P2 request shape refused pre-call
//   D  stale pinned shapes → fail-closed STOP
//   E2 REQUIRED-native-BUILD-input verification: missing artifact (row
//      present, disk absent) and corrupted artifact (row hash != disk bytes)
//      both fail closed — R2 names the path (review P1 #1)
//   F1 budget exhaustion at the CORRECT frozen budget → evaluable NOT-READY
//   F2 HUMAN_DECISION route → decision left PENDING, NOT-READY (no approval)
//   F3 EXPLORE_AS_WORK route → does NOT qualify
//   F4 disk-corrupted definition → provenance/authority fails closed
//   T  post-archive TAMPER: full-package verifier detects a flipped byte
//      outside the archive (review P1 #3)
//   AUTH out-of-policy upstream disk write → AUTHORITY-BYPASS STOP archived
//      BEFORE worktree cleanup (review P1 #4)
//   G  §10 SIGKILL after slot 1 counted, crash during slot 2 → the resume
//      RECONSTRUCTS the counted slot from the ledger: no re-execution, no
//      double-count (review P1 #2)
//   H  code-inspection: exactly ONE settings write (init); BUILD never driven
//
// Usage: npx tsx evidence/p4/p4-l1-qualifier.mts  (from the stratum repo)

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureRecord } from '../p3/config-guard.mts';
import {
  runP4Attempt, runP4Campaign, readLedger, targetPristine, verifyEvidencePackage,
  ROOT, DEFINE_WI,
  type AttemptRecord,
} from './p4-campaign.mts';
import { DEFAULT_SHAPES, calibrationShapes, loadFrozenSettings, type PinnedShapes } from './p4-step-contracts.mts';

const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const L1_DIR = `${EVIDENCE}/p4/l1-qualification-r3b`;
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
// EXACTLY (observed on the production wire in calibration)
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
// the definition AFTER the human decision is NOT authored by the test: the
// apply-human-decision step submits only a narrow DECISION_APPLICATION_PROPOSAL
// and the native deterministic contract performs the ledger transition.

// the decision-application PROPOSAL (the apply-human-decision submit surface):
// deliberately narrow — no goal, no facts; the deterministic contract performs
// the ledger transition on the resolved Decision's authority (DDR-036)
const DECISION_APPLICATION_PROPOSAL = () => ({
  factStatement: 'The failure-payload schema field set is FIXED by the human decision (option "include"): the full payload field set is in scope for this increment.',
  requirements: [
    'The worker returns a structured JSON failure payload with a machine-readable failure class on handled failures.',
    'The payload carries the full decided field set (include option).',
    'Existing success responses remain unchanged.',
  ],
  bodyMarkdown: 'Records the human decision: the payload field set is in scope (option include). Other open questions remain for their own routes.',
});
// the definition with f3 DEFERRED (the apply-deferred-gaps submit surface IS
// the full definition contract — the step converts DEFER gaps to DEFERRED)
const DEFINITION_DEFERRED = () => ({
  ...DEFINITION_VALUE(),
  facts: DEFINITION_VALUE().facts.map((f) => (f.id === 'f3'
    ? { ...f, status: 'DEFERRED' }
    : f)),
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
// route artifact payloads — exact contract shapes (escalation-contracts.ts)
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
// refine route: the FIRST review fails with a CAN_RESOLVE gap (resolvable by
// reading — refine-definition is the native route); the SECOND review passes
function refineRouteBehaviors() {
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
    structured: (step, _params, calls) => {
      if (step !== null && step.endsWith('readiness-review')) {
        const reviewCalls = calls.filter((c) => c.wire === 'completeStructured').length;
        return reviewCalls <= 1 ? READINESS_FAIL('CAN_RESOLVE', 'f3') : READINESS_PASS();
      }
      return undefined;
    },
  });
}
// human-RESOLUTION calibration leg: the review fails HUMAN_DECISION, the
// harness (as the scripted human operator) resolves the pending decision
// through the real ResumeService, the decision-application proposal is
// applied through the native deterministic contract, and the downstream
// native shapes (apply-human-decision, post-human-readiness-review) are
// observed
function humanResolutionBehaviors() {
  return scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      if (step === 'apply-human-decision') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DECISION_APPLICATION_PROPOSAL()), wire_observation: { finish_reason: 'tool_calls' } });
      if (step === 'prepare-human-decision') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DECISION_REQUEST_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      return undefined;
    },
    structured: (step, _params, calls) => {
      if (step !== null && step.endsWith('readiness-review')) {
        const reviewCalls = calls.filter((c) => c.wire === 'completeStructured').length;
        return reviewCalls <= 1 ? READINESS_FAIL('HUMAN_DECISION', 'f3') : READINESS_PASS();
      }
      return undefined;
    },
  });
}
// DEFER route: the review fails with a DEFER-classified gap; the native
// apply-deferred-gaps step converts the gap to DEFERRED in the fact ledger;
// the post-defer-readiness-review then passes — a legitimate native route to
// a READY definition (explicit recorded exclusion from scope)
function deferRouteBehaviors() {
  return scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition' || step === 'apply-deferred-gaps') {
        return mt({
          stop_reason: 'tool_use', text: '', wire_observation: { finish_reason: 'tool_calls' },
          tool_uses: submitToolUse(step === 'apply-deferred-gaps' ? DEFINITION_DEFERRED() : DEFINITION_VALUE()),
        });
      }
      if (step === 'scoping.produce') return mt({ text: archivedText('scoping.produce.md'), tokens_used: 512 });
      if (step === 'design') return mt({ text: archivedText('design.md'), tokens_used: 512 });
      if (step === 'plan') return mt({ text: archivedText('plan.md'), tokens_used: 512 });
      if (step === 'test') return mt({ text: archivedText('test.md'), tokens_used: 512 });
      return undefined;
    },
    structured: (step, _params, calls) => {
      if (step !== null && step.endsWith('readiness-review')) {
        const reviewCalls = calls.filter((c) => c.wire === 'completeStructured').length;
        return reviewCalls <= 1 ? READINESS_FAIL('DEFER', 'f3') : READINESS_PASS();
      }
      return undefined;
    },
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

// ─── shape extraction from a calibration capture ─────────────────────────────
function extractShapes(shapes: PinnedShapes, capturePath: string): number {
  const cap = readFileSync(capturePath, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as CaptureRecord);
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
  for (const x of cap) {
    if (x.kind !== 'request' || x.wire !== 'completeStructured') continue;
    const key = `${String(x.workflow_id)}/${String(x.step)}`;
    shapes[key] = shapes[key] ?? { tool_sets: [[]], submit_result: null };
    shapes[key].structured_schema_name = (x.structured_schema_name as string | null) ?? undefined;
  }
  return added;
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
  const shapes: PinnedShapes = {};
  extractShapes(shapes, join(rec1.evidencePackagePath, 'guard-capture.jsonl'));
  writeFileSync(SHAPES_PATH, JSON.stringify(shapes, null, 2));
  report('A.calibration', Object.keys(shapes).length > 0 && rec1.outcome === 'READY',
    `observed+attempt1=${rec1.outcome}; pinned ${Object.keys(shapes).length} step shapes [${Object.keys(shapes).join(', ')}] → ${SHAPES_PATH}`);

  // phase 1b/1c/1d/1e — calibration legs for the legitimate reachable native
  // route shapes the happy path never reaches: the refine route (CAN_RESOLVE
  // → refine-definition → re-review, a full READY attempt through a second
  // native route), the human-decision route (prepare-human-decision), the
  // explore route (record-exploration-need), and the human-RESOLUTION leg
  // (apply-human-decision + post-human-readiness-review, driven by a SCRIPTED
  // HUMAN operator through the real ResumeService — the campaign itself never
  // authors that resolution). Every call in every leg is guard-validated.
  const legs: Array<{ name: string; run: () => Promise<{ rec: AttemptRecord; calls: ScriptedCall[]; added: number }>; expect: string }> = [
    {
      name: 'refine-route',
      run: async () => {
        const h = refineRouteBehaviors();
        const rec = await runP4Attempt(1, h.provider, L1_DIR, calibrationShapes(), { captureToolSchemas: true, onActive: h.bind });
        const added = rec.evidencePackagePath ? extractShapes(shapes, join(rec.evidencePackagePath, 'guard-capture.jsonl')) : 0;
        return { rec, calls: h.calls, added };
      },
      expect: 'READY',
    },
    {
      name: 'defer-route',
      run: async () => {
        const h = deferRouteBehaviors();
        const rec = await runP4Attempt(1, h.provider, L1_DIR, calibrationShapes(), { captureToolSchemas: true, onActive: h.bind });
        const added = rec.evidencePackagePath ? extractShapes(shapes, join(rec.evidencePackagePath, 'guard-capture.jsonl')) : 0;
        return { rec, calls: h.calls, added };
      },
      expect: 'READY',
    },
    {
      name: 'human-route',
      run: async () => {
        const h = humanRouteBehaviors();
        const rec = await runP4Attempt(1, h.provider, L1_DIR, calibrationShapes(), { captureToolSchemas: true, onActive: h.bind });
        const added = rec.evidencePackagePath ? extractShapes(shapes, join(rec.evidencePackagePath, 'guard-capture.jsonl')) : 0;
        return { rec, calls: h.calls, added };
      },
      expect: 'NOT-READY',
    },
    {
      name: 'explore-route',
      run: async () => {
        const h = exploreRouteBehaviors();
        const rec = await runP4Attempt(1, h.provider, L1_DIR, calibrationShapes(), { captureToolSchemas: true, onActive: h.bind });
        const added = rec.evidencePackagePath ? extractShapes(shapes, join(rec.evidencePackagePath, 'guard-capture.jsonl')) : 0;
        return { rec, calls: h.calls, added };
      },
      expect: 'NOT-READY',
    },
    {
      name: 'human-resolution',
      run: async () => {
        const h = humanResolutionBehaviors();
        const rec = await runP4Attempt(1, h.provider, L1_DIR, calibrationShapes(), {
          captureToolSchemas: true, onActive: h.bind,
          hooks: {
            // the scripted HUMAN OPERATOR resolves through the real
            // ResumeService — a calibration act, never a campaign policy
            humanDecisionResolution: () => ({
              selectedOptionId: 'include',
              rationale: 'L1 calibration leg: scripted human operator decision (the campaign itself never authors this resolution)',
              resolvedAt: new Date().toISOString(),
              resolvedBy: 'scripted-human-operator',
            }),
          },
        });
        const added = rec.evidencePackagePath ? extractShapes(shapes, join(rec.evidencePackagePath, 'guard-capture.jsonl')) : 0;
        return { rec, calls: h.calls, added };
      },
      expect: 'NOT-READY',
    },
  ];
  for (const leg of legs) {
    const { rec, calls, added } = await leg.run();
    writeFileSync(SHAPES_PATH, JSON.stringify(shapes, null, 2));
    const ok = rec.outcome === leg.expect && (leg.expect === 'READY' ? rec.assessment?.ready === true : true);
    report(`A.calibration.${leg.name}`, ok && (leg.expect === 'READY' ? added >= 0 : added > 0 || shapes['define-work/refine-definition'] !== undefined),
      `leg outcome=${rec.outcome} class=${rec.failureClass ?? ''} (expected ${leg.expect}); shapes now ${Object.keys(shapes).length}${calls.length ? `; scripted calls=${calls.length}` : ''}${ok ? '' : ` lastTeaching=${lastUserText(calls)}`}`);
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
  const r1 = rec2.assessment!.checks.R1_halted_state;
  const r1Concrete = r1.pass && r1.detail.includes('status=halted') && r1.detail.includes('pendingRefStep=confirm');
  const wires = [...new Set(h2.calls.map((x) => x.wire))].join(',');
  report('A.ready-path', allPass && r1Concrete,
    `READY under PINNED shapes; R1–R6 all pass; R1 asserts the ACTUAL state [${r1.detail.slice(0, 110)}]; scripted calls=${h2.calls.length} wires=[${wires}]`);
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

async function gateE2(shapes: PinnedShapes): Promise<void> {
  // REQUIRED-native-BUILD-input verification (review P1 #1): a required
  // upstream output that is MISSING on disk (storage row present) or
  // CORRUPTED (disk bytes != row hash) must fail readiness closed, naming
  // the path. Fault injection fires right after the scoping.checkpoint
  // RESOLVES (the approve itself READS the charter, so the fault must come
  // after it) and before design/plan/test — none of which rewrite the
  // charter — so the corruption survives to the boundary assessment.
  const legs: Array<{ name: string; mutate: () => void; expect: string }> = [
    { name: 'missing-artifact', mutate: () => rmSync(join(ROOT, 'docs', 'cycle-charter.md')), expect: 'disk-missing' },
    { name: 'corrupted-artifact', mutate: () => writeFileSync(join(ROOT, 'docs', 'cycle-charter.md'), 'CORRUPTED BY L1 GATE E2'), expect: 'hash-mismatch' },
  ];
  for (const leg of legs) {
    const h = happyBehaviors();
    const rec = await runP4Attempt(6, h.provider, L1_DIR, shapes, {
      onActive: h.bind,
      hooks: { onExecCheckpointResolved: async (cursor) => { if (cursor === 'scoping.checkpoint') leg.mutate(); } },
    });
    const r2 = rec.assessment?.checks.R2_definition_chain;
    const ok = rec.outcome === 'NOT-READY' && rec.failureClass === 'build-inputs-incomplete'
      && r2?.pass === false && (r2.detail ?? '').includes(`docs/cycle-charter.md:${leg.expect}`);
    report(`E2.${leg.name}`, ok, `outcome=${rec.outcome} class=${rec.failureClass} R2=${String(r2?.pass)} (${(r2?.detail ?? '').slice(0, 170)}) — the required-output verifier fails closed and names the artifact`);
  }
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
  const rec = await runP4Attempt(7, h.provider, L1_DIR, shapes, { onActive: h.bind });
  report('F1.budget-exhaustion-not-ready', rec.outcome === 'NOT-READY' && rec.failureClass === 'budget-exhaustion-upstream' && rec.evaluable === true,
    `outcome=${rec.outcome} class=${rec.failureClass} evaluable=${rec.evaluable} — genuine length terminus at the CORRECT budget = model-attributable NOT-READY, never a STOP`);
}

async function gateF2(shapes: PinnedShapes): Promise<void> {
  const h = humanRouteBehaviors();
  const rec = await runP4Attempt(8, h.provider, L1_DIR, shapes, { onActive: h.bind });
  const db = rec.evidencePackagePath ? (JSON.parse(readFileSync(join(rec.evidencePackagePath, 'db-records.json'), 'utf-8')) as { decisions?: Array<{ status: string }> }) : null;
  const pending = (db?.decisions ?? []).filter((x) => x.status === 'pending').length;
  report('F2.human-decision-pending', rec.outcome === 'NOT-READY' && rec.failureClass === 'definition-human-decision-required' && pending >= 1,
    `outcome=${rec.outcome} class=${rec.failureClass} pendingDecisions=${pending} — the semantic human question is NEVER synthetically approved`);
}

async function gateF3(shapes: PinnedShapes): Promise<void> {
  const h = exploreRouteBehaviors();
  const rec = await runP4Attempt(9, h.provider, L1_DIR, shapes, { onActive: h.bind });
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
  const rec = await runP4Attempt(10, h.provider, L1_DIR, shapes, { onActive: h.bind });
  const r2 = rec.assessment?.checks.R2_definition_chain;
  report('F4.authority-invalid', rec.outcome === 'NOT-READY' && r2?.pass === false,
    `outcome=${rec.outcome} class=${rec.failureClass ?? ''} R2=${String(r2?.pass)} (${(r2?.detail ?? '').slice(0, 140)}) — provenance/disk-integrity/admissibility fails closed`);
}

async function gateTAMPER(shapes: PinnedShapes): Promise<void> {
  // post-archive tamper test (review P1 #3): the full-package verifier must
  // (a) verify the pristine READY package and (b) detect a single flipped
  // byte in a tampered COPY (existing evidence is never modified)
  const h = happyBehaviors();
  const rec = await runP4Attempt(11, h.provider, L1_DIR, shapes, { onActive: h.bind });
  const pkg = rec.evidencePackagePath;
  if (!pkg || rec.outcome !== 'READY') {
    report('T.post-archive-tamper', false, `no READY package to test (outcome=${rec.outcome})`);
    return;
  }
  const pristine = verifyEvidencePackage(pkg);
  const tampon = '/tmp/opencode/p4-tamper-copy';
  rmSync(tampon, { recursive: true, force: true });
  cpSync(pkg, tampon, { recursive: true });
  appendFileSync(join(tampon, 'readiness-assessment.json'), ' ');
  const tampered = verifyEvidencePackage(tampon);
  rmSync(tampon, { recursive: true, force: true });
  const ok = pristine.ok && !tampered.ok && tampered.violations.some((v) => v.includes('readiness-assessment.json'));
  report('T.post-archive-tamper', ok,
    `pristine ok=${pristine.ok}; tampered copy detected=[${tampered.violations.slice(0, 2).join(' | ').slice(0, 120)}] — full-package hash binding (files.sha256.json + package identity) catches post-archive edits`);
}

async function gateAUTH(shapes: PinnedShapes): Promise<void> {
  // AUTHORITY-BYPASS (review P1 #4): an out-of-policy upstream disk write
  // (docs/rogue.md authored inside the design step) must STOP the campaign,
  // archive the violating bytes BEFORE worktree cleanup, and leave the
  // worktree pristine afterwards.
  const h = scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      if (step === 'design') {
        if (!existsSync(join(ROOT, 'docs', 'rogue.md'))) {
          writeFileSync(join(ROOT, 'docs', 'rogue.md'), '# out-of-policy write authored inside the design step (L1 gate AUTH)\n');
        }
        return mt({ text: archivedText('design.md'), tokens_used: 512 });
      }
      if (step === 'scoping.produce') return mt({ text: archivedText('scoping.produce.md'), tokens_used: 512 });
      if (step === 'plan') return mt({ text: archivedText('plan.md'), tokens_used: 512 });
      if (step === 'test') return mt({ text: archivedText('test.md'), tokens_used: 512 });
      return undefined;
    },
    structured: (step) => (step !== null && step.endsWith('readiness-review') ? READINESS_PASS() : undefined),
  });
  const rec = await runP4Attempt(12, h.provider, L1_DIR, shapes, { onActive: h.bind });
  const pkg = rec.evidencePackagePath;
  let violationArchived = false;
  let verdict = { ok: false, violations: ['no package'] as string[] };
  if (pkg) {
    const violationsFile = join(pkg, 'authority-violations.json');
    violationArchived = existsSync(violationsFile) && existsSync(join(pkg, 'authority-violations', 'docs', 'rogue.md'))
      && (JSON.parse(readFileSync(violationsFile, 'utf-8')) as Array<{ path: string }>).some((v) => v.path === 'docs/rogue.md');
    verdict = verifyEvidencePackage(pkg);
  }
  const ok = rec.outcome === 'STOPPED' && rec.failureClass === 'authority-bypass'
    && violationArchived && verdict.ok && targetPristine();
  report('AUTH.authority-bypass-stop', ok,
    `outcome=${rec.outcome} class=${rec.failureClass} rogueWriteArchived=${violationArchived} packageVerifies=${verdict.ok} worktreePristine=${targetPristine()} — out-of-policy write STOPs the campaign; violating bytes archived BEFORE cleanup`);
}

async function gateG(shapes: PinnedShapes): Promise<void> {
  const campaignDir = join(L1_DIR, 'gate-g-campaign');
  rmSync(campaignDir, { recursive: true, force: true });
  mkdirSync(campaignDir, { recursive: true });
  const { spawnSync } = await import('node:child_process');
  const childArgs = (mode: string) => [
    'tsx', `${EVIDENCE}/p4/p4-l1-resume-child.mts`,
    '--evidence-dir', campaignDir, '--attempts', '2', '--threshold', '2',
    ...(mode ? ['--' + mode] : []),
  ];
  // launch 1: REAL SIGKILL after slot 1 is COUNTED and slot 2 has launched
  // (crash DURING slot 2) — the child kills its own process at exactly that
  // ledger state; the parent observes the signal death
  const k = spawnSync('npx', childArgs('kill-after-counted'), { cwd: '/home/theo/Documents/coding/repos/stratum', encoding: 'utf-8', timeout: 420000 });
  const killed = k.status !== 0 || k.signal === 'SIGKILL';
  // capture slot 1's package identity BEFORE the resume
  const preLedger = readLedger(campaignDir);
  const slot1 = preLedger.find((e) => e.event === 'attempt-counted' && e.index === 1);
  const slot2Started = preLedger.some((e) => e.event === 'attempt-start' && e.index === 2);
  const slot2Counted = preLedger.some((e) => e.event === 'attempt-counted' && e.index === 2);
  let slot1Dir: string | null = null;
  let slot1Sha = slot1?.evidencePackageSha256 ?? null;
  if (slot1?.attemptId) {
    slot1Dir = join(campaignDir, `attempt-1-${slot1.attemptId}`);
    if (slot1Dir && existsSync(join(slot1Dir, 'manifest.json'))) {
      slot1Sha = (JSON.parse(readFileSync(join(slot1Dir, 'manifest.json'), 'utf-8')) as { package_sha256: string }).package_sha256;
    }
  }
  // launch 2: the RESUME — same campaign dir, fresh process
  const r = spawnSync('npx', childArgs(''), { cwd: '/home/theo/Documents/coding/repos/stratum', encoding: 'utf-8', timeout: 600000 });
  const ledger = readLedger(campaignDir);
  const counted = ledger.filter((e) => e.event === 'attempt-counted');
  const incomplete = ledger.filter((e) => e.event === 'attempt-incomplete');
  const countedIdx = counted.map((e) => e.index).sort();
  const slot1Once = counted.filter((e) => e.index === 1).length === 1;
  const slot1DirAfter = slot1?.attemptId ? join(campaignDir, `attempt-1-${slot1.attemptId}`) : null;
  const slot1ShaAfter = slot1DirAfter && existsSync(join(slot1DirAfter, 'manifest.json'))
    ? (JSON.parse(readFileSync(join(slot1DirAfter, 'manifest.json'), 'utf-8')) as { package_sha256: string }).package_sha256
    : null;
  const slot1Untouched = slot1Sha !== null && slot1ShaAfter === slot1Sha && slot1DirAfter !== null && verifyEvidencePackage(slot1DirAfter).ok;
  const terminalLine = (r.stdout.trim().split('\n').pop() ?? '').slice(0, 90);
  const resumedOk = terminalLine.includes('ready=2/2') && terminalLine.includes('threshold 2');
  const ok = killed && slot1 !== undefined && slot2Started && !slot2Counted
    && slot1Once && slot1Untouched
    && countedIdx.join(',') === '1,3' && incomplete.length >= 1 && resumedOk;
  report('G.kill-and-resume', ok,
    `killed=${killed} slot1Counted=${slot1 !== undefined} crashDuringSlot2=${slot2Started && !slot2Counted} countedIdx=[${countedIdx.join(',')}] slot1Once=${slot1Once} slot1Untouched=${slot1Untouched} incomplete=${incomplete.length} resumeTerminal="${terminalLine}" — the resume RECONSTRUCTED slot 1 from the ledger (no re-execution, no double-count) and completed the terminal condition`);
}

async function gateAUTH2(shapes: PinnedShapes): Promise<void> {
  // pre-freeze correction A: unauthorized REWRITES of already-dirty paths,
  // detected by before/after CONTENT identities. The design step (authorized
  // for docs/requirements.md + docs/architecture.md only) rewrites
  // docs/cycle-charter.md — a path that is ALREADY DIRTY (written by
  // scoping.produce, untracked). Note the engine's own role ceilings already
  // drop unauthorized doc sections (defense layer 1); this gate exercises the
  // campaign-level backstop at the provider boundary, where no section
  // machinery mediates the write.
  const h = scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      if (step === 'scoping.produce') return mt({ text: archivedText('scoping.produce.md'), tokens_used: 512 });
      if (step === 'design') {
        const charter = readFileSync(join(ROOT, 'docs', 'cycle-charter.md'), 'utf-8');
        writeFileSync(join(ROOT, 'docs', 'cycle-charter.md'), `${charter}\n<!-- unauthorized rewrite authored inside the design step (L1 gate AUTH2) -->\n`);
        return mt({ text: archivedText('design.md'), tokens_used: 512 });
      }
      if (step === 'plan') return mt({ text: archivedText('plan.md'), tokens_used: 512 });
      if (step === 'test') return mt({ text: archivedText('test.md'), tokens_used: 512 });
      return undefined;
    },
    structured: (step) => (step !== null && step.endsWith('readiness-review') ? READINESS_PASS() : undefined),
  });
  const rec = await runP4Attempt(13, h.provider, L1_DIR, shapes, { onActive: h.bind });
  const pkg = rec.evidencePackagePath;
  let reasonSaysRewrite = false;
  if (pkg && existsSync(join(pkg, 'authority-violations.json'))) {
    const v = JSON.parse(readFileSync(join(pkg, 'authority-violations.json'), 'utf-8')) as Array<{ path: string; reason: string }>;
    reasonSaysRewrite = v.some((x) => x.path === 'docs/cycle-charter.md' && x.reason.includes('unauthorized rewrite of already-dirty path'));
  }
  const ok = rec.outcome === 'STOPPED' && rec.failureClass === 'authority-bypass' && reasonSaysRewrite && targetPristine();
  report('AUTH2.dirty-rewrite-stop', ok,
    `outcome=${rec.outcome} class=${rec.failureClass} rewriteNamed=${reasonSaysRewrite} worktreePristine=${targetPristine()} — a rewrite of an ALREADY-DIRTY path by an unauthorized step is detected via before/after content identities (campaign backstop; the engine's role ceilings are the first layer)`);
}

async function gateAUTHEXC(shapes: PinnedShapes): Promise<void> {
  // pre-freeze correction A (exception path): the out-of-policy write happens
  // and THEN the step throws — the authority check must still record the
  // violations and the campaign must still STOP and archive them.
  const h = scriptedProvider({
    multiTurn: (step) => {
      if (step === 'synthesize-definition') return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
      if (step === 'scoping.produce') return mt({ text: archivedText('scoping.produce.md'), tokens_used: 512 });
      if (step === 'design') {
        writeFileSync(join(ROOT, 'docs', 'rogue-exc.md'), 'out-of-policy write immediately followed by a step exception (L1 gate AUTH-EXC)\n');
        throw new Error('scripted step exception AFTER the out-of-policy write (L1 gate AUTH-EXC)');
      }
      return undefined;
    },
    structured: (step) => (step !== null && step.endsWith('readiness-review') ? READINESS_PASS() : undefined),
  });
  const rec = await runP4Attempt(14, h.provider, L1_DIR, shapes, { onActive: h.bind });
  const pkg = rec.evidencePackagePath;
  const archived = pkg !== null && existsSync(join(pkg, 'authority-violations', 'docs', 'rogue-exc.md'));
  const ok = rec.outcome === 'STOPPED' && rec.failureClass === 'authority-bypass' && archived && targetPristine();
  report('AUTHEXC.exception-path-stop', ok,
    `outcome=${rec.outcome} class=${rec.failureClass} violatingBytesArchived=${archived} worktreePristine=${targetPristine()} — the authority check runs on the EXCEPTION path too (write-then-throw is still a STOP)`);
}

async function gateG2(): Promise<void> {
  // pre-freeze correction C: retained counted-slot package identities are
  // verified and CONFLICTING ledger counts are rejected during recovery
  // (fail closed — the resume never launches on disputed evidence).
  const srcDir = join(L1_DIR, 'gate-g-campaign');
  const fixture = join(L1_DIR, 'gate-g2-fixture');
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  cpSync(srcDir, fixture, { recursive: true });
  const { reconstructCountedSlots } = await import('./p4-campaign.mts');
  const baseline = reconstructCountedSlots(fixture);
  const baselineClean = baseline.conflicts.length === 0 && baseline.attempts.length >= 1;
  // (a) tamper a RETAINED package -> identity verification must reject
  const retained = baseline.attempts[0];
  const pkgDir = join(fixture, `attempt-${retained.index}-${retained.attemptId}`);
  appendFileSync(join(pkgDir, 'readiness-assessment.json'), ' ');
  const tampered = reconstructCountedSlots(fixture);
  rmSync(join(pkgDir, 'readiness-assessment.json'));
  cpSync(join(srcDir, `attempt-${retained.index}-${retained.attemptId}`, 'readiness-assessment.json'), join(pkgDir, 'readiness-assessment.json'));
  const tamperRejected = tampered.conflicts.length > 0 && tampered.conflicts.some((c) => c.includes('does not verify') || c.includes('identity'));
  // (b) duplicate counted slot -> conflicting ledger counts must reject
  appendFileSync(join(fixture, 'campaign-ledger.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), event: 'attempt-counted', attemptId: 'duplicate-slot-entry', index: retained.index, outcome: 'READY', evaluable: true, evidencePackageSha256: retained.evidencePackageSha256 })}\n`);
  const duplicated = reconstructCountedSlots(fixture);
  const duplicateRejected = duplicated.conflicts.some((c) => c.includes('counted twice'));
  // (c) a counted slot whose ledger entry carries NO package identity —
  // reconstruction requires a non-null, matching evidencePackageSha256
  // (a retained manifest exists, so the slot WOULD otherwise reconstruct)
  appendFileSync(join(fixture, 'campaign-ledger.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), event: 'attempt-counted', attemptId: 'sha-less-slot', index: 9, outcome: 'READY', evaluable: true, evidencePackageSha256: null })}\n`);
  mkdirSync(join(fixture, 'attempt-9-sha-less-slot'), { recursive: true });
  writeFileSync(join(fixture, 'attempt-9-sha-less-slot', 'manifest.json'), JSON.stringify({ package_sha256: 'deadbeefdeadbeef' }));
  const shaless = reconstructCountedSlots(fixture);
  const shalessRejected = shaless.conflicts.some((c) => c.includes('no evidencePackageSha256'));
  report('G2.ledger-conflict-rejection', baselineClean && tamperRejected && duplicateRejected && shalessRejected,
    `baselineConflicts=${baseline.conflicts.length} tamperRejected=${tamperRejected} duplicateRejected=${duplicateRejected} shalessRejected=${shalessRejected} — every reconstructed counted slot requires a non-null, verifiable package identity; conflicting counts fail closed`);
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
  console.log('=== P4 L1 qualification r3b (offline; zero network traffic) ===');
  gateH();
  const shapes = await gateA();
  if (results.find((r) => r.gate === 'A.ready-path')?.pass) {
    await gateB(shapes);
    await gateC(shapes);
    await gateC2();
    await gateD(shapes);
    await gateE2(shapes);
    await gateF1(shapes);
    await gateF2(shapes);
    await gateF3(shapes);
    await gateF4(shapes);
    await gateTAMPER(shapes);
    await gateAUTH(shapes);
    await gateAUTH2(shapes);
    await gateAUTHEXC(shapes);
    await gateG(shapes);
    await gateG2();
  } else {
    console.log('Gate A failed — remaining gates skipped (fix the READY path first).');
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`=== L1 r3b: ${passed}/${results.length} gates passed ===`);
  writeFileSync(`${EVIDENCE}/p4/p4-l1-qualification-output-r3b.txt`, JSON.stringify({ finished_at_utc: new Date().toISOString(), results }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => { console.error('L1 fatal:', e); process.exit(1); });
