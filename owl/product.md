# gro

Provider-agnostic LLM runtime with context management. Single-agent, headless CLI that supersets the `claude` command-line interface.

## purpose

- Execute LLM completions against any provider (Anthropic, OpenAI, local) through a unified CLI
- Manage conversation context with swim-lane summarization so long sessions don't overflow the context window
- Connect to MCP servers for tool use, maintaining full compatibility with Claude Code's MCP ecosystem
- Persist sessions to disk so conversations can be resumed across process restarts
- Accept all `claude` CLI flags as a drop-in replacement, with graceful degradation for unimplemented features

## components

- **drivers**: Provider-specific chat completion backends (Anthropic native, OpenAI streaming, local via OpenAI-compat)
- **memory**: Conversation state management with optional swim-lane summarization and token budgeting
- **mcp**: MCP client manager that discovers servers, enumerates tools, and routes tool calls
- **session**: Persistence layer for saving/loading conversation state to `.gro/context/<id>/`
- **cli**: Flag parsing, config resolution, mode dispatch (interactive, print, pipe)

## success criteria

- `gro -p "hello"` produces a completion on stdout and exits
- `gro -i` enters interactive mode with context management and session auto-save
- `gro -c` resumes the most recent session with full message history
- `gro --allowedTools Bash "hello"` warns about unsupported flag and still works
- Summarization keeps token usage within budget during long interactive sessions
- MCP tools discovered from `~/.claude/settings.json` are callable during agentic turns
