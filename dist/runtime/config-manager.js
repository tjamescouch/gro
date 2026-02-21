/**
 * RuntimeConfigurationManager — orchestrates dynamic runtime control.
 *
 * Responsibilities:
 * - System prompt hot-patching (@@learn directive)
 * - Memory type swapping (@@ctrl:memory=type)
 * - Model switching (@@model-change)
 * - Thinking lever (@@thinking, @@think, @@relax)
 * - Token budget tracking
 *
 * Integrates with memory registry, chat loop, and prompt pipeline.
 */
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../logger.js";
import { memoryRegistry } from "../memory/memory-registry.js";
export class RuntimeConfigurationManager {
    constructor(initialConfig = {}) {
        this.learnedFacts = [];
        this.driver = null;
        this.currentMemory = null;
        const groDir = join(homedir(), ".gro");
        this.config = {
            memoryType: "virtual",
            model: "claude-sonnet-4-5",
            provider: "anthropic",
            thinkingLevel: 0.5,
            learnFilePath: join(groDir, "_learn.md"),
            pagesDir: join(groDir, "pages"),
            ...initialConfig,
        };
        this.baseSystemPrompt = "";
    }
    /** Set the driver for memory instantiation */
    setDriver(driver) {
        this.driver = driver;
    }
    /** Set the current memory instance */
    setMemory(memory) {
        this.currentMemory = memory;
    }
    /** Set the base system prompt (before learned facts) */
    setBaseSystemPrompt(prompt) {
        this.baseSystemPrompt = prompt;
    }
    /** Load learned facts from disk */
    async loadLearnedFacts() {
        try {
            const content = await fs.readFile(this.config.learnFilePath, "utf-8");
            this.learnedFacts = content
                .split("\n")
                .map((line) => line.replace(/^-\s*/, "").trim())
                .filter((line) => line.length > 0);
            Logger.info(`Loaded ${this.learnedFacts.length} learned facts from ${this.config.learnFilePath}`);
        }
        catch (err) {
            if (err.code === "ENOENT") {
                Logger.info(`No learned facts file found at ${this.config.learnFilePath}`);
                this.learnedFacts = [];
            }
            else {
                Logger.error(`Failed to load learned facts: ${err.message}`);
                this.learnedFacts = [];
            }
        }
    }
    /** Append a new fact to the learn file and reload */
    async learn(fact) {
        const trimmed = fact.trim();
        if (!trimmed) {
            Logger.warn("Attempted to learn empty fact, ignoring.");
            return;
        }
        // Append to file
        try {
            await fs.mkdir(dirname(this.config.learnFilePath), { recursive: true });
            const line = `- ${trimmed}\n`;
            await fs.appendFile(this.config.learnFilePath, line, "utf-8");
            Logger.info(`Learned: ${trimmed}`);
        }
        catch (err) {
            Logger.error(`Failed to write learned fact: ${err.message}`);
            throw err;
        }
        // Reload facts
        await this.loadLearnedFacts();
        // Hot-patch system prompt if memory is available
        if (this.currentMemory) {
            const sysMsg = this.currentMemory.messages().find(m => m.role === "system");
            if (sysMsg) {
                sysMsg.content = this.buildSystemPrompt();
                Logger.info("System prompt hot-patched with learned fact.");
            }
        }
    }
    /** Build the final system prompt (base + learned facts) */
    buildSystemPrompt() {
        if (this.learnedFacts.length === 0) {
            return this.baseSystemPrompt;
        }
        const learnBlock = `\n<!-- LEARNED -->\n${this.learnedFacts.map((f) => `- ${f}`).join("\n")}`;
        return this.baseSystemPrompt + learnBlock;
    }
    /** Swap memory type at runtime */
    async swapMemory(newType) {
        if (!memoryRegistry.has(newType)) {
            const available = memoryRegistry.list().map((d) => d.type).join(", ");
            throw new Error(`Unknown memory type '${newType}'. Available: ${available}`);
        }
        if (!this.driver) {
            throw new Error("Cannot swap memory: driver not set. Call setDriver() first.");
        }
        // Snapshot current memory state
        const oldMessages = this.currentMemory ? this.currentMemory.messages() : [];
        Logger.info(`Swapping memory from '${this.config.memoryType}' to '${newType}'...`);
        // Create new memory instance
        const newMemory = await memoryRegistry.create(newType, {
            systemPrompt: this.buildSystemPrompt(),
            driver: this.driver,
            model: this.config.model,
            provider: this.config.provider,
            pagesDir: this.config.pagesDir,
        });
        // Restore messages
        for (const msg of oldMessages) {
            await newMemory.add(msg);
        }
        this.config.memoryType = newType;
        this.currentMemory = newMemory;
        Logger.info(`Memory swapped to '${newType}' successfully.`);
        return newMemory;
    }
    /** Set thinking level (0.0–1.0) */
    setThinkingLevel(level) {
        this.config.thinkingLevel = Math.max(0.0, Math.min(1.0, level));
    }
    /** Bump thinking level by delta */
    adjustThinkingLevel(delta) {
        this.setThinkingLevel(this.config.thinkingLevel + delta);
    }
    /** Get current thinking level */
    getThinkingLevel() {
        return this.config.thinkingLevel;
    }
    /** Get current config snapshot */
    getConfig() {
        return { ...this.config };
    }
    /** Get learned facts */
    getLearnedFacts() {
        return [...this.learnedFacts];
    }
    /** Get current memory instance */
    getCurrentMemory() {
        return this.currentMemory;
    }
}
export const runtimeConfig = new RuntimeConfigurationManager();
