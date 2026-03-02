/**
 * Base class for agent memory with background summarization support.
 * Subclasses call `runOnce` to serialize/queue summarization so callers never block.
 */
export class AgentMemory {
    /** Whether a background summarization/compaction is currently running. */
    get isSummarizing() { return this.summarizing; }
    constructor(systemPrompt) {
        this.messagesBuffer = [];
        this.summarizing = false;
        this.pending = false;
        if (systemPrompt && systemPrompt.trim().length > 0) {
            this.messagesBuffer.push({ role: "system", content: systemPrompt, from: "System" });
        }
    }
    async add(msg) {
        this.messagesBuffer.push(msg);
        await this.onAfterAdd();
    }
    async addIfNotExists(msg) {
        const exists = this.messagesBuffer.some(m => m.content === msg.content && m.role === msg.role);
        if (!exists) {
            this.messagesBuffer.push(msg);
            await this.onAfterAdd();
        }
    }
    /**
     * Bulk-restore messages without triggering onAfterAdd (no compaction).
     * Used by warm state restore where messages are pre-compacted snapshots.
     * Preserves any existing system prompt as the first message.
     */
    restoreMessages(msgs) {
        // Keep the system prompt (first message) if present, then replace the rest
        const sysPrompt = this.messagesBuffer.length > 0 && this.messagesBuffer[0].role === "system"
            ? this.messagesBuffer[0]
            : null;
        // If incoming messages include their own system prompt, use them as-is
        if (msgs.length > 0 && msgs[0].role === "system") {
            this.messagesBuffer = [...msgs];
        }
        else if (sysPrompt) {
            this.messagesBuffer = [sysPrompt, ...msgs];
        }
        else {
            this.messagesBuffer = [...msgs];
        }
    }
    /** Update the active provider (used for session metadata persistence). */
    setProvider(_provider) { }
    /** Update the active model (used by stream markers to persist model changes across turns). */
    setModel(_model) { }
    /** Update thinking budget — VirtualMemory uses this to scale compaction aggressiveness. */
    setThinkingBudget(_budget) { }
    /** Run compaction with single-shot hints. Override in subclasses that support compaction. */
    async compactWithHints(_hints) {
        return "compact_context: this memory module does not support compaction.";
    }
    /** Mark a message as protected from compaction (current-turn tool results). */
    protectMessage(_msg) { }
    /** Remove protection from a message. */
    unprotectMessage(_msg) { }
    /** Clear all message protections (call at start of each turn). */
    clearProtectedMessages() { }
    /** Proactively compact if usage exceeds threshold. Returns true if compaction ran. */
    async preToolCompact(_threshold) { return false; }
    messages() {
        return [...this.messagesBuffer];
    }
    /** Return standardized stats about current memory state. Override in subclasses for richer data. */
    getStats() {
        const avgCharsPerToken = 2.8;
        let totalChars = 0;
        for (const m of this.messagesBuffer) {
            totalChars += String(m.content ?? "").length + 32;
        }
        return {
            type: "base",
            totalMessages: this.messagesBuffer.length,
            totalTokensEstimate: Math.ceil(totalChars / avgCharsPerToken),
            bufferMessages: this.messagesBuffer.length,
        };
    }
    nonSystemCount() {
        if (this.messagesBuffer.length === 0)
            return 0;
        return this.messagesBuffer[0].role === "system"
            ? this.messagesBuffer.length - 1
            : this.messagesBuffer.length;
    }
    async runOnce(task) {
        if (this.summarizing) {
            this.pending = true;
            return;
        }
        this.summarizing = true;
        try {
            await task();
        }
        finally {
            this.summarizing = false;
            if (this.pending) {
                this.pending = false;
                void this.runOnce(task);
            }
        }
    }
}
