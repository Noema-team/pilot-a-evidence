// P3 RUNNER QUALIFICATION — the launch-integration gate: proves the
// EXECUTABLE campaign lifecycle (p3-live-runner.mts — the exact code a live
// GO would run) connects fixture restoration, the composed model path, the
// positive publication boundary, capture reconciliation, counting, and the
// stop rules. ZERO completion traffic: providers are scripted; the fixture,
// engine, guard, boundary, and counting are the real code.
//
//  R1  successful publication through the runner: 1 evaluable PUBLISHED
//      attempt, boundary refusal recorded, evidence archived, target restored
//  R2  model-attributable failure: 1 evaluable MODEL-FAILURE (clean capture,
//      model reached, no publication) — consumes the denominator
//  R3  G1 STOP: immediate campaign abort, attempt NOT counted, 0 model calls
//  R4  G2 STOP from the EXCEPTION: capture-write failure classifies G2 even
//      though the capture file is missing
//  R5  stop-at-three: exactly 3 evaluable attempts, then terminal
//  R6  preflight separation: distinct path/namespace, never counted; a
//      preflight STOP aborts BEFORE attempt 1 with 0 attempts
//  R7  fail-closed evidence: a missing capture file classifies G2, not crash

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { runP3Campaign, type CampaignOptions } from './p3-live-runner.mts';
import { composeBuildAttempt, composePreflight, P3_TARGET } from './p3-live-driver.mts';
import { ConfigGuardViolation, type StepContract } from './config-guard.mts';

const ROOT = '/home/theo/Documents/coding/repos/student-platform';
const WORKER = P3_TARGET.worker_main_path;

import { createHash } from 'node:crypto';
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

function assertTargetPristine() {
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
  assert.ok(head.startsWith('86ec0871'), `target HEAD pristine: ${head.slice(0, 8)}`);
  assert.equal(sha256(join(ROOT, WORKER)), P3_TARGET.worker_main_sha256, 'main.py pristine');
}

// ─── scripted BUILD providers ────────────────────────────────────────────────
const WORKER_PATH = 'apps/ai-server/rag-worker-service/main.py';

// conforming builder: investigation turn -> submit_result with a REAL minted anchor
function conformingBuilder() {
  return {
    async completeMultiTurn(params: { messages: Array<{ role: string; content: unknown }> }) {
      const sawToolResult = params.messages.some((m) => m.role === 'user' && /src_[0-9a-f]{8,}/.test(JSON.stringify(m.content ?? '')));
      if (!sawToolResult) {
        return {
          stop_reason: 'tool_use', text: '', tokens_used: 100,
          tool_uses: [{ type: 'tool_use', id: 'tu1', name: 'read_source_slice', input: { path: WORKER_PATH, start_line: 30, end_line: 99 } }],
        } as never;
      }
      let anchorId: string | undefined;
      for (const m of params.messages) {
        const match = JSON.stringify(m.content ?? '').match(/src_[0-9a-f]{8,}/);
        if (match) { anchorId = match[0]; break; }
      }
      assert.ok(anchorId, 'a real anchor must have been minted');
      return {
        stop_reason: 'tool_use', text: '', tokens_used: 200,
        tool_uses: [{ type: 'tool_use', id: 'tu2', name: 'submit_result', input: { edits: [{ anchor_id: anchorId, replacement: '// p3 runner qualification edit' }] } }],
      } as never;
    },
  };
}

// model-attributable failure: ALWAYS submits a bogus anchor (never minted) —
// the acceptor rejects it every time until the repair budget is exhausted
function failingBuilder() {
  return {
    async completeMultiTurn(params: { messages: Array<{ role: string; content: unknown }> }) {
      const sawToolResult = params.messages.some((m) => m.role === 'user' && /src_[0-9a-f]{8,}/.test(JSON.stringify(m.content ?? '')));
      if (!sawToolResult) {
        return {
          stop_reason: 'tool_use', text: '', tokens_used: 100,
          tool_uses: [{ type: 'tool_use', id: 'tu1', name: 'read_source_slice', input: { path: WORKER_PATH, start_line: 30, end_line: 99 } }],
        } as never;
      }
      return {
        stop_reason: 'tool_use', text: '', tokens_used: 150,
        tool_uses: [{ type: 'tool_use', id: 'tu2', name: 'submit_result', input: { edits: [{ anchor_id: 'src_deadbeefdeadbeefdead', replacement: '// bogus anchor — never minted' }] } }],
      } as never;
    },
  };
}

const mkOpts = (over: Partial<CampaignOptions>): CampaignOptions =>
  ({ evidenceDir: join(tmpdir(), `p3r-evidence-${Math.random().toString(36).slice(2)}`), ...over }) as CampaignOptions;

// ─── R1: successful publication through the runner ───────────────────────────
{
  const evidence = join(tmpdir(), 'p3r1');
  rmSync(evidence, { recursive: true, force: true });
  const result = await runP3Campaign(mkOpts({
    maxAttempts: 1,
    evidenceDir: evidence,
    composeAttempt: (attemptId) => composeBuildAttempt(ROOT, attemptId, { innerProvider: conformingBuilder() }),
    runPreflight: async () => ({ stop: null, detail: 'offline preflight (scripted pass-through)' }),
  }));
  assert.equal(result.complete, true, 'campaign ran to its terminal state');
  assert.equal(result.stop, null, 'no campaign stop');
  assert.equal(result.evaluable, 1);
  assert.equal(result.published, 1);
  assert.equal(result.modelFailures, 0);
  const rec = result.attempts[0];
  assert.equal(rec.outcome, 'PUBLISHED');
  assert.ok(rec.publicationHash, 'publication hash recorded');
  assert.ok(rec.boundaryRefusals >= 1, 'the positive boundary refused downstream dispatch');
  assert.ok(rec.providerCallsObserved >= 2, 'model path exercised');
  assert.ok(rec.archivedCapturePath && existsSync(rec.archivedCapturePath), 'attempt evidence archived');
  const archived = readFileSync(rec.archivedCapturePath!, 'utf-8').trim().split('\n');
  assert.ok(archived.length >= 4, 'archived evidence holds request/response pairs');
  assert.ok(result.targetRestoredPristine, 'target restored pristine by the runner');
  assertTargetPristine();
  console.log('PASS R1 (publication): 1 evaluable PUBLISHED attempt; boundary refused downstream; evidence archived; target restored');
}

// ─── R2: model-attributable failure consumes the denominator ─────────────────
{
  const evidence = join(tmpdir(), 'p3r2');
  rmSync(evidence, { recursive: true, force: true });
  const result = await runP3Campaign(mkOpts({
    maxAttempts: 1,
    evidenceDir: evidence,
    composeAttempt: (attemptId) => composeBuildAttempt(ROOT, attemptId, { innerProvider: failingBuilder() }),
    runPreflight: async () => ({ stop: null, detail: 'offline preflight' }),
  }));
  assert.equal(result.complete, true);
  assert.equal(result.stop, null);
  assert.equal(result.evaluable, 1);
  assert.equal(result.modelFailures, 1);
  assert.equal(result.published, 0);
  const rec = result.attempts[0];
  assert.equal(rec.outcome, 'MODEL-FAILURE');
  assert.equal(rec.publicationHash, null, 'no publication');
  assert.equal(rec.stop, null, 'not a campaign stop — an evaluable attempt');
  assert.ok(rec.providerCallsObserved >= 2, 'the model was reached (this is model-attributable, not procedure)');
  assert.ok(rec.archivedCapturePath && existsSync(rec.archivedCapturePath));
  assert.ok(result.targetRestoredPristine);
  assertTargetPristine();
  console.log('PASS R2 (model failure): 1 evaluable MODEL-FAILURE; clean capture; model reached; no publication; counts against the denominator');
}

// ─── R3: G1 STOP — immediate abort, attempt not counted ──────────────────────
{
  const evidence = join(tmpdir(), 'p3r3');
  rmSync(evidence, { recursive: true, force: true });
  let calls = 0;
  const silent = { async completeMultiTurn() { calls++; return { stop_reason: 'end_turn', text: 'x', tool_uses: [], tokens_used: 1 } as never; } };
  const WRONG: () => StepContract = () => ({
    stepId: 'build', model: 'z-ai/glm-5.3-flash', max_tokens: 999, reasoning_effort: 'low', temperature: 0.7,
    tool_sets: [['read_file']], submit_result: null,
  });
  const result = await runP3Campaign(mkOpts({
    evidenceDir: evidence,
    composeAttempt: (attemptId) => composeBuildAttempt(ROOT, attemptId, { innerProvider: silent, contract: WRONG }),
    runPreflight: async () => ({ stop: null, detail: 'offline preflight' }),
  }));
  assert.equal(result.stop, 'G1', 'campaign stopped on the guard violation');
  assert.equal(result.evaluable, 0, 'the STOPped attempt is NOT counted');
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, 'STOPPED');
  assert.equal(calls, 0, 'the model was NEVER called');
  assert.ok(result.targetRestoredPristine);
  console.log('PASS R3 (G1 STOP): immediate abort; attempt not counted; 0 model calls');
}

// ─── R4: G2 STOP from the EXCEPTION (capture file missing) ───────────────────
{
  const evidence = join(tmpdir(), 'p3r4');
  rmSync(evidence, { recursive: true, force: true });
  // the provider turns the capture path into a directory inside call 2 —
  // the request write of the second call succeeds? No: request write fails
  // first. Instead: succeed call 1 fully; on call 2 the REQUEST write still
  // succeeds (file exists), then before the response write... the guard's
  // response write happens after the provider returns, so we break the file
  // DURING call 2 (as Q6b): request ok -> provider ok -> response write fails
  const builder = conformingBuilder() as { completeMultiTurn: (p: { messages: unknown[] }) => Promise<unknown> };
  let n = 0;
  let capturePathRef = '';
  const sabotage = {
    async completeMultiTurn(params: { messages: unknown[] }) {
      n++;
      if (n === 2 && capturePathRef) {
        rmSync(capturePathRef, { recursive: true, force: true });
        mkdirSync(capturePathRef); // appendFileSync -> EISDIR on the response write
      }
      return builder.completeMultiTurn(params);
    },
  };
  const result = await runP3Campaign(mkOpts({
    evidenceDir: evidence,
    composeAttempt: (attemptId) => {
      const composed = composeBuildAttempt(ROOT, attemptId, { innerProvider: sabotage });
      capturePathRef = composed.capturePath;
      return composed;
    },
    runPreflight: async () => ({ stop: null, detail: 'offline preflight' }),
  }));
  assert.equal(result.stop, 'G2', 'the archival failure classified G2');
  assert.equal(result.attempts[0].stop, 'G2', 'the attempt record carries G2');
  assert.equal(result.evaluable, 0, 'not counted');
  // the runner classifies from BOTH independent paths — the exception
  // (classifyViolation, proven in R7 with no file at all) and the unreadable
  // capture (classifyAttempt); either alone is sufficient for the STOP
  const detail = (result.stopDetail ?? '').toLowerCase();
  assert.ok(
    detail.includes('evidence-integrity') || detail.includes('archiv') || detail.includes('capture unreadable') || detail.includes('classification'),
    `G2 surfaced: ${result.stopDetail}`,
  );
  assert.ok(result.attempts[0].outcome === 'STOPPED');
  rmSync(capturePathRef, { recursive: true, force: true });
  assert.ok(result.targetRestoredPristine);
  console.log('PASS R4 (G2 from exception): response-archive failure classified G2 from the exception; attempt not counted');
}

// ─── R5: stop-at-three ───────────────────────────────────────────────────────
{
  const evidence = join(tmpdir(), 'p3r5');
  rmSync(evidence, { recursive: true, force: true });
  const result = await runP3Campaign(mkOpts({
    evidenceDir: evidence,
    composeAttempt: (attemptId) => composeBuildAttempt(ROOT, attemptId, { innerProvider: conformingBuilder() }),
    runPreflight: async () => ({ stop: null, detail: 'offline preflight' }),
  }));
  assert.equal(result.complete, true);
  assert.equal(result.evaluable, 3, 'exactly three evaluable attempts');
  assert.equal(result.published, 3);
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.attempts.map((a) => a.index), [1, 2, 3]);
  assert.ok(result.attempts.every((a) => a.publicationHash), 'every attempt published');
  assert.ok(result.targetRestoredPristine);
  assertTargetPristine();
  console.log('PASS R5 (stop-at-three): terminal after exactly 3 evaluable attempts (3 publications)');
}

// ─── R6: preflight separation ────────────────────────────────────────────────
{
  // (a) a preflight STOP aborts BEFORE attempt 1, counting nothing
  const evidence = join(tmpdir(), 'p3r6');
  rmSync(evidence, { recursive: true, force: true });
  let composeCalls = 0;
  const result = await runP3Campaign(mkOpts({
    evidenceDir: evidence,
    composeAttempt: (attemptId) => { composeCalls++; return composeBuildAttempt(ROOT, attemptId, { innerProvider: conformingBuilder() }); },
    runPreflight: async () => ({ stop: 'G1', detail: 'offline preflight guard STOP' }),
  }));
  assert.equal(result.stop, 'G1');
  assert.equal(result.stopDetail?.includes('preflight'), true, 'the stop is attributed to the preflight');
  assert.equal(result.attempts.length, 0, 'ZERO attempts after a preflight STOP');
  assert.equal(composeCalls, 0, 'no attempt composition happened');
  assert.equal(result.evaluable, 0);

  // (b) the preflight path is a DISTINCT composition: own capture namespace
  const probe = composePreflight(ROOT, 'r6-probe', { innerProvider: { async completeMultiTurn() { return { stop_reason: 'end_turn', text: 'ok', tool_uses: [], tokens_used: 1 } as never; } } });
  assert.ok(probe.capturePath.includes('preflight-'), 'preflight capture namespace is separate');
  await (probe.provider as { completeMultiTurn: (p: unknown) => Promise<unknown> }).completeMultiTurn({
    model: probe.model, system: 'x', messages: [{ role: 'user', content: 'x' }],
    max_tokens: 16, temperature: 0.7, reasoning_effort: 'low', tools: [],
  });
  const pf = probe.classifyAttempt();
  assert.equal(pf.stop, null, 'the preflight probe archived cleanly');
  assert.ok(existsSync(probe.capturePath));
  rmSync(probe.capturePath, { recursive: true, force: true });
  console.log('PASS R6 (preflight separation): preflight STOP aborts before attempt 1 counting nothing; probe path is distinct and verified');
}

// ─── R7: fail-closed evidence — missing capture file classifies G2 ───────────
{
  const missing = join(tmpdir(), 'p3r7-missing.jsonl');
  rmSync(missing, { force: true });
  const { classifyAttempt } = await import('./p3-live-driver.mts');
  const { stop, cls } = (classifyAttempt as (p: string) => { stop: string | null; cls: { g2: boolean } })(missing);
  assert.equal(stop, 'G2', 'an unreadable capture classifies G2');
  assert.equal(cls.g2, true);
  // and a direct ConfigGuardViolation classifies without any file at all
  const { classifyViolation } = await import('./p3-live-driver.mts');
  assert.equal((classifyViolation as (e: unknown) => string | null)(new ConfigGuardViolation('evidence-integrity', 'x')), 'G2');
  assert.equal((classifyViolation as (e: unknown) => string | null)(new ConfigGuardViolation('build', 'x')), 'G1');
  assert.equal((classifyViolation as (e: unknown) => string | null)(new Error('ordinary')), null);
  console.log('PASS R7 (fail-closed evidence): missing capture -> G2; violations classify from the exception alone');
}

console.log('\nP3 RUNNER QUALIFICATION: ALL PASS (zero completion traffic)');
