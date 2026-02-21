import type { ChatDriver, ChatMessage } from "../drivers/types.js";
import { VirtualMemory, type VirtualMemoryConfig } from "./virtual-memory.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../logger.js";

/**
 * HNSWMemory — semantic similarity-based memory (flat index fallback).
 *
 * Extends VirtualMemory with semantic retrieval:
 * - Embeds messages into vector space
 * - Uses flat cosine similarity search (O(n) but simple and reliable)
 * - On add, retrieves semantically similar past context
 * - Preserves VirtualMemory's paging and budgeting
 *
 * NOTE: Uses flat index instead of HNSW for stability. Performance is O(n)
 * per query but acceptable for <10k messages. Can upgrade to proper HNSW later.
 */

export interface HNSWMemoryConfig extends VirtualMemoryConfig {
  /** Embedding dimension (default: 384 for all-MiniLM-L6-v2) */
  dimension?: number;
  /** Number of similar messages to retrieve per query */
  retrievalCount?: number;
  /** Similarity threshold (0.0–1.0, higher = more similar) */
  similarityThreshold?: number;
  /** Embedding function (defaults to simple hash-based placeholder) */
  embedFn?: (text: string) => Promise<number[]>;
}

const HNSW_DEFAULTS = {
  dimension: 384,
  retrievalCount: 3,
  similarityThreshold: 0.7,
};

/**
 * Placeholder embedding function — simple hash-based embedding.
 * Replace with real embedding model (OpenAI, Sentence Transformers, etc.)
 */
function defaultEmbedFn(text: string): Promise<number[]> {
  const hash = createHash("sha256").update(text).digest();
  const vec: number[] = [];
  
  // Generate 384-dim vector from hash (deterministic, but not semantic)
  for (let i = 0; i < 384; i++) {
    const byteIdx = i % hash.length;
    const val = (hash[byteIdx] - 128) / 128.0; // Normalize to [-1, 1]
    vec.push(val);
  }
  
  return Promise.resolve(vec);
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

interface IndexEntry {
  msgId: string;
  embedding: number[];
  role: string;
  preview: string;
}

export class HNSWMemory extends VirtualMemory {
  private index: IndexEntry[] = [];
  private embedFn: (text: string) => Promise<number[]>;
  private retrievalCount: number;
  private similarityThreshold: number;
  private dimension: number;
  private hnswIndexPath: string;

  constructor(config: HNSWMemoryConfig = {}) {
    super(config);
    
    this.dimension = config.dimension ?? HNSW_DEFAULTS.dimension;
    this.retrievalCount = config.retrievalCount ?? HNSW_DEFAULTS.retrievalCount;
    this.similarityThreshold = config.similarityThreshold ?? HNSW_DEFAULTS.similarityThreshold;
    this.embedFn = config.embedFn ?? defaultEmbedFn;
    
    // Index path: ~/.gro/indices/<session_id>.hnsw.json (determined on save/load)
    const groDir = process.env.HOME ? join(process.env.HOME, ".gro") : "/tmp/gro";
    this.hnswIndexPath = join(groDir, "indices");
    mkdirSync(this.hnswIndexPath, { recursive: true });
  }

  /**
   * Override add to index messages as they arrive.
   */
  override async add(msg: ChatMessage): Promise<void> {
    await super.add(msg);
    await this.indexMessage(msg);
  }

  private async indexMessage(msg: ChatMessage): Promise<void> {
    const text = String(msg.content ?? "");
    if (!text.trim()) return;

    const embedding = await this.embedFn(text);
    const msgId = this.hashMessage(msg);

    this.index.push({
      msgId,
      embedding,
      role: msg.role,
      preview: text.slice(0, 100),
    });
  }

  /**
   * Retrieve semantically similar messages from the index.
   */
  async retrieve(query: string): Promise<ChatMessage[]> {
    if (this.index.length === 0) return [];

    const queryEmbedding = await this.embedFn(query);
    const similarities = this.index.map(entry => ({
      entry,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    // Sort by similarity descending
    similarities.sort((a, b) => b.score - a.score);

    // Filter by threshold and take top-k
    const topResults = similarities
      .filter(s => s.score >= this.similarityThreshold)
      .slice(0, this.retrievalCount);

    // Map back to messages (lookup in memory by msg ID)
    const messages = this.messages();
    const retrieved: ChatMessage[] = [];
    
    for (const { entry } of topResults) {
      const msg = messages.find(m => this.hashMessage(m) === entry.msgId);
      if (msg) retrieved.push(msg);
    }

    return retrieved;
  }

  private hashMessage(msg: ChatMessage): string {
    return createHash("sha256")
      .update(`${msg.role}:${msg.content}:${msg.from ?? ""}:${Date.now()}`)
      .digest("hex")
      .slice(0, 16);
  }

  async save(id: string): Promise<void> {
    // Save base VirtualMemory state
    await super.save(id);

    // Serialize index to disk
    const indexFile = join(this.hnswIndexPath, `${id}.hnsw.json`);
    const indexData = {
      version: 1,
      dimension: this.dimension,
      entries: this.index,
      timestamp: new Date().toISOString(),
    };
    
    try {
      mkdirSync(dirname(indexFile), { recursive: true });
      writeFileSync(indexFile, JSON.stringify(indexData, null, 2));
      Logger.info(`[HNSWMemory] Index saved to ${indexFile} (${this.index.length} entries)`);
    } catch (err) {
      Logger.error(`[HNSWMemory] Failed to save index to ${indexFile}: ${err}`);
    }
  }

  async load(id: string): Promise<void> {
    // Load base VirtualMemory state
    await super.load(id);

    // Load index from disk if it exists
    const indexFile = join(this.hnswIndexPath, `${id}.hnsw.json`);
    
    if (existsSync(indexFile)) {
      try {
        const indexData = JSON.parse(readFileSync(indexFile, "utf-8"));

        if (indexData.version !== 1) {
          Logger.warn(`[HNSWMemory] Unknown index version ${indexData.version}, rebuilding...`);
          await this.rebuildIndex();
          return;
        }

        if (indexData.dimension !== this.dimension) {
          Logger.warn(`[HNSWMemory] Index dimension mismatch (${indexData.dimension} vs ${this.dimension}), rebuilding...`);
          await this.rebuildIndex();
          return;
        }

        this.index = indexData.entries;
        Logger.info(`[HNSWMemory] Index loaded from ${indexFile} (${this.index.length} entries)`);
      } catch (err) {
        Logger.error(`[HNSWMemory] Failed to load index from ${indexFile}: ${err}`);
        await this.rebuildIndex();
      }
    } else {
      Logger.info(`[HNSWMemory] No index found at ${indexFile}, rebuilding...`);
      await this.rebuildIndex();
    }
  }

  private async rebuildIndex(): Promise<void> {
    Logger.info(`[HNSWMemory] Rebuilding index from ${this.messages().length} messages...`);
    
    this.index = [];
    for (const msg of this.messages()) {
      await this.indexMessage(msg);
    }
    
    Logger.info(`[HNSWMemory] Index rebuilt with ${this.index.length} messages`);
  }
}
