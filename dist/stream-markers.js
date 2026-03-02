/**
 * Stream Marker Parser
 *
 * Intercepts @@name('arg')@@ and @@name:value@@ patterns in the token stream.
 * Generic architecture — any marker type can register a handler.
 *
 * Markers are replaced with emoji indicators in the output stream:
 *   💡 for thinking markers (think, relax, zzz, thinking)
 *   🧠 for all other markers (model-change, importance, ref, etc.)
 *
 * When a complete marker is detected, the registered handler fires.
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
 * Marker regex: @@name('arg')@@ or @@name("arg")@@ or @@name@@
 * Non-greedy matching prevents consuming URLs like "http://..." incorrectly.
 * Supports escaped markers: \@@ → treated as literal text.
 */
const MARKER_RE = /(?<!\\)@@([a-zA-Z][a-zA-Z0-9_-]*)(?:\((?:'([^']*?)'|"([^"]*?)"|([^)]*?))\))?@@/g;
/**
 * Colon-format markers: @@name:value@@ or @@name:value,name:value,...@@
 * Values must be numeric (integer or decimal). Each name:value pair fires separately.
 */
const COLON_MARKER_RE = /(?<!\\)@@([a-zA-Z][a-zA-Z0-9_-]*:[0-9.]+(?:,[a-zA-Z][a-zA-Z0-9_-]*:[0-9.]+)*)@@/g;
/** Partial marker detection — we might be mid-stream in a marker.
 *  The trailing @? catches the case where one char of the closing @@ has arrived
 *  (e.g. "@@reboot@" waiting for the second "@"). */
const PARTIAL_MARKER_RE = /@@[a-zA-Z][a-zA-Z0-9_-]*(?:\([^)]*)?@?$/;
/** Partial colon marker detection for streaming buffering */
const PARTIAL_COLON_RE = /@@[a-zA-Z][a-zA-Z0-9_-]*(?::[0-9.]*(?:,[a-zA-Z][a-zA-Z0-9_-]*(?::[0-9.]*)?)*)?@?$/;
/** Bare @ or @@ at end of buffer — could be the start of @@marker@@ */
const PARTIAL_AT_RE = /@{1,2}$/;
/** Avatar marker: @@[clip name:weight, ...]@@ */
const AVATAR_MARKER_RE = /@@\[([^\]@]+)\]@@/g;
/** Partial avatar marker detection for streaming */
const PARTIAL_AVATAR_RE = /@@\[[^\]@]*$/;
const AVATAR_EMOJI = "\u{1F3AD}"; // 🎭
/** Thinking-related marker names get 💡, everything else gets 🧠 */
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
const MARKER_EMOJI = {
    "thinking": "\u{1F989}", // 🦉
    "think": "\u{1F989}", // 🦉
    "relax": "\u{1F989}", // 🦉
    "zzz": "\u{1F989}", // 🦉
    "model-change": "\u{1F500}", // 🔀
    "learn": "\u{1F4DA}", // 📚
    "ctrl": "\u{2699}\u{FE0F}", // ⚙️
    "importance": "\u{2696}\u{FE0F}", // ⚖️
    "ref": "\u{1F4CE}", // 📎
    "unref": "\u{1F4CE}", // 📎
    "memory": "\u{1F4BE}", // 💾
    "temp": "\u{1F321}\u{FE0F}", // 🌡️
    "temperature": "\u{1F321}\u{FE0F}", // 🌡️
    "top_k": "\u{2699}\u{FE0F}", // ⚙️
    "top_p": "\u{2699}\u{FE0F}", // ⚙️
    "max-context": "\u{1F4D0}", // 📐
    "sense": "\u{1F441}\u{FE0F}", // 👁️
    "view": "\u{1F4F7}", // 📷
    "resummarize": "\u{1F504}", // 🔄
};
function markerEmoji(name) {
    if (MARKER_EMOJI[name])
        return MARKER_EMOJI[name];
    if (EMOTION_DIMS.has(name))
        return "\u{1F60A}"; // 😊
    return "\u{1F9E0}"; // 🧠 fallback
}
/**
 * Validate marker name and arg — prevent reserved keyword collisions.
 * Returns { valid: boolean, error?: string }
 */
function validateMarker(name, arg) {
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
function unescapeMarkers(text) {
    return text.replace(/\@@/g, "@@");
}
/**
 * Parse avatar marker contents "clip name:0.8, other clip:1.0" into Record<string, number>.
 * Each entry is "name:weight" where weight defaults to 1.0 if omitted.
 */
function parseAvatarClips(contents) {
    const clips = {};
    for (const part of contents.split(",")) {
        const trimmed = part.trim();
        if (!trimmed)
            continue;
        const colonIdx = trimmed.lastIndexOf(":");
        if (colonIdx > 0) {
            const name = trimmed.slice(0, colonIdx).trim();
            const weight = parseFloat(trimmed.slice(colonIdx + 1));
            clips[name] = isNaN(weight) ? 1.0 : Math.max(0, Math.min(1, weight));
        }
        else {
            clips[trimmed] = 1.0;
        }
    }
    return clips;
}
/**
 * Scan a string for markers, fire the handler for each, and return cleaned text.
 * Unlike the streaming parser, this operates on a complete string (e.g. tool call arguments).
 */
export function extractMarkers(text, onMarker, onAvatarMarker) {
    // First pass: strip avatar markers @@[...]@@ before standard marker processing
    let preprocessed = text;
    if (onAvatarMarker) {
        preprocessed = text.replace(new RegExp(AVATAR_MARKER_RE.source, "g"), (_full, contents) => {
            const clips = parseAvatarClips(contents);
            try {
                onAvatarMarker(clips);
            }
            catch (e) {
                Logger.warn(`Avatar marker handler error: ${e}`);
            }
            return AVATAR_EMOJI;
        });
    }
    // Second pass: colon-format markers (more specific, must run first)
    // Do colon replacement first, then function-form on result
    let cleaned = "";
    let lastIndex = 0;
    const regex = new RegExp(MARKER_RE.source, "g");
    let match;
    let afterColon = "";
    let cLastIndex = 0;
    const colonRegex = new RegExp(COLON_MARKER_RE.source, "g");
    let cMatch;
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
            const marker = { name, arg, raw };
            try {
                onMarker(marker);
            }
            catch (e) {
                Logger.warn(`Marker handler error: ${e}`);
            }
            if (!firstEmoji)
                firstEmoji = markerEmoji(name);
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
        const marker = {
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
        try {
            onMarker(marker);
        }
        catch (e) {
            Logger.warn(`Marker handler error: ${e}`);
        }
        cleaned += markerEmoji(marker.name);
        lastIndex = match.index + match[0].length;
    }
    cleaned += afterColon.slice(lastIndex);
    return unescapeMarkers(cleaned);
}
/**
 * StreamMarkerParser class — streaming parser for @@marker@@ patterns.
 * Handles function-form @@name('arg')@@, colon-form @@name:value@@, and avatar markers.
 */
export class StreamMarkerParser {
    constructor(opts) {
        this.buffer = "";
        this.cleanText = "";
        this.markers = [];
        this.onToken = (s) => {
            this.buffer += s;
            this.processBuffer(false);
        };
        this.flush = () => {
            this.processBuffer(true);
        };
        this.getCleanText = () => {
            return this.cleanText;
        };
        this.getMarkers = () => {
            return [...this.markers];
        };
        this.reset = () => {
            this.buffer = "";
            this.cleanText = "";
            this.markers = [];
        };
        this.opts = opts;
    }
    emitText(text) {
        if (!text)
            return;
        // Unescape \@@ → @@ so masked code-span markers render correctly
        const unescaped = text.replace(/\\@@/g, "@@");
        this.cleanText += unescaped;
        if (this.opts.onToken)
            this.opts.onToken(unescaped);
    }
    emitEmoji(name) {
        const emoji = markerEmoji(name);
        this.cleanText += emoji;
        if (this.opts.onToken && Logger.isVerbose())
            this.opts.onToken(emoji);
    }
    handleMarkerMatch(name, arg, raw) {
        const validation = validateMarker(name, arg);
        if (!validation.valid) {
            Logger.warn(`Invalid marker: ${validation.error}`);
            this.cleanText += raw;
            if (this.opts.onToken)
                this.opts.onToken(raw);
            return;
        }
        const marker = { name, arg, raw };
        this.markers.push(marker);
        Logger.debug(`Stream marker detected: ${raw}`);
        try {
            this.opts.onMarker(marker);
        }
        catch (e) {
            Logger.warn(`Marker handler error for ${name}: ${e}`);
        }
        this.emitEmoji(name);
    }
    /**
     * Mask markers inside backtick code spans/fences so they aren't parsed.
     * Replaces @@ with \@@ inside `...` and ```...``` regions.
     * Only masks complete code spans — partial/unclosed spans are left alone
     * so the streaming buffer can accumulate more tokens.
     */
    maskCodeSpans(text, isFinal) {
        // Mask fenced code blocks (```...```)
        let result = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/@@/g, "\\@@"));
        // Mask inline code spans (`...`) — but not partial ones unless final
        if (isFinal) {
            result = result.replace(/`[^`]+`/g, (m) => m.replace(/@@/g, "\\@@"));
        }
        else {
            // Only mask complete inline spans (pairs of backticks)
            result = result.replace(/`[^`]+`/g, (m) => m.replace(/@@/g, "\\@@"));
        }
        return result;
    }
    processBuffer(isFinal) {
        // Mask markers inside code spans so they aren't triggered
        this.buffer = this.maskCodeSpans(this.buffer, isFinal);
        // First: extract avatar markers @@[...]@@ before standard markers
        if (this.opts.onAvatarMarker) {
            this.buffer = this.buffer.replace(new RegExp(AVATAR_MARKER_RE.source, "g"), (_full, contents) => {
                const clips = parseAvatarClips(contents);
                Logger.debug(`Avatar marker detected: ${JSON.stringify(clips)}`);
                try {
                    this.opts.onAvatarMarker(clips);
                }
                catch (e) {
                    Logger.warn(`Avatar marker handler error: ${e}`);
                }
                return AVATAR_EMOJI;
            });
        }
        // Process colon-format markers first (more specific), then function-form.
        // We do colon replacement in-place on the buffer first, then run function-form.
        this.buffer = this.processColonInBuffer();
        // Try to match complete function-form markers in the buffer
        let lastIndex = 0;
        const regex = new RegExp(MARKER_RE.source, "g");
        let match;
        while ((match = regex.exec(this.buffer)) !== null) {
            // Check for escaped marker — if \@@ precedes, treat as literal
            if (match.index > 0 && this.buffer[match.index - 1] === '\\') {
                const before = this.buffer.slice(lastIndex, match.index + match[0].length);
                this.emitText(before);
                lastIndex = match.index + match[0].length;
                continue;
            }
            // Emit any text before this marker
            const before = this.buffer.slice(lastIndex, match.index);
            this.emitText(before);
            // Parse the marker
            const name = match[1];
            const arg = match[2] ?? match[3] ?? match[4] ?? "";
            const raw = match[0];
            this.handleMarkerMatch(name, arg, raw);
            lastIndex = match.index + match[0].length;
        }
        // Whatever's left after all matches
        const remainder = this.buffer.slice(lastIndex);
        if (isFinal) {
            // End of stream — flush everything remaining as text
            this.emitText(remainder);
            this.buffer = "";
        }
        else {
            // Check if the remainder could be a partial marker (standard, colon, avatar, or bare @/@@)
            const partialMatch = PARTIAL_COLON_RE.exec(remainder)
                ?? PARTIAL_MARKER_RE.exec(remainder)
                ?? PARTIAL_AVATAR_RE.exec(remainder)
                ?? PARTIAL_AT_RE.exec(remainder);
            if (partialMatch) {
                // Hold back the potential partial marker, emit what's before it
                const safe = remainder.slice(0, partialMatch.index);
                this.emitText(safe);
                this.buffer = remainder.slice(partialMatch.index);
            }
            else {
                // No partial marker — emit all remaining text
                this.emitText(remainder);
                this.buffer = "";
            }
        }
    }
    /**
     * Process colon-format markers in the buffer, replacing them with emojis
     * and firing handlers. Returns the modified buffer string.
     */
    processColonInBuffer() {
        const regex = new RegExp(COLON_MARKER_RE.source, "g");
        let result = "";
        let lastIndex = 0;
        let match;
        while ((match = regex.exec(this.buffer)) !== null) {
            if (match.index > 0 && this.buffer[match.index - 1] === '\\') {
                result += this.buffer.slice(lastIndex, match.index + match[0].length);
                lastIndex = match.index + match[0].length;
                continue;
            }
            result += this.buffer.slice(lastIndex, match.index);
            // Parse comma-separated name:value pairs
            const pairs = match[1].split(",");
            let firstEmoji = "";
            for (const pair of pairs) {
                const colonIdx = pair.indexOf(":");
                const name = pair.slice(0, colonIdx);
                const arg = pair.slice(colonIdx + 1);
                const raw = match[0];
                const validation = validateMarker(name, arg);
                if (!validation.valid) {
                    Logger.warn(`Invalid marker: ${validation.error}`);
                    continue;
                }
                const marker = { name, arg, raw };
                this.markers.push(marker);
                Logger.debug(`Stream marker detected: @@${name}:${arg}@@`);
                try {
                    this.opts.onMarker(marker);
                }
                catch (e) {
                    Logger.warn(`Marker handler error for ${name}: ${e}`);
                }
                if (!firstEmoji)
                    firstEmoji = markerEmoji(name);
            }
            // Emit emoji for the colon marker group (use first dimension's emoji)
            const emoji = firstEmoji || markerEmoji(pairs[0].split(":")[0]);
            this.cleanText += emoji;
            if (this.opts.onToken && Logger.isVerbose())
                this.opts.onToken(emoji);
            lastIndex = match.index + match[0].length;
        }
        result += this.buffer.slice(lastIndex);
        return result;
    }
}
/**
 * Factory function — backward-compatible wrapper around StreamMarkerParser.
 */
export function createMarkerParser(opts) {
    return new StreamMarkerParser(opts);
}
