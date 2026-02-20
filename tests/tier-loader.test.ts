import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadTierConfigs, thinkingTierModel } from "../src/tier-loader.js";

describe("loadTierConfigs", () => {
  it("loads all provider tier configs", () => {
    const configs = loadTierConfigs();
    assert.ok(configs instanceof Map, "Returns a Map");
    assert.ok(configs.size > 0, "Loaded at least one provider config");
  });

  it("caches tier configs on repeated calls", () => {
    const first = loadTierConfigs();
    const second = loadTierConfigs();
    assert.strictEqual(first, second, "Returns same cached instance");
  });

  it("loads anthropic tier config", () => {
    const configs = loadTierConfigs();
    const anthropic = configs.get("anthropic");
    assert.ok(anthropic, "Anthropic config exists");
    assert.strictEqual(anthropic.provider, "anthropic");
    assert.ok(anthropic.tiers.low, "Has low tier");
    assert.ok(anthropic.tiers.mid, "Has mid tier");
    assert.ok(anthropic.tiers.high, "Has high tier");
  });
});

describe("thinkingTierModel", () => {
  const modelAliases = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-4-5",
    "opus": "claude-opus-4-6",
  };

  it("selects low tier for budget < 0.25", () => {
    const model = thinkingTierModel(0.1, "anthropic", "fallback", modelAliases);
    assert.strictEqual(model, "claude-haiku-4-5");
  });

  it("selects mid tier for budget 0.25-0.64", () => {
    const model = thinkingTierModel(0.5, "anthropic", "fallback", modelAliases);
    assert.strictEqual(model, "claude-sonnet-4-5");
  });

  it("selects high tier for budget >= 0.65", () => {
    const model = thinkingTierModel(0.8, "anthropic", "fallback", modelAliases);
    assert.strictEqual(model, "claude-opus-4-6");
  });

  it("falls back to anthropic defaults for unknown provider", () => {
    const model = thinkingTierModel(0.1, "unknown-provider", "fallback", modelAliases);
    assert.strictEqual(model, "claude-haiku-4-5");
  });

  it("uses fallback model when high tier is null", () => {
    // groq has null high tier in config
    const model = thinkingTierModel(0.8, "groq", "fallback-model", {});
    assert.strictEqual(model, "fallback-model");
  });

  it("uses model alias fallback when provider unknown and alias missing", () => {
    const model = thinkingTierModel(0.1, "unknown", "final-fallback", {});
    assert.strictEqual(model, "final-fallback");
  });

  it("selects correct groq low tier", () => {
    const model = thinkingTierModel(0.1, "groq", "fallback", {});
    assert.strictEqual(model, "llama-3.1-8b-instant");
  });

  it("selects correct groq mid tier", () => {
    const model = thinkingTierModel(0.5, "groq", "fallback", {});
    assert.strictEqual(model, "llama-3.3-70b-versatile");
  });
});
