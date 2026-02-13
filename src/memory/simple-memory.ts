import type { ChatMessage } from "../drivers/types.js";
import { AgentMemory } from "./agent-memory.js";
import { saveSession, loadSession, ensureGroDir } from "../session.js";

/**
 * SimpleMemory — unbounded message buffer.
 * No summarization, no token budgeting. Useful for short conversations
 * or when the caller manages context externally.
 */
export class SimpleMemory extends AgentMemory {
  private provider = "";
  private model = "";

  constructor(systemPrompt?: string) {
    super(systemPrompt);
  }

  setMeta(provider: string, model: string): void {
    this.provider = provider;
    this.model = model;
  }

  async load(id: string): Promise<void> {
    const session = loadSession(id);
    if (session) {
      this.messagesBuffer = session.messages;
    }
  }

  async save(id: string): Promise<void> {
    ensureGroDir();
    saveSession(id, this.messagesBuffer, {
      id,
      provider: this.provider,
      model: this.model,
      createdAt: new Date().toISOString(),
    });
  }

  protected async onAfterAdd(): Promise<void> {}
}
