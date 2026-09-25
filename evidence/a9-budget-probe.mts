// A6 Gate A safeguard — EFFECTIVE budget proof, per operator review:
// the settings must be on disk BEFORE runner construction (driver's exact
// order: resolveLLMProvider(ROOT) then 8-arg buildAgentRunner), and the
// probe must show the wire budget for synthesize-definition is 32768 —
// not merely that the JSON entry exists.
import { resolveLLMProvider, buildAgentRunner } from '/home/theo/Documents/repos/pilot-a/stratum/src/application.js';
import { ContextManager } from '/home/theo/Documents/repos/pilot-a/stratum/src/context-manager.js';
import { RunArtifactManager } from '/home/theo/Documents/repos/pilot-a/stratum/src/run-artifacts.js';

const ROOT = '/home/theo/Documents/repos/pilot-a/student-platform';

// Capturing provider: records the max_tokens actually placed on each
// generation request; returns a terminal end_turn so the run closes.
const calls: Array<{ max_tokens: unknown; model: unknown }> = [];
const provider = {
  async complete() { throw new Error('probe: single-turn path not expected'); },
  async completeMultiTurn(params: any) {
    calls.push({ max_tokens: params.max_tokens, model: params.model });
    return { stop_reason: 'end_turn', text: '', tool_uses: [], tokens_used: 1 };
  },
} as never;

// EXACTLY the driver's resolution + construction order, with only the
// provider swapped for the capturing stub:
const { provider: _real, model, maxTokens } = resolveLLMProvider(ROOT);
console.log('resolveLLMProvider(ROOT):', JSON.stringify({ model, globalMaxTokens: maxTokens }));
const contextManager = new ContextManager(ROOT);
const runner = buildAgentRunner(
  contextManager, provider, ROOT,
  new RunArtifactManager({ projectRoot: ROOT }),
  model, undefined as never, maxTokens, undefined,
);

function ctx(workflowId: string, stepId: string) {
  return {
    workflowRunId: 'probe', workflowId, stepId,
    iteration: 1, revision: 0, goal: 'gate-a-budget-probe', projectRoot: ROOT, role: 'explorer',
    outputArtifact: { type: 'definition', ref: 'definition:{objectiveId}', path: '.sle/work/probe/definition.md' },
  } as never;
}

for (const [wf, step, expect] of [
  ['define-work', 'synthesize-definition', 32768],
  ['define-work', 'definition-readiness-review', 16384],
  ['define-work', 'refine-definition', 16384],
  ['full-build', 'scoping.produce', 16384],
  ['full-build', 'build', 16384],
] as const) {
  calls.length = 0;
  await runner.run('explorer' as never, ctx(wf, step));
  const budgets = calls.map((c) => c.max_tokens);
  const ok = budgets.length > 0 && budgets.every((b) => b === expect);
  console.log(`${wf}/${step}: wire budgets=${JSON.stringify(budgets)} expected=${expect} -> ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}
