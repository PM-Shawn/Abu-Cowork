import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';

const invokeMock = vi.fn();
const permissionMock = vi.fn();
const isMacOSMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/tmp/abu-data'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  exists: vi.fn(async () => true),
}));
vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ currentPath: null }) },
}));
vi.mock('@/core/agent/computerUsePermission', () => ({
  checkComputerUsePermissions: (...args: unknown[]) => permissionMock(...args),
}));
vi.mock('@/utils/platform', () => ({
  isMacOS: () => isMacOSMock(),
}));

import { runPermissionsChecks } from './permissions';

describe('runPermissionsChecks — Computer Use readiness', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue({ pong: true });
    permissionMock.mockReset().mockResolvedValue({ screenRead: true, uiControl: true });
    isMacOSMock.mockReset().mockReturnValue(true);
    useSettingsStore.setState({ computerUseEnabled: false });
  });

  it('does not add Computer Use rows when the capability is disabled', async () => {
    const results = await runPermissionsChecks();

    expect(results.some(row => row.id.startsWith('permissions:computer-'))).toBe(false);
    expect(invokeMock).not.toHaveBeenCalledWith('native_helper_health');
  });

  it('adds fresh helper and permission rows when Computer Use is enabled', async () => {
    useSettingsStore.setState({ computerUseEnabled: true });

    const results = await runPermissionsChecks();

    expect(invokeMock).toHaveBeenCalledWith('native_helper_health');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(results.find(row => row.id === 'permissions:computer-helper')?.status).toBe('passed');
    expect(results.find(row => row.id === 'permissions:computer-ui-control')?.status).toBe('passed');
    expect(results.find(row => row.id === 'permissions:computer-screen-read')?.status).toBe('passed');
  });

  it('marks missing Accessibility as failed and missing Screen Recording as limited warning', async () => {
    useSettingsStore.setState({ computerUseEnabled: true });
    permissionMock.mockResolvedValue({ screenRead: false, uiControl: false });

    const results = await runPermissionsChecks();

    expect(results.find(row => row.id === 'permissions:computer-ui-control')?.status).toBe('failed');
    expect(results.find(row => row.id === 'permissions:computer-screen-read')?.status).toBe('warning');
  });

  it('prevents false green when the helper probe fails', async () => {
    useSettingsStore.setState({ computerUseEnabled: true });
    invokeMock.mockRejectedValue(new Error('helper missing'));

    const results = await runPermissionsChecks();

    const helper = results.find(row => row.id === 'permissions:computer-helper');
    expect(helper?.status).toBe('failed');
    expect(helper?.errorDetail).toContain('helper missing');
  });
});
