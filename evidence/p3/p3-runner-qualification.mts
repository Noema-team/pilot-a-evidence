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
//
// freeze-3 review T-gates (additive; R1-R7 preserved unchanged):
//  T1  transport re-queue: an unambiguous transport failure (fetch failed)
//      is JOURNALED and re-queued WITHOUT consuming a denominator slot
//  T2  ambiguity is NOT censored: a non-transport provider error stays an
//      evaluable MODEL-FAILURE
//  T3  transport adjudicator matrix: qualifying/ambiguous/terminal-position
//      rules decided from the archived capture alone
//  T4  re-queue cap: the 4th transport-censored event is NOT re-queued and
//      NOT recorded as one (REQUEUE-EXHAUSTED after exactly MAX_REQUEUES)
//  T5  preflight completion-status adjudication: the P2 class (finish_reason
//      error / absent / length, or missing text) is rejected; a clean probe
//      is accepted
//  T6  evidence durability: the per-attempt package re-verifies by hash
//      AFTER subsequent fixture rebuilds destroyed the runtime workspace
//  T7  campaign ledger durability: preflight/attempt/requeue/terminal events
//      recorded with evidence-package hashes before the next attempt
//  T8  full pristine restoration: untracked upstream artifacts removed via
//      filesystem ops, complete porcelain verification accounting for .sle,
//      fail closed on unexpected files
// freeze-4 review T-gates (additive; R1-R7 + T1-T8 preserved):
//  T3 additions: output-budget exhaustion vetoes the re-queue even when a
//      later transport error ends the capture (addendum-2: an already-
//      observed evaluable failure is never retroactively censored); an
//      application error merely containing "timeout" is NOT transport
//      evidence
//  T9  G2-over-G1 precedence when capture and exception classifications
//      overlap (consistently with mapCaptureToStop)

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

import { runP3Campaign, restoreTargetPristine, adjudicateTransportFailure, adjudicatePreflightCapture, combineStops, defaultRunPreflight, MAX_REQUEUES, type CampaignOptions } from './p3-live-runner.mts';
import { composeBuildAttempt, composePreflight, preflightContract, P3_TARGET } from './p3-live-driver.mts';
import { ConfigGuardViolation, classifyGuardCapture, type StepContract } from './config-guard.mts';

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
    // mirror the FROZEN probe contract (freeze-5: 512) — derived, never hardcoded
    max_tokens: preflightContract(probe.model).max_tokens, temperature: 0.7, reasoning_effort: 'low', tools: [],
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

// ─── scripted transport-failure providers (freeze-3 review P1-1) ─────────────
function transportThrower(err: Error) {
  return {
    async completeMultiTurn(): Promise<never> {
      throw err;
    },
  };
}

// synthetic capture helpers for the adjudicator matrices (T3/T5) — the same
// record shapes the guard writes
const synthDir = join(tmpdir(), `p3r-synth-${Math.random().toString(36).slice(2)}`);
function writeCapture(lines: Array<Record<string, unknown>>): string {
  mkdirSync(synthDir, { recursive: true });
  const p = join(synthDir, `cap-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const REQ = (step = 'build'): Record<string, unknown> => ({
  ts: 't', capture_version: 2, phase: 'synth', kind: 'request', wire: 'completeMultiTurn',
  step, model: 'm', guard_verdict: 'PASS', violations: [],
});
const RESP = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ts: 't', kind: 'response', wire: 'completeMultiTurn', step: 'build',
  stop_reason: 'end_turn', text: 'ok', tokens_used: 1, ...over,
});
const ERR = (name: string, msg: string): Record<string, unknown> => ({
  ts: 't', kind: 'error', wire: 'completeMultiTurn', step: 'build', error_name: name, error_message: msg,
});

// ─── T1: transport re-queue consumes NO denominator slot ─────────────────────
{
  const evidence = join(tmpdir(), 'p3t1');
  rmSync(evidence, { recursive: true, force: true });
  let composeN = 0;
  const result = await runP3Campaign(mkOpts({
    maxAttempts: 1, // ONE evaluable slot: the transport failure must consume none of it
    evidenceDir: evidence,
    composeAttempt: (attemptId) => {
      composeN++;
      return composeBuildAttempt(ROOT, attemptId, {
        innerProvider: composeN === 1 ? transportThrower(new TypeError('fetch failed')) : conformingBuilder(),
      });
    },
    runPreflight: async () => ({ stop: null, detail: 'offline preflight' }),
  }));
  assert.equal(result.complete, true);
  assert.equal(result.stop, null, 'a qualifying transport failure does not stop the campaign');
  assert.equal(result.requeues, 1, 'one transport re-queue');
  assert.equal(result.evaluable, 1, 'the re-queue consumed NO evaluable slot');
  assert.equal(result.published, 1);
  assert.equal(result.attempts.length, 2, 'exactly two attempts ran: the transport failure + the re-queued success');
  const rq = result.attempts[0];
  assert.equal(rq.outcome, 'TRANSPORT-REQUEUE');
  assert.equal(rq.evaluable, false, 'not counted');
  assert.equal(rq.slot, null, 'no denominator slot');
  assert.equal(rq.adjudication?.verdict, 'TRANSPORT-REQUEUE');
  assert.equal(rq.publicationHash, null);
  const ok = result.attempts[1];
  assert.equal(ok.outcome, 'PUBLISHED');
  assert.equal(ok.slot, 1, 'the published attempt took SLOT 1 — the transport failure took none');
  // durable ledger + package exist for the requeued attempt
  assert.ok(existsSync(result.ledgerPath), 'campaign ledger written');
  const ledgerLines = readFileSync(result.ledgerPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(ledgerLines.some((l) => l.event === 'transport-requeue' && l.requeues_used === 1), 'the re-queue is operator-visibly journaled');
  const rqLine = ledgerLines.find((l) => l.event === 'attempt' && l.attempt_id === rq.attemptId) as Record<string, unknown>;
  assert.equal(rqLine.evidence_package_sha256, rq.evidencePackageSha256, 'ledger carries the package hash');
  assert.ok(rq.evidencePackagePath && existsSync(rq.evidencePackagePath), 'requeued attempt evidence package exists');
  assert.ok(!existsSync(rq.capturePath), 'attempt 1 runtime capture was destroyed by the attempt-2 fixture rebuild — the durable package is the surviving record');
  assert.ok(result.targetRestoredPristine);
  assertTargetPristine();
  console.log('PASS T1 (transport re-queue): fetch failed journaled + re-queued; consumed NO slot; campaign completed on attempt 2');
}

// ─── T2: ambiguity is NOT censored — evaluable MODEL-FAILURE ─────────────────
{
  const evidence = join(tmpdir(), 'p3t2');
  rmSync(evidence, { recursive: true, force: true });
  const result = await runP3Campaign(mkOpts({
    maxAttempts: 1,
    evidenceDir: evidence,
    composeAttempt: (attemptId) => composeBuildAttempt(ROOT, attemptId, {
      innerProvider: transportThrower(new Error('LLM API request failed: 400 Bad Request — upstream rejected the request')),
    }),
    runPreflight: async () => ({ stop: null, detail: 'offline preflight' }),
  }));
  const rec = result.attempts[0];
  assert.equal(rec.outcome, 'MODEL-FAILURE', 'a non-transport provider error stays model-attributable');
  assert.equal(rec.evaluable, true, 'ambiguous cases remain evaluable (denominator consumed)');
  assert.equal(rec.adjudication?.verdict, 'AMBIGUOUS');
  assert.equal(result.modelFailures, 1);
  assert.equal(result.requeues, 0);
  assert.ok(result.targetRestoredPristine);
  console.log('PASS T2 (ambiguity not censored): non-transport error (HTTP 400) stays an evaluable MODEL-FAILURE');
}

// ─── T3: transport adjudicator matrix (archived capture alone decides) ───────
{
  const adjPath = (lines: Array<Record<string, unknown>>) => {
    const p = writeCapture(lines);
    return adjudicateTransportFailure(classifyGuardCapture(p), p);
  };
  // (a) undici wrapper — qualifies
  assert.equal(adjPath([REQ(), ERR('TypeError', 'fetch failed')]).verdict, 'TRANSPORT-REQUEUE');
  // (b) HTTP 502 (frozen llm-provider error shape) — qualifies
  assert.equal(adjPath([REQ(), ERR('Error', 'LLM API request failed: 502 Bad Gateway — upstream')]).verdict, 'TRANSPORT-REQUEUE');
  // (c) HTTP 408/429 — qualify
  assert.equal(adjPath([REQ(), ERR('Error', 'LLM API request failed: 408 Request Timeout — upstream')]).verdict, 'TRANSPORT-REQUEUE');
  assert.equal(adjPath([REQ(), ERR('Error', 'LLM API request failed: 429 Too Many Requests — upstream')]).verdict, 'TRANSPORT-REQUEUE');
  // (d) socket-level classes — qualify
  assert.equal(adjPath([REQ(), ERR('SocketError', 'socket hang up')]).verdict, 'TRANSPORT-REQUEUE');
  assert.equal(adjPath([REQ(), ERR('SystemError', 'connect ECONNRESET 127.0.0.1:443')]).verdict, 'TRANSPORT-REQUEUE');
  // (e) non-transport HTTP class — ambiguous (stays evaluable upstream)
  assert.equal(adjPath([REQ(), ERR('Error', 'LLM API request failed: 400 Bad Request — upstream')]).verdict, 'AMBIGUOUS');
  // (f) ordinary application error — ambiguous
  assert.equal(adjPath([REQ(), ERR('Error', 'anchor mint failed: no readable slice')]).verdict, 'AMBIGUOUS');
  // (g) terminal-position rule: a well-formed capture whose LAST outcome is a
  // response means the transport error is not the proximate failure cause —
  // no re-queue (falls through to model-attributable adjudication)
  const g = adjPath([REQ(), ERR('TypeError', 'fetch failed'), REQ(), RESP()]);
  assert.equal(g.verdict, 'AMBIGUOUS');
  assert.ok(g.detail.includes('last archived outcome is a response'), `terminal-position rule: ${g.detail}`);
  // (g2) a malformed capture (unpaired response after the error) is tamper
  // class — compromised captures can NEVER decide a re-queue
  assert.equal(adjPath([REQ(), ERR('TypeError', 'fetch failed'), RESP()]).verdict, 'AMBIGUOUS');
  // (h) mixed transport + non-transport errors — ambiguous
  assert.equal(adjPath([REQ(), ERR('TypeError', 'fetch failed'), REQ(), ERR('Error', 'anchor mint failed')]).verdict, 'AMBIGUOUS');
  // (i) no errors at all — not transport
  assert.equal(adjPath([REQ(), RESP()]).verdict, 'NOT-TRANSPORT');
  // (j) a tampered capture can never decide a re-queue
  const tamperedPath = writeCapture([REQ(), ERR('TypeError', 'fetch failed')]);
  writeFileSync(tamperedPath, readFileSync(tamperedPath, 'utf-8') + 'not-json\n');
  assert.equal(adjudicateTransportFailure(classifyGuardCapture(tamperedPath), tamperedPath).verdict, 'AMBIGUOUS');
  // (k) freeze-4: output-budget exhaustion ALREADY observed -> a later
  // transport error must NOT retroactively censor the evaluable failure
  const k = adjPath([REQ(), RESP({ wire_observation: { finish_reason: 'length' } }), REQ(), ERR('TypeError', 'fetch failed')]);
  assert.equal(k.verdict, 'NOT-TRANSPORT', `budget veto: ${k.detail}`);
  assert.ok(k.detail.includes('output-budget exhaustion'), `budget veto named: ${k.detail}`);
  // (k2) budget signal via the normalized stop_reason side
  const k2 = adjPath([REQ(), RESP({ stop_reason: 'max_tokens', wire_observation: { finish_reason: 'stop' } }), REQ(), ERR('TypeError', 'fetch failed')]);
  assert.equal(k2.verdict, 'NOT-TRANSPORT', `stop_reason budget veto: ${k2.detail}`);
  // (l) freeze-4: an application error merely CONTAINING "timeout" is NOT
  // transport evidence — narrow classification to provider/network shapes
  const l = adjPath([REQ(), ERR('Error', 'anchor validation timeout exceeded while staging the submission')]);
  assert.equal(l.verdict, 'AMBIGUOUS', `free-text 'timeout' rejected as transport evidence: ${l.detail}`);
  // (l2) genuine network timeouts still qualify — via explicit codes/shapes
  assert.equal(adjPath([REQ(), ERR('Error', 'LLM API request failed: 408 Request Timeout — upstream')]).verdict, 'TRANSPORT-REQUEUE');
  assert.equal(adjPath([REQ(), ERR('SystemError', 'connect ETIMEDOUT 10.0.0.1:443')]).verdict, 'TRANSPORT-REQUEUE');
  assert.equal(adjPath([REQ(), ERR('Error', 'UND_ERR_CONNECT_TIMEOUT: connect timed out')]).verdict, 'TRANSPORT-REQUEUE');
  console.log('PASS T3 (adjudicator matrix): qualifying transport shapes; 400/app/mixed/tampered/free-text-timeout ambiguous; budget exhaustion vetoes the re-queue; terminal-position rule enforced');
}

// ─── T4: re-queue cap — retries can never exceed the approved scope ──────────
{
  const evidence = join(tmpdir(), 'p3t4');
  rmSync(evidence, { recursive: true, force: true });
  const result = await runP3Campaign(mkOpts({
    evidenceDir: evidence, // default maxAttempts = 3 (frozen)
    composeAttempt: (attemptId) => composeBuildAttempt(ROOT, attemptId, {
      innerProvider: transportThrower(new TypeError('fetch failed')),
    }),
    runPreflight: async () => ({ stop: null, detail: 'offline preflight' }),
  }));
  assert.equal(result.complete, true);
  assert.equal(result.stop, 'REQUEUE-EXHAUSTED', 'the campaign STOPs once the re-queue cap is reached');
  assert.equal(result.evaluable, 0, 'no evaluable attempt consumed');
  assert.equal(result.attempts.length, MAX_REQUEUES + 1, `the ${MAX_REQUEUES + 1}th transport-censored attempt EXECUTES but is not re-queued`);
  assert.ok(result.attempts.every((a) => a.outcome === 'TRANSPORT-REQUEUE'));
  assert.equal(result.requeues, MAX_REQUEUES, `exactly MAX_REQUEUES (${MAX_REQUEUES}) re-queues recorded — no fourth`);
  const ledgerLines = readFileSync(result.ledgerPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(ledgerLines.filter((l) => l.event === 'transport-requeue').length, MAX_REQUEUES, 'exactly MAX_REQUEUES re-queue events journaled');
  const fourth = result.attempts[MAX_REQUEUES];
  assert.ok(!ledgerLines.some((l) => l.event === 'transport-requeue' && l.attempt_id === fourth.attemptId), 'the cap-exceeding event is NOT journaled as a re-queue');
  assert.ok((result.stopDetail ?? '').includes('NOT re-queued'), `terminal condition names the refusal: ${result.stopDetail}`);
  assert.ok(ledgerLines.some((l) => l.event === 'campaign-terminal' && l.stop === 'REQUEUE-EXHAUSTED'), 'terminal journaled');
  assert.ok(result.targetRestoredPristine);
  assertTargetPristine();
  console.log('PASS T4 (re-queue cap): exactly 3 re-queues recorded; the 4th transport-censored event is not re-queued; REQUEUE-EXHAUSTED STOP back to the operator; nothing consumed');
}

// ─── T5: preflight completion-status adjudication (P2 class rejected) ────────
{
  const pf = (lines: Array<Record<string, unknown>>) => adjudicatePreflightCapture(writeCapture(lines));
  // (a) clean probe — accepted
  const good = pf([REQ('preflight'), RESP({ step: 'preflight', wire_observation: { finish_reason: 'stop' } })]);
  assert.equal(good.accepted, true, 'a clean end_turn/stop probe is accepted');
  assert.equal(good.stop, null);
  // (b) the P2 transport-censoring class: end_turn + finish_reason error + partial text — REJECTED
  const p2 = pf([REQ('preflight'), RESP({ step: 'preflight', text: 'par', wire_observation: { finish_reason: 'error' } })]);
  assert.equal(p2.accepted, false);
  assert.equal(p2.stop, 'G2');
  assert.ok(p2.detail.includes('finish_reason'), `P2 class named: ${p2.detail}`);
  // (c) missing wire_observation (no finish_reason evidence) — rejected
  assert.equal(pf([REQ('preflight'), RESP({ step: 'preflight', wire_observation: null })]).accepted, false);
  // (d) finish_reason length — rejected
  assert.equal(pf([REQ('preflight'), RESP({ step: 'preflight', wire_observation: { finish_reason: 'length' } })]).accepted, false);
  // (e) stop_reason not end_turn — rejected
  assert.equal(pf([REQ('preflight'), RESP({ step: 'preflight', stop_reason: 'max_tokens', wire_observation: { finish_reason: 'stop' } })]).accepted, false);
  // (f) empty text — rejected
  assert.equal(pf([REQ('preflight'), RESP({ step: 'preflight', text: '', wire_observation: { finish_reason: 'stop' } })]).accepted, false);
  // (g) more than one probe call — rejected (exactly-one rule)
  assert.equal(pf([REQ('preflight'), RESP({ step: 'preflight', wire_observation: { finish_reason: 'stop' } }), RESP({ step: 'preflight', wire_observation: { finish_reason: 'stop' } })]).accepted, false);
  // (h) guard STOP in the probe — rejected
  assert.equal(pf([{ ...REQ('preflight'), guard_verdict: 'STOP', dimension: 'config', violations: ['max_tokens mismatch'] }]).accepted, false);
  console.log('PASS T5 (preflight adjudication): clean probe accepted; finish_reason error/absent/length, wrong stop_reason, empty text, multi-call, STOP all rejected');
}

// ─── T6: evidence durability across fixture rebuilds (uses T1's campaign) ────
{
  const evidence = join(tmpdir(), 'p3t1');
  const ledgerLines = readFileSync(join(evidence, 'campaign-ledger.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const attemptLines = ledgerLines.filter((l) => l.event === 'attempt') as Array<Record<string, string>>;
  assert.ok(attemptLines.length >= 2);
  for (const line of attemptLines) {
    const manifest = JSON.parse(readFileSync(join(line.evidence_package, 'evidence-manifest.json'), 'utf-8')) as {
      files: Record<string, string>; package_sha256: string;
    };
    // every file re-hashes to the manifest AFTER .sle was rebuilt by later attempts
    for (const [f, h] of Object.entries(manifest.files)) {
      assert.equal(sha256(join(line.evidence_package, f)), h, `package file ${f} intact after fixture rebuilds`);
    }
    assert.equal(line.evidence_package_sha256, manifest.package_sha256, `ledger hash matches manifest for attempt ${line.index}`);
  }
  // and the RUNTIME copies are gone — the package is the only surviving copy
  console.log('PASS T6 (evidence durability): all attempt packages re-verify by hash after subsequent fixture rebuilds; ledger hashes match');
}

// ─── T7: campaign ledger event structure (uses T1's campaign) ────────────────
{
  const evidence = join(tmpdir(), 'p3t1');
  const lines = readFileSync(join(evidence, 'campaign-ledger.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const events = lines.map((l) => l.event as string);
  assert.equal(events[0], 'preflight', 'the ledger opens with the preflight verdict');
  assert.deepEqual(
    events.filter((e) => e === 'attempt-counted').length, 1, 'exactly one counted slot',
  );
  assert.ok(events.indexOf('transport-requeue') >= 0 && events.indexOf('transport-requeue') < events.indexOf('attempt-counted'), 'the re-queue precedes the slot assignment');
  assert.equal(events[events.length - 1], 'campaign-terminal', 'the ledger closes with the terminal state');
  for (const l of lines) {
    assert.ok(typeof l.ts === 'string' && l.ts.length > 0, 'every ledger line is timestamped');
  }
  console.log('PASS T7 (ledger structure): preflight -> attempt -> re-queue -> counted -> terminal, all timestamped, package hashes carried');
}

// ─── T8: full pristine restoration — success and failure paths ───────────────
{
  // (a) success: untracked upstream artifacts + a tracked modification +
  //     .sle present — all resolved; porcelain clean except .sle
  writeFileSync(join(ROOT, 'docs/requirements.md'), '# stray upstream artifact (T8)\n');
  writeFileSync(join(ROOT, 'docs/test-plan.md'), '# stray upstream artifact (T8)\n');
  const mainPath = join(ROOT, 'apps/ai-server/rag-worker-service/main.py');
  const mainBytes = readFileSync(mainPath);
  writeFileSync(mainPath, mainBytes + '\n# T8 tracked drift\n');
  assert.equal(await restoreTargetPristine(), true, 'restoration succeeds with untracked artifacts + tracked drift + .sle present');
  assert.equal(sha256(mainPath), P3_TARGET.worker_main_sha256, 'worker bytes restored');
  assert.ok(!existsSync(join(ROOT, 'docs/requirements.md')) && !existsSync(join(ROOT, 'docs/test-plan.md')), 'untracked upstream artifacts removed');
  const porcelain = execFileSync('git', ['-C', ROOT, 'status', '--porcelain']).toString().trim().split('\n').filter((l) => l.length > 0);
  assert.deepEqual(porcelain, ['?? .sle/'], `worktree clean except .sle: ${JSON.stringify(porcelain)}`);

  // (b) failure: an unexpected untracked file fails closed and is left for
  //     the operator
  const stray = join(ROOT, 'p3-restore-probe-stray.txt');
  writeFileSync(stray, 'unexpected\n');
  assert.equal(await restoreTargetPristine(), false, 'an unexpected untracked file fails restoration (fail closed)');
  assert.ok(existsSync(stray), 'the stray file is NOT silently deleted — left for the operator');
  rmSync(stray, { force: true });
  assert.equal(await restoreTargetPristine(), true, 'restoration passes again once the stray is cleared');
  console.log('PASS T8 (full restoration): untracked artifacts removed, tracked drift reverted, .sle accounted; unexpected files fail closed');
}

// ─── T9: G2-over-G1 precedence when capture and exception overlap (freeze-4) ─
{
  const silent = { async completeMultiTurn() { return { stop_reason: 'end_turn', text: 'x', tool_uses: [], tokens_used: 1 } as never; } };
  const WRONG: () => StepContract = () => ({
    stepId: 'build', model: 'z-ai/glm-5.3-flash', max_tokens: 999, reasoning_effort: 'low', temperature: 0.7,
    tool_sets: [['read_file']], submit_result: null,
  });

  // (a) capture classification G2 (co-occurring integrity failure) + thrown
  // config violation (G1) -> the runner must report G2, never G1
  const evA = join(tmpdir(), 'p3t9a');
  rmSync(evA, { recursive: true, force: true });
  const resultA = await runP3Campaign(mkOpts({
    evidenceDir: evA,
    composeAttempt: (attemptId) => {
      const composed = composeBuildAttempt(ROOT, attemptId, { innerProvider: silent, contract: WRONG });
      return {
        ...composed,
        classifyAttempt: () => ({
          cls: { ...composed.classifyAttempt().cls, g2: true, integrity_failures: ['synthetic co-occurring integrity failure (overlap precedence regression)'] },
          stop: 'G2' as const,
        }),
      };
    },
    runPreflight: async () => ({ stop: null, detail: 'offline preflight' }),
  }));
  assert.equal(resultA.stop, 'G2', `G2 precedence over the co-occurring G1 exception (got ${resultA.stop})`);
  assert.equal(resultA.attempts[0].stop, 'G2');
  assert.equal(resultA.evaluable, 0);

  // (b) the full combination matrix — the engine absorbs provider-call
  // exceptions (attemptError stays null), so the G1-capture + G2-exception
  // overlap is proven on the exported pure combination the runner uses
  const cs = combineStops as (a: string | null, b: string | null) => string | null;
  assert.equal(cs('G2', 'G1'), 'G2', 'capture G2 + exception G1 -> G2');
  assert.equal(cs('G1', 'G2'), 'G2', 'capture G1 + exception G2 -> G2');
  assert.equal(cs('G2', null), 'G2');
  assert.equal(cs(null, 'G2'), 'G2');
  assert.equal(cs('G1', null), 'G1', 'a lone G1 remains G1 (R3 behavior preserved)');
  assert.equal(cs(null, 'G1'), 'G1');
  assert.equal(cs(null, null), null);
  console.log('PASS T9 (G2 precedence): capture G2 + exception G1 -> G2 end-to-end; capture G1 + exception G2 -> G2 via the combination matrix (consistent with mapCaptureToStop)');
}

// ─── T10: production preflight wiring derives its dial from the frozen contract (freeze-6) ─
{
  // regression for the freeze-5 defect: preflightContract() said 512 while
  // defaultRunPreflight() still dialed max_tokens 16 — the guard would have
  // STOPped the live campaign pre-call. The production function must DERIVE
  // its outbound request from the contract.
  const expectedBudget = preflightContract().max_tokens;
  assert.equal(expectedBudget, 512, 'the frozen probe budget is the freeze-5 value');
  let seen: Record<string, unknown> | null = null;
  const scripted = {
    async completeMultiTurn(p: unknown) {
      seen = p as Record<string, unknown>;
      return { stop_reason: 'end_turn', text: 'ok', tool_uses: [], tokens_used: 3,
        wire_observation: { finish_reason: 'stop', completion_tokens: 3 } };
    },
  };
  const evT10 = join(tmpdir(), 'p3t10');
  rmSync(evT10, { recursive: true, force: true });
  const pre = await defaultRunPreflight(evT10, scripted);
  assert.equal(pre.stop, null, `production preflight accepted a contract-conformant probe (detail: ${pre.detail})`);
  assert.ok(seen, 'the probe dialed the provider');
  assert.equal(seen!['max_tokens'], expectedBudget, 'outbound max_tokens derives from preflightContract()');
  assert.equal(seen!['reasoning_effort'], 'low');
  assert.deepEqual(seen!['tools'], []);
  const adjPath = join(evT10, 'preflight', 'preflight-guard.jsonl');
  assert.ok(existsSync(adjPath), 'probe capture durably archived');
  const adj = adjudicatePreflightCapture(adjPath);
  assert.equal(adj.accepted, true, 'archived evidence passes completion-status adjudication');
  // negative: a drifted budget is STOPped pre-call by the guard (G2), never dialed
  const drifted = {
    async completeMultiTurn(p: unknown) {
      return Promise.reject(new ConfigGuardViolation('preflight', 'max_tokens mismatch (injected)'));
    },
  };
  const evT10b = join(tmpdir(), 'p3t10b');
  rmSync(evT10b, { recursive: true, force: true });
  const pre2 = await defaultRunPreflight(evT10b, drifted);
  assert.equal(pre2.stop, 'G1', 'a contract-divergent dial fails closed as a preflight guard STOP (G1 — configuration violation)');
  console.log('PASS T10 (preflight wiring): production dial derives from preflightContract() (512, low, no tools); guard PASS; adjudication accepted; evidence archived; divergence -> G1 pre-call');
}

rmSync(synthDir, { recursive: true, force: true });

console.log('\nP3 RUNNER QUALIFICATION: ALL PASS (zero completion traffic)');
