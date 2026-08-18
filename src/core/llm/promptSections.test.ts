import { describe, it, expect } from 'vitest';
import { mergeSections, sectionsToString, orderSectionsForCaching, type PromptSection } from './promptSections';

describe('promptSections', () => {
  describe('mergeSections', () => {
    it('returns empty array for empty input', () => {
      expect(mergeSections([])).toEqual([]);
    });

    it('merges adjacent sections with same cacheability', () => {
      const sections: PromptSection[] = [
        { name: 'a', text: 'hello', cacheable: true },
        { name: 'b', text: 'world', cacheable: true },
        { name: 'c', text: 'dynamic', cacheable: false },
      ];
      const merged = mergeSections(sections);
      expect(merged).toHaveLength(2);
      expect(merged[0].text).toBe('hello\n\nworld');
      expect(merged[0].cacheable).toBe(true);
      expect(merged[0].name).toBe('a+b');
      expect(merged[1].text).toBe('dynamic');
      expect(merged[1].cacheable).toBe(false);
    });

    it('preserves sections with alternating cacheability', () => {
      const sections: PromptSection[] = [
        { name: 'a', text: 'static1', cacheable: true },
        { name: 'b', text: 'dynamic1', cacheable: false },
        { name: 'c', text: 'static2', cacheable: true },
      ];
      const merged = mergeSections(sections);
      expect(merged).toHaveLength(3);
      expect(merged.map(s => s.cacheable)).toEqual([true, false, true]);
    });

    it('handles single section', () => {
      const sections: PromptSection[] = [
        { name: 'only', text: 'content', cacheable: true },
      ];
      const merged = mergeSections(sections);
      expect(merged).toHaveLength(1);
      expect(merged[0].text).toBe('content');
    });

    it('merges all volatile sections together', () => {
      const sections: PromptSection[] = [
        { name: 'a', text: '1', cacheable: false },
        { name: 'b', text: '2', cacheable: false },
        { name: 'c', text: '3', cacheable: false },
      ];
      const merged = mergeSections(sections);
      expect(merged).toHaveLength(1);
      expect(merged[0].text).toBe('1\n\n2\n\n3');
      expect(merged[0].cacheable).toBe(false);
    });
  });

  describe('orderSectionsForCaching', () => {
    it('moves volatile sections behind every cacheable section', () => {
      const sections: PromptSection[] = [
        { name: 'persona', text: 'p', cacheable: true },
        { name: 'current-time', text: 't', cacheable: false },
        { name: 'workspace', text: 'w', cacheable: true },
        { name: 'proposal-signal', text: 's', cacheable: false },
        { name: 'safety-anchor', text: 'a', cacheable: true },
      ];
      const ordered = orderSectionsForCaching(sections);
      const lastCacheableIdx = ordered.map(s => s.cacheable).lastIndexOf(true);
      const firstVolatileIdx = ordered.map(s => s.cacheable).indexOf(false);
      expect(firstVolatileIdx).toBeGreaterThan(lastCacheableIdx);
    });

    it('is a stable partition — relative order within each group is preserved', () => {
      const sections: PromptSection[] = [
        { name: 'c1', text: '1', cacheable: true },
        { name: 'v1', text: '2', cacheable: false },
        { name: 'c2', text: '3', cacheable: true },
        { name: 'v2', text: '4', cacheable: false },
      ];
      expect(orderSectionsForCaching(sections).map(s => s.name)).toEqual(['c1', 'c2', 'v1', 'v2']);
    });

    it('keeps the safety anchor as the last cacheable section (breakpoint carrier)', () => {
      const sections: PromptSection[] = [
        { name: 'persona', text: 'p', cacheable: true },
        { name: 'current-time', text: 't', cacheable: false },
        { name: 'safety-anchor', text: 'a', cacheable: true },
      ];
      const ordered = orderSectionsForCaching(sections);
      const cacheable = ordered.filter(s => s.cacheable);
      expect(cacheable[cacheable.length - 1].name).toBe('safety-anchor');
    });

    it('pins pinToEnd sections after the volatile tail, preserving their order', () => {
      const sections: PromptSection[] = [
        { name: 'persona', text: 'p', cacheable: true },
        { name: 'safety-anchor', text: 'a', cacheable: false, pinToEnd: true },
        { name: 'current-time', text: 't', cacheable: false },
        { name: 'workspace', text: 'w', cacheable: true },
      ];
      expect(orderSectionsForCaching(sections).map(s => s.name)).toEqual([
        'persona', 'workspace', 'current-time', 'safety-anchor',
      ]);
    });

    it('is idempotent — re-partitioning after appending a volatile section keeps the pin last', () => {
      const first = orderSectionsForCaching([
        { name: 'persona', text: 'p', cacheable: true },
        { name: 'safety-anchor', text: 'a', cacheable: false, pinToEnd: true },
      ]);
      const second = orderSectionsForCaching([
        ...first,
        { name: 'compression-hint', text: 'h', cacheable: false },
      ]);
      expect(second.map(s => s.name)).toEqual(['persona', 'compression-hint', 'safety-anchor']);
    });

    it('handles all-cacheable, all-volatile, and empty inputs unchanged', () => {
      const allCacheable: PromptSection[] = [
        { name: 'a', text: 'a', cacheable: true },
        { name: 'b', text: 'b', cacheable: true },
      ];
      const allVolatile: PromptSection[] = [
        { name: 'a', text: 'a', cacheable: false },
        { name: 'b', text: 'b', cacheable: false },
      ];
      expect(orderSectionsForCaching(allCacheable)).toEqual(allCacheable);
      expect(orderSectionsForCaching(allVolatile)).toEqual(allVolatile);
      expect(orderSectionsForCaching([])).toEqual([]);
    });
  });

  describe('sectionsToString', () => {
    it('joins all sections with double newline', () => {
      const sections: PromptSection[] = [
        { name: 'a', text: 'hello', cacheable: true },
        { name: 'b', text: 'world', cacheable: false },
      ];
      expect(sectionsToString(sections)).toBe('hello\n\nworld');
    });

    it('returns empty string for empty input', () => {
      expect(sectionsToString([])).toBe('');
    });
  });
});
