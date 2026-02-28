# gro

<img width="200" height="200" alt="ChatGPT Image Feb 22, 2026, 03_15_50 AM" src="https://github.com/user-attachments/assets/3e168b1c-4d4b-4eca-b898-c9b6826ab1a0" />

**Provider-agnostic LLM agent runtime** with virtual memory, streaming tool-use, and context management.

`gro` runs persistent agent loops against any LLM provider — Anthropic, OpenAI, Google, xAI, or local — with automatic context paging, MCP tool integration, and AgentChat network support. For an interactive TUI see [gtui](https://github.com/tjamescouch/gtui) available as an [npm package](https://www.npmjs.com/package/@tjamescouch/gtui). This software is intended to be run in a containerized solution to protect the host machine.

[![npm version](https://img.shields.io/npm/v/@tjamescouch/gro.svg)](https://www.npmjs.com/package/@tjamescouch/gro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

## Install

```sh
npm install -g @tjamescouch/gro
```

Requires Node.js 18+.

---

## Quick Start

```sh
# One-shot prompt (Anthropic by default)
export ANTHROPIC_API_KEY=sk-...
gro "explain the CAP theorem in two sentences"

# Interactive conversation with virtual memory
gro -i

# Resume last session (like `claude --continue`)
gro -c

# Use a specific model (provider auto-inferred)
export OPENAI_API_KEY=sk-...
gro -m gpt-4.1 "hello"

# Pipe mode (like `claude -p`)
echo "summarize this" | gro -p
```

---

## Providers

Provider is auto-inferred from model name — `-m claude-sonnet-4-5` uses Anthropic, `-m gpt-4.1` uses OpenAI.

| Provider | Example Models | Env var | Required? |
|----------|---------------|---------|-----------|
| **Anthropic** (default) | `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-5` | `ANTHROPIC_API_KEY` | Yes (default provider) |
| **OpenAI** | `gpt-4.1`, `gpt-4.1-mini`, `o3`, `o4-mini` | `OPENAI_API_KEY` | Only if using OpenAI models |
| **Google** | `gemini-2.5-flash`, `gemini-2.5-pro` | `GOOGLE_API_KEY` | Only if using Gemini models |
| **xAI** | `grok-4`, `grok-4-latest` | `XAI_API_KEY` | Only if using Grok models |
| **Groq** | `llama-3.3-70b-versatile` | `GROQ_API_KEY` | Only if using Groq-hosted models |
| **Local** | `llama3`, `mistral`, `qwen` | — | No key needed (Ollama / LM Studio) |

### Setting API Keys

**macOS** — store keys in Keychain (persistent, secure):

```sh
gro --set-key anthropic    # prompted for key, stored in macOS Keychain
gro --set-key openai
gro --set-key xai
gro --set-key google
gro --set-key groq
```

**Linux / CI** — use environment variables:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export XAI_API_KEY=xai-...
export GOOGLE_API_KEY=AIza...
export GROQ_API_KEY=gsk_...
```

Key resolution order: macOS Keychain → environment variable. You only need to set keys for providers you use.

---

## Virtual Memory

gro includes a swim-lane **VirtualMemory** system that manages context as a sliding window, allowing agents to work across arbitrarily long conversations without burning tokens on stale context.

```sh
gro -i --gro-memory virtual        # default in interactive mode
gro -i --gro-memory simple         # unbounded buffer, no paging
gro -i --gro-memory fragmentation  # zero-cost stochastic paging
gro -i --gro-memory hnsw           # semantic similarity retrieval
```

**How it works:**

- Messages are partitioned into swim lanes: `assistant` / `user` / `system` / `tool`
- When working memory exceeds the high-watermark, old messages are summarized and paged to disk
- Summaries preserve `@@ref('id')@@` markers — load any page back on demand
- High-importance messages (tagged `@@important@@`) survive compaction
- Summarization uses a configurable, cheaper model

```sh
# Use Haiku for compression, Sonnet for reasoning
gro -i -m claude-sonnet-4-5 --summarizer-model claude-haiku-4-5
```

### Memory Modes

| Mode | Description | Cost |
|------|-------------|------|
| `virtual` | Swim-lane LLM summarization (default) | Low (summarizer model) |
| `simple` | Unbounded buffer, no paging | None |
| `fragmentation` | Age-biased random sampling | None |
| `hnsw` | Semantic similarity vector index | None + embedding calls |

---

## Extended Thinking

Control reasoning depth dynamically with the `@@thinking()@@` stream marker. The level selects the model tier and allocates thinking tokens (Anthropic extended thinking; OpenAI reasoning tokens).

```sh
gro -i -m claude-sonnet-4-5 "solve this complex problem"
# Agent can emit @@think@@ to escalate to Opus when stuck
```

| Level | Tier | Use case |
|-------|------|----------|
| `0.0–0.24` | Haiku / flash-lite | Fast, cheap — formatting, lookups, routine transforms |
| `0.25–0.64` | Sonnet / flash | Balanced — most tasks requiring judgment or code |
| `0.65–1.0` | Opus / pro | Deep reasoning — architecture, when stuck, low confidence |

The thinking budget **decays ×0.6 per idle round** unless renewed. Agents naturally step down from expensive tiers when not actively working hard problems.

**Token reservation:** 30% of `max_tokens` is reserved for completion output to prevent truncation on high-budget calls. Example: `max_tokens=4096, thinking=0.8` → ~2293 thinking tokens, ~1803 output tokens.

---

## Prompt Caching

Anthropic prompt caching is **enabled by default**. System prompts and tool definitions are cached automatically, reducing cost by ~90% on repeat calls. Cache hits are reported: `[cache read: 7993 tokens]`.

```sh
gro --no-prompt-caching   # disable if needed
```

---

## Batch Summarization

When `enableBatchSummarization` is set, context compaction queues summarization requests to the Anthropic Batch API (50% cost discount, async). The agent continues immediately with a placeholder summary. A background worker polls for completion and updates pages on disk.

---

## Stream Markers

gro parses inline `@@marker()@@` directives from model output and acts on them in real-time. Markers are stripped before display — users never see them. Models use them as a runtime control plane.

| Marker | Effect |
|--------|--------|
| `@@model-change('opus')@@` | Hot-swap to a different model mid-conversation |
| `@@thinking(0.85)@@` | Set thinking level — controls model tier and token budget |
| `@@importance('0.9')@@` | Tag message importance (0–1) for compaction priority |
| `@@important@@` | Line is reproduced verbatim in all summaries |
| `@@ephemeral@@` | Line may be omitted from summaries entirely |
| `@@ref('id')@@` | Load a paged memory block into context |
| `@@unref('id')@@` | Release a loaded page to free context budget |

See [`STREAM_MARKERS.md`](./STREAM_MARKERS.md) for the complete reference.

---

## MCP Support

gro discovers MCP servers from Claude Code's config (`~/.claude/settings.json`) automatically. Provide an explicit config with `--mcp-config`.

```sh
gro --mcp-config ./my-servers.json "use the filesystem tool to list files"
gro --no-mcp                       "no tools"
```

---

## Containerized Deployment

For production or multi-agent workloads, run gro inside an isolated container using [thesystem](https://github.com/tjamescouch/thesystem). This provides API key isolation (keys never leave the host), session persistence across runs, and sandboxed execution inside a Lima VM + Podman container.

```sh
# Install thesystem and boot the environment
brew tap tjamescouch/thesystem && brew install thesystem
thesystem init && thesystem keys set anthropic sk-ant-...
thesystem start

# Drop into an interactive gro session inside a pod (resumes last session)
thesystem gro
thesystem gro -P openai -m gpt-4.1

# Fresh session (no resume) — equivalent to `claude -p` behavior
thesystem gro --no-continue
```

See the [thesystem README](https://github.com/tjamescouch/thesystem) for full setup and multi-agent swarm configuration.

## AgentChat Integration

Run gro as a persistent agent connected to an AgentChat network:

```sh
gro -i --persistent --system-prompt-file _base.md --mcp-config agentchat-mcp.json
```

**Persistent mode** (`--persistent`) keeps the agent in a continuous tool-calling loop. If the model stops calling tools, gro injects a system nudge to resume listening. The loop is indefinite: `agentchat_listen` → process → respond → repeat.

An external process manager (systemd, supervisor, Docker) handles process lifecycle. Auto-save triggers every 10 tool rounds.

---

## PLASTIC Mode (Self-Modifying Agent)

PLASTIC mode lets an agent read, modify, and reload its own source code at runtime. The agent runs from a writable overlay directory (`~/.gro/plastic/overlay/`) — a copy of the stock `dist/` tree. It can edit files in the overlay, emit `@@reboot@@` to restart, and come back running the modified code.

```sh
# Run with PLASTIC enabled (containerized)
thesystem gro --plastic

# Or directly (not recommended outside containers)
GRO_PLASTIC=1 gro -i
```

### How It Works

1. **Boot**: stock `dist/main.js` diverts to `plastic/bootstrap.js`, which loads `overlay/main.js`
2. **Read**: the agent's source is pre-chunked into virtual memory pages (`@@ref('pg_src_...')@@`)
3. **Write**: `write_source` tool modifies files in the overlay (with syntax validation)
4. **Reboot**: `@@reboot@@` marker saves state and exits with code 75; an outer runner restarts
5. **Crash recovery**: if the overlay crashes on boot, it's wiped and re-initialized from stock

### Safety

PLASTIC mode is **training-only infrastructure**. It is designed for supervised experimentation in disposable containerized environments, not production use.

**Always run PLASTIC inside a container.** The `thesystem gro --plastic` command provides:
- Isolated Podman container (no host filesystem access)
- API keys injected via proxy (never on disk inside the container)
- Persistent volume for sessions (survives container restarts)
- Reboot loop with a 20-restart cap (prevents infinite loops)

**What the agent can modify:**
- Its own runtime code in `~/.gro/plastic/overlay/`
- Its version string, tool definitions, marker handling, memory system

**What the agent cannot do:**
- Escape the container or access the host
- Modify the stock install (`/usr/local/lib/node_modules/...` is read-only)
- Survive a container rebuild (`--rebuild` wipes everything)
- Persist changes across stock upgrades (overlay is wiped when npm version increases)

**Risk mitigations:**
- `write_source` validates JavaScript syntax before writing — rejects broken code
- Overlay crash triggers automatic fallback to stock code
- Reboot cap (20) prevents runaway restart loops
- Version mismatch detection wipes stale overlays on genuine upgrades
- All modifications are confined to the overlay — `rm -rf ~/.gro/plastic/overlay/` restores stock behavior

> **Do not run PLASTIC mode on a host machine with access to sensitive data, credentials, or production systems.** The agent has a shell tool and can execute arbitrary code. Container isolation is your primary safety boundary.

---

## Shell Tool

Enable a built-in `shell` tool for executing commands:

```sh
gro -i --bash "help me debug this"
```

Commands run with a 120s timeout and 30 KB output cap. The tool is opt-in and not available by default.

---

## Built-in Tools

These tools are always available (no flags required):

| Tool | Description |
|------|-------------|
| `Read` | Read file contents with optional line range |
| `Write` | Write content to a file (creates parent dirs) |
| `Glob` | Find files by glob pattern (`.gitignore`-aware) |
| `Grep` | Search file contents with POSIX regex |
| `apply_patch` | Apply unified diffs to files |
| `gro_version` | Runtime identity and version info |
| `memory_status` | VirtualMemory statistics |
| `memory_report` | Memory performance and tuning recommendations |
| `memory_tune` | Auto-tune memory parameters |
| `compact_context` | Force immediate context compaction |
| `cleanup_sessions` | Remove orphaned sessions older than 48 hours |

---

## Options

```
-P, --provider                  openai | anthropic | google | xai | local
-m, --model                     Model name (provider auto-inferred)
--base-url                      API base URL override
--system-prompt                 System prompt text
--system-prompt-file            Read system prompt from file
--append-system-prompt          Append to system prompt
--append-system-prompt-file     Append system prompt from file
--context-tokens                Working memory budget in tokens (default: 8192)
--max-turns                     Max tool rounds per turn (default: 10)
--summarizer-model              Model for context summarization
--gro-memory                    virtual | simple | fragmentation | hnsw
--mcp-config                    MCP servers config (JSON file or inline string)
--no-mcp                        Disable MCP server connections
--no-prompt-caching             Disable Anthropic prompt caching
--bash                          Enable built-in shell tool
--persistent                    Persistent agent mode (continuous loop)
--output-format                 text | json | stream-json (default: text)
-p, --print                     Print response and exit (non-interactive)
-c, --continue                  Continue most recent session
-r, --resume [id]               Resume session by ID
-i, --interactive               Interactive conversation mode
--verbose                       Verbose output
-V, --version                   Show version
-h, --help                      Show help
```

---

## Session Persistence

Sessions are saved automatically to `.gro/`:

```
.gro/
  context/
    <session-id>/
      messages.json    # full message history
      meta.json        # model, provider, timestamps
  pages/               # VirtualMemory paged summaries
```

Resume with `-c` (most recent) or `-r <id>` (specific). Disable with `--no-session-persistence`.

---

## Architecture

```
src/
  main.ts                      # CLI entry, flag parsing, agent loop
  session.ts                   # Session persistence and tool-pair sanitization
  errors.ts                    # Typed error hierarchy (GroError)
  logger.ts                    # Logger with ANSI color support
  stream-markers.ts            # Stream marker parser and dispatcher
  spend-meter.ts               # Token cost tracking
  drivers/
    anthropic.ts               # Native Anthropic Messages API (no SDK)
    streaming-openai.ts        # OpenAI-compatible streaming driver
    types.ts                   # ChatDriver interface, message types
    batch/
      anthropic-batch.ts       # Anthropic Batch API client
  memory/
    agent-memory.ts            # AgentMemory interface
    virtual-memory.ts          # Swim-lane paged context
    simple-memory.ts           # Unbounded buffer
    fragmentation-memory.ts    # Stochastic sampling pager
    hnsw-memory.ts             # Semantic similarity retrieval
    summarization-queue.ts     # Async batch summarization queue
    batch-worker.ts            # Background batch worker
    batch-worker-manager.ts    # Worker lifecycle manager
    memory-metrics.ts          # Performance metrics
    memory-tuner.ts            # Auto-tuning logic
    vector-index.ts            # HNSW vector index
  mcp/
    client.ts                  # MCP client manager
  tools/
    bash.ts                    # Built-in shell tool (--bash flag)
    read.ts / write.ts         # File I/O
    glob.ts / grep.ts          # File search
    agentpatch.ts              # Unified patch application
    version.ts                 # gro_version introspection
    memory-status.ts           # VirtualMemory stats
    memory-report.ts           # Performance report
    memory-tune.ts             # Auto-tune
    compact-context.ts         # Manual compaction trigger
    cleanup-sessions.ts        # Session cleanup
  plastic/
    bootstrap.ts               # PLASTIC overlay loader with crash fallback
    init.ts                    # Overlay setup, source page generation
    write-source.ts            # write_source tool (overlay file modification)
  utils/
    rate-limiter.ts            # Token bucket rate limiter
    timed-fetch.ts             # Fetch with configurable timeout
    retry.ts                   # Exponential backoff retry logic
  runtime/
    config-manager.ts          # Runtime configuration
    directive-parser.ts        # Stream directive parsing
  tui/
    main.ts                    # Terminal UI entry
    ui/                        # Blessed TUI panels
```

---

## Development

```sh
git clone https://github.com/tjamescouch/gro.git
cd gro
npm install
npm run build
npm test
```

---

## License

MIT © [tjamescouch](https://github.com/tjamescouch)

---

## For Agents

Boot context and stream marker reference: [`_base.md`](./_base.md)
