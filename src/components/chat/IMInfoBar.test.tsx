// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render as renderBare, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('ends the session only after the user confirms', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const user = userEvent.setup();
    render(<IMInfoBar conversation={conversation()} />);

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '结束会话' }));
    expect(confirm).toHaveBeenCalledWith('确定结束当前 IM 会话吗？');
    expect(useIMChannelStore.getState().sessions[session.key]).toBeDefined();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '结束会话' }));
    expect(useIMChannelStore.getState().sessions[session.key]).toBeUndefined();
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
