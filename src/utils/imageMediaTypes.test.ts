import { describe, expect, it } from 'vitest';
import { IMAGE_MIME_MAP, RESULT_IMAGE_EXTENSIONS } from './imageMediaTypes';

describe('imageMediaTypes', () => {
  it('preserves the existing extension and MIME aliases', () => {
    expect(IMAGE_MIME_MAP).toEqual({
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
    });
    expect(RESULT_IMAGE_EXTENSIONS).toEqual({
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/bmp': 'bmp',
      'image/svg+xml': 'svg',
      'image/x-icon': 'ico',
      'image/vnd.microsoft.icon': 'ico',
    });
  });

  it('keeps both maps semantically inverse when aliases collapse to canonical values', () => {
    for (const [extension, mimeType] of Object.entries(IMAGE_MIME_MAP)) {
      const canonicalExtension = RESULT_IMAGE_EXTENSIONS[mimeType];
      expect(canonicalExtension, `${extension} -> ${mimeType}`).toBeDefined();
      expect(IMAGE_MIME_MAP[canonicalExtension], `${extension} -> ${mimeType}`).toBe(mimeType);
    }

    for (const [mimeType, extension] of Object.entries(RESULT_IMAGE_EXTENSIONS)) {
      const canonicalMimeType = IMAGE_MIME_MAP[extension];
      expect(canonicalMimeType, `${mimeType} -> ${extension}`).toBeDefined();
      expect(RESULT_IMAGE_EXTENSIONS[canonicalMimeType], `${mimeType} -> ${extension}`).toBe(extension);
    }
  });
});
