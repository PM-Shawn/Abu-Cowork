import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { analyzeCommandBoundary } from './commandBoundary';
import { authorizeWorkspace, revokeWorkspace } from '../tools/pathSafety';

const WS = '/Users/test/project';
const HOME = '/Users/test';

describe('commandBoundary', () => {
  beforeEach(() => authorizeWorkspace(WS));
  afterEach(() => revokeWorkspace(WS));

  describe('inside the working set', () => {
    it('relative redirect resolves inside cwd', () => {
      expect(analyzeCommandBoundary('echo hi > out.txt', WS, HOME)).toBe('inside');
    });
    it('cp to relative dest inside workspace', () => {
      expect(analyzeCommandBoundary('cp a.txt sub/b.txt', WS, HOME)).toBe('inside');
    });
    it('write to /tmp is always inside', () => {
      expect(analyzeCommandBoundary('echo hi > /tmp/scratch.txt', WS, HOME)).toBe('inside');
    });
  });

  describe('outside the working set', () => {
    it('redirect to home dir outside workspace', () => {
      expect(analyzeCommandBoundary('echo data > ~/Desktop/leak.txt', WS, HOME)).toBe('outside');
    });
    it('cp destination outside workspace', () => {
      expect(analyzeCommandBoundary('cp a.txt ~/Desktop/b.txt', WS, HOME)).toBe('outside');
    });
    it('mv to a parent dir outside workspace', () => {
      expect(analyzeCommandBoundary('mv x.txt ../elsewhere/y.txt', WS, HOME)).toBe('outside');
    });
    it('tee to an absolute system path', () => {
      expect(analyzeCommandBoundary('tee /etc/evil.conf', WS, HOME)).toBe('outside');
    });
  });

  describe('unknown (conservative — no extra prompt)', () => {
    it('commands with no write target', () => {
      expect(analyzeCommandBoundary('echo hello', WS, HOME)).toBe('unknown');
      expect(analyzeCommandBoundary('npm run build', WS, HOME)).toBe('unknown');
    });
    it('relative write target with no cwd cannot be resolved', () => {
      expect(analyzeCommandBoundary('echo hi > out.txt', undefined, HOME)).toBe('unknown');
    });
    it('does not treat 2>&1 as a file redirect', () => {
      expect(analyzeCommandBoundary('make 2>&1', WS, HOME)).toBe('unknown');
    });
  });
});
