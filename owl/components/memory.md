# memory

Conversation state management with optional summarization to stay within the context window budget.

## capabilities

- Unbounded message buffer (SimpleMemory) for short or externally managed conversations
- Swim-lane summarization (AdvancedMemory) with three independent lanes: assistant, system, user
- High/low watermark hysteresis to prevent summarization thrashing
- Background summarization that never blocks the caller (runOnce serialization)
- Separate summarizer model support — route compression to a cheaper model
- Session load/save to `.gro/context/<id>/`

## interfaces

exposes:
- `AgentMemory.add(msg) -> Promise<void>` — append message, trigger summarization check
- `AgentMemory.messages() -> ChatMessage[]` — current message buffer (copy)
- `AgentMemory.load(id) -> Promise<void>` — restore from disk
- `AgentMemory.save(id) -> Promise<void>` — persist to disk
- `AdvancedMemory(opts)` — constructor with driver, model, summarizerDriver, summarizerModel, budget params
- `SimpleMemory(systemPrompt?)` — constructor for no-summarization mode

depends on:
- `ChatDriver` for summarization calls (AdvancedMemory only)
- `session` module for persistence

## invariants

- System prompt is always the first message if present
- Summarization preserves the N most recent messages per lane (keepRecentPerLane)
- Summaries are labeled: `ASSISTANT SUMMARY:`, `SYSTEM SUMMARY:`, `USER SUMMARY:`
- Background summarization is serialized — only one runs at a time, with pending flag for re-runs
- `messages()` always returns a copy, never the internal buffer
- Token estimation uses character-based heuristic (avgCharsPerToken, default 4)
