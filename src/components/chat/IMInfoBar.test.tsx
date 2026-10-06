// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useIMChannelStore } from '@/stores/imChannelStore';
import type { Conversation } from '@/types';
import type { IMSession } from '@/types/imChannel';
import IMInfoBar from './IMInfoBar';

const iconButtonRenders = vi.hoisted(() => vi.fn());

// Counts renders of the bar's only floating-layer control (the 更多操作 button and its tooltip).
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      iconButtonRenders();
      return actual.IconButton(props);
    },
  };
});

// The latest props of the details menu, to drive it the way Radix does when it is
// reopened during its exit animation (happy-dom has no animations).
const menuProps = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
  onSelectEnd: undefined as ((event: Event) => void) | undefined,
}));

vi.mock('@/components/ds/menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/menu')>();
  return {
    ...actual,
    Menu: (props: ComponentProps<typeof actual.Menu>) => {
      menuProps.onOpenChange = props.onOpenChange;
      return actual.Menu(props);
    },
    MenuItem: (props: ComponentProps<typeof actual.MenuItem>) => {
      if (props.tone === 'danger') menuProps.onSelectEnd = props.onSelect;
      return actual.MenuItem(props);
    },
  };
});

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

// Stands in for ChatView passing a new conversation object on every streamed token.
function Host({ tick, children }: { tick: number; children: ReactNode }) {
  return <DesignSystemProvider><span data-tick={tick} />{children}</DesignSystemProvider>;
}

const T0 = 1_700_000_000_000;

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'im-1',
    title: '周报群',
    createdAt: T0,
    updatedAt: T0,
    status: 'idle',
    messages: [],
    imPlatform: 'feishu',
    imChannelId: 'ch-1',
    ...overrides,
  } as Conversation;
}

const session = {
  key: 'feishu:chat-1:window',
  channelId: 'ch-1',
  conversationId: 'im-1',
  lastActiveAt: T0,
  messageCount: 3,
  userId: 'u1',
  userName: 'Shawn',
  capability: 'read_tools',
  chatName: '产品群',
} as IMSession;

describe('IMInfoBar', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    initLanguage('zh-CN');
    useIMChannelStore.setState({ channels: {}, sessions: { [session.key]: session } });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens the details menu from 更多操作, closes it on Escape and returns focus to the button', async () => {
    const user = userEvent.setup();
    render(<IMInfoBar conversation={conversation()} />);
    const more = screen.getByRole('button', { name: '更多操作' });

    await user.click(more);
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('能力');
    expect(menu).toHaveTextContent('产品群');
    expect(screen.getByRole('menuitem', { name: '结束会话' })).toHaveClass('text-danger');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  // Opens the menu and chooses 结束会话; the question is on the page afterwards.
  async function askToEnd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '结束会话' }));
    return screen.findByRole('alertdialog', { name: '结束会话' });
  }
  const answer = (user: ReturnType<typeof userEvent.setup>, box: HTMLElement, name: string) =>
    user.click(within(box).getByRole('button', { name }));

  it('ends the session only after the user confirms', async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    const removeSession = vi.spyOn(useIMChannelStore.getState(), 'removeSession');
    const user = userEvent.setup();
    render(<IMInfoBar conversation={conversation()} />);

    await answer(user, await askToEnd(user), '取消');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeSession).not.toHaveBeenCalled();
    expect(useIMChannelStore.getState().sessions[session.key]).toBeDefined();

    await answer(user, await askToEnd(user), '结束会话');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeSession.mock.calls).toEqual([[session.key]]);
    expect(useIMChannelStore.getState().sessions[session.key]).toBeUndefined();
    // The browser's own question box is not used.
    expect(nativeConfirm).not.toHaveBeenCalled();
    removeSession.mockRestore();
  });

  it('asks once the menu has gone, names the session, and opens on 取消', async () => {
    const user = userEvent.setup();
    render(<IMInfoBar conversation={conversation()} />);

    const box = await askToEnd(user);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(box).toHaveTextContent('确定结束当前 IM 会话吗？');
    expect(box).toHaveTextContent('周报群');
    expect(within(box).getByRole('button', { name: '取消' })).toHaveFocus();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('takes Escape as 取消 and returns the focus to 更多操作', async () => {
    const removeSession = vi.spyOn(useIMChannelStore.getState(), 'removeSession');
    const user = userEvent.setup();
    render(<IMInfoBar conversation={conversation()} />);

    await askToEnd(user);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(removeSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '更多操作' })).toHaveFocus();
    removeSession.mockRestore();
  });

  it('ends nothing when the session is gone by the time of the answer', async () => {
    const removeSession = vi.spyOn(useIMChannelStore.getState(), 'removeSession');
    const user = userEvent.setup();
    render(<IMInfoBar conversation={conversation()} />);

    const box = await askToEnd(user);
    act(() => { useIMChannelStore.setState({ sessions: {} }); });
    await answer(user, box, '结束会话');

    expect(removeSession).not.toHaveBeenCalled();
    removeSession.mockRestore();
  });

  it('ends nothing when the session under that key now belongs to another conversation', async () => {
    const removeSession = vi.spyOn(useIMChannelStore.getState(), 'removeSession');
    const user = userEvent.setup();
    render(<IMInfoBar conversation={conversation()} />);

    const box = await askToEnd(user);
    act(() => { useIMChannelStore.setState({ sessions: { [session.key]: { ...session, conversationId: 'im-2' } } }); });
    await answer(user, box, '结束会话');

    expect(removeSession).not.toHaveBeenCalled();
    expect(useIMChannelStore.getState().sessions[session.key]).toBeDefined();
    removeSession.mockRestore();
  });

  it('ends nothing when the bar has left the page by the time of the answer', async () => {
    function Host() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <Button onClick={() => setShown(false)}>leave the conversation</Button>
          {shown && <IMInfoBar conversation={conversation()} />}
        </>
      );
    }
    const removeSession = vi.spyOn(useIMChannelStore.getState(), 'removeSession');
    const user = userEvent.setup();
    render(<Host />);

    const box = await askToEnd(user);
    fireEvent.click(screen.getByRole('button', { name: 'leave the conversation', hidden: true }));
    await answer(user, box, '结束会话');

    expect(removeSession).not.toHaveBeenCalled();
    expect(useIMChannelStore.getState().sessions[session.key]).toBeDefined();
    removeSession.mockRestore();
  });

  // A menu reopened during its exit animation stays mounted: the close hook never ran
  // for the choice made before, and opening again must forget it.
  it('forgets a choice whose close hook never ran when the menu opens again', async () => {
    const user = userEvent.setup();
    render(<IMInfoBar conversation={conversation()} />);

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    act(() => menuProps.onSelectEnd?.(new Event('select')));
    act(() => menuProps.onOpenChange?.(true));
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更多操作' })).toHaveFocus();
  });

  it('offers no way to end a session when the conversation has none', async () => {
    useIMChannelStore.setState({ channels: {}, sessions: {} });
    const user = userEvent.setup();
    render(<IMInfoBar conversation={conversation()} />);

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '结束会话' })).not.toBeInTheDocument();
  });

  it('does not re-render the menu button when only the conversation object changes', () => {
    const { rerender } = renderBare(<Host tick={0}><IMInfoBar conversation={conversation()} /></Host>);
    const initial = iconButtonRenders.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    rerender(<Host tick={1}><IMInfoBar conversation={conversation({ updatedAt: T0 + 1 })} /></Host>);
    rerender(<Host tick={2}><IMInfoBar conversation={conversation({ updatedAt: T0 + 2 })} /></Host>);
    expect(iconButtonRenders).toHaveBeenCalledTimes(initial);
  });
});
