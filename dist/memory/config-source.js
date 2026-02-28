/**
 * ConfigSource — sensory channel for runtime configuration state.
 *
 * Box-drawn 48-char-wide panel with sections:
 *   - Model + provider
 *   - Sampling params (temp, top_p, top_k) with bars when set
 *   - Thinking level bar
 *   - Memory mode + autofill
 *   - Violations count + sleep state
 */
import { runtimeState } from "../runtime/state-manager.js";
import { topBorder, bottomBorder, divider, row, bar } from "./box.js";
/** Bar width for sampling/thinking bars. */
const PARAM_BAR_W = 24;
export class ConfigSource {
    constructor() {
        this.autoFillEnabled = true;
        this.autoFillThreshold = 0.5;
        this.integrityStatus = null;
        this.environmentWarning = null;
    }
    setAutoFill(enabled, threshold) {
        this.autoFillEnabled = enabled;
        this.autoFillThreshold = threshold;
    }
    setIntegrityStatus(status) {
        this.integrityStatus = status;
    }
    setEnvironmentWarning(warning) {
        this.environmentWarning = warning;
    }
    async poll() {
        return this.render();
    }
    destroy() { }
    render() {
        const snap = runtimeState.snapshot();
        const turn = snap.turn;
        const lines = [];
        // --- Header ---
        const integ = this.integrityStatus
            ? `integrity:${this.integrityStatus === "verified" ? "\u2713" : this.integrityStatus}`
            : "";
        const headerRight = `gro  ${integ}`;
        const headerInner = " RUNTIME" + " ".repeat(Math.max(1, 46 - 8 - headerRight.length)) + headerRight;
        lines.push(topBorder());
        lines.push(row(headerInner));
        // --- Model + Provider ---
        lines.push(divider());
        const shortModel = this.shortModel(turn.activeModel);
        const fullModel = turn.activeModel.length > 22
            ? turn.activeModel.slice(0, 22)
            : turn.activeModel;
        const modelLine = ` model    ${shortModel}  (${fullModel})`;
        lines.push(row(modelLine.padEnd(46)));
        lines.push(row(` provider ${snap.session.provider}`.padEnd(46)));
        // --- Sampling params ---
        lines.push(divider());
        // Temperature
        if (turn.activeTemperature !== undefined) {
            lines.push(this.paramBarRow("temp", turn.activeTemperature, 2));
        }
        else {
            lines.push(row(" temp     \u2500\u2500\u2500 (provider default)".padEnd(46)));
        }
        // top_p
        if (turn.activeTopP !== undefined) {
            lines.push(this.paramBarRow("top_p", turn.activeTopP, 1));
        }
        else {
            lines.push(row(" top_p    \u2500\u2500\u2500".padEnd(46)));
        }
        // top_k
        if (turn.activeTopK !== undefined) {
            lines.push(row(` top_k    ${turn.activeTopK}`.padEnd(46)));
        }
        else {
            lines.push(row(" top_k    \u2500\u2500\u2500".padEnd(46)));
        }
        // Thinking bar
        const thinkVal = turn.activeThinkingBudget;
        const thinkBar = bar(thinkVal, PARAM_BAR_W);
        const thinkStr = thinkVal.toFixed(2);
        lines.push(row(` thinking ${thinkBar}  ${thinkStr}`.padEnd(46)));
        // --- Memory + Autofill ---
        lines.push(divider());
        const afStr = this.autoFillEnabled ? "ON" : "OFF";
        lines.push(row(` memory   ${snap.config.memoryType}   autofill: ${afStr}`.padEnd(46)));
        const threshBar = bar(this.autoFillThreshold, PARAM_BAR_W);
        const threshStr = this.autoFillThreshold.toFixed(2);
        lines.push(row(` thresh   ${threshBar}  ${threshStr}`.padEnd(46)));
        // --- Violations + Sleep ---
        lines.push(divider());
        const vCount = snap.violations ? snap.violations.totalViolations : 0;
        lines.push(row(` violations  ${vCount} this session`.padEnd(46)));
        // Sleep state: based on whether yield tool is available (no persistent state)
        lines.push(row(" sleep       OFF   wake: ON".padEnd(46)));
        lines.push(bottomBorder());
        return lines.join("\n");
    }
    /** Render a parameter bar row: ` label    <bar>  value ` */
    paramBarRow(label, value, maxVal) {
        const frac = Math.max(0, Math.min(1, value / maxVal));
        const barStr = bar(frac, PARAM_BAR_W);
        const valStr = value.toFixed(2);
        const prefix = (" " + label).padEnd(10);
        return row(`${prefix}${barStr}  ${valStr}`.padEnd(46));
    }
    shortModel(model) {
        if (model.includes("opus"))
            return "opus";
        if (model.includes("sonnet"))
            return "sonnet";
        if (model.includes("haiku"))
            return "haiku";
        if (model.includes("gpt-4"))
            return "gpt4";
        if (model.includes("gpt-3"))
            return "gpt3";
        if (model.includes("llama"))
            return "llama";
        if (model.includes("gemini"))
            return "gemini";
        return model.length > 12 ? model.slice(0, 12) : model;
    }
}
