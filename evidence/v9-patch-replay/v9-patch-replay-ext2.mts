
// EXTENSION DIAGNOSTICS v2 — characterization only.
// D1 (v9-3): per-hunk declared oldStart vs content-true position (exact first-old-line anchor scan past previous hunk).
// D2 (v9-1): counts + restore EVERY bare-empty context line to base bytes, iteratively until a non-empty-line error or success.
import { readFileSync } from 'node:fs';
import { applyUnifiedDiff, PatchApplyError } from '/home/theo/Documents/coding/repos/stratum/src/patch.js';

const BASE = '/home/theo/Documents/coding/repos/student-platform/apps/ai-server/rag-worker-service/main.py';
const base = readFileSync(BASE, 'utf8');
const baseLines = base.endsWith('\n') ? base.slice(0, -1).split('\n') : base.split('\n');
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NN = '\\ No newline at end of file';

function extractPatch(archive: string): string {
  const raw = readFileSync(archive, 'utf8');
  const s = raw.indexOf('<<<SLE-PATCH '); const oe = raw.indexOf('>>>', s); const e = raw.indexOf('<<<END-SLE-PATCH>>>', oe);
  return raw.slice(oe + 3, e).replace(/^\n/, '');
}
interface H { oldStart: number; oldCount: number; newStart: number; newCount: number; dO: number; dN: number; body: string[]; }
function parse(diff: string): H[] {
  const lines = diff.split('\n'); const hunks: H[] = []; let i = 0;
  while (i < lines.length && !HUNK_HEADER_RE.test(lines[i])) i++;
  while (i < lines.length) {
    const m = lines[i].match(HUNK_HEADER_RE)!;
    const h: H = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], dO: 0, dN: 0, body: [] };
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (HUNK_HEADER_RE.test(l)) break;
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
function rebuild(hunks: H[]): string {
  return hunks.map(h => `@@ -${h.oldStart},${h.dO} +${h.newStart},${h.dN} @@\n` + h.body.join('\n')).join('\n') + '\n';
}
function tryApply(label: string, diff: string): string {
  try { applyUnifiedDiff(base, diff); console.log(`${label}: APPLIED`); return 'APPLIED'; }
  catch (e) { const m = e instanceof PatchApplyError ? e.message : String(e); console.log(`${label}: ${m}`); return m; }
}

// ---- D1: v9-3 declared vs content-true hunk positions ----
console.log('D1 v9-3 — declared oldStart vs exact content-anchored position:');
{
  const hunks = parse(extractPatch('/home/theo/Documents/coding/repos/pilot-a/evidence/v9-3/cdfcab43-8917-462e-ba68-24f8a5ea2e1d/1/node-outputs/build.md'));
  let cursor = 0;
  for (const [idx, h] of hunks.entries()) {
    const firstOld = h.body.find(b => b.startsWith(' ') || b.startsWith('-'))?.slice(1);
    let found = -1;
    if (firstOld !== undefined) {
      for (let j = cursor; j < baseLines.length; j++) {
        if (baseLines[j] === firstOld) { found = j + 1; break; }
      }
      if (found >= 1) cursor = found - 1 + h.dO;
    }
    console.log(`  hunk ${idx + 1}: declared oldStart=${h.oldStart} content-true=${found >= 1 ? found : 'NOT FOUND'} drift=${found >= 1 ? found - h.oldStart : 'n/a'}`);
  }
}

// ---- D2: v9-1 restore all bare-empty context lines, iterate ----
console.log('D2 v9-1 — counts + empty-context-line restoration (iterative):');
{
  const hunks = parse(extractPatch('/home/theo/Documents/coding/repos/pilot-a/evidence/v9-1/d5993dc5-9562-4855-a929-0bcf04cbb0e1/1/node-outputs/build.md'));
  let round = 0;
  for (;;) {
    round++;
    const err = tryApply(`  attempt ${round}`, rebuild(hunks));
    const m = err.match(/Hunk (\d+) does not apply: original line (\d+) is '(.*)' but the patch expects '(.*)'/);
    if (!m) break;
    const hunk = hunks[+m[1] - 1];
    const expectedEmpty = m[4] === '';
    const trueLine = baseLines[+m[2] - 1];
    if (!expectedEmpty) { console.log(`  → residual is NOT an empty-context defect; stopping`); break; }
    // find the bare-empty line in this hunk's body and restore it to tag+trueLine
    const bi = hunk.body.findIndex(b => b === '' || b === ' ');
    if (bi < 0) { console.log(`  → no bare-empty line left in hunk ${m[1]}; stopping`); break; }
    hunk.body[bi] = ' ' + trueLine;
    console.log(`  restored hunk ${m[1]} empty context → ${JSON.stringify(trueLine)}`);
    if (round > 20) break;
  }
}
