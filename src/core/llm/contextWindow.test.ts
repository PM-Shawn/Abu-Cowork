import { describe, it, expect } from 'vitest';
import { estimateContextWindow, formatContextLength, LOCAL_ESTIMATE_CAP, positiveInteger, resolveContextWindow } from './contextWindow';

describe('positiveInteger', () => {
  it('keeps positive safe integers only', () => {
    expect(positiveInteger(8192)).toBe(8192);
    expect(positiveInteger(0)).toBeUndefined();
    expect(positiveInteger(-1)).toBeUndefined();
    expect(positiveInteger(1.5)).toBeUndefined();
    expect(positiveInteger('8192')).toBeUndefined();
    expect(positiveInteger(undefined)).toBeUndefined();
  });
});

describe('estimateContextWindow', () => {
  it('uses the name-based value for a cloud provider', () => {
    expect(estimateContextWindow('qwen3-8b', false)).toBe(131072);
  });

  it('caps a local server at 32768 however large the name-based value is', () => {
    expect(LOCAL_ESTIMATE_CAP).toBe(32768);
    expect(estimateContextWindow('qwen3-8b', true)).toBe(32768);
    expect(estimateContextWindow('totally-unknown-local-model', true)).toBe(32768);
  });
});

describe('resolveContextWindow', () => {
  const base = { modelId: 'qwen3-8b', isLocal: true, ceiling: 200000 };

  it('level 1: the value the user typed wins, even above the ceiling', () => {
    expect(resolveContextWindow({ ...base, userSetting: 300000, probed: 8192, discovered: 4096 }))
      .toEqual({ size: 300000, source: 'user' });
  });

  it('level 2: the value the service reported', () => {
    expect(resolveContextWindow({ ...base, probed: 8192 })).toEqual({ size: 8192, source: 'service' });
  });

  it('level 3: the value learned from an overflow error', () => {
    expect(resolveContextWindow({ ...base, discovered: 6000 })).toEqual({ size: 6000, source: 'service' });
  });

  it('levels 2 and 3 together: the smaller one', () => {
    expect(resolveContextWindow({ ...base, probed: 8192, discovered: 2048 })).toEqual({ size: 2048, source: 'service' });
    expect(resolveContextWindow({ ...base, probed: 4096, discovered: 8192 })).toEqual({ size: 4096, source: 'service' });
  });

  it('a learned value still holds while the service reports what it reported when it was learned', () => {
    expect(resolveContextWindow({ ...base, probed: 32768, discovered: 8192, discoveredProbe: 32768 }))
      .toEqual({ size: 8192, source: 'service' });
  });

  it('a learned value is dropped once the service reports a different length (the user changed it there)', () => {
    expect(resolveContextWindow({ ...base, probed: 65536, discovered: 8192, discoveredProbe: 8192 }))
      .toEqual({ size: 65536, source: 'service' });
  });

  it('level 4: the name-based estimate, capped for local servers', () => {
    expect(resolveContextWindow(base)).toEqual({ size: 32768, source: 'estimate' });
    expect(resolveContextWindow({ ...base, isLocal: false })).toEqual({ size: 131072, source: 'estimate' });
  });

  it('the global ceiling bounds levels 2 to 4', () => {
    expect(resolveContextWindow({ modelId: 'claude-opus-4-6', isLocal: false, ceiling: 100000 }).size).toBe(100000);
    expect(resolveContextWindow({ ...base, probed: 262144, ceiling: 200000 }).size).toBe(200000);
  });

  it('ignores empty and invalid candidates', () => {
    expect(resolveContextWindow({ ...base, userSetting: 0, probed: -5, discovered: Number.NaN }))
      .toEqual({ size: 32768, source: 'estimate' });
  });
});

describe('formatContextLength', () => {
  it('prints lengths the way local model apps do', () => {
    expect(formatContextLength(8192)).toBe('8K');
    expect(formatContextLength(16384)).toBe('16K');
    expect(formatContextLength(32768)).toBe('32K');
    expect(formatContextLength(131072)).toBe('128K');
    expect(formatContextLength(128000)).toBe('128K');
  });
});
