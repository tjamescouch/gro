import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.js";
import { asError } from "./errors.js";
/** Lazy-loaded tier configs cache */
let tierConfigCache = null;
/** Load all provider tier configs from providers/*.json */
export function loadTierConfigs() {
    if (tierConfigCache)
        return tierConfigCache;
    const cache = new Map();
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const providersDir = join(__dirname, "..", "providers");
    if (!existsSync(providersDir)) {
        Logger.warn("providers/ directory not found — tier ladders unavailable");
        tierConfigCache = cache;
        return cache;
    }
    try {
        const files = readdirSync(providersDir);
        for (const file of files) {
            if (!file.endsWith(".json"))
                continue;
            const path = join(providersDir, file);
            const data = JSON.parse(readFileSync(path, "utf-8"));
            cache.set(data.provider, data);
        }
        Logger.debug(`Loaded ${cache.size} provider tier configs`);
    }
    catch (e) {
        Logger.warn(`Failed to load tier configs: ${asError(e).message}`);
    }
    tierConfigCache = cache;
    return cache;
}
/** Tier rank for clamping */
const TIER_RANK = { low: 0, mid: 1, high: 2 };
/** Select model tier based on thinking budget and provider config.
 *  maxTier ("low" | "mid" | "high") caps the tier selection — useful when
 *  the runtime proxy only supports a subset of models.
 */
export function thinkingTierModel(budget, provider, fallbackModel, modelAliases, maxTier) {
    const tierConfigs = loadTierConfigs();
    const tierConfig = tierConfigs.get(provider);
    // Determine the raw tier from budget
    let selectedTier;
    if (!tierConfig) {
        // Fallback: anthropic defaults for unknown providers
        if (budget < 0.25)
            selectedTier = "low";
        else if (budget < 0.65)
            selectedTier = "mid";
        else
            selectedTier = "high";
    }
    else {
        const { thresholds } = tierConfig;
        if (budget < thresholds.low)
            selectedTier = "low";
        else if (budget < thresholds.mid)
            selectedTier = "mid";
        else
            selectedTier = "high";
    }
    // Clamp to maxTier if specified
    if (maxTier && TIER_RANK[selectedTier] > TIER_RANK[maxTier]) {
        selectedTier = maxTier;
    }
    // Resolve model from tier
    if (!tierConfig) {
        const aliasMap = { low: "haiku", mid: "sonnet", high: "opus" };
        return modelAliases[aliasMap[selectedTier]] ?? fallbackModel;
    }
    return tierConfig.tiers[selectedTier] ?? fallbackModel;
}
/**
 * Select model tier across multiple providers.
 * Iterates providers in preference order, returning the first that has a
 * non-null model at the computed tier level. Falls back to the first
 * provider's default model if nothing matches.
 */
export function selectMultiProviderTierModel(budget, providers, fallbackModel, modelAliases, maxTier) {
    const tierConfigs = loadTierConfigs();
    // Determine the raw tier from budget (use default thresholds)
    let selectedTier;
    // Use first provider's config for thresholds if available, else defaults
    const firstConfig = tierConfigs.get(providers[0]);
    if (!firstConfig) {
        if (budget < 0.25)
            selectedTier = "low";
        else if (budget < 0.65)
            selectedTier = "mid";
        else
            selectedTier = "high";
    }
    else {
        const { thresholds } = firstConfig;
        if (budget < thresholds.low)
            selectedTier = "low";
        else if (budget < thresholds.mid)
            selectedTier = "mid";
        else
            selectedTier = "high";
    }
    // Clamp to maxTier if specified
    if (maxTier && TIER_RANK[selectedTier] > TIER_RANK[maxTier]) {
        selectedTier = maxTier;
    }
    // Iterate providers in preference order — first with a non-null model wins
    for (const provider of providers) {
        const config = tierConfigs.get(provider);
        if (!config) {
            // Unknown provider — try alias-based resolution (anthropic defaults)
            const aliasMap = { low: "haiku", mid: "sonnet", high: "opus" };
            const model = modelAliases[aliasMap[selectedTier]];
            if (model)
                return { provider, model };
            continue;
        }
        const model = config.tiers[selectedTier];
        if (model)
            return { provider, model };
    }
    // Nothing matched — fall back to first provider with the fallback model
    return { provider: providers[0], model: fallbackModel };
}
