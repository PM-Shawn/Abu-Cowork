import { describe, expect, it } from 'vitest';
import { formatFileSize } from './formatFileSize';

describe('formatFileSize', () => {
  it.each([
    [0, '0B'],
    [1023, '1023B'],
    [1024, '1.0KB'],
    [1536, '1.5KB'],
    [1024 * 1024 - 1, '1024.0KB'],
    [1024 * 1024, '1.0MB'],
    [5 * 1024 * 1024 * 1024, '5120.0MB'],
  ])('formats %i bytes as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});
