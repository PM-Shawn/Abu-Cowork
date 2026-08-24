import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { analyzeCommandBoundary } from './commandBoundary';
import { allWorkingDirectories } from './workingDirs';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  authorizeWorkspace,
  createAuthorizationScope,
  disposeAuthorizationScope,
  revokeWorkspace,
  scopedAuthorizeWorkspace,
} from '../tools/pathSafety';

const WS = '/Users/test/project';
const HOME = '/Users/test';
const GLOBAL_EXTRA = '/Users/test/global-extra';
const SCOPED_WS = '/Users/test/scoped-project';

describe('commandBoundary', () => {
  beforeEach(() => {
    authorizeWorkspace(WS);
    useWorkspaceStore.setState({ currentPath: null });
  });
  afterEach(() => {
    revokeWorkspace(WS);
    useWorkspaceStore.setState({ currentPath: null });
  });

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

    it('scoped runs do not treat globally authorized extra directories as inside', () => {
      const scopeId = createAuthorizationScope();
      authorizeWorkspace(GLOBAL_EXTRA, ['read', 'write']);
      scopedAuthorizeWorkspace(scopeId, WS, ['read', 'write']);

      try {
        expect(analyzeCommandBoundary(`echo data > ${GLOBAL_EXTRA}/out.txt`, WS, HOME, scopeId)).toBe('outside');
        expect(analyzeCommandBoundary(`echo data > ${GLOBAL_EXTRA}/out.txt`, WS, HOME)).toBe('inside');
      } finally {
        disposeAuthorizationScope(scopeId);
        revokeWorkspace(GLOBAL_EXTRA);
      }
    });

    it('scoped runs do not inherit the ambient workspace store currentPath', () => {
      const scopeId = createAuthorizationScope();
      useWorkspaceStore.setState({ currentPath: WS });
      scopedAuthorizeWorkspace(scopeId, SCOPED_WS, ['read', 'write']);

      try {
        expect(allWorkingDirectories(scopeId)).not.toContain(WS);
        expect(analyzeCommandBoundary('echo hi > out.txt', WS, HOME, scopeId)).toBe('outside');
        expect(analyzeCommandBoundary('echo hi > out.txt', WS, HOME)).toBe('inside');
      } finally {
        disposeAuthorizationScope(scopeId);
      }
    });

    it('scoped write detection does not treat read-only scope directories as writable', () => {
      const scopeId = createAuthorizationScope();
      scopedAuthorizeWorkspace(scopeId, WS, ['read']);

      try {
        expect(analyzeCommandBoundary('echo hi > out.txt', WS, HOME, scopeId)).toBe('outside');
      } finally {
        disposeAuthorizationScope(scopeId);
      }
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
