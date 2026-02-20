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
import { SummarizationQueue } from "./summarization-queue.js";
import { AnthropicBatchClient } from "../drivers/batch/anthropic-batch.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "../logger.js";
export class BatchWorker {
    constructor(config) {
        this.activeBatches = [];
        this.running = false;
        this.processingQueue = false;
        this.pollingBatches = false;
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
    start() {
        if (this.running) {
            Logger.warn("[BatchWorker] Already running");
            return;
        }
        this.running = true;
        Logger.info("[BatchWorker] Starting");
        // Poll queue for new tasks
        this.queuePollTimer = setInterval(() => {
            if (this.processingQueue)
                return;
            this.processingQueue = true;
            this.processQueue().catch(e => Logger.error("[BatchWorker] processQueue error:", e)).finally(() => { this.processingQueue = false; });
        }, this.cfg.pollInterval);
        // Poll active batches for completion
        this.batchPollTimer = setInterval(() => {
            if (this.pollingBatches)
                return;
            this.pollingBatches = true;
            this.pollBatches().catch(e => Logger.error("[BatchWorker] pollBatches error:", e)).finally(() => { this.pollingBatches = false; });
        }, this.cfg.batchPollInterval);
        // Run immediately on start
        this.processQueue().catch(e => Logger.error("[BatchWorker] processQueue error:", e));
        this.pollBatches().catch(e => Logger.error("[BatchWorker] pollBatches error:", e));
    }
    /**
     * Stop the worker loop.
     */
    stop() {
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
    async processQueue() {
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
            try {
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
                                role: "user",
                                content: prompt,
                            },
                        ],
                    },
                };
            }
            catch (err) {
                Logger.error(`[BatchWorker] Failed to read page ${item.pageId}: ${err}`);
                return null;
            }
        }).filter((r) => r !== null);
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
        }
        catch (err) {
            Logger.error(`[BatchWorker] Failed to submit batch: ${err}`);
            // Re-queue items on failure
            items.forEach((item) => this.queue.enqueue(item));
        }
    }
    /**
     * Poll active batches for completion.
     */
    async pollBatches() {
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
                }
                else {
                    Logger.debug(`[BatchWorker] Batch ${batch.batchId} status: ${status.processing_status}`);
                }
            }
            catch (err) {
                Logger.error(`[BatchWorker] Failed to poll batch ${batch.batchId}: ${err}`);
            }
        }
    }
    /**
     * Process completed batch results — update page summaries.
     */
    async processBatchResults(batch) {
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
                try {
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
                    }
                    else {
                        Logger.error(`[BatchWorker] Batch result failed for ${pageId}: ${JSON.stringify(result.result.error)}`);
                    }
                }
                catch (err) {
                    Logger.error(`[BatchWorker] Failed to process result for page ${pageId}: ${err}`);
                }
            }
        }
        catch (err) {
            Logger.error(`[BatchWorker] Failed to process batch results for ${batch.batchId}: ${err}`);
        }
    }
    /**
     * Build summarization prompt for a page.
     */
    buildSummarizationPrompt(messages, pageId, label, lane) {
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

Summary (2-3 sentences, include 🧠 marker at the end):`;
    }
    /**
     * Extract text content from message content field.
     */
    extractTextContent(content) {
        if (typeof content === "string") {
            return content;
        }
        if (Array.isArray(content)) {
            return content
                .map((block) => {
                if (typeof block === "string")
                    return block;
                if (block.type === "text")
                    return block.text;
                if (block.type === "tool_use")
                    return `[tool: ${block.name}]`;
                if (block.type === "tool_result")
                    return `[tool result]`;
                return "";
            })
                .join(" ");
        }
        return "";
    }
}
