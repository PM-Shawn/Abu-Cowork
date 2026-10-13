// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render as renderBare, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { resolveFileSource } from '@/core/session/outputSnapshots';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import type { Conversation, Message } from '@/types';
import MessageGroup from './MessageGroup';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

vi.mock('@/core/session/outputSnapshots', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/session/outputSnapshots')>(),
  resolveFileSource: vi.fn(),
}));

const CONVERSATION = 'conversation-1';
const ORIGINAL = '/fake/project/notes.md';
const COPY = '/fake/data/conversations/conversation-1/outputs/files/ab12/notes.md';

// A turn of a conversation whose messages carry no file-card mark: its cards
// and its preview at the end of the run come from the files its tools wrote.
const userMessage: Message = { id: 'user-1', role: 'user', content: 'write the notes', timestamp: 1_000, loopId: 'loop-1' };
const assistantMessage: Message = {
  id: 'assistant-1',
  role: 'assistant',
  content: 'Done.',
  timestamp: 2_000,
  loopId: 'loop-1',
  toolCalls: [{ id: 'call-1', name: 'write_file', input: { path: ORIGINAL, content: '# Notes' }, result: 'ok' }],
};

function seed(status: Conversation['status']) {
  const conversation: Conversation = {
    id: CONVERSATION,
    title: 'Notes',
    messages: [userMessage, assistantMessage],
    createdAt: 1_000,
    updatedAt: 3_000,
    status,
  };
  useChatStore.setState({
    activeConversationId: CONVERSATION,
    conversations: { [CONVERSATION]: conversation },
    agentStates: new Map(),
  });
}

function endRun() {
  act(() => {
    useChatStore.setState((state) => ({
      conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], status: 'idle' } },
    }));
  });
}

describe('MessageGroup preview at the end of a run whose file cards are inferred', () => {
  const openPreview = vi.fn();
  const realOpenPreview = usePreviewStore.getState().openPreview;

  beforeEach(() => {
    initLanguage('en-US');
    openPreview.mockClear();
    usePreviewStore.setState({ openPreview, currentConversationId: CONVERSATION });
  });

  afterEach(() => {
    cleanup();
    usePreviewStore.setState({ openPreview: realOpenPreview, currentConversationId: null });
    useWorkProcessFoldStore.getState().reset();
    vi.mocked(resolveFileSource).mockReset();
  });

  it('opens the file at its own path with no mark', async () => {
    vi.mocked(resolveFileSource).mockResolvedValue({ status: 'available', path: ORIGINAL, isFromSnapshot: false });
    seed('running');
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    endRun();

    await waitFor(() => expect(openPreview.mock.calls).toEqual([[ORIGINAL]]));
  });

  it('opens the kept copy of a file that is gone from its path, and says which file it is a copy of', async () => {
    vi.mocked(resolveFileSource).mockResolvedValue({ status: 'available', path: COPY, isFromSnapshot: true });
    seed('running');
    render(<MessageGroup conversationId={CONVERSATION} messages={[userMessage, assistantMessage]} isLastGroup />);

    endRun();

    await waitFor(() => expect(openPreview.mock.calls).toEqual([[COPY, { keptCopyOf: ORIGINAL }]]));
  });
});
