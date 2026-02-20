/**
 * FragmentationMemory — VirtualMemory with pluggable fragmentation instead of summarization.
 *
 * Extends VirtualMemory but overrides page creation to use a Fragmenter instead
 * of LLM-based summarization. This avoids the cost and latency of summarization
 * while still achieving context compaction through smart sampling.
 *
 * Key differences from VirtualMemory:
 * - No LLM calls during paging (zero cost)
 * - Pages contain sampled messages, not summaries
 * - Fragmenter is pluggable (e.g., RandomSamplingFragmenter, ImportanceFragmenter)
 * - Faster paging (no API latency)
 */
import { VirtualMemory } from "./virtual-memory.js";
import { RandomSamplingFragmenter } from "./random-sampling-fragmenter.js";
import { Logger } from "../logger.js";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
/**
 * FragmentationMemory — VirtualMemory with fragmenter-based paging.
 *
 * This class extends VirtualMemory and overrides the page creation logic
 * to use a Fragmenter instead of LLM summarization. The base VirtualMemory
 * class handles all the swimlane partitioning, importance weighting, and
 * page slot management. We only override the page content generation.
 */
export class FragmentationMemory extends VirtualMemory {
    constructor(config = {}) {
        // Convert FragmentationMemoryConfig to VirtualMemoryConfig by adding
        // null driver and empty summarizerModel (we won't use them)
        const vmConfig = {
            ...config,
            driver: null, // Cast to satisfy type — we override createPageFromMessages
            summarizerModel: "", // Won't be used
        };
        super(vmConfig);
        this.fragmenter = config.fragmenter ?? new RandomSamplingFragmenter();
        this.fragmenterConfig = config.fragmenterConfig ?? {};
        this.pagesDir = config.pagesDir ?? join(process.env.HOME ?? "/tmp", ".gro", "pages");
        this.avgCharsPerToken = config.avgCharsPerToken ?? 2.8;
    }
    /**
     * Override createPageFromMessages to use fragmenter instead of summarization.
     *
     * This method is called by VirtualMemory's onAfterAdd when it's time to
     * page out older messages. Instead of calling an LLM to generate a summary,
     * we use the fragmenter to sample/compress the messages.
     */
    async createPageFromMessages(messages, label, lane) {
        // Use fragmenter to create sampled representation
        const fragments = this.fragmenter.fragment(messages, this.fragmenterConfig);
        // Build page content from fragments
        const fragmentedContent = fragments.map((frag, idx) => {
            const header = `--- Fragment ${idx + 1}/${fragments.length} (${frag.metadata.count} messages, pos ${frag.metadata.position}) ---`;
            const msgLines = frag.messages.map(m => `[${m.role}${m.from ? ` (${m.from})` : ""}]: ${String(m.content ?? "").slice(0, 500)}`);
            return `${header}\n${msgLines.join("\n\n")}`;
        }).join("\n\n");
        // Track max importance across messages
        const maxImportance = messages.reduce((max, m) => Math.max(max, m.importance ?? 0), 0);
        // Generate page ID
        const pageId = "pg_" + createHash("sha256").update(fragmentedContent).digest("hex").slice(0, 12);
        const page = {
            id: pageId,
            label,
            content: fragmentedContent,
            createdAt: new Date().toISOString(),
            messageCount: messages.length,
            tokens: Math.ceil(fragmentedContent.length / this.avgCharsPerToken),
            ...(maxImportance > 0 ? { maxImportance } : {}),
        };
        // Save page to disk
        mkdirSync(this.pagesDir, { recursive: true });
        const pagePath = join(this.pagesDir, `${page.id}.json`);
        writeFileSync(pagePath, JSON.stringify(page, null, 2) + "\n");
        // Register page in parent's page map (access via any cast)
        this.pages.set(page.id, page);
        // Generate inline summary with ref
        const samplingStats = `${fragments.length} fragments, ${fragments.reduce((sum, f) => sum + f.metadata.count, 0)} sampled from ${messages.length}`;
        const summary = `[Fragmented: ${samplingStats}, ${label}] <ref id="${pageId}"/>`;
        Logger.info(`[FragMem] Created page ${pageId}: ${samplingStats}`);
        return { page, summary };
    }
}
