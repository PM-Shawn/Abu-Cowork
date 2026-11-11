import { describe, expect, it } from 'vitest';
import { uint8ArrayToBase64 } from './base64';
import { base64ImageHeaderSize, imageHeaderSize } from './imageHeaderSize';

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

/** A JPEG whose frame header comes after `padding` bytes of metadata segments. */
function jpeg(w: number, h: number, padding = 0): Uint8Array {
  const segments: number[] = [0xff, 0xd8];
  for (let left = padding; left > 0; left -= 1000) {
    const length = Math.min(left, 1000);
    segments.push(0xff, 0xe1, (length + 2) >> 8, (length + 2) & 0xff, ...new Array<number>(length).fill(0));
  }
  segments.push(0xff, 0xc0, 0, 17, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  return Uint8Array.from(segments);
}

describe('imageHeaderSize', () => {
  it('reads PNG and JPEG sizes', () => {
    expect(imageHeaderSize(png(10032, 4178))).toEqual({ w: 10032, h: 4178 });
    expect(imageHeaderSize(jpeg(1000, 9000))).toEqual({ w: 1000, h: 9000 });
  });

  it('gives null for a non-picture, a cut-off header and a zero size', () => {
    expect(imageHeaderSize(new TextEncoder().encode('%PDF-1.4 not a picture at all'))).toBeNull();
    expect(imageHeaderSize(png(10, 10).subarray(0, 20))).toBeNull();
    expect(imageHeaderSize(png(0, 10))).toBeNull();
  });
});

describe('base64ImageHeaderSize', () => {
  it('finds a size at the start of the data', () => {
    expect(base64ImageHeaderSize(uint8ArrayToBase64(png(3000, 1000)))).toEqual({ w: 3000, h: 1000 });
  });

  it('finds a JPEG frame header that follows large metadata segments', () => {
    expect(base64ImageHeaderSize(uint8ArrayToBase64(jpeg(5000, 3000, 50_000)))).toEqual({ w: 5000, h: 3000 });
  });

  it('gives null for data that is not base64 or holds no size', () => {
    expect(base64ImageHeaderSize('not base64 !!')).toBeNull();
    expect(base64ImageHeaderSize(uint8ArrayToBase64(new Uint8Array(200)))).toBeNull();
  });
});
