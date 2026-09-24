import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  listComputerUseGrants,
  parseComputerUseGrantList,
  revokeComputerUseGrant,
  setComputerUseAppDenied,
} from './grants';

const electronHost = { current: true };
vi.mock('@/utils/electronHost', () => ({
  hasElectronCommandHost: () => electronHost.current,
}));

const grant = {
  key: 'c:\\program files\\tencent\\qqnt\\qq.exe',
  displayName: 'QQ',
  tier: 'approval-required',
  grantedAt: 1_000,
  lastUsedAt: 2_000,
  source: 'dialog',
};

describe('Computer Use grant list (renderer view of the Host store)', () => {
  beforeEach(() => {
    electronHost.current = true;
    vi.mocked(invoke).mockReset();
  });

  it('parses the Host projection and drops malformed rows', () => {
    const parsed = parseComputerUseGrantList({
      available: true,
      grants: [
        grant,
        { ...grant, key: 'bad-tier', tier: 'communication' },
        { ...grant, key: 'bad-time', grantedAt: 'yesterday' },
        'not a record',
      ],
      denied: [
        { key: 'com.example.denied', displayName: 'Denied', deniedAt: 3_000 },
        { key: '', displayName: 'no key', deniedAt: 3_000 },
      ],
    });
    expect(parsed.available).toBe(true);
    expect(parsed.grants.map((record) => record.key)).toEqual([grant.key]);
    expect(parsed.grants[0]).not.toHaveProperty('signer');
    expect(parsed.denied.map((record) => record.key)).toEqual(['com.example.denied']);
  });

  it('treats a missing or unavailable store as empty, never as allowed', () => {
    expect(parseComputerUseGrantList(undefined)).toEqual({ available: false, grants: [], denied: [] });
    expect(parseComputerUseGrantList({ available: false, grants: [grant], denied: [] })).toEqual({
      available: false, grants: [], denied: [],
    });
  });

  it('asks the Host only inside the Electron command host', async () => {
    vi.mocked(invoke).mockResolvedValue({ available: true, grants: [grant], denied: [] });
    await expect(listComputerUseGrants()).resolves.toMatchObject({ available: true, grants: [{ key: grant.key }] });
    expect(invoke).toHaveBeenCalledWith('computer_use_list_grants', {});

    electronHost.current = false;
    vi.mocked(invoke).mockClear();
    await expect(listComputerUseGrants()).resolves.toEqual({ available: false, grants: [], denied: [] });
    await expect(revokeComputerUseGrant(grant.key)).resolves.toBe(false);
    await setComputerUseAppDenied(grant.key, true, 'QQ');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('forwards revoke and deny with the key the Host handed out', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ revoked: true }).mockResolvedValueOnce({ denied: true, persisted: true });
    await expect(revokeComputerUseGrant(grant.key)).resolves.toBe(true);
    expect(invoke).toHaveBeenNthCalledWith(1, 'computer_use_revoke_grant', { key: grant.key });
    await setComputerUseAppDenied(grant.key, true, 'QQ');
    expect(invoke).toHaveBeenNthCalledWith(2, 'computer_use_set_denied', { key: grant.key, denied: true, displayName: 'QQ' });
  });
});
