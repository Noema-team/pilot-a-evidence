// P2 S3 — campaign-side WIRE CAPTURE v2: a transparent provider wrapper that
// records the ACTUAL outgoing provider requests (the real tools array with
// the submit_result input_schema, and teaching markers from the real
// messages) without altering any byte of the frozen implementation
// (stratum 9f298f2).
//
// v2 corrections (operator launch-gate review of binding v2 @ e272e2a):
//   1. Response metadata is read from result.wire_observation (the REAL
//      provider's finish_reason / prompt_tokens live there — see
//      src/sse-accumulator.ts WireObservation), with top-level fallbacks for
//      scripted providers.
//   2. Failed requests ARE archived: the request record is appended BEFORE
//      forwarding; a response or error record with the same request_id
//      follows. A provider throw produces an error record and propagates.
//   3. Capability preservation: the wrapper is a Proxy over the inner
//      provider — prototype methods (completeStructured, complete,
//      completeMultiTurn, anything else) keep their exact function
//      references; only complete/completeMultiTurn are overridden.
//   4. Fail-closed capture: if the capture write fails, a 'wire-capture:'
//      error is thrown. On the REQUEST phase this happens BEFORE the model
//      call — no unaudited traffic can leave.
//
// Used in TWO places from this one source:
//   - pilot-a-driver.ts wraps the live provider so every live request is
//     captured to a campaign-owned JSONL file (copied into the run's evidence
//     directory after the run — the per-opportunity wire_surface_offered
//     reporting field reads THIS, never configuration inference)
//   - evidence/p2/s3-request-observability.mts proves, offline at 9f298f2,
//     the real emitted surface + capability preservation + fail-closed
//     behavior + failure archiving

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export interface WireCaptureRecord {
  ts: string;
  request_id: string;
  phase: 'request' | 'response' | 'error';
  kind: 'multi-turn' | 'single-turn';
  model: string;
  messages_length?: number;
  request_bytes?: number;
  tools?: Array<{ name: string; input_schema: unknown }> | null;
  tools_sha256?: string | null;
  submit_result_surface?: {
    offered: boolean;
    top_level_properties: string[] | null;
    required: string[] | null;
    has_creates_property: boolean | null;
  };
  teaching_markers?: {
    has_edits_field_line: boolean;
    has_creates_field_line: boolean;
  };
  response_finish_reason?: string | null;
  response_prompt_tokens?: number | null;
  error?: string;
}

function writeRecord(capturePath: string, rec: WireCaptureRecord): void {
  try {
    appendFileSync(capturePath, JSON.stringify(rec) + '\n', 'utf-8');
  } catch (err) {
    // fail closed with a recognizable marker: capture evidence must never be
    // silently lost (the caller converts request-phase failures into a throw
    // BEFORE the model call)
    throw new Error(`wire-capture: capture write failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Wrap any provider object transparently. Forwards EVERY call verbatim,
 * preserving the inner provider's prototype chain (Proxy delegation), and
 * appends paired request/response records per request to `capturePath`
 * (JSONL). Capture-write failures throw ('wire-capture: …') — on the request
 * phase BEFORE any model call (fail closed).
 */
export function createWireCaptureProvider<P extends object>(inner: P, capturePath: string, model: string): P {
  try {
    mkdirSync(dirname(capturePath), { recursive: true });
  } catch (err) {
    // fail closed at construction: an unwritable capture location must never
    // silently produce unaudited traffic
    throw new Error(`wire-capture: capture file is not writable — ${err instanceof Error ? err.message : String(err)}`);
  }
  let counter = 0;

  const observe = (params: { messages?: unknown[]; tools?: ReadonlyArray<{ name: string; input_schema?: unknown }> }, kind: 'multi-turn' | 'single-turn'): { requestId: string; requestBytes: number } => {
    const requestId = `${Date.now()}-${++counter}`;
    const tools = params.tools ? params.tools.map((t) => ({ name: t.name, input_schema: t.input_schema })) : null;
    const messagesBlob = JSON.stringify(params.messages ?? []);
    const submit = tools?.find((t) => t.name === 'submit_result');
    const schema = (submit?.input_schema ?? null) as { properties?: Record<string, unknown>; required?: string[] } | null;
    writeRecord(capturePath, {
      ts: new Date().toISOString(),
      request_id: requestId,
      phase: 'request',
      kind,
      model,
      messages_length: Array.isArray(params.messages) ? params.messages.length : 0,
      request_bytes: messagesBlob.length,
      tools,
      tools_sha256: tools ? sha256Hex(JSON.stringify(tools)) : null,
      submit_result_surface: {
        offered: Boolean(submit),
        top_level_properties: schema?.properties ? Object.keys(schema.properties).sort() : null,
        required: schema?.required ? [...schema.required].sort() : null,
        has_creates_property: schema?.properties ? Object.hasOwn(schema.properties, 'creates') : null,
      },
      teaching_markers: {
        has_edits_field_line: messagesBlob.includes('/properties/edits'),
        has_creates_field_line: messagesBlob.includes('/properties/creates'),
      },
    });
    return { requestId, requestBytes: messagesBlob.length };
  };

  const observeResponse = (capturePath_: string, requestId: string, kind: 'multi-turn' | 'single-turn', result: unknown): void => {
    const wo = (result as { wire_observation?: { finish_reason?: string | null; prompt_tokens?: number | null } })?.wire_observation;
    writeRecord(capturePath_, {
      ts: new Date().toISOString(),
      request_id: requestId,
      phase: 'response',
      kind,
      model,
      response_finish_reason: wo ? (wo.finish_reason ?? null) : ((result as { finish_reason?: string | null }).finish_reason ?? null),
      response_prompt_tokens: wo ? (wo.prompt_tokens ?? null) : ((result as { prompt_tokens?: number | null }).prompt_tokens ?? null),
    });
  };

  const wrappedMultiTurn = async (params: { messages: unknown[]; tools?: ReadonlyArray<{ name: string; input_schema?: unknown }> }) => {
    const { requestId } = observe(params, 'multi-turn'); // fail-closed: throws BEFORE the model call on capture-write failure
    let result: unknown;
    try {
      result = await (inner as { completeMultiTurn: (p: unknown) => Promise<unknown> }).completeMultiTurn(params);
    } catch (err) {
      try {
        writeRecord(capturePath, { ts: new Date().toISOString(), request_id: requestId, phase: 'error', kind: 'multi-turn', model, error: err instanceof Error ? err.message : String(err) });
      } catch { /* the original error outranks the evidence-write failure */ }
      throw err;
    }
    observeResponse(capturePath, requestId, 'multi-turn', result); // fail-closed after a successful call
    return result;
  };

  const wrappedComplete = async (params: unknown) => {
    const p = params as { messages?: unknown[]; tools?: ReadonlyArray<{ name: string; input_schema?: unknown }> };
    if (!Array.isArray(p?.messages)) {
      return (inner as { complete: (x: unknown) => Promise<unknown> }).complete(params);
    }
    const { requestId } = observe(p as never, 'single-turn');
    let result: unknown;
    try {
      result = await (inner as { complete: (x: unknown) => Promise<unknown> }).complete(params);
    } catch (err) {
      try {
        writeRecord(capturePath, { ts: new Date().toISOString(), request_id: requestId, phase: 'error', kind: 'single-turn', model, error: err instanceof Error ? err.message : String(err) });
      } catch { /* the original error outranks the evidence-write failure */ }
      throw err;
    }
    observeResponse(capturePath, requestId, 'single-turn', result);
    return result;
  };

  // Proxy delegation: every property NOT explicitly overridden resolves on
  // the inner provider with its original function reference and original
  // `this` — prototype methods like completeStructured survive untouched.
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'completeMultiTurn') return wrappedMultiTurn;
      if (prop === 'complete') return wrappedComplete;
      return Reflect.get(target, prop, receiver);
    },
  }) as P;
}
