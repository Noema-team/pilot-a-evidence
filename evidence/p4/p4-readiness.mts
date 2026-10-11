// P4 READINESS ASSESSMENT — the PURE mechanical evaluator for BUILD-entry
// readiness (final architecture review corrections 2 + 3). No I/O: the
// driver reads every file/row and passes plain data. Every check is
// structural and objective — no byte identity with the P3 fixture, no
// subjective content grading.
//
// Failure-class precedence (model-attributable only; guard G1/G2 STOPs are
// handled by the campaign BEFORE assessment):
//   budget-exhaustion-upstream > provider-error-unresolved > workflow-abandoned
//   > definition-human-decision-required > definition-exploration-required
//   > authority-invalid > malformed-state

import type { CaptureClassification, CaptureRecord } from '../p3/config-guard.mts';

export interface UpstreamArtifactRecord {
  stepId: string;
  artifactType: string;
  ref: string;
  path: string;
  existsOnDisk: boolean;
  diskSha256: string | null;
  storageHash: string | null; // artifacts.hash row
  bytes: number;
  nonEmpty: boolean;
}

export interface DefinitionParseOutcome {
  ok: boolean;
  errorCode?: string;
  detail?: string;
}

export interface DefinitionSourceOutcome {
  ok: boolean;
  failureCode?: string;
  failureMessage?: string;
  resolvedSha256?: string;
  resolvedBytes?: number;
}

export interface ReadinessInput {
  // R1 — the actual halted state
  execRun: { status: string; current_step_id: string | null; awaiting_checkpoint: unknown };
  pendingConfirm: { id: string; type: string } | null;
  intermediateDecisions: Array<{ stepId: string; how: 'approve-policy' | 'skipped-legitimately' }>;
  boundaryRefusals: number;
  buildStepRequestsInCapture: number;

  // R2 — definition chain + final readiness outcome
  defineRun: { status: string; current_step_id: string | null };
  defineWiState: string;
  definitionParse: DefinitionParseOutcome;
  finalReadiness: { parseError: string | null; gaps: unknown[] };
  humanDecisionArtifactExists: boolean;
  explorationArtifactExists: boolean;
  definitionSourceResolution: DefinitionSourceOutcome;
  upstreamArtifacts: UpstreamArtifactRecord[]; // definition + exec-side outputs

  // R3/R4 — configuration + budgets, re-verified FROM THE EVIDENCE
  frozenSettingsSha256: string;
  frozenModel: string;
  globalMaxTokens: number;
  budgetOf: (workflowId: string, stepId: string) => number;
  effortOf: (workflowId: string, stepId: string) => string | undefined;

  // R5 — BUILD edit policy (parameters only)
  editPolicy: {
    appliesToSteps: string[];
    allowedEditPaths: string[];
    requiredEditPaths: string[];
  } | null;
  frozenEditPolicy: {
    appliesToSteps: string[];
    allowedEditPaths: string[];
    requiredEditPaths: string[];
  };

  // R6 — wire integrity
  capture: CaptureClassification;
}

export interface CheckResult {
  pass: boolean;
  detail: string;
}

export interface ReadinessAssessment {
  ready: boolean;
  checks: Record<string, CheckResult>;
  failureClass: string | null;
  budgetExhaustedSteps: string[];
  providerErrorCount: number;
}

const BUDGET_STOP_REASONS = new Set(['max_tokens', 'length']);

const canonical = (v: unknown): string => JSON.stringify(v);

export function assessReadiness(input: ReadinessInput): ReadinessAssessment {
  const checks: Record<string, CheckResult> = {};

  // ── R1: the actual halted-at-confirm / pending-decision state ──────────────
  const r1Cursor = input.execRun.current_step_id === 'confirm';
  const r1Pending = input.pendingConfirm !== null;
  const r1NotPassed = input.boundaryRefusals === 0 && input.buildStepRequestsInCapture === 0;
  const r1Intermediate = input.intermediateDecisions.every((d) => d.how === 'approve-policy' || d.how === 'skipped-legitimately');
  checks.R1_halted_state = {
    pass: r1Cursor && r1Pending && r1NotPassed && r1Intermediate,
    detail: `cursor=${input.execRun.current_step_id} status=${input.execRun.status} pendingConfirm=${r1Pending} boundaryRefusals=${input.boundaryRefusals} buildRequests=${input.buildStepRequestsInCapture} intermediate=${input.intermediateDecisions.map((d) => `${d.stepId}:${d.how}`).join(',') || 'none'}`,
  };

  // ── R2: definition chain, provenance, readability, BUILD-context admissibility
  const defArt = input.upstreamArtifacts.find((a) => a.artifactType === 'definition');
  const r2Parse = input.definitionParse.ok;
  const r2FinalReadiness = input.finalReadiness.parseError === null && input.finalReadiness.gaps.length === 0;
  const r2NoHuman = !input.humanDecisionArtifactExists;
  const r2NoExplore = !input.explorationArtifactExists;
  const r2DefineDone = input.defineRun.status === 'complete' && (input.defineWiState === 'completed' || input.defineWiState === 'done');
  const r2Source = input.definitionSourceResolution.ok
    && input.definitionSourceResolution.resolvedSha256 !== undefined
    && defArt !== undefined
    && defArt.existsOnDisk
    && defArt.diskSha256 === input.definitionSourceResolution.resolvedSha256
    && defArt.storageHash === defArt.diskSha256;
  // upstream artifact integrity: storage provenance + disk bytes + non-empty
  const badArtifacts = input.upstreamArtifacts.filter((a) => !a.existsOnDisk || !a.nonEmpty || (a.storageHash !== null && a.storageHash !== a.diskSha256));
  checks.R2_definition_chain = {
    pass: r2Parse && r2FinalReadiness && r2NoHuman && r2NoExplore && r2DefineDone && r2Source && badArtifacts.length === 0,
    detail: `parse=${r2Parse} finalReadinessPass=${r2FinalReadiness} (gaps=${input.finalReadiness.gaps.length}${input.finalReadiness.parseError ? ` parseError=${input.finalReadiness.parseError}` : ''}) humanDecisionArtifact=${input.humanDecisionArtifactExists} explorationArtifact=${input.explorationArtifactExists} defineDone=${r2DefineDone} sourceResolved=${input.definitionSourceResolution.ok}${input.definitionSourceResolution.failureCode ? ` (${input.definitionSourceResolution.failureCode})` : ''} artifactsIntegrity=${badArtifacts.length === 0}${badArtifacts.length ? ` bad=[${badArtifacts.map((a) => a.stepId).join(',')}]` : ''}`,
  };

  // ── R3: settings pinned and verified at EVERY actual request ────────────────
  const requestRecords = input.capture.requests;
  const allPinned = requestRecords.every((r) => r.settings_sha256 === input.frozenSettingsSha256);
  checks.R3_settings_pinned = {
    pass: requestRecords.length > 0 && allPinned,
    detail: `${requestRecords.length} requests, all carry settings_sha256 == frozen: ${allPinned}`,
  };

  // ── R4: budget on the wire == frozen per-step map (STOP-class if violated) ──
  const budgetViolations: string[] = [];
  const budgetExhaustedSteps: string[] = [];
  for (const r of requestRecords) {
    const wf = String(r.workflow_id ?? '');
    const step = String(r.step ?? '');
    const expected = input.budgetOf(wf, step);
    if (r.max_tokens !== expected) budgetViolations.push(`${wf}/${step}: sent ${String(r.max_tokens)} != frozen ${expected}`);
    const effort = input.effortOf(wf, step);
    if ((r.reasoning_effort ?? null) !== (effort ?? null)) budgetViolations.push(`${wf}/${step}: effort ${String(r.reasoning_effort)} != frozen ${String(effort)}`);
    if (r.model !== input.frozenModel) budgetViolations.push(`${wf}/${step}: model ${String(r.model)} != frozen ${input.frozenModel}`);
  }
  // genuine exhaustion at the CORRECT budget (from response records)
  for (const resp of input.capture.responses) {
    if (resp.stop_reason !== null && BUDGET_STOP_REASONS.has(String(resp.stop_reason))) {
      budgetExhaustedSteps.push(String(resp.step));
    }
  }
  checks.R4_budget_on_wire = {
    // R4 itself is clean when the guard saw no mismatch; the guard turns any
    // mismatch into a campaign-terminal STOP before assessment, so reaching
    // here with violations would be an integrity bug — fail closed anyway.
    pass: budgetViolations.length === 0,
    detail: budgetViolations.length === 0
      ? `all ${requestRecords.length} requests match the frozen budget/effort/model map${budgetExhaustedSteps.length ? `; genuine length termini at correct budgets: [${[...new Set(budgetExhaustedSteps)].join(',')}]` : ''}`
      : budgetViolations.slice(0, 5).join('; '),
  };

  // ── R5: BUILD edit policy present as parameters (never enforced upstream) ───
  const ep = input.editPolicy;
  const r5 = ep !== null
    && canonical(ep.appliesToSteps) === canonical(input.frozenEditPolicy.appliesToSteps)
    && canonical([...ep.allowedEditPaths].sort()) === canonical([...input.frozenEditPolicy.allowedEditPaths].sort())
    && canonical([...ep.requiredEditPaths].sort()) === canonical([...input.frozenEditPolicy.requiredEditPaths].sort());
  checks.R5_edit_policy_parameters = {
    pass: r5,
    detail: ep ? `editPolicy=${canonical(ep)}` : 'editPolicy MISSING from exec workflowParameters',
  };

  // ── R6: wire integrity ──────────────────────────────────────────────────────
  const legalWires = new Set(['completeMultiTurn', 'complete', 'completeStructured']);
  const foreignWire = requestRecords.some((r) => !legalWires.has(String(r.wire)));
  checks.R6_wire_integrity = {
    pass: !input.capture.g1 && !input.capture.g2 && input.capture.parse_failures.length === 0 && !foreignWire,
    detail: `g1=${input.capture.g1} g2=${input.capture.g2} parseFailures=${input.capture.parse_failures.length} foreignWire=${foreignWire} requests=${input.capture.requests.length} responses=${input.capture.responses.length} errors=${input.capture.errors.length}`,
  };

  const ready = Object.values(checks).every((c) => c.pass);

  // ── model-attributable failure classification (precedence order) ────────────
  let failureClass: string | null = null;
  if (!ready) {
    if (budgetExhaustedSteps.length > 0) failureClass = 'budget-exhaustion-upstream';
    else if (input.capture.errors.length > 0) failureClass = 'provider-error-unresolved';
    else if (input.execRun.status === 'failed' || input.defineRun.status === 'failed') failureClass = 'workflow-abandoned';
    else if (input.humanDecisionArtifactExists) failureClass = 'definition-human-decision-required';
    else if (input.explorationArtifactExists) failureClass = 'definition-exploration-required';
    else if (!input.definitionSourceResolution.ok || !input.definitionParse.ok) failureClass = 'authority-invalid';
    else failureClass = 'malformed-state';
  }

  return {
    ready,
    checks,
    failureClass,
    budgetExhaustedSteps,
    providerErrorCount: input.capture.errors.length,
  };
}

// helper: per-request settings/budget facts extracted from capture records
export function buildStepRequestsInCapture(capture: CaptureClassification): number {
  return capture.requests.filter((r: CaptureRecord) => r.step === 'build').length;
}
