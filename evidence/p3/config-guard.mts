// P3 CONFIG GUARD v2 — request-time verification of the EFFECTIVE execution
// configuration (P2 forensic lessons 1 + 3: a settings-file hash checked
// before instantiation is insufficient; the invariant is what reaches the
// provider request).
//
// v2 (P3 design review corrections C1/C2/C4):
//   C2  canonicalJson is RECURSIVE and deterministic (sorted keys at every
//       level, arrays in order) — tools_sha256 now identifies the FULL tool
//       definitions; any material schema mutation changes the hash (proven
//       in Q1). Teaching markers are the LINE-FORM annotations (`- edits: `,
//       `- creates: `) scanned across ALL model-visible user messages, not
//       only the first.
//   C4  the guard instruments the provider's FULL completion surface:
//       completeMultiTurn is verified+captured (request AND response/error
//       archived — the P2 wire-capture composition, so a future
//       transport-censoring decision has response-side evidence);
//       complete and completeStructured are EXPLICITLY BLOCKED (fail closed
//       pre-call, archived as blocked requests).
//   C1  captures are attributable: every record carries `phase` (per fixture
//       instantiation / per attempt) and lives in a per-instantiation file
//       chosen by the caller; classifyGuardCapture()/reconcileCapture()
//       reconcile archived records against provider-call counts so
//       historical or foreign records can never pass as evidence.
//
// Any mismatch or blocked path throws 'config-guard: STOP — ...' and the
// model call is NEVER made. Verified requests are archived BEFORE the verdict
// is applied (a capture-write failure is itself an evidence-integrity
// failure).
//
// Campaign tooling only — Stratum src/ stays frozen at 9f298f2.

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
  // request records land here (JSONL, capture v2 record shape). Callers MUST
  // use a fresh path per fixture instantiation / per attempt (C1).
  capturePath: string;
  // attribution label baked into every record (C1)
  phase: string;
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

// C2 — recursive deterministic serialization: object keys sorted at EVERY
// level, arrays kept in order, all nested fields preserved.
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'number': return Number.isFinite(v) ? JSON.stringify(v) : JSON.stringify(String(v));
    case 'boolean': return JSON.stringify(v);
    case 'object': {
      const obj = v as Record<string, unknown>;
      return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default: return JSON.stringify(String(v)); // undefined / functions
  }
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

// C2 — precise create-related teaching markers: the schema annotations render
// as `- <field>: <note>` lines (workflow/contracts.ts renderSchemaTeaching);
// field keys arrive as JSON pointers, so the real BUILD wire teaches
// `- /properties/edits: ...`. The line-form marker cannot be confused with
// prose or file content that merely CONTAINS the word (and the RESULT SHAPE
// JSON is not matched — only the annotation line is teaching). Scanned across
// ALL model-visible user messages (+ the system prompt for the creates
// absence).
const EDITS_TEACHING_LINE = /(^|\n)- (\/properties\/)?edits: /;
const CREATES_TEACHING_LINE = /(^|\n)- (\/properties\/)?creates: /;

function extractSubmitSurface(tools: ReadonlyArray<GuardToolContract>, system: string, messages: Array<{ role: string; content: unknown }>) {
  const submission = tools.find((t) => t.name === 'submit_result');
  const userText = messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n');
  if (!submission) return { offered: false as const, scanned_user_messages: messages.filter((m) => m.role === 'user').length };
  const props = (submission.input_schema?.properties ?? null) as Record<string, unknown> | null;
  const required = (submission.input_schema?.required ?? null) as string[] | null;
  return {
    offered: true as const,
    scanned_user_messages: messages.filter((m) => m.role === 'user').length,
    top_level_properties: props ? Object.keys(props).sort() : null,
    required,
    has_creates_property: props ? Object.prototype.hasOwnProperty.call(props, 'creates') : null,
    teaching: {
      // the edits teaching must appear in SOME user message; the creates
      // teaching must appear NOWHERE (any user message or the system prompt)
      has_edits_line: EDITS_TEACHING_LINE.test(userText),
      has_creates_line: CREATES_TEACHING_LINE.test(`${system}\n${userText}`),
    },
  };
}

// ─── capture classification (C1 reconciliation + C4 campaign recognition) ──

export interface CaptureRecord {
  kind: string; // 'request' | 'response' | 'error'
  phase?: string;
  step?: string;
  wire?: string;
  guard_verdict?: string;
  violations?: string[];
  ts?: string;
  [k: string]: unknown;
}

export interface CaptureClassification {
  total_lines: number;
  parse_failures: string[];
  requests: CaptureRecord[];
  passes: CaptureRecord[];
  stops: CaptureRecord[];
  responses: CaptureRecord[];
  errors: CaptureRecord[];
  provider_calls_observed: number;
  integrity_failures: string[];
  // G1: any config-guard STOP (request-time violation or blocked completion
  // path) — the campaign must STOP, the attempt is NOT a model-attempt.
  g1: boolean;
  // G2: capture-integrity failure (unpaired/malformed/tampered records) —
  // the campaign must STOP.
  g2: boolean;
}

export function classifyGuardCapture(path: string): CaptureClassification {
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const out: CaptureClassification = {
    total_lines: lines.length, parse_failures: [], requests: [], passes: [], stops: [],
    responses: [], errors: [], provider_calls_observed: 0, integrity_failures: [],
    g1: false, g2: false,
  };
  const records: CaptureRecord[] = [];
  lines.forEach((line, i) => {
    try {
      records.push(JSON.parse(line) as CaptureRecord);
    } catch {
      out.parse_failures.push(`line ${i + 1} is not valid JSON`);
    }
  });
  for (const fail of out.parse_failures) out.integrity_failures.push(fail);

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const at = `record ${i + 1}`;
    if (r.kind === 'request') {
      if (typeof r.step !== 'string' || typeof r.guard_verdict !== 'string' || typeof r.phase !== 'string') {
        out.integrity_failures.push(`${at}: request record missing required fields`);
      }
      out.requests.push(r);
      if (r.guard_verdict === 'PASS') {
        out.passes.push(r);
        const next = records[i + 1];
        if (!next || (next.kind !== 'response' && next.kind !== 'error')) {
          out.integrity_failures.push(`${at}: PASS request has no paired response/error record`);
        }
      } else if (r.guard_verdict === 'STOP') {
        out.stops.push(r);
        // an evidence-integrity STOP is itself a G2 fact (archival failed),
        // not a config violation — the campaign treats it as G2
        if (r.dimension === 'evidence-integrity') out.integrity_failures.push(`${at}: evidence-integrity STOP (archival failed)`);
        const next = records[i + 1];
        if (next && (next.kind === 'response' || next.kind === 'error')) {
          out.integrity_failures.push(`${at}: STOP request followed by an outcome record (the call must never have been made)`);
        }
      } else {
        out.integrity_failures.push(`${at}: unknown guard_verdict ${String(r.guard_verdict)}`);
      }
    } else if (r.kind === 'response') {
      const prev = records[i - 1];
      if (!prev || prev.kind !== 'request' || prev.guard_verdict !== 'PASS') {
        out.integrity_failures.push(`${at}: response record without a preceding PASS request`);
      }
      out.responses.push(r);
    } else if (r.kind === 'error') {
      const prev = records[i - 1];
      if (!prev || prev.kind !== 'request' || prev.guard_verdict !== 'PASS') {
        out.integrity_failures.push(`${at}: error record without a preceding PASS request`);
      }
      out.errors.push(r);
    } else {
      out.integrity_failures.push(`${at}: unknown record kind ${String(r.kind)}`);
    }
  }
  out.provider_calls_observed = out.responses.length + out.errors.length;
  out.g1 = out.stops.some((s) => s.dimension !== 'evidence-integrity');
  out.g2 = out.integrity_failures.length > 0;
  return out;
}

// C1 — exact reconciliation of a capture against the calls the inner provider
// actually observed. Returns discrepancy strings; an empty array = exact.
export function reconcileCapture(
  cls: CaptureClassification,
  expected: Array<{ step?: string }>,
): string[] {
  const d: string[] = [];
  if (cls.passes.length !== expected.length) {
    d.push(`PASS request count ${cls.passes.length} != provider call count ${expected.length}`);
  }
  if (cls.provider_calls_observed !== expected.length) {
    d.push(`provider-observed outcomes ${cls.provider_calls_observed} != provider call count ${expected.length}`);
  }
  expected.forEach((e, i) => {
    const got = cls.passes[i];
    if (got && e.step !== undefined && got.step !== e.step) {
      d.push(`request ${i + 1}: capture step '${got.step}' != provider step '${e.step}'`);
    }
  });
  return d;
}

// ─── the guard ───────────────────────────────────────────────────────────────

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
  const baseRecord = () => ({ ts: new Date().toISOString(), capture_version: 2, phase: deps.phase });

  const wrapped = async (params: MultiTurnParamsLike): Promise<unknown> => {
    const c = contract();
    const violations: string[] = [];
    const surface = extractSubmitSurface(params.tools, params.system, params.messages);

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
      ...baseRecord(),
      kind: 'request',
      wire: 'completeMultiTurn',
      step: c.stepId,
      model: params.model,
      max_tokens: params.max_tokens,
      reasoning_effort: params.reasoning_effort ?? null,
      temperature: params.temperature ?? null,
      tools: params.tools.map((t) => t.name),
      // C2 — recursive canonical form of the FULL tool definitions
      tools_sha256: sha256(canonicalJson(params.tools.map((t) => ({ name: t.name, description: t.description ?? null, input_schema: t.input_schema ?? null })))),
      submit_result_surface: surface.offered
        ? { offered: true, top_level_properties: surface.top_level_properties, required: surface.required, has_creates_property: surface.has_creates_property }
        : { offered: false, top_level_properties: null, required: null, has_creates_property: null },
      teaching_markers: surface.offered
        ? { has_edits_teaching_line: surface.teaching.has_edits_line, has_creates_teaching_line: surface.teaching.has_creates_line, scanned_user_messages: surface.scanned_user_messages }
        : { has_edits_teaching_line: null, has_creates_teaching_line: null, scanned_user_messages: surface.scanned_user_messages },
      messages_length: params.messages.length,
      system_sha256: sha256(String(params.system ?? '')),
      guard_verdict: violations.length === 0 ? 'PASS' : 'STOP',
      dimension: violations.length === 0 ? null : 'config',
      violations,
    };
    // fail-closed evidence: the record MUST be archived before the verdict is
    // applied; a capture-write failure is itself an evidence-integrity failure
    try {
      writeRecord(record);
    } catch (writeErr) {
      // the request is unarchived: refuse the call AND surface G2 (the
      // thrown violation's dimension names the class for the classifier)
      throw new ConfigGuardViolation('evidence-integrity', `verified request could not be archived (${writeErr instanceof Error ? writeErr.message : String(writeErr)})`);
    }
    if (violations.length > 0) {
      throw new ConfigGuardViolation(c.stepId, violations.join('; ') + ' — the model call was NOT made');
    }

    // C4 v2 — response-side capture with ARCHIVAL/PROVIDER SEPARATION (P3
    // review round 2, P1-b): a provider execution failure and a capture-write
    // failure are different facts and must never be conflated — a response
    // that cannot be archived is a G2 evidence-integrity STOP, never a
    // provider-looking error record.
    const started = Date.now();
    let res: {
      stop_reason?: string; text?: string; tool_uses?: Array<{ name?: string }>; tokens_used?: number;
      wire_observation?: Record<string, unknown>;
    };
    try {
      res = await inner.completeMultiTurn(params) as typeof res;
    } catch (err) {
      // PROVIDER failed — archive the error record; if THAT archival fails,
      // escalate as evidence-integrity with the provider error embedded
      try {
        writeRecord({
          ...baseRecord(), kind: 'error', wire: 'completeMultiTurn', step: c.stepId,
          error_name: err instanceof Error ? err.name : String(err),
          error_message: err instanceof Error ? err.message : String(err),
          duration_ms: Date.now() - started,
        });
      } catch (writeErr) {
        throw new ConfigGuardViolation('evidence-integrity', `provider error could not be archived (${writeErr instanceof Error ? writeErr.message : String(writeErr)}); original provider error: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }
    // PROVIDER succeeded — archive the response; a write failure here is a
    // G2 evidence-integrity STOP (the response exists but is NOT evidenced)
    try {
      writeRecord({
        ...baseRecord(), kind: 'response', wire: 'completeMultiTurn', step: c.stepId,
        stop_reason: res?.stop_reason ?? null,
        tokens_used: res?.tokens_used ?? null,
        tool_uses: (res?.tool_uses ?? []).map((t) => t.name ?? null),
        text: typeof res?.text === 'string' ? res.text : null,
        text_sha256: typeof res?.text === 'string' ? sha256(res.text) : null,
        text_bytes: typeof res?.text === 'string' ? Buffer.byteLength(res.text) : null,
        // P1-a — the decisive provider-side wire metadata (the P2
        // transport-censoring adjudication class: stop_reason end_turn with
        // finish_reason error and partial content) preserved verbatim
        wire_observation: res?.wire_observation ?? null,
        duration_ms: Date.now() - started,
      });
    } catch (writeErr) {
      throw new ConfigGuardViolation('evidence-integrity', `provider response could not be archived (${writeErr instanceof Error ? writeErr.message : String(writeErr)}) — the response is NOT evidenced; G2 STOP`);
    }
    return res;
  };

  // C4 — explicit blocking of the non-permitted completion paths: the
  // multi-turn wire is the only channel the frozen BUILD protocol (and the
  // P3 scope) allows. A blocked call is ARCHIVED (kind 'request',
  // guard_verdict 'STOP', wire naming the path) and throws BEFORE any
  // provider interaction — it surfaces to the campaign as a G1-class guard
  // STOP, never as a model attempt.
  const blockedPath = (method: 'complete' | 'completeStructured') => async (..._args: unknown[]): Promise<never> => {
    let step = 'unknown';
    try { step = contract().stepId; } catch { /* classification unavailable */ }
    const record = {
      ...baseRecord(), kind: 'request', wire: method, step,
      guard_verdict: 'STOP',
      violations: [`completion path ${method} is not permitted in P3 scope — only completeMultiTurn is a guarded wire; the call was blocked BEFORE reaching the provider`],
      tools: null as unknown as string[],
      tools_sha256: null,
    };
    record.dimension = 'completion-path';
    try {
      writeRecord(record);
    } catch (writeErr) {
      // archival failed: the STOP still happens (no provider call either
      // way) but it surfaces as evidence-integrity (G2), not as a config STOP
      throw new ConfigGuardViolation('evidence-integrity', `blocked-completion attempt could not be archived (${writeErr instanceof Error ? writeErr.message : String(writeErr)})`);
    }
    throw new ConfigGuardViolation('completion-path', `${method} is not a permitted wire in P3 scope — only completeMultiTurn is guarded+captured; the call was blocked BEFORE reaching the provider`);
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'completeMultiTurn' && typeof (target as { completeMultiTurn?: unknown }).completeMultiTurn === 'function') {
        return wrapped;
      }
      if (prop === 'complete' || prop === 'completeStructured') {
        return blockedPath(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as P;
}
