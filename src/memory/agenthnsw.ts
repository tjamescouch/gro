/**
 * agenthnsw adapter — optional dynamic import.
 *
 * The "agenthnsw" package is an optional dependency.  We load it at
 * runtime via a dynamic `import()` so that TypeScript compilation and
 * Docker builds succeed even when the package is not installed.
 *
 * If agenthnsw is missing at runtime the factory function
 * `createAgentHnswIndex()` will throw a clear error.
 */

import type { VectorIndex, VectorRecord, VectorSearchResult, Vector } from "./vector-index.js";

// ── Dynamic loader ──────────────────────────────────────────────────────────

interface InMemoryLinearIndexLike {
  upsert(record: { id: string; vector: Vector; metadata?: unknown }): Promise<void>;
  upsertMany(records: { id: string; vector: Vector; metadata?: unknown }[]): Promise<void>;
  search(query: Vector, k: number): Promise<{ id: string; score: number; metadata?: unknown }[]>;
  delete(id: string): Promise<void>;
  save(dir: string): Promise<void>;
  load(dir: string): Promise<void>;
  stats(): Promise<{ count: number; dims?: number }>;
}

interface AgentHnswModule {
  InMemoryLinearIndex: new (opts?: { metric?: "cosine" | "l2" }) => InMemoryLinearIndexLike;
}

/**
 * Dynamically import "agenthnsw".
 *
 * We use `eval("(m) => import(m)")` to prevent the TypeScript compiler
 * and bundlers from resolving the specifier at compile time.
 */
async function importAgentHnsw(): Promise<AgentHnswModule> {
  try {
    const dynImport: (m: string) => Promise<AgentHnswModule> = eval("(m) => import(m)");
    return await dynImport("agenthnsw");
  } catch (err: unknown) {
    throw new Error(
      `Optional dependency "agenthnsw" is not installed. ` +
      `Install it with:  npm install agenthnsw\n` +
      `Original error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── AgentHnswIndex class ────────────────────────────────────────────────────

export class AgentHnswIndex implements VectorIndex {
  private idx: InMemoryLinearIndexLike | null = null;
  private readonly metric: "cosine" | "l2" | undefined;

  constructor(opts?: { metric?: "cosine" | "l2" }) {
    this.metric = opts?.metric;
  }

  /** Lazily initialise the underlying index on first use. */
  private async ensureIndex(): Promise<InMemoryLinearIndexLike> {
    if (!this.idx) {
      const mod = await importAgentHnsw();
      this.idx = new mod.InMemoryLinearIndex({ metric: this.metric });
    }
    return this.idx;
  }

  async upsert(record: VectorRecord): Promise<void> {
    const idx = await this.ensureIndex();
    await idx.upsert({ id: record.id, vector: record.vector, metadata: record.metadata });
  }

  async upsertMany(records: VectorRecord[]): Promise<void> {
    const idx = await this.ensureIndex();
    await idx.upsertMany(
      records.map((r: VectorRecord) => ({ id: r.id, vector: r.vector, metadata: r.metadata }))
    );
  }

  async search(query: Vector, k: number): Promise<VectorSearchResult[]> {
    const idx = await this.ensureIndex();
    const res = await idx.search(query, k);
    return res.map((r: { id: string; score: number; metadata?: unknown }) => ({
      id: r.id,
      score: r.score,
      metadata: r.metadata,
    }));
  }

  async delete(id: string): Promise<void> {
    const idx = await this.ensureIndex();
    await idx.delete(id);
  }

  async save(dir: string): Promise<void> {
    const idx = await this.ensureIndex();
    await idx.save(dir);
  }

  async load(dir: string): Promise<void> {
    const idx = await this.ensureIndex();
    await idx.load(dir);
  }

  async stats(): Promise<{ count: number; dims?: number }> {
    const idx = await this.ensureIndex();
    return await idx.stats();
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an AgentHnswIndex.
 *
 * The underlying "agenthnsw" package is loaded lazily — this function
 * itself never throws even when the package is absent.  The first call
 * to any index method will attempt the dynamic import.
 */
export function createAgentHnswIndex(opts?: { metric?: "cosine" | "l2" }): AgentHnswIndex {
  return new AgentHnswIndex(opts);
}
