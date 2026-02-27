/**
 * EmbeddingProvider — provider-agnostic embedding client.
 *
 * Supports OpenAI (text-embedding-3-small) and Google (text-embedding-004).
 * Uses raw fetch — no SDK dependency. Never throws on API failure;
 * returns empty arrays and logs a warning.
 */

import { timedFetch } from "../utils/timed-fetch.js";
import { resolveKey, resolveProxy } from "../keychain.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingProviderConfig {
  provider: "openai" | "google";
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimension?: number;
  timeoutMs?: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
  readonly model: string;
  readonly provider: string;
}

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

async function embedOpenAI(
  texts: string[],
  model: string,
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<number[][]> {
  const results: number[][] = [];

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

      const json = await res.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // API returns data sorted by index
      const sorted = json.data.sort((a, b) => a.index - b.index);
      results.push(...sorted.map(d => d.embedding));
    } catch (err) {
      Logger.warn(`[Embedding] OpenAI error: ${err}`);
      results.push(...batch.map(() => []));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Google embeddings
// ---------------------------------------------------------------------------

async function embedGoogle(
  texts: string[],
  model: string,
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const res = await timedFetch(
        `${baseUrl}/v1/models/${model}:batchEmbedContents?key=${apiKey}`,
        {
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
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        Logger.warn(`[Embedding] Google ${res.status}: ${body.slice(0, 200)}`);
        results.push(...batch.map(() => []));
        continue;
      }

      const json = await res.json() as {
        embeddings: Array<{ values: number[] }>;
      };
      results.push(...json.embeddings.map(e => e.values));
    } catch (err) {
      Logger.warn(`[Embedding] Google error: ${err}`);
      results.push(...batch.map(() => []));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
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
 * Checks agentauth proxy first (same key injection as the main LLM driver),
 * then falls back to direct keys. Probes OpenAI first, then Google.
 * Returns null if no key is available.
 */
export function tryCreateEmbeddingProvider(): EmbeddingProvider | null {
  // Probe agentauth proxy — routes embedding requests through the same
  // proxy that handles chat completions, with real keys injected server-side.
  const openaiProxy = resolveProxy("openai");
  if (openaiProxy) {
    return createEmbeddingProvider({
      provider: "openai",
      apiKey: openaiProxy.apiKey,
      baseUrl: openaiProxy.baseUrl,
    });
  }

  const googleProxy = resolveProxy("google");
  if (googleProxy) {
    return createEmbeddingProvider({
      provider: "google",
      apiKey: googleProxy.apiKey,
      baseUrl: googleProxy.baseUrl,
    });
  }

  // Fall back to direct keys (Keychain or env vars)
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
