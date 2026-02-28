/**
 * SemanticRetrieval — orchestrator for automatic and explicit page retrieval.
 *
 * Connects EmbeddingProvider, PageSearchIndex, and VirtualMemory:
 * - Auto-retrieval: before each turn, find semantically relevant pages
 * - Explicit search: @@ref('?query')@@ triggers semantic search
 * - Backfill: index existing pages on startup (only those with summaries)
 * - Live indexing: hook into VirtualMemory.onPageCreated for new pages
 */

import { createHash } from "node:crypto";
import { Logger } from "../logger.js";
import type { PageSearchIndex, PageSearchResult } from "./page-search-index.js";
import type { ChatMessage } from "../drivers/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal interface for VirtualMemory — avoids direct import to keep decoupled. */
interface PageMemory {
  ref(id: string): void;
  getActivePageIds(): string[];
  getPages(): Array<{ id: string; label: string; tokens: number; summary?: string }>;
  /** Remaining token budget in the page slot. */
  getPageSlotBudgetRemaining(): number;
  /** Pages the agent explicitly unref'd — auto-fill skips these. */
  getUnrefHistory(): Set<string>;
}

export interface SemanticRetrievalConfig {
  memory: PageMemory;
  searchIndex: PageSearchIndex;
  /** Enable auto-retrieval before each turn (default: true) */
  autoRetrievalEnabled?: boolean;
  /**
   * Max pages to auto-load per turn (default: 1).
   * Pressure valve — prevents retrieval from flooding the context window.
   * If you find one isn't enough, this is an easy knob to turn.
   */
  maxAutoPages?: number;
  /** Similarity threshold for auto-retrieval (default: 0.5). Silence > noise. */
  autoThreshold?: number;
  /** Similarity threshold for explicit search (default: 0.4) */
  searchThreshold?: number;
  /** Max results for explicit search (default: 5) */
  searchMaxResults?: number;
  /** Max pages to auto-fill per turn (inline harvest + semantic). Default: 3 */
  maxAutoFillPages?: number;
  /** Fraction of remaining page slot budget to use for auto-fill (0.0-1.0). Default: 0.7 */
  autoFillBudgetFraction?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Build a query string from recent messages.
 * Uses the last user message; if too short (<20 chars, e.g. "continue", "go"),
 * falls back to the last assistant message for grounding.
 */
function buildQuery(messages: ChatMessage[]): string | null {
  let lastUser = "";
  let lastAssistant = "";

  // Walk backwards to find the most recent user and assistant messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!lastUser && msg.role === "user" && content.trim()) {
      lastUser = content.trim();
    }
    if (!lastAssistant && msg.role === "assistant" && content.trim()) {
      lastAssistant = content.trim();
    }
    if (lastUser && lastAssistant) break;
  }

  if (!lastUser && !lastAssistant) return null;

  // If user message is short, supplement with assistant context
  if (lastUser.length < 20 && lastAssistant) {
    return (lastUser + " " + lastAssistant.slice(0, 300)).trim();
  }

  return lastUser.slice(0, 500);
}

// ---------------------------------------------------------------------------
// SemanticRetrieval
// ---------------------------------------------------------------------------

export class SemanticRetrieval {
  private memory: PageMemory;
  private searchIndex: PageSearchIndex;
  private autoEnabled: boolean;
  private maxAutoPages: number;
  private autoThreshold: number;
  private searchThreshold: number;
  private searchMaxResults: number;
  private maxAutoFillPages: number;
  private autoFillBudgetFraction: number;
  private lastQueryHash = "";
  private lastFillHash = "";
  /** Mutex: true while a batch re-summarization is running. Prevents concurrent backfill. */
  private _batchRunning = false;

  constructor(config: SemanticRetrievalConfig) {
    this.memory = config.memory;
    this.searchIndex = config.searchIndex;
    this.autoEnabled = config.autoRetrievalEnabled ?? true;
    this.maxAutoPages = config.maxAutoPages ?? 1;
    this.autoThreshold = config.autoThreshold ?? 0.5;
    this.searchThreshold = config.searchThreshold ?? 0.4;
    this.searchMaxResults = config.searchMaxResults ?? 5;
    this.maxAutoFillPages = config.maxAutoFillPages ?? 3;
    this.autoFillBudgetFraction = config.autoFillBudgetFraction ?? 0.7;
  }

  get available(): boolean {
    return this.searchIndex.size > 0;
  }

  get batchRunning(): boolean { return this._batchRunning; }
  set batchRunning(v: boolean) { this._batchRunning = v; }

  /** Atomically swap the live search index (used by BatchSummarizer after double-buffer build). */
  swapIndex(newIndex: PageSearchIndex): void {
    this.searchIndex = newIndex;
    Logger.telemetry(`[SemanticRetrieval] Index swapped (${newIndex.size} entries)`);
  }

  /** Expose the current search index (for BatchSummarizer to clone). */
  getSearchIndex(): PageSearchIndex { return this.searchIndex; }

  // --- Auto-retrieval (called before each turn) ---

  async autoRetrieve(messages: ChatMessage[]): Promise<string | null> {
    if (!this.autoEnabled || this.searchIndex.size === 0) return null;

    const query = buildQuery(messages);
    if (!query) return null;

    // Skip if query hasn't changed (e.g. during tool loops)
    const hash = hashText(query);
    if (hash === this.lastQueryHash) return null;
    this.lastQueryHash = hash;

    try {
      const results = await this.searchIndex.search(query, 3, this.autoThreshold);
      if (results.length === 0) return null;

      // Filter out already-loaded pages (dedup with @@ref@@)
      const activeIds = new Set(this.memory.getActivePageIds());
      const unloaded = results.filter(r => !activeIds.has(r.pageId));
      if (unloaded.length === 0) return null;

      // Load the best match (cap: maxAutoPages per turn)
      const toLoad = unloaded.slice(0, this.maxAutoPages);
      for (const r of toLoad) {
        this.memory.ref(r.pageId);
        Logger.telemetry(
          `[SemanticRetrieval] Auto-loading page ${r.pageId} (${r.label}, score=${r.score.toFixed(3)})`
        );
      }

      return toLoad[0].pageId;
    } catch (err) {
      Logger.warn(`[SemanticRetrieval] Auto-retrieval error: ${err}`);
      return null;
    }
  }

  // --- Auto-fill page slots (replaces autoRetrieve at call site) ---

  /**
   * Multi-phase page slot filling:
   * 1. Inline ref harvesting — scan working memory for @@ref('id')@@ patterns
   * 2. Semantic budget fill — load additional pages by similarity to frontal context
   *
   * Respects unref history, page slot token budget, and change detection.
   */
  async autoFillPageSlots(messages: ChatMessage[]): Promise<{
    harvestedIds: string[];
    semanticIds: string[];
  } | null> {
    if (!this.autoEnabled) return null;

    // Change detection: skip if working memory hasn't changed
    const contentSample = messages.slice(-6).map(m => String(m.content ?? "").slice(0, 200)).join("|");
    const fillHash = hashText(contentSample);
    if (fillHash === this.lastFillHash) return null;
    this.lastFillHash = fillHash;

    const activeIds = new Set(this.memory.getActivePageIds());
    const unrefHistory = this.memory.getUnrefHistory();
    const allPages = this.memory.getPages();
    const pageMap = new Map(allPages.map(p => [p.id, p]));
    let budgetRemaining = this.memory.getPageSlotBudgetRemaining() * this.autoFillBudgetFraction;

    const harvestedIds: string[] = [];
    const semanticIds: string[] = [];
    let totalLoaded = 0;

    // --- Phase 1: Inline ref harvesting ---
    // Scan working memory for @@ref('id')@@ patterns embedded in compaction summaries.
    // If a summary mentions a page, that page is likely relevant — auto-ref it.
    const refPattern = /@@ref\('([^']+)'\)@@/g;
    const referencedIds = new Set<string>();

    for (const msg of messages) {
      const content = String(msg.content ?? "");
      let match;
      while ((match = refPattern.exec(content)) !== null) {
        const ids = match[1].split(",").map(s => s.trim()).filter(Boolean);
        for (const id of ids) {
          if (!id.startsWith("?")) referencedIds.add(id);
        }
      }
    }

    for (const id of referencedIds) {
      if (activeIds.has(id)) continue;
      if (unrefHistory.has(id)) continue;
      if (totalLoaded >= this.maxAutoFillPages) break;

      const page = pageMap.get(id);
      if (!page) continue;
      if (page.tokens > budgetRemaining) continue;

      this.memory.ref(id);
      activeIds.add(id);
      budgetRemaining -= page.tokens;
      totalLoaded++;
      harvestedIds.push(id);
      Logger.telemetry(`[AutoFill] Inline harvest: ${id} (${page.label})`);
    }

    // --- Phase 2: Semantic budget fill ---
    if (totalLoaded < this.maxAutoFillPages && budgetRemaining > 0 && this.searchIndex.size > 0) {
      const query = buildQuery(messages);
      if (query) {
        const queryHash = hashText(query);
        // Only search if the query is fresh (different from last autoRetrieve)
        if (queryHash !== this.lastQueryHash) {
          this.lastQueryHash = queryHash;

          try {
            const maxSemantic = this.maxAutoFillPages - totalLoaded;
            const results = await this.searchIndex.search(
              query,
              maxSemantic + 3, // over-fetch for filtering
              this.autoThreshold,
            );

            for (const r of results) {
              if (totalLoaded >= this.maxAutoFillPages) break;
              if (activeIds.has(r.pageId)) continue;
              if (unrefHistory.has(r.pageId)) continue;

              const page = pageMap.get(r.pageId);
              if (!page) continue;
              if (page.tokens > budgetRemaining) continue;

              this.memory.ref(r.pageId);
              activeIds.add(r.pageId);
              budgetRemaining -= page.tokens;
              totalLoaded++;
              semanticIds.push(r.pageId);
              Logger.telemetry(
                `[AutoFill] Semantic fill: ${r.pageId} (${r.label}, score=${r.score.toFixed(3)})`,
              );
            }
          } catch (err) {
            Logger.warn(`[AutoFill] Semantic fill error: ${err}`);
          }
        }
      }
    }

    if (totalLoaded === 0) return null;
    return { harvestedIds, semanticIds };
  }

  // --- Explicit search (triggered by @@ref('?query')@@) ---

  async search(query: string): Promise<PageSearchResult[]> {
    try {
      const results = await this.searchIndex.search(query, this.searchMaxResults, this.searchThreshold);

      // Load unloaded results
      const activeIds = new Set(this.memory.getActivePageIds());
      for (const r of results) {
        if (!activeIds.has(r.pageId)) {
          this.memory.ref(r.pageId);
        }
      }

      return results;
    } catch (err) {
      Logger.warn(`[SemanticRetrieval] Search error: ${err}`);
      return [];
    }
  }

  // --- Live indexing hook ---

  async onPageCreated(pageId: string, summary: string, label: string): Promise<void> {
    await this.searchIndex.indexPage(pageId, summary, label);
  }

  // --- Backfill existing pages ---

  async backfill(): Promise<number> {
    if (this._batchRunning) {
      Logger.telemetry("[SemanticRetrieval] Backfill skipped — batch re-summarization in progress");
      return 0;
    }
    const allPages = this.memory.getPages();
    const allIds = allPages.map(p => p.id);
    const missing = this.searchIndex.getMissingPageIds(allIds);
    if (missing.length === 0) return 0;

    const missingSet = new Set(missing);
    const toIndex: Array<{ pageId: string; text: string; label: string }> = [];
    let skipped = 0;

    for (const page of allPages) {
      if (!missingSet.has(page.id)) continue;

      // Only embed pages with coherent summaries — skip broken/incomplete pages
      if (!page.summary) {
        skipped++;
        continue;
      }

      toIndex.push({ pageId: page.id, text: page.summary, label: page.label });
    }

    if (toIndex.length > 0) {
      await this.searchIndex.indexPages(toIndex);
      this.searchIndex.save();
    }

    if (skipped > 0) {
      Logger.telemetry(`[SemanticRetrieval] Backfill: skipped ${skipped} pages without summaries`);
    }

    return toIndex.length;
  }

  // --- Persistence ---

  saveIndex(): void {
    this.searchIndex.save();
  }
}
