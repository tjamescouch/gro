/**
 * CLI argument parsing, configuration loading, and help text.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../logger.js";
import { resolveApiKey, defaultBaseUrl } from "../drivers/driver-factory.js";
import { loadRuntimeBoot, assembleSystemPrompt, discoverExtensions } from "../boot/system-prompt.js";
import { inferProvider, defaultModel } from "../model-config.js";
import { groError, asError, errorLogFields } from "../errors.js";
import { getGroVersion } from "../tools/version.js";
import type { GroConfig } from "../gro-types.js";
import type { McpServerConfig } from "../mcp/index.js";

const VERSION = getGroVersion();

/** Wake notes: a runner-global file prepended to the system prompt on process start. */
export const WAKE_NOTES_DEFAULT_PATH = join(process.env.HOME || "", ".gro", "WAKE.md");

function loadMcpServers(mcpConfigPaths: string[], autodiscover: boolean): Record<string, McpServerConfig> {
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

  // --autodiscover-mcp: also check ~/.gro/mcp.json
  if (autodiscover) {
    const autoPath = join(homedir(), ".gro", "mcp.json");
    if (existsSync(autoPath) && !mcpConfigPaths.includes(autoPath)) {
      try {
        const raw = readFileSync(autoPath, "utf-8");
        const parsed = JSON.parse(raw);
        const servers = parsed.mcpServers || parsed;
        if (typeof servers === "object" && Object.keys(servers).length > 0) {
          Logger.info(`Auto-discovered MCP config: ${autoPath} (${Object.keys(servers).length} server(s))`);
          Object.assign(merged, servers);
        }
      } catch (e: unknown) {
        Logger.warn(`Failed to parse auto-discovered MCP config ${autoPath}: ${asError(e).message}`);
      }
    }
  }

  return merged;
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

export function loadConfig(): GroConfig {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  const mcpConfigPaths: string[] = [];

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
    else if (arg === "--supervised") { flags.supervised = "true"; }
    else if (arg === "--max-idle-nudges") { flags.maxIdleNudges = args[++i]; }
    else if (arg === "--lfs") { flags.lfs = args[++i]; }
    else if (arg === "--retry-base-ms") { process.env.GRO_RETRY_BASE_MS = args[++i]; }
    else if (arg === "--max-thinking-tokens") { flags.maxThinkingTokens = args[++i]; } // accepted, not used yet
    else if (arg === "--max-budget-usd" || arg === "--max-cost") { flags.maxBudgetUsd = args[++i]; }
    else if (arg === "--max-tier") { flags.maxTier = args[++i]; }
    else if (arg === "--providers") { flags.providers = args[++i]; }
    else if (arg === "--summarizer-model") { flags.summarizerModel = args[++i]; }
    else if (arg === "--output-format") { flags.outputFormat = args[++i]; }
    else if (arg === "--batch-summarization") { flags.batchSummarization = "true"; }
    else if (arg === "--no-cache") { flags.noCache = "true"; }
    else if (arg === "--mcp-config") { mcpConfigPaths.push(args[++i]); }
    else if (arg === "--autodiscover-mcp") { flags.autodiscoverMcp = "true"; }
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
    else if (arg === "--show-diffs") { flags.showDiffs = "true"; }
    else if (arg === "--plastic") { /* handled at boot, before main() */ }
    else if (arg === "--name") { flags.name = args[++i]; }
    else if (arg === "-d" || arg === "--debug" || arg === "-d2e" || arg === "--debug-to-stderr") {
      flags.verbose = "true";
      // --debug may have optional filter value
      if (arg === "-d" || arg === "--debug") {
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) { i++; } // consume filter
      }
    }
    else if (arg === "--set-key") { flags.setKey = args[++i]; }
    else if (arg === "-V" || arg === "--version") { Logger.info(`gro ${VERSION}`); process.exit(0); }
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

  const provider = inferProvider(flags.provider || process.env.AGENT_PROVIDER, flags.model || process.env.AGENT_MODEL);
  const apiKey = resolveApiKey(provider);
  const noMcp = flags.noMcp === "true";
  const autodiscoverMcp = flags.autodiscoverMcp === "true";
  const mcpServers = noMcp ? {} : loadMcpServers(mcpConfigPaths, autodiscoverMcp);

  // --- Layered system prompt assembly ---
  // Layer 1: Runtime boot (gro internal, always loaded)
  const runtime = loadRuntimeBoot();

  // Layer 2: Extensions (_base.md, SKILL.md, --append-system-prompt-file, --append-system-prompt)
  const extensions = discoverExtensions(mcpConfigPaths);
  if (flags.appendSystemPromptFile) {
    try {
      const extra = readFileSync(flags.appendSystemPromptFile, "utf-8").trim();
      if (extra) extensions.push(extra);
    } catch (e: unknown) {
      const ge = groError("config_error", `Failed to read append system prompt file: ${asError(e).message}`, { cause: e });
      Logger.error(ge.message, errorLogFields(ge));
      process.exit(1);
    }
  }
  if (flags.appendSystemPrompt) {
    extensions.push(flags.appendSystemPrompt);
  }

  // Layer 3: Role/Personality (WAKE.md, --system-prompt, --system-prompt-file)
  const role: string[] = [];

  // WAKE.md (runner-global) — loaded once, not twice
  const wakeNotesPath = flags.wakeNotes || WAKE_NOTES_DEFAULT_PATH;
  const wakeNotesEnabled = flags.noWakeNotes !== "true";
  if (wakeNotesEnabled && wakeNotesPath && existsSync(wakeNotesPath)) {
    try {
      const wake = readFileSync(wakeNotesPath, "utf-8").trim();
      if (wake) role.push(wake);
    } catch (e) {
      Logger.warn(`Failed to read wake notes at ${wakeNotesPath}: ${asError(e).message}`);
    }
  }

  // --system-prompt-file overrides --system-prompt (not additive)
  if (flags.systemPromptFile) {
    try {
      role.push(readFileSync(flags.systemPromptFile, "utf-8").trim());
    } catch (e: unknown) {
      const ge = groError("config_error", `Failed to read system prompt file: ${asError(e).message}`, { cause: e });
      Logger.error(ge.message, errorLogFields(ge));
      process.exit(1);
    }
  } else if (flags.systemPrompt) {
    role.push(flags.systemPrompt);
  }

  const systemPrompt = assembleSystemPrompt({ runtime, extensions, role });

  // Mode resolution: -p forces non-interactive, -i forces interactive
  // Default: interactive if TTY and no prompt given
  const printMode = flags.print === "true";
  const interactiveMode = printMode ? false
    : flags.interactive === "true" ? true
    : (positional.length === 0 && process.stdin.isTTY === true);

  return {
    provider,
    model: flags.model || process.env.AGENT_MODEL || defaultModel(provider),
    baseUrl: flags.baseUrl || defaultBaseUrl(provider),
    apiKey,
    systemPrompt,
    wakeNotes: flags.wakeNotes || WAKE_NOTES_DEFAULT_PATH,
    wakeNotesEnabled: flags.noWakeNotes !== "true",
    contextTokens: parseInt(flags.contextTokens || "32000"),
    maxTokens: parseInt(flags.maxTokens || "16384"),
    interactive: interactiveMode,
    print: printMode,
    maxToolRounds: parseInt(flags.maxToolRounds || "100"),
    persistent: flags.persistent === "true",
    supervised: flags.supervised === "true" || typeof process.send === "function",
    persistentPolicy: (flags.persistentPolicy as "listen-only" | "work-first") || "listen-only",
    maxIdleNudges: parseInt(flags.maxIdleNudges || "10"),
    bash: flags.bash === "true" || interactiveMode,
    lfs: flags.lfs || process.env.GRO_LFS || null,
    summarizerModel: flags.summarizerModel || process.env.AGENT_SUMMARIZER_MODEL || null,
    outputFormat: (flags.outputFormat as GroConfig["outputFormat"]) || "text",
    continueSession: flags.continue === "true",
    resumeSession: flags.resume || null,
    sessionPersistence: flags.noSessionPersistence !== "true",
    verbose: flags.verbose === "true",
    name: flags.name || null,
    batchSummarization: flags.batchSummarization === "true",
    showDiffs: flags.showDiffs === "true",
    mcpServers,
    maxBudgetUsd: flags.maxBudgetUsd ? parseFloat(flags.maxBudgetUsd) : null,
    maxTier: (flags.maxTier || process.env.GRO_MAX_TIER || null) as GroConfig["maxTier"],
    providers: (flags.providers || process.env.GRO_PROVIDERS || "").split(",").filter(Boolean),
    // toolRoles auto-detected after MCP connect — placeholder here
    toolRoles: { idleTool: null, idleToolDefaultArgs: {}, idleToolArgStrategy: "last-call", sendTool: null, sendToolMessageField: "message" },
    enablePromptCaching: flags.noCache !== "true",
  };
}

export function usage() {
  Logger.info(`gro ${VERSION} — provider-agnostic LLM runtime

usage:
  gro [options] "prompt"
  echo "prompt" | gro [options]
  gro -i                        # interactive mode

options:
  --set-key <provider>   store API key in macOS Keychain (anthropic | openai | groq | google | xai)
  -P, --provider         openai | anthropic | groq | google | xai | local (default: anthropic)
  -m, --model            model name (auto-infers provider)
  --base-url             API base URL
  --system-prompt        system prompt text
  --system-prompt-file   read system prompt from file
  --append-system-prompt append to system prompt
  --append-system-prompt-file  append system prompt from file
  --wake-notes           path to wake notes file (default: ~/.gro/WAKE.md)
  --no-wake-notes        disable auto-prepending wake notes
  --context-tokens       context window budget (default: 8192)
  --max-tokens           max response tokens per turn (default: 16384)
  --max-turns            max agentic rounds per turn (default: 100)
  --max-tool-rounds      alias for --max-turns
  --bash                 enable built-in bash tool for shell command execution
  --persistent           nudge model to keep using tools instead of exiting
  --lfs <url>            enable LLM-Face Streaming to personas server (e.g. http://localhost:3100)
  --max-retries          max API retry attempts on 429/5xx (default: 3, env: GRO_MAX_RETRIES)
  --retry-base-ms        base backoff delay in ms (default: 1000, env: GRO_RETRY_BASE_MS)
  --max-tier             low | mid | high — cap tier promotion (env: GRO_MAX_TIER)
  --providers            comma-separated providers for cross-provider tier selection (env: GRO_PROVIDERS)
  --summarizer-model     model for context summarization (default: same as --model)
  --output-format        text | json | stream-json (default: text)
  --mcp-config           load MCP servers from JSON file or string
  --autodiscover-mcp     also load ~/.gro/mcp.json if it exists
  --max-cost             alias for --max-budget-usd
  --no-cache             disable Anthropic prompt caching
  --no-mcp               disable MCP server connections
  --no-session-persistence  don't save sessions to .gro/
  -p, --print            print response and exit (non-interactive)
  -c, --continue         continue most recent session
  -r, --resume [id]      resume a session by ID
  -i, --interactive      interactive conversation mode
  --plastic              PLASTIC mode: self-modifying agent (training only)
  --verbose              verbose output
  -V, --version          show version
  -h, --help             show this help

session state is stored in .gro/context/<session-id>/`);
}
