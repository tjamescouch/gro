import type { ChatMessage } from "../drivers/types.js";
import { AgentMemory } from "./agent-memory.js";

/**
 * SimpleMemory — unbounded message buffer.
 * No summarization, no token budgeting. Useful for short conversations
 * or when the caller manages context externally.
 */
export class SimpleMemory extends AgentMemory {
  constructor(systemPrompt?: string) {
    super(systemPrompt);
  }

  async load(_id: string): Promise<void> {}
  async save(_id: string): Promise<void> {}
  protected async onAfterAdd(): Promise<void> {}
}
