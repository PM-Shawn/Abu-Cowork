// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drainCapabilitySetupRequests, requestCapabilitySetup } from '@/core/capabilityPlugins/setupBridge';
import * as approvalBridge from '@/core/agent/ports/approvalBridge';
import { useChatStore } from '@/stores/chatStore';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useNativeViewOcclusion } from './useNativeViewOcclusion';

describe('useNativeViewOcclusion', () => {
  beforeEach(() => {
    approvalBridge.drainAll('command');
    approvalBridge.drainAll('file-permission');
    approvalBridge.drainAll('workspace');
    drainCapabilitySetupRequests();
    useChatStore.setState({ activeConversationId: 'active-conversation' });
    useSettingsStore.setState({ systemSettingsOpen: false });
    usePreviewStore.setState({ menuOpen: false, appModalOpen: false, dsModalOpen: false });
    useImageLightboxStore.getState().close();
  });
  afterEach(() => {
    cleanup();
    usePreviewStore.setState({ menuOpen: false, appModalOpen: false, dsModalOpen: false });
    useSettingsStore.setState({ systemSettingsOpen: false });
  });

  it('leaves the native view alone while nothing covers it', () => {
    const { result } = renderHook(() => useNativeViewOcclusion());
    expect(result.current).toBe(false);
  });

  it('hides the native view while a design-system dialog or question is open, and gives it back afterwards', () => {
    const { result } = renderHook(() => useNativeViewOcclusion());
    act(() => { usePreviewStore.getState().setDsModalOpen(true); });
    expect(result.current).toBe(true);
    act(() => { usePreviewStore.getState().setDsModalOpen(false); });
    expect(result.current).toBe(false);
  });

  it.each([
    ['the settings window', () => useSettingsStore.setState({ systemSettingsOpen: true })],
    ['a workspace menu', () => usePreviewStore.setState({ menuOpen: true })],
  ])('still hides it for %s', (_name, open) => {
    const { result } = renderHook(() => useNativeViewOcclusion());
    act(() => { open(); });
    expect(result.current).toBe(true);
  });

  // The windows below report through the layer registry (`dsModalOpen`) once they are on the
  // page. What asks or is open in a store, with no window on the page, covers nothing.
  const REQUESTS: Array<[string, (conversationId: string) => void]> = [
    ['a command approval', (conversationId) => {
      void approvalBridge.request('command', {
        conversationId,
        payload: { info: { command: 'pkill abu-e2e-no-such-process', level: 'warn', reason: 'test' } },
      });
    }],
    ['a path grant', (conversationId) => {
      void approvalBridge.request('file-permission', {
        conversationId,
        payload: { path: '/abu-e2e/no-such-file.txt', capability: 'write', toolName: 'write_file' },
      });
    }],
    ['a workspace request', (conversationId) => {
      void approvalBridge.request('workspace', { conversationId, payload: { reason: 'test' } });
    }],
    ['a task grant', (conversationId) => {
      void requestCapabilitySetup('computer', { conversationId, toolCallId: 'tool-call', interactionMode: 'foreground' });
    }],
  ];

  it.each(REQUESTS)('leaves it alone for %s whose window is not on the page, and hides it once the window is', (_name, ask) => {
    const { result } = renderHook(() => useNativeViewOcclusion());
    act(() => { ask('active-conversation'); });
    expect(result.current).toBe(false);
    act(() => { usePreviewStore.getState().setDsModalOpen(true); });
    expect(result.current).toBe(true);
  });

  it.each(REQUESTS)('leaves it alone for %s that waits for another conversation', (_name, ask) => {
    const { result } = renderHook(() => useNativeViewOcclusion());
    act(() => { ask('background-conversation'); });
    expect(result.current).toBe(false);
  });

  it('leaves it alone while the image viewer has no window on the page', () => {
    const { result } = renderHook(() => useNativeViewOcclusion());
    act(() => { useImageLightboxStore.getState().open([{ id: 'image', data: 'cG5n', mediaType: 'image/png' }], 0); });
    expect(result.current).toBe(false);
  });

  it('leaves it alone while the close question has no window on the page', () => {
    const { result } = renderHook(() => useNativeViewOcclusion());
    act(() => { usePreviewStore.setState({ appModalOpen: true }); });
    expect(result.current).toBe(false);
  });
});
