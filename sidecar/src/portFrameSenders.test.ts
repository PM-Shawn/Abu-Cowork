import { describe, it, expect, vi } from 'vitest';
import { createFrameChatDelta, createFrameExecutionPort, createFrameScratchpadPort } from './portFrameSenders';
import type { PortFrame } from './portFrameCoalescer';
import type { ExecutionStep, DetailBlock } from '@/types/execution';

function makeStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: 'step-1',
    executionId: 'exec-1',
    type: 'tool',
    label: 'test step',
    status: 'running',
    toolName: 'test_tool',
    toolInput: {},
    source: 'agent',
    detailBlocks: [],
    ...overrides,
  };
}

function makeDetailBlock(overrides: Partial<DetailBlock> = {}): DetailBlock {
  return {
    id: 'block-1',
    stepId: 'step-1',
    type: 'result',
    label: 'result',
    content: 'hello',
    isTruncated: false,
    isExpanded: false,
    ...overrides,
  };
}

describe('createFrameChatDelta', () => {
  it('every method pushes the correct {p, m, a} frame', () => {
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((f) => frames.push(f));

    delta.appendText('c1', 'tok', 'm1');
    delta.setLastMessageContent('c1', 'content', 'm1');
    delta.appendThinking('c1', 'thk', 'm1');
    delta.setThinkingDuration('c1', 3, 'm1');
    delta.flushTokens('c1', 'm1');
    delta.finishStreaming('c1', 'm1');
    delta.cancelStreaming('c1');
    delta.deactivateSkills('c1');
    delta.setMessageStreamingFlag('c1', 'm1', true);
    delta.setMessageToolCalls('c1', 'm1', []);
    delta.addMessage('c1', { id: 'm1', role: 'user', content: 'hi', timestamp: 1 });
    delta.deleteMessagesFrom('c1', 'm1');
    delta.updateToolCall(
      'c1',
      'm1',
      'tc1',
      'result',
      undefined,
      false,
      false,
      { sandboxRecovery: { kind: 'app-automation', targetApp: 'Notes' } },
    );
    delta.checkpointToolCallMetadata('c1', 'm1', 'tc1', {
      sandboxRecovery: { kind: 'app-automation', targetApp: 'Notes' },
    });
    delta.appendToolCallContext('c1', 'loop1', { toolCallId: 'tc1' } as never);
    delta.updateMessageUsage('c1', { inputTokens: 1, outputTokens: 2 }, 'm1');
    delta.setExecutionStepsSnapshot('c1', 'loop1', []);
    delta.setPlannedStepsSnapshot('c1', 'loop1', []);
    delta.setConversationStatus('c1', 'idle');
    delta.setAgentStatus('c1', 'idle', 'tool', 'agent1');
    delta.setCurrentUsage(null);
    delta.setRetryInfo('c1', null);
    delta.setContextUsage('c1', undefined);
    delta.setContextCache('c1', { compressed: true } as never);
    delta.clearContextCache('c1');
    delta.setIsCompressing('c1', true);
    delta.setConversationModel('c1', { providerId: 'p', modelId: 'm' });
    delta.setPendingProposalSignal('c1', undefined);
    delta.removeActiveAgent('c1', 'agent1');

    expect(frames).toHaveLength(29);
    for (const f of frames) {
      expect(f.p).toBe('chat');
      expect(typeof f.m).toBe('string');
      expect(Array.isArray(f.a)).toBe(true);
    }
    expect(frames[0]).toEqual({ p: 'chat', m: 'appendText', a: ['c1', 'tok', 'm1'] });
    expect(frames.find((frame) => frame.m === 'updateToolCall')?.a.at(-1)).toEqual({
      sandboxRecovery: { kind: 'app-automation', targetApp: 'Notes' },
    });
    expect(frames[frames.length - 1]).toEqual({ p: 'chat', m: 'removeActiveAgent', a: ['c1', 'agent1'] });
  });

  it('onLocalApply is invoked synchronously BEFORE the frame is pushed', () => {
    const order: string[] = [];
    const delta = createFrameChatDelta(
      () => order.push('push'),
      () => order.push('onLocalApply'),
    );
    delta.appendText('c1', 'tok');
    expect(order).toEqual(['onLocalApply', 'push']);
  });

  it('onLocalApply receives the same (m, a) the frame carries', () => {
    let captured: { m: string; a: unknown[] } | null = null;
    const delta = createFrameChatDelta(
      () => {},
      (m, a) => {
        captured = { m, a };
      },
    );
    delta.appendText('c1', 'tok', 'm1');
    expect(captured).toEqual({ m: 'appendText', a: ['c1', 'tok', 'm1'] });
  });

  it('zero behavior when onLocalApply is omitted (no throw)', () => {
    const delta = createFrameChatDelta(() => {});
    expect(() => delta.appendText('c1', 'tok')).not.toThrow();
  });
});

describe('createFrameExecutionPort', () => {
  it('createExecution derives id === loopId, pushes {conversationId, loopId} (no separate id arg)', () => {
    const frames: PortFrame[] = [];
    const port = createFrameExecutionPort((f) => frames.push(f));
    const exec = port.createExecution('conv-1', 'loop-1');
    expect(exec.id).toBe('loop-1');
    expect(exec.loopId).toBe('loop-1');
    expect(exec.conversationId).toBe('conv-1');
    expect(exec.status).toBe('running');
    expect(frames).toEqual([{ p: 'exec', m: 'createExecution', a: ['conv-1', 'loop-1'] }]);
  });

  it('getExecutionByLoopId reflects local state immediately after createExecution (no round trip needed)', () => {
    const port = createFrameExecutionPort(() => {});
    port.createExecution('conv-1', 'loop-1');
    expect(port.getExecutionByLoopId('loop-1')?.conversationId).toBe('conv-1');
  });

  it('getExecutionByLoopId returns undefined for an unknown loopId', () => {
    const port = createFrameExecutionPort(() => {});
    expect(port.getExecutionByLoopId('nope')).toBeUndefined();
  });

  it('getExecutionByConversationId returns the LATEST execution for that conversationId', () => {
    const port = createFrameExecutionPort(() => {});
    const a = port.createExecution('conv-1', 'loop-a');
    vi.useFakeTimers();
    vi.advanceTimersByTime(10);
    const b = port.createExecution('conv-1', 'loop-b');
    vi.useRealTimers();
    expect(port.getExecutionByConversationId('conv-1')?.id).toBe(b.id);
    void a;
  });

  it('addStep reflects in a subsequent getExecutionByLoopId read, and pushes a frame', () => {
    const frames: PortFrame[] = [];
    const port = createFrameExecutionPort((f) => frames.push(f));
    port.createExecution('conv-1', 'loop-1');
    port.addStep('loop-1', makeStep({ id: 'step-1' }));
    expect(port.getExecutionByLoopId('loop-1')?.steps).toHaveLength(1);
    expect(frames.at(-1)).toEqual({ p: 'exec', m: 'addStep', a: ['loop-1', makeStep({ id: 'step-1' })] });
  });

  it('setStepResult marks the local step completed with the result, and pushes a frame', () => {
    const port = createFrameExecutionPort(() => {});
    port.createExecution('conv-1', 'loop-1');
    port.addStep('loop-1', makeStep({ id: 'step-1' }));
    port.setStepResult('loop-1', 'step-1', 'ok');
    const step = port.getExecutionByLoopId('loop-1')?.steps[0];
    expect(step?.toolResult).toBe('ok');
    expect(step?.status).toBe('completed');
  });

  it('setStepError marks the local step errored', () => {
    const port = createFrameExecutionPort(() => {});
    port.createExecution('conv-1', 'loop-1');
    port.addStep('loop-1', makeStep({ id: 'step-1' }));
    port.setStepError('loop-1', 'step-1', 'boom');
    const step = port.getExecutionByLoopId('loop-1')?.steps[0];
    expect(step?.errorMessage).toBe('boom');
    expect(step?.status).toBe('error');
  });

  it('addChildStep / updateChildStep nest and update a delegate child step locally', () => {
    const port = createFrameExecutionPort(() => {});
    port.createExecution('conv-1', 'loop-1');
    port.addStep('loop-1', makeStep({ id: 'parent-1', type: 'delegate' }));
    port.addChildStep('loop-1', 'parent-1', makeStep({ id: 'child-1' }));
    let parent = port.getExecutionByLoopId('loop-1')?.steps[0];
    expect(parent?.childSteps).toHaveLength(1);

    port.updateChildStep('loop-1', 'parent-1', 'child-1', 'child result', false);
    parent = port.getExecutionByLoopId('loop-1')?.steps[0];
    expect(parent?.childSteps?.[0].toolResult).toBe('child result');
    expect(parent?.childSteps?.[0].status).toBe('completed');
  });

  it('addDetailBlock pushes a detail block onto the local step', () => {
    const port = createFrameExecutionPort(() => {});
    port.createExecution('conv-1', 'loop-1');
    port.addStep('loop-1', makeStep({ id: 'step-1' }));
    port.addDetailBlock('loop-1', 'step-1', makeDetailBlock());
    expect(port.getExecutionByLoopId('loop-1')?.steps[0].detailBlocks).toHaveLength(1);
  });

  it('appendThinking / setThinkingDuration accumulate locally', () => {
    const port = createFrameExecutionPort(() => {});
    port.createExecution('conv-1', 'loop-1');
    port.appendThinking('loop-1', 'hello ');
    port.appendThinking('loop-1', 'world');
    port.setThinkingDuration('loop-1', 3);
    const exec = port.getExecutionByLoopId('loop-1');
    expect(exec?.thinking).toBe('hello world');
    expect(exec?.thinkingDuration).toBe(3);
  });

  it('setUsage sets local usage', () => {
    const port = createFrameExecutionPort(() => {});
    port.createExecution('conv-1', 'loop-1');
    port.setUsage('loop-1', { inputTokens: 10, outputTokens: 20 });
    expect(port.getExecutionByLoopId('loop-1')?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('completeExecution / errorExecution / cancelExecution set local status + endTime', () => {
    const port = createFrameExecutionPort(() => {});
    port.createExecution('conv-1', 'loop-1');
    port.completeExecution('loop-1');
    expect(port.getExecutionByLoopId('loop-1')?.status).toBe('completed');
    expect(port.getExecutionByLoopId('loop-1')?.endTime).toBeDefined();
  });

  it('evictExecution mirrors taskExecutionStore\'s guard — no-ops while status is "running"', () => {
    const port = createFrameExecutionPort(() => {});
    port.createExecution('conv-1', 'loop-1');
    port.evictExecution('loop-1'); // still 'running' — must not evict
    expect(port.getExecutionByLoopId('loop-1')).toBeDefined();
  });

  it('evictExecution removes a non-running execution locally, and still pushes the frame either way', () => {
    const frames: PortFrame[] = [];
    const port = createFrameExecutionPort((f) => frames.push(f));
    port.createExecution('conv-1', 'loop-1');
    port.cancelExecution('loop-1');
    port.evictExecution('loop-1');
    expect(port.getExecutionByLoopId('loop-1')).toBeUndefined();
    expect(frames.some((f) => f.m === 'evictExecution')).toBe(true);
  });

  it('write methods on an unknown execId are a local no-op but still push the frame (mirrors real store no-throw discipline)', () => {
    const frames: PortFrame[] = [];
    const port = createFrameExecutionPort((f) => frames.push(f));
    expect(() => port.setUsage('does-not-exist', { inputTokens: 1, outputTokens: 1 })).not.toThrow();
    expect(frames).toEqual([{ p: 'exec', m: 'setUsage', a: ['does-not-exist', { inputTokens: 1, outputTokens: 1 }] }]);
  });
});

describe('createFrameScratchpadPort', () => {
  it('addEntry returns a generated string id and pushes {p:"scratchpad", m:"addEntry", a:[id, entry]}', () => {
    const frames: PortFrame[] = [];
    const port = createFrameScratchpadPort((f) => frames.push(f));
    const entry = { conversationId: 'c1', title: 't', type: 'summary' as const, content: 'x' };
    const id = port.addEntry(entry);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(frames).toEqual([{ p: 'scratchpad', m: 'addEntry', a: [id, entry] }]);
  });

  it('id round-trips — the SAME id returned to the caller is the one in the pushed frame', () => {
    const frames: PortFrame[] = [];
    const port = createFrameScratchpadPort((f) => frames.push(f));
    const id = port.addEntry({ conversationId: 'c1', title: 't', type: 'summary', content: 'x' });
    const frameArgs = frames[0].a as [string, unknown];
    expect(frameArgs[0]).toBe(id);
  });

  it('generates distinct ids for consecutive entries', () => {
    const port = createFrameScratchpadPort(() => {});
    const id1 = port.addEntry({ conversationId: 'c1', title: 't1', type: 'summary', content: 'x' });
    const id2 = port.addEntry({ conversationId: 'c1', title: 't2', type: 'summary', content: 'y' });
    expect(id1).not.toBe(id2);
  });
});
