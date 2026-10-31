import { describe, expect, it } from 'vitest';
import { parseMessage } from './index.ts';

describe('parseMessage', () => {
  it('returns plain text unchanged', () => {
    expect(parseMessage('  buy milk ')).toEqual({ text: 'buy milk', tags: [], urls: [], list: null });
  });

  it('extracts hashtags, lower-cases them and strips them from the text', () => {
    const result = parseMessage('call mom #Family and #errands today #family');
    expect(result.tags).toEqual(['family', 'errands']);
    expect(result.text).toBe('call mom and today');
  });

  it('allows empty text after stripping', () => {
    expect(parseMessage('#idea')).toEqual({ text: '', tags: ['idea'], urls: [], list: null });
  });

  it('supports unicode tags', () => {
    const result = parseMessage('idée #café #日本語 #привет');
    expect(result.tags).toEqual(['café', '日本語', 'привет']);
    expect(result.text).toBe('idée');
  });

  it('ignores # inside words and a lone #', () => {
    const result = parseMessage('issue C#5 and # alone a#b');
    expect(result.tags).toEqual([]);
    expect(result.text).toBe('issue C#5 and # alone a#b');
  });

  it('recognizes URLs and trims trailing punctuation', () => {
    const result = parseMessage('see https://example.com/a?b=1, and http://x.org.');
    expect(result.urls).toEqual(['https://example.com/a?b=1', 'http://x.org']);
  });

  it('does not treat # inside a URL as a tag', () => {
    const result = parseMessage('read https://example.com/page#section #web');
    expect(result.urls).toEqual(['https://example.com/page#section']);
    expect(result.tags).toEqual(['web']);
    expect(result.text).toBe('read https://example.com/page#section');
  });

  it('parses a list command', () => {
    const result = parseMessage('list groceries: milk, eggs');
    expect(result.list).toEqual({ name: 'groceries', items: ['milk', 'eggs'] });
  });

  it('parses list commands case-insensitively with newline-separated items', () => {
    const result = parseMessage('List Todo:\nwash car\nbuy stamps, call bob\n');
    expect(result.list).toEqual({ name: 'Todo', items: ['wash car', 'buy stamps', 'call bob'] });
  });

  it('extracts tags from a list command without putting them in items', () => {
    const result = parseMessage('list groceries: milk, eggs #shopping');
    expect(result.tags).toEqual(['shopping']);
    expect(result.list?.items).toEqual(['milk', 'eggs']);
  });

  it('keeps messages that merely mention a list as notes', () => {
    expect(parseMessage('my list groceries: milk').list).toBeNull();
    expect(parseMessage('I should make a list: milk, eggs').list).toBeNull();
    expect(parseMessage('list groceries').list).toBeNull();
    expect(parseMessage('list groceries:').list).toBeNull();
  });
});
