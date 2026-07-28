/**
 * Regression tests for the computer tool's permission-check platform branch.
 *
 * Bug: on Windows, a non-elevated process gets accessibility=false from
 * check_macos_permissions, and the tool fell through to the macOS-only
 * error path — telling the user "已自动打开系统设置，请在「辅助功能」中授权"
 * while `open "x-apple.systempreferences:..."` silently failed. The user
 * waits for a dialog that can never appear.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { isWindows, isMacOS } from '../../../utils/platform';
import { computerTool } from './computerTools';
import { useChatStore } from '../../../stores/chatStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import {
  drainCapabilitySetupRequests,
  getPendingCapabilitySetup,
  resolveCapabilitySetup,
} from '../../capabilityPlugins/setupBridge';

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

function setElectronHost(enabled: boolean) {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };
  runtime.__ABU_SHELL__ = enabled
    ? { mainSupervisesSidecar: true }
    : undefined;
}

describe('computerTool — accessibility permission branch', () => {
  beforeEach(() => {
    drainCapabilitySetupRequests();
    setElectronHost(false);
    vi.mocked(invoke).mockReset();
    useSettingsStore.setState({
      activeSystemTab: 'general',
      capabilitySetupTarget: null,
      computerUseEnabled: true,
      systemSettingsOpen: false,
    });
    useChatStore.setState({ activeConversationId: 'active-conversation' });
  });

  afterEach(() => {
    setElectronHost(false);
  });

  it('suspends the same tool call until the user explicitly completes setup', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });

    const resultPromise = computerTool.execute(
      { action: 'wait', duration: 100 },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-1',
        toolCallId: 'tool-1',
        interactionMode: 'foreground',
      },
    );

    const request = getPendingCapabilitySetup();
    expect(request).toMatchObject({
      target: 'computer',
      conversationId: 'active-conversation',
      toolCallId: 'tool-1',
    });
    expect(useSettingsStore.getState()).toMatchObject({
      computerUseEnabled: false,
      systemSettingsOpen: false,
    });

    useSettingsStore.setState({ computerUseEnabled: true });
    resolveCapabilitySetup(request!.id, true);

    await expect(resultPromise).resolves.toBe('Waited 100ms');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses background setup without opening a global dialog', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });

    const resultPromise = computerTool.execute(
      { action: 'screenshot' },
      {
        conversationId: 'background-conversation',
        toolCallId: 'background-tool',
        interactionMode: 'background',
      },
    );

    expect(getPendingCapabilitySetup()).toBeNull();
    expect(useSettingsStore.getState()).toMatchObject({
      computerUseEnabled: false,
      systemSettingsOpen: false,
    });
    await expect(resultPromise).resolves.toContain('Computer Use');
    expect(getPendingCapabilitySetup()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
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

  it('never enables the main-process gate from a Computer Use tool call', async () => {
    setElectronHost(true);
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          token: 'task-owned-token',
          target: {
            app_name: 'Finder',
            bundle_id: 'com.apple.finder',
            process_id: 1,
          },
          classification: 'ordinary',
          expires_at: Date.now() + 60_000,
        });
      }
      if (cmd === 'get_overlay_window_id' || cmd === 'get_abu_window_id') {
        return Promise.resolve(null);
      }
      if (cmd === 'capture_screen') {
        return Promise.resolve({
          base64: 'iVBORw0KGgo=',
          width: 1,
          height: 1,
          scale_factor: 1,
        });
      }
      return Promise.resolve(null);
    });

    await computerTool.execute(
      { action: 'screenshot' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-1',
        toolCallId: 'tool-1',
        interactionMode: 'foreground',
      },
    );

    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(commands).toContain('computer_use_begin_session');
    expect(commands).toContain('computer_use_end_session');
    expect(commands).not.toContain('computer_use_set_enabled');
  });

  it('stops before native input when the task aborts during UI settling', async () => {
    setElectronHost(true);
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'get_active_window') {
        return Promise.resolve({
          app_name: 'Notes',
          bundle_id: 'com.apple.Notes',
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          token: 'task-owned-token',
          target: {
            app_name: 'Notes',
            bundle_id: 'com.apple.Notes',
            process_id: 1,
          },
          classification: 'ordinary',
          expires_at: Date.now() + 60_000,
        });
      }
      if (cmd === 'window_hide') {
        controller.abort();
      }
      return Promise.resolve(null);
    });

    await expect(computerTool.execute(
      { action: 'click', x: 10, y: 10 },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-1',
        toolCallId: 'tool-1',
        interactionMode: 'foreground',
        abortSignal: controller.signal,
      },
    )).rejects.toMatchObject({ name: 'AbortError' });

    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(commands).toContain('computer_use_end_session');
    expect(commands).not.toContain('mouse_click');
  });
});
