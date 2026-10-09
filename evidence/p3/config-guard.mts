// P3 CONFIG GUARD — request-time verification of the EFFECTIVE execution
// configuration (P2 forensic lesson 1 + 3: a settings-file hash checked
// before instantiation is insufficient; the invariant is what reaches the
// provider request).
//
// Wraps an ILLMProvider and, on EVERY completeMultiTurn call, verifies the
// outbound parameters against a frozen per-step contract BEFORE forwarding:
//   model, max_tokens, reasoning.effort (presence AND value), temperature,
//   the tool-name set (investigation vs synthesis shapes), and the
//   submit_result surface (narrowed schema: edits-only, no creates) with its
//   teaching markers.
// Any mismatch throws 'config-guard: STOP — ...' and the model call is NEVER
// made. Verified requests are appended to a capture JSONL (wire-capture v3
// record shape + guard verdict) so request-side compliance is archived, not
// merely enforced.
//
// Campaign tooling only — Stratum src/ stays frozen.

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface GuardToolContract {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface StepContract {
  stepId: string;
  model: string;
  max_tokens: number;
  reasoning_effort?: string;
  temperature: number;
  // tool-name sets the loop may offer on this step: investigation turns and,
  // when a synthesis gate is declared, synthesis turns. A request whose tool
  // set matches NEITHER is a violation.
  tool_sets: Array<readonly string[]>;
  // submit_result surface expectation; null = the step must NOT offer a
  // submission tool at all (legacy produce steps).
  submit_result: null | {
    schema_top_level_properties: readonly string[];
    schema_required: readonly string[];
    has_creates_property: false;
    teaching_has_edits_line: boolean;
    teaching_has_creates_line: boolean;
  };
}

export interface GuardDeps {
  // request records land here (JSONL, wire-capture record shape + guard data)
  capturePath: string;
  // invoked when construction-time settings verification runs
  settingsPath?: string;
  expectedSettingsSha256?: string;
}

export interface MultiTurnParamsLike {
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  max_tokens: number;
  temperature?: number;
  reasoning_effort?: string;
  tools: ReadonlyArray<GuardToolContract>;
}

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

export class ConfigGuardViolation extends Error {
  constructor(public dimension: string, message: string) {
    super(`config-guard: STOP — ${dimension}: ${message}`);
    this.name = 'ConfigGuardViolation';
  }
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(v, Object.keys(v as object).sort());
}

export function verifySettingsProvenance(settingsPath: string, expectedSha256: string): void {
  if (!existsSync(settingsPath)) {
    throw new ConfigGuardViolation('settings', `settings file missing at ${settingsPath}`);
  }
  const actual = sha256(readFileSync(settingsPath));
  if (actual !== expectedSha256) {
    throw new ConfigGuardViolation(
      'settings',
      `settings sha256 ${actual.slice(0, 12)} != frozen ${expectedSha256.slice(0, 12)} — the runtime configuration has diverged from the frozen bytes (P2 defect class)`,
    );
  }
}

function extractSubmitSurface(tools: ReadonlyArray<GuardToolContract>, system: string, teachingSource: string) {
  const submission = tools.find((t) => t.name === 'submit_result');
  if (!submission) return { offered: false as const };
  const props = (submission.input_schema?.properties ?? null) as Record<string, unknown> | null;
  const required = (submission.input_schema?.required ?? null) as string[] | null;
  return {
    offered: true as const,
    top_level_properties: props ? Object.keys(props).sort() : null,
    required,
    has_creates_property: props ? Object.prototype.hasOwnProperty.call(props, 'creates') : null,
    teaching: {
      // the transport teaching rides in the FIRST USER message (agent-loop
      // formatInstruction injection), not the system prompt
      has_edits_line: /\bedits\b/.test(teachingSource),
      has_creates_line: /\bcreates\b/.test(teachingSource),
    },
  };
}

export function createConfigGuardProvider<P extends { completeMultiTurn: (params: MultiTurnParamsLike) => Promise<unknown> }>(
  inner: P,
  contract: () => StepContract,
  deps: GuardDeps,
): P {
  // construction-time settings verification (P2 lesson: verify EFFECTIVE config)
  if (deps.expectedSettingsSha256 !== undefined && deps.settingsPath !== undefined) {
    verifySettingsProvenance(deps.settingsPath, deps.expectedSettingsSha256);
  }
  if (typeof inner.completeMultiTurn !== 'function') {
    throw new ConfigGuardViolation('capability', 'the wrapped provider lacks completeMultiTurn — the frozen BUILD protocol requires the multi-turn wire (fail closed)');
  }

  const writeRecord = (record: Record<string, unknown>): void => {
    mkdirSync(dirname(deps.capturePath), { recursive: true });
    appendFileSync(deps.capturePath, JSON.stringify(record) + '\n', 'utf-8');
  };

  const wrapped = async (params: MultiTurnParamsLike): Promise<unknown> => {
    const c = contract();
    const violations: string[] = [];
    const teachingSource = typeof params.messages[0]?.content === 'string' ? params.messages[0].content : JSON.stringify(params.messages[0]?.content ?? '');
    const surface = extractSubmitSurface(params.tools, params.system, teachingSource);

    if (params.model !== c.model) violations.push(`model expected ${c.model} got ${params.model}`);
    if (params.max_tokens !== c.max_tokens) violations.push(`max_tokens expected ${c.max_tokens} got ${params.max_tokens}`);
    if (c.reasoning_effort === undefined) {
      if (params.reasoning_effort !== undefined) violations.push(`reasoning_effort expected ABSENT got ${params.reasoning_effort}`);
    } else if (params.reasoning_effort !== c.reasoning_effort) {
      violations.push(`reasoning_effort expected ${c.reasoning_effort} got ${params.reasoning_effort}`);
    }
    if (params.temperature !== c.temperature) violations.push(`temperature expected ${c.temperature} got ${params.temperature}`);
    const names = params.tools.map((t) => t.name);
    const setMatches = c.tool_sets.some((set) => set.length === names.length && [...set].sort().join('\u0000') === [...names].sort().join('\u0000'));
    if (!setMatches) violations.push(`tool set [${names.join(',')}] matches none of the frozen shapes [${c.tool_sets.map((s) => s.join(',')).join(' | ')}]`);
    if (c.submit_result === null) {
      if (surface.offered) violations.push('submit_result offered on a legacy produce step (frozen shape: absent)');
    } else {
      if (!surface.offered) violations.push('submit_result MISSING on the BUILD wire');
      else {
        if (JSON.stringify(surface.top_level_properties) !== JSON.stringify([...c.submit_result.schema_top_level_properties].sort())) {
          violations.push(`submit_result properties expected [${c.submit_result.schema_top_level_properties.join(',')}] got [${(surface.top_level_properties ?? []).join(',')}]`);
        }
        if (JSON.stringify(surface.required) !== JSON.stringify(c.submit_result.schema_required)) {
          violations.push(`submit_result required expected [${c.submit_result.schema_required.join(',')}] got [${(surface.required ?? []).join(',')}]`);
        }
        if (surface.has_creates_property !== false) violations.push('submit_result carries a creates property — the narrowed surface failed to bind (S3-class violation)');
        if (surface.teaching.has_edits_line !== c.submit_result.teaching_has_edits_line) violations.push(`teaching edits-line ${surface.teaching.has_edits_line} != expected ${c.submit_result.teaching_has_edits_line}`);
        if (surface.teaching.has_creates_line !== c.submit_result.teaching_has_creates_line) violations.push(`teaching creates-line ${surface.teaching.has_creates_line} != expected ${c.submit_result.teaching_has_creates_line}`);
      }
    }
    if (!params.system || params.system.length === 0) violations.push('missing system prompt');
    if (!Array.isArray(params.messages) || params.messages.length === 0) violations.push('empty messages');

    const record = {
      ts: new Date().toISOString(),
      phase: 'guarded-request',
      kind: 'multi-turn',
      step: c.stepId,
      model: params.model,
      max_tokens: params.max_tokens,
      reasoning_effort: params.reasoning_effort ?? null,
      temperature: params.temperature ?? null,
      tools: params.tools.map((t) => t.name),
      tools_sha256: sha256(canonicalJson(params.tools.map((t) => ({ name: t.name, input_schema: t.input_schema ?? null })))),
      submit_result_surface: surface.offered
        ? { offered: true, top_level_properties: surface.top_level_properties, required: surface.required, has_creates_property: surface.has_creates_property }
        : { offered: false, top_level_properties: null, required: null, has_creates_property: null },
      teaching_markers: surface.offered ? { has_edits_field_line: surface.teaching.has_edits_line, has_creates_field_line: surface.teaching.has_creates_line } : { has_edits_field_line: null, has_creates_field_line: null },
      messages_length: params.messages.length,
      guard_verdict: violations.length === 0 ? 'PASS' : 'STOP',
      violations,
    };
    // fail-closed evidence: the record MUST be archived before the verdict is
    // applied; a capture-write failure is itself an evidence-integrity failure
    try {
      writeRecord(record);
    } catch (writeErr) {
      throw new ConfigGuardViolation('evidence-integrity', `verified request could not be archived (${writeErr instanceof Error ? writeErr.message : String(writeErr)})`);
    }
    if (violations.length > 0) {
      throw new ConfigGuardViolation(c.stepId, violations.join('; ') + ' — the model call was NOT made');
    }
    return inner.completeMultiTurn(params);
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'completeMultiTurn' && typeof (target as { completeMultiTurn?: unknown }).completeMultiTurn === 'function') {
        return wrapped;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as P;
}
