// BUILD Edit Protocol v1 — replay qualification (docs/specs/build-edit-protocol-v1.md §7(3)).
//
// Re-expresses the campaign's real BUILD outputs as anchored proposals and
// requires the staged bytes to equal the previously-recovered intent:
//
//   V9-1 / V9-3: the archived model patches (which FAILED publication on
//     count inflation / oldStart drift / whitespace truncation) are
//     super-normalized exactly as in evidence/v9-patch-replay (content-anchored
//     oldStarts, declared counts corrected, context whitespace restored from
//     the base) and applied with the frozen applyUnifiedDiff → finalA. The
//     SAME hunks are then re-expressed as anchored proposals (anchor = base
//     span, replacement = new-side lines) and staged through the real
//     build-changeset ActionContract → finalB. Qualification: finalB === finalA
//     byte-for-byte.
//   V11-3: the SLE-ARTIFACT new file (failure_payload.py) becomes a `creates`
//     entry; staged bytes must equal the artifact bytes.
//   V11-3 (bonus): its rejected patch is super-normalized the same way and
//     replayed through the anchored protocol.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyUnifiedDiff } from '/home/theo/Documents/coding/repos/stratum/src/patch.js';
import { AnchorRegistry } from '/home/theo/Documents/coding/repos/stratum/src/workflow/anchored-edits.js';
import {
  createBuildChangesetActionContract,
} from '/home/theo/Documents/coding/repos/stratum/src/workflow/methodology/build-changeset-contract.js';

const BASE = '/home/theo/Documents/coding/repos/student-platform/apps/ai-server/rag-worker-service/main.py';
const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const base = readFileSync(BASE, 'utf8');
const baseSha = sha256(base);
const baseLines = base.endsWith('\n') ? base.slice(0, -1).split('\n') : base.split('\n');

const RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NN = '\\ No newline at end of file';

function extractPatch(a: string): string {
  const raw = readFileSync(a, 'utf8');
  const s = raw.indexOf('<<<SLE-PATCH ');
  const oe = raw.indexOf('>>>', s);
  const e = raw.indexOf('<<<END-SLE-PATCH>>>', oe);
  return raw.slice(oe + 3, e).replace(/^\n/, '');
}

interface H { oldStart: number; newStart: number; dO: number; dN: number; body: string[]; anchored: number }
function parse(d: string): H[] {
  const lines = d.split('\n');
  const hunks: H[] = [];
  let i = 0;
  while (i < lines.length && !RE.test(lines[i])) i++;
  while (i < lines.length) {
    const m = lines[i].match(RE)!;
    const h: H = { oldStart: +m[1], newStart: +m[3], dO: 0, dN: 0, body: [], anchored: -1 };
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (RE.test(l)) break;
      if (l === NN) { h.body.push(l); i++; continue; }
      if (l === '') { h.body.push(l); h.dO++; h.dN++; i++; continue; }
      const t = l[0];
      if (t === ' ') { h.body.push(l); h.dO++; h.dN++; } else if (t === '-') { h.body.push(l); h.dO++; } else if (t === '+') { h.body.push(l); h.dN++; } else break;
      i++;
    }
    hunks.push(h);
  }
  return hunks;
}

// The v9-patch-replay super-normalization, verbatim in effect: content-anchored
// oldStarts + declared counts + base-derived whitespace restoration.
function superNormalize(name: string, patchPath: string): { norm: string; hunks: H[] } | null {
  const hunks = parse(extractPatch(patchPath));
  let cursor = 0;
  let restoreCount = 0;
  for (const h of hunks) {
    const firstOld = h.body.find((b) => b.startsWith(' ') || b.startsWith('-'))!.slice(1);
    let found = -1;
    for (let j = cursor; j < baseLines.length; j++) if (baseLines[j] === firstOld) { found = j; break; }
    if (found < 0) { console.log(`${name}: anchor failure after line ${cursor + 1}`); return null; }
    h.anchored = found + 1;
    cursor = found;
    let p = found;
    for (let i = 0; i < h.body.length; i++) {
      const b = h.body[i];
      if (b === NN) continue;
      if (b === '' || b === ' ') { h.body[i] = ' ' + baseLines[p]; restoreCount++; p++; }
      else if (b[0] === ' ' || b[0] === '-') p++;
    }
  }
  const out: string[] = [];
  for (const h of hunks) { out.push(`@@ -${h.anchored},${h.dO} +${h.newStart},${h.dN} @@`); out.push(...h.body); }
  const norm = out.join('\n') + '\n';
  console.log(`${name}: super-normalized (${restoreCount} whitespace restorations)`);
  return { norm, hunks };
}

// Anchored proposal from the normalized hunks — the model's INTENT, expressed
// the v1 way: reference base spans, supply new-side bytes only.
async function anchoredReplay(name: string, hunks: H[]): Promise<boolean> {
  const registry = new AnchorRegistry();
  const edits: Array<{ anchor_id: string; replacement: string }> = [];
  for (const h of hunks) {
    const oldLines = h.body.filter((b) => b !== NN && (b.startsWith(' ') || b.startsWith('-'))).map((b) => b.slice(1));
    const newLines = h.body.filter((b) => b !== NN && (b.startsWith(' ') || b.startsWith('+'))).map((b) => b.slice(1));
    if (oldLines.length !== h.dO || newLines.length !== h.dN) {
      console.log(`${name}: hunk extraction mismatch — FAIL`);
      return false;
    }
    const spanBase = baseLines.slice(h.anchored - 1, h.anchored - 1 + h.dO).join('\n');
    if (spanBase !== oldLines.join('\n')) {
      console.log(`${name}: hunk ${h.anchored} old-side does not match the base — FAIL`);
      return false;
    }
    const anchor = registry.mint({
      path: WORKER_PATH,
      base_sha256: baseSha,
      start_line: h.anchored,
      end_line: h.anchored + h.dO - 1,
      content_sha256: sha256(spanBase),
    });
    edits.push({ anchor_id: anchor.anchor_id, replacement: newLines.join('\n') });
  }
  const contract = createBuildChangesetActionContract();
  const validateDefects = contract.validate!({ edits, creates: [] }, {
    resolveAnchor: (id) => registry.resolve(id),
  });
  if (validateDefects.length > 0) {
    console.log(`${name}: validate defects: ${validateDefects.map((d) => d.code).join(', ')} — FAIL`);
    return false;
  }
  const outcome = await contract.stage({ edits, creates: [] }, {
    io: {
      readFile: async () => base,
      fileExists: async () => false,
    },
    resolveStageAnchor: (id) => registry.resolve(id),
  });
  if (!outcome.ok) {
    console.log(`${name}: stage failed: ${outcome.error} — FAIL`);
    return false;
  }
  const staged = outcome.changeset.edits.find((e) => e.path === WORKER_PATH);
  if (!staged) { console.log(`${name}: no staged edit for the worker file — FAIL`); return false; }
  return staged.content;
}

async function casePatch(name: string, patchPath: string): Promise<boolean> {
  const sup = superNormalize(name, patchPath);
  if (!sup) return false;
  let finalA: string;
  try {
    finalA = applyUnifiedDiff(base, sup.norm);
  } catch (err) {
    console.log(`${name}: super-normalized patch did not apply (${err instanceof Error ? err.message : String(err)}) — FAIL`);
    return false;
  }
  const finalB = await anchoredReplay(name, sup.hunks);
  if (typeof finalB !== 'string') return false;
  if (finalB === finalA) {
    console.log(`${name}: ANCHORED REPLAY MATCHES — ${Buffer.byteLength(finalA)} bytes, staged sha256 ${sha256(finalB).slice(0, 12)}… — PASS`);
    return true;
  }
  console.log(`${name}: BYTE MISMATCH (apply=${Buffer.byteLength(finalA)}B, anchored=${Buffer.byteLength(finalB)}B) — FAIL`);
  return false;
}

async function caseV11Create(): Promise<boolean> {
  const raw = readFileSync('/home/theo/Documents/coding/repos/pilot-a/evidence/v11-3/825e8cce-7cbe-4df1-a08a-51a5a1f70b0f/1/node-outputs/build.md', 'utf8');
  const s = raw.indexOf('<<<SLE-ARTIFACT path="');
  const oe = raw.indexOf('>>>', s);
  const pathStart = raw.indexOf('"', s) + 1;
  const pathEnd = raw.indexOf('"', pathStart);
  const artPath = raw.slice(pathStart, pathEnd);
  const e = raw.indexOf('<<<END-SLE-ARTIFACT>>>', oe);
  const content = raw.slice(oe + 3, e).replace(/^\n/, '').replace(/\n$/, '') + '\n';
  const registry = new AnchorRegistry();
  const contract = createBuildChangesetActionContract();
  const defects = contract.validate!({ edits: [], creates: [{ path: artPath, content }] }, { resolveAnchor: (id) => registry.resolve(id) });
  if (defects.length > 0) { console.log(`v11-3-create: validate defects — FAIL`); return false; }
  const outcome = await contract.stage({ edits: [], creates: [{ path: artPath, content }] }, {
    io: { readFile: async () => base, fileExists: async () => false },
    resolveStageAnchor: (id) => registry.resolve(id),
  });
  if (!outcome.ok) { console.log(`v11-3-create: stage failed — FAIL`); return false; }
  const staged = outcome.changeset.edits.find((e2) => e2.path === artPath);
  if (!staged) { console.log(`v11-3-create: not staged — FAIL`); return false; }
  if (staged.content === content) {
    console.log(`v11-3-create: staged bytes equal the SLE-ARTIFACT bytes (${Buffer.byteLength(content)} B) — PASS`);
    return true;
  }
  console.log(`v11-3-create: BYTE MISMATCH — FAIL`);
  return false;
}

let pass = 0, total = 0;
for (const [name, p] of [
  ['v9-1', '/home/theo/Documents/coding/repos/pilot-a/evidence/v9-1/d5993dc5-9562-4855-a929-0bcf04cbb0e1/1/node-outputs/build.md'],
  ['v9-3', '/home/theo/Documents/coding/repos/pilot-a/evidence/v9-3/cdfcab43-8917-462e-ba68-24f8a5ea2e1d/1/node-outputs/build.md'],
  ['v11-3-patch', '/home/theo/Documents/coding/repos/pilot-a/evidence/v11-3/825e8cce-7cbe-4df1-a08a-51a5a1f70b0f/1/node-outputs/build.md'],
] as const) {
  total++;
  if (await casePatch(name, p)) pass++;
}
total++;
if (await caseV11Create()) pass++;
console.log(`\nREPLAY QUALIFICATION: ${pass}/${total} cases passed`);
process.exit(pass === total ? 0 : 1);
