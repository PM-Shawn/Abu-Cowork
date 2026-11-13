import { describe, it, expect } from 'vitest';
import { admissionMaxDimension, admissionMaxImageBytes } from './imagePolicy';
import { admissionRawBytes, planImageFit } from './imageFit';

const L = admissionMaxDimension();
const RAW = admissionRawBytes();

describe('admissionRawBytes', () => {
  it('is the raw size whose base64 form fits the strictest per-picture byte ceiling', () => {
    expect(Math.ceil(RAW / 3) * 4).toBeLessThanOrEqual(admissionMaxImageBytes());
    expect(Math.ceil((RAW + 3) / 3) * 4).toBeGreaterThan(admissionMaxImageBytes());
  });
});

describe('planImageFit', () => {
  const plan = (width: number, height: number, byteLength: number, mediaType: string) =>
    planImageFit({ width, height, byteLength, mediaType });

  it('plans nothing for a picture inside both the pixel and the byte limit', () => {
    expect(plan(L, L, RAW, 'image/png')).toEqual([]);
    expect(plan(800, 600, 40_000, 'image/jpeg')).toEqual([]);
  });

  it('fits by the long side, wide or tall, keeping the picture format first', () => {
    expect(plan(10032, 4178, 1_700_000, 'image/png')[0]).toEqual({ width: L, format: 'same', quality: 85 });
    expect(plan(1000, 20000, 1_000_000, 'image/png')[0]).toEqual({ width: Math.floor(1000 * L / 20000), format: 'same', quality: 85 });
  });

  it('keeps a photo a JPEG: the first step is "same" and no step is PNG', () => {
    const steps = plan(4000, 3000, 900_000, 'image/jpeg');
    expect(steps[0]).toMatchObject({ width: L, format: 'same' });
    expect(steps.every((s) => s.format === 'same' || s.format === 'jpeg')).toBe(true);
  });

  it('plans for bytes alone: a 1900x1200 picture of 6 MB is inside the side limit but over the byte limit', () => {
    const steps = plan(1900, 1200, 6 * 1024 * 1024, 'image/png');
    expect(steps.length).toBeGreaterThan(0);
    // Re-encoding the same pixels as PNG cannot shrink a PNG, so the first try is already a JPEG at full size.
    expect(steps[0]).toMatchObject({ width: 1900, format: 'jpeg' });
  });

  it('falls back step by step: lossier, then smaller, never wider than the first step', () => {
    const steps = plan(4000, 3000, 5_000_000, 'image/png');
    expect(steps.length).toBeLessThanOrEqual(4);
    expect(steps.at(-1)!.format).toBe('jpeg');
    for (let i = 1; i < steps.length; i++) expect(steps[i].width).toBeLessThanOrEqual(steps[i - 1].width);
  });
});
