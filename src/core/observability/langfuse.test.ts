/**
 * Tests for Langfuse observability module — specifically the subagent span.
 *
 * The test environment may or may not have VITE_LANGFUSE_* keys (developer
 * machines with .env.local have them, CI does not). Tests must hold in BOTH
 * states: they verify the API contracts — non-throwing, correct return shape —
 * not the enabled/disabled state itself.
 */
import { describe, it, expect } from 'vitest';
import { startSubagentSpan } from './langfuse';

describe('startSubagentSpan', () => {
  it('always returns a handle (never null/undefined), regardless of observability state', () => {
    const handle = startSubagentSpan(null, { agentName: 'test-agent', task: 'do something' });
    expect(handle).toBeDefined();
    expect(typeof handle.end).toBe('function');
  });

  it('.end() does not throw when called with no arguments (null parentId)', () => {
    const handle = startSubagentSpan(null, { agentName: 'test-agent', task: 'do something' });
    expect(() => handle.end()).not.toThrow();
  });

  it('.end() does not throw with a full payload (null parentId)', () => {
    const handle = startSubagentSpan(null, { agentName: 'test-agent', task: 'do something' });
    expect(() =>
      handle.end({
        output: 'result text',
        tokenUsage: { input: 1000, output: 500 },
        toolCallCount: 3,
        turnCount: 2,
        duration: 4.5,
      })
    ).not.toThrow();
  });

  it('.end() does not throw when parentConversationId is a non-existent trace id', () => {
    // A conversationId that has no entry in _traces — must fall back gracefully
    const handle = startSubagentSpan('missing-conversation-id', {
      agentName: 'test-agent',
      task: 'another task',
    });
    expect(() =>
      handle.end({
        output: 'some output',
        tokenUsage: { input: 200, output: 100 },
        toolCallCount: 1,
        turnCount: 1,
        duration: 1.2,
        error: 'something went wrong',
      })
    ).not.toThrow();
  });

  it('.end() does not throw when called multiple times on the same handle', () => {
    const handle = startSubagentSpan(null, { agentName: 'multi-end', task: 'task' });
    expect(() => handle.end()).not.toThrow();
    expect(() => handle.end({ output: 'second call' })).not.toThrow();
  });

  it('.end() does not throw with error field set', () => {
    const handle = startSubagentSpan(null, { agentName: 'error-agent', task: 'fail task' });
    expect(() =>
      handle.end({
        output: 'Error: network timeout',
        error: 'network timeout',
        duration: 0.5,
      })
    ).not.toThrow();
  });
});
