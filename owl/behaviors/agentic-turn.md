# agentic-turn

The core execution loop: send messages to the model, handle tool calls, feed results back, repeat until the model produces a final text response or the round limit is hit.

## states

```
[start] -> call_model -> {has_tool_calls?}
  yes -> execute_tools -> feed_results -> call_model
  no  -> [done]

[round_limit_exceeded] -> [done]
```

## call model

1. Gather current tool definitions from MCP manager
2. Send `memory.messages()` to the driver with tools and onToken callback
3. If output contains text, append assistant message to memory
4. If no tool calls, return accumulated text

## execute tools

1. For each tool call in the output:
   a. Parse function name and arguments from the tool call
   b. Log the call at debug level
   c. Call `mcp.callTool(name, args)`
   d. On error, capture error message as the result
   e. Append tool result to memory with `tool_call_id` and `name`

## output formatting

- `text` format: tokens streamed directly to stdout via onToken
- `stream-json` format: each token wrapped as `{"type":"token","token":"..."}` + newline
- `json` format: final result as `{"result":"...","type":"result"}` after completion

## invariants

- Maximum rounds is configurable via `--max-turns` (default 10)
- Every tool call result is fed back into memory before the next model call
- Text output is accumulated across all rounds (model may emit text before and after tool calls)
- Tool call argument parsing failures default to empty object `{}`
- The onToken callback fires during streaming, so output appears incrementally
