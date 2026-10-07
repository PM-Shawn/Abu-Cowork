// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render as renderBare, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import ChatView from './ChatView';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getI18n } from '@/i18n';
import * as conversationStorage from '@/core/session/conversationStorage';
import type { Message } from '@/types';

vi.mock('@/core/session/conversationStorage', async () => {
  const actual = await vi.importActual<typeof import('@/core/session/conversationStorage')>('@/core/session/conversationStorage');
  return { ...actual, loadMessages: vi.fn(async () => []), replaceMessageById: vi.fn(async () => undefined) };
});
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: vi.fn() }));
vi.mock('./ScenarioGuide', () => ({ default: () => null }));
vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(_props: unknown, ref) {
      React.useImperativeHandle(ref, () => ({ scrollToIndex: () => undefined }));
      return React.createElement('div', { 'data-testid': 'mock-virtuoso' });
    }),
  };
});
vi.mock('./ChatInput', async () => {
  const React = await import('react');
  return { default: () => React.createElement('textarea', { 'data-chat-composer': '', 'aria-label': 'message field' }) };
});
vi.mock('./AgentStatusStrip', () => ({ default: () => null }));
vi.mock('./QueuedMessagesStrip', () => ({ default: () => null }));

const loadMessages = vi.mocked(conversationStorage.loadMessages);
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const HOST_PATH = '/Users/someone/Library/Application Support/abu/conversations/c1/messages.jsonl';
const HOST_ERROR = `EACCES: permission denied, open '${HOST_PATH}'`;
const message = (id: string, role: Message['role'], content: string): Message => ({ id, role, content, loopId: 'loop-1', timestamp: 1 });

/** c1 is in view and its record could not be read; c2 is another conversation of the index. */
async function givenUnreadableConversationInView(): Promise<void> {
  useChatStore.setState({
    conversationIndex: {
      c1: { id: 'c1', title: 'first', createdAt: 1, updatedAt: 1, messageCount: 2 },
      c2: { id: 'c2', title: 'second', createdAt: 1, updatedAt: 1, messageCount: 2 },
    },
  });
  loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
  await useChatStore.getState().switchConversation('c1');
}

/** Every attribute value and every piece of text under the page. */
function everythingOnThePage(): string {
  const attributes = [...document.querySelectorAll('*')]
    .flatMap((node) => [...node.attributes].map((attribute) => `${attribute.name}=${attribute.value}`));
  return [document.body.textContent ?? '', ...attributes].join('\n');
}

describe('ChatView: a conversation whose record cannot be read', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    loadMessages.mockReset();
    loadMessages.mockResolvedValue([]);
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('says that the record cannot be read, in the existing words, with a retry button', async () => {
    await givenUnreadableConversationInView();
    render(<ChatView />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(getI18n().panel.failedToReadFile);
    expect(screen.getByRole('button', { name: getI18n().common.retry })).toBeInTheDocument();
    expect(screen.queryByText(getI18n().chat.welcomeTitle)).toBeNull();
    expect(screen.queryByText(getI18n().common.loading)).toBeNull();
  });

  it('puts nothing of the host error on the page: no text, no title, no aria-label, no data attribute', async () => {
    await givenUnreadableConversationInView();
    render(<ChatView />);
    const page = everythingOnThePage();
    expect(page).not.toContain(HOST_PATH);
    expect(page).not.toContain('messages.jsonl');
    expect(page).not.toContain('/Users/');
    expect(page).not.toContain('EACCES');
    expect(page).not.toContain('permission denied');
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('[title]')).toBeNull();
    expect(alert.textContent).toBe(`${getI18n().panel.failedToReadFile}${getI18n().common.retry}`);
  });

  it('retry reads once per press, is busy while it reads, keeps the explanation when the read fails again, and shows the conversation when it succeeds', async () => {
    const user = userEvent.setup({ delay: null });
    await givenUnreadableConversationInView();
    render(<ChatView />);
    const retry = screen.getByRole('button', { name: getI18n().common.retry });
    expect(loadMessages).toHaveBeenCalledTimes(1);

    let fail!: (error: Error) => void;
    loadMessages.mockReturnValueOnce(new Promise<Message[]>((_resolve, reject) => { fail = reject; }));
    await user.click(retry);
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(getI18n().panel.failedToReadFile);
    // A second press while the read is in flight starts no second read.
    await user.click(retry);
    retry.focus();
    await user.keyboard('{Enter}');
    expect(loadMessages).toHaveBeenCalledTimes(2);

    await act(async () => { fail(new Error(HOST_ERROR)); });
    await waitFor(() => expect(retry).not.toHaveAttribute('aria-disabled'));
    expect(retry).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(getI18n().panel.failedToReadFile);
    expect(everythingOnThePage()).not.toContain('EACCES');

    loadMessages.mockResolvedValueOnce([message('m1', 'user', 'hello'), message('m2', 'assistant', 'answer')]);
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(loadMessages).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('mock-virtuoso')).toBeInTheDocument();
    expect(useChatStore.getState().loadFailures).toEqual({});
  });

  it('shows no explanation on another conversation, and shows it again on the way back, with a button that is not busy', async () => {
    const user = userEvent.setup({ delay: null });
    await givenUnreadableConversationInView();
    render(<ChatView />);
    loadMessages.mockReturnValueOnce(new Promise<Message[]>(() => undefined));
    await user.click(screen.getByRole('button', { name: getI18n().common.retry }));
    await waitFor(() => expect(loadMessages).toHaveBeenCalledTimes(2));

    loadMessages.mockResolvedValueOnce([message('n1', 'user', 'other'), message('n2', 'assistant', 'other answer')]);
    await act(async () => { await useChatStore.getState().switchConversation('c2'); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('mock-virtuoso')).toBeInTheDocument();

    // Coming back reads the record again; it still cannot be read.
    loadMessages.mockRejectedValueOnce(new Error(HOST_ERROR));
    await act(async () => { await useChatStore.getState().switchConversation('c1'); });
    expect(loadMessages).toHaveBeenCalledTimes(4);
    expect(screen.getByRole('alert')).toHaveTextContent(getI18n().panel.failedToReadFile);
    expect(screen.getByRole('button', { name: getI18n().common.retry })).not.toHaveAttribute('aria-disabled');
  });

  it('a read from elsewhere that succeeds while 重试 has the focus hands the focus to the message field', async () => {
    await givenUnreadableConversationInView();
    render(<ChatView />);
    screen.getByRole('button', { name: getI18n().common.retry }).focus();

    // Not the retry: another caller (crash recovery, an inbound channel message) reads the record.
    loadMessages.mockResolvedValueOnce([message('m1', 'user', 'hello'), message('m2', 'assistant', 'answer')]);
    await act(async () => { await useChatStore.getState().loadConversation('c1'); });
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(screen.getByLabelText('message field')).toHaveFocus());
  });

  it('a read from elsewhere that succeeds takes the focus from no control that has it', async () => {
    await givenUnreadableConversationInView();
    render(
      <>
        <Button>elsewhere</Button>
        <ChatView />
      </>,
    );
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();

    loadMessages.mockResolvedValueOnce([message('m1', 'user', 'hello'), message('m2', 'assistant', 'answer')]);
    await act(async () => { await useChatStore.getState().loadConversation('c1'); });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(elsewhere).toHaveFocus();
  });

  it('leaving for another conversation while 重试 has the focus moves no focus to the message field', async () => {
    await givenUnreadableConversationInView();
    render(<ChatView />);
    screen.getByRole('button', { name: getI18n().common.retry }).focus();

    loadMessages.mockResolvedValueOnce([message('n1', 'user', 'other'), message('n2', 'assistant', 'other answer')]);
    await act(async () => { await useChatStore.getState().switchConversation('c2'); });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(screen.getByLabelText('message field')).not.toHaveFocus();
  });

  it('leaves with the conversation when it is deleted', async () => {
    await givenUnreadableConversationInView();
    render(<ChatView />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    loadMessages.mockResolvedValueOnce([message('n1', 'user', 'other'), message('n2', 'assistant', 'other answer')]);
    await act(async () => { useChatStore.getState().deleteConversation('c1'); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(useChatStore.getState().loadFailures).toEqual({});
  });

  it('a conversation that is still being read shows the loading line, not the explanation', () => {
    useChatStore.setState({
      conversationIndex: { c1: { id: 'c1', title: 'first', createdAt: 1, updatedAt: 1, messageCount: 2 } },
      activeConversationId: 'c1',
    });
    render(<ChatView />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(getI18n().common.loading)).toBeInTheDocument();
  });
});
