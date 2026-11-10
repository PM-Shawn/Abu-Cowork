import { describe, it, expect } from 'vitest';
import {
  formatPageList,
  pagesArgument,
  parseDocumentReadParams,
  parsePages,
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

describe('parseDocumentReadParams', () => {
  it('collects every parameter, or the first one that cannot be used', () => {
    expect(parseDocumentReadParams({ path: '/a.pdf', pages: '18' })).toEqual({ pages: [[18, 18]] });
    expect(parseDocumentReadParams({ path: '/a.pdf', pages: 'x' })).toEqual({ error: expect.stringMatching(/^pages/) });
  });
});

describe('page lists', () => {
  it('folds runs into ranges and builds a pages argument', () => {
    expect(formatPageList([1, 2, 3, 5, 9, 10, 2])).toBe('1–3, 5, 9–10');
    expect(pagesArgument([7, 8, 9])).toBe('7-9');
    expect(pagesArgument([18])).toBe('18');
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
