/**
 * Shared types for gro runtime configuration.
 */

import type { McpServerConfig } from "./mcp/index.js";

export type Provider = "openai" | "anthropic" | "groq" | "google" | "xai" | "local";

export interface GroConfig {
  provider: Provider;
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
  supervised: boolean;
  persistentPolicy: "listen-only" | "work-first";
  maxIdleNudges: number;
  bash: boolean;
  lfs: string | null;
  summarizerModel: string | null;
  outputFormat: "text" | "json" | "stream-json";
  continueSession: boolean;
  resumeSession: string | null;
  sessionPersistence: boolean;
  verbose: boolean;
  name: string | null;
  showDiffs: boolean;
  batchSummarization: boolean;
  mcpServers: Record<string, McpServerConfig>;
  maxBudgetUsd: number | null;
  maxTier: "low" | "mid" | "high" | null;
  /** When set, tier auto-select picks from any listed provider (preference order). */
  providers: string[];
  /** MCP tool role bindings — auto-detected or explicitly configured. */
  toolRoles: McpToolRoles;
  /** Disable Anthropic prompt caching (--no-cache). Default: caching enabled. */
  enablePromptCaching: boolean;
}

/**
 * MCP tool role declarations — allows the runtime to auto-call tools
 * in specific lifecycle points (idle, send) without hardcoding tool names.
 * Auto-detected from available MCP tools when not explicitly configured.
 */
export interface McpToolRoles {
  /** Tool to auto-call when the model emits an empty response in persistent mode.
   *  Default: auto-detected from MCP tools (agentchat_listen, slack_listen, etc.) */
  idleTool: string | null;
  /** Default args for the idle tool (e.g., { channels: ["#general"] }). */
  idleToolDefaultArgs: Record<string, unknown>;
  /** How to extract args from memory for the idle tool.
   *  "last-call" = reuse args from the most recent call to this tool.
   *  "default" = always use idleToolDefaultArgs. */
  idleToolArgStrategy: "last-call" | "default";
  /** Tool whose message field gets emotion markers and buffered narration injected.
   *  Default: auto-detected from MCP tools (agentchat_send, slack_send, etc.) */
  sendTool: string | null;
  /** The field name in the send tool that contains the message text. */
  sendToolMessageField: string;
}

/** Auto-detect MCP tool roles from available tool definitions. */
export function detectToolRoles(tools: Array<{ function: { name: string } }>): McpToolRoles {
  const toolNames = new Set(tools.map(t => t.function.name));

  let idleTool: string | null = null;
  if (toolNames.has("agentchat_listen")) {
    idleTool = "agentchat_listen";
  } else {
    for (const name of toolNames) {
      if (name.endsWith("_listen")) { idleTool = name; break; }
    }
  }

  let sendTool: string | null = null;
  if (toolNames.has("agentchat_send")) {
    sendTool = "agentchat_send";
  } else {
    for (const name of toolNames) {
      if (name.endsWith("_send")) { sendTool = name; break; }
    }
  }

  return {
    idleTool,
    idleToolDefaultArgs: idleTool === "agentchat_listen" ? { channels: ["#general"] } : {},
    idleToolArgStrategy: "last-call",
    sendTool,
    sendToolMessageField: "message",
  };
}
