/**
 * SemanticRetrieval — orchestrator for automatic and explicit page retrieval.
 *
 * Connects EmbeddingProvider, PageSearchIndex, and VirtualMemory:
 * - Auto-retrieval: before each turn, find semantically relevant pages
 * - Explicit search: @@ref('?query')@@ triggers semantic search
 * - Backfill: index existing pages on startup (only those with summaries)
 * - Live indexing: hook into VirtualMemory.onPageCreated for new pages
 */
import { createHash } from "node:crypto";
import { Logger } from "../logger.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hashText(text) {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
/**
 * Build a query string from recent messages.
 * Uses the last user message; if too short (<20 chars, e.g. "continue", "go"),
 * falls back to the last assistant message for grounding.
 */
function buildQuery(messages) {
    let lastUser = "";
    let lastAssistant = "";
    // Walk backwards to find the most recent user and assistant messages
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const content = typeof msg.content === "string" ? msg.content : "";
        if (!lastUser && msg.role === "user" && content.trim()) {
            lastUser = content.trim();
        }
        if (!lastAssistant && msg.role === "assistant" && content.trim()) {
            lastAssistant = content.trim();
        }
        if (lastUser && lastAssistant)
            break;
    }
    if (!lastUser && !lastAssistant)
        return null;
    // If user message is short, supplement with assistant context
    if (lastUser.length < 20 && lastAssistant) {
        return (lastUser + " " + lastAssistant.slice(0, 300)).trim();
    }
    return lastUser.slice(0, 500);
}
// ---------------------------------------------------------------------------
// SemanticRetrieval
// ---------------------------------------------------------------------------
export class SemanticRetrieval {
    constructor(config) {
        this.lastQueryHash = "";
        this.memory = config.memory;
        this.searchIndex = config.searchIndex;
        this.autoEnabled = config.autoRetrievalEnabled ?? true;
        this.maxAutoPages = config.maxAutoPages ?? 1;
        this.autoThreshold = config.autoThreshold ?? 0.5;
        this.searchThreshold = config.searchThreshold ?? 0.4;
        this.searchMaxResults = config.searchMaxResults ?? 5;
    }
    get available() {
        return this.searchIndex.size > 0;
    }
    // --- Auto-retrieval (called before each turn) ---
    async autoRetrieve(messages) {
        if (!this.autoEnabled || this.searchIndex.size === 0)
            return null;
        const query = buildQuery(messages);
        if (!query)
            return null;
        // Skip if query hasn't changed (e.g. during tool loops)
        const hash = hashText(query);
        if (hash === this.lastQueryHash)
            return null;
        this.lastQueryHash = hash;
        try {
            const results = await this.searchIndex.search(query, 3, this.autoThreshold);
            if (results.length === 0)
                return null;
            // Filter out already-loaded pages (dedup with @@ref@@)
            const activeIds = new Set(this.memory.getActivePageIds());
            const unloaded = results.filter(r => !activeIds.has(r.pageId));
            if (unloaded.length === 0)
                return null;
            // Load the best match (cap: maxAutoPages per turn)
            const toLoad = unloaded.slice(0, this.maxAutoPages);
            for (const r of toLoad) {
                this.memory.ref(r.pageId);
                Logger.telemetry(`[SemanticRetrieval] Auto-loading page ${r.pageId} (${r.label}, score=${r.score.toFixed(3)})`);
            }
            return toLoad[0].pageId;
        }
        catch (err) {
            Logger.warn(`[SemanticRetrieval] Auto-retrieval error: ${err}`);
            return null;
        }
    }
    // --- Explicit search (triggered by @@ref('?query')@@) ---
    async search(query) {
        try {
            const results = await this.searchIndex.search(query, this.searchMaxResults, this.searchThreshold);
            // Load unloaded results
            const activeIds = new Set(this.memory.getActivePageIds());
            for (const r of results) {
                if (!activeIds.has(r.pageId)) {
                    this.memory.ref(r.pageId);
                }
            }
            return results;
        }
        catch (err) {
            Logger.warn(`[SemanticRetrieval] Search error: ${err}`);
            return [];
        }
    }
    // --- Live indexing hook ---
    async onPageCreated(pageId, summary, label) {
        await this.searchIndex.indexPage(pageId, summary, label);
    }
    // --- Backfill existing pages ---
    async backfill() {
        const allPages = this.memory.getPages();
        const allIds = allPages.map(p => p.id);
        const missing = this.searchIndex.getMissingPageIds(allIds);
        if (missing.length === 0)
            return 0;
        const missingSet = new Set(missing);
        const toIndex = [];
        let skipped = 0;
        for (const page of allPages) {
            if (!missingSet.has(page.id))
                continue;
            // Only embed pages with coherent summaries — skip broken/incomplete pages
            if (!page.summary) {
                skipped++;
                continue;
            }
            toIndex.push({ pageId: page.id, text: page.summary, label: page.label });
        }
        if (toIndex.length > 0) {
            await this.searchIndex.indexPages(toIndex);
            this.searchIndex.save();
        }
        if (skipped > 0) {
            Logger.telemetry(`[SemanticRetrieval] Backfill: skipped ${skipped} pages without summaries`);
        }
        return toIndex.length;
    }
    // --- Persistence ---
    saveIndex() {
        this.searchIndex.save();
    }
}
