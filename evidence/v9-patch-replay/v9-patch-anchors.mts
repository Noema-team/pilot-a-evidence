import { readFileSync } from 'node:fs';
const base = readFileSync('/home/theo/Documents/coding/repos/student-platform/apps/ai-server/rag-worker-service/main.py', 'utf8');
const baseLines = base.endsWith('\n') ? base.slice(0, -1).split('\n') : base.split('\n');
const RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NN = '\\ No newline at end of file';
const raw = readFileSync('/home/theo/Documents/coding/repos/pilot-a/evidence/v9-1/d5993dc5-9562-4855-a929-0bcf04cbb0e1/1/node-outputs/build.md', 'utf8');
const s = raw.indexOf('<<<SLE-PATCH '); const oe = raw.indexOf('>>>', s); const e = raw.indexOf('<<<END-SLE-PATCH>>>', oe);
const diff = raw.slice(oe + 3, e).replace(/^\n/, '');
const lines = diff.split('\n');
let i = 0; while (i < lines.length && !RE.test(lines[i])) i++;
let cursor = 0; let hn = 0;
while (i < lines.length) {
  const m = lines[i].match(RE)!; hn++;
  const oc = m[2] === undefined ? 1 : +m[2], nc = m[4] === undefined ? 1 : +m[4];
  i++; let dO = 0, dN = 0; const body: string[] = [];
  while (i < lines.length) {
    const l = lines[i];
    if (RE.test(l)) break;
    if (l === NN) { body.push(l); i++; continue; }
    if (l === '') { body.push(l); dO++; dN++; i++; continue; }
    const t = l[0];
    if (t === ' ') { body.push(l); dO++; dN++; } else if (t === '-') { body.push(l); dO++; } else if (t === '+') { body.push(l); dN++; } else break;
    i++;
  }
  const firstOld = body.find(b => b.startsWith(' ') || b.startsWith('-'))?.slice(1);
  let found = -1;
  if (firstOld !== undefined) for (let j = cursor; j < baseLines.length; j++) if (baseLines[j] === firstOld) { found = j + 1; break; }
  if (found >= 1) cursor = found - 1 + dO;
  console.log(`hunk ${hn}: declared oldStart=${+m[1]} content-true=${found >= 1 ? found : 'NOT FOUND'} drift=${found >= 1 ? found - +m[1] : 'n/a'} | counts declared -${oc},+${nc} derived -${dO},+${dN}`);
}
