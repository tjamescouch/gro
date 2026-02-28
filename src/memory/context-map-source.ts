/**
 * ContextMapSource — sensory channel that renders a memory map.
 *
 * Box-drawn 48-char-wide panel with three sections:
 *   1. Lane swimlanes — AST/USR/SYS/TOL bars with token + message counts
 *   2. Page dot grid — ● loaded, ○ dark, bucketed by time
 *   3. Active page slots — loaded pages with ID, lane, time, token bar
 *
 * Drill-down filters (context:today, context:full, context:pg_id) render
 * detailed page info into the same box.
 */

import type { AgentMemory, MemoryStats, VirtualMemoryStats, PageDigestEntry } from "./agent-memory.js";
import type { SensorySource } from "./sensory-memory.js";
import { topBorder, bottomBorder, divider, row, bar, lpad, rpad } from "./box.js";

// --- Time bucketing helpers ---

function timeBucket(createdAt: string, now: Date): string {
  const d = new Date(createdAt);
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yest";
  if (diffDays < 7) return `${diffDays}d`;
  return "older";
}

function bucketRank(bucket: string): number {
  if (bucket === "today") return 0;
  if (bucket === "yest") return 1;
  if (bucket === "older") return 100;
  const m = bucket.match(/^(\d+)d$/);
  return m ? parseInt(m[1], 10) : 50;
}

/** Lane bar width. */
const LANE_BAR_W = 26;
/** Dots per page row. */
const DOTS_PER_ROW = 22;
/** Page slot bar width. */
const SLOT_BAR_W = 12;

export interface ContextMapConfig {
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

  /** Dynamically update the character budget. */
  setMaxChars(maxChars: number): void {
    this.config.maxChars = maxChars;
  }

  async poll(): Promise<string | null> {
    const result = this.render();
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

  // --- Virtual Memory (lane bars + page grid + page slots) ---

  private renderVirtual(stats: VirtualMemoryStats): string {
    const totalBudget = stats.workingMemoryBudget + stats.pageSlotBudget;
    if (totalBudget === 0) return this.renderBasic(stats);

    const totalUsed = stats.systemTokens + stats.pageSlotUsed + stats.workingMemoryUsed;
    const usePct = totalBudget > 0 ? totalUsed / totalBudget : 0;
    const lines: string[] = [];

    // --- Header ---
    const pgCount = stats.pagesAvailable;
    const usedK = (totalUsed / 1000).toFixed(0);
    const budgetK = (totalBudget / 1000).toFixed(0);
    const fillPct = Math.round(usePct * 100);
    const headerRight = `${pgCount} pg  ${usedK}K/${budgetK}K  fill:${fillPct}%`;
    const headerInner = " MEMORY" + " ".repeat(Math.max(1, 46 - 7 - headerRight.length)) + headerRight;

    lines.push(topBorder());
    lines.push(row(headerInner));

    // --- Check for drill-down ---
    const filter = this.filter;
    const pages = stats.pageDigest ?? [];

    if (filter && this.isPageIdFilter(filter, pages)) {
      const page = pages.find(p => p.id === filter);
      if (page) {
        lines.push(divider());
        lines.push(...this.renderSinglePage(page, pages.length, stats.pagesLoaded));
        lines.push(row(" reset: view('context')".padEnd(46)));
        lines.push(bottomBorder());
        return lines.join("\n");
      }
    }

    if (filter && (this.isTimeBucketFilter(filter) || filter === "full")) {
      lines.push(divider());
      lines.push(...this.renderDrillDown(pages, filter));
      lines.push(row(" reset: view('context')".padEnd(46)));
      lines.push(bottomBorder());
      return lines.join("\n");
    }

    // --- Lane swimlanes ---
    lines.push(divider());
    const laneMap = new Map<string, { tokens: number; count: number }>();
    for (const lane of stats.lanes) {
      laneMap.set(lane.role, { tokens: lane.tokens, count: lane.count });
    }
    const maxLaneTokens = Math.max(1, ...stats.lanes.map(l => l.tokens));
    for (const [abbr, role] of [["AST", "assistant"], ["USR", "user"], ["SYS", "system"], ["TOL", "tool"]]) {
      const lane = laneMap.get(role) ?? { tokens: 0, count: 0 };
      const frac = lane.tokens / maxLaneTokens;
      const barStr = bar(frac, LANE_BAR_W);
      const tokStr = lpad(String(lane.tokens), 5);
      const msgStr = lpad(String(lane.count), 2);
      const inner = ` ${abbr} ${barStr} ${tokStr} tok  ${msgStr} `;
      lines.push(row(inner));
    }

    // --- Page dot grid ---
    lines.push(divider());
    if (pages.length > 0) {
      lines.push(...this.renderPageDots(pages));
    } else {
      lines.push(row(" PAGES  (none)".padEnd(46)));
    }

    // --- Active page slots ---
    const loadedPages = pages.filter(p => p.loaded);
    if (loadedPages.length > 0) {
      lines.push(divider());
      const maxSlotTokens = Math.max(1, ...loadedPages.map(p => p.tokens));
      for (let i = 0; i < Math.min(4, loadedPages.length); i++) {
        const p = loadedPages[i];
        lines.push(this.renderPageSlot(i, p, maxSlotTokens));
      }
    }

    lines.push(bottomBorder());
    return lines.join("\n");
  }

  // --- Lane bar row ---
  // Format: ` AST <bar>  TTTTT tok  MM `
  // Prefix=5, bar=26, suffix=15 → total 46

  // --- Page dot grid ---

  private renderPageDots(pages: PageDigestEntry[]): string[] {
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

    // Render bucket rows
    const labelWidth = 8; // " PAGES  " or "        "
    let first = true;
    for (const bucket of bucketOrder) {
      const items = buckets.get(bucket)!;
      const prefix = first ? " PAGES  " : "        ";
      first = false;

      // Dot string: ● for loaded, ○ for dark
      const dots = items.map(p => p.loaded ? "●" : "○").join("").slice(0, DOTS_PER_ROW);
      const paddedDots = dots.padEnd(DOTS_PER_ROW);

      // Bucket label with count, right portion
      const bucketLabel = ` ${bucket}:${lpad(String(items.length), 2)}`;
      const suffix = bucketLabel.padEnd(46 - labelWidth - DOTS_PER_ROW);

      lines.push(row(prefix + paddedDots + suffix));
    }

    // Legend line
    const legend = "        ●=loaded ○=dark  pin:" + stats_pinnedCount(pages);
    lines.push(row(legend.padEnd(46)));

    return lines;
  }

  // --- Page slot ---

  private renderPageSlot(idx: number, page: PageDigestEntry, maxTokens: number): string {
    // Format: ` [N] pg_XXXX  lll HH:MM  TTTTTt  <bar>  `
    const idShort = page.id.length > 7 ? page.id.slice(0, 7) : page.id;
    const createdDate = new Date(page.createdAt);
    const hh = lpad(String(createdDate.getHours()), 2).replace(/ /g, "0");
    const mm = lpad(String(createdDate.getMinutes()), 2).replace(/ /g, "0");
    const timeStr = `${hh}:${mm}`;

    // Determine lane from page label/summary (heuristic: look for role keywords)
    const lane = this.guessLane(page);
    const tokStr = lpad(String(page.tokens), 5) + "t";
    const frac = page.tokens / maxTokens;
    const barStr = bar(frac, SLOT_BAR_W);

    // ` [0] pg_XXXX  lll HH:MM  TTTTTt  ████░░░░░░░░ `
    // Build: ` [N] ` (5) + id (7) + `  ` (2) + lane (3) + ` ` (1) + time (5) + `  ` (2) + tok (6) + `  ` (2) + bar (12) + ` ` (1) = 46
    const inner = ` [${idx}] ${rpad(idShort, 7)}  ${rpad(lane, 3)} ${timeStr}  ${tokStr}  ${barStr} `;
    return row(inner);
  }

  /** Best-effort lane guess from page content. */
  private guessLane(page: PageDigestEntry): string {
    const s = (page.label + " " + page.summary).toLowerCase();
    if (s.includes("tool") || s.includes("function")) return "tol";
    if (s.includes("user") || s.includes("human")) return "usr";
    if (s.includes("system") || s.includes("sys")) return "sys";
    return "ast";
  }

  // --- Single page drill-down ---

  private renderSinglePage(page: PageDigestEntry, totalPages: number, loadedCount: number): string[] {
    const lines: string[] = [];
    lines.push(row(` page: ${page.id}`.padEnd(46)));
    lines.push(row(`   tokens: ${(page.tokens / 1000).toFixed(1)}K`.padEnd(46)));
    const status = page.loaded ? "loaded *" : page.pinned ? "pinned" : "unloaded";
    lines.push(row(`   status: ${status}`.padEnd(46)));
    lines.push(row(`   created: ${page.createdAt}`.padEnd(46)));
    const summary = this.compactSummary(page.summary, page.label, 40);
    lines.push(row(`   ${summary}`.padEnd(46)));
    if (page.loaded) {
      lines.push(row(`   unload: unref('${page.id}')`.padEnd(46)));
    } else {
      lines.push(row(`   load: ref('${page.id}')`.padEnd(46)));
    }
    return lines;
  }

  // --- Time-bucket drill-down ---

  private renderDrillDown(pages: PageDigestEntry[], filter: string): string[] {
    const now = new Date();
    const lines: string[] = [];

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
        lines.push(row(` ${bucket} (${items.length}):`.padEnd(46)));
        for (const p of items) {
          const sym = p.loaded ? "*" : p.pinned ? "+" : ".";
          const detail = `  ${sym} ${p.id} ${this.compactSummary(p.summary, p.label, 28)}`;
          lines.push(row(detail.padEnd(46)));
        }
      }
    } else {
      for (const bucket of bucketOrder) {
        const items = buckets.get(bucket)!;
        if (bucket === filter) {
          lines.push(row(` ${bucket} (${items.length}):`.padEnd(46)));
          for (const p of items) {
            const sym = p.loaded ? "*" : p.pinned ? "+" : ".";
            const tokK = (p.tokens / 1000).toFixed(1);
            const detail = `  ${sym} ${p.id} (${tokK}K) ${this.compactSummary(p.summary, p.label, 22)}`;
            lines.push(row(detail.padEnd(46)));
          }
        } else {
          lines.push(row(` ${bucket} (${items.length})`.padEnd(46)));
        }
      }
    }

    return lines;
  }

  // --- Basic Memory (fallback) ---

  private renderBasic(stats: MemoryStats): string {
    const lines: string[] = [];
    const usedK = (stats.totalTokensEstimate / 1000).toFixed(0);
    const headerInner = ` MEMORY  ${usedK}K  ${stats.totalMessages} msgs`;
    lines.push(topBorder());
    lines.push(row(headerInner.padEnd(46)));
    lines.push(bottomBorder());
    return lines.join("\n");
  }

  // --- Helpers ---

  private compactSummary(summary: string, label: string, maxLen = 40): string {
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
    return filter === "today" || filter === "yest" || filter === "yesterday" ||
           filter === "older" || /^\d+d$/.test(filter) || /^\d+d ago$/.test(filter);
  }

  private isPageIdFilter(filter: string, pages: PageDigestEntry[]): boolean {
    return pages.some(p => p.id === filter);
  }
}

/** Count pinned pages. */
function stats_pinnedCount(pages: PageDigestEntry[]): string {
  const count = pages.filter(p => p.pinned).length;
  return String(count);
}
