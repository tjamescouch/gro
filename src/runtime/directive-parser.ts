/**
 * DirectiveParser — extract and execute inline directives from assistant messages.
 *
 * Supported directives:
 * - 🧠        — persist fact to _learn.md and hot-patch system prompt
 * - @@ctrl:memory=type@@     — swap memory type at runtime
 * - 🧠 or 🧠 — request model switch
 * - 💡    — set thinking level
 * - 🧠          — bump thinking +0.3
 * - 🧠        — reduce thinking -0.3
 *
 * Directives are stripped from the displayed message but replaced with semantic emoji indicators:
 *   🦉 — thinking markers
 *   🔀 — model switch
 *   📚 — learn
 *   ⚙️ — control/config
 *   😊 — emotion
 *   ⚖️ — importance
 *   📎 — ref/unref
 *   💾 — memory
 *   🧠 — generic fallback
 *
 * Marker syntax inside fenced code blocks and backtick spans is preserved as-is
 * so documentation and examples render correctly.
 */

import { Logger } from "../logger.js";
import { runtimeConfig } from "./config-manager.js";

export interface ParsedDirectives {
  /** Cleaned message with directives removed */
  cleanedMessage: string;
  /** Facts to learn */
  learnFacts: string[];
  /** Memory type to swap to */
  memorySwap?: string;
  /** Model alias to switch to */
  modelSwitch?: string;
  /** Thinking level adjustment */
  thinkingLevel?: number;
}

// ---------------------------------------------------------------------------
// Segment-aware marker stripping
// ---------------------------------------------------------------------------

/** A chunk of the message, either raw prose or a protected code region. */
interface Segment {
  text: string;
  protected: boolean; // true = fenced block or backtick span — do not strip
}

/**
 * Split `content` into alternating prose / code segments so that marker
 * substitution is only applied to prose.
 *
 * Protected regions:
 *   - fenced code blocks:  ```...``` or ~~~...~~~
 *   - inline backtick spans: `...`
 */
function segmentByCode(content: string): Segment[] {
  const segments: Segment[] = [];
  // Matches fenced blocks (``` or ~~~, with optional lang) OR inline backtick spans
  const fenceOrInline = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|`[^`\n]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceOrInline.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: content.slice(lastIndex, match.index), protected: false });
    }
    segments.push({ text: match[0], protected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({ text: content.slice(lastIndex), protected: false });
  }

  return segments;
}

const OPEN = "@@";
const CLOSE = "@@";

/**
 * Strip live directive markers from prose segments only.
 * Markers inside fenced code blocks or backtick spans pass through untouched.
 * Each marker type is replaced with a semantic emoji.
 */
function stripMarkersOutsideCode(content: string): string {
  const segments = segmentByCode(content);

  return segments
    .map((seg) => {
      if (seg.protected) return seg.text;

      let t = seg.text;

      // Marker-specific emoji replacements (order matters — most specific first)
      t = t.replace(new RegExp(`${OPEN}importance\\(['"][\\d.]+['"]\\)${CLOSE}`, "g"), "⚖️");
      t = t.replace(new RegExp(`${OPEN}ref\\(['"][\\w-]+['"]\\)${CLOSE}`, "g"), "📎");
      t = t.replace(new RegExp(`${OPEN}unref\\(['"][\\w-]+['"]\\)${CLOSE}`, "g"), "📎");
      t = t.replace(new RegExp(`${OPEN}mem:[\\w-]+${CLOSE}`, "g"), "💾");
      t = t.replace(new RegExp(`${OPEN}learn\\(['"].+?['"]\\)${CLOSE}`, "g"), "📚");
      t = t.replace(new RegExp(`${OPEN}(?:model-change|model)\\(['"].+?['"]\\)${CLOSE}`, "g"), "🔀");
      t = t.replace(new RegExp(`${OPEN}thinking\\([\\d.]+\\)${CLOSE}`, "g"), "🦉");
      t = t.replace(new RegExp(`${OPEN}(?:thinking-up|think)${CLOSE}`, "g"), "🦉");
      t = t.replace(new RegExp(`${OPEN}(?:thinking-down|relax|zzz)${CLOSE}`, "g"), "🦉");
      t = t.replace(new RegExp(`${OPEN}ctrl:[\\w=]+${CLOSE}`, "g"), "⚙️");

      // Emotion markers: @@joy:0.5@@ @@sadness:0.2,urgency:0.8@@ etc.
      const emotions = "joy|sadness|anger|fear|surprise|confidence|uncertainty|excitement|calm|urgency|reverence";
      t = t.replace(
        new RegExp(
          `${OPEN}(?:${emotions}):[0-9.]+(?:,(?:${emotions}):[0-9.]+)*${CLOSE}`,
          "g"
        ),
        "😊"
      );

      // Generic fallback — any remaining markers → 🧠
      t = t.replace(new RegExp(`${OPEN}[a-zA-Z][a-zA-Z0-9_-]*(?:\\([^)]*\\))?${CLOSE}`, "g"), "🧠");

      return t;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Main parse / execute functions
// ---------------------------------------------------------------------------

/**
 * Parse directives from an assistant message.
 * Returns cleaned message and extracted directives.
 */
export function parseDirectives(content: string): ParsedDirectives {
  let cleaned = content;
  const result: ParsedDirectives = {
    cleanedMessage: content,
    learnFacts: [],
  };

  // Build a prose-only view for directive matching — strips code blocks/spans
  // so directives inside fenced blocks or backtick spans are never executed.
  // We replace protected segments with whitespace of equal length to preserve offsets
  // isn't needed — we just need a string safe to match against.
  const proseOnly = segmentByCode(content)
    .map((seg) => (seg.protected ? " ".repeat(seg.text.length) : seg.text))
    .join("");

  // 🧠
  const learnPattern = new RegExp(`${OPEN}learn\\(['"](.+?)['"]\\)${CLOSE}`, "g");
  let match;
  while ((match = learnPattern.exec(proseOnly)) !== null) {
    result.learnFacts.push(match[1]);
    cleaned = cleaned.replace(match[0], "📚");
  }

  // @@ctrl:memory=type@@
  const memoryPattern = new RegExp(`${OPEN}ctrl:memory=(\\w+)${CLOSE}`);
  const memoryMatch = proseOnly.match(memoryPattern);
  if (memoryMatch) {
    result.memorySwap = memoryMatch[1];
    cleaned = cleaned.replace(memoryMatch[0], "⚙️");
  }

  // 🧠 or 🧠
  const modelPattern = new RegExp(`${OPEN}(?:model-change|model)\\(['"](.+?)['"]\\)${CLOSE}`);
  const modelMatch = proseOnly.match(modelPattern);
  if (modelMatch) {
    result.modelSwitch = modelMatch[1];
    cleaned = cleaned.replace(modelMatch[0], "🔀");
  }

  // 💡
  const thinkingPattern = new RegExp(`${OPEN}thinking\\(([\\d.]+)\\)${CLOSE}`);
  const thinkingMatch = proseOnly.match(thinkingPattern);
  if (thinkingMatch) {
    const level = parseFloat(thinkingMatch[1]);
    if (!isNaN(level)) {
      result.thinkingLevel = level;
      cleaned = cleaned.replace(thinkingMatch[0], "🦉");
    }
  }

  // 🧠 or 💡 — bump +0.3
  const thinkingUp = new RegExp(`${OPEN}(?:thinking-up|think)${CLOSE}`, "g");
  if (thinkingUp.test(proseOnly)) {
    const current = runtimeConfig.getThinkingLevel();
    result.thinkingLevel = Math.min(1.0, current + 0.3);
    cleaned = cleaned.replace(thinkingUp, "🦉");
  }

  // 🧠 or 💡 or 💡 — reduce -0.3
  const thinkingDown = new RegExp(`${OPEN}(?:thinking-down|relax|zzz)${CLOSE}`, "g");
  if (thinkingDown.test(proseOnly)) {
    const current = runtimeConfig.getThinkingLevel();
    result.thinkingLevel = Math.max(0.0, current - 0.3);
    cleaned = cleaned.replace(thinkingDown, "🦉");
  }

  // Strip display-only markers from prose only — code blocks/spans pass through
  cleaned = stripMarkersOutsideCode(cleaned);

  // Collapse consecutive duplicate emoji
  cleaned = cleaned.replace(/🧠+/g, "🧠");
  cleaned = cleaned.replace(/💡+/g, "💡");
  cleaned = cleaned.replace(/🦉+/g, "🦉");
  cleaned = cleaned.replace(/🔀+/g, "🔀");
  cleaned = cleaned.replace(/📚+/g, "📚");
  cleaned = cleaned.replace(/😊+/g, "😊");
  cleaned = cleaned.replace(/⚖️+/g, "⚖️");
  cleaned = cleaned.replace(/📎+/g, "📎");
  cleaned = cleaned.replace(/💾+/g, "💾");
  cleaned = cleaned.replace(/⚙️+/g, "⚙️");

  result.cleanedMessage = cleaned.trim();
  return result;
}

/**
 * Execute directives extracted from a message.
 * Should be called after parseDirectives() in the chat loop.
 */
export async function executeDirectives(directives: ParsedDirectives): Promise<void> {
  // Learn facts
  for (const fact of directives.learnFacts) {
    try {
      await runtimeConfig.learn(fact);
    } catch (err: any) {
      Logger.error(`Failed to execute @@learn: ${err.message}`);
    }
  }

  // Memory swap
  if (directives.memorySwap) {
    try {
      await runtimeConfig.swapMemory(directives.memorySwap);
    } catch (err: any) {
      Logger.error(`Failed to swap memory to '${directives.memorySwap}': ${err.message}`);
    }
  }

  // Thinking level
  if (directives.thinkingLevel !== undefined) {
    runtimeConfig.setThinkingLevel(directives.thinkingLevel);
    Logger.info(`Thinking level set to ${directives.thinkingLevel.toFixed(2)}`);
  }

  // Model switch (logged but requires external handling in chat loop)
  if (directives.modelSwitch) {
    Logger.info(`Model switch requested: ${directives.modelSwitch}`);
  }
}
