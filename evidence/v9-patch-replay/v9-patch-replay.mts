
// V9 counterfactual replay — frozen diagnostic, offline only.
// Recovers the exact rejected SLE-PATCH diffs from the V9-1/V9-3 archives,
// derives hunk old/new counts mechanically from each hunk body, rewrites ONLY
// the count fields, and applies both original and normalized diffs through
// the real frozen applyUnifiedDiff against the byte-verified pinned base.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyUnifiedDiff, PatchApplyError } from '/home/theo/Documents/coding/repos/stratum/src/patch.js';

const BASE = '/home/theo/Documents/coding/repos/student-platform/apps/ai-server/rag-worker-service/main.py';
const PINNED = '7d7718bcbeb2e219dab14e285a66e62ea5883c209981a0be91cc29b490569988';
const RECORDED = {
  'v9-1': "Malformed diff line 19 (expected ' ', '-', or '+'): '@@ -989,6 +993,7 @@'",
  'v9-3': "Malformed hunk header at diff line 21: '             # Step 5: Generate Embeddings'",
};
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

function extractPatch(archive: string): string {
  const raw = readFileSync(archive, 'utf8');
  const start = raw.indexOf('<<<SLE-PATCH ');
  const openEnd = raw.indexOf('>>>', start);
  const end = raw.indexOf('<<<END-SLE-PATCH>>>', openEnd);
  if (start < 0 || openEnd < 0 || end < 0) throw new Error('markers not found');
  return raw.slice(openEnd + 3, end).replace(/^\n/, '');
}

function isHunkHeader(line: string): boolean { return HUNK_HEADER_RE.test(line); }

interface Derived { oldStart: number; oldCount: number; newStart: number; newCount: number;
  derivedOld: number; derivedNew: number; bodyLines: string[]; headerLine: string; }

function deriveHunks(diff: string): Derived[] {
  const lines = diff.split('\n');
  const hunks: Derived[] = [];
  let i = 0;
  while (i < lines.length && !isHunkHeader(lines[i])) { i++; } // skip file headers / blanks
  while (i < lines.length) {
    const m = lines[i].match(HUNK_HEADER_RE)!;
    const hunk: Derived = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2],
      newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4],
      derivedOld: 0, derivedNew: 0, bodyLines: [], headerLine: lines[i] };
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (isHunkHeader(line)) break;
      if (line === NO_NEWLINE_MARKER) { hunk.bodyLines.push(line); i++; continue; } // marker: not counted
      if (line === '') { hunk.bodyLines.push(line); hunk.derivedOld++; hunk.derivedNew++; i++; continue; }
      const tag = line.charAt(0);
      if (tag === ' ') { hunk.bodyLines.push(line); hunk.derivedOld++; hunk.derivedNew++; }
      else if (tag === '-') { hunk.bodyLines.push(line); hunk.derivedOld++; }
      else if (tag === '+') { hunk.bodyLines.push(line); hunk.derivedNew++; }
      else break; // not body content — structural anomaly; stop this hunk's body
      i++;
    }
    hunks.push(hunk);
  }
  return hunks;
}

function normalizeCounts(diff: string, hunks: Derived[]): string {
  const out: string[] = [];
  const lines = diff.split('\n');
  let i = 0;
  while (i < lines.length && !isHunkHeader(lines[i])) { out.push(lines[i]); i++; }
  for (const h of hunks) {
    const m = h.headerLine.match(HUNK_HEADER_RE)!;
    const oldStart = m[1], oc = m[2] === undefined ? '' : `,${h.derivedOld}`;
    const newStart = m[3], nc = m[4] === undefined ? '' : `,${h.derivedNew}`;
    const suffix = h.headerLine.slice(m[0].length); // preserve any trailing context text
    out.push(`@@ -${oldStart}${oc} +${newStart}${nc} @@${suffix}`);
    i++; // consume original header line
    for (const b of h.bodyLines) { out.push(b); i++; }
  }
  while (i < lines.length) { out.push(lines[i]); i++; }
  return out.join('\n');
}

const base = readFileSync(BASE, 'utf8');
const baseSha = createHash('sha256').update(base).digest('hex');
console.log(`base sha256: ${baseSha}`);
if (baseSha !== PINNED) throw new Error('BASE PIN MISMATCH');

for (const run of ['v9-1', 'v9-3'] as const) {
  const archive = run === 'v9-1'
    ? '/home/theo/Documents/coding/repos/pilot-a/evidence/v9-1/d5993dc5-9562-4855-a929-0bcf04cbb0e1/1/node-outputs/build.md'
    : '/home/theo/Documents/coding/repos/pilot-a/evidence/v9-3/cdfcab43-8917-462e-ba68-24f8a5ea2e1d/1/node-outputs/build.md';
  console.log(`\n===== ${run} =====`);
  const diff = extractPatch(archive);
  const sha = createHash('sha256').update(diff).digest('hex');
  console.log(`patch bytes: ${Buffer.byteLength(diff)} | patch sha256: ${sha.slice(0, 16)} | hunks: ${(diff.match(/@@/g) ?? []).length ? deriveHunks(diff).length : 0}`);

  // Step A — reproduce the recorded rejection through the real frozen applier.
  let originalError = 'APPLIED (unexpected)';
  try { applyUnifiedDiff(base, diff); } catch (e) { originalError = e instanceof PatchApplyError ? e.message : String(e); }
  const fidelity = originalError === RECORDED[run] ? 'EXACT MATCH with recorded run error' : 'DIVERGENT from recorded error';
  console.log(`original apply: PatchApplyError: ${originalError}`);
  console.log(`fidelity: ${fidelity}`);

  // Step B — mechanical count derivation + evidence.
  const hunks = deriveHunks(diff);
  let anyNormalized = false;
  for (const [idx, h] of hunks.entries()) {
    const norm = h.derivedOld !== h.oldCount || h.derivedNew !== h.newCount;
    if (norm) anyNormalized = true;
    console.log(`  hunk ${idx + 1}: declared -${h.oldCount},+${h.newCount} → derived -${h.derivedOld},+${h.derivedNew}${norm ? '  NORMALIZED' : '  (correct)'}`);
  }

  // Step C — apply the count-normalized diff (ALL other bytes identical).
  const normalized = normalizeCounts(diff, hunks);
  const normBodyDelta = Buffer.byteLength(diff) - Buffer.byteLength(normalized);
  let normResult = 'APPLIED';
  try { applyUnifiedDiff(base, normalized); } catch (e) { normResult = e instanceof PatchApplyError ? e.message : String(e); }
  console.log(`normalized apply: ${normResult}`);
  if (normResult === 'APPLIED') {
    const patched = applyUnifiedDiff(base, normalized);
    const psha = createHash('sha256').update(patched).digest('hex');
    writeFileSync(`/tmp/opencode/v9-replay-${run}-patched.py`, patched);
    console.log(`patched output: ${Buffer.byteLength(patched)} bytes | sha256 ${psha.slice(0, 16)} (saved to /tmp/opencode, repo untouched)`);
  }
  console.log(`summary: hunks=${hunks.length} anyCountNormalized=${anyNormalized} normalizedByteDelta=${-normBodyDelta} replay=${normResult === 'APPLIED' ? 'SUCCESS' : 'STILL FAILS'}`);
}
