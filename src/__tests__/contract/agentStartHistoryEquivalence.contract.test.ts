/**
 * Contract: a run whose history the sidecar reads from the ledger sees the
 * conversation a run that carried its history on the wire saw.
 *
 * Every conversation here is built through the real store actions and the real
 * `conversationStorage` module on an in-memory file system, so both views come
 * out of production code: the v1 view is
 * `prepareConversationSnapshotForSidecarWire` over the store's conversation,
 * the v2 view is the ledger's own bytes cut at the watermark
 * `takeLedgerHistoryPoint` returns, projected by `projectLedger` and cleaned by
 * `sanitizeLoadedLedgerMessages` — the three calls `sidecar/src/agentLoopHost.ts`
 * makes at `agent.start`. Nothing here builds an expected history by hand.
 *
 * The differences the two views are allowed to have are folded away by
 * `normalise`, and every scenario asserts the exact set of allowances it used,
 * so the fold cannot quietly become a blanket pass and every case stands on its
 * own when it is run alone. Everything else — order, ids, roles, text, tool
 * calls, the context projection, compaction boundary rows, the rows a
 * `msg.truncate` cut, the run states of finished turns, and every key of a
 * media block the fold does not name — is compared field by field.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, mkdir, readDir, readTextFile, remove, stat, writeTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { Conversation, Message } from '@/types';
import type { LoadedMessageSanitizerText } from '@/core/session/loadedMessageSanitizer';

vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ setWorkspace: vi.fn(), clearWorkspace: vi.fn() }),
    subscribe: vi.fn(),
  },
}));
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: { getState: () => ({ getProjectByWorkspace: () => undefined }) },
}));
vi.mock('@/core/agent/sidecarRunPredicate', () => ({
  isConversationRunningInSidecar: () => false,
  registerSidecarRunPredicate: () => {},
}));

/**
 * The delegated media store writes through the Electron host, which no unit
 * test has. The wire view only needs a `MediaRef` back; its identity is never
 * compared, because a ref and the ledger's own media block are compared by
 * media type (difference (a)/(c) below).
 */
let mediaCounter = 0;
vi.mock('@/core/subagent/delegatedMediaStore', () => ({
  persistDelegatedMedia: async (_conversationId: string, input: { mediaType: string; bytes: Uint8Array }) => {
    mediaCounter += 1;
    return {
      id: `media-${mediaCounter}`,
      sha256: 'a'.repeat(64),
      mediaType: input.mediaType,
      bytes: input.bytes.byteLength,
    };
  },
  readDelegatedMedia: async () => null,
}));

/** 1x1 PNG, the smallest real inline image. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PDF = 'JVBERi0xLjQK';
/** Filler timestamp (TESTING.md §3): ordering only, never asserted on. */
const T0 = 1_700_000_000_000;

type Mocked = ReturnType<typeof vi.fn>;

/**
 * The in-memory file system of `src/core/session/conversationStorage.test.ts`,
 * with `append_file_text` answered instead of refused so the ledger grows the
 * way the Electron host grows it.
 */
function installMemoryFs(): { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const writeToMemory = (path: string, content: string): void => {
    files.set(path, content);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  };

  (exists as unknown as Mocked).mockImplementation(async (path: string) => files.has(path) || dirs.has(path));

  (readTextFile as unknown as Mocked).mockImplementation(async (path: string) => {
    if (!files.has(path)) throw new Error(`File not found: ${path}`);
    return files.get(path)!;
  });

  (writeTextFile as unknown as Mocked).mockImplementation(async (path: string, content: string) => {
    writeToMemory(path, content);
  });

  (invoke as unknown as Mocked).mockImplementation(async (
    cmd: string,
    args?: { path?: string; content?: string; data?: string },
  ) => {
    if (cmd === 'append_file_text' && args?.path !== undefined) {
      writeToMemory(args.path, (files.get(args.path) ?? '') + (args.data ?? ''));
      return undefined;
    }
    if (cmd === 'atomic_write_text' && args?.path !== undefined) {
      writeToMemory(args.path, args.content ?? '');
      return undefined;
    }
    return undefined;
  });

  // `size` is the UTF-8 byte length, the unit a real file system reports and
  // the unit the ledger watermark is measured in.
  (stat as unknown as Mocked).mockImplementation(async (path: string) => {
    if (!files.has(path)) throw new Error(`File not found: ${path}`);
    return { size: new TextEncoder().encode(files.get(path)!).byteLength };
  });

  (mkdir as unknown as Mocked).mockImplementation(async (path: string) => {
    dirs.add(path);
  });

  (remove as unknown as Mocked).mockImplementation(async (path: string) => {
    for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
    dirs.delete(path);
  });

  (readDir as unknown as Mocked).mockImplementation(async (path: string) => {
    const entries: { name: string; isDirectory: boolean }[] = [];
    const seen = new Set<string>();
    for (const key of [...files.keys(), ...dirs]) {
      if (!key.startsWith(`${path}/`)) continue;
      const topLevel = key.slice(path.length + 1).split('/')[0];
      if (seen.has(topLevel)) continue;
      seen.add(topLevel);
      entries.push({ name: topLevel, isDirectory: dirs.has(`${path}/${topLevel}`) });
    }
    return entries;
  });

  return { files, dirs };
}

/**
 * The named differences, each recorded where it is observed. Each scenario
 * asserts the exact set it produced (`expectAllowancesSeen`), so an allowance
 * that stops occurring fails in the scenario that exists for it.
 *
 *  - `wireMediaRef` / `ledgerImageFilePath` — a user image travels as a
 *    `delegated_media_ref` on the wire and as `source.data: ''` plus the
 *    `filePath` the sidecar reads the bytes back from in the ledger.
 *  - `ledgerInlineDocument` — a document block keeps its inline base64 in the
 *    ledger view while the wire view hands over a media ref.
 *  - `resizeNotice` — `buildUserMessageContent` writes `resized` onto a
 *    downscaled user image; the wire form's media ref carries four keys only,
 *    so it is dropped there, while the ledger keeps it and the model is told
 *    the image was downscaled (`<image_resize_notice>` in `messageNormalizer`).
 *  - `bounded` — a tool result past the durable budget is the bounded one in
 *    the ledger view, which is what a restarted renderer loads too.
 *  - `isStreaming` — the sanitiser writes `isStreaming: false` on every row; a
 *    row in memory that never streamed carries no such key.
 *  - `pid` — the ledger line's parent id, written by `serializeLedgerPut` and
 *    read by nothing.
 */
interface Allowances {
  wireMediaRef: boolean;
  ledgerImageFilePath: boolean;
  ledgerInlineDocument: boolean;
  resizeNotice: boolean;
  bounded: boolean;
  isStreaming: boolean;
  pid: boolean;
}

function noAllowances(): Allowances {
  return {
    wireMediaRef: false,
    ledgerImageFilePath: false,
    ledgerInlineDocument: false,
    resizeNotice: false,
    bounded: false,
    isStreaming: false,
    pid: false,
  };
}

let seen = noAllowances();

/** Exactly these allowances were folded away in this scenario, and no others. */
function expectAllowancesSeen(...names: (keyof Allowances)[]): void {
  const expected = noAllowances();
  for (const name of names) expected[name] = true;
  expect(seen).toEqual(expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A media block with the named differences folded away and **every other key
 * kept**, so `name`, `outputRef` and anything else a block carries is still
 * compared. Folded: the payload (`source.data`), the path the sidecar reads it
 * back from (`filePath`), the ref's identity (`originConversationId` /
 * `attachment`, reduced to the media type the two sides share) and `resized`.
 *
 * `resized` is folded on every media block rather than only where the wire
 * form built a ref: this function sees one side at a time, and a ledger image
 * is `source.data: '' + filePath` whether its wire twin is a ref (a turn whose
 * bytes were still in memory) or a stripped image block (a reloaded row). The
 * scenario that owns the difference asserts the raw shapes on both sides.
 */
function mediaSignature(block: unknown): unknown {
  if (!isRecord(block)) return block;
  if (block.type === 'delegated_media_ref') {
    seen.wireMediaRef = true;
    const { type: _type, originConversationId: _origin, attachment, ...rest } = block;
    const mediaType = isRecord(attachment) ? attachment.mediaType : undefined;
    return { kind: 'media', mediaType, ...rest };
  }
  if ((block.type === 'image' || block.type === 'document') && isRecord(block.source)) {
    const source = block.source as { media_type?: string; data?: string };
    if (block.type === 'image' && source.data === '' && typeof block.filePath === 'string') {
      seen.ledgerImageFilePath = true;
    }
    if (block.type === 'document' && typeof source.data === 'string' && source.data !== '') {
      seen.ledgerInlineDocument = true;
    }
    const { type: _type, source: _source, filePath: _filePath, resized, ...rest } = block;
    if (resized !== undefined) seen.resizeNotice = true;
    return { kind: 'media', mediaType: source.media_type, ...rest };
  }
  return block;
}

function normaliseCalls(calls: unknown): unknown {
  if (!Array.isArray(calls)) return calls;
  return calls.map((call) => {
    const record = call as { resultContent?: unknown[] };
    return Array.isArray(record.resultContent)
      ? { ...record, resultContent: record.resultContent.map(mediaSignature) }
      : record;
  });
}

/** One message with the named differences folded away. */
function normalise(message: Message): unknown {
  const row = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  if ('pid' in row) {
    seen.pid = true;
    delete row.pid;
  }
  if (row.isStreaming === false) {
    seen.isStreaming = true;
    delete row.isStreaming;
  }
  if (Array.isArray(row.content)) row.content = row.content.map(mediaSignature);
  row.toolCalls = normaliseCalls(row.toolCalls);
  row.toolCallsForContext = normaliseCalls(row.toolCallsForContext);
  return JSON.parse(JSON.stringify(row));
}

interface Harness {
  files: Map<string, string>;
  store: typeof import('@/stores/chatStore');
  storage: typeof import('@/core/session/conversationStorage');
  /** The strings the renderer's own loader writes, so both sanitisers agree. */
  text: LoadedMessageSanitizerText;
}

async function freshHarness(): Promise<Harness> {
  const { files } = installMemoryFs();
  vi.resetModules();
  const store = await import('@/stores/chatStore');
  const storage = await import('@/core/session/conversationStorage');
  const { chat } = (await import('@/i18n')).getI18n();
  return {
    files,
    store,
    storage,
    text: { runRecoveredAfterRestart: chat.runRecoveredAfterRestart, errorEmptyBody: chat.errorEmptyBody },
  };
}

function addUserTurn(h: Harness, convId: string, id: string, content: Message['content'], at: number): void {
  h.store.useChatStore.getState().addMessage(convId, {
    id,
    role: 'user',
    content,
    timestamp: at,
    runState: 'completed',
    runEndedAt: at,
    loopId: `loop-${id}`,
  });
}

function addAnswer(h: Harness, convId: string, id: string, loopId: string, text: string, at: number): void {
  const actions = h.store.useChatStore.getState();
  actions.addMessage(convId, { id, role: 'assistant', content: '', timestamp: at, loopId, isStreaming: true });
  actions.setLastMessageContent(convId, text, id);
  actions.updateMessageUsage(convId, { inputTokens: 10, outputTokens: 5 }, id);
  actions.finishStreaming(convId, id);
}

/** The user row of the run being dispatched, in the routed form `buildAgentRunParams` leaves it in. */
async function dispatchRow(h: Harness, convId: string, runId: string, content: Message['content']): Promise<string> {
  const id = `msg-${runId}`;
  const actions = h.store.useChatStore.getState();
  actions.addMessage(convId, {
    id,
    clientMessageId: id,
    runId,
    runState: 'pending',
    role: 'user',
    content: typeof content === 'string' ? content : '原始输入',
    timestamp: T0 + 900,
    loopId: runId,
  });
  await h.store.waitForConversationPersistence(convId);
  actions.updateUserMessageRun(convId, id, { state: 'pending', content });
  await h.store.waitForConversationPersistence(convId);
  return id;
}

async function wireView(h: Harness, convId: string, bound: boolean): Promise<Message[]> {
  const { prepareConversationSnapshotForSidecarWire } = await import('@/core/subagent/delegatedUserTurnMaterializer');
  const { boundMessageToolResultContentForDisk } = await import('@/core/session/durableToolResultContent');
  const conversation = h.store.useChatStore.getState().conversations[convId] as Conversation;
  const source = bound
    ? { ...conversation, messages: conversation.messages.map(boundMessageToolResultContentForDisk) }
    : conversation;
  return (await prepareConversationSnapshotForSidecarWire(source)).messages;
}

/** What `sidecar/src/agentLoopHost.ts` hydrates a ledger start from. */
async function ledgerView(h: Harness, convId: string, currentRunMessageId: string): Promise<Message[]> {
  const { takeLedgerHistoryPoint } = await import('@/core/session/ledgerHistoryPoint');
  const { decodeLedgerPrefix, projectLedger } = await import('@/core/session/ledgerReader');
  const { sanitizeLoadedLedgerMessages } = await import('@/core/session/loadedMessageSanitizer');
  const { ledgerWatermark } = await takeLedgerHistoryPoint(convId);
  const path = [...h.files.keys()].find((key) => key.endsWith(`/${convId}/messages.jsonl`));
  if (!path) throw new Error(`no ledger file for ${convId}`);
  const bytes = new TextEncoder().encode(h.files.get(path)!);
  expect(ledgerWatermark).toBe(bytes.byteLength);
  const prefix = projectLedger({ ledgerText: decodeLedgerPrefix(bytes, ledgerWatermark) }).messages;
  return sanitizeLoadedLedgerMessages(prefix, { text: h.text, currentRunMessageId });
}

async function expectEquivalent(
  h: Harness,
  convId: string,
  currentRunMessageId: string,
): Promise<{ wire: Message[]; ledger: Message[] }> {
  const wire = await wireView(h, convId, true);
  const ledger = await ledgerView(h, convId, currentRunMessageId);
  expect(ledger.map((m) => m.id)).toEqual(wire.map((m) => m.id));
  expect(ledger.map(normalise)).toEqual(wire.map(normalise));
  return { wire, ledger };
}

describe('agent.start history: the wire snapshot and the ledger view agree (#549 P2a)', () => {
  // Every case imports chatStore afresh after `vi.resetModules()`. That resets
  // evaluated modules but not the transform cache, so the first import in a
  // worker also compiles the whole chatStore graph. Paying that once here puts
  // it under the hook budget; left to the first case, it lands inside a 5 s
  // test body whenever this file runs without a warm neighbour in its worker.
  beforeAll(async () => {
    await freshHarness();
  });

  beforeEach(() => {
    mediaCounter = 0;
    seen = noAllowances();
  });

  it('text turns with a tool call', async () => {
    const h = await freshHarness();
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    addUserTurn(h, convId, 'u1', '读一下 a.txt', T0);
    actions.addMessage(convId, { id: 'a1', role: 'assistant', content: '', timestamp: T0 + 1, loopId: 'loop-u1', isStreaming: true });
    actions.setMessageToolCalls(convId, 'a1', [{ id: 't1', name: 'read_file', input: { path: 'a.txt' }, isExecuting: true }]);
    actions.updateToolCall(convId, 'a1', 't1', '文件内容：你好');
    actions.appendToolCallContext(convId, 'loop-u1', { id: 't1', name: 'read_file', input: { path: 'a.txt' }, result: '文件内容：你好' });
    actions.setLastMessageContent(convId, '文件里写着「你好」。', 'a1');
    actions.updateMessageUsage(convId, { inputTokens: 10, outputTokens: 5 }, 'a1');
    actions.finishStreaming(convId, 'a1');
    await h.store.waitForConversationPersistence(convId);

    const current = await dispatchRow(h, convId, 'run-1', '再读一下 b.txt');
    const { ledger } = await expectEquivalent(h, convId, current);

    expect(ledger.map((m) => m.id)).toEqual(['u1', 'a1', current]);
    expect(ledger.at(-1)).toMatchObject({ runState: 'pending', content: '再读一下 b.txt' });
    expect(ledger[1].toolCallsForContext).toEqual([{ id: 't1', name: 'read_file', input: { path: 'a.txt' }, result: '文件内容：你好' }]);
    expectAllowancesSeen('isStreaming', 'pid');
  });

  it('edit-and-resend: rows cut by msg.truncate are in neither view', async () => {
    const h = await freshHarness();
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    addUserTurn(h, convId, 'u1', '第一问', T0);
    addAnswer(h, convId, 'a1', 'loop-u1', '第一答', T0 + 1);
    addUserTurn(h, convId, 'u2', '第二问（将被改写）', T0 + 2);
    addAnswer(h, convId, 'a2', 'loop-u2', '第二答（将被截掉）', T0 + 3);
    await h.store.waitForConversationPersistence(convId);
    actions.deleteMessagesFrom(convId, 'u2');
    await h.store.waitForConversationPersistence(convId);

    const current = await dispatchRow(h, convId, 'run-2', '第二问（改写后）');
    const { ledger } = await expectEquivalent(h, convId, current);

    expect(ledger.map((m) => m.id)).toEqual(['u1', 'a1', current]);
    expect(JSON.stringify(ledger)).not.toContain('将被截掉');
    expectAllowancesSeen('isStreaming', 'pid');
  });

  it('a compaction boundary row keeps its place and payload', async () => {
    const h = await freshHarness();
    const { createCompactBoundaryMarker } = await import('@/core/context/compactBoundary');
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    addUserTurn(h, convId, 'u1', '很早的问题', T0);
    addAnswer(h, convId, 'a1', 'loop-u1', '很早的回答', T0 + 1);
    const marker = createCompactBoundaryMarker({
      summaryText: '此前讨论了很早的问题。',
      summarizedFromId: 'u1',
      summarizedToId: 'a1',
      source: 'auto',
      timestamp: T0 + 2,
    });
    actions.addMessage(convId, marker);
    await h.store.waitForConversationPersistence(convId);

    const current = await dispatchRow(h, convId, 'run-3', '接着问');
    const { ledger } = await expectEquivalent(h, convId, current);

    expect(ledger.map((m) => m.id)).toEqual(['u1', 'a1', marker.id, current]);
    expect(ledger[2].compactBoundary).toEqual(marker.compactBoundary);
    expectAllowancesSeen('isStreaming', 'pid');
  });

  it("the new turn's image and PDF: a media ref on the wire, a file path and inline bytes in the ledger", async () => {
    const h = await freshHarness();
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG }, filePath: '/sessions/outputs/images/a.png' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, name: 'a.pdf' },
      { type: 'text', text: '看看这两个文件' },
    ] as Message['content'];

    const current = await dispatchRow(h, convId, 'run-4', content);
    const { wire, ledger } = await expectEquivalent(h, convId, current);

    const wireBlocks = wire.at(-1)!.content as { type: string }[];
    const ledgerBlocks = ledger.at(-1)!.content as { type: string; filePath?: string; source?: { data: string } }[];
    expect(wireBlocks.map((b) => b.type)).toEqual(['delegated_media_ref', 'delegated_media_ref', 'text']);
    expect(ledgerBlocks[0]).toMatchObject({ type: 'image', filePath: '/sessions/outputs/images/a.png', source: { data: '' } });
    expect(ledgerBlocks[1]).toMatchObject({ type: 'document', source: { data: PDF } });
    // The document's `name` is on both sides and is compared, not folded.
    expect((wire.at(-1)!.content as { name?: string }[])[1].name).toBe('a.pdf');
    expect((ledger.at(-1)!.content as { name?: string }[])[1].name).toBe('a.pdf');
    // No `pid`: the dispatch row is this conversation's first ledger line.
    expectAllowancesSeen('wireMediaRef', 'ledgerImageFilePath', 'ledgerInlineDocument', 'isStreaming');
  });

  it('a downscaled image: the wire ref drops `resized`, the ledger row keeps it', async () => {
    const h = await freshHarness();
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    const resized = { fromWidth: 4000, fromHeight: 3000, toWidth: 1568, toHeight: 1176 };
    const content = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG },
        filePath: '/sessions/outputs/images/big.png',
        resized,
      },
      { type: 'text', text: '这张图缩过' },
    ] as Message['content'];

    const current = await dispatchRow(h, convId, 'run-9', content);
    const { wire, ledger } = await expectEquivalent(h, convId, current);

    // The wire form's ref carries four keys only, so the flag cannot travel and
    // `messageNormalizer` emits no <image_resize_notice>; the ledger row keeps
    // it, so a run started from the ledger tells the model about the downscale.
    const wireBlock = (wire.at(-1)!.content as Record<string, unknown>[])[0];
    expect(wireBlock.type).toBe('delegated_media_ref');
    expect(wireBlock).not.toHaveProperty('resized');
    expect((ledger.at(-1)!.content as { resized?: unknown }[])[0].resized).toEqual(resized);
    // No `pid`: the dispatch row is this conversation's first ledger line.
    expectAllowancesSeen('wireMediaRef', 'ledgerImageFilePath', 'resizeNotice', 'isStreaming');
  });

  it('a reloaded history image: no path on the wire, the path in the ledger', async () => {
    const h = await freshHarness();
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    addUserTurn(h, convId, 'u1', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' }, filePath: '/sessions/outputs/images/old.png' },
      { type: 'text', text: '上次的图' },
    ] as Message['content'], T0);
    addAnswer(h, convId, 'a1', 'loop-u1', '看到了。', T0 + 1);
    await h.store.waitForConversationPersistence(convId);

    const current = await dispatchRow(h, convId, 'run-5', '那张图里有什么？');
    const { wire, ledger } = await expectEquivalent(h, convId, current);

    expect((wire[0].content as { filePath?: string }[])[0].filePath).toBeUndefined();
    expect((ledger[0].content as { filePath?: string }[])[0].filePath).toBe('/sessions/outputs/images/old.png');
    expectAllowancesSeen('ledgerImageFilePath', 'isStreaming', 'pid');
  });

  it('a tool result beyond the durable budget is the bounded one in both views', async () => {
    const h = await freshHarness();
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    addUserTurn(h, convId, 'u1', '跑一个输出很多的命令', T0);
    const huge = '输出'.repeat(200_000);
    actions.addMessage(convId, { id: 'a1', role: 'assistant', content: '', timestamp: T0 + 1, loopId: 'loop-u1', isStreaming: true });
    actions.setMessageToolCalls(convId, 'a1', [{ id: 't1', name: 'run_command', input: { command: 'big' }, isExecuting: true }]);
    actions.updateToolCall(convId, 'a1', 't1', huge);
    actions.appendToolCallContext(convId, 'loop-u1', { id: 't1', name: 'run_command', input: { command: 'big' }, result: huge });
    actions.setLastMessageContent(convId, '跑完了。', 'a1');
    actions.updateMessageUsage(convId, { inputTokens: 10, outputTokens: 5 }, 'a1');
    actions.finishStreaming(convId, 'a1');
    await h.store.waitForConversationPersistence(convId);

    const current = await dispatchRow(h, convId, 'run-6', '结果怎么样？');
    await expectEquivalent(h, convId, current);

    const unbounded = JSON.stringify((await wireView(h, convId, false)).map(normalise));
    const bounded = JSON.stringify((await wireView(h, convId, true)).map(normalise));
    seen.bounded ||= unbounded !== bounded;
    expect(unbounded).not.toBe(bounded);
    expectAllowancesSeen('bounded', 'isStreaming', 'pid');
  });

  it('a partial answer that lives only in the stream snapshot is in both views after the promotion', async () => {
    const h = await freshHarness();
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    addUserTurn(h, convId, 'u1', '写一首长诗', T0);
    actions.addMessage(convId, { id: 'a1', role: 'assistant', content: '', timestamp: T0 + 1, loopId: 'loop-u1', isStreaming: true });
    await h.store.waitForConversationPersistence(convId);
    actions.setLastMessageContent(convId, '床前明月光，疑是', 'a1');
    actions.setMessageStreamingFlag(convId, 'a1', false);
    const partial = h.store.useChatStore.getState().conversations[convId].messages.find((m) => m.id === 'a1')!;
    await h.storage.snapshotMessageRevision(convId, partial);

    const current = await dispatchRow(h, convId, 'run-7', '接着写');
    const { ledger } = await expectEquivalent(h, convId, current);

    expect(ledger.find((m) => m.id === 'a1')?.content).toBe('床前明月光，疑是');
    expectAllowancesSeen('isStreaming', 'pid');
  });

  it('a conversation reloaded from disk: the ghost row on disk is in neither view', async () => {
    const h = await freshHarness();
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    addUserTurn(h, convId, 'u1', '重启前的问题', T0);
    addAnswer(h, convId, 'a1', 'loop-u1', '重启前的回答', T0 + 1);
    await h.store.waitForConversationPersistence(convId);
    // The empty assistant placeholder a killed process left behind.
    await h.storage.appendMessage(convId, {
      id: 'ghost-1', role: 'assistant', content: '', timestamp: T0 + 2, loopId: 'loop-ghost', isStreaming: true,
    });
    await h.storage.flushWrites();

    // A relaunch: the index survives, the loaded conversations do not.
    h.store.useChatStore.setState((state) => {
      const conversations = { ...state.conversations };
      delete conversations[convId];
      return { conversations };
    });
    await h.store.useChatStore.getState().loadConversation(convId);
    await h.store.waitForConversationPersistence(convId);
    expect(h.store.useChatStore.getState().conversations[convId].messages.map((m) => m.id)).toEqual(['u1', 'a1']);

    const current = await dispatchRow(h, convId, 'run-8', '重启后的问题');
    const { ledger } = await expectEquivalent(h, convId, current);

    expect(ledger.map((m) => m.id)).toEqual(['u1', 'a1', current]);
    expectAllowancesSeen('isStreaming', 'pid');
  });

  /**
   * Why a positional index one run computed still points at the same rows in
   * the next one. `contextCache.summarizedRange` is a pair of indices into the
   * message list (`agentLoop.ts:1982` slices by it), and the list a run reads
   * on the ledger form is the sanitised ledger prefix, which drops
   * non-substantive assistant rows. Two facts keep the indices meaningful, and
   * both are asserted here:
   *
   *  1. a dispatch clears the conversation's `contextCache` before the snapshot
   *     the sidecar receives is taken (`chatStore.ts` `updateUserMessageRun`,
   *     which `buildAgentRunParams` calls just before reading the conversation),
   *     so no range ever crosses a dispatch at all;
   *  2. even if one did, the ledger view of a dispatch is a positional prefix
   *     of the next dispatch's — the ledger is append-only, the fold keeps a
   *     revised row in place, and a row the sanitiser drops is dropped at every
   *     watermark, so nothing shifts under an index.
   */
  it('a later dispatch sees the earlier one\'s history position for position, and carries no context cache', async () => {
    const h = await freshHarness();
    const actions = h.store.useChatStore.getState();
    const convId = actions.createConversation();
    addUserTurn(h, convId, 'u1', '第一问', T0);
    addAnswer(h, convId, 'a1', 'loop-u1', '第一答', T0 + 1);
    await h.store.waitForConversationPersistence(convId);
    // An assistant row a finished run left empty: dropped by the sanitiser at
    // every watermark, so it can never appear or disappear between dispatches.
    await h.storage.appendMessage(convId, {
      id: 'ghost-1', role: 'assistant', content: '', timestamp: T0 + 2, loopId: 'loop-ghost',
    });
    await h.storage.flushWrites();

    const summary: Message = { id: 'context-summary-1', role: 'user', content: '摘要', timestamp: T0 + 3 };
    actions.setContextCache(convId, {
      summaryMessage: summary,
      summarizedRange: [1, 2],
      messageCountAtCompression: 2,
    });

    const first = await dispatchRow(h, convId, 'run-10', '第二问');
    // Fact 1: the routed rewrite every dispatch performs clears the cache, so
    // `conversationSnapshot.contextCache` is undefined in the params that carry
    // this run — on either form.
    expect(h.store.useChatStore.getState().conversations[convId].contextCache).toBeUndefined();
    const { ledger: firstView } = await expectEquivalent(h, convId, first);
    expect(firstView.map((m) => m.id)).toEqual(['u1', 'a1', first]);

    // The run finishes and answers, then the user sends again.
    actions.updateUserMessageRun(convId, first, { state: 'completed' });
    addAnswer(h, convId, 'a2', first, '第二答', T0 + 10);
    await h.store.waitForConversationPersistence(convId);
    const second = await dispatchRow(h, convId, 'run-11', '第三问');
    const { ledger: secondView } = await expectEquivalent(h, convId, second);

    // Fact 2: position for position, the second run's history opens with the
    // first run's — the ghost row shifts nothing and the revised user row kept
    // its place.
    expect(secondView.map((m) => m.id).slice(0, firstView.length)).toEqual(firstView.map((m) => m.id));
    expect(secondView.map((m) => m.id)).toEqual(['u1', 'a1', first, 'a2', second]);
    expectAllowancesSeen('isStreaming', 'pid');
  });
});
