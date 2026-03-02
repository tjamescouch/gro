/**
 * Stream Marker Parser
 *
 * Intercepts @@name('arg')@@ and @@name:value@@ patterns in the token stream.
 *
 * IMPORTANT: This file implements a STREAMING parser. Markers may be split
 * across token/chunk boundaries (e.g. "@" then "@think@@"). The streaming
 * parser uses a character-scanning state machine rather than regex to handle
 * split boundaries reliably.
 *
 * Marker behavior:
 * - Markers are replaced with emoji indicators in the *clean text*.
 * - For streaming: by default, only normal text is forwarded via opts.onToken.
 *   Emojis are only forwarded when Logger.isVerbose().
 * - On final flush: if we end on an unterminated marker prefix/tail, we emit
 *   a visible placeholder "❓".
 *
 * Built-in marker types:
 *   @@model-change('sonnet')@@  — switch the active model mid-stream
 *   @@callback('name')@@       — fire a named callback
 *   @@emotion('happy')@@       — set facial expression / emotion state
 *   @@importance('0.9')@@      — tag message importance (0.0-1.0) for memory paging priority
 *   @@confidence:0.9@@         — colon-format emotion dimension
 *   @@joy:0.5,confidence:0.8@@ — multi-value colon-format dimensions
 *
 * Avatar markers (@@[...]@@):
 *   @@[face excited:1.0,full cheerful:0.8]@@  — animate avatar clips with weights
 */

import { Logger } from "./logger.js";

export interface StreamMarker {
  /** Marker name, e.g. "model-change", "emotion", "callback" */
  name: string;
  /** The argument string passed in the marker, e.g. "sonnet" */
  arg: string;
  /** Raw matched text, e.g. "🧠" */
  raw: string;
}

export interface MarkerHandler {
  (marker: StreamMarker): void;
}

/** Parsed avatar animation command: clip name → weight (0.0–1.0). */
export type AvatarMarkerHandler = (clips: Record<string, number>) => void;

export interface MarkerParserOptions {
  /** Called when a complete marker is detected */
  onMarker: MarkerHandler;
  /** Called when an avatar marker @@[clip:weight,...]@@ is detected */
  onAvatarMarker?: AvatarMarkerHandler;
  /** Original onToken callback to forward clean (marker-stripped) text to */
  onToken?: (s: string) => void;
}

/**
 * Marker regexes are kept ONLY for non-streaming extraction (extractMarkers).
 * Streaming parsing uses StreamMarkerParser.processBuffer() state machine.
 */
const MARKER_RE = /(?<!\\)@@([a-zA-Z][a-zA-Z0-9_-]*)(?:\((?:'([^']*?)'|"([^"]*?)"|([^)]*?))\))?@@/g;
const COLON_MARKER_RE = /(?<!\\)@@([a-zA-Z][a-zA-Z0-9_-]*:[0-9.]+(?:,[a-zA-Z][a-zA-Z0-9_-]*:[0-9.]+)*)@@/g;

/** Avatar marker: @@[clip name:weight, ...]@@ */
const AVATAR_MARKER_RE = /@@\[([^\]@]+)\]@@/g;
const AVATAR_EMOJI = "\u{1F3AD}";  // 🎭

/** Thinking-related marker names get 🦉, everything else gets 🧠 */
const THINKING_MARKERS = new Set(["think", "relax", "zzz", "thinking"]);
/**
 * Reserved marker names — cannot be used as emotion dimensions.
 * Prevents collisions with built-in control markers.
 */
const RESERVED_MARKERS = new Set([
  "model-change", "ref", "unref", "importance", "thinking", "think", "relax", "zzz",
  "memory", "callback", "emotion", "dim", "working", "memory-hotreload", "learn",
  "recall", "max-context", "sense", "view", "resize", "resummarize", "reboot", "export"
]);

/**
 * Emotion dimensions — valid names for @@dim:value@@ or @@dim('0.5')@@ markers.
 * Prevents misuse of reserved keywords.
 */
const EMOTION_DIMS = new Set([
  "joy", "sadness", "anger", "fear", "surprise", "confidence", "uncertainty",
  "excitement", "calm", "urgency", "reverence"
]);


const MARKER_EMOJI: Record<string, string> = {
  "thinking": "\u{1F989}",       // 🦉
  "think": "\u{1F989}",          // 🦉
  "relax": "\u{1F989}",          // 🦉
  "zzz": "\u{1F989}",            // 🦉
  "model-change": "\u{1F500}",   // 🔀
  "learn": "\u{1F4DA}",          // 📚
  "ctrl": "\u{2699}\u{FE0F}",    // ⚙️
  "importance": "\u{2696}\u{FE0F}", // ⚖️
  "ref": "\u{1F4CE}",            // 📎
  "unref": "\u{1F4CE}",          // 📎
  "memory": "\u{1F4BE}",         // 💾
  "temp": "\u{1F321}\u{FE0F}",   // 🌡️
  "temperature": "\u{1F321}\u{FE0F}", // 🌡️
  "top_k": "\u{2699}\u{FE0F}",   // ⚙️
  "top_p": "\u{2699}\u{FE0F}",   // ⚙️
  "max-context": "\u{1F4D0}",    // 📐
  "sense": "\u{1F441}\u{FE0F}",  // 👁️
  "view": "\u{1F4F7}",            // 📷
  "resummarize": "\u{1F504}",     // 🔄
};

function markerEmoji(name: string): string {
  if (MARKER_EMOJI[name]) return MARKER_EMOJI[name];
  if (EMOTION_DIMS.has(name)) return "\u{1F60A}";  // 😊
  return "\u{1F9E0}";  // 🧠 fallback
}

export interface MarkerParser {
  /** Feed tokens through the parser. Clean text is forwarded to onToken. */
  onToken: (s: string) => void;
  /** Get all accumulated clean text (markers stripped) */
  getCleanText: () => string;
  /** Get all markers detected so far */
  getMarkers: () => StreamMarker[];
  /** Flush any buffered partial content (call at end of stream) */
  flush: () => void;
  /** Reset parser state for reuse */
  reset: () => void;
}

/**
 * Validate marker name and arg — prevent reserved keyword collisions.
 * Returns { valid: boolean, error?: string }
 */
function validateMarker(name: string, arg: string): { valid: boolean; error?: string } {
  // Check if it's a reserved marker
  if (RESERVED_MARKERS.has(name)) {
    return { valid: true }; // Reserved markers are always valid
  }

  // If it looks like an emotion dimension, validate against allowed dims
  if (EMOTION_DIMS.has(name)) {
    // Parse arg as potential dimension value (0.0-1.0)
    const val = parseFloat(arg);
    if (isNaN(val) || val < 0 || val > 1) {
      return { valid: false, error: `Emotion dim '${name}' expects numeric value 0.0-1.0, got '${arg}'` };
    }
    return { valid: true };
  }

  // Unknown marker name — allow but log warning
  return { valid: true };
}

/**
 * Strip escape sequences \@@ → @@ in the output.
 * Call this on final clean text to unescape literal @@ markers.
 */
function unescapeMarkers(text: string): string {
  return text.replace(/\@@/g, "@@");
}

/**
 * Parse avatar marker contents "clip name:0.8, other clip:1.0" into Record<string, number>.
 * Each entry is "name:weight" where weight defaults to 1.0 if omitted.
 */
function parseAvatarClips(contents: string): Record<string, number> {
  const clips: Record<string, number> = {};
  for (const part of contents.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.lastIndexOf(":");
    if (colonIdx > 0) {
      const name = trimmed.slice(0, colonIdx).trim();
      const weight = parseFloat(trimmed.slice(colonIdx + 1));
      clips[name] = isNaN(weight) ? 1.0 : Math.max(0, Math.min(1, weight));
    } else {
      clips[trimmed] = 1.0;
    }
  }
  return clips;
}

/**
 * Scan a string for markers, fire the handler for each, and return cleaned text.
 * Unlike the streaming parser, this operates on a complete string (e.g. tool call arguments).
 */
export function extractMarkers(text: string, onMarker: MarkerHandler, onAvatarMarker?: AvatarMarkerHandler): string {
  // First pass: strip avatar markers @@[...]@@ before standard marker processing
  let preprocessed = text;
  if (onAvatarMarker) {
    preprocessed = text.replace(new RegExp(AVATAR_MARKER_RE.source, "g"), (_full, contents: string) => {
      const clips = parseAvatarClips(contents);
      try { onAvatarMarker(clips); } catch (e) { Logger.warn(`Avatar marker handler error: ${e}`); }
      return AVATAR_EMOJI;
    });
  }

  // Second pass: colon-format markers (more specific, must run first)
  // Do colon replacement first, then function-form on result
  let cleaned = "";
  let lastIndex = 0;
  const regex = new RegExp(MARKER_RE.source, "g");
  let match: RegExpExecArray | null;

  let afterColon = "";
  let cLastIndex = 0;
  const colonRegex = new RegExp(COLON_MARKER_RE.source, "g");
  let cMatch: RegExpExecArray | null;

  while ((cMatch = colonRegex.exec(preprocessed)) !== null) {
    if (cMatch.index > 0 && preprocessed[cMatch.index - 1] === '\\') {
      afterColon += preprocessed.slice(cLastIndex, cMatch.index + cMatch[0].length);
      cLastIndex = cMatch.index + cMatch[0].length;
      continue;
    }

    afterColon += preprocessed.slice(cLastIndex, cMatch.index);

    const pairs = cMatch[1].split(",");
    let firstEmoji = "";
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(":");
      const name = pair.slice(0, colonIdx);
      const arg = pair.slice(colonIdx + 1);
      const raw = cMatch[0];

      const validation = validateMarker(name, arg);
      if (!validation.valid) {
        Logger.warn(`Invalid marker: ${validation.error}`);
        continue;
      }

      const marker: StreamMarker = { name, arg, raw };
      try { onMarker(marker); } catch (e) {
        Logger.warn(`Marker handler error: ${e}`);
      }
      if (!firstEmoji) firstEmoji = markerEmoji(name);
    }

    afterColon += firstEmoji || markerEmoji(pairs[0].split(":")[0]);
    cLastIndex = cMatch.index + cMatch[0].length;
  }
  afterColon += preprocessed.slice(cLastIndex);

  // Now run function-form regex on the colon-cleaned text
  lastIndex = 0;
  while ((match = regex.exec(afterColon)) !== null) {
    if (match.index > 0 && afterColon[match.index - 1] === '\\') {
      cleaned += afterColon.slice(lastIndex, match.index + match[0].length);
      lastIndex = match.index + match[0].length;
      continue;
    }

    cleaned += afterColon.slice(lastIndex, match.index);
    const marker: StreamMarker = {
      name: match[1],
      arg: match[2] ?? match[3] ?? match[4] ?? "",
      raw: match[0],
    };

    const validation = validateMarker(marker.name, marker.arg);
    if (!validation.valid) {
      Logger.warn(`Invalid marker: ${validation.error}`);
      cleaned += match[0];
      lastIndex = match.index + match[0].length;
      continue;
    }

    try { onMarker(marker); } catch (e) {
      Logger.warn(`Marker handler error: ${e}`);
    }
    cleaned += markerEmoji(marker.name);
    lastIndex = match.index + match[0].length;
  }
  cleaned += afterColon.slice(lastIndex);
  return unescapeMarkers(cleaned);
}

/**
 * StreamMarkerParser — delimiter-safe streaming parser.
 *
 * This is a character-scanning state machine that:
 * - scans for @@ ... @@
 * - parses avatar markers @@[...]@@, function markers @@name('arg')@@,
 *   and colon markers @@name:value@@
 * - is safe when @@ delimiter is split across streaming boundaries
 */
export class StreamMarkerParser implements MarkerParser {
  private buffer = "";
  private cleanText = "";
  private markers: StreamMarker[] = [];
  private opts: MarkerParserOptions;

  constructor(opts: MarkerParserOptions) {
    this.opts = opts;
  }

  onToken = (s: string): void => {
    this.buffer += s;
    this.processBuffer(false);
  };

  flush = (): void => {
    this.processBuffer(true);
  };

  getCleanText = (): string => this.cleanText;
  getMarkers = (): StreamMarker[] => [...this.markers];

  reset = (): void => {
    this.buffer = "";
    this.cleanText = "";
    this.markers = [];
  };

  private emitText(text: string): void {
    if (!text) return;
    const unescaped = text.replace(/\\@@/g, "@@");
    this.cleanText += unescaped;
    if (this.opts.onToken) this.opts.onToken(unescaped);
  }

  private emitEmoji(name: string): void {
    const emoji = markerEmoji(name);
    this.cleanText += emoji;
    // Always emit marker emojis to onToken so the streamed output matches cleanText.
    if (this.opts.onToken) this.opts.onToken(emoji);
  }

  private handleMarkerMatch(name: string, arg: string, raw: string): void {
    const validation = validateMarker(name, arg);
    if (!validation.valid) {
      Logger.warn(`Invalid marker: ${validation.error}`);
      this.cleanText += raw;
      if (this.opts.onToken) this.opts.onToken(raw);
      return;
    }

    const marker: StreamMarker = { name, arg, raw };
    this.markers.push(marker);
    Logger.debug(`Stream marker detected: ${raw}`);

    try {
      this.opts.onMarker(marker);
    } catch (e: unknown) {
      Logger.warn(`Marker handler error for ${name}: ${e}`);
    }

    this.emitEmoji(name);
  }

  /**
   * Mask markers inside backtick code spans/fences so they aren't parsed.
   * Replaces @@ with \@@ inside `...` and ```...``` regions.
   */
  private maskCodeSpans(text: string): string {
    let result = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/@@/g, "\\@@"));
    result = result.replace(/`[^`]+`/g, (m) => m.replace(/@@/g, "\\@@"));
    return result;
  }

  // --- Streaming parse helpers ---

  private isNameChar(c: string): boolean {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") ||
           (c >= "0" && c <= "9") || c === "_" || c === "-";
  }

  private readUntilUnescaped(s: string, start: number, terminator: string): number {
    for (let i = start; i < s.length; i++) {
      if (s[i] === "\\") { i++; continue; }
      if (s[i] === terminator) return i;
    }
    return -1;
  }

  private tryParseMarkerAt(s: string, atIdx: number):
    | { kind: "partial" }
    | { kind: "no" }
    | { kind: "marker"; name: string; arg: string; raw: string; end: number }
    | { kind: "colon"; name: string; payload: string; raw: string; end: number } {
    // precondition: s[atIdx..atIdx+1] === '@@'
    let i = atIdx + 2;
    if (i >= s.length) return { kind: "partial" };

    // Avatar: @@[ ... ]@@
    if (s[i] === "[") {
      const endBracket = this.readUntilUnescaped(s, i + 1, "]");
      if (endBracket === -1) return { kind: "partial" };
      if (endBracket + 2 >= s.length) return { kind: "partial" };
      if (s[endBracket + 1] !== "@" || s[endBracket + 2] !== "@") return { kind: "no" };

      const raw = s.slice(atIdx, endBracket + 3);
      const arg = s.slice(i + 1, endBracket);
      return { kind: "marker", name: "avatar", arg, raw, end: endBracket + 3 };
    }

    // Marker name must start with a letter
    if (!(s[i] >= "a" && s[i] <= "z") && !(s[i] >= "A" && s[i] <= "Z")) {
      return { kind: "no" };
    }

    const nameStart = i;
    while (i < s.length && this.isNameChar(s[i])) i++;
    if (i >= s.length) return { kind: "partial" };
    const name = s.slice(nameStart, i);

    // Colon-form: @@name:value@@ or @@name:v,name:v@@
    if (s[i] === ":") {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === "\\") { j += 2; continue; }
        if (s[j] === "@" && j + 1 < s.length && s[j + 1] === "@") {
          const payload = s.slice(i + 1, j);
          if (!payload) return { kind: "no" }; // @@name:@@ with empty value is not valid
          const raw = s.slice(atIdx, j + 2);
          return { kind: "colon", name, payload, raw, end: j + 2 };
        }
        j++;
      }
      return { kind: "partial" };
    }

    // Optional (arg)
    let arg = "";
    if (s[i] === "(") {
      const endParen = this.readUntilUnescaped(s, i + 1, ")");
      if (endParen === -1) return { kind: "partial" };
      arg = s.slice(i + 1, endParen);
      if ((arg.startsWith("'") && arg.endsWith("'")) ||
          (arg.startsWith('"') && arg.endsWith('"'))) {
        arg = arg.slice(1, -1);
      }
      i = endParen + 1;
    }

    // Close @@
    if (i + 1 >= s.length) return { kind: "partial" };
    if (s[i] !== "@" || s[i + 1] !== "@") return { kind: "no" };

    const end = i + 2;
    const raw = s.slice(atIdx, end);
    return { kind: "marker", name, arg, raw, end };
  }

  private processBuffer(isFinal: boolean): void {
    this.buffer = this.maskCodeSpans(this.buffer);
    if (!this.buffer) return;

    const s = this.buffer;
    let i = 0;
    let lastTextStart = 0;

    const flushTextUpTo = (endIdx: number): void => {
      if (endIdx > lastTextStart) this.emitText(s.slice(lastTextStart, endIdx));
      lastTextStart = endIdx;
    };

    while (i < s.length) {
      if (s[i] === "@" && i + 1 < s.length && s[i + 1] === "@") {
        // Check for escape: \@@ means literal @@
        if (i > 0 && s[i - 1] === "\\") {
          if (i - 1 > lastTextStart) this.emitText(s.slice(lastTextStart, i - 1));
          this.emitText("@@");
          i += 2;
          lastTextStart = i;
          continue;
        }

        const parsed = this.tryParseMarkerAt(s, i);

        if (parsed.kind === "marker") {
          flushTextUpTo(i);

          if (parsed.name === "avatar") {
            const clips = parseAvatarClips(parsed.arg);
            Logger.debug(`Avatar marker detected: ${JSON.stringify(clips)}`);
            try {
              if (this.opts.onAvatarMarker) this.opts.onAvatarMarker(clips);
            } catch (e) {
              Logger.warn(`Avatar marker handler error: ${e}`);
            }
            this.emitEmoji("ctrl");
          } else {
            this.handleMarkerMatch(parsed.name, parsed.arg ?? "", parsed.raw);
          }

          i = parsed.end;
          lastTextStart = i;
          continue;
        }

        if (parsed.kind === "colon") {
          flushTextUpTo(i);

          const fullPayload = parsed.name + ":" + parsed.payload;
          const pairs = fullPayload.split(",");
          let firstEmoji = "";
          for (const pair of pairs) {
            const colonIdx = pair.indexOf(":");
            if (colonIdx === -1) continue;
            const dim = pair.slice(0, colonIdx).trim();
            const val = pair.slice(colonIdx + 1).trim();

            const validation = validateMarker(dim, val);
            if (!validation.valid) {
              Logger.warn(`Invalid marker: ${validation.error}`);
              continue;
            }

            const marker: StreamMarker = { name: dim, arg: val, raw: parsed.raw };
            this.markers.push(marker);
            Logger.debug(`Stream marker detected: @@${dim}:${val}@@`);
            try {
              this.opts.onMarker(marker);
            } catch (e: unknown) {
              Logger.warn(`Marker handler error for ${dim}: ${e}`);
            }

            if (!firstEmoji) firstEmoji = markerEmoji(dim);
          }

          const emoji = firstEmoji || markerEmoji(parsed.name);
          this.cleanText += emoji;
          if (this.opts.onToken) this.opts.onToken(emoji);

          i = parsed.end;
          lastTextStart = i;
          continue;
        }

        if (parsed.kind === "partial") {
          flushTextUpTo(i);

          if (isFinal) {
            // Unterminated marker tail at end of stream
            this.cleanText += "\u{2753}"; // ❓
            if (this.opts.onToken) this.opts.onToken("\u{2753}");
            this.buffer = "";
          } else {
            this.buffer = s.slice(i);
          }
          return;
        }

        // parsed.kind === "no": treat the leading "@@" as literal text.
        // We must emit it now (otherwise it disappears from cleanText)
        // and continue scanning after it.
        flushTextUpTo(i);
        this.emitText("@@");
        i += 2;
        lastTextStart = i;
        continue;
      }

      // If '@' is at the very end of a non-final buffer, it might be the
      // start of '@@'. Hold it back for the next chunk.
      if (!isFinal && s[i] === "@" && i === s.length - 1) {
        flushTextUpTo(i);
        this.buffer = "@";
        return;
      }

      i++;
    }

    // No partial marker tails: flush everything
    flushTextUpTo(s.length);
    this.buffer = "";
  }
}

/**
 * Factory function — backward-compatible wrapper around StreamMarkerParser.
 */
export function createMarkerParser(opts: MarkerParserOptions): MarkerParser {
  return new StreamMarkerParser(opts);
}
