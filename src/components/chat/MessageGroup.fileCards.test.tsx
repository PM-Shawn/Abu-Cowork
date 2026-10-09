// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { Conversation, Message, ToolCall } from '@/types';
import MessageGroup from './MessageGroup';

const exists = vi.fn<(path: string) => Promise<boolean>>();
vi.mock('@/core/tools/fsBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/tools/fsBridge')>()),
  exists: (path: string) => exists(path),
}));

vi.mock('@/core/session/outputSnapshots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/session/outputSnapshots')>()),
  resolveFileSource: vi.fn(async (_conversationId: unknown, filePath: string) => ({
    status: 'available', path: filePath, isFromSnapshot: false,
  })),
}));

vi.mock('@/utils/pathUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/pathUtils')>()),
  loadLocalImage: vi.fn(async () => 'blob:image'),
}));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const CONVERSATION_ID = 'conversation-file-cards';

function presentCall(files: { path: string; description?: string }[], id = 'present'): ToolCall {
  return {
    id,
    name: TOOL_NAMES.PRESENT_FILES,
    input: { files },
    result: files.map((file) => `Presented ${file.path}`).join('\n'),
  };
}

function writeCall(path: string, id = 'write'): ToolCall {
  return { id, name: TOOL_NAMES.WRITE_FILE, input: { path, content: 'text' }, result: 'ok' };
}

function turn(toolCalls: ToolCall[], options: { declared: boolean; answer?: string } = { declared: true }): Message[] {
  const marker = options.declared ? { fileCards: 'declared' as const } : {};
  return [
    { id: 'user', role: 'user', content: 'make the files', timestamp: 1_000, loopId: 'loop', runState: 'completed', runEndedAt: 3_000 },
    { id: 'work', role: 'assistant', content: '', timestamp: 2_000, loopId: 'loop', toolCalls, ...marker },
    { id: 'answer', role: 'assistant', content: options.answer ?? 'All done.', timestamp: 2_500, loopId: 'loop', ...marker },
  ];
}

function setConversation(messages: Message[], status: Conversation['status'] = 'idle') {
  const conversation: Conversation = {
    id: CONVERSATION_ID, title: 'Files', messages, createdAt: 1_000, updatedAt: 3_000, status,
  };
  useChatStore.setState({
    activeConversationId: conversation.id,
    conversations: { [conversation.id]: conversation },
    agentStates: new Map(),
  });
  return conversation;
}

/** File cards are the buttons that open the side preview. */
const cardButtons = () => screen.queryAllByTitle('Click to preview');

function numberedFiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({ path: `/ws/file-${index + 1}.md` }));
}

describe('MessageGroup file cards', () => {
  let onDisk: (path: string) => boolean;
  const originalOpenPreview = usePreviewStore.getState().openPreview;

  beforeEach(() => {
    initLanguage('en-US');
    onDisk = () => true;
    exists.mockReset();
    exists.mockImplementation(async (path) => onDisk(path));
    usePreviewStore.setState({
      openPreview: originalOpenPreview,
      tabs: [], currentConversationId: CONVERSATION_ID, activeTabId: null,
      panelStateByConversation: {}, lastActiveTabByConversation: {},
    });
  });

  afterEach(() => {
    useWorkProcessFoldStore.getState().reset();
    cleanup();
    vi.restoreAllMocks();
    usePreviewStore.setState({ openPreview: originalOpenPreview });
  });

  describe('declared turn', () => {
    it('shows four of six presented files, then all six, and no card for a file that was only written', async () => {
      const messages = turn([writeCall('/ws/draft.md'), presentCall(numberedFiles(6))]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      const expand = await screen.findByRole('button', { name: 'All 6 files' });
      expect(cardButtons()).toHaveLength(4);
      expect(expand).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTitle('draft.md')).toBeNull();

      fireEvent.click(expand);
      expect(cardButtons()).toHaveLength(6);
      const collapse = screen.getByRole('button', { name: 'Collapse' });
      expect(collapse).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByRole('button', { name: 'All 6 files' })).toBeNull();
      expect(screen.queryByTitle('draft.md')).toBeNull();

      fireEvent.click(collapse);
      expect(cardButtons()).toHaveLength(4);
    });

    it('shows no expand button for four files', async () => {
      const messages = turn([presentCall(numberedFiles(4))]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      await waitFor(() => expect(cardButtons()).toHaveLength(4));
      expect(screen.queryByRole('button', { name: /All \d+ files/ })).toBeNull();
    });

    it('leaves out a presented file that is not on disk and counts only the cards shown', async () => {
      onDisk = (path) => path !== '/ws/file-2.md';
      const messages = turn([presentCall(numberedFiles(6))]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      await screen.findByRole('button', { name: 'All 5 files' });
      fireEvent.click(screen.getByRole('button', { name: 'All 5 files' }));
      expect(cardButtons()).toHaveLength(5);
      expect(screen.queryByTitle('file-2.md')).toBeNull();
      expect(screen.getByTitle('file-3.md')).toBeInTheDocument();
    });

    it('renders no card and no placeholder when none of the presented files is on disk', async () => {
      onDisk = () => false;
      const messages = turn([presentCall(numberedFiles(2))]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      await waitFor(() => expect(exists).toHaveBeenCalledTimes(2));
      await act(async () => {});
      expect(cardButtons()).toHaveLength(0);
      expect(screen.queryByTitle('file-1.md')).toBeNull();
      expect(screen.queryByText('File no longer accessible')).toBeNull();
    });

    it('renders no card before the disk check answers', async () => {
      const pending: ((present: boolean) => void)[] = [];
      exists.mockImplementation(() => new Promise<boolean>((resolve) => { pending.push(resolve); }));
      const messages = turn([presentCall(numberedFiles(1))]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      await waitFor(() => expect(pending).toHaveLength(1));
      expect(cardButtons()).toHaveLength(0);
      await act(async () => { pending[0](true); });
      expect(cardButtons()).toHaveLength(1);
    });

    it('shows the description under the file name, and the file type when there is none', async () => {
      const messages = turn([presentCall([
        { path: '/ws/report.docx', description: 'Quarterly report' },
        { path: '/ws/notes.md' },
      ])]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      expect(await screen.findByText('Quarterly report')).toBeInTheDocument();
      expect(screen.getByTitle('report.docx')).toHaveTextContent('report');
      expect(screen.queryByText('Document · DOCX')).toBeNull();
      expect(screen.getByText('Document · MD')).toBeInTheDocument();
    });

    it('shows a file written but not presented without a card', async () => {
      const messages = turn([writeCall('/ws/draft.md')]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      await act(async () => {});
      expect(cardButtons()).toHaveLength(0);
      expect(exists).not.toHaveBeenCalled();
    });

    it('takes the cards of a failed present_files call off the list', async () => {
      const failed: ToolCall = {
        id: 'present-failed',
        name: TOOL_NAMES.PRESENT_FILES,
        input: { files: [{ path: '/ws/missing.md' }] },
        result: 'Error: Nothing was presented.',
      };
      const messages = turn([failed]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      await act(async () => {});
      expect(cardButtons()).toHaveLength(0);
      expect(exists).not.toHaveBeenCalled();
    });

    it('shows an image produced by generate_image as an image card', async () => {
      const generate: ToolCall = {
        id: 'generate',
        name: TOOL_NAMES.GENERATE_IMAGE,
        input: { prompt: 'a chart' },
        result: '图片已保存到: /ws/chart.png',
      };
      const messages = turn([generate]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      expect(await screen.findByRole('img', { name: 'chart.png' })).toBeInTheDocument();
    });

    it('takes a card away when its file leaves the disk and brings it back when the file returns', async () => {
      let present = true;
      onDisk = () => present;
      const messages = turn([presentCall(numberedFiles(1))]);
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
      await waitFor(() => expect(cardButtons()).toHaveLength(1));

      present = false;
      act(() => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(cardButtons()).toHaveLength(0));

      present = true;
      act(() => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(cardButtons()).toHaveLength(1));
    });

    it('keeps the cards off while the run is still going', async () => {
      const messages = turn([presentCall(numberedFiles(1))]);
      setConversation(messages, 'running');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      await act(async () => {});
      expect(cardButtons()).toHaveLength(0);
      expect(exists).not.toHaveBeenCalled();
    });
  });

  describe('turn without the declared marker', () => {
    it('still infers a card from a written file', async () => {
      const messages = turn([writeCall('/ws/report.md')], { declared: false });
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      expect(await screen.findByTitle('report.md')).toBeInTheDocument();
      expect(screen.getByText('Document · MD')).toBeInTheDocument();
      expect(exists).not.toHaveBeenCalled();
    });

    it('does not read present_files as its card list', async () => {
      const messages = turn([presentCall([{ path: '/ws/slides.pptx', description: 'Deck' }])], { declared: false });
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      await act(async () => {});
      expect(screen.queryByText('Deck')).toBeNull();
      expect(exists).not.toHaveBeenCalled();
    });
  });

  describe('file names in the reply text', () => {
    it('opens a file the declared turn wrote but did not present, at the line the text names', async () => {
      const messages = turn([writeCall('/ws/src/app.ts')], {
        declared: true,
        answer: 'I changed `app.ts`, see `/ws/src/app.ts:24`. `other.ts` is untouched.',
      });
      setConversation(messages);
      const open = vi.spyOn(usePreviewStore.getState(), 'openPreview');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      const mentions = screen.getAllByRole('button', { name: 'Preview app.ts' });
      expect(mentions.map((button) => button.textContent)).toEqual(['app.ts', '/ws/src/app.ts:24']);
      expect(screen.getByText('other.ts').closest('button')).toBeNull();

      fireEvent.click(mentions[1]);
      expect(open).toHaveBeenCalledWith('/ws/src/app.ts', { line: 24 });
      await act(async () => {});
      expect(cardButtons()).toHaveLength(0);
    });

    it('opens a presented file named by a relative path the workspace resolves', () => {
      const messages = turn([presentCall([{ path: 'out/report.md' }])], {
        declared: true,
        answer: 'The report is at `/ws/out/report.md`.',
      });
      useChatStore.setState({
        activeConversationId: CONVERSATION_ID,
        conversations: {
          [CONVERSATION_ID]: {
            id: CONVERSATION_ID, title: 'Files', messages, createdAt: 1_000, updatedAt: 3_000, status: 'idle', workspacePath: '/ws',
          },
        },
        agentStates: new Map(),
      });
      const open = vi.spyOn(usePreviewStore.getState(), 'openPreview');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      fireEvent.click(screen.getByRole('button', { name: 'Preview report.md' }));
      expect(open).toHaveBeenCalledWith('/ws/out/report.md', { line: undefined });
    });

    it('leaves the text of a turn without the declared marker as plain code', () => {
      const messages = turn([writeCall('/ws/src/app.ts')], { declared: false, answer: 'I changed `app.ts`.' });
      setConversation(messages);

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);

      expect(screen.queryByRole('button', { name: 'Preview app.ts' })).toBeNull();
      expect(screen.getByText('app.ts').tagName).toBe('CODE');
    });
  });

  describe('automatic preview of a declared turn', () => {
    async function finishRun(conversation: Conversation) {
      await act(async () => {
        useChatStore.setState({ conversations: { [conversation.id]: { ...conversation, status: 'idle' } } });
      });
    }

    it('opens the last presented file that is not an image, once', async () => {
      const messages = turn([presentCall([
        { path: '/ws/report.docx' },
        { path: '/ws/summary.md' },
        { path: '/ws/chart.png' },
      ])]);
      const conversation = setConversation(messages, 'running');
      const open = vi.spyOn(usePreviewStore.getState(), 'openPreview');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
      expect(open).not.toHaveBeenCalled();

      await finishRun(conversation);
      await waitFor(() => expect(open).toHaveBeenCalledWith('/ws/summary.md'));

      act(() => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(exists.mock.calls.length).toBeGreaterThanOrEqual(6));
      await act(async () => {});
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('opens the last image when every presented file is an image', async () => {
      const messages = turn([presentCall([{ path: '/ws/a.png' }, { path: '/ws/b.png' }])]);
      const conversation = setConversation(messages, 'running');
      const open = vi.spyOn(usePreviewStore.getState(), 'openPreview');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
      await finishRun(conversation);

      await waitFor(() => expect(open).toHaveBeenCalledWith('/ws/b.png'));
    });

    it('skips a presented file that is not on disk', async () => {
      onDisk = (path) => path !== '/ws/summary.md';
      const messages = turn([presentCall([{ path: '/ws/report.docx' }, { path: '/ws/summary.md' }])]);
      const conversation = setConversation(messages, 'running');
      const open = vi.spyOn(usePreviewStore.getState(), 'openPreview');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
      await finishRun(conversation);

      await waitFor(() => expect(open).toHaveBeenCalledWith('/ws/report.docx'));
    });

    it('opens nothing when the turn presented no file', async () => {
      const messages = turn([writeCall('/ws/draft.md')]);
      const conversation = setConversation(messages, 'running');
      const open = vi.spyOn(usePreviewStore.getState(), 'openPreview');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
      await finishRun(conversation);
      await act(async () => {});

      expect(open).not.toHaveBeenCalled();
    });

    it('opens nothing for a turn that was already finished when it was shown', async () => {
      const messages = turn([presentCall(numberedFiles(1))]);
      setConversation(messages);
      const open = vi.spyOn(usePreviewStore.getState(), 'openPreview');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
      await waitFor(() => expect(cardButtons()).toHaveLength(1));

      expect(open).not.toHaveBeenCalled();
    });

    it('opens nothing for a group that is not the last one', async () => {
      const messages = turn([presentCall(numberedFiles(1))]);
      const conversation = setConversation(messages, 'running');
      const open = vi.spyOn(usePreviewStore.getState(), 'openPreview');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} />);
      await finishRun(conversation);
      await waitFor(() => expect(cardButtons()).toHaveLength(1));

      expect(open).not.toHaveBeenCalled();
    });

    it('opens nothing once another conversation is in view', async () => {
      const messages = turn([presentCall(numberedFiles(1))]);
      const conversation = setConversation(messages, 'running');
      const open = vi.spyOn(usePreviewStore.getState(), 'openPreview');

      render(<MessageGroup conversationId={CONVERSATION_ID} messages={messages} isLastGroup />);
      await act(async () => {
        useChatStore.setState({
          activeConversationId: 'other',
          conversations: {
            [conversation.id]: { ...conversation, status: 'idle' },
            other: { ...conversation, id: 'other', status: 'idle' },
          },
        });
        usePreviewStore.getState().closeTabsForConversationSwitch('other');
      });
      await waitFor(() => expect(exists).toHaveBeenCalled());
      await act(async () => {});

      expect(open).not.toHaveBeenCalled();
    });
  });
});
