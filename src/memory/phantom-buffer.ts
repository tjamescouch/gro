import type { ChatMessage } from "../drivers/types.js";

/**
 * PhantomBuffer — parallel storage for original messages before compaction.
 *
 * Purpose: Preserve exact conversation history for perfect recall when needed.
 * Trade: RAM cost for retrieval capability.
 *
 * Usage:
 * 1. Before compaction: snapshot current messages to phantom buffer
 * 2. During compaction: VirtualMemory proceeds normally (pages + summaries)
 * 3. On demand: inject phantom messages back into context via 🧠 marker
 *
 * The phantom buffer is invisible until explicitly requested.
 */

export interface PhantomSnapshot {
  /** Unique snapshot ID */
  id: string;
  /** Timestamp when snapshot was created */
  timestamp: string;
  /** Full message buffer at time of snapshot */
  messages: ChatMessage[];
  /** Token count (estimated) */
  tokens: number;
  /** Compaction event that triggered this snapshot */
  reason: string;
}

export class PhantomBuffer {
  private snapshots: PhantomSnapshot[] = [];
  private maxSnapshots: number;
  private avgCharsPerToken: number;

  constructor(options: { maxSnapshots?: number; avgCharsPerToken?: number } = {}) {
    this.maxSnapshots = options.maxSnapshots ?? 10;
    this.avgCharsPerToken = options.avgCharsPerToken ?? 2.8;
  }

  /**
   * Create a snapshot of the current message buffer before compaction.
   * Returns the snapshot ID for later retrieval.
   */
  snapshot(messages: ChatMessage[], reason: string): string {
    const id = `phantom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tokens = this.estimateTokens(messages);

    const snap: PhantomSnapshot = {
      id,
      timestamp: new Date().toISOString(),
      messages: JSON.parse(JSON.stringify(messages)), // deep clone
      tokens,
      reason,
    };

    this.snapshots.push(snap);

    // Enforce max snapshots (FIFO eviction)
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }

    return id;
  }

  /**
   * Retrieve a snapshot by ID.
   * Returns null if not found.
   */
  getSnapshot(id: string): PhantomSnapshot | null {
    return this.snapshots.find(s => s.id === id) ?? null;
  }

  /**
   * Get the most recent snapshot.
   */
  getLatest(): PhantomSnapshot | null {
    return this.snapshots[this.snapshots.length - 1] ?? null;
  }

  /**
   * List all available snapshots (metadata only, not full messages).
   */
  listSnapshots(): Array<{ id: string; timestamp: string; tokens: number; reason: string; messageCount: number }> {
    return this.snapshots.map(s => ({
      id: s.id,
      timestamp: s.timestamp,
      tokens: s.tokens,
      reason: s.reason,
      messageCount: s.messages.length,
    }));
  }

  /**
   * Clear all snapshots.
   */
  clear(): void {
    this.snapshots = [];
  }

  /**
   * Get total memory usage (estimated).
   */
  getMemoryUsage(): { snapshots: number; totalTokens: number; totalMessages: number } {
    const totalTokens = this.snapshots.reduce((sum, s) => sum + s.tokens, 0);
    const totalMessages = this.snapshots.reduce((sum, s) => sum + s.messages.length, 0);
    return {
      snapshots: this.snapshots.length,
      totalTokens,
      totalMessages,
    };
  }

  private estimateTokens(messages: ChatMessage[]): number {
    let chars = 0;
    for (const m of messages) {
      const s = String(m.content ?? "");
      chars += s.length + 32;
      const tc = (m as any).tool_calls;
      if (Array.isArray(tc)) {
        for (const call of tc) {
          const fn = call?.function;
          if (fn) {
            chars += (fn.name?.length ?? 0) + (fn.arguments?.length ?? 0) + 32;
          }
        }
      }
    }
    return Math.ceil(chars / this.avgCharsPerToken);
  }
}
