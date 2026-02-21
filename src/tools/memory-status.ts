/**
 * Built-in memory-status tool for gro — reports VirtualMemory statistics.
 * Shows pages, loaded pages, token usage per lane, and context size.
 * When PerfectMemory is active, also shows fork chain info.
 */
import type { AgentMemory } from "../memory/agent-memory.js";
import { VirtualMemory } from "../memory/virtual-memory.js";

export function memoryStatusToolDefinition(): any {
  return {
    type: "function",
    function: {
      name: "memory_status",
      description: "Get VirtualMemory statistics: pages, loaded pages, per-lane token usage, context size.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  };
}

export function executeMemoryStatus(args: Record<string, any>, memory: AgentMemory): string {
  if (!(memory instanceof VirtualMemory)) {
    return "Error: memory system is not VirtualMemory";
  }

  const vm = memory as VirtualMemory;

  // Get page stats
  const totalPages = vm.getPageCount();
  const activePages = vm.getActivePageIds();
  const pages = vm.getPages();

  // Calculate per-lane token usage
  const messages = vm.messages();
  const assistant = messages.filter(m => m.role === "assistant");
  const user = messages.filter(m => m.role === "user");
  const system = messages.filter(m => m.role === "system");
  const tool = messages.filter(m => m.role === "tool");

  const assistantTokens = estimateTokens(assistant);
  const userTokens = estimateTokens(user);
  const systemTokens = estimateTokens(system);
  const toolTokens = estimateTokens(tool);
  const totalTokens = assistantTokens + userTokens + systemTokens + toolTokens;

  // Format page list
  const pageList = pages.length > 0
    ? pages.map(p => `  - ${p.id}: ${p.label} (${p.messageCount} msgs, ${p.tokens} tokens)`).join("\n")
    : "  (none)";

  const activeList = activePages.length > 0
    ? activePages.map(id => `  - ${id}`).join("\n")
    : "  (none)";

  // Check for PerfectMemory fork info
  let forkSection = "";
  if ("getForkStats" in vm && typeof (vm as any).getForkStats === "function") {
    const stats = (vm as any).getForkStats() as { count: number; totalTokens: number; totalMessages: number };
    const chain = (vm as any).forkHistory?.() as Array<{ id: string; timestamp: string; tokens: number; messageCount: number; reason: string }> | undefined;

    forkSection = `
Fork Chain (PerfectMemory):
  Total Forks: ${stats.count}
  Total Tokens (across forks): ${stats.totalTokens}
  Total Messages (across forks): ${stats.totalMessages}
`;

    if (chain && chain.length > 0) {
      const forkList = chain.slice(-10).map(f =>
        `  - ${f.id}: ${f.timestamp} (${f.messageCount} msgs, ${f.tokens} tokens, ${f.reason})`
      ).join("\n");
      forkSection += `\n  Recent Forks (last 10):\n${forkList}\n`;
      if (chain.length > 10) {
        forkSection += `  ... and ${chain.length - 10} more\n`;
      }
    }
  }

  return `${vm.constructor.name} Status:

Pages:
  Total: ${totalPages}
  Active (loaded): ${activePages.length}

Page Details:
${pageList}

Active Pages:
${activeList}

Token Usage (per lane):
  Assistant: ${assistantTokens} tokens (${assistant.length} msgs)
  User: ${userTokens} tokens (${user.length} msgs)
  System: ${systemTokens} tokens (${system.length} msgs)
  Tool: ${toolTokens} tokens (${tool.length} msgs)
  Total: ${totalTokens} tokens (${messages.length} msgs)
${forkSection}`;
}

function estimateTokens(messages: any[]): number {
  const AVG_CHARS_PER_TOKEN = 2.8;
  let chars = 0;
  for (const m of messages) {
    const s = String(m.content ?? "");
    chars += (s.length > 24_000 ? 24_000 : s.length) + 32;
  }
  return Math.ceil(chars / AVG_CHARS_PER_TOKEN);
}
