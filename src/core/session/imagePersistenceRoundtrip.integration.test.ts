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
import type { Message } from '../../types';

// Binary image read + snapshot resolution are mocked — this test targets the
// message-JSON persistence round-trip, not the image file bytes themselves.
const mockResolveFileSource = vi.fn();
vi.mock('./outputSnapshots', () => ({
  resolveFileSource: (...a: unknown[]) => mockResolveFileSource(...a),
}));

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
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: { path?: string; content?: string }) => {
    if (cmd === 'atomic_write_text' && args?.path) files.set(args.path, args.content ?? '');
    return undefined;
  }),
  transformCallback: vi.fn(),
}));

import { rehydrateForSend } from '../llm/imageRehydration';

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

describe('image persistence round-trip (persist → strip → reload → rehydrate)', () => {
  beforeEach(async () => {
    files.clear();
    mockResolveFileSource.mockReset();
    mockReadFileBinary.mockReset();
    vi.resetModules();
    storage = await import('./conversationStorage');
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

    mockResolveFileSource.mockResolvedValue({ status: 'available', path: '/real/shot.png', isFromSnapshot: false });
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

    mockResolveFileSource.mockResolvedValue({ status: 'missing', basename: 'shot.png', originalPath: 'D:/abu/shot.png' });

    const forSend = await rehydrateForSend(loaded, { vision: true, conversationId: 'conv-x', workspacePath: null });
    const content = forSend[0].content as Array<{ type: string; text?: string }>;

    expect(content.some((b) => b.type === 'image')).toBe(false); // no empty-data image survives
    expect(content.some((b) => b.type === 'text' && b.text?.includes('shot.png'))).toBe(true);
    expect(mockReadFileBinary).not.toHaveBeenCalled();
  });
});
