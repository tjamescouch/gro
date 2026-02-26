/**
 * ViolationsSource — sensory channel that renders violation tracking awareness.
 *
 * Uses ViolationTracker for count, breakdown, sleep status, and penalty factor.
 * Constructor accepts null for non-persistent mode; setTracker() allows late-binding.
 */

import type { SensorySource } from "./sensory-memory.js";
import type { ViolationTracker } from "../violations.js";

export class ViolationsSource implements SensorySource {
  private tracker: ViolationTracker | null;

  constructor(tracker: ViolationTracker | null) {
    this.tracker = tracker;
  }

  setTracker(tracker: ViolationTracker | null): void {
    this.tracker = tracker;
  }

  async poll(): Promise<string | null> {
    return this.render();
  }

  destroy(): void {}

  private render(): string {
    if (!this.tracker) {
      return "  n/a (non-persistent)";
    }

    const stats = this.tracker.getStats();
    const sleeping = this.tracker.isSleeping();

    const lines: string[] = [];
    lines.push(`  total ${stats.total}`);
    if (stats.total > 0) {
      const parts: string[] = [];
      if (stats.byType.plain_text > 0) parts.push(`txt:${stats.byType.plain_text}`);
      if (stats.byType.idle > 0) parts.push(`idle:${stats.byType.idle}`);
      if (stats.byType.same_tool_loop > 0) parts.push(`loop:${stats.byType.same_tool_loop}`);
      lines.push(`  types ${parts.join(" ")}`);
      lines.push(`penalty x${stats.penaltyFactor.toFixed(1)}`);
    }
    if (sleeping) {
      lines.push(`  sleep ON`);
    }

    return lines.join("\n");
  }
}
