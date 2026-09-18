/**
 * `agent.start` with a ledger history, against real files on disk.
 *
 * `agentLoopHost.test.ts` mocks the read so it can drive its timing and its
 * failures; this file leaves the reader in place and writes the conversation's
 * `messages.jsonl` and `stream-snapshot.json` the way the shell writes them, so
 * the watermark arithmetic, the ledger events and the snapshot rule are pinned
 * on the bytes themselves.
 *
 * Real temp files, like the other sidecar tests that touch the conversation
 * directory. `appDataDir` is answered from one directory for the whole file:
 * the reader resolves its base path once and caches it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = { path: '' };
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => root.path }));

const runAgentLoopMock = vi.hoisted(() => vi.fn());
vi.mock('@/core/agent/agentLoop', () => ({ runAgentLoop: (...a: unknown[]) => runAgentLoopMock(...a) }));
vi.mock('./rpcClient', () => ({
  sendRequest: vi.fn(),
  sendNotification: vi.fn(),
  setPreRequestFlush: vi.fn(),
}));
vi.mock('./runtimeTrace', () => ({
  traceSidecarRuntimeEvent: vi.fn(),
  sidecarRuntimeErrorType: (error: unknown) => (error instanceof Error ? error.name.toLowerCase() : typeof error),
}));
vi.mock('./localTools', () => ({
  hasLocalTool: vi.fn(),
  isLocalToolReadOnly: vi.fn(),
  executeLocalTool: vi.fn(),
}));

import {
  buildAgentRunPayloadDigest,
  handleAgentRun,
  handleAgentStart,
  __resetAgentRunRegistryForTests,
} from './agentLoopHost';
import { getCurrentAgentRunContext } from './agentRunContext';

function line(row: Record<string, unknown>): string {
  return JSON.stringify(row) + '\n';
}

function currentRow(runId: string): Record<string, unknown> {
  return {
    id: `msg-${runId}`,
    clientMessageId: `msg-${runId}`,
    role: 'user',
    content: '这一轮的问题',
    timestamp: 99,
    runId,
    loopId: runId,
    runState: 'pending',
  };
}

async function seed(convId: string, ledgerText: string | null, snapshotText?: string): Promise<void> {
  const dir = join(root.path, 'conversations', convId);
  await mkdir(dir, { recursive: true });
  if (ledgerText !== null) await writeFile(join(dir, 'messages.jsonl'), ledgerText, 'utf-8');
  if (snapshotText !== undefined) await writeFile(join(dir, 'stream-snapshot.json'), snapshotText, 'utf-8');
}

function startParams(runId: string, ledgerWatermark: number) {
  const clientMessageId = `msg-${runId}`;
  const conversationId = `conv-${runId}`;
  const body = {
    runId,
    clientMessageId,
    conversationId,
    userMessage: '这一轮的问题',
    options: { prePersistedUserMessageId: clientMessageId },
    orchestration: { route: { type: 'chat', cleanInput: '这一轮的问题' }, systemPromptSections: [] },
    conversationSnapshot: { id: conversationId, title: 'T', messages: [], createdAt: 0, updatedAt: 0, status: 'idle' },
    settingsSnapshot: { activeModel: { providerId: 'p', modelId: 'm' } },
    resolvedCreds: { apiKey: 'sk-test', baseUrl: undefined, forceOpenAiCompatible: false },
    toolList: [],
    locale: 'zh-CN',
    history: { source: 'ledger', ledgerWatermark },
  };
  return { ...body, payloadDigest: buildAgentRunPayloadDigest(body) };
}

/** Start the run and return the messages its loop reads from the hydrated snapshot. */
async function hydratedMessages(params: ReturnType<typeof startParams>): Promise<Record<string, unknown>[]> {
  await handleAgentStart(params);
  let seen: unknown[] = [];
  runAgentLoopMock.mockImplementation(async () => {
    seen = getCurrentAgentRunContext().conversationReader.getConversation(params.conversationId)?.messages ?? [];
    return { reason: 'completed' };
  });
  await handleAgentRun({
    runId: params.runId,
    clientMessageId: params.clientMessageId,
    payloadDigest: params.payloadDigest,
  });
  return JSON.parse(JSON.stringify(seen));
}

async function rejectionOf(run: () => unknown): Promise<{ code: number; data: unknown }> {
  try {
    await run();
  } catch (err) {
    return err as { code: number; data: unknown };
  }
  throw new Error('expected a rejection');
}

describe('agent.start hydration from a real ledger file', () => {
  beforeAll(async () => {
    root.path = await mkdtemp(join(tmpdir(), 'abu-agent-start-ledger-'));
  });
  afterAll(async () => {
    await rm(root.path, { recursive: true, force: true });
  });
  beforeEach(() => {
    runAgentLoopMock.mockReset();
    __resetAgentRunRegistryForTests();
  });

  it('cuts the history at the byte watermark, drops the ghost row, and keeps this run\'s own pending row', async () => {
    const runId = 'real-prefix';
    const kept = [
      line({ id: 'u0', role: 'user', content: '很早以前的问题', timestamp: 1, runState: 'accepted' }),
      line({ id: 'g0', role: 'assistant', content: '', timestamp: 2, isStreaming: true }),
      line({ id: 'a0', role: 'assistant', content: '很早以前的回答', timestamp: 3 }),
      line(currentRow(runId)),
    ].join('');
    const afterTheWatermark = line({ id: 'later', role: 'user', content: '水位之后写入的一行', timestamp: 100 });
    await seed(`conv-${runId}`, kept + afterTheWatermark);

    const upto = Buffer.byteLength(kept, 'utf8');
    // The cut is a BYTE offset: this prefix is longer in bytes than in
    // characters, so a character count would land inside a line.
    expect(upto).toBeGreaterThan(kept.length);

    const messages = await hydratedMessages(startParams(runId, upto));
    expect(messages.map((m) => [m.id, m.runState ?? null])).toEqual([
      ['u0', 'failed'],
      ['a0', null],
      [`msg-${runId}`, 'pending'],
    ]);
  });

  it('applies a msg.truncate inside the prefix', async () => {
    const runId = 'real-truncate';
    const ledger = [
      line({ id: 'u0', role: 'user', content: '第一句', timestamp: 1, runState: 'completed' }),
      line({ id: 'a0', role: 'assistant', content: '被删掉的回复', timestamp: 2 }),
      line({ lk: 'msg.truncate', id: 'ev1', role: 'system', content: '', isSystem: true, timestamp: 3, from: 'a0' }),
      line(currentRow(runId)),
    ].join('');
    await seed(`conv-${runId}`, ledger);

    const messages = await hydratedMessages(startParams(runId, Buffer.byteLength(ledger, 'utf8')));
    expect(messages.map((m) => m.id)).toEqual(['u0', `msg-${runId}`]);
  });

  it('does not merge a stream snapshot into a watermarked start', async () => {
    const runId = 'real-snapshot';
    const ledger = [
      line({ id: 'a0', role: 'assistant', content: '账本里的回答', timestamp: 1 }),
      line(currentRow(runId)),
    ].join('');
    // Stamped at the full ledger length, so a read without a watermark would
    // put this revision in place of the ledger's own `a0`.
    const snapshot = JSON.stringify({
      version: 2,
      ledgerBytes: ledger.length,
      entries: [
        { message: { id: 'a0', role: 'assistant', content: '快照里的回答', timestamp: 1 }, stamp: ledger.length },
      ],
    });
    await seed(`conv-${runId}`, ledger, snapshot);

    const messages = await hydratedMessages(startParams(runId, Buffer.byteLength(ledger, 'utf8')));
    expect(messages.map((m) => m.content)).toEqual(['账本里的回答', '这一轮的问题']);
  });

  it('refuses a watermark one byte short of a line end', async () => {
    const runId = 'real-short';
    const ledger = line(currentRow(runId));
    await seed(`conv-${runId}`, ledger);
    const fileBytes = Buffer.byteLength(ledger, 'utf8');

    const rejected = await rejectionOf(() => handleAgentStart(startParams(runId, fileBytes - 1)));
    expect(rejected.code).toBe(-32010);
    expect(rejected.data).toEqual({
      code: 'history_unavailable',
      reason: 'watermark_not_at_line_end',
      uptoBytes: fileBytes - 1,
      fileBytes,
    });
  });

  it('refuses a watermark above zero on a conversation that has no ledger file', async () => {
    const runId = 'real-missing';
    await seed(`conv-${runId}`, null);

    const rejected = await rejectionOf(() => handleAgentStart(startParams(runId, 64)));
    expect(rejected.data).toEqual({
      code: 'history_unavailable',
      reason: 'watermark_beyond_file',
      uptoBytes: 64,
      fileBytes: 0,
    });
  });

  it('a zero watermark on a conversation that has no ledger file is a missing current turn', async () => {
    const runId = 'real-empty';
    await seed(`conv-${runId}`, null);

    const rejected = await rejectionOf(() => handleAgentStart(startParams(runId, 0)));
    expect(rejected.data).toEqual({
      code: 'history_unavailable',
      reason: 'current_turn_missing',
      uptoBytes: 0,
      fileBytes: 0,
    });
  });
});
