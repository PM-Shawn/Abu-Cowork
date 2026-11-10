import { describe, expect, it } from 'vitest';
import { stepBudgetNote, stepBudgetThreshold } from './stepBudget';

const shownOn = (maxTurns: number) => {
  const steps: number[] = [];
  for (let t = 1; t <= maxTurns; t++) if (stepBudgetNote(t, maxTurns)) steps.push(t);
  return steps;
};
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const LAST = '[This is your last step in this run. Reply now with what is done and where each file the user asked for is saved; nothing can be saved or fixed after this reply.]';
const left = (n: number) => `[Only ${n} steps are left in this run. Make sure every file the user asked for is saved now in a usable state, before any further polishing.]`;

describe('stepBudgetThreshold', () => {
  it('is 10% of the cap with a floor of 5', () => {
    expect(stepBudgetThreshold(200)).toBe(20);
    expect(stepBudgetThreshold(45)).toBe(5);
    expect(stepBudgetThreshold(30)).toBe(5);
    expect(stepBudgetThreshold(101)).toBe(11);
  });
});

describe('stepBudgetNote', () => {
  it('shows nothing on a run capped below twice the threshold', () => {
    expect(shownOn(1)).toEqual([]);
    expect(shownOn(2)).toEqual([]);
    expect(shownOn(9)).toEqual([]);
  });

  it('shows on every step from the threshold to the last', () => {
    expect(shownOn(200)).toEqual(range(181, 200));
    expect(shownOn(10)).toEqual(range(6, 10));
    expect(shownOn(101)).toEqual(range(91, 101));
  });

  it('is silent before the threshold', () => {
    expect(stepBudgetNote(1, 200)).toBeUndefined();
    expect(stepBudgetNote(180, 200)).toBeUndefined();
    expect(stepBudgetNote(5, 10)).toBeUndefined();
  });

  it('counts the steps left down by one each step, this one included', () => {
    expect(stepBudgetNote(181, 200)).toBe(left(20));
    expect(stepBudgetNote(182, 200)).toBe(left(19));
    expect(stepBudgetNote(199, 200)).toBe(left(2));
    expect(stepBudgetNote(6, 10)).toBe(left(5));
    expect(stepBudgetNote(9, 10)).toBe(left(2));
  });

  it('has its own wording on the last step', () => {
    expect(stepBudgetNote(200, 200)).toBe(LAST);
    expect(stepBudgetNote(10, 10)).toBe(LAST);
  });

  it('is the same text when the same step is requested again, and silent past the cap', () => {
    expect(stepBudgetNote(181, 200)).toBe(stepBudgetNote(181, 200));
    expect(stepBudgetNote(201, 200)).toBeUndefined();
    expect(stepBudgetNote(0, 200)).toBeUndefined();
  });

  it('ignores an unlimited or invalid cap', () => {
    expect(stepBudgetNote(5, Infinity)).toBeUndefined();
    expect(stepBudgetNote(5, NaN)).toBeUndefined();
    expect(stepBudgetNote(5, -1)).toBeUndefined();
  });
});
