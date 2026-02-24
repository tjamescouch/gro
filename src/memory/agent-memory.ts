import type { ChatMessage } from "../drivers/types.js";

// --- Memory Stats Interfaces ---

export interface MemoryStats {
  type: string;
  totalMessages: number;
  totalTokensEstimate: number;
  bufferMessages: number;
}

export interface VirtualMemoryStats extends MemoryStats {
  type: "virtual" | "fragmentation" | "hnsw" | "perfect";
  workingMemoryBudget: number;
  workingMemoryUsed: number;
  pageSlotBudget: number;
  pagesAvailable: number;
  pagesLoaded: number;
  highRatio: number;
  compactionActive: boolean;
  thinkingBudget: number | null;
  lanes: { role: string; tokens: number; count: number }[];
  pinnedMessages: number;
  model: string | null;
}

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

  /** Update the active model (used by stream markers to persist model changes across turns). */
  setModel(_model: string): void {}

  /** Update thinking budget — VirtualMemory uses this to scale compaction aggressiveness. */
  setThinkingBudget(_budget: number): void {}

  messages(): ChatMessage[] {
    return [...this.messagesBuffer];
  }

  /** Return standardized stats about current memory state. Override in subclasses for richer data. */
  getStats(): MemoryStats {
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
