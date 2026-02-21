import { z } from "zod";
import { MemoryMetricsCollector } from "../memory/memory-metrics.js";
import { MemoryTuner } from "../memory/memory-tuner.js";
export const memory_tune = {
    name: "memory_tune",
    description: "Analyze VirtualMemory performance metrics and generate tuning recommendations. Can auto-apply high/medium priority changes.",
    inputSchema: z.object({
        auto_apply: z
            .boolean()
            .optional()
            .describe("If true, automatically apply high/medium priority recommendations to runtime config"),
    }),
    async execute({ auto_apply }, runtimeConfig) {
        const sessionId = "current";
        const metricsPath = `${process.env.HOME}/.gro/pages/memory-metrics.json`;
        const collector = new MemoryMetricsCollector(sessionId, metricsPath);
        const tuner = new MemoryTuner();
        const snapshot = collector.snapshot();
        const result = tuner.tune(snapshot);
        let output = tuner.formatRecommendations(result);
        if (auto_apply && runtimeConfig?.memoryConfig) {
            output += "\n\n---\n\n## Auto-Applied Changes\n\n";
            const applyResult = tuner.apply(result.recommendations, runtimeConfig.memoryConfig);
            output += applyResult;
            output += "\n\n(Changes will take effect on next memory compaction cycle.)";
        }
        else if (auto_apply) {
            output += "\n\n⚠️  Cannot auto-apply: runtimeConfig not available.";
        }
        else {
            output += "\n\n_Run with `auto_apply: true` to automatically apply high/medium priority recommendations._";
        }
        return output;
    },
};
