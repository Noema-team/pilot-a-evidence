# V2 qualification — GENUINE IMPLEMENTATION BUG in merged PR #45

Verdict: FAIL — qualification stopped per operator instruction ("If the
qualification exposes a genuine implementation bug, STOP and report it").
NO code or config was modified in response.

## Failure

AgentLoop turn 1 fails at ~2.3 s with:
  SseParseError: semantic delta (content/tool_calls) after finish_reason
    — stream contract violation
stop_reason provider_error, no tools executed, no submit_result.
Reproduced 2/2 (runs 1 and 3; run 2 identical, capture race only).
Deterministic → every V2 attempt would fail at its first turn.

## Root cause (raw wire evidence: raw-sse-capture-run3.txt, 2539 bytes, 7 events)

OpenRouter / z-ai/glm-5.3-flash streaming wire reality:

  event 3: finish_reason=null    delta={content:null, tool_calls:[...']}'}]}
  event 4: finish_reason=tool_calls delta={content:'', role:'assistant'}   ← finish chunk CARRIES EMPTY-STRING content
  event 5: finish_reason=tool_calls delta={content:'', role:'assistant'} usage={...}  ← SECOND finish_reason chunk CARRIES THE USAGE
  event 6: [DONE]

PR #45's accumulator terminal-state enforcement (added in review round 1)
rejects BOTH real behaviors:
  1. `content: ''` (empty string) on/after the finish chunk is treated as a
     semantic delta → SseParseError;
  2. a second finish_reason (the usage-carrier chunk) → SseParseError.
The review contract anticipated "usage-only chunks / empty keep-alive
choices"; OpenRouter actually sends empty-content deltas and a repeated
finish_reason as the usage carrier. The merged implementation is stricter
than the real wire.

## Why the 48 stub/CI tests did not catch it

All fixture streams were synthesized from the OpenAI-style shape where the
usage chunk has empty `choices` and [DONE] follows. No fixture modeled
OpenRouter's actual post-finish padding (empty-content delta + repeated
finish_reason carrying usage).

## Required fix (for operator ruling — NOT applied)

Accumulator terminal-state rule must accept, after the first non-null
finish_reason, additionally: content deltas that are EMPTY STRINGS, and a
REPEATED finish_reason chunk (identical terminal reason, empty/whitespace
content) — these are non-semantic per the observed wire. A NON-empty
content delta or a DIFFERENT second finish_reason must still fail closed.
The strict tool-call index rule is unaffected (events 1-3 all carry
index:0 and parse fine).

## Qualification artifacts

- v2-qualification-20260925.json — harness report (run 3; runs 1-2 overwrote same path, all FAIL)
- raw-sse-capture-run3.txt — raw SSE bytes of the failing turn-1 stream
- Harness: /tmp/opencode/qualify-v2.ts (+capture variant) — provider-wrapper
  recording, scratch git fixture, schema-driven submit_result negotiation;
  zero stratum source changes.
