/**
 * AwarenessSource — sensory channel that surfaces familiarity and deja vu signals.
 *
 * Renders a compact box-drawn panel showing:
 *   FAMILIAR  main.ts=0.92  version.js=0.55  ...
 *   DEJA_VU   ⚠ shell("cat overlay/version.js") seen 3x, last turn 38
 *
 * These are sensors, not locks. The agent sees them and self-corrects.
 */
import { topBorder, bottomBorder, divider, row, IW } from "./box.js";
export class AwarenessSource {
    constructor() {
        this.familiarity = null;
        this.dejaVu = null;
    }
    setFamiliarity(tracker) {
        this.familiarity = tracker;
    }
    setDejaVu(tracker) {
        this.dejaVu = tracker;
    }
    async poll() {
        return this.render();
    }
    destroy() { }
    render() {
        const lines = [];
        lines.push(topBorder());
        lines.push(row(" AWARENESS".padEnd(IW)));
        lines.push(divider());
        // Familiarity line
        lines.push(row(this.renderFamiliarity()));
        // Deja vu lines
        const dvLines = this.renderDejaVu();
        if (dvLines.length > 0) {
            lines.push(divider());
            for (const l of dvLines)
                lines.push(row(l));
        }
        lines.push(bottomBorder());
        return lines.join("\n");
    }
    renderFamiliarity() {
        if (!this.familiarity || this.familiarity.size === 0) {
            return " FAMILIAR  (none)".padEnd(IW);
        }
        const top = this.familiarity.top(6).filter(e => e.score >= 0.1);
        if (top.length === 0) {
            return " FAMILIAR  (none)".padEnd(IW);
        }
        const parts = top.map(e => `${e.label}=${e.score.toFixed(2)}`);
        let line = " FAMILIAR  " + parts.join("  ");
        // Truncate if too long
        if (line.length > IW) {
            line = line.slice(0, IW - 1) + "…";
        }
        return line.padEnd(IW);
    }
    renderDejaVu() {
        if (!this.dejaVu)
            return [];
        const warnings = this.dejaVu.warnings();
        if (warnings.length === 0)
            return [];
        const lines = [];
        // Show top 3 warnings max
        for (const w of warnings.slice(0, 3)) {
            const snippet = w.argsSnippet.length > 45
                ? w.argsSnippet.slice(0, 42) + "..."
                : w.argsSnippet;
            let line = ` DEJA_VU   ⚠ ${w.toolName}("${snippet}") ${w.count}x, turn ${w.turn}`;
            if (line.length > IW) {
                line = line.slice(0, IW - 1) + "…";
            }
            lines.push(line.padEnd(IW));
        }
        return lines;
    }
}
