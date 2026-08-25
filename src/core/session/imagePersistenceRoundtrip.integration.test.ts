/**
 * Image persistence round-trip — integration test.
 *
 * Reproduces the real bug mechanism end-to-end through the ACTUAL storage code
 * (not a hand-built stripped message): persist a user message carrying an image
 * → stripForDisk clears its base64 on disk → reload after "restart" yields an
 * empty-data image with only filePath → rehydrateForSend must refill the base64
 * (vision model) or degrade to a placeholder (unrecoverable), so the send path
 * NEVER emits `data:<mime>;base64,` (empty) again.
 *
 * See project-image-empty-base64-after-reload-bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, ToolResultContent } from '../../types';
import type { ExecutionStep } from '../../types/execution';

// One in-memory fs backing both conversationStorage (text/JSONL) and the
// rehydration binary read. appDataDir/join stay on the global setup.ts mocks.
const files = new Map<string, string>();
const mockReadFileBinary = vi.fn();
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async (p: string) => files.has(p)),
  readTextFile: vi.fn(async (p: string) => {
    if (!files.has(p)) throw new Error(`not found: ${p}`);
    return files.get(p)!;
  }),
  writeTextFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
  readDir: vi.fn(async () => []),
  mkdir: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  watch: vi.fn(async () => () => {}),
  readFile: (...a: unknown[]) => mockReadFileBinary(...a),
  BaseDirectory: { AppData: 0, Home: 1 },
}));

// conversationStorage writes via atomicWrite → invoke('atomic_write_text').
// appendToFile (Part B1) tries native invoke('append_file_text') first; reject
// it here so this test keeps exercising the read+atomic-write fallback path
// its assertions were written against.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: { path?: string; content?: string }) => {
    if (cmd === 'append_file_text') throw new Error('native append unavailable in test');
    if (cmd === 'atomic_write_text' && args?.path) files.set(args.path, args.content ?? '');
    return undefined;
  }),
  transformCallback: vi.fn(),
}));

import { rehydrateForSend } from '../llm/imageRehydration';
import { backfillDetailBlockImages } from '../agent/executionSnapshot';

let storage: typeof import('./conversationStorage');

function messageWithImage(): Message {
  return {
    id: 'u1', role: 'user', timestamp: 1,
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ORIGINALBASE64==' }, filePath: 'D:/abu/shot.png' },
      { type: 'text', text: '看看这张图' },
    ],
  } as Message;
}

function imageBlockOf(m: Message) {
  return (m.content as Array<{ type: string; source?: { data: string }; filePath?: string }>)
    .find((b) => b.type === 'image');
}

function writeOutputManifest(convId: string, manifest: unknown) {
  files.set(`/Users/testuser/.abu/conversations/${convId}/outputs/manifest.json`, JSON.stringify(manifest));
}

function toolImageContent(base64 = 'A'.repeat(4096)): ToolResultContent[] {
  return [
    { type: 'text', text: 'Image: /tmp/result.png (4KB, image/png)' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
  ];
}

function assistantWithToolResultImage(): Message {
  const resultContent = toolImageContent();
  const contextResultContent = toolImageContent();
  return {
    id: 'a-tool-image',
    role: 'assistant',
    timestamp: 2,
    content: '',
    toolCalls: [{
      id: 'toolu_result_image',
      name: 'read_file',
      input: { path: '/tmp/result.png' },
      result: 'Image: /tmp/result.png (4KB, image/png)',
      resultContent,
    }],
    toolCallsForContext: [{
      id: 'toolu_result_image',
      name: 'read_file',
      input: { path: '/tmp/result.png' },
      result: 'Image: /tmp/result.png (4KB, image/png)',
      resultContent: contextResultContent,
    }],
    executionSteps: [{
      id: 'step-image',
      toolCallId: 'toolu_result_image',
      type: 'file-read',
      label: 'Read result.png',
      status: 'completed',
      toolName: 'read_file',
      detailBlocks: [{
        id: 'step-image-image',
        title: 'Image',
        type: 'image',
        content: 'Image: /tmp/result.png (4KB, image/png)',
      }],
    }],
  } as Message;
}

describe('image persistence round-trip (persist → strip → reload → rehydrate)', () => {
  beforeEach(async () => {
    files.clear();
    mockReadFileBinary.mockReset();
    vi.resetModules();
    storage = await import('./conversationStorage');
    const outputSnapshots = await import('./outputSnapshots');
    outputSnapshots.__testing.resetCaches();
  });

  it('real persist strips base64; reload leaves it empty (bug precondition)', async () => {
    await storage.appendMessage('conv-x', messageWithImage());
    await storage.flushWrites();

    const loaded = await storage.loadMessages('conv-x');
    const img = imageBlockOf(loaded[0]);

    expect(img).toBeDefined();
    expect(img!.source!.data).toBe('');            // stripForDisk cleared it on the real write path
    expect(img!.filePath).toBe('D:/abu/shot.png'); // only the disk reference survived
  });

  it('rehydrateForSend refills the reloaded empty image for a vision model', async () => {
    await storage.appendMessage('conv-x', messageWithImage());
    await storage.flushWrites();
    const loaded = await storage.loadMessages('conv-x');

    files.set('D:/abu/shot.png', 'binary');
    mockReadFileBinary.mockResolvedValue(new Uint8Array([137, 80, 78, 71])); // \x89PNG

    const forSend = await rehydrateForSend(loaded, { vision: true, conversationId: 'conv-x', workspacePath: null });
    const img = imageBlockOf(forSend[0]);

    expect(img!.source!.data).toBe('iVBORw=='); // refilled — no empty base64 leaves the app
    expect(img!.source!.data).not.toBe('');
  });

  it('degrades a reloaded image whose file is gone to a text placeholder (never empty base64)', async () => {
    await storage.appendMessage('conv-x', messageWithImage());
    await storage.flushWrites();
    const loaded = await storage.loadMessages('conv-x');

    const forSend = await rehydrateForSend(loaded, { vision: true, conversationId: 'conv-x', workspacePath: null });
    const content = forSend[0].content as Array<{ type: string; text?: string }>;

    expect(content.some((b) => b.type === 'image')).toBe(false); // no empty-data image survives
    expect(content.some((b) => b.type === 'text' && b.text?.includes('shot.png'))).toBe(true);
    expect(mockReadFileBinary).not.toHaveBeenCalled();
  });

  it('round-trips a dehydrated tool-result image through storage, replay backfill, and send rehydration', async () => {
    writeOutputManifest('conv-x', {
      version: 1,
      entries: {
        'tool-result://toolu_result_image': {
          originalPath: 'tool-result://toolu_result_image',
          basename: 'result.png',
          snapshotRelPath: 'files/toolhash/result.png',
          size: 4,
          originalMtime: 0,
          snapshottedAt: 1_700_000_000_000,
          source: 'tool-output',
          refId: 'toolu_result_image',
          refKind: 'result-image',
        },
      },
    });
    const live = assistantWithToolResultImage();

    await storage.appendMessage('conv-x', live);
    await storage.flushWrites();

    const liveToolImage = live.toolCalls![0].resultContent![1];
    const liveContextImage = live.toolCallsForContext![0].resultContent![1];
    expect(liveToolImage.type).toBe('image');
    expect(liveContextImage.type).toBe('image');
    if (liveToolImage.type === 'image') expect(liveToolImage.source.data).toBe('A'.repeat(4096));
    if (liveContextImage.type === 'image') expect(liveContextImage.source.data).toBe('A'.repeat(4096));

    const rawLine = files.get('/Users/testuser/.abu/conversations/conv-x/messages.jsonl') ?? '';
    expect(rawLine.length).toBeLessThan(2000);
    expect(rawLine).not.toContain('A'.repeat(4096));

    const [loaded] = await storage.loadMessages('conv-x');
    const loadedToolImage = loaded.toolCalls![0].resultContent![1];
    const loadedContextImage = loaded.toolCallsForContext![0].resultContent![1];
    expect(loadedToolImage.type).toBe('image');
    expect(loadedContextImage.type).toBe('image');
    if (loadedToolImage.type === 'image') {
      expect(loadedToolImage.source.data).toBe('');
      expect(loadedToolImage.outputRef).toEqual({
        relPath: 'files/toolhash/result.png',
        basename: 'result.png',
        sizeBytes: 4,
      });
    }
    if (loadedContextImage.type === 'image') {
      expect(loadedContextImage.source.data).toBe('');
      expect(loadedContextImage.outputRef?.relPath).toBe('files/toolhash/result.png');
    }

    const replaySteps: ExecutionStep[] = [{
      id: 'step-image',
      executionId: '',
      toolCallId: 'toolu_result_image',
      type: 'file-read',
      label: 'Read result.png',
      status: 'completed',
      toolName: 'read_file',
      toolInput: {},
      source: 'agent',
      detailBlocks: [{
        id: 'step-image-image',
        stepId: 'step-image',
        type: 'image',
        label: 'Image',
        content: 'Image: /tmp/result.png (4KB, image/png)',
        isTruncated: false,
        isExpanded: false,
      }],
    }];
    const backfilled = backfillDetailBlockImages(replaySteps, [loaded]);
    expect(backfilled[0].detailBlocks[0].imageData).toEqual({
      mediaType: 'image/png',
      outputRef: {
        relPath: 'files/toolhash/result.png',
        basename: 'result.png',
        sizeBytes: 4,
      },
    });

    files.set('/Users/testuser/.abu/conversations/conv-x/outputs/files/toolhash/result.png', 'binary');
    mockReadFileBinary.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));

    const forSend = await rehydrateForSend([loaded], { vision: true, conversationId: 'conv-x', workspacePath: null });
    const sentContextImage = forSend[0].toolCallsForContext![0].resultContent![1];
    const sentToolImage = forSend[0].toolCalls![0].resultContent![1];
    expect(sentContextImage.type).toBe('image');
    expect(sentToolImage.type).toBe('image');
    if (sentContextImage.type === 'image') expect(sentContextImage.source.data).toBe('iVBORw==');
    if (sentToolImage.type === 'image') expect(sentToolImage.source.data).toBe('iVBORw==');

    const loadedContextStillStripped = loaded.toolCallsForContext![0].resultContent![1];
    expect(loadedContextStillStripped.type).toBe('image');
    if (loadedContextStillStripped.type === 'image') expect(loadedContextStillStripped.source.data).toBe('');
  });
});
