// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getI18n, format } from '@/i18n';
import type { Conversation, ConversationBranchOrigin } from '@/types';
import { ConversationBranchOrigin as Origin } from './ConversationBranchOrigin';

const origin: ConversationBranchOrigin = { version: 1, sourceConversationId: 'parent', sourceMessageId: 'exact-reply',
  sourceTitle: 'Parent', inheritedThroughMessageId: 'child-reply' };
const parent: Conversation = { id: 'parent', title: 'Parent', createdAt: 1, updatedAt: 2, status: 'idle', messages: [
  { id: 'question', role: 'user', content: 'Question', timestamp: 1 },
  { id: 'exact-reply', role: 'assistant', content: 'Repeated answer', timestamp: 2 },
  { id: 'other-reply', role: 'assistant', content: 'Repeated answer', timestamp: 3 },
] };
beforeEach(() => {
  useChatStore.setState({ activeConversationId: 'child', pendingSearchJump: null, loadFailures: {},
    conversations: { parent, child: { ...parent, id: 'child', branchOrigin: origin } },
    conversationIndex: { parent: { id: 'parent', title: 'Parent', createdAt: 1, updatedAt: 2, messageCount: 3 } } });
  useSettingsStore.setState({ viewMode: 'chat' });
});
afterEach(cleanup);

describe('branch origin navigation', () => {
  it('opens the exact original reply when reply text appears more than once', async () => {
    render(<Origin origin={origin} workspacePath="/work" />);
    expect(screen.getByText(getI18n().chat.branch.currentFiles)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: format(getI18n().chat.branch.source, { title: 'Parent' }) }));
    await waitFor(() => expect(useChatStore.getState().activeConversationId).toBe('parent'));
    expect(useChatStore.getState().pendingSearchJump).toEqual({ convId: 'parent', query: '', messageId: 'exact-reply' });
  });

  it('keeps the child open when its original reply was removed', () => {
    useChatStore.setState({ conversations: { ...useChatStore.getState().conversations, parent: { ...parent, messages: parent.messages.filter(message => message.id !== 'exact-reply') } } });
    render(<Origin origin={origin} />);
    expect(screen.getByText(getI18n().chat.branch.sourceUnavailable)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(useChatStore.getState().activeConversationId).toBe('child');
  });

  it('keeps inherited history available when the source was deleted', () => {
    useChatStore.setState({ conversationIndex: {} });
    render(<Origin origin={origin} />);
    expect(screen.getByText(getI18n().chat.branch.sourceDeleted)).toBeTruthy();
    expect(screen.getByText(getI18n().chat.branch.boundary)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(useChatStore.getState().activeConversationId).toBe('child');
  });

  it('reports an unreadable source without navigating', () => {
    useChatStore.setState({ loadFailures: { parent: true } });
    render(<Origin origin={origin} />);
    expect(screen.getByText(getI18n().chat.branch.sourceInaccessible)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(useChatStore.getState().activeConversationId).toBe('child');
  });
});
