/**
 * channels.ts — system_notification click-through regression tests.
 *
 * Guards the notification → source-conversation deep link: clicking the OS
 * notification for "task A finished" must jump to conversation A, not stay
 * on whichever conversation the window happens to show (bug found in the
 * 2026-07-26 signed-package verification).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initNoticeChannelHandlers, setNotificationPermission } from './channels';
import { dispatchTargets } from './pipeline';
import type { Notice } from './types';

vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: vi.fn() } }));
vi.mock('@/stores/settingsStore', () => ({ useSettingsStore: { getState: vi.fn() } }));
vi.mock('@/stores/previewStore', () => ({ usePreviewStore: { getState: vi.fn() } }));
vi.mock('@/stores/noticeBadgeStore', () => ({ useNoticeBadgeStore: { getState: vi.fn() } }));

import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useNoticeBadgeStore } from '@/stores/noticeBadgeStore';

class FakeNotification {
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options?: { body?: string },
  ) {
    FakeNotification.instances.push(this);
  }
}

const switchConversation = vi.fn().mockResolvedValue(undefined);
const clearCompletedStatus = vi.fn();
const setViewMode = vi.fn();
const setFileTreeMode = vi.fn();
const clearBadge = vi.fn();

function makeNotice(payload: Record<string, unknown>): Notice {
  return {
    id: 'ntc_test',
    type: 'task_complete',
    tier: 'L2',
    source: 'agent',
    payload,
    dedupKey: 'task_complete:test',
    createdAt: Date.now(),
  };
}

function fireSystemNotification(notice: Notice): FakeNotification {
  dispatchTargets(notice, [{ channel: 'system_notification' }]);
  const n = FakeNotification.instances.at(-1);
  if (!n) throw new Error('no Notification was created');
  return n;
}

describe('system_notification click-through', () => {
  beforeEach(() => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.instances = [];
    vi.mocked(useChatStore.getState).mockReturnValue({
      conversationIndex: { 'conv-a': { id: 'conv-a' } },
      switchConversation,
      clearCompletedStatus,
    } as unknown as ReturnType<typeof useChatStore.getState>);
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      setViewMode,
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    vi.mocked(usePreviewStore.getState).mockReturnValue({
      setFileTreeMode,
    } as unknown as ReturnType<typeof usePreviewStore.getState>);
    vi.mocked(useNoticeBadgeStore.getState).mockReturnValue({
      clear: clearBadge,
    } as unknown as ReturnType<typeof useNoticeBadgeStore.getState>);
    initNoticeChannelHandlers();
    setNotificationPermission(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('creates a web Notification with a click handler attached', () => {
    const n = fireSystemNotification(
      makeNotice({ conversationTitle: 'A', conversationId: 'conv-a' }),
    );
    expect(n.options?.body).toContain('A');
    expect(typeof n.onclick).toBe('function');
  });

  it('click jumps to the source conversation (switch + chat view + badges cleared)', async () => {
    const n = fireSystemNotification(
      makeNotice({ conversationTitle: 'A', conversationId: 'conv-a' }),
    );
    n.onclick?.();
    await vi.waitFor(() => expect(switchConversation).toHaveBeenCalledWith('conv-a'));
    expect(setViewMode).toHaveBeenCalledWith('chat');
    expect(setFileTreeMode).toHaveBeenCalledWith(false);
    expect(clearBadge).toHaveBeenCalledWith('conv-a');
    expect(clearCompletedStatus).toHaveBeenCalledWith('conv-a');
  });

  it('click does NOT switch when the conversation was deleted since the notice fired', async () => {
    const n = fireSystemNotification(
      makeNotice({ conversationTitle: 'gone', conversationId: 'conv-deleted' }),
    );
    n.onclick?.();
    // flush the dynamic imports + guard check
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(switchConversation).not.toHaveBeenCalled();
    expect(setViewMode).not.toHaveBeenCalled();
  });

  it('click without a conversationId only focuses — no store calls, no throw', async () => {
    const n = fireSystemNotification(makeNotice({ title: 'trigger-task', outcome: 'completed' }));
    expect(() => n.onclick?.()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(switchConversation).not.toHaveBeenCalled();
  });
});
