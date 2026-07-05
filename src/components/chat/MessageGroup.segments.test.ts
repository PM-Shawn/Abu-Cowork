/**
 * Unit tests for buildRenderSegments — the pure segment-building function
 * that interleaves text, tool-step, and mid-loop user-bubble segments.
 */
import { describe, it, expect } from 'vitest';
import { buildRenderSegments } from './MessageGroup';
import type { Message } from '@/types';
import type { ExecutionStep } from '@/types/execution';

function makeAssistant(id: string, text: string, toolCount = 0): Message {
  return {
    id,
    role: 'assistant',
    content: text,
    timestamp: 0,
    loopId: 'loop-1',
    toolCalls: Array.from({ length: toolCount }, (_, i) => ({
      id: `tc-${id}-${i}`,
      name: 'read_file',
      input: {},
      result: 'ok',
    })),
  };
}

function makeUser(id: string, text: string): Message {
  return { id, role: 'user', content: text, timestamp: 0, loopId: 'loop-1' };
}

function makeExecStep(id: string): ExecutionStep {
  return {
    id,
    executionId: 'exec-1',
    type: 'tool',
    label: id,
    status: 'completed',
    toolName: 'read_file',
    toolInput: {},
    source: 'agent',
    detailBlocks: [],
  };
}

function makeThinkingAssistant(
  id: string,
  opts: { thinking?: string; thinkingDuration?: number; text?: string; toolCount?: number; plan?: string[] },
): Message {
  const toolCalls: Message['toolCalls'] = Array.from({ length: opts.toolCount ?? 0 }, (_, i) => ({
    id: `tc-${id}-${i}`,
    name: 'read_file',
    input: {},
    result: 'ok',
  }));
  if (opts.plan) {
    // report_plan is hidden:true and carries steps in input.steps
    toolCalls.push({ id: `plan-${id}`, name: 'report_plan', input: { steps: opts.plan }, hidden: true, result: 'ok' });
  }
  return {
    id,
    role: 'assistant',
    content: opts.text ?? '',
    timestamp: 0,
    loopId: 'loop-1',
    thinking: opts.thinking,
    thinkingDuration: opts.thinkingDuration,
    toolCalls,
  };
}

describe('buildRenderSegments', () => {
  it('leading user message is NOT in segments (rendered by top bubble)', () => {
    const msgs: Message[] = [
      makeUser('u1', 'user start'),
      makeAssistant('a1', 'hello'),
    ];
    const segs = buildRenderSegments(msgs, [], []);
    expect(segs.some((s) => s.kind === 'user')).toBe(false);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('text');
  });

  it('mid-loop user message appears as a user segment between assistant segments', () => {
    const msgs: Message[] = [
      makeUser('u1', 'start'),
      makeAssistant('a1', 'text after tools', 0),
      makeUser('u2', 'queued mid-loop'),
      makeAssistant('a2', 'response'),
    ];
    const segs = buildRenderSegments(msgs, [], []);

    // Expect: text(a1), user(u2), text(a2)
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ kind: 'text', message: expect.objectContaining({ id: 'a1' }) });
    expect(segs[1]).toMatchObject({ kind: 'user', message: expect.objectContaining({ id: 'u2' }) });
    expect(segs[2]).toMatchObject({ kind: 'text', message: expect.objectContaining({ id: 'a2' }) });
  });

  it('step slicing remains aligned with assistant messages when mid-user segments are present', () => {
    // a1 has 1 visible tool call, a2 has 1 visible tool call
    const msgs: Message[] = [
      makeUser('u1', 'start'),
      makeAssistant('a1', '', 1),   // tool-only turn
      makeUser('u2', 'queued'),
      makeAssistant('a2', 'done', 1), // tool + text turn
    ];
    const execStep1 = makeExecStep('step-1');
    const execStep2 = makeExecStep('step-2');
    const segs = buildRenderSegments(msgs, [execStep1, execStep2], []);

    // Expected: steps(a1 → step1), user(u2), text(a2) + steps(a2 → step2 pending flush)
    // The important thing: step1 belongs to a1, step2 belongs to a2 — not mixed up.
    const stepsSegs = segs.filter((s) => s.kind === 'steps');
    expect(stepsSegs).toHaveLength(2);
    const firstSteps = stepsSegs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>;
    const secondSteps = stepsSegs[1] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>;
    expect(firstSteps.executionSteps).toHaveLength(1);
    expect(firstSteps.executionSteps[0].id).toBe('step-1');
    expect(secondSteps.executionSteps).toHaveLength(1);
    expect(secondSteps.executionSteps[0].id).toBe('step-2');
  });

  it('thinking renders as its own steps segment, NOT hoisted above the plan', () => {
    // Real shape of conversation mr7k14k0cjzqof, message 2:
    // thinking(5s) then report_plan. Order must be: thinking, then plan.
    const msgs: Message[] = [
      makeUser('u1', 'delete logs'),
      makeThinkingAssistant('a1', { thinking: 'let me plan', thinkingDuration: 5, plan: ['scan', 'list', 'delete', 'verify'] }),
    ];
    const segs = buildRenderSegments(msgs, [], []);

    // Expect exactly: steps(thinking) then plan
    expect(segs.map((s) => s.kind)).toEqual(['steps', 'plan']);
    const thinkingSeg = segs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>;
    expect(thinkingSeg.executionSteps).toHaveLength(1);
    expect(thinkingSeg.executionSteps[0].type).toBe('thinking');
    expect(thinkingSeg.executionSteps[0].duration).toBe(5);
  });

  it('multiple thinking blocks stay inline at each message position, interleaved with tools', () => {
    // thinking5+plan → thinking2+find_files → thinking3+text+list_dir
    const msgs: Message[] = [
      makeUser('u1', 'go'),
      makeThinkingAssistant('a1', { thinking: 't5', thinkingDuration: 5, plan: ['a', 'b'] }),
      makeThinkingAssistant('a2', { thinking: 't2', thinkingDuration: 2, toolCount: 1 }),
      makeThinkingAssistant('a3', { thinking: 't3', thinkingDuration: 3, text: 'no logs found', toolCount: 1 }),
    ];
    const execSteps = [makeExecStep('find'), makeExecStep('listdir')];
    const segs = buildRenderSegments(msgs, execSteps, []);

    // thinking(a1), plan, thinking(a2), steps(find), thinking(a3), text(a3), steps(listdir)
    expect(segs.map((s) => s.kind)).toEqual(['steps', 'plan', 'steps', 'steps', 'steps', 'text', 'steps']);
    // Each thinking block is standalone (single thinking step, no tool steps mixed in)
    const stepSegs = segs.filter((s) => s.kind === 'steps') as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>[];
    // [thinking-a1, thinking-a2, find, thinking-a3, listdir]
    expect(stepSegs[0].executionSteps[0].type).toBe('thinking');
    expect(stepSegs[2].executionSteps[0].id).toBe('find');
    expect(stepSegs[2].executionSteps.every((s) => s.type !== 'thinking')).toBe(true);
    expect(stepSegs[4].executionSteps[0].id).toBe('listdir');
  });

  it('a thinking-typed step in allExecSteps is discarded (thinking comes from messages)', () => {
    const msgs: Message[] = [makeUser('u1', 'x'), makeThinkingAssistant('a1', { thinking: 'from msg', thinkingDuration: 1, toolCount: 1 })];
    const thinkingExec: ExecutionStep = { ...makeExecStep('ghost'), type: 'thinking' };
    const toolExec = makeExecStep('real-tool');
    const segs = buildRenderSegments(msgs, [thinkingExec, toolExec], []);
    const stepSegs = segs.filter((s) => s.kind === 'steps') as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>[];
    // thinking block (from msg) + tool block (real-tool); ghost thinking-exec dropped
    const toolSeg = stepSegs.find((s) => s.executionSteps[0]?.type !== 'thinking')!;
    expect(toolSeg.executionSteps.map((s) => s.id)).toEqual(['real-tool']);
  });
});
