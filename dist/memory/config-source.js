/**
 * ConfigSource — sensory channel for runtime configuration state.
 *
 * Compact key-value pairs: model, sampling params (with clamping notes),
 * thinking level, memory mode, autofill state, budget, violations summary.
 * Designed for ~100 tokens — low cost, high signal.
 */
import { runtimeState } from "../runtime/state-manager.js";
// Provider-specific parameter ceilings for clamping detection
const TEMP_MAX = {
    anthropic: 1,
    openai: 2,
    google: 2,
};
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
        const provider = snap.session.provider;
        const lines = [];
        // Model
        lines.push(`model:      ${this.shortModel(turn.activeModel)}`);
        // Temperature — always shown, with clamping note when adjusted
        const rawTemp = turn.activeTemperature;
        const max = TEMP_MAX[provider] ?? 2;
        if (rawTemp !== undefined) {
            const effective = Math.max(0, Math.min(max, rawTemp));
            const note = effective !== rawTemp ? `  (clamped from ${rawTemp})` : "";
            lines.push(`temp:       ${effective}${note}`);
        }
        else {
            lines.push(`temp:       —  (provider default)`);
        }
        // top_p / top_k — show value or dash
        lines.push(`top_p:      ${turn.activeTopP !== undefined ? turn.activeTopP : "—"}`);
        if (turn.activeTopK !== undefined)
            lines.push(`top_k:      ${turn.activeTopK}`);
        // Thinking level
        lines.push(`thinking:   ${turn.activeThinkingBudget.toFixed(2)}`);
        // Memory + autofill
        const af = this.autoFillEnabled
            ? `autofill on (threshold=${this.autoFillThreshold.toFixed(2)})`
            : "autofill off";
        lines.push(`memory:     ${snap.config.memoryType}  ${af}`);
        // State integrity (shown only on resume)
        if (this.integrityStatus) {
            lines.push(`integrity:  ${this.integrityStatus}`);
        }
        if (this.environmentWarning) {
            lines.push(`environment: ${this.environmentWarning}`);
        }
        // Violations one-liner
        if (snap.violations && snap.violations.totalViolations > 0) {
            const v = snap.violations;
            const parts = [];
            if (v.plainTextResponses > 0)
                parts.push(`plain_text×${v.plainTextResponses}`);
            if (v.idleRounds > 0)
                parts.push(`idle×${v.idleRounds}`);
            if (v.sameToolLoops > 0)
                parts.push(`same_tool×${v.sameToolLoops}`);
            lines.push(`violations: ${parts.join("  ")}`);
        }
        return lines.join("\n");
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
        return model.length > 20 ? model.slice(0, 20) : model;
    }
}
