/// <reference types="@testing-library/jest-dom" />
/**
 * Long-conversation Part B3 — render windowing.
 *
 * `conv.messages` stays fully in memory (compaction/editing/export are
 * untouched); these tests only assert on the DOM subset ChatView actually
 * mounts. The windowing math itself (renderLimit growth/reset) is unit
 * tested in `useRenderWindow.test.ts` — this file exercises the ChatView
 * wiring: tail-slicing, the sentinel's presence, and the IntersectionObserver
 * hookup (mocked — happy-dom has no real IO; see the note below).
 *
 * NOT covered here (needs a real layout engine): the scroll-anchor math in
 * ChatView's `useLayoutEffect` (`container.scrollTop = prevScrollTop +
 * (scrollHeight - prevScrollHeight)`). happy-dom does not compute real
 * scrollHeight/layout, so this must be verified with a real `tauri:dev`
 * smoke test (scroll up in a 60+ message conversation, confirm the view
 * doesn't jump when earlier messages load in).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import ChatView from './ChatView';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message } from '@/types';

// ── Lightweight stand-ins for heavy child components ──
// These aren't under test here; mocking them keeps this test focused on
// windowing and avoids dragging in their own (unrelated) dependencies.
vi.mock('./MessageGroup', () => ({
  default: ({ messages }: { messages: Message[] }) => (
    <div data-testid="message-group" data-group-id={messages[0]?.id}>
      {messages[0]?.id}
    </div>
  ),
}));
vi.mock('./CompactDivider', () => ({
  default: () => <div data-testid="compact-divider" />,
}));
vi.mock('./ChatInput', () => ({ default: () => <div data-testid="chat-input" /> }));
vi.mock('./UserQuestionDock', () => ({ default: () => null }));
vi.mock('./AgentStatusStrip', () => ({ default: () => null }));
vi.mock('./QueuedMessagesStrip', () => ({ default: () => null }));
vi.mock('./ScenarioGuide', () => ({ default: () => null }));
vi.mock('./IMInfoBar', () => ({ default: () => null }));
vi.mock('./SourceInfoBar', () => ({ default: () => null }));
vi.mock('./ComputerUseStatusBar', () => ({ default: () => null }));
vi.mock('./ConvIdBadge', () => ({ default: () => null }));
vi.mock('./UsageChip', () => ({ default: () => null }));

/** IntersectionObserver doesn't exist in happy-dom — stub it so the
 *  sentinel-observing effect doesn't throw, and stash the constructor calls
 *  so tests can simulate an intersection. */
class MockIntersectionObserver implements IntersectionObserver {
  root: Element | Document | null = null;
  rootMargin = '';
  scrollMargin = '';
  thresholds: ReadonlyArray<number> = [];
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }
  static instances: MockIntersectionObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = () => [];
  /** Test helper: simulate the sentinel scrolling into view. */
  triggerIntersect() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this,
    );
  }
}

function buildConversation(id: string, groupCount: number): Conversation {
  const messages: Message[] = Array.from({ length: groupCount }, (_, i) => ({
    id: `${id}-msg-${i}`,
    role: 'assistant',
    content: `message ${i}`,
    timestamp: i,
    loopId: `${id}-loop-${i}`,
  }));
  return {
    id,
    title: id,
    messages,
    createdAt: 0,
    updatedAt: 0,
    status: 'idle',
  };
}

function setActiveConversation(conv: Conversation) {
  useChatStore.setState({
    activeConversationId: conv.id,
    conversations: { [conv.id]: conv },
    conversationIndex: {
      [conv.id]: {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        status: conv.status,
      },
    } as never,
  });
}

describe('ChatView render windowing (Part B3)', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useChatStore.setState({ activeConversationId: null, conversations: {} });
  });

  it('renders every group and no sentinel when the conversation fits in one window', () => {
    setActiveConversation(buildConversation('conv-small', 10));
    render(<ChatView />);

    expect(screen.getAllByTestId('message-group')).toHaveLength(10);
    expect(screen.queryByTestId('render-window-sentinel')).not.toBeInTheDocument();
  });

  it('renders only the most recent RENDER_WINDOW (40) groups when there are more', () => {
    setActiveConversation(buildConversation('conv-big', 57));
    render(<ChatView />);

    const rendered = screen.getAllByTestId('message-group');
    expect(rendered).toHaveLength(40);
    // Tail slice: the last group in memory must still be the last rendered
    // group (isLastGroup wiring depends on this).
    expect(rendered[rendered.length - 1]).toHaveAttribute('data-group-id', 'conv-big-msg-56');
    // And the earliest rendered group is the 18th (57 - 40 + 1 -> index 17).
    expect(rendered[0]).toHaveAttribute('data-group-id', 'conv-big-msg-17');
    expect(screen.getByTestId('render-window-sentinel')).toBeInTheDocument();
  });

  it('loading the sentinel intersection grows the render window', () => {
    setActiveConversation(buildConversation('conv-grow', 57));
    render(<ChatView />);

    expect(screen.getAllByTestId('message-group')).toHaveLength(40);
    expect(MockIntersectionObserver.instances).toHaveLength(1);

    act(() => {
      MockIntersectionObserver.instances[0].triggerIntersect();
    });

    // All 57 groups now fit inside the grown window (40 + 40 = 80), so the
    // sentinel should disappear entirely.
    expect(screen.getAllByTestId('message-group')).toHaveLength(57);
    expect(screen.queryByTestId('render-window-sentinel')).not.toBeInTheDocument();
  });

  it('resets the render window back to 40 when switching to a different conversation', () => {
    setActiveConversation(buildConversation('conv-a', 57));
    const { rerender } = render(<ChatView />);
    expect(screen.getAllByTestId('message-group')).toHaveLength(40);

    act(() => {
      MockIntersectionObserver.instances[0]?.triggerIntersect();
    });
    expect(screen.getAllByTestId('message-group')).toHaveLength(57);

    // Switch to a second, equally-large conversation.
    setActiveConversation(buildConversation('conv-b', 57));
    rerender(<ChatView />);

    expect(screen.getAllByTestId('message-group')).toHaveLength(40);
    expect(screen.getByTestId('render-window-sentinel')).toBeInTheDocument();
  });
});
