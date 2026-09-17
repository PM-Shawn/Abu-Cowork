// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import MessageBubble from './MessageBubble';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';

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

  describe('when the conversation pinned model is no longer usable', () => {
    const GONE_PIN = { providerId: 'gone-provider', modelId: 'model-a' };
    const USABLE_PIN = { providerId: 'anthropic', modelId: 'model-a' };

    beforeEach(() => {
      vi.mocked(runAgentLoopDispatched).mockReset();
      useSettingsStore.setState(useSettingsStore.getInitialState(), true);
      useSettingsStore.setState((state) => ({
        providers: state.providers.map((provider) =>
          provider.id === 'anthropic'
            ? { ...provider, enabled: true, apiKey: 'test-key', models: [...provider.models, { ...provider.models[0], id: 'model-a', label: '' }] }
            : provider,
        ),
      }));
      useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
      useToastStore.setState(useToastStore.getInitialState(), true);
    });

    let deleteSpy: MockInstance | undefined;

    afterEach(() => {
      deleteSpy?.mockRestore();
      deleteSpy = undefined;
      useToastStore.setState(useToastStore.getInitialState(), true);
      useSettingsStore.setState(useSettingsStore.getInitialState(), true);
      useEnterpriseStore.setState(useEnterpriseStore.getInitialState(), true);
    });

    /** A conversation with the given turns, pinned to `model`; returns a delete spy. */
    function seedConversation(messages: Message[], model: { providerId: string; modelId: string }): MockInstance {
      setConversation(messages[0], 'idle');
      useChatStore.setState((state) => ({
        conversations: {
          'conversation-1': { ...state.conversations['conversation-1'], messages, model },
        },
      }));
      deleteSpy = vi.spyOn(useChatStore.getState(), 'deleteMessagesFrom');
      return deleteSpy;
    }

    function expectNothingSent(spy: MockInstance, before: Message[]): void {
      expect(spy).not.toHaveBeenCalled();
      expect(useChatStore.getState().conversations['conversation-1'].messages).toBe(before);
      expect(runAgentLoopDispatched).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ type: 'error', title: expect.stringContaining('model-a') }),
      ]);
    }

    const laterTurn: Message = { id: 'message-later', role: 'assistant', content: 'later answer', timestamp: 3, loopId: 'loop-2' };

    it('refuses retry before rewinding any turns', () => {
      const failed: Message = { ...baseMessage, runState: 'failed', runError: 'boom', loopId: 'loop-1' };
      const spy = seedConversation([failed, laterTurn], GONE_PIN);
      const before = useChatStore.getState().conversations['conversation-1'].messages;

      render(<MessageBubble message={failed} />);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expectNothingSent(spy, before);
      expect(screen.queryByText(getI18n().chat.rewindConfirmTitle)).not.toBeInTheDocument();
    });

    it('re-checks when the provider is removed while the rewind confirm is open', () => {
      const failed: Message = { ...baseMessage, runState: 'failed', runError: 'boom', loopId: 'loop-1' };
      const spy = seedConversation([failed, laterTurn], USABLE_PIN);
      const before = useChatStore.getState().conversations['conversation-1'].messages;

      render(<MessageBubble message={failed} />);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(screen.getByText(getI18n().chat.rewindConfirmTitle)).toBeInTheDocument();
      expect(useToastStore.getState().toasts).toEqual([]);

      useSettingsStore.setState((state) => ({
        providers: state.providers.map((provider) =>
          provider.id === 'anthropic' ? { ...provider, enabled: false } : provider,
        ),
      }));
      // Another provider stays usable, so the refusal is a toast, not Settings.
      useSettingsStore.setState((state) => ({
        providers: [...state.providers, { ...state.providers.find((p) => p.id === 'anthropic')!, id: 'other', enabled: true }],
      }));
      fireEvent.click(screen.getByRole('button', { name: getI18n().common.confirm }));

      expectNothingSent(spy, before);
    });

    it('refuses edit-resend and keeps the editor open', () => {
      const sent: Message = { ...baseMessage, loopId: 'loop-1' };
      const spy = seedConversation([sent, laterTurn], GONE_PIN);
      const before = useChatStore.getState().conversations['conversation-1'].messages;

      render(<MessageBubble message={sent} />);
      fireEvent.click(screen.getByRole('button', { name: getI18n().chat.edit }));
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited text' } });
      fireEvent.click(screen.getByRole('button', { name: getI18n().chat.saveAndResend }));

      expectNothingSent(spy, before);
      expect(screen.getByRole('textbox')).toHaveValue('edited text');
      expect(screen.queryByText(getI18n().chat.rewindConfirmTitle)).not.toBeInTheDocument();
    });

    it('refuses regenerate before rewinding any turns', () => {
      const question: Message = { ...baseMessage, loopId: 'loop-1' };
      const answer: Message = { id: 'message-answer', role: 'assistant', content: 'first answer', timestamp: 1, loopId: 'loop-1' };
      const spy = seedConversation([question, answer, laterTurn], GONE_PIN);
      const before = useChatStore.getState().conversations['conversation-1'].messages;

      render(<MessageBubble message={answer} />);
      fireEvent.click(screen.getByRole('button', { name: getI18n().chat.regenerate }));

      expectNothingSent(spy, before);
      expect(screen.queryByText(getI18n().chat.rewindConfirmTitle)).not.toBeInTheDocument();
    });
  });
});
