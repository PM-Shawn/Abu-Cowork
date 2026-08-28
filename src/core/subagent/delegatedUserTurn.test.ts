import { describe, expect, it } from 'vitest';
import { isDelegatedMediaType } from './delegatedUserTurn';

describe('isDelegatedMediaType', () => {
  it.each([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
  ])('accepts supported MIME %s', (mediaType) => {
    expect(isDelegatedMediaType(mediaType)).toBe(true);
  });

  it.each(['image/bmp', 'image/tiff', 'application/octet-stream', '', undefined])(
    'rejects unsupported MIME %s',
    (mediaType) => {
      expect(isDelegatedMediaType(mediaType)).toBe(false);
    },
  );
});
