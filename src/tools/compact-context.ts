/**
 * Built-in compact_context tool for gro — forces immediate context compaction.
 * Call this before starting a large task to free up working memory budget.
 */
import type { AgentMemory } from "../memory/agent-memory.js";
import { VirtualMemory } from "../memory/virtual-memory.js";

export function compactContextToolDefinition(): any {
  return {
    type: "function",
    function: {
      name: "compact_context",
      description:
        "Force immediate context compaction, paging out older messages to free working memory. " +
        "Use before starting a large task (cloning a repo, reading many files) when you want to " +
        "preserve your current token budget. Only works with VirtualMemory.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  };
}

export async function executeCompactContext(
  _args: Record<string, any>,
  memory: AgentMemory
): Promise<string> {
  if (!(memory instanceof VirtualMemory)) {
    return "compact_context: memory system is not VirtualMemory — nothing to compact.";
  }
  return await (memory as VirtualMemory).forceCompact();
}
