export class PhantomBuffer {
    constructor(options = {}) {
        this.snapshots = [];
        this.maxSnapshots = options.maxSnapshots ?? 10;
        this.avgCharsPerToken = options.avgCharsPerToken ?? 2.8;
    }
    /**
     * Create a snapshot of the current message buffer before compaction.
     * Returns the snapshot ID for later retrieval.
     */
    snapshot(messages, reason) {
        const id = `phantom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const tokens = this.estimateTokens(messages);
        const snap = {
            id,
            timestamp: new Date().toISOString(),
            messages: JSON.parse(JSON.stringify(messages)), // deep clone
            tokens,
            reason,
        };
        this.snapshots.push(snap);
        // Enforce max snapshots (FIFO eviction)
        if (this.snapshots.length > this.maxSnapshots) {
            this.snapshots.shift();
        }
        return id;
    }
    /**
     * Retrieve a snapshot by ID.
     * Returns null if not found.
     */
    getSnapshot(id) {
        return this.snapshots.find(s => s.id === id) ?? null;
    }
    /**
     * Get the most recent snapshot.
     */
    getLatest() {
        return this.snapshots[this.snapshots.length - 1] ?? null;
    }
    /**
     * List all available snapshots (metadata only, not full messages).
     */
    listSnapshots() {
        return this.snapshots.map(s => ({
            id: s.id,
            timestamp: s.timestamp,
            tokens: s.tokens,
            reason: s.reason,
            messageCount: s.messages.length,
        }));
    }
    /**
     * Clear all snapshots.
     */
    clear() {
        this.snapshots = [];
    }
    /**
     * Get total memory usage (estimated).
     */
    getMemoryUsage() {
        const totalTokens = this.snapshots.reduce((sum, s) => sum + s.tokens, 0);
        const totalMessages = this.snapshots.reduce((sum, s) => sum + s.messages.length, 0);
        return {
            snapshots: this.snapshots.length,
            totalTokens,
            totalMessages,
        };
    }
    estimateTokens(messages) {
        let chars = 0;
        for (const m of messages) {
            const s = String(m.content ?? "");
            chars += s.length + 32;
            const tc = m.tool_calls;
            if (Array.isArray(tc)) {
                for (const call of tc) {
                    const fn = call?.function;
                    if (fn) {
                        chars += (fn.name?.length ?? 0) + (fn.arguments?.length ?? 0) + 32;
                    }
                }
            }
        }
        return Math.ceil(chars / this.avgCharsPerToken);
    }
}
