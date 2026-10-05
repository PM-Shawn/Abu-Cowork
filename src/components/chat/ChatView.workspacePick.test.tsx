// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import ChatView from './ChatView';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useToastStore } from '@/stores/toastStore';
import { getI18n } from '@/i18n';
import {
  drainWorkspaceRequest,
  getPendingWorkspaceRequest,
  requestWorkspace,
} from '@/core/agent/permissionBridge';
import type { Message } from '@/types';

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: vi.fn(),
}));

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso() {
      return React.createElement('div', { 'data-testid': 'mock-virtuoso' });
    }),
  };
});

vi.mock('./ChatInput', () => ({ default: () => null }));
vi.mock('./AgentStatusStrip', () => ({ default: () => null }));
vi.mock('./QueuedMessagesStrip', () => ({ default: () => null }));
vi.mock('./ScenarioGuide', () => ({ default: () => null }));
vi.mock('./UsageChip', () => ({ default: () => null }));
vi.mock('./ChapterRail', () => ({ default: () => null }));
vi.mock('./ChapterMenu', () => ({ default: () => null }));

const WORKSPACE_REQUEST_TIMEOUT_MS = 60_000;

interface OpenPicker {
  close: (selected: string | null) => Promise<void>;
}

/** The system folder picker stays open until the test closes it. */
function holdPickerOpen(): OpenPicker {
  let settle: (selected: string | null) => void = () => {};
  vi.mocked(openDialog).mockImplementationOnce(
    () => new Promise<string | null>((resolve) => { settle = resolve; }),
  );
  return {
    close: async (selected) => {
      await act(async () => {
        settle(selected);
      });
    },
  };
}

function setupConversation(): string {
  const store = useChatStore.getState();
  const conversationId = store.createConversation();
  const message: Message = { id: 'user-1', role: 'user', content: 'organize my files', loopId: 'loop-1', timestamp: 1 };
  store.addMessage(conversationId, message);
  store.setConversationStatus(conversationId, 'running');
  return conversationId;
}

/** Tracks how a workspace request's promise settled without awaiting it. */
function track(promise: Promise<string | null>): { settled: boolean; value: string | null } {
  const state = { settled: false, value: null as string | null };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

function clickChooseFolder(): void {
  fireEvent.click(screen.getByRole('button', { name: getI18n().permission.folderSelect?.selectButton }));
}

describe('ChatView workspace request folder pick', () => {
  let conversationId: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(openDialog).mockReset();
    vi.mocked(openDialog).mockResolvedValue(null);
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useWorkspaceStore.setState({ currentPath: null });
    useToastStore.setState(useToastStore.getInitialState(), true);
    conversationId = setupConversation();
  });

  afterEach(() => {
    cleanup();
    drainWorkspaceRequest();
    vi.useRealTimers();
  });

  it('applies the picked folder and answers the request it was picked for', async () => {
    render(<ChatView />);
    let answer = track(Promise.resolve(null));
    await act(async () => {
      answer = track(requestWorkspace('need a folder', conversationId));
    });
    const picker = holdPickerOpen();
    clickChooseFolder();

    await picker.close('/Users/me/reports');

    expect(answer).toEqual({ settled: true, value: '/Users/me/reports' });
    expect(useWorkspaceStore.getState().currentPath).toBe('/Users/me/reports');
    expect(useChatStore.getState().conversations[conversationId].workspacePath).toBe('/Users/me/reports');
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('drops a folder picked after the request timed out', async () => {
    render(<ChatView />);
    let answer = track(Promise.resolve(null));
    await act(async () => {
      answer = track(requestWorkspace('need a folder', conversationId));
    });
    const picker = holdPickerOpen();
    clickChooseFolder();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKSPACE_REQUEST_TIMEOUT_MS);
    });
    expect(answer).toEqual({ settled: true, value: null });

    await picker.close('/Users/me/late-pick');

    expect(useWorkspaceStore.getState().currentPath).toBeNull();
    expect(useChatStore.getState().conversations[conversationId].workspacePath ?? null).toBeNull();
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      getI18n().permission.folderRequestEnded,
    ]);
  });

  it('never answers a newer request with a folder picked for the one it replaced', async () => {
    render(<ChatView />);
    await act(async () => {
      void requestWorkspace('first question', conversationId);
    });
    const picker = holdPickerOpen();
    clickChooseFolder();

    let secondAnswer = track(Promise.resolve(null));
    await act(async () => {
      secondAnswer = track(requestWorkspace('second question', conversationId));
    });

    await picker.close('/Users/me/picked-for-first');

    expect(secondAnswer.settled).toBe(false);
    expect(getPendingWorkspaceRequest()?.reason).toBe('second question');
    expect(useWorkspaceStore.getState().currentPath).toBeNull();
    expect(useChatStore.getState().conversations[conversationId].workspacePath ?? null).toBeNull();
    expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([
      getI18n().permission.folderRequestEnded,
    ]);
  });

  it('keeps a newer request pending when the picker opened for the replaced one is cancelled', async () => {
    render(<ChatView />);
    await act(async () => {
      void requestWorkspace('first question', conversationId);
    });
    const picker = holdPickerOpen();
    clickChooseFolder();

    let secondAnswer = track(Promise.resolve(null));
    await act(async () => {
      secondAnswer = track(requestWorkspace('second question', conversationId));
    });

    await picker.close(null);

    expect(secondAnswer.settled).toBe(false);
    expect(getPendingWorkspaceRequest()?.reason).toBe('second question');
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
