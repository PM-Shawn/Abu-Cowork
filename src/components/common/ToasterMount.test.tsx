// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getLanguageSetting, setLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
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
const shownTitles = () => within(region()).queryAllByRole('listitem').map((item) => item.querySelector('p')?.textContent ?? '');
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  toasterRenders.count = 0;
});

afterEach(() => {
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
    expect(shownTitles()).toEqual(['Copied', 'Save failed']);
    expect(within(region()).getByText('The disk is full')).toBeInTheDocument();
  });

  it('shows the newest three of four', () => {
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    for (const n of [1, 2, 3, 4]) add({ type: 'info', title: `Notice ${n}` });
    expect(shownTitles()).toEqual(['Notice 2', 'Notice 3', 'Notice 4']);
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
    await user.click(within(region()).getByRole('button', { name: 'Authorize' }));
    expect(onAuthorize).toHaveBeenCalledOnce();
    expect(onSettings).not.toHaveBeenCalled();
    expect(shownTitles()).toEqual([]);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('shows the notification an action adds while it closes its own', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    add({
      type: 'warning',
      title: 'Write blocked',
      actions: [{ label: 'Authorize', onClick: () => useToastStore.getState().addToast({ type: 'success', title: 'Authorized' }) }],
    });
    await user.click(within(region()).getByRole('button', { name: 'Authorize' }));
    expect(shownTitles()).toEqual(['Authorized']);
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
      const first = within(region()).getAllByRole('listitem')[0];
      await user.click(within(first).getByRole('button', { name: 'Close' }));
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

describe('ToasterMount and the store clock', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('brings back a failure that stays until closed once newer notifications have gone', async () => {
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    add({ type: 'error', title: 'Upload failed', duration: 0 });
    for (const n of [1, 2, 3]) add({ type: 'info', title: `Notice ${n}` });
    expect(shownTitles()).toEqual(['Notice 1', 'Notice 2', 'Notice 3']);
    await advance(3000);
    expect(shownTitles()).toEqual(['Upload failed']);
  });

  it('leaves the timing to the store: 3 s, 10 s with actions, and no end for duration 0', async () => {
    render(<ToasterMount />, { wrapper: DesignSystemProvider });
    add({ type: 'error', title: 'Stays', duration: 0 });
    add({ type: 'warning', title: 'With action', actions: [{ label: 'Open settings', onClick: () => undefined }] });
    add({ type: 'success', title: 'Plain' });
    await advance(2999);
    expect(shownTitles()).toEqual(['Stays', 'With action', 'Plain']);
    await advance(1);
    expect(shownTitles()).toEqual(['Stays', 'With action']);
    await advance(6999);
    expect(shownTitles()).toEqual(['Stays', 'With action']);
    await advance(1);
    expect(shownTitles()).toEqual(['Stays']);
    await advance(10000);
    expect(shownTitles()).toEqual(['Stays']);
  });
});
