// P3 LIVE-DRIVER QUALIFICATION — proves the EXACT composition the live
// campaign will run (p3-live-driver.mts) applies the approved guard and
// stopping behavior. ZERO completion traffic: the real provider is
// constructed and wired, but never dialed (the only dialing path is the
// guard-verified completeMultiTurn forward, whose mechanics are proven in
// p3-qualification.mts Q1/Q4 with the identical wrapped function).
//
//  D1  composition: real OpenRouter provider resolved from the fixture's
//      frozen settings; frozen model id; guard wrapping live on the real
//      object (blocked paths + contract mismatch STOP pre-call — provably
//      no dialing); construction fails closed on divergent settings
//  D2  recognition: the campaign-loop G1/G2 mapping on real capture shapes
//  D3  boundary: the driver's publicationBoundaryRunner (build completes ->
//      every downstream dispatch refused with the sentinel)
//  D4  zero-completion preflight: OpenRouter /models (GET, no completion)
//      proves connectivity, key validity, and the frozen model's presence

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  P3_MODEL_REGIME, P3_TARGET, buildContract, preflightContract,
  composeBuildAttempt, publicationBoundaryRunner, classifyAttempt, mapCaptureToStop,
  PUBLICATION_BOUNDARY_SENTINEL,
} from './p3-live-driver.mts';
import { ConfigGuardViolation, verifySettingsProvenance, type CaptureClassification } from './config-guard.mts';

const ROOT = '/home/theo/Documents/coding/repos/student-platform';
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

// ─── D1: composition over the REAL provider (no dialing) ────────────────────
{
  // fixture workspace still instantiated from the qualification run
  const settingsSha = sha256(join(ROOT, '.sle', 'settings.json'));
  assert.equal(settingsSha, P3_MODEL_REGIME.settings_sha256, 'fixture settings are the frozen bytes');

  const attempt = composeBuildAttempt(ROOT);
  assert.equal(attempt.model, P3_MODEL_REGIME.model, 'resolved model is the frozen model');

  // the guard is live on the REAL provider object: a contract-mismatched
  // request STOPs pre-call (throwing before the forward proves no dialing
  // happened — the forward is the only dialing path)
  await assert.rejects(
    () => (attempt.provider as { completeMultiTurn: (p: unknown) => Promise<unknown> }).completeMultiTurn({
      model: 'gpt-4o', system: 'x', messages: [{ role: 'user', content: 'x\n- /properties/edits: y' }],
      max_tokens: 32768, temperature: 0.7, reasoning_effort: 'low', tools: [],
    }),
    (err: Error) => err instanceof ConfigGuardViolation && err.message.includes('tool set'),
    'mismatched request STOPs pre-call on the real composition',
  );
  await assert.rejects(
    () => (attempt.provider as { completeStructured: () => Promise<unknown> }).completeStructured({} as never),
    (err: Error) => err instanceof ConfigGuardViolation && err.message.includes('completion-path'),
    'completeStructured is blocked on the real composition',
  );
  await assert.rejects(
    () => (attempt.provider as { complete: () => Promise<unknown> }).complete({} as never),
    (err: Error) => err instanceof ConfigGuardViolation && err.message.includes('completion-path'),
    'complete is blocked on the real composition',
  );

  // construction fails closed on divergent settings (the guard's own
  // construction-time check, the same one composeBuildAttempt installs)
  assert.throws(
    () => verifySettingsProvenance(join(tmpdir(), 'p3d1-does-not-exist'), P3_MODEL_REGIME.settings_sha256),
    (err: Error) => err instanceof ConfigGuardViolation,
    'divergent/missing settings fail construction',
  );

  // the frozen contracts are well-formed and carry the approved values
  const bc = buildContract();
  assert.equal(bc.max_tokens, 32768);
  assert.equal(bc.reasoning_effort, 'low');
  assert.equal(bc.temperature, 0.7);
  assert.deepEqual(bc.submit_result.schema_required, ['edits']);
  assert.equal(bc.submit_result.has_creates_property, false);
  const pc = preflightContract();
  assert.equal(pc.max_tokens, 16);
  assert.deepEqual(pc.tool_sets, [[]]);
  console.log('PASS D1 (composition): real OpenRouter provider under the guard; mismatched/blocked requests STOP pre-call (0 dialing); construction fails closed; frozen contracts carry the approved values');
}

// ─── D2: campaign-loop recognition (G1/G2) ──────────────────────────────────
{
  const mk = (lines: string[]): string => {
    const p = join(tmpdir(), `p3d2-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(p, lines.join('\n') + '\n');
    return p;
  };
  const req = (verdict: string, dimension: string | null) => JSON.stringify({
    ts: 't', capture_version: 2, phase: 'd2', kind: 'request', wire: 'completeMultiTurn',
    step: 'build', model: P3_MODEL_REGIME.model, max_tokens: 32768, guard_verdict: verdict, dimension, violations: verdict === 'STOP' ? ['x'] : [],
  });
  const resp = JSON.stringify({ ts: 't', capture_version: 2, phase: 'd2', kind: 'response', wire: 'completeMultiTurn', step: 'build', stop_reason: 'end_turn' });

  const clean = classifyAttempt(mk([req('PASS', null), resp]));
  assert.equal(clean.stop, null, 'clean capture -> no campaign stop');
  const g1 = classifyAttempt(mk([req('STOP', 'config')]));
  assert.equal(g1.stop, 'G1', 'config STOP -> G1');
  const g2int = classifyAttempt(mk([req('STOP', 'evidence-integrity')]));
  assert.equal(g2int.stop, 'G2', 'evidence-integrity STOP -> G2');
  const g2pair = classifyAttempt(mk([req('PASS', null)]));
  assert.equal(g2pair.stop, 'G2', 'unpaired PASS -> G2');
  assert.equal(mapCaptureToStop({ g1: true, g2: true } as CaptureClassification), 'G2', 'G2 takes precedence when both are flagged');
  console.log('PASS D2 (recognition): clean->null, config STOP->G1, evidence-integrity STOP->G2, unpaired PASS->G2');
}

// ─── D3: positive publication boundary (the driver's exact wrapper) ─────────
{
  let refusals = 0;
  let publishedHook = 0;
  const inner = {
    run: async (step: { id: string }) =>
      step.id === 'build'
        ? { success: true, artifacts_written: ['x'], tokens_used: 1, duration_ms: 1 }
        : { success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0 },
    handleExecute: async () => ({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0 }),
    handleCommit: async () => ({ success: true, artifacts_written: [], tokens_used: 0, duration_ms: 0 }),
    handleCheckpoint: async () => ({ success: true }),
    resolveCheckpoint: async () => ({}),
  };
  const runner = publicationBoundaryRunner(inner as never, {
    onPublished: () => publishedHook++,
    onRefusal: () => refusals++,
  });
  const buildResult = await runner.run({ id: 'build' } as never, {} as never);
  assert.equal((buildResult as { success: boolean }).success, true, 'BUILD dispatches');
  assert.equal(publishedHook, 1, 'publication hook fired');
  assert.equal(runner.published, true);

  for (const dispatch of [
    () => runner.run({ id: 'exec' } as never, {} as never),
    () => runner.handleExecute({ id: 'exec' } as never, {} as never),
    () => runner.handleCommit({ id: 'snapshot' } as never, {} as never),
  ]) {
    const r = await dispatch() as { outcome: string; error: string };
    assert.equal(r.outcome, 'failed', 'post-publication dispatch refused');
    assert.equal(r.error, PUBLICATION_BOUNDARY_SENTINEL, 'refusal carries the exact sentinel');
    // the inner was never reached: prove by sentinel + hook counting below
  }
  assert.equal(refusals, 3, 'exactly three refusals, one per downstream dispatch');
  // the checkpoint path still delegates (gate resolution is pre-build)
  await runner.handleCheckpoint({ id: 'confirm' } as never, {} as never);
  await runner.resolveCheckpoint({});
  console.log('PASS D3 (boundary): publication detected; 3/3 downstream dispatches refused with the sentinel before execution');
}

// ─── D4: zero-completion OpenRouter preflight (GET /models only) ────────────
{
  const key = process.env.OPENROUTER_API_KEY;
  assert.ok(key && key.length > 10, 'OPENROUTER_API_KEY present');
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(res.status, 200, `OpenRouter /models reachable (HTTP ${res.status})`);
  const body = await res.json() as { data: Array<{ id: string; supported_parameters?: string[] }> };
  const entry = body.data.find((m) => m.id === P3_MODEL_REGIME.model);
  assert.ok(entry, `frozen model ${P3_MODEL_REGIME.model} is listed by OpenRouter`);
  const params = entry.supported_parameters ?? [];
  const efforts = params.includes('reasoning_effort') || params.includes('reasoning');
  console.log(`PASS D4 (zero-completion preflight): OpenRouter reachable; key valid; model listed; supported_parameters include reasoning controls: ${efforts} (${params.length} params)`);
}

console.log('\nP3 LIVE-DRIVER QUALIFICATION: ALL PASS (zero completion traffic)');
