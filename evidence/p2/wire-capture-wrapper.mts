// P2 S3 — campaign-side WIRE CAPTURE: a transparent provider wrapper that
// records the ACTUAL outgoing provider requests (the real tools array with
// the submit_result input_schema, and teaching markers from the real
// messages) alongside the normal response, without altering any byte of the
// frozen implementation (stratum 9f298f2).
//
// Used in TWO places from this one source:
//   - pilot-a-driver.ts wraps the live provider so every live request is
//     captured to a campaign-owned JSONL file (copied into the run's evidence
//     directory after the run — the per-opportunity `wire_surface_offered`
//     reporting field reads THIS, never configuration inference)
//   - evidence/p2/s3-request-observability.mts wraps a scripted provider to
//     prove, offline at 9f298f2, that the capture reflects the real emitted
//     surface (narrowed: no creates; full: creates present)

export interface WireCaptureRecord {
  ts: string;
  kind: 'multi-turn' | 'single-turn';
  model: string;
  messages_length: number;
  request_bytes: number;
  tools: Array<{ name: string; input_schema: unknown }> | null;
  tools_sha256: string | null;
  submit_result_surface: {
    offered: boolean;
    top_level_properties: string[] | null;
    required: string[] | null;
    has_creates_property: boolean | null;
  };
  teaching_markers: {
    has_edits_field_line: boolean;
    has_creates_field_line: boolean;
  };
  response_finish_reason?: string;
  response_prompt_tokens?: number;
}

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Wrap any provider object transparently. Forwards EVERY call verbatim and
 * appends one WireCaptureRecord per request to `capturePath` (JSONL).
 */
export function createWireCaptureProvider<P extends object>(inner: P, capturePath: string, model: string): P {
  mkdirSync(dirname(capturePath), { recursive: true });

  const record = (rec: WireCaptureRecord): void => {
    appendFileSync(capturePath, JSON.stringify(rec) + '\n', 'utf-8');
  };

  const observeMultiTurn = (params: { messages: unknown[]; tools?: ReadonlyArray<{ name: string; input_schema?: unknown }> }, result: { finish_reason?: string; prompt_tokens?: number }): void => {
    const tools = params.tools ? params.tools.map((t) => ({ name: t.name, input_schema: t.input_schema })) : null;
    const messagesBlob = JSON.stringify(params.messages);
    const submit = tools?.find((t) => t.name === 'submit_result');
    const schema = (submit?.input_schema ?? null) as { properties?: Record<string, unknown>; required?: string[] } | null;
    record({
      ts: new Date().toISOString(),
      kind: 'multi-turn',
      model,
      messages_length: params.messages.length,
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
      ...(result.finish_reason !== undefined ? { response_finish_reason: result.finish_reason } : {}),
      ...(result.prompt_tokens !== undefined ? { response_prompt_tokens: result.prompt_tokens } : {}),
    });
  };

  const wrapped: P = { ...inner } as P;
  const anyInner = inner as unknown as Record<string, unknown>;
  const anyWrapped = wrapped as unknown as Record<string, unknown>;

  if (typeof anyInner.completeMultiTurn === 'function') {
    const orig = anyInner.completeMultiTurn.bind(inner);
    anyWrapped.completeMultiTurn = async (params: { messages: unknown[]; tools?: ReadonlyArray<{ name: string; input_schema?: unknown }> }) => {
      const result = await orig(params);
      observeMultiTurn(params, result as { finish_reason?: string; prompt_tokens?: number });
      return result;
    };
  }
  if (typeof anyInner.complete === 'function') {
    const orig = anyInner.complete.bind(inner);
    anyWrapped.complete = async (params: unknown) => {
      const result = await orig(params);
      const p = params as { messages?: unknown[]; tools?: ReadonlyArray<{ name: string; input_schema?: unknown }> };
      if (Array.isArray(p?.messages)) {
        observeMultiTurn(p as never, result as { finish_reason?: string; prompt_tokens?: number });
      }
      return result;
    };
  }
  return wrapped;
}
