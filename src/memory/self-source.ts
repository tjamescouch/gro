/**
 * SelfSource — writable sensory channel (model's etch-a-sketch).
 *
 * Box-drawn 48-char-wide panel. Content is set via `write_self` tool.
 * When empty, shows a template with labeled zones.
 * Content word-wraps at 44 chars inside the border.
 */

import type { SensorySource } from "./sensory-memory.js";
import { topBorder, bottomBorder, divider, row, IW } from "./box.js";

/** Usable content width inside `║ ` and ` ║` = 44 chars. */
const CONTENT_W = 44;

export class SelfSource implements SensorySource {
  private content: string = "";

  /** Replace the entire self channel content. */
  setContent(content: string): void {
    this.content = content;
  }

  /** Get the current self channel content (for persistence). */
  getContent(): string {
    return this.content;
  }

  async poll(): Promise<string | null> {
    return this.render();
  }

  destroy(): void {}

  private render(): string {
    const lines: string[] = [];

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
    } else {
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
  private wordWrap(text: string, width: number): string[] {
    const sourceLines = text.split("\n");
    const result: string[] = [];
    for (const line of sourceLines) {
      if (line.length <= width) {
        result.push(line);
      } else {
        let remaining = line;
        while (remaining.length > width) {
          let breakAt = remaining.lastIndexOf(" ", width);
          if (breakAt <= 0) breakAt = width;
          result.push(remaining.slice(0, breakAt));
          remaining = remaining.slice(breakAt).trimStart();
        }
        if (remaining) result.push(remaining);
      }
    }
    return result;
  }
}
