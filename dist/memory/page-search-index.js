/**
 * PageSearchIndex — flat-vector index over page summaries.
 *
 * Embeds page summaries via EmbeddingProvider and stores them on disk.
 * Cosine similarity search, O(n) scan. Inter-result deduplication
 * removes results that are >0.9 similar to a higher-ranked result.
 *
 * Persistence: ~/.gro/pages/embeddings.json
 * On load, if the saved model/provider differs from the current
 * EmbeddingProvider, all entries are discarded (triggers re-index via backfill).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Logger } from "../logger.js";
// ---------------------------------------------------------------------------
// Cosine similarity (matches hnsw-memory.ts:60-75)
// ---------------------------------------------------------------------------
function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0)
        return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
// ---------------------------------------------------------------------------
// Deduplication: remove results too similar to a higher-ranked result
// ---------------------------------------------------------------------------
const DEDUP_THRESHOLD = 0.9;
function deduplicateResults(results) {
    const kept = [];
    for (const r of results) {
        const tooSimilar = kept.some(k => cosineSimilarity(k.embedding, r.embedding) > DEDUP_THRESHOLD);
        if (!tooSimilar)
            kept.push(r);
    }
    return kept.map(({ embedding: _, ...rest }) => rest);
}
// ---------------------------------------------------------------------------
// PageSearchIndex
// ---------------------------------------------------------------------------
export class PageSearchIndex {
    constructor(config) {
        this.entries = new Map();
        this.indexPath = config.indexPath;
        this.provider = config.embeddingProvider;
    }
    // --- Persistence ---
    async load() {
        try {
            const raw = readFileSync(this.indexPath, "utf-8");
            const data = JSON.parse(raw);
            // Model drift detection: discard if provider/model changed
            if (data.provider !== this.provider.provider || data.model !== this.provider.model) {
                Logger.telemetry(`[PageSearchIndex] Model changed (${data.provider}/${data.model} → ${this.provider.provider}/${this.provider.model}), discarding index`);
                this.entries.clear();
                return;
            }
            for (const [id, entry] of Object.entries(data.entries)) {
                this.entries.set(id, { embedding: entry.embedding, label: entry.label });
            }
            Logger.telemetry(`[PageSearchIndex] Loaded ${this.entries.size} entries from ${this.indexPath}`);
        }
        catch {
            // File doesn't exist or is corrupted — start fresh
            this.entries.clear();
        }
    }
    save(pathOverride) {
        const target = pathOverride ?? this.indexPath;
        try {
            mkdirSync(dirname(target), { recursive: true });
            const data = {
                version: 1,
                provider: this.provider.provider,
                model: this.provider.model,
                dimension: this.provider.dimension,
                entries: Object.fromEntries(Array.from(this.entries.entries()).map(([id, e]) => [id, { embedding: e.embedding, label: e.label }])),
                updatedAt: new Date().toISOString(),
            };
            writeFileSync(target, JSON.stringify(data) + "\n");
        }
        catch (err) {
            Logger.warn(`[PageSearchIndex] Save failed: ${err}`);
        }
    }
    // --- Indexing ---
    async indexPage(pageId, text, label) {
        const embeddings = await this.provider.embed([text]);
        if (embeddings.length > 0 && embeddings[0].length > 0) {
            this.entries.set(pageId, { embedding: embeddings[0], label });
        }
    }
    async indexPages(pages) {
        if (pages.length === 0)
            return;
        const texts = pages.map(p => p.text);
        const embeddings = await this.provider.embed(texts);
        for (let i = 0; i < pages.length; i++) {
            if (embeddings[i] && embeddings[i].length > 0) {
                this.entries.set(pages[i].pageId, {
                    embedding: embeddings[i],
                    label: pages[i].label,
                });
            }
        }
    }
    removePage(pageId) {
        this.entries.delete(pageId);
    }
    // --- Search ---
    async search(query, k = 5, threshold = 0.5) {
        if (this.entries.size === 0)
            return [];
        const queryEmbeddings = await this.provider.embed([query]);
        if (queryEmbeddings.length === 0 || queryEmbeddings[0].length === 0)
            return [];
        const queryVec = queryEmbeddings[0];
        // Score all entries
        const scored = [];
        for (const [pageId, entry] of this.entries) {
            const score = cosineSimilarity(queryVec, entry.embedding);
            if (score >= threshold) {
                scored.push({ pageId, score, label: entry.label, embedding: entry.embedding });
            }
        }
        // Sort descending by score
        scored.sort((a, b) => b.score - a.score);
        // Take top candidates (wider than k to allow dedup to filter)
        const candidates = scored.slice(0, k * 2);
        // Inter-result deduplication
        const deduped = deduplicateResults(candidates);
        return deduped.slice(0, k);
    }
    // --- Utilities ---
    getMissingPageIds(allPageIds) {
        return allPageIds.filter(id => !this.entries.has(id));
    }
    get size() {
        return this.entries.size;
    }
    /** Deep-copy this index (for use as shadow during batch re-summarization). */
    clone(pathOverride) {
        const cloned = new PageSearchIndex({
            indexPath: pathOverride ?? this.indexPath,
            embeddingProvider: this.provider,
        });
        for (const [id, entry] of this.entries) {
            cloned.entries.set(id, { embedding: [...entry.embedding], label: entry.label });
        }
        return cloned;
    }
    /** Create an empty index for building from scratch (shadow index). */
    static fromScratch(config) {
        return new PageSearchIndex(config);
    }
    /** Replace the index path (used after atomic swap). */
    setIndexPath(newPath) {
        this.indexPath = newPath;
    }
}
