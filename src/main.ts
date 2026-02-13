#!/usr/bin/env bun
/**
 * gro — provider-agnostic LLM runtime with context management.
 *
 * Extracted from org. Single-agent, headless, no terminal UI.
 * Reads prompt from argv or stdin, manages conversation state,
 * outputs completion to stdout. Connects to MCP servers for tools.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Logger, C } from "./logger.js";
import { makeStreamingOpenAiDriver } from "./drivers/streaming-openai.js";
import { makeAnthropicDriver } from "./drivers/anthropic.js";
import { SimpleMemory } from "./memory/simple-memory.js";
import { AdvancedMemory } from "./memory/advanced-memory.js";
import { McpManager } from "./mcp/index.js";
import type { McpServerConfig } from "./mcp/index.js";
import type { ChatDriver, ChatMessage, ChatOutput } from "./drivers/types.js";
import type { AgentMemory } from "./memory/agent-memory.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface GroConfig {
  provider: "openai" | "anthropic" | "local";
  model: string;
  baseUrl: string;
  apiKey: string;
  systemPrompt: string;
  contextTokens: number;
  interactive: boolean;
  maxToolRounds: number;
  summarizerModel: string | null;
  mcpServers: Record<string, McpServerConfig>;
}

function loadMcpServers(): Record<string, McpServerConfig> {
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
      } catch (e: any) {
        Logger.debug(`Failed to parse ${path}: ${e.message}`);
      }
    }
  }
  return {};
}

function loadConfig(): GroConfig {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" || args[i] === "-P") { flags.provider = args[++i]; }
    else if (args[i] === "--model" || args[i] === "-m") { flags.model = args[++i]; }
    else if (args[i] === "--base-url") { flags.baseUrl = args[++i]; }
    else if (args[i] === "--system-prompt") { flags.systemPrompt = args[++i]; }
    else if (args[i] === "--context-tokens") { flags.contextTokens = args[++i]; }
    else if (args[i] === "--max-tool-rounds") { flags.maxToolRounds = args[++i]; }
    else if (args[i] === "--summarizer-model") { flags.summarizerModel = args[++i]; }
    else if (args[i] === "-i" || args[i] === "--interactive") { flags.interactive = "true"; }
    else if (args[i] === "--no-mcp") { flags.noMcp = "true"; }
    else if (args[i] === "-h" || args[i] === "--help") { usage(); process.exit(0); }
    else if (!args[i].startsWith("-")) { positional.push(args[i]); }
  }

  const provider = inferProvider(flags.provider, flags.model);
  const apiKey = resolveApiKey(provider);
  const mcpServers = flags.noMcp === "true" ? {} : loadMcpServers();

  return {
    provider,
    model: flags.model || defaultModel(provider),
    baseUrl: flags.baseUrl || defaultBaseUrl(provider),
    apiKey,
    systemPrompt: flags.systemPrompt || "",
    contextTokens: parseInt(flags.contextTokens || "8192"),
    interactive: flags.interactive === "true" || (positional.length === 0 && process.stdin.isTTY === true),
    maxToolRounds: parseInt(flags.maxToolRounds || "10"),
    summarizerModel: flags.summarizerModel || null,
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
    case "openai": return "https://api.openai.com";
    case "local": return "http://127.0.0.1:11434";
    default: return "https://api.anthropic.com";
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
  console.log(`gro — provider-agnostic LLM runtime

usage:
  gro [options] "prompt"
  echo "prompt" | gro [options]
  gro -i                        # interactive mode

options:
  -P, --provider      openai | anthropic | local (default: anthropic)
  -m, --model         model name (auto-infers provider)
  --base-url          API base URL
  --system-prompt     system prompt text
  --context-tokens    context window budget (default: 8192)
  --max-tool-rounds   max tool call rounds per turn (default: 10)
  --summarizer-model  model for context summarization (default: same as --model)
  --no-mcp            disable MCP server connections
  -i, --interactive   interactive conversation mode
  -h, --help          show this help`);
}

// ---------------------------------------------------------------------------
// Driver factory
// ---------------------------------------------------------------------------

function createDriverForModel(
  provider: "openai" | "anthropic" | "local",
  model: string,
  apiKey: string,
  baseUrl: string,
): ChatDriver {
  switch (provider) {
    case "anthropic":
      if (!apiKey) {
        Logger.error("gro: ANTHROPIC_API_KEY not set");
        process.exit(1);
      }
      return makeAnthropicDriver({ apiKey, model });

    case "openai":
      if (!apiKey) {
        Logger.error("gro: OPENAI_API_KEY not set");
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

function createDriver(cfg: GroConfig): ChatDriver {
  return createDriverForModel(cfg.provider, cfg.model, cfg.apiKey, cfg.baseUrl);
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
  return new SimpleMemory(cfg.systemPrompt || undefined);
}

// ---------------------------------------------------------------------------
// Tool execution loop
// ---------------------------------------------------------------------------

/**
 * Execute a single turn: call the model, handle tool calls, repeat until
 * the model produces a final text response or we hit maxRounds.
 */
async function executeTurn(
  driver: ChatDriver,
  memory: AgentMemory,
  mcp: McpManager,
  cfg: GroConfig,
): Promise<string> {
  const tools = mcp.getToolDefinitions();
  let finalText = "";

  for (let round = 0; round < cfg.maxToolRounds; round++) {
    const output: ChatOutput = await driver.chat(memory.messages(), {
      model: cfg.model,
      tools: tools.length > 0 ? tools : undefined,
      onToken: (t: string) => process.stdout.write(t),
    });

    // Accumulate text
    if (output.text) {
      finalText += output.text;
      await memory.add({ role: "assistant", from: "Assistant", content: output.text });
    }

    // No tool calls — we're done
    if (output.toolCalls.length === 0) break;

    // Process tool calls
    for (const tc of output.toolCalls) {
      const fnName = tc.function.name;
      let fnArgs: Record<string, any>;
      try {
        fnArgs = JSON.parse(tc.function.arguments);
      } catch {
        fnArgs = {};
      }

      Logger.debug(`Tool call: ${fnName}(${JSON.stringify(fnArgs)})`);

      let result: string;
      try {
        result = await mcp.callTool(fnName, fnArgs);
      } catch (e: any) {
        result = `Error: ${e.message}`;
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
  }

  return finalText;
}

// ---------------------------------------------------------------------------
// Main modes
// ---------------------------------------------------------------------------

async function singleShot(cfg: GroConfig, driver: ChatDriver, mcp: McpManager): Promise<void> {
  const args = process.argv.slice(2).filter((a: string) => !a.startsWith("-"));
  let prompt = args.join(" ").trim();

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
  await memory.add({ role: "user", from: "User", content: prompt });

  const text = await executeTurn(driver, memory, mcp, cfg);

  if (!text) {
    Logger.error("gro: empty response");
    process.exit(1);
  }

  if (!text.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

async function interactive(cfg: GroConfig, driver: ChatDriver, mcp: McpManager): Promise<void> {
  const memory = createMemory(cfg, driver);
  const readline = await import("readline");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: C.cyan("you > "),
  });

  const toolCount = mcp.getToolDefinitions().length;
  Logger.info(C.gray(`gro interactive — ${cfg.provider}/${cfg.model}`));
  if (toolCount > 0) Logger.info(C.gray(`${toolCount} MCP tool(s) available`));
  Logger.info(C.gray("type 'exit' or Ctrl+D to quit\n"));
  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === "exit" || input === "quit") { rl.close(); return; }

    await memory.add({ role: "user", from: "User", content: input });

    try {
      await executeTurn(driver, memory, mcp, cfg);
    } catch (e: any) {
      Logger.error(C.red(`error: ${e.message}`));
    }

    process.stdout.write("\n");
    rl.prompt();
  });

  rl.on("close", async () => {
    await mcp.disconnectAll();
    Logger.info(C.gray("\ngoodbye."));
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();

  const args = process.argv.slice(2);
  const positional: string[] = [];
  const flagsWithValues = ["--provider", "-P", "--model", "-m", "--base-url", "--system-prompt", "--context-tokens", "--max-tool-rounds", "--summarizer-model"];
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
      await interactive(cfg, driver, mcp);
    } else {
      await singleShot(cfg, driver, mcp);
      await mcp.disconnectAll();
    }
  } catch (e: any) {
    await mcp.disconnectAll();
    throw e;
  }
}

main().catch((e) => {
  Logger.error("gro:", e.message || e);
  process.exit(1);
});
