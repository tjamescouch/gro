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
    /** Update the active model (used by stream markers to persist model changes across turns). */
    setModel(_model) { }
    /** Update thinking budget — VirtualMemory uses this to scale compaction aggressiveness. */
    setThinkingBudget(_budget) { }
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
