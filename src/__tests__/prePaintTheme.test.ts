// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The blocking script in index.html decides light or dark before the first paint, from the
// stored settings alone. It has to agree with what the settings store will hold once it has
// loaded (its default and its migration), or the window paints one appearance and turns.
const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const script = new DOMParser().parseFromString(html, 'text/html').querySelector('head script:not([src])');
if (!script?.textContent) throw new Error('index.html has no inline script in its head');
const prePaint = new Function(script.textContent);

function firstPaintIsDark(stored: unknown, system: 'light' | 'dark'): boolean {
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem('abu-settings', typeof stored === 'string' ? stored : JSON.stringify(stored));
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && system === 'dark' }));
  document.documentElement.classList.remove('dark');
  prePaint();
  return document.documentElement.classList.contains('dark');
}

describe('the first paint of index.html', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it.each([
    ['dark', true],
    ['light', false],
  ] as const)('with nothing stored and a %s system: dark is %s', (system, dark) => {
    expect(firstPaintIsDark(undefined, system)).toBe(dark);
  });

  it.each([
    ['light', 'dark', false], ['light', 'light', false],
    ['dark', 'dark', true], ['dark', 'light', true],
    ['system', 'dark', true], ['system', 'light', false],
  ] as const)('with %s stored at version 54 and a %s system: dark is %s', (theme, system, dark) => {
    expect(firstPaintIsDark({ version: 54, state: { theme } }, system)).toBe(dark);
  });

  // The store's v54 step turns every earlier store to follow-the-system when it loads; the first
  // paint has to show that result, not the value still in storage.
  it.each([53, 42, 41, 0])('settings stored at version %i follow the system whatever they hold', (version) => {
    for (const theme of ['light', 'dark', 'system']) {
      expect(firstPaintIsDark({ version, state: { theme } }, 'dark')).toBe(true);
      expect(firstPaintIsDark({ version, state: { theme } }, 'light')).toBe(false);
    }
  });

  it('keeps the stored choice of a later version', () => {
    expect(firstPaintIsDark({ version: 55, state: { theme: 'light' } }, 'dark')).toBe(false);
    expect(firstPaintIsDark({ version: 55, state: { theme: 'dark' } }, 'light')).toBe(true);
  });

  it('keeps the stored choice of settings without a version number, which the store does not migrate', () => {
    expect(firstPaintIsDark({ state: { theme: 'light' } }, 'dark')).toBe(false);
    expect(firstPaintIsDark({ state: { theme: 'dark' } }, 'light')).toBe(true);
  });

  it('follows the system for settings that cannot be read, as the store falls back to its default', () => {
    expect(firstPaintIsDark('{not json', 'dark')).toBe(true);
    expect(firstPaintIsDark('{not json', 'light')).toBe(false);
  });

  it('keeps the parsed settings for the language script', () => {
    firstPaintIsDark({ version: 54, state: { theme: 'light', language: 'zh-CN' } }, 'light');
    expect((window as unknown as { __abuSettings: { state: { language: string } } }).__abuSettings.state.language).toBe('zh-CN');
  });
});
