import { describe, it, expect } from 'vitest';
import {
  filter,
  type GateContext,
  type FeedbackRule,
} from './gate';
import type { Notice } from './types';

function makeNotice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: 'ntc_test',
    type: 'task_complete',
    tier: 'L1',
    source: 'agent',
    payload: {},
    dedupKey: 'k',
    createdAt: 1_000_000,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: 1_000_000,
    mainWindowFocused: false,
    currentConversationId: null,
    petState: 'off',
    fullscreenApp: null,
    recentL2Count: { windowStart: 0, count: 0 },
    userFeedbackHistory: [],
    ...overrides,
  };
}

describe('Notice Gate · filter', () => {
  describe('L1 bypass', () => {
    it('L1 allows even during fullscreen', () => {
      const out = filter(
        makeNotice({ tier: 'L1' }),
        makeCtx({ fullscreenApp: 'Keynote' }),
      );
      expect(out).toEqual({ action: 'allow' });
    });

    it('L1 ignores matching drop rules', () => {
      const rule: FeedbackRule = {
        label: 'always-drop',
        matches: () => true,
        action: 'drop',
      };
      const out = filter(
        makeNotice({ tier: 'L1' }),
        makeCtx({ userFeedbackHistory: [rule] }),
      );
      expect(out).toEqual({ action: 'allow' });
    });
  });

  describe('fullscreen handling', () => {
    it('L2 fullscreen → queue_inbox', () => {
      const out = filter(
        makeNotice({ tier: 'L2' }),
        makeCtx({ fullscreenApp: 'Keynote' }),
      );
      expect(out.action).toBe('queue_inbox');
      if (out.action === 'queue_inbox') {
        expect(out.reason).toContain('fullscreen:Keynote');
      }
    });

    it('L3 fullscreen → drop', () => {
      const out = filter(
        makeNotice({ tier: 'L3' }),
        makeCtx({ fullscreenApp: 'Keynote' }),
      );
      expect(out.action).toBe('drop');
    });
  });

  describe('feedback rules', () => {
    it('matching drop rule drops L2', () => {
      const rule: FeedbackRule = {
        label: 'no-im',
        matches: (n) => n.type === 'im_inbound',
        action: 'drop',
      };
      const out = filter(
        makeNotice({ tier: 'L2', type: 'im_inbound' }),
        makeCtx({ userFeedbackHistory: [rule] }),
      );
      expect(out).toEqual({ action: 'drop', reason: 'rule:no-im' });
    });

    it('matching degrade rule changes tier', () => {
      const rule: FeedbackRule = {
        label: 'evening-l2-to-l3',
        matches: () => true,
        action: 'degrade',
        degradeTo: 'L3',
      };
      const out = filter(
        makeNotice({ tier: 'L2' }),
        makeCtx({ userFeedbackHistory: [rule] }),
      );
      expect(out).toEqual({
        action: 'degrade_tier',
        to: 'L3',
        reason: 'rule:evening-l2-to-l3',
      });
    });

    it('non-matching rules fall through to allow', () => {
      const rule: FeedbackRule = {
        label: 'meeting-only',
        matches: (n) => n.type === 'meeting_prep',
        action: 'drop',
      };
      const out = filter(
        makeNotice({ tier: 'L2', type: 'im_inbound' }),
        makeCtx({ userFeedbackHistory: [rule] }),
      );
      expect(out).toEqual({ action: 'allow' });
    });

    it('first matching rule wins', () => {
      const drop: FeedbackRule = {
        label: 'drop-all',
        matches: () => true,
        action: 'drop',
      };
      const degrade: FeedbackRule = {
        label: 'degrade-all',
        matches: () => true,
        action: 'degrade',
        degradeTo: 'L3',
      };
      const out = filter(
        makeNotice({ tier: 'L2' }),
        makeCtx({ userFeedbackHistory: [drop, degrade] }),
      );
      expect(out.action).toBe('drop');
    });

    it('degrade rule without degradeTo is skipped', () => {
      const broken: FeedbackRule = {
        label: 'broken',
        matches: () => true,
        action: 'degrade',
      };
      const out = filter(
        makeNotice({ tier: 'L2' }),
        makeCtx({ userFeedbackHistory: [broken] }),
      );
      expect(out).toEqual({ action: 'allow' });
    });
  });

  it('default allow when nothing triggers', () => {
    const out = filter(makeNotice({ tier: 'L2' }), makeCtx());
    expect(out).toEqual({ action: 'allow' });
  });
});
