import type { Fragmenter, FragmenterConfig } from './fragmentation-memory.js';

export interface RecencyFragmenterConfig extends FragmenterConfig {
  /** Number of most-recent messages to keep (default: 20) */
  keepRecent?: number;
}

/**
 * RecencyFragmenter — keeps the N most recent messages from a batch.
 * Zero API cost. Useful for preserving recent context over older history.
 */
export class RecencyFragmenter implements Fragmenter {
  private keepRecent: number;

  constructor(config: RecencyFragmenterConfig = {}) {
    this.keepRecent = config.keepRecent ?? 20;
  }

  fragment(messages: any[]): any[] {
    if (messages.length <= this.keepRecent) return messages;
    return messages.slice(messages.length - this.keepRecent);
  }
}
