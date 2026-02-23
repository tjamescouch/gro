import { Fragmenter, FragmenterConfig } from './fragmentation-memory.js';
import { Message } from '../types.js';

export interface KeywordFragmenterConfig extends FragmenterConfig {
  /** Keywords to prioritize — messages containing these survive sampling */
  keywords: string[];
  /** Fraction of non-keyword messages to keep (0.0–1.0, default 0.3) */
  nonKeywordKeepRatio?: number;
}

/**
 * KeywordFragmenter samples messages based on keyword presence.
 * Messages containing priority keywords are always kept.
 * Non-keyword messages are sampled at nonKeywordKeepRatio.
 */
export class KeywordFragmenter implements Fragmenter {
  private keywords: string[];
  private nonKeywordKeepRatio: number;

  constructor(config: KeywordFragmenterConfig) {
    this.keywords = config.keywords.map(k => k.toLowerCase());
    this.nonKeywordKeepRatio = config.nonKeywordKeepRatio ?? 0.3;
  }

  fragment(messages: Message[], targetCount: number): Message[] {
    const keyword = messages.filter(m => this.hasKeyword(m));
    const rest = messages.filter(m => !this.hasKeyword(m));

    const nonKeywordKeep = Math.floor(rest.length * this.nonKeywordKeepRatio);
    const sampled = this.sampleEvenly(rest, nonKeywordKeep);

    const combined = [...keyword, ...sampled];
    if (combined.length <= targetCount) return combined;

    // If still over target, prefer keyword messages
    return [...keyword.slice(0, targetCount), ...sampled.slice(0, Math.max(0, targetCount - keyword.length))];
  }

  private hasKeyword(message: Message): boolean {
    const content = this.extractText(message).toLowerCase();
    return this.keywords.some(kw => content.includes(kw));
  }

  private extractText(message: Message): string {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join(' ');
    }
    return '';
  }

  private sampleEvenly(messages: Message[], count: number): Message[] {
    if (count <= 0 || messages.length === 0) return [];
    if (count >= messages.length) return messages;
    const step = messages.length / count;
    return Array.from({ length: count }, (_, i) => messages[Math.floor(i * step)]);
  }
}
