import { describe, it, expect } from 'vitest';
import { normalizeBrowserUrl } from './browserUrl';

describe('normalizeBrowserUrl', () => {
  describe('existing scheme', () => {
    it('leaves http/https URLs unchanged', () => {
      expect(normalizeBrowserUrl('https://example.com')).toBe('https://example.com');
      expect(normalizeBrowserUrl('http://example.com/path?q=1')).toBe('http://example.com/path?q=1');
    });

    it('leaves other schemes (file://, about:) unchanged', () => {
      expect(normalizeBrowserUrl('file:///Users/x/a.html')).toBe('file:///Users/x/a.html');
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeBrowserUrl('  https://example.com  ')).toBe('https://example.com');
    });
  });

  describe('localhost / loopback → http', () => {
    it('prepends http:// for bare localhost', () => {
      expect(normalizeBrowserUrl('localhost')).toBe('http://localhost');
      expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173');
      expect(normalizeBrowserUrl('localhost:3000/app')).toBe('http://localhost:3000/app');
    });

    it('prepends http:// for 127.0.0.1', () => {
      expect(normalizeBrowserUrl('127.0.0.1')).toBe('http://127.0.0.1');
      expect(normalizeBrowserUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    });
  });

  describe('bare domains → https', () => {
    it('prepends https:// for real-world domains', () => {
      expect(normalizeBrowserUrl('example.com')).toBe('https://example.com');
      expect(normalizeBrowserUrl('sub.example.com/path')).toBe('https://sub.example.com/path');
    });
  });
});
