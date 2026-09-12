/**
 * Regression tests for the computer tool's permission-check platform branch.
 *
 * Windows has no macOS-style Accessibility consent switch. The Electron host
 * reports normal desktop control as available and concrete higher-integrity
 * targets are rejected by the native action guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { isWindows, isMacOS } from '../../../utils/platform';
import {
  closeAxSession,
  computerTool,
  formatComputerVerification,
  selectAxElementsForModel,
} from './computerTools';
import enUS from '../../../i18n/locales/en-US';
import zhCN from '../../../i18n/locales/zh-CN';
import { useChatStore } from '../../../stores/chatStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { computerUseController } from '../../agent/computerUseController';
import { recoveryBudget, runBudgetKey } from '@/core/computer-use/recoveryBudget';
import { computerObservationContexts } from '../../computer-use/observationContext';
import {
  drainCapabilitySetupRequests,
  getPendingCapabilitySetup,
  resolveCapabilitySetup,
} from '../../capabilityPlugins/setupBridge';
import {
  __resetRuntimeTraceForTests,
  getRendererRuntimeTraceSnapshot,
} from '../../observability/runtimeTrace';

describe('computerTool WindowRef-first contract', () => {
  it('documents WindowRef-first targeting and explicit whole-screen separation', () => {
    expect(computerTool.inputSchema.properties).toMatchObject({
      window_ref: { type: 'string' },
      target_selector: { enum: ['foreground-at-submit'] },
      screenshot_id: { type: 'string' },
    });
    expect(computerTool.inputSchema.properties.action.description).toContain('list_windows');
    expect(computerTool.inputSchema.properties.action.description).toContain('get_window_state');
    expect(computerTool.inputSchema.properties.action.description).toContain('get_screen_state');
    expect(computerTool.description).toContain('Every write must carry window_ref');
    expect(computerTool.description).toContain('Never fall back to the whole screen');
  });

  it('describes AX bounds as screen coordinates and action coordinates as screenshot-relative', () => {
    expect(computerTool.description).toContain('AX element bounds are screen coordinates');
    expect(computerTool.description).toContain('x/y action coordinates are relative to the referenced screenshot');
  });

  it('documents that element-appears needs a non-empty role or label', () => {
    expect(computerTool.inputSchema.properties.expected_effect.description)
      .toContain('element-appears requires at least one non-empty role or label');
  });

  it('renders changed-without-expectation without claiming the target was achieved', () => {
    const verification = {
      status: 'verified-change' as const,
      beforeStateId: 'before',
      afterStateId: 'after',
      reason: 'state-changed' as const,
      observation: 'changed' as const,
      expectation: 'not-requested' as const,
    };

    expect(formatComputerVerification(verification, zhCN.toolResult.computer))
      .toContain('已观察到界面变化，尚未确认目标达成');
    expect(formatComputerVerification(verification, enUS.toolResult.computer))
      .toContain('A UI change was observed; target completion is not confirmed');
  });

  it('renders a legacy verification without separated evidence as weak evidence', () => {
    const text = formatComputerVerification({
      status: 'verified-change',
      beforeStateId: 'before',
      afterStateId: 'after',
      reason: 'state-changed',
    }, enUS.toolResult.computer);

    expect(text).toContain('Legacy verification evidence is incomplete');
    expect(text).toContain('target completion is not confirmed');
    expect(text).not.toContain('verified change');
  });
});

vi.mock('../../../utils/platform', () => ({
  initPlatform: vi.fn(),
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => true),
  getPlatform: vi.fn(() => 'macos'),
  getShell: vi.fn(() => 'zsh/bash'),
}));

describe('selectAxElementsForModel', () => {
  it('keeps focused, editable, and document content visible past ribbon truncation', () => {
    const ribbon = Array.from({ length: 130 }, (_, id) => ({
      id,
      role: 'Button',
      label: `Ribbon ${id}`,
      value: null,
      bounds: [0, 0, 20, 20] as [number, number, number, number],
      actions: ['Invoke'],
      depth: 2,
    }));
    const document = {
      id: 130,
      role: 'Document',
      label: 'Page 1',
      value: null,
      bounds: [100, 200, 900, 700] as [number, number, number, number],
      actions: [],
      depth: 3,
      focused: true,
    };
    const editable = {
      id: 131,
      role: 'TextField',
      label: 'Formula bar',
      value: null,
      bounds: [100, 100, 500, 30] as [number, number, number, number],
      actions: ['SetValue'],
      depth: 3,
    };

    const selected = selectAxElementsForModel([...ribbon, document, editable], 120);

    expect(selected).toHaveLength(120);
    expect(selected.slice(0, 2).map((element) => element.id)).toEqual([130, 131]);
    expect(selected.some((element) => element.id === 129)).toBe(false);
  });

  it('keeps focus-only custom document surfaces visible past ribbon truncation', () => {
    const ribbon = Array.from({ length: 130 }, (_, id) => ({
      id,
      role: 'Button',
      label: `Ribbon ${id}`,
      value: null,
      bounds: [0, 0, 20, 20] as [number, number, number, number],
      actions: ['Invoke'],
      depth: 2,
    }));
    const workspace = {
      id: 130,
      role: 'Pane',
      label: 'Workspace',
      value: null,
      bounds: [0, 180, 1_200, 700] as [number, number, number, number],
      actions: ['Focus'],
      depth: 3,
    };

    const selected = selectAxElementsForModel([...ribbon, workspace], 120);

    expect(selected[0]).toBe(workspace);
  });
});

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

  it.each(['click', 'move', 'scroll', 'drag'])('rejects Windows %s with missing/stale screenshot ID before Host or state consumption', async (action) => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    const key = { conversationId: 'strict-coordinate', loopId: `strict-${action}` };
    computerUseController.recordObservation(key, {
      stateId: 'state-coordinate', target: { windowRef: 'wr-coordinate', appName: 'Editor', bundleId: 'editor.exe', processId: 42 },
      axSessionId: 'ax-coordinate', elements: [], capabilityTier: 'full',
    });
    computerObservationContexts.record(key, { windowRef: 'wr-coordinate', stateId: 'state-coordinate',
      screenshotId: 'shot-coordinate', scaleFactor: 1, origin: { x: 0, y: 0 } });
    for (const screenshot_id of [undefined, null, '', 42, 'shot-other']) {
      const result = await computerTool.execute({ action, x: 10, y: 20, startX: 10, startY: 20, endX: 30, endY: 40,
        window_ref: 'wr-coordinate', expected_state_id: 'state-coordinate', screenshot_id, consequence: 'none' },
      { ...key, toolCallId: 'coordinate', interactionMode: 'foreground', supportsVision: true });
      expect(String(result)).toContain('screenshot_id');
      expect(invoke).not.toHaveBeenCalled();
    }
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') return Promise.resolve({ accessibility: true, screen_recording: true });
      if (cmd === 'computer_use_begin_session') return Promise.resolve({ status: 'authorized', token: 'coordinate-token',
        target: { window_ref: 'wr-coordinate', app_name: 'Editor', bundle_id: 'editor.exe', process_id: 42, relation: 'root' },
        classification: 'ordinary', expires_at: 61000 });
      if (cmd === 'ax_snapshot') return Promise.resolve({ session_id: 'ax-coordinate-next', state_id: 'state-coordinate-next',
        app: 'Editor', total_visited: 0, truncated: false, elements: [] });
      if (cmd.startsWith('capture_screen')) return Promise.resolve({ base64: 'iVBORw0KGgo=', width: 100, height: 100,
        scale_factor: 1, origin_x: 0, origin_y: 0, screenshot_id: 'shot-coordinate-next' });
      return Promise.resolve('ok');
    });
    await computerTool.execute({ action, x: 10, y: 20, startX: 10, startY: 20, endX: 30, endY: 40,
      direction: 'down', window_ref: 'wr-coordinate', expected_state_id: 'state-coordinate',
      screenshot_id: 'shot-coordinate', consequence: 'none' },
    { ...key, toolCallId: 'valid-coordinate', interactionMode: 'foreground', supportsVision: true });
    // Correcting only the image reference must still execute against the
    // unconsumed observation, through the same token-bound native boundary.
    expect(vi.mocked(invoke).mock.calls).toContainEqual([`mouse_${action}`,
      expect.objectContaining({ screenshotId: 'shot-coordinate', __abuComputerUseToken: 'coordinate-token' })]);
  });

  it('lists visible windows as opaque candidates without opening an action session', async () => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'computer_use_list_windows') {
        return Promise.resolve({
          status: 'candidates',
          candidates: [
            { window_ref: 'wr-word-a', app_name: 'Word', title: 'Document A', relation: 'root' },
            { window_ref: 'wr-word-b', app_name: 'Word', title: 'Document B', relation: 'root' },
          ],
        });
      }
      return Promise.resolve(null);
    });

    const result = await computerTool.execute(
      { action: 'list_windows', app: 'Word', consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-list-windows',
        toolCallId: 'tool-list-windows',
        interactionMode: 'foreground',
      },
    );

    expect(String(result)).toContain('window_ref: wr-word-a');
    expect(String(result)).toContain('window_ref: wr-word-b');
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'computer_use_list_windows')).toBe(true);
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'computer_use_begin_session')).toBe(false);
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
    await expect(resultPromise).resolves.toMatch(/Computer Use|电脑操控/);
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
    await expect(resultPromise).resolves.toMatch(/Computer Use|电脑操控/);
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
    await expect(resultPromise).resolves.toMatch(/Computer Use|电脑操控/);
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

  it('Windows backend failure never recommends elevation or opens macOS Settings', async () => {
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
    expect(text).toContain('Windows Computer Use');
    expect(text.toLowerCase()).not.toContain('administrator');
    expect(text.toLowerCase()).not.toContain('elevation');
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

    expect(result as string).toMatch(/Accessibility|辅助功能/);
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
          status: 'authorized',
          token: 'task-owned-token',
          target: {
            window_ref: 'wr-finder-task',
            app_name: 'Finder',
            bundle_id: 'com.apple.finder',
            process_id: 1,
            relation: 'root',
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

  it.each([
    { type: 'element-appears' },
    { type: 'element-appears', role: '' },
    { type: 'element-appears', label: '   ' },
    { type: 'element-appears', role: '\t', label: '' },
  ])('rejects an empty element-appears matcher before native dispatch: %j', async (expected_effect) => {
    const result = await computerTool.execute({
      action: 'activate_app',
      app: 'Notes',
      consequence: 'none',
      expected_effect,
    }, {
      conversationId: 'invalid-element-appears',
      loopId: 'invalid-element-appears-loop',
      toolCallId: 'invalid-element-appears-tool',
      interactionMode: 'foreground',
    });

    expect(String(result)).toContain('expected_effect');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reuses the observed app grant for a later screenshot in the same run', async () => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    const beginRequests: Array<Record<string, unknown>> = [];
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({ app_name: 'Word', bundle_id: 'winword.exe', process_id: 42 });
      }
      if (cmd === 'computer_use_begin_session') {
        beginRequests.push(args as Record<string, unknown>);
        return Promise.resolve({
          status: 'authorized',
          token: `token-${beginRequests.length}`,
          target: { window_ref: 'wr-word-reuse', app_name: 'Word', bundle_id: 'winword.exe', process_id: 42, relation: 'root' },
          classification: 'approval-required',
          expires_at: 20_000,
        });
      }
      if (cmd === 'activate_app') return Promise.resolve('Word');
      if (cmd === 'ax_snapshot') {
        return Promise.resolve({
          session_id: 'ax-word-reuse',
          state_id: 'state-word-reuse',
          app: 'Word',
          total_visited: 1,
          truncated: false,
          elements: [],
          input_epoch: 1,
          window_id: 'hwnd:0x42',
          accessibility_revision: 1,
        });
      }
      if (cmd === 'get_abu_window_id') return Promise.resolve(0);
      if (cmd === 'capture_screen_excluding') {
        return Promise.resolve({
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
          width: 1,
          height: 1,
          scale_factor: 1,
          origin_x: 0,
          origin_y: 0,
          screenshot_id: 'shot-word-reuse',
        });
      }
      return Promise.resolve(null);
    });
    const context = {
      conversationId: 'active-conversation',
      loopId: 'loop-grant-reuse',
      interactionMode: 'foreground' as const,
      supportsVision: false,
    };

    await computerTool.execute(
      { action: 'get_app_state', app: 'Word', consequence: 'none' },
      { ...context, toolCallId: 'tool-observe-word' },
    );
    await computerTool.execute(
      { action: 'screenshot', consequence: 'none', show_user: false },
      { ...context, toolCallId: 'tool-screenshot-word', supportsVision: true },
    );

    expect(beginRequests).toHaveLength(2);
    expect(beginRequests[1]).toMatchObject({
      scope: 'ui-control',
      targetApp: 'Word',
      actionIntent: { action: 'screenshot', category: 'none' },
    });
  });

  it('keeps a recovery screenshot target-bound when observation failed after naming an app', async () => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    const beginRequests: Array<Record<string, unknown>> = [];
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity') {
        return Promise.resolve({ app_name: 'Editor', bundle_id: 'editor.exe', process_id: 42 });
      }
      if (cmd === 'computer_use_begin_session') {
        beginRequests.push(args as Record<string, unknown>);
        return Promise.resolve({
          status: 'authorized',
          token: `token-${beginRequests.length}`,
          target: { window_ref: 'wr-editor-recovery', app_name: 'Editor', bundle_id: 'editor.exe', process_id: 42, relation: 'root' },
          classification: 'approval-required',
          expires_at: 20_000,
        });
      }
      if (cmd === 'activate_app') return Promise.resolve('Editor');
      if (cmd === 'ax_snapshot') return Promise.reject(new Error('temporary observation failure'));
      if (cmd === 'get_abu_window_id') return Promise.resolve(0);
      if (cmd === 'capture_screen_excluding') {
        return Promise.resolve({
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
          width: 1,
          height: 1,
          scale_factor: 1,
          origin_x: 0,
          origin_y: 0,
          screenshot_id: 'shot-editor-recovery',
        });
      }
      return Promise.resolve(null);
    });
    const context = {
      conversationId: 'target-recovery-conversation',
      loopId: 'target-recovery-loop',
      interactionMode: 'foreground' as const,
      supportsVision: false,
    };

    const observation = await computerTool.execute(
      { action: 'get_app_state', app: 'Editor', consequence: 'none' },
      { ...context, toolCallId: 'observe-editor' },
    );
    await computerTool.execute(
      { action: 'screenshot', app: 'Editor', consequence: 'none', show_user: false },
      { ...context, toolCallId: 'screenshot-editor', supportsVision: true },
    );

    expect(beginRequests).toHaveLength(2);
    expect(beginRequests[1]).toMatchObject({
      scope: 'ui-control',
      targetApp: 'Editor',
    });
    expect(String(observation)).toMatch(/^Error:/);
  });

  it.each(['named-app', 'window-ref'])('observes after activation and uses guarded Windows text replacement (%s)', async (selection) => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    let snapshotCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity') {
        return Promise.resolve({ app_name: 'Editor', bundle_id: 'editor.exe', process_id: 42 });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: `token-${snapshotCount}`,
          target: { window_ref: 'wr-editor-visible', app_name: 'Editor', bundle_id: 'editor.exe', process_id: 42, relation: 'root' },
          classification: 'approval-required',
          expires_at: 20_000,
        });
      }
      if (cmd === 'activate_app') return Promise.resolve('Editor');
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `ax-editor-${snapshotCount}`,
          state_id: `state-editor-${snapshotCount}`,
          app: 'Editor',
          total_visited: 1,
          truncated: false,
          input_epoch: 1,
          window_id: 'hwnd:0x42',
          accessibility_revision: snapshotCount,
          elements: [{
            id: 7,
            role: 'Document',
            label: 'Document',
            value: snapshotCount === 1 ? 'old' : 'new',
            bounds: [10, 20, 100, 30],
            actions: ['SetValue', 'Focus'],
            depth: 2,
            focused: true,
          }],
        });
      }
      return Promise.resolve(null);
    });
    const context = {
      conversationId: 'windows-visible-text-conversation',
      loopId: 'windows-visible-text-loop',
      interactionMode: 'foreground' as const,
      supportsVision: false,
    };
    const observed = await computerTool.execute(
      { action: 'get_window_state', ...(selection === 'named-app' ? { app: 'Editor' } : { window_ref: 'wr-editor-visible' }), consequence: 'none' },
      { ...context, toolCallId: 'observe-editor' },
    );
    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(commands.indexOf('activate_app')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('activate_app')).toBeLessThan(commands.indexOf('ax_snapshot'));
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];

    await computerTool.execute({
      action: 'type',
      element_id: 7,
      text: 'new',
      window_ref: 'wr-editor-visible',
      expected_state_id: stateId,
      expected_effect: { type: 'element-value', element_id: 7, equals: 'new' },
      consequence: 'none',
    }, { ...context, toolCallId: 'type-editor' });

    expect(vi.mocked(invoke).mock.calls).toContainEqual([
      'ax_replace_text',
      expect.objectContaining({ sessionId: 'ax-editor-1', elementId: 7, text: 'new' }),
    ]);
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'ax_set_value')).toBe(false);
  });

  it('warns instead of inviting retries when Office reports that editing is disabled', async () => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({ app_name: 'POWERPNT', bundle_id: 'powerpnt.exe', process_id: 42 });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'token-unlicensed-office',
          target: { window_ref: 'wr-powerpoint', app_name: 'POWERPNT', bundle_id: 'powerpnt.exe', process_id: 42, relation: 'root' },
          classification: 'approval-required',
          expires_at: 20_000,
        });
      }
      if (cmd === 'activate_app') return Promise.resolve('POWERPNT');
      if (cmd === 'ax_snapshot') {
        return Promise.resolve({
          session_id: 'ax-unlicensed-office',
          app: 'POWERPNT',
          total_visited: 2,
          truncated: false,
          elements: [{
            id: 0,
            role: 'Window',
            label: 'Presentation1 - PowerPoint (Unlicensed Product)',
            value: null,
            bounds: [0, 0, 1280, 720],
            actions: ['Focus'],
            depth: 0,
          }],
          input_epoch: 1,
          window_id: 'hwnd:0x42',
          accessibility_revision: 1,
        });
      }
      return Promise.resolve(null);
    });

    const result = await computerTool.execute(
      { action: 'get_app_state', app: 'POWERPNT', consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-unlicensed-office',
        toolCallId: 'tool-unlicensed-office',
        interactionMode: 'foreground',
        supportsVision: false,
      },
    );

    expect(String(result)).toMatch(/Unlicensed Product|未经授权产品/);
    expect(String(result)).toMatch(/Do not keep clicking|不要继续点击/);
  });

  it('reports a missing named window as target-unavailable and never falls back to Abu', async () => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    const beginRequests: Array<Record<string, unknown>> = [];
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity') {
        return Promise.resolve({
          app_name: 'electron',
          bundle_id: 'F:\\Abu\\Abu-Cowork\\node_modules\\electron\\dist\\electron.exe',
          process_id: 10224,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        beginRequests.push(args as Record<string, unknown>);
        return Promise.reject(new Error("app 'Word' has no visible window"));
      }
      return Promise.resolve(null);
    });
    const context = {
      conversationId: 'active-conversation',
      loopId: 'loop-missing-word',
      interactionMode: 'foreground' as const,
      supportsVision: false,
      reportMetadata: vi.fn(),
    };

    const first = await computerTool.execute(
      { action: 'get_app_state', app: 'Word', consequence: 'none' },
      { ...context, toolCallId: 'tool-missing-word-1' },
    );
    const second = await computerTool.execute(
      { action: 'get_app_state', app: 'Word', consequence: 'none' },
      { ...context, toolCallId: 'tool-missing-word-2' },
    );

    expect(String(first)).toContain('Word');
    expect(String(first)).not.toMatch(/授权未通过|authorization was not granted/i);
    expect(String(second)).toContain('Word');
    expect(beginRequests).toHaveLength(2);
    expect(beginRequests[0]).toMatchObject({ targetApp: 'Word' });
    expect(beginRequests[1]).toMatchObject({ targetApp: 'Word' });
    expect(context.reportMetadata).toHaveBeenCalledTimes(2);
    expect(context.reportMetadata).toHaveBeenCalledWith({
      requiresUserRecovery: 'computer-target-unavailable',
    });
  });

  it('sends WindowRef-first selectors and preserves structured target errors for the tool executor', async () => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    let beginRequest: Record<string, unknown> | undefined;
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({ app_name: 'Word', bundle_id: 'winword.exe', process_id: 42 });
      }
      if (cmd === 'computer_use_begin_session') {
        beginRequest = args as Record<string, unknown>;
        return Promise.resolve({
          status: 'target-error',
          error: {
            code: 'target-ambiguous',
            recoverable: true,
            next_action: 'select-target',
            candidates: [
              { window_ref: 'wr-document-a', app_name: 'Word', title: 'A', relation: 'root' },
              { window_ref: 'wr-document-b', app_name: 'Word', title: 'B', relation: 'root' },
            ],
          },
        });
      }
      return Promise.resolve(null);
    });

    const execution = computerTool.execute({
      action: 'get_app_state',
      app: 'Word',
      window_ref: 'wr-model-selected',
      target_selector: 'foreground-at-submit',
      consequence: 'none',
    }, {
      conversationId: 'active-conversation',
      loopId: 'loop-window-ref',
      toolCallId: 'tool-window-ref',
      interactionMode: 'foreground',
      supportsVision: false,
    });

    const result = await execution;
    expect(result).toEqual(expect.stringContaining('wr-document-a'));
    expect(result).toEqual(expect.stringContaining('wr-document-b'));
    expect(beginRequest).toMatchObject({
      windowRef: 'wr-model-selected',
      targetApp: 'Word',
      targetSelector: 'foreground-at-submit',
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
          status: 'authorized',
          token: 'task-owned-token',
          target: {
            window_ref: 'wr-finder-native',
            app_name: 'Finder',
            bundle_id: 'com.apple.finder',
            process_id: 42,
            relation: 'root',
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

  it('structured-mode model with no app name gets AX data for the Host-resolved frontmost app', async () => {
    // Repro: a non-vision model (e.g. deepseek-v4-flash) cannot see the screen, so it
    // has no way to name the app it wants observed. It must still be able to call
    // get_app_state with no `app`/`app_name` and land on the app the Host Gate already
    // resolved as frontmost for this session, instead of forwarding a null app name to
    // ax_snapshot and hitting the native "AX identity requires an explicit target app"
    // guard (accessibility_macos.rs ax_snapshot_impl).
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
          status: 'authorized',
          token: 'structured-no-app-token',
          target: {
            window_ref: 'wr-finder-structured',
            app_name: 'Finder',
            bundle_id: 'com.apple.finder',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        return Promise.resolve({
          session_id: 'ax-finder-structured',
          app: 'Finder',
          total_visited: 1,
          truncated: false,
          elements: [],
        });
      }
      return Promise.resolve(null);
    });

    const result = await computerTool.execute(
      { action: 'get_app_state', consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-structured-no-app',
        toolCallId: 'tool-structured-no-app',
        interactionMode: 'foreground',
        computerUseTier: 'structured',
        modelId: 'deepseek-v4-flash',
        supportsVision: false,
      },
    );

    expect(result as string).not.toContain('explicit target app');
    const axCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'ax_snapshot');
    expect(axCall?.[1]).toMatchObject({ appName: 'Finder' });
    // The Host-resolved fallback must not trigger activate_app: that raises every
    // window of the target app and adds a 250ms stall, which is unwanted for what
    // the model asked as a pure observe (no app named) — only an explicit app name
    // should raise windows.
    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(commands).not.toContain('activate_app');
  });

  it('treats a whitespace-only app name as absent and still falls back to the Host-resolved app', async () => {
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
          status: 'authorized',
          token: 'structured-whitespace-app-token',
          target: {
            window_ref: 'wr-finder-whitespace',
            app_name: 'Finder',
            bundle_id: 'com.apple.finder',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        return Promise.resolve({
          session_id: 'ax-finder-whitespace',
          app: 'Finder',
          total_visited: 1,
          truncated: false,
          elements: [],
        });
      }
      return Promise.resolve(null);
    });

    await computerTool.execute(
      { action: 'get_app_state', app: '   ', consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-whitespace-app',
        toolCallId: 'tool-whitespace-app',
        interactionMode: 'foreground',
        computerUseTier: 'structured',
        modelId: 'deepseek-v4-flash',
        supportsVision: false,
      },
    );

    const axCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'ax_snapshot');
    expect(axCall?.[1]).toMatchObject({ appName: 'Finder' });
    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    expect(commands).not.toContain('activate_app');
  });

  it('returns a structured manual handoff without recording a writable security state', async () => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({ app_name: 'Word', bundle_id: 'word.exe', process_id: 42 });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'manual-handoff-token',
          target: {
            window_ref: 'wr-word-manual',
            app_name: 'Word',
            bundle_id: 'word.exe',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        return Promise.resolve({
          app: 'Word',
          elements: [],
          modal: true,
          related_windows: [],
          protocol_error: {
            code: 'manual-handoff-required',
            recoverable: true,
            next_action: 'wait-for-user',
          },
        });
      }
      return Promise.resolve(null);
    });
    const context = {
      conversationId: 'manual-handoff-conversation',
      loopId: 'manual-handoff-loop',
      interactionMode: 'foreground' as const,
      supportsVision: false,
    };

    const observed = await computerTool.execute(
      { action: 'get_window_state', window_ref: 'wr-word-manual', consequence: 'none' },
      { ...context, toolCallId: 'manual-handoff-observe' },
    );
    const write = await computerTool.execute(
      {
        action: 'key',
        key: 'Escape',
        window_ref: 'wr-word-manual',
        expected_state_id: 'not-a-state',
        consequence: 'none',
      },
      { ...context, toolCallId: 'manual-handoff-write' },
    );

    expect(String(observed)).toMatch(/manual handoff|人工接管/i);
    expect(String(write)).toMatch(/state_id/i);
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'keyboard_press')).toBe(false);
  });

  it('returns manual handoff and no next_state when verification reaches a security surface', async () => {
    setElectronHost(true);
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    let snapshotCount = 0;
    let keyCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({ app_name: 'Word', bundle_id: 'word.exe', process_id: 42 });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized', token: `manual-after-token-${snapshotCount}`,
          target: { window_ref: 'wr-word-after-manual', app_name: 'Word', bundle_id: 'word.exe', process_id: 42, relation: 'root' },
          classification: 'ordinary', expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          return Promise.resolve({
            session_id: 'ax-before-manual', state_id: 'state-before-manual', app: 'Word',
            total_visited: 0, truncated: false, elements: [],
          });
        }
        return Promise.resolve({
          app: 'Word', elements: [], modal: true, related_windows: [],
          protocol_error: { code: 'manual-handoff-required', recoverable: true, next_action: 'wait-for-user' },
        });
      }
      if (cmd === 'keyboard_press') {
        keyCount += 1;
        return Promise.resolve('pressed');
      }
      return Promise.resolve(null);
    });
    const context = {
      conversationId: 'manual-after-conversation',
      loopId: 'manual-after-loop',
      interactionMode: 'foreground' as const,
      supportsVision: false,
    };
    const observed = await computerTool.execute(
      { action: 'get_window_state', window_ref: 'wr-word-after-manual', consequence: 'none' },
      { ...context, toolCallId: 'manual-after-observe' },
    );
    const stateId = String(observed).match(/state_id:\s*(\S+)/)?.[1];

    const result = await computerTool.execute(
      {
        action: 'key', key: 'ArrowRight', window_ref: 'wr-word-after-manual',
        expected_state_id: stateId, consequence: 'none',
      },
      { ...context, toolCallId: 'manual-after-write' },
    );

    expect(String(result)).toMatch(/manual handoff|人工接管/i);
    expect(String(result)).not.toContain('next_state:');
    expect(keyCount).toBe(1);
  });

  it('uses native Windows identity, UIA observation, and one-shot state for input', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    setElectronHost(true);
    let snapshotCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'notepad',
          bundle_id: 'C:\\Windows\\System32\\notepad.exe',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'windows-task-token',
          target: {
            window_ref: 'wr-notepad-task',
            app_name: 'notepad',
            bundle_id: 'C:\\Windows\\System32\\notepad.exe',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `windows-ax-${snapshotCount}`,
          state_id: `windows-state-${snapshotCount}`,
          app: 'notepad',
          total_visited: 0,
          truncated: false,
          related_windows: snapshotCount === 1 ? [{
            window_ref: 'wr-notepad-dialog',
            app_name: 'notepad',
            relation: 'modal',
          }] : [],
          elements: snapshotCount === 1 ? [] : [{
            id: 9,
            role: 'Document',
            label: 'Editor',
            value: 'after key',
            bounds: [0, 0, 100, 100],
            actions: ['Focus'],
            depth: 1,
          }],
        });
      }
      if (cmd === 'keyboard_press') return Promise.resolve('pressed');
      return Promise.resolve(null);
    });

    const context = {
      conversationId: 'active-conversation',
      loopId: 'loop-windows-identity',
      interactionMode: 'foreground' as const,
      supportsVision: false,
    };
    const observed = await computerTool.execute(
      { action: 'get_app_state', target_selector: 'foreground-at-submit', consequence: 'none' },
      { ...context, toolCallId: 'tool-windows-observe' },
    );
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];
    expect(stateId).toBe('windows-state-1');
    expect(String(observed)).toContain('window_ref=wr-notepad-dialog');

    const missingWindowRef = await computerTool.execute(
      { action: 'key', key: 'ArrowRight', expected_state_id: stateId, consequence: 'none' },
      { ...context, toolCallId: 'tool-windows-missing-ref' },
    );
    expect(String(missingWindowRef)).toMatch(/window_ref|目标窗口/i);
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'keyboard_press')).toBe(false);

    const actionResult = await computerTool.execute(
      {
        action: 'key',
        key: 'ArrowRight',
        window_ref: 'wr-notepad-task',
        expected_state_id: stateId,
        consequence: 'none',
      },
      { ...context, toolCallId: 'tool-windows-identity' },
    );

    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
    const beginRequests = vi.mocked(invoke).mock.calls
      .filter(([cmd]) => cmd === 'computer_use_begin_session')
      .map(([, args]) => args as Record<string, unknown>);
    expect(beginRequests[0]).toMatchObject({
      windowRef: null,
      targetSelector: 'foreground-at-submit',
    });
    expect(beginRequests[1]).toMatchObject({
      windowRef: 'wr-notepad-task',
      targetApp: 'notepad',
    });
    expect(commands).toContain('frontmost_app_identity');
    expect(commands).toContain('keyboard_press');
    expect(commands).not.toContain('get_active_window');
    expect(commands).toContain('ax_snapshot');
    expect(String(actionResult)).toContain('next_state:');
    expect(String(actionResult)).toContain('window_ref: wr-notepad-task');
    expect(String(actionResult)).toContain('state_id: windows-state-2');
    expect(String(actionResult)).toContain('[9] Document');
  });

  it('does not replay a Windows action whose native outcome is unknown', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    setElectronHost(true);
    let snapshotCount = 0;
    let keyCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'notepad',
          bundle_id: 'C:\\Windows\\System32\\notepad.exe',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'windows-unknown-token',
          target: {
            window_ref: 'wr-notepad-unknown',
            app_name: 'notepad',
            bundle_id: 'C:\\Windows\\System32\\notepad.exe',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `windows-unknown-ax-${snapshotCount}`,
          state_id: `windows-unknown-state-${snapshotCount}`,
          app: 'notepad',
          total_visited: 0,
          truncated: false,
          elements: [],
        });
      }
      if (cmd === 'keyboard_press') {
        keyCount += 1;
        return Promise.reject(new Error("Computer Use outcome is unknown after 'keyboard_press'"));
      }
      if (cmd === 'computer_use_get_task_status') {
        return Promise.resolve({
          active: true,
          stopped: false,
          stopped_reason: null,
          outcome_unknown_receipt: {
            status: 'outcome-unknown',
            command: 'keyboard_press',
            before_state_id: 'windows-unknown-state-1',
            attempt_count: 1,
            consequential: false,
            decision: 'observe-required',
          },
        });
      }
      return Promise.resolve(null);
    });

    const context = {
      conversationId: 'active-conversation',
      loopId: 'loop-windows-unknown',
      interactionMode: 'foreground' as const,
      supportsVision: false,
    };
    const observed = await computerTool.execute(
      { action: 'get_app_state', consequence: 'none' },
      { ...context, toolCallId: 'tool-windows-unknown-observe' },
    );
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];

    const result = await computerTool.execute(
      {
        action: 'key',
        key: 'ArrowRight',
        window_ref: 'wr-notepad-unknown',
        expected_state_id: stateId,
        consequence: 'none',
      },
      { ...context, toolCallId: 'tool-windows-unknown-action' },
    );

    expect(String(result)).toMatch(/outcome is unknown|结果.*不确定/i);
    expect(keyCount).toBe(1);
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'computer_use_get_task_status')).toBe(true);
  });

  it('re-observes once after a Windows action the helper refused before dispatch, then hands off', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    setElectronHost(true);
    const runKey = { conversationId: 'active-conversation', loopId: 'loop-windows-refused' };
    recoveryBudget.clear(runBudgetKey(runKey));
    let snapshotCount = 0;
    let keyCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'notepad',
          bundle_id: 'C:\\Windows\\System32\\notepad.exe',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'windows-refused-token',
          target: {
            window_ref: 'wr-notepad-refused',
            app_name: 'notepad',
            bundle_id: 'C:\\Windows\\System32\\notepad.exe',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `windows-refused-ax-${snapshotCount}`,
          state_id: `windows-refused-state-${snapshotCount}`,
          app: 'notepad',
          total_visited: 0,
          truncated: false,
          elements: [],
        });
      }
      if (cmd === 'keyboard_press') {
        keyCount += 1;
        return Promise.reject(new Error('frontmost target changed; observe again'));
      }
      if (cmd === 'computer_use_get_task_status') {
        return Promise.resolve({
          active: true,
          stopped: false,
          stopped_reason: null,
          outcome_unknown_receipt: null,
          not_executed_receipt: {
            status: 'not-executed',
            execution: 'not-executed',
            helper_code: 'target-changed',
            retryable: true,
            command: 'keyboard_press',
            before_state_id: `windows-refused-state-${snapshotCount}`,
            attempt_count: keyCount,
            consequential: false,
            decision: 'observe-required',
          },
        });
      }
      return Promise.resolve(null);
    });

    const reportMetadata = vi.fn();
    const context = {
      ...runKey,
      interactionMode: 'foreground' as const,
      supportsVision: false,
      reportMetadata,
    };
    const observeStateId = async (toolCallId: string) => {
      const observed = await computerTool.execute(
        { action: 'get_app_state', consequence: 'none' },
        { ...context, toolCallId },
      );
      return String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];
    };
    const press = (toolCallId: string, stateId: string | undefined) => computerTool.execute(
      {
        action: 'key',
        key: 'ArrowRight',
        window_ref: 'wr-notepad-refused',
        expected_state_id: stateId,
        consequence: 'none',
      },
      { ...context, toolCallId },
    );

    // First refusal: nothing reached the app, so the model is told to observe
    // again — not that the outcome is uncertain, and not to hand off.
    const first = await press('tool-refused-1', await observeStateId('tool-refused-observe-1'));
    expect(String(first)).toMatch(/not executed|没有执行/i);
    expect(String(first)).not.toMatch(/outcome is unknown|结果.*不确定/i);
    expect(reportMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ requiresUserRecovery: expect.anything() }),
    );
    expect(keyCount).toBe(1);
    // The tool re-observed on the model's behalf: the fresh state is part of
    // the same result, so the model's next call can already be an action.
    expect(String(first)).toContain('windows-refused-state-2');
    expect(snapshotCount).toBe(2);

    // Same refusal again with no verified progress in between: the per-event
    // budget is spent, so the run hands off to the user instead of looping.
    const second = await press('tool-refused-2', await observeStateId('tool-refused-observe-2'));
    expect(String(second)).toMatch(/recovery budget|自动恢复次数/i);
    expect(reportMetadata).toHaveBeenCalledWith({ requiresUserRecovery: 'computer-target-unavailable' });
    expect(keyCount).toBe(2);
  });

  it('hands the turn back as a pause when the user takes over mid-action', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    setElectronHost(true);
    const runKey = { conversationId: 'active-conversation', loopId: 'loop-windows-takeover' };
    recoveryBudget.clear(runBudgetKey(runKey));
    let snapshotCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'notepad',
          bundle_id: 'C:\\Windows\\System32\\notepad.exe',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'windows-takeover-token',
          target: {
            window_ref: 'wr-notepad-takeover',
            app_name: 'notepad',
            bundle_id: 'C:\\Windows\\System32\\notepad.exe',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `windows-takeover-ax-${snapshotCount}`,
          state_id: `windows-takeover-state-${snapshotCount}`,
          app: 'notepad',
          total_visited: 0,
          truncated: false,
          elements: [],
        });
      }
      if (cmd === 'keyboard_press') {
        // The Host revoked the task and stopped the helper mid-dispatch.
        return Promise.reject(new Error('native helper exited during dispatch'));
      }
      if (cmd === 'computer_use_get_task_status') {
        return Promise.resolve({
          active: false,
          stopped: true,
          stopped_reason: 'user-input-detected',
          outcome_unknown_receipt: null,
          not_executed_receipt: null,
        });
      }
      return Promise.resolve(null);
    });

    const reportMetadata = vi.fn();
    const context = {
      ...runKey,
      interactionMode: 'foreground' as const,
      supportsVision: false,
      reportMetadata,
    };
    const observed = await computerTool.execute(
      { action: 'get_app_state', consequence: 'none' },
      { ...context, toolCallId: 'tool-takeover-observe' },
    );
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];
    const result = await computerTool.execute(
      {
        action: 'key',
        key: 'ArrowRight',
        window_ref: 'wr-notepad-takeover',
        expected_state_id: stateId,
        consequence: 'none',
      },
      { ...context, toolCallId: 'tool-takeover-press' },
    );
    // A pause, not a stop and not an error the model should work around:
    // resumable copy, the turn handed back, nothing re-observed on its own.
    expect(String(result)).toMatch(/Paused|已暂停/);
    expect(String(result)).toMatch(/continue|继续/);
    expect(reportMetadata).toHaveBeenCalledWith({ requiresUserRecovery: 'computer-user-takeover' });
    expect(snapshotCount).toBe(1);
  });

  it('hands the turn back with boundary copy when the helper refuses at a platform boundary', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    setElectronHost(true);
    const runKey = { conversationId: 'active-conversation', loopId: 'loop-windows-boundary' };
    recoveryBudget.clear(runBudgetKey(runKey));
    let snapshotCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'notepad',
          bundle_id: 'C:\\Windows\\System32\\notepad.exe',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'windows-boundary-token',
          target: {
            window_ref: 'wr-windows-boundary',
            app_name: 'notepad',
            bundle_id: 'C:\\Windows\\System32\\notepad.exe',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `windows-boundary-ax-${snapshotCount}`,
          state_id: `windows-boundary-state-${snapshotCount}`,
          app: 'notepad',
          total_visited: 0,
          truncated: false,
          elements: [],
        });
      }
      if (cmd === 'keyboard_press') {
        return Promise.reject(new Error('target has higher Windows integrity; input is blocked by UIPI'));
      }
      if (cmd === 'computer_use_get_task_status') {
        return Promise.resolve({
          active: true,
          stopped: false,
          stopped_reason: null,
          outcome_unknown_receipt: null,
          not_executed_receipt: {
            status: 'not-executed',
            execution: 'not-executed',
            helper_code: 'higher-integrity',
            retryable: false,
            command: 'keyboard_press',
            before_state_id: `windows-boundary-state-${snapshotCount}`,
            attempt_count: 1,
            consequential: false,
            decision: 'observe-required',
          },
        });
      }
      return Promise.resolve(null);
    });

    const reportMetadata = vi.fn();
    const context = {
      ...runKey,
      interactionMode: 'foreground' as const,
      supportsVision: false,
      reportMetadata,
    };
    const observed = await computerTool.execute(
      { action: 'get_app_state', consequence: 'none' },
      { ...context, toolCallId: 'tool-windows-boundary-observe' },
    );
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];
    expect(stateId).toBe('windows-boundary-state-1');
    const press = computerTool.execute(
      {
        action: 'key',
        key: 'ArrowRight',
        window_ref: 'wr-windows-boundary',
        expected_state_id: stateId,
        consequence: 'none',
      },
      { ...context, toolCallId: 'tool-windows-boundary-press' },
    );

    // Non-retryable and a known boundary: no observation is taken on the
    // model's behalf, no recovery is spent, and the copy tells the user what
    // to do about an elevated window.
    const result = await press;
    expect(String(result)).toMatch(/administrator|管理员/);
    expect(String(result)).toContain('blocked by UIPI');
    expect(reportMetadata).toHaveBeenCalledWith({ requiresUserRecovery: 'computer-platform-boundary' });
    expect(snapshotCount).toBe(1);
  });

  it('returns a non-retryable refusal that is the model\'s to fix without spending recovery', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    setElectronHost(true);
    const runKey = { conversationId: 'active-conversation', loopId: 'loop-windows-model-error' };
    recoveryBudget.clear(runBudgetKey(runKey));
    let snapshotCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'notepad',
          bundle_id: 'C:\\Windows\\System32\\notepad.exe',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'windows-model-error-token',
          target: {
            window_ref: 'wr-windows-model-error',
            app_name: 'notepad',
            bundle_id: 'C:\\Windows\\System32\\notepad.exe',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `windows-model-error-ax-${snapshotCount}`,
          state_id: `windows-model-error-state-${snapshotCount}`,
          app: 'notepad',
          total_visited: 0,
          truncated: false,
          elements: [],
        });
      }
      if (cmd === 'keyboard_press') {
        return Promise.reject(new Error('target keyboard layout cannot resolve requested key'));
      }
      if (cmd === 'computer_use_get_task_status') {
        return Promise.resolve({
          active: true,
          stopped: false,
          stopped_reason: null,
          outcome_unknown_receipt: null,
          not_executed_receipt: {
            status: 'not-executed',
            execution: 'not-executed',
            helper_code: 'key-unavailable',
            retryable: false,
            command: 'keyboard_press',
            before_state_id: `windows-model-error-state-${snapshotCount}`,
            attempt_count: 1,
            consequential: false,
            decision: 'observe-required',
          },
        });
      }
      return Promise.resolve(null);
    });

    const reportMetadata = vi.fn();
    const context = {
      ...runKey,
      interactionMode: 'foreground' as const,
      supportsVision: false,
      reportMetadata,
    };
    const observed = await computerTool.execute(
      { action: 'get_app_state', consequence: 'none' },
      { ...context, toolCallId: 'tool-windows-model-error-observe' },
    );
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];
    expect(stateId).toBe('windows-model-error-state-1');
    const press = computerTool.execute(
      {
        action: 'key',
        key: 'ArrowRight',
        window_ref: 'wr-windows-model-error',
        expected_state_id: stateId,
        consequence: 'none',
      },
      { ...context, toolCallId: 'tool-windows-model-error-press' },
    );

    // Not a boundary: the error goes back to the model as-is (it should use
    // `type`), with no re-observation and no hand-off.
    await expect(press).rejects.toThrow(/cannot resolve requested key/);
    expect(snapshotCount).toBe(1);
    expect(reportMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ requiresUserRecovery: expect.anything() }),
    );
  });

  it('ignores a not-executed receipt written against a different state_id', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    setElectronHost(true);
    const runKey = { conversationId: 'active-conversation', loopId: 'loop-windows-stale-receipt' };
    recoveryBudget.clear(runBudgetKey(runKey));
    let snapshotCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'notepad',
          bundle_id: 'C:\\Windows\\System32\\notepad.exe',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'windows-stale-token',
          target: {
            window_ref: 'wr-notepad-stale',
            app_name: 'notepad',
            bundle_id: 'C:\\Windows\\System32\\notepad.exe',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `windows-stale-ax-${snapshotCount}`,
          state_id: `windows-stale-state-${snapshotCount}`,
          app: 'notepad',
          total_visited: 0,
          truncated: false,
          elements: [],
        });
      }
      if (cmd === 'keyboard_press') {
        return Promise.reject(new Error('Computer Use run is stopped (stop-no-progress)'));
      }
      if (cmd === 'computer_use_get_task_status') {
        // A leftover receipt from an earlier action in the same run.
        return Promise.resolve({
          active: true,
          stopped: false,
          stopped_reason: null,
          outcome_unknown_receipt: null,
          not_executed_receipt: {
            status: 'not-executed',
            execution: 'not-executed',
            helper_code: 'target-changed',
            retryable: true,
            command: 'keyboard_press',
            before_state_id: 'windows-stale-state-0',
            attempt_count: 1,
            consequential: false,
            decision: 'observe-required',
          },
        });
      }
      return Promise.resolve(null);
    });

    const reportMetadata = vi.fn();
    const context = {
      ...runKey,
      interactionMode: 'foreground' as const,
      supportsVision: false,
      reportMetadata,
    };
    const observed = await computerTool.execute(
      { action: 'get_app_state', consequence: 'none' },
      { ...context, toolCallId: 'tool-stale-observe' },
    );
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];
    expect(stateId).toBe('windows-stale-state-1');

    // The receipt is not this action's verdict, so the error stands as-is:
    // no recovery spent, no observation taken on the model's behalf.
    await expect(computerTool.execute(
      {
        action: 'key',
        key: 'ArrowRight',
        window_ref: 'wr-notepad-stale',
        expected_state_id: stateId,
        consequence: 'none',
      },
      { ...context, toolCallId: 'tool-stale-press' },
    )).rejects.toThrow(/run is stopped/);
    expect(snapshotCount).toBe(1);
    expect(reportMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ requiresUserRecovery: expect.anything() }),
    );
  });

  it('shows the model one line of the driver declaration in every observation', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(isMacOS).mockReturnValue(false);
    setElectronHost(true);
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({
          app_name: 'notepad',
          bundle_id: 'C:\\Windows\\System32\\notepad.exe',
          process_id: 42,
        });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: 'windows-driver-token',
          target: {
            window_ref: 'wr-notepad-driver',
            app_name: 'notepad',
            bundle_id: 'C:\\Windows\\System32\\notepad.exe',
            process_id: 42,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
          driver: {
            id: 'windows-uia',
            declared: true,
            input: {
              foreground_required: true,
              background_element_actions: false,
              unicode_text: true,
              chords: true,
              ime_aware: false,
              physical_input_monitoring: true,
            },
            capture: { display: 'wgc-monitor', occluded_window: false, excludes_own_window: true },
            elements: { identity: 'runtime-id', empty_value: 'string', actions: ['Invoke'] },
            boundaries: ['secure-desktop'],
            activation: { can_activate_window: true },
          },
        });
      }
      if (cmd === 'ax_snapshot') {
        return Promise.resolve({
          session_id: 'windows-driver-ax-1',
          state_id: 'windows-driver-state-1',
          app: 'notepad',
          total_visited: 0,
          truncated: false,
          elements: [],
        });
      }
      return Promise.resolve(null);
    });

    const observed = await computerTool.execute(
      { action: 'get_app_state', consequence: 'none' },
      {
        conversationId: 'active-conversation',
        loopId: 'loop-windows-driver',
        interactionMode: 'foreground' as const,
        supportsVision: false,
        toolCallId: 'tool-windows-driver',
      },
    );
    expect(String(observed)).toContain(
      'driver: windows-uia; input=foreground-only; element-identity=stable; ime=unknown; occluded-capture=no',
    );
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
          status: 'authorized',
          token: 'task-owned-token',
          target: {
            window_ref: 'wr-notes-abort',
            app_name: 'Notes',
            bundle_id: 'com.apple.Notes',
            process_id: 1,
            relation: 'root',
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
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];
    expect(stateId).toBeTruthy();

    await expect(computerTool.execute(
      {
        action: 'click',
        x: 10,
        y: 10,
        window_ref: 'wr-notes-abort',
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
          status: 'authorized',
          token: `token-${snapshotCount}`,
          target: {
            window_ref: 'wr-notes-state',
            app_name: 'Notes',
            bundle_id: 'com.apple.Notes',
            process_id: 7,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `ax-${snapshotCount}`,
          state_id: `state-${snapshotCount}`,
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
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];
    expect(stateId).toBeTruthy();

    const action = await computerTool.execute({
      action: 'type',
      element_id: 1,
      text: 'Shawn',
      window_ref: 'wr-notes-state',
      expected_state_id: stateId,
      expected_effect: { type: 'element-value', element_id: 1, equals: 'Shawn' },
      consequence: 'none',
    }, { ...context, toolCallId: 'type' });

    expect(action).toContain('state-2');
    expect(vi.mocked(invoke).mock.calls).toContainEqual([
      'ax_set_value',
      expect.objectContaining({ sessionId: 'ax-1', elementId: 1 }),
    ]);

    const staleRetry = await computerTool.execute({
      action: 'type',
      element_id: 1,
      text: 'Shawn',
      window_ref: 'wr-notes-state',
      expected_state_id: stateId,
      consequence: 'none',
    }, { ...context, toolCallId: 'type-again' });

    expect(staleRetry).toContain('state_id');
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ax_set_value')).toHaveLength(1);
  });

  it('hands off immediately when an explicit expected effect is not satisfied', async () => {
    setElectronHost(true);
    let snapshotCount = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'frontmost_app_identity' || cmd === 'resolve_app_identity') {
        return Promise.resolve({ app_name: 'Notes', bundle_id: 'com.apple.Notes', process_id: 7 });
      }
      if (cmd === 'computer_use_begin_session') {
        return Promise.resolve({
          status: 'authorized',
          token: `token-mismatch-${snapshotCount}`,
          target: {
            window_ref: 'wr-notes-mismatch',
            app_name: 'Notes',
            bundle_id: 'com.apple.Notes',
            process_id: 7,
            relation: 'root',
          },
          classification: 'ordinary',
          expires_at: 61_000,
        });
      }
      if (cmd === 'ax_snapshot') {
        snapshotCount += 1;
        return Promise.resolve({
          session_id: `ax-mismatch-${snapshotCount}`,
          state_id: `state-mismatch-${snapshotCount}`,
          app: 'Notes',
          total_visited: 1,
          truncated: false,
          elements: [{
            id: 1,
            role: 'AXTextField',
            label: 'Draft',
            value: '',
            bounds: [10, 20, 100, 30],
            actions: ['AXSetValue'],
            depth: 2,
          }],
        });
      }
      return Promise.resolve('ok');
    });
    const reportMetadata = vi.fn();
    const context = {
      conversationId: 'expectation-mismatch-conversation',
      loopId: 'expectation-mismatch-loop',
      interactionMode: 'foreground' as const,
      supportsVision: false,
      reportMetadata,
    };

    const observed = await computerTool.execute(
      { action: 'get_window_state', window_ref: 'wr-notes-mismatch', consequence: 'none' },
      { ...context, toolCallId: 'observe-mismatch' },
    );
    const stateId = String(observed).match(/state_id[：:]\s*([^（(\s]+)/)?.[1];
    const action = await computerTool.execute({
      action: 'key',
      key: 'Escape',
      window_ref: 'wr-notes-mismatch',
      expected_state_id: stateId,
      expected_effect: { type: 'element-appears', role: 'AXDialog', label: 'Sent' },
      consequence: 'none',
    }, { ...context, toolCallId: 'key-mismatch' });

    expect(String(action)).toMatch(/expected effect was not satisfied|明确预期未满足/i);
    expect(reportMetadata).toHaveBeenCalledWith({
      requiresUserRecovery: 'computer-verification-mismatch',
    });
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
            status: 'authorized',
            token: `token-${app}`,
            target: {
              window_ref: `wr-${app.toLowerCase()}`,
              app_name: app,
              bundle_id: `test.${app.toLowerCase()}`,
              process_id: app === 'Notes' ? 11 : 22,
              relation: 'root',
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

  it('keeps screenshot transforms and guards isolated across two task contexts', async () => {
    setElectronHost(false);
    vi.mocked(isWindows).mockReturnValue(false);
    vi.mocked(isMacOS).mockReturnValue(true);
    let captureCount = 0;
    let moveArgs: Record<string, unknown> | undefined;
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'check_macos_permissions') {
        return Promise.resolve({ screen_recording: true, accessibility: true });
      }
      if (cmd === 'get_overlay_window_id') return Promise.resolve(1);
      if (cmd === 'capture_screen_excluding') {
        captureCount += 1;
        return Promise.resolve(captureCount === 1
          ? {
              base64: 'iVBORw0KGgo=', width: 100, height: 100,
              scale_factor: 2, origin_x: 100, origin_y: 50, screenshot_id: 'shot-a',
            }
          : {
              base64: 'iVBORw0KGgo=', width: 100, height: 100,
              scale_factor: 1, origin_x: 0, origin_y: 0, screenshot_id: 'shot-b',
            });
      }
      if (cmd === 'mouse_move') {
        moveArgs = args as Record<string, unknown>;
        return Promise.resolve('moved');
      }
      return Promise.resolve(null);
    });
    const contextA = {
      conversationId: 'screenshot-conversation-a', loopId: 'screenshot-loop-a',
      interactionMode: 'foreground' as const, supportsVision: true,
    };
    const contextB = {
      conversationId: 'screenshot-conversation-b', loopId: 'screenshot-loop-b',
      interactionMode: 'foreground' as const, supportsVision: true,
    };

    await computerTool.execute(
      { action: 'screenshot', consequence: 'none', show_user: false },
      { ...contextA, toolCallId: 'screenshot-a' },
    );
    await computerTool.execute(
      { action: 'screenshot', consequence: 'none', show_user: false },
      { ...contextB, toolCallId: 'screenshot-b' },
    );
    await computerTool.execute(
      { action: 'move', x: 10, y: 20, consequence: 'none' },
      { ...contextA, toolCallId: 'move-a' },
    );

    expect(moveArgs).toMatchObject({ x: 120, y: 90, screenshotId: 'shot-a' });
  });
});
