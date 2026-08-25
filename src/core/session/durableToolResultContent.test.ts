import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/types';
import {
  appendBoundedSubagentToolCall,
  boundMessageToolResultContentForDisk,
  boundToolCallRichContent,
  __testing,
} from './durableToolResultContent';

function imageCall(id: string, data: string, fromSubagent = false): ToolCall {
  return {
    id,
    name: 'computer',
    input: {},
    result: `image ${id}`,
    resultContent: [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data },
    }],
    ...(fromSubagent ? { hidden: true, fromSubagent: true } : {}),
  };
}

function jsonBytes(value: unknown): number {
  return __testing.jsonUtf8ByteLength(value);
}

describe('durable tool-result storage budget', () => {
  it('retains newest calls within the exact serialized list budget', () => {
    const oldCall = imageCall('old', 'YWFh');
    const newCall = imageCall('new', 'YmJi');
    const oneCallBudget = jsonBytes([newCall]);

    const bounded = boundToolCallRichContent(
      [oldCall, newCall],
      { maxBytes: oneCallBudget, maxImages: 1 },
    )!;

    expect(bounded).toEqual([newCall]);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(oneCallBudget);
  });

  it('truncates text on a valid UTF-8 and JSON boundary', () => {
    const call: ToolCall = {
      id: 'text',
      name: 'read_file',
      input: {},
      result: 'text',
      resultContent: [{ type: 'text', text: 'a😀\u0000b' }],
    };
    const oneCharacterBlockBytes = jsonBytes({ type: 'text', text: 'a' });

    const bounded = boundToolCallRichContent([call], {
      maxBytes: 2_048,
      maxImages: 0,
      maxBlockBytes: oneCharacterBlockBytes,
    })!;

    expect(bounded[0].resultContent).toEqual([{ type: 'text', text: 'a' }]);
    expect(bounded[0].result).toContain(__testing.OMITTED_NOTE);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(2_048);
  });

  it('deduplicates dual delivery and evicts the oldest subagent replay entry first', () => {
    const parent = imageCall('parent', 'cGFyZW50');
    const first = imageCall('subagent-v1:run-a:call_1', 'YWFh', true);
    const second = imageCall('subagent-v1:run-b:call_1', 'YmJi', true);
    const oneReplayBudget = jsonBytes([second]);

    const once = appendBoundedSubagentToolCall(
      [parent],
      first,
      { maxBytes: oneReplayBudget, maxImages: 1 },
    );
    const duplicate = appendBoundedSubagentToolCall(
      once.toolCalls,
      first,
      { maxBytes: oneReplayBudget, maxImages: 1 },
    );
    const nextRun = appendBoundedSubagentToolCall(
      duplicate.toolCalls,
      second,
      { maxBytes: oneReplayBudget, maxImages: 1 },
    );

    expect(duplicate.appended).toBe(false);
    expect(nextRun.toolCalls).toHaveLength(2);
    expect(nextRun.toolCalls[0]).toBe(parent);
    expect(nextRun.toolCalls[1].id).toBe(second.id);
    expect(nextRun.toolCalls[1].resultContent?.[0]).toMatchObject({
      type: 'image',
      source: { data: 'YmJi' },
    });
  });

  it('preserves long replay identities so repeated delivery stays idempotent', () => {
    const sharedPrefix = 'call-'.repeat(1_000);
    const first = imageCall(`${sharedPrefix}a`, 'YQ==', true);
    const sameAgain = { ...first };
    const differentTail = imageCall(`${sharedPrefix}b`, 'Yg==', true);
    const limits = { maxBytes: 32 * 1024, maxImages: 2 };

    const once = appendBoundedSubagentToolCall([], first, limits);
    const duplicate = appendBoundedSubagentToolCall(once.toolCalls, sameAgain, limits);
    const distinct = appendBoundedSubagentToolCall(duplicate.toolCalls, differentTail, limits);

    expect(once.toolCalls[0].id).toBe(first.id);
    expect(duplicate.appended).toBe(false);
    expect(duplicate.toolCalls).toHaveLength(1);
    expect(distinct.appended).toBe(true);
    expect(distinct.toolCalls.map((toolCall) => toolCall.id)).toEqual([first.id, differentTail.id]);
  });

  it('counts empty and one-byte blocks by serialized envelope and caps total blocks', () => {
    const call: ToolCall = {
      id: 'many-blocks',
      name: 'mcp__hostile__result',
      input: {},
      result: 'result',
      resultContent: Array.from({ length: 10_000 }, (_, index) => (
        index % 2 === 0
          ? { type: 'text' as const, text: '' }
          : { type: 'text' as const, text: 'x' }
      )),
    };
    const maxBytes = 2_048;
    const bounded = boundToolCallRichContent([call], {
      maxBytes,
      maxImages: 0,
      maxBlocks: 4,
      maxBlockBytes: 128,
    })!;

    expect(bounded[0].resultContent).toHaveLength(2);
    expect(bounded[0].result).toContain(__testing.OMITTED_NOTE);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(maxBytes);
  });

  it('rejects malformed image data and oversized or invalid MIME metadata', () => {
    const call = imageCall('malformed', 'YQ==');
    call.resultContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: `image/${'x'.repeat(300)}`, data: 'YQ==' },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'not base64!\u0000' },
      },
      { type: 'bogus' } as never,
    ];

    const bounded = boundToolCallRichContent([call], { maxBytes: 2_048, maxImages: 8 })!;
    expect(bounded[0].resultContent).toBeUndefined();
    expect(bounded[0].result).toContain(__testing.OMITTED_NOTE);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(2_048);
  });

  it('bounds result text, tool input, block bytes, and JSON escaping together', () => {
    const call = imageCall('hostile', 'YQ==', true);
    call.input = { payload: 'i'.repeat(1_000_000) };
    call.result = `${'r'.repeat(1_000_000)}${'\u0000'.repeat(1_000)}`;
    call.resultContent = [
      { type: 'text', text: `${'t'.repeat(10_000)}${'\u0000'.repeat(1_000)}` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
    ];
    const maxBytes = 4_096;

    const { toolCalls } = appendBoundedSubagentToolCall([], call, {
      maxBytes,
      maxImages: 1,
      maxBlocks: 2,
      maxBlockBytes: 512,
      maxResultBytes: 512,
      maxInputBytes: 256,
    });

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].input).toEqual({ _durableTruncated: true });
    expect(toolCalls[0].result).toContain(__testing.OMITTED_NOTE);
    expect(jsonBytes(toolCalls)).toBeLessThanOrEqual(maxBytes);
  });

  it('defends both persisted projections without mutating a normal live message', () => {
    const display = imageCall('call-1', 'ZGlzcGxheQ==');
    const context: NonNullable<Message['toolCallsForContext']>[number] = {
      name: 'computer',
      input: {},
      result: 'context image',
      resultContent: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'Y29udGV4dA==' },
      }],
    };
    const message: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [display],
      toolCallsForContext: [context],
    };

    const bounded = boundMessageToolResultContentForDisk(message);
    expect(bounded).toBe(message);
    expect(message.toolCalls?.[0].resultContent?.[0]).toMatchObject({
      type: 'image',
      source: { data: 'ZGlzcGxheQ==' },
    });
  });
});
