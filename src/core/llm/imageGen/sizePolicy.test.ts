import { describe, it, expect } from 'vitest';
import { isSeedream5ProOrFlash, normalizeSeedreamSize, normalizeOpenAiSize } from './sizePolicy';

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

describe('normalizeSeedreamSize for Seedream 5.0 pro/flash', () => {
  const PRO = 'doubao-seedream-5-0-pro-260628';
  const FLASH = 'doubao-seedream-5-0-flash-260628';
  const MIN = 921_600;
  const MAX = 4_624_220;

  function expectLegal(size: string) {
    const [w, h] = size.split('x').map(Number);
    expect(w * h).toBeGreaterThanOrEqual(MIN);
    expect(w * h).toBeLessThanOrEqual(MAX);
    expect(w).toBeLessThanOrEqual(16 * h);
    expect(h).toBeLessThanOrEqual(16 * w);
    expect(w % 8).toBe(0);
    expect(h % 8).toBe(0);
    return [w, h];
  }

  it.each([PRO, FLASH, 'DOUBAO-SEEDREAM-5-0-PRO-260628', 'ep/doubao-seedream-5-0-flash'])('recognises %s', (model) => {
    expect(isSeedream5ProOrFlash(model)).toBe(true);
  });

  it.each(['doubao-seedream-5-0-260128', 'doubao-seedream-5-0-lite-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0', '', undefined])(
    'does not treat %s as pro/flash',
    (model) => {
      expect(isSeedream5ProOrFlash(model)).toBe(false);
    },
  );

  it.each([['1K', '1K'], ['1.5K', '1.5K'], ['2K', '2K'], ['2k', '2K'], [' 1.5k ', '1.5K']])('passes the tier %s through as %s', (size, expected) => {
    expect(normalizeSeedreamSize(size, PRO)).toBe(expected);
    expect(normalizeSeedreamSize(size, FLASH)).toBe(expected);
  });

  it('leaves a token that is neither a tier nor WxH to the API', () => {
    expect(normalizeSeedreamSize('auto', PRO)).toBe('auto');
  });

  it('keeps a size that is already inside the range, even below the older 3,686,400px floor', () => {
    // Other Seedream models would scale this up to 1920x1920.
    expect(normalizeSeedreamSize('1024x1024', PRO)).toBe('1024x1024');
    expect(normalizeSeedreamSize('2048x2048', PRO)).toBe('2048x2048');
    expect(normalizeSeedreamSize('1280x720', FLASH)).toBe('1280x720');
    // The range edges themselves are legal.
    expect(normalizeSeedreamSize('960x960', PRO)).toBe('960x960');
  });

  it('scales a too-small size up into the range, keeping the aspect', () => {
    expect(normalizeSeedreamSize('512x512', PRO)).toBe('960x960'); // exactly 921,600px
    const [w, h] = expectLegal(normalizeSeedreamSize('640x360', PRO));
    expect(w / h).toBeCloseTo(16 / 9, 1);
  });

  it('scales a too-large size down into the range, keeping the aspect', () => {
    expect(normalizeSeedreamSize('4096x4096', PRO)).toBe('2144x2144'); // stays square
    const [w, h] = expectLegal(normalizeSeedreamSize('3840x2160', FLASH));
    expect(w / h).toBeCloseTo(16 / 9, 1);
    const [pw, ph] = expectLegal(normalizeSeedreamSize('2160x3840', FLASH));
    expect(pw / ph).toBeCloseTo(9 / 16, 1);
  });

  it('pulls an aspect beyond 16:1 back to the nearest legal ratio', () => {
    const [w, h] = expectLegal(normalizeSeedreamSize('8000x200', PRO));
    expect(w / h).toBeCloseTo(16, 0);
    const [tw, th] = expectLegal(normalizeSeedreamSize('100x4000', PRO));
    expect(th / tw).toBeCloseTo(16, 0);
  });

  it('finds a legal size on the 8px grid at the extreme corners, where plain floor/ceil has none', () => {
    // 16:1 at the pixel ceiling: floor8 breaks the aspect, ceil8 breaks the pixel cap.
    expectLegal(normalizeSeedreamSize('9000x562', PRO));
    expectLegal(normalizeSeedreamSize('562x9000', PRO));
    expectLegal(normalizeSeedreamSize('12000x750', PRO));
  });

  it('always lands in the range, on the grid, for a spread of requests', () => {
    const sides = [1, 7, 64, 100, 333, 512, 777, 960, 1000, 1500, 2047, 2500, 3000, 4096, 6000, 10000];
    for (const w of sides) {
      for (const h of sides) {
        const requested = `${w}x${h}`;
        const out = normalizeSeedreamSize(requested, PRO);
        // A request that was legal comes back untouched; anything else is fitted.
        if (out !== requested) expectLegal(out);
      }
    }
  });

  it('falls back to a safe square for degenerate input', () => {
    expect(normalizeSeedreamSize('0x0', PRO)).toBe('2048x2048');
    expect(normalizeSeedreamSize('0x500', PRO)).toBe('2048x2048');
  });

  it('leaves every other Seedream model on the 3,686,400px floor', () => {
    for (const model of ['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828', undefined]) {
      expect(normalizeSeedreamSize('1024x1024', model)).toBe('1920x1920');
      expect(normalizeSeedreamSize('2K', model)).toBe('2K');
    }
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
