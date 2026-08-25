import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '../../types';

// Mock the disk layer the rehydrator depends on.
const mockResolveFileSource = vi.fn();
const mockResolveOutputRefSource = vi.fn();
vi.mock('../session/outputSnapshots', () => ({
  resolveFileSource: (...args: unknown[]) => mockResolveFileSource(...args),
  resolveOutputRefSource: (...args: unknown[]) => mockResolveOutputRefSource(...args),
}));

const mockReadFile = vi.fn();
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

import { rehydrateImageData, rehydrateForSend } from './imageRehydration';
import { normalizeMessages } from './messageNormalizer';

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

function assistantWithOutputRefToolImage(): Message {
  return {
    id: 'a1',
    role: 'assistant',
    timestamp: 1,
    content: '',
    toolCalls: [{
      id: 'toolu_ui',
      name: 'read_file',
      input: {},
      result: 'ui copy',
      resultContent: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: '' },
        outputRef: { relPath: 'files/ui/result.png', basename: 'result.png', sizeBytes: 4 },
      }],
    }],
    toolCallsForContext: [{
      id: 'toolu_context',
      name: 'read_file',
      input: {},
      result: 'context copy',
      resultContent: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: '' },
        outputRef: { relPath: 'files/context/result.png', basename: 'result.png', sizeBytes: 4 },
      }],
    }],
  } as Message;
}

describe('rehydrateImageData', () => {
  beforeEach(() => {
    mockResolveFileSource.mockReset();
    mockResolveOutputRefSource.mockReset();
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
    expect(mockResolveOutputRefSource).not.toHaveBeenCalled();
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

  it('rehydrates outputRef tool result images on both tool-call carriers', async () => {
    mockResolveOutputRefSource.mockResolvedValue({ status: 'available', path: '/snapshot/result.png', isFromSnapshot: true });
    mockReadFile.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));

    const input = assistantWithOutputRefToolImage();
    const out = await rehydrateImageData([input], 'conv1', null);

    const uiBlock = out[0].toolCalls![0].resultContent![0];
    const contextBlock = out[0].toolCallsForContext![0].resultContent![0];
    expect(uiBlock.type).toBe('image');
    expect(contextBlock.type).toBe('image');
    if (uiBlock.type === 'image') expect(uiBlock.source.data).toBe('iVBORw==');
    if (contextBlock.type === 'image') expect(contextBlock.source.data).toBe('iVBORw==');
    expect(mockResolveOutputRefSource).toHaveBeenCalledWith('conv1', 'files/ui/result.png');
    expect(mockResolveOutputRefSource).toHaveBeenCalledWith('conv1', 'files/context/result.png');

    const originalUiBlock = input.toolCalls![0].resultContent![0];
    const originalContextBlock = input.toolCallsForContext![0].resultContent![0];
    if (originalUiBlock.type === 'image') expect(originalUiBlock.source.data).toBe('');
    if (originalContextBlock.type === 'image') expect(originalContextBlock.source.data).toBe('');
  });

  it('degrades missing outputRef tool result images to reversible send-only text placeholders', async () => {
    mockResolveOutputRefSource.mockResolvedValue({ status: 'missing', basename: 'result.png', originalPath: 'files/context/result.png' });

    const input = assistantWithOutputRefToolImage();
    const out = await rehydrateImageData([input], 'conv1', null);

    const contextBlock = out[0].toolCallsForContext![0].resultContent![0];
    expect(contextBlock).toBeUndefined();
    expect(out[0].toolCallsForContext![0].result).toContain('path=files/context/result.png');
    expect(out[0].toolCallsForContext![0].result).toContain('filename=result.png');
    expect(out[0].toolCallsForContext![0].result).toContain('bytes=4');
    expect(out[0].toolCallsForContext![0].result).toContain('media_type=image/png');

    const turns = normalizeMessages(out, { supportsVision: true });
    const assistantTurn = turns.find((turn) => turn.kind === 'assistant');
    expect(assistantTurn?.kind).toBe('assistant');
    if (assistantTurn?.kind === 'assistant') {
      expect(assistantTurn.toolCalls[0].result).toContain('context copy');
      expect(assistantTurn.toolCalls[0].result).toContain('path=files/context/result.png');
      expect(assistantTurn.toolCalls[0].result).not.toContain('path=files/ui/result.png');
      expect(assistantTurn.toolCalls[0].resultImages).toEqual([]);
    }

    const originalContextBlock = input.toolCallsForContext![0].resultContent![0];
    expect(originalContextBlock.type).toBe('image');
    expect(input.toolCallsForContext![0].result).toBe('context copy');
  });
});

// The seam both agent-loop send sites (primary send + context_too_long recovery
// retry) call. Consolidated so a second send site can't skip rehydration — the
// exact way the recovery path regressed in review.
describe('rehydrateForSend (shared send-prep seam)', () => {
  beforeEach(() => {
    mockResolveFileSource.mockReset();
    mockResolveOutputRefSource.mockReset();
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
