/**
 * Register all built-in memory types.
 * Import this module once during startup to populate the memory registry.
 */
import { memoryRegistry } from "./memory-registry.js";
import { SimpleMemory } from "./simple-memory.js";
import { AdvancedMemory } from "./advanced-memory.js";
import { VirtualMemory } from "./virtual-memory.js";
import { FragmentationMemory } from "./fragmentation-memory.js";
// --- Simple Memory ---
memoryRegistry.register({
    type: "simple",
    label: "Simple Memory",
    description: "Unbounded message buffer. No summarization, no budgeting. For short conversations.",
    factory: (config) => {
        const mem = new SimpleMemory(config.systemPrompt);
        if (config.provider && config.model) {
            mem.setMeta(config.provider, config.model);
        }
        return mem;
    },
    parameters: [
        { name: "systemPrompt", type: "string", description: "System prompt", required: false },
    ],
});
// --- Advanced Memory ---
memoryRegistry.register({
    type: "advanced",
    label: "Advanced Memory",
    description: "Swim-lane summarization with token budgeting. Independent lanes for assistant/user/system.",
    factory: (config) => {
        if (!config.driver || !config.model) {
            throw new Error("AdvancedMemory requires driver and model in config.");
        }
        return new AdvancedMemory({
            driver: config.driver,
            model: config.model,
            systemPrompt: config.systemPrompt,
            contextTokens: config.contextTokens,
            reserveHeaderTokens: config.reserveHeaderTokens,
            reserveResponseTokens: config.reserveResponseTokens,
            highRatio: config.highRatio,
            lowRatio: config.lowRatio,
            summaryRatio: config.summaryRatio,
            avgCharsPerToken: config.avgCharsPerToken,
            keepRecentPerLane: config.keepRecentPerLane,
            keepRecentTools: config.keepRecentTools,
        });
    },
    defaults: {
        contextTokens: 8192,
        reserveHeaderTokens: 512,
        reserveResponseTokens: 2048,
        highRatio: 0.85,
        lowRatio: 0.75,
        summaryRatio: 0.2,
        avgCharsPerToken: 4,
        keepRecentPerLane: 5,
        keepRecentTools: 10,
    },
    parameters: [
        { name: "contextTokens", type: "number", description: "Total context token budget", defaultValue: 8192 },
        { name: "reserveHeaderTokens", type: "number", description: "Tokens reserved for header", defaultValue: 512 },
        { name: "reserveResponseTokens", type: "number", description: "Tokens reserved for response", defaultValue: 2048 },
        { name: "highRatio", type: "number", description: "High watermark ratio (trigger compaction)", defaultValue: 0.85, range: { min: 0.5, max: 1.0 } },
        { name: "lowRatio", type: "number", description: "Low watermark ratio (target after compaction)", defaultValue: 0.75, range: { min: 0.5, max: 1.0 } },
        { name: "summaryRatio", type: "number", description: "Fraction of budget for summaries", defaultValue: 0.2, range: { min: 0.1, max: 0.5 } },
        { name: "avgCharsPerToken", type: "number", description: "Characters per token estimate", defaultValue: 4 },
        { name: "keepRecentPerLane", type: "number", description: "Recent messages to preserve per lane", defaultValue: 5 },
        { name: "keepRecentTools", type: "number", description: "Recent tool messages to preserve", defaultValue: 10 },
    ],
});
// --- Virtual Memory ---
memoryRegistry.register({
    type: "virtual",
    label: "Virtual Memory",
    description: "Paged context with inline refs, independent budgets, and swimlane awareness. Default memory type.",
    factory: async (config) => {
        if (!config.driver) {
            throw new Error("VirtualMemory requires driver in config.");
        }
        return new VirtualMemory({
            driver: config.driver,
            summarizerModel: config.model || config.summarizerModel,
            systemPrompt: config.systemPrompt,
            pagesDir: config.pagesDir,
            pageSlotTokens: config.pageSlotTokens,
            workingMemoryTokens: config.workingMemoryTokens,
            assistantWeight: config.assistantWeight,
            userWeight: config.userWeight,
            systemWeight: config.systemWeight,
            toolWeight: config.toolWeight,
            avgCharsPerToken: config.avgCharsPerToken,
            minRecentPerLane: config.minRecentPerLane,
            highRatio: config.highRatio,
            lowRatio: config.lowRatio,
        });
    },
    defaults: {
        pageSlotTokens: 16000,
        workingMemoryTokens: 32000,
        assistantWeight: 3,
        userWeight: 2,
        systemWeight: 1,
        toolWeight: 1,
        avgCharsPerToken: 4,
        minRecentPerLane: 5,
        highRatio: 0.75,
        lowRatio: 0.50,
    },
    parameters: [
        { name: "pagesDir", type: "string", description: "Directory for page storage", required: false },
        { name: "pageSlotTokens", type: "number", description: "Token budget for loaded pages", defaultValue: 16000 },
        { name: "workingMemoryTokens", type: "number", description: "Token budget for working memory", defaultValue: 32000 },
        { name: "assistantWeight", type: "number", description: "Weight for assistant lane", defaultValue: 3 },
        { name: "userWeight", type: "number", description: "Weight for user lane", defaultValue: 2 },
        { name: "systemWeight", type: "number", description: "Weight for system lane", defaultValue: 1 },
        { name: "toolWeight", type: "number", description: "Weight for tool lane", defaultValue: 1 },
        { name: "avgCharsPerToken", type: "number", description: "Characters per token estimate", defaultValue: 4 },
        { name: "minRecentPerLane", type: "number", description: "Minimum recent messages per lane", defaultValue: 5 },
        { name: "compactionTriggerRatio", type: "number", description: "Trigger compaction ratio", defaultValue: 0.85, range: { min: 0.5, max: 1.0 } },
        { name: "compactionTargetRatio", type: "number", description: "Target ratio after compaction", defaultValue: 0.7, range: { min: 0.5, max: 1.0 } },
        { name: "maxBatchSize", type: "number", description: "Max swimlanes per batch", defaultValue: 3 },
        { name: "maxConcurrentBatches", type: "number", description: "Max concurrent batches", defaultValue: 2 },
    ],
});
// --- Fragmentation Memory ---
memoryRegistry.register({
    type: "fragmentation",
    label: "Fragmentation Memory",
    description: "VirtualMemory with sampling-based compaction instead of LLM summarization. Zero cost, faster paging.",
    factory: (config) => {
        return new FragmentationMemory({
            systemPrompt: config.systemPrompt,
            pagesDir: config.pagesDir,
            pageSlotTokens: config.pageSlotTokens,
            workingMemoryTokens: config.workingMemoryTokens,
            assistantWeight: config.assistantWeight,
            userWeight: config.userWeight,
            systemWeight: config.systemWeight,
            toolWeight: config.toolWeight,
            avgCharsPerToken: config.avgCharsPerToken,
            minRecentPerLane: config.minRecentPerLane,
            fragmenterConfig: config.fragmenterConfig,
        });
    },
    defaults: {
        pageSlotTokens: 16000,
        workingMemoryTokens: 32000,
        assistantWeight: 3,
        userWeight: 2,
        systemWeight: 1,
        toolWeight: 1,
        avgCharsPerToken: 4,
        minRecentPerLane: 5,
        fragmenterConfig: {
            samplingRate: 0.3,
            minSamples: 3,
            maxSamples: 20,
            preserveImportantThreshold: 0.7,
        },
    },
    parameters: [
        { name: "pageSlotTokens", type: "number", description: "Token budget for loaded pages", defaultValue: 16000 },
        { name: "workingMemoryTokens", type: "number", description: "Token budget for working memory", defaultValue: 32000 },
        { name: "fragmenterConfig.samplingRate", type: "number", description: "Sampling rate (0.0-1.0)", defaultValue: 0.3, range: { min: 0.0, max: 1.0 } },
        { name: "fragmenterConfig.minSamples", type: "number", description: "Min samples per page", defaultValue: 3 },
        { name: "fragmenterConfig.maxSamples", type: "number", description: "Max samples per page", defaultValue: 20 },
        { name: "fragmenterConfig.preserveImportantThreshold", type: "number", description: "Always sample messages above this importance", defaultValue: 0.7, range: { min: 0.0, max: 1.0 } },
    ],
});
// --- HNSW Memory (lazy-loaded) ---
memoryRegistry.register({
    type: "hnsw",
    label: "HNSW Memory",
    description: "Hierarchical Navigable Small World vector-based memory with semantic retrieval.",
    factory: async (config) => {
        const { HNSWMemory } = await import("./hnsw-memory.js");
        return new HNSWMemory({
            systemPrompt: config.systemPrompt,
            dimension: config.dimension,
            retrievalCount: config.retrievalCount,
            similarityThreshold: config.similarityThreshold,
        });
    },
    defaults: {
        dimension: 384,
        retrievalCount: 3,
        similarityThreshold: 0.7,
    },
    parameters: [
        { name: "dimension", type: "number", description: "Embedding dimensions", defaultValue: 384 },
        { name: "retrievalCount", type: "number", description: "Number of similar messages to retrieve", defaultValue: 3 },
        { name: "similarityThreshold", type: "number", description: "Similarity threshold (0.0-1.0)", defaultValue: 0.7 },
    ],
});
