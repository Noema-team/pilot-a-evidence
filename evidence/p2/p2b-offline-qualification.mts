// P2-B OFFLINE QUALIFICATION — the P1-R archives as hard fixtures (zero model
// traffic). Operator requirements:
//   op2 archived proposal
//     → policy-specialized representation removes the illegal create
//     → boundary composition succeeds
//     → zero contract defects
//     → staged main.py bytes match the forensic mechanical merge
//   op3 archived proposal
//     → missing creates canonicalizes to []
//     → first and only remaining defect = unknown-anchor
//     → no other masked defect

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';

import { createBuildChangesetActionContract, BuildEditProposalSchema, BuildEditProposalNoCreatesSchema } from '/home/theo/Documents/coding/repos/stratum/src/workflow/methodology/build-changeset-contract.js';
import type { SourceAnchor } from '/home/theo/Documents/coding/repos/stratum/src/workflow/anchored-edits.js';

const contract = createBuildChangesetActionContract();
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const SP = '/home/theo/Documents/coding/repos/student-platform';
const WORKER = 'apps/ai-server/rag-worker-service/main.py';
const BASE = execSync(`git -C ${SP} show 86ec0871:${WORKER}`, { encoding: 'utf-8' });
const BASE_SHA = sha256(Buffer.from(BASE, 'utf-8').digest ? Buffer.from(BASE, 'utf-8') : Buffer.from(BASE, 'utf-8'));
const baseLines = BASE.split('\n');

function mint(start: number, end: number): SourceAnchor {
  const content = baseLines.slice(start - 1, end).join('\n');
  const csha = sha256(content);
  const anchor_id = 'src_' + createHash('sha256').update([WORKER, BASE_SHA, String(start), String(end), csha].join('\0'), 'utf8').digest('hex').slice(0, 16);
  return { anchor_id, path: WORKER, base_sha256: BASE_SHA, start_line: start, end_line: end, content_sha256: csha };
}

const anchors = new Map<string, SourceAnchor>();
for (const span of [[905, 1024], [1024, 1103], [30, 99]] as const) {
  const a = mint(span[0], span[1]);
  anchors.set(a.anchor_id, a);
}

// ═══ op2 (99100d24) ═══
console.log('── op2 fixture (p1-r-3/99100d24…) ──');
const op2Raw = JSON.parse(readFileSync('/home/theo/Documents/coding/repos/pilot-a/evidence/p1-r/p1-r-3/99100d24-2150-4380-925c-936eb4c82869/node-outputs/build-rejected-result.json', 'utf-8'));
assert.equal(op2Raw.creates.length, 1, 'op2 archive: one create');
assert.equal(op2Raw.creates[0].path, 'apps/ai-server/tests/integration/test_worker_failure_contract.py');

// (1) policy-specialized representation: under the frozen policy the wire
// surface has no create operation — the create cannot be expressed. Prove the
// narrowed schema rejects it (never silently discards):
const narrowed = BuildEditProposalNoCreatesSchema.safeParse(op2Raw);
assert.equal(narrowed.success, false);
assert.match(JSON.stringify((narrowed as any).error.issues), /Unrecognized key/);
console.log('  ✓ narrowed surface rejects the illegal create explicitly (unknown key) — not silently discarded');

// (2) the policy-legal form (creates structurally absent → canonical []):
const op2Canonical = BuildEditProposalSchema.parse({ edits: op2Raw.edits });
assert.deepEqual(op2Canonical.creates, []);
const ctx = { workItemId: 'wi-exec-108', resolveAnchor: (id: string) => anchors.get(id) };
const defects = contract.validate!(op2Canonical, ctx as never);
assert.deepEqual(defects.map((d) => d.code), [], `op2 must validate with ZERO defects under composition; got ${JSON.stringify(defects)}`);
console.log('  ✓ boundary composition succeeds — ZERO contract defects (the P1-R-3 blocking defect is gone)');

// (3) authoritative staging against a real tree; bytes must equal the forensic merge:
const root = mkdtempSync(join(tmpdir(), 'p2b-op2-'));
try {
  mkdirSync(join(root, 'apps/ai-server/rag-worker-service'), { recursive: true });
  writeFileSync(join(root, WORKER), BASE);
  const outcome = await contract.stage(op2Canonical, {
    workItemId: 'wi-exec-108',
    io: {
      readFile: async (p: string) => {
        assert.equal(p, WORKER);
        return BASE;
      },
      fileExists: async () => false,
    },
    resolveStageAnchor: (id: string) => anchors.get(id),
  } as never);
  assert.equal(outcome.ok, true, `stage failed: ${!outcome.ok && outcome.error}`);
  if (outcome.ok) {
    const staged = outcome.changeset.edits.find((e) => e.path === WORKER)!;
    // the forensic mechanical merge: [30,99] edit + A + B[1:] composed over [905,1103]
    const byId = (id: string) => op2Raw.edits.find((e: any) => e.anchor_id === id).replacement;
    const merged = byId(anchors.get(mint(905, 1024).anchor_id)!.anchor_id)
      + '\n' + byId(anchors.get(mint(1024, 1103).anchor_id)!.anchor_id).split('\n').slice(1).join('\n');
    const diskLines = BASE.split('\n');
    const expected = [
      ...diskLines.slice(0, 29).map((l, i) => (i >= 29 ? l : l)),
    ].join('\n');
    // apply [30,99] then the composed [905,1103] to the base, bottom-up:
    const splice = (text: string, start: number, end: number, replacement: string) => {
      const lines = text.split('\n');
      return lines.slice(0, start - 1).concat(replacement.split('\n')).concat(lines.slice(end)).join('\n');
    };
    const expectedBytes = splice(splice(BASE, 905, 1103, merged), 30, 99, byId(anchors.get(mint(30, 99).anchor_id)!.anchor_id));
    assert.equal(staged.content, expectedBytes);
    assert.deepEqual(staged.composed_from, [mint(905, 1024).anchor_id, mint(1024, 1103).anchor_id]);
    console.log(`  ✓ staged main.py bytes == forensic mechanical merge (${staged.content.length} B, sha256 ${sha256(staged.content).slice(0, 12)}…); composed_from recorded`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ═══ op3 (fb79af13) ═══
console.log('── op3 fixture (p1-r-5/fb79af13…) ──');
const op3Raw = JSON.parse(readFileSync('/home/theo/Documents/coding/repos/pilot-a/evidence/p1-r/p1-r-5/fb79af13-ac2c-4ff1-a871-0461fdef5da8/node-outputs/build-rejected-result.json', 'utf-8'));
assert.equal(op3Raw.creates, undefined, 'op3 archive: creates key absent');

// (1) missing creates canonicalizes to []:
const op3Canonical = BuildEditProposalSchema.parse(op3Raw);
assert.deepEqual(op3Canonical.creates, []);
console.log('  ✓ missing creates canonicalizes to []');

// (2) the FIRST and ONLY remaining defect is unknown-anchor (no masked defects):
const emptyCtx = { workItemId: 'wi-exec-108', resolveAnchor: () => undefined };
const op3Defects = contract.validate!(op3Canonical, emptyCtx as never);
assert.deepEqual(op3Defects.map((d) => d.code), ['unknown-anchor'], JSON.stringify(op3Defects));
assert.match(op3Defects[0].message, /cannot be repaired in this synthesis phase and must fail closed/);
console.log('  ✓ first and only defect = unknown-anchor (fabricated anchor), truthful instruction, nothing masked');

console.log('\nP2-B OFFLINE QUALIFICATION: ALL FIXTURE PINS PASS');
