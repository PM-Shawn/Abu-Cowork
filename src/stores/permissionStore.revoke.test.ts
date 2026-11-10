import { describe, it, expect, beforeEach } from 'vitest';
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
});
