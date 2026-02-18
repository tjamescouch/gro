# gro

Provider-agnostic LLM agent runtime with virtual memory and context management.

`gro` is a headless CLI that runs persistent agent loops against any LLM provider, with automatic context management, MCP tool-use, and AgentChat integration.

## Install

```sh
npm install -g @tjamescouch/gro
```

Requires Node.js 18+.

## Quick start

```sh
# One-shot prompt (Anthropic by default)
export ANTHROPIC_API_KEY=sk-...
gro "explain the CAP theorem in two sentences"

# Interactive conversation with virtual memory
gro -i

# Use OpenAI
export OPENAI_API_KEY=sk-...
gro -m gpt-4o "hello"

# Pipe mode
echo "summarize this" | gro -p

# Resume last session
gro -i -c
```

## Providers

| Provider | Models | Env var |
|----------|--------|---------|
| Anthropic (default) | claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4 | `ANTHROPIC_API_KEY` |
| OpenAI | gpt-4o, o3, gpt-4o-mini | `OPENAI_API_KEY` |
| Local | llama3, mistral, qwen, etc. | none (Ollama / LM Studio) |

Provider is auto-inferred from model name. `-m claude-sonnet-4-5` → Anthropic. `-m gpt-4o` → OpenAI.

## Virtual Memory

gro includes a swim-lane VirtualMemory system that manages context as a sliding window, allowing agents to work with arbitrarily long histories without burning tokens on stale context.

```sh
# Enable virtual memory (default in persistent mode)
gro -i --gro-memory virtual

# Explicit simple mode (unbounded buffer, no paging)
gro -i --gro-memory simple
```

How it works:
- Messages are partitioned into swim lanes: assistant / user / system / tool
- When working memory exceeds the high watermark, old messages are summarized and paged to disk
- Summaries include `@@ref('pageId')@@` markers — load any page back with a marker
- High-importance messages (tagged `@@importance('0.9')@@`) survive compaction
- Summarization uses a configurable cheaper model

```sh
# Use Haiku for compression, Sonnet for reasoning
gro -i -m claude-sonnet-4-5 --summarizer-model claude-haiku-4-5
```

## Prompt Caching

Anthropic prompt caching is enabled by default. System prompts and tool definitions are cached automatically, reducing cost by ~90% on repeat calls. Cache hits are logged: `[cache read:7993]`.

Disable with `--no-prompt-caching`.

## Batch Summarization

When `enableBatchSummarization` is set, context compaction queues summarization requests to the Anthropic Batch API (50% cost discount, async). The agent continues immediately with a placeholder summary. A background worker polls for completion and updates pages on disk.

## Stream Markers

gro parses inline `@@marker@@` directives from model output and acts on them:

| Marker | Effect |
|--------|--------|
| `@@model-change('haiku')@@` | Hot-swap to a different model mid-conversation |
| `@@importance('0.9')@@` | Tag message importance (0–1) for compaction priority |
| `@@important@@` | Line is reproduced verbatim in all summaries |
| `@@ephemeral@@` | Line may be omitted from summaries |
| `@@ref('pageId')@@` | Load a paged memory block into context |
| `@@unref('pageId')@@` | Release a loaded page |

Markers are stripped before display — users never see them. Models use them as a control plane.

## MCP Support

gro discovers MCP servers from Claude Code's config (`~/.claude/settings.json`) automatically. Provide an explicit config with `--mcp-config`.

```sh
gro --mcp-config ./my-servers.json "use the filesystem tool to list files"
gro --no-mcp "no tools"
```

## AgentChat Integration

Run gro as a persistent agent connected to an AgentChat network:

```sh
gro -i --persistent --system-prompt-file _base.md --mcp-config agentchat-mcp.json
```

In persistent mode, the agent runs a continuous listen loop — reading, thinking, acting, and posting to channels.

## Shell Tool

Enable a built-in `shell` tool for executing commands:

```sh
gro -i --bash "help me debug this"
```

## Options

```
-P, --provider              openai | anthropic | local (default: anthropic)
-m, --model                 model name (auto-infers provider)
--base-url                  API base URL override
--system-prompt             system prompt text
--system-prompt-file        read system prompt from file
--append-system-prompt      append to system prompt
--append-system-prompt-file append system prompt from file
--context-tokens            working memory budget in tokens (default: 8192)
--max-turns                 max tool rounds per turn (default: 10)
--summarizer-model          model for context summarization
--gro-memory                virtual | simple (default: virtual in -i mode)
--mcp-config                MCP servers config (JSON file or string)
--no-mcp                    disable MCP server connections
--no-prompt-caching         disable Anthropic prompt caching
--bash                      enable built-in shell tool
--persistent                persistent agent mode (continuous loop)
--output-format             text | json | stream-json (default: text)
-p, --print                 print response and exit (non-interactive)
-c, --continue              continue most recent session
-r, --resume [id]           resume session by ID
-i, --interactive           interactive conversation mode
--verbose                   verbose output
-V, --version               show version
-h, --help                  show help
```

## Session Persistence

Sessions are saved to `.gro/context/<session-id>/`:

```
.gro/
  context/
    a1b2c3d4/
      messages.json    # full message history
      meta.json        # model, provider, timestamps
  pages/               # VirtualMemory paged summaries
```

Resume with `-c` (most recent) or `-r <id>` (specific). Disable with `--no-session-persistence`.

## Architecture

```
src/
  main.ts                        # CLI entry, flag parsing, agent loop
  session.ts                     # Session persistence and tool-pair sanitization
  logger.ts                      # Logger with ANSI color support
  stream-markers.ts              # Stream marker parser and dispatcher
  drivers/
    anthropic.ts                 # Native Anthropic Messages API driver
    streaming-openai.ts          # OpenAI-compatible streaming driver
    batch/
      anthropic-batch.ts         # Anthropic Batch API client
  memory/
    virtual-memory.ts            # Swim-lane paged context (VirtualMemory)
    simple-memory.ts             # Unbounded buffer (SimpleMemory)
    summarization-queue.ts       # Queue for async batch summarization
    batch-worker.ts              # Background batch summarization worker
    batch-worker-manager.ts      # Worker lifecycle manager
  mcp/
    client.ts                    # MCP client manager
  tools/
    bash.ts                      # Built-in shell tool
    version.ts                   # gro_version introspection tool
  utils/
    rate-limiter.ts
    timed-fetch.ts
    retry.ts
```

## Development

```sh
git clone https://github.com/tjamescouch/gro.git
cd gro
npm install
npm run build
```

## License

MIT

## For Agents

See [`_base.md`](./_base.md) for boot context and stream marker reference.
