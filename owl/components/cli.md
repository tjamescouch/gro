# cli

Flag parsing, configuration resolution, and mode dispatch. Entry point for the gro runtime.

## capabilities

- Parse CLI flags with support for value flags, boolean flags, and positional arguments
- Auto-infer provider from model name (`claude-*` -> anthropic, `gpt-*` -> openai, `llama*` -> local)
- Resolve system prompts from flags, files, and append combinations
- Dispatch to interactive mode, single-shot mode, or print/pipe mode
- Accept all `claude` CLI flags with graceful degradation for unsupported ones
- Version display, help text

## interfaces

exposes:
- `loadConfig() -> GroConfig` — parse argv into a typed config object
- `createDriver(cfg) -> ChatDriver` — factory for the main chat driver
- `createDriverForModel(provider, model, apiKey, baseUrl) -> ChatDriver` — factory for arbitrary driver instances
- `createMemory(cfg, driver) -> AgentMemory` — factory for memory (SimpleMemory or AdvancedMemory)
- `executeTurn(driver, memory, mcp, cfg) -> Promise<string>` — one agentic turn with tool loop
- `singleShot(cfg, driver, mcp, sessionId) -> Promise<void>` — non-interactive mode
- `interactive(cfg, driver, mcp, sessionId) -> Promise<void>` — REPL mode with auto-save

depends on:
- All other components (drivers, memory, mcp, session)
- Node.js readline for interactive mode

## invariants

- `-p` forces non-interactive mode, `-i` forces interactive mode
- Default mode is interactive when TTY and no positional args, otherwise single-shot
- Unsupported claude flags are accepted with a warning to stderr, never crash
- Session ID is generated once at startup and threaded through all operations
- `--continue` and `--resume` load existing session state before the first turn
- Interactive mode auto-saves after every turn and on close
- MCP connections are always cleaned up (try/finally in main)
