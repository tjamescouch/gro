/**
 * DirectiveParser — extract and execute inline directives from assistant messages.
 *
 * Supported directives:
 * - 🧠 — persist fact to _learn.md and hot-patch system prompt
 * - @@ctrl:memory=type@@ — swap memory type at runtime
 * - 🧠 — request model switch
 * - 💡 — set thinking level
 * - 💡 — bump thinking +0.3
 * - 💡 — reduce thinking -0.3
 *
 * Directives are stripped from the displayed message but executed immediately.
 */
import { Logger } from "../logger.js";
import { runtimeConfig } from "./config-manager.js";
/**
 * Parse directives from an assistant message.
 * Returns cleaned message and extracted directives.
 */
export function parseDirectives(content) {
    let cleaned = content;
    const result = {
        cleanedMessage: content,
        learnFacts: [],
    };
    // 🧠
    const learnPattern = /@@learn\(['"](.+?)['"]\)@@/g;
    let match;
    while ((match = learnPattern.exec(content)) !== null) {
        result.learnFacts.push(match[1]);
        cleaned = cleaned.replace(match[0], "");
    }
    // @@ctrl:memory=type@@
    const memoryPattern = /@@ctrl:memory=(\w+)@@/;
    const memoryMatch = content.match(memoryPattern);
    if (memoryMatch) {
        result.memorySwap = memoryMatch[1];
        cleaned = cleaned.replace(memoryMatch[0], "");
    }
    // 🧠
    const modelPattern = /@@model-change\(['"](.+?)['"]\)@@/;
    const modelMatch = content.match(modelPattern);
    if (modelMatch) {
        result.modelSwitch = modelMatch[1];
        cleaned = cleaned.replace(modelMatch[0], "");
    }
    // 💡
    const thinkingPattern = /@@thinking\(([\d.]+)\)@@/;
    const thinkingMatch = content.match(thinkingPattern);
    if (thinkingMatch) {
        const level = parseFloat(thinkingMatch[1]);
        if (!isNaN(level)) {
            result.thinkingLevel = level;
            cleaned = cleaned.replace(thinkingMatch[0], "");
        }
    }
    // 💡 — bump +0.3
    if (content.includes("💡")) {
        const current = runtimeConfig.getThinkingLevel();
        result.thinkingLevel = Math.min(1.0, current + 0.3);
        cleaned = cleaned.replace(/💡/g, "");
    }
    // 💡 — reduce -0.3
    if (content.includes("💡")) {
        const current = runtimeConfig.getThinkingLevel();
        result.thinkingLevel = Math.max(0.0, current - 0.3);
        cleaned = cleaned.replace(/💡/g, "");
    }
    // Strip display-only markers that don't have side effects
    // These are handled by stream-markers.ts during streaming, but need cleanup here too
    cleaned = cleaned.replace(/@@importance\(['"][\d.]+['"]\)@@/g, "🧠");
    cleaned = cleaned.replace(/🧠/g, "🧠");
    cleaned = cleaned.replace(/🧠/g, "🧠");
    cleaned = cleaned.replace(/@@ref\(['"][\w-]+['"]\)@@/g, "🧠");
    cleaned = cleaned.replace(/@@unref\(['"][\w-]+['"]\)@@/g, "🧠");
    cleaned = cleaned.replace(/@@mem:[\w-]+@@/g, "🧠");
    // Emotion markers: @@joy:0.5@@ @@sadness:0.2@@ etc
    cleaned = cleaned.replace(/@@(?:joy|sadness|anger|fear|surprise|confidence|uncertainty|excitement|calm|urgency|reverence):[0-9.]+(?:,(?:joy|sadness|anger|fear|surprise|confidence|uncertainty|excitement|calm|urgency|reverence):[0-9.]+)*@@/g, "🧠");
    // Generic fallback: any remaining @@...@@ pattern → 🧠
    // This catches unknown/future markers without breaking display
    cleaned = cleaned.replace(/@@[a-zA-Z][a-zA-Z0-9_-]*(?:\([^)]*\))?@@/g, "🧠");
    // Clean up duplicate emoji to prevent visual spam
    cleaned = cleaned.replace(/🧠+/g, "🧠");
    cleaned = cleaned.replace(/💡+/g, "💡");
    result.cleanedMessage = cleaned.trim();
    return result;
}
/**
 * Execute directives extracted from a message.
 * Should be called after parseDirectives() in the chat loop.
 */
export async function executeDirectives(directives) {
    // Learn facts
    for (const fact of directives.learnFacts) {
        try {
            await runtimeConfig.learn(fact);
        }
        catch (err) {
            Logger.error(`Failed to execute @@learn: ${err.message}`);
        }
    }
    // Memory swap
    if (directives.memorySwap) {
        try {
            await runtimeConfig.swapMemory(directives.memorySwap);
        }
        catch (err) {
            Logger.error(`Failed to swap memory to '${directives.memorySwap}': ${err.message}`);
        }
    }
    // Thinking level
    if (directives.thinkingLevel !== undefined) {
        runtimeConfig.setThinkingLevel(directives.thinkingLevel);
        Logger.info(`Thinking level set to ${directives.thinkingLevel.toFixed(2)}`);
    }
    // Model switch (logged but requires external handling in chat loop)
    if (directives.modelSwitch) {
        Logger.info(`Model switch requested: ${directives.modelSwitch}`);
    }
}
