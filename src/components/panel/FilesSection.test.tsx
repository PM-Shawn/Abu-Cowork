// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { DesignSystemProvider } from '@/components/ds/provider';
import { resolveFileSource } from '@/core/session/outputSnapshots';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import type { Conversation, ToolCall } from '@/types';
import FilesSection from './FilesSection';

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/core/session/outputSnapshots', () => ({
  resolveFileSource: vi.fn(),
}));

const extractions = vi.hoisted(() => vi.fn());

// Counts how often the section rebuilds its file list.
vi.mock('@/utils/workflowExtractor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/workflowExtractor')>();
  return {
    ...actual,
    extractFileOutputs: (...args: Parameters<typeof actual.extractFileOutputs>) => {
      extractions();
      return actual.extractFileOutputs(...args);
    },
  };
});

const iconButtonRenders = vi.hoisted(() => vi.fn());

// Counts renders of each row's only floating-layer control (the reveal button's tooltip).
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      iconButtonRenders();
      return actual.IconButton(props);
    },
  };
});

const CONV = 'conv-files';
const READ_PATH = '/work/notes.md';
const WRITE_PATH = '/work/main.ts';
const CREATE_PATH = '/work/data.json';

function toolCall(id: string, name: string, path: string): ToolCall {
  return { id, name, input: { path }, result: 'ok' };
}

function seedConversation(toolCalls: ToolCall[]) {
  const conversation = {
    id: CONV,
    title: 'Files',
    messages: [
      { id: 'm1', role: 'assistant', content: 'Working', timestamp: 1, toolCalls },
      { id: 'm2', role: 'assistant', content: '', timestamp: 2 },
    ],
    createdAt: 1,
    updatedAt: 2,
    status: 'running',
  } as Conversation;
  useChatStore.setState({ activeConversationId: CONV, conversations: { [CONV]: conversation } });
}

function streamIntoLastMessage(content: string) {
  act(() => {
    useChatStore.setState((state) => {
      const conversation = state.conversations[CONV];
      const messages = conversation.messages.slice();
      messages[messages.length - 1] = { ...messages[messages.length - 1], content };
      return { conversations: { ...state.conversations, [CONV]: { ...conversation, messages } } };
    });
  });
}

function renderSection() {
  return render(
    <DesignSystemProvider>
      <FilesSection />
    </DesignSystemProvider>,
  );
}

const THREE_FILES = [
  toolCall('t1', 'read_file', READ_PATH),
  toolCall('t2', 'write_file', WRITE_PATH),
  toolCall('t3', 'create_file', CREATE_PATH),
];

describe('FilesSection', () => {
  const openPreview = vi.fn();
  const realOpenPreview = usePreviewStore.getState().openPreview;

  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(resolveFileSource).mockReset().mockImplementation(async (_conversationId, path) => (
      { status: 'available', path, isFromSnapshot: false }
    ));
    vi.mocked(revealItemInDir).mockClear();
    iconButtonRenders.mockClear();
    extractions.mockClear();
    openPreview.mockClear();
    usePreviewStore.setState({ openPreview });
  });

  afterEach(() => {
    cleanup();
    usePreviewStore.setState({ openPreview: realOpenPreview });
  });

  it('labels read, modified and created files with the same neutral tag', async () => {
    seedConversation(THREE_FILES);
    renderSection();
    await screen.findAllByRole('button', { name: 'Show in File Manager' });

    for (const label of ['Read', 'Modify', 'Create']) {
      const tag = screen.getByText(label);
      expect(tag).toHaveClass('bg-fill');
      expect(tag).not.toHaveClass('bg-info-soft');
      expect(tag).not.toHaveClass('bg-warning-soft');
      expect(tag).not.toHaveClass('bg-success-soft');
    }
    expect(screen.getByRole('heading', { name: 'Operated Files' })).toBeInTheDocument();
  });

  it('opens the preview from the file name and keeps the reveal button a separate control', async () => {
    const user = userEvent.setup();
    seedConversation([toolCall('t1', 'read_file', READ_PATH)]);
    renderSection();
    const reveal = await screen.findByRole('button', { name: 'Show in File Manager' });
    const file = screen.getByRole('button', { name: /notes\.md/ });
    expect(file).toHaveAttribute('title', `Click to preview: ${READ_PATH}`);
    expect(file).not.toContainElement(reveal);

    await user.click(reveal);

    expect(revealItemInDir).toHaveBeenCalledWith(READ_PATH);
    expect(openPreview).not.toHaveBeenCalled();

    await user.click(file);

    expect(openPreview).toHaveBeenCalledWith(READ_PATH);
  });

  it('dims a file that is gone, strikes it through when it was written, and offers no reveal button', async () => {
    vi.mocked(resolveFileSource).mockImplementation(async (_conversationId, path) => (
      { status: 'missing', basename: path, originalPath: path }
    ));
    seedConversation([toolCall('t1', 'read_file', READ_PATH), toolCall('t2', 'write_file', WRITE_PATH)]);
    renderSection();

    const written = await screen.findByRole('button', { name: /main\.ts/ });
    await waitFor(() => expect(written).toHaveAttribute('title', `File no longer accessible: ${WRITE_PATH}`));
    expect(screen.getByText('main.ts')).toHaveClass('line-through');
    expect(screen.getByText('notes.md')).not.toHaveClass('line-through');
    expect(written.parentElement).toHaveClass('opacity-60');
    expect(screen.queryByRole('button', { name: 'Show in File Manager' })).not.toBeInTheDocument();
  });

  it('shows seven files and reveals the rest on request', async () => {
    const user = userEvent.setup();
    seedConversation(Array.from({ length: 9 }, (_, i) => toolCall(`t${i}`, 'read_file', `/work/file-${i}.md`)));
    renderSection();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Show in File Manager' })).toHaveLength(7));

    await user.click(screen.getByRole('button', { name: '2 more files...' }));

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Show in File Manager' })).toHaveLength(9));
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
  });

  // Each row is memoized on plain strings: streamed text renders no tooltip button,
  // and a file that joins the list renders only its own.
  it('does not re-render the rows that are already there', async () => {
    seedConversation(THREE_FILES);
    renderSection();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Show in File Manager' })).toHaveLength(3));
    const before = iconButtonRenders.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    streamIntoLastMessage('a');
    streamIntoLastMessage('ab');
    streamIntoLastMessage('abc');

    expect(iconButtonRenders.mock.calls.length).toBe(before);

    act(() => {
      useChatStore.setState((state) => {
        const conversation = state.conversations[CONV];
        const messages = conversation.messages.slice();
        messages[messages.length - 1] = { ...messages[messages.length - 1], toolCalls: [toolCall('t9', 'write_file', '/work/extra.md')] };
        return { conversations: { ...state.conversations, [CONV]: { ...conversation, messages } } };
      });
    });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Show in File Manager' })).toHaveLength(4));
    await act(async () => {});

    // The new row renders its button when it mounts and once more when its file resolves.
    expect(iconButtonRenders.mock.calls.length).toBe(before + 2);
  });

  // Streamed text leaves every message's tool calls as they are, so the file list
  // is not rebuilt; a tool call that finishes rebuilds it once and shows its file.
  it('rebuilds the file list for a finished tool call, not for streamed text', async () => {
    seedConversation([toolCall('t1', 'read_file', READ_PATH)]);
    renderSection();
    await screen.findByRole('button', { name: 'Show in File Manager' });
    const before = extractions.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    streamIntoLastMessage('a');
    streamIntoLastMessage('ab');
    streamIntoLastMessage('abc');

    expect(extractions.mock.calls.length).toBe(before);

    act(() => {
      useChatStore.setState((state) => {
        const conversation = state.conversations[CONV];
        const messages = conversation.messages.slice();
        messages[messages.length - 1] = { ...messages[messages.length - 1], toolCalls: [toolCall('t9', 'write_file', WRITE_PATH)] };
        return { conversations: { ...state.conversations, [CONV]: { ...conversation, messages } } };
      });
    });

    expect(await screen.findByRole('button', { name: /main\.ts/ })).toBeInTheDocument();
    expect(extractions.mock.calls.length).toBe(before + 1);
  });
});
