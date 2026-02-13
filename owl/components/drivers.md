# drivers

Chat completion backends that translate between gro's internal message format and provider-specific APIs.

## capabilities

- Streaming token delivery via `onToken` callback
- Tool call parsing and accumulation from streamed deltas
- Reasoning token forwarding via `onReasoningToken` callback
- Provider auto-inference from model name patterns

## interfaces

exposes:
- `makeStreamingOpenAiDriver(opts) -> ChatDriver` — OpenAI-compatible streaming (works with OpenAI, LM Studio, Ollama)
- `makeAnthropicDriver(opts) -> ChatDriver` — Native Anthropic Messages API with system message separation
- `ChatDriver.chat(messages, opts) -> Promise<ChatOutput>` — unified completion interface

depends on:
- `timed-fetch` for HTTP with timeout
- Native `fetch` API

## invariants

- Drivers never mutate the input message array
- `ChatOutput.text` contains the full accumulated text, even when tokens were streamed
- `ChatOutput.toolCalls` is always an array (empty if no tool calls)
- Tool call arguments are always serialized JSON strings, even if the provider returns objects
- System messages are separated from the conversation for Anthropic (API requirement)
