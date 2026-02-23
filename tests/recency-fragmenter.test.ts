import { describe, it, expect } from 'vitest';
import { RecencyFragmenter } from '../src/memory/recency-fragmenter.js';

const makeMsg = (content: string) => ({ role: 'user' as const, content });
const msgs = (n: number) => Array.from({ length: n }, (_, i) => makeMsg(`msg ${i}`));

describe('RecencyFragmenter', () => {
  it('always keeps the N most recent messages', () => {
    const f = new RecencyFragmenter({ recentKeepCount: 5, olderKeepRatio: 0.0 });
    const messages = msgs(20);
    const result = f.fragment(messages, 10);
    const last5 = messages.slice(-5).map(m => m.content);
    last5.forEach(content => {
      expect(result.some(m => m.content === content)).toBe(true);
    });
  });

  it('returns all messages when under targetCount', () => {
    const f = new RecencyFragmenter();
    const messages = msgs(5);
    expect(f.fragment(messages, 10)).toHaveLength(5);
  });

  it('handles empty array', () => {
    const f = new RecencyFragmenter();
    expect(f.fragment([], 10)).toEqual([]);
  });

  it('samples older messages at specified ratio', () => {
    const f = new RecencyFragmenter({ recentKeepCount: 3, olderKeepRatio: 0.5 });
    const messages = msgs(13); // 10 older + 3 recent
    const result = f.fragment(messages, 100);
    // recent: 3, older: floor(10 * 0.5) = 5
    expect(result.length).toBe(8);
  });

  it('preserves chronological order (older before recent)', () => {
    const f = new RecencyFragmenter({ recentKeepCount: 3, olderKeepRatio: 0.5 });
    const messages = msgs(10);
    const result = f.fragment(messages, 100);
    // recent messages should be at the end
    const last3 = messages.slice(-3).map(m => m.content);
    const resultTail = result.slice(-3).map(m => m.content);
    expect(resultTail).toEqual(last3);
  });
});
