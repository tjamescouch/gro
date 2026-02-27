import type { ChatMessage } from "../drivers/types.js";

// --- Compaction Hints ---

/** Single-shot hints for fine-grained control over one compaction cycle. */
export interface CompactionHints {
  /** Per-lane priority weights. Higher = preserve more. Auto-normalized.
   *  Standard lanes: "assistant", "user", "system", "tool". */
  lane_weights?: Record<string, number>;
  /** Importance threshold (0.0-1.0) for promoting messages to keep set.
   *  Lower = keep more. Default: 0.7 */
  importance_threshold?: number;
  /** Min recent messages to preserve per lane (single-shot override). */
  min_recent?: number;
  /** 0.0 = light cleanup, 1.0 = free maximum space. Default: 0.5 */
  aggressiveness?: number;
}

// --- Memory Stats Interfaces ---

export interface MemoryStats {
  type: string;
  totalMessages: number;
  totalTokensEstimate: number;
  bufferMessages: number;
}

export interface VirtualMemoryStats extends MemoryStats {
  type: "virtual" | "fragmentation" | "hnsw" | "perfect";
  systemTokens: number;
  workingMemoryBudget: number;
  workingMemoryUsed: number;
  pageSlotBudget: number;
  pageSlotUsed: number;
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

  /** Whether a background summarization/compaction is currently running. */
  protected get isSummarizing(): boolean { return this.summarizing; }

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

  /** Run compaction with single-shot hints. Override in subclasses that support compaction. */
  async compactWithHints(_hints: CompactionHints): Promise<string> {
    return "compact_context: this memory module does not support compaction.";
  }

  /** Mark a message as protected from compaction (current-turn tool results). */
  protectMessage(_msg: ChatMessage): void {}

  /** Remove protection from a message. */
  unprotectMessage(_msg: ChatMessage): void {}

  /** Clear all message protections (call at start of each turn). */
  clearProtectedMessages(): void {}

  /** Proactively compact if usage exceeds threshold. Returns true if compaction ran. */
  async preToolCompact(_threshold?: number): Promise<boolean> { return false; }

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
