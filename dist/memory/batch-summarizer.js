/**
 * BatchSummarizer — async batch summarization for VirtualMemory pages
 * Uses Anthropic Batch API (50% cost discount) to summarize pages out-of-band.
 * Decouples summarization from agent turns, keeps main loop unblocked.
 */
/**
 * BatchSummarizer submits VirtualMemory page content to Anthropic Batch API
 * for async summarization. Results are polled and merged back into pages.
 */
export class BatchSummarizer {
    constructor(config = {}) {
        this.pendingBatchIds = new Map(); // batchId -> pageIds
        this.config = {
            batchSize: config.batchSize ?? 10,
            model: config.model ?? 'claude-haiku-4-5',
            outputDir: config.outputDir ?? '.gro/batch-results',
        };
    }
    /**
     * Submit pages for async summarization.
     * Returns a batch ID that can be polled via checkResults().
     */
    async submitBatch(requests) {
        // Placeholder: integrate with Anthropic Batch API
        // POST /v1/messages/batches with array of requests
        const batchId = `batch_${Date.now()}`;
        this.pendingBatchIds.set(batchId, requests.map(r => r.pageId));
        return batchId;
    }
    /**
     * Poll for completed batch results.
     * Returns completed summaries; pending items return null.
     */
    async checkResults(batchId) {
        // Placeholder: GET /v1/messages/batches/{batchId}/results
        const pageIds = this.pendingBatchIds.get(batchId) ?? [];
        return pageIds.map(() => null); // pending
    }
    /**
     * Check if all items in a batch are complete.
     */
    async isComplete(batchId) {
        const results = await this.checkResults(batchId);
        return results.every(r => r !== null);
    }
    get pendingCount() {
        return this.pendingBatchIds.size;
    }
}
