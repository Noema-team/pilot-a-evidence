// P4 STEP CONTRACTS — fail-closed derivation of per-step guard contracts from
// the FROZEN settings bytes (the anti-P2 invariant: the expected budget/effort
// is computed from the frozen file at EVERY request, never from memory), plus
// the pinned per-step request-shape table calibrated by L1.
//
// Mirrors the engine's own lookup discipline (agent-runner.ts
// resolveWorkflowBudgetOverridesFromSettings / completionBudgetFor:
// budget = workflow_max_tokens["workflowId/stepId"] ?? global max_tokens;
// effort = workflow_reasoning_effort["workflowId/stepId"] ?? absent) but is
// STRICTER than the engine by design: the engine silently discards a malformed
// map (legacy behavior), while the campaign REFUSES to run under a frozen file
// it cannot parse — a silent downgrade is exactly the P2 defect class.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { P4StepContract, P4Wire } from './p4-transport-guard.mts';

export interface FrozenSettings {
  model: string;
  temperature: number;
  globalMaxTokens: number;
  settingsSha256: string;
  budgetFor: (workflowId: string, stepId: string) => number;
  effortFor: (workflowId: string, stepId: string) => string | undefined;
}

export const FROZEN_SETTINGS_PATH = '/home/theo/Documents/coding/repos/pilot-a/evidence/v11-frozen-config/settings.json';
export const FROZEN_SETTINGS_SHA256 = '5634b2e897eeb56467deae26da0dd9146c36dc192a61ded23196ee21b55925a2';
export const FROZEN_TEMPERATURE = 0.7;

export function loadFrozenSettings(path: string = FROZEN_SETTINGS_PATH, expectedSha: string = FROZEN_SETTINGS_SHA256): FrozenSettings {
  const bytes = readFileSync(path);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== expectedSha) throw new Error(`p4-step-contracts: frozen settings sha ${sha} != pinned ${expectedSha}`);
  const raw = JSON.parse(bytes.toString('utf-8')) as {
    model: string; max_tokens: number;
    workflow_max_tokens?: Record<string, number>;
    workflow_reasoning_effort?: Record<string, string>;
  };
  const validateMap = <T>(m: Record<string, T> | undefined, ok: (v: T) => boolean, what: string): Record<string, T> => {
    if (m === undefined) return {};
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(m)) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(k)) throw new Error(`p4-step-contracts: ${what} key "${k}" is not workflowId/stepId`);
      if (!ok(v)) throw new Error(`p4-step-contracts: ${what} entry "${k}" has an invalid value`);
      out[k] = v;
    }
    return out;
  };
  const budgets = validateMap(raw.workflow_max_tokens, (v) => typeof v === 'number' && Number.isInteger(v) && v > 0, 'workflow_max_tokens');
  const efforts = validateMap(raw.workflow_reasoning_effort, (v) => ['minimal', 'low', 'medium', 'high', 'max', 'xhigh'].includes(v), 'workflow_reasoning_effort');
  return {
    model: raw.model,
    temperature: FROZEN_TEMPERATURE,
    globalMaxTokens: raw.max_tokens,
    settingsSha256: sha,
    budgetFor: (wf, step) => budgets[`${wf}/${step}`] ?? raw.max_tokens,
    effortFor: (wf, step) => efforts[`${wf}/${step}`],
  };
}

// ─── pinned per-step request shapes (L1-calibrated) ──────────────────────────
// tool_sets / submit surface / structured schema name per (workflowId, stepId),
// as OBSERVED on the real production path with scripted providers and pinned
// for campaign use. A request whose step is absent from the table fails closed
// (G1) — the campaign never dials an unpinned step.

export interface PinnedStepShape {
  tool_sets: Array<readonly string[]>;
  submit_result: P4StepContract['submit_result'];
  structured_schema_name?: string;
}

export type PinnedShapes = Record<string, PinnedStepShape>;

export const INVESTIGATION_TOOLS = ['read_file', 'read_source_slice', 'list_directory'] as const;

// L1 defaults (P1-R precedent for full-build legacy produce steps); the L1
// qualifier validates every shape against the real engine and re-pins
// evidence/p4/p4-step-shapes.json — the pinned file is authoritative.
export const DEFAULT_SHAPES: PinnedShapes = {
  'full-build/scoping.produce': { tool_sets: [INVESTIGATION_TOOLS], submit_result: null },
  'full-build/design': { tool_sets: [INVESTIGATION_TOOLS], submit_result: null },
  'full-build/critique': { tool_sets: [[]], submit_result: null },
  'full-build/plan': { tool_sets: [INVESTIGATION_TOOLS], submit_result: null },
  'full-build/test': { tool_sets: [INVESTIGATION_TOOLS], submit_result: null },
};

export function loadPinnedShapes(path: string): PinnedShapes {
  return JSON.parse(readFileSync(path, 'utf-8')) as PinnedShapes;
}

// L1 calibration mode: a shapes map that yields an unpinned-tools contract for
// ANY key (frozen model/budget/effort/temperature still enforced; everything
// still recorded). Never used by the campaign path.
export function calibrationShapes(): PinnedShapes {
  return new Proxy({} as PinnedShapes, {
    get(_t, key: string) {
      return { __calibration: true, tool_sets: [[]], submit_result: null };
    },
    has() { return true; },
  }) as PinnedShapes;
}

export function isCalibrationShape(s: PinnedStepShape | undefined): boolean {
  return s !== undefined && (s as PinnedStepShape & { __calibration?: boolean }).__calibration === true;
}

// Build the contract resolver handed to the guard: the driver keeps
// `active` pointed at the workflow step currently executing (updated from the
// run repository before each scheduler tick); unknown steps fail closed.
export function makeContractResolver(
  frozen: FrozenSettings,
  shapes: PinnedShapes,
  active: { workflowId: string | null; stepId: string | null },
): (wire: P4Wire) => P4StepContract {
  return (wire: P4Wire): P4StepContract => {
    const wf = active.workflowId;
    const step = active.stepId;
    if (!wf || !step) throw new Error(`p4-step-contracts: no active step resolved for an incoming ${wire} call (fail closed)`);
    const shape = shapes[`${wf}/${step}`];
    const calibrating = isCalibrationShape(shape);
    const isMultiTurn = wire === 'completeMultiTurn';
    const isStructured = wire === 'completeStructured';
    if (isMultiTurn && !shape) throw new Error(`p4-step-contracts: no pinned shape for ${wf}/${step} (fail closed — unpinned step reached the multi-turn wire)`);
    if (isStructured && !shape && !calibrating) {
      // structured reviews must also be pinned (schema name); calibration mode
      // permits the observation pass
      throw new Error(`p4-step-contracts: no pinned shape for ${wf}/${step} (fail closed — unpinned step reached the structured wire)`);
    }
    const contract: P4StepContract = {
      stepId: step,
      workflowId: wf,
      model: frozen.model,
      max_tokens: frozen.budgetFor(wf, step),
      temperature: frozen.temperature,
      tool_sets: isMultiTurn ? (shape?.tool_sets ?? [[]]) : [[]],
      submit_result: isMultiTurn ? (shape?.submit_result ?? null) : null,
      structured_schema_name: isStructured ? shape?.structured_schema_name : undefined,
    };
    if (calibrating) contract.unpinned_tools = true;
    const effort = frozen.effortFor(wf, step);
    if (effort !== undefined && !isMultiTurn) {
      // the frozen map must only declare effort for multi-turn steps; the
      // engine itself fails closed on a single-turn override (agent-runner)
      throw new Error(`p4-step-contracts: frozen effort override on single-turn step ${wf}/${step} — campaign refuses (engine would fail closed)`);
    }
    if (effort !== undefined) contract.reasoning_effort = effort;
    return contract;
  };
}
