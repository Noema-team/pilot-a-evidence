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
  "error": "LLM call failed: config-guard: STOP — synthesize-definition: tool set [read_file,read_source_slice,list_directory,submit_result] matches none of the frozen shapes [nonexistent_tool]; submit_result offered on a step whose frozen shape declares none — the model call was NOT made",
  "transport_failure": {
    "duration_ms": 0,
    "error_name": "ConfigGuardViolation"
  }
}