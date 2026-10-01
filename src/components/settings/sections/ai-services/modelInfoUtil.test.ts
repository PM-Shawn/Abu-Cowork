import { describe, it, expect } from 'vitest';
import { toModelInfo, withContextWindows } from './modelInfoUtil';

describe('toModelInfo', () => {
  it('attaches derived UI capability tags (vision for gpt-4o)', () => {
    const m = toModelInfo('gpt-4o');
    expect(m.id).toBe('gpt-4o');
    expect(m.label).toBe('gpt-4o');
    expect(Array.isArray(m.capabilities)).toBe(true);
    expect(m.capabilities).toContain('vision');
  });
  it('uses provided label and marks custom', () => {
    const m = toModelInfo('my-proxy-model', { label: 'My Model', isCustom: true });
    expect(m.label).toBe('My Model');
    expect(m.isCustom).toBe(true);
    expect(Array.isArray(m.capabilities)).toBe(true);
  });
  it('omits isCustom when not requested', () => {
    const m = toModelInfo('deepseek-chat');
    expect(m.isCustom).toBeUndefined();
  });
  it('attaches declaredCapabilities when provided, omits when not', () => {
    const withCaps = toModelInfo('m', { declaredCapabilities: { supportsImages: true } });
    expect(withCaps.declaredCapabilities?.supportsImages).toBe(true);
    const withoutCaps = toModelInfo('m');
    expect(withoutCaps.declaredCapabilities).toBeUndefined();
  });
});

describe('withContextWindows', () => {
  it('attaches the reported window to matching models and leaves the rest untouched', () => {
    const models = [{ id: 'a', label: 'a' }, { id: 'b', label: 'b', contextWindow: 4096 }];
    expect(withContextWindows(models, new Map([['a', 8192]]))).toEqual([
      { id: 'a', label: 'a', contextWindow: 8192 },
      { id: 'b', label: 'b', contextWindow: 4096 },
    ]);
  });

  it('toModelInfo carries a detected window', () => {
    expect(toModelInfo('m', { contextWindow: 8192 }).contextWindow).toBe(8192);
  });
});
