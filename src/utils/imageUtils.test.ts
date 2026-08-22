import { describe, it, expect } from 'vitest';
import { sniffImageMediaType, IMAGE_MAGIC_PREFIX_BYTES, SUPPORTED_IMAGE_TYPES } from './imageUtils';

/** Build a byte prefix long enough for the sniffer, padded with filler. */
function head(...bytes: number[]): Uint8Array {
  const out = new Uint8Array(IMAGE_MAGIC_PREFIX_BYTES);
  out.set(bytes.slice(0, IMAGE_MAGIC_PREFIX_BYTES));
  return out;
}

const PNG = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = head(0xff, 0xd8, 0xff, 0xe0);
const GIF87 = head(0x47, 0x49, 0x46, 0x38, 0x37, 0x61);
const GIF89 = head(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
// RIFF <4-byte size> WEBP
const WEBP = head(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);

describe('sniffImageMediaType', () => {
  describe('supported image signatures', () => {
    it('recognises PNG', () => expect(sniffImageMediaType(PNG)).toBe('image/png'));
    it('recognises JPEG', () => expect(sniffImageMediaType(JPEG)).toBe('image/jpeg'));
    it('recognises GIF87a and GIF89a', () => {
      expect(sniffImageMediaType(GIF87)).toBe('image/gif');
      expect(sniffImageMediaType(GIF89)).toBe('image/gif');
    });
    it('recognises WebP', () => expect(sniffImageMediaType(WEBP)).toBe('image/webp'));

    it('only ever returns a type the composer can send', () => {
      for (const bytes of [PNG, JPEG, GIF87, GIF89, WEBP]) {
        expect(SUPPORTED_IMAGE_TYPES).toContain(sniffImageMediaType(bytes));
      }
    });
  });

  describe('non-images', () => {
    it('rejects a PDF', () => {
      expect(sniffImageMediaType(head(0x25, 0x50, 0x44, 0x46, 0x2d))).toBeNull();
    });

    it('rejects TIFF and BMP — real images, but not types the composer can send', () => {
      expect(sniffImageMediaType(head(0x49, 0x49, 0x2a, 0x00))).toBeNull(); // TIFF little-endian
      expect(sniffImageMediaType(head(0x4d, 0x4d, 0x00, 0x2a))).toBeNull(); // TIFF big-endian
      expect(sniffImageMediaType(head(0x42, 0x4d))).toBeNull(); // BMP
    });

    it('rejects RIFF containers that are not WebP (e.g. WAV)', () => {
      const wav = head(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
      expect(sniffImageMediaType(wav)).toBeNull();
    });

    it('rejects plain text and all-zero bytes', () => {
      expect(sniffImageMediaType(new TextEncoder().encode('hello world.....'))).toBeNull();
      expect(sniffImageMediaType(new Uint8Array(IMAGE_MAGIC_PREFIX_BYTES))).toBeNull();
    });
  });

  describe('short input', () => {
    it('does not over-read a buffer shorter than the signature', () => {
      expect(sniffImageMediaType(new Uint8Array([0x89, 0x50]))).toBeNull();
      expect(sniffImageMediaType(new Uint8Array())).toBeNull();
      // "RIFF" alone must not pass as WebP — the WEBP marker sits at offset 8.
      expect(sniffImageMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
    });

    it('matches a signature that is fully present even without the full prefix', () => {
      expect(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    });
  });

  describe('the reported bug: extension-less pasteboard temp item', () => {
    it('types the file by its bytes, not by its (useless) name', () => {
      // `…/id=6571367.107158211` — the name says ".107158211", the bytes say PNG.
      expect(sniffImageMediaType(PNG)).toBe('image/png');
    });
  });
});
