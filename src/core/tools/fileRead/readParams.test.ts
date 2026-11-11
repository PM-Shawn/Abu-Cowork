import { describe, it, expect } from 'vitest';
import {
  cutToJsonBytes,
  describeView,
  formatPageList,
  pagesArgument,
  parseDocumentReadParams,
  parsePages,
  parseRegion,
  parseRotation,
  singlePage,
} from './readParams';

describe('parsePages', () => {
  it('reads single pages, ranges and open ranges, and a bare number', () => {
    expect(parsePages('3-5, 9，12-')).toEqual([[3, 5], [9, 9], [12, null]]);
    expect(parsePages('18')).toEqual([[18, 18]]);
    expect(parsePages(4)).toEqual([[4, 4]]);
    expect(parsePages(undefined)).toBeNull();
    expect(parsePages('')).toBeNull();
  });

  it('refuses what it cannot read', () => {
    expect(parsePages('7-3')).toHaveProperty('error');
    expect(parsePages('0')).toHaveProperty('error');
    expect(parsePages('all')).toHaveProperty('error');
    expect(parsePages(2.5)).toHaveProperty('error');
    expect(parsePages(',')).toHaveProperty('error');
  });
});

describe('parseRegion', () => {
  it('takes an object, an array or JSON text, with numbers as strings', () => {
    expect(parseRegion({ x0: 0.5, y0: 0.6, x1: 1, y1: 1 })).toEqual([0.5, 0.6, 1, 1]);
    expect(parseRegion([0, 0, 0.5, 0.5])).toEqual([0, 0, 0.5, 0.5]);
    expect(parseRegion('{"x0":"0.1","y0":0.2,"x1":0.3,"y1":0.4}')).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(parseRegion(undefined)).toBeNull();
  });

  it('refuses pixels, missing corners, an empty box and garbage', () => {
    expect(parseRegion({ x0: 0, y0: 0, x1: 800, y1: 600 })).toEqual({ error: expect.stringMatching(/fractions between 0 and 1/) });
    expect(parseRegion({ x0: 0, y0: 0, x1: 0.5 })).toHaveProperty('error');
    expect(parseRegion({ x0: 0.5, y0: 0, x1: 0.5, y1: 1 })).toEqual({ error: expect.stringMatching(/empty/) });
    expect(parseRegion('lower right')).toHaveProperty('error');
    expect(parseRegion(7)).toHaveProperty('error');
  });
});

describe('parseRotation', () => {
  it('takes quarter turns clockwise, -90 as 270', () => {
    expect(parseRotation(90)).toBe(90);
    expect(parseRotation('180')).toBe(180);
    expect(parseRotation(-90)).toBe(270);
    expect(parseRotation(undefined)).toBe(0);
    expect(parseRotation(45)).toHaveProperty('error');
  });
});

describe('parseDocumentReadParams', () => {
  it('collects every parameter, or the first one that cannot be used', () => {
    expect(parseDocumentReadParams({ path: '/a.pdf', pages: '18', region: [0, 0, 0.5, 0.5], rotate: 90 }))
      .toEqual({ pages: [[18, 18]], region: [0, 0, 0.5, 0.5], rotate: 90, imageIndex: null });
    expect(parseDocumentReadParams({ path: '/a.docx', image_index: '3' })).toMatchObject({ imageIndex: 3 });
    expect(parseDocumentReadParams({ path: '/a.docx', image_index: 0 })).toEqual({ error: expect.stringMatching(/image_index/) });
    expect(parseDocumentReadParams({ path: '/a.pdf', pages: 'x', rotate: 45 })).toEqual({ error: expect.stringMatching(/^pages/) });
  });
});

describe('page lists', () => {
  it('folds runs into ranges and builds a pages argument', () => {
    expect(formatPageList([1, 2, 3, 5, 9, 10, 2])).toBe('1–3, 5, 9–10');
    expect(pagesArgument([7, 8, 9])).toBe('7-9');
    expect(pagesArgument([18])).toBe('18');
    expect(singlePage([[18, 18]])).toBe(18);
    expect(singlePage([[3, 5]])).toBeNull();
    expect(singlePage(null)).toBeNull();
  });

  it('describes a view', () => {
    expect(describeView([0, 0, 1, 1], 0, 'whole page')).toBe('whole page');
    expect(describeView([0.25, 0.2, 0.9, 0.5], 90, 'whole page')).toBe('turned 90° clockwise, region x 0.25–0.9, y 0.2–0.5');
    expect(describeView([0, 0, 1, 1], 270, 'whole page')).toBe('turned 270° clockwise, whole page');
  });

  it('asks for exactly the pages of the list: pages apart stay apart, so a call never asks for more than the cap', () => {
    expect(pagesArgument([3, 7, 9])).toBe('3,7,9');
    expect(pagesArgument([1, 2, 3, 5])).toBe('1-3,5');
    expect(pagesArgument([5, 3, 4])).toBe('3-5');
    expect(pagesArgument([])).toBe('');
  });
});

describe('read_file errors about the user\'s file', () => {
  it('state the fact and what makes the file readable, in both locales, without telling the model to ask', async () => {
    const [{ default: enUS }, { default: zhCN }] = await Promise.all([import('@/i18n/locales/en-US'), import('@/i18n/locales/zh-CN')]);
    const en = Object.values(enUS.toolResult.fileRead);
    const zh = Object.values(zhCN.toolResult.fileRead);
    expect(Object.keys(zhCN.toolResult.fileRead)).toEqual(Object.keys(enUS.toolResult.fileRead));
    for (const text of en) expect(text).not.toMatch(/\bask\b/i);
    for (const text of zh) expect(text).not.toMatch(/向用户|请用户|问用户/);
    // The same placeholders in both, so they say the same thing.
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    en.forEach((text, i) => expect(placeholders(zh[i])).toEqual(placeholders(text)));
  });
});

describe('cutToJsonBytes', () => {
  const jsonBytes = (text: string) => new TextEncoder().encode(JSON.stringify(text)).length - 2;

  it('counts a string the way JSON writes it', () => {
    expect(cutToJsonBytes('abc', 3)).toEqual({ text: 'abc', cut: false });
    expect(cutToJsonBytes('a"b', 3)).toEqual({ text: 'a"', cut: true });
    expect(cutToJsonBytes('a"b', 2)).toEqual({ text: 'a', cut: true });
    expect(cutToJsonBytes('a\nb\\c', 100)).toEqual({ text: 'a\nb\\c', cut: false });
  });

  it.each([
    ['quotes and line breaks', '{"a":"b"}\n'.repeat(500)],
    ['Chinese', '合同'.repeat(500)],
    ['astral characters', '📄a'.repeat(500)],
    ['control characters and tabs', '\u0001\t\\'.repeat(500)],
    ['a lone surrogate', 'x\ud800y'.repeat(500)],
  ])('never exceeds the budget and cuts between characters: %s', (_label, text) => {
    for (const max of [0, 1, 5, 7, 100, 999]) {
      const cut = cutToJsonBytes(text, max);
      expect(jsonBytes(cut.text)).toBeLessThanOrEqual(max);
      expect(cut.cut).toBe(cut.text.length < text.length);
    }
  });
});
