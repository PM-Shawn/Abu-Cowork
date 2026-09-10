import { describe, it, expect } from 'vitest';
import type { Message } from '../../types';
import {
  AGENT_MAX_TURNS_OPTIONS,
  buildAgentMaxTurnsOptions,
  createMaxTurnsNoticeMessage,
  deriveMaxTurnsStreak,
  isMaxTurnsNoticeMessage,
  MAX_TURNS_NOTICE_ID_PREFIX,
} from './maxTurnsNotice';

function notice(options: {
  id?: string;
  streak?: number;
  continued?: boolean;
  limit?: number;
}): Message {
  const message = createMaxTurnsNoticeMessage({
    id: options.id ?? 'n1',
    timestamp: 1_000,
    limit: options.limit ?? 200,
    streak: options.streak ?? 1,
  });
  if (options.continued) message.maxTurnsNotice!.action = 'continued';
  return message;
}

function user(text: string, extra: Partial<Message> = {}): Message {
  return { id: `u-${text}`, role: 'user', content: text, timestamp: 2_000, ...extra };
}

function assistant(text: string): Message {
  return { id: `a-${text}`, role: 'assistant', content: text, timestamp: 3_000 };
}

describe('maxTurnsNotice', () => {
  describe('createMaxTurnsNoticeMessage', () => {
    it('carries the prefix, the payload and no loopId', () => {
      const message = createMaxTurnsNoticeMessage({
        id: 'abc',
        timestamp: 42,
        limit: 200,
        streak: 1,
      });

      expect(message.id).toBe(`${MAX_TURNS_NOTICE_ID_PREFIX}abc`);
      expect(message.timestamp).toBe(42);
      expect(message.maxTurnsNotice).toEqual({ limit: 200, streak: 1 });
      expect(message.loopId).toBeUndefined();
    });

    it('is role "system" but NOT isSystem — visible in chat, absent from context', () => {
      const message = createMaxTurnsNoticeMessage({
        id: 'abc', timestamp: 42, limit: 200, streak: 1,
      });

      expect(message.role).toBe('system');
      expect(message.isSystem).toBeUndefined();
    });
  });

  describe('isMaxTurnsNoticeMessage', () => {
    it('requires both the prefix and the payload', () => {
      expect(isMaxTurnsNoticeMessage(notice({}))).toBe(true);
      expect(isMaxTurnsNoticeMessage(user('hello'))).toBe(false);
    });

    it('rejects a prefixed message whose payload is missing', () => {
      const empty: Message = {
        id: `${MAX_TURNS_NOTICE_ID_PREFIX}x`,
        role: 'system',
        content: '',
        timestamp: 1,
      };

      expect(isMaxTurnsNoticeMessage(empty)).toBe(false);
    });
  });

  describe('deriveMaxTurnsStreak', () => {
    it('is 1 when the conversation has never hit the cap', () => {
      expect(deriveMaxTurnsStreak([user('go'), assistant('done')])).toBe(1);
    });

    it('is 1 when the previous notice was never continued', () => {
      expect(deriveMaxTurnsStreak([
        user('go'),
        notice({ streak: 1 }),
        user('try again'),
      ])).toBe(1);
    });

    it('increments when the continuation itself hits the cap', () => {
      expect(deriveMaxTurnsStreak([
        user('go'),
        notice({ streak: 1, continued: true }),
        user('继续完成上面还没做完的任务。'),
        assistant('working'),
      ])).toBe(2);
    });

    it('keeps incrementing along the chain', () => {
      expect(deriveMaxTurnsStreak([
        notice({ id: 'n1', streak: 1, continued: true }),
        user('continue'),
        notice({ id: 'n2', streak: 2, continued: true }),
        user('continue'),
      ])).toBe(3);
    });

    it('resets when the user drove in between — a later unrelated run', () => {
      // The continued run finished, then the user asked for something else.
      // Two user messages since the marker ⇒ this is not the same chain.
      expect(deriveMaxTurnsStreak([
        notice({ streak: 1, continued: true }),
        user('continue'),
        assistant('finished that'),
        user('now do something else'),
      ])).toBe(1);
    });

    it('ignores system-injected user messages when reading the chain', () => {
      expect(deriveMaxTurnsStreak([
        notice({ streak: 1, continued: true }),
        user('continue'),
        user('max-tokens recovery', { isSystem: true }),
      ])).toBe(2);
    });

    it('reads the most recent notice, not the first', () => {
      expect(deriveMaxTurnsStreak([
        notice({ id: 'old', streak: 4, continued: true }),
        user('a'),
        assistant('b'),
        user('c'),
        notice({ id: 'new', streak: 1, continued: true }),
        user('continue'),
      ])).toBe(2);
    });
  });

  describe('buildAgentMaxTurnsOptions', () => {
    it('offers the presets when nothing is stored', () => {
      expect(buildAgentMaxTurnsOptions(undefined)).toEqual([...AGENT_MAX_TURNS_OPTIONS]);
    });

    it('offers exactly the presets when the stored value is one of them', () => {
      expect(buildAgentMaxTurnsOptions(200)).toEqual([...AGENT_MAX_TURNS_OPTIONS]);
    });

    it('never offers 0 or an unbounded number as a NEW choice', () => {
      const offered = buildAgentMaxTurnsOptions(undefined);

      expect(offered).not.toContain(0);
      expect(Math.max(...offered)).toBe(1000);
    });

    it('keeps an out-of-band stored value visible, in order', () => {
      // Only reachable by hand-editing config — but the menu must show the cap
      // that is really in force rather than rounding it away.
      expect(buildAgentMaxTurnsOptions(777)).toEqual([50, 100, 200, 500, 777, 1000]);
    });

    it('surfaces an already-in-force "no cap" instead of pretending it is 200', () => {
      expect(buildAgentMaxTurnsOptions(0)).toEqual([50, 100, 200, 500, 1000, 0]);
      expect(buildAgentMaxTurnsOptions(-5)).toEqual([50, 100, 200, 500, 1000, 0]);
    });
  });
});
