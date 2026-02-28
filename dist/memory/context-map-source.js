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
// --- Time bucketing helpers ---
function timeBucket(createdAt, now) {
    const d = new Date(createdAt);
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays <= 0)
        return "today";
    if (diffDays === 1)
        return "yesterday";
    if (diffDays < 7)
        return `${diffDays}d ago`;
    return "older";
}
function bucketRank(bucket) {
    if (bucket === "today")
        return 0;
    if (bucket === "yesterday")
        return 1;
    if (bucket === "older")
        return 100;
    const m = bucket.match(/^(\d+)d ago$/);
    return m ? parseInt(m[1], 10) : 50;
}
export class ContextMapSource {
    constructor(memory, config) {
        /** One-shot filter for drill-down views. Cleared after next render. */
        this.filter = null;
        this.memory = memory;
        this.config = {
            barWidth: config?.barWidth ?? 32,
            showLanes: config?.showLanes ?? true,
            showPages: config?.showPages ?? true,
            maxChars: config?.maxChars ?? 0,
        };
    }
    /** Update the memory reference (e.g., after hot-swap). */
    setMemory(memory) {
        this.memory = memory;
    }
    /** Set a one-shot drill-down filter. Cleared after the next render. */
    setFilter(filter) {
        this.filter = filter;
    }
    /** Dynamically update the character budget (e.g., during full-screen expand). */
    setMaxChars(maxChars) {
        this.config.maxChars = maxChars;
    }
    async poll() {
        const result = this.render();
        // One-shot: clear filter after rendering
        if (this.filter)
            this.filter = null;
        return result;
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
        const isHigh = usePct > 0.75 && !stats.compactionActive;
        lines.push(isLow ? `${freeLabel} ${freeBar}  ← LOW` :
            isHigh ? `${freeLabel} ${freeBar}  ⚠ expand budget or compact` :
                `${freeLabel} ${freeBar}`);
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
        // Page digest — compact listing of all pages with short summaries
        if (this.config.showPages && stats.pageDigest && stats.pageDigest.length > 0) {
            // Calculate remaining character budget for page digest
            const usedSoFar = lines.reduce((sum, l) => sum + l.length + 1, 0); // +1 for \n
            const remaining = this.config.maxChars > 0
                ? Math.max(100, this.config.maxChars - usedSoFar)
                : 0;
            lines.push(this.renderPageDigest(stats.pageDigest, remaining));
        }
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
    /**
     * Strip boilerplate prefixes from page summaries and truncate for compact display.
     * Removes "[Summary of N messages: ...]", "[Pending summary: ...]", timestamps in labels.
     */
    compactSummary(summary, label, maxLen = 80) {
        let s = summary;
        // Strip "[Summary of N messages: ...]" or truncated "[Summary of N messages: ..."
        // The closing ] may be missing if virtual-memory truncated the summary to 80 chars
        s = s.replace(/^\[Summary of \d+ messages:[^\]]*\]?\s*/i, "");
        // Strip "[Pending summary: ...]" (same truncation-safe pattern)
        s = s.replace(/^\[Pending summary:[^\]]*\]?\s*/i, "");
        // Strip leading "..." left by truncation
        s = s.replace(/^\.{3}\s*/, "");
        // If nothing left, derive from label
        if (!s || s.length < 3) {
            // Strip ISO timestamps from label for compactness
            s = label.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*-?\s*/g, "").trim();
            if (!s)
                s = label;
        }
        return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
    }
    /**
     * Render page digest as a time-grouped tree the agent can browse and ref from.
     * @param charBudget Max chars for this section (0 = unlimited). Entries are
     *        trimmed to fit while preserving the hint line and loaded pages.
     */
    renderPageDigest(pages, charBudget = 0) {
        const now = new Date();
        const filter = this.filter;
        // Build page collections
        const loaded = [];
        const unloaded = [];
        let totalTokens = 0;
        for (const p of pages) {
            if (p.loaded || p.pinned)
                loaded.push(p);
            else
                unloaded.push(p);
            if (p.loaded)
                totalTokens += p.tokens;
        }
        const budgetK = "18"; // page slot budget ~18K
        const usedK = (totalTokens / 1000).toFixed(1);
        // --- Single page drill-down ---
        if (filter && this.isPageIdFilter(filter, pages)) {
            const page = pages.find(p => p.id === filter);
            if (page)
                return this.renderSinglePage(page, pages.length, loaded.length, usedK, budgetK);
        }
        // Hint line — built first so we can reserve space for it.
        // Use plain text (no @@ markers) — markers in the sensory buffer get consumed
        // when the LLM repeats them verbatim, stripping the hint from visible output.
        const hintLine = filter
            ? `reset: view('context')`
            : `view('context:today|full|pg_id')`;
        const hintReserve = hintLine.length + 1; // +1 for \n
        const lines = [`pages: ${pages.length} total, ${loaded.length} loaded (${usedK}K/${budgetK}K budget)`];
        // Loaded/pinned pages always shown individually
        for (const p of loaded) {
            const status = p.loaded ? "★" : "📌";
            const tokK = (p.tokens / 1000).toFixed(1);
            lines.push(`  ${status} ${p.id} (${tokK}K) ${this.compactSummary(p.summary, p.label)}`);
        }
        /** Check if adding a line would overflow the character budget. */
        const charsSoFar = () => lines.reduce((sum, l) => sum + l.length + 1, 0);
        const wouldOverflow = (line) => charBudget > 0 && (charsSoFar() + line.length + 1 + hintReserve > charBudget);
        // Group unloaded by time bucket
        if (unloaded.length > 0) {
            const buckets = new Map();
            const bucketOrder = [];
            for (const p of unloaded) {
                const bucket = timeBucket(p.createdAt, now);
                if (!buckets.has(bucket)) {
                    buckets.set(bucket, []);
                    bucketOrder.push(bucket);
                }
                buckets.get(bucket).push(p);
            }
            // Sort bucket order: today first, then yesterday, then Nd ago ascending, then older
            bucketOrder.sort((a, b) => bucketRank(a) - bucketRank(b));
            if (filter === "full") {
                // Full mode: expand all buckets, no per-bucket cap — overflow check limits naturally
                for (const bucket of bucketOrder) {
                    const items = buckets.get(bucket);
                    const header = `  ${bucket} (${items.length}):`;
                    if (wouldOverflow(header))
                        break;
                    lines.push(header);
                    let shown = 0;
                    for (const p of items) {
                        const line = `    · ${p.id} ${this.compactSummary(p.summary, p.label, 40)}`;
                        if (wouldOverflow(line))
                            break;
                        lines.push(line);
                        shown++;
                    }
                    if (shown < items.length) {
                        const more = `    +${items.length - shown} more`;
                        if (!wouldOverflow(more))
                            lines.push(more);
                    }
                }
            }
            else if (filter && this.isTimeBucketFilter(filter)) {
                // Time bucket filter: expand only matching bucket, collapse others
                for (const bucket of bucketOrder) {
                    const items = buckets.get(bucket);
                    if (bucket === filter) {
                        const header = `  ${bucket} (${items.length}):`;
                        if (wouldOverflow(header))
                            break;
                        lines.push(header);
                        for (const p of items) {
                            const line = `    · ${p.id} (${(p.tokens / 1000).toFixed(1)}K) ${this.compactSummary(p.summary, p.label)}`;
                            if (wouldOverflow(line))
                                break;
                            lines.push(line);
                        }
                    }
                    else {
                        const line = `  ${bucket} (${items.length})`;
                        if (wouldOverflow(line))
                            break;
                        lines.push(line);
                    }
                }
            }
            else {
                // Normal mode: expand most recent bucket only (up to 5 entries)
                let firstBucketExpanded = false;
                for (const bucket of bucketOrder) {
                    const items = buckets.get(bucket);
                    if (!firstBucketExpanded) {
                        firstBucketExpanded = true;
                        const header = `  ${bucket} (${items.length}):`;
                        if (wouldOverflow(header))
                            break;
                        lines.push(header);
                        let shown = 0;
                        for (const p of items.slice(0, 5)) {
                            const line = `    · ${p.id} (${(p.tokens / 1000).toFixed(1)}K) ${this.compactSummary(p.summary, p.label)}`;
                            if (wouldOverflow(line))
                                break;
                            lines.push(line);
                            shown++;
                        }
                        if (shown < items.length) {
                            const more = `    +${items.length - shown} more`;
                            if (!wouldOverflow(more))
                                lines.push(more);
                        }
                    }
                    else {
                        const line = `  ${bucket} (${items.length})`;
                        if (wouldOverflow(line))
                            break;
                        lines.push(line);
                    }
                }
            }
        }
        // Hint line — always included (space was reserved)
        lines.push(hintLine);
        return lines.join("\n");
    }
    /** Render detailed view of a single page. */
    renderSinglePage(page, totalPages, loadedCount, usedK, budgetK) {
        const lines = [];
        lines.push(`page detail: ${page.id} (${totalPages} total, ${loadedCount} loaded)`);
        lines.push(`  label: ${page.label}`);
        lines.push(`  tokens: ${(page.tokens / 1000).toFixed(1)}K`);
        lines.push(`  status: ${page.loaded ? "loaded ★" : page.pinned ? "pinned 📌" : "unloaded"}`);
        lines.push(`  created: ${page.createdAt}`);
        lines.push(`  summary: ${page.summary}`);
        if (page.loaded) {
            lines.push(`  unload: @@unref('${page.id}')@@  back: @@view('context')@@`);
        }
        else {
            lines.push(`  load: @@ref('${page.id}')@@  back: @@view('context')@@`);
        }
        return lines.join("\n");
    }
    /** Check if a filter string matches a time bucket name. */
    isTimeBucketFilter(filter) {
        return filter === "today" || filter === "yesterday" || filter === "older" || /^\d+d ago$/.test(filter);
    }
    /** Check if a filter string looks like a page ID (exists in pages list). */
    isPageIdFilter(filter, pages) {
        return pages.some(p => p.id === filter);
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
