import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const decompressSync = vi.hoisted(() => vi.fn<(
  bytes: Uint8Array,
  options?: { out?: Uint8Array },
) => Uint8Array>());

vi.mock('fflate', () => ({ decompressSync }));

import {
  hasDelegatedMediaSignature,
  validateDelegatedMediaInput,
} from './delegatedMediaValidation';

function b64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

const HUGE_EXPECTED_PNG = b64('iVBORw0KGgoAAAANSUhEUgABhqAAAYagCAYAAACoUgvIAAAACUlEQVR4nGMAAAABAAFe/335AAAAAElFTkSuQmCC');
const VALID_ONE_PIXEL_PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');

afterEach(() => {
  decompressSync.mockReset();
});

describe('delegated media validation decompression limits', () => {
  it('rejects huge-dimension PNG before invoking zlib decompression', async () => {
    decompressSync.mockReturnValue(new Uint8Array([0]));

    await expect(validateDelegatedMediaInput({
      mediaType: 'image/png',
      bytes: HUGE_EXPECTED_PNG,
    })).rejects.toThrow();
    expect(decompressSync).not.toHaveBeenCalled();
  });

  it('passes a bounded output buffer to zlib for dimensions that are allowed', async () => {
    decompressSync.mockImplementation((_bytes, options) => {
      expect(options?.out?.byteLength).toBe(4);
      return new Uint8Array(3);
    });

    await expect(hasDelegatedMediaSignature(VALID_ONE_PIXEL_PNG, 'image/png')).resolves.toBe(true);
    expect(decompressSync).toHaveBeenCalledOnce();
  });
});
