/**
 * SensoryMemory — decorator that injects a sensory buffer into any AgentMemory.
 *
 * Wraps an inner AgentMemory and adds a compact sensory block (context map,
 * environment state, etc.) as a system message right after the system prompt.
 * Zero changes to existing memory modules — works with all memory types.
 *
 * Usage:
 *   const inner = new VirtualMemory({ ... });
 *   const sensory = new SensoryMemory(inner, { totalBudget: 500 });
 *   sensory.addChannel({ name: "context", ... source: contextMapSource });
 *   // Before each turn:
 *   await sensory.pollSources();
 *   const msgs = sensory.messages(); // inner messages + sensory buffer at index 1
 */
import { AgentMemory } from "./agent-memory.js";
import { Logger } from "../logger.js";
// --- SensoryMemory ---
export class SensoryMemory extends AgentMemory {
    constructor(inner, config = {}) {
        // Don't pass systemPrompt — inner already has it
        super();
        this.channels = new Map();
        // Clear the empty messagesBuffer created by super() — we delegate everything to inner
        this.messagesBuffer = []; // unused, inner owns messages
        this.inner = inner;
        this.totalBudget = config.totalBudget ?? 500;
        this.avgCharsPerToken = config.avgCharsPerToken ?? 2.8;
    }
    // --- Channel management ---
    addChannel(channel) {
        this.channels.set(channel.name, channel);
    }
    removeChannel(name) {
        const ch = this.channels.get(name);
        if (ch?.source)
            ch.source.destroy();
        this.channels.delete(name);
    }
    setEnabled(name, enabled) {
        const ch = this.channels.get(name);
        if (ch)
            ch.enabled = enabled;
    }
    update(name, content) {
        const ch = this.channels.get(name);
        if (!ch)
            return;
        // Enforce per-channel token limit
        const maxChars = ch.maxTokens * this.avgCharsPerToken;
        ch.content = content.length > maxChars ? content.slice(0, maxChars) + "..." : content;
    }
    /** Poll all every_turn sources for fresh content. Call before driver.chat(). */
    async pollSources() {
        for (const [name, ch] of this.channels) {
            if (!ch.enabled || ch.updateMode !== "every_turn" || !ch.source)
                continue;
            try {
                const content = await ch.source.poll();
                if (content !== null) {
                    this.update(name, content);
                }
            }
            catch (err) {
                Logger.warn(`[Sensory] Channel '${name}' poll failed: ${err}`);
            }
        }
    }
    /** Handle @@sense@@ marker from stream. Args: channel (or action), action. */
    onSenseMarker(channelOrAction, action) {
        // If first arg is an action keyword with no channel → apply to all channels
        // Otherwise first arg is channel name, second is action
        const isAction = (s) => ["off", "disable", "on", "enable"].includes(s);
        let channel;
        let op;
        if (isAction(channelOrAction) && !action) {
            // @@sense('off')@@ — disable all
            channel = "";
            op = channelOrAction;
        }
        else if (!isAction(channelOrAction) && isAction(action)) {
            // @@sense('context,off')@@ — channel first, action second
            channel = channelOrAction;
            op = action;
        }
        else if (isAction(channelOrAction)) {
            // @@sense('off,context')@@ — action first, channel second (legacy compat)
            channel = action;
            op = channelOrAction;
        }
        else {
            return; // unrecognized
        }
        if (op === "off" || op === "disable") {
            if (channel) {
                this.setEnabled(channel, false);
            }
            else {
                for (const ch of this.channels.values())
                    ch.enabled = false;
            }
        }
        else if (op === "on" || op === "enable") {
            if (channel) {
                this.setEnabled(channel, true);
            }
            else {
                for (const ch of this.channels.values())
                    ch.enabled = true;
            }
        }
    }
    // --- Inner memory access ---
    getInner() {
        return this.inner;
    }
    setInner(newInner) {
        this.inner = newInner;
        // Update sources that hold a reference to the inner memory
        for (const ch of this.channels.values()) {
            if (ch.source && "setMemory" in ch.source && typeof ch.source.setMemory === "function") {
                ch.source.setMemory(newInner);
            }
        }
    }
    // --- Render ---
    renderBuffer() {
        const enabled = Array.from(this.channels.values()).filter(ch => ch.enabled && ch.content);
        if (enabled.length === 0)
            return "";
        const parts = [];
        let totalChars = 0;
        const maxChars = this.totalBudget * this.avgCharsPerToken;
        for (const ch of enabled) {
            const header = `[${ch.name}]`;
            const section = `${header}\n${ch.content}`;
            if (totalChars + section.length > maxChars && parts.length > 0)
                break;
            parts.push(section);
            totalChars += section.length;
        }
        return `--- SENSORY BUFFER ---\n${parts.join("\n\n")}\n--- END SENSORY BUFFER ---`;
    }
    // --- AgentMemory overrides (delegation + injection) ---
    messages() {
        const inner = this.inner.messages();
        const buffer = this.renderBuffer();
        if (!buffer)
            return inner;
        const sensoryMsg = {
            role: "system",
            content: buffer,
            from: "SensoryMemory",
        };
        // Inject at index 1 (after system prompt, before conversation)
        const result = [...inner];
        if (result.length > 0 && result[0].role === "system") {
            result.splice(1, 0, sensoryMsg);
        }
        else {
            result.unshift(sensoryMsg);
        }
        return result;
    }
    async add(msg) {
        await this.inner.add(msg);
    }
    async addIfNotExists(msg) {
        await this.inner.addIfNotExists(msg);
    }
    async load(id) {
        await this.inner.load(id);
    }
    async save(id) {
        await this.inner.save(id);
    }
    setModel(model) {
        this.inner.setModel(model);
    }
    setThinkingBudget(budget) {
        this.inner.setThinkingBudget(budget);
    }
    getStats() {
        return this.inner.getStats();
    }
    async onAfterAdd() {
        // Handled by inner memory
    }
}
