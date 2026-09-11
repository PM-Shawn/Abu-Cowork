import { describe, expect, it } from 'vitest';
import { createRecoveryBudget, runBudgetKey } from './recoveryBudget';

describe('recoveryBudget', () => {
  describe('decide', () => {
    it('allows one re-observation per event, then hands off', () => {
      const budget = createRecoveryBudget();
      expect(budget.decide('run-a', 'not-executed', false)).toBe('observe-once');
      expect(budget.decide('run-a', 'not-executed', false)).toBe('handoff');
    });

    it('never auto-recovers an action whose outcome is unknown', () => {
      const budget = createRecoveryBudget();
      // The input may already have landed; re-observing and retrying could
      // submit twice. Unknown is handed to the user, not spent from the budget.
      expect(budget.decide('run-b', 'outcome-unknown', false)).toBe('handoff');
      expect(budget.decide('run-b', 'not-executed', false)).toBe('observe-once');
    });

    it('never auto-recovers an action that was actually dispatched', () => {
      const budget = createRecoveryBudget();
      expect(budget.decide('run-c', 'dispatched', false)).toBe('handoff');
    });

    it('stops rather than recovering once the turn is stopped', () => {
      const budget = createRecoveryBudget();
      expect(budget.decide('run-d', 'not-executed', true)).toBe('stop');
    });

    it('keeps a stopped turn stopped even for a fresh event', () => {
      const budget = createRecoveryBudget();
      expect(budget.decide('run-e', 'not-executed', false)).toBe('observe-once');
      expect(budget.decide('run-e', 'not-executed', true)).toBe('stop');
    });

    it('reads decisions without spending budget on handoff', () => {
      const budget = createRecoveryBudget();
      expect(budget.decide('run-f', 'not-executed', false)).toBe('observe-once');
      // Repeated reads must not silently unlock more recoveries.
      expect(budget.decide('run-f', 'not-executed', false)).toBe('handoff');
      expect(budget.decide('run-f', 'not-executed', false)).toBe('handoff');
      expect(budget.decide('run-f', 'not-executed', false)).toBe('handoff');
    });

    it('keeps runs independent', () => {
      const budget = createRecoveryBudget();
      expect(budget.decide('run-g', 'not-executed', false)).toBe('observe-once');
      expect(budget.decide('run-g', 'not-executed', false)).toBe('handoff');
      expect(budget.decide('run-h', 'not-executed', false)).toBe('observe-once');
    });
  });

  describe('recordVerifiedProgress', () => {
    it('frees the per-event budget so a later event can recover again', () => {
      const budget = createRecoveryBudget();
      expect(budget.decide('run-i', 'not-executed', false)).toBe('observe-once');
      expect(budget.decide('run-i', 'not-executed', false)).toBe('handoff');
      budget.recordVerifiedProgress('run-i');
      expect(budget.decide('run-i', 'not-executed', false)).toBe('observe-once');
    });

    it('does not refund the per-turn budget', () => {
      const budget = createRecoveryBudget();
      // Two turn recoveries is the whole allowance; verified progress between
      // them must not turn the turn budget into an unlimited one, or a task
      // that alternates progress and failure loops forever.
      expect(budget.decide('run-j', 'not-executed', false)).toBe('observe-once');
      budget.recordVerifiedProgress('run-j');
      expect(budget.decide('run-j', 'not-executed', false)).toBe('observe-once');
      budget.recordVerifiedProgress('run-j');
      expect(budget.decide('run-j', 'not-executed', false)).toBe('handoff');
    });

    it('is harmless for a run that never spent anything', () => {
      const budget = createRecoveryBudget();
      budget.recordVerifiedProgress('run-k');
      expect(budget.decide('run-k', 'not-executed', false)).toBe('observe-once');
    });
  });

  describe('clear', () => {
    it('releases a finished run so its key can be reused', () => {
      const budget = createRecoveryBudget();
      expect(budget.decide('run-l', 'not-executed', false)).toBe('observe-once');
      expect(budget.decide('run-l', 'not-executed', false)).toBe('handoff');
      budget.clear('run-l');
      expect(budget.decide('run-l', 'not-executed', false)).toBe('observe-once');
    });

    it('does not disturb other runs', () => {
      const budget = createRecoveryBudget();
      expect(budget.decide('run-m', 'not-executed', false)).toBe('observe-once');
      budget.clear('run-n');
      expect(budget.decide('run-m', 'not-executed', false)).toBe('handoff');
    });
  });

  describe('runBudgetKey', () => {
    it('encodes a run identity that cannot collide across conversations', () => {
      const a = runBudgetKey({ conversationId: 'a:b', loopId: 'c' });
      const b = runBudgetKey({ conversationId: 'a', loopId: 'b:c' });
      expect(a).not.toBe(b);
    });

    it('is stable for the same run', () => {
      const key = { conversationId: 'conv-1', loopId: 'loop-1' };
      expect(runBudgetKey(key)).toBe(runBudgetKey({ ...key }));
    });
  });
});
