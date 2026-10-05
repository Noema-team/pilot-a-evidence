// Campaign-only reasoning-capability preflight: every configured reasoning
// effort MUST appear in the model's live declared supported_efforts.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const meta = JSON.parse(readFileSync('/home/theo/Documents/coding/repos/pilot-a/evidence/v11-model-metadata.json', 'utf8'));
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const supported = meta.supported_efforts;
if (!Array.isArray(supported) || supported.length === 0) throw new Error('metadata snapshot lacks supported_efforts');
const configured = Object.entries(cfg.workflow_reasoning_effort ?? {});
let ok = true;
for (const [step, effort] of configured) {
  const pass = supported.includes(effort);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${step}: effort "${effort}" ${pass ? 'is' : 'is NOT'} in supported_efforts ${JSON.stringify(supported)}`);
}
if (configured.length === 0) { console.log('NOTE: no reasoning efforts configured'); }
console.log(`metadata snapshot: ${meta.model_id} sha256 ${createHash('sha256').update(JSON.stringify(meta)).digest('hex').slice(0,16)} default_effort=${meta.default_effort}`);
console.log(ok && configured.length > 0 ? 'CAPABILITY PREFLIGHT: ALL CONFIGURED EFFORTS SUPPORTED' : 'CAPABILITY PREFLIGHT: FAILURE');
if (!ok) process.exit(1);
