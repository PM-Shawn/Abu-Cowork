import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tempDir } from '@tauri-apps/api/path';
import { lstat } from '@tauri-apps/plugin-fs';
import { presentFilesTool } from './presentTools';
import {
  createAuthorizationScope,
  disposeAuthorizationScope,
  revokeWorkspace,
  scopedAuthorizeWorkspace,
} from '../pathSafety';
import { canonicalizeElectronPathForPolicy } from '../../../utils/electronHost';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import type { ToolExecutionContext } from '../../../types';

// The disk and the Electron host are the boundaries; path authorization runs for real.
const mockExists = vi.fn();
const mockStat = vi.fn();
vi.mock('../fsBridge', () => ({
  exists: (p: string) => mockExists(p),
  stat: (p: string) => mockStat(p),
}));

vi.mock('../../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

const FIRST = '/Users/testuser/Projects/first';
const SECOND = '/Users/testuser/Projects/second';
const NO_ACCESS = 'reading this path is not authorized';

async function run(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const result = await presentFilesTool.execute(input, context);
  return typeof result === 'string' ? result : JSON.stringify(result);
}

describe('presentFilesTool path authorization', () => {
  beforeEach(() => {
    mockExists.mockReset().mockResolvedValue(true);
    mockStat.mockReset().mockResolvedValue({ isFile: true, isDirectory: false, size: 1024 });
    vi.mocked(canonicalizeElectronPathForPolicy).mockReset();
    vi.mocked(canonicalizeElectronPathForPolicy).mockResolvedValue(null);
    vi.mocked(tempDir).mockReset();
    vi.mocked(tempDir).mockResolvedValue('/tmp');
    vi.mocked(lstat).mockReset();
    vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
    useWorkspaceStore.getState().clearWorkspace();
    revokeWorkspace(FIRST);
    revokeWorkspace(SECOND);
  });

  afterEach(() => {
    useWorkspaceStore.getState().clearWorkspace();
  });

  describe('a run whose conversation is the one in view', () => {
    it('presents a file of its workspace', async () => {
      useWorkspaceStore.getState().setWorkspace(FIRST);
      const out = await run({ files: [{ path: 'report.md' }] }, { workspacePath: FIRST });
      expect(out).toBe(`Presented ${FIRST}/report.md`);
    });

    it('rejects a path no grant covers without probing the disk', async () => {
      useWorkspaceStore.getState().setWorkspace(FIRST);
      const out = await run({ files: [{ path: '/Users/testuser/Documents/secret.md' }] }, { workspacePath: FIRST });
      expect(out).toContain(`- /Users/testuser/Documents/secret.md: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
      expect(mockStat).not.toHaveBeenCalled();
    });
  });

  describe('a run that goes on after another conversation came into view', () => {
    // Selecting a conversation makes its workspace the current one, which
    // takes the previous workspace out of the shared authorization table.
    beforeEach(() => {
      useWorkspaceStore.getState().setWorkspace(FIRST);
      useWorkspaceStore.getState().setWorkspace(SECOND);
    });

    it('still presents a file of its own workspace', async () => {
      const out = await run(
        { files: [{ path: 'report.md' }, { path: `${FIRST}/out/data.xlsx` }] },
        { workspacePath: FIRST },
      );
      expect(out).toBe(`Presented ${FIRST}/report.md\nPresented ${FIRST}/out/data.xlsx`);
    });

    it('still presents a file of its own workspace when no conversation with a workspace is in view', async () => {
      useWorkspaceStore.getState().clearWorkspace();
      const out = await run({ files: [{ path: 'report.md' }] }, { workspacePath: FIRST });
      expect(out).toBe(`Presented ${FIRST}/report.md`);
    });

    it('rejects a path outside its workspace that no grant covers, without probing the disk', async () => {
      const out = await run({ files: [{ path: '/Users/testuser/Documents/secret.md' }] }, { workspacePath: FIRST });
      expect(out).toContain(`- /Users/testuser/Documents/secret.md: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
    });

    it('rejects a path that leaves its workspace through `..`, without probing the disk', async () => {
      const out = await run({ files: [{ path: '../third/report.md' }] }, { workspacePath: FIRST });
      expect(out).toContain(`- /Users/testuser/Projects/third/report.md: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
    });

    it('rejects a blocked file inside its workspace without probing the disk', async () => {
      const out = await run({ files: [{ path: '.env' }] }, { workspacePath: FIRST });
      expect(out).toContain(`- ${FIRST}/.env: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
    });

    it('rejects a link inside its workspace whose target is outside, without probing the disk', async () => {
      vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (candidate) => (
        candidate === `${FIRST}/link.md` ? '/Users/testuser/Documents/secret.md' : candidate
      ));
      const out = await run({ files: [{ path: 'link.md' }] }, { workspacePath: FIRST });
      expect(out).toContain(`- ${FIRST}/link.md: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
    });
  });

  describe('a run with an authorization scope of its own', () => {
    let scopeId: string;

    beforeEach(() => {
      scopeId = createAuthorizationScope();
    });

    afterEach(() => {
      disposeAuthorizationScope(scopeId);
    });

    it('presents what its scope grants', async () => {
      scopedAuthorizeWorkspace(scopeId, FIRST, ['read']);
      const out = await run({ files: [{ path: 'report.md' }] }, { workspacePath: FIRST, authorizationScopeId: scopeId });
      expect(out).toBe(`Presented ${FIRST}/report.md`);
    });

    it('is held to its scope: a workspace the scope does not grant is rejected without probing the disk', async () => {
      useWorkspaceStore.getState().setWorkspace(FIRST);
      const out = await run({ files: [{ path: 'report.md' }] }, { workspacePath: FIRST, authorizationScopeId: scopeId });
      expect(out).toContain(`- ${FIRST}/report.md: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
    });
  });
});
