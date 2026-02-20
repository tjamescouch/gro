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

/** Select model tier based on thinking budget and provider config */
export function thinkingTierModel(
  budget: number,
  provider: string,
  fallbackModel: string,
  modelAliases: Record<string, string>
): string {
  const tierConfigs = loadTierConfigs();
  const tierConfig = tierConfigs.get(provider);
  
  if (!tierConfig) {
    // Fallback: anthropic defaults for unknown providers
    if (budget < 0.25) return modelAliases["haiku"] ?? fallbackModel;
    if (budget < 0.65) return modelAliases["sonnet"] ?? fallbackModel;
    return modelAliases["opus"] ?? fallbackModel;
  }
  
  const { tiers, thresholds } = tierConfig;
  
  if (budget < thresholds.low) {
    return tiers.low ?? fallbackModel;
  }
  if (budget < thresholds.mid) {
    return tiers.mid ?? fallbackModel;
  }
  return tiers.high ?? fallbackModel;
}
