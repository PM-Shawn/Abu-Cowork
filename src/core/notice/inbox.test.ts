import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  queueToInbox,
  getPendingInbox,
  markDelivered,
  cleanupInbox,
  drainInbox,
} from './inbox';
import {
  registerChannel,
  clearChannelHandlersForTest,
} from './pipeline';
import type { Notice } from './types';
import type { GateContext } from './gate';

vi.mocked(invoke).mockResolvedValue(undefined);

function makeNotice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: 'ntc_test',
    type: 'skill_proposal_offer',
    tier: 'L2',
    source: 'self_evolving',
    payload: {},
    dedupKey: 'k',
    createdAt: 1_000_000,
    ttl: 86_400_000,
    ...overrides,
  };
}

describe('Notice Inbox (SQLite via invoke)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  describe('queueToInbox', () => {
    it('calls notice_inbox_insert with serialized notice', () => {
      const notice = makeNotice();
      queueToInbox(notice);

      expect(invoke).toHaveBeenCalledWith('notice_inbox_insert', {
        entry: {
          notice_id: 'ntc_test',
          notice_json: JSON.stringify(notice),
          tier: 'L2',
          queued_at: 1_000_000,
          expires_at: 1_000_000 + 86_400_000,
        },
      });
    });

    it('defaults TTL to 24h when notice.ttl is undefined', () => {
      const notice = makeNotice({ ttl: undefined });
      queueToInbox(notice);

      expect(invoke).toHaveBeenCalledWith(
        'notice_inbox_insert',
        expect.objectContaining({
          entry: expect.objectContaining({
            expires_at: 1_000_000 + 24 * 60 * 60 * 1000,
          }),
        }),
      );
    });
  });

  describe('getPendingInbox', () => {
    it('calls notice_inbox_pending with current time', async () => {
      const mockEntries = [
        {
          id: 1,
          notice_id: 'ntc_1',
          notice_json: '{}',
          tier: 'L2',
          queued_at: 1_000_000,
          expires_at: 2_000_000,
          delivered: false,
        },
      ];
      vi.mocked(invoke).mockResolvedValue(mockEntries);

      const result = await getPendingInbox();

      expect(invoke).toHaveBeenCalledWith('notice_inbox_pending', {
        now: expect.any(Number),
      });
      expect(result).toEqual(mockEntries);
    });
  });

  describe('markDelivered', () => {
    it('calls notice_inbox_mark_delivered', () => {
      markDelivered('ntc_abc');
      expect(invoke).toHaveBeenCalledWith('notice_inbox_mark_delivered', {
        noticeId: 'ntc_abc',
      });
    });
  });

  describe('cleanupInbox', () => {
    it('calls notice_inbox_cleanup and returns deleted count', async () => {
      vi.mocked(invoke).mockResolvedValue(5);
      const count = await cleanupInbox();
      expect(invoke).toHaveBeenCalledWith('notice_inbox_cleanup', {
        now: expect.any(Number),
      });
      expect(count).toBe(5);
    });
  });

  describe('drainInbox', () => {
    function makeEntry(overrides: Partial<{
      id: number;
      notice_id: string;
      notice_json: string;
      tier: string;
      queued_at: number;
      expires_at: number;
    }> = {}) {
      const notice = makeNotice({ id: overrides.notice_id ?? 'ntc_q' });
      return {
        id: 1,
        notice_id: notice.id,
        notice_json: JSON.stringify(notice),
        tier: 'L2',
        queued_at: 1_000_000,
        expires_at: 10_000_000,
        delivered: false,
        ...overrides,
      };
    }

    function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
      return {
        now: 2_000_000,
        mainWindowFocused: true,
        currentConversationId: null,
        petState: 'off',
        fullscreenApp: null,
        recentL2Count: { windowStart: 0, count: 0 },
        userFeedbackHistory: [],
        ...overrides,
      };
    }

    beforeEach(() => {
      clearChannelHandlersForTest();
    });

    it('returns 0 when inbox empty', async () => {
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'notice_inbox_pending') return Promise.resolve([]);
        return Promise.resolve(undefined);
      });

      const count = await drainInbox(baseCtx());
      expect(count).toBe(0);
    });

    it('returns 0 when getPendingInbox rejects (non-fatal)', async () => {
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'notice_inbox_pending') return Promise.reject(new Error('db locked'));
        return Promise.resolve(undefined);
      });

      const count = await drainInbox(baseCtx());
      expect(count).toBe(0);
    });

    it('skips entries whose expires_at is before ctx.now', async () => {
      const expired = makeEntry({
        id: 1,
        notice_id: 'ntc_expired',
        expires_at: 500_000, // before ctx.now = 2_000_000
      });
      const valid = makeEntry({
        id: 2,
        notice_id: 'ntc_valid',
        expires_at: 10_000_000,
      });

      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'notice_inbox_pending') return Promise.resolve([expired, valid]);
        return Promise.resolve(undefined);
      });

      const menubarHandler = vi.fn();
      registerChannel('menubar', menubarHandler);

      const count = await drainInbox(baseCtx());
      expect(count).toBe(1);
      expect(menubarHandler).toHaveBeenCalledTimes(1);
      // Expired entry should not have triggered markDelivered either
      expect(invoke).not.toHaveBeenCalledWith('notice_inbox_mark_delivered', {
        noticeId: 'ntc_expired',
      });
      expect(invoke).toHaveBeenCalledWith('notice_inbox_mark_delivered', {
        noticeId: 'ntc_valid',
      });
    });

    it('skips entries with corrupt JSON', async () => {
      const corrupt = {
        id: 1,
        notice_id: 'ntc_bad',
        notice_json: '{ not valid json',
        tier: 'L2',
        queued_at: 1_000_000,
        expires_at: 10_000_000,
        delivered: false,
      };

      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'notice_inbox_pending') return Promise.resolve([corrupt]);
        return Promise.resolve(undefined);
      });

      const handler = vi.fn();
      registerChannel('menubar', handler);

      const count = await drainInbox(baseCtx());
      expect(count).toBe(0);
      expect(handler).not.toHaveBeenCalled();
    });

    it('caps per-call dispatch at opts.cap', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({ id: i, notice_id: `ntc_${i}` }),
      );
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'notice_inbox_pending') return Promise.resolve(entries);
        return Promise.resolve(undefined);
      });

      const handler = vi.fn();
      registerChannel('menubar', handler);

      const count = await drainInbox(baseCtx(), { cap: 3 });
      expect(count).toBe(3);
      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('marks each delivered notice via notice_inbox_mark_delivered', async () => {
      const entries = [
        makeEntry({ id: 1, notice_id: 'ntc_a' }),
        makeEntry({ id: 2, notice_id: 'ntc_b' }),
      ];
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'notice_inbox_pending') return Promise.resolve(entries);
        return Promise.resolve(undefined);
      });

      registerChannel('menubar', vi.fn());

      await drainInbox(baseCtx());
      expect(invoke).toHaveBeenCalledWith('notice_inbox_mark_delivered', {
        noticeId: 'ntc_a',
      });
      expect(invoke).toHaveBeenCalledWith('notice_inbox_mark_delivered', {
        noticeId: 'ntc_b',
      });
    });

    it('routes L2 with conversationId to sidebar_badge when focused elsewhere', async () => {
      const notice = makeNotice({
        id: 'ntc_convo',
        payload: { conversationId: 'conv_xyz' },
      });
      const entry = {
        id: 1,
        notice_id: notice.id,
        notice_json: JSON.stringify(notice),
        tier: 'L2',
        queued_at: 1_000_000,
        expires_at: 10_000_000,
        delivered: false,
      };

      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'notice_inbox_pending') return Promise.resolve([entry]);
        return Promise.resolve(undefined);
      });

      const sidebarHandler = vi.fn();
      registerChannel('sidebar_badge', sidebarHandler);

      // focused + different conversation active → sidebar_badge
      const ctx = baseCtx({
        mainWindowFocused: true,
        currentConversationId: 'conv_other',
      });
      const count = await drainInbox(ctx);
      expect(count).toBe(1);
      expect(sidebarHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ntc_convo' }),
        { channel: 'sidebar_badge', conversationId: 'conv_xyz' },
      );
    });
  });
});
