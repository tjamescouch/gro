import { VirtualMemory } from "./virtual-memory.js";
import { Logger } from "../logger.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
// --- PerfectMemory ---
const FORKS_DIR_DEFAULT = join(process.env.HOME ?? "/tmp", ".gro", "forks");
export class PerfectMemory extends VirtualMemory {
    constructor(config = {}) {
        super(config);
        this.chain = [];
        this.forksDir = config.forksDir ?? FORKS_DIR_DEFAULT;
        this.maxForkAgeMsec = config.maxForkAgeMsec ?? null;
        this.avgCharsPerTokenPM = config.avgCharsPerToken ?? 2.8;
        mkdirSync(this.forksDir, { recursive: true });
        this.loadChain();
    }
    // --- Fork Chain Persistence ---
    chainPath() {
        return join(this.forksDir, "chain.json");
    }
    loadChain() {
        const p = this.chainPath();
        if (!existsSync(p))
            return;
        try {
            const data = JSON.parse(readFileSync(p, "utf8"));
            this.chain = data.forks ?? [];
        }
        catch {
            this.chain = [];
        }
    }
    saveChain() {
        try {
            mkdirSync(this.forksDir, { recursive: true });
            const data = {
                forks: this.chain,
                updatedAt: new Date().toISOString(),
            };
            writeFileSync(this.chainPath(), JSON.stringify(data, null, 2) + "\n");
        }
        catch (err) {
            Logger.error(`[PerfectMemory] Failed to save chain: ${err}`);
        }
    }
    // --- Fork File I/O ---
    forkPath(id) {
        return join(this.forksDir, `${id}.json`);
    }
    saveFork(fork) {
        try {
            mkdirSync(this.forksDir, { recursive: true });
            writeFileSync(this.forkPath(fork.id), JSON.stringify(fork, null, 2) + "\n");
        }
        catch (err) {
            Logger.error(`[PerfectMemory] Failed to save fork ${fork.id}: ${err}`);
        }
    }
    generateForkId(messages) {
        const content = messages.map(m => String(m.content ?? "").slice(0, 500)).join("|");
        const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
        return `fork_${Date.now()}_${hash}`;
    }
    estimateTokens(messages) {
        let chars = 0;
        for (const m of messages) {
            chars += String(m.content ?? "").length + 32;
            const tc = m.tool_calls;
            if (Array.isArray(tc)) {
                for (const call of tc) {
                    const fn = call?.function;
                    if (fn) {
                        chars += (fn.name?.length ?? 0) + (fn.arguments?.length ?? 0) + 32;
                    }
                }
            }
        }
        return Math.ceil(chars / this.avgCharsPerTokenPM);
    }
    countLanes(messages) {
        const lanes = { assistant: 0, user: 0, system: 0, tool: 0 };
        for (const m of messages) {
            switch (m.role) {
                case "assistant":
                    lanes.assistant++;
                    break;
                case "user":
                    lanes.user++;
                    break;
                case "system":
                    lanes.system++;
                    break;
                case "tool":
                    lanes.tool++;
                    break;
            }
        }
        return lanes;
    }
    // --- Core: Override onAfterAdd ---
    /**
     * Before VirtualMemory's compaction runs, persist the full message buffer
     * as an immutable fork on disk. Then delegate to super for normal compaction.
     */
    async onAfterAdd() {
        // We need to check if compaction will trigger BEFORE calling super.
        // Replicate the watermark check from VirtualMemory to detect this.
        const willCompact = this.shouldCompact();
        if (willCompact) {
            // Save current buffer as a fork BEFORE compaction mutates it
            const messages = [...this.messagesBuffer]; // shallow copy
            const parentId = this.chain.length > 0
                ? this.chain[this.chain.length - 1].id
                : null;
            const fork = {
                id: this.generateForkId(messages),
                parentId,
                timestamp: new Date().toISOString(),
                messages: JSON.parse(JSON.stringify(messages)), // deep clone
                tokens: this.estimateTokens(messages),
                messageCount: messages.length,
                reason: this.isForceCompactPending() ? "manual" : "watermark",
                lanes: this.countLanes(messages),
            };
            this.saveFork(fork);
            // Add to chain
            const meta = {
                id: fork.id,
                parentId: fork.parentId,
                timestamp: fork.timestamp,
                tokens: fork.tokens,
                messageCount: fork.messageCount,
                reason: fork.reason,
                lanes: fork.lanes,
            };
            this.chain.push(meta);
            this.saveChain();
            // Prune old forks if maxForkAgeMsec is set
            if (this.maxForkAgeMsec !== null) {
                this.pruneOldForks();
            }
            Logger.info(`[PerfectMemory] Fork saved: ${fork.id} (${fork.messageCount} msgs, ${fork.tokens} tokens, parent=${fork.parentId ?? "none"})`);
        }
        // Delegate to VirtualMemory for normal compaction
        await super.onAfterAdd();
    }
    /**
     * Check if compaction would trigger — mirrors VirtualMemory's watermark logic.
     * This is read-only (no side effects).
     */
    shouldCompact() {
        // Access the forceCompactPending flag
        if (this.isForceCompactPending())
            return true;
        // Replicate the watermark check from VirtualMemory.onAfterAdd()
        const budgets = this.computeLaneBudgetsPM();
        const { assistant, user, system } = this.partitionPM();
        const cfg = this.getConfigPM();
        const assistantTokens = this.estimateTokens(assistant);
        const userTokens = this.estimateTokens(user);
        // Exclude system prompt from system token count
        const sysPrompt = this.messagesBuffer.find(m => m.role === "system" && m.from === "System");
        const remainingSystem = system.filter(m => m !== sysPrompt);
        const systemTokens = this.estimateTokens(remainingSystem);
        return (assistantTokens > budgets.assistant * cfg.highRatio ||
            userTokens > budgets.user * cfg.highRatio ||
            systemTokens > budgets.system * cfg.highRatio);
    }
    /**
     * Check if the parent's forceCompactPending flag is set.
     * We access this via the (private) field — cast for access.
     */
    isForceCompactPending() {
        return this.forceCompactPending === true;
    }
    /** Mirror of VirtualMemory.computeLaneBudgets() for read-only watermark check */
    computeLaneBudgetsPM() {
        const cfg = this.getConfigPM();
        const totalWeight = cfg.assistantWeight + cfg.userWeight + cfg.systemWeight + cfg.toolWeight;
        const wmBudget = cfg.workingMemoryTokens;
        return {
            assistant: Math.floor((cfg.assistantWeight / totalWeight) * wmBudget),
            user: Math.floor((cfg.userWeight / totalWeight) * wmBudget),
            system: Math.floor((cfg.systemWeight / totalWeight) * wmBudget),
            tool: Math.floor((cfg.toolWeight / totalWeight) * wmBudget),
        };
    }
    /** Access parent's private cfg via cast */
    getConfigPM() {
        return this.cfg;
    }
    /** Mirror of VirtualMemory.partition() for read-only swimlane check */
    partitionPM() {
        const assistant = [];
        const user = [];
        const system = [];
        for (const m of this.messagesBuffer) {
            switch (m.role) {
                case "assistant":
                    assistant.push(m);
                    break;
                case "user":
                    user.push(m);
                    break;
                case "system":
                    system.push(m);
                    break;
            }
        }
        return { assistant, user, system };
    }
    // --- Pruning ---
    pruneOldForks() {
        if (this.maxForkAgeMsec === null)
            return;
        const cutoff = Date.now() - this.maxForkAgeMsec;
        const toRemove = [];
        for (const meta of this.chain) {
            const forkTime = new Date(meta.timestamp).getTime();
            if (forkTime < cutoff) {
                toRemove.push(meta.id);
            }
        }
        if (toRemove.length === 0)
            return;
        // Remove fork files
        for (const id of toRemove) {
            const p = this.forkPath(id);
            try {
                if (existsSync(p)) {
                    unlinkSync(p);
                }
            }
            catch (err) {
                Logger.warn(`[PerfectMemory] Failed to prune fork ${id}: ${err}`);
            }
        }
        // Update chain
        const removeSet = new Set(toRemove);
        this.chain = this.chain.filter(m => !removeSet.has(m.id));
        // Fix parent pointers — the first remaining fork's parent should be null
        if (this.chain.length > 0) {
            this.chain[0].parentId = null;
        }
        this.saveChain();
        Logger.info(`[PerfectMemory] Pruned ${toRemove.length} old forks`);
    }
    // --- Public API ---
    /**
     * List all forks (metadata only, no messages).
     */
    forkHistory() {
        return [...this.chain];
    }
    /**
     * Load a fork's full messages from disk.
     * Returns null if not found.
     */
    loadFork(id) {
        const p = this.forkPath(id);
        if (!existsSync(p))
            return null;
        try {
            return JSON.parse(readFileSync(p, "utf8"));
        }
        catch (err) {
            Logger.error(`[PerfectMemory] Failed to load fork ${id}: ${err}`);
            return null;
        }
    }
    /**
     * Load the most recent fork.
     */
    loadLatestFork() {
        if (this.chain.length === 0)
            return null;
        return this.loadFork(this.chain[this.chain.length - 1].id);
    }
    /**
     * Get the fork chain (metadata only).
     */
    getForkChain() {
        return [...this.chain];
    }
    /**
     * Get fork count and total token estimate.
     */
    getForkStats() {
        const totalTokens = this.chain.reduce((sum, m) => sum + m.tokens, 0);
        const totalMessages = this.chain.reduce((sum, m) => sum + m.messageCount, 0);
        return { count: this.chain.length, totalTokens, totalMessages };
    }
    /**
     * Format fork content for injection into context (page slot style).
     * Returns a summary of the fork suitable for the model to read.
     */
    formatForkForContext(fork) {
        const lines = [
            `--- Recalled Fork: ${fork.id} (${fork.messageCount} msgs, ${fork.timestamp}) ---`,
        ];
        for (const m of fork.messages) {
            // Skip system prompts (they're the same)
            if (m.role === "system" && m.from === "System")
                continue;
            const content = String(m.content ?? "").slice(0, 4000);
            const role = m.role.toUpperCase();
            const from = m.from ? ` (${m.from})` : "";
            lines.push(`[${role}${from}]: ${content}`);
        }
        lines.push(`--- End Fork: ${fork.id} ---`);
        return lines.join("\n\n");
    }
    /**
     * Recall a fork: create a page from its messages and load it into the page slot.
     * If no forkId is given, recalls the most recent fork.
     * Returns the page ID on success, or null if fork not found.
     */
    async recallFork(forkId) {
        const fork = forkId ? this.loadFork(forkId) : this.loadLatestFork();
        if (!fork) {
            Logger.warn(`[PerfectMemory] recallFork: fork not found (${forkId ?? "latest"})`);
            return null;
        }
        // Filter out system prompts — they're already in context
        const recallMessages = fork.messages.filter(m => !(m.role === "system" && m.from === "System"));
        if (recallMessages.length === 0) {
            Logger.warn(`[PerfectMemory] recallFork: fork ${fork.id} has no non-system messages`);
            return null;
        }
        try {
            const label = `recalled fork ${fork.id} (${fork.timestamp})`;
            const { page } = await this.createPageFromMessages(recallMessages, label);
            this.ref(page.id);
            Logger.info(`[PerfectMemory] recallFork: ${fork.id} → page ${page.id} (${recallMessages.length} msgs, ${page.tokens} tokens)`);
            return page.id;
        }
        catch (err) {
            Logger.error(`[PerfectMemory] recallFork failed: ${err}`);
            return null;
        }
    }
}
