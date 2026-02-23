import { Fragmenter, FragmenterConfig } from './fragmentation-memory.js';
import { Message } from '../types.js';

export interface RecencyFragmenterConfig extends FragmenterConfig {
  /** Always keep the N most recent messages regardless of sampling (default: 10) */
  recentKeepCount?: number;
  /** Fraction of older messages to keep (0.0–1.0, default: 0.2) */
  olderKeepRatio?: number;
}

/**
 * RecencyFragmenter biases retention toward recent messages.
 * The N most recent messages are always preserved.
 * Older messages are sampled at olderKeepRatio.
 *
 * This is useful for maintaining conversational coherence —
 * recent context matters more than distant history.
 */
export class RecencyFragmenter implements Fragmenter {
  private recentKeepCount: number;
  private olderKeepRatio: number;

  constructor(config: RecencyFragmenterConfig = {}) {
    this.recentKeepCount = config.recentKeepCount ?? 10;
    this.olderKeepRatio = config.olderKeepRatio ?? 0.2;
  }

  fragment(messages: Message[], targetCount: number): Message[] {
    if (messages.length === 0) return [];
    if (messages.length <= targetCount) return messages;

    const recentCount = Math.min(this.recentKeepCount, messages.length);
    const recent = messages.slice(-recentCount);
    const older = messages.slice(0, -recentCount);

    const olderKeep = Math.min(
      Math.floor(older.length * this.olderKeepRatio),
      Math.max(0, targetCount - recent.length)
    );

    const sampledOlder = this.sampleEvenly(older, olderKeep);
    return [...sampledOlder, ...recent];
  }

  private sampleEvenly(messages: Message[], count: number): Message[] {
    if (count <= 0 || messages.length === 0) return [];
    if (count >= messages.length) return messages;
    const step = messages.length / count;
    return Array.from({ length: count }, (_, i) => messages[Math.floor(i * step)]);
  }
}
