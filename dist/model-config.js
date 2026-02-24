import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.js";
let cached = null;
/** Load models.json from project root (lazy, cached). */
export function loadModelConfig() {
    if (cached)
        return cached;
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Try package root first (../models.json from dist/), then same dir as fallback
    const candidates = [
        join(__dirname, "..", "models.json"),
        join(__dirname, "models.json"),
    ];
    for (const configPath of candidates) {
        if (existsSync(configPath)) {
            try {
                cached = JSON.parse(readFileSync(configPath, "utf-8"));
                Logger.debug(`Loaded model config: ${Object.keys(cached.aliases).length} aliases, ${Object.keys(cached.defaults).length} provider defaults`);
                return cached;
            }
            catch (e) {
                Logger.warn(`Failed to parse ${configPath}: ${e.message}`);
            }
        }
    }
    Logger.warn(`models.json not found — using empty config`);
    cached = { aliases: {}, defaults: {}, providerPrefixes: {} };
    return cached;
}
/** Resolve a short alias to its full model identifier. */
export function resolveModelAlias(alias) {
    const { aliases } = loadModelConfig();
    const lower = alias.trim().toLowerCase();
    return aliases[lower] ?? alias;
}
/** Check whether a string is a known alias. */
export function isKnownAlias(alias) {
    const { aliases } = loadModelConfig();
    return Object.prototype.hasOwnProperty.call(aliases, alias.trim().toLowerCase());
}
/** Get the default model for a provider. */
export function defaultModel(provider) {
    const { defaults } = loadModelConfig();
    return defaults[provider] ?? defaults["openai"] ?? "gpt-5.2";
}
/** Build a RegExp that matches any known model ID prefix (for validation). */
export function modelIdPrefixPattern() {
    const { providerPrefixes } = loadModelConfig();
    const allPrefixes = Object.values(providerPrefixes).flat();
    // Escape regex special chars, sort longest-first so longer prefixes match first
    const escaped = allPrefixes
        .sort((a, b) => b.length - a.length)
        .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^(${escaped.join("|")})`);
}
/** Infer provider from an explicit flag or model ID prefix. */
export function inferProvider(explicit, model) {
    if (explicit) {
        const known = ["openai", "anthropic", "groq", "google", "xai", "local"];
        if (known.includes(explicit))
            return explicit;
        Logger.warn(`Unknown provider "${explicit}", defaulting to anthropic`);
        return "anthropic";
    }
    if (model) {
        // Resolve alias first so short names like "grok" match their provider
        const resolved = resolveModelAlias(model);
        const { providerPrefixes } = loadModelConfig();
        // Check providers in defined order, trying both raw and resolved model names
        for (const [provider, prefixes] of Object.entries(providerPrefixes)) {
            for (const prefix of prefixes) {
                if (model.startsWith(prefix) || resolved.startsWith(prefix))
                    return provider;
            }
        }
    }
    return "anthropic";
}
