
// EXTENSION DIAGNOSTICS — characterization only, beyond the frozen protocol.
// D1 (v9-3): sequential oldStart re-derivation after count normalization.
// D2 (v9-1): restore the single whitespace-truncated context line + counts.
// Neither is a mechanism proposal; both fields are "never correct" in the
// draft canonicalizer contract — this only bounds the residual defect depth.
import { readFileSync } from 'node:fs';
import { applyUnifiedDiff, PatchApplyError } from '/home/theo/Documents/coding/repos/stratum/src/patch.js';

const BASE = '/home/theo/Documents/coding/repos/student-platform/apps/ai-server/rag-worker-service/main.py';
const base = readFileSync(BASE, 'utf8');
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NN = '\\ No newline at end of file';

function extractPatch(archive: string): string {
  const raw = readFileSync(archive, 'utf8');
  const start = raw.indexOf('<<<SLE-PATCH ');
  const openEnd = raw.indexOf('>>>', start);
  const end = raw.indexOf('<<<END-SLE-PATCH>>>', openEnd);
  return raw.slice(openEnd + 3, end).replace(/^\n/, '');
}
interface H { oldStart: number; oldCount: number; newStart: number; newCount: number;
  dO: number; dN: number; body: string[]; header: string; }
function parse(diff: string): H[] {
  const lines = diff.split('\n'); const hunks: H[] = []; let i = 0;
  while (i < lines.length && !HUNK_HEADER_RE.test(lines[i])) i++;
  while (i < lines.length) {
    const m = lines[i].match(HUNK_HEADER_RE)!;
    const h: H = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3],
      newCount: m[4] === undefined ? 1 : +m[4], dO: 0, dN: 0, body: [], header: lines[i] };
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (HUNK_HEADER_RE.test(l)) break;
      if (l === NN) { h.body.push(l); i++; continue; }
      if (l === '') { h.body.push(l); h.dO++; h.dN++; i++; continue; }
      const t = l[0];
      if (t === ' ') { h.body.push(l); h.dO++; h.dN++; }
      else if (t === '-') { h.body.push(l); h.dO++; }
      else if (t === '+') { h.body.push(l); h.dN++; }
      else break;
      i++;
    }
    hunks.push(h); i;
  }
  return hunks;
}
function rebuild(hunks: H[]): string {
  const out: string[] = [];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.dO} +${h.newStart},${h.dN} @@`);
    for (const b of h.body) out.push(b);
  }
  return out.join('\n') + '\n';
}
function tryApply(label: string, diff: string): void {
  try { applyUnifiedDiff(base, diff); console.log(`${label}: APPLIED`); }
  catch (e) { console.log(`${label}: ${e instanceof PatchApplyError ? e.message : String(e)}`); }
}

// D1 — v9-3: counts normalized AND oldStarts re-derived sequentially (anchor hunk 1's verified oldStart 87).
console.log('D1 v9-3 — counts + sequential oldStart (hunk1 anchor preserved):');
{
  const hunks = parse(extractPatch('/home/theo/Documents/coding/repos/pilot-a/evidence/v9-3/cdfcab43-8917-462e-ba68-24f8a5ea2e1d/1/node-outputs/build.md'));
  let pos = hunks[0].oldStart;
  for (const h of hunks) { h.oldStart = pos; pos += h.dO; }
  tryApply('D1', rebuild(hunks));
}

// D2 — v9-1: counts normalized AND hunk 4's bare-empty context line restored to the true 12-space line.
console.log('D2 v9-1 — counts + single context line restored to base bytes (line 996 = 12 spaces):');
{
  const hunks = parse(extractPatch('/home/theo/Documents/coding/repos/pilot-a/evidence/v9-1/d5993dc5-9562-4855-a929-0bcf04cbb0e1/1/node-outputs/build.md'));
  for (const h of hunks) {
    for (let i = 0; i < h.body.length; i++) {
      if (h.body[i] === '') h.body[i] = ' '; // context tag + empty body → becomes ' ' + 12 spaces below
      if (h.body[i] === ' ') { /* bare tag = empty context; we instead set full: */ }
    }
  }
  // precise fix: only hunk 4 (index 3) has the offending bare-empty context line
  const h4 = hunks[3];
  h4.body = h4.body.map(b => b === '' ? ' ' + '            '.slice(0) : b);
  tryApply('D2', rebuild(hunks));
}
