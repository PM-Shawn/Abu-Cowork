import { describe, it, expect, beforeEach } from 'vitest';
import { highlightRegistry } from './highlightRegistry';

describe('highlightRegistry', () => {
  beforeEach(() => highlightRegistry.clear());

  it('does not throw when CSS.highlights is unavailable (no-op)', () => {
    document.body.innerHTML = '<p>abc</p>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p')!);
    expect(() => highlightRegistry.add('r1', range)).not.toThrow();
    expect(() => highlightRegistry.remove('r1')).not.toThrow();
    expect(() => highlightRegistry.clear()).not.toThrow();
  });

  it('tracks ids regardless of platform support', () => {
    const range = document.createRange();
    highlightRegistry.add('r1', range);
    highlightRegistry.add('r2', range);
    expect(highlightRegistry.size()).toBe(2);
    highlightRegistry.remove('r1');
    expect(highlightRegistry.size()).toBe(1);
    highlightRegistry.clear();
    expect(highlightRegistry.size()).toBe(0);
  });
});
