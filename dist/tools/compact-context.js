export function compactContextToolDefinition() {
    return {
        type: "function",
        function: {
            name: "compact_context",
            description: "Force immediate context compaction, paging out older messages to free working memory. " +
                "Use before starting a large task (cloning a repo, reading many files) when you want to " +
                "preserve your current token budget. Optionally pass hints to control compaction behavior " +
                "for this one cycle (lane weights, importance threshold, aggressiveness).",
            parameters: {
                type: "object",
                properties: {
                    lane_weights: {
                        type: "object",
                        description: "Per-lane priority weights. Higher = preserve more. Auto-normalized. " +
                            'Standard lanes: "assistant", "user", "system", "tool".',
                        additionalProperties: { type: "number" },
                    },
                    importance_threshold: {
                        type: "number",
                        description: "Importance threshold (0.0-1.0) for promoting messages to keep set. " +
                            "Lower = keep more. Default: 0.7",
                    },
                    min_recent: {
                        type: "integer",
                        description: "Min recent messages to preserve per lane (single-shot override).",
                    },
                    aggressiveness: {
                        type: "number",
                        description: "0.0 = light cleanup, 1.0 = free maximum space. Default: 0.5",
                    },
                },
                required: [],
            },
        },
    };
}
export async function executeCompactContext(args, memory) {
    const hints = {};
    if (args.lane_weights && typeof args.lane_weights === "object") {
        hints.lane_weights = args.lane_weights;
    }
    if (typeof args.importance_threshold === "number") {
        hints.importance_threshold = args.importance_threshold;
    }
    if (typeof args.min_recent === "number") {
        hints.min_recent = args.min_recent;
    }
    if (typeof args.aggressiveness === "number") {
        hints.aggressiveness = args.aggressiveness;
    }
    return await memory.compactWithHints(hints);
}
