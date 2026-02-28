/**
 * ContextMapSource — sensory channel that renders a spatial context map.
 *
 * Default view: composite fill bar + page symbol grid.
 *   Line 1: Single composite bar — █ sys, ▓ page, ▒ wm, ░ free + stats
 *   Line 2: Key metrics (pin count, pages, model, fill %)
 *   Lines 3+: Page grid — each cell is a symbol (█ loaded, · unloaded, ◆ pinned, ! important)
 *   Last 2 lines: Legend + drill-down hint
 *
 * Drill-down filters (context:today, context:full, context:pg_id) render
 * detailed page info into the same grid, truncated to fit.
 *
 * Degrades gracefully: renders whatever stats the memory type provides.
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
  /** Width of the composite bar in characters (default: 32) */
  barWidth?: number;
  /** Include page grid (default: true) */
  showPages?: boolean;
  /** Character budget for the rendered output (default: 0 = unlimited) */
  maxChars?: number;
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
      showPages: config?.showPages ?? true,
      maxChars: config?.maxChars ?? 0,
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

  /** Dynamically update the character budget (e.g., during full-screen expand). */
  setMaxChars(maxChars: number): void {
    this.config.maxChars = maxChars;
  }

  async poll(): Promise<string | null> {
    const result = this.render();
    // One-shot: clear filter after rendering
    if (this.filter) this.filter = null;
    return result;
  }

  destroy(): void {}

  render(): string {
    const stats = this.memory.getStats();
    return this.isVirtualStats(stats) ? this.renderVirtual(stats) : this.renderBasic(stats);
  }

  private isVirtualStats(stats: MemoryStats): stats is VirtualMemoryStats {
    return stats.type === "virtual" || stats.type === "fragmentation" || stats.type === "hnsw" || stats.type === "perfect";
  }

  // --- Virtual Memory (composite bar + page grid) ---

  private renderVirtual(stats: VirtualMemoryStats): string {
    const w = this.config.barWidth;
    const totalBudget = stats.workingMemoryBudget + stats.pageSlotBudget;
    if (totalBudget === 0) return this.renderBasic(stats);

    const sysTokens = stats.systemTokens;
    const pageTokens = stats.pageSlotUsed;
    const wmUsed = stats.workingMemoryUsed;
    const totalUsed = sysTokens + pageTokens + wmUsed;
    const free = Math.max(0, totalBudget - totalUsed);
    const usePct = totalBudget > 0 ? totalUsed / totalBudget : 0;
    const isLow = (free / totalBudget) < 0.2 || stats.compactionActive || usePct > stats.highRatio;

    const lines: string[] = [];

    // Line 1: Composite fill bar — █ sys, ▓ page, ▒ wm, ░ free
    const sysChars = Math.max(sysTokens > 0 ? 1 : 0, Math.round((sysTokens / totalBudget) * w));
    const pageChars = Math.max(pageTokens > 0 ? 1 : 0, Math.round((pageTokens / totalBudget) * w));
    const wmChars = Math.max(wmUsed > 0 ? 1 : 0, Math.round((wmUsed / totalBudget) * w));
    const freeChars = Math.max(0, w - sysChars - pageChars - wmChars);
    const bar = "█".repeat(sysChars) + "▓".repeat(pageChars) + "▒".repeat(wmChars) + "░".repeat(freeChars);
    const usedK = (totalUsed / 1000).toFixed(0);
    const budgetK = (totalBudget / 1000).toFixed(0);
    const barSuffix = isLow ? `${usedK}K/${budgetK}K LOW` : `${usedK}K/${budgetK}K`;
    lines.push(`${bar}  ${barSuffix}`);

    // Line 2: Key metrics
    const parts: string[] = [];
    if (stats.pinnedMessages > 0) parts.push(`pin:${stats.pinnedMessages}`);
    parts.push(`pg:${stats.pagesLoaded}/${stats.pagesAvailable}`);
    if (stats.model) parts.push(this.shortModel(stats.model));
    parts.push(`fill:${Math.round(usePct * 100)}%`);
    lines.push(parts.join(" "));

    // Page digest — either drill-down or page grid
    if (this.config.showPages && stats.pageDigest && stats.pageDigest.length > 0) {
      const filter = this.filter;

      // Single page drill-down
      if (filter && this.isPageIdFilter(filter, stats.pageDigest)) {
        const page = stats.pageDigest.find(p => p.id === filter);
        if (page) {
          lines.push(...this.renderSinglePage(page, stats.pageDigest.length, stats.pagesLoaded));
          lines.push(`reset: view('context')`);
          return lines.join("\n");
        }
      }

      // Time bucket or full drill-down
      if (filter && (this.isTimeBucketFilter(filter) || filter === "full")) {
        lines.push(...this.renderDrillDown(stats.pageDigest, filter));
        lines.push(`reset: view('context')`);
        return lines.join("\n");
      }

      // Default: page symbol grid
      lines.push(...this.renderPageGrid(stats.pageDigest, w));
    } else if (this.config.showPages) {
      // No pages yet
      lines.push("(no pages)");
    }

    // Hint line
    lines.push(`view('context:today|full|pg_id')`);

    return lines.join("\n");
  }

  // --- Page symbol grid ---

  private renderPageGrid(pages: PageDigestEntry[], barWidth: number): string[] {
    const cellsPerRow = Math.max(1, Math.floor(barWidth / 2));
    const lines: string[] = [];
    let row = "";
    let count = 0;

    for (const p of pages) {
      let sym: string;
      if (p.pinned) sym = "◆";
      else if (p.loaded) sym = "█";
      else sym = "·";

      row += sym + " ";
      count++;
      if (count >= cellsPerRow) {
        lines.push(row.trimEnd());
        row = "";
        count = 0;
      }
    }
    if (row) lines.push(row.trimEnd());

    // Legend
    lines.push("█=loaded ·=free ◆=pinned");

    return lines;
  }

  // --- Drill-down views ---

  private renderDrillDown(pages: PageDigestEntry[], filter: string): string[] {
    const now = new Date();
    const lines: string[] = [];

    // Group by time bucket
    const buckets = new Map<string, PageDigestEntry[]>();
    const bucketOrder: string[] = [];
    for (const p of pages) {
      const bucket = timeBucket(p.createdAt, now);
      if (!buckets.has(bucket)) {
        buckets.set(bucket, []);
        bucketOrder.push(bucket);
      }
      buckets.get(bucket)!.push(p);
    }
    bucketOrder.sort((a, b) => bucketRank(a) - bucketRank(b));

    if (filter === "full") {
      for (const bucket of bucketOrder) {
        const items = buckets.get(bucket)!;
        lines.push(`${bucket} (${items.length}):`);
        for (const p of items) {
          const status = p.loaded ? "★" : p.pinned ? "◆" : "·";
          lines.push(`  ${status} ${p.id} ${this.compactSummary(p.summary, p.label, 30)}`);
        }
      }
    } else {
      // Show only the matching bucket expanded, others collapsed
      for (const bucket of bucketOrder) {
        const items = buckets.get(bucket)!;
        if (bucket === filter) {
          lines.push(`${bucket} (${items.length}):`);
          for (const p of items) {
            const status = p.loaded ? "★" : p.pinned ? "◆" : "·";
            const tokK = (p.tokens / 1000).toFixed(1);
            lines.push(`  ${status} ${p.id} (${tokK}K) ${this.compactSummary(p.summary, p.label)}`);
          }
        } else {
          lines.push(`${bucket} (${items.length})`);
        }
      }
    }

    return lines;
  }

  private renderSinglePage(page: PageDigestEntry, totalPages: number, loadedCount: number): string[] {
    const lines: string[] = [];
    lines.push(`page: ${page.id}`);
    lines.push(`  tokens: ${(page.tokens / 1000).toFixed(1)}K`);
    lines.push(`  status: ${page.loaded ? "loaded ★" : page.pinned ? "pinned ◆" : "unloaded"}`);
    lines.push(`  created: ${page.createdAt}`);
    lines.push(`  ${this.compactSummary(page.summary, page.label, 42)}`);
    if (page.loaded) {
      lines.push(`  unload: unref('${page.id}')`);
    } else {
      lines.push(`  load: ref('${page.id}')`);
    }
    return lines;
  }

  // --- Basic Memory (fallback) ---

  private renderBasic(stats: MemoryStats): string {
    const w = this.config.barWidth;
    const estimatedBudget = 128000;
    const used = stats.totalTokensEstimate;
    const free = Math.max(0, estimatedBudget - used);

    const usedChars = Math.max(used > 0 ? 1 : 0, Math.round((used / estimatedBudget) * w));
    const freeChars = Math.max(0, w - usedChars);

    const lines: string[] = [];
    lines.push("▒".repeat(usedChars) + "░".repeat(freeChars) + `  ${(used / 1000).toFixed(0)}K`);
    lines.push(`${stats.type} | ${stats.totalMessages} msgs`);
    return lines.join("\n");
  }

  // --- Helpers ---

  private compactSummary(summary: string, label: string, maxLen = 80): string {
    let s = summary;
    s = s.replace(/^\[Summary of \d+ messages:[^\]]*\]?\s*/i, "");
    s = s.replace(/^\[Pending summary:[^\]]*\]?\s*/i, "");
    s = s.replace(/^\.{3}\s*/, "");
    if (!s || s.length < 3) {
      s = label.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*-?\s*/g, "").trim();
      if (!s) s = label;
    }
    return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
  }

  private isTimeBucketFilter(filter: string): boolean {
    return filter === "today" || filter === "yesterday" || filter === "older" || /^\d+d ago$/.test(filter);
  }

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
