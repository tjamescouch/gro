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
/**
 * Dynamically import "agenthnsw".
 *
 * We use `eval("(m) => import(m)")` to prevent the TypeScript compiler
 * and bundlers from resolving the specifier at compile time.
 */
async function importAgentHnsw() {
    try {
        const dynImport = eval("(m) => import(m)");
        return await dynImport("agenthnsw");
    }
    catch (err) {
        throw new Error(`Optional dependency "agenthnsw" is not installed. ` +
            `Install it with:  npm install agenthnsw\n` +
            `Original error: ${err instanceof Error ? err.message : String(err)}`);
    }
}
// ── AgentHnswIndex class ────────────────────────────────────────────────────
export class AgentHnswIndex {
    constructor(opts) {
        this.idx = null;
        this.metric = opts?.metric;
    }
    /** Lazily initialise the underlying index on first use. */
    async ensureIndex() {
        if (!this.idx) {
            const mod = await importAgentHnsw();
            this.idx = new mod.InMemoryLinearIndex({ metric: this.metric });
        }
        return this.idx;
    }
    async upsert(record) {
        const idx = await this.ensureIndex();
        await idx.upsert({ id: record.id, vector: record.vector, metadata: record.metadata });
    }
    async upsertMany(records) {
        const idx = await this.ensureIndex();
        await idx.upsertMany(records.map((r) => ({ id: r.id, vector: r.vector, metadata: r.metadata })));
    }
    async search(query, k) {
        const idx = await this.ensureIndex();
        const res = await idx.search(query, k);
        return res.map((r) => ({
            id: r.id,
            score: r.score,
            metadata: r.metadata,
        }));
    }
    async delete(id) {
        const idx = await this.ensureIndex();
        await idx.delete(id);
    }
    async save(dir) {
        const idx = await this.ensureIndex();
        await idx.save(dir);
    }
    async load(dir) {
        const idx = await this.ensureIndex();
        await idx.load(dir);
    }
    async stats() {
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
export function createAgentHnswIndex(opts) {
    return new AgentHnswIndex(opts);
}
