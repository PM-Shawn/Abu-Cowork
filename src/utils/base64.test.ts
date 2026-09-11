import { describe, it, expect } from 'vitest';
import { base64ToUint8Array, uint8ArrayToBase64 } from './base64';

describe('base64', () => {
  it('converts small Uint8Array to base64', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(uint8ArrayToBase64(bytes)).toBe(btoa('Hello'));
  });

  it('converts empty Uint8Array', () => {
    const bytes = new Uint8Array([]);
    expect(uint8ArrayToBase64(bytes)).toBe('');
  });

  it('converts single byte', () => {
    const bytes = new Uint8Array([65]); // "A"
    expect(uint8ArrayToBase64(bytes)).toBe(btoa('A'));
  });

  it('handles large arrays without stack overflow (> 8192 bytes)', () => {
    // Create array > chunkSize (8192)
    const bytes = new Uint8Array(20000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }
    // Should not throw RangeError
    const result = uint8ArrayToBase64(bytes);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('produces valid base64 output', () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253]);
    const result = uint8ArrayToBase64(bytes);
    // Verify it's valid base64 by decoding
    const decoded = atob(result);
    expect(decoded.length).toBe(6);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(5)).toBe(253);
  });

  it('round-trips arbitrary byte values', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);

    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes);
  });
});
