import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFrameChatDelta, createFrameExecutionPort, createFrameScratchpadPort } from './portFrameSenders';
import type { PortFrame } from './portFrameCoalescer';
import type { ExecutionStep, DetailBlock } from '@/types/execution';
import type { ToolCall, ToolResultContent } from '@/types';
import {
  materializeSidecarMediaRefsForShell,
  sidecarValueHasOpaqueMediaRefs,
} from '@/core/subagent/delegatedUserTurnMaterializer';

const delegatedMediaStoreMocks = vi.hoisted(() => ({
  persistDelegatedMedia: vi.fn(),
  readDelegatedMedia: vi.fn(),
}));

vi.mock('@/core/subagent/delegatedMediaStore', () => delegatedMediaStoreMocks);

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
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngBase64 = 'iVBORw0KGgo=';
  const imageResult: ToolResultContent[] = [
    { type: 'text', text: 'Screenshot saved to: /Users/alice/Desktop/secret-shot.png' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: pngBase64 },
    },
  ];
  const imageResultText = 'Screenshot saved to: /tmp/private/secret-shot.png';

  beforeEach(() => {
    delegatedMediaStoreMocks.persistDelegatedMedia.mockReset();
    delegatedMediaStoreMocks.readDelegatedMedia.mockReset();
  });

  it('persists updateToolCall image results before strict shell receiver applies the frame', async () => {
    delegatedMediaStoreMocks.persistDelegatedMedia.mockResolvedValueOnce({
      id: 'media_tool_result',
      sha256: 'c'.repeat(64),
      mediaType: 'image/png',
      bytes: pngBytes.byteLength,
    });
    delegatedMediaStoreMocks.readDelegatedMedia.mockResolvedValueOnce(pngBytes);
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((f) => frames.push(f));

    delta.updateToolCall('conv-1', 'm1', 'tc1', imageResultText, imageResult, false);

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(pngBase64);
    expect(wire).not.toContain('/tmp/private/secret-shot.png');
    expect(sidecarValueHasOpaqueMediaRefs(frames)).toBe(true);

    const shellFrames = await materializeSidecarMediaRefsForShell(frames, 'conv-1');
    expect(shellFrames).toEqual([{
      p: 'chat',
      m: 'updateToolCall',
      a: [
        'conv-1',
        'm1',
        'tc1',
        'Screenshot saved to: [REDACTED:path]',
        [
          { type: 'text', text: 'Screenshot saved to: [REDACTED:path]' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: pngBase64 },
          },
        ],
        false,
        undefined,
        undefined,
      ],
    }]);
  });

  it('fails closed when updateToolCall image result persistence fails', async () => {
    delegatedMediaStoreMocks.persistDelegatedMedia.mockRejectedValueOnce(
      new Error(`disk refused ${pngBase64} at /Users/alice/Desktop/secret-shot.png`),
    );
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((f) => frames.push(f));

    delta.updateToolCall('conv-1', 'm1', 'tc1', imageResultText, imageResult, false);

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(pngBase64);
    expect(wire).not.toContain('/tmp/private/secret-shot.png');
    expect(sidecarValueHasOpaqueMediaRefs(frames)).toBe(false);
    expect(frames[0]).toMatchObject({
      p: 'chat',
      m: 'updateToolCall',
      a: [
        'conv-1',
        'm1',
        'tc1',
        'Error: Could not prepare sidecar tool media for transport.',
        undefined,
        true,
        undefined,
        undefined,
      ],
    });
  });

  it('queues subsequent wire frames behind a delayed updateToolCall image transport', async () => {
    let resolvePersist!: (ref: {
      id: string;
      sha256: string;
      mediaType: string;
      bytes: number;
    }) => void;
    delegatedMediaStoreMocks.persistDelegatedMedia.mockReturnValueOnce(
      new Promise((resolve) => { resolvePersist = resolve; }),
    );
    const frames: PortFrame[] = [];
    const localApplyOrder: string[] = [];
    const delta = createFrameChatDelta(
      (f) => frames.push(f),
      (m) => localApplyOrder.push(m),
    ) as ReturnType<typeof createFrameChatDelta> & {
      drain: () => Promise<void>;
      flush: () => Promise<void>;
    };

    delta.updateToolCall('conv-1', 'm1', 'tc1', imageResultText, imageResult, false);
    delta.appendText('conv-1', 'after-media', 'm1');

    expect(localApplyOrder).toEqual(['updateToolCall', 'appendText']);
    await Promise.resolve();
    expect(frames).toHaveLength(0);

    resolvePersist({
      id: 'media_delayed_tool_result',
      sha256: 'd'.repeat(64),
      mediaType: 'image/png',
      bytes: pngBytes.byteLength,
    });
    await delta.drain();
    await delta.flush();

    expect(frames.map((frame) => frame.m)).toEqual(['updateToolCall', 'appendText']);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(pngBase64);
    expect(wire).not.toContain('/Users/alice/Desktop/secret-shot.png');
  });

  it('keeps drain pending when another media frame is enqueued while it waits', async () => {
    let resolveFirst!: (ref: {
      id: string;
      sha256: string;
      mediaType: string;
      bytes: number;
    }) => void;
    let resolveSecond!: typeof resolveFirst;
    delegatedMediaStoreMocks.persistDelegatedMedia
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((frame) => frames.push(frame));

    delta.updateToolCall('conv-1', 'm1', 'tc1', imageResultText, imageResult, false);
    const draining = delta.drain();
    let drainSettled = false;
    void draining.then(() => { drainSettled = true; });
    delta.updateToolCall('conv-1', 'm1', 'tc2', imageResultText, imageResult, false);

    await vi.waitFor(() => expect(delegatedMediaStoreMocks.persistDelegatedMedia).toHaveBeenCalledTimes(1));
    resolveFirst({
      id: 'media_first',
      sha256: 'f'.repeat(64),
      mediaType: 'image/png',
      bytes: pngBytes.byteLength,
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(drainSettled).toBe(false);

    resolveSecond({
      id: 'media_second',
      sha256: 'a'.repeat(64),
      mediaType: 'image/png',
      bytes: pngBytes.byteLength,
    });
    await draining;
    expect(frames.map((frame) => frame.a[2])).toEqual(['tc1', 'tc2']);
  });

  it('scrubs absolute paths and data URLs from text-only rich results', () => {
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((frame) => frames.push(frame));
    const dataUrl = `data:image/png;base64,${pngBase64}`;
    const shortDataUrl = 'data:image/png;base64,QQ==';
    const parameterizedDataUrl = 'data:image/png;charset=utf-8;base64,QUJDRA==';
    const namedPdfDataUrl = 'data:application/pdf;name=secret.pdf;base64,JVBERi0=';
    const emptyMimeDataUrl = 'data:;base64,QQ==';
    const httpsUrl = 'https://example.test/assets/secret.png';
    const ordinaryDataText = 'ordinary data: label';

    delta.updateToolCall(
      'conv-1',
      'm1',
      'tc-text',
      `Saw ${dataUrl} ${shortDataUrl} ${parameterizedDataUrl} after opening path:/Users/alice/secret.png and /tmp/private/report.txt`,
      [{ type: 'text', text: `Saw ${dataUrl} ${shortDataUrl} ${namedPdfDataUrl} ${emptyMimeDataUrl} after opening file:///Users/alice/secret.png </Users/alice/secret.png> and /var/private/report.txt ${httpsUrl} ${ordinaryDataText}` }],
      false,
    );

    const wire = JSON.stringify(frames);
    expect(wire).not.toContain('path:/Users/alice/secret.png');
    expect(wire).not.toContain('file:///Users/alice/secret.png');
    expect(wire).not.toContain('/Users/alice/secret.png');
    expect(wire).not.toContain('/tmp/private/report.txt');
    expect(wire).not.toContain('/var/private/report.txt');
    expect(wire).not.toContain(dataUrl);
    expect(wire).not.toContain(shortDataUrl);
    expect(wire).not.toContain(parameterizedDataUrl);
    expect(wire).not.toContain(namedPdfDataUrl);
    expect(wire).not.toContain(emptyMimeDataUrl);
    expect(wire).toContain(httpsUrl);
    expect(wire).toContain(ordinaryDataText);
    expect(wire).toContain('[REDACTED:path]');
    expect(wire).toContain('[REDACTED:base64]');
  });

  it('queues appendMessageToolCall image media before subsequent chat frames and restores it in the shell', async () => {
    let resolvePersist!: (ref: {
      id: string;
      sha256: string;
      mediaType: string;
      bytes: number;
    }) => void;
    delegatedMediaStoreMocks.persistDelegatedMedia.mockReturnValueOnce(
      new Promise((resolve) => { resolvePersist = resolve; }),
    );
    delegatedMediaStoreMocks.readDelegatedMedia.mockResolvedValueOnce(pngBytes);
    const frames: PortFrame[] = [];
    const localApplyOrder: string[] = [];
    const delta = createFrameChatDelta(
      (frame) => frames.push(frame),
      (method) => localApplyOrder.push(method),
    );
    const toolCall: ToolCall = {
      id: 'tool-1',
      name: 'read_file',
      input: { path: '/tmp/secret.png' },
      result: 'Image: /tmp/secret.png',
      resultContent: [
        { type: 'text', text: 'Image text from /Users/alice/secret.png' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
      ],
    };

    delta.appendMessageToolCall('conv-1', 'loop-1', toolCall);
    delta.setAgentStatus('conv-1', 'thinking');
    const draining = delta.drain();

    expect(localApplyOrder).toEqual(['appendMessageToolCall', 'setAgentStatus']);
    await Promise.resolve();
    expect(frames).toHaveLength(0);

    resolvePersist({
      id: 'media_append_tool_call',
      sha256: 'e'.repeat(64),
      mediaType: 'image/png',
      bytes: pngBytes.byteLength,
    });
    await draining;

    expect(frames.map((frame) => frame.m)).toEqual(['appendMessageToolCall', 'setAgentStatus']);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(pngBase64);
    expect(wire).not.toContain('/tmp/secret.png');
    expect(wire).not.toContain('/Users/alice/secret.png');
    expect(sidecarValueHasOpaqueMediaRefs(frames)).toBe(true);

    const shellFrames = await materializeSidecarMediaRefsForShell(frames, 'conv-1');
    const shellToolCall = shellFrames[0].a[2] as ToolCall;
    expect(shellToolCall.result).toBe('Image: [REDACTED:path]');
    expect(shellToolCall.resultContent?.[0]).toEqual({
      type: 'text',
      text: 'Image text from [REDACTED:path]',
    });
    expect(shellToolCall.resultContent?.[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: pngBase64 },
    });
  });

  it('queues tool-call context and message tool-call snapshots with media before subsequent chat frames', async () => {
    const resolvers: Array<(ref: {
      id: string;
      sha256: string;
      mediaType: string;
      bytes: number;
    }) => void> = [];
    delegatedMediaStoreMocks.persistDelegatedMedia.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
    );
    delegatedMediaStoreMocks.readDelegatedMedia.mockResolvedValue(pngBytes);
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((frame) => frames.push(frame));
    const toolCall: ToolCall = {
      id: 'tool-snapshot',
      name: 'read_file',
      input: {},
      result: 'Snapshot image: /tmp/snapshot.png',
      resultContent: [
        { type: 'text', text: 'Snapshot text: /Users/alice/snapshot.png' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
      ],
    };

    delta.appendToolCallContext('conv-1', 'loop-1', {
      name: 'read_file',
      input: {},
      result: 'Context image: /tmp/context.png',
      resultContent: [
        { type: 'text', text: 'Context text: /Users/alice/context.png' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
      ],
    });
    delta.setMessageToolCalls('conv-1', 'm1', [toolCall]);
    delta.setAgentStatus('conv-1', 'thinking');
    const draining = delta.drain();

    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    expect(frames).toHaveLength(0);

    for (let index = 0; index < 2; index += 1) {
      await vi.waitFor(() => expect(resolvers.length).toBe(index + 1));
      resolvers[index]({
        id: `media_tool_snapshot_${index}`,
        sha256: `${index}`.repeat(64).slice(0, 64),
        mediaType: 'image/png',
        bytes: pngBytes.byteLength,
      });
    }
    await draining;

    expect(frames.map((frame) => frame.m)).toEqual([
      'appendToolCallContext',
      'setMessageToolCalls',
      'setAgentStatus',
    ]);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(pngBase64);
    expect(wire).not.toContain('/tmp/context.png');
    expect(wire).not.toContain('/tmp/snapshot.png');
    expect(wire).not.toContain('/Users/alice/context.png');
    expect(wire).not.toContain('/Users/alice/snapshot.png');
    expect(sidecarValueHasOpaqueMediaRefs(frames)).toBe(true);

    const shellFrames = await materializeSidecarMediaRefsForShell(frames, 'conv-1');
    const context = shellFrames[0].a[2] as { resultContent?: ToolResultContent[] };
    const toolCalls = shellFrames[1].a[2] as ToolCall[];
    expect(context.resultContent?.[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: pngBase64 },
    });
    expect(toolCalls[0].resultContent?.[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: pngBase64 },
    });
  });

  it('fails closed explicitly when appendMessageToolCall media persistence fails', async () => {
    delegatedMediaStoreMocks.persistDelegatedMedia.mockRejectedValueOnce(
      new Error(`persist failed for ${pngBase64} at /Users/alice/secret.png`),
    );
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((frame) => frames.push(frame));
    const toolCall: ToolCall = {
      id: 'tool-fail',
      name: 'read_file',
      input: { path: '/Users/alice/secret.png' },
      result: 'Image: /Users/alice/secret.png',
      resultContent: [
        { type: 'text', text: 'Image text from /Users/alice/secret.png' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
      ],
    };

    delta.appendMessageToolCall('conv-1', 'loop-1', toolCall);
    await delta.drain();

    expect(frames).toHaveLength(1);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(pngBase64);
    expect(wire).not.toContain('/Users/alice/secret.png');
    const safeToolCall = frames[0].a[2] as ToolCall;
    expect(safeToolCall).toMatchObject({
      id: 'tool-fail',
      name: 'read_file',
      result: 'Error: Could not prepare sidecar tool media for transport.',
      isError: true,
    });
    expect(safeToolCall.resultContent).toBeUndefined();
  });

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
  beforeEach(() => {
    delegatedMediaStoreMocks.persistDelegatedMedia.mockReset();
    delegatedMediaStoreMocks.readDelegatedMedia.mockReset();
  });

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

  it('queues execution imageData frames and chat snapshots behind media persistence', async () => {
    const execPngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const execPngBase64 = 'iVBORw0KGgo=';
    const resolvers: Array<(ref: {
      id: string;
      sha256: string;
      mediaType: string;
      bytes: number;
    }) => void> = [];
    delegatedMediaStoreMocks.persistDelegatedMedia.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
    );
    delegatedMediaStoreMocks.readDelegatedMedia.mockResolvedValue(execPngBytes);
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((frame) => frames.push(frame));
    const queue = (delta as unknown as {
      pushTransportTask?: (task: () => void | Promise<void>) => void;
    }).pushTransportTask;
    const port = createFrameExecutionPort((frame) => frames.push(frame), queue);
    const imageBlock = makeDetailBlock({
      id: 'image-block-1',
      stepId: 'step-1',
      type: 'image',
      content: 'Image: /tmp/secret.png',
      imageData: { mediaType: 'image/png', base64: execPngBase64 },
    });
    const childImageBlock = makeDetailBlock({
      id: 'image-block-child',
      stepId: 'child-1',
      type: 'image',
      content: 'Child image: /Users/alice/child.png',
      imageData: { mediaType: 'image/png', base64: execPngBase64 },
    });
    const snapshotImageBlock = makeDetailBlock({
      id: 'image-block-snapshot',
      stepId: 'snapshot-1',
      type: 'image',
      content: 'Snapshot image: /var/private/snapshot.png',
      imageData: { mediaType: 'image/png', base64: execPngBase64 },
    });

    port.createExecution('conv-1', 'loop-1');
    port.addStep('loop-1', makeStep({ id: 'step-1' }));
    port.addStep('loop-1', makeStep({ id: 'parent-1', type: 'delegate' }));
    port.addChildStep('loop-1', 'parent-1', makeStep({ id: 'child-1' }));
    await delta.drain();
    frames.length = 0;

    port.addDetailBlock('loop-1', 'step-1', imageBlock);
    port.updateChildStep('loop-1', 'parent-1', 'child-1', 'child result', false, [childImageBlock]);
    const rawRuntimeSnapshot = [
      makeStep({ id: 'snapshot-1', status: 'completed', detailBlocks: [snapshotImageBlock] }),
    ] as unknown as Parameters<typeof delta.setExecutionStepsSnapshot>[2];
    delta.setExecutionStepsSnapshot('conv-1', 'loop-1', rawRuntimeSnapshot);
    delta.setAgentStatus('conv-1', 'thinking');
    const draining = delta.drain();

    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    expect(frames).toHaveLength(0);

    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(resolvers.length).toBe(index + 1));
      resolvers[index]({
        id: `media_exec_${index}`,
        sha256: `${index}`.repeat(64).slice(0, 64),
        mediaType: 'image/png',
        bytes: execPngBytes.byteLength,
      });
    }
    await draining;

    expect(frames.map((frame) => `${frame.p}:${frame.m}`)).toEqual([
      'exec:addDetailBlock',
      'exec:updateChildStep',
      'chat:setExecutionStepsSnapshot',
      'chat:setAgentStatus',
    ]);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(execPngBase64);
    expect(wire).not.toContain('/tmp/secret.png');
    expect(wire).not.toContain('/Users/alice/child.png');
    expect(wire).not.toContain('/var/private/snapshot.png');
    expect(sidecarValueHasOpaqueMediaRefs(frames)).toBe(true);

    const shellFrames = await materializeSidecarMediaRefsForShell(frames, 'conv-1');
    const addDetailBlock = shellFrames[0].a[2] as DetailBlock;
    const childBlocks = shellFrames[1].a[5] as DetailBlock[];
    const snapshotSteps = shellFrames[2].a[2] as ExecutionStep[];
    expect(addDetailBlock.imageData).toEqual({ mediaType: 'image/png', base64: execPngBase64 });
    expect(childBlocks[0].imageData).toEqual({ mediaType: 'image/png', base64: execPngBase64 });
    expect(snapshotSteps[0].detailBlocks[0].imageData).toEqual({ mediaType: 'image/png', base64: execPngBase64 });
  });

  it('queues non-media exec frames behind pending media frames without mutating the queued media payload', async () => {
    const execPngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const execPngBase64 = 'iVBORw0KGgo=';
    let resolvePersist!: (ref: {
      id: string;
      sha256: string;
      mediaType: string;
      bytes: number;
    }) => void;
    delegatedMediaStoreMocks.persistDelegatedMedia.mockReturnValueOnce(
      new Promise((resolve) => { resolvePersist = resolve; }),
    );
    delegatedMediaStoreMocks.readDelegatedMedia.mockResolvedValueOnce(execPngBytes);
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((frame) => frames.push(frame));
    const queue = (delta as unknown as {
      pushTransportTask?: (task: () => void | Promise<void>) => void;
    }).pushTransportTask;
    const port = createFrameExecutionPort((frame) => frames.push(frame), queue);
    const imageBlock = makeDetailBlock({
      id: 'image-block-queued',
      stepId: 'step-1',
      type: 'image',
      content: 'Image: /tmp/queued-secret.png',
      imageData: { mediaType: 'image/png', base64: execPngBase64 },
    });

    port.createExecution('conv-1', 'loop-1');
    port.addStep('loop-1', makeStep({ id: 'step-1' }));
    await delta.drain();
    frames.length = 0;

    port.addDetailBlock('loop-1', 'step-1', imageBlock);
    port.appendThinking('loop-1', 'after-media');
    port.setThinkingDuration('loop-1', 1.25);
    port.setUsage('loop-1', { inputTokens: 1, outputTokens: 2 });
    port.releaseDetailBlockImage('loop-1', 'step-1', 'image-block-queued');
    port.completeExecution('loop-1');
    port.evictExecution('loop-1');
    const draining = delta.drain();

    await vi.waitFor(() => expect(delegatedMediaStoreMocks.persistDelegatedMedia).toHaveBeenCalledTimes(1));
    expect(frames).toHaveLength(0);

    resolvePersist({
      id: 'media_exec_queued',
      sha256: 'a'.repeat(64),
      mediaType: 'image/png',
      bytes: execPngBytes.byteLength,
    });
    await draining;

    expect(frames.map((frame) => `${frame.p}:${frame.m}`)).toEqual([
      'exec:addDetailBlock',
      'exec:appendThinking',
      'exec:setThinkingDuration',
      'exec:setUsage',
      'exec:releaseDetailBlockImage',
      'exec:completeExecution',
      'exec:evictExecution',
    ]);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(execPngBase64);
    expect(wire).not.toContain('/tmp/queued-secret.png');
    expect(sidecarValueHasOpaqueMediaRefs(frames[0])).toBe(true);

    const shellFrames = await materializeSidecarMediaRefsForShell(frames, 'conv-1');
    const addDetailBlock = shellFrames[0].a[2] as DetailBlock;
    expect(addDetailBlock.imageData).toEqual({ mediaType: 'image/png', base64: execPngBase64 });
  });

  it('fails closed explicitly when execution imageData persistence fails', async () => {
    const execPngBase64 = 'iVBORw0KGgo=';
    delegatedMediaStoreMocks.persistDelegatedMedia.mockRejectedValueOnce(
      new Error(`persist failed for ${execPngBase64} at /tmp/secret.png`),
    );
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((frame) => frames.push(frame));
    const queue = (delta as unknown as {
      pushTransportTask?: (task: () => void | Promise<void>) => void;
    }).pushTransportTask;
    const port = createFrameExecutionPort((frame) => frames.push(frame), queue);

    port.createExecution('conv-1', 'loop-1');
    port.addStep('loop-1', makeStep({ id: 'step-1' }));
    await delta.drain();
    frames.length = 0;

    port.addDetailBlock('loop-1', 'step-1', makeDetailBlock({
      id: 'image-block-fail',
      stepId: 'step-1',
      type: 'image',
      content: 'Image: /tmp/secret.png',
      imageData: { mediaType: 'image/png', base64: execPngBase64 },
    }));
    await delta.drain();

    expect(frames).toHaveLength(1);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(execPngBase64);
    expect(wire).not.toContain('/tmp/secret.png');
    const safeBlock = frames[0].a[2] as DetailBlock;
    expect(safeBlock.type).toBe('error');
    expect(safeBlock.content).toBe('Error: Could not prepare sidecar media for transport.');
    expect(safeBlock.imageData).toBeUndefined();
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
