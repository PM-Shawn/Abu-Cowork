// @vitest-environment happy-dom
// Needs a DOM: these tests spy on document.createElement to stand up a canvas.
// Required since 0b68c42b flipped the suite default to `node` (TESTING.md §6).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fitImageToDimension } from './imageCompress';

/**
 * happy-dom ships no canvas, so this file's header records it as "not unit
 * tested". That left composer admission — every image the user attaches — at 0%
 * coverage, which is where the `.bmp` gap below survived.
 *
 * The browser surface it needs is small and fully observable, so we stand it up
 * rather than skipping: `createImageBitmap` reports dimensions, `getContext`
 * records that a draw happened, and `toBlob` hands back bytes tagged with the
 * type it was asked to encode. The assertions are about which type comes out
 * and whether a resize was recorded — never about pixels, which only a real
 * browser can produce.
 */
function stubCanvas(width: number, height: number, sizeOf: (type: string, canvasWidth: number) => number = () => 3) {
  vi.stubGlobal('createImageBitmap', async () => ({ width, height, close() {} }));
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob: (cb: (b: Blob | null) => void, type: string) => {
        cb(new Blob([new Uint8Array(sizeOf(type, canvas.width)).fill(7)], { type }));
      },
    };
    return canvas;
  }) as typeof document.createElement);
}

const bytes = () => new Uint8Array([1, 2, 3, 4]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fitImageToDimension', () => {
  it('leaves a wire-legal image that already fits completely untouched', async () => {
    stubCanvas(1000, 800);
    const input = { bytes: bytes(), mediaType: 'image/png' };
    expect(await fitImageToDimension(input, 2000)).toBe(input);
  });

  it('scales down and records the before/after dimensions', async () => {
    stubCanvas(4000, 2000);
    const out = await fitImageToDimension({ bytes: bytes(), mediaType: 'image/png' }, 2000);
    expect(out.mediaType).toBe('image/png'); // PNG stays PNG, so alpha survives
    expect(out.resized).toEqual({ fromWidth: 4000, fromHeight: 2000, toWidth: 2000, toHeight: 1000 });
  });

  // The regression. `isImageFile` admits `.bmp` and `IMAGE_MIME_MAP` turns it
  // into `image/bmp`, which Anthropic and OpenAI both reject — and the block is
  // in durable history by then, re-inlined into every later request, so the
  // session is wedged for good. A dimension-only gate let it through because
  // its pixels were fine.
  it('re-encodes a wire-illegal type even when no resize is needed', async () => {
    stubCanvas(1000, 800);
    const out = await fitImageToDimension({ bytes: bytes(), mediaType: 'image/bmp' }, 2000);
    expect(out.mediaType).toBe('image/png');
  });

  // The notice this feeds tells the model it is not looking at original scale.
  // A pure container swap changes no pixels, so claiming a resize would make
  // the model discount coordinates that are still exact.
  it('records no resize when it only changed the container', async () => {
    stubCanvas(1000, 800);
    const out = await fitImageToDimension({ bytes: bytes(), mediaType: 'image/bmp' }, 2000);
    expect(out.mediaType).toBe('image/png'); // pinned here too, or this passes vacuously
    expect(out.resized).toBeUndefined();
  });

  // Animated GIFs are wire-legal, and canvas would flatten one to a single
  // frame. Under the ceiling there is no reason to touch it.
  it('does not flatten an animated GIF that fits', async () => {
    stubCanvas(500, 500);
    const input = { bytes: bytes(), mediaType: 'image/gif' };
    expect(await fitImageToDimension(input, 2000)).toBe(input);
  });

  it('re-encodes an oversized GIF to PNG, losing animation to keep it sendable', async () => {
    stubCanvas(4000, 4000);
    const out = await fitImageToDimension({ bytes: bytes(), mediaType: 'image/gif' }, 2000);
    expect(out.mediaType).toBe('image/png');
    expect(out.resized).toEqual({ fromWidth: 4000, fromHeight: 4000, toWidth: 2000, toHeight: 2000 });
  });

  // A resize bug must never block the user from attaching a picture.
  it('returns the input untouched when the image cannot be decoded', async () => {
    vi.stubGlobal('createImageBitmap', async () => { throw new Error('corrupt'); });
    const input = { bytes: bytes(), mediaType: 'image/png' };
    expect(await fitImageToDimension(input, 2000)).toBe(input);
  });

  it('treats a non-positive or non-finite ceiling as "no gate"', async () => {
    stubCanvas(4000, 4000);
    const input = { bytes: bytes(), mediaType: 'image/png' };
    expect(await fitImageToDimension(input, 0)).toBe(input);
    expect(await fitImageToDimension(input, Number.NaN)).toBe(input);
  });
});

describe('fitImageToDimension keeps the encoded picture under the byte limit', () => {
  const LIMIT = 1000;

  it('re-encodes a PNG that is inside the side limit but over the byte limit as a JPEG, with no resize record', async () => {
    stubCanvas(1900, 1200, (type) => (type === 'image/jpeg' ? 400 : 5000));
    const out = await fitImageToDimension({ bytes: new Uint8Array(5000), mediaType: 'image/png' }, 2000, LIMIT);
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.bytes.length).toBe(400);
    expect(out.resized).toBeUndefined();
  });

  it('keeps a photo a JPEG when it is scaled down to the side limit', async () => {
    stubCanvas(4000, 3000, () => 300);
    const out = await fitImageToDimension({ bytes: new Uint8Array(5000), mediaType: 'image/jpeg' }, 2000, LIMIT);
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.resized).toEqual({ fromWidth: 4000, fromHeight: 3000, toWidth: 2000, toHeight: 1500 });
  });

  it('steps down in size when a JPEG at full size is still over the limit', async () => {
    stubCanvas(1900, 1200, (type, w) => (type === 'image/jpeg' && w <= 1330 ? 500 : 5000));
    const out = await fitImageToDimension({ bytes: new Uint8Array(5000), mediaType: 'image/png' }, 2000, LIMIT);
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.resized?.toWidth).toBe(1330);
  });

  it('leaves the picture as it is when no step brings it under the limit (the send-time check judges it)', async () => {
    stubCanvas(1900, 1200, () => 5000);
    const input = { bytes: new Uint8Array(5000), mediaType: 'image/png' };
    expect(await fitImageToDimension(input, 2000, LIMIT)).toBe(input);
  });

  it('judges bytes only when a byte limit is given', async () => {
    stubCanvas(1900, 1200, () => 5000);
    const input = { bytes: new Uint8Array(5000), mediaType: 'image/png' };
    expect(await fitImageToDimension(input, 2000)).toBe(input);
  });
});
