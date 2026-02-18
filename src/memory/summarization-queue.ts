/**
 * SummarizationQueue — persistent queue for async batch summarization.
 * 
 * Stores pages waiting for batch summarization. Queue persists to disk
 * so it survives gro restarts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Logger } from "../logger.js";

export interface QueuedSummarization {
  pageId: string;
  label: string;
  lane?: "assistant" | "user" | "system" | "tool";
  queuedAt: number;
}

export class SummarizationQueue {
  private queue: QueuedSummarization[] = [];
  private queuePath: string;

  constructor(queuePath: string) {
    this.queuePath = queuePath;
    this.load();
  }

  /**
   * Add a page to the queue.
   */
  enqueue(item: QueuedSummarization): void {
    this.queue.push(item);
    this.persist();
    Logger.info(`[Queue] Enqueued page ${item.pageId} (${item.label})`);
  }

  /**
   * Remove up to `limit` items from the queue (FIFO).
   */
  dequeue(limit: number): QueuedSummarization[] {
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
  size(): number {
    return this.queue.length;
  }

  /**
   * Peek at the next item without removing it.
   */
  peek(): QueuedSummarization | undefined {
    return this.queue[0];
  }

  /**
   * Clear the entire queue.
   */
  clear(): void {
    this.queue = [];
    this.persist();
    Logger.info(`[Queue] Cleared`);
  }

  /**
   * Save queue to disk (JSONL format).
   */
  private persist(): void {
    try {
      mkdirSync(dirname(this.queuePath), { recursive: true });
      const lines = this.queue.map((item) => JSON.stringify(item)).join("\n");
      writeFileSync(this.queuePath, lines + "\n", "utf-8");
    } catch (e) {
      Logger.error(`[Queue] Failed to persist queue to ${this.queuePath}:`, e);
    }
  }

  /**
   * Load queue from disk.
   */
  private load(): void {
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
    } catch (e) {
      Logger.error(`[Queue] Failed to load queue from ${this.queuePath}:`, e);
      this.queue = [];
    }
  }
}
