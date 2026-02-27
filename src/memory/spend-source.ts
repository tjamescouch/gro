/**
 * SpendSource — sensory channel that renders spend/cost awareness.
 *
 * Uses the SpendMeter singleton for session cost, model info, and token rates.
 */

import type { SensorySource } from "./sensory-memory.js";
import type { SpendMeter } from "../spend-meter.js";

export class SpendSource implements SensorySource {
  private meter: SpendMeter;

  constructor(meter: SpendMeter) {
    this.meter = meter;
  }

  async poll(): Promise<string | null> {
    return this.render();
  }

  destroy(): void {}

  private render(): string {
    const cost = this.meter.cost();
    const tokens = this.meter.tokens;

    const lines: string[] = [];
    lines.push(`  cost $${cost.toFixed(4)}`);
    lines.push(`   tok ${this.fmtK(tokens.in)} in / ${this.fmtK(tokens.out)} out`);
    const last = this.meter.lastTurnMs;
    if (last > 0) {
      lines.push(` turn ${this.fmtDur(last)} | longest ${this.fmtDur(this.meter.longestTurnMs)} | avg ${this.fmtDur(this.meter.avgTurnMs)}`);
    }
    lines.push(`   hz ${this.meter.currentHorizon} cur / ${this.meter.maxHorizon} max (${this.meter.totalTurns} turns)`);
    return lines.join("\n");
  }

  private fmtK(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return n.toFixed(0);
  }

  private fmtDur(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }
}
