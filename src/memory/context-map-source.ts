/**
 * ContextMapSource — sensory channel that renders a spatial context map.
 *
 * Reads memory stats from the inner AgentMemory (via getStats()) and produces
 * a compact text heatmap showing how the context window is distributed.
 * Degrades gracefully: renders whatever stats the memory type provides.
 *
 * Target: under 300 tokens per render.
 */

import type { AgentMemory, MemoryStats, VirtualMemoryStats } from "./agent-memory.js";
import type { SensorySource } from "./sensory-memory.js";

export interface ContextMapConfig {
  /** Width of the bar chart in characters (default: 32) */
  barWidth?: number;
  /** Include swimlane breakdown (default: true) */
  showLanes?: boolean;
  /** Include page stats (default: true) */
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

  // --- Virtual Memory (rich) ---

  private renderVirtual(stats: VirtualMemoryStats): string {
    const w = this.config.barWidth;
    const totalBudget = stats.workingMemoryBudget + stats.pageSlotBudget;
    if (totalBudget === 0) return this.renderBasic(stats);

    // Use real values from getStats()
    const sysTokens = stats.systemTokens;
    const pageTokens = stats.pageSlotUsed;
    const wmUsed = stats.workingMemoryUsed;
    const free = Math.max(0, totalBudget - sysTokens - pageTokens - wmUsed);

    // Bar segments (chars)
    const sysChars = Math.round((sysTokens / totalBudget) * w);
    const pageChars = Math.round((pageTokens / totalBudget) * w);
    const wmChars = Math.round((wmUsed / totalBudget) * w);
    const freeChars = Math.max(0, w - sysChars - pageChars - wmChars);

    const bar = "█".repeat(sysChars) + "▓".repeat(pageChars) + "▒".repeat(wmChars) + "░".repeat(freeChars);

    const lines: string[] = [];

    // Bar with labels
    const sysPct = totalBudget > 0 ? Math.round((sysTokens / totalBudget) * 100) : 0;
    const wmPct = totalBudget > 0 ? Math.round((wmUsed / totalBudget) * 100) : 0;
    const freePct = totalBudget > 0 ? Math.round((free / totalBudget) * 100) : 0;
    lines.push(`${bar}  sys:${sysPct}% wm:${wmPct}% free:${freePct}%`);

    // Stats line
    const totalUsed = sysTokens + pageTokens + wmUsed;
    const usedK = (totalUsed / 1000).toFixed(1);
    const budgetK = (totalBudget / 1000).toFixed(1);
    const usePct = totalBudget > 0 ? Math.round((totalUsed / totalBudget) * 100) : 0;
    lines.push(`${usedK}K/${budgetK}K tok (${usePct}%)`);

    // Lane breakdown
    if (this.config.showLanes && stats.lanes.length > 0) {
      const laneStr = stats.lanes
        .filter(l => l.tokens > 0)
        .map(l => `${l.role.slice(0, 3)}:${(l.tokens / 1000).toFixed(1)}K`)
        .join(" ");
      if (laneStr) lines.push(`wm: ${laneStr}`);
    }

    // Page stats
    if (this.config.showPages) {
      const parts: string[] = [];
      if (stats.pinnedMessages > 0) parts.push(`pin:${stats.pinnedMessages}`);
      parts.push(`pg:${stats.pagesLoaded}/${stats.pagesAvailable}`);
      if (stats.model) parts.push(`model:${this.shortModel(stats.model)}`);
      lines.push(parts.join(" | "));
    }

    return lines.join("\n");
  }

  // --- Basic Memory (minimal) ---

  private renderBasic(stats: MemoryStats): string {
    const lines: string[] = [];
    lines.push(`${stats.type} | ${stats.totalMessages} msgs | ~${(stats.totalTokensEstimate / 1000).toFixed(1)}K tok`);
    return lines.join("\n");
  }

  // --- Helpers ---

  private shortModel(model: string): string {
    // Shorten common model names
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
