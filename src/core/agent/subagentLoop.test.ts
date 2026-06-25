import { describe, it, expect, afterEach } from 'vitest';
import { isNoProgressTurn, buildSubagentStartEvent, buildSubagentEndEvent, isWallClockExceeded } from './subagentLoop';
import { registerHook, clearAllHooks, getHookCount } from './lifecycleHooks';
import type { SubagentStartEvent, SubagentEndEvent } from './lifecycleHooks';

describe('isWallClockExceeded', () => {
  it('returns false when elapsed is below threshold', () => {
    expect(isWallClockExceeded(299_999, 300_000)).toBe(false);
  });

  it('returns true when elapsed equals threshold (at boundary)', () => {
    expect(isWallClockExceeded(300_000, 300_000)).toBe(true);
  });

  it('returns true when elapsed exceeds threshold', () => {
    expect(isWallClockExceeded(300_001, 300_000)).toBe(true);
  });

  it('returns false at zero elapsed', () => {
    expect(isWallClockExceeded(0, 300_000)).toBe(false);
  });
});

describe('isNoProgressTurn', () => {
  it('flags a turn where every tool call is unparseable', () => {
    expect(isNoProgressTurn({
      toolCalls: [
        { input: { _parse_error: 'Failed to parse tool input: {"path":"' } },
        { input: { _parse_error: 'Failed to parse tool input: {"cmd":"' } },
      ],
      turnText: '',
      stopReason: 'tool_use',
    })).toBe(true);
  });

  it('does NOT flag when at least one tool call parsed (partial progress)', () => {
    // One good tool call means the turn can make progress — tolerate it.
    expect(isNoProgressTurn({
      toolCalls: [
        { input: { _parse_error: 'bad' } },
        { input: { path: '/tmp/ok.txt' } },
      ],
      turnText: '',
      stopReason: 'tool_use',
    })).toBe(false);
  });

  it('flags a max_tokens truncation that produced no text and no tool calls', () => {
    expect(isNoProgressTurn({
      toolCalls: [],
      turnText: '   ',
      stopReason: 'max_tokens',
    })).toBe(true);
  });

  it('does NOT flag max_tokens truncation that still produced some text', () => {
    // Partial text is usable output — append and stop, not a no-progress turn.
    expect(isNoProgressTurn({
      toolCalls: [],
      turnText: 'partial answer that got cut off',
      stopReason: 'max_tokens',
    })).toBe(false);
  });

  it('does NOT flag a normal end_turn with text', () => {
    expect(isNoProgressTurn({
      toolCalls: [],
      turnText: 'here is the answer',
      stopReason: 'end_turn',
    })).toBe(false);
  });

  it('does NOT flag a normal tool_use turn with valid args', () => {
    expect(isNoProgressTurn({
      toolCalls: [{ input: { path: '/tmp/a.txt' } }],
      turnText: '',
      stopReason: 'tool_use',
    })).toBe(false);
  });

  it('does NOT flag an empty turn that was not truncated (no tool calls, end_turn)', () => {
    // Only max_tokens truncation counts as no-progress for the empty case.
    expect(isNoProgressTurn({
      toolCalls: [],
      turnText: '',
      stopReason: 'end_turn',
    })).toBe(false);
  });
});

// ─── Lifecycle hook event shape tests ────────────────────────────────────────

describe('subagent lifecycle event builders', () => {
  afterEach(() => {
    clearAllHooks();
  });

  describe('buildSubagentStartEvent', () => {
    it('returns a subagentStart event with correct shape', () => {
      const before = Date.now();
      const event = buildSubagentStartEvent('my-agent', 'write a report');
      const after = Date.now();

      expect(event.type).toBe('subagentStart');
      expect(event.agentName).toBe('my-agent');
      expect(event.task).toBe('write a report');
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('buildSubagentEndEvent', () => {
    it('returns a subagentEnd event with correct shape (success)', () => {
      const event = buildSubagentEndEvent('my-agent', 'done', false);
      expect(event.type).toBe('subagentEnd');
      expect(event.agentName).toBe('my-agent');
      expect(event.result).toBe('done');
      expect(event.error).toBe(false);
    });

    it('returns a subagentEnd event with correct shape (error)', () => {
      const event = buildSubagentEndEvent('my-agent', 'Error: something failed', true);
      expect(event.type).toBe('subagentEnd');
      expect(event.error).toBe(true);
      expect(event.result).toBe('Error: something failed');
    });
  });

  describe('hook registration and invocation', () => {
    it('subagentStart hook is invoked when event is emitted via emitHook', async () => {
      // Import emitHook directly so we can drive it without the full loop
      const { emitHook } = await import('./lifecycleHooks');

      const received: SubagentStartEvent[] = [];
      registerHook<SubagentStartEvent>('subagentStart', (e) => { received.push(e); });
      expect(getHookCount('subagentStart')).toBe(1);

      const event = buildSubagentStartEvent('test-agent', 'test task');
      await emitHook(event);

      expect(received).toHaveLength(1);
      expect(received[0].agentName).toBe('test-agent');
      expect(received[0].task).toBe('test task');
    });

    it('subagentEnd hook is invoked when event is emitted via emitHook', async () => {
      const { emitHook } = await import('./lifecycleHooks');

      const received: SubagentEndEvent[] = [];
      registerHook<SubagentEndEvent>('subagentEnd', (e) => { received.push(e); });

      const event = buildSubagentEndEvent('test-agent', 'result text', false);
      await emitHook(event);

      expect(received).toHaveLength(1);
      expect(received[0].result).toBe('result text');
      expect(received[0].error).toBe(false);
    });

    it('clearAllHooks removes all registered hooks', () => {
      registerHook<SubagentStartEvent>('subagentStart', () => {});
      registerHook<SubagentEndEvent>('subagentEnd', () => {});
      expect(getHookCount()).toBe(2);
      clearAllHooks();
      expect(getHookCount()).toBe(0);
    });

    it('emitHook is behavior-preserving when no hooks are registered (synchronous fast path)', async () => {
      const { emitHook } = await import('./lifecycleHooks');
      // clearAllHooks already called in afterEach, verify count is 0
      expect(getHookCount('subagentStart')).toBe(0);

      const event = buildSubagentStartEvent('no-hooks', 'task');
      // When no hooks registered, emitHook returns synchronously (not a Promise)
      // but awaiting it is always safe
      const result = await emitHook(event);
      expect(result).toBe(event); // same reference returned
    });
  });
});
