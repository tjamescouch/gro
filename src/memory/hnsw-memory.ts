import type { ChatDriver, ChatMessage } from "../drivers/types.js";
import { VirtualMemory, type VirtualMemoryConfig } from "./virtual-memory.js";
import { createHash } from "node:crypto";

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

/** Cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

interface IndexedMessage {
  id: string;
  vector: number[];
  message: ChatMessage;
}

export class HNSWMemory extends VirtualMemory {
  private hnswCfg: Required<Pick<HNSWMemoryConfig, "dimension" | "retrievalCount" | "similarityThreshold" | "embedFn">>;
  private index: IndexedMessage[] = [];

  constructor(config: HNSWMemoryConfig = {}) {
    super(config);

    this.hnswCfg = {
      dimension: config.dimension ?? HNSW_DEFAULTS.dimension,
      retrievalCount: config.retrievalCount ?? HNSW_DEFAULTS.retrievalCount,
      similarityThreshold: config.similarityThreshold ?? HNSW_DEFAULTS.similarityThreshold,
      embedFn: config.embedFn ?? defaultEmbedFn,
    };
  }

  async add(msg: ChatMessage): Promise<void> {
    // Embed and index the message
    await this.indexMessage(msg);

    // Retrieve semantically similar past messages
    const similar = await this.retrieveSimilar(msg.content);
    
    // Log retrieval for observability
    if (similar.length > 0) {
      console.log(
        `[HNSWMemory] Retrieved ${similar.length} similar messages for: "${msg.content.slice(0, 60)}..."`
      );
    }

    // Add to buffer (VirtualMemory handles paging/compaction)
    await super.add(msg);
  }

  private async indexMessage(msg: ChatMessage): Promise<void> {
    try {
      const vector = await this.hnswCfg.embedFn(msg.content);
      
      // Generate unique ID for this message
      const msgId = this.hashMessage(msg);
      
      // Add to flat index
      this.index.push({ id: msgId, vector, message: msg });
    } catch (error) {
      console.error(`[HNSWMemory] Failed to index message: ${error}`);
    }
  }

  private async retrieveSimilar(query: string): Promise<ChatMessage[]> {
    try {
      const queryVector = await this.hnswCfg.embedFn(query);
      
      // Compute similarities for all indexed messages (O(n) flat search)
      const scored: { message: ChatMessage; similarity: number }[] = [];
      
      for (const item of this.index) {
        const similarity = cosineSimilarity(queryVector, item.vector);
        if (similarity >= this.hnswCfg.similarityThreshold) {
          scored.push({ message: item.message, similarity });
        }
      }
      
      // Sort by similarity descending and take top k
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, this.hnswCfg.retrievalCount).map(s => s.message);
    } catch (error) {
      console.error(`[HNSWMemory] Failed to retrieve similar messages: ${error}`);
      return [];
    }
  }

  private hashMessage(msg: ChatMessage): string {
    return createHash("sha256")
      .update(`${msg.role}:${msg.content}:${msg.from ?? ""}:${Date.now()}`)
      .digest("hex")
      .slice(0, 16);
  }

  async save(id: string): Promise<void> {
    // TODO: Serialize index to disk alongside session
    // For now, just save base VirtualMemory state
    // Index will be rebuilt on load from messages
    await super.save(id);
  }

  async load(id: string): Promise<void> {
    // Load base VirtualMemory state
    await super.load(id);

    // Rebuild index from loaded messages
    console.log(`[HNSWMemory] Rebuilding index from ${this.messages().length} messages...`);
    
    this.index = [];
    for (const msg of this.messages()) {
      await this.indexMessage(msg);
    }
    
    console.log(`[HNSWMemory] Index rebuilt with ${this.index.length} messages`);
  }
}
