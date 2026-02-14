/**
 * agenthnsw adapter.
 *
 * For now, this uses the baseline linear index shipped by agenthnsw.
 * A future revision can switch to an actual HNSW backend without changing
 * gro's calling code.
 */

import { InMemoryLinearIndex } from "agenthnsw";
import type { VectorIndex, VectorRecord, VectorSearchResult, Vector } from "./vector-index.js";

export class AgentHnswIndex implements VectorIndex {
  private readonly idx: InMemoryLinearIndex;

  constructor(opts?: { metric?: "cosine" | "l2" }) {
    this.idx = new InMemoryLinearIndex(opts);
  }

  async upsert(record: VectorRecord): Promise<void> {
    await this.idx.upsert({ id: record.id, vector: record.vector, metadata: record.metadata });
  }

  async upsertMany(records: VectorRecord[]): Promise<void> {
    await this.idx.upsertMany(records.map(r => ({ id: r.id, vector: r.vector, metadata: r.metadata })));
  }

  async search(query: Vector, k: number): Promise<VectorSearchResult[]> {
    const res = await this.idx.search(query, k);
    return res.map(r => ({ id: r.id, score: r.score, metadata: r.metadata }));
  }

  async delete(id: string): Promise<void> {
    await this.idx.delete(id);
  }

  async save(dir: string): Promise<void> {
    await this.idx.save(dir);
  }

  async load(dir: string): Promise<void> {
    await this.idx.load(dir);
  }

  async stats(): Promise<{ count: number; dims?: number }> {
    return await this.idx.stats();
  }
}
