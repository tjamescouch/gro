import { describe, it, expect } from 'vitest';
import { KeywordFragmenter } from '../src/memory/keyword-fragmenter.js';

const makeMsg = (content: string, role: 'user' | 'assistant' = 'user') => ({
  role,
  content,
});

describe('KeywordFragmenter', () => {
  it('keeps all messages containing keywords', () => {
    const fragmenter = new KeywordFragmenter({
      keywords: ['error', 'critical'],
      nonKeywordKeepRatio: 0.0,
    });

    const messages = [
      makeMsg('hello world'),
      makeMsg('critical error detected'),
      makeMsg('everything is fine'),
      makeMsg('another error occurred'),
      makeMsg('status ok'),
    ];

    const result = fragmenter.fragment(messages, 10);
    expect(result).toHaveLength(2);
    expect(result.every(m => typeof m.content === 'string' && (m.content.includes('critical') || m.content.includes('error')))).toBe(true);
  });

  it('samples non-keyword messages at specified ratio', () => {
    const fragmenter = new KeywordFragmenter({
      keywords: ['KEEP'],
      nonKeywordKeepRatio: 0.5,
    });

    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg(i % 3 === 0 ? `KEEP message ${i}` : `regular message ${i}`)
    );

    const result = fragmenter.fragment(messages, 100);
    const keywordMsgs = result.filter(m => typeof m.content === 'string' && m.content.includes('KEEP'));
    const regularMsgs = result.filter(m => typeof m.content === 'string' && !m.content.includes('KEEP'));

    // All keyword messages kept
    expect(keywordMsgs.length).toBe(messages.filter(m => typeof m.content === 'string' && (m.content as string).includes('KEEP')).length);
    // ~50% of non-keyword messages kept
    const nonKeywordTotal = messages.filter(m => typeof m.content === 'string' && !(m.content as string).includes('KEEP')).length;
    expect(regularMsgs.length).toBe(Math.floor(nonKeywordTotal * 0.5));
  });

  it('respects targetCount ceiling', () => {
    const fragmenter = new KeywordFragmenter({
      keywords: ['important'],
      nonKeywordKeepRatio: 1.0,
    });

    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMsg(i % 2 === 0 ? `important item ${i}` : `filler ${i}`)
    );

    const result = fragmenter.fragment(messages, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('handles empty messages array', () => {
    const fragmenter = new KeywordFragmenter({ keywords: ['test'] });
    expect(fragmenter.fragment([], 10)).toEqual([]);
  });

  it('handles array content blocks', () => {
    const fragmenter = new KeywordFragmenter({
      keywords: ['urgent'],
      nonKeywordKeepRatio: 0.0,
    });

    const messages = [
      { role: 'user' as const, content: [{ type: 'text', text: 'this is urgent please help' }] },
      { role: 'user' as const, content: [{ type: 'text', text: 'regular message' }] },
    ];

    const result = fragmenter.fragment(messages, 10);
    expect(result).toHaveLength(1);
  });
});
