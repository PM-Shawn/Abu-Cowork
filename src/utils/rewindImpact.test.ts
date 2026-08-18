import { describe, it, expect } from 'vitest';
import { computeRewindImpact } from './rewindImpact';
import type { Message } from '@/types';

function msg(id: string, role: Message['role'], loopId?: string): Message {
  return { id, role, content: '', timestamp: 0, ...(loopId ? { loopId } : {}) };
}

describe('computeRewindImpact', () => {
  it('reports no later turns when the redone loop is the conversation tail', () => {
    const messages = [
      msg('u1', 'user', 'loop-1'),
      msg('a1', 'assistant', 'loop-1'),
    ];
    const impact = computeRewindImpact(messages, 'loop-1', 'u1');
    expect(impact).toEqual({ hasLaterTurns: false, laterTurnsCount: 0 });
  });

  it('detects later turns when redoing a middle loop, counting distinct trailing loopIds', () => {
    const messages = [
      msg('u1', 'user', 'loop-1'),
      msg('a1', 'assistant', 'loop-1'),
      msg('u2', 'user', 'loop-2'),
      msg('a2', 'assistant', 'loop-2'),
      msg('u3', 'user', 'loop-3'),
      msg('a3', 'assistant', 'loop-3'),
    ];
    const impact = computeRewindImpact(messages, 'loop-1', 'u1');
    expect(impact.hasLaterTurns).toBe(true);
    expect(impact.laterTurnsCount).toBe(2); // loop-2, loop-3
  });

  it('counts multi-message loops (e.g. multi-turn tool use) as a single later turn', () => {
    const messages = [
      msg('u1', 'user', 'loop-1'),
      msg('a1', 'assistant', 'loop-1'),
      msg('u2', 'user', 'loop-2'),
      msg('a2a', 'assistant', 'loop-2'),
      msg('a2b', 'assistant', 'loop-2'),
      msg('a2c', 'assistant', 'loop-2'),
    ];
    const impact = computeRewindImpact(messages, 'loop-1', 'u1');
    expect(impact).toEqual({ hasLaterTurns: true, laterTurnsCount: 1 });
  });

  it('falls back to fallbackMessageId when loopId is absent (legacy transcripts)', () => {
    const messages = [
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('u2', 'user'),
      msg('a2', 'assistant'),
    ];
    const impact = computeRewindImpact(messages, undefined, 'u1');
    expect(impact.hasLaterTurns).toBe(true);
    // No loopId anywhere — each trailing message counts as its own anonymous turn.
    expect(impact.laterTurnsCount).toBe(3);
  });

  it('falls back to fallbackMessageId when the loop is not found in messages', () => {
    const messages = [
      msg('u1', 'user', 'loop-1'),
      msg('a1', 'assistant', 'loop-1'),
    ];
    // loopId does not match anything in messages — falls back to the id.
    const impact = computeRewindImpact(messages, 'missing-loop', 'a1');
    expect(impact).toEqual({ hasLaterTurns: false, laterTurnsCount: 0 });
  });

  it('returns no later turns when the anchor id is not found at all', () => {
    const messages = [msg('u1', 'user', 'loop-1')];
    const impact = computeRewindImpact(messages, undefined, 'does-not-exist');
    expect(impact).toEqual({ hasLaterTurns: false, laterTurnsCount: 0 });
  });
});
