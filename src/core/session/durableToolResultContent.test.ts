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

  it.each(['', 'YQ=='])('retains a saved image reference with data %j', data => {
    const call = imageCall('saved-image', data);
    const image = call.resultContent![0];
    if (image.type !== 'image') throw new Error('Expected image fixture');
    image.outputRef = { relPath: 'inherited/1/photo.png', basename: 'photo.png', sizeBytes: 1 };
    const original = structuredClone(call);
    const bounded = boundToolCallRichContent([call], { maxBytes: 2_048, maxImages: 1 })!;
    expect(bounded).toEqual([original]);
    expect(call).toEqual(original);
  });

  it.each([
    { relPath: '' },
    { relPath: 3 },
    { relPath: 'x'.repeat(4097) },
    { relPath: 'photo.png', sizeBytes: -1 },
    { relPath: 'photo.png', sizeBytes: 1.5 },
    { relPath: 'photo.png', basename: 7 },
  ])('omits malformed saved image metadata %j', outputRef => {
    const call = imageCall('invalid-reference', '');
    Object.assign(call.resultContent![0], { outputRef });
    const bounded = boundToolCallRichContent([call], { maxBytes: 2_048, maxImages: 1 })!;
    expect(bounded[0].resultContent).toBeUndefined();
    expect(bounded[0].result).toContain(__testing.OMITTED_NOTE);
  });

  it('counts reference metadata and saved images within the storage limits', () => {
    const call = imageCall('large-reference', '');
    Object.assign(call.resultContent![0], { outputRef: { relPath: 'photo.png', basename: 'x'.repeat(500) } });
    for (const limits of [
      { maxBytes: 1_024, maxImages: 0 },
      { maxBytes: 1_024, maxImages: 1, maxBlockBytes: 128 },
    ]) {
      const bounded = boundToolCallRichContent([call], limits)!;
      expect(bounded[0].resultContent).toBeUndefined();
      expect(jsonBytes(bounded)).toBeLessThanOrEqual(limits.maxBytes);
    }
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

  describe('file change of a tool call', () => {
    const editCall: ToolCall = {
      id: 'call-edit',
      name: 'edit_file',
      input: { path: '/w/plan.md', old_content: 'a', new_content: 'b' },
      result: 'Successfully edited /w/plan.md: replaced 1 line(s) with 1 line(s)',
      startTime: 1,
      endTime: 2,
      fileChange: {
        path: '/w/plan.md',
        kind: 'modify',
        added: 1,
        deleted: 1,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      },
    };

    it('stays whole on a call that fits the budget', () => {
      const message: Message = { id: 'assistant-1', role: 'assistant', content: '', timestamp: 1, toolCalls: [editCall] };
      expect(boundMessageToolResultContentForDisk(message)).toBe(message);
    });

    it('keeps path, kind and counts and marks the dropped hunks when the call is reduced', () => {
      const reduced: ToolCall = {
        ...editCall,
        fileChange: { path: '/w/plan.md', kind: 'modify', added: 1, deleted: 1, cut: true },
      };

      const bounded = boundToolCallRichContent([editCall], { maxBytes: jsonBytes([reduced]) })!;

      expect(bounded).toEqual([reduced]);
      expect(jsonBytes([editCall])).toBeGreaterThan(jsonBytes([reduced]));
    });
  });

  it('keeps the background command of a call that is reduced, so its tool row still names the command', () => {
    const stopCall: ToolCall = {
      id: 'call-stop',
      name: 'stop_background_command',
      input: { id: 'bg-0a1b2c3d' },
      result: 'Stop requested for background command bg-0a1b2c3d (npm run dev).',
      backgroundCommand: { command: 'npm run dev' },
      noticeCard: { type: 'skill-proposal', id: 'x'.repeat(200) } as ToolCall['noticeCard'],
    };
    const { noticeCard: _dropped, ...reduced } = stopCall;

    const bounded = boundToolCallRichContent([stopCall], { maxBytes: jsonBytes([reduced]) })!;

    expect(bounded).toEqual([reduced]);
  });

  it('keeps the three outcome records of a call that is reduced', () => {
    const call: ToolCall = {
      id: 'call-outcomes',
      name: 'run_command',
      input: { command: 'npm test' },
      result: 'Exit code: 1',
      commandOutcome: { exitCode: 1, stdout: [8, 20], stderr: [30, 41] },
      fileReadOutcome: { kind: 'text', startLine: 200, lineCount: 100, totalLines: 1500, bodyStart: 60 },
      httpFetchOutcome: { status: 404, statusText: 'Not Found', body: [20, 90], truncated: false },
      noticeCard: { type: 'skill-proposal', id: 'x'.repeat(200) } as ToolCall['noticeCard'],
    };
    const { noticeCard: _dropped, ...reduced } = call;
    // The early size estimate counts every array index like an object key, so the
    // budget leaves room for the six numbers of the three ranges.
    const maxBytes = jsonBytes([reduced]) + 64;
    expect(maxBytes).toBeLessThan(jsonBytes([call]));

    const bounded = boundToolCallRichContent([call], { maxBytes })!;

    expect(bounded).toEqual([reduced]);
    expect(bounded[0].commandOutcome).toEqual(call.commandOutcome);
    expect(bounded[0].fileReadOutcome).toEqual(call.fileReadOutcome);
    expect(bounded[0].httpFetchOutcome).toEqual(call.httpFetchOutcome);
  });
});
