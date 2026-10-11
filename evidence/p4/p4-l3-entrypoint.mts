// P4 L3 PRODUCTION ENTRYPOINT — the preregistered scientific campaign.
//
// This is the ONLY launch surface for P4 L3. Everything the freeze fixes is
// hardcoded here; there are NO test-only overrides on this surface:
//   - NO scripted/calibration providers, NO calibration shapes, NO attempt or
//     launch-index overrides, NO drive hooks, NO env-var knobs for treatment.
//   - provider/model/settings: the frozen settings file, sha-checked against
//     the published constant (refuses to launch on any mismatch).
//   - task: the frozen target repository and its frozen workflow (the
//     campaign machinery owns it; nothing here can alter it).
//   - step shapes: the published pins (evidence/p4/p4-step-shapes.json);
//     a missing or unloadable pins file refuses the launch.
//   - N = 3 attempts, threshold >= 2/3 READY (the preregistered terminal
//     condition, evaluated over the durable ledger count).
//   - stop rules: exactly those implemented by runP4Campaign — guard-stop
//     (fail-closed request validation), authority-bypass, ledger-conflict,
//     target-not-pristine, budget exhaustion (NOT-READY, never STOP),
//     sticky procedure-class STOP, and the launch cap. Re-invoking this
//     entrypoint RESUMES from the ledger (counted slots are reconstructed,
//     never re-executed, never double-counted; every reconstructed slot
//     requires a non-null, verifiable package identity).
//
// Evidence namespace: evidence/p4/l3-campaign/ (the L3 campaign proper).
//
// Usage: npx tsx evidence/p4/p4-l3-entrypoint.mts   (from the stratum repo)
// Exit code 0 = campaign reached its terminal condition (the SCIENTIFIC
// result — supported or not — is in the ledger and the evidence packages,
// not the exit code); 1 = refused, stopped, or interrupted.

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runP4Campaign, targetPristine, MAX_ATTEMPTS, READY_THRESHOLD } from './p4-campaign.mts';
import { loadFrozenSettings, loadPinnedShapes, FROZEN_SETTINGS_PATH, FROZEN_SETTINGS_SHA256 } from './p4-step-contracts.mts';

const EVIDENCE = '/home/theo/Documents/coding/repos/pilot-a/evidence';
const L3_DIR = `${EVIDENCE}/p4/l3-campaign`;
const SHAPES_PATH = `${EVIDENCE}/p4/p4-step-shapes.json`;
const STRATUM = '/home/theo/Documents/coding/repos/stratum';

async function main(): Promise<void> {
  console.log(`=== P4 L3 production campaign (N=${MAX_ATTEMPTS}, threshold >=${READY_THRESHOLD}/${MAX_ATTEMPTS}) ===`);

  // ── fail-closed preconditions (fixed, no overrides) ────────────────────────
  if (!targetPristine()) throw new Error('target worktree not pristine — L3 refuses to launch');
  const frozen = loadFrozenSettings(); // verifies the settings sha; throws on drift
  const raw = JSON.parse(readFileSync(FROZEN_SETTINGS_PATH, 'utf-8')) as { provider: string; model: string; base_url?: string; api_key_env?: string };
  const keyEnv = raw.api_key_env ?? 'OPENROUTER_API_KEY';
  if (!process.env[keyEnv]) throw new Error(`${keyEnv} not present — L3 refuses to launch`);
  if (!existsSync(SHAPES_PATH)) throw new Error(`pinned step shapes not found (${SHAPES_PATH}) — L3 refuses to launch`);
  const shapes = loadPinnedShapes(SHAPES_PATH);
  mkdirSync(L3_DIR, { recursive: true });

  // ── the frozen production composition: createLLMProvider(openrouter) ->
  //    P4 guarded transport (applied inside the campaign/attempt machinery)
  //    -> engine. The SAME instance serves every launch (the guard is
  //    stateless; per-attempt state lives in the campaign ledger).
  const { createLLMProvider } = await import(`${STRATUM}/src/llm-provider.js`);
  const realProvider = createLLMProvider({
    provider: raw.provider, model: raw.model,
    base_url: raw.base_url, api_key_env: keyEnv,
  } as never);

  const result = await runP4Campaign({
    evidenceDir: L3_DIR,
    shapes,
    innerProviderFactory: () => realProvider,
    maxAttempts: MAX_ATTEMPTS, // N = 3 (preregistered; NOT configurable here)
    readyThreshold: READY_THRESHOLD, // >= 2/3 (preregistered; NOT configurable here)
  });

  console.log(`terminal: ${result.terminal}`);
  console.log(`result: ready=${result.readyCount}/${result.evaluableCount} supported=${String(result.supported)}`);
  console.log(`evidence: ${L3_DIR} (launchId ${result.launchId})`);
  if (!result.terminal.startsWith('complete')) {
    console.error('L3 did NOT reach its preregistered terminal condition — inspect the ledger and evidence before any further action');
    process.exit(1);
  }
}

// IMPORT-SAFE: executes only when invoked directly (same discipline as the
// corrected L2 module — importing this file is a no-op).
const INVOKED_DIRECTLY = typeof process.argv[1] === 'string'
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (INVOKED_DIRECTLY) main().catch((e) => { console.error('L3 fatal:', e); process.exit(1); });
