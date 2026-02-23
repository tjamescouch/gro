/**
 * Stream Marker Parser
 *
 * Intercepts 🧠 patterns in the token stream.
 * Generic architecture — any marker type can register a handler.
 *
 * Markers are replaced with emoji indicators in the output stream:
 *   💡 for thinking markers (think, relax, zzz, thinking)
 *   🧠 for all other markers (model-change, importance, ref, etc.)
 *
 * When a complete marker is detected, the registered handler fires.
 *
 * Built-in marker types:
 *   🔀  — switch the active model mid-stream
 *   🧠       — fire a named callback
 *   🧠       — set facial expression / emotion state
 *   ⚖️      — tag message importance (0.0-1.0) for memory paging priority
 *   🧠 — set processing texture posture (smooth/rough/sharp/flat/dense/sparse)
 *
 * Usage:
 *   const parser = createMarkerParser({ onMarker: (name, arg) => { ... } });
 *   // Wrap your onToken callback:
 *   driver.chat(messages, { onToken: parser.onToken });
 *   // After the response, get clean text:
 *   const cleanText = parser.getCleanText();
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

export interface MarkerParserOptions {
  /** Called when a complete marker is detected */
  onMarker: MarkerHandler;
  /** Original onToken callback to forward clean (marker-stripped) text to */
  onToken?: (s: string) => void;
}

/**
 * Regex for matching complete markers.
 * Supports: 🧠 and 🧠 and 🧠 and 🧠
 */
/**
 * Marker regex: 🧠 or 🧠 or 🧠
 * Non-greedy matching prevents consuming URLs like "http://..." incorrectly.
 * Supports escaped markers: @@ → treated as literal text.
 */
const MARKER_RE = /(?<!\\)@@([a-zA-Z][a-zA-Z0-9_-]*)(?:\((?:'([^']*?)'|"([^"]*?)"|([^)]*?))\))?@@/g;

/**
 * Regex to detect escaped markers (@@) — these should NOT be processed.
 */
const ESCAPED_MARKER_RE = /\@@/g;

/** Partial marker detection — we might be mid-stream in a marker */
const PARTIAL_MARKER_RE = /@@[a-zA-Z][a-zA-Z0-9_-]*(?:\([^)]*)?$/;

/** Thinking-related marker names get 💡, everything else gets 🧠 */
const THINKING_MARKERS = new Set(["think", "relax", "zzz", "thinking"]);
/**
 * Reserved marker names — cannot be used as emotion dimensions.
 * Prevents collisions with built-in control markers.
 */
const RESERVED_MARKERS = new Set([
  "model-change", "ref", "unref", "importance", "thinking", "think", "relax", "zzz",
  "memory", "callback", "emotion", "dim", "working", "memory-hotreload", "learn",
  "recall", "max-context", "texture"
]);

/**
 * Emotion dimensions — valid names for @@dim:value@@ or 🧠 markers.
 * Prevents misuse of reserved keywords.
 */
const EMOTION_DIMS = new Set([
  "joy", "sadness", "anger", "fear", "surprise", "confidence", "uncertainty",
  "excitement", "calm", "urgency", "reverence"
]);

/**
 * Texture dimensions — valid names inside 🧠.
 * Maps to processing posture (how the agent reads), distinct from emotion dims
 * (how the agent responds). See _texture.md for full semantics.
 *
 * smooth — predictable, gradual; flow state processing
 * rough  — high entropy, irregular; cautious granular attention
 * sharp  — abrupt discontinuity; reorient on each token
 * flat   — featureless, uniform; efficient cruise mode
 * dense  — compressed, high info; slow down, unpack carefully
 * sparse — open, low info; allow silence, don't fill gaps
 */
export const TEXTURE_DIMS = new Set([
  "smooth", "rough", "sharp", "flat", "dense", "sparse"
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
  "texture": "\u{1FAC8}",        // 🪨 (tactile/texture)
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
}

/**
 * Scan a string for markers, fire the handler for each, and return cleaned text.
 * Unlike the streaming parser, this operates on a complete string (e.g. tool call arguments).
 */

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
 * Parse a texture marker argument string into a dim→value map.
 * Accepts: "smooth:0.8" or "smooth:0.8,dense:0.5,rough:0.1"
 * Returns null on parse failure.
 */
export function parseTextureDims(arg: string): Record<string, number> | null {
  const result: Record<string, number> = {};
  const parts = arg.split(",").map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) return null;
    const dim = part.slice(0, colonIdx).trim();
    const valStr = part.slice(colonIdx + 1).trim();
    if (!TEXTURE_DIMS.has(dim)) return null;
    const val = parseFloat(valStr);
    if (isNaN(val) || val < 0 || val > 1) return null;
    result[dim] = val;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Strip escape sequences @@ → @@ in the output.
 * Call this on final clean text to unescape literal @@ markers.
 */
function unescapeMarkers(text: string): string {
  return text.replace(/\@@/g, "@@");
}

export function extractMarkers(text: string, onMarker: MarkerHandler): string {
  let cleaned = "";
  let lastIndex = 0;
  const regex = new RegExp(MARKER_RE.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Check for escaped marker — if @@ precedes, skip it
    if (match.index > 0 && text[match.index - 1] === '\\') {
      // This is an escaped marker — treat as literal text
      cleaned += text.slice(lastIndex, match.index + match[0].length);
      lastIndex = match.index + match[0].length;
      continue;
    }

    cleaned += text.slice(lastIndex, match.index);
    const marker: StreamMarker = {
      name: match[1],
      arg: match[2] ?? match[3] ?? match[4] ?? "",
      raw: match[0],
    };

    // Validate before calling handler
    const validation = validateMarker(marker.name, marker.arg);
    if (!validation.valid) {
      Logger.warn(`Invalid marker: ${validation.error}`);
      cleaned += match[0]; // Keep the malformed marker as-is
      lastIndex = match.index + match[0].length;
      continue;
    }

    try { onMarker(marker); } catch (e) { 
      Logger.warn(`Marker handler error: ${e}`);
    }
    // Emit emoji indicator instead of stripping completely
    cleaned += markerEmoji(marker.name);
    lastIndex = match.index + match[0].length;
  }
  cleaned += text.slice(lastIndex);
  return unescapeMarkers(cleaned);
}

export function createMarkerParser(opts: MarkerParserOptions): MarkerParser {
  const { onMarker, onToken } = opts;
  let buffer = "";
  let cleanText = "";
  const markers: StreamMarker[] = [];

  function processBuffer(isFinal: boolean) {
    // Try to match complete markers in the buffer
    let lastIndex = 0;
    const regex = new RegExp(MARKER_RE.source, "g");
    let match: RegExpExecArray | null;

    while ((match = regex.exec(buffer)) !== null) {
      // Check for escaped marker — if @@ precedes, treat as literal
      if (match.index > 0 && buffer[match.index - 1] === '\\') {
        // Skip this match, it's escaped
        const before = buffer.slice(lastIndex, match.index + match[0].length);
        cleanText += before;
        if (onToken) onToken(before);
        lastIndex = match.index + match[0].length;
        continue;
      }

      // Emit any text before this marker
      const before = buffer.slice(lastIndex, match.index);
      if (before) {
        cleanText += before;
        if (onToken) onToken(before);
      }

      // Parse the marker
      const name = match[1];
      const arg = match[2] ?? match[3] ?? match[4] ?? "";
      const raw = match[0];

      // Validate marker before processing
      const validation = validateMarker(name, arg);
      if (!validation.valid) {
        Logger.warn(`Invalid marker: ${validation.error}`);
        cleanText += raw; // Keep malformed marker in output
        if (onToken) onToken(raw);
        lastIndex = match.index + match[0].length;
        continue;
      }

      const marker: StreamMarker = { name, arg, raw };
      markers.push(marker);
      Logger.debug(`Stream marker detected: ${raw}`);

      try {
        onMarker(marker);
      } catch (e: unknown) {
        Logger.warn(`Marker handler error for ${name}: ${e}`);
      }

      // Emit emoji indicator into the output stream
      const emoji = markerEmoji(name);
      cleanText += emoji;
      if (onToken) onToken(emoji);

      lastIndex = match.index + match[0].length;
    }

    // Whatever's left after all matches
    const remainder = buffer.slice(lastIndex);

    if (isFinal) {
      // End of stream — flush everything remaining as text
      if (remainder) {
        cleanText += remainder;
        if (onToken) onToken(remainder);
      }
      buffer = "";
    } else {
      // Check if the remainder could be a partial marker
      const partialMatch = PARTIAL_MARKER_RE.exec(remainder);
      if (partialMatch) {
        // Hold back the potential partial marker, emit what's before it
        const safe = remainder.slice(0, partialMatch.index);
        if (safe) {
          cleanText += safe;
          if (onToken) onToken(safe);
        }
        buffer = remainder.slice(partialMatch.index);
      } else {
        // No partial marker — emit all remaining text
        if (remainder) {
          cleanText += remainder;
          if (onToken) onToken(remainder);
        }
        buffer = "";
      }
    }
  }

  return {
    onToken(s: string) {
      buffer += s;
      processBuffer(false);
    },

    getCleanText() {
      return cleanText;
    },

    getMarkers() {
      return [...markers];
    },

    flush() {
      processBuffer(true);
    },
  };
}
