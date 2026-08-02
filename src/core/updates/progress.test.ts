import { describe, expect, it } from 'vitest';
import { getUpdateProgressPresentation } from './progress';

describe('getUpdateProgressPresentation', () => {
  it('keeps the pre-download connection phase indeterminate', () => {
    expect(getUpdateProgressPresentation({
      phase: 'preparing',
      downloaded: 0,
      total: 0,
    })).toEqual({
      indeterminate: true,
      percent: null,
      percentLabel: null,
    });
  });

  it('keeps downloads with an unknown total indeterminate', () => {
    expect(getUpdateProgressPresentation({
      phase: 'downloading',
      downloaded: 8 * 1024 * 1024,
      total: 0,
    })).toEqual({
      indeterminate: true,
      percent: null,
      percentLabel: null,
    });
  });

  it('shows one decimal place so a slow large download visibly advances', () => {
    const presentation = getUpdateProgressPresentation({
      phase: 'downloading',
      downloaded: 512 * 1024,
      total: 400 * 1024 * 1024,
    });

    expect(presentation.indeterminate).toBe(false);
    expect(presentation.percent).toBeCloseTo(0.125);
    expect(presentation.percentLabel).toBe('0.1');
  });

  it('uses an indeterminate activity state while the package is verified', () => {
    expect(getUpdateProgressPresentation({
      phase: 'verifying',
      downloaded: 400,
      total: 400,
    })).toEqual({
      indeterminate: true,
      percent: null,
      percentLabel: null,
    });
  });

  it('clamps over-reported byte counts to a complete percentage', () => {
    expect(getUpdateProgressPresentation({
      phase: 'downloading',
      downloaded: 450,
      total: 400,
    })).toMatchObject({ percent: 100, percentLabel: '100' });
  });
});
