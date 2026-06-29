import { describe, it, expect } from 'vitest';
import { allToolsUnparseable, resolveMaxTurns, DEFAULT_MAX_TURNS } from './loopGuards';

// Shared no-progress predicate. Mirrors the half of subagentLoop's isNoProgressTurn
// that detects "the model emitted only tool calls the loop can't act on" — extracted
// so the subagent guard and the agentLoop guard can't drift.
describe('allToolsUnparseable', () => {
  it('is false for an empty batch (no tool calls is not a no-progress signal)', () => {
    // A turn with zero tool calls is a pure-text turn — handled by the
    // truncation/recovery paths, not the no-progress guard.
    expect(allToolsUnparseable([])).toBe(false);
  });

  it('is true when every tool call carries _parse_error', () => {
    expect(allToolsUnparseable([
      { input: { _parse_error: 'bad json' } },
      { input: { _parse_error: 'bad json 2' } },
    ])).toBe(true);
  });

  it('is false when at least one tool call is well-formed', () => {
    expect(allToolsUnparseable([
      { input: { _parse_error: 'bad json' } },
      { input: { x: 1 } },
    ])).toBe(false);
  });

  it('is false when all tool calls are well-formed', () => {
    expect(allToolsUnparseable([{ input: { x: 1 } }])).toBe(false);
  });
});

// Turn-cap resolution. Industry baseline: an agent loop must never be unlimited by
// default (OpenAI Agents SDK ~10, LangChain ~15, LangGraph ~25, Claude Code's fork
// subagent 200). The old `?? globalMaxTurns` left the cap undefined (unlimited)
// whenever nothing was set — the outlier. resolveMaxTurns keeps explicit settings
// authoritative but falls back to a sane cap, with an explicit non-positive value
// as the opt-in escape hatch for true unlimited.
describe('resolveMaxTurns', () => {
  it('skill maxTurns wins over agent definition, global, and the fallback', () => {
    expect(resolveMaxTurns({ skillMaxTurns: 5, definitionMaxTurns: 10, globalMaxTurns: 20 })).toBe(5);
  });

  it('agent definition maxTurns wins over global and the fallback', () => {
    expect(resolveMaxTurns({ definitionMaxTurns: 10, globalMaxTurns: 20 })).toBe(10);
  });

  it('global setting wins over the fallback', () => {
    expect(resolveMaxTurns({ globalMaxTurns: 20 })).toBe(20);
  });

  it('falls back to the default cap when nothing is set (never unlimited)', () => {
    expect(resolveMaxTurns({})).toBe(DEFAULT_MAX_TURNS);
  });

  it('treats an explicit non-positive setting as opt-in unlimited (Infinity)', () => {
    // The escape hatch that preserves the capability the old `undefined`
    // default used to grant implicitly — now it must be chosen deliberately.
    expect(resolveMaxTurns({ globalMaxTurns: 0 })).toBe(Infinity);
    expect(resolveMaxTurns({ globalMaxTurns: -1 })).toBe(Infinity);
  });
});
