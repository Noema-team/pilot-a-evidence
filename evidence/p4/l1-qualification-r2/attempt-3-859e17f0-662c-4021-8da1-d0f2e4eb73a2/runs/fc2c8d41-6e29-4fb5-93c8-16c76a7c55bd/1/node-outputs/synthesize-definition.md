{
  "kind": "step-failure-observation",
  "result_transport": "submit-result",
  "turns_taken": 1,
  "format_repairs": 0,
  "result_repairs": 0,
  "stop_reason": "provider_error",
  "text_length": 0,
  "tool_calls": [],
  "tool_uses": [],
  "error": "LLM call failed: config-guard: STOP — evidence-integrity: provider response could not be archived (config-guard: STOP — settings: settings sha256 fcd35b658368 != frozen 5634b2e897ee — the runtime configuration has diverged from the frozen bytes (P2 defect class)) — the response is NOT evidenced; G2 STOP",
  "transport_failure": {
    "duration_ms": 3,
    "error_name": "ConfigGuardViolation"
  }
}