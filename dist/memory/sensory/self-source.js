/**
 * SelfSource — writable sensory channel (model's etch-a-sketch).
 *
 * Box-drawn 80-char-wide panel. Content is set via `write_self` tool.
 * When empty, shows a template with labeled zones.
 * Content word-wraps at 76 chars inside the border.
 */
import { topBorder, bottomBorder, divider, row, IW } from "./box.js";
/** Usable content width inside `║ ` and ` ║` = 76 chars. */
const CONTENT_W = 76;
export class SelfSource {
    constructor() {
        this.content = "";
    }
    /** Replace the entire self channel content. */
    setContent(content) {
        this.content = content;
    }
    /** Get the current self channel content (for persistence). */
    getContent() {
        return this.content;
    }
    async poll() {
        return this.render();
    }
    destroy() { }
    render() {
        const lines = [];
        // Header
        lines.push(topBorder());
        lines.push(row(" SELF".padEnd(IW)));
        lines.push(divider());
        if (this.content) {
            // Word-wrap content into the box
            const wrappedLines = this.wordWrap(this.content, CONTENT_W);
            for (const wl of wrappedLines) {
                lines.push(row(" " + wl.padEnd(IW - 1)));
            }
        }
        else {
            // Empty template with labeled zones
            lines.push(row(""));
            lines.push(row(" " + " current task " + ".".repeat(IW - 15)));
            lines.push(row(" " + ".".repeat(IW - 1)));
            lines.push(row(""));
            lines.push(row(" " + " open threads " + ".".repeat(IW - 15)));
            lines.push(row(" " + ".".repeat(IW - 1)));
            lines.push(row(""));
            lines.push(row(" " + " state " + ".".repeat(IW - 8)));
            lines.push(row(" " + ".".repeat(IW - 1)));
            lines.push(row(""));
        }
        lines.push(bottomBorder());
        return lines.join("\n");
    }
    /** Word-wrap a string to fit within `width` characters. */
    wordWrap(text, width) {
        const sourceLines = text.split("\n");
        const result = [];
        for (const line of sourceLines) {
            if (line.length <= width) {
                result.push(line);
            }
            else {
                let remaining = line;
                while (remaining.length > width) {
                    let breakAt = remaining.lastIndexOf(" ", width);
                    if (breakAt <= 0)
                        breakAt = width;
                    result.push(remaining.slice(0, breakAt));
                    remaining = remaining.slice(breakAt).trimStart();
                }
                if (remaining)
                    result.push(remaining);
            }
        }
        return result;
    }
}
