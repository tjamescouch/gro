/**
 * Stream Marker Parser
 *
 * Intercepts @@name('arg')@@ patterns in the token stream.
 * Generic architecture — any marker type can register a handler.
 *
 * Markers are replaced with emoji indicators in the output stream:
 *   💡 for thinking markers (think, relax, thinking)
 *   🧠 for all other markers (model-change, importance, ref, etc.)
 *
 * When a complete marker is detected, the registered handler fires.
 *
 * Built-in marker types:
 *   @@model-change('sonnet')@@  — switch the active model mid-stream
 *   @@callback('name')@@       — fire a named callback
 *   @@emotion('happy')@@       — set facial expression / emotion state
 *   @@importance('0.9')@@      — tag message importance (0.0-1.0) for memory paging priority
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
  /** Raw matched text, e.g. "@@model-change('sonnet')@@" */
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
 * Supports: @@name('arg')@@ and @@name("arg")@@ and @@name(arg)@@ and @@name@@
 */
const MARKER_RE = /@@([a-zA-Z][a-zA-Z0-9_-]*)(?:\((?:'([^']*)'|"([^"]*)"|([^)]*?))\))?@@/g;

/** Partial marker detection — we might be mid-stream in a marker */
const PARTIAL_MARKER_RE = /@@[a-zA-Z][a-zA-Z0-9_-]*(?:\([^)]*)?$/;

/** Thinking-related marker names get 💡, everything else gets 🧠 */
const THINKING_MARKERS = new Set(["think", "relax", "thinking"]);

function markerEmoji(name: string): string {
  return THINKING_MARKERS.has(name) ? "\u{1F4A1}" : "\u{1F9E0}";  // 💡 or 🧠
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
export function extractMarkers(text: string, onMarker: MarkerHandler): string {
  let cleaned = "";
  let lastIndex = 0;
  const regex = new RegExp(MARKER_RE.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    cleaned += text.slice(lastIndex, match.index);
    const marker: StreamMarker = {
      name: match[1],
      arg: match[2] ?? match[3] ?? match[4] ?? "",
      raw: match[0],
    };
    try { onMarker(marker); } catch { /* handled by caller */ }
    // Emit emoji indicator instead of stripping completely
    cleaned += markerEmoji(marker.name);
    lastIndex = match.index + match[0].length;
  }
  cleaned += text.slice(lastIndex);
  return cleaned;
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
