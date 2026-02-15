#!/usr/bin/env node
/**
 * gro — provider-agnostic LLM runtime with context management.
 *
 * Extracted from org. Single-agent, headless, no terminal UI.
 * Reads prompt from argv or stdin, manages conversation state,
 * outputs completion to stdout. Connects to MCP servers for tools.
 *
 * Supersets the claude CLI flags for drop-in compatibility.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Logger, C } from "./logger.js";
import { makeStreamingOpenAiDriver } from "./drivers/streaming-openai.js";
import { makeAnthropicDriver } from "./drivers/anthropic.js";
import { SimpleMemory } from "./memory/simple-memory.js";
import { AdvancedMemory } from "./memory/advanced-memory.js";
import { McpManager } from "./mcp/index.js";
import { newSessionId, findLatestSession, loadSession, ensureGroDir } from "./session.js";
import { groError, asError, isGroError, errorLogFields } from "./errors.js";
import type { McpServerConfig } from "./mcp/index.js";
import type { ChatDriver, ChatMessage, ChatOutput, TokenUsage } from "./drivers/types.js";
import type { AgentMemory } from "./memory/agent-memory.js";
import { bashToolDefinition, executeBash } from "./tools/bash.js";
import { agentpatchToolDefinition, executeAgentpatch } from "./tools/agentpatch.js";
import { groVersionToolDefinition, executeGroVersion, getGroVersion } from "./tools/version.js";
import { createMarkerParser, extractMarkers } from "./stream-markers.js";

const VERSION = getGroVersion();

// ---------------------------------------------------------------------------
// Graceful shutdown state — module-level so signal handlers can save sessions.
// ---------------------------------------------------------------------------
let _shutdownMemory: AgentMemory | null = null;
let _shutdownSessionId: string | null = null;
let _shutdownSessionPersistence = false;

/** Auto-save interval: save session every N tool rounds in persistent mode */
const AUTO_SAVE_INTERVAL = 10;

// Wake notes: a runner-global file that is prepended to the system prompt on process start
// so agents reliably see dev workflow + memory pointers on wake.
const WAKE_NOTES_DEFAULT_PATH = join(process.env.HOME || "", ".claude", "WAKE.md");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface GroConfig {
  provider: "openai" | "anthropic" | "local";
  model: string;
  baseUrl: string;
  apiKey: string;
  systemPrompt: string;
  wakeNotes: string;
  wakeNotesEnabled: boolean;
  contextTokens: number;
  maxTokens: number;
  interactive: boolean;
  print: boolean;
  maxToolRounds: number;
  persistent: boolean;
  maxIdleNudges: number;
  bash: boolean;
  summarizerModel: string | null;
  outputFormat: "text" | "json" | "stream-json";
  continueSession: boolean;
  resumeSession: string | null;
  sessionPersistence: boolean;
  verbose: boolean;
  mcpServers: Record<string, McpServerConfig>;
}

function loadMcpServers(mcpConfigPaths: string[]): Record<string, McpServerConfig> {
  // If explicit --mcp-config paths given, use those
  if (mcpConfigPaths.length > 0) {
    const merged: Record<string, McpServerConfig> = {};
    for (const p of mcpConfigPaths) {
      try {
        let raw: string;
        if (p.startsWith("{")) {
          raw = p; // inline JSON
        } else if (existsSync(p)) {
          raw = readFileSync(p, "utf-8");
        } else {
          Logger.warn(`MCP config not found: ${p}`);
          continue;
        }
        const parsed = JSON.parse(raw);
        const servers = parsed.mcpServers || parsed;
        if (typeof servers === "object") {
          Object.assign(merged, servers);
        }
      } catch (e: unknown) {
        const ge = groError("config_error", `Failed to parse MCP config ${p}: ${asError(e).message}`, { cause: e });
        Logger.warn(ge.message, errorLogFields(ge));
      }
    }
    return merged;
  }

  // Try Claude Code config locations
  const candidates = [
    join(process.cwd(), ".claude", "settings.json"),
    join(process.env.HOME || "", ".claude", "settings.json"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
          Logger.debug(`Loaded MCP config from ${path}`);
          return parsed.mcpServers;
        }
      } catch (e: unknown) {
        const ge = groError("config_error", `Failed to parse ${path}: ${asError(e).message}`, { cause: e });
        Logger.debug(ge.message, errorLogFields(ge));
      }
    }
  }
  return {};
}

// Flags that claude supports but we don't yet — accept gracefully
const UNSUPPORTED_VALUE_FLAGS = new Set([
  "--effort", "--agent", "--agents", "--betas", "--fallback-model",
  "--permission-prompt-tool", "--permission-mode", "--tools",
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--add-dir", "--plugin-dir", "--settings", "--setting-sources",
  "--json-schema", "--input-format", "--file",
  "--resume-session-at", "--rewind-files", "--session-id",
  "--debug-file", "--sdk-url",
]);

const UNSUPPORTED_BOOL_FLAGS = new Set([
  "--include-partial-messages", "--replay-user-messages",
  "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
  "--fork-session", "--from-pr", "--strict-mcp-config", "--mcp-debug",
  "--ide", "--chrome", "--no-chrome", "--disable-slash-commands",
  "--init", "--init-only", "--maintenance", "--enable-auth-status",
]);

function loadConfig(): GroConfig {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  const mcpConfigPaths: string[] = [];

  // Wake file: global startup instructions injected into the system prompt.
  // This is intentionally runner-level (not per-repo) so agents reliably see
  // the same rules on boot.
  const defaultWakeFile = join(homedir(), ".claude", "WAKE.md");
  let wakeFile: string | null = defaultWakeFile;
  let disableWake = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // --- gro native flags ---
    if (arg === "--provider" || arg === "-P") { flags.provider = args[++i]; }
    else if (arg === "--model" || arg === "-m") { flags.model = args[++i]; }
    else if (arg === "--base-url") { flags.baseUrl = args[++i]; }
    else if (arg === "--system-prompt") { flags.systemPrompt = args[++i]; }
    else if (arg === "--system-prompt-file") { flags.systemPromptFile = args[++i]; }
    else if (arg === "--append-system-prompt") { flags.appendSystemPrompt = args[++i]; }
    else if (arg === "--append-system-prompt-file") { flags.appendSystemPromptFile = args[++i]; }
    else if (arg === "--wake-notes") { flags.wakeNotes = args[++i]; }
    else if (arg === "--no-wake-notes") { flags.noWakeNotes = "true"; }
    else if (arg === "--context-tokens") { flags.contextTokens = args[++i]; }
    else if (arg === "--max-tokens") { flags.maxTokens = args[++i]; }
    else if (arg === "--max-tool-rounds" || arg === "--max-turns") { flags.maxToolRounds = args[++i]; }
    else if (arg === "--bash") { flags.bash = "true"; }
    else if (arg === "--persistent" || arg === "--keep-alive") { flags.persistent = "true"; }
    else if (arg === "--max-idle-nudges") { flags.maxIdleNudges = args[++i]; }
    else if (arg === "--max-thinking-tokens") { flags.maxThinkingTokens = args[++i]; } // accepted, not used yet
    else if (arg === "--max-budget-usd") { flags.maxBudgetUsd = args[++i]; } // accepted, not used yet
    else if (arg === "--summarizer-model") { flags.summarizerModel = args[++i]; }
    else if (arg === "--output-format") { flags.outputFormat = args[++i]; }
    else if (arg === "--mcp-config") { mcpConfigPaths.push(args[++i]); }
    else if (arg === "-i" || arg === "--interactive") { flags.interactive = "true"; }
    else if (arg === "-p" || arg === "--print") { flags.print = "true"; }
    else if (arg === "-c" || arg === "--continue") { flags.continue = "true"; }
    else if (arg === "-r" || arg === "--resume") {
      // --resume can have optional value
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        flags.resume = args[++i];
      } else {
        flags.resume = "latest";
      }
    }
    else if (arg === "--no-mcp") { flags.noMcp = "true"; }
    else if (arg === "--no-session-persistence") { flags.noSessionPersistence = "true"; }
    else if (arg === "--verbose") { flags.verbose = "true"; }
    else if (arg === "-d" || arg === "--debug" || arg === "-d2e" || arg === "--debug-to-stderr") {
      flags.verbose = "true";
      // --debug may have optional filter value
      if (arg === "-d" || arg === "--debug") {
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) { i++; } // consume filter
      }
    }
    else if (arg === "-V" || arg === "--version") { console.log(`gro ${VERSION}`); process.exit(0); }
    else if (arg === "-h" || arg === "--help") { usage(); process.exit(0); }
    // --- graceful degradation for unsupported claude flags ---
    else if (UNSUPPORTED_VALUE_FLAGS.has(arg)) {
      Logger.warn(`${arg} not yet supported, ignoring`);
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) i++; // skip value
    }
    else if (UNSUPPORTED_BOOL_FLAGS.has(arg)) {
      Logger.warn(`${arg} not yet supported, ignoring`);
    }
    else if (!arg.startsWith("-")) { positional.push(arg); }
    else { Logger.warn(`Unknown flag: ${arg}`); }
  }

  const provider = inferProvider(flags.provider, flags.model);
  const apiKey = resolveApiKey(provider);
  const noMcp = flags.noMcp === "true";
  const mcpServers = noMcp ? {} : loadMcpServers(mcpConfigPaths);

  // Resolve system prompt
  let systemPrompt = flags.systemPrompt || "";

  // Inject wake notes by default (runner-global), unless explicitly disabled.
  // This ensures the model always sees workflow + memory pointers on wake.
  const wakeNotesPath = flags.wakeNotes || WAKE_NOTES_DEFAULT_PATH;
  const wakeNotesEnabled = flags.noWakeNotes !== "true";
  if (wakeNotesEnabled && wakeNotesPath && existsSync(wakeNotesPath)) {
    try {
      const wake = readFileSync(wakeNotesPath, "utf-8").trim();
      if (wake) systemPrompt = systemPrompt ? `${wake}

${systemPrompt}` : wake;
    } catch (e) {
      // Non-fatal: if wake notes can't be read, proceed without them.
      Logger.warn(`Failed to read wake notes at ${wakeNotesPath}: ${asError(e).message}`);
    }
  }
  if (flags.systemPromptFile) {
    try {
      systemPrompt = readFileSync(flags.systemPromptFile, "utf-8").trim();
    } catch (e: unknown) {
      const ge = groError("config_error", `Failed to read system prompt file: ${asError(e).message}`, { cause: e });
      Logger.error(ge.message, errorLogFields(ge));
      process.exit(1);
    }
  }
  if (flags.appendSystemPrompt) {
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${flags.appendSystemPrompt}` : flags.appendSystemPrompt;
  }
  if (flags.appendSystemPromptFile) {
    try {
      const extra = readFileSync(flags.appendSystemPromptFile, "utf-8").trim();
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${extra}` : extra;
    } catch (e: unknown) {
      const ge = groError("config_error", `Failed to read append system prompt file: ${asError(e).message}`, { cause: e });
      Logger.error(ge.message, errorLogFields(ge));
      process.exit(1);
    }
  }

  // Default wake injection: prepend runner-global WAKE.md unless explicitly disabled.
  // Soft dependency: if missing, warn and continue.
  if (!disableWake && wakeFile) {
    try {
      const wake = readFileSync(wakeFile, "utf-8").trim();
      if (wake) systemPrompt = systemPrompt ? `${wake}\n\n${systemPrompt}` : wake;
    } catch (e: unknown) {
      Logger.warn(`Wake file not found/readable (${wakeFile}); continuing without it`);
    }
  }



  // Mode resolution: -p forces non-interactive, -i forces interactive
  // Default: interactive if TTY and no prompt given
  const printMode = flags.print === "true";
  const interactiveMode = printMode ? false
    : flags.interactive === "true" ? true
    : (positional.length === 0 && process.stdin.isTTY === true);

  return {
    provider,
    model: flags.model || defaultModel(provider),
    baseUrl: flags.baseUrl || defaultBaseUrl(provider),
    apiKey,
    systemPrompt,
    wakeNotes: flags.wakeNotes || WAKE_NOTES_DEFAULT_PATH,
    wakeNotesEnabled: flags.noWakeNotes !== "true",
    contextTokens: parseInt(flags.contextTokens || "8192"),
    maxTokens: parseInt(flags.maxTokens || "16384"),
    interactive: interactiveMode,
    print: printMode,
    maxToolRounds: parseInt(flags.maxToolRounds || "10"),
    persistent: flags.persistent === "true",
    maxIdleNudges: parseInt(flags.maxIdleNudges || "10"),
    bash: flags.bash === "true",
    summarizerModel: flags.summarizerModel || null,
    outputFormat: (flags.outputFormat as GroConfig["outputFormat"]) || "text",
    continueSession: flags.continue === "true",
    resumeSession: flags.resume || null,
    sessionPersistence: flags.noSessionPersistence !== "true",
    verbose: flags.verbose === "true",
    mcpServers,
  };
}

function inferProvider(explicit?: string, model?: string): "openai" | "anthropic" | "local" {
  if (explicit) {
    if (explicit === "openai" || explicit === "anthropic" || explicit === "local") return explicit;
    Logger.warn(`Unknown provider "${explicit}", defaulting to anthropic`);
    return "anthropic";
  }
  if (model) {
    if (/^(gpt-|o1-|o3-|o4-|chatgpt-)/.test(model)) return "openai";
    if (/^(claude-|sonnet|haiku|opus)/.test(model)) return "anthropic";
    if (/^(gemma|llama|mistral|phi|qwen|deepseek)/.test(model)) return "local";
  }
  return "anthropic";
}

function defaultModel(provider: string): string {
  switch (provider) {
    case "openai": return "gpt-4o";
    case "anthropic": return "claude-sonnet-4-20250514";
    case "local": return "llama3";
    default: return "claude-sonnet-4-20250514";
  }
}

function defaultBaseUrl(provider: string): string {
  switch (provider) {
    case "openai": return process.env.OPENAI_BASE_URL || "https://api.openai.com";
    case "local": return "http://127.0.0.1:11434";
    default: return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
  }
}

function resolveApiKey(provider: string): string {
  switch (provider) {
    case "openai": return process.env.OPENAI_API_KEY || "";
    case "anthropic": return process.env.ANTHROPIC_API_KEY || "";
    default: return "";
  }
}

function usage() {
  console.log(`gro ${VERSION} — provider-agnostic LLM runtime

usage:
  gro [options] "prompt"
  echo "prompt" | gro [options]
  gro -i                        # interactive mode

options:
  -P, --provider         openai | anthropic | local (default: anthropic)
  -m, --model            model name (auto-infers provider)
  --base-url             API base URL
  --system-prompt        system prompt text
  --system-prompt-file   read system prompt from file
  --append-system-prompt append to system prompt
  --append-system-prompt-file  append system prompt from file
  --wake-notes           path to wake notes file (default: ~/.claude/WAKE.md)
  --no-wake-notes        disable auto-prepending wake notes
  --context-tokens       context window budget (default: 8192)
  --max-tokens           max response tokens per turn (default: 16384)
  --max-turns            max agentic rounds per turn (default: 10)
  --max-tool-rounds      alias for --max-turns
  --bash                 enable built-in bash tool for shell command execution
  --persistent           nudge model to keep using tools instead of exiting
  --max-idle-nudges      max consecutive nudges before giving up (default: 10)
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
  -h, --help             show this help

session state is stored in .gro/context/<session-id>/`);
}

// ---------------------------------------------------------------------------
// Driver factory
// ---------------------------------------------------------------------------

function createDriverForModel(
  provider: "openai" | "anthropic" | "local",
  model: string,
  apiKey: string,
  baseUrl: string,
  maxTokens?: number,
): ChatDriver {
  switch (provider) {
    case "anthropic":
      if (!apiKey && baseUrl === "https://api.anthropic.com") {
        Logger.error("gro: ANTHROPIC_API_KEY not set (set ANTHROPIC_BASE_URL for proxy mode)");
        process.exit(1);
      }
      return makeAnthropicDriver({ apiKey: apiKey || "proxy-managed", model, baseUrl, maxTokens });

    case "openai":
      if (!apiKey && baseUrl === "https://api.openai.com") {
        Logger.error("gro: OPENAI_API_KEY not set (set OPENAI_BASE_URL for proxy mode)");
        process.exit(1);
      }
      return makeStreamingOpenAiDriver({ baseUrl, model, apiKey: apiKey || undefined });

    case "local":
      return makeStreamingOpenAiDriver({ baseUrl, model });

    default:
      Logger.error(`gro: unknown provider "${provider}"`);
      process.exit(1);
  }
  throw new Error("unreachable");
}

function createDriver(cfg: GroConfig): ChatDriver {
  return createDriverForModel(cfg.provider, cfg.model, cfg.apiKey, cfg.baseUrl, cfg.maxTokens);
}

// ---------------------------------------------------------------------------
// Memory factory
// ---------------------------------------------------------------------------

function createMemory(cfg: GroConfig, driver: ChatDriver): AgentMemory {
  if (cfg.interactive) {
    let summarizerDriver: ChatDriver | undefined;
    let summarizerModel: string | undefined;

    if (cfg.summarizerModel) {
      summarizerModel = cfg.summarizerModel;
      const summarizerProvider = inferProvider(undefined, summarizerModel);
      summarizerDriver = createDriverForModel(
        summarizerProvider,
        summarizerModel,
        resolveApiKey(summarizerProvider),
        defaultBaseUrl(summarizerProvider),
      );
      Logger.info(`Summarizer: ${summarizerProvider}/${summarizerModel}`);
    }

    return new AdvancedMemory({
      driver,
      model: cfg.model,
      summarizerDriver,
      summarizerModel,
      systemPrompt: cfg.systemPrompt || undefined,
      contextTokens: cfg.contextTokens,
    });
  }
  const mem = new SimpleMemory(cfg.systemPrompt || undefined);
  mem.setMeta(cfg.provider, cfg.model);
  return mem;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatOutput(text: string, format: GroConfig["outputFormat"]): string {
  switch (format) {
    case "json":
      return JSON.stringify({ result: text, type: "result" });
    case "stream-json":
      // For stream-json, individual tokens are already streamed.
      // This is the final message.
      return JSON.stringify({ result: text, type: "result" });
    case "text":
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Tool execution loop
// ---------------------------------------------------------------------------

/**
 * Resolve short model aliases to full model identifiers.
 * Allows stream markers like @@model-change('haiku')@@ without
 * the model needing to know the full versioned name.
 */
const MODEL_ALIASES: Record<string, string> = {
  "haiku": "claude-haiku-4-20250514",
  "sonnet": "claude-sonnet-4-20250514",
  "opus": "claude-opus-4-20250514",
  "gpt4": "gpt-4o",
  "gpt4o": "gpt-4o",
  "gpt4o-mini": "gpt-4o-mini",
  "o3": "o3",
};

function resolveModelAlias(alias: string): string {
  const lower = alias.trim().toLowerCase();
  return MODEL_ALIASES[lower] ?? alias;
}


/**
 * Execute a single turn: call the model, handle tool calls, repeat until
 * the model produces a final text response or we hit maxRounds.
 */
async function executeTurn(
  driver: ChatDriver,
  memory: AgentMemory,
  mcp: McpManager,
  cfg: GroConfig,
  sessionId?: string,
): Promise<string> {
  const tools = mcp.getToolDefinitions();
  tools.push(agentpatchToolDefinition());
  if (cfg.bash) tools.push(bashToolDefinition());
  tools.push(groVersionToolDefinition());
  let finalText = "";
  let turnTokensIn = 0;
  let turnTokensOut = 0;

  const rawOnToken = cfg.outputFormat === "stream-json"
    ? (t: string) => process.stdout.write(JSON.stringify({ type: "token", token: t }) + "\n")
    : (t: string) => process.stdout.write(t);

  // Mutable model reference — stream markers can switch this mid-turn
  let activeModel = cfg.model;

  let brokeCleanly = false;
  let idleNudges = 0;
  for (let round = 0; round < cfg.maxToolRounds; round++) {
    // Shared marker handler — used by both streaming parser and tool-arg scanner
    const handleMarker = (marker: { name: string; arg: string }) => {
      if (marker.name === "model-change") {
        const newModel = resolveModelAlias(marker.arg);
        Logger.info(`Stream marker: model-change '${marker.arg}' → ${newModel}`);
        activeModel = newModel;
        cfg.model = newModel;       // persist across turns
        memory.setModel(newModel);  // persist in session metadata on save
      } else {
        Logger.debug(`Stream marker: ${marker.name}('${marker.arg}')`);
      }
    };

    // Create a fresh marker parser per round so partial state doesn't leak
    const markerParser = createMarkerParser({
      onToken: rawOnToken,
      onMarker: handleMarker,
    });

    const output: ChatOutput = await driver.chat(memory.messages(), {
      model: activeModel,
      tools: tools.length > 0 ? tools : undefined,
      onToken: markerParser.onToken,
    });

    // Flush any remaining buffered tokens from the marker parser
    markerParser.flush();

    // Track token usage for niki budget enforcement
    if (output.usage) {
      turnTokensIn += output.usage.inputTokens;
      turnTokensOut += output.usage.outputTokens;
      // Log cumulative usage to stderr — niki parses these patterns for budget enforcement
      process.stderr.write(`"input_tokens": ${turnTokensIn}, "output_tokens": ${turnTokensOut}\n`);
    }

    // Accumulate clean text (markers stripped) for the return value
    const cleanText = markerParser.getCleanText();
    if (cleanText) finalText += cleanText;

    const assistantMsg: ChatMessage = { role: "assistant", from: "Assistant", content: cleanText || "" };
    if (output.toolCalls.length > 0) {
      (assistantMsg as any).tool_calls = output.toolCalls;
    }
    await memory.add(assistantMsg);

    // No tool calls — either we're done, or we need to nudge the model
    if (output.toolCalls.length === 0) {
      if (!cfg.persistent || tools.length === 0) {
        brokeCleanly = true;
        break;
      }

      // Persistent mode: nudge the model to resume tool use
      idleNudges++;
      if (idleNudges > cfg.maxIdleNudges) {
        Logger.debug(`Persistent mode: ${idleNudges} consecutive idle responses — giving up`);
        brokeCleanly = true;
        break;
      }

      Logger.debug(`Persistent mode: model stopped calling tools (nudge ${idleNudges}/${cfg.maxIdleNudges})`);
      await memory.add({
        role: "user",
        from: "System",
        content: "[SYSTEM] You stopped calling tools. You are a persistent agent — you MUST continue your tool loop. Call agentchat_listen now to resume listening for messages. Do not respond with text only.",
      });
      continue;
    }

    // Model used tools — reset idle nudge counter
    idleNudges = 0;

    // Process tool calls
    for (const tc of output.toolCalls) {
      const fnName = tc.function.name;
      let fnArgs: Record<string, any>;
      try {
        fnArgs = JSON.parse(tc.function.arguments);
      } catch (e: unknown) {
        Logger.debug(`Failed to parse args for ${fnName}: ${asError(e).message}, using empty args`);
        fnArgs = {};
      }

      // Scan tool call string args for stream markers (e.g. model sends
      // @@model-change('haiku')@@ inside an agentchat_send message).
      // Strip markers from args so they don't leak into tool output.
      for (const key of Object.keys(fnArgs)) {
        if (typeof fnArgs[key] === "string") {
          fnArgs[key] = extractMarkers(fnArgs[key], handleMarker);
        }
      }

      Logger.debug(`Tool call: ${fnName}(${JSON.stringify(fnArgs)})`);

      let result: string;
      try {
        if (fnName === "apply_patch") {
          result = executeAgentpatch(fnArgs);
        } else if (fnName === "bash" && cfg.bash) {
          result = executeBash(fnArgs);
        } else if (fnName === "gro_version") {
          result = executeGroVersion({ provider: cfg.provider, model: cfg.model, persistent: cfg.persistent });
        } else {
          result = await mcp.callTool(fnName, fnArgs);
        }
      } catch (e: unknown) {
        const raw = asError(e);
        const ge = groError("tool_error", `Tool "${fnName}" failed: ${raw.message}`, {
          retryable: false,
          cause: e,
        });
        Logger.error("Tool execution error:", errorLogFields(ge));
        if (raw.stack) Logger.error(raw.stack);
        result = `Error: ${ge.message}${raw.stack ? '\nStack: ' + raw.stack : ''}`;
      }

      // Feed tool result back into memory
      await memory.add({
        role: "tool",
        from: fnName,
        content: result,
        tool_call_id: tc.id,
        name: fnName,
      });
    }

    // Auto-save periodically in persistent mode to survive SIGTERM/crashes
    if (cfg.persistent && cfg.sessionPersistence && sessionId && round > 0 && round % AUTO_SAVE_INTERVAL === 0) {
      try {
        await memory.save(sessionId);
        Logger.debug(`Auto-saved session ${sessionId} at round ${round}`);
      } catch (e: unknown) {
        Logger.warn(`Auto-save failed at round ${round}: ${asError(e).message}`);
      }
    }
  }

  // If we exhausted maxToolRounds (loop didn't break via no-tool-calls),
  // give the model one final turn with no tools so it can produce a closing response.
  if (!brokeCleanly && tools.length > 0) {
    Logger.debug("Max tool rounds reached — final turn with no tools");
    const finalOutput: ChatOutput = await driver.chat(memory.messages(), {
      model: activeModel,
      onToken: rawOnToken,
    });
    if (finalOutput.usage) {
      turnTokensIn += finalOutput.usage.inputTokens;
      turnTokensOut += finalOutput.usage.outputTokens;
      process.stderr.write(`"input_tokens": ${turnTokensIn}, "output_tokens": ${turnTokensOut}\n`);
    }
    if (finalOutput.text) finalText += finalOutput.text;
    await memory.add({ role: "assistant", from: "Assistant", content: finalOutput.text || "" });
  }

  return finalText;
}

// ---------------------------------------------------------------------------
// Main modes
// ---------------------------------------------------------------------------

async function singleShot(
  cfg: GroConfig,
  driver: ChatDriver,
  mcp: McpManager,
  sessionId: string,
  positionalArgs?: string[],
): Promise<void> {
  let prompt = (positionalArgs || []).join(" ").trim();

  if (!prompt && !process.stdin.isTTY) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    prompt = Buffer.concat(chunks).toString("utf-8").trim();
  }

  if (!prompt) {
    Logger.error("gro: no prompt provided");
    usage();
    process.exit(1);
  }

  const memory = createMemory(cfg, driver);

  // Register for graceful shutdown
  _shutdownMemory = memory;
  _shutdownSessionId = sessionId;
  _shutdownSessionPersistence = cfg.sessionPersistence;

  // Resume existing session if requested
  if (cfg.continueSession || cfg.resumeSession) {
    await memory.load(sessionId);
  }

  await memory.add({ role: "user", from: "User", content: prompt });

  let text: string | undefined;
  let fatalError = false;
  try {
    text = await executeTurn(driver, memory, mcp, cfg, sessionId);
  } catch (e: unknown) {
    const ge = isGroError(e) ? e : groError("provider_error", asError(e).message, { cause: e });
    Logger.error(C.red(`error: ${ge.message}`), errorLogFields(ge));
    fatalError = true;
  }

  // Save session (even on error — preserve conversation state)
  if (cfg.sessionPersistence) {
    try {
      await memory.save(sessionId);
    } catch (e: unknown) {
      Logger.error(C.red(`session save failed: ${asError(e).message}`));
    }
  }

  // Exit with non-zero code on fatal API errors so the supervisor
  // can distinguish "finished cleanly" from "crashed on API call"
  if (fatalError) {
    process.exit(1);
  }

  if (text) {
    if (cfg.outputFormat === "json") {
      process.stdout.write(formatOutput(text, "json") + "\n");
    } else if (!text.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
}

async function interactive(
  cfg: GroConfig,
  driver: ChatDriver,
  mcp: McpManager,
  sessionId: string,
): Promise<void> {
  const memory = createMemory(cfg, driver);
  const readline = await import("readline");

  // Register for graceful shutdown
  _shutdownMemory = memory;
  _shutdownSessionId = sessionId;
  _shutdownSessionPersistence = cfg.sessionPersistence;

  // Resume existing session if requested
  if (cfg.continueSession || cfg.resumeSession) {
    await memory.load(sessionId);
    const sess = loadSession(sessionId);
    if (sess) {
      const msgCount = sess.messages.filter((m: any) => m.role !== "system").length;
      Logger.info(C.gray(`Resumed session ${sessionId} (${msgCount} messages)`));
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: C.cyan("you > "),
  });

  const toolCount = mcp.getToolDefinitions().length;
  Logger.info(C.gray(`gro interactive — ${cfg.provider}/${cfg.model} [${sessionId}]`));
  if (cfg.summarizerModel) Logger.info(C.gray(`summarizer: ${cfg.summarizerModel}`));
  if (toolCount > 0) Logger.info(C.gray(`${toolCount} MCP tool(s) available`));
  Logger.info(C.gray("type 'exit' or Ctrl+D to quit\n"));
  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === "exit" || input === "quit") { rl.close(); return; }

    try {
      await memory.add({ role: "user", from: "User", content: input });
      await executeTurn(driver, memory, mcp, cfg, sessionId);
    } catch (e: unknown) {
      const ge = isGroError(e) ? e : groError("provider_error", asError(e).message, { cause: e });
      Logger.error(C.red(`error: ${ge.message}`), errorLogFields(ge));
    }

    // Auto-save after each turn
    if (cfg.sessionPersistence) {
      try {
        await memory.save(sessionId);
      } catch (e: unknown) {
        Logger.error(C.red(`session save failed: ${asError(e).message}`));
      }
    }

    process.stdout.write("\n");
    rl.prompt();
  });

  rl.on("error", (e: Error) => {
    Logger.error(C.red(`readline error: ${e.message}`));
  });

  rl.on("close", async () => {
    if (cfg.sessionPersistence) {
      try {
        await memory.save(sessionId);
      } catch (e: unknown) {
        Logger.error(C.red(`session save failed: ${asError(e).message}`));
      }
    }
    await mcp.disconnectAll();
    Logger.info(C.gray(`\ngoodbye. session: ${sessionId}`));
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();

  if (cfg.verbose) {
    process.env.GRO_LOG_LEVEL = "debug";
  }

  // Resolve session ID
  let sessionId: string;
  if (cfg.continueSession) {
    const latest = findLatestSession();
    if (!latest) {
      Logger.error("gro: no session to continue");
      process.exit(1);
    }
    sessionId = latest;
    Logger.debug(`Continuing session: ${sessionId}`);
  } else if (cfg.resumeSession) {
    if (cfg.resumeSession === "latest") {
      const latest = findLatestSession();
      if (!latest) {
        Logger.error("gro: no session to resume");
        process.exit(1);
      }
      sessionId = latest;
    } else {
      sessionId = cfg.resumeSession;
    }
    Logger.debug(`Resuming session: ${sessionId}`);
  } else {
    sessionId = newSessionId();
    if (cfg.sessionPersistence) {
      ensureGroDir();
    }
  }

  const args = process.argv.slice(2);
  const positional: string[] = [];
  const flagsWithValues = [
    "--provider", "-P", "--model", "-m", "--base-url",
    "--system-prompt", "--system-prompt-file",
    "--append-system-prompt", "--append-system-prompt-file",
    "--context-tokens", "--max-tokens", "--max-tool-rounds", "--max-turns",
    "--max-thinking-tokens", "--max-budget-usd",
    "--summarizer-model", "--output-format", "--mcp-config",
    "--resume", "-r",
  ];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) {
      if (flagsWithValues.includes(args[i])) i++;
      continue;
    }
    positional.push(args[i]);
  }

  const driver = createDriver(cfg);

  // Connect to MCP servers
  const mcp = new McpManager();
  if (Object.keys(cfg.mcpServers).length > 0) {
    await mcp.connectAll(cfg.mcpServers);
  }

  try {
    if (cfg.interactive && positional.length === 0) {
      await interactive(cfg, driver, mcp, sessionId);
    } else {
      await singleShot(cfg, driver, mcp, sessionId, positional);
      await mcp.disconnectAll();
    }
  } catch (e: unknown) {
    await mcp.disconnectAll();
    throw e;
  }
}

// Graceful shutdown on signals — save session before exiting
for (const sig of ["SIGTERM", "SIGHUP"] as const) {
  process.on(sig, async () => {
    Logger.info(C.gray(`\nreceived ${sig}, saving session and shutting down...`));
    if (_shutdownMemory && _shutdownSessionId && _shutdownSessionPersistence) {
      try {
        await _shutdownMemory.save(_shutdownSessionId);
        Logger.info(C.gray(`session ${_shutdownSessionId} saved on ${sig}`));
      } catch (e: unknown) {
        Logger.error(C.red(`session save on ${sig} failed: ${asError(e).message}`));
      }
    }
    process.exit(0);
  });
}

// Catch unhandled promise rejections (e.g. background summarization)
process.on("unhandledRejection", (reason: unknown) => {
  const err = asError(reason);
  Logger.error(C.red(`unhandled rejection: ${err.message}`));
  if (err.stack) Logger.error(C.red(err.stack));
});

main().catch((e: unknown) => {
  const err = asError(e);
  Logger.error("gro:", err.message);
  if (err.stack) Logger.error(err.stack);
  process.exit(1);
});
