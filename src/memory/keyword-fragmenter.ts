import type { Fragmenter, FragmenterConfig } from './fragmentation-memory.js';

export interface KeywordFragmenterConfig extends FragmenterConfig {
  /** Keywords to prioritize. Messages containing these are always kept. */
  keywords?: string[];
  /** Max messages to return (default: 20) */
  maxMessages?: number;
}

/**
 * KeywordFragmenter — retains messages that match given keywords,
 * plus fills remaining slots with most-recent messages.
 * Zero API cost.
 */
export class KeywordFragmenter implements Fragmenter {
  private keywords: string[];
  private maxMessages: number;

  constructor(config: KeywordFragmenterConfig = {}) {
    this.keywords = (config.keywords ?? []).map(k => k.toLowerCase());
    this.maxMessages = config.maxMessages ?? 20;
  }

  fragment(messages: any[]): any[] {
    if (this.keywords.length === 0) {
      return messages.slice(-this.maxMessages);
    }

    const matched: any[] = [];
    const unmatched: any[] = [];

    for (const msg of messages) {
      const text = (
        (typeof msg.content === 'string' ? msg.content : '') +
        (msg.role ?? '')
      ).toLowerCase();

      const hits = this.keywords.some(kw => text.includes(kw));
      if (hits) matched.push(msg);
      else unmatched.push(msg);
    }

    // Fill up to maxMessages: matched first, then recent unmatched
    const slots = this.maxMessages - matched.length;
    const recent = slots > 0 ? unmatched.slice(-slots) : [];
    return [...matched, ...recent].slice(-this.maxMessages);
  }
}
