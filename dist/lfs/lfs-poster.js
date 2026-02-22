/**
 * Fire-and-forget HTTP POST to the personas LFS server.
 * Batches signals at ~60fps to avoid overwhelming the connection.
 */
import { Logger } from "../logger.js";
export class LfsPoster {
    constructor(serverUrl) {
        this.queue = [];
        this.flushTimer = null;
        this.BATCH_INTERVAL_MS = 16; // ~60fps
        const base = serverUrl.replace(/\/+$/, "");
        this.url = base.includes("/api/signal") ? base : `${base}/api/signal`;
    }
    /** Enqueue a signal for batched sending. */
    post(signal) {
        this.queue.push(signal);
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), this.BATCH_INTERVAL_MS);
        }
    }
    /** Enqueue multiple signals. */
    postBatch(signals) {
        for (const s of signals)
            this.queue.push(s);
        if (!this.flushTimer && this.queue.length > 0) {
            this.flushTimer = setTimeout(() => this.flush(), this.BATCH_INTERVAL_MS);
        }
    }
    async flush() {
        this.flushTimer = null;
        if (this.queue.length === 0)
            return;
        const batch = this.queue.splice(0);
        try {
            await fetch(this.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(batch.length === 1 ? batch[0] : batch),
                signal: AbortSignal.timeout(2000),
            });
        }
        catch {
            // Fire and forget — don't crash gro if personas server is down
            Logger.debug("LFS post failed (server may be offline)");
        }
    }
    /** Flush remaining signals. Call at end of response. */
    async close() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }
}
