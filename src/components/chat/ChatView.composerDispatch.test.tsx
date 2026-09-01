// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatView from './ChatView';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';
import { AgentLoopDispatchError } from '@/core/agent/agentLoopDispatchError';
import {
  clearAllComposerDrafts,
  readComposerDraft,
  WELCOME_COMPOSER_DRAFT_KEY,
} from '@/stores/composerDraftStore';

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
}));

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: (...args: unknown[]) => dispatchMock(...args),
}));

vi.mock('@/utils/electronHost', () => ({
  authorizeElectronUserAttachment: vi.fn(),
  hasElectronCommandHost: vi.fn(() => false),
  hasElectronUserAttachmentAuthorizeHost: vi.fn(() => false),
  hasElectronUserAttachmentReadHost: vi.fn(() => false),
  hasElectronUserAttachmentReleaseHost: vi.fn(() => false),
  hasElectronUserAttachmentSelectHost: vi.fn(() => false),
  readElectronUserAttachment: vi.fn(),
  releaseElectronUserAttachment: vi.fn(),
  selectElectronUserAttachments: vi.fn(),
}));

vi.mock('react-virtuoso', async () => {
  const { createElement, forwardRef } = await import('react');
  type MockVirtuosoProps = {
    data?: unknown[];
    itemContent?: (index: number, item: unknown) => ReturnType<typeof createElement>;
  };
  return {
    Virtuoso: forwardRef<unknown, MockVirtuosoProps>(function MockVirtuoso(
      { data = [], itemContent },
      _ref,
    ) {
      return createElement(
        'div',
        { 'data-testid': 'mock-virtuoso' },
        data.map((item, index) => createElement(
          'div',
          { key: index },
          itemContent?.(index, item),
        )),
      );
    }),
  };
});

// The guide is unrelated to dispatch ownership. Keep the real ChatInput so
// these tests cross the actual ChatView -> composer restoration boundary.
vi.mock('./ScenarioGuide', () => ({
  default: () => null,
}));

function configureApiKey(): void {
  useSettingsStore.setState((state) => ({
    providers: state.providers.map((provider) =>
      provider.id === 'anthropic'
        ? { ...provider, enabled: true, apiKey: 'test-key' }
        : provider,
    ),
  }));
}

async function submitWelcome(text: string): Promise<HTMLTextAreaElement> {
  const user = userEvent.setup();
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  await user.type(textarea, text);
  await user.keyboard('{Enter}');
  return textarea;
}

describe('ChatView welcome composer dispatch ownership', () => {
  beforeEach(() => {
    clearAllComposerDrafts();
    dispatchMock.mockReset();
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    clearAllComposerDrafts();
    useToastStore.setState(useToastStore.getInitialState(), true);
  });

  it('keeps the composer empty after a post-commit dispatch failure', async () => {
    configureApiKey();
    dispatchMock.mockResolvedValueOnce({
      reason: 'error',
      error: 'provider unavailable',
      messageTaken: true,
    });

    render(<ChatView />);
    const textarea = await submitWelcome('hello');

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.any(String),
      'hello',
      { images: undefined, onMessageTaken: expect.any(Function) },
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(readComposerDraft(WELCOME_COMPOSER_DRAFT_KEY).text).toBe('');
    expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'error', title: 'provider unavailable' }),
      ]),
    );
  });

  it('keeps the composer empty after a post-commit dispatch rejection', async () => {
    configureApiKey();
    dispatchMock.mockImplementationOnce(async (conversationId: string, text: string) => {
      useChatStore.getState().addMessage(conversationId, {
        id: 'failed-user-message',
        role: 'user',
        content: text,
        timestamp: 1,
        loopId: 'failed-run',
        runState: 'failed',
        runError: 'disk unavailable',
      });
      throw new AgentLoopDispatchError(new Error('disk unavailable'), true);
    });

    render(<ChatView />);
    await submitWelcome('persist once');

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    expect(readComposerDraft(WELCOME_COMPOSER_DRAFT_KEY).text).toBe('');
    expect(screen.getByTestId('mock-virtuoso')).toHaveTextContent('persist once');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'error', title: 'disk unavailable' }),
      ]),
    );
  });

  it('keeps the created conversation when the dispatcher rejects ownership', async () => {
    configureApiKey();
    dispatchMock.mockResolvedValueOnce({
      reason: 'error',
      error: 'conversation busy',
      messageTaken: false,
    });

    render(<ChatView />);
    const textarea = await submitWelcome('retry me');

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useChatStore.getState().activeConversationId).not.toBeNull());
    expect(textarea).toHaveValue('');
    expect(readComposerDraft(WELCOME_COMPOSER_DRAFT_KEY).text).toBe('retry me');
  });

  it('keeps the created conversation after a pre-accept dispatch rejection', async () => {
    configureApiKey();
    dispatchMock.mockRejectedValueOnce(new Error('failed before ownership'));

    render(<ChatView />);
    const textarea = await submitWelcome('still mine');

    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useChatStore.getState().activeConversationId).not.toBeNull());
    expect(textarea).toHaveValue('');
    expect(readComposerDraft(WELCOME_COMPOSER_DRAFT_KEY).text).toBe('still mine');
  });

  it('restores the draft before dispatch when the API key is missing', async () => {
    render(<ChatView />);
    const textarea = await submitWelcome('keep this');

    await waitFor(() => expect(textarea).toHaveValue('keep this'));
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(readComposerDraft(WELCOME_COMPOSER_DRAFT_KEY).text).toBe('keep this');
    expect(useSettingsStore.getState()).toMatchObject({
      systemSettingsOpen: true,
      activeSystemTab: 'ai-services',
    });
  });
});
