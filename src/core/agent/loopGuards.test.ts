import { describe, it, expect } from 'vitest';
import {
  allToolsUnparseable,
  resolveMaxTurns,
  DEFAULT_MAX_TURNS,
  escalateMaxOutputTokens,
  shouldContinueTruncatedToolCalls,
} from './loopGuards';

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

// Moved from agentLoop.test.ts (P1-3a-pre): escalateMaxOutputTokens /
// shouldContinueTruncatedToolCalls are pure and shared by agentLoop and
// subagentLoop; extracting them here (instead of leaving them in agentLoop.ts)
// lets subagentLoop reuse them without importing agentLoop's whole
// store-import graph. No assertion changed from the original agentLoop.test.ts
// — this is a pure relocation.
describe('escalateMaxOutputTokens', () => {
  it('does not escalate when recoveryCount is 0', () => {
    const result = escalateMaxOutputTokens(8192, 200000, 0);
    expect(result).toEqual({ maxOutputTokens: 8192, changed: false });
  });

  it('doubles maxOutputTokens on first recovery', () => {
    const result = escalateMaxOutputTokens(8192, 200000, 1);
    expect(result).toEqual({ maxOutputTokens: 16384, changed: true });
  });

  // Bug #5 regression: escalation must STAY escalated across recoveries, not fall
  // back to base after the first. Previously a one-shot `alreadyEscalated` latch
  // made the budget go base → 2x → base → base. Fix: a fixed 2x that persists for
  // every recovery (base → 2x → 2x → 2x) — capped, and aligned with the recovery
  // prompt that tells the model to break remaining work into smaller pieces (so the
  // budget needn't grow unboundedly and can't starve the input-context budget).
  it('stays escalated across later recoveries (regression: was base → 2x → base)', () => {
    expect(escalateMaxOutputTokens(8192, 200000, 2)).toEqual({ maxOutputTokens: 16384, changed: true });
    expect(escalateMaxOutputTokens(8192, 200000, 3)).toEqual({ maxOutputTokens: 16384, changed: true });
  });

  it('caps at contextWindowSize - 1000', () => {
    // contextWindow is 10000, so cap = 9000, doubling 8192 would be 16384 > 9000
    const result = escalateMaxOutputTokens(8192, 10000, 1);
    expect(result).toEqual({ maxOutputTokens: 9000, changed: true });
  });

  it('does not escalate when already at context limit', () => {
    // currentMax=9000, contextWindow=10000, cap=9000 — doubling gives 9000, not > 9000
    const result = escalateMaxOutputTokens(9000, 10000, 1);
    expect(result).toEqual({ maxOutputTokens: 9000, changed: false });
  });

  it('works with large context windows', () => {
    const result = escalateMaxOutputTokens(32768, 1000000, 2);
    expect(result).toEqual({ maxOutputTokens: 65536, changed: true });
  });
});

// Bug #4: a turn cut off by max_tokens AFTER emitting complete tool calls. The
// adapter only emits a tool_use event on content_block_stop, so a call truncated
// mid-JSON is dropped — collected calls are complete. The loop must send their
// results back (continue) instead of discarding them / ending the turn — UNLESS
// every collected call is malformed (_parse_error), which is not real progress:
// continuing on an all-malformed batch would spin a broken model forever in
// agentLoop (no no-progress guard, default unlimited maxTurns).
describe('shouldContinueTruncatedToolCalls', () => {
  const wellFormed = (n: number) => Array.from({ length: n }, () => ({ input: { x: 1 } }));

  it('continues when max_tokens truncated after a well-formed tool call', () => {
    expect(shouldContinueTruncatedToolCalls('max_tokens', wellFormed(2))).toBe(true);
  });

  it('does not continue with no tool calls (pure text truncation → resume path)', () => {
    expect(shouldContinueTruncatedToolCalls('max_tokens', [])).toBe(false);
  });

  it('does not continue when ALL tool calls are malformed (avoids spinning a broken model)', () => {
    expect(shouldContinueTruncatedToolCalls('max_tokens', [{ input: { _parse_error: 'bad json' } }])).toBe(false);
  });

  it('continues if at least one tool call is well-formed among malformed ones', () => {
    expect(shouldContinueTruncatedToolCalls('max_tokens', [
      { input: { _parse_error: 'bad json' } },
      { input: { x: 1 } },
    ])).toBe(true);
  });

  it('does not apply on a clean tool_use stop (normal continuation path)', () => {
    expect(shouldContinueTruncatedToolCalls('tool_use', wellFormed(2))).toBe(false);
  });

  it('does not apply on end_turn', () => {
    expect(shouldContinueTruncatedToolCalls('end_turn', [])).toBe(false);
  });
});
