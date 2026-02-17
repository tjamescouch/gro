/**
 * Stream Marker Parser
 *
 * Intercepts @@name('arg')@@ patterns in the token stream.
 * Generic architecture — any marker type can register a handler.
 *
 * Markers are stripped from the output text that reaches the user.
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
/**
 * Regex for matching complete markers.
 * Supports: @@name('arg')@@ and @@name("arg")@@ and @@name(arg)@@
 */
const MARKER_RE = /@@([a-zA-Z][a-zA-Z0-9_-]*)\((?:'([^']*)'|"([^"]*)"|([^)]*?))\)@@/g;
/** Partial marker detection — we might be mid-stream in a marker */
const PARTIAL_MARKER_RE = /@@[a-zA-Z][a-zA-Z0-9_-]*(?:\([^)]*)?$/;
/**
 * Scan a string for markers, fire the handler for each, and return cleaned text.
 * Unlike the streaming parser, this operates on a complete string (e.g. tool call arguments).
 */
export function extractMarkers(text, onMarker) {
    let cleaned = "";
    let lastIndex = 0;
    const regex = new RegExp(MARKER_RE.source, "g");
    let match;
    while ((match = regex.exec(text)) !== null) {
        cleaned += text.slice(lastIndex, match.index);
        const marker = {
            name: match[1],
            arg: match[2] ?? match[3] ?? match[4] ?? "",
            raw: match[0],
        };
        try {
            onMarker(marker);
        }
        catch { /* handled by caller */ }
        lastIndex = match.index + match[0].length;
    }
    cleaned += text.slice(lastIndex);
    return cleaned;
}
export function createMarkerParser(opts) {
    const { onMarker, onToken } = opts;
    let buffer = "";
    let cleanText = "";
    const markers = [];
    function processBuffer(isFinal) {
        // Try to match complete markers in the buffer
        let lastIndex = 0;
        const regex = new RegExp(MARKER_RE.source, "g");
        let match;
        while ((match = regex.exec(buffer)) !== null) {
            // Emit any text before this marker
            const before = buffer.slice(lastIndex, match.index);
            if (before) {
                cleanText += before;
                if (onToken)
                    onToken(before);
            }
            // Parse the marker
            const name = match[1];
            const arg = match[2] ?? match[3] ?? match[4] ?? "";
            const raw = match[0];
            const marker = { name, arg, raw };
            markers.push(marker);
            Logger.debug(`Stream marker detected: ${raw}`);
            try {
                onMarker(marker);
            }
            catch (e) {
                Logger.warn(`Marker handler error for ${name}: ${e}`);
            }
            lastIndex = match.index + match[0].length;
        }
        // Whatever's left after all matches
        const remainder = buffer.slice(lastIndex);
        if (isFinal) {
            // End of stream — flush everything remaining as text
            if (remainder) {
                cleanText += remainder;
                if (onToken)
                    onToken(remainder);
            }
            buffer = "";
        }
        else {
            // Check if the remainder could be a partial marker
            const partialMatch = PARTIAL_MARKER_RE.exec(remainder);
            if (partialMatch) {
                // Hold back the potential partial marker, emit what's before it
                const safe = remainder.slice(0, partialMatch.index);
                if (safe) {
                    cleanText += safe;
                    if (onToken)
                        onToken(safe);
                }
                buffer = remainder.slice(partialMatch.index);
            }
            else {
                // No partial marker — emit all remaining text
                if (remainder) {
                    cleanText += remainder;
                    if (onToken)
                        onToken(remainder);
                }
                buffer = "";
            }
        }
    }
    return {
        onToken(s) {
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
