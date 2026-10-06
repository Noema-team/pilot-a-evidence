// Collision semantics of the FROZEN mint (8138e564) — fault-injection proof.
// The id is src_+16hex of sha256(binding); a genuine cross-binding collision
// is ~2^-64, so the collision PATH is exercised by pre-registering a foreign
// record under a computed id and then minting the colliding binding through
// the production code path.
import { AnchorRegistry, mintAnchorId } from '/home/theo/Documents/coding/repos/stratum/src/workflow/anchored-edits.js';
import { createHash } from 'node:crypto';
const H = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const bindingA = { path: 'apps/x/main.py', base_sha256: H('A'), start_line: 10, end_line: 12, content_sha256: H('l1\nl2\nl3') };
const reg = new AnchorRegistry();
const a1 = reg.mint(bindingA);
const a2 = reg.mint({ ...bindingA }); // identical binding re-minted
console.log('1. identical binding minted twice ->', a1 === a2 ? 'SAME anchor object (harmless dedupe)' : 'DIFFERENT (bad)');

// craft bindingB: different binding whose DERIVED id equals bindingA's id is
// not constructible without a real collision, so inject the foreign record
// under bindingB's real derived id, then mint bindingB — this drives the same
// byId.get(id) branch mint uses on a genuine collision.
const bindingB = { path: 'apps/x/other.py', base_sha256: H('B'), start_line: 500, end_line: 502, content_sha256: H('z1\nz2\nz3') };
const idB = mintAnchorId(bindingB);
(reg as unknown as { byId: Map<string, unknown> }).byId.set(idB, { ...bindingA, anchor_id: idB }); // foreign record under B's id
const returned = reg.mint(bindingB);
console.log('2. different binding whose id is already registered ->');
console.log('   mint returned record:', JSON.stringify(returned));
console.log('   FAIL-CLOSED?', returned.path === bindingB.path ? 'YES (kept B binding)' : 'NO — returned the FIRST-registered record (authority follows the truncated id, not the binding)');
console.log('3. resolve(idB) ->', JSON.stringify(reg.resolve(idB)));
