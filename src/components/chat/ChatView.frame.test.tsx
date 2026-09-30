// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render as renderBare, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import ChatView from './ChatView';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getI18n } from '@/i18n';
import type { Message, SubagentDefinition } from '@/types';

interface MockVirtuosoProps {
  atBottomStateChange?: (atBottom: boolean) => void;
  data?: Message[][];
  itemContent?: (index: number, group: Message[]) => React.ReactNode;
}

const harness = vi.hoisted(() => ({
  props: null as MockVirtuosoProps | null,
  scrollToIndex: vi.fn(),
  tooltipRenders: vi.fn(),
  teamLeader: null as null | Record<string, unknown>,
}));

vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: vi.fn() }));

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(props: MockVirtuosoProps, ref) {
      harness.props = props;
      React.useImperativeHandle(ref, () => ({ scrollToIndex: harness.scrollToIndex }));
      return React.createElement(
        'div',
        { 'data-testid': 'mock-virtuoso' },
        ...(props.data ?? []).map((group, index) => React.createElement(
          'div',
          { 'data-index': String(index), key: group[0]?.id ?? index },
          props.itemContent?.(index, group),
        )),
      );
    }),
  };
});

// The frame is under test; the message rows, the composer and the strips above it are not.
vi.mock('./MessageGroup', () => ({ default: () => null }));
vi.mock('./ChatInput', () => ({ default: () => null }));
vi.mock('./AgentStatusStrip', () => ({ default: () => null }));
vi.mock('./QueuedMessagesStrip', () => ({ default: () => null }));

vi.mock('@/core/usage/usageLedgerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/usage/usageLedgerClient')>();
  return {
    ...actual,
    queryUsageConversation: vi.fn(async () => ({
      available: true,
      totals: { ...actual.emptyUsageAggregate(), attempts: 2, inputKnownSum: 1200, outputKnownSum: 300 },
    })),
  };
});

vi.mock('@/components/team/useConversationTeamLeader', () => ({
  useConversationTeamLeader: () => harness.teamLeader,
}));

// Counts every ds tooltip render in the frame: the chapter menu button, the usage chip and the copy button.
vi.mock('@/components/ds/tooltip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/tooltip')>();
  return {
    ...actual,
    Tooltip: (props: ComponentProps<typeof actual.Tooltip>) => {
      harness.tooltipRenders();
      return actual.Tooltip(props);
    },
  };
});

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

function message(id: string, role: Message['role'], content: string, loopId: string): Message {
  return { id, role, content, loopId, timestamp: 1 };
}

/** Three turns: enough chapters for the chapter menu (the rail does not fit a zero-width test scroller). */
function setupConversation(): string {
  const store = useChatStore.getState();
  const conversationId = store.createConversation();
  for (let turn = 1; turn <= 3; turn += 1) {
    store.addMessage(conversationId, message(`user-${turn}`, 'user', `prompt ${turn}`, `loop-${turn}`));
    store.addMessage(conversationId, message(`assistant-${turn}`, 'assistant', `answer ${turn}`, `loop-${turn}`));
  }
  store.setConversationStatus(conversationId, 'idle');
  return conversationId;
}

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

describe('ChatView frame', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    harness.props = null;
    harness.scrollToIndex.mockReset();
    harness.tooltipRenders.mockReset();
    harness.teamLeader = null;
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows one loading line while a task is read from disk', () => {
    useChatStore.setState({ activeConversationId: 'not-loaded-yet' });

    render(<ChatView />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    expect(document.querySelector('.animate-pulse')).toBeNull();
  });

  it('asks for a model on a flat card whose only filled button opens the model settings', async () => {
    const user = setupUser();
    useSettingsStore.setState((state) => ({
      providers: state.providers.filter((provider) => provider.id !== 'ollama' && provider.id !== 'lmstudio').map((provider) => ({ ...provider, apiKey: '' })),
    }));
    const openSystemSettings = vi.spyOn(useSettingsStore.getState(), 'openSystemSettings');

    render(<ChatView />);

    const button = screen.getByRole('button', { name: getI18n().chat.setupButton });
    expect(button).toHaveClass('bg-emphasis');
    const card = button.parentElement!;
    expect(card).toHaveClass('rounded-panel');
    expect(card).toHaveClass('bg-surface');
    expect(card).not.toHaveClass('shadow-float');
    await user.click(button);
    expect(openSystemSettings).toHaveBeenCalledWith('ai-services');
  });

  it('paints no background of its own around the messages and the composer', async () => {
    setupConversation();

    render(<ChatView />);
    await screen.findByTestId('mock-virtuoso');

    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const composerArea = scroller.nextElementSibling as HTMLElement;
    for (const element of [scroller.parentElement!, scroller, composerArea]) {
      expect(element.className.split(' ').filter((name) => name.startsWith('bg-'))).toEqual([]);
    }
  });

  it('renames the task in a text field: Enter saves, Escape keeps the old title', async () => {
    const user = setupUser();
    const conversationId = setupConversation();
    const oldTitle = useChatStore.getState().conversations[conversationId].title;
    render(<ChatView />);

    await user.dblClick(screen.getByTitle(oldTitle));
    const field = screen.getByRole('textbox');
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, 'Quarterly review{Escape}');
    expect(useChatStore.getState().conversations[conversationId].title).toBe(oldTitle);

    await user.dblClick(screen.getByTitle(oldTitle));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Quarterly review{Enter}');
    expect(useChatStore.getState().conversations[conversationId].title).toBe('Quarterly review');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the team as a tag with the leader in its hover text', () => {
    harness.teamLeader = {
      teamId: 'tm-data',
      teamName: 'Data squad',
      leaderName: 'Analyst',
      leader: { name: 'Analyst', description: '', filePath: '', systemPrompt: '' } as SubagentDefinition,
      teamAvatar: null,
    };
    setupConversation();

    render(<ChatView />);

    const badge = screen.getByTestId('chat-title-team-badge');
    expect(badge).toHaveAttribute('title', 'Analyst · Data squad');
    expect(badge).toHaveTextContent('Data squad');
    expect(badge.firstElementChild).toHaveClass('rounded-control');
  });

  it('offers an opaque button back to the latest message once the reader scrolls up', async () => {
    const user = setupUser();
    setupConversation();
    render(<ChatView />);
    await screen.findByTestId('mock-virtuoso');
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;

    act(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -12 })));
    act(() => harness.props?.atBottomStateChange?.(false));

    const button = screen.getByRole('button', { name: 'Scroll to bottom' });
    const backing = button.parentElement!;
    expect(backing).toHaveClass('bg-raised');
    expect(backing).toHaveClass('shadow-float');
    const layers = [button, backing, backing.parentElement!];
    for (const element of layers) {
      expect(element.className).not.toMatch(/backdrop-/);
    }

    await user.click(button);
    expect(harness.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior: 'smooth' });
  });

  it('shows usage, the disclaimer and the task number with a copy button under the composer', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);

    expect(await screen.findByText('1.5k')).toBeInTheDocument();
    expect(screen.getByText(`#${conversationId.slice(0, 8)}`)).toHaveClass('font-code');
    expect(screen.getByRole('button', { name: /copy conversation id/i })).toBeInTheDocument();
  });

  it('does not re-render the frame’s tooltips and the chapter menu while a reply streams', async () => {
    const conversationId = setupConversation();
    useChatStore.getState().setConversationStatus(conversationId, 'running');
    render(<ChatView />);
    await screen.findByText('1.5k');
    expect(screen.getByRole('button', { name: 'Conversation chapters' })).toBeInTheDocument();
    // Let the scroll-spy's first frame pick the current chapter before counting.
    await act(async () => { vi.advanceTimersByTime(50); });
    const settled = harness.tooltipRenders.mock.calls.length;
    expect(settled).toBeGreaterThan(0);

    // What a flushed token frame does to the store.
    for (const content of ['answer 3 more', 'answer 3 more and more', 'answer 3 more and more words']) {
      act(() => useChatStore.getState().setLastMessageContent(conversationId, content, 'assistant-3'));
    }

    expect(useChatStore.getState().conversations[conversationId].messages.at(-1)?.content).toBe('answer 3 more and more words');
    expect(harness.tooltipRenders).toHaveBeenCalledTimes(settled);
  });

  it('jumps to a chapter picked from the menu', async () => {
    const user = setupUser();
    setupConversation();
    render(<ChatView />);

    await user.click(screen.getByRole('button', { name: 'Conversation chapters' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'prompt 2' }));

    await waitFor(() => expect(harness.scrollToIndex).toHaveBeenCalledWith({ index: 1, align: 'start', behavior: 'auto' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
