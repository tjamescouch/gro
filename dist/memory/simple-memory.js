import { AgentMemory } from "./agent-memory.js";
import { saveSession, loadSession, ensureGroDir } from "../session.js";
/**
 * SimpleMemory — unbounded message buffer.
 * No summarization, no token budgeting. Useful for short conversations
 * or when the caller manages context externally.
 */
export class SimpleMemory extends AgentMemory {
    constructor(systemPrompt) {
        super(systemPrompt);
        this.provider = "";
        this.model = "";
    }
    setMeta(provider, model) {
        this.provider = provider;
        this.model = model;
    }
    setProvider(provider) {
        this.provider = provider;
    }
    setModel(model) {
        this.model = model;
    }
    async load(id) {
        const session = loadSession(id);
        if (session) {
            this.messagesBuffer = session.messages;
        }
    }
    async save(id) {
        ensureGroDir();
        saveSession(id, this.messagesBuffer, {
            id,
            provider: this.provider,
            model: this.model,
            createdAt: new Date().toISOString(),
        });
    }
    getStats() {
        const stats = super.getStats();
        return { ...stats, type: "simple" };
    }
    async onAfterAdd() { }
}
