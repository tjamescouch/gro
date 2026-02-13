#!/usr/bin/env bun
/**
 * gro — provider-agnostic LLM runtime with context management.
 *
 * Extracted from org. Single-agent, headless, no terminal UI.
 * Reads prompt from argv or stdin, manages conversation state,
 * outputs completion to stdout.
 */

import { Logger, C } from "./logger.js";
import { makeStreamingOpenAiDriver } from "./drivers/streaming-openai.js";
import { makeAnthropicDriver } from "./drivers/anthropic.js";
import { SimpleMemory } from "./memory/simple-memory.js";
import { AdvancedMemory } from "./memory/advanced-memory.js";
import type { ChatDriver, ChatMessage } from "./drivers/types.js";
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
    else if (args[i] === "-i" || args[i] === "--interactive") { flags.interactive = "true"; }
    else if (args[i] === "-h" || args[i] === "--help") { usage(); process.exit(0); }
    else if (!args[i].startsWith("-")) { positional.push(args[i]); }
  }

  const provider = inferProvider(flags.provider, flags.model);
  const apiKey = resolveApiKey(provider);

  return {
    provider,
    model: flags.model || defaultModel(provider),
    baseUrl: flags.baseUrl || defaultBaseUrl(provider),
    apiKey,
    systemPrompt: flags.systemPrompt || "",
    contextTokens: parseInt(flags.contextTokens || "8192"),
    interactive: flags.interactive === "true" || (positional.length === 0 && process.stdin.isTTY === true),
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
  -P, --provider    openai | anthropic | local (default: anthropic)
  -m, --model       model name (auto-infers provider)
  --base-url        API base URL
  --system-prompt   system prompt text
  --context-tokens  context window budget (default: 8192)
  -i, --interactive interactive conversation mode
  -h, --help        show this help`);
}

// ---------------------------------------------------------------------------
// Driver factory
// ---------------------------------------------------------------------------

function createDriver(cfg: GroConfig): ChatDriver {
  switch (cfg.provider) {  // eslint-disable-line default-case
    case "anthropic":
      if (!cfg.apiKey) {
        Logger.error("gro: ANTHROPIC_API_KEY not set");
        process.exit(1);
      }
      return makeAnthropicDriver({
        apiKey: cfg.apiKey,
        model: cfg.model,
      });

    case "openai":
      if (!cfg.apiKey) {
        Logger.error("gro: OPENAI_API_KEY not set");
        process.exit(1);
      }
      return makeStreamingOpenAiDriver({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: cfg.apiKey,
      });

    case "local":
      return makeStreamingOpenAiDriver({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
      });

    default:
      Logger.error(`gro: unknown provider "${cfg.provider}"`);
      process.exit(1);
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Memory factory
// ---------------------------------------------------------------------------

function createMemory(cfg: GroConfig, driver: ChatDriver): AgentMemory {
  if (cfg.interactive) {
    return new AdvancedMemory({
      driver,
      model: cfg.model,
      systemPrompt: cfg.systemPrompt || undefined,
      contextTokens: cfg.contextTokens,
    });
  }
  return new SimpleMemory(cfg.systemPrompt || undefined);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function singleShot(cfg: GroConfig, driver: ChatDriver): Promise<void> {
  // Read prompt from argv or stdin
  const args = process.argv.slice(2).filter(a => !a.startsWith("-"));
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

  const output = await driver.chat(memory.messages(), {
    model: cfg.model,
    onToken: (t: string) => process.stdout.write(t),
  });

  if (!output.text && output.toolCalls.length === 0) {
    Logger.error("gro: empty response");
    process.exit(1);
  }

  // Ensure trailing newline
  if (output.text && !output.text.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

async function interactive(cfg: GroConfig, driver: ChatDriver): Promise<void> {
  const memory = createMemory(cfg, driver);
  const readline = await import("readline");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // prompts to stderr, completions to stdout
    prompt: C.cyan("you > "),
  });

  Logger.info(C.gray(`gro interactive — ${cfg.provider}/${cfg.model}`));
  Logger.info(C.gray("type 'exit' or Ctrl+D to quit\n"));
  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === "exit" || input === "quit") { rl.close(); return; }

    await memory.add({ role: "user", from: "User", content: input });

    try {
      const output = await driver.chat(memory.messages(), {
        model: cfg.model,
        onToken: (t: string) => process.stdout.write(t),
      });

      if (output.text) {
        if (!output.text.endsWith("\n")) process.stdout.write("\n");
        await memory.add({ role: "assistant", from: "Assistant", content: output.text });
      }
    } catch (e: any) {
      Logger.error(C.red(`error: ${e.message}`));
    }

    process.stdout.write("\n");
    rl.prompt();
  });

  rl.on("close", () => {
    Logger.info(C.gray("\ngoodbye."));
    process.exit(0);
  });
}

async function main() {
  const cfg = loadConfig();

  // Filter out flags to get positional args
  const args = process.argv.slice(2);
  const positional: string[] = [];
  const flagsWithValues = ["--provider", "-P", "--model", "-m", "--base-url", "--system-prompt", "--context-tokens"];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) {
      if (flagsWithValues.includes(args[i])) i++;
      continue;
    }
    positional.push(args[i]);
  }

  const driver = createDriver(cfg);

  if (cfg.interactive && positional.length === 0) {
    await interactive(cfg, driver);
  } else {
    await singleShot(cfg, driver);
  }
}

main().catch((e) => {
  Logger.error("gro:", e.message || e);
  process.exit(1);
});
