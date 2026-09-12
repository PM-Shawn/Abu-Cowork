// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatView from './ChatView';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useToastStore } from '@/stores/toastStore';
import { useTeamStore } from '@/stores/teamStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { agentRegistry } from '@/core/agent/registry';
import { getI18n } from '@/i18n';
import type { SubagentDefinition } from '@/types';
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

  it('pins a new conversation to the team named by a typed @团队 and dispatches the plain text', async () => {
    configureApiKey();
    const { useTeamStore } = await import('@/stores/teamStore');
    useTeamStore.setState({
      teams: [{ id: 'tm1', name: 'zz数据小队', leaderRoleId: 'r1', memberRoleIds: ['r1'], createdAt: 1 }]
    });
    dispatchMock.mockResolvedValueOnce({ reason: 'completed' });
    try {
      render(<ChatView />);
      await submitWelcome('@zz数据小队 出周报');

      await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
      const [convId, text] = dispatchMock.mock.calls[0] as [string, string];
      expect(text).toBe('出周报');
      expect(useChatStore.getState().conversations[convId].teamId).toBe('tm1');
      expect(useChatStore.getState().pendingTeamId).toBeUndefined();
    } finally {
      useTeamStore.setState({ teams: []});
    }
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
      { images: undefined, onMessageTaken: expect.any(Function), initiatedBy: 'user' },
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

  describe('team welcome identity', () => {
    const leader: SubagentDefinition = { name: '分析师', description: '分析数据', intro: '队员开场白', avatar: 'icon:code/purple', roleId: 'role-lead', filePath: '/agents/analyst/AGENT.md', systemPrompt: '' };
    const member: SubagentDefinition = { name: '取数员', description: '负责取数', roleId: 'role-fetch', filePath: '/agents/fetch/AGENT.md', systemPrompt: '' };
    let restoreRegistry: () => void;

    beforeEach(() => {
      const original = agentRegistry.getAgent.bind(agentRegistry);
      const spy = vi.spyOn(agentRegistry, 'getAgent').mockImplementation((name) => [leader, member].find((agent) => agent.name === name) ?? original(name));
      restoreRegistry = () => spy.mockRestore();
      useDiscoveryStore.setState({ agents: [leader, member] });
      useTeamStore.setState({ teams: [{ id: 'tm-welcome', name: '数据小队', leaderRoleId: 'role-lead', memberRoleIds: ['role-lead', 'role-fetch', 'missing'], createdAt: 1, avatar: 'icon:chart-bar/blue', description: '看数据的小队', intro: '我们负责取数和出图' }] });
    });

    afterEach(() => {
      restoreRegistry();
      useTeamStore.setState({ teams: [] });
      useDiscoveryStore.setState({ agents: [] });
    });

    it('renders a pending team, its members and a fallback for a missing member', () => {
      useChatStore.setState({ pendingTeamId: 'tm-welcome' });
      render(<ChatView />);
      const welcome = within(screen.getByTestId('team-welcome'));
      expect(welcome.getByRole('heading', { name: '数据小队' })).toBeTruthy();
      expect(welcome.getByText('看数据的小队')).toBeTruthy();
      expect(welcome.getByText('我们负责取数和出图')).toBeTruthy();
      expect(welcome.getByText('分析师')).toBeTruthy();
      expect(welcome.getByText('取数员')).toBeTruthy();
      expect(welcome.getByText(getI18n().team.unknownMember)).toBeTruthy();
      expect(welcome.getByTestId('team-avatar')).toHaveAttribute('data-avatar-kind', 'icon');
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('prefers an explicitly pending agent and renders its icon reference as an avatar', () => {
      useChatStore.setState({ pendingTeamId: 'tm-welcome', pendingAgentName: leader.name });
      render(<ChatView />);
      expect(screen.getByRole('heading', { name: leader.name })).toBeTruthy();
      expect(screen.queryByTestId('team-welcome')).toBeNull();
      expect(screen.queryByText('icon:code/purple')).toBeNull();
      expect(screen.getByTestId('welcome-avatar')).toHaveAttribute('data-avatar-kind', 'icon');
    });

    it('uses the active empty conversation pin and hides the team when the pin is removed', () => {
      const id = useChatStore.getState().createConversation(null, { teamId: 'tm-welcome' });
      useChatStore.setState({ pendingTeamId: 'stale-team' });
      render(<ChatView />);
      expect(within(screen.getByTestId('team-welcome')).getByRole('heading', { name: '数据小队' })).toBeTruthy();
      act(() => useChatStore.getState().setConversationTeamId(id, undefined));
      expect(screen.queryByTestId('team-welcome')).toBeNull();
      expect(screen.getByRole('heading', { name: getI18n().chat.welcomeTitle })).toBeTruthy();
    });
  });
});
