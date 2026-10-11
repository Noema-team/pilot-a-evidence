{
  "kind": "step-failure-observation",
  "result_transport": "submit-result",
  "turns_taken": 2,
  "format_repairs": 0,
  "result_repairs": 1,
  "stop_reason": "tool_use",
  "text_length": 0,
  "tool_calls": [],
  "tool_uses": [
    {
      "name": "submit_result",
      "argument_bytes": 1396
    }
  ],
  "wire_observation": {
    "finish_reason": "tool_calls"
  },
  "error": "Submitted result was rejected by output contract 'decision-application' and result repair is exhausted (2 provider turn(s), 1 result-repair attempt(s)): Your submitted result was rejected by the output contract for 'decision-application'. Reason: the submitted result does not match the required semantic shape — (root): Unrecognized key(s) in object: 'goal', 'facts'\nRe-submit the complete corrected result in the same required shape. Do not change anything that was not rejected.",
  "rejected_result": {
    "argument_bytes": 1396,
    "repair_instruction": "Your submitted result was rejected by the output contract for 'decision-application'. Reason: the submitted result does not match the required semantic shape — (root): Unrecognized key(s) in object: 'goal', 'facts'\nRe-submit the complete corrected result in the same required shape. Do not change anything that was not rejected."
  }
}