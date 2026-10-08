import { createBuildChangesetActionContract } from '/home/theo/Documents/coding/repos/stratum/src/workflow/methodology/build-changeset-contract.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const contract = createBuildChangesetActionContract();
const BASE = readFileSync('/tmp/opencode/base_main.py', 'utf-8');
const lines = BASE.split('\n');
const baseSha = createHash('sha256').update(Buffer.from(BASE, 'utf-8')).digest('hex');
const PATH = 'apps/ai-server/rag-worker-service/main.py';
const span = (s: number, e: number) => {
  const content = lines.slice(s - 1, e).join('\n');
  const csha = createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
  const id = 'src_' + createHash('sha256').update([PATH, baseSha, String(s), String(e), csha].join('\0'), 'utf8').digest('hex').slice(0, 16);
  return { anchor_id: id, path: PATH, base_sha256: baseSha, start_line: s, end_line: e, content_sha256: csha };
};
const a905 = span(905,1024), a1024 = span(1024,1103), a30 = span(30,99);
const minted = new Map([[a905.anchor_id, a905], [a1024.anchor_id, a1024], [a30.anchor_id, a30]]);
const ctx = { workItemId: 'wi-exec-108', resolveAnchor: (id: string) => minted.get(id) } as never;

const op2 = JSON.parse(readFileSync('/home/theo/Documents/coding/repos/pilot-a/evidence/p1-r/p1-r-3/99100d24-2150-4380-925c-936eb4c82869/node-outputs/build-rejected-result.json', 'utf-8'));
const op2NoCreate = { edits: op2.edits, creates: [] };
const d1 = contract.validate!(contract.modelSchema.parse(op2NoCreate), ctx);
console.log('op2 minus-create → defects:', JSON.stringify(d1.map(d => ({ code: d.code, ref: d.ref }))), '| schema-valid:', contract.modelSchema.safeParse(op2NoCreate).success);

const replA = op2.edits.find((e: any) => e.anchor_id === a905.anchor_id)!.replacement;
const replB = op2.edits.find((e: any) => e.anchor_id === a1024.anchor_id)!.replacement;
const merged = replA + '\n' + replB.split('\n').slice(1).join('\n');
const covering = span(905,1103);
const minted2 = new Map([[covering.anchor_id, covering], [a30.anchor_id, a30]]);
const ctx2 = { workItemId: 'wi-exec-108', resolveAnchor: (id: string) => minted2.get(id) } as never;
const third = op2.edits.find((e: any) => e.anchor_id === a30.anchor_id)!;
const op2Merged = { edits: [{ anchor_id: covering.anchor_id, replacement: merged }, third], creates: [] };
const d2 = contract.validate!(contract.modelSchema.parse(op2Merged), ctx2);
console.log('op2 merged-single-edit → defects:', JSON.stringify(d2.map(d => d.code)), '(validates clean if [])');
console.log('  merged repl bytes:', Buffer.byteLength(merged), '| corrected proposal bytes:', Buffer.byteLength(JSON.stringify(op2Merged)), '| original rejected bytes:', Buffer.byteLength(JSON.stringify(op2)));

const op3 = JSON.parse(readFileSync('/home/theo/Documents/coding/repos/pilot-a/evidence/p1-r/p1-r-5/fb79af13-ac2c-4ff1-a871-0461fdef5da8/node-outputs/build-rejected-result.json', 'utf-8'));
const op3Fixed = { edits: op3.edits, creates: [] };
const emptyCtx = { workItemId: 'wi-exec-108', resolveAnchor: () => undefined } as never;
const d3 = contract.validate!(contract.modelSchema.parse(op3Fixed), emptyCtx);
console.log('op3 +creates:[] → defects (anchor unresolved):', JSON.stringify(d3.map(d => ({ code: d.code, ref: (d.ref ?? '').slice(0, 24) }))));
console.log('  corrected proposal bytes:', Buffer.byteLength(JSON.stringify(op3Fixed)), '| original rejected bytes:', Buffer.byteLength(JSON.stringify(op3)));
