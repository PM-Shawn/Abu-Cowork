import { describe, expect, it } from 'vitest';
import { findAgentMentionTarget, parseLeadingAgentCommand, resolveAgentMentionReplacementRange } from './composerAgentMention';

describe('composerAgentMention', () => {
  describe('findAgentMentionTarget', () => {
    it.each([
      ['line start', '@pub', 4, 0],
      ['after whitespace', 'draft @pub', 10, 6],
      ['after punctuation', 'draft,@pub', 10, 6],
      ['after CJK text', '帮我@pub', 6, 2],
    ])('accepts an inline @mention %s', (_label, text, caret, start) => {
      expect(findAgentMentionTarget(text, caret, caret)).toMatchObject({
        source: 'inline',
        range: { start, end: text.length },
        caret,
        query: 'pub',
      });
    });

    it('replaces the full active token rather than stopping at the caret', () => {
      expect(findAgentMentionTarget('draft @publisher body', 10, 10)).toMatchObject({
        source: 'inline',
        range: { start: 6, end: 16 },
        caret: 10,
        query: 'pub',
      });
    });

    it.each([
      'hello@publisher',
      'hello@publisher.com',
      'prefix@@publisher',
    ])('rejects ASCII local-part adjacency and double @ tokens: %s', (text) => {
      expect(findAgentMentionTarget(text, text.length, text.length)).toBeNull();
    });

    it('rejects an address with a Unicode local part', () => {
      expect(findAgentMentionTarget('用户@publisher.com', '用户@publisher.com'.length, '用户@publisher.com'.length)).toBeNull();
    });

    it.each([
      ['CJK prose with punctuation', '请 @pub，润色', '请 '.length + '@pub'.length],
      ['English prose with punctuation', 'before @publisher，after', 'before '.length + '@pub'.length],
    ])('keeps punctuation and prose outside the active mention for %s', (_label, text, caret) => {
      expect(findAgentMentionTarget(text, caret, caret)).toMatchObject({
        range: { start: text.indexOf('@'), end: text.indexOf('，') },
        query: 'pub',
      });
    });

    it('requires a collapsed selection', () => {
      expect(findAgentMentionTarget('@publisher', 1, 4)).toBeNull();
    });

    it('includes a scoped key with source, range, caret, and query', () => {
      expect(findAgentMentionTarget('draft @pub', 10, 10)?.key).toBe('inline:6-10:10:pub');
    });
  });

  describe('parseLeadingAgentCommand', () => {
    it('returns only the leading command token and leaves the body outside the range', () => {
      expect(parseLeadingAgentCommand('@pub write this')).toMatchObject({
        source: 'leading-command',
        range: { start: 0, end: 4 },
        caret: 4,
        query: 'pub',
        body: 'write this',
        key: 'leading-command:0-4:4:pub',
      });
    });

    it('does not treat inline email-like text as a leading command fallback', () => {
      expect(parseLeadingAgentCommand('hello@publisher')).toBeNull();
    });
  });

  describe('resolveAgentMentionReplacementRange', () => {
    it('removes only the typed inline query when CJK prose follows the caret', () => {
      const text = '请@pub润色';
      const caret = '请@pub'.length;
      const target = findAgentMentionTarget(text, caret, caret);

      expect(target).not.toBeNull();
      expect(resolveAgentMentionReplacementRange(target!, 'publisher', text)).toEqual({
        start: '请'.length,
        end: '请@pub'.length,
      });
    });

    it('removes the full candidate token when the composer already contains the full agent name', () => {
      const text = '@publisher';
      const caret = '@pub'.length;
      const target = findAgentMentionTarget(text, caret, caret);

      expect(target).not.toBeNull();
      expect(resolveAgentMentionReplacementRange(target!, 'publisher', text)).toEqual({
        start: 0,
        end: '@publisher'.length,
      });
    });
  });
});
