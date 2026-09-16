/**
 * The bounds Chrome silently enforces on a canvas.
 *
 * Past either bound nothing throws and nothing reports the failure: the canvas
 * still reports the width and height it was given, `getContext('2d')` still
 * returns a context, and `drawImage`/`fillRect` still run. Only the pixels are
 * gone (a read-back is transparent black) and `toDataURL()` answers the
 * six-character string `"data:,"`.
 *
 * That is why full-page capture needed this: the stitcher returned that string
 * as if it were a PNG, `stitchSlices` resolved successfully, and the bridge
 * handed `"data:,"` to the model as base64 image data — a tall page produced a
 * confident, successful, broken screenshot.
 *
 * The numbers are measured, not remembered — probed in Chrome 152 at the exact
 * boundary in both directions, and the cases below are those probes:
 *
 *   100 x 65535  -> data:image/png…      100 x 65536  -> data:,
 *   8192 x 32768 -> data:image/png…      8192 x 32800 -> data:,
 *   (8192 x 32768 is 268,435,456 px, i.e. 16384², exactly the area ceiling)
 */

import { describe, expect, it } from 'vitest';
import { MAX_CANVAS_AREA, MAX_CANVAS_SIDE, canvasLimitRefusal } from './canvasLimits.js';

describe('canvasLimitRefusal', () => {
  it('accepts the shapes a normal full-page capture produces', () => {
    // The 4320px fixture at DPR 2, the case that exercised this path.
    expect(canvasLimitRefusal(2560, 8640)).toBeNull();
    expect(canvasLimitRefusal(1280, 4320)).toBeNull();
  });

  it('accepts a canvas sitting exactly on each ceiling', () => {
    expect(canvasLimitRefusal(100, MAX_CANVAS_SIDE)).toBeNull();
    expect(canvasLimitRefusal(MAX_CANVAS_SIDE, 100)).toBeNull();
    // 8192 x 32768 === MAX_CANVAS_AREA, and Chrome accepts it.
    expect(canvasLimitRefusal(8192, 32768)).toBeNull();
  });

  it('refuses one pixel past the side ceiling, on either axis', () => {
    expect(canvasLimitRefusal(100, MAX_CANVAS_SIDE + 1)).toMatch(/too (tall|large)/i);
    expect(canvasLimitRefusal(MAX_CANVAS_SIDE + 1, 100)).toMatch(/too (wide|large)/i);
  });

  it('refuses past the area ceiling even when both sides are legal', () => {
    // 8192 x 32800: every side is far below 65535, only the area is over.
    const refusal = canvasLimitRefusal(8192, 32800);
    expect(refusal).not.toBeNull();
    expect(8192).toBeLessThan(MAX_CANVAS_SIDE);
    expect(32800).toBeLessThan(MAX_CANVAS_SIDE);
    expect(8192 * 32800).toBeGreaterThan(MAX_CANVAS_AREA);
  });

  it('says what happened and what to do instead, in the message itself', () => {
    // This sentence is what the model reads when a page is too long. It has to
    // name the limit and offer the way forward, or the model retries the same
    // capture and gets the same refusal.
    const refusal = canvasLimitRefusal(2560, 70000) ?? '';
    expect(refusal).toMatch(/70000/);          // the size actually asked for
    expect(refusal).toMatch(/65535/);          // the bound it broke
    expect(refusal).toMatch(/screenshot/i);    // the alternative
  });

  it('carries the measured ceilings, so a wrong constant cannot pass quietly', () => {
    expect(MAX_CANVAS_SIDE).toBe(65535);
    expect(MAX_CANVAS_AREA).toBe(16384 * 16384);
  });
});
