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
import { closeAxSession, computerTool } from './computerTools';
import { useChatStore } from '../../../stores/chatStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import {
  drainCapabilitySetupRequests,
  getPendingCapabilitySetup,
  resolveCapabilitySetup,
} from '../../capabilityPlugins/setupBridge';
import {
  __resetRuntimeTraceForTests,
  getRendererRuntimeTraceSnapshot,
} from '../../observability/runtimeTrace';

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
    __resetRuntimeTraceForTests();
    drainCapabilitySetupRequests();
    setElectronHost(false);
    vi.mocked(isWindows).mockReturnValue(false);
    vi.mocked(isMacOS).mockReturnValue(true);
    vi.mocked(invoke).mockReset();
    useSettingsStore.setState({
      activeSystemTab: 'general',
      capabilitySetupTarget: null,
      computerUseEnabled: true,
      systemSettingsOpen: false,
    });
    useChatStore.setState({ activeConversationId: 'active-conversation' });
  });

  afterEach(async () => {
    await closeAxSession();
    setElectronHost(false);
  });

  it('suspends the same tool call until the user explicitly completes setup', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });

    const resultPromise = computerTool.execute(
      { action: 'wait', duration: 100, consequence: 'none' },
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

  it('requests only Accessibility setup for an AX-only task', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });

    const resultPromise = computerTool.execute(
      { action: 'get_app_state', app: 'Notes', consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-ax',
        toolCallId: 'tool-ax',
        interactionMode: 'foreground',
        computerUseTier: 'structured',
        modelId: 'deepseek-chat',
      },
    );

    const request = getPendingCapabilitySetup();
    expect(request).toMatchObject({
      target: 'computer',
      computerUseRequirements: { screenRead: false, uiControl: true },
    });
    resolveCapabilitySetup(request!.id, false);
    await expect(resultPromise).resolves.toContain('Computer Use');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requests both permissions for pixel control setup', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });

    const resultPromise = computerTool.execute(
      {
        action: 'click',
        x: 10,
        y: 10,
        expected_state_id: 'state-1',
        consequence: 'none',
      },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-pixel',
        toolCallId: 'tool-pixel',
        interactionMode: 'foreground',
        computerUseTier: 'full',
        modelId: 'gpt-4o',
      },
    );

    const request = getPendingCapabilitySetup();
    expect(request).toMatchObject({
      target: 'computer',
      computerUseRequirements: { screenRead: true, uiControl: true },
    });
    resolveCapabilitySetup(request!.id, false);
    await expect(resultPromise).resolves.toContain('Computer Use');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses background setup without opening a global dialog', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });

    const resultPromise = computerTool.execute(
      { action: 'screenshot', consequence: 'none' },
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

  it('blocks a model that explicitly lacks tool calling before any host access', async () => {
    const result = await computerTool.execute(
      { action: 'wait', duration: 100, consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-1',
        toolCallId: 'tool-unsupported',
        interactionMode: 'foreground',
        computerUseTier: 'unsupported',
        modelId: 'text-only-no-tools',
      },
    );

    expect(String(result)).toContain('text-only-no-tools');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps an undeclared custom model fail-closed until capability is declared', async () => {
    const result = await computerTool.execute(
      { action: 'wait', duration: 100, consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-1',
        toolCallId: 'tool-unknown',
        interactionMode: 'foreground',
        computerUseTier: 'unknown',
        modelId: 'private-proxy-model',
      },
    );

    expect(String(result)).toContain('private-proxy-model');
    expect(invoke).not.toHaveBeenCalled();
    expect(getRendererRuntimeTraceSnapshot().recentEvents).toContainEqual(
      expect.objectContaining({
        event: 'renderer.computer_use_blocked',
        conversationId: 'active-conversation',
        loopId: 'loop-1',
        computerRunId: 'active-conversation:loop-1',
        traceId: 'active-conversation:loop-1',
        toolCallId: 'tool-unknown',
        modelId: 'private-proxy-model',
        modelTier: 'unknown',
        reason: 'model-unknown',
      }),
    );
  });

  it('allows structured non-vision models to use the safe AX-oriented path', async () => {
    await expect(computerTool.execute(
      { action: 'wait', duration: 100, consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-1',
        toolCallId: 'tool-structured',
        interactionMode: 'foreground',
        computerUseTier: 'structured',
        modelId: 'deepseek-chat',
        supportsVision: false,
      },
    )).resolves.toBe('Waited 100ms');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a consequential action without an exact user-visible detail', async () => {
    const result = await computerTool.execute({
      action: 'click',
      x: 10,
      y: 10,
      consequence: 'delete',
    }, {
      conversationId: 'active-conversation',
      loopId: 'loop-1',
      toolCallId: 'tool-1',
      interactionMode: 'foreground',
    });

    expect(result).toContain('consequence_detail');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Windows without elevation: returns a Windows-appropriate error, no macOS Settings call', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    mockPermissions({ screen_recording: true, accessibility: false });

    const result = await computerTool.execute({
      action: 'get_app_state',
      app: 'Chrome',
      consequence: 'none',
    }, undefined);

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

    const result = await computerTool.execute({
      action: 'get_app_state',
      app: 'Chrome',
      consequence: 'none',
    }, undefined);

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
          expires_at: 1_700_000_060_000, // filler (TESTING.md §3), matches sibling literals below
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
      { action: 'screenshot', consequence: 'none' },
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
    const beginCall = vi.mocked(invoke).mock.calls.find(([cmd]) => (
      cmd === 'computer_use_begin_session'
    ));
    expect(beginCall?.[1]).toMatchObject({
      actionIntent: {
        action: 'screenshot',
        category: 'none',
        summary: '',
      },
    });
  });

  it('uses the native frontmost-app identity probe in Electron without Apple Events', async () => {
    setElectronHost(true);
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: false, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'Finder',
          bundle_id: 'com.apple.finder',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          token: 'task-owned-token',
          target: {
            app_name: 'Finder',
            bundle_id: 'com.apple.finder',
            process_id: 42,
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        return Promise.resolve({
          session_id: 'ax-finder',
          app: 'Finder',
          total_visited: 1,
          truncated: false,
          elements: [],
        });
      }
      return Promise.resolve(null);
    });

    await computerTool.execute(
      { action: 'get_app_state', app: 'Finder', consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-native-identity',
        toolCallId: 'tool-native-identity',
        interactionMode: 'foreground',
        supportsVision: false,
      },
    );

    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(commands).toContain('frontmost_app_identity');
    expect(commands).not.toContain('get_active_window');
  });

  it('keeps the Windows foreground-process probe instead of calling macOS-only identity APIs', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    setElectronHost(true);
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'get_active_window') {
        return Promise.resolve({
          app_name: 'notepad',
          bundle_id: 'notepad.exe',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          token: 'windows-task-token',
          target: {
            app_name: 'notepad',
            bundle_id: 'notepad.exe',
            process_id: 42,
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'mouse_move') return Promise.resolve('moved');
      return Promise.resolve(null);
    });

    await computerTool.execute(
      { action: 'move', x: 10, y: 20, consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-windows-identity',
        toolCallId: 'tool-windows-identity',
        interactionMode: 'foreground',
        supportsVision: true,
      },
    );

    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(commands).toContain('get_active_window');
    expect(commands).toContain('mouse_move');
    expect(commands).not.toContain('frontmost_app_identity');
    expect(commands).not.toContain('ax_snapshot');
  });

  it('stops before native input when the task aborts during UI settling', async () => {
    setElectronHost(true);
    const abortController = new AbortController();
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity') {
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
          expires_at: 1_700_000_060_000, // filler (TESTING.md §3), matches sibling literals below
        });
      }
      if (cmd === 'ax_snapshot') {
        return Promise.resolve({
          session_id: 'ax-before-abort',
          app: 'Notes',
          total_visited: 1,
          truncated: false,
          elements: [],
        });
      }
      if (cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'Notes',
          bundle_id: 'com.apple.Notes',
          process_id: 1,
        });
      }
      if (cmd === 'window_hide') {
        abortController.abort();
      }
      return Promise.resolve(null);
    });

    const observed = await computerTool.execute(
      { action: 'get_app_state', app: 'Notes', consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-1',
        toolCallId: 'observe-1',
        interactionMode: 'foreground',
        supportsVision: false,
      },
    );
    const stateId = String(observed).match(/state_id: ([^ ]+)/)?.[1];
    expect(stateId).toBeTruthy();

    await expect(computerTool.execute(
      {
        action: 'click',
        x: 10,
        y: 10,
        expected_state_id: stateId,
        consequence: 'none',
      },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-1',
        toolCallId: 'tool-1',
        interactionMode: 'foreground',
        abortSignal: abortController.signal,
      },
    )).rejects.toMatchObject({ name: 'AbortError' });

    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(commands).toContain('computer_use_end_session');
    expect(commands).not.toContain('mouse_click');
  });

  it('returns state_id, consumes it once, and automatically verifies the write', async () => {
    setElectronHost(true);
    let snapshotCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: false, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'Notes',
          bundle_id: 'com.apple.Notes',
          process_id: 7,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          token: `token-${snapshotCount}`,
          target: {
            app_name: 'Notes',
            bundle_id: 'com.apple.Notes',
            process_id: 7,
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `ax-${snapshotCount}`,
          app: 'Notes',
          total_visited: 1,
          truncated: false,
          elements: [{
            id: 1,
            role: 'AXTextField',
            label: 'Name',
            value: snapshotCount === 1 ? '' : 'Shawn',
            bounds: [10, 20, 100, 30],
            actions: ['AXSetValue'],
            depth: 2,
          }],
        });
      }
      return Promise.resolve(null);
    });
    const context = {
      conversationId: 'state-protocol-conversation',
      loopId: 'state-protocol-loop',
      interactionMode: 'foreground' as const,
      supportsVision: false,
    };

    const observed = await computerTool.execute(
      { action: 'get_app_state', app: 'Notes', consequence: 'none' },
      { ...context, toolCallId: 'observe' },
    );
    const stateId = String(observed).match(/state_id: ([^ ]+)/)?.[1];
    expect(stateId).toBeTruthy();

    const action = await computerTool.execute({
      action: 'type',
      element_id: 1,
      text: 'Shawn',
      expected_state_id: stateId,
      expected_effect: { type: 'element-value', element_id: 1, equals: 'Shawn' },
      consequence: 'none',
    }, { ...context, toolCallId: 'type' });

    expect(action).toContain('Automatic verification: verified change');
    expect(vi.mocked(invoke).mock.calls).toContainEqual([
      'ax_set_value',
      expect.objectContaining({ sessionId: 'ax-1', elementId: 1 }),
    ]);

    const staleRetry = await computerTool.execute({
      action: 'type',
      element_id: 1,
      text: 'Shawn',
      expected_state_id: stateId,
      consequence: 'none',
    }, { ...context, toolCallId: 'type-again' });

    expect(staleRetry).toContain('state_id is stale');
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ax_set_value')).toHaveLength(1);
  });

  it('keeps Host Gate tokens isolated across overlapping runs', async () => {
    setElectronHost(true);
    const beginResolvers: Array<() => void> = [];
    vi.mocked(invoke).mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: false, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity') {
        return Promise.resolve({
          app_name: 'Finder',
          bundle_id: 'com.apple.finder',
          process_id: 1,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        const app = args?.targetApp as string;
        return new Promise((resolve) => {
          beginResolvers.push(() => resolve({
            token: `token-${app}`,
            target: {
              app_name: app,
              bundle_id: `test.${app.toLowerCase()}`,
              process_id: app === 'Notes' ? 11 : 22,
            },
            classification: 'ordinary',
            expires_at: 61_000,
          }));
          if (beginResolvers.length === 2) {
            beginResolvers.forEach((release) => release());
          }
        });
      }
      if (cmd === 'resolve_app_identity') {
        const app = args?.appName as string;
        return Promise.resolve({
          app_name: app,
          bundle_id: `test.${app.toLowerCase()}`,
          process_id: app === 'Notes' ? 11 : 22,
        });
      }
      if (cmd === 'ax_snapshot') {
        const app = args?.appName as string;
        return Promise.resolve({
          session_id: `ax-${app}`,
          app,
          total_visited: 0,
          truncated: false,
          elements: [],
        });
      }
      return Promise.resolve(null);
    });

    await Promise.all([
      computerTool.execute(
        { action: 'get_app_state', app: 'Notes', consequence: 'none' },
        {
          conversationId: 'parallel-a',
          loopId: 'parallel-loop-a',
          toolCallId: 'parallel-tool-a',
          interactionMode: 'foreground',
          supportsVision: false,
        },
      ),
      computerTool.execute(
        { action: 'get_app_state', app: 'TextEdit', consequence: 'none' },
        {
          conversationId: 'parallel-b',
          loopId: 'parallel-loop-b',
          toolCallId: 'parallel-tool-b',
          interactionMode: 'foreground',
          supportsVision: false,
        },
      ),
    ]);

    const privilegedCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => (
      cmd === 'activate_app' || cmd === 'ax_snapshot'
    ));
    for (const [, args] of privilegedCalls) {
      const payload = args as Record<string, unknown>;
      expect(payload.__abuComputerUseToken).toBe(`token-${payload.appName}`);
    }
    const endedTokens = vi.mocked(invoke).mock.calls
      .filter(([cmd]) => cmd === 'computer_use_end_session')
      .map(([, args]) => (args as Record<string, unknown>).__abuComputerUseToken)
      .sort();
    expect(endedTokens).toEqual(['token-Notes', 'token-TextEdit']);
  });
});
