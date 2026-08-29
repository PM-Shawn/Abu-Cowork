// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import MessageBubble from './MessageBubble';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { usePreviewStore } from '@/stores/previewStore';

vi.mock('./MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('./ToolCallsGroup', () => ({
  default: () => null,
  InlineToolResultImages: () => null,
}));

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: vi.fn(),
}));

const baseMessage: Message = {
  id: 'message-1',
  role: 'user',
  content: '看看我桌面上有什么',
  timestamp: 0,
};

function setConversation(message: Message, status: Conversation['status']): void {
  const conversation: Conversation = {
    id: 'conversation-1',
    title: 'test',
    messages: [message],
    createdAt: 0,
    updatedAt: 0,
    status,
    workspacePath: '/workspace',
  };
  useChatStore.setState({
    activeConversationId: conversation.id,
    conversations: { [conversation.id]: conversation },
  });
}

describe('MessageBubble user run status', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useImageLightboxStore.getState().close();
    usePreviewStore.setState(usePreviewStore.getInitialState(), true);
  });

  afterEach(() => {
    useImageLightboxStore.getState().close();
    cleanup();
  });

  it.each(['pending', 'accepted', 'running', 'recovering', 'interrupted'] as const)(
    'hides the internal %s lifecycle state',
    (runState) => {
      const message = { ...baseMessage, runState };
      setConversation(message, runState === 'interrupted' ? 'idle' : 'running');

      render(<MessageBubble message={message} />);

      expect(screen.getByText(baseMessage.content as string)).toBeInTheDocument();
      expect(screen.queryByText(/Sending|Accepted|Running|Recovering|Stopped/)).not.toBeInTheDocument();
    },
  );

  it('keeps an actionable failure and retry control visible', () => {
    const message = { ...baseMessage, runState: 'failed' as const, runError: 'network unavailable' };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);

    const failureLabel = screen.getByText('Send failed');
    expect(failureLabel).toBeInTheDocument();
    expect(failureLabel.parentElement).not.toHaveAttribute('title');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders structured upstream failure fields without a raw JSON blob', () => {
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runError: '{"error_type":"governance.alicloud_content_safety_input_rejected"}',
      runErrorDetails: {
        status: 403,
        error_type: 'governance.alicloud_content_safety_input_rejected',
        traceId: 'trace-403-local',
        summary: 'The upstream content safety system rejected the request.',
      },
    };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);

    expect(screen.getByText('HTTP 403')).toBeInTheDocument();
    expect(screen.getByText('governance.alicloud_content_safety_input_rejected')).toBeInTheDocument();
    expect(screen.getByText('trace-403-local')).toBeInTheDocument();
    expect(screen.getByText('The upstream content safety system rejected the request.')).toBeInTheDocument();
    expect(screen.queryByText(message.runError as string)).not.toBeInTheDocument();
    expect(screen.getByText('Send failed').parentElement).not.toHaveAttribute('title');
    expect(screen.queryByText(/conversation history/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('opens the user message image group in the lightbox without a workspace preview', () => {
    const message: Message = {
      ...baseMessage,
      content: [
        { type: 'text', text: 'two screenshots' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'cG5n' },
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/webp', data: 'd2VicA==' },
          filePath: '/workspace/outputs/images/second.webp',
        },
      ],
    };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);
    const thumbnails = screen.getAllByRole('button', { name: 'Click to view full image' });
    fireEvent.click(thumbnails[1]);

    const lightbox = useImageLightboxStore.getState();
    expect(lightbox.isOpen).toBe(true);
    expect(lightbox.activeIndex).toBe(1);
    expect(lightbox.items).toEqual([
      expect.objectContaining({ id: 'message-1:image:0', mediaType: 'image/png', data: 'cG5n' }),
      expect.objectContaining({
        id: 'message-1:image:1',
        mediaType: 'image/webp',
        filePath: '/workspace/outputs/images/second.webp',
        conversationId: 'conversation-1',
        workspacePath: '/workspace',
      }),
    ]);
    expect(usePreviewStore.getState().tabs).toEqual([]);
    expect(usePreviewStore.getState().previewFilePath).toBeNull();
  });

});
