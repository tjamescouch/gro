/**
 * SensoryMemory — decorator that injects a sensory buffer into any AgentMemory.
 *
 * Wraps an inner AgentMemory and adds a compact sensory block (context map,
 * environment state, etc.) as a system message right after the system prompt.
 * Zero changes to existing memory modules — works with all memory types.
 *
 * Two-slot camera system: slot0 and slot1 are both agent-switchable via the
 * stream marker. Default: slot0="context", slot1="time".
 * Use <view:X> to set slot0, <view:X,1> to set slot1.
 *
 * Usage:
 *   const inner = new VirtualMemory({ ... });
 *   const sensory = new SensoryMemory(inner, { totalBudget: 500 });
 *   sensory.addChannel({ name: "context", ... source: contextMapSource });
 *   sensory.addChannel({ name: "time",    ... source: temporalSource });
 *   sensory.setSlot(0, "context");
 *   sensory.setSlot(1, "time");
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
        /** Three camera slots — all agent-switchable. null = slot disabled. */
        this.slots = [null, null, null];
        /** Saved slot state during full-screen expand. */
        this.savedSlots = null;
        /** Saved maxTokens per channel during full-screen expand. */
        this.savedMaxTokens = new Map();
        /** Countdown for full-screen expand restoration. */
        this.expandTurnsRemaining = 0;
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
    // --- Camera slot management ---
    /**
     * Set a camera slot to a named channel.
     * @param slot 0 or 1
     * @param channelName name of a registered channel, or null to clear slot
     */
    setSlot(slot, channelName) {
        this.slots[slot] = channelName;
        Logger.telemetry(`[Sensory] slot${slot} → ${channelName ?? "off"}`);
    }
    getSlot(slot) {
        return this.slots[slot];
    }
    /** Switch a camera slot. If channelName exists, activate it. */
    switchView(channelName, slot = 0) {
        if (!this.channels.has(channelName)) {
            Logger.warn(`[Sensory] switchView: unknown channel '${channelName}'`);
            return;
        }
        this.setSlot(slot, channelName);
    }
    /** Get channel names in registration order — used for view cycling. */
    getChannelNames() {
        return Array.from(this.channels.keys());
    }
    /** Get the source for a named channel (for late-binding dependency injection). */
    getChannelSource(name) {
        return this.channels.get(name)?.source;
    }
    /** Cycle slot0 to the next/previous channel in registration order. */
    cycleSlot0(direction) {
        const names = this.getChannelNames();
        if (names.length === 0)
            return;
        const current = this.slots[0];
        let idx = current ? names.indexOf(current) : -1;
        if (direction === "next") {
            idx = (idx + 1) % names.length;
        }
        else {
            idx = idx <= 0 ? names.length - 1 : idx - 1;
        }
        this.setSlot(0, names[idx]);
    }
    /**
     * Full-screen expand: commandeer all 3 slots for a single channel for one turn.
     * Saves current slot config and boosts the channel's token budget to the total budget.
     * Automatically restores after the next pollSources() cycle.
     */
    expandForOneTurn(channelName) {
        const ch = this.channels.get(channelName);
        if (!ch) {
            Logger.warn(`[Sensory] expandForOneTurn: unknown channel '${channelName}'`);
            return;
        }
        // Save current state
        this.savedSlots = [...this.slots];
        this.savedMaxTokens.set(channelName, ch.maxTokens);
        // Expand: 3x budget to this channel (one-shot diagnostic, restores after 1 turn)
        const expandedBudget = this.totalBudget * 3;
        ch.maxTokens = expandedBudget;
        // Propagate expanded budget to the source if it supports dynamic maxChars
        if (ch.source && "setMaxChars" in ch.source && typeof ch.source.setMaxChars === "function") {
            ch.source.setMaxChars(Math.floor(expandedBudget * this.avgCharsPerToken));
        }
        this.slots = [channelName, null, null];
        // 2 = next poll renders expanded, then restore before the poll after that
        this.expandTurnsRemaining = 2;
        Logger.telemetry(`[Sensory] Full-screen expand: ${channelName} (budget: ${expandedBudget})`);
    }
    /** Restore slot config and channel budgets after full-screen expand. */
    restoreFromExpand() {
        if (this.savedSlots) {
            this.slots = this.savedSlots;
            this.savedSlots = null;
        }
        for (const [name, maxTok] of this.savedMaxTokens) {
            const ch = this.channels.get(name);
            if (ch) {
                ch.maxTokens = maxTok;
                // Restore source's maxChars to match the original channel budget
                if (ch.source && "setMaxChars" in ch.source && typeof ch.source.setMaxChars === "function") {
                    ch.source.setMaxChars(Math.floor(maxTok * this.avgCharsPerToken));
                }
            }
        }
        this.savedMaxTokens.clear();
        Logger.telemetry(`[Sensory] Restored from full-screen expand`);
    }
    /** Poll all every_turn sources for fresh content. Call before driver.chat(). */
    async pollSources() {
        // Handle full-screen expand lifecycle
        if (this.expandTurnsRemaining > 0) {
            this.expandTurnsRemaining--;
            if (this.expandTurnsRemaining === 0) {
                this.restoreFromExpand();
            }
        }
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
        // Gather content from the three camera slots (in order)
        const slotContents = [];
        for (const slotName of this.slots) {
            if (!slotName)
                continue;
            const ch = this.channels.get(slotName);
            if (ch && ch.enabled && ch.content) {
                slotContents.push({ name: slotName, content: ch.content });
            }
        }
        // Fallback: if no slots configured, render all enabled channels (legacy)
        const items = slotContents.length > 0
            ? slotContents
            : Array.from(this.channels.values())
                .filter(ch => ch.enabled && ch.content)
                .map(ch => ({ name: ch.name, content: ch.content }));
        if (items.length === 0)
            return "";
        const parts = [];
        let totalChars = 0;
        const maxChars = this.totalBudget * this.avgCharsPerToken;
        for (const item of items) {
            const section = `[${item.name}]\n${item.content}`;
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
    protectMessage(msg) {
        this.inner.protectMessage(msg);
    }
    unprotectMessage(msg) {
        this.inner.unprotectMessage(msg);
    }
    clearProtectedMessages() {
        this.inner.clearProtectedMessages();
    }
    async preToolCompact(threshold) {
        return this.inner.preToolCompact(threshold);
    }
    getStats() {
        return this.inner.getStats();
    }
    async onAfterAdd() {
        // Handled by inner memory
    }
}
