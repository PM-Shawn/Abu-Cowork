import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, StreamEvent, ToolCall } from '@/types';
import type { LLMAdapter } from '../llm/adapter';
import type { SummaryRequest } from './contextCompressor';
import { compactHistory, readFileThroughTool } from './compaction';
import { buildContextFromBoundary } from './compactBoundary';
import { computeInputBudget, enforceContextBudget } from './contextManager';
import { estimateMessageTokens, estimateTokens, estimateToolSchemaTokens } from './tokenEstimator';

const summaryChat = vi.fn<LLMAdapter['chat']>();

let seq = 0;
function msg(role: 'user' | 'assistant', overrides: Partial<Message> = {}): Message {
  seq++;
  return { id: `m${seq}`, role, content: `content ${seq}`, timestamp: seq, ...overrides };
}
function step(toolCalls: Partial<ToolCall>[] = [{ name: 'run_command' }]): Message {
  return msg('assistant', {
    toolCalls: toolCalls.map((call, index) => ({ id: `tc${seq}-${index}`, name: 'run_command', input: {}, result: 'ok', ...call })) as ToolCall[],
  });
}

const summaryRequest: SummaryRequest = {
  adapter: { chat: summaryChat } as LLMAdapter,
  chatOptions: { model: 'm', apiKey: 'k' },
  conversationId: 'c1',
  providerInstanceId: 'p1',
};

beforeEach(() => {
  seq = 0;
  summaryChat.mockReset();
  summaryChat.mockImplementation(async (_messages, _options, onEvent) => {
    onEvent({ type: 'text', text: 'SUMMARY' });
    onEvent({ type: 'done', stopReason: 'end_turn' });
  });
});

describe('compactHistory', () => {
  it('returns null and asks nothing when there is nothing before the newest step', async () => {
    const marker = await compactHistory({
      history: [msg('user'), step()],
      inputBudget: 100_000,
      retainTokens: 0,
      source: 'auto',
      summary: summaryRequest as never,
      readFile: vi.fn(),
      now: () => 1,
    });
    expect(marker).toBeNull();
    expect(summaryChat).not.toHaveBeenCalled();
  });

  it('sends text only: images and attachments become one-line notes', async () => {
    const user = msg('user', {
      content: [
        { type: 'text', text: 'What is on these?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
      ] as Message['content'],
    });
    const shot = step([{
      name: 'computer',
      result: '[image]',
      resultContent: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PIXELS' } }],
    }]);
    await compactHistory({
      history: [user, shot, step()],
      inputBudget: 100_000,
      retainTokens: 0,
      source: 'auto',
      summary: summaryRequest as never,
      readFile: vi.fn(),
      now: () => 1,
    });

    const sent = JSON.stringify(summaryChat.mock.calls[0][0]);
    expect(sent).not.toContain('PIXELS');
    expect(sent).not.toContain('"type":"image"');
    expect(sent).toContain('What is on these?');
    expect(sent).toContain('not part of this summary request');
  });

  it('fits the complete summary request including its instruction before sending it', async () => {
    const user = msg('user');
    const longStep = msg('assistant', { content: 'result '.repeat(5000) });
    const request: SummaryRequest = {
      ...summaryRequest,
      chatOptions: { ...summaryRequest.chatOptions, systemPrompt: 'System prompt', maxTokens: 256 },
    };
    const system = request.chatOptions.systemPrompt!;
    const tools = estimateToolSchemaTokens(request.chatOptions.tools ?? []);
    await compactHistory({
      history: [user, longStep, step()],
      inputBudget: computeInputBudget(2000, 256).inputBudget,
      retainTokens: 0,
      source: 'auto',
      summary: request,
      fitSummaryInput: (messages) => enforceContextBudget(messages, system, 2000, 256, tools).messages,
      readFile: vi.fn(),
      now: () => 1,
    });
    const sent = summaryChat.mock.calls[0][0];
    expect(sent.at(-1)?.content).toContain('Do not call any tools');
    expect(sent).toContainEqual(user);
    expect(estimateMessageTokens(sent) + estimateTokens(system) + tools)
      .toBeLessThanOrEqual(computeInputBudget(2000, 256).inputBudget);
  });

  it('re-reads the files read before the tail and stores them on the marker within their budgets', async () => {
    const history = [
      msg('user'),
      step([{ name: 'read_file', input: { path: '/small.ts' } }]),
      step([{ name: 'read_file', input: { path: '/huge.ts' } }]),
      step([{ name: 'read_file', input: { path: '/gone.ts' } }]),
      step(),
    ];
    const readFile = vi.fn(async (path: string) => {
      if (path === '/gone.ts') return null;
      if (path === '/huge.ts') return 'h'.repeat(200_000);
      return 'export const small = 1;';
    });

    const marker = await compactHistory({
      history,
      inputBudget: 200_000,
      retainTokens: 0,
      source: 'auto',
      loopId: 'loop-1',
      summary: summaryRequest as never,
      readFile,
      now: () => 42,
    });

    expect(readFile.mock.calls.map((call) => call[0])).toEqual(['/gone.ts', '/huge.ts', '/small.ts']);
    const files = marker!.compactBoundary!.restoredFiles!;
    expect(files.map((file) => file.path)).toEqual(['/huge.ts', '/small.ts']);
    // One file keeps at most 5 000 tokens (about 20 000 plain characters here).
    expect(files[0].content.length).toBeLessThan(21_000);
    expect(files[0].content).toContain('the rest of this file is not shown');
    expect(files[1].content).toBe('export const small = 1;');
    expect(marker!.loopId).toBe('loop-1');
    expect(marker!.compactBoundary!.summaryText).toBe('SUMMARY');

    // The rebuilt view carries the snapshot right after the summary.
    const view = buildContextFromBoundary([...history, marker!]);
    expect(view[2].content).toContain('<file path="/huge.ts">');
  });

  it('lets a failed summary request throw, and writes nothing', async () => {
    summaryChat.mockRejectedValueOnce(new Error('provider down'));
    await expect(compactHistory({
      history: [msg('user'), step(), step()],
      inputBudget: 100_000,
      retainTokens: 0,
      source: 'auto',
      summary: summaryRequest as never,
      readFile: vi.fn(),
      now: () => 1,
    })).rejects.toThrow('provider down');
  });

  it('appends the [kept anchors] block when keepAnchors is on', async () => {
    const anchored = msg('assistant', {
      content: '开始处理。\n- [ ] 扫描 d:/00malong/aiworkspace/测试目录 的文件\n- [ ] 按 spec 分组',
      toolCalls: [{ id: 'tc-a', name: 'run_command', input: {}, result: 'ok' }] as ToolCall[],
    });
    const marker = await compactHistory({
      history: [msg('user'), anchored, step()],
      inputBudget: 100_000,
      retainTokens: 0,
      source: 'auto',
      summary: summaryRequest as never,
      keepAnchors: true,
      readFile: vi.fn(),
      now: () => 1,
    });
    const summaryText = marker!.compactBoundary!.summaryText;
    expect(summaryText.startsWith('SUMMARY')).toBe(true);
    expect(summaryText).toContain('[kept anchors]');
    expect(summaryText).toContain('- [ ] 扫描 d:/00malong/aiworkspace/测试目录 的文件');
    expect(summaryText).toContain('- [ ] 按 spec 分组');
  });

  it('keeps the summary bare when keepAnchors is off or nothing matches', async () => {
    const markerOff = await compactHistory({
      history: [msg('user'), msg('assistant', { content: '- [ ] 锚点步骤' }), step()],
      inputBudget: 100_000,
      retainTokens: 0,
      source: 'auto',
      summary: summaryRequest as never,
      readFile: vi.fn(),
      now: () => 1,
    });
    expect(markerOff!.compactBoundary!.summaryText).toBe('SUMMARY');

    const markerNoMatch = await compactHistory({
      history: [msg('user'), msg('assistant', { content: '普通叙述，没有锚点。' }), step()],
      inputBudget: 100_000,
      retainTokens: 0,
      source: 'auto',
      summary: summaryRequest as never,
      keepAnchors: true,
      readFile: vi.fn(),
      now: () => 1,
    });
    expect(markerNoMatch!.compactBoundary!.summaryText).toBe('SUMMARY');
  });

  it('leaves the history unchanged when a partial summary is cancelled', async () => {
    const controller = new AbortController();
    const history = [msg('user'), step(), step()];
    const original = structuredClone(history);
    const readFile = vi.fn();
    summaryChat.mockImplementationOnce(async (_messages, _options, onEvent: (event: StreamEvent) => void) => {
      onEvent({ type: 'text', text: 'partial summary' });
      controller.abort();
      onEvent({ type: 'done', stopReason: 'cancelled' });
    });
    await expect(compactHistory({
      history,
      inputBudget: 100_000,
      retainTokens: 0,
      source: 'auto',
      summary: { ...summaryRequest, signal: controller.signal },
      readFile,
      now: () => 1,
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(history).toEqual(original);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('creates no marker when cancelled while restoring a file', async () => {
    const controller = new AbortController();
    const history = [
      msg('user'),
      step([{ name: 'read_file', input: { path: '/a.ts' } }]),
      step([{ name: 'read_file', input: { path: '/b.ts' } }]),
      step(),
    ];
    const original = structuredClone(history);
    const readFile = vi.fn(async () => {
      controller.abort();
      return 'current file';
    });
    await expect(compactHistory({
      history,
      inputBudget: 100_000,
      retainTokens: 0,
      source: 'auto',
      summary: { ...summaryRequest, signal: controller.signal },
      readFile,
      now: () => 1,
    })).rejects.toThrow();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(history).toEqual(original);
  });
});

describe('readFileThroughTool', () => {
  it('returns the text read_file produced when it reports a text read', async () => {
    const read = readFileThroughTool(async (_input, context) => {
      expect(context.allowPermissionPrompts).toBe(false);
      context.reportMetadata?.({ fileReadOutcome: { kind: 'text', startLine: 1, lineCount: 1, totalLines: 1, bodyStart: 0 } });
      return 'file body';
    }, { conversationId: 'c1' });
    expect(await read('/a.ts')).toBe('file body');
  });

  it('returns null for anything else: a refusal, a notice, an error string', async () => {
    const read = readFileThroughTool(async () => 'Error reading file: ENOENT', { conversationId: 'c1' });
    expect(await read('/missing.ts')).toBeNull();
  });
  it('restores extracted document text', async () => {
    const read = readFileThroughTool(async (_input, context) => {
      context.reportMetadata?.({ fileReadOutcome: { kind: 'document' } });
      return 'Extracted report text';
    }, { conversationId: 'c1' });
    expect(await read('/report.pdf')).toBe('Extracted report text');
  });
});
