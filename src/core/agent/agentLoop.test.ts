import { describe, it, expect } from 'vitest';
import {
  escalateMaxOutputTokens,
  shouldContinueTruncatedToolCalls,
  isInteractiveDesktop,
  shouldComputeProposalSignal,
} from './agentLoop';

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

// Task #49 · Gate that protects memory extraction + post-loop proposal
// signal from firing in headless contexts. Regression-critical because
// the bug mode is silent: failing gates leak skill drafts and memories
// into user-invisible directories.
describe('isInteractiveDesktop', () => {
  it('desktop conversation (no imContext, no scheduledTaskId, no triggerId) → true', () => {
    expect(isInteractiveDesktop(undefined, {})).toBe(true);
    expect(isInteractiveDesktop({}, undefined)).toBe(true);
    expect(isInteractiveDesktop({}, {})).toBe(true);
  });

  it('IM headless conversation (imContext set) → false', () => {
    expect(
      isInteractiveDesktop(
        { imContext: { platform: 'dchat', workspacePath: '/ws' } },
        {},
      ),
    ).toBe(false);
  });

  it('scheduled-task conversation → false', () => {
    expect(isInteractiveDesktop({}, { scheduledTaskId: 'task-42' })).toBe(false);
  });

  it('trigger-run conversation → false', () => {
    expect(isInteractiveDesktop({}, { triggerId: 'trigger-7' })).toBe(false);
  });

  it('absent conversation record (shouldn’t happen, defensive) → falls through to options-only check', () => {
    // convRecord may be absent if the conversation was deleted mid-run.
    // The gate should not crash and should rely on options to decide.
    expect(isInteractiveDesktop(undefined, undefined)).toBe(true);
    expect(
      isInteractiveDesktop(
        { imContext: { platform: 'dchat', workspacePath: '/ws' } },
        undefined,
      ),
    ).toBe(false);
  });

  it('any single headless marker is enough to lock the gate', () => {
    // Pathological combo shouldn't accidentally re-open the gate — each
    // marker is an independent "headless" condition.
    expect(
      isInteractiveDesktop(
        { imContext: { channelId: 'c', platform: 'dchat', workspacePath: '/ws' } },
        { scheduledTaskId: 'x', triggerId: 'y' },
      ),
    ).toBe(false);
  });
});

// Task #51 · Stricter gate for post-loop proposal signal. Adds a
// workspace-bound check on top of isInteractiveDesktop — without a
// workspace, skill_manage can't write, AND the next turn's system
// prompt will already carry a workspace-hint telling the agent "don't
// call skill_manage, call request_workspace first". Stacking the
// proposal-signal on top gives contradictory instructions.
describe('shouldComputeProposalSignal (Task #51 gate)', () => {
  const desktopOpts = {};
  const desktopConv = {};

  it('fires on desktop + workspace bound (baseline)', () => {
    expect(shouldComputeProposalSignal(desktopOpts, desktopConv, '/workspace/myapp')).toBe(true);
  });

  it('blocks when no workspace is bound (the Task #51 fix)', () => {
    // Regression guard for the workspace-hint ↔ proposal-signal
    // conflict: without a workspace, the signal would stack on top
    // of the "call request_workspace first" prompt.
    expect(shouldComputeProposalSignal(desktopOpts, desktopConv, null)).toBe(false);
    expect(shouldComputeProposalSignal(desktopOpts, desktopConv, undefined)).toBe(false);
    expect(shouldComputeProposalSignal(desktopOpts, desktopConv, '')).toBe(false);
  });

  it('inherits isInteractiveDesktop blockers — IM context blocks even with workspace', () => {
    expect(
      shouldComputeProposalSignal(
        { imContext: { platform: 'dchat', workspacePath: '/ws' } },
        desktopConv,
        '/workspace/myapp',
      ),
    ).toBe(false);
  });

  it('inherits isInteractiveDesktop blockers — scheduled task + workspace still blocked', () => {
    expect(
      shouldComputeProposalSignal(
        desktopOpts,
        { scheduledTaskId: 'task-1' },
        '/workspace/myapp',
      ),
    ).toBe(false);
  });

  it('inherits isInteractiveDesktop blockers — trigger + workspace still blocked', () => {
    expect(
      shouldComputeProposalSignal(
        desktopOpts,
        { triggerId: 'trigger-1' },
        '/workspace/myapp',
      ),
    ).toBe(false);
  });
});
