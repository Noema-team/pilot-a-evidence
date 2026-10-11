// P4 TRANSPORT GUARD — request-time verification + guarded capture for the
// THREE native completion paths the frozen Stratum workflows actually use
// (P4 final architecture review, correction 1):
//
//   completeMultiTurn  — produce/gather steps (AgentLoop C5 negotiation,
//                        investigation tools, SSE stream, wire_observation)
//   complete           — single-turn textual path (CriticAgent; review
//                        fallback when the provider lacks completeStructured)
//   completeStructured — single-turn review wire when the step carries a
//                        registered contract and the provider genuinely
//                        implements it (D.34 C6; the openrouter provider does)
//
// The review binding: "Do not assume single-turn reviews use the multi-turn
// wire or expose streaming metadata." Each wire is captured with ITS OWN
// result shape: complete/completeStructured results carry NO wire_observation
// and NO tool_uses — the record stores `wire_observation: null` as an explicit
// recorded fact (absence is evidenced, never implied), and streaming fields
// are never fabricated on those wires.
//
// Everything else preserves the frozen P3 guard semantics (imported, not
// modified): fail-closed request validation against a per-step contract,
// archival BEFORE the verdict is applied, provider-failure vs capture-write
// separation (evidence-integrity dimension), ConfigGuardViolation G1/G2
// classes, and classifyGuardCapture-compatible records (kind / step /
// guard_verdict / dimension / violations / phase) so the campaign-loop
// recognition logic is reused unchanged. Every request record additionally
// pins `settings_sha256` and `workflow_id` (P4 readiness R3/R4 re-verify from
// evidence, not from construction-time state).
//
// Campaign tooling only — Stratum src/ stays frozen at 9f298f2.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ConfigGuardViolation,
  canonicalJson,
  verifySettingsProvenance,
  type GuardToolContract,
} from '../p3/config-guard.mts';

export type P4Wire = 'completeMultiTurn' | 'complete' | 'completeStructured';

export interface P4StepContract {
  stepId: string;
  workflowId: string;
  model: string;
  max_tokens: number;
  // multi-turn only; must be ABSENT on the single-turn wires (agent-runner
  // fails closed on a single-turn effort override — the guard double-checks)
  reasoning_effort?: string;
  temperature: number;
  // multi-turn only
  tool_sets: Array<readonly string[]>;
  submit_result: null | {
    schema_top_level_properties: readonly string[];
    schema_required: readonly string[];
    has_creates_property: false;
  };
  // structured wire only (when the contract is declared)
  structured_schema_name?: string;
  // CALIBRATION ONLY (L1 phase 1): skip tool-surface/submit checks for a step
  // whose production shape has not been pinned yet; model/budget/effort/
  // temperature remain enforced, and everything is still recorded so the
  // observed shape can be pinned. NEVER set by the campaign path.
  unpinned_tools?: boolean;
}

export interface P4GuardDeps {
  capturePath: string;
  phase: string;
  settingsPath: string;
  expectedSettingsSha256: string;
  // L1 calibration aid: include FULL tool definitions + structured schema in
  // request records so the qualification can pin observed shapes. Live use
  // may disable it (hashes are always recorded either way).
  captureToolSchemas?: boolean;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface P4MultiTurnParams {
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  max_tokens: number;
  temperature?: number;
  reasoning_effort?: string;
  tools: ReadonlyArray<GuardToolContract>;
}
export interface P4CompleteParams {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  temperature?: number;
  max_tokens: number;
}
export interface P4StructuredParams {
  model: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
  temperature?: number;
  schema: Record<string, unknown>;
  schemaName?: string;
}

function extractSubmitSurface(tools: ReadonlyArray<GuardToolContract>) {
  const submission = tools.find((t) => t.name === 'submit_result');
  if (!submission) return { offered: false as const };
  const props = (submission.input_schema?.properties ?? null) as Record<string, unknown> | null;
  const required = (submission.input_schema?.required ?? null) as string[] | null;
  return {
    offered: true as const,
    top_level_properties: props ? Object.keys(props).sort() : null,
    required,
    has_creates_property: props ? Object.prototype.hasOwnProperty.call(props, 'creates') : null,
  };
}

// ─── the guard ────────────────────────────────────────────────────────────────

export function createP4GuardProvider<P extends object>(
  inner: P,
  resolveContract: (wire: P4Wire) => P4StepContract,
  deps: P4GuardDeps,
): P {
  // construction-time verification PLUS per-call re-verification (R3: the
  // settings sha is checked at EVERY actual request — mid-attempt drift is
  // the P2 defect class and must STOP the campaign, never pass silently)
  verifySettingsProvenance(deps.settingsPath, deps.expectedSettingsSha256);

  const writeRecord = (record: Record<string, unknown>): void => {
    mkdirSync(dirname(deps.capturePath), { recursive: true });
    appendFileSync(deps.capturePath, JSON.stringify(record) + '\n', 'utf-8');
  };
  // per-call: re-read the settings file; a drifted file STOPs before the
  // request, and every record pins the sha ACTUALLY verified for this call
  const baseRecord = () => {
    verifySettingsProvenance(deps.settingsPath, deps.expectedSettingsSha256);
    return {
      ts: new Date().toISOString(), capture_version: 3, phase: deps.phase,
      settings_sha256: deps.expectedSettingsSha256,
    };
  };

  const commonChecks = (
    p: { model: string; max_tokens: number; temperature?: number },
    c: P4StepContract,
  ): string[] => {
    const v: string[] = [];
    if (p.model !== c.model) v.push(`model expected ${c.model} got ${p.model}`);
    if (p.max_tokens !== c.max_tokens) v.push(`max_tokens expected ${c.max_tokens} (frozen map for ${c.workflowId}/${c.stepId}) got ${p.max_tokens}`);
    if (p.temperature !== c.temperature) v.push(`temperature expected ${c.temperature} got ${String(p.temperature)}`);
    return v;
  };

  const multiTurnWrapped = async (params: P4MultiTurnParams): Promise<unknown> => {
    const wire: P4Wire = 'completeMultiTurn';
    const c = resolveContract(wire);
    const violations = commonChecks(params, c);
    if (c.reasoning_effort === undefined) {
      if (params.reasoning_effort !== undefined) violations.push(`reasoning_effort expected ABSENT got ${params.reasoning_effort}`);
    } else if (params.reasoning_effort !== c.reasoning_effort) {
      violations.push(`reasoning_effort expected ${c.reasoning_effort} got ${params.reasoning_effort}`);
    }
    const names = params.tools.map((t) => t.name);
    const surface = extractSubmitSurface(params.tools);
    if (!c.unpinned_tools) {
      const setMatches = c.tool_sets.some((set) => set.length === names.length && [...set].sort().join('\u0000') === [...names].sort().join('\u0000'));
      if (!setMatches) violations.push(`tool set [${names.join(',')}] matches none of the frozen shapes [${c.tool_sets.map((s) => s.join(',')).join(' | ')}]`);
      if (c.submit_result === null) {
        if (surface.offered) violations.push('submit_result offered on a step whose frozen shape declares none');
      } else if (!surface.offered) {
        violations.push('submit_result MISSING on a step whose frozen shape declares it');
      } else {
        if (JSON.stringify(surface.top_level_properties) !== JSON.stringify([...c.submit_result.schema_top_level_properties].sort())) {
          violations.push(`submit_result properties expected [${c.submit_result.schema_top_level_properties.join(',')}] got [${(surface.top_level_properties ?? []).join(',')}]`);
        }
        if (JSON.stringify(surface.required) !== JSON.stringify(c.submit_result.schema_required)) {
          violations.push(`submit_result required expected [${c.submit_result.schema_required.join(',')}] got [${(surface.required ?? []).join(',')}]`);
        }
        if (surface.has_creates_property !== false) violations.push('submit_result carries a creates property');
      }
    }
    if (!params.system) violations.push('missing system prompt');
    if (!Array.isArray(params.messages) || params.messages.length === 0) violations.push('empty messages');

    const record: Record<string, unknown> = {
      ...baseRecord(), kind: 'request', wire, step: c.stepId, workflow_id: c.workflowId,
      model: params.model, max_tokens: params.max_tokens,
      reasoning_effort: params.reasoning_effort ?? null, temperature: params.temperature ?? null,
      tools: names,
      tools_sha256: sha256(canonicalJson(params.tools.map((t) => ({ name: t.name, description: t.description ?? null, input_schema: t.input_schema ?? null })))),
      submit_result_surface: surface.offered
        ? { offered: true, top_level_properties: surface.top_level_properties, required: surface.required, has_creates_property: surface.has_creates_property }
        : { offered: false, top_level_properties: null, required: null, has_creates_property: null },
      messages_length: params.messages.length,
      system_sha256: sha256(String(params.system ?? '')),
      guard_verdict: violations.length === 0 ? 'PASS' : 'STOP',
      dimension: violations.length === 0 ? null : 'config',
      violations,
    };
    if (deps.captureToolSchemas) record.tool_definitions = params.tools;
    try { writeRecord(record); } catch (w) {
      throw new ConfigGuardViolation('evidence-integrity', `verified request could not be archived (${w instanceof Error ? w.message : String(w)})`);
    }
    if (violations.length > 0) throw new ConfigGuardViolation(c.stepId, violations.join('; ') + ' — the model call was NOT made');

    const started = Date.now();
    let res: { stop_reason?: string; text?: string; tool_uses?: Array<{ name?: string }>; tokens_used?: number; wire_observation?: Record<string, unknown> };
    try {
      res = await (inner as { completeMultiTurn: (p: P4MultiTurnParams) => Promise<typeof res> }).completeMultiTurn(params);
    } catch (err) {
      try {
        writeRecord({ ...baseRecord(), kind: 'error', wire, step: c.stepId, workflow_id: c.workflowId, error_name: err instanceof Error ? err.name : String(err), error_message: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - started });
      } catch (w) {
        throw new ConfigGuardViolation('evidence-integrity', `provider error could not be archived (${w instanceof Error ? w.message : String(w)}); original provider error: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }
    try {
      writeRecord({
        ...baseRecord(), kind: 'response', wire, step: c.stepId, workflow_id: c.workflowId,
        stop_reason: res?.stop_reason ?? null, tokens_used: res?.tokens_used ?? null,
        tool_uses: (res?.tool_uses ?? []).map((t) => t.name ?? null),
        text: typeof res?.text === 'string' ? res.text : null,
        text_sha256: typeof res?.text === 'string' ? sha256(res.text) : null,
        text_bytes: typeof res?.text === 'string' ? Buffer.byteLength(res.text) : null,
        wire_observation: res?.wire_observation ?? null,
        duration_ms: Date.now() - started,
      });
    } catch (w) {
      throw new ConfigGuardViolation('evidence-integrity', `provider response could not be archived (${w instanceof Error ? w.message : String(w)}) — the response is NOT evidenced; G2 STOP`);
    }
    return res;
  };

  // single-turn textual wire: LLMCompletionParams is zod-strict
  // {model, messages[{role, content:string}], temperature, max_tokens}; the
  // result is {content, tokens_used, duration_ms} — NO streaming metadata.
  const completeWrapped = async (params: P4CompleteParams): Promise<unknown> => {
    const wire: P4Wire = 'complete';
    const c = resolveContract(wire);
    const violations = commonChecks(params, c);
    if (c.reasoning_effort !== undefined) violations.push(`frozen map declares reasoning_effort for ${c.workflowId}/${c.stepId} but the single-turn wire does not support reasoning control (agent-runner fails closed; guard refuses pre-call)`);
    if (!Array.isArray(params.messages) || params.messages.length === 0) violations.push('empty messages');
    const record: Record<string, unknown> = {
      ...baseRecord(), kind: 'request', wire, step: c.stepId, workflow_id: c.workflowId,
      model: params.model, max_tokens: params.max_tokens, reasoning_effort: null,
      temperature: params.temperature ?? null, tools: [],
      tools_sha256: null,
      submit_result_surface: { offered: false, top_level_properties: null, required: null, has_creates_property: null },
      messages_length: params.messages.length,
      system_sha256: null,
      guard_verdict: violations.length === 0 ? 'PASS' : 'STOP',
      dimension: violations.length === 0 ? null : 'config',
      violations,
    };
    try { writeRecord(record); } catch (w) {
      throw new ConfigGuardViolation('evidence-integrity', `verified request could not be archived (${w instanceof Error ? w.message : String(w)})`);
    }
    if (violations.length > 0) throw new ConfigGuardViolation(c.stepId, violations.join('; ') + ' — the model call was NOT made');

    const started = Date.now();
    let res: { content?: string; tokens_used?: number; duration_ms?: number };
    try {
      res = await (inner as { complete: (p: P4CompleteParams) => Promise<typeof res> }).complete(params);
    } catch (err) {
      try {
        writeRecord({ ...baseRecord(), kind: 'error', wire, step: c.stepId, workflow_id: c.workflowId, error_name: err instanceof Error ? err.name : String(err), error_message: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - started });
      } catch (w) {
        throw new ConfigGuardViolation('evidence-integrity', `provider error could not be archived (${w instanceof Error ? w.message : String(w)}); original provider error: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }
    try {
      writeRecord({
        ...baseRecord(), kind: 'response', wire, step: c.stepId, workflow_id: c.workflowId,
        stop_reason: null, tokens_used: res?.tokens_used ?? null, tool_uses: [],
        text: typeof res?.content === 'string' ? res.content : null,
        text_sha256: typeof res?.content === 'string' ? sha256(res.content) : null,
        text_bytes: typeof res?.content === 'string' ? Buffer.byteLength(res.content) : null,
        // recorded fact: the single-turn textual result exposes NO streaming
        // metadata — absence is evidenced, never implied
        wire_observation: null,
        duration_ms: res?.duration_ms ?? Date.now() - started,
      });
    } catch (w) {
      throw new ConfigGuardViolation('evidence-integrity', `provider response could not be archived (${w instanceof Error ? w.message : String(w)}) — the response is NOT evidenced; G2 STOP`);
    }
    return res;
  };

  // single-turn structured review wire: the value IS the semantic proposal.
  const structuredWrapped = async (params: P4StructuredParams): Promise<unknown> => {
    const wire: P4Wire = 'completeStructured';
    const c = resolveContract(wire);
    const violations = commonChecks(params, c);
    if (c.reasoning_effort !== undefined) violations.push(`frozen map declares reasoning_effort for ${c.workflowId}/${c.stepId} but the single-turn wire does not support reasoning control`);
    if (c.structured_schema_name !== undefined && params.schemaName !== c.structured_schema_name) {
      violations.push(`schemaName expected ${c.structured_schema_name} got ${String(params.schemaName)}`);
    }
    if (!params.schema || typeof params.schema !== 'object') violations.push('missing structured schema');
    if (!Array.isArray(params.messages) || params.messages.length === 0) violations.push('empty messages');
    const record: Record<string, unknown> = {
      ...baseRecord(), kind: 'request', wire, step: c.stepId, workflow_id: c.workflowId,
      model: params.model, max_tokens: params.max_tokens, reasoning_effort: null,
      temperature: params.temperature ?? null, tools: [],
      tools_sha256: null,
      structured_schema_name: params.schemaName ?? null,
      structured_schema_sha256: sha256(canonicalJson(params.schema ?? null)),
      submit_result_surface: { offered: false, top_level_properties: null, required: null, has_creates_property: null },
      messages_length: params.messages.length,
      system_sha256: params.system ? sha256(params.system) : null,
      guard_verdict: violations.length === 0 ? 'PASS' : 'STOP',
      dimension: violations.length === 0 ? null : 'config',
      violations,
    };
    if (deps.captureToolSchemas) record.structured_schema = params.schema;
    try { writeRecord(record); } catch (w) {
      throw new ConfigGuardViolation('evidence-integrity', `verified request could not be archived (${w instanceof Error ? w.message : String(w)})`);
    }
    if (violations.length > 0) throw new ConfigGuardViolation(c.stepId, violations.join('; ') + ' — the model call was NOT made');

    const started = Date.now();
    let res: { value?: unknown; tokens_used?: number; duration_ms?: number };
    try {
      res = await (inner as { completeStructured: (p: P4StructuredParams) => Promise<typeof res> }).completeStructured(params);
    } catch (err) {
      try {
        writeRecord({ ...baseRecord(), kind: 'error', wire, step: c.stepId, workflow_id: c.workflowId, error_name: err instanceof Error ? err.name : String(err), error_message: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - started });
      } catch (w) {
        throw new ConfigGuardViolation('evidence-integrity', `provider error could not be archived (${w instanceof Error ? w.message : String(w)}); original provider error: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }
    try {
      writeRecord({
        ...baseRecord(), kind: 'response', wire, step: c.stepId, workflow_id: c.workflowId,
        stop_reason: null, tokens_used: res?.tokens_used ?? null, tool_uses: [],
        text: null, text_sha256: null, text_bytes: null,
        value_sha256: sha256(canonicalJson(res?.value ?? null)),
        value_bytes: Buffer.byteLength(canonicalJson(res?.value ?? null)),
        // recorded fact: the structured result exposes NO streaming metadata
        wire_observation: null,
        duration_ms: res?.duration_ms ?? Date.now() - started,
      });
    } catch (w) {
      throw new ConfigGuardViolation('evidence-integrity', `provider response could not be archived (${w instanceof Error ? w.message : String(w)}) — the response is NOT evidenced; G2 STOP`);
    }
    return res;
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'completeMultiTurn' && typeof (target as { completeMultiTurn?: unknown }).completeMultiTurn === 'function') return multiTurnWrapped;
      if (prop === 'complete' && typeof (target as { complete?: unknown }).complete === 'function') return completeWrapped;
      if (prop === 'completeStructured' && typeof (target as { completeStructured?: unknown }).completeStructured === 'function') return structuredWrapped;
      return Reflect.get(target, prop, receiver);
    },
  }) as P;
}
