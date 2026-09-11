/**
 * Unit tests for buildRenderSegments — the pure segment-building function
 * that interleaves text, tool-step, and mid-loop user-bubble segments.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRenderSegments,
  computeWorkProcessFold,
  hasPersistedStopState,
  streamingTurnHasRenderableContent,
  stripLegacyStopMarker,
} from './MessageGroup';
import type { Message } from '@/types';
import type { ExecutionStep } from '@/types/execution';
import type { WorkflowStep } from '@/utils/workflowExtractor';

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

function makeToolCall(id: string, name: string): NonNullable<Message['toolCalls']>[number] {
  if (name === 'run_agent_batch') {
    return { id, name, input: { tasks: [{ task: id }] }, isExecuting: true };
  }
  return { id, name, input: {}, result: 'ok' };
}

function makeLegacyStep(id: string, toolName?: string): WorkflowStep {
  const step: WorkflowStep = {
    id,
    type: toolName ? 'tool' : 'skill',
    label: id,
    status: 'completed',
    timestamp: 0,
    toolInput: {},
    toolResult: 'ok',
  };
  if (toolName) step.toolName = toolName;
  return step;
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

  it('consecutive thinking+tool turns MERGE into one block; only text/plan break it', () => {
    // thinking5+plan → thinking2+find_files → thinking3+text+list_dir
    const msgs: Message[] = [
      makeUser('u1', 'go'),
      makeThinkingAssistant('a1', { thinking: 't5', thinkingDuration: 5, plan: ['a', 'b'] }),
      makeThinkingAssistant('a2', { thinking: 't2', thinkingDuration: 2, toolCount: 1 }),
      makeThinkingAssistant('a3', { thinking: 't3', thinkingDuration: 3, text: 'no logs found', toolCount: 1 }),
    ];
    const execSteps = [makeExecStep('find'), makeExecStep('listdir')];
    const segs = buildRenderSegments(msgs, execSteps, []);

    // steps(t5) [plan flushes it], plan, steps(t2·find·t3) [merged], text, steps(listdir)
    expect(segs.map((s) => s.kind)).toEqual(['steps', 'plan', 'steps', 'text', 'steps']);
    const stepSegs = segs.filter((s) => s.kind === 'steps') as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>[];
    // Leading thinking is its own block (report_plan flushed it out)
    expect(stepSegs[0].executionSteps.map((s) => s.type)).toEqual(['thinking']);
    // Middle block MERGES thinking + tool + thinking in true order
    expect(stepSegs[1].executionSteps.map((s) => s.id)).toEqual(['thinking-a2', 'find', 'thinking-a3']);
    // Trailing tool block (after the intermediate text flush)
    expect(stepSegs[2].executionSteps.map((s) => s.id)).toEqual(['listdir']);
  });

  it('show_widget becomes a dedicated widget segment at its real position (text → widget)', () => {
    const msg: Message = {
      id: 'a1',
      role: 'assistant',
      content: 'here is your chart',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [{
        id: 'tc-widget-1',
        name: 'show_widget',
        input: { title: 'Chart', widget_code: '<div>x</div>', loading_messages: ['loading'] },
        hidden: true,
        result: 'Widget rendered: Chart',
      }],
    };
    const segs = buildRenderSegments([makeUser('u1', 'chart please'), msg], [], []);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'widget']);
    const widgetSeg = segs[1] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'widget' }>;
    expect(widgetSeg.toolCall.id).toBe('tc-widget-1');
  });

  it('multiple show_widget calls in one turn each get their own widget segment', () => {
    const msg: Message = {
      id: 'a1',
      role: 'assistant',
      content: 'two charts',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [
        { id: 'w1', name: 'show_widget', input: { widget_code: '<div>1</div>' }, hidden: true, result: 'ok' },
        { id: 'w2', name: 'show_widget', input: { widget_code: '<div>2</div>' }, hidden: true, result: 'ok' },
      ],
    };
    const segs = buildRenderSegments([makeUser('u1', 'go'), msg], [], []);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'widget', 'widget']);
  });

  it('show_widget steps are counted in slicing (step bookkeeping runs) but filtered from the timeline', () => {
    // show_widget is hidden for DISPLAY only — agentLoop creates an execution
    // step for it (so planned-step advance counts widget calls). Slicing must
    // consume that step slot, filter it from the visible timeline, and keep
    // later messages' steps correctly aligned.
    const a1: Message = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [
        { id: 'tc-read', name: 'read_file', input: {}, result: 'ok' },
        { id: 'tc-w', name: 'show_widget', input: { widget_code: '<div>x</div>' }, hidden: true, result: 'ok' },
      ],
    };
    const a2: Message = {
      id: 'a2',
      role: 'assistant',
      content: 'done',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [{ id: 'tc-list', name: 'list_directory', input: {}, result: 'ok' }],
    };
    const widgetStep: ExecutionStep = { ...makeExecStep('step-widget'), toolName: 'show_widget' };
    const listStep: ExecutionStep = { ...makeExecStep('step-list'), toolName: 'list_directory' };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), a1, a2],
      [makeExecStep('step-read'), widgetStep, listStep],
      [],
    );
    // a1 → steps(step-read) then widget segment;
    // a2 → text + steps(step-list) — alignment preserved across the widget slot.
    expect(segs.map((s) => s.kind)).toEqual(['steps', 'widget', 'text', 'steps']);
    const stepSegs = segs.filter((s) => s.kind === 'steps') as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>[];
    expect(stepSegs[0].executionSteps.map((s) => s.id)).toEqual(['step-read']);
    expect(stepSegs[1].executionSteps.map((s) => s.id)).toEqual(['step-list']);
  });

  it('renders batch segments at exact tool-call positions without duplicating generic steps', () => {
    const msg: Message = {
      id: 'a-batches',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [
        makeToolCall('tc-read', 'read_file'),
        makeToolCall('tc-batch-a', 'run_agent_batch'),
        makeToolCall('tc-write', 'write_file'),
        makeToolCall('tc-batch-b', 'run_agent_batch'),
      ],
    };
    const readStep = { ...makeExecStep('read-step'), toolCallId: 'tc-read' };
    const batchStepA = { ...makeExecStep('batch-a-step'), toolName: 'run_agent_batch', toolCallId: 'tc-batch-a' };
    const writeStep = { ...makeExecStep('write-step'), toolName: 'write_file', toolCallId: 'tc-write' };
    const batchStepB = { ...makeExecStep('batch-b-step'), toolName: 'run_agent_batch', toolCallId: 'tc-batch-b' };

    const segs = buildRenderSegments([makeUser('u1', 'go'), msg], [readStep, batchStepA, writeStep, batchStepB], []);

    expect(segs.map((seg) => seg.kind)).toEqual(['steps', 'batch', 'steps', 'batch']);
    expect((segs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).executionSteps.map((s) => s.id)).toEqual(['read-step']);
    expect((segs[1] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'batch' }>).toolCall.id).toBe('tc-batch-a');
    expect((segs[2] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).executionSteps.map((s) => s.id)).toEqual(['write-step']);
    expect((segs[3] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'batch' }>).toolCall.id).toBe('tc-batch-b');
    expect(JSON.stringify(segs)).not.toContain('batch-a-step');
    expect(JSON.stringify(segs)).not.toContain('batch-b-step');
  });

  it('claims execution steps by exact toolCallId across same-name batch positions', () => {
    const msg: Message = {
      id: 'a-same-name-batches',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [
        makeToolCall('tc-read', 'read_file'),
        makeToolCall('tc-batch-a', 'run_agent_batch'),
        makeToolCall('tc-write', 'write_file'),
        makeToolCall('tc-batch-b', 'run_agent_batch'),
      ],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), msg],
      [
        { ...makeExecStep('batch-b-step'), toolName: 'run_agent_batch', toolCallId: 'tc-batch-b' },
        { ...makeExecStep('write-step'), toolName: 'write_file', toolCallId: 'tc-write' },
        { ...makeExecStep('read-step'), toolCallId: 'tc-read' },
        { ...makeExecStep('batch-a-step'), toolName: 'run_agent_batch', toolCallId: 'tc-batch-a' },
      ],
      [],
    );

    expect(segs.map((seg) => seg.kind)).toEqual(['steps', 'batch', 'steps', 'batch']);
    expect((segs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).executionSteps.map((s) => s.id)).toEqual(['read-step']);
    expect((segs[1] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'batch' }>).toolCall.id).toBe('tc-batch-a');
    expect((segs[2] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).executionSteps.map((s) => s.id)).toEqual(['write-step']);
    expect((segs[3] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'batch' }>).toolCall.id).toBe('tc-batch-b');
  });

  it('uses original positions for old snapshots with same-name batches missing toolCallId', () => {
    const msg: Message = {
      id: 'a-old-batches',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [
        makeToolCall('tc-batch-a', 'run_agent_batch'),
        makeToolCall('tc-batch-b', 'run_agent_batch'),
      ],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), msg],
      [
        { ...makeExecStep('old-batch-a-step'), toolName: 'run_agent_batch' },
        { ...makeExecStep('old-batch-b-step'), toolName: 'run_agent_batch' },
      ],
      [],
    );

    expect(segs.map((seg) => seg.kind)).toEqual(['batch', 'batch']);
    expect((segs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'batch' }>).toolCall.id).toBe('tc-batch-a');
    expect((segs[1] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'batch' }>).toolCall.id).toBe('tc-batch-b');
  });

  it('keeps raw offsets aligned across first-message batch and second-message generic/batch', () => {
    const batchTurn: Message = {
      id: 'a-batch-first',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-batch-first', 'run_agent_batch')],
    };
    const mixedTurn: Message = {
      id: 'a-mixed-second',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [
        makeToolCall('tc-read-second', 'read_file'),
        makeToolCall('tc-batch-second', 'run_agent_batch'),
      ],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), batchTurn, mixedTurn],
      [
        { ...makeExecStep('batch-first-step'), toolName: 'run_agent_batch', toolCallId: 'tc-batch-first' },
        { ...makeExecStep('read-second-step'), toolCallId: 'tc-read-second' },
        { ...makeExecStep('batch-second-step'), toolName: 'run_agent_batch', toolCallId: 'tc-batch-second' },
      ],
      [],
    );

    expect(segs.map((seg) => seg.kind)).toEqual(['batch', 'steps', 'batch']);
    expect((segs[1] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).executionSteps.map((s) => s.id)).toEqual(['read-second-step']);
  });

  it('claims execution steps by exact toolCallId from the global remaining set across messages', () => {
    const firstTurn: Message = {
      id: 'a-first-missing',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-A', 'read_file')],
    };
    const secondTurn: Message = {
      id: 'a-second-present',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-B', 'read_file')],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), firstTurn, secondTurn],
      [{ ...makeExecStep('step-B'), toolCallId: 'tc-B' }],
      [],
    );

    expect(segs.map((seg) => seg.kind)).toEqual(['steps']);
    expect((segs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).executionSteps.map((s) => s.id)).toEqual(['step-B']);
  });

  it('leaves duplicate exact execution steps unclaimed without hiding later message matches', () => {
    const firstTurn: Message = {
      id: 'a-first-duplicate',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-A', 'read_file')],
    };
    const secondTurn: Message = {
      id: 'a-second-after-duplicate',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-B', 'read_file')],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), firstTurn, secondTurn],
      [
        { ...makeExecStep('step-A-1'), toolCallId: 'tc-A' },
        { ...makeExecStep('step-A-2'), toolCallId: 'tc-A' },
        { ...makeExecStep('step-B'), toolCallId: 'tc-B' },
      ],
      [],
    );

    expect(segs.map((seg) => seg.kind)).toEqual(['steps']);
    expect((segs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).executionSteps.map((s) => s.id)).toEqual(['step-A-1', 'step-B']);
  });

  it('does not drift missing-id execution fallback to a later same-tool message', () => {
    const firstTurn: Message = {
      id: 'a-first-write',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-write', 'write_file')],
    };
    const secondTurn: Message = {
      id: 'a-second-read',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-read', 'read_file')],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), firstTurn, secondTurn],
      [makeExecStep('old-read-at-first-slot')],
      [],
    );

    expect(segs).toHaveLength(0);
  });

  it('claims legacy exact ids globally only when the tool name also matches', () => {
    const firstTurn: Message = {
      id: 'a-first-legacy-missing',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-A', 'read_file')],
    };
    const secondTurn: Message = {
      id: 'a-second-legacy-present',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-B', 'write_file')],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), firstTurn, secondTurn],
      [],
      [
        makeLegacyStep('tc-B', 'write_file'),
        makeLegacyStep('tc-A', 'write_file'),
      ],
    );

    expect(segs.map((seg) => seg.kind)).toEqual(['steps']);
    expect((segs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).legacySteps.map((s) => s.id)).toEqual(['tc-B']);
  });

  it('renders duplicate batch tool-call ids once without shifting the next message offset', () => {
    const duplicateTurn: Message = {
      id: 'a-duplicate-batch',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [
        makeToolCall('tc-batch-dup', 'run_agent_batch'),
        makeToolCall('tc-batch-dup', 'run_agent_batch'),
      ],
    };
    const nextTurn: Message = {
      id: 'a-after-duplicate',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-read-after', 'read_file')],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), duplicateTurn, nextTurn],
      [
        { ...makeExecStep('batch-dup-1'), toolName: 'run_agent_batch', toolCallId: 'tc-batch-dup' },
        { ...makeExecStep('read-after-step'), toolCallId: 'tc-read-after' },
      ],
      [],
    );

    const batchSegments = segs.filter((seg) => seg.kind === 'batch');
    expect(batchSegments).toHaveLength(1);
    expect(segs.map((seg) => seg.kind)).toEqual(['batch', 'steps']);
    expect((segs[1] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).executionSteps.map((s) => s.id)).toEqual(['read-after-step']);
  });

  it('dedupes duplicate legacy batch rows without shifting the next message offset', () => {
    const duplicateTurn: Message = {
      id: 'a-duplicate-legacy-batch',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [
        makeToolCall('tc-batch-dup', 'run_agent_batch'),
        makeToolCall('tc-batch-dup', 'run_agent_batch'),
      ],
    };
    const nextTurn: Message = {
      id: 'a-after-duplicate-legacy',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-read-after', 'read_file')],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), duplicateTurn, nextTurn],
      [],
      [
        makeLegacyStep('tc-batch-dup', 'run_agent_batch'),
        makeLegacyStep('tc-batch-dup', 'run_agent_batch'),
        makeLegacyStep('tc-read-after', 'read_file'),
      ],
    );

    const batchSegments = segs.filter((seg) => seg.kind === 'batch');
    expect(batchSegments).toHaveLength(1);
    expect(segs.map((seg) => seg.kind)).toEqual(['batch', 'steps']);
    expect((segs[1] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).legacySteps.map((s) => s.id)).toEqual(['tc-read-after']);
  });

  it('does not fallback to a positional execution step with a conflicting present toolCallId', () => {
    const msg: Message = {
      id: 'a-wrong-id',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-read', 'read_file')],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), msg],
      [{ ...makeExecStep('wrong-step'), toolCallId: 'different-call' }],
      [],
    );

    expect(segs).toHaveLength(0);
  });

  it('uses same-position same-tool fallback only for old execution snapshots missing toolCallId', () => {
    const msg: Message = {
      id: 'a-old-snapshot',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-read', 'read_file')],
    };
    const segs = buildRenderSegments([makeUser('u1', 'go'), msg], [makeExecStep('old-read-step')], []);

    expect(segs.map((seg) => seg.kind)).toEqual(['steps']);
    expect((segs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).executionSteps[0].id).toBe('old-read-step');
  });

  it('filters synthetic legacy skill rows before raw offset slicing and claims legacy by exact id', () => {
    const msg: Message = {
      id: 'a-legacy',
      role: 'assistant',
      content: '',
      timestamp: 0,
      loopId: 'loop-1',
      toolCalls: [makeToolCall('tc-read', 'read_file')],
    };
    const segs = buildRenderSegments(
      [makeUser('u1', 'go'), msg],
      [],
      [makeLegacyStep('skill'), makeLegacyStep('tc-read', 'read_file')],
    );

    expect(segs.map((seg) => seg.kind)).toEqual(['steps']);
    expect((segs[0] as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>).legacySteps.map((s) => s.id)).toEqual(['tc-read']);
  });

  it('a thinking-typed step in allExecSteps is discarded; msg thinking merges with the tool', () => {
    const msgs: Message[] = [makeUser('u1', 'x'), makeThinkingAssistant('a1', { thinking: 'from msg', thinkingDuration: 1, toolCount: 1 })];
    const thinkingExec: ExecutionStep = { ...makeExecStep('ghost'), type: 'thinking' };
    const toolExec = makeExecStep('real-tool');
    const segs = buildRenderSegments(msgs, [thinkingExec, toolExec], []);
    const stepSegs = segs.filter((s) => s.kind === 'steps') as Extract<ReturnType<typeof buildRenderSegments>[0], { kind: 'steps' }>[];
    // One merged block: msg thinking + real tool, in order. The ghost thinking-exec is dropped.
    expect(stepSegs).toHaveLength(1);
    expect(stepSegs[0].executionSteps.map((s) => s.id)).toEqual(['thinking-a1', 'real-tool']);
    expect(stepSegs[0].executionSteps.some((s) => s.id === 'ghost')).toBe(false);
  });
});

describe('persisted stop terminal', () => {
  it('uses the user reliable-run terminal even when no assistant message exists', () => {
    expect(hasPersistedStopState([{
      ...makeUser('u1', 'stop before first token'),
      runState: 'interrupted',
      runEndedAt: 2_000,
    }])).toBe(true);
  });

  it('keeps compatibility with assistant stopReason and legacy markers', () => {
    expect(hasPersistedStopState([{ ...makeAssistant('a1', ''), stopReason: 'user' }])).toBe(true);
    expect(hasPersistedStopState([makeAssistant('a2', 'partial\n\n*[已停止]*')])).toBe(true);
    expect(stripLegacyStopMarker('partial\n\n*[已停止]*')).toBe('partial');
  });
});

describe('computeWorkProcessFold', () => {
  type Segment = ReturnType<typeof buildRenderSegments>[number];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seg = (kind: string): any => (kind === 'text' ? { kind, text: 'x', message: { id: 't' }, isLastTurn: true } : { kind, executionSteps: [], legacySteps: [], isLastGroup: false, stepsMsgs: [] });

  it('never folds while the run is in progress (header would insert mid-run and say "worked for")', () => {
    expect(computeWorkProcessFold([seg('steps'), seg('text')], false)).toBeNull();
    expect(computeWorkProcessFold([seg('steps'), seg('steps')], false)).toBeNull();
    const batch = { kind: 'batch', toolCall: { id: 'b', name: 'run_agent_batch', input: {} }, message: { id: 'm' } } as Extract<Segment, { kind: 'batch' }>;
    expect(computeWorkProcessFold([batch], false)).toBeNull();
  });
  it('folds everything before the final text answer', () => {
    // [thinking, plan, tool, text] → foldEnd = 3
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(computeWorkProcessFold([seg('steps'), { kind: 'plan', toolCall: { id: 'p' } } as any, seg('steps'), seg('text')], true)).toBe(3);
  });
  it('returns null when the only/first segment is the answer (nothing to fold)', () => {
    expect(computeWorkProcessFold([seg('text')], true)).toBeNull();
  });
  it('folds all process segments when there is no final text answer', () => {
    expect(computeWorkProcessFold([seg('steps'), seg('steps')], true)).toBe(2);
  });
  it('intermediate text folds in; only the last text stays outside', () => {
    // [thinking, text(mid), tool, text(final)] → foldEnd = 3; the mid text
    // inside the fold survives collapse via the collapsed-render filter.
    expect(computeWorkProcessFold([seg('steps'), seg('text'), seg('steps'), seg('text')], true)).toBe(3);
  });
  it('folds text-first output whose process work has no closing answer', () => {
    const batch = { kind: 'batch', toolCall: { id: 'b', name: 'run_agent_batch', input: {} }, message: { id: 'm' } } as Extract<Segment, { kind: 'batch' }>;
    // The leading text is inside the fold range but the collapsed-render
    // filter keeps it visible; only the batch card hides on collapse.
    expect(computeWorkProcessFold([seg('text'), batch], true)).toBe(2);
  });
  it('keeps a mid-loop user message inside the fold range (visibility owned by the render filter)', () => {
    const user = { kind: 'user', message: { id: 'u' } } as Extract<Segment, { kind: 'user' }>;
    expect(computeWorkProcessFold([seg('steps'), user, seg('steps'), seg('text')], true)).toBe(3);
  });
});

describe('streamingTurnHasRenderableContent', () => {
  it('is false for a fresh empty streaming placeholder (dots must show)', () => {
    expect(streamingTurnHasRenderableContent(makeAssistant('m1', ''))).toBe(false);
  });
  it('is false when there is no streaming message', () => {
    expect(streamingTurnHasRenderableContent(undefined)).toBe(false);
  });
  it('is true once text has streamed in', () => {
    expect(streamingTurnHasRenderableContent(makeAssistant('m1', 'hello'))).toBe(true);
  });
  it('is true once thinking has streamed in', () => {
    expect(streamingTurnHasRenderableContent(makeThinkingAssistant('m1', { thinking: 'hmm' }))).toBe(true);
  });
  it('is true once a real tool call has streamed in', () => {
    expect(streamingTurnHasRenderableContent(makeAssistant('m1', '', 1))).toBe(true);
  });
  it('does not count a report_plan with empty steps as content', () => {
    expect(streamingTurnHasRenderableContent(makeThinkingAssistant('m1', { plan: ['  ', ''] }))).toBe(false);
  });
  it('counts a report_plan with real steps as content', () => {
    expect(streamingTurnHasRenderableContent(makeThinkingAssistant('m1', { plan: ['step one'] }))).toBe(true);
  });

  // The reported bug: an earlier turn rendered a (non-empty) plan card, then
  // agentLoop spawned a fresh empty streaming turn to do the actual work. The
  // group HAS content (the plan card is a segment), but the CURRENT streaming
  // turn is empty — so the typing dots must still show. Gating on the group
  // (old `segments.length > 0`) left dead space under the plan card.
  it('regression: the empty streaming turn after a plan card reports no content', () => {
    const planTurn = makeThinkingAssistant('m1', { thinking: 'planning', plan: ['创建 HTML 文件'] });
    const emptyStreamingTurn: Message = { ...makeAssistant('m2', ''), isStreaming: true };
    const group = [planTurn, emptyStreamingTurn];
    // Group-wide view: has content (plan card renders a segment).
    expect(buildRenderSegments(group, [], []).length).toBeGreaterThan(0);
    // Per-turn view: the streaming turn is empty → dots correctly show.
    const streamingMsg = group.find((m) => m.role === 'assistant' && m.isStreaming);
    expect(streamingTurnHasRenderableContent(streamingMsg)).toBe(false);
  });
});
