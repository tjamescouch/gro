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
    }
    setAutoFill(enabled, threshold) {
        this.autoFillEnabled = enabled;
        this.autoFillThreshold = threshold;
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
        // Temperature with clamping note
        if (turn.activeTemperature !== undefined) {
            const raw = turn.activeTemperature;
            const max = TEMP_MAX[provider] ?? 2;
            const effective = Math.max(0, Math.min(max, raw));
            const note = effective !== raw ? `  (clamped from ${raw})` : "";
            lines.push(`temp:       ${effective}${note}`);
        }
        // top_p / top_k — only show if set
        if (turn.activeTopP !== undefined)
            lines.push(`top_p:      ${turn.activeTopP}`);
        if (turn.activeTopK !== undefined)
            lines.push(`top_k:      ${turn.activeTopK}`);
        // Thinking level
        lines.push(`thinking:   ${turn.activeThinkingBudget.toFixed(2)}`);
        // Memory + autofill
        const af = this.autoFillEnabled
            ? `autofill on (threshold=${this.autoFillThreshold.toFixed(2)})`
            : "autofill off";
        lines.push(`memory:     ${snap.config.memoryType}  ${af}`);
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
