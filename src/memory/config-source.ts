/**
 * ConfigSource — sensory channel for runtime configuration state.
 *
 * Box-drawn 80-char-wide panel with sections:
 *   - Model + provider
 *   - Sampling params (temp, top_p, top_k) with bars when set
 *   - Thinking level bar
 *   - Memory mode + autofill
 *   - Violations count + sleep state
 */

import type { SensorySource } from "./sensory-memory.js";
import { runtimeState } from "../runtime/state-manager.js";
import { topBorder, bottomBorder, divider, row, bar, IW } from "./box.js";

/** Bar width for sampling/thinking bars. */
const PARAM_BAR_W = 40;

export class ConfigSource implements SensorySource {
  private autoFillEnabled = true;
  private autoFillThreshold = 0.5;
  private integrityStatus: string | null = null;
  private environmentWarning: string | null = null;

  setAutoFill(enabled: boolean, threshold: number): void {
    this.autoFillEnabled = enabled;
    this.autoFillThreshold = threshold;
  }

  setIntegrityStatus(status: string | null): void {
    this.integrityStatus = status;
  }

  setEnvironmentWarning(warning: string | null): void {
    this.environmentWarning = warning;
  }

  async poll(): Promise<string | null> {
    return this.render();
  }

  destroy(): void {}

  private render(): string {
    const snap = runtimeState.snapshot();
    const turn = snap.turn;
    const lines: string[] = [];

    // --- Header ---
    const integ = this.integrityStatus
      ? `integrity:${this.integrityStatus === "verified" ? "\u2713" : this.integrityStatus}`
      : "";
    const headerRight = `gro  ${integ}`;
    const headerInner = " RUNTIME" + " ".repeat(Math.max(1, IW - 8 - headerRight.length)) + headerRight;
    lines.push(topBorder());
    lines.push(row(headerInner));

    // --- Model + Provider ---
    lines.push(divider());
    const shortModel = this.shortModel(turn.activeModel);
    const fullModel = turn.activeModel.length > 38
      ? turn.activeModel.slice(0, 38)
      : turn.activeModel;
    const modelLine = ` model    ${shortModel}  (${fullModel})`;
    lines.push(row(modelLine.padEnd(IW)));
    lines.push(row(` provider ${snap.session.provider}`.padEnd(IW)));

    // --- Sampling params ---
    lines.push(divider());

    // Temperature
    if (turn.activeTemperature !== undefined) {
      lines.push(this.paramBarRow("temp", turn.activeTemperature, 2));
    } else {
      lines.push(row(" temp     \u2500\u2500\u2500 (provider default)".padEnd(IW)));
    }

    // top_p
    if (turn.activeTopP !== undefined) {
      lines.push(this.paramBarRow("top_p", turn.activeTopP, 1));
    } else {
      lines.push(row(" top_p    \u2500\u2500\u2500".padEnd(IW)));
    }

    // top_k
    if (turn.activeTopK !== undefined) {
      lines.push(row(` top_k    ${turn.activeTopK}`.padEnd(IW)));
    } else {
      lines.push(row(" top_k    \u2500\u2500\u2500".padEnd(IW)));
    }

    // Thinking bar
    const thinkVal = turn.activeThinkingBudget;
    const thinkBar = bar(thinkVal, PARAM_BAR_W);
    const thinkStr = thinkVal.toFixed(2);
    lines.push(row(` thinking ${thinkBar}  ${thinkStr}`.padEnd(IW)));

    // --- Memory + Autofill ---
    lines.push(divider());
    const afStr = this.autoFillEnabled ? "ON" : "OFF";
    lines.push(row(` memory   ${snap.config.memoryType}   autofill: ${afStr}`.padEnd(IW)));
    const threshBar = bar(this.autoFillThreshold, PARAM_BAR_W);
    const threshStr = this.autoFillThreshold.toFixed(2);
    lines.push(row(` thresh   ${threshBar}  ${threshStr}`.padEnd(IW)));

    // --- Violations + Sleep ---
    lines.push(divider());
    const vCount = snap.violations ? snap.violations.totalViolations : 0;
    lines.push(row(` violations  ${vCount} this session`.padEnd(IW)));
    // Sleep state: based on whether yield tool is available (no persistent state)
    lines.push(row(" sleep       OFF   wake: ON".padEnd(IW)));

    lines.push(bottomBorder());
    return lines.join("\n");
  }

  /** Render a parameter bar row: ` label    <bar>  value ` */
  private paramBarRow(label: string, value: number, maxVal: number): string {
    const frac = Math.max(0, Math.min(1, value / maxVal));
    const barStr = bar(frac, PARAM_BAR_W);
    const valStr = value.toFixed(2);
    const prefix = (" " + label).padEnd(10);
    return row(`${prefix}${barStr}  ${valStr}`.padEnd(IW));
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
