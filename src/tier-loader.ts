import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.js";
import { asError } from "./errors.js";

/** Provider tier configuration schema */
interface ProviderTierConfig {
  provider: string;
  tiers: {
    low: string | null;
    mid: string | null;
    high: string | null;
  };
  thresholds: {
    low: number;
    mid: number;
  };
  notes?: string;
}

/** Lazy-loaded tier configs cache */
let tierConfigCache: Map<string, ProviderTierConfig> | null = null;

/** Load all provider tier configs from providers/*.json */
export function loadTierConfigs(): Map<string, ProviderTierConfig> {
  if (tierConfigCache) return tierConfigCache;
  
  const cache = new Map<string, ProviderTierConfig>();
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
      if (!file.endsWith(".json")) continue;
      const path = join(providersDir, file);
      const data = JSON.parse(readFileSync(path, "utf-8")) as ProviderTierConfig;
      cache.set(data.provider, data);
    }
    Logger.debug(`Loaded ${cache.size} provider tier configs`);
  } catch (e: unknown) {
    Logger.warn(`Failed to load tier configs: ${asError(e).message}`);
  }
  
  tierConfigCache = cache;
  return cache;
}

/** Tier rank for clamping */
const TIER_RANK: Record<string, number> = { low: 0, mid: 1, high: 2 };

/** Select model tier based on thinking budget and provider config.
 *  maxTier ("low" | "mid" | "high") caps the tier selection — useful when
 *  the runtime proxy only supports a subset of models.
 */
export function thinkingTierModel(
  budget: number,
  provider: string,
  fallbackModel: string,
  modelAliases: Record<string, string>,
  maxTier?: "low" | "mid" | "high"
): string {
  const tierConfigs = loadTierConfigs();
  const tierConfig = tierConfigs.get(provider);

  // Determine the raw tier from budget
  let selectedTier: "low" | "mid" | "high";

  if (!tierConfig) {
    // Fallback: anthropic defaults for unknown providers
    if (budget < 0.25) selectedTier = "low";
    else if (budget < 0.65) selectedTier = "mid";
    else selectedTier = "high";
  } else {
    const { thresholds } = tierConfig;
    if (budget < thresholds.low) selectedTier = "low";
    else if (budget < thresholds.mid) selectedTier = "mid";
    else selectedTier = "high";
  }

  // Clamp to maxTier if specified
  if (maxTier && TIER_RANK[selectedTier] > TIER_RANK[maxTier]) {
    selectedTier = maxTier;
  }

  // Resolve model from tier
  if (!tierConfig) {
    const aliasMap: Record<string, string> = { low: "haiku", mid: "sonnet", high: "opus" };
    return modelAliases[aliasMap[selectedTier]] ?? fallbackModel;
  }

  return tierConfig.tiers[selectedTier] ?? fallbackModel;
}
