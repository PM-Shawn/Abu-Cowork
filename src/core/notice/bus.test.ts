import { describe, it, expect, beforeEach } from 'vitest';
import {
  publish,
  subscribe,
  clearSubscribersForTest,
  subscriberCountForTest,
} from './bus';
import { clearDedupCacheForTest } from './dedup';

describe('Notice Bus', () => {
  beforeEach(() => {
    clearSubscribersForTest();
    clearDedupCacheForTest();
  });

  describe('publish', () => {
    it('assigns an id with ntc_ prefix and returns it', () => {
      const id = publish({
        type: 'task_complete',
        source: 'agent',
        payload: { conversationId: 'c1' },
        dedupKey: 'task_complete:c1',
      });
      expect(id).not.toBeNull();
      expect(id).toMatch(/^ntc_/);
    });

    it('dedupes same dedupKey within window, returns null', () => {
      const first = publish({
        type: 'skill_proposal_offer',
        source: 'self_evolving',
        payload: {},
        dedupKey: 'intent:abc',
      });
      const second = publish({
        type: 'skill_proposal_offer',
        source: 'self_evolving',
        payload: {},
        dedupKey: 'intent:abc',
      });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('does not dedupe different keys', () => {
      const id1 = publish({
        type: 'skill_proposal_offer',
        source: 'self_evolving',
        payload: {},
        dedupKey: 'intent:abc',
      });
      const id2 = publish({
        type: 'skill_proposal_offer',
        source: 'self_evolving',
        payload: {},
        dedupKey: 'intent:xyz',
      });
      expect(id1).not.toBe(id2);
    });

    it('defaults tier from DEFAULT_TIER table', () => {
      let received: { tier?: string } | null = null;
      subscribe('chat_card', (n) => {
        received = n;
      });
      publish({
        type: 'meeting_prep',
        source: 'behavior',
        payload: {},
        dedupKey: 'meet:123',
      });
      expect(received).not.toBeNull();
      expect(received!.tier).toBe('L1');
    });

    it('allows tier override via PublishInput.tier', () => {
      let received: { tier?: string } | null = null;
      subscribe('chat_card', (n) => {
        received = n;
      });
      publish({
        type: 'im_inbound',
        source: 'im',
        payload: {},
        dedupKey: 'msg:1',
        tier: 'L3',
      });
      expect(received).not.toBeNull();
      expect(received!.tier).toBe('L3');
    });

    it('rejects invalid input via zod (empty dedupKey)', () => {
      expect(() =>
        publish({
          type: 'task_complete',
          source: 'agent',
          payload: {},
          dedupKey: '',
        }),
      ).toThrow();
    });
  });

  describe('subscribe', () => {
    it('delivers published notices to subscribers', () => {
      const received: string[] = [];
      subscribe('chat_card', (n) => {
        received.push(n.id);
      });
      const id = publish({
        type: 'task_complete',
        source: 'agent',
        payload: {},
        dedupKey: 'k1',
      });
      expect(received).toEqual([id]);
    });

    it('returns an unsubscribe function', () => {
      const received: string[] = [];
      const unsub = subscribe('chat_card', (n) => {
        received.push(n.id);
      });
      unsub();
      publish({
        type: 'task_complete',
        source: 'agent',
        payload: {},
        dedupKey: 'k2',
      });
      expect(received).toEqual([]);
      expect(subscriberCountForTest()).toBe(0);
    });

    it('fans out to multiple channels (blanket dispatch until Router lands)', () => {
      const a: string[] = [];
      const b: string[] = [];
      subscribe('chat_card', (n) => {
        a.push(n.id);
      });
      subscribe('pet_bubble', (n) => {
        b.push(n.id);
      });
      const id = publish({
        type: 'task_complete',
        source: 'agent',
        payload: {},
        dedupKey: 'k3',
      });
      expect(a).toEqual([id]);
      expect(b).toEqual([id]);
    });

    it('isolates thrown handler errors from sibling handlers', () => {
      const received: string[] = [];
      subscribe('chat_card', () => {
        throw new Error('boom');
      });
      subscribe('pet_bubble', (n) => {
        received.push(n.id);
      });
      const id = publish({
        type: 'task_complete',
        source: 'agent',
        payload: {},
        dedupKey: 'k4',
      });
      expect(received).toEqual([id]);
    });
  });
});
