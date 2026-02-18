/**
 * SummarizationQueue — persistent queue for async batch summarization.
 *
 * Stores pages waiting for batch summarization. Queue persists to disk
 * so it survives gro restarts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Logger } from "../logger.js";
export class SummarizationQueue {
    constructor(queuePath) {
        this.queue = [];
        this.queuePath = queuePath;
        this.load();
    }
    /**
     * Add a page to the queue.
     */
    enqueue(item) {
        this.queue.push(item);
        this.persist();
        Logger.info(`[Queue] Enqueued page ${item.pageId} (${item.label})`);
    }
    /**
     * Remove up to `limit` items from the queue (FIFO).
     */
    dequeue(limit) {
        const items = this.queue.splice(0, limit);
        this.persist();
        if (items.length > 0) {
            Logger.info(`[Queue] Dequeued ${items.length} pages`);
        }
        return items;
    }
    /**
     * Get queue size without removing items.
     */
    size() {
        return this.queue.length;
    }
    /**
     * Peek at the next item without removing it.
     */
    peek() {
        return this.queue[0];
    }
    /**
     * Clear the entire queue.
     */
    clear() {
        this.queue = [];
        this.persist();
        Logger.info(`[Queue] Cleared`);
    }
    /**
     * Save queue to disk (JSONL format).
     */
    persist() {
        try {
            mkdirSync(dirname(this.queuePath), { recursive: true });
            const lines = this.queue.map((item) => JSON.stringify(item)).join("\n");
            writeFileSync(this.queuePath, lines + "\n", "utf-8");
        }
        catch (e) {
            Logger.error(`[Queue] Failed to persist queue to ${this.queuePath}:`, e);
        }
    }
    /**
     * Load queue from disk.
     */
    load() {
        if (!existsSync(this.queuePath)) {
            Logger.info(`[Queue] No existing queue at ${this.queuePath}, starting fresh`);
            return;
        }
        try {
            const content = readFileSync(this.queuePath, "utf-8");
            const lines = content.trim().split("\n");
            this.queue = lines
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line));
            Logger.info(`[Queue] Loaded ${this.queue.length} pending pages from disk`);
        }
        catch (e) {
            Logger.error(`[Queue] Failed to load queue from ${this.queuePath}:`, e);
            this.queue = [];
        }
    }
}
