import { VirtualMemory } from "../memory/virtual-memory.js";
export function compactContextToolDefinition() {
    return {
        type: "function",
        function: {
            name: "compact_context",
            description: "Force immediate context compaction, paging out older messages to free working memory. " +
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
export async function executeCompactContext(_args, memory) {
    if (!(memory instanceof VirtualMemory)) {
        return "compact_context: memory system is not VirtualMemory — nothing to compact.";
    }
    return await memory.forceCompact();
}
