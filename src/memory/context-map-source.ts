/**
 * ContextMapSource — sensory channel that renders a compact memory page viewer.
 *
 * Box-drawn 80-char-wide panel with sections:
 *   1. HEADER   — page count, loaded count, fill bar, active token count
 *   2. LOADED   — loaded/pinned pages with expanded summaries (if any)
 *   3. PAGES    — all pages grouped by time bucket, compact single-line format
 *   4. BUDGET   — slot usage bar + navigation hints
 *
 * Drill-down filters (context:today, context:full, context:pg_id) render
 * detailed page info into the same box.
 */

import type { AgentMemory, MemoryStats, VirtualMemoryStats, PageDigestEntry } from "./agent-memory.js";
import type { SensorySource } from "./sensory-memory.js";
import { topBorder, bottomBorder, sectionDivider, row, bar, lpad, rpad, IW } from "./box.js";

// --- Constants ---

const FILL_BAR_W = 27;
const LANE_BAR_W = 12;

// --- Lane glyphs ---

const LANE_GLYPHS: Record<string, string> = {
  assistant: "🤖",
  user: "👤",
  system: "⚙️",
  tool: "🔧",
  mixed: "🔀",
};

function laneGlyph(lane: string): string {
  return LANE_GLYPHS[lane] ?? "·";
}

function laneAbbr(lane: string): string {
  if (lane === "assistant") return "asst";
  if (lane === "user") return "user";
  if (lane === "system") return "sys";
  if (lane === "tool") return "tool";
  return "mix";
}

// --- Time bucketing helpers ---

function timeBucket(createdAt: string, now: Date): string {
  const d = new Date(createdAt);
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays === 2) return "2d ago";
  if (diffDays === 3) return "3d ago";
  if (diffDays <= 7) return "this week";
  return "older";
}

function bucketRank(bucket: string): number {
  if (bucket === "today") return 0;
  if (bucket === "yesterday") return 1;
  if (bucket === "2d ago") return 2;
  if (bucket === "3d ago") return 3;
  if (bucket === "this week") return 4;
  return 100;
}

function timeRange(pages: PageDigestEntry[]): string {
  if (pages.length === 0) return "";
  const times = pages.map(p => new Date(p.createdAt));
  const earliest = new Date(Math.min(...times.map(t => t.getTime())));
  const latest = new Date(Math.max(...times.map(t => t.getTime())));
  return `${fmtHHMM(earliest)}–${fmtHHMM(latest)}`;
}

function fmtHHMM(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function fmtTok(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

export interface ContextMapConfig {
  /** Character budget for the rendered output (default: 0 = unlimited) */
  maxChars?: number;
  /** Maximum lines for the rendered output (default: 40) */
  maxLines?: number;
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
      maxLines: config?.maxLines ?? 40,
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

  // --- Virtual Memory (full page viewer) ---

  private renderVirtual(stats: VirtualMemoryStats): string {
    const totalBudget = stats.workingMemoryBudget + stats.pageSlotBudget;
    if (totalBudget === 0) return this.renderBasic(stats);

    const totalUsed = stats.systemTokens + stats.pageSlotUsed + stats.workingMemoryUsed;
    const pages = stats.pageDigest ?? [];
    const lines: string[] = [];

    // --- Check for drill-down first ---
    const filter = this.filter;
    if (filter && this.isPageIdFilter(filter, pages)) {
      const page = pages.find(p => p.id === filter);
      if (page) {
        lines.push(topBorder());
        lines.push(row(` PAGE ${page.id}`));
        lines.push(sectionDivider("DETAIL"));
        lines.push(...this.renderSinglePage(page, stats));
        lines.push(bottomBorder());
        return lines.join("\n");
      }
    }

    if (filter && (this.isTimeBucketFilter(filter) || filter === "full")) {
      lines.push(topBorder());
      lines.push(row(` CONTEXT  drill-down: ${filter}`));
      lines.push(sectionDivider(filter.toUpperCase()));
      lines.push(...this.renderDrillDown(pages, filter));
      lines.push(bottomBorder());
      return lines.join("\n");
    }

    // --- Normal view ---

    // === SECTION 1: HEADER (fill bar + lanes inline) ===
    const fillFrac = totalBudget > 0 ? totalUsed / totalBudget : 0;
    const fillPct = Math.round(fillFrac * 100);
    const fillBar = bar(fillFrac, FILL_BAR_W);
    const warn = fillPct >= 75 ? " ⚠" : "";
    const activeTokens = stats.pageSlotUsed + stats.workingMemoryUsed;

    lines.push(topBorder());
    lines.push(row(` PAGES  ${lpad(String(pages.length), 3)} total  ${lpad(String(stats.pagesLoaded), 2)} loaded  ${fillBar} ${fillPct}%${warn}  ${fmtTok(activeTokens)} active`));

    // Lane summary — single compact line
    const laneTotals = this.aggregateLanes(stats, pages);
    const laneStr = Object.entries(laneTotals)
      .filter(([_, t]) => t > 0)
      .map(([l, t]) => `${laneGlyph(l)}${fmtTok(t)}`)
      .join("  ");
    if (laneStr) {
      lines.push(row(` lanes: ${laneStr}`));
    }

    // === SECTION 2: LOADED PAGES (if any) ===
    const loadedPages = pages.filter(p => p.loaded || p.pinned);
    if (loadedPages.length > 0) {
      lines.push(sectionDivider("LOADED"));
      for (const p of loadedPages) {
        const d = new Date(p.createdAt);
        const pin = p.pinned ? "📌" : "█ ";
        const snippet = this.cleanSummary(p.summary, p.label, 54);
        lines.push(row(`  ${pin} ${rpad(p.id.slice(0, 11), 11)}  ${laneGlyph(p.lane)} ${fmtHHMM(d)}  ${fmtTok(p.tokens)}t  ${snippet}`));
      }
    }

    // === SECTION 3: PAGE ROWS (compact, by time bucket) ===
    const maxLines = this.config.maxLines;
    // Fixed overhead: top(1) + header(1) + lanes(1) + budget section(3) + bottom(1) = 7
    // Loaded section: divider(1) + N loaded pages
    const loadedOverhead = loadedPages.length > 0 ? 1 + loadedPages.length : 0;
    const fixedOverhead = 7 + loadedOverhead;
    const availableForPages = Math.max(4, maxLines - fixedOverhead);

    this.renderCompactPageRows(pages, lines, availableForPages);

    // === SECTION 4: BUDGET + NAV ===
    lines.push(sectionDivider("BUDGET"));
    this.renderBudgetLine(stats, lines);
    lines.push(row(` nav: ref('id')  ref('?query')  memory_grep  view('context:full')`));

    lines.push(bottomBorder());
    return lines.join("\n");
  }

  // --- Aggregate lane tokens ---

  private aggregateLanes(stats: VirtualMemoryStats, pages: PageDigestEntry[]): Record<string, number> {
    const totals: Record<string, number> = { assistant: 0, user: 0, system: 0, tool: 0 };
    for (const p of pages) {
      const l = p.lane === "mixed" ? "assistant" : p.lane;
      if (l in totals) totals[l] += p.tokens;
      else totals["assistant"] += p.tokens;
    }
    for (const lane of stats.lanes) {
      if (lane.role in totals) totals[lane.role] += lane.tokens;
    }
    return totals;
  }

  // --- Compact page rows (one line per page) ---

  private renderCompactPageRows(pages: PageDigestEntry[], lines: string[], maxPageLines: number): void {
    if (pages.length === 0) {
      lines.push(sectionDivider("PAGES"));
      lines.push(row("  (no pages yet)"));
      return;
    }

    const now = new Date();

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

    // Budget: each bucket costs divider(1) + pages + overflow(0-1)
    let linesUsed = 0;

    for (const bucket of bucketOrder) {
      if (linesUsed >= maxPageLines) break;
      const items = buckets.get(bucket)!;
      const range = timeRange(items);
      const label = range ? `${bucket.toUpperCase()} ${range}` : bucket.toUpperCase();
      lines.push(sectionDivider(label));
      linesUsed++;

      // How many pages can we show in this bucket?
      const remaining = maxPageLines - linesUsed;
      const cap = Math.min(items.length, Math.max(1, remaining - 1)); // -1 for potential overflow line

      for (let i = 0; i < cap && linesUsed < maxPageLines; i++) {
        lines.push(this.renderCompactRow(items[i]));
        linesUsed++;
      }
      if (items.length > cap) {
        lines.push(row(`  … +${items.length - cap} more`));
        linesUsed++;
      }
    }
  }

  /** Single compact line per page: status + id + glyph + time + tokens + snippet */
  private renderCompactRow(p: PageDigestEntry): string {
    const d = new Date(p.createdAt);
    const idShort = p.id.slice(0, 11);

    let status: string;
    if (p.pinned) status = "📌";
    else if (p.loaded) status = "█ ";
    else if (p.maxImportance >= 0.8) status = "★ ";
    else status = "░ ";

    const snippet = this.cleanSummary(p.summary, p.label, 38);

    return row(`  ${status} ${rpad(idShort, 11)}  ${laneGlyph(p.lane)} ${fmtHHMM(d)}  ${lpad(String(p.messageCount), 2)}m  ${lpad(fmtTok(p.tokens), 5)}t  ${snippet}`);
  }

  // --- Budget line ---

  private renderBudgetLine(stats: VirtualMemoryStats, lines: string[]): void {
    const budget = stats.pageSlotBudget;
    const used = stats.pageSlotUsed;
    const usedFrac = budget > 0 ? used / budget : 0;
    const usedBar = bar(usedFrac, 20);
    lines.push(row(` slots: ${usedBar}  ${fmtTok(used)}/${fmtTok(budget)} used  (${stats.pagesLoaded} loaded)`));
  }

  // --- Single page drill-down ---

  private renderSinglePage(page: PageDigestEntry, stats: VirtualMemoryStats): string[] {
    const lines: string[] = [];
    const d = new Date(page.createdAt);

    // Identity
    lines.push(row(`  id:      ${page.id}`));
    lines.push(row(`  lane:    ${laneGlyph(page.lane)} ${page.lane}    msgs: ${page.messageCount}    tokens: ${fmtTok(page.tokens)}`));
    lines.push(row(`  created: ${page.createdAt}  (${fmtHHMM(d)})`));

    // Status
    const status = page.loaded ? "loaded" : page.pinned ? "pinned" : "unloaded";
    lines.push(row(`  status:  ${status}    importance: ${page.maxImportance.toFixed(2)}`));

    // Full summary (word-wrapped)
    lines.push(row(``));
    const summary = this.cleanSummary(page.summary, page.label, 999);
    const maxWidth = IW - 4; // 2 indent + 2 border margin
    const wrapped = this.wordWrap(summary, maxWidth);
    for (const line of wrapped.slice(0, 8)) {
      lines.push(row(`  ${line}`));
    }
    if (wrapped.length > 8) {
      lines.push(row(`  … (${wrapped.length - 8} more lines)`));
    }

    // Action
    lines.push(row(``));
    if (page.loaded) {
      lines.push(row(`  action: unref('${page.id}') to release`));
    } else {
      lines.push(row(`  action: ref('${page.id}') to load`));
    }
    lines.push(row(`  back:   view('context')`));

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
        const range = timeRange(items);
        lines.push(row(` ${bucket} (${items.length}) ${range}`));
        for (const p of items) {
          lines.push(this.renderCompactRow(p));
          // In full mode, also show summary line
          const sumLine = this.renderSummaryLine(p);
          if (sumLine) lines.push(sumLine);
        }
      }
    } else {
      for (const bucket of bucketOrder) {
        const items = buckets.get(bucket)!;
        if (bucket === filter) {
          const range = timeRange(items);
          lines.push(row(` ${bucket} (${items.length}) ${range}`));
          for (const p of items) {
            lines.push(this.renderCompactRow(p));
            const sumLine = this.renderSummaryLine(p);
            if (sumLine) lines.push(sumLine);
          }
        } else {
          lines.push(row(` ${bucket} (${items.length}) — collapsed`));
        }
      }
    }

    return lines;
  }

  /** Render an inline summary line under a page row (for drill-down). */
  private renderSummaryLine(p: PageDigestEntry): string | null {
    if (!p.summary) return null;
    const s = this.cleanSummary(p.summary, p.label, IW - 7);
    if (!s || s.length < 3) return null;
    return row(`     └ ${s}`);
  }

  // --- Basic Memory (fallback) ---

  private renderBasic(stats: MemoryStats): string {
    const lines: string[] = [];
    const usedK = (stats.totalTokensEstimate / 1000).toFixed(0);
    lines.push(topBorder());
    lines.push(row(` MEMORY  ${usedK}K  ${stats.totalMessages} msgs`));
    lines.push(bottomBorder());
    return lines.join("\n");
  }

  // --- Helpers ---

  /** Clean summary text — strip boilerplate prefixes, trim, truncate. */
  private cleanSummary(summary: string, label: string, maxLen: number): string {
    let s = summary;
    s = s.replace(/^\[Summary of \d+ messages:[^\]]*\]?\s*/i, "");
    s = s.replace(/^\[Pending summary:[^\]]*\]?\s*/i, "");
    s = s.replace(/^\.{3}\s*/, "");
    s = s.replace(/^STATUS:\s*/i, "");
    s = s.trim();
    if (!s || s.length < 3) {
      s = label.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*-?\s*/g, "").trim();
      if (!s) s = label;
    }
    return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
  }

  /** Word-wrap text to fit within maxWidth characters. */
  private wordWrap(text: string, maxWidth: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      if (current.length + word.length + 1 > maxWidth && current.length > 0) {
        lines.push(current);
        current = word;
      } else {
        current = current ? current + " " + word : word;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  private isTimeBucketFilter(filter: string): boolean {
    return filter === "today" || filter === "yest" || filter === "yesterday" ||
           filter === "older" || filter === "2d ago" || filter === "3d ago" || filter === "this week" ||
           /^\d+d$/.test(filter) || /^\d+d ago$/.test(filter);
  }

  private isPageIdFilter(filter: string, pages: PageDigestEntry[]): boolean {
    return pages.some(p => p.id === filter);
  }
}
