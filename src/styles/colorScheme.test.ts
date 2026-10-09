// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { followSystemColorScheme } from './colorScheme';

/** A media query list whose answer the test changes; it counts who listens. */
function fakeColorScheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: dark,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  };
  const asked: string[] = [];
  vi.stubGlobal('matchMedia', (query: string) => { asked.push(query); return list; });
  return {
    asked,
    listening: () => listeners.size,
    turn: (next: boolean) => { list.matches = next; for (const listener of [...listeners]) listener(); },
  };
}

describe('followSystemColorScheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
  });

  it('sets the dark class at once when the color scheme is dark', () => {
    const scheme = fakeColorScheme(true);
    followSystemColorScheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(scheme.asked).toEqual(['(prefers-color-scheme: dark)']);
  });

  it('removes a dark class that is there when the color scheme is light', () => {
    fakeColorScheme(false);
    document.documentElement.classList.add('dark');
    followSystemColorScheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('follows every change, in both directions', () => {
    const scheme = fakeColorScheme(false);
    followSystemColorScheme();
    scheme.turn(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    scheme.turn(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('stops listening when told to, and leaves the class as it is', () => {
    const scheme = fakeColorScheme(true);
    const stop = followSystemColorScheme();
    expect(scheme.listening()).toBe(1);
    stop();
    expect(scheme.listening()).toBe(0);
    scheme.turn(false);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('writes the class on the element it is given', () => {
    fakeColorScheme(true);
    const root = document.createElement('div');
    followSystemColorScheme(root);
    expect(root.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
