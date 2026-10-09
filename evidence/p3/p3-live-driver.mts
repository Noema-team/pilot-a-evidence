// P3 LIVE-DRIVER COMPOSITION — the single composition the live campaign
// driver imports. Frozen at binding time so the pre-execution qualification
// proves the EXACT guard/stopping behavior that live attempts will run
// under (operator directive: "prove that the actual campaign driver applies
// the approved guard and stopping behavior").
//
// The composition is deliberately thin — it only wires approved components:
//   provider  : the REAL provider resolved by Stratum from the fixture's
//               frozen settings (5634b2e8) — never constructed ad hoc
//   guard     : config-guard v3 (request-time contract enforcement,
//               response/wire_observation capture, blocked completion
//               paths, classify/reconcile) wrapping that provider
//   boundary  : the positive publication-boundary runner (refuses every
//               step dispatch after BUILD completes)
//   recognition: mapCaptureToStop — the campaign-loop G1/G2 decision
//
// NO live dialing happens anywhere in this module at import or composition
// time; the only forwarding path is the guard-verified completeMultiTurn.

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowEngineDeps } from '/home/theo/Documents/coding/repos/stratum/src/workflow/engine.js';
import type { StepRunner, StepRunContext, StepRunOutcome } from '/home/theo/Documents/coding/repos/stratum/src/workflow/types.js';
import { resolveLLMProvider } from '/home/theo/Documents/coding/repos/stratum/src/application.js';
import {
  createConfigGuardProvider, classifyGuardCapture,
  type StepContract, type CaptureClassification,
} from './config-guard.mts';

// ─── frozen model regime (identical to P1-R/P2; approved in the P3 prereg) ──
export const P3_MODEL_REGIME = {
  provider: 'openrouter',
  model: 'z-ai/glm-5.3-flash',
  base_url: 'https://openrouter.ai/api/v1',
  settings_sha256: '5634b2e897eeb56467deae26da0dd9146c36dc192a61ded23196ee21b55925a2',
  build: { max_tokens: 32768, reasoning_effort: 'low', temperature: 0.7 },
} as const;

export const P3_TARGET = {
  head: '86ec0871d64ecca8732434c11d015fd8e08ddc7e',
  worker_main_sha256: '7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988',
  worker_main_path: 'apps/ai-server/rag-worker-service/main.py',
} as const;

// ─── frozen BUILD contract (the guard's per-request expectation) ────────────
export function buildContract(model: string = P3_MODEL_REGIME.model): StepContract {
  return {
    stepId: 'build',
    model,
    max_tokens: P3_MODEL_REGIME.build.max_tokens,
    reasoning_effort: P3_MODEL_REGIME.build.reasoning_effort,
    temperature: P3_MODEL_REGIME.build.temperature,
    tool_sets: [
      ['read_file', 'read_source_slice', 'list_directory', 'submit_result'],
      ['submit_result'],
    ],
    submit_result: {
      schema_top_level_properties: ['edits'],
      schema_required: ['edits'],
      has_creates_property: false,
      teaching_has_edits_line: true,
      teaching_has_creates_line: false,
    },
  };
}

// pre-launch capability probe contract (used at GO time only, ONE tiny
// completion): model/effort/temperature as frozen, minimal budget, no tools.
// Dialing it is NOT part of freeze preparation (no model traffic).
export function preflightContract(model: string = P3_MODEL_REGIME.model): StepContract {
  return {
    stepId: 'preflight',
    model,
    max_tokens: 16,
    reasoning_effort: P3_MODEL_REGIME.build.reasoning_effort,
    temperature: P3_MODEL_REGIME.build.temperature,
    tool_sets: [[]],
    submit_result: null,
  };
}

// ─── campaign-loop recognition (G1/G2) ──────────────────────────────────────
export type CampaignStop = 'G1' | 'G2' | null;

export function mapCaptureToStop(cls: CaptureClassification): CampaignStop {
  if (cls.g2) return 'G2';
  if (cls.g1) return 'G1';
  return null;
}

export function classifyAttempt(capturePath: string): { cls: CaptureClassification; stop: CampaignStop } {
  const cls = classifyGuardCapture(capturePath);
  return { cls, stop: mapCaptureToStop(cls) };
}

// ─── attempt composition (REAL provider under the guard) ────────────────────
export interface ComposedBuildAttempt {
  attemptId: string;
  capturePath: string;
  model: string;
  // the guard-wrapped REAL provider — pass to buildAgentRunner exactly as
  // the qualified dry run did
  provider: unknown;
  classifyAttempt: () => { cls: CaptureClassification; stop: CampaignStop };
}

export function composeBuildAttempt(projectRoot: string, attemptId: string = randomUUID()): ComposedBuildAttempt {
  const { provider, model } = resolveLLMProvider(projectRoot);
  if (model !== P3_MODEL_REGIME.model) {
    throw new Error(`p3-live-driver: resolved model ${model} != frozen ${P3_MODEL_REGIME.model}`);
  }
  const capturePath = join(projectRoot, '.sle', 'p3-captures', attemptId, 'build-attempt-guard.jsonl');
  const guarded = createConfigGuardProvider(provider, () => buildContract(model), {
    capturePath,
    phase: `build-attempt:${attemptId}`,
    settingsPath: join(projectRoot, '.sle', 'settings.json'),
    expectedSettingsSha256: P3_MODEL_REGIME.settings_sha256,
  });
  return {
    attemptId,
    capturePath,
    model,
    provider: guarded,
    classifyAttempt: () => classifyAttempt(capturePath),
  };
}

// ─── positive publication boundary (the exact qualified behavior) ───────────
export const PUBLICATION_BOUNDARY_SENTINEL =
  'P3 publication boundary: workflow halted after BUILD publication (positive stop; downstream execution is not part of the P3 scope)';

export interface BoundaryHooks {
  onPublished?: () => void;
  onRefusal?: (stepId: string) => void;
}

// wraps the harness step runner; after BUILD completes, EVERY subsequent
// dispatch (run/handleExecute/handleCommit) is refused BEFORE any execution
export function publicationBoundaryRunner(
  inner: StepRunner & {
    handleExecute?: (step: never, ctx: never) => Promise<unknown>;
    handleCommit?: (step: never, ctx: never) => Promise<unknown>;
    handleCheckpoint?: (step: never, ctx: never) => Promise<unknown>;
    resolveCheckpoint?: (input: never) => Promise<unknown>;
  },
  hooks: BoundaryHooks = {},
) {
  let published = false;
  const isBuildComplete = (r: unknown) => {
    const x = r as { success?: boolean; outcome?: string };
    return x.success === true || x.outcome === 'completed';
  };
  const refusal = (stepId: string) => {
    hooks.onRefusal?.(stepId);
    return {
      success: false, outcome: 'failed', error: PUBLICATION_BOUNDARY_SENTINEL,
      artifacts_written: [], tokens_used: 0, duration_ms: 0,
    } as unknown as StepRunOutcome;
  };
  return {
    get published() { return published; },
    run: async (step: { id: string }, ctx: StepRunContext): Promise<StepRunOutcome> => {
      if (published) return refusal(step.id);
      const r = await inner.run(step as never, ctx as never);
      if (step.id === 'build' && isBuildComplete(r)) {
        published = true;
        hooks.onPublished?.();
      }
      return r as StepRunOutcome;
    },
    handleExecute: async (step: { id: string }, ctx: StepRunContext) => {
      if (published) return refusal(step.id);
      return inner.handleExecute ? inner.handleExecute(step as never, ctx as never) : undefined;
    },
    handleCommit: async (step: { id: string }, ctx: StepRunContext) => {
      if (published) return refusal(step.id);
      return inner.handleCommit ? inner.handleCommit(step as never, ctx as never) : undefined;
    },
    handleCheckpoint: async (step: { id: string }, ctx: StepRunContext) =>
      inner.handleCheckpoint ? inner.handleCheckpoint(step as never, ctx as never) : undefined,
    resolveCheckpoint: (input: unknown) =>
      inner.resolveCheckpoint ? inner.resolveCheckpoint(input as never) : undefined,
  };
}

// re-export for the driver's engineDeps wiring
export type { WorkflowEngineDeps };
