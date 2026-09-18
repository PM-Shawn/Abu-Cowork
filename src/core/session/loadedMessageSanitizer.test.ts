import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  FIXTURE_TEXT,
  expectedForText,
  loadLoadedMessageSanitizerFixtures,
} from '@/test/loadedMessageSanitizerFixtures';
import {
  ACTIVE_RUN_STATES,
  collectAnsweredLoopIds,
  recoverInterruptedUserRun,
  sanitizeLoadedLedgerMessages,
  sanitizeRunErrorKind,
} from './loadedMessageSanitizer';

const { cases } = loadLoadedMessageSanitizerFixtures();

/** What a JSON wire or a ledger line would keep of a value: no `undefined` members. */
function asJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('sanitizeLoadedLedgerMessages', () => {
  it('the fixture file covers every rule', () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
    expect(cases.some((c) => c.currentRunMessageId !== undefined)).toBe(true);
  });

  for (const testCase of cases) {
    it(`fixture: ${testCase.name}`, () => {
      const out = sanitizeLoadedLedgerMessages(testCase.input as Message[], {
        text: FIXTURE_TEXT,
        currentRunMessageId: testCase.currentRunMessageId,
      });
      expect(asJson(out)).toEqual(expectedForText(testCase.expected, FIXTURE_TEXT));
    });
  }

  it('leaves its input untouched', () => {
    for (const testCase of cases) {
      const before = JSON.stringify(testCase.input);
      sanitizeLoadedLedgerMessages(testCase.input as Message[], { text: FIXTURE_TEXT });
      expect(JSON.stringify(testCase.input)).toBe(before);
    }
  });

  it('without currentRunMessageId the newest pending row is recovered like any other', () => {
    const current = cases.find((c) => c.currentRunMessageId !== undefined)!;
    const out = sanitizeLoadedLedgerMessages(current.input as Message[], { text: FIXTURE_TEXT });
    expect(out.map((m) => m.runState)).toEqual(['failed', 'failed']);
  });
});

describe('recoverInterruptedUserRun', () => {
  const pending = { id: 'm1', role: 'user', content: 'x', timestamp: 1, runState: 'pending' } as Message;

  it('names every active state', () => {
    expect([...ACTIVE_RUN_STATES].sort()).toEqual(['accepted', 'pending', 'recovering', 'running']);
  });

  it('returns the current run row as the same object', () => {
    expect(recoverInterruptedUserRun(pending, { recoveredText: 'r', currentRunMessageId: 'm1' })).toBe(pending);
  });

  it('drops a stored runErrorKind when it brands a row failed', () => {
    const out = recoverInterruptedUserRun(
      { ...pending, runErrorKind: 'payload_too_large' },
      { recoveredText: 'r' },
    );
    expect(out).toMatchObject({ runState: 'failed', runError: 'r' });
    expect('runErrorKind' in out).toBe(false);
  });
});

describe('helpers', () => {
  it('sanitizeRunErrorKind keeps the closed set only', () => {
    expect(sanitizeRunErrorKind('dispatch_failed')).toBe('dispatch_failed');
    expect(sanitizeRunErrorKind('payload_too_large')).toBe('payload_too_large');
    expect(sanitizeRunErrorKind('sidecar_unavailable')).toBe('sidecar_unavailable');
    expect(sanitizeRunErrorKind('history_unavailable')).toBeUndefined();
    expect(sanitizeRunErrorKind(7)).toBeUndefined();
  });

  it('collectAnsweredLoopIds needs usage on a substantive assistant row', () => {
    const rows = [
      { id: 'a', role: 'assistant', content: '半句', timestamp: 1, loopId: 'L-cut' },
      { id: 'b', role: 'assistant', content: '整句', timestamp: 2, loopId: 'L-done', usage: { inputTokens: 1, outputTokens: 1 } },
      { id: 'c', role: 'assistant', content: '', timestamp: 3, loopId: 'L-ghost', usage: { inputTokens: 1, outputTokens: 0 } },
    ] as Message[];
    expect([...collectAnsweredLoopIds(rows)]).toEqual(['L-done']);
  });
});
