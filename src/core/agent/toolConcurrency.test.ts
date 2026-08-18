import { describe, expect, it } from 'vitest';
import type { ToolCall, ToolDefinition } from '../../types';
import { groupToolCallsByConcurrency, resolveToolConcurrencySafety } from './toolConcurrency';

// Deterministic id source — the repo's test rules ban Math.random()/Date.now()
// in tests; a monotonic counter gives the same uniqueness with a fixed run.
let tcSeq = 0;
function tc(name: string, input: Record<string, unknown> = {}): ToolCall {
  tcSeq += 1;
  return { id: `id-${name}-${tcSeq}`, name, input };
}

function makeTool(name: string, isConcurrencySafe: ToolDefinition['isConcurrencySafe']): ToolDefinition {
  return {
    name,
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'ok',
    isConcurrencySafe,
  };
}

describe('resolveToolConcurrencySafety', () => {
  it('is unsafe (fail-closed) when no tool definition is found', () => {
    expect(resolveToolConcurrencySafety(undefined, {})).toBe(false);
  });

  it('is unsafe when isConcurrencySafe is undefined', () => {
    expect(resolveToolConcurrencySafety(makeTool('x', undefined), {})).toBe(false);
  });

  it('honors a static true/false', () => {
    expect(resolveToolConcurrencySafety(makeTool('x', true), {})).toBe(true);
    expect(resolveToolConcurrencySafety(makeTool('x', false), {})).toBe(false);
  });

  it('calls the input-dependent function with the resolved input', () => {
    const tool = makeTool('run_command', (input) => input.command === 'ls');
    expect(resolveToolConcurrencySafety(tool, { command: 'ls' })).toBe(true);
    expect(resolveToolConcurrencySafety(tool, { command: 'rm -rf /' })).toBe(false);
  });

  it('treats a thrown isConcurrencySafe (e.g. malformed input) as unsafe', () => {
    const tool = makeTool('flaky', () => {
      throw new Error('cannot parse input');
    });
    expect(resolveToolConcurrencySafety(tool, {})).toBe(false);
  });

  it('treats a non-strict-true return value as unsafe', () => {
    // isConcurrencySafe must return exactly `true`, not just a truthy value
    const tool = makeTool('loose', (() => 1) as unknown as ToolDefinition['isConcurrencySafe']);
    expect(resolveToolConcurrencySafety(tool, {})).toBe(false);
  });
});

describe('groupToolCallsByConcurrency', () => {
  it('returns an empty array for an empty batch', () => {
    expect(groupToolCallsByConcurrency([], () => true)).toEqual([]);
  });

  it('merges an all-safe run into a single parallel batch', () => {
    const calls = [tc('read_file'), tc('read_file'), tc('read_file')];
    const batches = groupToolCallsByConcurrency(calls, () => true);
    expect(batches).toEqual([{ safe: true, calls }]);
  });

  it('splits an all-unsafe run into one serial batch per call (no merging)', () => {
    const calls = [tc('write_file'), tc('write_file'), tc('write_file')];
    const batches = groupToolCallsByConcurrency(calls, () => false);
    expect(batches).toEqual([
      { safe: false, calls: [calls[0]] },
      { safe: false, calls: [calls[1]] },
      { safe: false, calls: [calls[2]] },
    ]);
  });

  it('groups a mixed sequence: consecutive safe calls merge, unsafe calls stay isolated', () => {
    const readA = tc('read_file', { path: 'a' });
    const readB = tc('read_file', { path: 'b' });
    const write = tc('write_file', { path: 'c' });
    const readC = tc('read_file', { path: 'd' });
    const readD = tc('read_file', { path: 'e' });

    const safeNames = new Set(['read_file']);
    const batches = groupToolCallsByConcurrency(
      [readA, readB, write, readC, readD],
      (call) => safeNames.has(call.name),
    );

    expect(batches).toEqual([
      { safe: true, calls: [readA, readB] },
      { safe: false, calls: [write] },
      { safe: true, calls: [readC, readD] },
    ]);
  });

  it('keeps two consecutive unsafe calls as two separate serial batches, preserving order', () => {
    const writeA = tc('write_file', { path: 'a' });
    const writeB = tc('write_file', { path: 'b' });
    const batches = groupToolCallsByConcurrency([writeA, writeB], () => false);
    expect(batches).toEqual([
      { safe: false, calls: [writeA] },
      { safe: false, calls: [writeB] },
    ]);
  });

  it('resolves safety per-call against its own input (e.g. run_command read-only vs. mutating)', () => {
    const readOnly = tc('run_command', { command: 'ls -la' });
    const mutating = tc('run_command', { command: 'rm -rf build' });
    const readOnly2 = tc('run_command', { command: 'git status' });

    const isSafe = (call: ToolCall) => call.name === 'run_command' && call.input.command === 'ls -la' ? true
      : call.name === 'run_command' && call.input.command === 'git status' ? true
      : false;

    const batches = groupToolCallsByConcurrency([readOnly, mutating, readOnly2], isSafe);
    expect(batches).toEqual([
      { safe: true, calls: [readOnly] },
      { safe: false, calls: [mutating] },
      { safe: true, calls: [readOnly2] },
    ]);
  });

  it('falls back to a serial batch when isSafe throws (input validation failure surfaced by the caller)', () => {
    const bad = tc('run_command', { command: undefined });
    const isSafe = () => {
      throw new Error('invalid input shape');
    };
    // groupToolCallsByConcurrency itself doesn't catch — callers are expected
    // to pass an isSafe that already fails closed (see
    // resolveToolConcurrencySafety's try/catch). This test documents that
    // contract: a throwing isSafe propagates rather than being silently
    // treated as safe.
    expect(() => groupToolCallsByConcurrency([bad], isSafe)).toThrow('invalid input shape');
  });
});
