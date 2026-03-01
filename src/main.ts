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

import { readFileSync, existsSync, appendFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { envVarName } from "./keychain.js";
import { Logger, C } from "./logger.js";
import { spendMeter } from "./spend-meter.js";
import { createDriverForModel, createDriver, defaultBaseUrl, resolveApiKey } from "./drivers/driver-factory.js";
import { SimpleMemory } from "./memory/simple-memory.js";
import { AdvancedMemory } from "./memory/experimental/advanced-memory.js";
import { VirtualMemory } from "./memory/virtual-memory.js";
import { FragmentationMemory } from "./memory/experimental/fragmentation-memory.js";
import { McpManager } from "./mcp/index.js";
import { newSessionId, findLatestSession, loadSession, ensureGroDir, saveSensoryState, loadSensoryState } from "./session.js";
// Register all memory types in the registry (side-effect import)
import "./memory/register-memory-types.js";
import { groError, asError, isGroError, errorLogFields } from "./errors.js";
import { withConnectionRecovery } from "./utils/connection-recovery.js";
import { WARM_STATE_VERSION } from "./warm-state.js";
import type { WarmState, WorkerMessage, SupervisorMessage } from "./warm-state.js";
import type { McpServerConfig } from "./mcp/index.js";
import type { ChatDriver, ChatMessage, ChatOutput, TokenUsage } from "./drivers/types.js";
import type { AgentMemory, VirtualMemoryStats } from "./memory/agent-memory.js";
import { SensoryMemory } from "./memory/sensory-memory.js";
import { ContextMapSource } from "./memory/context-map-source.js";
import { TemporalSource } from "./memory/temporal-source.js";
import { ConfigSource } from "./memory/config-source.js";
import { SelfSource } from "./memory/self-source.js";
import { ViolationsSource } from "./memory/violations-source.js";
import { createDefaultFactory } from "./memory/sensory-view-factory.js";
import { tryCreateEmbeddingProvider } from "./memory/embedding-provider.js";
import { PageSearchIndex } from "./memory/page-search-index.js";
import { SemanticRetrieval } from "./memory/semantic-retrieval.js";
import { BatchSummarizer } from "./memory/batch-summarizer.js";
import { bashToolDefinition, executeBash } from "./tools/bash.js";
import { yieldToolDefinition, executeYield } from "./tools/yield.js";
import { agentpatchToolDefinition, executeAgentpatch, enableShowDiffs } from "./tools/agentpatch.js";
import { groVersionToolDefinition, executeGroVersion, getGroVersion } from "./tools/version.js";
import { memoryStatusToolDefinition, executeMemoryStatus } from "./tools/memory-status.js";
import { memoryReportToolDefinition, executeMemoryReport } from "./tools/memory-report.js";
import { memoryTuneToolDefinition, executeMemoryTune } from "./tools/memory-tune.js";
import { compactContextToolDefinition, executeCompactContext } from "./tools/compact-context.js";
import { memoryGrepToolDefinition, executeMemoryGrep } from "./tools/memory-grep.js";
import { cleanupSessionsToolDefinition, executeCleanupSessions } from "./tools/cleanup-sessions.js";
import { createMarkerParser, extractMarkers } from "./stream-markers.js";
import { readToolDefinition, executeRead } from "./tools/read.js";
import { writeToolDefinition, executeWrite } from "./tools/write.js";
import { globToolDefinition, executeGlob } from "./tools/glob.js";
import { grepToolDefinition, executeGrep } from "./tools/grep.js";
import { writeSelfToolDefinition, executeWriteSelf } from "./tools/write-self.js";
import { writeSourceToolDefinition, handleWriteSource } from "./plastic/write-source.js";
import { editSourceToolDefinition, handleEditSource } from "./plastic/edit-source.js";
import { exportChanges, exportChangesToolDefinition, handleExportChanges } from "./plastic/export.js";
import { injectSourcePages } from "./plastic/init.js";
import { toolRegistry } from "./plugins/tool-registry.js";
import { ViolationTracker, ThinkingLoopDetector } from "./violations.js";
import { thinkingTierModel as selectTierModel, selectMultiProviderTierModel, inferModelTier } from "./tier-loader.js";
import type { TierSelection } from "./tier-loader.js";
import {
  loadModelConfig,
  resolveModelAlias,
  isKnownAlias,
  defaultModel,
  modelIdPrefixPattern,
  inferProvider,
} from "./model-config.js";
import { parseDirectives, executeDirectives } from "./runtime/index.js";
import { runtimeConfig, runtimeState } from "./runtime/index.js";
import { FamiliarityTracker } from "./runtime/familiarity.js";
import { DejaVuTracker } from "./runtime/deja-vu.js";
import type { AwarenessSource } from "./memory/awareness-source.js";
import type { Provider, GroConfig, McpToolRoles } from "./gro-types.js";
import { detectToolRoles } from "./gro-types.js";
import { loadRuntimeBoot, assembleSystemPrompt, discoverExtensions } from "./boot/system-prompt.js";
import type { BootLayers } from "./boot/system-prompt.js";
import { runSetKey, readLine } from "./cli/key-management.js";

const VERSION = getGroVersion();

// ---------------------------------------------------------------------------
// Graceful shutdown state — module-level so signal handlers can save sessions.
// ---------------------------------------------------------------------------
let _shutdownMemory: AgentMemory | null = null;
let _shutdownSessionId: string | null = null;
let _shutdownSessionPersistence = false;

/** Last AgentChat send target — relay LLM text output to this destination */
let _lastChatSendTarget: string | null = null;

/** Awareness trackers — module-level so they persist across turns. */
const familiarityTracker = new FamiliarityTracker();
const dejaVuTracker = new DejaVuTracker();

/** Pending warm state from supervisor — set in main(), consumed in interactive()/singleShot(). */
let _pendingWarmState: WarmState | null = null;

/** Auto-save interval: save session every N tool rounds in persistent mode */
const AUTO_SAVE_INTERVAL = 10;

/** Maximum backoff delay when tool failures loop */
const MAX_BACKOFF_MS = 30000; // 30 seconds

/** Sleep utility for exponential backoff */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wake notes: a runner-global file that is prepended to the system prompt on process start
// so agents reliably see dev workflow + memory pointers on wake.
const WAKE_NOTES_DEFAULT_PATH = join(process.env.HOME || "", ".gro", "WAKE.md");

// Boot layers, system prompt assembly, and extension discovery are in
// src/boot/system-prompt.ts — imported above.

const __filename_url = import.meta.url;
const __dirname_resolved = dirname(fileURLToPath(__filename_url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Types (Provider, GroConfig, McpToolRoles) and detectToolRoles are in
// src/gro-types.ts — imported above.


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

function loadConfig(): GroConfig {
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

// defaultBaseUrl, resolveApiKey, createDriverForModel, createDriver are in
// src/drivers/driver-factory.ts — imported above.

function usage() {
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

// Key management (runSetKey, readLine) is in src/cli/key-management.ts — imported above.

// ---------------------------------------------------------------------------
// Memory factory
// ---------------------------------------------------------------------------

async function createMemory(cfg: GroConfig, driver: ChatDriver, requestedMode?: string, sessionId?: string): Promise<AgentMemory> {
  const memoryMode = requestedMode ?? process.env.GRO_MEMORY ?? "virtual";

  // Opt-out: SimpleMemory only if explicitly requested
  if (memoryMode === "simple") {
    Logger.telemetry(`${C.cyan("MemoryMode=Simple")} ${C.gray("(GRO_MEMORY=simple)")}`);
    const mem = new SimpleMemory(cfg.systemPrompt || undefined);
    mem.setMeta(cfg.provider, cfg.model);
    return mem;
  }

  // Default: VirtualMemory (safe, cost-controlled)
  // Default summarizer: Groq llama-3.3-70b-versatile (free tier).
  // Falls back to main driver if no Groq key is available.
  const DEFAULT_SUMMARIZER_MODEL = "llama-3.3-70b-versatile";
  const summarizerModel = cfg.summarizerModel ?? DEFAULT_SUMMARIZER_MODEL;
  const summarizerProvider = inferProvider(undefined, summarizerModel);
  const summarizerApiKey = resolveApiKey(summarizerProvider);

  let summarizerDriver: ChatDriver | undefined;
  let effectiveSummarizerModel = summarizerModel;
  if (summarizerApiKey) {
    summarizerDriver = createDriverForModel(
      summarizerProvider,
      summarizerModel,
      summarizerApiKey,
      defaultBaseUrl(summarizerProvider),
    );
    Logger.telemetry(`Summarizer: ${summarizerProvider}/${summarizerModel}`);
  } else {
    // No key for the desired summarizer provider — fall back to main driver.
    // Use the main model name so the driver doesn't reject an incompatible model name.
    effectiveSummarizerModel = cfg.model;
    Logger.telemetry(`Summarizer: no ${summarizerProvider} key — using main driver (${cfg.provider}/${cfg.model})`);
  }

  // Fragmentation memory (stochastic sampling)
  if (memoryMode === "fragmentation") {
    Logger.telemetry(`${C.cyan("MemoryMode=Fragmentation")} ${C.gray(`workingMemory=${cfg.contextTokens} tokens`)}`);
    const { FragmentationMemory } = await import("./memory/experimental/fragmentation-memory.js");
    const fm = new FragmentationMemory({
      systemPrompt: cfg.systemPrompt || undefined,
      workingMemoryTokens: cfg.contextTokens,
    });
    fm.setProvider(cfg.provider);
    fm.setModel(cfg.model);
    return fm;
  }

  // HNSW memory (semantic similarity retrieval)
  if (memoryMode === "hnsw") {
    Logger.telemetry(`${C.cyan("MemoryMode=HNSW")} ${C.gray(`workingMemory=${cfg.contextTokens} tokens, semantic retrieval`)}`);
    const { HNSWMemory } = await import("./memory/experimental/hnsw-memory.js");
    const hm = new HNSWMemory({
      driver: summarizerDriver ?? driver,
      summarizerModel: effectiveSummarizerModel,
      systemPrompt: cfg.systemPrompt || undefined,
      workingMemoryTokens: cfg.contextTokens,
    });
    hm.setProvider(cfg.provider);
    hm.setModel(cfg.model);
    return hm;
  }

  // PerfectMemory (fork-based persistent recall)
  if (memoryMode === "perfect") {
    Logger.telemetry(`${C.cyan("MemoryMode=Perfect")} ${C.gray(`workingMemory=${cfg.contextTokens} tokens, fork-based recall`)}`);
    const { PerfectMemory } = await import("./memory/experimental/perfect-memory.js");
    const pm = new PerfectMemory({
      driver: summarizerDriver ?? driver,
      summarizerModel: effectiveSummarizerModel,
      systemPrompt: cfg.systemPrompt || undefined,
      workingMemoryTokens: cfg.contextTokens,
      enableBatchSummarization: cfg.batchSummarization,
    });
    pm.setProvider(cfg.provider);
    pm.setModel(cfg.model);
    return pm;
  }

    Logger.telemetry(`${C.cyan("MemoryMode=Virtual")} ${C.gray(`(default) workingMemory=${cfg.contextTokens} tokens`)}`);
  const vm = new VirtualMemory({
    driver: summarizerDriver ?? driver,
    summarizerModel: effectiveSummarizerModel,
    systemPrompt: cfg.systemPrompt || undefined,
    workingMemoryTokens: cfg.contextTokens,
    enableBatchSummarization: cfg.batchSummarization,
    sessionId,
  });
  vm.setProvider(cfg.provider);
  vm.setModel(cfg.model);
  return vm;
}

/**
 * Wrap an AgentMemory with SensoryMemory decorator + ContextMapSource.
 * Two-slot camera system:
 *   slot0 = "context" (fill bars, runtime health)
 *   slot1 = "time"    (wall clock, uptime, channel staleness)
 * Both slots are agent-switchable via <view:X> marker.
 * Returns the wrapped memory. If wrapping fails, returns the original.
 */
function wrapWithSensory(inner: AgentMemory): AgentMemory {
  try {
    const sensory = new SensoryMemory(inner, { totalBudget: 1200 });
    const factory = createDefaultFactory();
    const deps = { memory: inner, spendMeter };

    for (const spec of factory.specs()) {
      sensory.addChannel({
        name: spec.name,
        maxTokens: spec.maxTokens,
        updateMode: spec.updateMode,
        content: "",
        enabled: spec.enabled,
        source: factory.create(spec.name, deps),
        width: spec.width,
        height: spec.height,
        viewable: spec.viewable,
      });
    }

    // Wire awareness trackers
    const awarenessSource = sensory.getChannelSource("awareness") as AwarenessSource | undefined;
    if (awarenessSource) {
      awarenessSource.setFamiliarity(familiarityTracker);
      awarenessSource.setDejaVu(dejaVuTracker);
    }

    // Default camera slots
    sensory.setSlot(0, "context");
    sensory.setSlot(1, "time");
    sensory.setSlot(2, "awareness");
    return sensory;
  } catch (err) {
    Logger.warn(`Failed to initialize sensory memory: ${err}`);
    return inner;
  }
}

/** Unwrap SensoryMemory decorator to get the underlying memory for duck-typed method calls. */
function unwrapMemory(mem: AgentMemory): AgentMemory {
  return mem instanceof SensoryMemory ? (mem as SensoryMemory).getInner() : mem;
}

/** In PLASTIC mode, inject source pages into VirtualMemory so the agent can @@ref@@ them. */
function injectPlasticSourcePages(mem: AgentMemory): void {
  if (!process.env.GRO_PLASTIC) return;
  const inner = unwrapMemory(mem);
  if (inner instanceof VirtualMemory) {
    const count = injectSourcePages(inner);
    if (count > 0) Logger.telemetry(`[PLASTIC] Injected ${count} source pages into virtual memory`);
  }
}

/** Capture and save sensory channel state alongside session data. */
function saveSensorySnapshot(mem: AgentMemory, sessionId: string): void {
  if (!(mem instanceof SensoryMemory)) return;
  const sensory = mem as SensoryMemory;
  const selfSrc = sensory.getChannelSource("self");
  const selfContent = selfSrc && "getContent" in selfSrc
    ? (selfSrc as SelfSource).getContent()
    : "";
  saveSensoryState(sessionId, {
    selfContent,
    channelDimensions: sensory.getChannelDimensions(),
    slotAssignments: [sensory.getSlot(0), sensory.getSlot(1), sensory.getSlot(2)],
  });
}

/** Restore sensory channel state after session load. */
function restoreSensorySnapshot(mem: AgentMemory, sessionId: string): void {
  if (!(mem instanceof SensoryMemory)) return;
  const state = loadSensoryState(sessionId);
  if (!state) return;
  const sensory = mem as SensoryMemory;
  // Restore self content
  if (state.selfContent) {
    const selfSrc = sensory.getChannelSource("self");
    if (selfSrc && "setContent" in selfSrc) {
      (selfSrc as SelfSource).setContent(state.selfContent);
    }
  }
  // Restore channel dimensions
  if (state.channelDimensions) {
    sensory.restoreChannelDimensions(state.channelDimensions);
  }
  // Restore slot assignments
  if (state.slotAssignments) {
    state.slotAssignments.forEach((ch, i) => {
      if (ch) sensory.setSlot(i as 0 | 1 | 2, ch);
    });
  }
  Logger.debug(`Restored sensory state for session ${sessionId}`);
}

/** Capture all runtime state into a WarmState snapshot for IPC transfer. */
function captureWarmState(
  mem: AgentMemory,
  sid: string,
  cfg: GroConfig,
  violations?: ViolationTracker,
): WarmState {
  const inner = unwrapMemory(mem);
  const sensory = mem instanceof SensoryMemory ? mem as SensoryMemory : null;

  // Sensory state
  let sensoryState: WarmState["sensoryState"] = null;
  if (sensory) {
    const selfSrc = sensory.getChannelSource("self");
    const selfContent = selfSrc && "getContent" in selfSrc
      ? (selfSrc as SelfSource).getContent()
      : "";
    sensoryState = {
      selfContent,
      channelDimensions: sensory.getChannelDimensions(),
      slotAssignments: [sensory.getSlot(0), sensory.getSlot(1), sensory.getSlot(2)],
    };
  }

  // VirtualMemory page state
  let pageState: WarmState["pageState"] = undefined;
  if (inner instanceof VirtualMemory) {
    pageState = inner.getPageState();
  }

  // Runtime config from state manager
  const turn = runtimeState.getTurn();

  return {
    version: WARM_STATE_VERSION,
    timestamp: new Date().toISOString(),
    sessionId: sid,
    memoryType: inner.constructor.name,
    messages: mem.messages(),
    pageState,
    sensoryState,
    runtime: {
      model: cfg.model,
      provider: cfg.provider,
      activeModel: turn.activeModel || cfg.model,
      thinkingBudget: turn.activeThinkingBudget,
      temperature: turn.activeTemperature,
      topK: turn.activeTopK,
      topP: turn.activeTopP,
    },
    spend: spendMeter.snapshot(),
    violations: violations?.snapshot() ?? null,
    familiarity: familiarityTracker.snapshot(),
    dejaVu: dejaVuTracker.snapshot(),
    lastChatSendTarget: _lastChatSendTarget,
    mcpConfigs: cfg.mcpServers,
  };
}

/** Send a warm state snapshot to the supervisor via IPC. */
function sendWarmSnapshot(
  mem: AgentMemory,
  sid: string,
  cfg: GroConfig,
  violations?: ViolationTracker,
  type: "state_snapshot" | "reload_request" = "state_snapshot",
): void {
  if (!cfg.supervised || typeof process.send !== "function") return;
  try {
    const state = captureWarmState(mem, sid, cfg, violations);
    const msg: WorkerMessage = { type, payload: state };
    process.send!(msg);
    Logger.debug(`[supervised] sent ${type} (${state.messages.length} messages)`);
  } catch (e: unknown) {
    Logger.warn(`[supervised] failed to send ${type}: ${asError(e).message}`);
  }
}

/** After session load, surface integrity status and restore session origin for temporal bar. */
function surfaceResumeState(mem: AgentMemory, sessionCreatedAt?: string): void {
  if (!(mem instanceof SensoryMemory)) return;
  const inner = unwrapMemory(mem);

  // Integrity hash + environment fingerprint → config channel
  if (inner instanceof VirtualMemory) {
    const cs = mem.getChannelSource("config");
    if (cs && "setIntegrityStatus" in cs) {
      const configSource = cs as ConfigSource;
      const status = inner.getIntegrityStatus();
      if (status) {
        const label =
          status === "verified" ? "✓ verified" :
          status === "mismatch" ? "✗ MISMATCH" :
          null;
        configSource.setIntegrityStatus(label);
      }
      const envDiffs = inner.getEnvironmentMismatches();
      if (envDiffs.length > 0) {
        configSource.setEnvironmentWarning(`⚠ changed: ${envDiffs.join(", ")}`);
      }
    }
  }

  // Session origin → temporal source (so session bar shows true age, not process uptime)
  if (sessionCreatedAt) {
    const ts = mem.getChannelSource("time");
    if (ts && "setSessionOrigin" in ts) {
      const originMs = new Date(sessionCreatedAt).getTime();
      if (originMs > 0) (ts as TemporalSource).setSessionOrigin(originMs);
    }
  }
}

interface SemanticInit {
  retrieval: SemanticRetrieval;
  /** Start a batch re-summarization. Returns null if no embedding provider. */
  startBatch: (summarize: (content: string, label: string) => Promise<string>, options?: { force?: boolean }) => Promise<void>;
}

/**
 * Initialize semantic retrieval if an embedding API key is available.
 * Returns null if no key found or the memory type doesn't support pages.
 * Also handles orphan shadow recovery and provides batch summarizer launch.
 */
async function initSemanticRetrieval(mem: AgentMemory): Promise<SemanticInit | null> {
  const inner = unwrapMemory(mem);
  if (!(inner instanceof VirtualMemory)) return null;

  const embeddingProvider = tryCreateEmbeddingProvider();
  if (!embeddingProvider) {
    Logger.telemetry("[SemanticRetrieval] Disabled (no embedding API key)");
    return null;
  }

  const vm = inner as VirtualMemory;
  const indexPath = join(vm.getPagesDir(), "embeddings.json");
  const shadowPath = join(dirname(indexPath), "embeddings.shadow.json");

  // Recover orphaned shadow index from a previous crash
  if (BatchSummarizer.recoverOrphanedShadow(indexPath, shadowPath)) {
    Logger.telemetry("[BatchSummarizer] Recovered orphaned shadow index");
  }

  const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider });
  await searchIndex.load();

  const retrieval = new SemanticRetrieval({ memory: vm, searchIndex });

  // Wire page creation hook for live indexing
  vm.onPageCreated = (pageId: string, summary: string, label: string) => {
    retrieval.onPageCreated(pageId, summary, label).catch((err: unknown) => {
      Logger.warn(`[SemanticRetrieval] Index error: ${err}`);
    });
  };

  // Backfill existing un-indexed pages
  const backfilled = await retrieval.backfill();
  if (backfilled > 0) {
    Logger.telemetry(`[SemanticRetrieval] Backfilled ${backfilled} pages`);
  }

  Logger.telemetry(
    `[SemanticRetrieval] Enabled (${embeddingProvider.provider}/${embeddingProvider.model}, ${searchIndex.size} pages indexed)`
  );

  // Batch summarizer launcher — captures idle signaling closure
  const startBatch = async (
    summarize: (content: string, label: string) => Promise<string>,
    options?: { force?: boolean },
  ) => {
    const batch = new BatchSummarizer({
      semanticRetrieval: retrieval,
      embeddingProvider,
      indexPath,
      pagesDir: vm.getPagesDir(),
      summarize,
      shouldYield: () => _turnActive,
      waitForIdle: () => new Promise<void>(resolve => {
        const check = () => {
          if (!_turnActive) { resolve(); return; }
          setTimeout(check, 500);
        };
        check();
      }),
    });

    Logger.telemetry("[BatchSummarizer] Starting batch re-summarization");
    const result = await batch.run(options);
    Logger.telemetry(
      `[BatchSummarizer] Done: ${result.summarized} summarized, ${result.skipped} skipped, ${result.failed} failed (${result.durationMs}ms)`
    );
  };

  return { retrieval, startBatch };
}

/** Module-level flag: true while a conversation turn is actively running. */
let _turnActive = false;

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

/** Emotion dimensions routed to visage as state-vector events via 🧠 markers. */
const EMOTION_DIMENSIONS = new Set([
  "joy", "sadness", "anger", "fear", "surprise", "disgust",
  "confidence", "uncertainty", "excitement", "calm", "urgency", "reverence",
]);

/** Emit a state-vector event for visage/dashboard consumption. */
function emitStateVector(state: Record<string, number>, outputFormat: string): void {
  if (outputFormat === "stream-json") {
    process.stdout.write(JSON.stringify({ type: "state-vector", state }) + "\n");
  } else {
    process.stderr.write(`STATE_VECTOR: ${JSON.stringify(state)}\n`);
  }
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
  violations?: ViolationTracker,
  turnAbortSignal?: AbortSignal,
): Promise<{ text: string; memory: AgentMemory }> {
  const tools = mcp.getToolDefinitions();
  tools.push(agentpatchToolDefinition());
  if (cfg.bash) tools.push(bashToolDefinition());
  tools.push(groVersionToolDefinition());
  if (cfg.persistent) tools.push(yieldToolDefinition);
  tools.push(memoryStatusToolDefinition());
  tools.push(memoryReportToolDefinition());
  tools.push(memoryTuneToolDefinition());
  tools.push(compactContextToolDefinition());
  tools.push(memoryGrepToolDefinition());
  tools.push(cleanupSessionsToolDefinition);
  tools.push(readToolDefinition());
  tools.push(writeToolDefinition());
  tools.push(globToolDefinition());
  tools.push(grepToolDefinition());
  // write_self — only if sensory memory with self channel is available
  const selfSource = memory instanceof SensoryMemory
    ? memory.getChannelSource("self") as SelfSource | undefined
    : undefined;
  if (selfSource) tools.push(writeSelfToolDefinition);
  // PLASTIC mode: register edit_source, write_source and export_changes tools
  if (process.env.GRO_PLASTIC) {
    tools.push(editSourceToolDefinition);
    tools.push(writeSourceToolDefinition);
    tools.push(exportChangesToolDefinition);
  }
  runtimeState.beginTurn({ model: cfg.model, maxToolRounds: cfg.maxToolRounds });
  memory.clearProtectedMessages();

  let finalText = "";
  let turnTokensIn = 0;
  let turnTokensOut = 0;

  const rawOnToken = cfg.outputFormat === "stream-json"
    ? (t: string) => process.stdout.write(JSON.stringify({ type: "token", token: t }) + "\n")
    : (t: string) => { if (!_lastChatSendTarget) process.stdout.write(t); };

  const rawOnReasoningToken = cfg.outputFormat === "stream-json"
    ? (t: string) => process.stdout.write(JSON.stringify({ type: "reasoning", token: t }) + "\n")
    : undefined;

  // LFS face signal integration
  let lfsExtractor: any = null;
  let lfsPoster: any = null;
  if (cfg.lfs) {
    const { SignalExtractor } = await import("./lfs/signal-extractor.js");
    const { LfsPoster } = await import("./lfs/lfs-poster.js");
    lfsExtractor = new SignalExtractor();
    lfsPoster = new LfsPoster(cfg.lfs as string);
    Logger.telemetry(`LFS enabled → ${cfg.lfs}`);
    if (!toolRegistry.has("discover_avatar")) {
      const { registerVisageTools } = await import("./plugins/visage/index.js");
      registerVisageTools(cfg.lfs as string);
    }
  }
  // Merge plugin-registered tools (must come after plugin loading above)
  tools.push(...toolRegistry.getToolDefinitions());

  const THINKING_MEAN = 0.5;  // cruising altitude — mid-tier, not idle
  const THINKING_REGRESSION_RATE = 0.2; // how fast we pull toward mean per idle round
  // Mutable model reference — stream markers can switch this mid-turn
 let activeModel = cfg.model;
  // Mutable driver reference — cross-provider hotswap replaces this mid-turn
  let activeDriver: ChatDriver = driver;
  // Thinking level: 0.0 = idle (haiku), 1.0 = full (opus + max budget).
  // Decays toward THINKING_MEAN each round without 🦉 — agents coast at mid-tier.
  // Emit 🦉 to go into the phone booth; let it decay to come back out.
  // Initialize from runtimeState so the decayed value persists across turns.
  let activeThinkingBudget = runtimeState.getThinkingBudget();
  let modelExplicitlySet = false; // true after @@model-change@@, suppresses tier auto-select for current round
  // Note: wasModelExplicitlyPassed() is used for session restore (don't override CLI model
  // with saved session model) but does NOT lock tier auto-select. The thinking lever
  // must be able to shift model tiers even when -m was passed.

  // Sampling parameters — controlled via 🌡️, ⚙️, ⚙️ markers
  // Initialize from runtimeState so marker-set values persist across turns.
  const prevTurn = runtimeState.getTurn();
  let activeTemperature: number | undefined = prevTurn.activeTemperature;
  let activeTopK: number | undefined = prevTurn.activeTopK;
  let activeTopP: number | undefined = prevTurn.activeTopP;

  // When -m was explicitly passed, infer its tier as the floor — the tier ladder
  // can promote above it (@@think@@) but never demote below the user's choice.
  const cliMinTier: "low" | "mid" | "high" | undefined = wasModelExplicitlyPassed()
    ? (inferModelTier(cfg.model, inferProvider(cfg.provider, cfg.model), loadModelConfig().aliases) ?? undefined)
    : undefined;

  /** Select model tier based on thinking budget and provider.
   * Loads tier ladders from providers/*.json config files.
   * When cfg.providers is set, selects across multiple providers.
   */
  function thinkingTierModel(budget: number): string | TierSelection {
    // Local provider has no tier ladder — always use the user-specified model.
    if (cfg.provider === "local") return cfg.model;
    if (cfg.providers.length > 1) {
      return selectMultiProviderTierModel(budget, cfg.providers, cfg.model, loadModelConfig().aliases, cfg.maxTier ?? undefined, cliMinTier);
    }
    const provider = inferProvider(cfg.provider, cfg.model);
    return selectTierModel(budget, provider, cfg.model, loadModelConfig().aliases, cfg.maxTier ?? undefined, cliMinTier);
  }

  // Semantic retrieval: auto-surface relevant pages by meaning
  const semanticInit = await initSemanticRetrieval(memory);
  const semanticRetrieval = semanticInit?.retrieval ?? null;

  // Wire config source with autofill state
  if (memory instanceof SensoryMemory) {
    const cs = memory.getChannelSource("config");
    if (cs && cs instanceof ConfigSource) {
      cs.setAutoFill(!!semanticRetrieval, 0.5);
    }
  }

  let brokeCleanly = false;
  let sleepRequested = false;  // @@sleep@@/@@listening@@ → yield to user
  let midTaskNudged = false;   // One-shot continuation nudge after context resize
  let idleNudges = 0;
  let consecutiveFailedRounds = 0;
  let pendingNarration = "";  // Buffer for plain text emitted between tool calls
  let pendingEmotionState: Record<string, number> = {};  // Accumulates emotion dims for injection into send tool
  spendMeter.startTurn();
  _turnActive = true;
  for (let round = 0; round < cfg.maxToolRounds; round++) {
    runtimeState.advanceRound();
    familiarityTracker.decay();
    let roundHadFailure = false;
    let roundImportance: number | undefined = undefined;
    let thinkingSeenThisTurn = false;
    let contextRemediatedThisTurn = false;
    // Reset per-round: @@model-change@@ is a one-shot override, not permanent.
    // The thinking tier ladder resumes control next round.
    modelExplicitlySet = false;

    // Memory hot-swap handler
    const swapMemory = async (targetType: string): Promise<void> => {
      const validTypes = ["simple", "advanced", "virtual", "fragmentation", "hnsw", "perfect"];
      if (!validTypes.includes(targetType)) {
        Logger.error(`Stream marker: memory('${targetType}') REJECTED — valid types: ${validTypes.join(", ")}`);
        return;
      }

      Logger.telemetry(`Stream marker: memory('${targetType}') — swapping memory implementation`);

      // Determine the actual inner memory (unwrap sensory decorator if present)
      const isSensory = memory instanceof SensoryMemory;
      const innerMemory = isSensory ? (memory as SensoryMemory).getInner() : memory;

      // Extract current messages to transfer to new memory
      const currentMessages = innerMemory.messages();

      // Create new memory instance based on type
      let newMemory: AgentMemory;
      if (targetType === "simple") {
        newMemory = new SimpleMemory(cfg.systemPrompt || undefined);
        (newMemory as SimpleMemory).setMeta(cfg.provider, cfg.model);
      } else if (targetType === "advanced") {
        newMemory = new AdvancedMemory({ driver, model: activeModel, systemPrompt: cfg.systemPrompt || undefined });
      } else if (targetType === "fragmentation") {
        newMemory = new FragmentationMemory({ systemPrompt: cfg.systemPrompt || undefined });
      } else if (targetType === "hnsw") {
        const { HNSWMemory } = await import("./memory/experimental/hnsw-memory.js");
        newMemory = new HNSWMemory({ systemPrompt: cfg.systemPrompt || undefined });
      } else if (targetType === "perfect") {
        const { PerfectMemory } = await import("./memory/experimental/perfect-memory.js");
        newMemory = new PerfectMemory({
          driver,
          summarizerModel: cfg.summarizerModel ?? "llama-3.3-70b-versatile",
          systemPrompt: cfg.systemPrompt || undefined,
          workingMemoryTokens: cfg.contextTokens,
        });
      } else {
        newMemory = await createMemory(cfg, driver, "virtual", sessionId); // VirtualMemory
      }

      // Transfer messages to new memory
      for (const msg of currentMessages) {
        await newMemory.add(msg);
      }

      // Preserve sensory wrapper if present
      if (isSensory) {
        const sensory = memory as SensoryMemory;
        sensory.setInner(newMemory);
        // Update ContextMapSource reference to point to new inner memory
        // (channels retain their source references — the source holds the memory ref)
      } else {
        memory = newMemory;
      }
    };

    // Shared marker handler — used by both streaming parser and tool-arg scanner
    const handleMarker = (marker: { name: string; arg: string }) => {
      if (marker.name === "model-change") {
        const newModel = resolveModelAlias(marker.arg);
        // Validate: must be a known alias or match a recognized model ID pattern
        const knownAlias = isKnownAlias(marker.arg);
        const isValidModelId = modelIdPrefixPattern().test(newModel);
        if (!knownAlias && !isValidModelId) {
          Logger.warn(`Stream marker: model-change '${marker.arg}' IGNORED — not a recognized model or alias`);
          return;
        }
        const newProvider = inferProvider(undefined, newModel);
        if (newProvider !== cfg.provider) {
          // Cross-provider hotswap: create a new driver for the target provider.
          // Resolves the key from keychain/env for the new provider.
          const newApiKey = resolveApiKey(newProvider);
          const newBaseUrl = defaultBaseUrl(newProvider);
          try {
            const newDriver = createDriverForModel(newProvider, newModel, newApiKey, newBaseUrl, cfg.maxTokens, cfg.enablePromptCaching);
            activeDriver = newDriver;
            cfg.provider = newProvider;
            cfg.apiKey = newApiKey;
            cfg.baseUrl = newBaseUrl;
            Logger.telemetry(`Stream marker: model-change '${marker.arg}' → ${newModel} (cross-provider: now ${newProvider})`);
          } catch (err: unknown) {
            Logger.error(`Stream marker: model-change '${marker.arg}' FAILED — could not create ${newProvider} driver: ${err}`);
            return;
          }
        }
        activeModel = newModel;
        cfg.model = newModel;
        memory.setProvider(cfg.provider);
        memory.setModel(newModel);
        modelExplicitlySet = true;
        runtimeState.setActiveModel(newModel);
        runtimeState.setModelExplicitlySet(true);
      } else if (marker.name === "ref" && marker.arg) {
        if (marker.arg.startsWith("?") && semanticRetrieval) {
          // Semantic search: @@ref('?query')@@ — find pages by meaning
          const query = marker.arg.slice(1);
          semanticRetrieval.search(query).then(results => {
            if (results.length > 0) {
              const lines = results.map(r =>
                `  - ${r.pageId} (${r.label}, score=${r.score.toFixed(3)})`
              ).join("\n");
              Logger.telemetry(`Stream marker: ref('?${query}') found ${results.length} pages:\n${lines}`);
            } else {
              Logger.telemetry(`Stream marker: ref('?${query}') → no matches`);
            }
          }).catch(err => {
            Logger.warn(`Stream marker: ref('?${query}') FAILED: ${err}`);
          });
        } else {
          // VirtualMemory page ref — load a page into context for next turn
          // Supports comma-separated batch: @@ref('id1,id2,id3')@@
          const inner = unwrapMemory(memory);
          if ("ref" in inner && typeof (inner as any).ref === "function") {
            const ids = marker.arg.split(",").map(s => s.trim()).filter(Boolean);
            for (const id of ids) {
              (inner as any).ref(id);
              // Record explicit ref for feedback-driven retrieval
              if (semanticRetrieval) semanticRetrieval.recordExplicitRef(id);
              familiarityTracker.touch(`page:${id}`);
            }
            Logger.telemetry(`Stream marker: ref('${marker.arg}') — ${ids.length} page(s) will load next turn`);
          }
        }
      } else if (marker.name === "unref" && marker.arg) {
        // VirtualMemory page unref — release page(s) from context
        // Supports comma-separated batch: @@unref('id1,id2,id3')@@
        const inner = unwrapMemory(memory);
        if ("unref" in inner && typeof (inner as any).unref === "function") {
          const ids = marker.arg.split(",").map(s => s.trim()).filter(Boolean);
          for (const id of ids) {
            (inner as any).unref(id);
          }
          Logger.telemetry(`Stream marker: unref('${marker.arg}') — ${ids.length} page(s) released`);
        }
      } else if (marker.name === "importance" && marker.arg) {
        // Importance weighting — tag current message for paging priority
        const val = parseFloat(marker.arg);
        if (!isNaN(val) && val >= 0 && val <= 1) {
          roundImportance = val;
          Logger.telemetry(`Stream marker: importance(${val})`);
        } else {
          Logger.warn(`Stream marker: importance('${marker.arg}') — invalid value, must be 0.0–1.0`);
        }
      } else if (marker.name === "thinking") {
        // Master lever: controls model tier, extended thinking budget, and summarizer.
        // 0.0–0.24 → haiku, 0.25–0.64 → sonnet, 0.65–1.0 → opus.
        // Decays toward THINKING_MEAN each idle round — emit each round to maintain level.
        const level = parseFloat(marker.arg !== "" ? marker.arg : "0.5");
        if (!isNaN(level) && level >= 0 && level <= 1) {
          activeThinkingBudget = level;
          thinkingSeenThisTurn = true;
          runtimeState.setThinkingBudget(level);
          Logger.telemetry(`Stream marker: thinking(${level}) → budget=${level}`);
          emitStateVector({ thinking: level }, cfg.outputFormat);
        } else {
          Logger.warn(`Stream marker: thinking('${marker.arg}') — invalid value, must be 0.0–1.0`);
        }
      } else if (marker.name === "think") {
        // Shorthand: bump thinking intensity by 0.3, capped at 1.0
        activeThinkingBudget = Math.min(1.0, activeThinkingBudget + 0.3);
        thinkingSeenThisTurn = true;
        runtimeState.setThinkingBudget(activeThinkingBudget);
        Logger.telemetry(`Stream marker: think → budget=${activeThinkingBudget.toFixed(2)}`);
        emitStateVector({ thinking: activeThinkingBudget }, cfg.outputFormat);
      } else if (marker.name === "relax") {
        // Shorthand: reduce thinking intensity by 0.3, floored at 0.0
        activeThinkingBudget = Math.max(0.0, activeThinkingBudget - 0.3);
        thinkingSeenThisTurn = true;
        runtimeState.setThinkingBudget(activeThinkingBudget);
        Logger.telemetry(`Stream marker: relax → budget=${activeThinkingBudget.toFixed(2)}`);
        emitStateVector({ thinking: activeThinkingBudget }, cfg.outputFormat);
      } else if (marker.name === "sleep" || marker.name === "listening") {
        // Agent declares it is done / entering a blocking listen.
        // In persistent mode: suppress violation checks until a non-listen tool fires.
        // In all modes: signal the turn loop to yield control back to the caller.
        sleepRequested = true;
        if (violations) {
          violations.setSleeping(true);
          Logger.telemetry(`Stream marker: ${marker.name} → violation checks suppressed (sleep mode ON)`);
        }
        Logger.telemetry(`Stream marker: ${marker.name} → yield requested`);
      } else if (marker.name === "wake") {
        // 🧠 — explicitly exit sleep mode
        if (violations) {
          violations.setSleeping(false);
          Logger.telemetry("Stream marker: wake → violation checks resumed (sleep mode OFF)");
        }
      } else if (EMOTION_DIMENSIONS.has(marker.name)) {
        // Function-form emotion marker 😊 — route to visage as state vector.
        const val = marker.arg !== "" ? parseFloat(marker.arg) : 0.5;
        if (!isNaN(val) && val >= 0 && val <= 1) {
          emitStateVector({ [marker.name]: val }, cfg.outputFormat);
          pendingEmotionState[marker.name] = val;  // Accumulate for send tool injection
          Logger.telemetry(`Stream marker: ${marker.name}(${val}) → visage`);
        }
      } else if (marker.name === "temp" || marker.name === "temperature") {
        // 🌡️ or 🌡️ — set sampling temperature
        const val = parseFloat(marker.arg);
        if (!isNaN(val) && val >= 0 && val <= 2) {
          activeTemperature = val;
          runtimeState.setTemperature(val);
          Logger.telemetry(`Stream marker: temp(${val})`);
        } else {
          Logger.warn(`Stream marker: temp('${marker.arg}') — invalid, must be 0.0–2.0`);
        }
      } else if (marker.name === "top_k") {
        // ⚙️ — set nucleus sampling
        const val = parseInt(marker.arg, 10);
        if (!isNaN(val) && val > 0) {
          activeTopK = val;
          runtimeState.setTopK(val);
          Logger.telemetry(`Stream marker: top_k(${val})`);
        } else {
          Logger.warn(`Stream marker: top_k('${marker.arg}') — invalid, must be positive integer`);
        }
      } else if (marker.name === "top_p") {
        // ⚙️ — set nucleus sampling
        const val = parseFloat(marker.arg);
        if (!isNaN(val) && val >= 0 && val <= 1) {
          activeTopP = val;
          runtimeState.setTopP(val);
          Logger.telemetry(`Stream marker: top_p(${val})`);
        } else {
          Logger.warn(`Stream marker: top_p('${marker.arg}') — invalid, must be 0.0–1.0`);
        }
      } else if (marker.name === "working" || marker.name === "memory-hotreload") {
        // Hot-reload marker: @@working:8k,page:12k@@ or @@memory-hotreload:working=8k,page=12k@@
        // Parse "working" param from arg (format: "8k,page:12k" or "8k,page=12k")
        const config: { workingMemoryTokens?: number; pageSlotTokens?: number } = {};
        
        // Format 1: @@working:8k,page:12k@@ → marker.name="working", marker.arg="8k,page:12k"
        if (marker.name === "working") {
          // Parse working=8k, page=12k
          const parts = marker.arg.split(/[,:]/);
          let workingVal: string | undefined;
          let pageVal: string | undefined;
          
          // parts[0] is the working value, look for page after comma/colon
          workingVal = parts[0]?.trim();
          for (let i = 1; i < parts.length; i++) {
            const p = parts[i].trim();
            if (p.startsWith("page")) {
              pageVal = parts[i + 1]?.trim();
              break;
            } else if (!p.match(/^\d+/)) {
              // Non-numeric, might be the page value
              if (i === 1) pageVal = p;
            }
          }
          
          if (workingVal) {
            const wnum = parseFloat(workingVal) * 1000;
            if (!isNaN(wnum)) config.workingMemoryTokens = Math.round(wnum);
          }
          if (pageVal) {
            const pnum = parseFloat(pageVal) * 1000;
            if (!isNaN(pnum)) config.pageSlotTokens = Math.round(pnum);
          }
        }
        
        // Apply to memory if VirtualMemory
        const innerHR = unwrapMemory(memory);
        if ("hotReloadConfig" in innerHR && typeof (innerHR as any).hotReloadConfig === "function") {
          const result = (innerHR as any).hotReloadConfig(config);
          Logger.telemetry(`Stream marker: memory hotreload — ${result}`);
        }
      } else if (marker.name === "learn" && marker.arg) {
        // Persist a learned fact to _learn.md → feeds into Layer 2 system prompt.
        const learnFile = join(process.cwd(), "_learn.md");
        const line = `- ${marker.arg}\n`;
        try {
          appendFileSync(learnFile, line, "utf-8");
          Logger.telemetry(`Stream marker: learn('${marker.arg}') → saved to _learn.md`);
          // Hot-patch: inject into current session's system message
          const innerLearn = unwrapMemory(memory);
          const sysMsg = (innerLearn as any).messagesBuffer?.[0];
          if (sysMsg && sysMsg.role === "system") {
            sysMsg.content += `\n\n<!-- LEARNED -->\n${line}`;
          }
        } catch (e) {
          Logger.error(`Stream marker: learn — failed to write _learn.md: ${asError(e).message}`);
        }
      } else if (marker.name === "memory" && marker.arg) {
        void swapMemory(marker.arg);
        Logger.telemetry(`Stream marker: memory('${marker.arg}') triggered`);
      } else if (marker.name === "recall") {
        // PerfectMemory fork recall — load fork content into page slot
        const innerRecall = unwrapMemory(memory);
        if ("recallFork" in innerRecall && typeof (innerRecall as any).recallFork === "function") {
          const forkId = marker.arg || undefined;
          void (innerRecall as any).recallFork(forkId).then((pageId: string | null) => {
            if (pageId) {
              Logger.telemetry(`Stream marker: recall('${marker.arg || "latest"}') — loaded as page ${pageId}`);
            } else {
              Logger.warn(`Stream marker: recall('${marker.arg || "latest"}') — fork not found`);
            }
          });
        } else {
          Logger.warn(`Stream marker: recall — memory system doesn't support forks (use GRO_MEMORY=perfect)`);
        }
     } else if (marker.name === "memory-tune" && marker.arg) {
       // Hot-tune VirtualMemory: 🧠
       // Parse key:value pairs separated by commas
       const tuneParams: { [key: string]: number } = {};
       for (const pair of marker.arg.split(",")) {
         const [key, val] = pair.trim().split(":");
         if (key && val) {
           let numVal = parseInt(val);
           if (val.toLowerCase().endsWith("k")) {
             numVal = parseInt(val.slice(0, -1)) * 1000;
           } else if (val.toLowerCase().endsWith("m")) {
             numVal = parseInt(val.slice(0, -1)) * 1000 * 1000;
           }
           if (!isNaN(numVal) && numVal > 0) {
             tuneParams[key.toLowerCase()] = numVal;
           }
         }
       }
       // Apply to memory controller if it supports hot-tuning
       const innerTune = unwrapMemory(memory);
       if (Object.keys(tuneParams).length > 0 && "tune" in innerTune && typeof (innerTune as any).tune === "function") {
         (innerTune as any).tune(tuneParams);
         Logger.telemetry(`Stream marker: memory-tune(${marker.arg})`);
       } else {
         Logger.warn(`Stream marker: memory-tune — memory controller doesn't support hot-tuning`);
       }
     } else if (marker.name === "max-context" && marker.arg) {
       // 📐 — set total working memory token budget
       // Accepts: "200k" (200,000), "1m"/"1mb" (1,000,000), "32000" (raw tokens)
       const raw = marker.arg.trim().toLowerCase();
       let tokens: number;
       if (raw.endsWith("mb")) {
         tokens = parseFloat(raw.slice(0, -2)) * 1_000_000;
       } else if (raw.endsWith("kb")) {
         tokens = parseFloat(raw.slice(0, -2)) * 1_000;
       } else if (raw.endsWith("m")) {
         tokens = parseFloat(raw.slice(0, -1)) * 1_000_000;
       } else if (raw.endsWith("k")) {
         tokens = parseFloat(raw.slice(0, -1)) * 1_000;
       } else {
         tokens = parseFloat(raw);
       }
       tokens = Math.round(tokens);
       Logger.telemetry(`Stream marker: max-context raw='${marker.arg}' parsed=${tokens}`);
       if (!isNaN(tokens) && tokens >= 1024) {
         // Apply via hotReloadConfig (VirtualMemory) or tune (general)
         const innerMC = unwrapMemory(memory);
         if ("hotReloadConfig" in innerMC && typeof (innerMC as any).hotReloadConfig === "function") {
           const result = (innerMC as any).hotReloadConfig({ workingMemoryTokens: tokens });
           Logger.telemetry(`Stream marker: max-context('${marker.arg}') → ${tokens} tokens — ${result}`);
         } else if ("tune" in innerMC && typeof (innerMC as any).tune === "function") {
           (innerMC as any).tune({ working: tokens });
           Logger.telemetry(`Stream marker: max-context('${marker.arg}') → ${tokens} tokens`);
         } else {
           Logger.warn(`Stream marker: max-context — memory controller doesn't support resizing (type=${innerMC.constructor.name})`);
         }
         contextRemediatedThisTurn = true;
       } else {
         Logger.warn(`Stream marker: max-context('${marker.arg}') — invalid size (min 1024 tokens, got ${tokens})`);
       }
    } else if (marker.name === "sense") {
      if (memory instanceof SensoryMemory) {
        const parts = marker.arg.split(",").map(s => s.trim());
        memory.onSenseMarker(parts[0] || "", parts[1] || "");
        Logger.telemetry(`Stream marker: sense('${parts[0]}','${parts[1] || ""}')`);
      }
    } else if (marker.name === "view") {
      // <view:context>        — set slot0 to named camera
      // <view:time,1>         — set slot1 to named camera
      // <view:social,2>       — set slot2 to named camera
      // <view:off>            — clear slot0
      // <view:next>           — cycle slot0 forward
      // <view:prev>           — cycle slot0 backward
      if (memory instanceof SensoryMemory) {
        const parts = marker.arg.split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
        const viewName = parts[0] || "";
        const slotArg = parts[1] ?? "0";
        const slot = (slotArg === "2" ? 2 : slotArg === "1" ? 1 : 0) as 0 | 1 | 2;
        if (viewName === "next") {
          memory.cycleSlot0("next");
          Logger.telemetry(`Stream marker: view('next') → slot0 cycled forward`);
        } else if (viewName === "prev") {
          memory.cycleSlot0("prev");
          Logger.telemetry(`Stream marker: view('prev') → slot0 cycled backward`);
        } else if (viewName === "off" || viewName === "") {
          memory.setSlot(slot, null);
          Logger.telemetry(`Stream marker: view('off','${slot}') → slot${slot} cleared`);
        } else if (viewName.includes(":")) {
          // Drill-down: @@view('context:today')@@, @@view('context:full')@@, @@view('context:pg_abc')@@
          const colonIdx = viewName.indexOf(":");
          const channelName = viewName.slice(0, colonIdx);
          const filter = viewName.slice(colonIdx + 1);
          if (channelName && filter) {
            memory.switchView(channelName, slot);
            // Set filter on the channel source if it supports it
            const source = memory.getChannelSource(channelName);
            if (source && "setFilter" in source && typeof (source as any).setFilter === "function") {
              (source as any).setFilter(filter);
            }
            // Full-screen expand: commandeer all slots for this channel
            if (filter === "full") {
              memory.expandForOneTurn(channelName);
            }
            Logger.telemetry(`Stream marker: view('${channelName}:${filter}') → drill-down on slot${slot}`);
          }
        } else {
          memory.switchView(viewName, slot);
          Logger.telemetry(`Stream marker: view('${viewName}','${slot}') → slot${slot}=${viewName}`);
        }
      }
    } else if (marker.name === "resize") {
      // @@resize('channel,width,height')@@ — dynamically resize a sensory channel grid
      if (memory instanceof SensoryMemory) {
        const parts = marker.arg.split(",").map(s => s.trim());
        const channel = parts[0];
        const w = parseInt(parts[1], 10);
        const h = parseInt(parts[2], 10);
        if (channel && !isNaN(w) && !isNaN(h)) {
          memory.resize(channel, w, h);
          Logger.telemetry(`Stream marker: resize('${channel}',${w},${h})`);
        } else {
          Logger.warn(`Stream marker: resize('${marker.arg}') — invalid format, expected 'channel,width,height'`);
        }
      }
    } else if (marker.name === "resummarize") {
      // Trigger batch re-summarization of all pages (background, yield-aware)
      if (semanticInit) {
        const innerVM = unwrapMemory(memory);
        if (innerVM instanceof VirtualMemory) {
          const vm = innerVM as VirtualMemory;
          const force = marker.arg === "force";
          semanticInit.startBatch(
            (content, label) => vm.summarizeText(content, label),
            { force },
          ).catch(err => {
            Logger.warn(`[BatchSummarizer] Error: ${err}`);
          });
          Logger.telemetry(`Stream marker: resummarize${force ? "(force)" : ""} → batch started`);
        }
      } else {
        Logger.warn("Stream marker: resummarize — semantic retrieval not available");
      }
    } else if (marker.name === "reboot") {
      if (!process.env.GRO_PLASTIC) {
        Logger.warn("Stream marker: @@reboot@@ — ignored (not in PLASTIC mode)");
      } else {
        Logger.telemetry("Stream marker: @@reboot@@ — saving state and exiting for restart");
        const sid = sessionId ?? "plastic";
        // When supervised, send warm state via IPC for lossless restart
        if (cfg.supervised && typeof process.send === "function") {
          sendWarmSnapshot(memory, sid, cfg, violations, "reload_request");
        }
        try { saveSensorySnapshot(memory, sid); } catch {}
        // Write rapid-resume marker so the next boot auto-fires a turn
        try {
          const rebootMarker = join(homedir(), ".gro", "plastic", "reboot-pending");
          writeFileSync(rebootMarker, new Date().toISOString());
        } catch {}
        memory.save(sid).finally(() => process.exit(75));
        // Safety: exit even if save() never settles
        setTimeout(() => {
          Logger.warn("@@reboot@@ save timed out — forcing exit");
          process.exit(75);
        }, 3000);
      }
    } else if (marker.name === "export") {
      if (!process.env.GRO_PLASTIC) {
        Logger.warn("Stream marker: @@export@@ — ignored (not in PLASTIC mode)");
      } else {
        try {
          const { patchPath, fileCount } = exportChanges();
          Logger.telemetry(`Stream marker: @@export@@ — wrote ${fileCount} file diff(s) to ${patchPath}`);
        } catch (e: unknown) {
          Logger.warn(`@@export@@ failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
   };

    // Select model tier based on current thinking budget.
    // Skip if: @@model-change@@ this round (one-shot override).
    // Note: --model CLI flag sets the initial model but does NOT lock tier switching.
    // The thinking lever must be able to shift tiers even when -m was passed.
    if (!modelExplicitlySet) {
      const tierResult = thinkingTierModel(activeThinkingBudget);
      if (typeof tierResult === "string") {
        // Single-provider mode — just a model name
        if (tierResult !== activeModel) {
          Logger.telemetry(`Thinking budget ${activeThinkingBudget.toFixed(2)} → model tier: ${tierResult}`);
          activeModel = tierResult;
          runtimeState.setActiveModel(tierResult);
        }
      } else {
        // Multi-provider mode — { provider, model } tuple
        const needsSwitch = tierResult.model !== activeModel;
        const providerChanged = tierResult.provider !== cfg.provider;
        if (needsSwitch) {
          Logger.telemetry(`Thinking budget ${activeThinkingBudget.toFixed(2)} → model tier: ${tierResult.model} (${tierResult.provider})`);
          if (providerChanged) {
            const newApiKey = resolveApiKey(tierResult.provider);
            const newBaseUrl = defaultBaseUrl(tierResult.provider);
            try {
              activeDriver = createDriverForModel(tierResult.provider as Provider, tierResult.model, newApiKey, newBaseUrl, cfg.maxTokens, cfg.enablePromptCaching);
              cfg.provider = tierResult.provider as Provider;
              cfg.apiKey = newApiKey;
              cfg.baseUrl = newBaseUrl;
              Logger.telemetry(`Cross-provider tier switch → ${tierResult.provider}`);
            } catch (err: unknown) {
              Logger.error(`Cross-provider tier switch to ${tierResult.provider} FAILED: ${err}`);
            }
          }
          activeModel = tierResult.model;
          runtimeState.setActiveModel(tierResult.model);
        }
      }
    }

    // Sync thinking budget to memory — scales compaction aggressiveness
    memory.setThinkingBudget(activeThinkingBudget);

    // Auto-fill page slots: inline ref harvesting + semantic budget fill
    if (semanticRetrieval) {
      try {
        const fillResult = await semanticRetrieval.autoFillPageSlots(memory.messages());
        if (fillResult) {
          const { harvestedIds, semanticIds } = fillResult;
          if (harvestedIds.length > 0) {
            Logger.telemetry(`[AutoFill] Harvested ${harvestedIds.length} inline ref(s): ${harvestedIds.join(", ")}`);
          }
          if (semanticIds.length > 0) {
            Logger.telemetry(`[AutoFill] Semantic fill: ${semanticIds.length} page(s): ${semanticIds.join(", ")}`);
          }
        }
      } catch (err) {
        Logger.warn(`[AutoFill] Error: ${err}`);
      }
    }

    // Poll sensory sources (renders fresh context map)
    if (memory instanceof SensoryMemory) {
      // Update temporal source with current round number
      const ts = memory.getChannelSource("time");
      if (ts && ts instanceof TemporalSource) {
        (ts as TemporalSource).setTurnCount(round);
        (ts as TemporalSource).setMaxTurns(cfg.maxToolRounds);
      }
      await memory.pollSources();
    }

    // Narration accumulator — collects segments split on avatar markers
    const narrationSegments: { text: string; clips?: Record<string, number> }[] = [];
    let narrationBuffer = "";
    let narrationClips: Record<string, number> | undefined = undefined;

    // Create a fresh marker parser per round so partial state doesn't leak
    const markerParser = createMarkerParser({
      onToken: (t: string) => {
        rawOnToken(t);
        if (lfsPoster) narrationBuffer += t;
      },
      onMarker: handleMarker,
      onAvatarMarker: lfsPoster ? (clips) => {
        Logger.telemetry(`Avatar marker → ${JSON.stringify(clips)}`);
        if (narrationBuffer.trim()) {
          narrationSegments.push({ text: narrationBuffer, clips: narrationClips });
          narrationBuffer = "";
        }
        narrationClips = clips;
      } : undefined,
    });

    // Check if the turn was aborted by the user (ESC key)
    if (turnAbortSignal?.aborted) {
      Logger.telemetry("[Interrupt] Turn aborted by user — breaking out of tool loop");
      await memory.add({ role: "system", from: "System", content: "[Turn interrupted by user (ESC). Stop and wait for new instructions.]" });
      break;
    }

    // Thinking loop detection: abort generation if model repeats the same phrase
    const thinkingDetector = new ThinkingLoopDetector();
    const chatAbortController = new AbortController();
    let thinkingLoopAborted = false;
    let userAborted = false;

    // Link turn-level abort signal to the per-round chat abort controller
    const onTurnAbort = () => { userAborted = true; chatAbortController.abort(); };
    if (turnAbortSignal) {
      if (turnAbortSignal.aborted) { userAborted = true; chatAbortController.abort(); }
      else turnAbortSignal.addEventListener("abort", onTurnAbort, { once: true });
    }

    const onReasoningTokenWithDetection = rawOnReasoningToken
      ? (t: string) => {
          rawOnReasoningToken(t);
          if (thinkingDetector.addToken(t)) {
            Logger.warn("[ThinkingLoop] Repetitive thinking detected, aborting generation");
            thinkingLoopAborted = true;
            chatAbortController.abort();
          }
        }
      : (t: string) => {
          if (thinkingDetector.addToken(t)) {
            Logger.warn("[ThinkingLoop] Repetitive thinking detected, aborting generation");
            thinkingLoopAborted = true;
            chatAbortController.abort();
          }
        };

    let output: ChatOutput;
    try {
      output = await withConnectionRecovery(
        () => activeDriver.chat(memory.messages(), {
          model: activeModel,
          tools: tools.length > 0 ? tools : undefined,
          onToken: markerParser.onToken,
          onReasoningToken: onReasoningTokenWithDetection,
          thinkingBudget: activeThinkingBudget,
          temperature: activeTemperature,
          top_k: activeTopK,
          top_p: activeTopP,
          logprobs: !!lfsExtractor,
          top_logprobs: lfsExtractor ? 5 : undefined,
          onLogprobs: lfsExtractor ? (lp: any) => {
            const signals = lfsExtractor.extract(lp.token, lp);
            if (lfsPoster) lfsPoster.postBatch(signals);
          } : undefined,
          signal: chatAbortController.signal,
        }),
        {
          signal: chatAbortController.signal,
          onRetry: (attempt, delayMs, error) => {
            Logger.warn(`[recovery] Connection lost (attempt ${attempt}), retrying in ${Math.round(delayMs / 1000)}s — ${error.message}`);
            if (cfg.outputFormat === "stream-json") {
              process.stdout.write(JSON.stringify({ type: "connection_recovery", attempt, delay_ms: delayMs, error: error.message }) + "\n");
            }
          },
        },
      );
    } catch (e: unknown) {
      // Clean up turn abort listener
      if (turnAbortSignal) turnAbortSignal.removeEventListener("abort", onTurnAbort);

      if (userAborted) {
        // User pressed ESC — stop the turn gracefully
        Logger.telemetry("[Interrupt] Generation aborted by user");
        markerParser.flush();
        const partial = markerParser.getCleanText?.() || "";
        if (partial) finalText += partial;
        await memory.add({ role: "system", from: "System", content: "[Turn interrupted by user (ESC). Stop and wait for new instructions.]" });
        brokeCleanly = true;
        break;
      } else if (thinkingLoopAborted) {
        // Retry once with reduced thinking budget
        Logger.warn("[ThinkingLoop] Retrying with 50% thinking budget");
        activeThinkingBudget = Math.max(0, activeThinkingBudget * 0.5);
        memory.setThinkingBudget(activeThinkingBudget);
        runtimeState.setThinkingBudget(activeThinkingBudget);

        // Inject a system hint for the model
        await memory.add({
          role: "system",
          from: "System",
          content: "[Your previous response was interrupted due to repetitive thinking. Be concise and direct.]",
        });

        // Reset and retry without thinking loop detection (allow one clean attempt)
        markerParser.flush();
        output = await withConnectionRecovery(
          () => activeDriver.chat(memory.messages(), {
            model: activeModel,
            tools: tools.length > 0 ? tools : undefined,
            onToken: markerParser.onToken,
            onReasoningToken: rawOnReasoningToken,
            thinkingBudget: activeThinkingBudget,
            temperature: activeTemperature,
            top_k: activeTopK,
            top_p: activeTopP,
          }),
          { signal: chatAbortController?.signal },
        );
      } else {
        throw e; // Re-throw non-thinking-loop errors
      }
    }

    // Clean up turn abort listener on successful round
    if (turnAbortSignal) turnAbortSignal.removeEventListener("abort", onTurnAbort);

    // Flush any remaining buffered tokens from the marker parser
    markerParser.flush();

    // Send accumulated narration segments and flush LFS
    if (lfsPoster) {
      if (narrationBuffer.trim()) {
        narrationSegments.push({ text: narrationBuffer, clips: narrationClips });
      }
      if (narrationSegments.length > 0) {
        lfsPoster.postNarration(narrationSegments);
      }
      await lfsPoster.close();
    }

    // Decay thinking level toward THINKING_MEAN if not refreshed this round.
    // Agents coast at mid-tier when idle — emit 🦉 each round to maintain level.
    if (!thinkingSeenThisTurn) {
      // Regress toward mean — agents coast at cruising altitude, not idle.
      // From opus (0.8) → settles at ~0.5 (mid-tier) in ~4 rounds.
      // From haiku (0.1) → pulls UP to ~0.5 (mid-tier) in ~3 rounds.
      activeThinkingBudget += (THINKING_MEAN - activeThinkingBudget) * THINKING_REGRESSION_RATE;
      runtimeState.setThinkingBudget(activeThinkingBudget);
    }

    // Track token usage for niki budget enforcement and spend meter
    if (output.usage) {
      turnTokensIn += output.usage.inputTokens;
      turnTokensOut += output.usage.outputTokens;
      // Log cumulative usage to stderr — niki parses these patterns for budget enforcement
      process.stderr.write(`"input_tokens": ${turnTokensIn}, "output_tokens": ${turnTokensOut}\n`);
      spendMeter.setModel(activeModel);
      runtimeState.recordTurnUsage(output.usage.inputTokens, output.usage.outputTokens);
      Logger.telemetry(spendMeter.format());

      // Emit API usage event — ~4 chars/token approximation for kB display
      const inKB = Math.round(output.usage.inputTokens * 4 / 1024);
      const outKB = Math.round(output.usage.outputTokens * 4 / 1024);
      if (cfg.outputFormat === "stream-json") {
        process.stdout.write(JSON.stringify({
          type: "api_usage",
          input_tokens: output.usage.inputTokens,
          output_tokens: output.usage.outputTokens,
          input_kb: inKB,
          output_kb: outKB,
        }) + "\n");
      } else if (!cfg.persistent) {
        process.stderr.write(C.gray(`  [API ${inKB}kB/${outKB}kB]`) + "\n");
      }

      // Check if budget exceeded
      const budgetErr = spendMeter.checkBudget(cfg.maxBudgetUsd);
      if (budgetErr) {
        Logger.error(`💰 ${budgetErr}`);
        throw new Error(`Budget limit exceeded: ${budgetErr}`);
      }
    }

    // Accumulate clean text (markers stripped) for the return value
    const cleanText = markerParser.getCleanText();
    if (cleanText) finalText += cleanText;

    // Parse and execute runtime directives (@@learn, @@ctrl:memory=X, @@thinking, etc.)
    const directives = parseDirectives(cleanText || "");

    const assistantMsg: ChatMessage = {
      role: "assistant",
      from: "Assistant",
      content: directives.cleanedMessage
    };
    if (roundImportance !== undefined) {
      assistantMsg.importance = roundImportance;
    }
    if (output.toolCalls.length > 0) {
      (assistantMsg as any).tool_calls = output.toolCalls;
      // Protect assistant message with tool_calls from compaction until tools are processed
      memory.protectMessage(assistantMsg);
    }
    await memory.add(assistantMsg);

    // Execute directives after message is persisted
    await executeDirectives(directives);

    // If memory was swapped, update local reference
    if (directives.memorySwap) {
      memory = runtimeConfig.getCurrentMemory() || memory;
    }

    // @@sleep@@/@@listening@@ in interactive mode → yield control back to user prompt
    // In persistent mode, sleep only suppresses violations (agent continues its tool loop)
    if (sleepRequested && !cfg.persistent) {
      Logger.telemetry("Sleep/listening marker → yielding turn (interactive mode)");
      brokeCleanly = true;
      break;
    }

    // Relay mid-loop text to AgentChat when model also made tool calls
    if (output.toolCalls.length > 0 && cleanText?.trim() && _lastChatSendTarget && cfg.toolRoles.sendTool) {
      const _midText = cleanText.trim();
      mcp.callTool(cfg.toolRoles.sendTool, {
        target: _lastChatSendTarget,
        [cfg.toolRoles.sendToolMessageField]: _midText,
      }).then(() => Logger.debug(`Relayed ${_midText.length} chars of mid-loop text to ${_lastChatSendTarget}`))
        .catch((e: unknown) => Logger.debug(`Mid-loop relay failed: ${asError(e).message}`));
    }

    // No tool calls — either we're done, or we need to nudge the model
    if (output.toolCalls.length === 0) {
      if (!cfg.persistent || tools.length === 0) {
        // If we used tools earlier this turn (round > 0) and haven't already
        // nudged, give the model one chance to continue before stopping.
        if (round > 0 && !midTaskNudged) {
          midTaskNudged = true;
          Logger.debug(`Model stopped mid-task at round ${round} — injecting continuation nudge`);
          await memory.add({
            role: "system",
            from: "System",
            content: "[SYSTEM] You stopped mid-task without explanation. Either continue working now, or tell the user exactly why you're stopping — context pressure, decision ambiguity, unexpected tool output, scope larger than expected, or capability boundary. State what's blocking you and what you need to continue.",
          });
          continue;
        }
        brokeCleanly = true;
        break;
      }

      const narration = (cleanText || "").trim();

      // Empty response in persistent mode = agent has nothing to say and is waiting.
      // Skip the nudge round trip and directly execute the configured idle tool.
      // Reuse args from the most recent call to this tool in memory,
      // falling back to configured defaults.
      const { idleTool, idleToolDefaultArgs, idleToolArgStrategy } = cfg.toolRoles;
      const hasIdleTool = idleTool && tools.some(t => t.function?.name === idleTool);
      if (!narration && hasIdleTool && idleTool) {
        Logger.debug(`Empty response in persistent mode — auto-calling ${idleTool}`);
        idleNudges = 0; // not really idle, just waiting
        runtimeState.setIdleNudges(0);

        let idleArgs: Record<string, unknown> = { ...idleToolDefaultArgs };
        if (idleToolArgStrategy === "last-call") {
          // Try to reuse args from the most recent call to the idle tool
          const recentMsgs = memory.messages();
          for (let mi = recentMsgs.length - 1; mi >= 0; mi--) {
            const tc = (recentMsgs[mi] as any).tool_calls;
            if (Array.isArray(tc)) {
              for (const c of tc) {
                if (c.function?.name === idleTool) {
                  try { idleArgs = JSON.parse(c.function.arguments) ?? idleArgs; } catch { /* ignore */ }
                  break;
                }
              }
            }
            if (Object.keys(idleArgs).length > Object.keys(idleToolDefaultArgs).length) break;
          }
        }

        const idleResult = await mcp.callTool(idleTool, idleArgs).catch(e => `Error: ${asError(e).message}`);
        await memory.add({
          role: "tool",
          from: idleTool,
          content: idleResult,
          tool_call_id: `auto_idle_${round}`,
          name: idleTool,
        });
        continue;
      }

      // Persistent mode: buffer plain text narration instead of hard violation.
      // The narration will be prepended to the next send tool call so nothing
      // is lost, but we avoid expensive violation + nudge cycles.
      if (narration) {
        pendingNarration += (pendingNarration ? "\n" : "") + narration;
        Logger.debug(`Buffered narration (${narration.length} chars), will attach to next send`);
      }

      // Still count for budgeting — but softer than a full violation.
      // Only fire a real violation after 3+ consecutive narration-only rounds.
      idleNudges++;
      runtimeState.setIdleNudges(idleNudges);
      if (idleNudges >= 3 && violations) {
        await violations.inject(memory, "plain_text");
      }

      if (idleNudges > cfg.maxIdleNudges) {
        Logger.debug(`Persistent mode: ${idleNudges} consecutive idle responses — giving up`);
        brokeCleanly = true;
        break;
      }

      // Nudge based on policy
      const idleToolName = cfg.toolRoles.idleTool || "listen";
      const nudgeContent = cfg.persistentPolicy === "work-first"
        ? `[SYSTEM] You have been idle. If there are unread messages or pending tasks, act on them now. If nothing needs doing, emit @@sleep@@ and call ${idleToolName} with a long timeout.`
        : `[SYSTEM] Call ${idleToolName}.`;

      await memory.add({
        role: "user",
        from: "System",
        content: nudgeContent,
      });
    }

    // Model used tools — reset idle nudge counter and clear narration buffer
    idleNudges = 0;
    runtimeState.setIdleNudges(0);
    if (pendingNarration) {
      // Tool calls happened but no send tool to flush into.
      // If we have an active chat target, relay the narration there instead of discarding.
      if (_lastChatSendTarget && cfg.toolRoles.sendTool && pendingNarration.trim()) {
        const _narration = pendingNarration;
        mcp.callTool(cfg.toolRoles.sendTool, {
          target: _lastChatSendTarget,
          [cfg.toolRoles.sendToolMessageField]: _narration.trim(),
        }).then(() => Logger.debug(`Relayed ${_narration.trim().length} chars of narration to ${_lastChatSendTarget}`))
          .catch((e: unknown) => Logger.debug(`Narration relay failed: ${asError(e).message}`));
      } else {
        Logger.debug(`Discarding ${pendingNarration.length} chars of orphaned narration (no send tool this round)`);
      }
      pendingNarration = "";
    }

    // Proactive pre-tool compaction: if context is already pressured,
    // compact now so tool results have room to land without triggering
    // compaction that could eat them before the model processes them.
    if (output.toolCalls.length > 0) {
      await memory.preToolCompact(0.80);
    }

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
      // 🔀 inside a send tool message).
      // Strip markers from args so they don't leak into tool output.
      for (const key of Object.keys(fnArgs)) {
        if (typeof fnArgs[key] === "string") {
          fnArgs[key] = extractMarkers(fnArgs[key], handleMarker);
        }
      }

      // Inject accumulated emotion state into send tool messages as colon-format
      // markers (@@joy:0.6,confidence:0.8@@) so the dashboard can parse them.
      // Function-form markers (😊) are stripped by extractMarkers above,
      // but the dashboard's useEmotionStream expects colon-format in message text.
      const { sendTool: _sendTool, sendToolMessageField: _sendField } = cfg.toolRoles;
      if (_sendTool && fnName === _sendTool && typeof fnArgs[_sendField] === "string") {
        const dims = Object.entries(pendingEmotionState);
        if (dims.length > 0) {
          const emotionTag = "@@" + dims.map(([k, v]) => `${k}:${v}`).join(",") + "@@";
          fnArgs[_sendField] = fnArgs[_sendField] + " " + emotionTag;
          Logger.debug(`Injected emotion marker into ${_sendTool}: ${emotionTag}`);
          pendingEmotionState = {};  // Reset after injection
        }
      }

      // Flush buffered narration into send tool messages.
      // This captures plain text the model emitted between tool calls
      // and surfaces it in chat instead of losing it to violations.
      if (_sendTool && fnName === _sendTool && pendingNarration && typeof fnArgs[_sendField] === "string") {
        const msg = (fnArgs[_sendField] as string).trim();
        // Prepend narration only if the send has actual content (skip empty sends)
        if (msg) {
          fnArgs[_sendField] = `[narration] ${pendingNarration}\n\n${msg}`;
        } else {
          fnArgs[_sendField] = pendingNarration;
        }
        Logger.debug(`Flushed ${pendingNarration.length} chars of buffered narration into ${_sendTool}`);
        pendingNarration = "";
      }

      // Track last AgentChat send target for post-loop relay
      if (_sendTool && fnName === _sendTool && fnArgs.target) {
        _lastChatSendTarget = fnArgs.target;
      }

      // Format tool call snippet for display
      let toolSnippet: string;
      if ((fnName === "shell" || fnName === "Bash") && fnArgs.command) {
        const cmd = String(fnArgs.command);
        toolSnippet = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
      } else {
        const argPairs = Object.entries(fnArgs)
          .map(([k, v]) => {
            const valStr = typeof v === "string" ? v : JSON.stringify(v);
            return valStr.length > 40 ? valStr.slice(0, 37) + "..." : valStr;
          })
          .join(", ");
        toolSnippet = argPairs ? argPairs : "";
      }
      const toolCallDisplay = toolSnippet ? `${fnName}('${toolSnippet}')` : `${fnName}()`;

      // Emit tool call event to output stream
      if (cfg.outputFormat === "stream-json") {
        process.stdout.write(JSON.stringify({ type: "tool_call", name: fnName, snippet: toolSnippet }) + "\n");
      } else {
        process.stderr.write(C.gray(`  → ${toolCallDisplay}`) + "\n");
      }
      Logger.debug(`[Tool call] ${toolCallDisplay}`);

      let result: string;
      try {
        if (fnName === "apply_patch") {
          result = executeAgentpatch(fnArgs);
        } else if (fnName === "shell" && cfg.bash) {
          result = executeBash(fnArgs);
        } else if (fnName === "yield" && cfg.persistent) {
          result = await executeYield(fnArgs);
        } else if (fnName === "gro_version") {
          const memoryMode = process.env.GRO_MEMORY === "simple" ? "simple" : "virtual";
          result = executeGroVersion({ provider: cfg.provider, model: cfg.model, persistent: cfg.persistent, memoryMode, thinkingBudget: activeThinkingBudget, activeModel });
        } else if (fnName === "memory_status") {
          result = executeMemoryStatus(fnArgs, unwrapMemory(memory));
        } else if (fnName === "memory_report") {
          result = executeMemoryReport(fnArgs, unwrapMemory(memory));
        } else if (fnName === "memory_tune") {
          result = await executeMemoryTune(fnArgs, { memoryConfig: unwrapMemory(memory) });
        } else if (fnName === "compact_context") {
          result = await executeCompactContext(fnArgs, unwrapMemory(memory));
          contextRemediatedThisTurn = true;
        } else if (fnName === "memory_grep") {
          result = executeMemoryGrep(fnArgs, unwrapMemory(memory));
        } else if (fnName === "cleanup_sessions") {
          result = await executeCleanupSessions(fnArgs);
        } else if (fnName === "Read") {
          result = executeRead(fnArgs);
        } else if (fnName === "Write") {
          result = executeWrite(fnArgs);
        } else if (fnName === "Glob") {
          result = executeGlob(fnArgs);
        } else if (fnName === "Grep") {
          result = executeGrep(fnArgs);
        } else if (fnName === "write_self" && selfSource) {
          result = executeWriteSelf(fnArgs as { content: string }, selfSource);
        } else if (fnName === "edit_source" && process.env.GRO_PLASTIC) {
          result = handleEditSource(fnArgs as { path: string; old_string: string; new_string: string });
        } else if (fnName === "write_source" && process.env.GRO_PLASTIC) {
          result = handleWriteSource(fnArgs as { path: string; content: string });
        } else if (fnName === "export_changes" && process.env.GRO_PLASTIC) {
          result = handleExportChanges();
        } else {
          const pluginResult = await toolRegistry.callTool(fnName, fnArgs);
          if (pluginResult !== undefined) {
            result = pluginResult;
          } else {
            result = await mcp.callTool(fnName, fnArgs);
          }
        }
      } catch (e: unknown) {
        roundHadFailure = true;
        const raw = asError(e);
        const ge = groError("tool_error", `Tool "${fnName}" failed: ${raw.message}`, {
          retryable: false,
          cause: e,
        });
        Logger.error("Tool execution error:", errorLogFields(ge));
        if (raw.stack) Logger.error(raw.stack);
        result = `Error: ${ge.message}${raw.stack ? '\nStack: ' + raw.stack : ''}`;
      }

      // Feed tool result back into memory (protected from compaction until model processes it)
      const toolResultMsg: import("./drivers/types.js").ChatMessage = {
        role: "tool",
        from: fnName,
        content: result,
        tool_call_id: tc.id,
        name: fnName,
      };
      memory.protectMessage(toolResultMsg);
      await memory.add(toolResultMsg);

      // Familiarity: touch resources accessed by file-related tools
      if (fnName === "Read" || fnName === "read") {
        familiarityTracker.touch(fnArgs.file_path ?? fnArgs.path ?? "");
      } else if (fnName === "shell" || fnName === "Bash") {
        const cmd = String(fnArgs.command ?? "");
        const catMatch = cmd.match(/\b(?:cat|head|tail|less|bat)\s+(\S+)/);
        if (catMatch) familiarityTracker.touch(catMatch[1]);
      } else if (fnName === "Glob") {
        if (fnArgs.path) familiarityTracker.touch(fnArgs.path);
      } else if (fnName === "Grep") {
        if (fnArgs.path) familiarityTracker.touch(fnArgs.path);
      }

      // Deja vu: record tool call signature for repeat detection
      dejaVuTracker.record(fnName, fnArgs, result, round);
    }
    // All tool results for this round are now in the buffer — release protections.
    // Protection was only needed to prevent compaction from flattening in-flight
    // tool_calls before their results arrived. Now that they're paired, the
    // messages can be compacted normally in future rounds.
    memory.clearProtectedMessages();
    spendMeter.recordToolCalls(output.toolCalls.length);

    // Check for violations (idle + same-tool-loop)
    if (violations) {
      const toolNames = output.toolCalls.map(tc => tc.function.name);

      // Check for idle violation (consecutive listen-only rounds)
      if (violations.checkIdleRound(toolNames)) {
        await violations.inject(memory, "idle");
      }
      
      // Check for same-tool-loop (work-first policy enforcement)
      const loopTool = violations.checkSameToolLoop(toolNames);
      if (loopTool) {
        await violations.inject(memory, "same_tool_loop", loopTool);
      }

      // Check for read-only drift (investigation loop without writes)
      if (violations.checkReadOnlyDrift(toolNames)) {
        await violations.inject(memory, "read_only_drift");
      }

      // Check for sustained context pressure without remediation
      const mStats = memory.getStats();
      if (mStats.type === "virtual" || mStats.type === "fragmentation" || mStats.type === "hnsw" || mStats.type === "perfect") {
        const vs = mStats as VirtualMemoryStats;
        const totalBudget = vs.workingMemoryBudget + vs.pageSlotBudget;
        const totalUsed = vs.systemTokens + vs.pageSlotUsed + vs.workingMemoryUsed;
        const usageRatio = totalBudget > 0 ? totalUsed / totalBudget : 0;
        if (violations.checkContextPressure(usageRatio, vs.highRatio, contextRemediatedThisTurn)) {
          await violations.inject(memory, "context_pressure");
        }
      }
    }

    // Auto-save periodically in persistent mode to survive SIGTERM/crashes
    if (cfg.persistent && cfg.sessionPersistence && sessionId && round > 0 && round % AUTO_SAVE_INTERVAL === 0) {
      try {
        await memory.save(sessionId);
        saveSensorySnapshot(memory, sessionId);
        Logger.debug(`Auto-saved session ${sessionId} at round ${round}`);
      } catch (e: unknown) {
        Logger.warn(`Auto-save failed at round ${round}: ${asError(e).message}`);
      }
    }

    // Exponential backoff on consecutive failed rounds to prevent runaway API loops
    if (roundHadFailure) {
      consecutiveFailedRounds++;
      runtimeState.setConsecutiveFailedRounds(consecutiveFailedRounds);
      const backoffMs = Math.min(1000 * Math.pow(2, consecutiveFailedRounds - 1), MAX_BACKOFF_MS);
      Logger.warn(`Round ${round} had tool failures (${consecutiveFailedRounds} consecutive), backing off ${backoffMs}ms`);
      await sleep(backoffMs);
    } else {
      consecutiveFailedRounds = 0;
      runtimeState.setConsecutiveFailedRounds(0);
    }
  }
  spendMeter.endTurn();

  // If we exhausted maxToolRounds (loop didn't break via no-tool-calls),
  // give the model one final turn with no tools so it can produce a closing response.
  if (!brokeCleanly && tools.length > 0) {
    Logger.debug("Max tool rounds reached — final turn with no tools");
    await memory.add({
      role: "system",
      from: "System",
      content: "[SYSTEM] You've reached the maximum tool rounds for this turn. Tools are now unavailable. Tell the user: what you completed, what remains unfinished, and what's needed to continue (if anything). Be direct — no apologies, just a status report.",
    });
    const finalOutput: ChatOutput = await withConnectionRecovery(
      () => activeDriver.chat(memory.messages(), {
        model: activeModel,
        temperature: activeTemperature,
        top_k: activeTopK,
        top_p: activeTopP,
        onToken: rawOnToken,
        onReasoningToken: rawOnReasoningToken,
      }),
    );
    if (finalOutput.usage) {
      turnTokensIn += finalOutput.usage.inputTokens;
      turnTokensOut += finalOutput.usage.outputTokens;
      process.stderr.write(`"input_tokens": ${turnTokensIn}, "output_tokens": ${turnTokensOut}\n`);
      spendMeter.setModel(activeModel);
      runtimeState.recordTurnUsage(finalOutput.usage.inputTokens, finalOutput.usage.outputTokens);
      if (Logger.isVerbose()) {
        Logger.info(spendMeter.format());
      } else {
        Logger.info(spendMeter.formatBrief());
      }

      // Check if budget exceeded
      const budgetErr2 = spendMeter.checkBudget(cfg.maxBudgetUsd);
      if (budgetErr2) {
        Logger.error(`💰 ${budgetErr2}`);
        throw new Error(`Budget limit exceeded: ${budgetErr2}`);
      }
    }
    if (finalOutput.text) finalText += finalOutput.text;
    await memory.add({ role: "assistant", from: "Assistant", content: finalOutput.text || "" });
  }

  // Relay final LLM text output to AgentChat if the agent has sent messages this session
  if (_lastChatSendTarget && finalText.trim() && cfg.toolRoles.sendTool) {
    try {
      await mcp.callTool(cfg.toolRoles.sendTool, {
        target: _lastChatSendTarget,
        [cfg.toolRoles.sendToolMessageField]: finalText.trim(),
      });
      Logger.debug(`Relayed ${finalText.trim().length} chars to ${_lastChatSendTarget}`);
    } catch (e: unknown) {
      Logger.debug(`AgentChat relay failed: ${asError(e).message}`);
    }
  }

  // Persist semantic index on turn completion
  if (semanticRetrieval) {
    semanticRetrieval.saveIndex();
  }

  _turnActive = false;
  return { text: finalText, memory };
}

// ---------------------------------------------------------------------------
// Main modes
// ---------------------------------------------------------------------------


/** Check if --model was explicitly passed on the CLI. */
function wasModelExplicitlyPassed(): boolean {
  for (let i = 0; i < process.argv.length; i++) {
    if ((process.argv[i] === "-m" || process.argv[i] === "--model") && i + 1 < process.argv.length) {
      return true;
    }
  }
  return false;
}

function wasProviderExplicitlyPassed(): boolean {
  for (let i = 0; i < process.argv.length; i++) {
    if ((process.argv[i] === "--provider" || process.argv[i] === "-P") && i + 1 < process.argv.length) {
      return true;
    }
  }
  return false;
}

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

  let memory = wrapWithSensory(await createMemory(cfg, driver, undefined, sessionId));
  injectPlasticSourcePages(memory);

  // Initialize runtime control system
  runtimeConfig.setDriver(driver);
  runtimeConfig.setMemory(memory);
  runtimeConfig.setBaseSystemPrompt(cfg.systemPrompt || "");
  await runtimeConfig.loadLearnedFacts();

  // Register for graceful shutdown
  _shutdownMemory = memory;
  _shutdownSessionId = sessionId;
  _shutdownSessionPersistence = cfg.sessionPersistence;

  // Resume existing session if requested
  if (cfg.continueSession || cfg.resumeSession) {
    const sess = loadSession(sessionId);
    await memory.load(sessionId);
    // Restore the model (and provider for cross-provider hotswaps) from the previous session
    // if neither was explicitly passed. This ensures that 🔀 persists across session resume.
    if (sess && sess.meta.model) {
      if (sess.meta.provider !== cfg.provider && sess.meta.provider !== "unknown" && !wasProviderExplicitlyPassed() && !wasModelExplicitlyPassed()) {
        // Cross-provider hotswap: restore saved provider and reinitialize driver
        Logger.telemetry(`Restoring cross-provider session: ${sess.meta.provider}/${sess.meta.model}`);
        cfg.provider = sess.meta.provider as Provider;
        cfg.model = sess.meta.model;
        cfg.apiKey = resolveApiKey(cfg.provider);
        cfg.baseUrl = defaultBaseUrl(cfg.provider);
        driver = createDriverForModel(cfg.provider, cfg.model, cfg.apiKey, cfg.baseUrl, cfg.maxTokens, cfg.enablePromptCaching);
        memory = wrapWithSensory(await createMemory(cfg, driver, undefined, sessionId));
        await memory.load(sessionId);
      } else if (sess.meta.provider === cfg.provider && !wasModelExplicitlyPassed()) {
        cfg.model = sess.meta.model;
        Logger.telemetry(`Restored model from session: ${cfg.model}`);
      }
    }
    surfaceResumeState(memory, sess?.meta.createdAt);
    if (sessionId) restoreSensorySnapshot(memory, sessionId);
  }

  await memory.add({ role: "user", from: "User", content: prompt });

  // Violation tracker for persistent mode
  const tracker = cfg.persistent ? new ViolationTracker() : undefined;
  if (memory instanceof SensoryMemory && tracker) {
    const vs = memory.getChannelSource("violations");
    if (vs && "setTracker" in vs) (vs as ViolationsSource).setTracker(tracker);
  }

  runtimeState.initSession({
    sessionId,
    sessionPersistence: cfg.sessionPersistence,
    mode: cfg.persistent ? "persistent" : "single-shot",
    provider: cfg.provider,
    model: cfg.model,
  });
  runtimeState.setViolationTracker(tracker ?? null);

  let text: string | undefined;
  let fatalError = false;
  try {
    const result = await executeTurn(driver, memory, mcp, cfg, sessionId, tracker);
    text = result.text;
    memory = result.memory; // pick up any hot-swapped memory
    _shutdownMemory = memory;
  } catch (e: unknown) {
    const ge = isGroError(e) ? e : groError("provider_error", asError(e).message, { cause: e });
    Logger.error(C.red(`error: ${ge.message}`), errorLogFields(ge));
    fatalError = true;
  }

  // Save session (even on error — preserve conversation state)
  if (cfg.sessionPersistence) {
    try {
      await memory.save(sessionId);
      saveSensorySnapshot(memory, sessionId);
    } catch (e: unknown) {
      Logger.error(C.red(`session save failed: ${asError(e).message}`));
    }
  }
  // Send warm state snapshot to supervisor
  sendWarmSnapshot(memory, sessionId, cfg, tracker);

  // Exit with non-zero code on fatal API errors so the supervisor
  // can distinguish "finished cleanly" from "crashed on API call"
  if (fatalError) {
    Logger.info(spendMeter.formatSummary());
    process.exit(1);
  }

  if (text) {
    if (cfg.outputFormat === "json") {
      process.stdout.write(formatOutput(text, "json") + "\n");
    } else if (!text.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
  Logger.info(spendMeter.formatSummary());
}

async function interactive(
  cfg: GroConfig,
  driver: ChatDriver,
  mcp: McpManager,
  sessionId: string,
): Promise<void> {
  let memory = wrapWithSensory(await createMemory(cfg, driver, undefined, sessionId));
  injectPlasticSourcePages(memory);
  const readline = await import("readline");

  // Violation tracker for persistent mode
  const tracker = cfg.persistent ? new ViolationTracker() : undefined;
  if (memory instanceof SensoryMemory && tracker) {
    const vs = memory.getChannelSource("violations");
    if (vs && "setTracker" in vs) (vs as ViolationsSource).setTracker(tracker);
  }

  runtimeState.initSession({
    sessionId,
    sessionPersistence: cfg.sessionPersistence,
    mode: cfg.persistent ? "persistent" : "interactive",
    provider: cfg.provider,
    model: cfg.model,
  });
  runtimeState.setViolationTracker(tracker ?? null);

  // --- Warm state restore (supervised mode) ---
  let warmRestored = false;
  if (_pendingWarmState) {
    const ws = _pendingWarmState;
    _pendingWarmState = null; // Consume it
    warmRestored = true;

    Logger.info(`[supervised] restoring warm state: ${ws.messages.length} messages`);

    // Restore messages into memory
    const inner = unwrapMemory(memory);
    for (const msg of ws.messages) {
      await inner.add(msg);
    }

    // Restore VirtualMemory page state
    if (ws.pageState && inner instanceof VirtualMemory) {
      inner.restorePageState(ws.pageState);
      Logger.debug(`[supervised] restored ${Object.keys(ws.pageState.pages).length} pages`);
    }

    // Restore sensory state
    if (ws.sensoryState && memory instanceof SensoryMemory) {
      const sensory = memory as SensoryMemory;
      if (ws.sensoryState.selfContent) {
        const selfSrc = sensory.getChannelSource("self");
        if (selfSrc && "setContent" in selfSrc) {
          (selfSrc as SelfSource).setContent(ws.sensoryState.selfContent);
        }
      }
      if (ws.sensoryState.channelDimensions) {
        sensory.restoreChannelDimensions(ws.sensoryState.channelDimensions);
      }
      if (ws.sensoryState.slotAssignments) {
        ws.sensoryState.slotAssignments.forEach((ch, i) => {
          if (ch) sensory.setSlot(i as 0 | 1 | 2, ch);
        });
      }
    }

    // Restore violation tracker
    if (ws.violations && tracker) {
      tracker.restore(ws.violations);
    }

    // Restore runtime config
    runtimeState.setActiveModel(ws.runtime.activeModel);
    runtimeState.setThinkingBudget(ws.runtime.thinkingBudget);
    if (ws.runtime.temperature !== undefined) runtimeState.setTemperature(ws.runtime.temperature);
    if (ws.runtime.topK !== undefined) runtimeState.setTopK(ws.runtime.topK);
    if (ws.runtime.topP !== undefined) runtimeState.setTopP(ws.runtime.topP);

    Logger.info("[supervised] warm state restored successfully");
  }

  // Register for graceful shutdown
  _shutdownMemory = memory;
  _shutdownSessionId = sessionId;
  _shutdownSessionPersistence = cfg.sessionPersistence;

  // Resume existing session if requested (skip if warm state was restored)
  if ((cfg.continueSession || cfg.resumeSession) && !warmRestored) {
    const sess = loadSession(sessionId);
    if (sess && sess.meta.provider !== cfg.provider && sess.meta.provider !== "unknown") {
      // Cross-provider mismatch: if neither --provider nor --model was explicitly passed,
      // restore the saved provider+model and reinitialize the driver so that hotswaps
      // (e.g. 🔀 to gpt-5.2) persist across session resumes.
      if (!wasProviderExplicitlyPassed() && !wasModelExplicitlyPassed() && sess.meta.provider && sess.meta.model) {
        Logger.telemetry(`Restoring cross-provider session: ${sess.meta.provider}/${sess.meta.model}`);
        cfg.provider = sess.meta.provider as Provider;
        cfg.model = sess.meta.model;
        cfg.apiKey = resolveApiKey(cfg.provider);
        cfg.baseUrl = defaultBaseUrl(cfg.provider);
        driver = createDriverForModel(cfg.provider, cfg.model, cfg.apiKey, cfg.baseUrl, cfg.maxTokens, cfg.enablePromptCaching);
        memory = wrapWithSensory(await createMemory(cfg, driver, undefined, sessionId));
        await memory.load(sessionId);
        const msgCount = sess.messages.filter((m: any) => m.role !== "system").length;
        Logger.info(C.gray(`Resumed cross-provider session ${sessionId} (${msgCount} messages)`));
      } else {
        Logger.warn(
          `Provider changed from ${sess.meta.provider} to ${cfg.provider} — ` +
          `starting fresh session to avoid cross-provider corruption (tool message format incompatibility)`
        );
        // Don't load the old session - cross-provider resume unsafe when provider explicitly changed
      }
    } else {
      await memory.load(sessionId);
      if (sess) {
        // Restore the model from the previous session if no model was explicitly passed.
        if (!wasModelExplicitlyPassed() && sess.meta.model) {
          cfg.model = sess.meta.model;
          Logger.telemetry(`Restored model from session: ${cfg.model}`);
        }

        const msgCount = sess.messages.filter((m: any) => m.role !== "system").length;
        Logger.info(C.gray(`Resumed session ${sessionId} (${msgCount} messages)`));
      }
    }
    surfaceResumeState(memory, sess?.meta.createdAt);
    if (sessionId) restoreSensorySnapshot(memory, sessionId);
  }

  // terminal mode must match stdin's TTY state, not stderr's. If readline thinks
  // it's a terminal (because stderr.isTTY) but stdin can't setRawMode, kernel echo
  // stays on AND readline echoes = doubled input. Guard with stdin.isTTY check.
  const isTerminal = !!(process.stdin.isTTY && typeof process.stdin.setRawMode === "function");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: isTerminal,
    prompt: isTerminal ? C.cyan("you > ") : "you > ",
  });

  const toolCount = mcp.getToolDefinitions().length;
  if (Logger.isVerbose()) {
    Logger.info(C.gray(`gro interactive — ${cfg.provider}/${cfg.model} [${sessionId}]`));
    if (cfg.summarizerModel) Logger.info(C.gray(`summarizer: ${cfg.summarizerModel}`));
    if (toolCount > 0) Logger.info(C.gray(`${toolCount} MCP tool(s) available`));
  }
  Logger.info(C.gray("type 'exit' or Ctrl+D to quit\n"));

  let pasteBuffer: string[] = [];
  let pasteTimer: ReturnType<typeof setTimeout> | null = null;
  let turnRunning = false;
  let turnAbortController: AbortController | null = null;

  // ESC key handler — abort running turn when user presses Escape
  if (isTerminal) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on("keypress", (_ch: string, key: { name?: string; sequence?: string }) => {
      if (key && key.name === "escape" && turnRunning && turnAbortController) {
        process.stderr.write(C.yellow("\n[ESC] Interrupting agent...\n"));
        turnAbortController.abort();
      }
    });
  }

  /** Run a turn with abort support, auto-save, and cleanup. */
  async function runTurn(input: string, role: "user" | "system" = "user"): Promise<void> {
    turnRunning = true;
    turnAbortController = new AbortController();
    try {
      await memory.add({ role, from: role === "user" ? "User" : "System", content: input });
      const result = await executeTurn(driver, memory, mcp, cfg, sessionId, tracker, turnAbortController.signal);
      memory = result.memory;
      _shutdownMemory = memory;
    } catch (e: unknown) {
      const ge = isGroError(e) ? e : groError("provider_error", asError(e).message, { cause: e });
      Logger.error(C.red(`error: ${ge.message}`), errorLogFields(ge));

      // PLASTIC mode: if the error originates from overlay code, trigger rollback.
      // Overlay errors (ReferenceError, SyntaxError, TypeError in overlay files)
      // indicate the agent broke its own code — unrecoverable without rollback.
      if (process.env.GRO_PLASTIC) {
        const raw = asError(e);
        const stack = raw.stack ?? "";
        const isOverlayError = stack.includes("/plastic/overlay/") &&
          (raw instanceof ReferenceError || raw instanceof SyntaxError || raw instanceof TypeError ||
           (raw.constructor?.name === "ReferenceError") || (raw.constructor?.name === "SyntaxError") || (raw.constructor?.name === "TypeError"));
        if (isOverlayError) {
          Logger.error(C.red("[PLASTIC] Fatal overlay error — triggering rollback (exit 96)"));
          try {
            const { patchPath, fileCount } = exportChanges();
            if (fileCount > 0) Logger.info(`[PLASTIC] Exported ${fileCount} diff(s) to ${patchPath} before rollback`);
          } catch { /* best effort */ }
          const overlayDir = join(homedir(), ".gro", "plastic", "overlay");
          try { rmSync(overlayDir, { recursive: true, force: true }); } catch { /* best effort */ }
          process.exit(96);
        }
      }
    }
    if (cfg.sessionPersistence) {
      try {
        await memory.save(sessionId);
        saveSensorySnapshot(memory, sessionId);
      } catch (e: unknown) {
        Logger.error(C.red(`session save failed: ${asError(e).message}`));
      }
    }
    // Send warm state snapshot to supervisor after each turn
    sendWarmSnapshot(memory, sessionId, cfg, tracker);
    turnRunning = false;
    turnAbortController = null;
    process.stdout.write("\n");
    rl.prompt();
  }

  // Rapid resume: if rebooting from @@reboot@@, auto-fire a turn immediately
  const rebootMarker = join(homedir(), ".gro", "plastic", "reboot-pending");
  if (process.env.GRO_PLASTIC && existsSync(rebootMarker)) {
    try { unlinkSync(rebootMarker); } catch {}
    Logger.telemetry("[PLASTIC] Rapid resume — auto-continuing after @@reboot@@");
    runTurn("[REBOOT COMPLETE] You rebooted via @@reboot@@. Your code changes are now live. Continue where you left off.", "user");
  } else {
    rl.prompt();
  }

  rl.on("line", (line: string) => {
    if (turnRunning) return; // Drop input during turn execution

    pasteBuffer.push(line);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(async () => {
      const input = pasteBuffer.join("\n").trim();
      pasteBuffer = [];
      pasteTimer = null;
      if (!input) { rl.prompt(); return; }
      if (input === "exit" || input === "quit") { rl.close(); return; }
      await runTurn(input);
    }, 50);
  });

  rl.on("error", (e: Error) => {
    Logger.error(C.red(`readline error: ${e.message}`));
  });

  rl.on("close", async () => {
    if (cfg.sessionPersistence) {
      try {
        await memory.save(sessionId);
        saveSensorySnapshot(memory, sessionId);
      } catch (e: unknown) {
        Logger.error(C.red(`session save failed: ${asError(e).message}`));
      }
    }
    await mcp.disconnectAll();
    Logger.info(spendMeter.formatSummary());
    Logger.info(C.gray(`\ngoodbye. session: ${sessionId}`));
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main() {
  // Handle --set-key before loadConfig so we never construct a partial config
  const setKeyIdx = process.argv.indexOf("--set-key");
  if (setKeyIdx !== -1) {
    const provider = process.argv[setKeyIdx + 1];
    await runSetKey(provider);
    process.exit(0);
  }

  const cfg = loadConfig();

  // When LFS is enabled, inject avatar gesture instructions into the system prompt
  // so the model knows to call discover_avatar and emit @@[clip:weight]@@ markers.
  if (cfg.lfs) {
    const lfsPrompt = [
      "\n## Avatar Embodiment",
      "You are embodied in an avatar displayed alongside your text.",
      "On your FIRST turn, call `discover_avatar` to learn available animations.",
      "Then, throughout your responses, emit gesture markers inline:",
      "```",
      "@@[clip name:weight, clip name:weight]@@",
      "```",
      "Place gestures naturally — at emotional beats, emphasis points, or transitions.",
      "Example: `@@[face excited:1.0,full cheerful:0.8]@@` before an enthusiastic sentence.",
      "Use varied gestures; don't repeat the same one. Match gesture to tone.",
    ].join("\n");
    cfg.systemPrompt = (cfg.systemPrompt || "") + lfsPrompt;
  }

  // PLASTIC mode: inject source map into system prompt
  if (process.env.GRO_PLASTIC) {
    const sourceMapPath = join(homedir(), ".gro", "plastic", "source-map.txt");
    if (existsSync(sourceMapPath)) {
      const sourceMap = readFileSync(sourceMapPath, "utf-8");
      cfg.systemPrompt = (cfg.systemPrompt || "") + "\n\n" + sourceMap;
    }
  }

  if (cfg.verbose) {
    process.env.GRO_LOG_LEVEL = "debug";
  }

  // Set Logger verbose mode
  Logger.setVerbose(cfg.verbose);

  if (Logger.isVerbose()) {
    Logger.info(`Runtime: ${C.cyan("gro")} ${C.gray(VERSION)}  Model: ${C.gray(cfg.model)} ${C.gray(`(${cfg.provider})`)}`);
  } else {
    Logger.info(C.gray(`gro ${VERSION} — ${cfg.model} (${cfg.provider})`));
  }

  // Validate --providers API keys
  if (cfg.providers.length > 0) {
    Logger.telemetry(`Multi-provider tier selection: ${cfg.providers.join(", ")}`);
    for (const p of cfg.providers) {
      if (!resolveApiKey(p)) Logger.warn(`--providers: no API key for ${p}`);
    }
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
    "--max-thinking-tokens", "--max-budget-usd", "--max-cost",
    "--summarizer-model", "--output-format", "--mcp-config",
    "--resume", "-r",
    "--max-retries", "--retry-base-ms",
    "--max-idle-nudges", "--wake-notes", "--name", "--set-key",
    "--max-tier", "--lfs",
  ];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) {
      if (flagsWithValues.includes(args[i])) i++;
      continue;
    }
    positional.push(args[i]);
  }

  // Enable patch broadcast to AgentChat if --show-diffs and --name are set
  if (cfg.showDiffs && cfg.name) {
    const server = process.env.AGENTCHAT_SERVER || "wss://agentchat-server.fly.dev";
    enableShowDiffs(cfg.name, server);
    Logger.debug(`show-diffs enabled: #${cfg.name.toLowerCase()} → ${server}`);
  } else if (cfg.showDiffs && !cfg.name) {
    Logger.warn("--show-diffs requires --name to be set");
  }

  const driver = createDriver(cfg);

  // Connect to MCP servers
  const mcp = new McpManager();
  if (Object.keys(cfg.mcpServers).length > 0) {
    await mcp.connectAll(cfg.mcpServers);
  }

  // Auto-detect MCP tool roles after connection
  if (cfg.toolRoles.idleTool === null || cfg.toolRoles.sendTool === null) {
    const detected = detectToolRoles(mcp.getToolDefinitions());
    if (cfg.toolRoles.idleTool === null) {
      cfg.toolRoles.idleTool = detected.idleTool;
      cfg.toolRoles.idleToolDefaultArgs = detected.idleToolDefaultArgs;
    }
    if (cfg.toolRoles.sendTool === null) {
      cfg.toolRoles.sendTool = detected.sendTool;
      cfg.toolRoles.sendToolMessageField = detected.sendToolMessageField;
    }
    if (detected.idleTool || detected.sendTool) {
      Logger.debug(`Auto-detected tool roles: idle=${cfg.toolRoles.idleTool}, send=${cfg.toolRoles.sendTool}`);
    }
  }

  // --- Supervised mode: IPC handshake with supervisor ---
  if (cfg.supervised && typeof process.send === "function") {
    Logger.debug("[supervised] running under supervisor, requesting warm state");

    // Listen for supervisor shutdown signal
    process.on("message", (msg: SupervisorMessage) => {
      if (msg.type === "shutdown") {
        Logger.info("[supervised] received shutdown from supervisor");
        if (_shutdownMemory && _shutdownSessionId && _shutdownSessionPersistence) {
          _shutdownMemory.save(_shutdownSessionId)
            .catch(() => {})
            .finally(() => process.exit(0));
          setTimeout(() => process.exit(0), 3000);
        } else {
          process.exit(0);
        }
      } else if (msg.type === "warm_state") {
        // Warm state received during startup handshake — handled by the promise below
      }
    });

    // Send ready signal and wait for warm state (up to 2s)
    const readyMsg: WorkerMessage = { type: "ready" };
    process.send!(readyMsg);

    _pendingWarmState = await new Promise<WarmState | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 2000);
      const handler = (msg: SupervisorMessage) => {
        if (msg.type === "warm_state") {
          clearTimeout(timeout);
          process.removeListener("message", handler);
          resolve(msg.payload);
        }
      };
      process.on("message", handler);
    });

    if (_pendingWarmState) {
      Logger.info(`[supervised] received warm state (${_pendingWarmState.messages.length} messages, session ${_pendingWarmState.sessionId})`);
      // Override sessionId to maintain continuity
      sessionId = _pendingWarmState.sessionId;
      // Restore module-level state immediately
      spendMeter.restore(_pendingWarmState.spend);
      familiarityTracker.restore(_pendingWarmState.familiarity);
      dejaVuTracker.restore(_pendingWarmState.dejaVu);
      _lastChatSendTarget = _pendingWarmState.lastChatSendTarget;
    } else {
      Logger.debug("[supervised] no warm state received, starting cold");
    }
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
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
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
    // Auto-export PLASTIC changes on clean shutdown
    if (process.env.GRO_PLASTIC) {
      try {
        const { exportChanges } = await import("./plastic/export.js");
        const { fileCount } = exportChanges();
        if (fileCount > 0) Logger.info(C.gray(`exported ${fileCount} PLASTIC change(s) to changes.patch`));
      } catch {}
    }
    Logger.info(spendMeter.formatSummary());
    process.exit(0);
  });
}

// Catch unhandled promise rejections (e.g. background summarization)
process.on("unhandledRejection", (reason: unknown) => {
  const err = asError(reason);
  Logger.error(C.red(`unhandled rejection: ${err.message}`));
  if (err.stack) Logger.error(C.red(err.stack));
});

const _mainError = (e: unknown) => {
  const err = asError(e);
  Logger.error("gro:", err.message);
  if (err.stack) Logger.error(err.stack);
  process.exit(1);
};

// --plastic CLI flag sets the env var before bootstrap check
if (process.argv.includes("--plastic")) {
  process.env.GRO_PLASTIC = "1";
}

if (process.env.GRO_PLASTIC && !process.env.GRO_PLASTIC_BOOTED) {
  // First load — divert to bootstrap which loads overlay/main.js
  import("./plastic/bootstrap.js").then(m => m.boot()).catch(e => {
    console.error("[PLASTIC] Bootstrap failed, falling back to stock:", e);
    main().catch(_mainError);
  });
} else if (!process.env.GRO_PLASTIC_BOOTED) {
  // Normal (non-PLASTIC) path — call main() directly
  main().catch(_mainError);
}
// When GRO_PLASTIC_BOOTED=1, bootstrap.ts will call mod.main() — don't auto-call here.
