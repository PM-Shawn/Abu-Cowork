import { describe, it, expect } from 'vitest';
import { renderMarkedText, highlightQuery, MARK_OPEN, MARK_CLOSE } from './searchHighlight';

describe('searchHighlight', () => {
  describe('renderMarkedText', () => {
    it('returns plain text unchanged when there are no sentinel delimiters', () => {
      const nodes = renderMarkedText('hello world', 'hl');
      expect(nodes).toEqual(['hello world']);
    });

    it('splits marked segments into <mark> elements', () => {
      const nodes = renderMarkedText(`foo ${MARK_OPEN}bar${MARK_CLOSE} baz`, 'hl');
      // ['foo ', <mark>bar</mark>, ' baz']
      expect(nodes).toHaveLength(3);
      expect(nodes[0]).toBe('foo ');
      expect(nodes[2]).toBe(' baz');
      // The marked node is a React element, not a plain string.
      expect(typeof nodes[1]).toBe('object');
    });

    it('handles multiple marked segments', () => {
      const nodes = renderMarkedText(`${MARK_OPEN}a${MARK_CLOSE}-${MARK_OPEN}b${MARK_CLOSE}`, 'hl');
      expect(nodes).toHaveLength(3);
      expect(nodes[1]).toBe('-');
    });

    it('returns empty array for empty input', () => {
      expect(renderMarkedText('', 'hl')).toEqual([]);
    });

    it('treats stray < and > in content as plain text, never as markup', () => {
      const nodes = renderMarkedText('1 < 2 && 3 > 1 <script>evil</script>', 'hl');
      // No sentinel delimiters present, so the whole string must survive
      // as a single plain-text node — including the literal "<script>" text.
      expect(nodes).toEqual(['1 < 2 && 3 > 1 <script>evil</script>']);
    });

    it('treats a literal "<mark>" in content as plain text, not a delimiter', () => {
      // A title/snippet whose content literally contains the text "<mark>"
      // (e.g. a user pasted HTML) must render that text verbatim — only the
      // STX/ETX sentinels are delimiters now, never the literal tag text.
      const nodes = renderMarkedText(`see ${MARK_OPEN}<mark>${MARK_CLOSE} tag`, 'hl');
      expect(nodes).toHaveLength(3);
      expect(nodes[0]).toBe('see ');
      expect(nodes[2]).toBe(' tag');
      expect(typeof nodes[1]).toBe('object');
    });
  });

  describe('highlightQuery', () => {
    it('wraps case-insensitive matches of the query', () => {
      const nodes = highlightQuery('Hello World', 'world', 'hl');
      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toBe('Hello ');
      expect(typeof nodes[1]).toBe('object');
    });

    it('returns the original text as-is when query is empty/whitespace', () => {
      expect(highlightQuery('Hello', '   ', 'hl')).toEqual(['Hello']);
    });

    it('escapes regex metacharacters in the query', () => {
      const nodes = highlightQuery('a.b.c', '.', 'hl');
      // '.' should only match literal '.' characters, not "any character".
      expect(nodes).toHaveLength(5);
      expect(nodes[0]).toBe('a');
      expect(nodes[2]).toBe('b');
      expect(nodes[4]).toBe('c');
    });

    it('does not let content-embedded angle brackets become markup', () => {
      const nodes = highlightQuery('<b>foo</b> bar', 'bar', 'hl');
      // The literal "<b>foo</b> " text must be preserved verbatim as text.
      expect(nodes[0]).toBe('<b>foo</b> ');
    });

    it('highlights the correct query term when the title also contains a literal "<mark>"', () => {
      // Reproduces the delimiter-collision bug: a title containing the exact
      // literal text "<mark>" must not be misparsed — the query match should
      // still be the only thing wrapped in a <mark> element, and the literal
      // "<mark>" text should survive verbatim as plain text (not consumed as
      // a delimiter).
      const nodes = highlightQuery('fix the <mark> tag rendering bug', 'tag', 'hl');
      expect(nodes).toHaveLength(3);
      expect(nodes[0]).toBe('fix the <mark> ');
      expect(typeof nodes[1]).toBe('object');
      expect(nodes[2]).toBe(' rendering bug');
    });
  });
});
