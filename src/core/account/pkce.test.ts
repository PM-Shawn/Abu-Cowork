import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPkcePair } from '@/core/account/pkce';

describe('createPkcePair', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates an RFC 7636 S256 proof from separate verifier and state entropy', async () => {
    let call = 0;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      const bytes = array as Uint8Array;
      bytes.fill(call === 0 ? 0 : 255);
      call += 1;
      return array;
    });

    const pair = await createPkcePair();

    expect(pair).toEqual({
      verifier: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      challenge: 'DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo',
      state: '_____________________w',
    });
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});
