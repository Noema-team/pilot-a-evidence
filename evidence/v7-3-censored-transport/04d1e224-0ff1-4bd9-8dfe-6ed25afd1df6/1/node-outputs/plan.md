{
  "kind": "step-failure-observation",
  "result_transport": "textual-sle-output",
  "turns_taken": 3,
  "format_repairs": 0,
  "result_repairs": 0,
  "stop_reason": "tool_use",
  "text_length": 0,
  "tool_calls": [
    {
      "tool": "list_directory",
      "path": ".",
      "turn": 1
    },
    {
      "tool": "list_directory",
      "path": "apps/ai-server",
      "turn": 1
    },
    {
      "tool": "list_directory",
      "path": "apps/ai-server/rag-worker-service",
      "turn": 2
    },
    {
      "tool": "list_directory",
      "path": "apps/ai-server/rag-api-service",
      "turn": 2
    },
    {
      "tool": "list_directory",
      "path": "apps/ai-server/tests/integration",
      "turn": 2
    }
  ],
  "tool_uses": [
    {
      "name": "read_file",
      "argument_bytes": 52
    }
  ],
  "wire_observation": {
    "reasoning_chunks": 0,
    "reasoning_bytes": 0,
    "reasoning_fields": [],
    "content_bytes": 0,
    "tool_call_fragments": 2,
    "finish_reason": "tool_calls",
    "completion_tokens": 21,
    "reasoning_tokens": 0,
    "prompt_tokens": 4844,
    "total_tokens": 4865,
    "stream_id": "gen-1790850493-am2OgfyJM3gJ2zeIgNCI",
    "model": "z-ai/glm-5.3-flash",
    "provider": "Relace"
  },
  "error": "LLM call failed: fetch failed",
  "transport_failure": {
    "duration_ms": 15020,
    "error_name": "TypeError",
    "cause_name": "Error",
    "cause_code": "ECONNRESET",
    "cause_message": "read ECONNRESET"
  }
}