/**
 * Boundary units for the shared media-transport-failure module — the
 * degradation contract the `agent.delta` receiver depends on: order and
 * count are preserved, `session`-port frames are never re-labelled as tool
 * failures, and degradation touches nothing but the offending frame's args.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOL_MEDIA_TRANSPORT_ERROR,
  degradeDeltaFramesForMediaFailure,
  markToolCallMediaTransportFailure,
} from './mediaTransportFailure';
import type { PortFrame } from '@/core/agent/frameApplier';

vi.mock('./delegatedMediaStore', () => ({
  persistDelegatedMedia: vi.fn(),
  readDelegatedMedia: vi.fn(),
}));

const RAW_B64 = 'QUJVLVJBVy1CQVNFNjQ=';
const rawImageBlock = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RAW_B64 } });

describe('degradeDeltaFramesForMediaFailure', () => {
  it('keeps frame order and count, degrading only the offending frames', () => {
    const frames: PortFrame[] = [
      { p: 'chat', m: 'appendText', a: ['conv-1', 'hello'] },
      { p: 'chat', m: 'appendMessageToolCall', a: ['conv-1', 'loop-1', { id: 'tc-bad', resultContent: [rawImageBlock()] }] },
      { p: 'exec', m: 'addStep', a: ['loop-1', { id: 'step-1' }] },
      { p: 'chat', m: 'updateToolCall', a: ['conv-1', 'msg-1', 'tc-ok', 'done'] },
    ];

    const { frames: degraded, degradedIndexes } = degradeDeltaFramesForMediaFailure(frames);

    expect(degradedIndexes).toEqual([1]);
    expect(degraded).toHaveLength(frames.length);
    expect(degraded.map((frame) => `${frame.p}.${frame.m}`)).toEqual([
      'chat.appendText', 'chat.appendMessageToolCall', 'exec.addStep', 'chat.updateToolCall',
    ]);
    // Clean frames are passed through by identity — never re-serialized.
    expect(degraded[0]).toBe(frames[0]);
    expect(degraded[2]).toBe(frames[2]);
    expect(degraded[3]).toBe(frames[3]);
    expect(JSON.stringify(degraded)).not.toContain(RAW_B64);
  });

  it('redacts a session-port frame without re-labelling it as a tool failure', () => {
    const frames: PortFrame[] = [{
      p: 'session',
      m: 'replaceMessageById',
      a: ['conv-1', { id: 'msg-1', role: 'assistant', content: [rawImageBlock()] }],
    }];

    const { frames: degraded, degradedIndexes } = degradeDeltaFramesForMediaFailure(frames);

    expect(degradedIndexes).toEqual([0]);
    expect(degraded[0].p).toBe('session');
    expect(degraded[0].m).toBe('replaceMessageById');
    const message = degraded[0].a[1] as Record<string, unknown>;
    expect(message.id).toBe('msg-1');
    expect(message.role).toBe('assistant');
    expect(message).not.toHaveProperty('result');
    expect(message).not.toHaveProperty('isError');
    expect(JSON.stringify(degraded)).not.toContain(RAW_B64);
  });

  it('never re-labels a non-chat frame even when it borrows a chat tool-call method name', () => {
    // Hostile/malformed shape: the port, not the method name, decides whether
    // a frame may be settled as a tool failure.
    const { frames: degraded } = degradeDeltaFramesForMediaFailure([
      { p: 'session', m: 'updateToolCall', a: ['conv-1', 'msg-1', 'tc-1', { imageData: { mediaType: 'image/png', base64: RAW_B64 } }] },
    ]);

    expect(degraded[0].a).toHaveLength(4);
    expect(degraded[0].a[3]).not.toBe(TOOL_MEDIA_TRANSPORT_ERROR);
    expect(JSON.stringify(degraded)).not.toContain(RAW_B64);
  });

  it('does not touch run/session identity — only the offending frame args change', () => {
    const frames: PortFrame[] = [{
      p: 'chat',
      m: 'appendToolCallContext',
      a: ['conv-1', 'loop-1', { toolCallId: 'tc-1', runId: 'run-1', resultContent: [rawImageBlock()] }],
    }];

    const { frames: degraded } = degradeDeltaFramesForMediaFailure(frames);

    const context = degraded[0].a[2] as Record<string, unknown>;
    expect(degraded[0].a[0]).toBe('conv-1');
    expect(degraded[0].a[1]).toBe('loop-1');
    expect(context.toolCallId).toBe('tc-1');
    expect(context.runId).toBe('run-1');
    expect(context.result).toBe(TOOL_MEDIA_TRANSPORT_ERROR);
    expect(context.isExecuting).toBe(false);
    // The input batch is not mutated in place.
    expect((frames[0].a[2] as Record<string, unknown>).result).toBeUndefined();
  });

  it('settles updateToolCall positionally (result / resultContent / isError)', () => {
    const frames: PortFrame[] = [{
      p: 'chat',
      m: 'updateToolCall',
      a: ['conv-1', 'msg-1', 'tc-1', 'ok', [rawImageBlock()], false, true, { subagentStopReason: 'completed' }],
    }];

    const { frames: degraded } = degradeDeltaFramesForMediaFailure(frames);

    expect(degraded[0].a[2]).toBe('tc-1');
    expect(degraded[0].a[3]).toBe(TOOL_MEDIA_TRANSPORT_ERROR);
    expect(degraded[0].a[4]).toBeUndefined();
    expect(degraded[0].a[5]).toBe(true);
    expect(degraded[0].a[6]).toBe(true);
    expect(degraded[0].a[7]).toEqual({ subagentStopReason: 'completed' });
  });

  it('pads a short updateToolCall arg list so the failure is still settled', () => {
    const { frames: degraded } = degradeDeltaFramesForMediaFailure([
      { p: 'chat', m: 'updateToolCall', a: ['conv-1', 'msg-1', 'tc-1', { imageData: { mediaType: 'image/png', base64: RAW_B64 } }] },
    ]);

    expect(degraded[0].a).toHaveLength(6);
    expect(degraded[0].a[3]).toBe(TOOL_MEDIA_TRANSPORT_ERROR);
    expect(degraded[0].a[5]).toBe(true);
  });

  it('settles every call in a setMessageToolCalls batch', () => {
    const { frames: degraded } = degradeDeltaFramesForMediaFailure([
      {
        p: 'chat',
        m: 'setMessageToolCalls',
        a: ['conv-1', 'msg-1', [
          { id: 'tc-1', isExecuting: true },
          { id: 'tc-2', isExecuting: true, resultContent: [rawImageBlock()] },
        ]],
      },
    ]);

    const calls = degraded[0].a[2] as Array<Record<string, unknown>>;
    expect(calls.map((call) => call.id)).toEqual(['tc-1', 'tc-2']);
    expect(calls.every((call) => call.isExecuting === false && call.isError === true)).toBe(true);
    expect(calls.every((call) => call.result === TOOL_MEDIA_TRANSPORT_ERROR)).toBe(true);
  });

  it('redacts checkpointToolCallMetadata without inventing a failure label it has no slot for', () => {
    const { frames: degraded, degradedIndexes } = degradeDeltaFramesForMediaFailure([
      {
        p: 'chat',
        m: 'checkpointToolCallMetadata',
        a: ['conv-1', 'msg-1', 'tc-1', { detail: { mediaType: 'image/png', base64: RAW_B64 } }],
      },
    ]);

    expect(degradedIndexes).toEqual([0]);
    expect(degraded[0].a.slice(0, 3)).toEqual(['conv-1', 'msg-1', 'tc-1']);
    expect(degraded[0].a).toHaveLength(4);
    expect(JSON.stringify(degraded)).not.toContain(RAW_B64);
  });

  it('leaves a clean batch untouched and reports no degradation', () => {
    const frames: PortFrame[] = [
      { p: 'chat', m: 'appendText', a: ['conv-1', 'hi'] },
      { p: 'scratchpad', m: 'updateEntry', a: ['e-1', { conversationId: 'conv-1' }] },
    ];

    const result = degradeDeltaFramesForMediaFailure(frames);

    expect(result.degradedIndexes).toEqual([]);
    expect(result.frames).toEqual(frames);
  });
});

describe('markToolCallMediaTransportFailure', () => {
  it('passes non-tool-call values through unchanged', () => {
    expect(markToolCallMediaTransportFailure('tc-1')).toBe('tc-1');
    expect(markToolCallMediaTransportFailure(undefined)).toBeUndefined();
    expect(markToolCallMediaTransportFailure([1, 2])).toEqual([1, 2]);
  });

  it('scrubs the payload and stamps the terminal state', () => {
    const marked = markToolCallMediaTransportFailure({
      id: 'tc-1',
      isExecuting: true,
      resultContent: [rawImageBlock()],
    }) as Record<string, unknown>;

    expect(marked.id).toBe('tc-1');
    expect(marked.result).toBe(TOOL_MEDIA_TRANSPORT_ERROR);
    expect(marked.resultContent).toBeUndefined();
    expect(marked.isError).toBe(true);
    expect(marked.isExecuting).toBe(false);
    expect(JSON.stringify(marked)).not.toContain(RAW_B64);
  });
});
