// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TOAST_SETTLE_MS } from '@/components/ds/styles';
import ChatView from './ChatView';
import WorkspaceSection from '@/components/panel/WorkspaceSection';
import * as approvalBridge from '@/core/agent/ports/approvalBridge';
import {
  drainConfirmationQueue,
  drainFilePermissionQueue,
  drainUserQuestions,
  drainWorkspaceRequest,
  getPendingCommandConfirmation,
  getPendingFilePermission,
  getPendingWorkspaceRequest,
  requestCommandConfirmationForConversation,
  requestUserQuestion,
  requestWorkspace,
  resolveUserQuestion,
} from '@/core/agent/permissionBridge';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getI18n } from '@/i18n';
import type { Message, UserQuestionPayload } from '@/types';
import { noteComposerKey } from './composerActivity';

// The approvals a task asks for, as the chat view shows them: which one is on the page, and
// that nothing but a press on its own buttons answers it. The requests are real entries of the
// approval queues; the rows, the composer and the strips of the chat are not under test.
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: vi.fn() }));
vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return { Virtuoso: React.forwardRef(function MockVirtuoso() { return React.createElement('div'); }) };
});
vi.mock('./MessageGroup', () => ({ default: () => null }));
// Stands in for the composer: the message field, and a Send button that the Stop button takes
// the place of once a message is sent (two elements, as in the composer).
vi.mock('./ChatInput', async () => {
  const { useState } = await import('react');
  const { Button } = await import('@/components/ds/button');
  const { TextArea } = await import('@/components/ds/text-area');
  function ComposerStandIn() {
    const [running, setRunning] = useState(false);
    return (
      <>
        <TextArea data-chat-composer="" aria-label="Message" />
        {running ? <Button key="stop">Stop</Button> : <Button key="send" onClick={() => setRunning(true)}>Send</Button>}
      </>
    );
  }
  return { default: ComposerStandIn };
});
vi.mock('./AgentStatusStrip', () => ({ default: () => null }));
vi.mock('./QueuedMessagesStrip', () => ({ default: () => null }));
// The workspace panel looks for project memory when it mounts.
vi.mock('@/core/memdir/scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/memdir/scan')>();
  return { ...actual, scanMemoryFiles: vi.fn().mockResolvedValue([]) };
});
vi.mock('@/core/usage/usageLedgerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/usage/usageLedgerClient')>();
  return { ...actual, queryUsageConversation: vi.fn(async () => ({ available: true, totals: actual.emptyUsageAggregate() })) };
});

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const COMMAND = 'echo not-a-real-command';
const SECOND_COMMAND = 'echo not-a-real-command --again';
const FOLDER = '/fake/project';
const FILE = `${FOLDER}/notes.txt`;
const SECOND_FILE = '/fake/elsewhere/report.txt';
const OTHER_FOLDER = '/fake/other';
const DAY_MS = 24 * 60 * 60 * 1000;

function conversation(skipActivate = false, workspacePath: string | null = null): string {
  const store = useChatStore.getState();
  const id = store.createConversation(workspacePath, { skipActivate });
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
function askFile(conversationId: string, path = FILE, capability: 'read' | 'write' = 'write') {
  let answers!: boolean[];
  act(() => {
    answers = heard(approvalBridge.request('file-permission', {
      conversationId,
      payload: { path, capability, toolName: capability === 'write' ? 'write_file' : 'read_file' },
    }));
  });
  return answers;
}
// `null`: a request that names no folder.
function askWorkspace(conversationId: string, suggestedPath: string | null = FOLDER) {
  let answers!: (string | null)[];
  act(() => { answers = heard(requestWorkspace('needs a folder', conversationId, suggestedPath ?? undefined)); });
  return answers;
}

const settle = () => act(async () => { await Promise.resolve(); });
// An approval takes no pointer press for a moment after it appears; the keyboard is never held.
// After this the window on the page has been there long enough to be read.
const readable = () => act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });
const view = (id: string) => act(() => { useChatStore.setState({ activeConversationId: id }); });
const heading = (name: string) => screen.queryByRole('heading', { name });
const headings = () => screen.queryAllByRole('heading').map((element) => element.textContent);
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
// One of the four durations of a file grant.
const duration = (name: string) => screen.getByRole('radio', { name });
// The allowing button of a file grant. With the grant for good chosen, the duration carries
// nearly the same words.
const pressAllow = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
// The corner button is the one button without words.
const pressCorner = () => {
  const found = screen.getAllByRole('button').find((candidate) => candidate.textContent === '');
  if (!found) throw new Error('The window has no corner button');
  fireEvent.click(found);
};
const grants = () => {
  const { persistedGrants, sessionGrants } = usePermissionStore.getState();
  return { persisted: persistedGrants, session: sessionGrants };
};
const NO_GRANTS = { persisted: {}, session: {} };

describe('ChatView approvals', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => undefined;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {} });
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
    vi.mocked(openDialog).mockReset().mockResolvedValue(null);
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

  describe('focus after an approval is answered', () => {
    const messageField = () => screen.getByRole('textbox', { name: 'Message' });
    const left = () => act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });

    it('goes to the message field when the command approval is refused with Escape and the Send button that was pressed has left the page', async () => {
      const id = conversation();
      render(<ChatView />);
      const send = screen.getByRole('button', { name: 'Send' });
      send.focus();
      fireEvent.click(send);
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
      const answers = askCommand(id);
      await settle();
      expect(screen.getByRole('button', { name: t().commandConfirm.cancel })).toHaveFocus();

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await settle();
      left();
      expect(answers).toEqual([false]);
      expect(messageField()).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Stop' })).not.toHaveFocus();
    });

    it('goes to the message field after a file grant is denied and after a workspace request is denied, when no control had the focus', async () => {
      const id = conversation();
      render(<ChatView />);
      const file = askFile(id);
      await settle();
      press(t().permission.deny);
      await settle();
      left();
      expect(file).toEqual([false]);
      expect(messageField()).toHaveFocus();

      act(() => { messageField().blur(); });
      expect(document.body).toHaveFocus();
      const workspace = askWorkspace(id);
      await settle();
      press(t().permission.deny);
      await settle();
      left();
      expect(workspace).toEqual([null]);
      expect(messageField()).toHaveFocus();
    });

    it('returns to the control that had the focus while it is still on the page', async () => {
      const id = conversation();
      render(<ChatView />);
      const send = screen.getByRole('button', { name: 'Send' });
      send.focus();
      const answers = askCommand(id);
      await settle();

      press(t().commandConfirm.cancel);
      await settle();
      left();
      expect(answers).toEqual([false]);
      expect(send).toHaveFocus();
    });
  });

  it('opens the next approval in the queue with the focus on Cancel again: Enter after confirming the first cancels the second', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const id = conversation();
    render(<ChatView />);
    const first = askCommand(id);
    const second = askCommand(id, SECOND_COMMAND);
    expect(screen.getByRole('button', { name: t().commandConfirm.cancel })).toHaveFocus();

    // The press leaves the focus on the confirming button of the first approval.
    readable();
    await user.click(screen.getByRole('button', { name: t().commandConfirm.confirm }));
    await settle();
    expect(first).toEqual([true]);
    expect(screen.getByText(SECOND_COMMAND)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t().commandConfirm.cancel })).toHaveFocus();

    await user.keyboard('{Enter}');
    await settle();
    expect(second).toEqual([false]);
  });

  // The window of the next request appears where the one just answered was, its buttons at the
  // same spots. The second press of a double press lands there before anyone could read it.
  describe('a double press with two approvals due', () => {
    // A pointer press as the browser reports it: it begins on the button and its click says detail 1.
    const pointerPress = (name: string) => {
      const button = screen.getByRole('button', { name });
      fireEvent.pointerDown(button);
      fireEvent.click(button, { detail: 1 });
    };

    it('confirms one command with a double press on Confirm: the second stays on the page, waiting, with the focus on Cancel', async () => {
      const id = conversation();
      render(<ChatView />);
      const first = askCommand(id);
      const second = askCommand(id, SECOND_COMMAND);
      readable();
      pointerPress(t().commandConfirm.confirm);
      await settle();
      pointerPress(t().commandConfirm.confirm);
      await settle();
      expect(first).toEqual([true]);
      expect(second).toEqual([]);
      expect(screen.getByText(SECOND_COMMAND)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t().commandConfirm.cancel })).toHaveFocus();

      readable();
      pointerPress(t().commandConfirm.confirm);
      await settle();
      expect(second).toEqual([true]);
    });

    it('cancels one command with a double press on Cancel: the second is not refused by it', async () => {
      const id = conversation();
      render(<ChatView />);
      const first = askCommand(id);
      const second = askCommand(id, SECOND_COMMAND);
      readable();
      pointerPress(t().commandConfirm.cancel);
      await settle();
      pointerPress(t().commandConfirm.cancel);
      await settle();
      expect(first).toEqual([false]);
      expect(second).toEqual([]);
      expect(screen.getByText(SECOND_COMMAND)).toBeInTheDocument();
    });

    it('grants nothing for the next file with the second press of a double press on the allowing button', async () => {
      const id = conversation();
      render(<ChatView />);
      const first = askFile(id);
      const second = askFile(id, SECOND_FILE);
      readable();
      pointerPress(t().permission.allowSessionButton);
      await settle();
      pointerPress(t().permission.allowSessionButton);
      await settle();
      expect(first).toEqual([true]);
      expect(second).toEqual([]);
      expect(screen.getByText(SECOND_FILE)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t().permission.deny })).toHaveFocus();
    });
  });

  // A file grant lets Abu read or write under a path. What each answer records is pinned here
  // through the real queue and the real permission store.
  describe('file grants: what an answer records', () => {
    it('shows the grant of the conversation in view, and showing it grants nothing', async () => {
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id);
      await settle();

      expect(heading(t().permission.fileWrite.title)).toBeInTheDocument();
      expect(screen.getByText(FILE)).toBeInTheDocument();
      expect(answers).toEqual([]);
      expect(grants()).toEqual(NO_GRANTS);
    });

    it('records a grant for the session, with read, write and execute, for a write request', async () => {
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id);
      await settle();

      pressAllow(t().permission.allowSessionButton);
      await settle();
      expect(answers).toEqual([true]);
      expect(getPendingFilePermission()).toBeNull();
      expect(grants().persisted).toEqual({});
      expect(grants().session).toEqual({
        [FILE]: expect.objectContaining({ path: FILE, capabilities: ['read', 'write', 'execute'], duration: 'session', expiresAt: null }),
      });
      expect(heading(t().permission.fileWrite.title)).toBeNull();
    });

    it('records a read grant alone for a read request', async () => {
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id, FILE, 'read');
      await settle();
      expect(heading(t().permission.fileRead?.title ?? '')).toBeInTheDocument();

      pressAllow(t().permission.allowSessionButton);
      await settle();
      expect(answers).toEqual([true]);
      expect(grants().session[FILE]?.capabilities).toEqual(['read']);
      expect(usePermissionStore.getState().hasPermission(FILE, 'write')).toBe(false);
    });

    it('records a grant for this time as one that ends with the session', async () => {
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id);
      await settle();

      fireEvent.click(duration(t().permission.durationOnce));
      pressAllow(t().permission.allowOnceButton);
      await settle();
      expect(answers).toEqual([true]);
      expect(grants().persisted).toEqual({});
      expect(grants().session[FILE]).toEqual(expect.objectContaining({ duration: 'once', expiresAt: null }));
    });

    it('records a grant for 24 hours as one that is kept and ends a day later', async () => {
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id);
      await settle();

      fireEvent.click(duration(t().permission.duration24h));
      pressAllow(t().permission.allow24hButton);
      await settle();
      expect(answers).toEqual([true]);
      expect(grants().session).toEqual({});
      const grant = grants().persisted[FILE];
      expect(grant).toEqual(expect.objectContaining({ duration: '24h', capabilities: ['read', 'write', 'execute'] }));
      expect((grant.expiresAt ?? 0) - grant.grantedAt).toBe(DAY_MS);
    });

    it('records a grant for good only after the second press', async () => {
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id);
      const pending = getPendingFilePermission();
      await settle();

      fireEvent.click(duration(t().permission.durationAlways));
      pressAllow(t().permission.allowAlwaysButton);
      await settle();
      expect(answers).toEqual([]);
      expect(grants()).toEqual(NO_GRANTS);
      expect(getPendingFilePermission()).toBe(pending);
      expect(screen.getByText(t().permission.durationAlwaysConfirm)).toBeInTheDocument();

      press(t().common.confirm);
      await settle();
      expect(answers).toEqual([true]);
      expect(grants().session).toEqual({});
      expect(grants().persisted[FILE]).toEqual(expect.objectContaining({ duration: 'always', expiresAt: null, capabilities: ['read', 'write', 'execute'] }));
    });

    it.each([
      ['Deny', () => press(t().permission.deny)],
      ['the corner button', () => pressCorner()],
      ['Escape', () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); }],
    ] as const)('answers no and records nothing on %s', async (_name, answer) => {
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id);
      await settle();

      answer();
      await settle();
      expect(answers).toEqual([false]);
      expect(getPendingFilePermission()).toBeNull();
      expect(grants()).toEqual(NO_GRANTS);
      expect(heading(t().permission.fileWrite.title)).toBeNull();
    });

    it('hides the grant, unanswered, when the user goes to another conversation, and shows it again when they return', async () => {
      const other = conversation(true);
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id);
      const pending = getPendingFilePermission();
      await settle();
      expect(heading(t().permission.fileWrite.title)).toBeInTheDocument();

      view(other);
      await settle();
      expect(heading(t().permission.fileWrite.title)).toBeNull();
      expect(screen.queryByText(FILE)).toBeNull();
      expect(answers).toEqual([]);
      expect(getPendingFilePermission()).toBe(pending);
      expect(grants()).toEqual(NO_GRANTS);

      view(id);
      await settle();
      expect(heading(t().permission.fileWrite.title)).toBeInTheDocument();
      expect(screen.getByText(FILE)).toBeInTheDocument();
      expect(answers).toEqual([]);
      expect(grants()).toEqual(NO_GRANTS);
    });

    it('leaves the grant waiting when the chat view itself leaves the page', async () => {
      const id = conversation();
      const first = render(<ChatView />);
      const answers = askFile(id);
      const pending = getPendingFilePermission();
      await settle();

      first.unmount();
      await settle();
      expect(answers).toEqual([]);
      expect(getPendingFilePermission()).toBe(pending);
      expect(grants()).toEqual(NO_GRANTS);
    });

    it('answers only the grant on screen: the one behind it is shown next, unanswered', async () => {
      const id = conversation();
      render(<ChatView />);
      const first = askFile(id);
      const second = askFile(id, SECOND_FILE);
      await settle();
      expect(screen.getByText(FILE)).toBeInTheDocument();
      expect(screen.queryByText(SECOND_FILE)).toBeNull();

      press(t().permission.deny);
      await settle();
      expect(first).toEqual([false]);
      expect(second).toEqual([]);
      expect(screen.getByText(SECOND_FILE)).toBeInTheDocument();
      expect(screen.queryByText(FILE)).toBeNull();
      expect(grants()).toEqual(NO_GRANTS);
    });

    it('answers a waiting request for a path the grant just given already covers, with no window', async () => {
      const id = conversation();
      render(<ChatView />);
      const first = askFile(id);
      const second = askFile(id);
      await settle();

      pressAllow(t().permission.allowSessionButton);
      await settle();
      expect(first).toEqual([true]);
      expect(second).toEqual([true]);
      expect(heading(t().permission.fileWrite.title)).toBeNull();
      expect(getPendingFilePermission()).toBeNull();
    });
  });

  // A workspace request asks which folder the task works in. Authorizing sets the folder as
  // the workspace; it answers itself with no 60 seconds after it was asked.
  describe('workspace requests: what an answer records', () => {
    const workspaceOf = (id: string) => useChatStore.getState().conversations[id]?.workspacePath ?? null;

    it('sets the named folder as the workspace on Allow Access, and answers with it', async () => {
      const id = conversation();
      render(<ChatView />);
      const answers = askWorkspace(id);
      await settle();
      expect(heading(t().permission.folderSelect?.authorizeTitle ?? '')).toBeInTheDocument();
      expect(screen.getByText(FOLDER)).toBeInTheDocument();
      expect(useWorkspaceStore.getState().currentPath).toBeNull();

      press(t().permission.folderSelect?.authorizeButton ?? '');
      await settle();
      expect(answers).toEqual([FOLDER]);
      expect(useWorkspaceStore.getState().currentPath).toBe(FOLDER);
      expect(workspaceOf(id)).toBe(FOLDER);
      expect(openDialog).not.toHaveBeenCalled();
      expect(grants()).toEqual(NO_GRANTS);
      expect(getPendingWorkspaceRequest()).toBeNull();
    });

    it('sets nothing until the system folder picker returns a folder, then answers with that folder', async () => {
      const id = conversation();
      let pick!: (folder: string | null) => void;
      vi.mocked(openDialog).mockImplementation(() => new Promise((resolve) => { pick = resolve; }));
      render(<ChatView />);
      const answers = askWorkspace(id);
      await settle();

      press(t().permission.folderSelect?.chooseDifferent ?? '');
      await settle();
      expect(openDialog).toHaveBeenCalledWith({ directory: true, multiple: false, defaultPath: FOLDER });
      expect(answers).toEqual([]);
      expect(useWorkspaceStore.getState().currentPath).toBeNull();
      expect(getPendingWorkspaceRequest()).not.toBeNull();

      await act(async () => { pick(OTHER_FOLDER); });
      await settle();
      expect(answers).toEqual([OTHER_FOLDER]);
      expect(useWorkspaceStore.getState().currentPath).toBe(OTHER_FOLDER);
      expect(workspaceOf(id)).toBe(OTHER_FOLDER);
    });

    it('answers with no folder when the system folder picker is cancelled', async () => {
      const id = conversation();
      render(<ChatView />);
      const answers = askWorkspace(id);
      await settle();

      press(t().permission.folderSelect?.chooseDifferent ?? '');
      await settle();
      expect(answers).toEqual([null]);
      expect(useWorkspaceStore.getState().currentPath).toBeNull();
      expect(workspaceOf(id)).toBeNull();
    });

    it('answers with no folder when the system folder picker fails', async () => {
      const id = conversation();
      vi.mocked(openDialog).mockRejectedValue(new Error('no picker'));
      render(<ChatView />);
      const answers = askWorkspace(id);
      await settle();

      press(t().permission.folderSelect?.chooseDifferent ?? '');
      await settle();
      expect(answers).toEqual([null]);
      expect(useWorkspaceStore.getState().currentPath).toBeNull();
    });

    it('asks for a folder when the request names none: only the picker sets one', async () => {
      const id = conversation();
      vi.mocked(openDialog).mockResolvedValue(OTHER_FOLDER);
      render(<ChatView />);
      const answers = askWorkspace(id, null);
      await settle();
      expect(heading(t().permission.folderSelect?.title ?? '')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t().permission.deny })).toBeNull();
      expect(answers).toEqual([]);

      press(t().permission.folderSelect?.selectButton ?? '');
      await settle();
      expect(openDialog).toHaveBeenCalledWith({ directory: true, multiple: false, defaultPath: undefined });
      expect(answers).toEqual([OTHER_FOLDER]);
      expect(useWorkspaceStore.getState().currentPath).toBe(OTHER_FOLDER);
      expect(workspaceOf(id)).toBe(OTHER_FOLDER);
    });

    it.each([
      ['Deny', () => press(t().permission.deny)],
      ['the corner button', () => pressCorner()],
      ['Escape', () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); }],
    ] as const)('answers with no folder and sets nothing on %s', async (_name, answer) => {
      const id = conversation();
      render(<ChatView />);
      const answers = askWorkspace(id);
      await settle();

      answer();
      await settle();
      expect(answers).toEqual([null]);
      expect(useWorkspaceStore.getState().currentPath).toBeNull();
      expect(workspaceOf(id)).toBeNull();
      expect(heading(t().permission.folderSelect?.authorizeTitle ?? '')).toBeNull();
    });

    it('answers itself with no folder 60 seconds after it was asked, and leaves the page', async () => {
      const id = conversation();
      render(<ChatView />);
      const answers = askWorkspace(id);
      await settle();

      await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
      expect(answers).toEqual([]);
      expect(heading(t().permission.folderSelect?.authorizeTitle ?? '')).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(answers).toEqual([null]);
      expect(heading(t().permission.folderSelect?.authorizeTitle ?? '')).toBeNull();
      expect(useWorkspaceStore.getState().currentPath).toBeNull();
    });

    it('shows the newer request when a second one arrives; the first is never answered', async () => {
      const id = conversation();
      render(<ChatView />);
      const first = askWorkspace(id);
      await settle();
      const second = askWorkspace(id, OTHER_FOLDER);
      await settle();
      expect(screen.getByText(OTHER_FOLDER)).toBeInTheDocument();
      expect(screen.queryByText(FOLDER)).toBeNull();

      press(t().permission.folderSelect?.authorizeButton ?? '');
      await settle();
      expect(first).toEqual([]);
      expect(second).toEqual([OTHER_FOLDER]);
      expect(useWorkspaceStore.getState().currentPath).toBe(OTHER_FOLDER);
    });

    it('hides the request, unanswered, when the user goes to another conversation, and shows it again when they return', async () => {
      const other = conversation(true);
      const id = conversation();
      render(<ChatView />);
      const answers = askWorkspace(id);
      const pending = getPendingWorkspaceRequest();
      await settle();

      view(other);
      await settle();
      expect(heading(t().permission.folderSelect?.authorizeTitle ?? '')).toBeNull();
      expect(answers).toEqual([]);
      expect(getPendingWorkspaceRequest()).toBe(pending);

      view(id);
      await settle();
      expect(heading(t().permission.folderSelect?.authorizeTitle ?? '')).toBeInTheDocument();
      expect(answers).toEqual([]);
      expect(useWorkspaceStore.getState().currentPath).toBeNull();
    });
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

  // The grant window is an approval layer like the command approval: each request is a new
  // window that opens with the focus on Deny, so a key pressed for one request never allows
  // the next.
  describe('file grants and workspace requests: a new window per request', () => {
    const deny = () => screen.getByRole('button', { name: t().permission.deny });
    const allowSession = () => screen.getByRole('button', { name: t().permission.allowSessionButton });

    it('opens a file grant with the focus on Deny: Enter pressed as it appears denies and records nothing', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id);
      await settle();
      expect(screen.getByRole('alertdialog', { name: t().permission.fileWrite.title })).toBeInTheDocument();
      expect(deny()).toHaveFocus();

      await user.keyboard('{Enter}');
      await settle();
      expect(answers).toEqual([false]);
      expect(grants()).toEqual(NO_GRANTS);
    });

    it('opens the next file grant in the queue with the focus on Deny again: Enter after allowing the first denies the second', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversation();
      render(<ChatView />);
      const first = askFile(id);
      const second = askFile(id, SECOND_FILE);
      await settle();

      // The press leaves the focus on the allowing button of the first grant.
      readable();
      await user.click(allowSession());
      await settle();
      expect(first).toEqual([true]);
      expect(screen.getByText(SECOND_FILE)).toBeInTheDocument();
      expect(deny()).toHaveFocus();

      await user.keyboard('{Enter}');
      await settle();
      expect(second).toEqual([false]);
      expect(Object.keys(grants().session)).toEqual([FILE]);
      expect(usePermissionStore.getState().hasPermission(SECOND_FILE, 'write')).toBe(false);
    });

    it('starts the next file grant from the default: a grant for good given to the first asks nothing of the second in advance', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversation();
      render(<ChatView />);
      const first = askFile(id);
      const second = askFile(id, SECOND_FILE);
      await settle();

      readable();
      await user.click(screen.getByRole('radio', { name: t().permission.durationAlways }));
      await user.click(screen.getByRole('button', { name: t().permission.allowAlwaysButton }));
      // The allowing button now reads Confirm: the window holds pointer presses again for a moment.
      readable();
      await user.click(screen.getByRole('button', { name: t().common.confirm }));
      await settle();
      expect(first).toEqual([true]);

      expect(screen.getByText(SECOND_FILE)).toBeInTheDocument();
      expect(screen.queryByText(t().permission.durationAlwaysConfirm)).toBeNull();
      expect(screen.queryByRole('button', { name: t().common.confirm })).toBeNull();
      expect(screen.getByRole('radio', { name: t().permission.durationSession })).toHaveAttribute('aria-checked', 'true');
      expect(allowSession()).toBeInTheDocument();
      expect(deny()).toHaveFocus();
      expect(second).toEqual([]);
      expect(Object.keys(grants().persisted)).toEqual([FILE]);
    });

    it('starts a second request for the same path from the default too: the question about a grant for good is not left open for it', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversation();
      render(<ChatView />);
      const first = askFile(id);
      const second = askFile(id);
      await settle();

      readable();
      await user.click(screen.getByRole('radio', { name: t().permission.durationAlways }));
      await user.click(screen.getByRole('button', { name: t().permission.allowAlwaysButton }));
      expect(screen.getByText(t().permission.durationAlwaysConfirm)).toBeInTheDocument();
      await user.tab();
      expect(screen.getByRole('button', { name: t().common.confirm })).toHaveFocus();

      // The first is denied from the keyboard; the second, for the same path, takes its place.
      await user.keyboard('{Escape}');
      await settle();
      expect(first).toEqual([false]);
      expect(heading(t().permission.fileWrite.title)).toBeInTheDocument();
      expect(screen.queryByText(t().permission.durationAlwaysConfirm)).toBeNull();
      expect(screen.getByRole('radio', { name: t().permission.durationSession })).toHaveAttribute('aria-checked', 'true');
      expect(deny()).toHaveFocus();

      await user.keyboard('{Enter}');
      await settle();
      expect(second).toEqual([false]);
      expect(grants()).toEqual(NO_GRANTS);
    });

    it('opens a file grant that follows a command approval with the focus on Deny: Enter after confirming the command denies the grant', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversation();
      render(<ChatView />);
      const file = askFile(id);
      const command = askCommand(id);
      await settle();

      readable();
      await user.click(screen.getByRole('button', { name: t().commandConfirm.confirm }));
      await settle();
      expect(command).toEqual([true]);
      expect(heading(t().permission.fileWrite.title)).toBeInTheDocument();
      expect(deny()).toHaveFocus();

      await user.keyboard('{Enter}');
      await settle();
      expect(file).toEqual([false]);
      expect(grants()).toEqual(NO_GRANTS);
    });

    it('opens a workspace request that takes the place of a command approval with the focus on Deny; the command approval returns unanswered, on Cancel', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversation();
      render(<ChatView />);
      const command = askCommand(id);
      await settle();
      // The focus is on the confirming button of the command approval when the request arrives.
      screen.getByRole('button', { name: t().commandConfirm.confirm }).focus();

      const workspace = askWorkspace(id);
      await settle();
      expect(headings()).toEqual([t().permission.folderSelect?.authorizeTitle]);
      expect(deny()).toHaveFocus();

      await user.keyboard('{Enter}');
      await settle();
      expect(workspace).toEqual([null]);
      expect(useWorkspaceStore.getState().currentPath).toBeNull();
      expect(command).toEqual([]);
      expect(headings()).toEqual([t().commandConfirm.title]);
      expect(screen.getByRole('button', { name: t().commandConfirm.cancel })).toHaveFocus();
    });

    it('opens a workspace request that takes the place of a file grant with the focus on Deny; the file grant returns from its default', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversation();
      render(<ChatView />);
      const file = askFile(id);
      await settle();
      readable();
      await user.click(screen.getByRole('radio', { name: t().permission.durationAlways }));
      await user.click(screen.getByRole('button', { name: t().permission.allowAlwaysButton }));
      expect(screen.getByText(t().permission.durationAlwaysConfirm)).toBeInTheDocument();

      const workspace = askWorkspace(id);
      await settle();
      expect(headings()).toEqual([t().permission.folderSelect?.authorizeTitle]);
      expect(deny()).toHaveFocus();
      expect(file).toEqual([]);

      await user.keyboard('{Enter}');
      await settle();
      expect(workspace).toEqual([null]);
      expect(headings()).toEqual([t().permission.fileWrite.title]);
      expect(screen.queryByText(t().permission.durationAlwaysConfirm)).toBeNull();
      expect(screen.getByRole('radio', { name: t().permission.durationSession })).toHaveAttribute('aria-checked', 'true');
      expect(deny()).toHaveFocus();
      expect(file).toEqual([]);
      expect(grants()).toEqual(NO_GRANTS);
    });

    it('opens the newer workspace request with the focus on Deny when it takes the place of the one on screen', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversation();
      render(<ChatView />);
      askWorkspace(id);
      await settle();
      screen.getByRole('button', { name: t().permission.folderSelect?.authorizeButton ?? '' }).focus();

      const second = askWorkspace(id, OTHER_FOLDER);
      await settle();
      expect(screen.getByText(OTHER_FOLDER)).toBeInTheDocument();
      expect(deny()).toHaveFocus();

      await user.keyboard('{Enter}');
      await settle();
      expect(second).toEqual([null]);
      expect(useWorkspaceStore.getState().currentPath).toBeNull();
    });

    it('shows a grant that returns after a conversation switch from its default, with the focus on Deny', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const other = conversation(true);
      const id = conversation();
      render(<ChatView />);
      const answers = askFile(id);
      await settle();
      readable();
      await user.click(screen.getByRole('radio', { name: t().permission.durationAlways }));
      await user.click(screen.getByRole('button', { name: t().permission.allowAlwaysButton }));
      expect(screen.getByText(t().permission.durationAlwaysConfirm)).toBeInTheDocument();

      view(other);
      await settle();
      view(id);
      await settle();
      expect(heading(t().permission.fileWrite.title)).toBeInTheDocument();
      expect(screen.queryByText(t().permission.durationAlwaysConfirm)).toBeNull();
      expect(deny()).toHaveFocus();

      await user.keyboard('{Enter}');
      await settle();
      expect(answers).toEqual([false]);
      expect(grants()).toEqual(NO_GRANTS);
    });

    it('opens a request that names no folder on Select Folder: Enter opens the picker, and nothing is set until it returns a folder', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversation();
      let pick!: (folder: string | null) => void;
      vi.mocked(openDialog).mockImplementation(() => new Promise((resolve) => { pick = resolve; }));
      render(<ChatView />);
      const answers = askWorkspace(id, null);
      await settle();
      expect(screen.getByRole('button', { name: t().permission.folderSelect?.selectButton ?? '' })).toHaveFocus();

      await user.keyboard('{Enter}');
      await settle();
      expect(openDialog).toHaveBeenCalledTimes(1);
      expect(answers).toEqual([]);
      expect(useWorkspaceStore.getState().currentPath).toBeNull();

      await act(async () => { pick(null); });
      await settle();
      expect(answers).toEqual([null]);
      expect(useWorkspaceStore.getState().currentPath).toBeNull();
    });

    it('turns away a window that opens while a file grant is on screen, and the grant stays unanswered', async () => {
      const id = conversation();
      const onSearch = vi.fn();
      const page = (search: boolean) => (
        <>
          <ChatView />
          <Dialog open={search} onOpenChange={onSearch} title="Search" />
        </>
      );
      const shown = render(page(false));
      const answers = askFile(id);
      await settle();

      shown.rerender(page(true));
      await settle();
      expect(onSearch.mock.calls).toEqual([[false]]);
      expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull();
      expect(heading(t().permission.fileWrite.title)).toBeInTheDocument();
      expect(answers).toEqual([]);
      expect(grants()).toEqual(NO_GRANTS);

      shown.rerender(page(false));
      await settle();
      expect(answers).toEqual([]);
      expect(getPendingFilePermission()).not.toBeNull();
    });
  });

  // The workspace panel asks for access to a folder the user picks there, in the same window.
  // It is another request, held in the panel's own state; the chat view's requests and it are
  // on the page one at a time, and an answer to one is no answer to the other.
  describe('with the workspace panel asking about a folder of its own', () => {
    const PANEL_FOLDER = '/fake/alpha';
    const PICKED = '/fake/gamma';
    const page = () => (
      <>
        <ChatView />
        <WorkspaceSection />
      </>
    );
    const panelTitle = () => t().permission.workspace.title;
    const fileTitle = () => t().permission.fileWrite.title;
    const windows = () => screen.queryAllByRole('alertdialog').map((element) => element.querySelector('h2')?.textContent);

    // A conversation that works in the panel's folder, with one more folder in the recent list.
    function conversationInFolder(): string {
      const id = conversation(false, PANEL_FOLDER);
      useWorkspaceStore.setState({ currentPath: PANEL_FOLDER, recentPaths: [PANEL_FOLDER, PICKED] });
      return id;
    }

    async function pickInPanel(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: /alpha/ }));
      await user.click(screen.getByRole('menuitemradio', { name: 'gamma' }));
      await settle();
    }

    it('keeps a file grant of the task off the page while the panel asks; Escape answers the panel alone', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversationInFolder();
      render(page());
      await settle();
      await pickInPanel(user);
      expect(windows()).toEqual([panelTitle()]);

      const answers = askFile(id);
      await settle();
      expect(windows()).toEqual([panelTitle()]);
      expect(answers).toEqual([]);

      await user.keyboard('{Escape}');
      await settle();
      expect(answers).toEqual([]);
      expect(getPendingFilePermission()).not.toBeNull();
      expect(grants()).toEqual(NO_GRANTS);
      expect(useWorkspaceStore.getState().currentPath).toBe(PANEL_FOLDER);
      expect(windows()).toEqual([fileTitle()]);
      expect(screen.getByRole('button', { name: t().permission.deny })).toHaveFocus();

      await user.keyboard('{Escape}');
      await settle();
      expect(answers).toEqual([false]);
      expect(grants()).toEqual(NO_GRANTS);
      expect(windows()).toEqual([]);
    });

    it('keeps the panel\'s question off the page while a file grant of the task is on screen; allowing the grant allows nothing for the folder', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const id = conversationInFolder();
      let pick!: (folder: string | null) => void;
      vi.mocked(openDialog).mockImplementation(() => new Promise((resolve) => { pick = resolve; }));
      render(page());
      await settle();
      // The system folder picker is open when the task asks.
      await user.click(screen.getByRole('button', { name: /alpha/ }));
      await user.click(screen.getByRole('menuitem', { name: t().folder.selectOtherFolder }));
      await settle();
      expect(openDialog).toHaveBeenCalledTimes(1);

      const answers = askFile(id);
      await settle();
      expect(windows()).toEqual([fileTitle()]);

      await act(async () => { pick(PICKED); });
      await settle();
      expect(windows()).toEqual([fileTitle()]);
      expect(screen.queryByText(PICKED)).toBeNull();

      readable();
      await user.click(screen.getByRole('button', { name: t().permission.allowSessionButton }));
      await settle();
      expect(answers).toEqual([true]);
      expect(Object.keys(grants().session)).toEqual([FILE]);
      expect(useWorkspaceStore.getState().currentPath).toBe(PANEL_FOLDER);

      // The panel's question is shown now, from its default, with the focus on Deny.
      expect(windows()).toEqual([panelTitle()]);
      expect(screen.getByText(PICKED)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t().permission.deny })).toHaveFocus();
      await user.keyboard('{Enter}');
      await settle();
      expect(windows()).toEqual([]);
      expect(Object.keys(grants().session)).toEqual([FILE]);
      expect(useWorkspaceStore.getState().currentPath).toBe(PANEL_FOLDER);
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

  // The question dock goes through the same bridge. It leaves the focus with a user who is
  // writing, so a screen reader hears of it through the page's live element.
  describe('a question of the agent that arrives while the user writes a message', () => {
    const QUESTION: UserQuestionPayload = {
      questions: [{ header: 'Format', question: 'Which format do you want?', multiSelect: false, options: [{ label: 'Long' }, { label: 'Short' }] }],
    };
    const liveElement = () => document.querySelector<HTMLElement>('[aria-live="polite"][aria-atomic="true"]');
    const messageField = () => screen.getByRole('textbox', { name: 'Message' });
    function conversationThatAsks(): string {
      const id = conversation();
      useChatStore.getState().addMessage(id, {
        id: `asks-${id}`, role: 'assistant', content: '', loopId: `loop-${id}`, timestamp: 2,
        toolCalls: [{ id: 'question-1', name: 'ask_user_question', input: {} }],
      });
      return id;
    }
    afterEach(() => { drainUserQuestions(); });

    it('keeps one polite live element on the chat page, empty while no question has arrived', () => {
      conversationThatAsks();
      render(<ChatView />);
      expect(liveElement()).toBeInTheDocument();
      expect(liveElement()).toBeEmptyDOMElement();
      expect(liveElement()).toHaveClass('sr-only');
    });

    it('writes the header and the question into it when the dock leaves the focus in the message field, and empties it when the question is answered', async () => {
      const id = conversationThatAsks();
      render(<ChatView />);
      const live = liveElement();
      act(() => { messageField().focus(); });
      noteComposerKey();
      act(() => { void requestUserQuestion('question-1', id, QUESTION); });
      await settle();

      expect(screen.getByRole('group', { name: 'Which format do you want?' })).toBeInTheDocument();
      expect(messageField()).toHaveFocus();
      expect(liveElement()).toBe(live);
      expect(live).toHaveTextContent('Format');
      expect(live).toHaveTextContent('Which format do you want?');

      act(() => { resolveUserQuestion('question-1', null); });
      await settle();
      expect(screen.queryByRole('group', { name: 'Which format do you want?' })).toBeNull();
      expect(live).toBeEmptyDOMElement();
    });

    it('writes nothing into it when the dock takes the focus', async () => {
      const id = conversationThatAsks();
      render(<ChatView />);
      act(() => { void requestUserQuestion('question-1', id, QUESTION); });
      await settle();

      expect(screen.getByRole('group', { name: 'Which format do you want?' })).toHaveFocus();
      expect(liveElement()).toBeEmptyDOMElement();
    });
  });
});
