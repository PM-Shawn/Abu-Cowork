import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePermissionStore } from './permissionStore';
import { getAuthorizedDirs } from '../core/tools/pathSafety';

const FOLDER = '/Users/testuser/Documents/reports';

describe('permissionStore · revoking a grant', () => {
  beforeEach(() => {
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
  });

  it('removes a remembered grant, so it is not authorized again at the next start', () => {
    usePermissionStore.getState().grantPermission(FOLDER, ['read', 'write'], 'always');
    expect(Object.keys(usePermissionStore.getState().persistedGrants)).toEqual([FOLDER]);

    usePermissionStore.getState().revokePermission(FOLDER);

    expect(usePermissionStore.getState().persistedGrants).toEqual({});
    expect(getAuthorizedDirs()).not.toContain(FOLDER);
  });

  it('finds the stored grant under a different spelling of the same folder', () => {
    usePermissionStore.getState().grantPermission(FOLDER, ['read', 'write'], 'always');
    usePermissionStore.getState().grantPermission(`${FOLDER}/archive`, ['read'], 'session');

    usePermissionStore.getState().revokePermission(`${FOLDER}/`);

    expect(usePermissionStore.getState().persistedGrants).toEqual({});
    // A folder inside it was granted on its own and stays.
    expect(Object.keys(usePermissionStore.getState().sessionGrants)).toEqual([`${FOLDER}/archive`]);
    expect(getAuthorizedDirs()).not.toContain(FOLDER);
    usePermissionStore.getState().revokePermission(`${FOLDER}/archive`);
  });

  it('keeps only read of the home folder, or a folder above it, in the stored grant', async () => {
    const { homeDir } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    for (const root of [home, '/Users']) {
      usePermissionStore.getState().grantPermission(root, ['read', 'write', 'execute'], 'always');
      await vi.waitFor(() => {
        expect(usePermissionStore.getState().persistedGrants[root]?.capabilities).toEqual(['read']);
      });
      usePermissionStore.getState().revokePermission(root);
    }
  });

  it('does not persist a write grant on a system or program folder', () => {
    for (const path of ['/Applications/Tool.app', '/opt/homebrew/bin', '/usr/local/bin/tool']) {
      usePermissionStore.getState().grantPermission(path, ['read', 'write'], 'always');
      expect(usePermissionStore.getState().persistedGrants[path]).toBeUndefined();
      expect(usePermissionStore.getState().sessionGrants[path]?.duration).toBe('session');
      usePermissionStore.getState().revokePermission(path);
    }
    usePermissionStore.getState().grantPermission('/Users/testuser/Documents', ['read', 'write'], 'always');
    expect(usePermissionStore.getState().persistedGrants['/Users/testuser/Documents']).toBeDefined();
    usePermissionStore.getState().revokePermission('/Users/testuser/Documents');
  });
});
