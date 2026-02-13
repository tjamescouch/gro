import type { ChatMessage } from "../drivers/types.js";

/**
 * Base class for agent memory with background summarization support.
 * Subclasses call `runOnce` to serialize/queue summarization so callers never block.
 */
export abstract class AgentMemory {
  protected messagesBuffer: ChatMessage[] = [];

  private summarizing = false;
  private pending = false;

  constructor(systemPrompt?: string) {
    if (systemPrompt && systemPrompt.trim().length > 0) {
      this.messagesBuffer.push({ role: "system", content: systemPrompt, from: "System" });
    }
  }

  abstract load(id: string): Promise<void>;
  abstract save(id: string): Promise<void>;

  async add(msg: ChatMessage): Promise<void> {
    this.messagesBuffer.push(msg);
    await this.onAfterAdd();
  }

  async addIfNotExists(msg: ChatMessage): Promise<void> {
    const exists = this.messagesBuffer.some(m => m.content === msg.content && m.role === msg.role);
    if (!exists) {
      this.messagesBuffer.push(msg);
      await this.onAfterAdd();
    }
  }

  protected abstract onAfterAdd(): Promise<void>;

  messages(): ChatMessage[] {
    return [...this.messagesBuffer];
  }

  protected nonSystemCount(): number {
    if (this.messagesBuffer.length === 0) return 0;
    return this.messagesBuffer[0].role === "system"
      ? this.messagesBuffer.length - 1
      : this.messagesBuffer.length;
  }

  protected async runOnce(task: () => Promise<void>): Promise<void> {
    if (this.summarizing) { this.pending = true; return; }
    this.summarizing = true;
    try {
      await task();
    } finally {
      this.summarizing = false;
      if (this.pending) {
        this.pending = false;
        void this.runOnce(task);
      }
    }
  }
}
