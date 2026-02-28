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

  async poll(): Promise<string | null> {
    return this.render();
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

  /** Render page digest as a compact listing the agent can browse and ref from. */
  private renderPageDigest(pages: PageDigestEntry[]): string {
    const lines: string[] = ["pages:"];
    // Show loaded pages first, then unloaded, capped at 12 to stay within token budget
    const sorted = [...pages].sort((a, b) => (b.loaded ? 1 : 0) - (a.loaded ? 1 : 0));
    const shown = sorted.slice(0, 12);
    for (const p of shown) {
      const status = p.loaded ? "★" : p.pinned ? "📌" : "·";
      const tokK = (p.tokens / 1000).toFixed(1);
      lines.push(`  ${status} ${p.id} (${tokK}K) ${p.summary}`);
    }
    if (pages.length > 12) {
      lines.push(`  ... +${pages.length - 12} more`);
    }
    lines.push(`load: @@ref('id1,id2')@@  release: @@unref('id')@@`);
    return lines.join("\n");
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
