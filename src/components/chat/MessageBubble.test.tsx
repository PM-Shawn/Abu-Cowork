// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import MessageBubble from './MessageBubble';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

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

function setConversation(
  message: Message,
  status: Conversation['status'],
  overrides: Partial<Conversation> = {},
): void {
  const conversation: Conversation = {
    id: 'conversation-1',
    title: 'test',
    messages: [message],
    createdAt: 0,
    updatedAt: 0,
    status,
    workspacePath: '/workspace',
    ...overrides,
  };
  useChatStore.setState({
    activeConversationId: conversation.id,
    conversations: { [conversation.id]: conversation },
  });
}

describe('MessageBubble user run status', () => {
  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(runAgentLoopDispatched).mockReset();
    vi.mocked(runAgentLoopDispatched).mockResolvedValue({ reason: 'completed' });
    useImageLightboxStore.getState().close();
    usePreviewStore.setState(usePreviewStore.getInitialState(), true);
    useWorkspaceStore.setState({ currentPath: null });
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

  it('exposes a stable DOM anchor for the persisted user message id', () => {
    setConversation(baseMessage, 'running');

    const { container } = render(<MessageBubble message={baseMessage} />);

    expect(container.querySelector('[data-message-id="message-1"]')).toBeInTheDocument();
  });

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
    // #549: `runError` is raw upstream text unless a `runErrorKind` marks it as
    // one of our own, user-readable pre-accept reasons — so it stays hidden here.
    expect(screen.queryByText(message.runError as string)).not.toBeInTheDocument();
    expect(screen.getByText('Send failed').parentElement).not.toHaveAttribute('title');
    expect(screen.queryByText(/conversation history/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('#549: an unreachable sidecar is just Send failed + Retry, with no reason line', () => {
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runError: 'The background service did not start, so this message was not sent. Click Retry to try again.',
      runErrorKind: 'sidecar_unavailable',
    };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);

    expect(screen.getByText('Send failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(message.runError as string)).not.toBeInTheDocument();
  });

  it('#549: a connection-failed row keeps its own label and Retry', () => {
    const message: Message = {
      ...baseMessage,
      runState: 'connection-failed',
      runError: 'Connection interrupted. Click Retry to try again.',
    };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);

    expect(screen.getByText('Connection recovery failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(message.runError as string)).not.toBeInTheDocument();
  });

  it('#549: Retry dispatches as a user-initiated send so a stopped sidecar restarts', async () => {
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runErrorKind: 'sidecar_unavailable',
    };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(runAgentLoopDispatched).toHaveBeenCalled());

    expect(runAgentLoopDispatched).toHaveBeenCalledWith(
      'conversation-1',
      baseMessage.content,
      expect.objectContaining({ initiatedBy: 'user' }),
    );
  });

  it('#549: shows the reason for a dispatch failure that also carries upstream details', () => {
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runError: 'Abu could not prepare this message, so it was not sent. Click Retry to try again.',
      runErrorKind: 'dispatch_failed',
      runErrorDetails: {
        status: 403,
        error_type: 'governance.alicloud_content_safety_input_rejected',
        traceId: 'trace-403-local',
        summary: 'The upstream content safety system rejected the request.',
      },
    };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);

    expect(screen.getByText(message.runError as string)).toBeInTheDocument();
    expect(screen.getByText('HTTP 403')).toBeInTheDocument();
  });

  it('#549: oversize states the limit in place of the failure label and offers a new conversation', () => {
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runError: 'This conversation is too long to continue.',
      runErrorKind: 'payload_too_large',
    };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);

    // The sentence IS the label here — 「发送失败」 would only repeat it.
    expect(screen.getByText(message.runError as string)).toBeInTheDocument();
    expect(screen.queryByText('Send failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    expect(useChatStore.getState().activeConversationId).toBeNull();
    expect(useChatStore.getState().pendingInput).toBe(baseMessage.content);
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('#549: the new conversation keeps the failed conversation’s workspace', () => {
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runError: 'This conversation is too long to continue.',
      runErrorKind: 'payload_too_large',
    };
    setConversation(message, 'idle');
    useWorkspaceStore.setState({ currentPath: '/workspace' });

    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    // startNewConversation() clears the workspace by design; carrying the text
    // into a project-less conversation would break every relative path in it.
    expect(useWorkspaceStore.getState().currentPath).toBe('/workspace');
    expect(useChatStore.getState().pendingInput).toBe(baseMessage.content);
  });

  it('#549: a failed conversation with no workspace starts the new one without one', () => {
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runError: 'This conversation is too long to continue.',
      runErrorKind: 'payload_too_large',
    };
    setConversation(message, 'idle', { workspacePath: undefined });
    useWorkspaceStore.setState({ currentPath: '/left-over' });

    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    expect(useWorkspaceStore.getState().currentPath).toBeNull();
  });

  it('keeps generic failures unchanged (no reason line without a kind)', () => {
    const message = { ...baseMessage, runState: 'failed' as const, runError: 'network unavailable' };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);

    expect(screen.queryByText('network unavailable')).not.toBeInTheDocument();
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
