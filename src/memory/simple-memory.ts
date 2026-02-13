import type { ChatMessage } from "../drivers/types.js";
import { AgentMemory } from "./agent-memory.js";
import { loadSession, saveSession, ensureGroDir } from "../session.js";

/**
 * SimpleMemory — unbounded message buffer.
 * No summarization, no token budgeting. Useful for short conversations
 * or when the caller manages context externally.
 */
export class SimpleMemory extends AgentMemory {
  constructor(systemPrompt?: string) {
    super(systemPrompt);
  }

  async load(id: string): Promise<void> {
    const session = loadSession(id);
    if (session) {
      this.messagesBuffer.splice(0, this.messagesBuffer.length, ...session.messages);
    }
  }

  async save(id: string): Promise<void> {
    ensureGroDir();
    saveSession(id, this.messagesBuffer, {});
  }
  protected async onAfterAdd(): Promise<void> {}
}
