import { describe, it, expect } from 'vitest';
import { GOAL_MAX_MAX_ROUNDS, sanitizeGoalState } from './goalTypes';

const valid = {
  id: 'g1',
  revision: 2,
  objective: 'do it',
  phase: 'active',
  maxRounds: 10,
  roundsStarted: 3,
  consecutiveIdleRounds: 1,
  elapsedMs: 4000,
  createdAt: 1,
  updatedAt: 2,
};

describe('goalTypes', () => {
  describe('sanitizeGoalState', () => {
    it('accepts a well-formed goal', () => {
      expect(sanitizeGoalState(valid)).toEqual(valid);
    });

    it('drops malformed entries instead of throwing', () => {
      expect(sanitizeGoalState(undefined)).toBeUndefined();
      expect(sanitizeGoalState('goal')).toBeUndefined();
      expect(sanitizeGoalState({ ...valid, id: '' })).toBeUndefined();
      expect(sanitizeGoalState({ ...valid, revision: 0 })).toBeUndefined();
      expect(sanitizeGoalState({ ...valid, phase: 'running' })).toBeUndefined();
      expect(sanitizeGoalState({ ...valid, objective: '  ' })).toBeUndefined();
      expect(sanitizeGoalState({ ...valid, roundsStarted: -1 })).toBeUndefined();
      expect(sanitizeGoalState({ ...valid, maxRounds: 0 })).toBeUndefined();
    });

    it('clamps an out-of-range budget and defaults a missing idle streak', () => {
      const goal = sanitizeGoalState({ ...valid, maxRounds: 1e9, consecutiveIdleRounds: 'x' });
      expect(goal?.maxRounds).toBe(GOAL_MAX_MAX_ROUNDS);
      expect(goal?.consecutiveIdleRounds).toBe(0);
    });

    it('defaults a missing or malformed working time to zero', () => {
      const { elapsedMs: _elapsedMs, ...withoutElapsed } = valid;
      expect(sanitizeGoalState(withoutElapsed)?.elapsedMs).toBe(0);
      expect(sanitizeGoalState({ ...valid, elapsedMs: -5 })?.elapsedMs).toBe(0);
      expect(sanitizeGoalState({ ...valid, elapsedMs: 'long' })?.elapsedMs).toBe(0);
    });

    it('keeps phase-specific fields only for their phase', () => {
      const blocked = sanitizeGoalState({ ...valid, phase: 'blocked', blockedReason: { code: 'round-limit', message: 'm' }, settledLoopId: 'L' });
      expect(blocked?.blockedReason).toEqual({ code: 'round-limit', message: 'm' });
      expect(blocked?.settledLoopId).toBe('L');
      const unknownCode = sanitizeGoalState({ ...valid, phase: 'blocked', blockedReason: { code: 'bogus', message: 'm' } });
      expect(unknownCode?.blockedReason?.code).toBe('model-reported');
      const activeWithStale = sanitizeGoalState({ ...valid, blockedReason: { code: 'round-limit', message: 'm' }, settledLoopId: 'L' });
      expect(activeWithStale?.blockedReason).toBeUndefined();
      expect(activeWithStale?.settledLoopId).toBeUndefined();
      const complete = sanitizeGoalState({ ...valid, phase: 'complete', completion: { summary: 's', evidence: ['a', 3] } });
      expect(complete?.completion).toEqual({ summary: 's', evidence: ['a'] });
    });
  });
});
