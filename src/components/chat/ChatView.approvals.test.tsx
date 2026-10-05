// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import ChatView from './ChatView';
import * as approvalBridge from '@/core/agent/ports/approvalBridge';
import {
  drainConfirmationQueue,
  drainFilePermissionQueue,
  drainWorkspaceRequest,
  getPendingCommandConfirmation,
  getPendingFilePermission,
  getPendingWorkspaceRequest,
  requestCommandConfirmationForConversation,
  requestWorkspace,
} from '@/core/agent/permissionBridge';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getI18n } from '@/i18n';
import type { Message } from '@/types';

// The approvals a task asks for, as the chat view shows them: which one is on the page, and
// that nothing but a press on its own buttons answers it. The requests are real entries of the
// approval queues; the rows, the composer and the strips of the chat are not under test.
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: vi.fn() }));
vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return { Virtuoso: React.forwardRef(function MockVirtuoso() { return React.createElement('div'); }) };
});
vi.mock('./MessageGroup', () => ({ default: () => null }));
vi.mock('./ChatInput', () => ({ default: () => null }));
vi.mock('./AgentStatusStrip', () => ({ default: () => null }));
vi.mock('./QueuedMessagesStrip', () => ({ default: () => null }));
vi.mock('@/core/usage/usageLedgerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/usage/usageLedgerClient')>();
  return { ...actual, queryUsageConversation: vi.fn(async () => ({ available: true, totals: actual.emptyUsageAggregate() })) };
});

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const COMMAND = 'echo not-a-real-command';
const SECOND_COMMAND = 'echo not-a-real-command --again';
const FOLDER = '/fake/project';

function conversation(skipActivate = false): string {
  const store = useChatStore.getState();
  const id = store.createConversation(null, { skipActivate });
  const prompt: Message = { id: `user-${id}`, role: 'user', content: 'prompt', loopId: `loop-${id}`, timestamp: 1 };
  store.addMessage(id, prompt);
  store.setConversationStatus(id, 'idle');
  return id;
}

// An answer as the waiting tool call hears it: the list stays empty until the request is answered.
function heard<T>(request: Promise<T>): T[] {
  const answers: T[] = [];
  void request.then((answer) => { answers.push(answer); });
  return answers;
}

function askCommand(conversationId: string, command = COMMAND) {
  let answers!: boolean[];
  act(() => {
    answers = heard(requestCommandConfirmationForConversation({ command, level: 'warn', reason: 'needs a look' }, conversationId));
  });
  return answers;
}
function askFile(conversationId: string) {
  let answers!: boolean[];
  act(() => {
    answers = heard(approvalBridge.request('file-permission', {
      conversationId,
      payload: { path: `${FOLDER}/notes.txt`, capability: 'write', toolName: 'write_file' },
    }));
  });
  return answers;
}
function askWorkspace(conversationId: string) {
  let answers!: (string | null)[];
  act(() => { answers = heard(requestWorkspace('needs a folder', conversationId, FOLDER)); });
  return answers;
}

const settle = () => act(async () => { await Promise.resolve(); });
const view = (id: string) => act(() => { useChatStore.setState({ activeConversationId: id }); });
const heading = (name: string) => screen.queryByRole('heading', { name });
const headings = () => screen.queryAllByRole('heading').map((element) => element.textContent);
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('ChatView approvals', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
  });

  afterEach(() => {
    cleanup();
    drainConfirmationQueue();
    drainFilePermissionQueue();
    drainWorkspaceRequest();
    vi.useRealTimers();
  });

  const t = () => getI18n();

  it('shows the command approval of the conversation in view, and showing it answers nothing', async () => {
    const id = conversation();
    render(<ChatView />);
    const answers = askCommand(id);
    await settle();

    expect(heading(t().commandConfirm.title)).toBeInTheDocument();
    expect(screen.getByText(COMMAND)).toBeInTheDocument();
    expect(answers).toEqual([]);
    expect(getPendingCommandConfirmation()?.conversationId).toBe(id);
  });

  it('does not show the approval of another conversation, and leaves it waiting', async () => {
    const other = conversation(true);
    conversation();
    render(<ChatView />);
    const answers = askCommand(other);
    await settle();

    expect(heading(t().commandConfirm.title)).toBeNull();
    expect(answers).toEqual([]);
    expect(getPendingCommandConfirmation()?.conversationId).toBe(other);
  });

  it('hides the approval, unanswered, when the user goes to another conversation, and shows it again when they return', async () => {
    const other = conversation(true);
    const id = conversation();
    render(<ChatView />);
    const answers = askCommand(id);
    const pending = getPendingCommandConfirmation();
    expect(heading(t().commandConfirm.title)).toBeInTheDocument();

    view(other);
    await settle();
    expect(heading(t().commandConfirm.title)).toBeNull();
    expect(screen.queryByText(COMMAND)).toBeNull();
    expect(answers).toEqual([]);
    expect(getPendingCommandConfirmation()).toBe(pending);

    view(id);
    await settle();
    expect(heading(t().commandConfirm.title)).toBeInTheDocument();
    expect(screen.getByText(COMMAND)).toBeInTheDocument();
    expect(answers).toEqual([]);
    expect(getPendingCommandConfirmation()).toBe(pending);

    press(t().commandConfirm.cancel);
    await settle();
    expect(answers).toEqual([false]);
    expect(getPendingCommandConfirmation()).toBeNull();
  });

  it('leaves the approval waiting when the chat view itself leaves the page, and shows it when the view is back', async () => {
    const id = conversation();
    const first = render(<ChatView />);
    const answers = askCommand(id);
    const pending = getPendingCommandConfirmation();

    first.unmount();
    await settle();
    expect(answers).toEqual([]);
    expect(getPendingCommandConfirmation()).toBe(pending);

    render(<ChatView />);
    expect(heading(t().commandConfirm.title)).toBeInTheDocument();
    expect(answers).toEqual([]);
  });

  it('answers only the approval on screen: the one behind it is shown next, unanswered', async () => {
    const id = conversation();
    render(<ChatView />);
    const first = askCommand(id);
    const second = askCommand(id, SECOND_COMMAND);
    expect(screen.getByText(COMMAND)).toBeInTheDocument();
    expect(screen.queryByText(SECOND_COMMAND)).toBeNull();

    press(t().commandConfirm.confirm);
    await settle();
    expect(first).toEqual([true]);
    expect(second).toEqual([]);
    expect(screen.getByText(SECOND_COMMAND)).toBeInTheDocument();
    expect(screen.queryByText(COMMAND)).toBeNull();

    press(t().commandConfirm.cancel);
    await settle();
    expect(second).toEqual([false]);
    expect(heading(t().commandConfirm.title)).toBeNull();
  });

  it('cancels the approval on Escape, and that one press answers nothing else', async () => {
    const id = conversation();
    render(<ChatView />);
    const first = askCommand(id);
    const second = askCommand(id, SECOND_COMMAND);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await settle();
    expect(first).toEqual([false]);
    expect(second).toEqual([]);
    expect(screen.getByText(SECOND_COMMAND)).toBeInTheDocument();
  });

  it('opens the next approval in the queue with the focus on Cancel again: Enter after confirming the first cancels the second', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const id = conversation();
    render(<ChatView />);
    const first = askCommand(id);
    const second = askCommand(id, SECOND_COMMAND);
    expect(screen.getByRole('button', { name: t().commandConfirm.cancel })).toHaveFocus();

    // The press leaves the focus on the confirming button of the first approval.
    await user.click(screen.getByRole('button', { name: t().commandConfirm.confirm }));
    await settle();
    expect(first).toEqual([true]);
    expect(screen.getByText(SECOND_COMMAND)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t().commandConfirm.cancel })).toHaveFocus();

    await user.keyboard('{Enter}');
    await settle();
    expect(second).toEqual([false]);
  });

  describe('one approval at a time', () => {
    it('shows the workspace request first, then the command approval, then the file grant, each unanswered until its turn', async () => {
      const id = conversation();
      render(<ChatView />);
      const file = askFile(id);
      const command = askCommand(id);
      const workspace = askWorkspace(id);
      await settle();

      expect(headings()).toEqual([t().permission.folderSelect?.authorizeTitle]);
      expect(command).toEqual([]);
      expect(file).toEqual([]);

      press(t().permission.deny);
      await settle();
      expect(workspace).toEqual([null]);
      expect(headings()).toEqual([t().commandConfirm.title]);
      expect(command).toEqual([]);
      expect(file).toEqual([]);
      expect(getPendingFilePermission()).not.toBeNull();

      press(t().commandConfirm.cancel);
      await settle();
      expect(command).toEqual([false]);
      expect(headings()).toEqual([t().permission.fileWrite.title]);
      expect(file).toEqual([]);

      press(t().permission.deny);
      await settle();
      expect(file).toEqual([false]);
      expect(headings()).toEqual([]);
    });

    it('answers nothing that waits behind the approval on screen when Escape is pressed', async () => {
      const id = conversation();
      render(<ChatView />);
      const file = askFile(id);
      const command = askCommand(id);
      await settle();
      expect(headings()).toEqual([t().commandConfirm.title]);

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await settle();
      expect(command).toEqual([false]);
      expect(file).toEqual([]);
      expect(getPendingFilePermission()).not.toBeNull();
      expect(headings()).toEqual([t().permission.fileWrite.title]);
    });

    it('shows a workspace request that arrives while a command approval is on screen, and brings the command approval back unanswered', async () => {
      const id = conversation();
      render(<ChatView />);
      const command = askCommand(id);
      const pending = getPendingCommandConfirmation();
      expect(headings()).toEqual([t().commandConfirm.title]);

      const workspace = askWorkspace(id);
      await settle();
      expect(headings()).toEqual([t().permission.folderSelect?.authorizeTitle]);
      expect(command).toEqual([]);
      expect(getPendingCommandConfirmation()).toBe(pending);

      press(t().permission.deny);
      await settle();
      expect(workspace).toEqual([null]);
      expect(getPendingWorkspaceRequest()).toBeNull();
      expect(headings()).toEqual([t().commandConfirm.title]);
      expect(command).toEqual([]);
    });
  });

  describe('other windows', () => {
    it('turns away a window that opens while the command approval is on screen, and the approval stays unanswered', async () => {
      const id = conversation();
      const onSearch = vi.fn();
      const page = (search: boolean) => (
        <>
          <ChatView />
          <Dialog open={search} onOpenChange={onSearch} title="Search" />
        </>
      );
      const shown = render(page(false));
      const answers = askCommand(id);
      await settle();

      shown.rerender(page(true));
      await settle();
      expect(onSearch.mock.calls).toEqual([[false]]);
      expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull();
      expect(heading(t().commandConfirm.title)).toBeInTheDocument();
      expect(answers).toEqual([]);

      shown.rerender(page(false));
      await settle();
      expect(answers).toEqual([]);
      expect(getPendingCommandConfirmation()?.conversationId).toBe(id);
    });
  });
});
