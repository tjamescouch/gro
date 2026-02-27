/**
 * EmbeddingProvider — provider-agnostic embedding client.
 *
 * Supports OpenAI (text-embedding-3-small) and Google (text-embedding-004).
 * Uses raw fetch — no SDK dependency. Never throws on API failure;
 * returns empty arrays and logs a warning.
 */
import { timedFetch } from "../utils/timed-fetch.js";
import { resolveKey } from "../keychain.js";
import { Logger } from "../logger.js";
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const OPENAI_DEFAULTS = {
    model: "text-embedding-3-small",
    baseUrl: "https://api.openai.com",
    dimension: 1536,
};
const GOOGLE_DEFAULTS = {
    model: "text-embedding-004",
    baseUrl: "https://generativelanguage.googleapis.com",
    dimension: 768,
};
const DEFAULT_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 100; // Max texts per API call
// ---------------------------------------------------------------------------
// OpenAI embeddings
// ---------------------------------------------------------------------------
async function embedOpenAI(texts, model, baseUrl, apiKey, timeoutMs) {
    const results = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        try {
            const res = await timedFetch(`${baseUrl}/v1/embeddings`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    input: batch,
                    encoding_format: "float",
                }),
                timeoutMs,
                where: "EmbeddingProvider/openai",
            });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                Logger.warn(`[Embedding] OpenAI ${res.status}: ${body.slice(0, 200)}`);
                results.push(...batch.map(() => []));
                continue;
            }
            const json = await res.json();
            // API returns data sorted by index
            const sorted = json.data.sort((a, b) => a.index - b.index);
            results.push(...sorted.map(d => d.embedding));
        }
        catch (err) {
            Logger.warn(`[Embedding] OpenAI error: ${err}`);
            results.push(...batch.map(() => []));
        }
    }
    return results;
}
// ---------------------------------------------------------------------------
// Google embeddings
// ---------------------------------------------------------------------------
async function embedGoogle(texts, model, baseUrl, apiKey, timeoutMs) {
    const results = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        try {
            const res = await timedFetch(`${baseUrl}/v1/models/${model}:batchEmbedContents?key=${apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    requests: batch.map(text => ({
                        model: `models/${model}`,
                        content: { parts: [{ text }] },
                    })),
                }),
                timeoutMs,
                where: "EmbeddingProvider/google",
            });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                Logger.warn(`[Embedding] Google ${res.status}: ${body.slice(0, 200)}`);
                results.push(...batch.map(() => []));
                continue;
            }
            const json = await res.json();
            results.push(...json.embeddings.map(e => e.values));
        }
        catch (err) {
            Logger.warn(`[Embedding] Google error: ${err}`);
            results.push(...batch.map(() => []));
        }
    }
    return results;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createEmbeddingProvider(config) {
    const { provider, apiKey } = config;
    if (provider === "openai") {
        const model = config.model ?? OPENAI_DEFAULTS.model;
        const baseUrl = config.baseUrl ?? OPENAI_DEFAULTS.baseUrl;
        const dimension = config.dimension ?? OPENAI_DEFAULTS.dimension;
        const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        return {
            embed: (texts) => embedOpenAI(texts, model, baseUrl, apiKey, timeoutMs),
            dimension,
            model,
            provider: "openai",
        };
    }
    if (provider === "google") {
        const model = config.model ?? GOOGLE_DEFAULTS.model;
        const baseUrl = config.baseUrl ?? GOOGLE_DEFAULTS.baseUrl;
        const dimension = config.dimension ?? GOOGLE_DEFAULTS.dimension;
        const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        return {
            embed: (texts) => embedGoogle(texts, model, baseUrl, apiKey, timeoutMs),
            dimension,
            model,
            provider: "google",
        };
    }
    throw new Error(`[Embedding] Unsupported provider: ${provider}`);
}
/**
 * Auto-detect an embedding provider from available API keys.
 * Probes OpenAI first, then Google. Returns null if no key is available.
 */
export function tryCreateEmbeddingProvider() {
    const openaiKey = resolveKey("openai");
    if (openaiKey && !openaiKey.toLowerCase().includes("proxy")) {
        return createEmbeddingProvider({ provider: "openai", apiKey: openaiKey });
    }
    const googleKey = resolveKey("google");
    if (googleKey) {
        return createEmbeddingProvider({ provider: "google", apiKey: googleKey });
    }
    return null;
}
