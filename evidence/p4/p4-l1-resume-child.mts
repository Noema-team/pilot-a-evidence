// P4 L1 GATE-G CHILD — a campaign process that can be SIGKILLed mid-attempt.
// Run by p4-l1-qualifier gate G: the first child kills itself at the Nth
// provider call (a real process death — the §10 scenario); the parent then
// relaunches it WITHOUT the kill to verify ledger-driven resume.
//
// Usage: npx tsx evidence/p4/p4-l1-resume-child.mts --evidence-dir <dir> \
//         --kill-at <N|0> --attempts <n> --threshold <t>

import { readFileSync } from 'node:fs';
import { runP4Campaign } from './p4-campaign.mts';
import { loadPinnedShapes } from './p4-step-contracts.mts';

const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : '';
};

const evidenceDir = arg('evidence-dir');
const killAt = parseInt(arg('kill-at') || '0', 10);
const attempts = parseInt(arg('attempts') || '2', 10);
const threshold = parseInt(arg('threshold') || '2', 10);
const shapes = loadPinnedShapes(`${EVIDENCE}/p4/p4-step-shapes.json`);

// minimal happy-path scripted provider (same shape semantics as the
// qualifier's factory; duplicated here so the child is self-contained)
const mt = (over: Record<string, unknown>) => ({
  stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 64,
  wire_observation: { finish_reason: 'stop' }, ...over,
});
const archivedText = (name: string): string =>
  readFileSync(`${EVIDENCE}/p1-r/p1-r-1/91342881-eb32-47ff-8dfb-d8a7115dd371/node-outputs/${name}`, 'utf-8');
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
  bodyMarkdown: '# Definition\n\nBounded scope: the RAG worker service failure responses.',
});

let calls = 0;
// holds the LIVE active-step object reference (read lazily at call time)
let activeRef: { stepId: string | null } | null = null;
function makeProvider(): unknown {
  return {
    async completeMultiTurn(params: Record<string, unknown>) {
      calls++;
      if (killAt > 0 && calls >= killAt) {
        process.kill(process.pid, 'SIGKILL'); // real process death, no cleanup
      }
      const activeStep = activeRef?.stepId ?? null;
      if (activeStep === 'synthesize-definition') return mt({ stop_reason: 'tool_use', text: '', tool_uses: [{ name: 'submit_result', id: 'x', input: DEFINITION_VALUE() }], wire_observation: { finish_reason: 'tool_calls' } });
      if (activeStep === 'scoping.produce') return mt({ text: archivedText('scoping.produce.md'), tokens_used: 512 });
      if (activeStep === 'design') return mt({ text: archivedText('design.md'), tokens_used: 512 });
      if (activeStep === 'plan') return mt({ text: archivedText('plan.md'), tokens_used: 512 });
      if (activeStep === 'test') return mt({ text: archivedText('test.md'), tokens_used: 512 });
      throw new Error(`resume-child: no multiTurn behavior for step=${activeStep}`);
    },
    async complete() { return { content: '{"blocking_issues":[],"warnings":[],"suggestions":[],"pass":true}', tokens_used: 64, duration_ms: 1 }; },
    async completeStructured() { return { value: { verdict: 'pass', gaps: [], bodyMarkdown: 'All seven readiness dimensions pass. (resume-child scripted review.)' }, tokens_used: 64, duration_ms: 1 }; },
  };
}

const res = await runP4Campaign({
  evidenceDir,
  shapes,
  innerProviderFactory: () => makeProvider(),
  maxAttempts: attempts,
  readyThreshold: threshold,
  onActive: (a) => { activeRef = a; },
});
console.log('child terminal:', res.terminal);
