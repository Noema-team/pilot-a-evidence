import { readFileSync } from 'node:fs';
import { applyUnifiedDiff, PatchApplyError } from '/home/theo/Documents/coding/repos/stratum/src/patch.js';
const BASE = '/home/theo/Documents/coding/repos/student-platform/apps/ai-server/rag-worker-service/main.py';
const base = readFileSync(BASE, 'utf8');
const baseLines = base.endsWith('\n') ? base.slice(0, -1).split('\n') : base.split('\n');
const RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NN = '\\ No newline at end of file';
function extract(a: string): string {
  const raw = readFileSync(a, 'utf8');
  const s = raw.indexOf('<<<SLE-PATCH '); const oe = raw.indexOf('>>>', s); const e = raw.indexOf('<<<END-SLE-PATCH>>>', oe);
  return raw.slice(oe + 3, e).replace(/^\n/, '');
}
interface H { oldStart: number; newStart: number; dO: number; dN: number; body: string[]; anchored: number; }
function parse(d: string): H[] {
  const lines = d.split('\n'); const hunks: H[] = []; let i = 0;
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
for (const [name, path] of [['v9-1', '/home/theo/Documents/coding/repos/pilot-a/evidence/v9-1/d5993dc5-9562-4855-a929-0bcf04cbb0e1/1/node-outputs/build.md'], ['v9-3', '/home/theo/Documents/coding/repos/pilot-a/evidence/v9-3/cdfcab43-8917-462e-ba68-24f8a5ea2e1d/1/node-outputs/build.md']] as const) {
  const hunks = parse(extract(path));
  // pass 1: anchor + whitespace restore
  let cursor = 0;
  let restoreCount = 0, drift = 0;
  for (const h of hunks) {
    const firstOld = h.body.find(b => b.startsWith(' ') || b.startsWith('-'))!.slice(1);
    let found = -1;
    for (let j = cursor; j < baseLines.length; j++) if (baseLines[j] === firstOld) { found = j; break; }
    if (found < 0) { console.log(`${name}: anchor failure after line ${cursor + 1}`); break; }
    h.anchored = found + 1;
    drift += Math.abs(found + 1 - h.oldStart);
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
  try { const r = applyUnifiedDiff(base, norm); console.log(`${name} SUPER-NORMALIZED (counts+anchors+${restoreCount} whitespace restorations, position drift total ${drift}): APPLIED — output ${Buffer.byteLength(r)} bytes`); }
  catch (e) { console.log(`${name} SUPER-NORMALIZED: ${e instanceof PatchApplyError ? e.message : String(e)}`); }
}
