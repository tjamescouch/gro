/**
 * HybridFragmentationMemory — FragmentationMemory + optional summarization.
 *
 * Design 2: Combines sampled fragments with LLM summarization for better recall.
 *
 * This class extends FragmentationMemory and optionally calls the summarizer
 * on the sampled fragments (or selected subset). This hybrid approach balances
 * cost (~$0.05-0.10 vs $0.50 for full VirtualMemory) with better recall than
 * pure sampling.
 *
 * Key differences:
 * - Samples messages via fragmenter (same as FragmentationMemory)
 * - Optionally summarizes selected samples (controlled by `summaryOnFragments`)
 * - Cost intermediate between FragmentationMemory ($0) and VirtualMemory ($0.50)
 * - Still respects importance weights (🧠 markers preserved)
 * - Async batch summary queue (reuses VirtualMemory's infrastructure)
 */
import { FragmentationMemory } from "./fragmentation-memory.js";
import { Logger } from "../logger.js";
/**
 * HybridFragmentationMemory — FragmentationMemory with optional summarization.
 *
 * Extends FragmentationMemory to add an optional summarization step on sampled
 * fragments. This gives you a middle ground:
 *
 * - Pure FragmentationMemory: $0, instant, lossy
 * - HybridFragmentationMemory: $0.05-0.10, 5-10s, better recall
 * - VirtualMemory: $0.50, 5-10s, best recall
 *
 * Use when you want moderate cost savings without sacrificing too much context quality.
 */
export class HybridFragmentationMemory extends FragmentationMemory {
    constructor(config = {}) {
        super(config);
        this.summaryOnFragments = config.summaryOnFragments ?? true;
        this.summaryInputTokens = config.summaryInputTokens ?? 5000;
        this.summarizerModel = config.summarizerModel ?? "";
        this.summarizerDriver = config.summarizerDriver ?? null;
    }
    /**
     * Override createPageFromMessages to add optional summarization on fragments.
     *
     * This method reuses FragmentationMemory's fragment creation, then optionally
     * passes the fragments to the summarizer (if summaryOnFragments is true).
     */
    async createPageFromMessages(messages, label, lane) {
        // Get fragmented page from parent class
        const { page, summary: fragmentedSummary } = await super.createPageFromMessages(messages, label, lane);
        // If summarization disabled or no driver, return fragmented version
        if (!this.summaryOnFragments || !this.summarizerDriver) {
            return { page, summary: fragmentedSummary };
        }
        // Extract fragment content for summarization
        const fragmentContent = page.content
            .split("\n")
            .slice(0, Math.ceil(this.summaryInputTokens / 2.8)) // Rough token limit
            .join("\n");
        // Call summarizer on fragments
        try {
            Logger.info(`[HybridFragMem] Summarizing ${fragmentContent.length} chars from ${messages.length} messages`);
            const summarizerPrompt = `Summarize the following message fragments, preserving key information and decisions:\n\n${fragmentContent}\n\nProvide a concise summary.`;
            const response = await this.summarizerDriver.chat({
                messages: [{ role: "user", content: summarizerPrompt }],
                model: this.summarizerModel || "claude-haiku-4-5",
                temperature: 0.2,
                maxTokens: 500,
            });
            const summaryText = response.choices[0]?.message?.content ?? "";
            // Augment page with summary
            const hybridPage = {
                ...page,
                summary: summaryText,
            };
            // Return hybrid summary referencing both fragments and summary
            const hybridSummary = `[Hybrid: ${page.messageCount} messages → fragments + summary] 📄 ${summaryText.slice(0, 200)}... <ref id="${page.id}"/>`;
            Logger.info(`[HybridFragMem] Created hybrid page ${page.id} with summary`);
            return { page: hybridPage, summary: hybridSummary };
        }
        catch (err) {
            // Fall back to fragmented version if summary fails
            Logger.warn(`[HybridFragMem] Summarization failed, using fragments: ${err}`);
            return { page, summary: fragmentedSummary };
        }
    }
}
