/**
 * Regression tests for the computer tool's permission-check platform branch.
 *
 * Bug: on Windows, a non-elevated process gets accessibility=false from
 * check_macos_permissions, and the tool fell through to the macOS-only
 * error path — telling the user "已自动打开系统设置，请在「辅助功能」中授权"
 * while `open "x-apple.systempreferences:..."` silently failed. The user
 * waits for a dialog that can never appear.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { isWindows, isMacOS } from '../../../utils/platform';
import { computerTool } from './computerTools';

vi.mock('../../../utils/platform', () => ({
  initPlatform: vi.fn(),
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => true),
  getPlatform: vi.fn(() => 'macos'),
  getShell: vi.fn(() => 'zsh/bash'),
}));

function mockPermissions(perms: { screen_recording: boolean; accessibility: boolean }) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === 'check_macos_permissions') return Promise.resolve(perms);
    if (cmd === 'run_shell_command') return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    return Promise.resolve(null);
  });
}

function shellCommands(): string[] {
  return vi.mocked(invoke).mock.calls
    .filter(([cmd]) => cmd === 'run_shell_command')
    .map(([, payload]) => (payload as { command: string }).command);
}

describe('computerTool — accessibility permission branch', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('Windows without elevation: returns a Windows-appropriate error, no macOS Settings call', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    mockPermissions({ screen_recording: true, accessibility: false });

    const result = await computerTool.execute({ action: 'get_app_state', app: 'Chrome' }, undefined);

    expect(typeof result).toBe('string');
    const text = result as string;
    expect(text.toLowerCase()).toContain('administrator');
    // Must NOT claim a macOS Settings panel was opened
    expect(text).not.toContain('Accessibility');
    expect(text).not.toContain('System Settings');
    // Must NOT attempt to open macOS System Settings
    expect(shellCommands().some((c) => c.includes('x-apple.systempreferences'))).toBe(false);
  });

  it('macOS without accessibility: keeps existing behavior (opens Settings, macOS message)', async () => {
    vi.mocked(isWindows).mockReturnValue(false);
    vi.mocked(isMacOS).mockReturnValue(true);
    mockPermissions({ screen_recording: true, accessibility: false });

    const result = await computerTool.execute({ action: 'get_app_state', app: 'Chrome' }, undefined);

    expect(result as string).toContain('Accessibility');
    expect(shellCommands().some((c) => c.includes('x-apple.systempreferences'))).toBe(true);
  });
});
