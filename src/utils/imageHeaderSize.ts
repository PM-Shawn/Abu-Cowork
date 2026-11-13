import { base64ToUint8Array } from './base64';

/** Pixel size of a picture. */
export interface PixelSize { w: number; h: number }

const decoder = new TextDecoder();

function u16be(b: Uint8Array, i: number): number { return (b[i] << 8) | b[i + 1]; }
function u16le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8); }
function u32be(b: Uint8Array, i: number): number { return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; }
function i32le(b: Uint8Array, i: number): number { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24); }

function rawSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: u16le(b, 6), height: u16le(b, 8) };
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // A start-of-frame marker (not the table, arithmetic-coding or reserved ones) holds the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      i += 2 + u16be(b, i + 2);
    }
    return null;
  }
  if (b.length >= 30 && decoder.decode(b.subarray(0, 4)) === 'RIFF' && decoder.decode(b.subarray(8, 12)) === 'WEBP') {
    const chunk = decoder.decode(b.subarray(12, 16));
    if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/** Pixel size from a PNG, JPEG, GIF, BMP or WebP header; null for other formats or a header that is cut off or not positive. */
export function imageHeaderSize(bytes: Uint8Array): PixelSize | null {
  try {
    const size = rawSize(bytes);
    return size && size.width > 0 && size.height > 0 ? { w: size.width, h: size.height } : null;
  } catch {
    return null;
  }
}

/**
 * Base64 characters decoded to find a size: 48 bytes hold the size of a PNG,
 * GIF, BMP or WebP; a JPEG keeps its frame header after its tables (3 KB holds
 * them in a screenshot or an encoded copy) or after its metadata segments
 * (EXIF, ICC, XMP: up to 64 KB each), so the later steps read 48 KB, then 768 KB.
 * Every picture of a request is judged on every request, so the common case
 * must stay cheap.
 */
const BASE64_HEADER_STEPS = [64, 1 << 12, 1 << 16, 1 << 20];

/** Pixel size from the start of base64 image data, decoding no more than needed; null when not found there. */
export function base64ImageHeaderSize(data: string): PixelSize | null {
  for (const chars of BASE64_HEADER_STEPS) {
    let size: PixelSize | null;
    try {
      size = imageHeaderSize(base64ToUint8Array(data.slice(0, chars)));
    } catch {
      return null;
    }
    if (size || data.length <= chars) return size;
  }
  return null;
}
