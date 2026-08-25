// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import MessageBubble from './MessageBubble';

const mockResolveOutputRefSource = vi.hoisted(() => vi.fn());
const mockLoadLocalImage = vi.hoisted(() => vi.fn());

vi.mock('./MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/core/session/outputSnapshots', () => ({
  resolveOutputRefSource: (...args: unknown[]) => mockResolveOutputRefSource(...args),
}));

vi.mock('@/utils/pathUtils', async () => {
  const actual = await vi.importActual<typeof import('@/utils/pathUtils')>('@/utils/pathUtils');
  return {
    ...actual,
    loadLocalImage: (...args: unknown[]) => mockLoadLocalImage(...args),
  };
});

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: vi.fn(),
}));

function setConversation(message: Message): void {
  const conversation: Conversation = {
    id: 'conversation-1',
    title: 'test',
    messages: [message],
    createdAt: 0,
    updatedAt: 0,
    status: 'idle',
  };
  useChatStore.setState({
    activeConversationId: conversation.id,
    conversations: { [conversation.id]: conversation },
  });
}

function assistantWithOutputRefTool(name: string): Message {
  return {
    id: `assistant-${name}`,
    role: 'assistant',
    content: 'done',
    timestamp: 1,
    toolCalls: [{
      id: `toolu_${name}`,
      name,
      input: {},
      result: 'image result',
      resultContent: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: '' },
        outputRef: { relPath: `files/hash/${name}.png`, basename: `${name}.png`, sizeBytes: 4 },
      }],
    }],
  } as Message;
}

describe('MessageBubble tool-result outputRef images', () => {
  beforeEach(() => {
    initLanguage('en-US');
    mockResolveOutputRefSource.mockReset();
    mockLoadLocalImage.mockReset();
    mockResolveOutputRefSource.mockImplementation(async (_convId: string, relPath: string) => ({
      status: 'available',
      path: `/snapshots/${relPath.split('/').at(-1)}`,
      isFromSnapshot: true,
    }));
    mockLoadLocalImage.mockImplementation(async (path: string) => `blob:${path.split('/').at(-1)}`);
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders inline dehydrated tool-result images without emitting empty base64 data URIs', async () => {
    const message = assistantWithOutputRefTool('read_file');
    setConversation(message);

    render(<MessageBubble message={message} hideAvatar />);

    const image = await screen.findByRole('img', { name: 'Image' });
    expect(image).toHaveAttribute('src', 'blob:read_file.png');
    expect(image.getAttribute('src')).not.toMatch(/base64,$/);
    expect(mockResolveOutputRefSource).toHaveBeenCalledWith('conversation-1', 'files/hash/read_file.png');
  });

  it('renders computer screenshot thumbnails from outputRef without emitting empty base64 data URIs', async () => {
    const message = assistantWithOutputRefTool('computer');
    setConversation(message);

    render(<MessageBubble message={message} hideAvatar />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    fireEvent.click(screen.getAllByText('computer').at(-1)!);

    const image = await screen.findByRole('img', { name: 'Screenshot' });
    expect(image).toHaveAttribute('src', 'blob:computer.png');
    expect(image.getAttribute('src')).not.toMatch(/base64,$/);
    expect(mockResolveOutputRefSource).toHaveBeenCalledWith('conversation-1', 'files/hash/computer.png');
  });
});
