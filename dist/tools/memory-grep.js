import { VirtualMemory } from "../memory/virtual-memory.js";
export function memoryGrepToolDefinition() {
    return {
        type: "function",
        function: {
            name: "memory_grep",
            description: "Search memory page content by regex or string pattern. " +
                "Returns matching pages with context snippets. Use this to find " +
                "specific text (file paths, variable names, error messages) in paged-out context. " +
                "Use @@ref('id1,id2')@@ to load matching pages.",
            parameters: {
                type: "object",
                properties: {
                    pattern: {
                        type: "string",
                        description: "Regex pattern or literal string to search for",
                    },
                    case_insensitive: {
                        type: "boolean",
                        description: "Case-insensitive matching (default: true)",
                    },
                    max_results: {
                        type: "integer",
                        description: "Max pages to return (default: 10)",
                    },
                },
                required: ["pattern"],
            },
        },
    };
}
export function executeMemoryGrep(args, memory) {
    if (!(memory instanceof VirtualMemory)) {
        return "Error: memory_grep requires VirtualMemory";
    }
    const pattern = args.pattern;
    if (!pattern)
        return "Error: pattern is required";
    const results = memory.grepPages(pattern, {
        caseInsensitive: args.case_insensitive ?? true,
        maxResults: args.max_results ?? 10,
    });
    if (results.length === 0) {
        return `No pages match "${pattern}"`;
    }
    const lines = [`${results.length} page(s) match "${pattern}":\n`];
    for (const r of results) {
        const status = r.loaded ? "[loaded]" : "";
        lines.push(`${r.pageId} ${status} — ${r.label} (${r.tokens} tok, ${r.matchCount} matches)`);
        for (const snippet of r.snippets) {
            lines.push(`  │ ${snippet}`);
        }
        lines.push("");
    }
    // Cap total output to avoid context bloat
    let output = lines.join("\n");
    if (output.length > 6000) {
        output = output.slice(0, 5900) + "\n... (truncated)";
    }
    return output;
}
