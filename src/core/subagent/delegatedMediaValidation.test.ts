import { describe, expect, it } from 'vitest';
import { validateDelegatedMediaInput } from './delegatedMediaValidation';

function b64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

const VALID_PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
const VALID_INTERLACED_PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAFNeavDAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==');
const VALID_WEBP = b64('UklGRiIAAABXRUJQVlA4IBYAAADQAQCdASoBAAEAAUAmJaQAA3AA/vuU');
const VALID_ANIMATED_WEBP = b64('UklGRjoAAABXRUJQQU5NRi4AAAAAAAAAAAAAAAAAAAAAAAAAVlA4IBYAAADQAQCdASoBAAEAAUAmJaQAA3AA/vuU');
const TRUNCATED_VP8L_HEX = '5249464614000000574542505650384c080000002f00000000010203';

describe('delegated media validation', () => {
  it.each([
    [
      'PNG whose inflated scanline uses invalid filter byte 5',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNlAAAADAAGjm0zfwAAAABJRU5ErkJggg==',
      'image/png',
    ],
    [
      'interlaced PNG whose inflated scanline uses invalid filter byte 5',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAFNeavDAAAACklEQVR4nGNlAAAADAAGjm0zfwAAAABJRU5ErkJggg==',
      'image/png',
    ],
    [
      'truncated VP8L WebP',
      'UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAA=',
      'image/webp',
    ],
  ])('rejects reviewer exact corrupt sample: %s', async (_label, base64, mediaType) => {
    await expect(validateDelegatedMediaInput({ mediaType, bytes: b64(base64) })).rejects.toThrow();
  });

  it('rejects the reviewer exact truncated VP8L hex sample', async () => {
    await expect(validateDelegatedMediaInput({
      mediaType: 'image/webp',
      bytes: Uint8Array.from(Buffer.from(TRUNCATED_VP8L_HEX, 'hex')),
    })).rejects.toThrow();
  });

  it.each([
    ['PNG', 'image/png', VALID_PNG],
    ['interlaced PNG', 'image/png', VALID_INTERLACED_PNG],
    ['common VP8 WebP', 'image/webp', VALID_WEBP],
    ['animated WebP', 'image/webp', VALID_ANIMATED_WEBP],
    [
      'basic complete PDF',
      'application/pdf',
      new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF'),
    ],
  ])('accepts valid %s payloads', async (_label, mediaType, bytes) => {
    await expect(validateDelegatedMediaInput({ mediaType, bytes })).resolves.toBeUndefined();
  });
});
