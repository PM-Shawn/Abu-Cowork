// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import type { ReactNode } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TOAST_SETTLE_MS } from '@/components/ds/styles';
import { getLanguageSetting, setLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { MAX_VISIBLE_TOASTS, setToastPlacesForApproval, useToastStore } from '@/stores/toastStore';
import ToasterMount from './ToasterMount';

// Counts renders of the real list: the wrapper runs the real component inside its own render.
const toasterRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/ds/toaster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/toaster')>();
  return {
    ...actual,
    Toaster: (props: Parameters<typeof actual.Toaster>[0]) => {
      toasterRenders.count += 1;
      return actual.Toaster(props);
    },
  };
});

const add = (toast: Parameters<ReturnType<typeof useToastStore.getState>['addToast']>[0]) => {
  act(() => useToastStore.getState().addToast(toast));
};
const region = () => screen.getByRole('region', { name: 'Notifications' });
// Titles on the page, top to bottom: the newest first.
const shownTitles = () => within(region()).queryAllByRole('listitem').map((item) => item.querySelector('p')?.textContent ?? '');
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
// A notification takes no pointer press for a moment after it appeared or moved: let that pass.
const settle = () => act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });
const clear = () => {
  for (const toast of useToastStore.getState().toasts) useToastStore.getState().removeToast(toast.id);
  useToastStore.getState().setPlaces(MAX_VISIBLE_TOASTS);
};

beforeEach(() => {
  clear();
  toasterRenders.count = 0;
});

afterEach(() => {
  act(() => clear());
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ToasterMount', () => {
  // The store's expiry timers never run on the real clock; user-event needs a clock that moves.
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });

  it('shows what a caller adds: title, message and status icon', () => {
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    expect(shownTitles()).toEqual([]);
    add({ type: 'success', title: 'Copied' });
    add({ type: 'error', title: 'Save failed', message: 'The disk is full' });
    expect(shownTitles()).toEqual(['Save failed', 'Copied']);
    expect(within(region()).getByText('The disk is full')).toBeInTheDocument();
  });

  it('shows the newest three of four; the first one waits off screen', () => {
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    for (const n of [1, 2, 3, 4]) add({ type: 'info', title: `Notice ${n}` });
    expect(shownTitles()).toEqual(['Notice 4', 'Notice 3', 'Notice 2']);
    expect(useToastStore.getState().toasts).toHaveLength(4);
  });

  it('runs an action, then closes the notification', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onAuthorize = vi.fn();
    const onSettings = vi.fn();
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    add({
      type: 'warning',
      title: 'Write blocked',
      message: 'Folder: /fake/project',
      actions: [{ label: 'Authorize', onClick: onAuthorize }, { label: 'Open settings', onClick: onSettings }],
    });
    expect(within(region()).getByRole('button', { name: 'Open settings' })).toBeInTheDocument();
    settle();
    await user.click(within(region()).getByRole('button', { name: 'Authorize' }));
    expect(onAuthorize).toHaveBeenCalledOnce();
    expect(onSettings).not.toHaveBeenCalled();
    expect(shownTitles()).toEqual([]);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  // The answer to a press is on screen at once, also with other notifications waiting.
  it('shows the notification an action adds, on top, while it closes its own', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    for (const folder of ['a', 'b', 'c', 'd']) {
      add({
        type: 'warning',
        title: 'Write blocked',
        message: `Folder: /fake/project/${folder}`,
        actions: [{ label: `Authorize ${folder}`, onClick: () => useToastStore.getState().addToast({ type: 'success', title: `Authorized ${folder}` }) }],
      });
    }
    settle();
    await user.click(within(region()).getByRole('button', { name: 'Authorize c' }));
    expect(shownTitles()).toEqual(['Authorized c', 'Write blocked', 'Write blocked']);
    expect(within(region()).getByText('Folder: /fake/project/d')).toBeInTheDocument();
    expect(within(region()).getByText('Folder: /fake/project/b')).toBeInTheDocument();
  });

  it('closes a notification through removeToast with its id', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const original = useToastStore.getState().removeToast;
    const removeToast = vi.fn(original);
    useToastStore.setState({ removeToast });
    try {
      render(<ToasterMount />, { wrapper: DesignSystemProvider });
      add({ type: 'error', title: 'Save failed', duration: 0 });
      add({ type: 'info', title: 'Still here', duration: 0 });
      const id = useToastStore.getState().toasts[0].id;
      settle();
      const older = within(region()).getAllByRole('listitem')[1];
      await user.click(within(older).getByRole('button', { name: 'Close' }));
      expect(removeToast.mock.calls).toEqual([[id]]);
      expect(shownTitles()).toEqual(['Still here']);
    } finally {
      useToastStore.setState({ removeToast: original });
    }
  });

  it('is a region named 「通知」 with a polite live list inside, and no status role', () => {
    const previous = getLanguageSetting();
    setLanguage('zh-CN');
    try {
      render(<ToasterMount />, { wrapper: DesignSystemProvider });
      const named = screen.getByRole('region', { name: '通知' });
      // The region is there before any notification, so a reader hears the first one too.
      expect(named.querySelector('[aria-live]')).toHaveAttribute('aria-live', 'polite');
      add({ type: 'success', title: '已复制' });
      expect(within(named).getAllByRole('listitem')).toHaveLength(1);
      expect(within(named).getByRole('button', { name: '关闭' })).toBeInTheDocument();
      expect(named.querySelector('[role="status"]')).toBeNull();
    } finally {
      setLanguage(previous);
    }
  });

  it('does not render when the page around it renders for a chat change', () => {
    const pageRenders = { count: 0 };
    function Page() {
      useChatStore((s) => s.activeConversationId);
      pageRenders.count += 1;
      return <ToasterMount />;
    }
    const before = useChatStore.getState().activeConversationId;
    try {
      render(<Page />, { wrapper: DesignSystemProvider });
      const page = pageRenders.count;
      const list = toasterRenders.count;
      act(() => useChatStore.setState({ activeConversationId: 'conversation-for-the-render-check' }));
      expect(pageRenders.count).toBe(page + 1);
      expect(toasterRenders.count).toBe(list);
      // The counter is live: a notification does render the list.
      add({ type: 'info', title: 'Notice' });
      expect(toasterRenders.count).toBeGreaterThan(list);
    } finally {
      useChatStore.setState({ activeConversationId: before });
    }
  });
});

describe('ToasterMount beside an approval', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });

  const Page = ({ approval }: { approval: boolean }) => (
    <>
      <Dialog open={approval} layer="approval" role="alertdialog" title="Run this command?" />
      <ToasterMount />
    </>
  );
  const provider = { wrapper: ({ children }: { children: ReactNode }) => <DesignSystemProvider onApprovalChange={setToastPlacesForApproval}>{children}</DesignSystemProvider> };

  it('shows the newest notification alone while an approval is on the page, and the others return after', () => {
    const { rerender } = render(<Page approval={false} />, provider);
    for (const n of [1, 2, 3]) add({ type: 'info', title: `Notice ${n}`, duration: 0 });
    expect(shownTitles()).toEqual(['Notice 3', 'Notice 2', 'Notice 1']);
    rerender(<Page approval />);
    expect(screen.getByRole('alertdialog', { name: 'Run this command?' })).toBeInTheDocument();
    expect(shownTitles()).toEqual(['Notice 3']);
    expect(useToastStore.getState().toasts).toHaveLength(3);
    // One that arrives takes the single place.
    add({ type: 'error', title: 'Send blocked', duration: 0 });
    expect(shownTitles()).toEqual(['Send blocked']);
    rerender(<Page approval={false} />);
    expect(shownTitles()).toEqual(['Send blocked', 'Notice 3', 'Notice 2']);
  });
});

describe('ToasterMount and the store clock', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  // One error per failed draft, added in one loop: every one is on the page for its full 3 s.
  it('shows each of five errors for its full time: the newest three at once, then the two that were pushed out', async () => {
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    for (const n of [1, 2, 3, 4, 5]) add({ type: 'error', title: `Draft ${n} failed` });
    expect(shownTitles()).toEqual(['Draft 5 failed', 'Draft 4 failed', 'Draft 3 failed']);
    await advance(2999);
    expect(shownTitles()).toEqual(['Draft 5 failed', 'Draft 4 failed', 'Draft 3 failed']);
    await advance(1);
    expect(shownTitles()).toEqual(['Draft 2 failed', 'Draft 1 failed']);
    await advance(2999);
    expect(shownTitles()).toEqual(['Draft 2 failed', 'Draft 1 failed']);
    await advance(1);
    expect(shownTitles()).toEqual([]);
  });

  it('leaves the timing to the store: 3 s, 10 s with actions, and no end for duration 0', async () => {
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    add({ type: 'error', title: 'Stays', duration: 0 });
    add({ type: 'warning', title: 'With action', actions: [{ label: 'Open settings', onClick: () => undefined }] });
    add({ type: 'success', title: 'Plain' });
    await advance(2999);
    expect(shownTitles()).toEqual(['Plain', 'With action', 'Stays']);
    await advance(1);
    expect(shownTitles()).toEqual(['With action', 'Stays']);
    await advance(6999);
    expect(shownTitles()).toEqual(['With action', 'Stays']);
    await advance(1);
    expect(shownTitles()).toEqual(['Stays']);
    await advance(10000);
    expect(shownTitles()).toEqual(['Stays']);
  });
});
