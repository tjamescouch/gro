/**
 * Driver factory — creates provider-specific chat drivers.
 */
import { Logger } from "../logger.js";
import { resolveKey, resolveProxy } from "../keychain.js";
import { makeAnthropicDriver } from "./anthropic.js";
import { makeStreamingOpenAiDriver } from "./streaming-openai.js";
import { makeGoogleDriver } from "./streaming-google.js";
export function defaultBaseUrl(provider) {
    switch (provider) {
        case "openai": return process.env.OPENAI_BASE_URL || "https://api.openai.com";
        case "groq": return process.env.GROQ_BASE_URL || "https://api.groq.com/openai";
        case "google": return process.env.GOOGLE_BASE_URL || "https://generativelanguage.googleapis.com";
        case "xai": return process.env.XAI_BASE_URL || "https://api.x.ai";
        case "local": return "http://127.0.0.1:11434";
        default: return process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    }
}
export function resolveApiKey(provider) {
    return resolveKey(provider);
}
export function createDriverForModel(provider, model, apiKey, baseUrl, maxTokens, enablePromptCaching) {
    // Prefer agentauth proxy when available
    if (provider !== "local") {
        const isDefaultBaseUrl = baseUrl === defaultBaseUrl(provider);
        if (isDefaultBaseUrl) {
            const proxy = resolveProxy(provider);
            if (proxy) {
                Logger.telemetry(`Using agentauth proxy for ${provider} at ${proxy.baseUrl}`);
                apiKey = proxy.apiKey;
                baseUrl = proxy.baseUrl;
            }
        }
    }
    switch (provider) {
        case "anthropic":
            if (!apiKey && baseUrl === "https://api.anthropic.com") {
                Logger.error(`gro: no API key for anthropic — run: gro --set-key anthropic`);
                process.exit(1);
            }
            return makeAnthropicDriver({ apiKey: apiKey || "proxy-managed", model, baseUrl, maxTokens, enablePromptCaching });
        case "openai":
            if (!apiKey && baseUrl === "https://api.openai.com") {
                Logger.error(`gro: no API key for openai — run: gro --set-key openai`);
                process.exit(1);
            }
            return makeStreamingOpenAiDriver({ baseUrl, model, apiKey: apiKey || undefined });
        case "groq":
            if (!apiKey) {
                Logger.error(`gro: no API key for groq — run: gro --set-key groq`);
                process.exit(1);
            }
            return makeStreamingOpenAiDriver({ baseUrl, model, apiKey });
        case "google":
            if (!apiKey && baseUrl === "https://generativelanguage.googleapis.com") {
                Logger.error(`gro: no API key for google — run: gro --set-key google`);
                process.exit(1);
            }
            return makeGoogleDriver({ baseUrl: baseUrl.replace(/\/v1beta\/openai\/?$/, ""), model, apiKey: apiKey || undefined });
        case "xai":
            if (!apiKey && baseUrl === "https://api.x.ai") {
                Logger.error(`gro: no API key for xai — run: gro --set-key xai`);
                process.exit(1);
            }
            return makeStreamingOpenAiDriver({ baseUrl, model, apiKey: apiKey || undefined });
        case "local":
            return makeStreamingOpenAiDriver({ baseUrl, model });
        default:
            Logger.error(`gro: unknown provider "${provider}"`);
            process.exit(1);
    }
}
export function createDriver(cfg) {
    return createDriverForModel(cfg.provider, cfg.model, cfg.apiKey, cfg.baseUrl, cfg.maxTokens, cfg.enablePromptCaching);
}
