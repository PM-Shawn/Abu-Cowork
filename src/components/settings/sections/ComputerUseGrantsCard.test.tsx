// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { invoke } from '@tauri-apps/api/core';
import ComputerUseGrantsCard from './ComputerUseGrantsCard';
import { initLanguage, getI18n } from '@/i18n';

const electronHost = { current: true };
vi.mock('@/utils/electronHost', () => ({
  hasElectronCommandHost: () => electronHost.current,
}));

const t = () => getI18n();

const qq = {
  key: 'c:\\program files\\tencent\\qqnt\\qq.exe',
  displayName: 'QQ',
  tier: 'approval-required',
  grantedAt: Date.UTC(2026, 8, 13),
  lastUsedAt: Date.UTC(2026, 8, 13),
  source: 'dialog',
};
const notepad = { ...qq, key: 'c:\\windows\\notepad.exe', displayName: 'Notepad', tier: 'ordinary' };

describe('ComputerUseGrantsCard', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    electronHost.current = true;
    vi.mocked(invoke).mockReset();
  });
  afterEach(cleanup);

  it('lists remembered apps with their tier and the denied apps', async () => {
    vi.mocked(invoke).mockResolvedValue({
      available: true,
      grants: [qq, notepad],
      denied: [{ key: 'com.example.denied', displayName: 'Denied App', deniedAt: 1 }],
    });
    render(<ComputerUseGrantsCard />);
    expect(await screen.findByText('QQ')).toBeInTheDocument();
    expect(screen.getByText('Notepad')).toBeInTheDocument();
    expect(screen.getByText(t().sandbox.computerUseGrantTierApprovalRequired)).toBeInTheDocument();
    expect(screen.getByText(t().sandbox.computerUseGrantTierOrdinary)).toBeInTheDocument();
    expect(screen.getByText('Denied App')).toBeInTheDocument();
    expect(screen.getByText(t().sandbox.computerUseGrantsRedLines)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('computer_use_list_grants', {});
  });

  it('revokes through the Host and re-reads the list', async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'computer_use_revoke_grant') return { revoked: true };
      return {
        available: true,
        grants: vi.mocked(invoke).mock.calls.some(([c]) => c === 'computer_use_revoke_grant') ? [] : [qq],
        denied: [],
      };
    });
    render(<ComputerUseGrantsCard />);
    await screen.findByText('QQ');
    await user.click(screen.getByTitle(t().sandbox.computerUseGrantRevoke));
    expect(invoke).toHaveBeenCalledWith('computer_use_revoke_grant', { key: qq.key });
    await waitFor(() => expect(screen.queryByText('QQ')).not.toBeInTheDocument());
    expect(screen.getByText(t().sandbox.computerUseGrantsEmpty)).toBeInTheDocument();
  });

  it('denies from the allowed list and restores from the denied list', async () => {
    const user = userEvent.setup();
    let denied = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'computer_use_set_denied') {
        denied = (args as { denied?: unknown } | undefined)?.denied === true;
        return { denied, persisted: true };
      }
      return denied
        ? { available: true, grants: [], denied: [{ key: qq.key, displayName: 'QQ', deniedAt: 2 }] }
        : { available: true, grants: [qq], denied: [] };
    });
    render(<ComputerUseGrantsCard />);
    await screen.findByText('QQ');
    await user.click(screen.getByTitle(t().sandbox.computerUseGrantDeny));
    expect(invoke).toHaveBeenCalledWith('computer_use_set_denied', { key: qq.key, denied: true, displayName: 'QQ' });
    await screen.findByTitle(t().sandbox.computerUseGrantRestore);

    await user.click(screen.getByTitle(t().sandbox.computerUseGrantRestore));
    expect(invoke).toHaveBeenCalledWith('computer_use_set_denied', { key: qq.key, denied: false, displayName: 'QQ' });
    await screen.findByTitle(t().sandbox.computerUseGrantRevoke);
  });

  it('explains when no Host store answers instead of pretending the list is empty', async () => {
    electronHost.current = false;
    render(<ComputerUseGrantsCard />);
    expect(await screen.findByText(t().sandbox.computerUseGrantsUnavailable)).toBeInTheDocument();
    expect(screen.queryByText(t().sandbox.computerUseGrantsEmpty)).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});
