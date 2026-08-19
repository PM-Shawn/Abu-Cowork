import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { Event } from '@tauri-apps/api/event';
import { useNoticeMenubarStore } from '@/stores/noticeMenubarStore';
import { cachedContextProvider, setFocused } from './contextProvider';
import type { Notice } from './types';

const mocks = vi.hoisted(() => ({
  onFocusChanged: vi.fn(),
  unlisten: vi.fn(),
  clearDockBadge: vi.fn(),
  nativeHandler: null as ((event: Event<boolean>) => void) | null,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: mocks.onFocusChanged,
  }),
}));

vi.mock('@/utils/notifications', () => ({
  clearDockBadge: mocks.clearDockBadge,
}));

import { installNoticeFocusSync } from './focusSync';

// Filler timestamp (TESTING.md §3) — required by the Notice/GateContext shapes
// but never asserted on below.
const FIXED_TIMESTAMP = 1_700_000_000_000;

function makeNotice(id: string): Notice {
  return {
    id,
    type: 'task_complete',
    tier: 'L1',
    source: 'agent',
    payload: { conversationId: 'conv-1' },
    dedupKey: id,
    createdAt: FIXED_TIMESTAMP,
  };
}

describe('installNoticeFocusSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nativeHandler = null;
    mocks.onFocusChanged.mockImplementation(
      async (handler: (event: Event<boolean>) => void) => {
        mocks.nativeHandler = handler;
        return mocks.unlisten;
      },
    );
    vi.mocked(invoke).mockResolvedValue(undefined);
    useNoticeMenubarStore.setState({ notices: [] });
    setFocused(true);
  });

  it('clears a stale menubar count when renderer focus arrives without a native event', () => {
    useNoticeMenubarStore.getState().addNotice(makeNotice('ntc-1'));
    vi.mocked(invoke).mockClear();

    const cleanup = installNoticeFocusSync(vi.fn());
    window.dispatchEvent(new globalThis.Event('focus'));

    expect(useNoticeMenubarStore.getState().notices).toEqual([]);
    expect(mocks.clearDockBadge).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('update_tray_notice_count', { count: 0 });
    cleanup();
  });

  it('tracks native blur and clears attention plus drains once on native focus', async () => {
    const onNativeFocused = vi.fn();
    const cleanup = installNoticeFocusSync(onNativeFocused);
    await vi.waitFor(() => expect(mocks.nativeHandler).not.toBeNull());

    useNoticeMenubarStore.getState().addNotice(makeNotice('ntc-2'));
    mocks.nativeHandler!({ payload: false } as Event<boolean>);
    expect(cachedContextProvider(FIXED_TIMESTAMP).mainWindowFocused).toBe(false);
    expect(useNoticeMenubarStore.getState().notices).toHaveLength(1);

    mocks.nativeHandler!({ payload: true } as Event<boolean>);
    expect(cachedContextProvider(FIXED_TIMESTAMP).mainWindowFocused).toBe(true);
    expect(useNoticeMenubarStore.getState().notices).toEqual([]);
    expect(onNativeFocused).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('removes both focus listeners during cleanup', async () => {
    const cleanup = installNoticeFocusSync(vi.fn());
    await vi.waitFor(() => expect(mocks.nativeHandler).not.toBeNull());
    cleanup();

    useNoticeMenubarStore.getState().addNotice(makeNotice('ntc-3'));
    window.dispatchEvent(new globalThis.Event('focus'));

    expect(useNoticeMenubarStore.getState().notices).toHaveLength(1);
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });
});
