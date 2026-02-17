/**
 * Base class for agent memory with background summarization support.
 * Subclasses call `runOnce` to serialize/queue summarization so callers never block.
 */
export class AgentMemory {
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
    messages() {
        return [...this.messagesBuffer];
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
