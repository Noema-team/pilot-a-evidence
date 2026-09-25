// OpenRouter transport probes from a fresh Node process — infrastructure investigation only.
// Records exact timestamps/durations/errors for: quick GET, small non-streaming completion,
// and a streaming completion with TTFT + per-chunk gap metrics.
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = readFileSync('/tmp/opencode/.openrouter_key', 'utf8').trim();
const BASE = 'https://openrouter.ai/api/v1';
const LOG = 'logs/node-openrouter.log';
const t = () => new Date().toISOString();
const out = [];
const say = (s) => { const line = `${t()} ${s}`; console.log(line); out.push(line); };
const dur = (ms0) => `${((Date.now() - ms0) / 1000).toFixed(1)}s`;

say(`node ${process.version} undici ${process.versions.undici} — probe start`);

// 1. Quick GET
{
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/models`);
    const j = await r.json();
    say(`GET /models -> ${r.status}, ${j.data?.length} models, ${dur(t0)}`);
  } catch (e) { say(`GET /models FAILED after ${dur(t0)}: ${e.name}/${e.cause?.code ?? e.message}`); }
}

// 2. Small non-streaming completion
{
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }),
    });
    const j = await r.json();
    say(`non-stream small completion -> ${r.status} "${j.choices?.[0]?.message?.content?.trim()}", usage_total_tokens=${j.usage?.total_tokens}, ${dur(t0)}`);
  } catch (e) { say(`non-stream small completion FAILED after ${dur(t0)}: ${e.name}/${e.cause?.code ?? e.message} cause_msg="${e.cause?.message}"`); }
}

// 3. Streaming completion with metrics
{
  const t0 = Date.now();
  let ttft = null, last = null, chunks = 0, bytes = 0, maxGap = 0, maxGapAt = null, firstChunkAt = null;
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'z-ai/glm-5.3-flash', max_tokens: 3000, stream: true,
        messages: [{ role: 'user', content: 'Count from 1 to 300, one number per line, then write a 200-word summary of what you counted.' }],
      }),
    });
    say(`stream: response status=${r.status} headers at ${dur(t0)}`);
    const dec = new TextDecoder();
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      const now = Date.now();
      if (done) break;
      chunks++; bytes += value.length;
      if (ttft === null) { ttft = now; firstChunkAt = t(); say(`stream: FIRST CHUNK at +${((now - t0) / 1000).toFixed(2)}s`); }
      if (last !== null) { const gap = now - last; if (gap > maxGap) { maxGap = gap; maxGapAt = t(); } }
      last = now;
    }
    say(`stream: COMPLETED chunks=${chunks} bytes=${bytes} total=${dur(t0)} ttft=${((ttft - t0) / 1000).toFixed(2)}s largest_inter_chunk_gap=${(maxGap / 1000).toFixed(2)}s (at ${maxGapAt})`);
  } catch (e) {
    say(`stream FAILED after ${dur(t0)} ttft=${ttft ? ((ttft - t0) / 1000).toFixed(2) + 's' : 'never'} chunks=${chunks} bytes=${bytes} largest_gap=${(maxGap / 1000).toFixed(2)}s: ${e.name}/${e.cause?.code ?? e.message} cause_msg="${e.cause?.message}"`);
  }
}
say('probe end');
writeFileSync(LOG, out.join('\n') + '\n');
