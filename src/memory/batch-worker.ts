/**
 * BatchWorker — background worker for processing queued batch summarization requests.
 * 
 * Workflow:
 * 1. Poll queue for pending summarization tasks
 * 2. Batch pages into Anthropic Batch API requests
 * 3. Submit batches and track batch IDs
 * 4. Poll batch status until complete (5min-24hr)
 * 5. Extract results and update page summaries on disk
 * 
 * This runs independently of gro main loop — can be a separate process
 * or integrated as a background thread.
 */

import { SummarizationQueue, QueuedSummarization } from "./summarization-queue.js";
import { AnthropicBatchClient } from "../drivers/batch/anthropic-batch.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "../logger.js";

export interface BatchWorkerConfig {
  queuePath: string;
  pagesDir: string;
  apiKey: string;
  /**
   * How often to poll the queue for new tasks (ms).
   * Default: 60000 (1 minute)
   */
  pollInterval?: number;
  /**
   * How often to check batch status for in-progress batches (ms).
   * Default: 300000 (5 minutes)
   */
  batchPollInterval?: number;
  /**
   * Max pages per batch request.
   * Default: 10000 (Anthropic Batch API limit)
   */
  batchSize?: number;
  /**
   * Model to use for summarization.
   * Default: "claude-haiku-4-5"
   */
  model?: string;
}

interface TrackedBatch {
  batchId: string;
  pageIds: string[];
  submittedAt: number;
}

export class BatchWorker {
  private queue: SummarizationQueue;
  private client: AnthropicBatchClient;
  private cfg: Required<BatchWorkerConfig>;
  private activeBatches: TrackedBatch[] = [];
  private running = false;
  private queuePollTimer?: NodeJS.Timeout;
  private batchPollTimer?: NodeJS.Timeout;

  constructor(config: BatchWorkerConfig) {
    this.cfg = {
      pollInterval: 60000,
      batchPollInterval: 300000,
      batchSize: 10000,
      model: "claude-haiku-4-5",
      ...config,
    };

    this.queue = new SummarizationQueue(this.cfg.queuePath);
    this.client = new AnthropicBatchClient(this.cfg.apiKey);
  }

  /**
   * Start the worker loop.
   */
  start(): void {
    if (this.running) {
      Logger.warn("[BatchWorker] Already running");
      return;
    }

    this.running = true;
    Logger.info("[BatchWorker] Starting");

    // Poll queue for new tasks
    this.queuePollTimer = setInterval(() => {
      this.processQueue();
    }, this.cfg.pollInterval);

    // Poll active batches for completion
    this.batchPollTimer = setInterval(() => {
      this.pollBatches();
    }, this.cfg.batchPollInterval);

    // Run immediately on start
    this.processQueue();
    this.pollBatches();
  }

  /**
   * Stop the worker loop.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    Logger.info("[BatchWorker] Stopping");

    if (this.queuePollTimer) {
      clearInterval(this.queuePollTimer);
      this.queuePollTimer = undefined;
    }

    if (this.batchPollTimer) {
      clearInterval(this.batchPollTimer);
      this.batchPollTimer = undefined;
    }
  }

  /**
   * Process queued summarization tasks — submit new batches.
   */
  private async processQueue(): Promise<void> {
    if (this.queue.size() === 0) {
      return;
    }

    Logger.info(`[BatchWorker] Processing queue (${this.queue.size()} items)`);

    // Dequeue up to batchSize items
    const items = this.queue.dequeue(this.cfg.batchSize);
    if (items.length === 0) {
      return;
    }

    // Build batch requests
    const requests = items.map((item) => {
      const pagePath = join(this.cfg.pagesDir, `${item.pageId}.json`);
      if (!existsSync(pagePath)) {
        Logger.warn(`[BatchWorker] Page not found: ${item.pageId}`);
        return null;
      }

      const pageData = JSON.parse(readFileSync(pagePath, "utf-8"));
      const messages = pageData.messages || [];

      // Construct summarization prompt
      const prompt = this.buildSummarizationPrompt(messages, item.pageId, item.label, item.lane);

      return {
        custom_id: item.pageId,
        params: {
          model: this.cfg.model,
          max_tokens: 1000,
          messages: [
            {
              role: "user" as const,
              content: prompt,
            },
          ],
        },
      };
    }).filter((r): r is NonNullable<typeof r> => r !== null);

    if (requests.length === 0) {
      Logger.warn("[BatchWorker] No valid requests to submit");
      return;
    }

    // Submit batch
    try {
      const batchId = await this.client.submitBatch(requests);
      Logger.info(`[BatchWorker] Submitted batch ${batchId} (${requests.length} requests)`);

      // Track batch
      this.activeBatches.push({
        batchId,
        pageIds: requests.map((r) => r.custom_id),
        submittedAt: Date.now(),
      });
    } catch (err) {
      Logger.error(`[BatchWorker] Failed to submit batch: ${err}`);
      // Re-queue items on failure
      items.forEach((item) => this.queue.enqueue(item));
    }
  }

  /**
   * Poll active batches for completion.
   */
  private async pollBatches(): Promise<void> {
    if (this.activeBatches.length === 0) {
      return;
    }

    Logger.info(`[BatchWorker] Polling ${this.activeBatches.length} active batches`);

    for (const batch of [...this.activeBatches]) {
      try {
        const status = await this.client.getBatchStatus(batch.batchId);

        if (status.processing_status === "ended") {
          Logger.info(`[BatchWorker] Batch ${batch.batchId} complete`);
          await this.processBatchResults(batch);

          // Remove from active list
          this.activeBatches = this.activeBatches.filter((b) => b.batchId !== batch.batchId);
        } else {
          Logger.debug(`[BatchWorker] Batch ${batch.batchId} status: ${status.processing_status}`);
        }
      } catch (err) {
        Logger.error(`[BatchWorker] Failed to poll batch ${batch.batchId}: ${err}`);
      }
    }
  }

  /**
   * Process completed batch results — update page summaries.
   */
  private async processBatchResults(batch: TrackedBatch): Promise<void> {
    try {
      // First get status to retrieve results_url
      const status = await this.client.getBatchStatus(batch.batchId);
      if (!status.results_url) {
        Logger.error(`[BatchWorker] No results_url for batch ${batch.batchId}`);
        return;
      }
      const results = await this.client.downloadResults(status.results_url);

      for (const result of results) {
        const pageId = result.custom_id;
        const pagePath = join(this.cfg.pagesDir, `${pageId}.json`);

        if (!existsSync(pagePath)) {
          Logger.warn(`[BatchWorker] Page not found for result: ${pageId}`);
          continue;
        }

        if (result.result.type === "succeeded") {
          const summary = result.result.message?.content?.[0]?.text || "";

          // Update page summary
          const pageData = JSON.parse(readFileSync(pagePath, "utf-8"));
          pageData.summary = summary;
          writeFileSync(pagePath, JSON.stringify(pageData, null, 2));

          Logger.info(`[BatchWorker] Updated page ${pageId} with batch summary`);
        } else {
          Logger.error(`[BatchWorker] Batch result failed for ${pageId}: ${JSON.stringify(result.result.error)}`);
        }
      }
    } catch (err) {
      Logger.error(`[BatchWorker] Failed to process batch results for ${batch.batchId}: ${err}`);
    }
  }

  /**
   * Build summarization prompt for a page.
   */
  private buildSummarizationPrompt(
    messages: any[],
    pageId: string,
    label: string,
    lane?: "assistant" | "user" | "system" | "tool"
  ): string {
    const laneLabel = lane ? ` (${lane} lane)` : "";
    const msgCount = messages.length;

    let transcript = messages
      .map((m) => {
        const role = m.role || "unknown";
        const content = this.extractTextContent(m.content);
        return `[${role}] ${content}`;
      })
      .join("\n\n");

    // Truncate if too long (batch requests have token limits)
    const maxChars = 8000;
    if (transcript.length > maxChars) {
      transcript = transcript.slice(0, maxChars) + "\n... (truncated)";
    }

    return `Summarize this conversation context for a memory page reference. Be concise but capture key decisions, outcomes, and unresolved questions.

Page ID: ${pageId}
Label: ${label}${laneLabel}
Messages: ${msgCount}

Transcript:
${transcript}

Summary (2-3 sentences, include  marker at the end):`;
  }

  /**
   * Extract text content from message content field.
   */
  private extractTextContent(content: any): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === "string") return block;
          if (block.type === "text") return block.text;
          if (block.type === "tool_use") return `[tool: ${block.name}]`;
          if (block.type === "tool_result") return `[tool result]`;
          return "";
        })
        .join(" ");
    }
    return "";
  }
}
