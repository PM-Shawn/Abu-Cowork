/**
 * A picture read_file derives from a file — a PDF page render, a region or
 * turned view, a picture inside an Office file, a scaled-down view — must come
 * back from disk as the same bytes the model was shown.
 *
 * The chain is the product's own: the tool batch records the result picture
 * (toolExecutor → snapshotResultImage), the conversation writer keeps the
 * message without the picture's bytes and points at that record (stripForDisk
 * → outputRef), and the next turn reads history back and refills the bytes
 * before sending (loadMessages → rehydrateForSend).
 *
 * The record once copied the file at read_file's `path` instead of the bytes
 * the tool returned, so a scanned PDF came back as the PDF itself under
 * image/jpeg and every later request of the conversation was refused
 * ("unsupported image").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolCall, ToolExecutionContext, ToolResultContent } from '@/types';
import type { EventRouter } from '@/core/agent/eventRouter';
import type { ToolInvoker } from '@/core/agent/ports/toolInvoker';

// ── One in-memory disk under every module of the chain ─────────────────────
const disk = new Map<string, Uint8Array>();
const dirs = new Set<string>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function addParents(path: string): void {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
}

function put(path: string, bytes: Uint8Array): void {
  disk.set(path, bytes);
  addParents(path);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async (path: string) => disk.has(path) || dirs.has(path)),
  readTextFile: vi.fn(async (path: string) => {
    const bytes = disk.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return decoder.decode(bytes);
  }),
  readFile: vi.fn(async (path: string) => {
    const bytes = disk.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return bytes.slice();
  }),
  writeTextFile: vi.fn(async (path: string, text: string, options?: { append?: boolean }) => {
    const next = encoder.encode(text);
    put(path, options?.append && disk.has(path) ? concat(disk.get(path)!, next) : next);
  }),
  writeFile: vi.fn(async (path: string, bytes: Uint8Array) => { put(path, bytes.slice()); }),
  copyFile: vi.fn(async (from: string, to: string) => {
    const bytes = disk.get(from);
    if (!bytes) throw new Error(`ENOENT: ${from}`);
    put(to, bytes.slice());
  }),
  stat: vi.fn(async (path: string) => {
    const bytes = disk.get(path);
    if (!bytes) throw new Error(`ENOENT: ${path}`);
    return { isFile: true, isDirectory: false, isSymlink: false, size: bytes.length, mtime: new Date(1_700_000_000_000), atime: null, birthtime: null };
  }),
  mkdir: vi.fn(async (path: string) => { dirs.add(path); addParents(path); }),
  remove: vi.fn(async (path: string) => {
    for (const key of [...disk.keys()]) if (key === path || key.startsWith(`${path}/`)) disk.delete(key);
  }),
  readDir: vi.fn(async () => []),
  rename: vi.fn(async (from: string, to: string) => {
    const bytes = disk.get(from);
    if (!bytes) throw new Error(`ENOENT: ${from}`);
    put(to, bytes);
    disk.delete(from);
  }),
  watch: vi.fn(async () => () => {}),
  BaseDirectory: { AppData: 0, Home: 1 },
}));

// The conversation writer appends through atomic whole-file writes here.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: { path?: string; content?: string }) => {
    if (cmd === 'append_file_text') throw new Error('native append unavailable in test');
    if (cmd === 'atomic_write_text' && args?.path) put(args.path, encoder.encode(args.content ?? ''));
    return undefined;
  }),
  transformCallback: vi.fn(),
}));

// ── The tool batch's surroundings, as toolExecutor.test.ts stubs them ──────
const updateToolCall = vi.hoisted(() => vi.fn());

vi.mock('@/core/agent/ports/chatDelta', () => ({
  getChatDelta: () => ({
    updateToolCall,
    checkpointToolCallMetadata: vi.fn(),
    setMessageToolCalls: vi.fn(),
    setAgentStatus: vi.fn(),
  }),
}));
vi.mock('@/core/agent/lifecycleHooks', () => ({ emitHook: vi.fn(async () => ({ blocked: false })) }));
vi.mock('@/core/agent/planMode', () => ({ getPlanMode: () => 'off', evaluatePlanGate: () => ({ allow: true }) }));
vi.mock('@/core/session/sessionMemory', () => ({
  writeToolResultFile: async (conversationId: string, toolCallId: string) => `/data/conversations/${conversationId}/results/${toolCallId}.txt`,
}));
vi.mock('@/core/tools/builtins', () => ({ setComputerUseBatchMode: vi.fn(), setSkipAutoScreenshot: vi.fn() }));
vi.mock('@/core/agent/computerUseStatus', () => ({
  setComputerUseActive: vi.fn(),
  incrementComputerUseStep: vi.fn(),
  setCurrentAction: vi.fn(),
  isSessionWindowHidden: () => false,
  setSessionWindowHidden: vi.fn(),
  pauseComputerUseStatus: vi.fn(),
}));
vi.mock('@/core/agent/permissionBridge', () => ({ setLoopContext: vi.fn(), clearLoopContext: vi.fn() }));
vi.mock('@/core/agent/ports/conversationReader', () => ({
  getConversationReader: () => ({ getConversation: () => ({ workspacePath: null }) }),
}));
vi.mock('@/core/observability/langfuse', () => ({ startToolSpan: () => ({ end: vi.fn() }) }));

const CONV = 'conv-scan';
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A JPEG as a renderer writes one: SOI, JFIF, then body bytes. */
function jpegBytes(seed: number): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
  return Uint8Array.from([...head, ...Array.from({ length: 300 }, (_, i) => (i * 7 + seed) & 0xff), 0xff, 0xd9]);
}

function pngBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 500 }, (_, i) => i & 0xff)]);
}

function toolCallFor(id: string, input: Record<string, unknown>): ToolCall {
  return { id, name: 'read_file', input, isExecuting: true };
}

function batchParams(toolCall: ToolCall, result: ToolResultContent[]) {
  const invoker: ToolInvoker = {
    getAllTools: () => [],
    executeAnyTool: vi.fn(async () => result),
    toolResultToString: (value) => String(value),
  };
  return {
    collectedToolCalls: [toolCall],
    toolCallToStepId: new Map<string, string>(),
    conversationId: CONV,
    assistantMsgId: 'a1',
    loopId: 'loop-1',
    abortController: new AbortController(),
    eventRouter: { route: vi.fn() } as unknown as EventRouter,
    executionId: 'exec-1',
    inputValidators: new Map<string, (input: Record<string, unknown>) => boolean>(),
    confirmCb: async () => true,
    filePermCb: async () => true,
    toolContext: {} as ToolExecutionContext,
    toolInvoker: invoker,
    settingsReader: { getSnapshot: () => ({}) as never },
    continueLoop: true,
  };
}

interface Case {
  name: string;
  path: string;
  input: Record<string, unknown>;
  /** What is on disk at `path`. */
  file: Uint8Array;
  caption: string;
}

const CASES: Case[] = [
  {
    name: 'a scanned PDF page render',
    path: '/work/小票扫描.pdf',
    input: { path: '/work/小票扫描.pdf' },
    file: encoder.encode(`%PDF-1.4\n%\u00e2\u00e3\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${'0'.repeat(400)}`),
    caption: '[Page 1 of 小票扫描.pdf, whole page, 1035×1427 px]',
  },
  {
    name: 'a region of a PDF page',
    path: '/work/小票扫描.pdf',
    input: { path: '/work/小票扫描.pdf', pages: '1', region: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.3 } },
    file: encoder.encode(`%PDF-1.4\n${'1'.repeat(400)}`),
    caption: '[Page 1 of 小票扫描.pdf, region x 0.1–0.4, y 0.1–0.3, 1643×1450 px]',
  },
  {
    name: 'a picture inside a Word file',
    path: 'D:\\工作\\报告.docx',
    input: { path: 'D:\\工作\\报告.docx', image_index: 1 },
    file: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 400 }, (_, i) => i & 0xff)]),
    caption: '[Image 1 of 报告.docx, 800×600 px]',
  },
  {
    name: 'a turned region of a PNG picture',
    path: '/work/白板.png',
    input: { path: '/work/白板.png', region: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, rotate: 90 },
    file: pngBytes(),
    caption: '[白板.png, region x 0–0.5, y 0–0.5, turned 90°, 1600×1200 px]',
  },
  {
    name: 'a scaled-down view of a large photo',
    path: '/work/现场照片.jpg',
    input: { path: '/work/现场照片.jpg' },
    file: jpegBytes(99),
    caption: '[现场照片.jpg, 6000×4000 px, shown at 1600×1067 px]',
  },
];

describe('a derived picture survives persist → reload → rehydrate as the picture the model saw', () => {
  let storage: typeof import('@/core/session/conversationStorage');
  let snapshots: typeof import('@/core/session/outputSnapshots');
  let rehydrateForSend: typeof import('@/core/llm/imageRehydration').rehydrateForSend;
  let executeToolBatch: typeof import('@/core/agent/toolExecutor').executeToolBatch;

  beforeEach(async () => {
    disk.clear();
    dirs.clear();
    updateToolCall.mockReset();
    vi.resetModules();
    storage = await import('@/core/session/conversationStorage');
    snapshots = await import('@/core/session/outputSnapshots');
    snapshots.__testing.resetCaches();
    ({ rehydrateForSend } = await import('@/core/llm/imageRehydration'));
    ({ executeToolBatch } = await import('@/core/agent/toolExecutor'));
  });

  it.each(CASES)('$name', async ({ path, input, file, caption }) => {
    put(path, file);
    const shown = b64(jpegBytes(3));
    const result: ToolResultContent[] = [
      { type: 'text', text: caption },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shown } },
    ];
    const toolCall = toolCallFor('toolu_1_0', input);

    await executeToolBatch(batchParams(toolCall, result));

    // The tool batch records the picture without waiting for the write.
    await vi.waitFor(async () => {
      await snapshots.refreshOutputManifest(CONV);
      expect(snapshots.findToolResultImageSnapshot(CONV, toolCall.id)).not.toBeNull();
    });

    const resultContent = updateToolCall.mock.calls[0][4] as ToolResultContent[];
    const message: Message = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      toolCalls: [{ ...toolCall, isExecuting: false, result: caption, resultContent }],
      toolCallsForContext: [{ id: toolCall.id, name: toolCall.name, input, result: caption, resultContent }],
    } as Message;
    await storage.appendMessage(CONV, message);
    await storage.flushWrites();

    // The next turn reads history back from disk: the picture is stored by reference only.
    const [loaded] = await storage.loadMessages(CONV);
    const stored = loaded.toolCallsForContext![0].resultContent![1];
    expect(stored.type === 'image' && stored.source.data).toBe('');
    expect(stored.type === 'image' && stored.outputRef?.relPath).toBeTruthy();

    const [sent] = await rehydrateForSend([loaded], { vision: true, conversationId: CONV, workspacePath: null });
    for (const call of [sent.toolCallsForContext![0], sent.toolCalls![0]]) {
      const image = call.resultContent![1];
      expect(image.type).toBe('image');
      if (image.type === 'image') {
        expect(image.source.media_type).toBe('image/jpeg');
        expect(image.source.data).toBe(shown);
      }
    }
  });

  it('keeps the picture of a later read when the file at the same path has changed since', async () => {
    const path = '/work/小票扫描.pdf';
    put(path, encoder.encode('%PDF-1.4\nfirst version'));
    const first = b64(jpegBytes(1));
    const second = b64(jpegBytes(2));
    const read = (data: string): ToolResultContent[] => [
      { type: 'text', text: '[Page 1 of 小票扫描.pdf, whole page, 1035×1427 px]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
    ];

    await executeToolBatch(batchParams(toolCallFor('toolu_1_0', { path }), read(first)));
    put(path, encoder.encode('%PDF-1.4\nsecond version, a different scan'));
    await executeToolBatch(batchParams(toolCallFor('toolu_2_0', { path }), read(second)));
    await vi.waitFor(async () => {
      await snapshots.refreshOutputManifest(CONV);
      expect(snapshots.findToolResultImageSnapshot(CONV, 'toolu_1_0')).not.toBeNull();
      expect(snapshots.findToolResultImageSnapshot(CONV, 'toolu_2_0')).not.toBeNull();
    });

    const messages = updateToolCall.mock.calls.map((args, i): Message => ({
      id: `a${i}`,
      role: 'assistant',
      content: '',
      timestamp: i + 1,
      toolCallsForContext: [{ id: args[2] as string, name: 'read_file', input: { path }, result: 'read', resultContent: args[4] as ToolResultContent[] }],
    }) as Message);
    for (const message of messages) await storage.appendMessage(CONV, message);
    await storage.flushWrites();

    const sent = await rehydrateForSend(await storage.loadMessages(CONV), { vision: true, conversationId: CONV, workspacePath: null });
    const data = sent.map((m) => {
      const image = m.toolCallsForContext![0].resultContent![1];
      return image.type === 'image' ? image.source.data : null;
    });
    expect(data).toEqual([first, second]);
  });
});
