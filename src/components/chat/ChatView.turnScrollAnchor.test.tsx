// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatView from './ChatView';
import { announceChatTurnScrollIntent } from './chatTurnScrollIntent';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import type { Message } from '@/types';

interface MockVirtuosoProps {
  atBottomStateChange?: (atBottom: boolean) => void;
  components?: { Footer?: React.ComponentType<{ context?: unknown }> };
  context?: unknown;
  data?: Message[][];
  followOutput?: (atBottom: boolean) => 'auto' | false;
  itemContent?: (index: number, group: Message[]) => React.ReactNode;
  totalListHeightChanged?: (height: number) => void;
}

const harness = vi.hoisted(() => ({
  props: null as MockVirtuosoProps | null,
  scrollToIndex: vi.fn(),
}));

vi.mock('@/core/agent/agentLoopRunner', () => ({
  runAgentLoopDispatched: vi.fn(),
}));

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(props: MockVirtuosoProps, ref) {
      harness.props = props;
      React.useImperativeHandle(ref, () => ({ scrollToIndex: harness.scrollToIndex }));
      const Footer = props.components?.Footer;
      return React.createElement(
        'div',
        { 'data-testid': 'mock-virtuoso' },
        ...(props.data ?? []).map((group, index) => React.createElement(
          'div',
          { 'data-index': String(index), key: group[0]?.id ?? index },
          props.itemContent?.(index, group),
        )),
        Footer ? React.createElement(Footer, { context: props.context }) : null,
      );
    }),
  };
});

vi.mock('./MessageGroup', async () => {
  const React = await import('react');
  return {
    default: ({ messages }: { messages: Message[] }) => React.createElement(
      React.Fragment,
      null,
      ...messages.map((message) => React.createElement(
        'div',
        {
          'data-message-id': message.role === 'user' ? message.id : undefined,
          key: message.id,
        },
        typeof message.content === 'string' ? message.content : message.role,
      )),
    ),
  };
});

vi.mock('./ChatInput', () => ({ default: () => null }));
vi.mock('./AgentStatusStrip', () => ({ default: () => null }));
vi.mock('./QueuedMessagesStrip', () => ({ default: () => null }));
vi.mock('./ScenarioGuide', () => ({ default: () => null }));
vi.mock('./UsageChip', () => ({ default: () => null }));
vi.mock('./ChapterRail', async () => {
  const React = await import('react');
  return {
    default: ({ chapters, onJump }: { chapters: Array<{ messageId: string }>; onJump: (chapter: { messageId: string }) => void }) => React.createElement(
      'button',
      { 'data-testid': 'chapter-jump', onClick: () => onJump(chapters[0]) },
      'chapter jump',
    ),
  };
});
vi.mock('./ChapterMenu', async () => {
  const React = await import('react');
  return {
    default: ({ chapters, onJump }: { chapters: Array<{ messageId: string }>; onJump: (chapter: { messageId: string }) => void }) => React.createElement(
      'button',
      { 'data-testid': 'chapter-jump', onClick: () => onJump(chapters[0]) },
      'chapter jump',
    ),
  };
});

// happy-dom's ResizeObserver never fires without real layout, so record every
// observer and let a test drive the exact one it means to (determinism rule).
interface RecordedObserver {
  callback: () => void;
  targets: Element[];
}
const resizeObservers: RecordedObserver[] = [];

class RecordingResizeObserver {
  private readonly record: RecordedObserver;
  constructor(callback: () => void) {
    this.record = { callback, targets: [] };
    resizeObservers.push(this.record);
  }
  observe(target: Element) {
    this.record.targets.push(target);
  }
  disconnect() {
    this.record.targets.length = 0;
  }
}

/** Fire the observer watching `target`, mirroring a post-layout resize. */
function fireResizeFor(target: Element | null): boolean {
  if (!target) return false;
  let fired = false;
  for (const observer of resizeObservers) {
    if (observer.targets.includes(target)) {
      observer.callback();
      fired = true;
    }
  }
  return fired;
}

const geometry = {
  anchorDocumentTop: 220,
  anchorHeight: 40,
  baselineContentHeight: 100,
  contentHeight: 100,
  /** Scroll range below the spacer that the arm's ledger never allocated —
   *  models the cold-start settlement surplus (late Virtuoso list-height
   *  materialization + native scroll anchoring adjustments). */
  extraScrollRange: 0,
  scroller: null as HTMLElement | null,
};

function rect(input: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
    ...input,
  };
}

function message(id: string, role: Message['role'], content: string, loopId: string): Message {
  return { id, role, content, loopId, timestamp: 1 };
}

function setupConversation(): string {
  const store = useChatStore.getState();
  const conversationId = store.createConversation();
  store.addMessage(conversationId, message('old-user', 'user', 'old prompt', 'old-loop'));
  store.addMessage(conversationId, message('old-assistant', 'assistant', 'old answer', 'old-loop'));
  store.setConversationStatus(conversationId, 'idle');
  return conversationId;
}

function installGeometry(scroller: HTMLElement): { getScrollTop: () => number } {
  geometry.scroller = scroller;
  let scrollTop = 0;
  const spacerHeight = () => Number.parseFloat(
    document.querySelector<HTMLElement>('[data-turn-bottom-spacer]')?.style.height || '0',
  );
  const scrollHeight = () => (
    300
    + Math.max(0, geometry.contentHeight - geometry.baselineContentHeight)
    + spacerHeight()
    + geometry.extraScrollRange
  );
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 300 },
    clientWidth: { configurable: true, value: 800 },
    offsetWidth: { configurable: true, value: 816 },
    scrollHeight: { configurable: true, get: scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight() - 300));
      },
    },
  });
  return { getScrollTop: () => scrollTop };
}

async function armNewTurn(conversationId: string, expectedSpacer: string | null = '200'): Promise<HTMLElement> {
  announceChatTurnScrollIntent({ conversationId, source: 'composer' });
  await act(async () => {
    const store = useChatStore.getState();
    store.setConversationStatus(conversationId, 'running');
    store.addMessage(conversationId, message('new-user', 'user', 'new prompt', 'new-loop'));
  });
  const spacer = await screen.findByTestId('mock-virtuoso').then(() => (
    document.querySelector<HTMLElement>('[data-turn-bottom-spacer]')!
  ));
  if (expectedSpacer != null) {
    await waitFor(() => expect(spacer.dataset.spacerHeight).toBe(expectedSpacer));
  }
  return spacer;
}

describe('ChatView active-turn scroll state machine', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    harness.props = null;
    harness.scrollToIndex.mockReset();
    geometry.anchorHeight = 40;
    geometry.contentHeight = geometry.baselineContentHeight;
    geometry.extraScrollRange = 0;
    geometry.scroller = null;
    resizeObservers.length = 0;
    vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const element = this as HTMLElement;
      const scroller = geometry.scroller;
      if (element === scroller) return rect({ right: 816, width: 816, height: 300, bottom: 300 });
      const row = element.closest<HTMLElement>('[data-index]');
      const rowTop = geometry.anchorDocumentTop - (scroller?.scrollTop ?? 0);
      if (element.hasAttribute('data-message-id')) {
        return rect({ top: rowTop, bottom: rowTop + geometry.anchorHeight, height: geometry.anchorHeight });
      }
      if (element.hasAttribute('data-turn-bottom-spacer')) {
        const height = Number.parseFloat(element.style.height || '0');
        const top = rowTop + geometry.contentHeight;
        return rect({ top, bottom: top + height, height });
      }
      if (row === element) return rect({ top: rowTop, bottom: rowTop + geometry.contentHeight, height: geometry.contentHeight });
      return rect();
    });
  });

  afterEach(() => {
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
    cleanup();
  });

  it('accounts spacer growth and exhausts with scrollTop compensation in the same callback', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);
    const spacer = await armNewTurn(conversationId);

    expect(getScrollTop()).toBe(200);
    geometry.contentHeight = 180;
    act(() => harness.props?.totalListHeightChanged?.(380));
    expect(spacer.dataset.spacerHeight).toBe('120');
    expect(getScrollTop()).toBe(200);

    geometry.contentHeight = 320;
    act(() => harness.props?.totalListHeightChanged?.(520));
    expect(spacer.dataset.spacerHeight).toBe('0');
    expect(getScrollTop()).toBe(220);
    expect(harness.props?.followOutput?.(false)).toBe('auto');
  });

  it('reclaims a cold-start settlement surplus into the spacer without moving the viewport', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);
    const spacer = await armNewTurn(conversationId);
    expect(getScrollTop()).toBe(200);

    // The arm's multi-frame settlement (late Virtuoso list-height + native
    // scroll anchoring) leaves 26px of scroll range below the pinned anchor.
    geometry.extraScrollRange = 26;
    act(() => harness.props?.totalListHeightChanged?.(326));

    // The surplus is returned by shrinking the spacer; the viewport (and the
    // pinned anchor) do not move, and the bottom gap closes to zero.
    expect(spacer.dataset.spacerHeight).toBe('174');
    expect(getScrollTop()).toBe(200);
    expect(scroller.scrollHeight - getScrollTop() - 300).toBe(0);

    // Later growth reconciles against the reduced ledger — the reclaimed
    // pixels stay gone and the gap stays closed.
    geometry.contentHeight = 180;
    act(() => harness.props?.totalListHeightChanged?.(406));
    expect(spacer.dataset.spacerHeight).toBe('94');
    expect(scroller.scrollHeight - getScrollTop() - 300).toBe(0);
  });

  it('does not re-reclaim while Virtuoso has not yet applied the previous shrink', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);
    const spacer = await armNewTurn(conversationId);
    expect(getScrollTop()).toBe(200);

    geometry.extraScrollRange = 26;
    act(() => harness.props?.totalListHeightChanged?.(326));
    expect(spacer.dataset.spacerHeight).toBe('174');

    // In the real renderer the spacer's style shrink reaches scrollHeight only
    // on Virtuoso's next height pass. Model that lag: scrollHeight still
    // carries the 26 reclaimed pixels, so the measured gap is stale — a second
    // reconcile must NOT shave the spacer again.
    geometry.extraScrollRange = 52;
    act(() => harness.props?.totalListHeightChanged?.(326));
    expect(spacer.dataset.spacerHeight).toBe('174');

    // Virtuoso catches up (the stale pixels leave scrollHeight): the gap is
    // truly closed and reconciliation stays quiet.
    geometry.extraScrollRange = 26;
    act(() => harness.props?.totalListHeightChanged?.(326));
    expect(spacer.dataset.spacerHeight).toBe('174');
    expect(scroller.scrollHeight - getScrollTop() - 300).toBe(0);
  });

  it('re-sticks when content grows after the last list-height event', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);
    await armNewTurn(conversationId);

    // Exhaust the spacer: the anchor hands off and the view sits at the bottom.
    geometry.contentHeight = 320;
    act(() => harness.props?.totalListHeightChanged?.(520));
    expect(scroller.scrollHeight - getScrollTop() - 300).toBe(0);

    // The real race: the last growth reaches the scroller AFTER the final
    // `totalListHeightChanged`, so no further event ever arrives to correct it
    // and the view freezes a few pixels above the bottom.
    geometry.contentHeight = 329;
    expect(scroller.scrollHeight - getScrollTop() - 300).toBe(9);

    // A resize of the scrolled content is the authoritative signal that the
    // geometry changed. It runs after layout and before paint, so correcting
    // here is invisible rather than a visible one-frame jump.
    const content = scroller.querySelector<HTMLElement>('[data-chat-scroll-content]');
    expect(fireResizeFor(content), 'the scrolled content is not observed').toBe(true);
    act(() => {});
    expect(scroller.scrollHeight - getScrollTop() - 300).toBe(0);
  });

  it('holds the bottom-pin off while a turn anchor is announced but not armed', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);
    scroller.scrollTop = 0;

    // Announced, not yet armed: the arm is about to measure this very geometry,
    // and every follow path must agree to hold off until it has (otherwise one
    // writer re-enables the bottom-pin another is deliberately holding off).
    announceChatTurnScrollIntent({ conversationId, source: 'composer' });
    geometry.contentHeight = 400;
    fireResizeFor(scroller.querySelector<HTMLElement>('[data-chat-scroll-content]'));
    act(() => {});

    expect(getScrollTop()).toBe(0);
  });

  it('leaves an unpinned reader alone when late content resizes', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);
    await armNewTurn(conversationId);
    // An explicit upward gesture unpins and freezes the spacer.
    act(() => { scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -12 })); });
    scroller.scrollTop = 120;

    geometry.contentHeight = 329;
    fireResizeFor(scroller.querySelector<HTMLElement>('[data-chat-scroll-content]'));
    act(() => {});

    expect(getScrollTop()).toBe(120);
  });

  it('self-clears a pending gate whose dispatch never persisted a message', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);

    // Announce, but never persist a new user row: the failed-dispatch shape.
    announceChatTurnScrollIntent({ conversationId, source: 'regenerate' });
    // Leave a visible bottom gap so an unsuppressed handler would stick-to-bottom.
    geometry.contentHeight = geometry.baselineContentHeight - 60;
    const before = getScrollTop();

    // Inside the suppression budget: follow stays gated, scrollTop untouched.
    for (let i = 0; i < 20; i += 1) {
      act(() => harness.props?.totalListHeightChanged?.(400));
    }
    expect(harness.props?.followOutput?.(false)).toBe(false);
    expect(getScrollTop()).toBe(before);

    // Past the budget the gate self-clears and ordinary follow recovers.
    for (let i = 0; i < 20; i += 1) {
      act(() => harness.props?.totalListHeightChanged?.(400));
    }
    expect(harness.props?.followOutput?.(false)).toBe('auto');
  });

  it('disarms on a run terminal and clears spacer with a synchronous bottom decision', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);
    const spacer = await armNewTurn(conversationId);

    act(() => useChatStore.getState().setConversationStatus(conversationId, 'idle'));

    expect(spacer.dataset.spacerHeight).toBe('0');
    expect(getScrollTop()).toBe(0);
    expect(harness.props?.followOutput?.(false)).toBe('auto');
  });

  it.each([
    ['downward wheel', () => geometry.scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY: 12 }))],
    ['keyboard page-down', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))],
    ['native scrollbar gutter', () => geometry.scroller?.dispatchEvent(new MouseEvent('pointerdown', { clientX: 815 }))],
  ])('disarms for %s and preserves the physical bottom state', async (_label, gesture) => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);
    const spacer = await armNewTurn(conversationId);
    scroller.scrollTop = 195;

    act(gesture);

    expect(spacer.dataset.spacerHeight).toBe('200');
    expect(getScrollTop()).toBe(195);
    expect(harness.props?.followOutput?.(false)).toBe('auto');
    expect(screen.queryByText(/bottom|latest|最新|底部/i)).not.toBeInTheDocument();
  });

  it('does not steal the viewport again when a user-disarmed run becomes terminal', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    const { getScrollTop } = installGeometry(scroller);
    const spacer = await armNewTurn(conversationId);
    scroller.scrollTop = 120;
    act(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -12 })));

    act(() => useChatStore.getState().setConversationStatus(conversationId, 'idle'));

    expect(spacer.dataset.spacerHeight).toBe('200');
    expect(getScrollTop()).toBe(120);
    expect(harness.props?.followOutput?.(false)).toBe('auto');
  });

  it('abandons pending cleanly instead of top-anchoring a viewport-height user message', async () => {
    geometry.anchorHeight = 280;
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    installGeometry(scroller);

    const spacer = await armNewTurn(conversationId, null);

    await waitFor(() => expect(harness.props?.followOutput?.(false)).toBe('auto'));
    expect(spacer.dataset.spacerHeight).toBe('0');
  });

  it('clears a frozen spacer for an explicit latest jump', async () => {
    const user = userEvent.setup();
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    installGeometry(scroller);
    const spacer = await armNewTurn(conversationId);
    scroller.scrollTop = 0;
    act(() => scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -12 })));
    expect(spacer.dataset.spacerHeight).toBe('200');

    await user.click(screen.getByText(/bottom|latest|最新|底部/i));
    expect(spacer.dataset.spacerHeight).toBe('0');
  });

  it('clears spacer before the chapter rail changes the Virtuoso target', async () => {
    const user = userEvent.setup();
    const conversationId = setupConversation();
    for (let index = 1; index <= 2; index += 1) {
      useChatStore.getState().addMessage(
        conversationId,
        message(`chapter-user-${index}`, 'user', `chapter ${index}`, `chapter-loop-${index}`),
      );
      useChatStore.getState().addMessage(
        conversationId,
        message(`chapter-assistant-${index}`, 'assistant', `answer ${index}`, `chapter-loop-${index}`),
      );
    }
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    installGeometry(scroller);
    const spacer = await armNewTurn(conversationId);
    await user.click(screen.getByTestId('chapter-jump'));
    expect(spacer.dataset.spacerHeight).toBe('0');
    expect(harness.scrollToIndex).toHaveBeenCalled();
  });

  it('clears spacer for search navigation and conversation switches', async () => {
    const conversationId = setupConversation();
    render(<ChatView />);
    const scroller = document.querySelector<HTMLElement>('.overlay-scroll')!;
    installGeometry(scroller);
    const spacer = await armNewTurn(conversationId);

    act(() => useChatStore.getState().setPendingSearchJump({ convId: conversationId, query: 'old prompt' }));
    await waitFor(() => expect(harness.scrollToIndex).toHaveBeenCalled());
    expect(spacer.dataset.spacerHeight).toBe('0');

    const secondConversation = useChatStore.getState().createConversation();
    useChatStore.getState().addMessage(
      secondConversation,
      message('second-user', 'user', 'second conversation', 'second-loop'),
    );
    await waitFor(() => expect(useChatStore.getState().activeConversationId).toBe(secondConversation));
    expect(document.querySelector<HTMLElement>('[data-turn-bottom-spacer]')?.dataset.spacerHeight).toBe('0');
  });
});
