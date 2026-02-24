/**
 * TemporalSource — sensory channel that renders a temporal awareness block.
 *
 * Addresses the most common agent disorientation problem: not knowing what
 * time it is, how long the session has been running, or how stale channels are.
 *
 * Output format targets under 150 tokens per render.
 */

import type { SensorySource } from "./sensory-memory.js";

export interface TemporalSourceConfig {
  /** Width of staleness bars in characters (default: 16) */
  barWidth?: number;
  /** Show per-channel staleness rows (requires channel tracker) */
  showChannels?: boolean;
}

export interface ChannelStaleness {
  name: string;
  lastMessageAt: number; // unix ms
}

export class TemporalSource implements SensorySource {
  private startTime: number;
  private config: Required<TemporalSourceConfig>;
  private channels: ChannelStaleness[] = [];

  constructor(config?: TemporalSourceConfig) {
    this.startTime = Date.now();
    this.config = {
      barWidth: config?.barWidth ?? 16,
      showChannels: config?.showChannels ?? true,
    };
  }

  /** Register a channel to track staleness for. */
  addChannel(name: string): void {
    if (!this.channels.find(c => c.name === name)) {
      this.channels.push({ name, lastMessageAt: Date.now() });
    }
  }

  /** Update the last-message timestamp for a channel. */
  touchChannel(name: string): void {
    const ch = this.channels.find(c => c.name === name);
    if (ch) {
      ch.lastMessageAt = Date.now();
    }
  }

  async poll(): Promise<string | null> {
    return this.render();
  }

  destroy(): void {
    // No resources to clean up
  }

  render(): string {
    const now = Date.now();
    const lines: string[] = [];

    // Wall clock line
    const wallClock = new Date(now).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    lines.push(`clock ${wallClock}`);

    // Session uptime
    const uptimeMs = now - this.startTime;
    lines.push(`  age ${this.formatDuration(uptimeMs)}`);

    // Per-channel staleness
    if (this.config.showChannels && this.channels.length > 0) {
      for (const ch of this.channels) {
        const staleMs = now - ch.lastMessageAt;
        const label = ch.name.padStart(5);
        const staleStr = this.formatDuration(staleMs);
        const bar = this.stalenessBar(staleMs);
        lines.push(`${label} ${bar} ${staleStr} ago`);
      }
    }

    return lines.join("\n");
  }

  /** Format a duration in ms to a human-readable string. */
  private formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m${rs > 0 ? rs + "s" : ""}`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h${rm > 0 ? rm + "m" : ""}`;
  }

  /**
   * Render a staleness bar. Fresh = filled (▓), stale = empty (░).
   * Scale: 0s = full, 5min = empty.
   */
  private stalenessBar(staleMs: number): string {
    const w = this.config.barWidth;
    const maxMs = 5 * 60 * 1000; // 5 minutes = fully stale
    const freshRatio = Math.max(0, 1 - staleMs / maxMs);
    const filled = Math.round(freshRatio * w);
    const empty = w - filled;
    return "▓".repeat(filled) + "░".repeat(empty);
  }
}
