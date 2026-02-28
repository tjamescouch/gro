/**
 * Box-drawing helpers for sensory channel rendering.
 *
 * All channels render into an 82-char-wide box using these primitives.
 * Total width = 82 (including ║ borders). Inner content = 80 chars.
 */

/** Total width of the rendered box. */
export const W = 82;
/** Inner width between ║ borders. */
export const IW = 80;

/** Top border: ╔══...══╗ */
export function topBorder(): string {
  return "╔" + "═".repeat(IW) + "╗";
}

/** Bottom border: ╚══...══╝ */
export function bottomBorder(): string {
  return "╚" + "═".repeat(IW) + "╝";
}

/** Horizontal divider: ╠══...══╣ */
export function divider(): string {
  return "╠" + "═".repeat(IW) + "╣";
}

/**
 * Section divider with label: ╠══[LABEL]══...══╣
 * Total width = W (82 chars).
 */
export function sectionDivider(label: string): string {
  const tag = `══[${label}]`;
  const remaining = IW - tag.length;
  return "╠" + tag + "═".repeat(Math.max(0, remaining)) + "╣";
}

/**
 * Content row: ║<inner>║
 * Inner is padded/truncated to exactly IW chars.
 */
export function row(inner: string): string {
  const padded = inner.length > IW ? inner.slice(0, IW) : inner.padEnd(IW);
  return "║" + padded + "║";
}

/**
 * Render a progress bar of the given width.
 * @param frac Fraction filled (0-1)
 * @param width Number of characters in the bar
 * @returns String of █ and ░ characters
 */
export function bar(frac: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, frac));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Right-pad a string to exactly `len` characters, truncating if needed. */
export function rpad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s.padEnd(len);
}

/** Left-pad a string to exactly `len` characters, truncating if needed. */
export function lpad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s.padStart(len);
}
