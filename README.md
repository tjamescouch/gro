# gro

Provider-agnostic LLM runtime with context management.

`gro` is a headless (no TUI) CLI that runs a single agent loop against an LLM provider, persists sessions to disk, and can connect to MCP servers for tool-use.

- Works as a **one-shot** prompt runner or an **interactive** agent loop
- **Provider-agnostic** (Anthropic / OpenAI / local OpenAI-compatible)
- **Session persistence** to `.gro/context/<session-id>/...`
- **Context management** via background summarization
- **MCP support** (discovers Claude Code MCP servers by default)

Repo note: agent work happens on `feature/*` branches; `main` is protected.

## Install

```sh
git clone https://github.com/tjamescouch/gro.git
cd gro
npm install
npx tsc
```

Requires [Bun](https://bun.sh) or Node.js 18+.

## Quick start

```sh
# One-shot prompt (Anthropic by default)
export ANTHROPIC_API_KEY=sk-...
node dist/main.js "explain the CAP theorem in two sentences"

# Pipe mode
echo "summarize this" | node dist/main.js -p

# Interactive conversation
node dist/main.js -i

# Use OpenAI
export OPENAI_API_KEY=sk-...
node dist/main.js -m gpt-4o "hello"

# Local model via Ollama
node dist/main.js -m llama3 "hello"
```

Tip: during development you can run directly from TypeScript:

```sh
npx tsx src/main.ts -i
```

## Providers

| Provider | Flag | Models | Env var |
|----------|------|--------|---------|
| Anthropic | `-P anthropic` (default) | claude-sonnet-4-20250514, claude-haiku-3, etc. | `ANTHROPIC_API_KEY` |
| OpenAI | `-P openai` | gpt-4o, o3-mini, etc. | `OPENAI_API_KEY` |
| Local | `-P local` | llama3, mistral, qwen, etc. | none (Ollama/LM Studio) |

The provider is auto-inferred from the model name. `-m claude-sonnet-4-20250514` sets provider to Anthropic. `-m gpt-4o` sets provider to OpenAI.

## Options

```
-P, --provider         openai | anthropic | local (default: anthropic)
-m, --model            model name (auto-infers provider)
--base-url             API base URL
--system-prompt        system prompt text
--system-prompt-file   read system prompt from file
--append-system-prompt append to system prompt
--append-system-prompt-file  append system prompt from file
--context-tokens       context window budget (default: 8192)
--max-turns            max agentic rounds per turn (default: 10)
--summarizer-model     model for context summarization (default: same as --model)
--output-format        text | json | stream-json (default: text)
--mcp-config           load MCP servers from JSON file or string
--no-mcp               disable MCP server connections
--no-session-persistence  don't save sessions to .gro/
-p, --print            print response and exit (non-interactive)
-c, --continue         continue most recent session
-r, --resume [id]      resume a session by ID
-i, --interactive      interactive conversation mode
--verbose              verbose output
-V, --version          show version
-h, --help             show help
```

Run `node dist/main.js --help` to see the full, up-to-date CLI.

## Session persistence

Interactive sessions are saved to `.gro/context/<session-id>/`:

```
.gro/
  context/
    a1b2c3d4/
      messages.json    # full message history
      meta.json        # model, provider, timestamps
```

Resume the most recent session with `-c`, or a specific one with `-r <id>`.

Disable with `--no-session-persistence`.

## Context management

In interactive mode, gro uses swim-lane summarization to manage context:

- Three independent lanes (assistant / system / user) are summarized separately
- High/low watermark hysteresis prevents thrashing
- Summarization runs in the background and never blocks
- Use `--summarizer-model` to route summarization to a cheaper model:

```sh
# Sonnet for reasoning, Haiku for compression
node dist/main.js -i -m claude-sonnet-4-20250514 --summarizer-model claude-haiku-3
```

## MCP support

gro discovers MCP servers from Claude Code's config (`~/.claude/settings.json`) automatically. You can also load MCP config explicitly:

```sh
node dist/main.js --mcp-config ./my-mcp-servers.json "use the filesystem tool to list files"
```

Disable MCP with `--no-mcp`.

### Config discovery

By default, gro attempts to discover MCP servers from Claude Code’s config:

- `~/.claude/settings.json` → `mcpServers`

You can also provide an explicit config file or JSON string via `--mcp-config`.

### Tool availability

Tools available to the model depend on which MCP servers you have configured and which are reachable.

## Claude CLI compatibility

gro accepts all `claude` CLI flags. Unsupported flags produce a warning and are ignored — nothing crashes.

```sh
# These all work (some with graceful degradation)
node dist/main.js -p --model claude-sonnet-4-20250514 --max-turns 5 "hello"
node dist/main.js --allowedTools "Bash" "hello"  # warns: --allowedTools not yet supported
```

## Architecture

```
src/
  main.ts                    # CLI entry point, flag parsing, mode dispatch
  session.ts                 # .gro directory and session persistence
  logger.ts                  # Logger with color support
  drivers/
    types.ts                 # ChatDriver, ChatMessage, ChatOutput interfaces
    streaming-openai.ts      # OpenAI-compatible streaming driver
    anthropic.ts             # Native Anthropic Messages API driver
  memory/
    agent-memory.ts          # Abstract base with background summarization
    advanced-memory.ts       # Swim-lane summarization with token budgeting
    simple-memory.ts         # Unbounded message buffer
  mcp/
    client.ts                # MCP client manager (connect, discover, call tools)
    index.ts                 # Re-exports
  utils/
    rate-limiter.ts          # Per-lane FIFO rate limiter
    timed-fetch.ts           # Fetch with timeout
```

## Development

```sh
npm install
npm run build
npm test
```

### Safe git workflow

- Never commit directly to `main`
- Create a `feature/*` branch for changes

## License

MIT
