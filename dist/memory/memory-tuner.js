/**
 * Memory Tuner — Self-adjusting eviction policy based on observed metrics
 *
 * Analyzes memory performance data and recommends/applies parameter adjustments:
 * - Increase pageSlotTokens if miss rate is high
 * - Adjust lane weights based on recall patterns
 * - Tune eviction frequency threshold based on reload counts
 * - Modify summarization aggressiveness if compression is poor
 *
 * Can run in advisory mode (suggest) or automatic mode (auto-apply).
 */
export class MemoryTuner {
    constructor() {
        this.MISS_RATE_THRESHOLD = 0.25; // Warn if >25% references miss
        this.LOW_COMPRESSION_THRESHOLD = 2.0; // Warn if compression <2x
        this.HIGH_RECALL_THRESHOLD = 0.4; // Good if >40% evicted pages get recalled
        this.MIN_SAMPLE_SIZE = 10; // Need at least 10 references for meaningful analysis
    }
    /**
     * Analyze metrics and generate tuning recommendations.
     */
    tune(snapshot) {
        const recommendations = [];
        const { globalStats, lanes } = snapshot;
        // Skip if insufficient data
        if (globalStats.totalReferences < this.MIN_SAMPLE_SIZE) {
            return {
                recommendations: [],
                summary: `Insufficient data for tuning (${globalStats.totalReferences} references, need ${this.MIN_SAMPLE_SIZE}).`,
            };
        }
        const missRate = globalStats.missedReferences / globalStats.totalReferences;
        const recallRate = globalStats.successfulRecalls / globalStats.totalReferences;
        // 1. Tune page slot budget based on miss rate
        if (missRate > this.MISS_RATE_THRESHOLD) {
            const currentSlot = 6000; // Default from VirtualMemory
            const recommendedSlot = Math.round(currentSlot * (1 + missRate));
            recommendations.push({
                parameter: "pageSlotTokens",
                currentValue: currentSlot,
                recommendedValue: recommendedSlot,
                reason: `Miss rate is ${(missRate * 100).toFixed(1)}% (target: <${this.MISS_RATE_THRESHOLD * 100}%). Increasing page slot budget to reduce evictions.`,
                priority: "high",
                impact: "Will load more pages simultaneously, reducing miss rate but increasing context size.",
            });
        }
        // 2. Tune lane weights based on recall patterns
        for (const [lane, metrics] of Object.entries(lanes)) {
            // If a lane has high recall rate, it's valuable — increase its weight
            if (metrics.refRecallRate > this.HIGH_RECALL_THRESHOLD && metrics.totalEvictions > 5) {
                recommendations.push({
                    parameter: `${lane}Weight`,
                    currentValue: "1.0 (default)",
                    recommendedValue: "1.5",
                    reason: `${lane} lane has ${(metrics.refRecallRate * 100).toFixed(0)}% recall rate — pages are frequently re-referenced after eviction. Increasing weight will retain them longer.`,
                    priority: "medium",
                    impact: `More ${lane} messages will be kept in working memory before paging.`,
                });
            }
            // If compression is poor, summarizer may be too verbose
            if (metrics.avgCompressionRatio < this.LOW_COMPRESSION_THRESHOLD && metrics.totalPages > 3) {
                recommendations.push({
                    parameter: "summarizerPrompt",
                    currentValue: "(current prompt)",
                    recommendedValue: "(add stronger compression directives)",
                    reason: `${lane} lane has ${metrics.avgCompressionRatio.toFixed(2)}x compression (target: >${this.LOW_COMPRESSION_THRESHOLD}x). Summarizer may be too verbose.`,
                    priority: "low",
                    impact: "Summaries will be more concise, freeing up working memory tokens.",
                });
            }
            // If retention time is very short, messages are churning too fast
            const avgRetentionMin = metrics.avgRetentionTime / 1000 / 60;
            if (avgRetentionMin < 5 && metrics.totalEvictions > 5) {
                recommendations.push({
                    parameter: "workingMemoryTokens",
                    currentValue: "10000 (default)",
                    recommendedValue: "15000",
                    reason: `${lane} lane pages are evicted after only ${avgRetentionMin.toFixed(1)} minutes on average. This may be too aggressive.`,
                    priority: "medium",
                    impact: "Working memory will hold more recent messages before compacting.",
                });
            }
        }
        // 3. Tune minRecentPerLane if pages are being created too frequently
        const totalPages = snapshot.pages.length;
        const sessionAgeMs = Date.now() - snapshot.timestamp + (snapshot.globalStats.avgEvictionAge || 1);
        const pagesPerHour = (totalPages / sessionAgeMs) * 3600 * 1000;
        if (pagesPerHour > 10) {
            recommendations.push({
                parameter: "minRecentPerLane",
                currentValue: "6",
                recommendedValue: "10",
                reason: `Creating ${pagesPerHour.toFixed(1)} pages/hour. Increase minRecentPerLane to reduce page churn.`,
                priority: "low",
                impact: "More messages will stay in working memory (unpaged) before being archived.",
            });
        }
        // Generate summary
        let summary = `Analyzed ${globalStats.totalReferences} page references.\n`;
        summary += `- Recall rate: ${(recallRate * 100).toFixed(1)}%\n`;
        summary += `- Miss rate: ${(missRate * 100).toFixed(1)}%\n`;
        summary += `- Avg page lifetime: ${(globalStats.avgEvictionAge / 1000 / 60).toFixed(1)} min\n`;
        if (recommendations.length === 0) {
            summary += "\n✓ Memory system is well-tuned. No adjustments needed.";
        }
        else {
            summary += `\n${recommendations.length} tuning recommendation(s) generated.`;
        }
        return { recommendations, summary };
    }
    /**
     * Auto-apply tuning recommendations by modifying VirtualMemory config.
     * Returns a summary of applied changes.
     */
    apply(recommendations, cfg) {
        const applied = [];
        for (const rec of recommendations) {
            if (rec.priority === "high" || rec.priority === "medium") {
                // Apply numeric parameter changes
                if (typeof rec.recommendedValue === "number") {
                    cfg[rec.parameter] = rec.recommendedValue;
                    applied.push(`✓ Set ${rec.parameter} = ${rec.recommendedValue} (was ${rec.currentValue})`);
                }
                // For non-numeric changes (e.g., prompt modifications), just log
                else {
                    applied.push(`⚠️  Manual action needed: ${rec.reason}`);
                }
            }
        }
        if (applied.length === 0) {
            return "No high/medium priority recommendations to apply.";
        }
        return applied.join("\n");
    }
    /**
     * Format recommendations as markdown report.
     */
    formatRecommendations(result) {
        const lines = [];
        lines.push("# Memory Tuning Recommendations");
        lines.push("");
        lines.push(result.summary);
        lines.push("");
        if (result.recommendations.length === 0) {
            return lines.join("\n");
        }
        // Group by priority
        const high = result.recommendations.filter(r => r.priority === "high");
        const medium = result.recommendations.filter(r => r.priority === "medium");
        const low = result.recommendations.filter(r => r.priority === "low");
        if (high.length > 0) {
            lines.push("## High Priority");
            for (const rec of high) {
                lines.push(`### ${rec.parameter}`);
                lines.push(`- Current: ${rec.currentValue}`);
                lines.push(`- Recommended: ${rec.recommendedValue}`);
                lines.push(`- Reason: ${rec.reason}`);
                lines.push(`- Impact: ${rec.impact}`);
                lines.push("");
            }
        }
        if (medium.length > 0) {
            lines.push("## Medium Priority");
            for (const rec of medium) {
                lines.push(`### ${rec.parameter}`);
                lines.push(`- Current: ${rec.currentValue}`);
                lines.push(`- Recommended: ${rec.recommendedValue}`);
                lines.push(`- Reason: ${rec.reason}`);
                lines.push(`- Impact: ${rec.impact}`);
                lines.push("");
            }
        }
        if (low.length > 0) {
            lines.push("## Low Priority");
            for (const rec of low) {
                lines.push(`### ${rec.parameter}`);
                lines.push(`- Current: ${rec.currentValue}`);
                lines.push(`- Recommended: ${rec.recommendedValue}`);
                lines.push(`- Reason: ${rec.reason}`);
                lines.push("");
            }
        }
        return lines.join("\n");
    }
}
