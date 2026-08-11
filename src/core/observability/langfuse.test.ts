/**
 * Tests for the trace event port (client single-source model).
 *
 * OSS default has no sink registered — every helper must be a free no-op.
 * With a sink registered (enterprise builds), startGeneration must deliver a
 * complete GenerationEvent on end(); loop/tool/subagent helpers stay no-ops
 * (the lifecycle-hook bus is their single source).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  registerTraceSink,
  isObservabilityEnabled,
  startConversationTrace,
  endConversationTrace,
  startGeneration,
  startToolSpan,
  startSubagentSpan,
  type GenerationEvent,
} from './langfuse';

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('no sink registered (OSS default)', () => {
  it('all helpers no-op without throwing', () => {
    expect(isObservabilityEnabled()).toBe(false);
    expect(() => {
      startConversationTrace('c1', { name: 'abu', input: 'hi' });
      startGeneration('c1', { model: 'm', input: [] }).end({ output: 'x' });
      startToolSpan('c1', { name: 'Bash' }).end();
      startSubagentSpan('c1', { agentName: 'Explore', task: 't' }).end();
      startSubagentSpan(null, { agentName: 'Explore', task: 't' }).end({
        output: 'r', tokenUsage: { input: 1, output: 2 }, toolCallCount: 3, turnCount: 2, duration: 4.5, error: 'e',
      });
      endConversationTrace('c1');
    }).not.toThrow();
  });
});

describe('with a registered sink', () => {
  it('startGeneration delivers a full GenerationEvent on end()', () => {
    const events: GenerationEvent[] = [];
    unregister = registerTraceSink({ onGeneration: e => events.push(e) });
    expect(isObservabilityEnabled()).toBe(true);

    const gen = startGeneration('conv-1', {
      name: 'turn-2',
      model: 'glm-5',
      input: [{ role: 'user', content: 'hi' }],
      startTime: new Date(1786000000000),
    });
    gen.end({
      output: { content: 'hello' },
      usage: { inputTokens: 10, outputTokens: 4 },
      costUsd: 0.002,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      conversationId: 'conv-1',
      name: 'turn-2',
      model: 'glm-5',
      input: [{ role: 'user', content: 'hi' }],
      output: { content: 'hello' },
      usage: { inputTokens: 10, outputTokens: 4 },
      costUsd: 0.002,
      startTime: 1786000000000,
    });
    expect(events[0].error).toBeUndefined();
    expect(events[0].endTime).toBeGreaterThanOrEqual(events[0].startTime);
  });

  it('maps ERROR level to the error field', () => {
    const events: GenerationEvent[] = [];
    unregister = registerTraceSink({ onGeneration: e => events.push(e) });
    startGeneration('c', { model: 'm', input: 'x' }).end({ level: 'ERROR', statusMessage: 'timeout' });
    expect(events[0].error).toBe('timeout');
  });

  it('a throwing sink never propagates to the call site', () => {
    unregister = registerTraceSink({ onGeneration: () => { throw new Error('sink boom'); } });
    expect(() => startGeneration('c', { model: 'm', input: 'x' }).end()).not.toThrow();
  });

  it('tool/subagent spans remain no-ops (hook bus is their source)', () => {
    const onGeneration = vi.fn();
    unregister = registerTraceSink({ onGeneration });
    startToolSpan('c', { name: 'Bash' }).end({ output: 'r' });
    startSubagentSpan('c', { agentName: 'a', task: 't' }).end({ output: 'r' });
    expect(onGeneration).not.toHaveBeenCalled();
  });

  it('unregister detaches the sink; a stale unregister does not detach a newer sink', () => {
    const first = registerTraceSink({ onGeneration: () => {} });
    const second = vi.fn();
    unregister = registerTraceSink({ onGeneration: second });
    first();  // stale — must not remove the second sink
    expect(isObservabilityEnabled()).toBe(true);
    startGeneration('c', { model: 'm', input: 'x' }).end();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
