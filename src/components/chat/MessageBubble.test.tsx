// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Button } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';
import MessageBubble from './MessageBubble';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';

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

// The action row's icon buttons carry ds tooltips, which need the provider the app mounts at its root.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

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
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
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
    // Retry goes through the same pre-send model check as the composer, so the
    // conversation's model has to belong to a configured provider.
    useSettingsStore.setState((state) => ({
      providers: state.providers.map((provider) =>
        provider.id === state.activeModel.providerId
          ? {
              ...provider,
              enabled: true,
              apiKey: 'test-key',
              models: [{ id: state.activeModel.modelId, label: state.activeModel.modelId }],
            }
          : provider,
      ),
    }));

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

  it('#549: the new conversation carries the routing prefix Retry would resend', () => {
    // An oversize turn always fails after the params build, which has already
    // rewritten the row to the route's clean input and stamped the agent on
    // it. Carrying the bare text would send the new turn to the default route.
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runError: 'This conversation is too long to continue.',
      runErrorKind: 'payload_too_large',
      delegateAgent: { name: '研究员', description: 'researcher' },
    };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    expect(useChatStore.getState().pendingInput).toBe(`@研究员 ${baseMessage.content}`);
  });

  it('#549: the new conversation carries the skill prefix of a skill turn', () => {
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runError: 'This conversation is too long to continue.',
      runErrorKind: 'payload_too_large',
      skill: { name: 'pdf', description: 'pdf skill' },
    };
    setConversation(message, 'idle');

    render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    expect(useChatStore.getState().pendingInput).toBe(`/pdf ${baseMessage.content}`);
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

    it('re-checks when the provider is removed while the rewind confirm is open', async () => {
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
      // The answer reaches the handler that waits for it.
      await act(async () => {});

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

describe('MessageBubble on the design system', () => {
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    initLanguage('en-US');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    writeText.mockClear();
  });

  const answer: Message = { id: 'message-answer', role: 'assistant', content: 'first answer', timestamp: 1 };

  it('paints the user bubble with the fill surface and the panel radius', () => {
    setConversation(baseMessage, 'idle');
    render(<MessageBubble message={baseMessage} />);

    const bubble = screen.getByText(baseMessage.content as string).closest('.rounded-panel');
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveClass('bg-fill');
    expect(bubble).toHaveClass('text-label');
    expect(bubble).toHaveClass('py-2');
  });

  it('puts the failure, its reason and the upstream fields in one danger message', () => {
    const message: Message = {
      ...baseMessage,
      runState: 'failed',
      runError: 'Abu could not prepare this message, so it was not sent. Click Retry to try again.',
      runErrorKind: 'dispatch_failed',
      runErrorDetails: { status: 403, traceId: 'trace-403-local', summary: 'Rejected upstream.' },
    };
    setConversation(message, 'idle');
    render(<MessageBubble message={message} />);

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    const [alert] = alerts;
    expect(alert).toHaveClass('bg-danger-soft');
    expect(alert).toHaveTextContent('Send failed');
    expect(alert).toHaveTextContent(message.runError as string);
    expect(alert).toHaveTextContent('Rejected upstream.');
    expect(screen.getByText('HTTP 403').parentElement).toHaveClass('font-code');
    expect(alert).toContainElement(screen.getByRole('button', { name: 'Retry' }));
  });

  it('names every action button without a native title and swaps the copy icon after copying', async () => {
    setConversation(answer, 'idle');
    const { container } = render(<MessageBubble message={answer} />);

    for (const name of ['Copy', 'Regenerate', 'Helpful', 'Not helpful']) {
      expect(screen.getByRole('button', { name })).not.toHaveAttribute('title');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('first answer'));
    expect(container.querySelector('button[aria-label="Copy"] svg.lucide-check')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(container.querySelector('button[aria-label="Copy"] svg.lucide-copy')).not.toBeNull();
  });

  it('marks the chosen rating with the selected fill instead of a status color', () => {
    setConversation(answer, 'idle');
    render(<MessageBubble message={answer} />);

    const helpful = screen.getByRole('button', { name: 'Helpful' });
    expect(helpful).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(helpful);
    expect(helpful).toHaveAttribute('aria-pressed', 'true');
    // The pressed look comes from IconButton itself (it keys off aria-pressed), so it also holds under the pointer.
    expect(helpful).toHaveClass('aria-pressed:bg-fill-selected');
    expect(helpful).toHaveClass('aria-pressed:hover:bg-fill-selected');
    expect(helpful).not.toHaveClass('bg-fill-selected');
    expect(helpful).not.toHaveClass('text-success');
  });

  it('draws a still streaming cursor in the secondary label color', () => {
    const streaming: Message = { ...answer, isStreaming: true };
    setConversation(streaming, 'running');
    const { container } = render(<MessageBubble message={streaming} hideAvatar />);

    expect(container.querySelector('.streaming-cursor')).toBeNull();
    const cursor = container.querySelector('span[aria-hidden="true"].bg-label-secondary');
    expect(cursor).not.toBeNull();
    expect(cursor).not.toHaveClass('animate-pulse');
  });

  it('opens the thinking block from a named disclosure button', () => {
    const thinking: Message = { ...answer, thinking: 'weighing the options' };
    setConversation(thinking, 'idle');
    render(<MessageBubble message={thinking} hideAvatar />);

    const header = screen.getByRole('button', { name: 'Thinking Process' });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('weighing the options')).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const text = screen.getByText('weighing the options');
    expect(text).toHaveClass('text-ui-sm');
    expect(text).toHaveClass('text-label-secondary');
  });

  it('edits in a flat card with a text area, a route tag and one primary button', () => {
    const routed: Message = { ...baseMessage, delegateAgent: { name: '研究员', description: 'researcher' } };
    setConversation(routed, 'idle');
    render(<MessageBubble message={routed} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textbox = screen.getByRole('textbox');
    expect(textbox).toHaveClass('text-body');
    expect(screen.getByText('@研究员')).toHaveClass('rounded-control');
    expect(screen.getByRole('button', { name: 'Save & Resend' })).toHaveClass('bg-emphasis');
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toHaveClass('bg-emphasis');
  });

  it('fades a long user message with a mask and expands it from a plain button', () => {
    const long: Message = { ...baseMessage, content: 'line\n'.repeat(12) };
    setConversation(long, 'idle');
    const { container } = render(<MessageBubble message={long} />);

    expect(container.querySelector('.mask-b-from-22')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(container.querySelector('.mask-b-from-22')).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
  });

  it('opens a file chip in the preview and names its reveal button', () => {
    const withFile: Message = { ...baseMessage, content: 'see [Attachment: `/workspace/report.pdf`]' };
    setConversation(withFile, 'idle');
    usePreviewStore.setState(usePreviewStore.getInitialState(), true);
    render(<MessageBubble message={withFile} />);

    fireEvent.click(screen.getByRole('button', { name: 'report.pdf' }));
    expect(usePreviewStore.getState().previewFilePath).toBe('/workspace/report.pdf');
    expect(screen.getByRole('button', { name: 'Show in File Manager' })).toBeInTheDocument();
  });
});

describe('MessageBubble redo question', () => {
  const CONVERSATION = 'conversation-1';
  const question: Message = { ...baseMessage, loopId: 'loop-1' };
  const answer: Message = { id: 'message-answer', role: 'assistant', content: 'first answer', timestamp: 1, loopId: 'loop-1' };
  const laterTurns = (count: number): Message[] => Array.from({ length: count }, (_, index) => ({
    id: `later-${index}`, role: 'user' as const, content: `later ${index}`, timestamp: 10 + index, loopId: `loop-later-${index}`,
  }));
  let deleteSpy: MockInstance;

  function seed(messages: Message[], status: Conversation['status'] = 'idle') {
    setConversation(messages[0], status);
    useChatStore.setState((state) => ({
      conversations: {
        [CONVERSATION]: { ...state.conversations[CONVERSATION], messages, model: { providerId: 'anthropic', modelId: 'model-a' } },
      },
    }));
    deleteSpy = vi.spyOn(useChatStore.getState(), 'deleteMessagesFrom');
  }
  const stored = () => useChatStore.getState().conversations[CONVERSATION].messages;
  const questionTitle = () => screen.queryByText(getI18n().chat.rewindConfirmTitle);
  const questionText = (count: number) => getI18n().chat.rewindConfirmMessage.replace('{count}', String(count));
  const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
  // Lets the answer reach the handler that waits for it.
  const answered = () => act(async () => {});

  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(runAgentLoopDispatched).mockReset();
    vi.mocked(runAgentLoopDispatched).mockResolvedValue({ reason: 'completed' });
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

  afterEach(() => {
    deleteSpy.mockRestore();
    cleanup();
    useToastStore.setState(useToastStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState(useEnterpriseStore.getInitialState(), true);
  });

  it('regenerates at once, with no question, when no turn follows', async () => {
    seed([question, answer]);
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    await answered();

    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, question.id]]);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched).toHaveBeenCalledWith(CONVERSATION, question.content, { initiatedBy: 'user' });
  });

  it('asks with the number of turns that follow, and Cancel deletes nothing', async () => {
    seed([question, answer, ...laterTurns(3)]);
    const before = stored();
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    expect(questionTitle()).toBeInTheDocument();
    expect(screen.getByText(questionText(3))).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();

    press('Cancel');
    await answered();
    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('deletes and sends once after Confirm', async () => {
    seed([question, answer, ...laterTurns(2)]);
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    expect(screen.getByText(questionText(2))).toBeInTheDocument();
    press('Confirm');
    await answered();

    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, question.id]]);
    expect(stored()).toEqual([]);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched).toHaveBeenCalledWith(CONVERSATION, question.content, { initiatedBy: 'user' });
  });

  it('takes Escape as Cancel', async () => {
    seed([question, answer, ...laterTurns(1)]);
    const before = stored();
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    expect(questionTitle()).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await answered();

    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('asks the same question before a retry that would delete later turns', async () => {
    const failed: Message = { ...question, runState: 'failed', runError: 'boom' };
    seed([failed, ...laterTurns(2)]);
    const before = stored();
    render(<MessageBubble message={failed} />);

    press('Retry');
    expect(screen.getByText(questionText(2))).toBeInTheDocument();
    expect(stored()).toBe(before);
    press('Confirm');
    await answered();

    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, failed.id]]);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
  });

  it('asks the same question before an edited message is sent again', async () => {
    seed([question, answer, ...laterTurns(1)]);
    const before = stored();
    render(<MessageBubble message={question} />);

    press('Edit');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited text' } });
    press('Save & Resend');
    expect(screen.getByText(questionText(1))).toBeInTheDocument();
    expect(stored()).toBe(before);
    press('Confirm');
    await answered();

    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, question.id]]);
    expect(runAgentLoopDispatched).toHaveBeenCalledWith(CONVERSATION, 'edited text', { initiatedBy: 'user' });
  });

  it('offers no redo while the conversation runs', () => {
    seed([question, answer, ...laterTurns(1)], 'running');
    render(<><MessageBubble message={question} /><MessageBubble message={answer} hideAvatar /></>);

    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  // An IM message, a goal's next round or a message from the pet window can start a run on the
  // conversation while the question shows. The question was asked about a conversation at rest.
  it('deletes nothing when a run has started on the conversation by the time of the answer', async () => {
    seed([question, answer, ...laterTurns(1)]);
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    act(() => {
      useChatStore.setState((state) => ({
        conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], status: 'running' } },
      }));
    });
    const before = stored();
    expect(questionTitle()).toBeInTheDocument();
    press('Confirm');
    await answered();

    expect(questionTitle()).not.toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('redoes when the run that started while the question showed has ended by the time of the answer', async () => {
    seed([question, answer, ...laterTurns(1)]);
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    for (const status of ['running', 'idle'] as const) {
      act(() => {
        useChatStore.setState((state) => ({
          conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], status } },
        }));
      });
    }
    press('Confirm');
    await answered();

    expect(deleteSpy.mock.calls).toEqual([[CONVERSATION, question.id]]);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
  });

  const setStored = (messages: Message[]) => act(() => {
    useChatStore.setState((state) => ({
      conversations: { [CONVERSATION]: { ...state.conversations[CONVERSATION], messages } },
    }));
  });

  it('asks in a question window that opens on Cancel', () => {
    seed([question, answer, ...laterTurns(1)]);
    render(<MessageBubble message={answer} />);

    press('Regenerate');

    const box = screen.getByRole('alertdialog', { name: getI18n().chat.rewindConfirmTitle });
    expect(box).toHaveTextContent(questionText(1));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('deletes nothing when the message has left the conversation by the time of the answer', async () => {
    seed([question, answer, ...laterTurns(1)]);
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    await setStored(laterTurns(1));
    const before = stored();
    press('Confirm');
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('deletes nothing when the message it would cut at has left the conversation', async () => {
    seed([question, answer, ...laterTurns(1)]);
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    await setStored([answer, ...laterTurns(1)]);
    const before = stored();
    press('Confirm');
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('deletes nothing when more turns follow at the answer than the question named', async () => {
    seed([question, answer, ...laterTurns(1)]);
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    expect(screen.getByText(questionText(1))).toBeInTheDocument();
    await setStored([question, answer, ...laterTurns(3)]);
    const before = stored();
    press('Confirm');
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('deletes nothing when the message row has left the page by the time of the answer', async () => {
    function Host() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <Button onClick={() => setShown(false)}>take the row away</Button>
          {shown && <MessageBubble message={answer} />}
        </>
      );
    }
    seed([question, answer, ...laterTurns(1)]);
    const before = stored();
    render(<Host />);

    press('Regenerate');
    fireEvent.click(screen.getByRole('button', { name: 'take the row away', hidden: true }));
    press('Confirm');
    await answered();

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('is answered no by a question that takes its place', async () => {
    const otherAnswers: boolean[] = [];
    function Other() {
      const confirm = useConfirm();
      return (
        <Button onClick={() => { void confirm({ title: 'Replace the goal?', confirmLabel: 'Replace' }).then((ok) => otherAnswers.push(ok)); }}>
          ask about the goal
        </Button>
      );
    }
    seed([question, answer, ...laterTurns(1)]);
    const before = stored();
    render(<><MessageBubble message={answer} /><Other /></>);

    press('Regenerate');
    fireEvent.click(screen.getByRole('button', { name: 'ask about the goal', hidden: true }));
    await answered();

    expect(questionTitle()).not.toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: 'Replace the goal?' })).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();

    // The answer to the question now on screen is not an answer to the redo question.
    press('Replace');
    await answered();
    expect(otherAnswers).toEqual([true]);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(stored()).toBe(before);
  });

  it('asks nothing a second time for a second press on Confirm', async () => {
    seed([question, answer, ...laterTurns(1)]);
    render(<MessageBubble message={answer} />);

    press('Regenerate');
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    await answered();

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
  });
});
