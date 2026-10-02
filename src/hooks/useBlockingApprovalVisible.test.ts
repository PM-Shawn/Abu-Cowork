// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useBlockingApprovalVisible } from './useBlockingApprovalVisible';

type Owned = { conversationId: string } | null;

const bridge = vi.hoisted(() => {
  const source = () => {
    const listeners = new Set<() => void>();
    const state = { pending: null as Owned };
    return {
      state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      get: () => state.pending,
      set: (next: Owned) => {
        state.pending = next;
        for (const listener of listeners) listener();
      },
    };
  };
  return { command: source(), file: source(), workspace: source(), capability: source() };
});

// The chat store imports the rest of both bridges, so only the six readers are replaced.
vi.mock('@/core/agent/permissionBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/agent/permissionBridge')>()),
  subscribeToCommandConfirmation: bridge.command.subscribe,
  getPendingCommandConfirmation: bridge.command.get,
  subscribeToFilePermission: bridge.file.subscribe,
  getPendingFilePermission: bridge.file.get,
  subscribeToWorkspaceRequest: bridge.workspace.subscribe,
  getPendingWorkspaceRequest: bridge.workspace.get,
}));

vi.mock('@/core/capabilityPlugins/setupBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/capabilityPlugins/setupBridge')>()),
  subscribeCapabilitySetup: bridge.capability.subscribe,
  getPendingCapabilitySetup: bridge.capability.get,
}));

describe('useBlockingApprovalVisible', () => {
  beforeEach(() => {
    useChatStore.setState({ activeConversationId: 'conversation-in-view' });
    usePreviewStore.setState({ appModalOpen: false });
    useSettingsStore.setState({ viewMode: 'chat' });
  });

  afterEach(() => {
    cleanup();
    for (const source of Object.values(bridge)) source.set(null);
    usePreviewStore.setState({ appModalOpen: false });
    useChatStore.setState({ activeConversationId: null });
    useSettingsStore.setState({ viewMode: 'chat' });
  });

  it('is false while nothing is waiting and the close-window question is not shown', () => {
    const { result } = renderHook(() => useBlockingApprovalVisible());
    expect(result.current).toBe(false);
  });

  it('is true while the close-window question is shown', () => {
    const { result } = renderHook(() => useBlockingApprovalVisible());
    act(() => usePreviewStore.setState({ appModalOpen: true }));
    expect(result.current).toBe(true);
  });

  it.each([
    ['a command approval', bridge.command],
    ['a file approval', bridge.file],
    ['a workspace approval', bridge.workspace],
  ])('is true for %s of the conversation in view, and false again once it is answered', (_name, source) => {
    const { result } = renderHook(() => useBlockingApprovalVisible());
    act(() => source.set({ conversationId: 'conversation-in-view' }));
    expect(result.current).toBe(true);
    act(() => source.set(null));
    expect(result.current).toBe(false);
  });

  it.each([
    ['a command approval', bridge.command],
    ['a file approval', bridge.file],
    ['a workspace approval', bridge.workspace],
  ])('stays false for %s of another conversation', (_name, source) => {
    const { result } = renderHook(() => useBlockingApprovalVisible());
    act(() => source.set({ conversationId: 'another-conversation' }));
    expect(result.current).toBe(false);
  });

  it('follows the conversation in view', () => {
    const { result } = renderHook(() => useBlockingApprovalVisible());
    act(() => bridge.command.set({ conversationId: 'another-conversation' }));
    expect(result.current).toBe(false);
    act(() => useChatStore.setState({ activeConversationId: 'another-conversation' }));
    expect(result.current).toBe(true);
  });

  // The three approval dialogs are drawn by the chat view only.
  it.each([
    ['a command approval', bridge.command],
    ['a file approval', bridge.file],
    ['a workspace approval', bridge.workspace],
  ])('is false for %s while another view is in front, and true again back in the chat view', (_name, source) => {
    const { result } = renderHook(() => useBlockingApprovalVisible());
    act(() => source.set({ conversationId: 'conversation-in-view' }));
    expect(result.current).toBe(true);
    act(() => useSettingsStore.setState({ viewMode: 'automation' }));
    expect(result.current).toBe(false);
    act(() => useSettingsStore.setState({ viewMode: 'chat' }));
    expect(result.current).toBe(true);
  });

  it('stays true for the close-window question and a capability grant in any view', () => {
    const { result } = renderHook(() => useBlockingApprovalVisible());
    act(() => useSettingsStore.setState({ viewMode: 'team' }));
    act(() => usePreviewStore.setState({ appModalOpen: true }));
    expect(result.current).toBe(true);
    act(() => usePreviewStore.setState({ appModalOpen: false }));
    act(() => bridge.capability.set({ conversationId: 'conversation-in-view' }));
    expect(result.current).toBe(true);
  });

  it('is true while a task waits for a capability grant, whichever conversation is in view', () => {
    const { result } = renderHook(() => useBlockingApprovalVisible());
    act(() => bridge.capability.set({ conversationId: 'another-conversation' }));
    expect(result.current).toBe(true);
    act(() => bridge.capability.set(null));
    expect(result.current).toBe(false);
  });
});
