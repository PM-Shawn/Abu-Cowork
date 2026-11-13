import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appDataDir, tempDir } from '@tauri-apps/api/path';
import { lstat } from '@tauri-apps/plugin-fs';
import { presentFilesTool } from './presentTools';
import {
  checkReadPath,
  createAuthorizationScope,
  disposeAuthorizationScope,
  revokeWorkspace,
  scopedAuthorizeWorkspace,
} from '../pathSafety';
import { canonicalizeElectronPathForPolicy } from '../../../utils/electronHost';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useChatStore } from '../../../stores/chatStore';
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

    it('presents a file the run saved in a folder of the user outside its workspace, with no grant', async () => {
      useWorkspaceStore.getState().setWorkspace(FIRST);
      const out = await run({ files: [{ path: '/Users/testuser/Documents/2026预算_修正.xlsx' }] }, { workspacePath: FIRST });
      expect(out).toBe('Presented /Users/testuser/Documents/2026预算_修正.xlsx');
    });

    it('grants nothing by presenting: the shared table stays as it was', async () => {
      useWorkspaceStore.getState().setWorkspace(FIRST);
      await run({ files: [{ path: '/Users/testuser/Documents/a.xlsx' }] }, { workspacePath: FIRST });
      expect((await checkReadPath('/Users/testuser/Documents/a.xlsx')).allowed).toBe(false);
    });

    it('rejects a path read_file refuses, without probing the disk', async () => {
      useWorkspaceStore.getState().setWorkspace(FIRST);
      const out = await run({ files: [{ path: '/Users/testuser/.ssh/id_rsa' }] }, { workspacePath: FIRST });
      expect(out).toContain(`- /Users/testuser/.ssh/id_rsa: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('rejects a user-folder path when the run may not prompt, without probing the disk', async () => {
      useWorkspaceStore.getState().setWorkspace(FIRST);
      const out = await run(
        { files: [{ path: '/Users/testuser/Documents/a.xlsx' }] },
        { workspacePath: FIRST, allowPermissionPrompts: false },
      );
      expect(out).toContain(`- /Users/testuser/Documents/a.xlsx: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
    });
  });

  describe('tool results of the conversation itself', () => {
    const OWN = 'conv-own';
    const OTHER = 'conv-other';
    const results = (id: string) => `/Users/testuser/.abu/conversations/${id}/results/big.csv`;

    beforeEach(() => {
      vi.mocked(appDataDir).mockResolvedValue('/Users/testuser/.abu');
      useChatStore.setState({ conversations: { [OWN]: { id: OWN }, [OTHER]: { id: OTHER } } as never });
    });

    afterEach(() => {
      useChatStore.setState({ conversations: {} });
    });

    it('presents a file of its own, as read_file reads it', async () => {
      const out = await run({ files: [{ path: results(OWN) }] }, { conversationId: OWN });
      expect(out).toBe(`Presented ${results(OWN)}`);
    });

    it('rejects another conversation\'s results without probing the disk', async () => {
      const out = await run({ files: [{ path: results(OTHER) }] }, { conversationId: OWN });
      expect(out).toContain(`- ${results(OTHER)}: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
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

    it('presents a file in a folder of the user outside its workspace, as read_file would read it', async () => {
      const out = await run({ files: [{ path: '/Users/testuser/Documents/secret.md' }] }, { workspacePath: FIRST });
      expect(out).toBe('Presented /Users/testuser/Documents/secret.md');
    });

    it('presents a file reached through `..` in a folder of the user', async () => {
      const out = await run({ files: [{ path: '../third/report.md' }] }, { workspacePath: FIRST });
      expect(out).toBe('Presented /Users/testuser/Projects/third/report.md');
    });

    it('rejects a blocked file inside its workspace without probing the disk', async () => {
      const out = await run({ files: [{ path: '.env' }] }, { workspacePath: FIRST });
      expect(out).toContain(`- ${FIRST}/.env: ${NO_ACCESS}`);
      expect(mockExists).not.toHaveBeenCalled();
    });

    it('rejects a link inside its workspace whose target is a credential store, without probing the disk', async () => {
      vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (candidate) => (
        candidate === `${FIRST}/link.md` ? '/Users/testuser/.ssh/id_rsa' : candidate
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
