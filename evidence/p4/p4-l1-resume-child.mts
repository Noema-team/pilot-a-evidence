// P4 L1 gate-G child: runs the campaign in its OWN process so the parent can
// SIGKILL it at a precise ledger state (a REAL process death). Modes:
//   default          — run the campaign to its terminal condition
//   --kill-after-counted — run the campaign; this process polls the SHARED
//                      ledger and SIGKILLs itself once slot 1 is counted AND
//                      slot 2 has launched (crash DURING slot 2; slot 2's
//                      first model call is deliberately slowed so the kill
//                      lands mid-flight, not after completion)
// The parent then invokes a resume child (default mode) on the SAME evidence
// dir: the resume must reconstruct slot 1 from the ledger (never re-execute,
// never double-count) and complete the terminal condition.
import { runP4Campaign } from './p4-campaign.mts';
import { loadPinnedShapes } from './p4-step-contracts.mts';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const has = (name: string): boolean => args.includes(name);
const EVIDENCE = flag('--evidence-dir') ?? '/home/theo/Documents/coding/repos/pilot-a/evidence/p4/l1-qualification-r2/gate-g-campaign';
const SHAPES = flag('--shapes') ?? '/home/theo/Documents/coding/repos/pilot-a/evidence/p4/p4-step-shapes.json';
const ATTEMPTS = Number(flag('--attempts') ?? '2');
const THRESHOLD = Number(flag('--threshold') ?? '2');

// archived P1-R upstream outputs (published under the same frozen code)
const p1rRun = '/home/theo/Documents/coding/repos/pilot-a/evidence/p1-r/p1-r-1/91342881-eb32-47ff-8dfb-d8a7115dd371/node-outputs';
const archivedText = (name: string): string => readFileSync(`${p1rRun}/${name}`, 'utf-8');

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
  nonGoals: ['Reworking the worker indexing pipeline.', 'Changing the upstream vector-store integration.'],
  acceptance: [{ description: 'A handled failure returns JSON whose body parses and carries a non-empty machine-readable failure class field.' }],
  bodyMarkdown: '# Definition — Worker failure-payload contract\n\nThe bounded scope is the RAG worker service failure responses.',
});
const READINESS_PASS = () => ({ verdict: 'pass', gaps: [], bodyMarkdown: 'All seven readiness dimensions pass for the candidate bounded scope. (L1 scripted review.)' });
const mt = (over: Record<string, unknown>) => ({
  stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 64,
  wire_observation: { finish_reason: 'stop' }, ...over,
});
const submitToolUse = (value: unknown) => [{ name: 'submit_result', id: 'scu_1', input: value }];

let liveRef: { stepId: string | null } | null = null; // the driver's LIVE step view (read at call time)

// the provider for launch N: launch 2+ slows its FIRST multi-turn call by
// ~4s so the SIGKILL (fired once slot 2 has launched) reliably lands
// MID-FLIGHT inside slot 2 — a genuine crash-during-slot-2
const makeProvider = (launchIndex: number) => ({
  async completeMultiTurn(params: Record<string, unknown>) {
    const step = liveRef?.stepId ?? null;
    if (launchIndex >= 2 && step === 'synthesize-definition') {
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (step === 'synthesize-definition' || step === 'refine-definition') {
      return mt({ stop_reason: 'tool_use', text: '', tool_uses: submitToolUse(DEFINITION_VALUE()), wire_observation: { finish_reason: 'tool_calls' } });
    }
    if (step === 'scoping.produce') return mt({ text: archivedText('scoping.produce.md'), tokens_used: 512 });
    if (step === 'design') return mt({ text: archivedText('design.md'), tokens_used: 512 });
    if (step === 'plan') return mt({ text: archivedText('plan.md'), tokens_used: 512 });
    if (step === 'test') return mt({ text: archivedText('test.md'), tokens_used: 512 });
    throw new Error(`child scripted gap: no multiTurn behavior for step=${step}`);
  },
  async complete() { return { content: JSON.stringify({ blocking_issues: [], warnings: [], suggestions: [], pass: true }), tokens_used: 64, duration_ms: 1 }; },
  async completeStructured(params: Record<string, unknown>) {
    void params;
    return { value: READINESS_PASS(), tokens_used: 64, duration_ms: 1 };
  },
});

// kill-after-counted mode: poll the SHARED ledger; once slot 1 is COUNTED and
// slot 2 has LAUNCHED, wait briefly (mid-flight) and SIGKILL this process —
// a REAL process death at exactly the state the §10 resume must reconstruct
if (has('--kill-after-counted')) {
  const timer = setInterval(() => {
    try {
      const p = `${EVIDENCE}/campaign-ledger.jsonl`;
      const entries = readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { event: string; index?: number });
      const counted1 = entries.some((e) => e.event === 'attempt-counted' && e.index === 1);
      const started2 = entries.some((e) => e.event === 'attempt-start' && e.index === 2);
      if (counted1 && started2) {
        clearInterval(timer);
        setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1500);
      }
    } catch { /* ledger not written yet — poll again */ }
  }, 200);
}

const res = await runP4Campaign({
  evidenceDir: EVIDENCE,
  shapes: loadPinnedShapes(SHAPES),
  innerProviderFactory: (index) => makeProvider(index),
  maxAttempts: ATTEMPTS,
  readyThreshold: THRESHOLD,
  onActive: (a) => { liveRef = a; }, // LIVE reference — read at call time
});
console.log(`child terminal: ${res.terminal}`);
