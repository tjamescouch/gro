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
import type { EmbeddingProvider } from "./embedding-provider.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageSearchResult {
  pageId: string;
  score: number;
  label: string;
}

interface IndexEntry {
  embedding: number[];
  label: string;
}

interface PersistedIndex {
  version: number;
  provider: string;
  model: string;
  dimension: number;
  entries: Record<string, { embedding: number[]; label: string }>;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Cosine similarity (matches hnsw-memory.ts:60-75)
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
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

function deduplicateResults(results: Array<PageSearchResult & { embedding: number[] }>): PageSearchResult[] {
  const kept: Array<PageSearchResult & { embedding: number[] }> = [];
  for (const r of results) {
    const tooSimilar = kept.some(k => cosineSimilarity(k.embedding, r.embedding) > DEDUP_THRESHOLD);
    if (!tooSimilar) kept.push(r);
  }
  return kept.map(({ embedding: _, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// PageSearchIndex
// ---------------------------------------------------------------------------

export class PageSearchIndex {
  private entries: Map<string, IndexEntry> = new Map();
  private indexPath: string;
  private provider: EmbeddingProvider;

  constructor(config: { indexPath: string; embeddingProvider: EmbeddingProvider }) {
    this.indexPath = config.indexPath;
    this.provider = config.embeddingProvider;
  }

  // --- Persistence ---

  async load(): Promise<void> {
    try {
      const raw = readFileSync(this.indexPath, "utf-8");
      const data = JSON.parse(raw) as PersistedIndex;

      // Model drift detection: discard if provider/model changed
      if (data.provider !== this.provider.provider || data.model !== this.provider.model) {
        Logger.telemetry(
          `[PageSearchIndex] Model changed (${data.provider}/${data.model} → ${this.provider.provider}/${this.provider.model}), discarding index`
        );
        this.entries.clear();
        return;
      }

      for (const [id, entry] of Object.entries(data.entries)) {
        this.entries.set(id, { embedding: entry.embedding, label: entry.label });
      }
      Logger.telemetry(`[PageSearchIndex] Loaded ${this.entries.size} entries from ${this.indexPath}`);
    } catch {
      // File doesn't exist or is corrupted — start fresh
      this.entries.clear();
    }
  }

  save(pathOverride?: string): void {
    const target = pathOverride ?? this.indexPath;
    try {
      mkdirSync(dirname(target), { recursive: true });
      const data: PersistedIndex = {
        version: 1,
        provider: this.provider.provider,
        model: this.provider.model,
        dimension: this.provider.dimension,
        entries: Object.fromEntries(
          Array.from(this.entries.entries()).map(([id, e]) => [id, { embedding: e.embedding, label: e.label }])
        ),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(target, JSON.stringify(data) + "\n");
    } catch (err) {
      Logger.warn(`[PageSearchIndex] Save failed: ${err}`);
    }
  }

  // --- Indexing ---

  async indexPage(pageId: string, text: string, label: string): Promise<void> {
    const embeddings = await this.provider.embed([text]);
    if (embeddings.length > 0 && embeddings[0].length > 0) {
      this.entries.set(pageId, { embedding: embeddings[0], label });
    }
  }

  async indexPages(pages: Array<{ pageId: string; text: string; label: string }>): Promise<void> {
    if (pages.length === 0) return;
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

  removePage(pageId: string): void {
    this.entries.delete(pageId);
  }

  // --- Search ---

  async search(query: string, k = 5, threshold = 0.5): Promise<PageSearchResult[]> {
    if (this.entries.size === 0) return [];

    const queryEmbeddings = await this.provider.embed([query]);
    if (queryEmbeddings.length === 0 || queryEmbeddings[0].length === 0) return [];
    const queryVec = queryEmbeddings[0];

    // Score all entries
    const scored: Array<PageSearchResult & { embedding: number[] }> = [];
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

  /**
   * Search with ref-feedback boosts. Same as search() but applies an additive
   * boost based on embedding similarity to recently-ref'd pages.
   * Threshold filters on raw score only — boosts can lift ranking but not
   * synthesize relevance from nothing.
   */
  async searchWithRefBoosts(
    query: string,
    k = 5,
    threshold = 0.5,
    refBoosts: Array<{ pageId: string; weight: number }>,
  ): Promise<PageSearchResult[]> {
    if (this.entries.size === 0) return [];
    if (refBoosts.length === 0) return this.search(query, k, threshold);

    const queryEmbeddings = await this.provider.embed([query]);
    if (queryEmbeddings.length === 0 || queryEmbeddings[0].length === 0) return [];
    const queryVec = queryEmbeddings[0];

    // Collect ref embeddings
    const refEmbeddings: Array<{ embedding: number[]; weight: number }> = [];
    for (const rb of refBoosts) {
      const entry = this.entries.get(rb.pageId);
      if (entry) refEmbeddings.push({ embedding: entry.embedding, weight: rb.weight });
    }

    // Score all entries
    const scored: Array<PageSearchResult & { embedding: number[] }> = [];
    for (const [pageId, entry] of this.entries) {
      const rawScore = cosineSimilarity(queryVec, entry.embedding);
      if (rawScore < threshold) continue;

      // Compute ref boost: max similarity to any ref embedding, scaled by weight
      let refBoost = 0;
      for (const re of refEmbeddings) {
        const sim = cosineSimilarity(entry.embedding, re.embedding) * re.weight;
        if (sim > refBoost) refBoost = sim;
      }

      scored.push({
        pageId,
        score: rawScore + refBoost * 0.15,
        label: entry.label,
        embedding: entry.embedding,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, k * 2);
    const deduped = deduplicateResults(candidates);
    return deduped.slice(0, k);
  }

  // --- Utilities ---

  getMissingPageIds(allPageIds: string[]): string[] {
    return allPageIds.filter(id => !this.entries.has(id));
  }

  get size(): number {
    return this.entries.size;
  }

  /** Deep-copy this index (for use as shadow during batch re-summarization). */
  clone(pathOverride?: string): PageSearchIndex {
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
  static fromScratch(config: { indexPath: string; embeddingProvider: EmbeddingProvider }): PageSearchIndex {
    return new PageSearchIndex(config);
  }

  /** Replace the index path (used after atomic swap). */
  setIndexPath(newPath: string): void {
    this.indexPath = newPath;
  }
}
