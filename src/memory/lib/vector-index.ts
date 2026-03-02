/**
 * Pluggable vector index interface for retrieval-backed memory.
 *
 * This is intentionally small so backends can live in separate packages
 * (e.g. agenthnsw) and be imported by gro.
 */

export type Vector = Float32Array | number[];

export interface VectorRecord {
  id: string;
  vector: Vector;
  metadata?: unknown;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: unknown;
}

export interface VectorIndex {
  upsert(record: VectorRecord): Promise<void>;
  upsertMany(records: VectorRecord[]): Promise<void>;
  search(query: Vector, k: number): Promise<VectorSearchResult[]>;
  delete(id: string): Promise<void>;
  save(dir: string): Promise<void>;
  load(dir: string): Promise<void>;
  stats(): Promise<{ count: number; dims?: number }>;
}
