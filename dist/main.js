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
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getKey, setKey, resolveKey } from "./keychain.js";
import { Logger, C } from "./logger.js";
import { spendMeter } from "./spend-meter.js";
import { makeStreamingOpenAiDriver } from "./drivers/streaming-openai.js";
import { makeAnthropicDriver } from "./drivers/anthropic.js";
import { SimpleMemory } from "./memory/simple-memory.js";
import { AdvancedMemory } from "./memory/advanced-memory.js";
import { VirtualMemory } from "./memory/virtual-memory.js";
import { FragmentationMemory } from "./memory/fragmentation-memory.js";
import { McpManager } from "./mcp/index.js";
import { newSessionId, findLatestSession, loadSession, ensureGroDir } from "./session.js";
import { groError, asError, isGroError, errorLogFields } from "./errors.js";
import { bashToolDefinition, executeBash } from "./tools/bash.js";
import { yieldToolDefinition, executeYield } from "./tools/yield.js";
import { agentpatchToolDefinition, executeAgentpatch, enableShowDiffs } from "./tools/agentpatch.js";
import { groVersionToolDefinition, executeGroVersion, getGroVersion } from "./tools/version.js";
import { memoryStatusToolDefinition, executeMemoryStatus } from "./tools/memory-status.js";
import { compactContextToolDefinition, executeCompactContext } from "./tools/compact-context.js";
import { createMarkerParser, extractMarkers } from "./stream-markers.js";
import { readToolDefinition, executeRead } from "./tools/read.js";
import { writeToolDefinition, executeWrite } from "./tools/write.js";
import { globToolDefinition, executeGlob } from "./tools/glob.js";
import { grepToolDefinition, executeGrep } from "./tools/grep.js";
import { ViolationTracker, SameToolLoopTracker } from "./violations.js";
import { thinkingTierModel as selectTierModel } from "./tier-loader.js";
const VERSION = getGroVersion();
// ---------------------------------------------------------------------------
// Graceful shutdown state — module-level so signal handlers can save sessions.
// ---------------------------------------------------------------------------
let _shutdownMemory = null;
let _shutdownSessionId = null;
let _shutdownSessionPersistence = false;
/** Auto-save interval: save session every N tool rounds in persistent mode */
const AUTO_SAVE_INTERVAL = 10;
/** Maximum backoff delay when tool failures loop */
const MAX_BACKOFF_MS = 30000; // 30 seconds
/** Sleep utility for exponential backoff */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// Wake notes: a runner-global file that is prepended to the system prompt on process start
// so agents reliably see dev workflow + memory pointers on wake.
const WAKE_NOTES_DEFAULT_PATH = join(process.env.HOME || "", ".claude", "WAKE.md");
// ---------------------------------------------------------------------------
// Boot Layers — system prompt assembly
// ---------------------------------------------------------------------------
const __filename_url = import.meta.url;
const __dirname_resolved = dirname(fileURLToPath(__filename_url));
/** Load Layer 1 runtime.md from the gro package (bundled). */
function loadRuntimeBoot() {
    // In dist/ after build: dist/boot/runtime.md
    // In src/ during dev: src/boot/runtime.md
    const candidates = [
        join(__dirname_resolved, "boot", "runtime.md"),
        join(__dirname_resolved, "..", "src", "boot", "runtime.md"),
    ];
    for (const p of candidates) {
        if (existsSync(p)) {
            return readFileSync(p, "utf-8").trim();
        }
    }
    Logger.warn("runtime.md not found — Layer 1 boot missing");
    return "";
}
function assembleSystemPrompt(layers) {
    const sections = [];
    // Layer 1: Runtime (always first, non-negotiable)
    if (layers.runtime) {
        sections.push(`<!-- LAYER 1: RUNTIME -->\n${layers.runtime}`);
    }
    // Layer 2: Extensions (additive)
    for (const ext of layers.extensions) {
        if (ext.trim()) {
            sections.push(`<!-- LAYER 2: EXTENSION -->\n${ext.trim()}`);
        }
    }
    // Layer 3: Role/Personality
    for (const role of layers.role) {
        if (role.trim()) {
            sections.push(`<!-- LAYER 3: ROLE -->\n${role.trim()}`);
        }
    }
    return sections.join("\n\n---\n\n");
}
/** Discover Layer 2 extension files from repo root and known locations. */
function discoverExtensions(mcpConfigPaths) {
    const extensions = [];
    // Check repo root for _base.md
    const repoBase = join(process.cwd(), "_base.md");
    if (existsSync(repoBase)) {
        try {
            extensions.push(readFileSync(repoBase, "utf-8").trim());
        }
        catch {
            Logger.warn(`Failed to read _base.md at ${repoBase}`);
        }
    }
    // Check for agentchat SKILL.md in common locations
    const skillCandidates = [
        join(process.cwd(), "SKILL.md"),
        join(process.cwd(), ".claude", "SKILL.md"),
    ];
    for (const p of skillCandidates) {
        if (existsSync(p)) {
            try {
                extensions.push(readFileSync(p, "utf-8").trim());
            }
            catch {
                Logger.warn(`Failed to read SKILL.md at ${p}`);
            }
            break; // only load the first found
        }
    }
    return extensions;
}
function loadMcpServers(mcpConfigPaths) {
    // If explicit --mcp-config paths given, use those
    if (mcpConfigPaths.length > 0) {
        const merged = {};
        for (const p of mcpConfigPaths) {
            try {
                let raw;
                if (p.startsWith("{")) {
                    raw = p; // inline JSON
                }
                else if (existsSync(p)) {
                    raw = readFileSync(p, "utf-8");
                }
                else {
                    Logger.warn(`MCP config not found: ${p}`);
                    continue;
                }
                const parsed = JSON.parse(raw);
                const servers = parsed.mcpServers || parsed;
                if (typeof servers === "object") {
                    Object.assign(merged, servers);
                }
            }
            catch (e) {
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
            }
            catch (e) {
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
function loadConfig() {
    const args = process.argv.slice(2);
    const flags = {};
    const positional = [];
    const mcpConfigPaths = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        // --- gro native flags ---
        if (arg === "--provider" || arg === "-P") {
            flags.provider = args[++i];
        }
        else if (arg === "--model" || arg === "-m") {
            flags.model = args[++i];
        }
        else if (arg === "--base-url") {
            flags.baseUrl = args[++i];
        }
        else if (arg === "--system-prompt") {
            flags.systemPrompt = args[++i];
        }
        else if (arg === "--system-prompt-file") {
            flags.systemPromptFile = args[++i];
        }
        else if (arg === "--append-system-prompt") {
            flags.appendSystemPrompt = args[++i];
        }
        else if (arg === "--append-system-prompt-file") {
            flags.appendSystemPromptFile = args[++i];
        }
        else if (arg === "--wake-notes") {
            flags.wakeNotes = args[++i];
        }
        else if (arg === "--no-wake-notes") {
            flags.noWakeNotes = "true";
        }
        else if (arg === "--context-tokens") {
            flags.contextTokens = args[++i];
        }
        else if (arg === "--max-tokens") {
            flags.maxTokens = args[++i];
        }
        else if (arg === "--max-tool-rounds" || arg === "--max-turns") {
            flags.maxToolRounds = args[++i];
        }
        else if (arg === "--bash") {
            flags.bash = "true";
        }
        else if (arg === "--persistent" || arg === "--keep-alive") {
            flags.persistent = "true";
        }
        else if (arg === "--persistent-policy") {
            flags.persistentPolicy = args[++i];
        }
        else if (arg === "--max-idle-nudges") {
            flags.maxIdleNudges = args[++i];
        }
        else if (arg === "--max-retries") {
            process.env.GRO_MAX_RETRIES = args[++i];
        }
        else if (arg === "--retry-base-ms") {
            process.env.GRO_RETRY_BASE_MS = args[++i];
        }
        else if (arg === "--max-thinking-tokens") {
            flags.maxThinkingTokens = args[++i];
        } // accepted, not used yet
        else if (arg === "--max-budget-usd") {
            flags.maxBudgetUsd = args[++i];
        } // accepted, not used yet
        else if (arg === "--summarizer-model") {
            flags.summarizerModel = args[++i];
        }
        else if (arg === "--output-format") {
            flags.outputFormat = args[++i];
        }
        else if (arg === "--batch-summarization") {
            flags.batchSummarization = "true";
        }
        else if (arg === "--mcp-config") {
            mcpConfigPaths.push(args[++i]);
        }
        else if (arg === "-i" || arg === "--interactive") {
            flags.interactive = "true";
        }
        else if (arg === "-p" || arg === "--print") {
            flags.print = "true";
        }
        else if (arg === "-c" || arg === "--continue") {
            flags.continue = "true";
        }
        else if (arg === "-r" || arg === "--resume") {
            // --resume can have optional value
            if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                flags.resume = args[++i];
            }
            else {
                flags.resume = "latest";
            }
        }
        else if (arg === "--no-mcp") {
            flags.noMcp = "true";
        }
        else if (arg === "--no-session-persistence") {
            flags.noSessionPersistence = "true";
        }
        else if (arg === "--verbose") {
            flags.verbose = "true";
        }
        else if (arg === "--show-diffs") {
            flags.showDiffs = "true";
        }
        else if (arg === "--name") {
            flags.name = args[++i];
        }
        else if (arg === "-d" || arg === "--debug" || arg === "-d2e" || arg === "--debug-to-stderr") {
            flags.verbose = "true";
            // --debug may have optional filter value
            if (arg === "-d" || arg === "--debug") {
                if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                    i++;
                } // consume filter
            }
        }
        else if (arg === "--set-key") {
            flags.setKey = args[++i];
        }
        else if (arg === "-V" || arg === "--version") {
            console.log(`gro ${VERSION}`);
            process.exit(0);
        }
        else if (arg === "-h" || arg === "--help") {
            usage();
            process.exit(0);
        }
        // --- graceful degradation for unsupported claude flags ---
        else if (UNSUPPORTED_VALUE_FLAGS.has(arg)) {
            Logger.warn(`${arg} not yet supported, ignoring`);
            if (i + 1 < args.length && !args[i + 1].startsWith("-"))
                i++; // skip value
        }
        else if (UNSUPPORTED_BOOL_FLAGS.has(arg)) {
            Logger.warn(`${arg} not yet supported, ignoring`);
        }
        else if (!arg.startsWith("-")) {
            positional.push(arg);
        }
        else {
            Logger.warn(`Unknown flag: ${arg}`);
        }
    }
    const provider = inferProvider(flags.provider || process.env.AGENT_PROVIDER, flags.model || process.env.AGENT_MODEL);
    const apiKey = resolveApiKey(provider);
    const noMcp = flags.noMcp === "true";
    const mcpServers = noMcp ? {} : loadMcpServers(mcpConfigPaths);
    // --- Layered system prompt assembly ---
    // Layer 1: Runtime boot (gro internal, always loaded)
    const runtime = loadRuntimeBoot();
    // Layer 2: Extensions (_base.md, SKILL.md, --append-system-prompt-file, --append-system-prompt)
    const extensions = discoverExtensions(mcpConfigPaths);
    if (flags.appendSystemPromptFile) {
        try {
            const extra = readFileSync(flags.appendSystemPromptFile, "utf-8").trim();
            if (extra)
                extensions.push(extra);
        }
        catch (e) {
            const ge = groError("config_error", `Failed to read append system prompt file: ${asError(e).message}`, { cause: e });
            Logger.error(ge.message, errorLogFields(ge));
            process.exit(1);
        }
    }
    if (flags.appendSystemPrompt) {
        extensions.push(flags.appendSystemPrompt);
    }
    // Layer 3: Role/Personality (WAKE.md, --system-prompt, --system-prompt-file)
    const role = [];
    // WAKE.md (runner-global) — loaded once, not twice
    const wakeNotesPath = flags.wakeNotes || WAKE_NOTES_DEFAULT_PATH;
    const wakeNotesEnabled = flags.noWakeNotes !== "true";
    if (wakeNotesEnabled && wakeNotesPath && existsSync(wakeNotesPath)) {
        try {
            const wake = readFileSync(wakeNotesPath, "utf-8").trim();
            if (wake)
                role.push(wake);
        }
        catch (e) {
            Logger.warn(`Failed to read wake notes at ${wakeNotesPath}: ${asError(e).message}`);
        }
    }
    // --system-prompt-file overrides --system-prompt (not additive)
    if (flags.systemPromptFile) {
        try {
            role.push(readFileSync(flags.systemPromptFile, "utf-8").trim());
        }
        catch (e) {
            const ge = groError("config_error", `Failed to read system prompt file: ${asError(e).message}`, { cause: e });
            Logger.error(ge.message, errorLogFields(ge));
            process.exit(1);
        }
    }
    else if (flags.systemPrompt) {
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
        contextTokens: parseInt(flags.contextTokens || "8192"),
        maxTokens: parseInt(flags.maxTokens || "16384"),
        interactive: interactiveMode,
        print: printMode,
        maxToolRounds: parseInt(flags.maxToolRounds || "10"),
        persistent: flags.persistent === "true",
        persistentPolicy: flags.persistentPolicy || "work-first",
        maxIdleNudges: parseInt(flags.maxIdleNudges || "10"),
        bash: flags.bash === "true",
        summarizerModel: flags.summarizerModel || process.env.AGENT_SUMMARIZER_MODEL || null,
        outputFormat: flags.outputFormat || "text",
        continueSession: flags.continue === "true",
        resumeSession: flags.resume || null,
        sessionPersistence: flags.noSessionPersistence !== "true",
        verbose: flags.verbose === "true",
        name: flags.name || null,
        batchSummarization: flags.batchSummarization === "true",
        showDiffs: flags.showDiffs === "true",
        mcpServers,
    };
}
function inferProvider(explicit, model) {
    if (explicit) {
        const known = ["openai", "anthropic", "groq", "google", "xai", "local"];
        if (known.includes(explicit))
            return explicit;
        Logger.warn(`Unknown provider "${explicit}", defaulting to anthropic`);
        return "anthropic";
    }
    if (model) {
        if (/^(gpt-|o1-|o3|o4-|chatgpt-)/.test(model))
            return "openai";
        if (/^(claude-|sonnet|haiku|opus)/.test(model))
            return "anthropic";
        if (/^gemini-/.test(model))
            return "google";
        if (/^grok-/.test(model))
            return "xai";
        // Groq-hosted models
        if (/^(llama-3|gemma2-|gemma-|mixtral-|whisper-)/.test(model))
            return "groq";
        if (/^(gemma|llama|mistral|phi|qwen|deepseek)/.test(model))
            return "local";
    }
    return "anthropic";
}
function defaultModel(provider) {
    switch (provider) {
        case "openai": return "gpt-5.2-codex";
        case "anthropic": return "claude-sonnet-4-5";
        case "groq": return "llama-3.3-70b-versatile";
        case "google": return "gemini-2.5-flash";
        case "xai": return "grok-4.1-fast";
        case "local": return "llama3";
        default: return "claude-sonnet-4-5";
    }
}
function defaultBaseUrl(provider) {
    switch (provider) {
        case "openai": return process.env.OPENAI_BASE_URL || "https://api.openai.com";
        case "groq": return process.env.GROQ_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.groq.com/openai";
        case "google": return process.env.GOOGLE_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";
        case "xai": return process.env.XAI_BASE_URL || "https://api.x.ai/v1";
        case "local": return "http://127.0.0.1:11434";
        default: return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    }
}
function resolveApiKey(provider) {
    return resolveKey(provider);
}
function usage() {
    console.log(`gro ${VERSION} — provider-agnostic LLM runtime

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
  --wake-notes           path to wake notes file (default: ~/.claude/WAKE.md)
  --no-wake-notes        disable auto-prepending wake notes
  --context-tokens       context window budget (default: 8192)
  --max-tokens           max response tokens per turn (default: 16384)
  --max-turns            max agentic rounds per turn (default: 10)
  --max-tool-rounds      alias for --max-turns
  --bash                 enable built-in bash tool for shell command execution
  --persistent           nudge model to keep using tools instead of exiting
  --persistent-policy    work-first | listen-only (default: work-first)
  --max-idle-nudges      max consecutive nudges before giving up (default: 10)
  --max-retries          max API retry attempts on 429/5xx (default: 3, env: GRO_MAX_RETRIES)
  --retry-base-ms        base backoff delay in ms (default: 1000, env: GRO_RETRY_BASE_MS)
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
// Key management
// ---------------------------------------------------------------------------
async function runSetKey(provider) {
    const known = ["anthropic", "openai", "groq", "google", "xai"];
    if (!known.includes(provider)) {
        throw new Error(`Unknown provider "${provider}". Valid: ${known.join(", ")}`);
    }
    const current = getKey(provider);
    if (current) {
        process.stdout.write(`Keychain already has a key for ${provider} (${current.slice(0, 8)}…). Overwrite? [y/N] `);
        const answer = await readLine();
        if (!answer.toLowerCase().startsWith("y")) {
            console.log("Aborted.");
            return;
        }
    }
    process.stdout.write(`Enter API key for ${provider}: `);
    const key = await readLineHidden();
    process.stdout.write("\n");
    if (!key.trim()) {
        throw new Error("No key entered — aborted.");
    }
    setKey(provider, key.trim());
    console.log(`✓ Key stored in Keychain for provider "${provider}"`);
}
function readLine() {
    return new Promise(resolve => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.once("line", line => { rl.close(); resolve(line); });
    });
}
function readLineHidden() {
    return new Promise(resolve => {
        // Disable echo by switching stdin to raw mode
        if (process.stdin.isTTY)
            process.stdin.setRawMode(true);
        process.stdin.resume();
        let buf = "";
        const onData = (chunk) => {
            const s = chunk.toString("utf8");
            for (const ch of s) {
                if (ch === "\r" || ch === "\n") {
                    process.stdin.removeListener("data", onData);
                    if (process.stdin.isTTY)
                        process.stdin.setRawMode(false);
                    process.stdin.pause();
                    resolve(buf);
                    return;
                }
                if (ch === "\x03") {
                    process.exit(1);
                } // Ctrl-C
                if (ch === "\x7f" || ch === "\b") {
                    buf = buf.slice(0, -1);
                } // backspace
                else {
                    buf += ch;
                }
            }
        };
        process.stdin.on("data", onData);
    });
}
// ---------------------------------------------------------------------------
// Driver factory
// ---------------------------------------------------------------------------
function createDriverForModel(provider, model, apiKey, baseUrl, maxTokens) {
    switch (provider) {
        case "anthropic":
            if (!apiKey && baseUrl === "https://api.anthropic.com") {
                Logger.error(`gro: no API key for anthropic — run: gro --set-key anthropic`);
                process.exit(1);
            }
            return makeAnthropicDriver({ apiKey: apiKey || "proxy-managed", model, baseUrl, maxTokens });
        case "openai":
            if (!apiKey && baseUrl === "https://api.openai.com") {
                Logger.error(`gro: no API key for openai — run: gro --set-key openai`);
                process.exit(1);
            }
            return makeStreamingOpenAiDriver({ baseUrl, model, apiKey: apiKey || undefined });
        case "groq":
            if (!apiKey) {
                Logger.error(`gro: no API key for groq — run: gro --set-key groq`);
                process.exit(1);
            }
            return makeStreamingOpenAiDriver({ baseUrl, model, apiKey });
        case "google":
            // Google Gemini via OpenAI-compatible endpoint
            if (!apiKey) {
                Logger.error(`gro: no API key for google — set GOOGLE_API_KEY or run: gro --set-key google`);
                process.exit(1);
            }
            return makeStreamingOpenAiDriver({ baseUrl, model, apiKey });
        case "xai":
            // xAI Grok via OpenAI-compatible endpoint
            if (!apiKey) {
                Logger.error(`gro: no API key for xai — set XAI_API_KEY or run: gro --set-key xai`);
                process.exit(1);
            }
            return makeStreamingOpenAiDriver({ baseUrl, model, apiKey });
        case "local":
            return makeStreamingOpenAiDriver({ baseUrl, model });
        default:
            Logger.error(`gro: unknown provider "${provider}"`);
            process.exit(1);
    }
    throw new Error("unreachable");
}
function createDriver(cfg) {
    return createDriverForModel(cfg.provider, cfg.model, cfg.apiKey, cfg.baseUrl, cfg.maxTokens);
}
// ---------------------------------------------------------------------------
// Memory factory
// ---------------------------------------------------------------------------
async function createMemory(cfg, driver, requestedMode) {
    const memoryMode = requestedMode ?? process.env.GRO_MEMORY ?? "virtual";
    // Opt-out: SimpleMemory only if explicitly requested
    if (memoryMode === "simple") {
        Logger.info(`${C.cyan("MemoryMode=Simple")} ${C.gray("(GRO_MEMORY=simple)")}`);
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
    let summarizerDriver;
    let effectiveSummarizerModel = summarizerModel;
    if (summarizerApiKey) {
        summarizerDriver = createDriverForModel(summarizerProvider, summarizerModel, summarizerApiKey, defaultBaseUrl(summarizerProvider));
        Logger.info(`Summarizer: ${summarizerProvider}/${summarizerModel}`);
    }
    else {
        // No key for the desired summarizer provider — fall back to main driver.
        // Use the main model name so the driver doesn't reject an incompatible model name.
        effectiveSummarizerModel = cfg.model;
        Logger.info(`Summarizer: no ${summarizerProvider} key — using main driver (${cfg.provider}/${cfg.model})`);
    }
    // Fragmentation memory (stochastic sampling)
    if (memoryMode === "fragmentation") {
        Logger.info(`${C.cyan("MemoryMode=Fragmentation")} ${C.gray(`workingMemory=${cfg.contextTokens} tokens`)}`);
        const { FragmentationMemory } = await import("./memory/fragmentation-memory.js");
        const fm = new FragmentationMemory({
            systemPrompt: cfg.systemPrompt || undefined,
            workingMemoryTokens: cfg.contextTokens,
        });
        fm.setModel(cfg.model);
        return fm;
    }
    // HNSW memory (semantic similarity retrieval)
    if (memoryMode === "hnsw") {
        Logger.info(`${C.cyan("MemoryMode=HNSW")} ${C.gray(`workingMemory=${cfg.contextTokens} tokens, semantic retrieval`)}`);
        const { HNSWMemory } = await import("./memory/hnsw-memory.js");
        const hm = new HNSWMemory({
            driver: summarizerDriver ?? driver,
            summarizerModel: effectiveSummarizerModel,
            systemPrompt: cfg.systemPrompt || undefined,
            workingMemoryTokens: cfg.contextTokens,
        });
        hm.setModel(cfg.model);
        return hm;
    }
    Logger.info(`${C.cyan("MemoryMode=Virtual")} ${C.gray(`(default) workingMemory=${cfg.contextTokens} tokens`)}`);
    const vm = new VirtualMemory({
        driver: summarizerDriver ?? driver,
        summarizerModel: effectiveSummarizerModel,
        systemPrompt: cfg.systemPrompt || undefined,
        workingMemoryTokens: cfg.contextTokens,
        enableBatchSummarization: cfg.batchSummarization,
    });
    vm.setModel(cfg.model);
    return vm;
}
// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------
function formatOutput(text, format) {
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
const MODEL_ALIASES = {
    // Anthropic
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-4-5",
    "opus": "claude-opus-4-6",
    // OpenAI — GPT-5 family
    "gpt5-nano": "gpt-5-nano",
    "gpt5-mini": "gpt-5-mini",
    "gpt5": "gpt-5",
    "gpt5.2": "gpt-5.2",
    "gpt5.2-codex": "gpt-5.2-codex",
    "gpt5.2-pro": "gpt-5.2-pro",
    // OpenAI — GPT-4.1 family
    "gpt4.1-nano": "gpt-4.1-nano",
    "gpt4.1-mini": "gpt-4.1-mini",
    "gpt4.1": "gpt-4.1",
    // OpenAI — reasoning
    "o3": "o3",
    "o4-mini": "o4-mini",
    // OpenAI — legacy
    "gpt4o": "gpt-4o",
    "gpt4o-mini": "gpt-4o-mini",
    "gpt4": "gpt-4o",
    // Google
    "flash-lite": "gemini-2.5-flash-lite",
    "flash": "gemini-2.5-flash",
    "gemini-pro": "gemini-2.5-pro",
    "gemini3-flash": "gemini-3-flash",
    "gemini3-pro": "gemini-3-pro",
    // xAI
    "grok-fast": "grok-4.1-fast",
    "grok": "grok-4",
    // Local
    "llama3": "llama3",
    "qwen": "qwen",
    "deepseek": "deepseek",
};
function resolveModelAlias(alias) {
    const lower = alias.trim().toLowerCase();
    return MODEL_ALIASES[lower] ?? alias;
}
/** Emotion dimensions routed to visage as state-vector events via @@dim(value)@@ markers. */
const EMOTION_DIMENSIONS = new Set([
    "joy", "sadness", "anger", "fear", "surprise", "disgust",
    "confidence", "uncertainty", "excitement", "calm", "urgency", "reverence",
]);
/** Emit a state-vector event for visage/dashboard consumption. */
function emitStateVector(state, outputFormat) {
    if (outputFormat === "stream-json") {
        process.stdout.write(JSON.stringify({ type: "state-vector", state }) + "\n");
    }
    else {
        process.stderr.write(`STATE_VECTOR: ${JSON.stringify(state)}\n`);
    }
}
/**
 * Execute a single turn: call the model, handle tool calls, repeat until
 * the model produces a final text response or we hit maxRounds.
 */
async function executeTurn(driver, memory, mcp, cfg, sessionId, violations, sameToolLoop) {
    const tools = mcp.getToolDefinitions();
    tools.push(agentpatchToolDefinition());
    if (cfg.bash)
        tools.push(bashToolDefinition());
    tools.push(groVersionToolDefinition());
    if (cfg.persistent)
        tools.push(yieldToolDefinition);
    tools.push(memoryStatusToolDefinition());
    tools.push(compactContextToolDefinition());
    tools.push(readToolDefinition());
    tools.push(writeToolDefinition());
    tools.push(globToolDefinition());
    tools.push(grepToolDefinition());
    let finalText = "";
    let turnTokensIn = 0;
    let turnTokensOut = 0;
    const rawOnToken = cfg.outputFormat === "stream-json"
        ? (t) => process.stdout.write(JSON.stringify({ type: "token", token: t }) + "\n")
        : (t) => process.stdout.write(t);
    const THINKING_MEAN = 0.5; // cruising altitude — mid-tier, not idle
    const THINKING_REGRESSION_RATE = 0.4; // how fast we pull toward mean per idle round
    // Mutable model reference — stream markers can switch this mid-turn
    let activeModel = cfg.model;
    // Thinking level: 0.0 = idle (haiku), 1.0 = full (opus + max budget).
    // Decays toward THINKING_MEAN each round without @@thinking()@@ — agents coast at mid-tier.
    // Emit @@thinking(0.8)@@ to go into the phone booth; let it decay to come back out.
    let activeThinkingBudget = 0.5;
    let modelExplicitlySet = false; // true after @@model-change()@@, suppresses tier auto-select
    /** Select model tier based on thinking budget and provider.
     * Loads tier ladders from providers/*.json config files.
     */
    function thinkingTierModel(budget) {
        const provider = inferProvider(cfg.provider, cfg.model);
        return selectTierModel(budget, provider, cfg.model, MODEL_ALIASES);
    }
    let brokeCleanly = false;
    let idleNudges = 0;
    let consecutiveFailedRounds = 0;
    let pendingNarration = ""; // Buffer for plain text emitted between tool calls
    for (let round = 0; round < cfg.maxToolRounds; round++) {
        let roundHadFailure = false;
        let roundImportance = undefined;
        let thinkingSeenThisTurn = false;
        // Memory hot-swap handler
        const swapMemory = async (targetType) => {
            const validTypes = ["simple", "advanced", "virtual", "fragmentation", "hnsw"];
            if (!validTypes.includes(targetType)) {
                Logger.error(`Stream marker: memory('${targetType}') REJECTED — valid types: ${validTypes.join(", ")}`);
                return;
            }
            Logger.info(`Stream marker: memory('${targetType}') — swapping memory implementation`);
            // Extract current messages to transfer to new memory
            const currentMessages = memory.messages();
            // Create new memory instance based on type
            let newMemory;
            if (targetType === "simple") {
                newMemory = new SimpleMemory(cfg.systemPrompt || undefined);
                newMemory.setMeta(cfg.provider, cfg.model);
            }
            else if (targetType === "advanced") {
                newMemory = new AdvancedMemory({ driver, model: activeModel, systemPrompt: cfg.systemPrompt || undefined });
            }
            else if (targetType === "fragmentation") {
                newMemory = new FragmentationMemory({ systemPrompt: cfg.systemPrompt || undefined });
            }
            else if (targetType === "hnsw") {
                const { HNSWMemory } = await import("./memory/hnsw-memory.js");
                newMemory = new HNSWMemory({ systemPrompt: cfg.systemPrompt || undefined });
            }
            else {
                newMemory = await createMemory(cfg, driver); // VirtualMemory
            }
            // Transfer messages to new memory
            for (const msg of currentMessages) {
                newMemory.add(msg);
            }
            memory = newMemory;
        };
        // Shared marker handler — used by both streaming parser and tool-arg scanner
        const handleMarker = (marker) => {
            if (marker.name === "model-change") {
                const newModel = resolveModelAlias(marker.arg);
                const newProvider = inferProvider(undefined, newModel);
                if (newProvider !== cfg.provider) {
                    Logger.error(`Stream marker: model-change '${marker.arg}' REJECTED — cross-provider swap (${cfg.provider} → ${newProvider}) is not supported. Stay on ${cfg.provider} models.`);
                }
                else {
                    Logger.info(`Stream marker: model-change '${marker.arg}' → ${newModel}`);
                    activeModel = newModel;
                    cfg.model = newModel; // persist across turns
                    memory.setModel(newModel); // persist in session metadata on save
                    modelExplicitlySet = true; // suppress thinking-tier auto-select
                }
            }
            else if (marker.name === "ref" && marker.arg) {
                // VirtualMemory page ref — load a page into context for next turn
                if ("ref" in memory && typeof memory.ref === "function") {
                    memory.ref(marker.arg);
                    Logger.info(`Stream marker: ref('${marker.arg}') — page will load next turn`);
                }
            }
            else if (marker.name === "unref" && marker.arg) {
                // VirtualMemory page unref — release a page from context
                if ("unref" in memory && typeof memory.unref === "function") {
                    memory.unref(marker.arg);
                    Logger.info(`Stream marker: unref('${marker.arg}') — page released`);
                }
            }
            else if (marker.name === "importance" && marker.arg) {
                // Importance weighting — tag current message for paging priority
                const val = parseFloat(marker.arg);
                if (!isNaN(val) && val >= 0 && val <= 1) {
                    roundImportance = val;
                    Logger.info(`Stream marker: importance(${val})`);
                }
                else {
                    Logger.warn(`Stream marker: importance('${marker.arg}') — invalid value, must be 0.0–1.0`);
                }
            }
            else if (marker.name === "thinking") {
                // Master lever: controls model tier, extended thinking budget, and summarizer.
                // 0.0–0.24 → haiku, 0.25–0.64 → sonnet, 0.65–1.0 → opus.
                // Decays toward THINKING_MEAN each idle round — emit each round to maintain level.
                const level = parseFloat(marker.arg !== "" ? marker.arg : "0.5");
                if (!isNaN(level) && level >= 0 && level <= 1) {
                    activeThinkingBudget = level;
                    thinkingSeenThisTurn = true;
                    Logger.info(`Stream marker: thinking(${level}) → budget=${level}`);
                    emitStateVector({ thinking: level }, cfg.outputFormat);
                }
                else {
                    Logger.warn(`Stream marker: thinking('${marker.arg}') — invalid value, must be 0.0–1.0`);
                }
            }
            else if (marker.name === "think") {
                // Shorthand: bump thinking intensity by 0.3, capped at 1.0
                activeThinkingBudget = Math.min(1.0, activeThinkingBudget + 0.3);
                thinkingSeenThisTurn = true;
                Logger.info(`Stream marker: think → budget=${activeThinkingBudget.toFixed(2)}`);
                emitStateVector({ thinking: activeThinkingBudget }, cfg.outputFormat);
            }
            else if (marker.name === "relax") {
                // Shorthand: reduce thinking intensity by 0.3, floored at 0.0
                activeThinkingBudget = Math.max(0.0, activeThinkingBudget - 0.3);
                thinkingSeenThisTurn = true;
                Logger.info(`Stream marker: relax → budget=${activeThinkingBudget.toFixed(2)}`);
                emitStateVector({ thinking: activeThinkingBudget }, cfg.outputFormat);
            }
            else if (EMOTION_DIMENSIONS.has(marker.name)) {
                // Function-form emotion marker @@joy(0.6)@@ — route to visage as state vector.
                const val = marker.arg !== "" ? parseFloat(marker.arg) : 0.5;
                if (!isNaN(val) && val >= 0 && val <= 1) {
                    emitStateVector({ [marker.name]: val }, cfg.outputFormat);
                    Logger.info(`Stream marker: ${marker.name}(${val}) → visage`);
                }
            }
            else if (marker.name === "memory" && marker.arg) {
            }
            else if (marker.name === "memory-tune" && marker.arg) {
                // Hot-tune VirtualMemory: 🧠
                // Parse key:value pairs separated by commas
                const tuneParams = {};
                for (const pair of marker.arg.split(",")) {
                    const [key, val] = pair.trim().split(":");
                    if (key && val) {
                        let numVal = parseInt(val);
                        if (val.toLowerCase().endsWith("k")) {
                            numVal = parseInt(val.slice(0, -1)) * 1000;
                        }
                        else if (val.toLowerCase().endsWith("m")) {
                            numVal = parseInt(val.slice(0, -1)) * 1000 * 1000;
                        }
                        if (!isNaN(numVal) && numVal > 0) {
                            tuneParams[key.toLowerCase()] = numVal;
                        }
                    }
                }
                // Apply to memory controller if it supports hot-tuning
                if (Object.keys(tuneParams).length > 0 && "tune" in memory && typeof memory.tune === "function") {
                    memory.tune(tuneParams);
                    Logger.info(`Stream marker: memory-tune(${marker.arg})`);
                }
                else {
                    Logger.warn(`Stream marker: memory-tune — memory controller doesn't support hot-tuning`);
                }
            }
        };
        // Select model tier based on current thinking budget (unless agent pinned a model explicitly)
        if (!modelExplicitlySet) {
            const tierModel = thinkingTierModel(activeThinkingBudget);
            if (tierModel !== activeModel) {
                Logger.info(`Thinking budget ${activeThinkingBudget.toFixed(2)} → model tier: ${tierModel}`);
                activeModel = tierModel;
            }
        }
        // Sync thinking budget to memory — scales compaction aggressiveness
        memory.setThinkingBudget(activeThinkingBudget);
        // Create a fresh marker parser per round so partial state doesn't leak
        const markerParser = createMarkerParser({
            onToken: rawOnToken,
            onMarker: handleMarker,
        });
        const output = await driver.chat(memory.messages(), {
            model: activeModel,
            tools: tools.length > 0 ? tools : undefined,
            onToken: markerParser.onToken,
            thinkingBudget: activeThinkingBudget,
        });
        // Flush any remaining buffered tokens from the marker parser
        markerParser.flush();
        // Decay thinking level toward THINKING_MEAN if not refreshed this round.
        // Agents coast at mid-tier when idle — emit @@thinking(X)@@ each round to maintain level.
        if (!thinkingSeenThisTurn) {
            // Regress toward mean — agents coast at cruising altitude, not idle.
            // From opus (0.8) → settles at ~0.5 (mid-tier) in ~4 rounds.
            // From haiku (0.1) → pulls UP to ~0.5 (mid-tier) in ~3 rounds.
            activeThinkingBudget += (THINKING_MEAN - activeThinkingBudget) * THINKING_REGRESSION_RATE;
        }
        // Track token usage for niki budget enforcement and spend meter
        if (output.usage) {
            turnTokensIn += output.usage.inputTokens;
            turnTokensOut += output.usage.outputTokens;
            // Log cumulative usage to stderr — niki parses these patterns for budget enforcement
            process.stderr.write(`"input_tokens": ${turnTokensIn}, "output_tokens": ${turnTokensOut}\n`);
            spendMeter.setModel(activeModel);
            spendMeter.record(output.usage.inputTokens, output.usage.outputTokens);
            Logger.info(spendMeter.format());
        }
        // Accumulate clean text (markers stripped) for the return value
        const cleanText = markerParser.getCleanText();
        if (cleanText)
            finalText += cleanText;
        const assistantMsg = { role: "assistant", from: "Assistant", content: cleanText || "" };
        if (roundImportance !== undefined) {
            assistantMsg.importance = roundImportance;
        }
        if (output.toolCalls.length > 0) {
            assistantMsg.tool_calls = output.toolCalls;
        }
        await memory.add(assistantMsg);
        // No tool calls — either we're done, or we need to nudge the model
        if (output.toolCalls.length === 0) {
            if (!cfg.persistent || tools.length === 0) {
                brokeCleanly = true;
                break;
            }
            const narration = (cleanText || "").trim();
            // Empty response in persistent mode = agent has nothing to say and is waiting.
            // Skip the nudge round trip and directly execute agentchat_listen on its behalf.
            // Reuse the channels from the most recent agentchat_listen call in memory so
            // we don't have to guess — fall back to #general if none found.
            const hasListenTool = tools.some(t => t.function?.name === "agentchat_listen");
            if (!narration && hasListenTool) {
                Logger.debug("Empty response in persistent mode — auto-calling agentchat_listen");
                idleNudges = 0; // not really idle, just waiting
                let listenChannels = [];
                const recentMsgs = memory.messages();
                for (let mi = recentMsgs.length - 1; mi >= 0; mi--) {
                    const tc = recentMsgs[mi].tool_calls;
                    if (Array.isArray(tc)) {
                        for (const c of tc) {
                            if (c.function?.name === "agentchat_listen") {
                                try {
                                    listenChannels = JSON.parse(c.function.arguments).channels ?? [];
                                }
                                catch { /* ignore */ }
                                break;
                            }
                        }
                    }
                    if (listenChannels.length > 0)
                        break;
                }
                if (listenChannels.length === 0)
                    listenChannels = ["#general"];
                const listenResult = await mcp.callTool("agentchat_listen", { channels: listenChannels }).catch(e => `Error: ${asError(e).message}`);
                await memory.add({
                    role: "tool",
                    from: "agentchat_listen",
                    content: listenResult,
                    tool_call_id: `auto_listen_${round}`,
                    name: "agentchat_listen",
                });
                continue;
            }
            // Persistent mode: buffer plain text narration instead of hard violation.
            // The narration will be prepended to the next agentchat_send so nothing
            // is lost, but we avoid expensive violation + nudge cycles.
            if (narration) {
                pendingNarration += (pendingNarration ? "\n" : "") + narration;
                Logger.debug(`Buffered narration (${narration.length} chars), will attach to next send`);
            }
            // Still count for budgeting — but softer than a full violation.
            // Only fire a real violation after 3+ consecutive narration-only rounds.
            idleNudges++;
            if (idleNudges >= 3 && violations) {
                await violations.inject(memory, "plain_text");
            }
            if (idleNudges > cfg.maxIdleNudges) {
                Logger.debug(`Persistent mode: ${idleNudges} consecutive idle responses — giving up`);
                brokeCleanly = true;
                break;
            }
            // Nudge based on policy
            const nudgeContent = cfg.persistentPolicy === "work-first"
                ? `[SYSTEM] Persistent mode: you must keep making forward progress.
Loop:
1) Check messages quickly (agentchat_listen with short timeout)
2) Do one work slice (bash/file tools/git)
3) Repeat.
Do not get stuck calling listen repeatedly.`
                : "[SYSTEM] Call agentchat_listen.";
            await memory.add({
                role: "user",
                from: "System",
                content: nudgeContent,
            });
        }
        // Model used tools — reset idle nudge counter and clear narration buffer
        idleNudges = 0;
        if (pendingNarration) {
            // Tool calls happened but no agentchat_send to flush into — discard silently
            Logger.debug(`Discarding ${pendingNarration.length} chars of orphaned narration (no agentchat_send this round)`);
            pendingNarration = "";
        }
        // Process tool calls
        for (const tc of output.toolCalls) {
            const fnName = tc.function.name;
            let fnArgs;
            try {
                fnArgs = JSON.parse(tc.function.arguments);
            }
            catch (e) {
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
            // Flush buffered narration into agentchat_send messages.
            // This captures plain text the model emitted between tool calls
            // and surfaces it in chat instead of losing it to violations.
            if (fnName === "agentchat_send" && pendingNarration && typeof fnArgs.message === "string") {
                const msg = fnArgs.message.trim();
                // Prepend narration only if the send has actual content (skip empty sends)
                if (msg) {
                    fnArgs.message = `[narration] ${pendingNarration}\n\n${msg}`;
                }
                else {
                    fnArgs.message = pendingNarration;
                }
                Logger.debug(`Flushed ${pendingNarration.length} chars of buffered narration into agentchat_send`);
                pendingNarration = "";
            }
            // Format tool call for readability
            let toolCallDisplay;
            if (fnName === "shell" && fnArgs.command) {
                toolCallDisplay = `${fnName}(${fnArgs.command})`;
            }
            else {
                // For other tools, show args in key=value format
                const argPairs = Object.entries(fnArgs)
                    .map(([k, v]) => {
                    const valStr = typeof v === "string" ? v : JSON.stringify(v);
                    const truncated = valStr.length > 60 ? valStr.slice(0, 60) + "..." : valStr;
                    return `${k}=${truncated}`;
                })
                    .join(", ");
                toolCallDisplay = argPairs ? `${fnName}(${argPairs})` : `${fnName}()`;
            }
            Logger.info(`${C.magenta("[Tool call]")} ${C.bold(fnName)}${toolCallDisplay.slice(fnName.length)}`);
            let result;
            try {
                if (fnName === "apply_patch") {
                    result = executeAgentpatch(fnArgs);
                }
                else if (fnName === "shell" && cfg.bash) {
                    result = executeBash(fnArgs);
                }
                else if (fnName === "yield" && cfg.persistent) {
                    result = await executeYield(fnArgs);
                }
                else if (fnName === "gro_version") {
                    const memoryMode = process.env.GRO_MEMORY === "simple" ? "simple" : "virtual";
                    result = executeGroVersion({ provider: cfg.provider, model: cfg.model, persistent: cfg.persistent, memoryMode, thinkingBudget: activeThinkingBudget, activeModel });
                }
                else if (fnName === "memory_status") {
                    result = executeMemoryStatus(fnArgs, memory);
                }
                else if (fnName === "compact_context") {
                    result = await executeCompactContext(fnArgs, memory);
                }
                else if (fnName === "Read") {
                    result = executeRead(fnArgs);
                }
                else if (fnName === "Write") {
                    result = executeWrite(fnArgs);
                }
                else if (fnName === "Glob") {
                    result = executeGlob(fnArgs);
                }
                else if (fnName === "Grep") {
                    result = executeGrep(fnArgs);
                }
                else {
                    result = await mcp.callTool(fnName, fnArgs);
                }
            }
            catch (e) {
                roundHadFailure = true;
                const raw = asError(e);
                const ge = groError("tool_error", `Tool "${fnName}" failed: ${raw.message}`, {
                    retryable: false,
                    cause: e,
                });
                Logger.error("Tool execution error:", errorLogFields(ge));
                if (raw.stack)
                    Logger.error(raw.stack);
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
        }
        // Check for same-tool loop (consecutive identical tool calls)
        if (sameToolLoop) {
            const toolNames = output.toolCalls.map(tc => tc.function.name);
            if (sameToolLoop.check(toolNames)) {
                await memory.add({
                    role: "user",
                    from: "System",
                    content: `[SYSTEM] You have called ${toolNames[0]} ${sameToolLoop['threshold']} times consecutively. This is a same-tool loop. Do one work slice (bash/file tools/git) now before calling ${toolNames[0]} again.`,
                });
            }
        }
        // Auto-save periodically in persistent mode to survive SIGTERM/crashes
        if (cfg.persistent && cfg.sessionPersistence && sessionId && round > 0 && round % AUTO_SAVE_INTERVAL === 0) {
            try {
                await memory.save(sessionId);
                Logger.debug(`Auto-saved session ${sessionId} at round ${round}`);
            }
            catch (e) {
                Logger.warn(`Auto-save failed at round ${round}: ${asError(e).message}`);
            }
        }
        // Exponential backoff on consecutive failed rounds to prevent runaway API loops
        if (roundHadFailure) {
            consecutiveFailedRounds++;
            const backoffMs = Math.min(1000 * Math.pow(2, consecutiveFailedRounds - 1), MAX_BACKOFF_MS);
            Logger.warn(`Round ${round} had tool failures (${consecutiveFailedRounds} consecutive), backing off ${backoffMs}ms`);
            await sleep(backoffMs);
        }
        else {
            consecutiveFailedRounds = 0;
        }
    }
    // If we exhausted maxToolRounds (loop didn't break via no-tool-calls),
    // give the model one final turn with no tools so it can produce a closing response.
    if (!brokeCleanly && tools.length > 0) {
        Logger.debug("Max tool rounds reached — final turn with no tools");
        const finalOutput = await driver.chat(memory.messages(), {
            model: activeModel,
            onToken: rawOnToken,
        });
        if (finalOutput.usage) {
            turnTokensIn += finalOutput.usage.inputTokens;
            turnTokensOut += finalOutput.usage.outputTokens;
            process.stderr.write(`"input_tokens": ${turnTokensIn}, "output_tokens": ${turnTokensOut}\n`);
            spendMeter.setModel(activeModel);
            spendMeter.record(finalOutput.usage.inputTokens, finalOutput.usage.outputTokens);
            Logger.info(spendMeter.format());
        }
        if (finalOutput.text)
            finalText += finalOutput.text;
        await memory.add({ role: "assistant", from: "Assistant", content: finalOutput.text || "" });
    }
    return { text: finalText, memory };
}
// ---------------------------------------------------------------------------
// Main modes
// ---------------------------------------------------------------------------
/** Check if --model was explicitly passed on the CLI. */
function wasModelExplicitlyPassed() {
    for (let i = 0; i < process.argv.length; i++) {
        if ((process.argv[i] === "-m" || process.argv[i] === "--model") && i + 1 < process.argv.length) {
            return true;
        }
    }
    return false;
}
async function singleShot(cfg, driver, mcp, sessionId, positionalArgs) {
    let prompt = (positionalArgs || []).join(" ").trim();
    if (!prompt && !process.stdin.isTTY) {
        const chunks = [];
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
    let memory = await createMemory(cfg, driver);
    // Register for graceful shutdown
    _shutdownMemory = memory;
    _shutdownSessionId = sessionId;
    _shutdownSessionPersistence = cfg.sessionPersistence;
    // Resume existing session if requested
    if (cfg.continueSession || cfg.resumeSession) {
        const sess = loadSession(sessionId);
        await memory.load(sessionId);
        // Restore the model from the previous session if no model was explicitly passed.
        // This ensures that @@model-change@@ applied in a previous turn persists
        // across session resume, since the model is stored in session metadata.
        if (sess && sess.meta.provider === cfg.provider && sess.meta.model) {
            if (!wasModelExplicitlyPassed()) {
                cfg.model = sess.meta.model;
                Logger.info(`Restored model from session: ${cfg.model}`);
            }
        }
    }
    await memory.add({ role: "user", from: "User", content: prompt });
    // Violation tracker for persistent mode
    const tracker = cfg.persistent ? new ViolationTracker() : undefined;
    const sameToolLoop = cfg.persistent ? new SameToolLoopTracker() : undefined;
    let text;
    let fatalError = false;
    try {
        const result = await executeTurn(driver, memory, mcp, cfg, sessionId, tracker, sameToolLoop);
        text = result.text;
        memory = result.memory; // pick up any hot-swapped memory
        _shutdownMemory = memory;
    }
    catch (e) {
        const ge = isGroError(e) ? e : groError("provider_error", asError(e).message, { cause: e });
        Logger.error(C.red(`error: ${ge.message}`), errorLogFields(ge));
        fatalError = true;
    }
    // Save session (even on error — preserve conversation state)
    if (cfg.sessionPersistence) {
        try {
            await memory.save(sessionId);
        }
        catch (e) {
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
        }
        else if (!text.endsWith("\n")) {
            process.stdout.write("\n");
        }
    }
}
async function interactive(cfg, driver, mcp, sessionId) {
    let memory = await createMemory(cfg, driver);
    const readline = await import("readline");
    // Violation tracker for persistent mode
    const sameToolLoop = cfg.persistent ? new SameToolLoopTracker() : undefined;
    const tracker = cfg.persistent ? new ViolationTracker() : undefined;
    // Register for graceful shutdown
    _shutdownMemory = memory;
    _shutdownSessionId = sessionId;
    _shutdownSessionPersistence = cfg.sessionPersistence;
    // Resume existing session if requested
    if (cfg.continueSession || cfg.resumeSession) {
        const sess = loadSession(sessionId);
        if (sess && sess.meta.provider !== cfg.provider) {
            Logger.warn(`Provider changed from ${sess.meta.provider} to ${cfg.provider} — ` +
                `starting fresh session to avoid cross-provider corruption (tool message format incompatibility)`);
            // Don't load the old session - cross-provider resume is unsafe
        }
        else {
            await memory.load(sessionId);
            if (sess) {
                // Restore the model from the previous session if no model was explicitly passed.
                if (!wasModelExplicitlyPassed() && sess.meta.model) {
                    cfg.model = sess.meta.model;
                    Logger.info(`Restored model from session: ${cfg.model}`);
                }
                const msgCount = sess.messages.filter((m) => m.role !== "system").length;
                Logger.info(C.gray(`Resumed session ${sessionId} (${msgCount} messages)`));
            }
        }
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        prompt: C.cyan("you > "),
    });
    const toolCount = mcp.getToolDefinitions().length;
    Logger.info(C.gray(`gro interactive — ${cfg.provider}/${cfg.model} [${sessionId}]`));
    if (cfg.summarizerModel)
        Logger.info(C.gray(`summarizer: ${cfg.summarizerModel}`));
    if (toolCount > 0)
        Logger.info(C.gray(`${toolCount} MCP tool(s) available`));
    Logger.info(C.gray("type 'exit' or Ctrl+D to quit\n"));
    rl.prompt();
    rl.on("line", async (line) => {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            return;
        }
        if (input === "exit" || input === "quit") {
            rl.close();
            return;
        }
        try {
            await memory.add({ role: "user", from: "User", content: input });
            const result = await executeTurn(driver, memory, mcp, cfg, sessionId, tracker, sameToolLoop);
            memory = result.memory; // pick up any hot-swapped memory
            _shutdownMemory = memory;
        }
        catch (e) {
            const ge = isGroError(e) ? e : groError("provider_error", asError(e).message, { cause: e });
            Logger.error(C.red(`error: ${ge.message}`), errorLogFields(ge));
        }
        // Auto-save after each turn
        if (cfg.sessionPersistence) {
            try {
                await memory.save(sessionId);
            }
            catch (e) {
                Logger.error(C.red(`session save failed: ${asError(e).message}`));
            }
        }
        process.stdout.write("\n");
        rl.prompt();
    });
    rl.on("error", (e) => {
        Logger.error(C.red(`readline error: ${e.message}`));
    });
    rl.on("close", async () => {
        if (cfg.sessionPersistence) {
            try {
                await memory.save(sessionId);
            }
            catch (e) {
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
    // Handle --set-key before loadConfig so we never construct a partial config
    const setKeyIdx = process.argv.indexOf("--set-key");
    if (setKeyIdx !== -1) {
        const provider = process.argv[setKeyIdx + 1];
        await runSetKey(provider);
        process.exit(0);
    }
    const cfg = loadConfig();
    if (cfg.verbose) {
        process.env.GRO_LOG_LEVEL = "debug";
    }
    // Set Logger verbose mode
    Logger.setVerbose(cfg.verbose);
    Logger.info(`Runtime: ${C.cyan("gro")} ${C.gray(VERSION)}  Model: ${C.gray(cfg.model)} ${C.gray(`(${cfg.provider})`)}`);
    // Resolve session ID
    let sessionId;
    if (cfg.continueSession) {
        const latest = findLatestSession();
        if (!latest) {
            Logger.error("gro: no session to continue");
            process.exit(1);
        }
        sessionId = latest;
        Logger.debug(`Continuing session: ${sessionId}`);
    }
    else if (cfg.resumeSession) {
        if (cfg.resumeSession === "latest") {
            const latest = findLatestSession();
            if (!latest) {
                Logger.error("gro: no session to resume");
                process.exit(1);
            }
            sessionId = latest;
        }
        else {
            sessionId = cfg.resumeSession;
        }
        Logger.debug(`Resuming session: ${sessionId}`);
    }
    else {
        sessionId = newSessionId();
        if (cfg.sessionPersistence) {
            ensureGroDir();
        }
    }
    const args = process.argv.slice(2);
    const positional = [];
    const flagsWithValues = [
        "--provider", "-P", "--model", "-m", "--base-url",
        "--system-prompt", "--system-prompt-file",
        "--append-system-prompt", "--append-system-prompt-file",
        "--context-tokens", "--max-tokens", "--max-tool-rounds", "--max-turns",
        "--max-thinking-tokens", "--max-budget-usd",
        "--summarizer-model", "--output-format", "--mcp-config",
        "--resume", "-r",
        "--max-retries", "--retry-base-ms",
        "--max-idle-nudges", "--wake-notes", "--name", "--set-key",
    ];
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("-")) {
            if (flagsWithValues.includes(args[i]))
                i++;
            continue;
        }
        positional.push(args[i]);
    }
    // Enable patch broadcast to AgentChat if --show-diffs and --name are set
    if (cfg.showDiffs && cfg.name) {
        const server = process.env.AGENTCHAT_SERVER || "wss://agentchat-server.fly.dev";
        enableShowDiffs(cfg.name, server);
        Logger.debug(`show-diffs enabled: #${cfg.name.toLowerCase()} → ${server}`);
    }
    else if (cfg.showDiffs && !cfg.name) {
        Logger.warn("--show-diffs requires --name to be set");
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
        }
        else {
            await singleShot(cfg, driver, mcp, sessionId, positional);
            await mcp.disconnectAll();
        }
    }
    catch (e) {
        await mcp.disconnectAll();
        throw e;
    }
}
// Graceful shutdown on signals — save session before exiting
for (const sig of ["SIGTERM", "SIGHUP"]) {
    process.on(sig, async () => {
        Logger.info(C.gray(`\nreceived ${sig}, saving session and shutting down...`));
        if (_shutdownMemory && _shutdownSessionId && _shutdownSessionPersistence) {
            try {
                await _shutdownMemory.save(_shutdownSessionId);
                Logger.info(C.gray(`session ${_shutdownSessionId} saved on ${sig}`));
            }
            catch (e) {
                Logger.error(C.red(`session save on ${sig} failed: ${asError(e).message}`));
            }
        }
        process.exit(0);
    });
}
// Catch unhandled promise rejections (e.g. background summarization)
process.on("unhandledRejection", (reason) => {
    const err = asError(reason);
    Logger.error(C.red(`unhandled rejection: ${err.message}`));
    if (err.stack)
        Logger.error(C.red(err.stack));
});
main().catch((e) => {
    const err = asError(e);
    Logger.error("gro:", err.message);
    if (err.stack)
        Logger.error(err.stack);
    process.exit(1);
});
