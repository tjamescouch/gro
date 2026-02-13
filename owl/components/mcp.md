# mcp

MCP client manager that connects to Model Context Protocol servers, discovers their tools, and routes tool calls during agentic turns.

## capabilities

- Connect to multiple MCP servers simultaneously via stdio transport
- Discover tools from each server and merge into a unified tool list
- Route tool calls to the correct server by tool name
- Convert MCP tool schemas to OpenAI function-calling format for driver compatibility
- Auto-discover servers from Claude Code's `~/.claude/settings.json`
- Accept explicit MCP config via `--mcp-config` flag (file path or inline JSON)

## interfaces

exposes:
- `McpManager.connectAll(configs) -> Promise<void>` — connect to all configured servers
- `McpManager.getToolDefinitions() -> any[]` — merged tool list in OpenAI function-calling format
- `McpManager.callTool(name, args) -> Promise<string>` — route and execute a tool call
- `McpManager.hasTool(name) -> boolean` — check if a tool is available
- `McpManager.disconnectAll() -> Promise<void>` — clean shutdown of all connections

depends on:
- `@modelcontextprotocol/sdk` — Client and StdioClientTransport
- Server configs from Claude Code settings or explicit `--mcp-config`

## invariants

- Tool names are globally unique across all connected servers (last-writer-wins on collision)
- `callTool` throws if the tool name is not found
- Tool results are always stringified — objects are JSON.stringify'd, arrays joined
- Disconnect is always called on process exit (interactive close handler, singleShot cleanup, error catch)
- Server connection failures are logged and skipped, not fatal
