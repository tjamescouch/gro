/**
 * ContextMapSource — sensory channel that renders a spatial context map.
 *
 * Reads memory stats from the inner AgentMemory (via getStats()) and produces
 * a 2D spatial visualization where position, density, and shape encode
 * context window distribution. The model perceives patterns from row length
 * and fill — not from labels and numbers.
 *
 * Degrades gracefully: renders whatever stats the memory type provides.
 *
 * Target: under 300 tokens per render.
 */

import type { AgentMemory, MemoryStats, VirtualMemoryStats, PageDigestEntry } from "./agent-memory.js";
import type { SensorySource } from "./sensory-memory.js";

// --- Time bucketing helpers ---

function timeBucket(createdAt: string, now: Date): string {
  const d = new Date(createdAt);
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return "older";
}

function bucketRank(bucket: string): number {
  if (bucket === "today") return 0;
  if (bucket === "yesterday") return 1;
  if (bucket === "older") return 100;
  const m = bucket.match(/^(\d+)d ago$/);
  return m ? parseInt(m[1], 10) : 50;
}

export interface ContextMapConfig {
  /** Width of the bar chart in characters (default: 32) */
  barWidth?: number;
  /** Include individual swimlane rows (default: true) */
  showLanes?: boolean;
  /** Include page row (default: true) */
  showPages?: boolean;
}

export class ContextMapSource implements SensorySource {
  private memory: AgentMemory;
  private config: Required<ContextMapConfig>;
  /** One-shot filter for drill-down views. Cleared after next render. */
  private filter: string | null = null;

  constructor(memory: AgentMemory, config?: ContextMapConfig) {
    this.memory = memory;
    this.config = {
      barWidth: config?.barWidth ?? 32,
      showLanes: config?.showLanes ?? true,
      showPages: config?.showPages ?? true,
    };
  }

  /** Update the memory reference (e.g., after hot-swap). */
  setMemory(memory: AgentMemory): void {
    this.memory = memory;
  }

  /** Set a one-shot drill-down filter. Cleared after the next render. */
  setFilter(filter: string | null): void {
    this.filter = filter;
  }

  async poll(): Promise<string | null> {
    const result = this.render();
    // One-shot: clear filter after rendering
    if (this.filter) this.filter = null;
    return result;
  }

  destroy(): void {
    // No resources to clean up
  }

  render(): string {
    const stats = this.memory.getStats();
    return this.isVirtualStats(stats) ? this.renderVirtual(stats) : this.renderBasic(stats);
  }

  private isVirtualStats(stats: MemoryStats): stats is VirtualMemoryStats {
    return stats.type === "virtual" || stats.type === "fragmentation" || stats.type === "hnsw" || stats.type === "perfect";
  }

  // --- Virtual Memory (spatial 2D) ---

  private renderVirtual(stats: VirtualMemoryStats): string {
    const w = this.config.barWidth;
    const totalBudget = stats.workingMemoryBudget + stats.pageSlotBudget;
    if (totalBudget === 0) return this.renderBasic(stats);

    const sysTokens = stats.systemTokens;
    const pageTokens = stats.pageSlotUsed;
    const wmUsed = stats.workingMemoryUsed;
    const free = Math.max(0, totalBudget - sysTokens - pageTokens - wmUsed);

    const lines: string[] = [];

    // System prompt row (immutable — █)
    if (sysTokens > 0) {
      const chars = Math.max(1, Math.round((sysTokens / totalBudget) * w));
      lines.push(this.spatialRow("sys", chars, w, "█"));
    }

    // Page row (loaded, evictable — ▓)
    if (this.config.showPages && pageTokens > 0) {
      const chars = Math.max(1, Math.round((pageTokens / totalBudget) * w));
      lines.push(this.spatialRow("page", chars, w, "▓"));
    }

    // Lane rows (active working memory — ▒)
    if (this.config.showLanes && stats.lanes.length > 0) {
      for (const lane of stats.lanes) {
        if (lane.tokens <= 0) continue;
        const chars = Math.max(1, Math.round((lane.tokens / totalBudget) * w));
        lines.push(this.spatialRow(this.laneLabel(lane.role), chars, w, "▒"));
      }
    }

    // Free row — bar length IS the free space; no ░ padding
    const freeChars = Math.round((free / totalBudget) * w);
    const freeBar = "░".repeat(freeChars);
    const freeLabel = "free".padStart(4);
    const totalUsed = sysTokens + pageTokens + wmUsed;
    const usePct = totalBudget > 0 ? totalUsed / totalBudget : 0;
    const isLow = (free / totalBudget) < 0.2 || stats.compactionActive || usePct > stats.highRatio;
    const isHigh = usePct > 0.75 && !stats.compactionActive;
    lines.push(
      isLow ? `${freeLabel} ${freeBar}  ← LOW` :
      isHigh ? `${freeLabel} ${freeBar}  ⚠ expand budget or compact` :
      `${freeLabel} ${freeBar}`
    );

    // Stats line — one line of precision for when the model needs exact numbers
    const usedK = (totalUsed / 1000).toFixed(0);
    const budgetK = (totalBudget / 1000).toFixed(0);
    const parts: string[] = [`${usedK}K/${budgetK}K`];
    if (stats.pinnedMessages > 0) parts.push(`pin:${stats.pinnedMessages}`);
    parts.push(`pg:${stats.pagesLoaded}/${stats.pagesAvailable}`);
    if (stats.model) parts.push(this.shortModel(stats.model));
    lines.push(parts.join(" | "));

    // Page digest — compact listing of all pages with short summaries
    if (this.config.showPages && stats.pageDigest && stats.pageDigest.length > 0) {
      lines.push(this.renderPageDigest(stats.pageDigest));
    }

    return lines.join("\n");
  }

  // --- Basic Memory (spatial simplified) ---

  private renderBasic(stats: MemoryStats): string {
    const w = this.config.barWidth;
    const estimatedBudget = 128000;
    const used = stats.totalTokensEstimate;
    const free = Math.max(0, estimatedBudget - used);

    const usedChars = Math.max(used > 0 ? 1 : 0, Math.round((used / estimatedBudget) * w));
    const freeChars = Math.round((free / estimatedBudget) * w);

    const lines: string[] = [];
    lines.push(this.spatialRow("used", usedChars, w, "▒"));
    lines.push(`free ${"░".repeat(freeChars)}`);
    lines.push(`${stats.type} | ${stats.totalMessages} msgs | ~${(stats.totalTokensEstimate / 1000).toFixed(1)}K tok`);

    return lines.join("\n");
  }

  // --- Helpers ---

  /** Render a spatial row: right-aligned label + fill chars + ░ padding to width. */
  private spatialRow(label: string, filled: number, width: number, fillChar: string): string {
    const paddedLabel = label.padStart(4);
    const fill = fillChar.repeat(Math.min(filled, width));
    const pad = "░".repeat(Math.max(0, width - filled));
    return `${paddedLabel} ${fill}${pad}`;
  }

  /** Map lane role to short label for spatial rows. */
  private laneLabel(role: string): string {
    switch (role) {
      case "assistant": return "ast";
      case "user": return "usr";
      case "system": return "sys";
      case "tool": return "tool";
      default: return role.slice(0, 4);
    }
  }

  /**
   * Strip boilerplate prefixes from page summaries and truncate for compact display.
   * Removes "[Summary of N messages: ...]", "[Pending summary: ...]", timestamps in labels.
   */
  private compactSummary(summary: string, label: string, maxLen = 80): string {
    let s = summary;
    // Strip "[Summary of N messages: ...]" or truncated "[Summary of N messages: ..."
    // The closing ] may be missing if virtual-memory truncated the summary to 80 chars
    s = s.replace(/^\[Summary of \d+ messages:[^\]]*\]?\s*/i, "");
    // Strip "[Pending summary: ...]" (same truncation-safe pattern)
    s = s.replace(/^\[Pending summary:[^\]]*\]?\s*/i, "");
    // Strip leading "..." left by truncation
    s = s.replace(/^\.{3}\s*/, "");
    // If nothing left, derive from label
    if (!s || s.length < 3) {
      // Strip ISO timestamps from label for compactness
      s = label.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*-?\s*/g, "").trim();
      if (!s) s = label;
    }
    return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
  }

  /** Render page digest as a time-grouped tree the agent can browse and ref from. */
  private renderPageDigest(pages: PageDigestEntry[]): string {
    const now = new Date();
    const filter = this.filter;

    // Build page collections
    const loaded: PageDigestEntry[] = [];
    const unloaded: PageDigestEntry[] = [];
    let totalTokens = 0;

    for (const p of pages) {
      if (p.loaded || p.pinned) loaded.push(p);
      else unloaded.push(p);
      if (p.loaded) totalTokens += p.tokens;
    }

    const budgetK = "18"; // page slot budget ~18K
    const usedK = (totalTokens / 1000).toFixed(1);

    // --- Single page drill-down ---
    if (filter && this.isPageIdFilter(filter, pages)) {
      const page = pages.find(p => p.id === filter);
      if (page) return this.renderSinglePage(page, pages.length, loaded.length, usedK, budgetK);
    }

    const lines: string[] = [`pages: ${pages.length} total, ${loaded.length} loaded (${usedK}K/${budgetK}K budget)`];

    // Loaded/pinned pages always shown individually
    for (const p of loaded) {
      const status = p.loaded ? "★" : "📌";
      const tokK = (p.tokens / 1000).toFixed(1);
      lines.push(`  ${status} ${p.id} (${tokK}K) ${this.compactSummary(p.summary, p.label)}`);
    }

    // Group unloaded by time bucket
    if (unloaded.length > 0) {
      const buckets = new Map<string, PageDigestEntry[]>();
      const bucketOrder: string[] = [];
      for (const p of unloaded) {
        const bucket = timeBucket(p.createdAt, now);
        if (!buckets.has(bucket)) {
          buckets.set(bucket, []);
          bucketOrder.push(bucket);
        }
        buckets.get(bucket)!.push(p);
      }

      // Sort bucket order: today first, then yesterday, then Nd ago ascending, then older
      bucketOrder.sort((a, b) => bucketRank(a) - bucketRank(b));

      if (filter === "full") {
        // Full mode: expand all buckets (cap per bucket to stay within budget)
        for (const bucket of bucketOrder) {
          const items = buckets.get(bucket)!;
          lines.push(`  ${bucket} (${items.length}):`);
          const shown = items.slice(0, 15);
          for (const p of shown) {
            lines.push(`    · ${p.id} ${this.compactSummary(p.summary, p.label, 40)}`);
          }
          if (items.length > 15) lines.push(`    +${items.length - 15} more`);
        }
      } else if (filter && this.isTimeBucketFilter(filter)) {
        // Time bucket filter: expand only matching bucket, collapse others
        for (const bucket of bucketOrder) {
          const items = buckets.get(bucket)!;
          if (bucket === filter) {
            lines.push(`  ${bucket} (${items.length}):`);
            for (const p of items) {
              lines.push(`    · ${p.id} (${(p.tokens / 1000).toFixed(1)}K) ${this.compactSummary(p.summary, p.label)}`);
            }
          } else {
            lines.push(`  ${bucket} (${items.length})`);
          }
        }
      } else {
        // Normal mode: expand most recent bucket only (up to 5 entries)
        let firstBucketExpanded = false;
        for (const bucket of bucketOrder) {
          const items = buckets.get(bucket)!;
          if (!firstBucketExpanded) {
            firstBucketExpanded = true;
            lines.push(`  ${bucket} (${items.length}):`);
            const shown = items.slice(0, 5);
            for (const p of shown) {
              lines.push(`    · ${p.id} (${(p.tokens / 1000).toFixed(1)}K) ${this.compactSummary(p.summary, p.label)}`);
            }
            if (items.length > 5) lines.push(`    +${items.length - 5} more`);
          } else {
            lines.push(`  ${bucket} (${items.length})`);
          }
        }
      }
    }

    // Hint line — compact syntax reminder
    if (filter) {
      lines.push(`@@view('context')@@ to reset`);
    } else {
      lines.push(`view('context:today|full|pg_id')`);
    }
    return lines.join("\n");
  }

  /** Render detailed view of a single page. */
  private renderSinglePage(
    page: PageDigestEntry,
    totalPages: number,
    loadedCount: number,
    usedK: string,
    budgetK: string,
  ): string {
    const lines: string[] = [];
    lines.push(`page detail: ${page.id} (${totalPages} total, ${loadedCount} loaded)`);
    lines.push(`  label: ${page.label}`);
    lines.push(`  tokens: ${(page.tokens / 1000).toFixed(1)}K`);
    lines.push(`  status: ${page.loaded ? "loaded ★" : page.pinned ? "pinned 📌" : "unloaded"}`);
    lines.push(`  created: ${page.createdAt}`);
    lines.push(`  summary: ${page.summary}`);
    if (page.loaded) {
      lines.push(`  unload: @@unref('${page.id}')@@  back: @@view('context')@@`);
    } else {
      lines.push(`  load: @@ref('${page.id}')@@  back: @@view('context')@@`);
    }
    return lines.join("\n");
  }

  /** Check if a filter string matches a time bucket name. */
  private isTimeBucketFilter(filter: string): boolean {
    return filter === "today" || filter === "yesterday" || filter === "older" || /^\d+d ago$/.test(filter);
  }

  /** Check if a filter string looks like a page ID (exists in pages list). */
  private isPageIdFilter(filter: string, pages: PageDigestEntry[]): boolean {
    return pages.some(p => p.id === filter);
  }

  private shortModel(model: string): string {
    if (model.includes("opus")) return "opus";
    if (model.includes("sonnet")) return "sonnet";
    if (model.includes("haiku")) return "haiku";
    if (model.includes("gpt-4")) return "gpt4";
    if (model.includes("gpt-3")) return "gpt3";
    if (model.includes("llama")) return "llama";
    if (model.includes("gemini")) return "gemini";
    return model.length > 12 ? model.slice(0, 12) : model;
  }
}
