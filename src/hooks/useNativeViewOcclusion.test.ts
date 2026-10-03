// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drainCapabilitySetupRequests } from '@/core/capabilityPlugins/setupBridge';
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
    ['the close-window question', () => usePreviewStore.setState({ appModalOpen: true })],
  ])('still hides it for %s', (_name, open) => {
    const { result } = renderHook(() => useNativeViewOcclusion());
    act(() => { open(); });
    expect(result.current).toBe(true);
  });
});
