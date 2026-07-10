import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../types';

// Mock the disk layer the rehydrator depends on.
const mockResolveFileSource = vi.fn();
vi.mock('../session/outputSnapshots', () => ({
  resolveFileSource: (...args: unknown[]) => mockResolveFileSource(...args),
}));

const mockReadFile = vi.fn();
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

import { rehydrateImageData, rehydrateForSend } from './imageRehydration';

/** A user message whose image was stripped on persist (data:'' + filePath kept). */
function strippedImageMessage(filePath = 'D:/abu/shot.png'): Message {
  return {
    id: 'u1',
    role: 'user',
    timestamp: 1,
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' }, filePath },
      { type: 'text', text: '看看这张图' },
    ],
  } as Message;
}

function imageBlock(m: Message) {
  const arr = m.content as Array<{ type: string; source?: { data: string } }>;
  return arr.find((b) => b.type === 'image') as { type: string; source: { data: string } } | undefined;
}

describe('rehydrateImageData', () => {
  beforeEach(() => {
    mockResolveFileSource.mockReset();
    mockReadFile.mockReset();
  });

  it('refills empty base64 from the resolved disk file', async () => {
    mockResolveFileSource.mockResolvedValue({ status: 'available', path: '/real/shot.png', isFromSnapshot: false });
    mockReadFile.mockResolvedValue(new Uint8Array([137, 80, 78, 71])); // \x89PNG

    const out = await rehydrateImageData([strippedImageMessage()], 'conv1', null);

    const img = imageBlock(out[0]);
    expect(img).toBeDefined();
    expect(img!.source.data).toBe('iVBORw=='); // base64 of the 4 bytes above
    expect(img!.source.data).not.toBe('');
  });

  it('degrades an unrecoverable image to a text placeholder — never an empty image', async () => {
    mockResolveFileSource.mockResolvedValue({ status: 'missing', basename: 'shot.png', originalPath: 'D:/abu/shot.png' });

    const out = await rehydrateImageData([strippedImageMessage()], 'conv1', null);

    const content = out[0].content as Array<{ type: string; text?: string; source?: { data: string } }>;
    // No image block with empty base64 survives.
    expect(content.some((b) => b.type === 'image')).toBe(false);
    const placeholder = content.find((b) => b.type === 'text' && b.text?.includes('shot.png'));
    expect(placeholder).toBeDefined();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('degrades to placeholder when the disk read throws', async () => {
    mockResolveFileSource.mockResolvedValue({ status: 'available', path: '/real/shot.png', isFromSnapshot: false });
    mockReadFile.mockRejectedValue(new Error('EACCES'));

    const out = await rehydrateImageData([strippedImageMessage()], 'conv1', null);
    const content = out[0].content as Array<{ type: string }>;
    expect(content.some((b) => b.type === 'image')).toBe(false);
  });

  it('leaves messages untouched when no image was stripped (fast path, no disk I/O)', async () => {
    const intact: Message = {
      id: 'u2', role: 'user', timestamp: 1,
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ALREADYHERE' }, filePath: 'x.png' }],
    } as Message;
    const textOnly: Message = { id: 'u3', role: 'user', content: 'hi', timestamp: 2 } as Message;

    const out = await rehydrateImageData([intact, textOnly], 'conv1', null);

    expect(out[0]).toBe(intact); // same reference — untouched
    expect(out[1]).toBe(textOnly);
    expect(mockResolveFileSource).not.toHaveBeenCalled();
  });

  it('reads each filePath from disk only once across turns when a cache is shared', async () => {
    mockResolveFileSource.mockResolvedValue({ status: 'available', path: '/real/shot.png', isFromSnapshot: false });
    mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const cache = new Map<string, string | null>();

    // Simulate 3 turns of a tool-use loop re-sending the same stripped image.
    await rehydrateImageData([strippedImageMessage()], 'conv1', null, cache);
    await rehydrateImageData([strippedImageMessage()], 'conv1', null, cache);
    const out = await rehydrateImageData([strippedImageMessage()], 'conv1', null, cache);

    expect(mockResolveFileSource).toHaveBeenCalledTimes(1);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(imageBlock(out[0])!.source.data).toBe('AQID'); // still rehydrated on turn 3
  });

  it('caches unrecoverable results too (no repeated disk probes for a missing file)', async () => {
    mockResolveFileSource.mockResolvedValue({ status: 'missing', basename: 'shot.png', originalPath: 'D:/abu/shot.png' });
    const cache = new Map<string, string | null>();

    await rehydrateImageData([strippedImageMessage()], 'conv1', null, cache);
    await rehydrateImageData([strippedImageMessage()], 'conv1', null, cache);

    expect(mockResolveFileSource).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the input message (immutable)', async () => {
    mockResolveFileSource.mockResolvedValue({ status: 'available', path: '/real/shot.png', isFromSnapshot: false });
    mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const input = strippedImageMessage();
    await rehydrateImageData([input], 'conv1', null);

    expect(imageBlock(input)!.source.data).toBe(''); // original still stripped
  });
});

// The seam both agent-loop send sites (primary send + context_too_long recovery
// retry) call. Consolidated so a second send site can't skip rehydration — the
// exact way the recovery path regressed in review.
describe('rehydrateForSend (shared send-prep seam)', () => {
  beforeEach(() => {
    mockResolveFileSource.mockReset();
    mockReadFile.mockReset();
  });

  it('passes non-vision messages through untouched with zero disk I/O', async () => {
    const msgs = [strippedImageMessage()];
    const out = await rehydrateForSend(msgs, { vision: false, conversationId: 'c1', workspacePath: null });

    expect(out).toBe(msgs); // same reference — nothing rehydrated
    expect(imageBlock(out[0])!.source.data).toBe('');
    expect(mockResolveFileSource).not.toHaveBeenCalled();
  });

  it('rehydrates for a vision model (delegates to rehydrateImageData)', async () => {
    mockResolveFileSource.mockResolvedValue({ status: 'available', path: '/real/shot.png', isFromSnapshot: false });
    mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const out = await rehydrateForSend([strippedImageMessage()], { vision: true, conversationId: 'c1', workspacePath: null });

    expect(imageBlock(out[0])!.source.data).toBe('AQID');
  });

  it('threads the shared cache through so repeat sends read disk once', async () => {
    mockResolveFileSource.mockResolvedValue({ status: 'available', path: '/real/shot.png', isFromSnapshot: false });
    mockReadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const cache = new Map<string, string | null>();

    // Mirrors primary-send then recovery-retry in one turn: two calls, one read.
    await rehydrateForSend([strippedImageMessage()], { vision: true, conversationId: 'c1', workspacePath: null, cache });
    await rehydrateForSend([strippedImageMessage()], { vision: true, conversationId: 'c1', workspacePath: null, cache });

    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });
});
