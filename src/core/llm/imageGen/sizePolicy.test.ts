import { describe, it, expect } from 'vitest';
import { normalizeSeedreamSize, normalizeOpenAiSize } from './sizePolicy';

describe('normalizeSeedreamSize', () => {
  it('scales a too-small square up to the floor (preserving square aspect)', () => {
    // 1024x1024 (1,048,576px) → 1920x1920 = 3,686,400px exactly, still 1:1.
    expect(normalizeSeedreamSize('1024x1024')).toBe('1920x1920');
  });

  it('scales a too-small NON-square up preserving aspect ratio (not collapsed to a square)', () => {
    // 1280x720 (16:9, 921,600px) must stay 16:9, scaled to meet the floor —
    // 2560x1440 = 3,686,400px, still 16:9. Regression for the P3 audit finding
    // where sub-floor non-square requests silently became a square.
    const out = normalizeSeedreamSize('1280x720');
    expect(out).toBe('2560x1440');
    const [w, h] = out.split('x').map(Number);
    expect(w * h).toBeGreaterThanOrEqual(3_686_400);
    expect(w / h).toBeCloseTo(16 / 9, 2); // aspect preserved
  });

  it('passes through a size that already meets the floor', () => {
    expect(normalizeSeedreamSize('2048x2048')).toBe('2048x2048');
  });

  it('passes through a non-square size that meets the floor', () => {
    // 2560x1440 = 3,686,400px exactly — right at the floor, should not be remapped.
    expect(normalizeSeedreamSize('2560x1440')).toBe('2560x1440');
  });

  it('falls back to a safe square for degenerate input', () => {
    expect(normalizeSeedreamSize('0x0')).toBe('2048x2048');
  });

  it('passes through an unparseable token (e.g. a vendor size tier) unchanged', () => {
    expect(normalizeSeedreamSize('2K')).toBe('2K');
  });
});

describe('normalizeOpenAiSize', () => {
  describe('dall-e-3', () => {
    it('passes through an already-supported size', () => {
      expect(normalizeOpenAiSize('dall-e-3', '1024x1024')).toBe('1024x1024');
      expect(normalizeOpenAiSize('dall-e-3', '1792x1024')).toBe('1792x1024');
      expect(normalizeOpenAiSize('dall-e-3', '1024x1792')).toBe('1024x1792');
    });

    it('snaps an unsupported square size to 1024x1024', () => {
      expect(normalizeOpenAiSize('dall-e-3', '512x512')).toBe('1024x1024');
    });

    it('snaps an unsupported landscape size to 1792x1024', () => {
      expect(normalizeOpenAiSize('dall-e-3', '2048x1024')).toBe('1792x1024');
    });

    it('snaps an unsupported portrait size to 1024x1792', () => {
      expect(normalizeOpenAiSize('dall-e-3', '1024x2048')).toBe('1024x1792');
    });
  });

  describe('gpt-image-1', () => {
    it('passes through "auto" unchanged', () => {
      expect(normalizeOpenAiSize('gpt-image-1', 'auto')).toBe('auto');
    });

    it('passes through an already-supported size', () => {
      expect(normalizeOpenAiSize('gpt-image-1', '1536x1024')).toBe('1536x1024');
    });

    it('snaps an unsupported portrait size to 1024x1536', () => {
      expect(normalizeOpenAiSize('gpt-image-1', '900x1600')).toBe('1024x1536');
    });
  });

  it('passes an unrecognized model id through unchanged', () => {
    expect(normalizeOpenAiSize('some-future-openai-model', '333x777')).toBe('333x777');
  });
});
