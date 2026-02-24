/**
 * ContextMapSource — sensory channel that renders a spatial context map.
 *
 * Reads memory stats from the inner AgentMemory (via getStats()) and produces
 * a 2D spatial visualization where position, density, and shape encode
 * context window distribution. The model perceives patterns from row length
 * and fill — not from labels and numbers.
 *
 * Degrades gracefully: renders whatever stats the memory type provides.
 *
 * Target: under 300 tokens per render.
 */
export class ContextMapSource {
    constructor(memory, config) {
        this.memory = memory;
        this.config = {
            barWidth: config?.barWidth ?? 32,
            showLanes: config?.showLanes ?? true,
            showPages: config?.showPages ?? true,
        };
    }
    /** Update the memory reference (e.g., after hot-swap). */
    setMemory(memory) {
        this.memory = memory;
    }
    async poll() {
        return this.render();
    }
    destroy() {
        // No resources to clean up
    }
    render() {
        const stats = this.memory.getStats();
        return this.isVirtualStats(stats) ? this.renderVirtual(stats) : this.renderBasic(stats);
    }
    isVirtualStats(stats) {
        return stats.type === "virtual" || stats.type === "fragmentation" || stats.type === "hnsw" || stats.type === "perfect";
    }
    // --- Virtual Memory (spatial 2D) ---
    renderVirtual(stats) {
        const w = this.config.barWidth;
        const totalBudget = stats.workingMemoryBudget + stats.pageSlotBudget;
        if (totalBudget === 0)
            return this.renderBasic(stats);
        const sysTokens = stats.systemTokens;
        const pageTokens = stats.pageSlotUsed;
        const wmUsed = stats.workingMemoryUsed;
        const free = Math.max(0, totalBudget - sysTokens - pageTokens - wmUsed);
        const lines = [];
        // System prompt row (immutable — █)
        if (sysTokens > 0) {
            const chars = Math.max(1, Math.round((sysTokens / totalBudget) * w));
            lines.push(this.spatialRow("sys", chars, w, "█"));
        }
        // Page row (loaded, evictable — ▓)
        if (this.config.showPages && pageTokens > 0) {
            const chars = Math.max(1, Math.round((pageTokens / totalBudget) * w));
            lines.push(this.spatialRow("page", chars, w, "▓"));
        }
        // Lane rows (active working memory — ▒)
        if (this.config.showLanes && stats.lanes.length > 0) {
            for (const lane of stats.lanes) {
                if (lane.tokens <= 0)
                    continue;
                const chars = Math.max(1, Math.round((lane.tokens / totalBudget) * w));
                lines.push(this.spatialRow(this.laneLabel(lane.role), chars, w, "▒"));
            }
        }
        // Free row — bar length IS the free space; no ░ padding
        const freeChars = Math.round((free / totalBudget) * w);
        const freeBar = "░".repeat(freeChars);
        const freeLabel = "free".padStart(4);
        const totalUsed = sysTokens + pageTokens + wmUsed;
        const usePct = totalBudget > 0 ? totalUsed / totalBudget : 0;
        const isLow = (free / totalBudget) < 0.2 || stats.compactionActive || usePct > stats.highRatio;
        lines.push(isLow ? `${freeLabel} ${freeBar}  ← LOW` : `${freeLabel} ${freeBar}`);
        // Stats line — one line of precision for when the model needs exact numbers
        const usedK = (totalUsed / 1000).toFixed(0);
        const budgetK = (totalBudget / 1000).toFixed(0);
        const parts = [`${usedK}K/${budgetK}K`];
        if (stats.pinnedMessages > 0)
            parts.push(`pin:${stats.pinnedMessages}`);
        parts.push(`pg:${stats.pagesLoaded}/${stats.pagesAvailable}`);
        if (stats.model)
            parts.push(this.shortModel(stats.model));
        lines.push(parts.join(" | "));
        return lines.join("\n");
    }
    // --- Basic Memory (spatial simplified) ---
    renderBasic(stats) {
        const w = this.config.barWidth;
        const estimatedBudget = 128000;
        const used = stats.totalTokensEstimate;
        const free = Math.max(0, estimatedBudget - used);
        const usedChars = Math.max(used > 0 ? 1 : 0, Math.round((used / estimatedBudget) * w));
        const freeChars = Math.round((free / estimatedBudget) * w);
        const lines = [];
        lines.push(this.spatialRow("used", usedChars, w, "▒"));
        lines.push(`free ${"░".repeat(freeChars)}`);
        lines.push(`${stats.type} | ${stats.totalMessages} msgs | ~${(stats.totalTokensEstimate / 1000).toFixed(1)}K tok`);
        return lines.join("\n");
    }
    // --- Helpers ---
    /** Render a spatial row: right-aligned label + fill chars + ░ padding to width. */
    spatialRow(label, filled, width, fillChar) {
        const paddedLabel = label.padStart(4);
        const fill = fillChar.repeat(Math.min(filled, width));
        const pad = "░".repeat(Math.max(0, width - filled));
        return `${paddedLabel} ${fill}${pad}`;
    }
    /** Map lane role to short label for spatial rows. */
    laneLabel(role) {
        switch (role) {
            case "assistant": return "ast";
            case "user": return "usr";
            case "system": return "sys";
            case "tool": return "tool";
            default: return role.slice(0, 4);
        }
    }
    shortModel(model) {
        if (model.includes("opus"))
            return "opus";
        if (model.includes("sonnet"))
            return "sonnet";
        if (model.includes("haiku"))
            return "haiku";
        if (model.includes("gpt-4"))
            return "gpt4";
        if (model.includes("gpt-3"))
            return "gpt3";
        if (model.includes("llama"))
            return "llama";
        if (model.includes("gemini"))
            return "gemini";
        return model.length > 12 ? model.slice(0, 12) : model;
    }
}
