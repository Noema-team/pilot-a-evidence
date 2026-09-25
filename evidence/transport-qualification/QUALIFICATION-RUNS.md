# V2 qualification runs on merged PR #46 (stratum main @ f5734e40023173d5f255829cfc164ed9dbba2d8b)

Same harness as the f215272 qualification (model z-ai/glm-5.3-flash via real
OpenRouter, scratch git fixture, schema-driven submit_result negotiation,
recording provider wrapper, no retries/fallbacks). Harness fixes between runs
were HARNESS-only (never stratum code/config):

- run A: FAIL pre-check — harness never registered the loop's `acceptResult`
  (the role the production runner composes); loop failed CLOSED exactly as
  designed. Transport itself was already healthy (read_file executed, usage
  plausible). Harness fixed: acceptor registered.
- run B: FAIL on one harness check — the harness prompt asked for "the sha256
  read_file reported", but read_file returns raw text only; the authoritative
  digest is read_source_slice's (by design: computed by Stratum, never claimed
  by the model). Run B's model only used read_file and FABRICATED a plausible
  64-hex digest (74183cb9…) — a model-grounding observation, not a transport
  defect; all 7 transport gates passed. Harness fixed: prompt directs the
  model to read_source_slice for the authoritative digest.
- run C: **PASS 8/8** — see v2-qualification-20260925-QUALIFIED-runC.json.
  Raw wire of both streamed turns: raw-wire-qualified/qual-v2-sse-turn{1,2}.txt
  (turn 1: read_file+read_source_slice calls; turn 2: submit_result carrier).

Verification summary (run C): SSE completed 2/2 turns; streamed tool calls
assembled and executed with correct paths; submit_result decoded end-to-end;
marker byte-exact; content_sha256 byte-exact vs the Stratum-computed
authoritative digest; finish_reason tool_calls mapped to tool_use on every
turn; usage present and plausible (869/1131, total 2000); AgentLoop success
with no failure_observation.
