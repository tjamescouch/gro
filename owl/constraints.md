# constraints

## technology

- TypeScript, targeting ES2021
- Bun as primary runtime, Node.js 18+ as fallback
- NodeNext module resolution with explicit `.js` import extensions
- No frontend, no terminal UI, no raw/cooked mode — stdout/stderr only

## dependencies

- `@modelcontextprotocol/sdk` for MCP client transport (stdio)
- `@types/node` for type definitions
- `typescript` for compilation
- No other runtime dependencies — HTTP calls use native fetch

## architecture

- Single-agent only. Multi-agent coordination happens via agentchat sockets, not inside gro
- Drivers are pure functions: `(messages, opts) => ChatOutput`. No state, no side effects beyond the HTTP call
- Memory is a class hierarchy: `AgentMemory` (abstract) -> `SimpleMemory` | `AdvancedMemory`
- Session state lives in `.gro/context/<uuid>/` with `messages.json` and `meta.json`
- MCP servers are discovered from Claude Code's `settings.json` or explicit `--mcp-config` paths
- Config is resolved from CLI flags only (no config file yet). Environment variables for API keys

## style

- Prefer `async/await` over raw promises
- Prefer explicit types over inference for function signatures
- No classes where a plain function suffices (drivers are factory functions, not classes)
- Error messages go to stderr via Logger. Completions go to stdout
- Graceful degradation: unknown flags warn, never crash
