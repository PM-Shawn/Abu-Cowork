import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { uint8ArrayToBase64 } from '../../utils/base64';
import type { Conversation, Message } from '../../types';
import {
  MAX_DELEGATED_IMAGE_BASE64_BYTES,
  MAX_DELEGATED_IMAGE_COUNT,
} from './delegatedMediaPreflight';

const mockBase64Decode = vi.hoisted(() => vi.fn());
vi.mock('../../utils/base64', async () => {
  const actual = await vi.importActual<typeof import('../../utils/base64')>('../../utils/base64');
  return {
    ...actual,
    base64ToUint8Array: (data: string) => {
      mockBase64Decode(data);
      return actual.base64ToUint8Array(data);
    },
  };
});

const mocks = vi.hoisted(() => ({
  getConversation: vi.fn(),
  persistDelegatedMedia: vi.fn(),
  readDelegatedMedia: vi.fn(),
  resolveFileSource: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('../agent/ports/conversationReader', () => ({
  getConversationReader: () => ({
    getConversation: (...args: unknown[]) => mocks.getConversation(...args),
  }),
}));

vi.mock('./delegatedMediaStore', () => ({
  persistDelegatedMedia: (...args: unknown[]) => mocks.persistDelegatedMedia(...args),
  readDelegatedMedia: (...args: unknown[]) => mocks.readDelegatedMedia(...args),
}));

vi.mock('../session/outputSnapshots', () => ({
  resolveFileSource: (...args: unknown[]) => mocks.resolveFileSource(...args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: (...args: unknown[]) => mocks.readFile(...args),
}));

import {
  DelegatedUserTurnError,
  buildInitialSubagentUserContent,
  materializeDelegatedUserTurn,
  materializeSidecarMediaRefsForShell,
  prepareConversationSnapshotForSidecarWire,
  prepareDelegatedUserTurnForRequest,
  prepareToolResultForSidecarWire,
  redactAbsoluteMediaPaths,
  sidecarValueHasOpaqueMediaRefs,
} from './delegatedUserTurnMaterializer';

function userMessage(overrides: Partial<Message>): Message {
  return {
    id: 'user-1',
    role: 'user',
    content: 'text',
    timestamp: 1,
    loopId: 'loop-1',
    ...overrides,
  };
}

function conversation(messages: Message[]): Conversation {
  return {
    id: 'conv-1',
    title: 'Conversation',
    messages,
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    workspacePath: '/workspace',
  };
}

describe('delegated user turn materializer', () => {
  beforeEach(() => {
    mocks.getConversation.mockReset();
    mocks.persistDelegatedMedia.mockReset();
    mocks.persistDelegatedMedia.mockImplementation(async (_convId: string, input: { mediaType: string; bytes: Uint8Array }) => ({
      id: `media_${mocks.persistDelegatedMedia.mock.calls.length}`,
      sha256: `${mocks.persistDelegatedMedia.mock.calls.length}`.repeat(64).slice(0, 64),
      mediaType: input.mediaType,
      bytes: input.bytes.byteLength,
    }));
    mocks.readDelegatedMedia.mockReset();
    mocks.resolveFileSource.mockReset();
    mocks.readFile.mockReset();
    mockBase64Decode.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('binds exactly the shell-owned source user turn and preserves interleaved media order', async () => {
    const image1 = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const image2 = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
    const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]);
    mocks.getConversation.mockReturnValue(conversation([
      userMessage({ id: 'older', loopId: 'other-loop', content: 'older' }),
      userMessage({
        id: 'user-source',
        content: [
          { type: 'text', text: 'Label A' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: uint8ArrayToBase64(image1) } },
          { type: 'text', text: 'Label B' },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: uint8ArrayToBase64(pdf) } },
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: uint8ArrayToBase64(image2) } },
        ],
      }),
    ]));

    const turn = await materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' });

    expect(turn.origin).toEqual({ conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-source' });
    expect(turn.content.map((block) => block.type)).toEqual(['text', 'image', 'text', 'document', 'image']);
    expect(mocks.persistDelegatedMedia).toHaveBeenNthCalledWith(1, 'conv-1', { mediaType: 'image/png', bytes: image1 });
    expect(mocks.persistDelegatedMedia).toHaveBeenNthCalledWith(2, 'conv-1', { mediaType: 'application/pdf', bytes: pdf });
    expect(mocks.persistDelegatedMedia).toHaveBeenNthCalledWith(3, 'conv-1', { mediaType: 'image/webp', bytes: image2 });
    expect(Object.isFrozen(turn)).toBe(true);
    expect(Object.isFrozen(turn.origin)).toBe(true);
    expect(Object.isFrozen(turn.content)).toBe(true);
    expect(Object.isFrozen(turn.content[1])).toBe(true);
    expect(Object.isFrozen((turn.content[1] as { attachment: unknown }).attachment)).toBe(true);
  });

  it('preserves shell-issued opaque refs when a sidecar direct @agent route snapshots the source turn', async () => {
    const attachment = {
      id: 'media_' + 'a'.repeat(64),
      sha256: 'a'.repeat(64),
      mediaType: 'application/pdf' as const,
      bytes: 6,
    };
    mocks.getConversation.mockReturnValue(conversation([
      userMessage({
        id: 'user-source',
        content: [
          { type: 'text', text: 'Review this.' },
          {
            type: 'delegated_media_ref',
            originConversationId: 'conv-1',
            attachment,
          },
        ] as never,
      }),
    ]));

    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .resolves.toMatchObject({
        origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-source' },
        content: [
          { type: 'text', text: 'Review this.' },
          { type: 'document', attachment },
        ],
      });
    expect(mocks.persistDelegatedMedia).not.toHaveBeenCalled();
  });

  it('keeps already-stripped historical images off the sidecar ref conversion path', async () => {
    const snapshot = conversation([
      userMessage({
        id: 'historical-user',
        loopId: 'historical-loop',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: '' },
            filePath: '/workspace/historical.png',
          },
          { type: 'text', text: 'Earlier context.' },
        ],
      }),
      userMessage({ id: 'current-user', content: 'Delegate this turn.' }),
    ]);

    const prepared = await prepareConversationSnapshotForSidecarWire(snapshot);
    const serialized = JSON.stringify(prepared);

    expect(prepared).not.toBe(snapshot);
    expect(serialized).not.toContain('/workspace/historical.png');
    expect(serialized).toContain('"data":""');
    expect(mocks.persistDelegatedMedia).not.toHaveBeenCalled();
  });

  it('strips base64 and absolute paths from the full sidecar conversation snapshot without dropping media', async () => {
    const imageData = uint8ArrayToBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const pdfData = uint8ArrayToBase64(new Uint8Array([37, 80, 68, 70, 45, 49]));
    const snapshot = conversation([
      userMessage({
        id: 'user-source',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageData },
            filePath: '/Users/tester/private/shot.png',
          },
          {
            type: 'document',
            name: 'plan.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfData },
          } as never,
        ],
      }),
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'tool output',
        timestamp: 2,
        loopId: 'loop-1',
        toolCalls: [{
          id: 'tool-1',
          name: 'computer',
          input: {},
          result: 'screenshot',
          resultContent: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageData },
            outputRef: { relPath: 'images/tool-1.png', basename: 'tool-1.png', sizeBytes: 8 },
          }],
        }],
        toolCallsForContext: [{
          id: 'tool-1',
          name: 'computer',
          input: {},
          result: 'screenshot',
          resultContent: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageData },
            outputRef: { relPath: 'images/tool-1.png', basename: 'tool-1.png', sizeBytes: 8 },
          }],
        }],
      },
    ]);

    const prepared = await prepareConversationSnapshotForSidecarWire(snapshot);
    const serialized = JSON.stringify(prepared);

    expect(prepared).not.toBe(snapshot);
    expect(serialized).not.toContain(imageData);
    expect(serialized).not.toContain(pdfData);
    expect(serialized).not.toContain('/Users/tester/private/shot.png');
    expect(serialized).toContain('delegated_media_ref');
    expect(serialized).toContain('plan.pdf');
    expect(serialized).toContain('images/tool-1.png');
    expect(mocks.persistDelegatedMedia).toHaveBeenCalledTimes(2);
  });

  it('redacts local path prefixes and short base64 data URLs without breaking https or plain data text', () => {
    const dataUrls = [
      'data:image/png;base64,QQ==',
      'data:image/png;charset=utf-8;base64,QUJDRA==',
      'data:application/pdf;name=secret.pdf;base64,JVBERi0=',
      'data:;base64,QQ==',
    ];
    const httpsUrl = 'https://example.test/assets/secret.png';
    const ordinaryDataText = 'ordinary data: label';

    const sanitized = redactAbsoluteMediaPaths(
      `path:/Users/alice/secret.png file:///Users/alice/secret.png </Users/alice/secret.png> ${dataUrls.join(' ')} ${httpsUrl} ${ordinaryDataText}`,
    );

    expect(sanitized).not.toContain('path:/Users/alice/secret.png');
    expect(sanitized).not.toContain('file:///Users/alice/secret.png');
    expect(sanitized).not.toContain('/Users/alice/secret.png');
    for (const dataUrl of dataUrls) {
      expect(sanitized).not.toContain(dataUrl);
    }
    expect(sanitized).toContain('path:[REDACTED:path]');
    expect(sanitized).toContain('file://[REDACTED:path]');
    expect(sanitized).toContain('<[REDACTED:path]>');
    expect(sanitized).toContain('[REDACTED:base64]');
    expect(sanitized).toContain(httpsUrl);
    expect(sanitized).toContain(ordinaryDataText);
  });

  it('keeps generic Unix absolute path redaction while preserving https URLs', () => {
    const httpsUrl = 'https://example.test/assets/a.png';
    const sanitized = redactAbsoluteMediaPaths(
      `file=/tmp/a.png opening /var/private/report.txt ${httpsUrl}`,
    );

    expect(sanitized).not.toContain('/tmp/a.png');
    expect(sanitized).not.toContain('/var/private/report.txt');
    expect(sanitized).toContain('file=[REDACTED:path]');
    expect(sanitized).toContain('opening [REDACTED:path]');
    expect(sanitized).toContain(httpsUrl);
  });

  it.each([
    ['PATH prefix', 'PATH:/Users/a/secret.png', 'PATH:[REDACTED:path]'],
    ['output prefix', 'output:/Users/a/secret.png', 'output:[REDACTED:path]'],
    ['uppercase file URI', 'FILE:///Users/a/secret.png', 'FILE://[REDACTED:path]'],
  ])('redacts %s without treating https URLs as local paths', (_label, rawPath, expected) => {
    const httpsUrl = 'https://example.test/assets/a.png';
    const sanitized = redactAbsoluteMediaPaths(`${rawPath} ${httpsUrl}`);

    expect(sanitized).not.toContain(rawPath);
    expect(sanitized).toContain(expected);
    expect(sanitized).toContain(httpsUrl);
  });

  it('rejects an aggregate above 15 MiB when every inline image is below 5 MiB before any byte work', async () => {
    const imageBytes = new Uint8Array(Math.floor((MAX_DELEGATED_IMAGE_BASE64_BYTES - 4) * 3 / 4));
    const data = uint8ArrayToBase64(imageBytes);
    expect(data.length).toBeLessThan(MAX_DELEGATED_IMAGE_BASE64_BYTES);
    expect(data.length * 4).toBeGreaterThan(MAX_DELEGATED_IMAGE_BASE64_BYTES * 3);
    mocks.getConversation.mockReturnValue(conversation([userMessage({
      id: 'user-source',
      content: Array.from({ length: 4 }, () => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png' as const, data },
      })),
    })]));

    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .rejects.toThrow(/images are too large/i);

    expect(mockBase64Decode).not.toHaveBeenCalled();
    expect(mocks.readDelegatedMedia).not.toHaveBeenCalled();
    expect(mocks.persistDelegatedMedia).not.toHaveBeenCalled();
  });

  it('keeps reverse tool-result media opaque on the sidecar wire and restores it only in the shell', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const imageData = uint8ArrayToBase64(imageBytes);
    mocks.readDelegatedMedia.mockResolvedValue(imageBytes);

    const wireResult = await prepareToolResultForSidecarWire('conv-1', [
      { type: 'text', text: 'Image: /private/customer/shot.png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
    ]);
    const serializedWire = JSON.stringify(wireResult);

    expect(serializedWire).not.toContain(imageData);
    expect(serializedWire).not.toContain('/private/customer/shot.png');
    expect(serializedWire).toContain('delegated_media_ref');
    expect(mocks.persistDelegatedMedia).toHaveBeenCalledTimes(1);

    const shellResult = await materializeSidecarMediaRefsForShell(wireResult, 'conv-1');
    expect(shellResult).toEqual([
      { type: 'text', text: 'Image: [REDACTED:path]' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: imageData },
      },
    ]);
    expect(mocks.readDelegatedMedia).toHaveBeenCalledTimes(1);
  });

  it('rejects raw document base64 on the sidecar display boundary while preserving opaque document refs', async () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49]);
    const pdfData = uint8ArrayToBase64(pdfBytes);
    const rawDocument = [{
      type: 'document',
      name: 'secret.pdf',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfData },
    }];

    expect(() => sidecarValueHasOpaqueMediaRefs(rawDocument))
      .toThrow(/raw base64 crossed the wire/i);
    await expect(materializeSidecarMediaRefsForShell(rawDocument, 'conv-1'))
      .rejects.toThrow(/raw base64 crossed the wire/i);

    mocks.readDelegatedMedia.mockResolvedValueOnce(pdfBytes);
    const opaqueDocument = [{
      type: 'delegated_media_ref',
      originConversationId: 'conv-1',
      name: 'safe.pdf',
      attachment: {
        id: `media_${'d'.repeat(64)}`,
        sha256: 'd'.repeat(64),
        mediaType: 'application/pdf',
        bytes: pdfBytes.byteLength,
      },
    }] as const;

    expect(sidecarValueHasOpaqueMediaRefs(opaqueDocument)).toBe(true);
    await expect(materializeSidecarMediaRefsForShell(opaqueDocument, 'conv-1'))
      .resolves.toEqual([{
        type: 'document',
        name: 'safe.pdf',
        source: { type: 'base64', media_type: 'application/pdf', data: pdfData },
      }]);
  });

  it('rejects a shell-issued opaque ref from a different conversation', async () => {
    mocks.getConversation.mockReturnValue(conversation([
      userMessage({
        id: 'user-source',
        content: [{
          type: 'delegated_media_ref',
          originConversationId: 'conv-other',
          attachment: {
            id: `media_${'a'.repeat(64)}`,
            sha256: 'a'.repeat(64),
            mediaType: 'image/png',
            bytes: 8,
          },
        }] as never,
      }),
    ]));

    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .rejects.toThrow(/media origin mismatch/i);
    expect(mocks.persistDelegatedMedia).not.toHaveBeenCalled();
  });

  it('rejects foreign stripped document metadata before attempting any byte work', async () => {
    mocks.getConversation.mockReturnValue(conversation([
      userMessage({
        id: 'user-source',
        content: [{
          type: 'document',
          name: 'foreign.pdf',
          originConversationId: 'conv-other',
          source: { type: 'base64', media_type: 'application/pdf', data: '' },
        }],
      }),
    ]));

    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .rejects.toThrow(/media origin mismatch/i);
    expect(mocks.readDelegatedMedia).not.toHaveBeenCalled();
    expect(mocks.persistDelegatedMedia).not.toHaveBeenCalled();
  });

  it('does not rebuild same-conversation stripped documents while materializing the live source turn', async () => {
    mocks.getConversation.mockReturnValue(conversation([
      userMessage({
        id: 'user-source',
        content: [{
          type: 'document',
          name: 'historical.pdf',
          originConversationId: 'conv-1',
          source: { type: 'base64', media_type: 'application/pdf', data: '' },
        }],
      }),
    ]));
    mocks.readDelegatedMedia.mockResolvedValue(new Uint8Array([37, 80, 68, 70, 45, 49]));

    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .rejects.toThrow(/missing inline data/i);
    expect(mocks.readDelegatedMedia).not.toHaveBeenCalled();
    expect(mocks.persistDelegatedMedia).not.toHaveBeenCalled();
  });

  it('rejects a foreign stripped document while preparing the sidecar snapshot', async () => {
    const snapshot = conversation([userMessage({
      id: 'user-source',
      content: [{
        type: 'document',
        name: 'foreign.pdf',
        originConversationId: 'conv-other',
        source: { type: 'base64', media_type: 'application/pdf', data: '' },
      }],
    })]);

    await expect(prepareConversationSnapshotForSidecarWire(snapshot))
      .rejects.toThrow(/media origin mismatch/i);
    expect(mocks.readDelegatedMedia).not.toHaveBeenCalled();
    expect(mocks.persistDelegatedMedia).not.toHaveBeenCalled();
  });

  it('does not convert same-conversation stripped documents into sidecar delegated refs', async () => {
    const snapshot = conversation([userMessage({
      id: 'user-source',
      content: [{
        type: 'document',
        name: 'historical.pdf',
        originConversationId: 'conv-1',
        source: { type: 'base64', media_type: 'application/pdf', data: '' },
      }],
    })]);
    mocks.readDelegatedMedia.mockResolvedValue(new Uint8Array([37, 80, 68, 70, 45, 49]));

    const prepared = await prepareConversationSnapshotForSidecarWire(snapshot);
    const serialized = JSON.stringify(prepared);

    expect(serialized).not.toContain('delegated_media_ref');
    expect(serialized).toContain('"data":""');
    expect(mocks.readDelegatedMedia).not.toHaveBeenCalled();
    expect(mocks.persistDelegatedMedia).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted source turn is missing, ambiguous, or not a user message', async () => {
    mocks.getConversation.mockReturnValue(conversation([]));
    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .rejects.toThrow(DelegatedUserTurnError);

    mocks.getConversation.mockReturnValue(conversation([
      userMessage({ id: 'user-a' }),
      userMessage({ id: 'user-b' }),
    ]));
    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .rejects.toThrow(/missing or ambiguous/);

    mocks.getConversation.mockReturnValue(conversation([
      { id: 'assistant-1', role: 'assistant', content: 'not trusted', timestamp: 1, loopId: 'loop-1' },
    ]));
    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .rejects.toThrow(/missing or ambiguous/);
  });

  it('recovers a stripped restart image by filePath before delegating it', async () => {
    const recoveredBytes = new Uint8Array([137, 80, 78, 71]);
    mocks.resolveFileSource.mockResolvedValue({
      status: 'available',
      path: '/Users/tester/.abu/conversations/conv-1/outputs/files/hash/secret.png',
      isFromSnapshot: true,
    });
    mocks.readFile.mockResolvedValue(recoveredBytes);
    mocks.getConversation.mockReturnValue(conversation([
      userMessage({
        id: 'user-source',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: '' },
            filePath: '/Users/tester/secret.png',
          },
        ],
      }),
    ]));

    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .resolves.toMatchObject({
        content: [{
          type: 'image',
          attachment: { mediaType: 'image/png', bytes: recoveredBytes.byteLength },
        }],
      });
    expect(mocks.resolveFileSource).toHaveBeenCalledWith('conv-1', '/Users/tester/secret.png', '/workspace');
    expect(mocks.readFile).toHaveBeenCalledWith('/Users/tester/.abu/conversations/conv-1/outputs/files/hash/secret.png');
    expect(mocks.persistDelegatedMedia).toHaveBeenCalledWith('conv-1', {
      mediaType: 'image/png',
      bytes: recoveredBytes,
    });
  });

  it.each([
    ['image count', Array.from({ length: MAX_DELEGATED_IMAGE_COUNT + 1 }, () => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: uint8ArrayToBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])) } }))],
    ['single image bytes', [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: uint8ArrayToBase64(new Uint8Array(Math.ceil((MAX_DELEGATED_IMAGE_BASE64_BYTES + 1) * 3 / 4))) } }]],
    ['total image bytes', Array.from({ length: 5 }, () => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: uint8ArrayToBase64(new Uint8Array(Math.ceil(MAX_DELEGATED_IMAGE_BASE64_BYTES * 3 / 4))) } }))],
  ])('rejects %s before decoding, reading, or persisting any attachment', async (_label, content) => {
    mocks.getConversation.mockReturnValue(conversation([userMessage({ id: 'user-source', content })]));

    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1' }))
      .rejects.toThrow(DelegatedUserTurnError);

    expect(mockBase64Decode).not.toHaveBeenCalled();
    expect(mocks.persistDelegatedMedia).not.toHaveBeenCalled();
  });

  it('stops materializing and never persists a later attachment when aborted mid-turn', async () => {
    const controller = new AbortController();
    mocks.persistDelegatedMedia.mockImplementationOnce(async (_convId: string, input: { mediaType: string; bytes: Uint8Array }) => {
      controller.abort();
      return { id: 'media_first', sha256: 'a'.repeat(64), mediaType: input.mediaType, bytes: input.bytes.byteLength };
    });
    mocks.getConversation.mockReturnValue(conversation([userMessage({
      id: 'user-source',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: uint8ArrayToBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])) } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: uint8ArrayToBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])) } },
      ],
    })]));

    await expect(materializeDelegatedUserTurn({ conversationId: 'conv-1', loopId: 'loop-1', signal: controller.signal } as never))
      .rejects.toThrow(/abort/i);
    expect(mocks.persistDelegatedMedia).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['image', { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: uint8ArrayToBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])) } }],
    ['document', { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: uint8ArrayToBase64(new Uint8Array([37, 80, 68, 70, 45, 49])) } }],
  ])('rejects promptly when a pending initial %s persist is aborted', async (_label, block) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mocks.persistDelegatedMedia.mockReturnValueOnce(new Promise(() => undefined));
    mocks.getConversation.mockReturnValue(conversation([userMessage({
      id: 'user-source',
      content: [block],
    })]));

    const promise = materializeDelegatedUserTurn({
      conversationId: 'conv-1',
      loopId: 'loop-1',
      signal: controller.signal,
    });
    const settled = promise.then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    await expect(Promise.race([settled, Promise.resolve('pending')]))
      .resolves.toMatch(/aborted/i);
  });

  it('builds child send content from stored refs only and keeps the old string path without media', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    mocks.readDelegatedMedia.mockResolvedValue(imageBytes);
    const mediaTurn = {
      schemaVersion: 1,
      origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-source' },
      content: [
        { type: 'text', text: 'Look here.' },
        { type: 'image', attachment: { id: 'media_1', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 8 } },
      ],
    } as const;

    await expect(buildInitialSubagentUserContent({
      task: 'Describe it.',
      context: 'Use terse prose.',
      delegatedUserTurn: mediaTurn,
    })).resolves.toEqual([
      { type: 'text', text: 'Look here.' },
      {
        type: 'delegated_media_ref',
        originConversationId: 'conv-1',
        attachment: { id: 'media_1', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 8 },
      },
      { type: 'text', text: 'Describe it.\n\nUse terse prose.' },
    ]);
    expect(mocks.readDelegatedMedia).not.toHaveBeenCalled();
    await expect(prepareDelegatedUserTurnForRequest([{
      id: 'sub-user-0',
      role: 'user',
      content: await buildInitialSubagentUserContent({
        task: 'Describe it.',
        delegatedUserTurn: mediaTurn,
      }),
      timestamp: 1,
    }], undefined, 'conv-1')).resolves.toEqual([{
      id: 'sub-user-0',
      role: 'user',
      content: [
        { type: 'text', text: 'Look here.' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
        { type: 'text', text: 'Describe it.' },
      ],
      timestamp: 1,
    }]);
    await expect(buildInitialSubagentUserContent({
      task: 'Describe it.',
      context: 'Use terse prose.',
      delegatedUserTurn: {
        ...mediaTurn,
        content: [{ type: 'text', text: 'text only' }],
      },
    })).resolves.toBe('Describe it.\n\nUse terse prose.');
  });

  it('stops provider-request media materialization after a mid-read abort', async () => {
    const controller = new AbortController();
    const mediaTurn = {
      schemaVersion: 1,
      origin: { conversationId: 'conv-1', loopId: 'loop-1', messageId: 'user-source' },
      content: [
        { type: 'image', attachment: { id: 'media_1', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 8 } },
        { type: 'image', attachment: { id: 'media_2', sha256: 'b'.repeat(64), mediaType: 'image/png', bytes: 8 } },
      ],
    } as const;
    mocks.readDelegatedMedia.mockImplementationOnce(async () => {
      controller.abort();
      return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    });

    await expect(prepareDelegatedUserTurnForRequest([{
      id: 'sub-user-0',
      role: 'user',
      content: await buildInitialSubagentUserContent({
        task: 'Describe it.',
        delegatedUserTurn: mediaTurn,
      }),
      timestamp: 1,
    }], controller.signal, 'conv-1')).rejects.toThrow(/aborted/i);

    expect(mocks.readDelegatedMedia).toHaveBeenCalledTimes(1);
  });

  it('fails closed before reading when metadata conflicts on the same origin/id', async () => {
    mocks.readDelegatedMedia.mockResolvedValue(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const baseRef = {
      id: 'media_same',
      sha256: 'a'.repeat(64),
      mediaType: 'image/png' as const,
      bytes: 8,
      width: 1,
      height: 1,
    };
    const messages = [{
      id: 'sub-user-0',
      role: 'user' as const,
      content: [
        { type: 'delegated_media_ref' as const, originConversationId: 'conv-1', attachment: baseRef },
        { type: 'delegated_media_ref' as const, originConversationId: 'conv-1', attachment: { ...baseRef, bytes: 9, width: 2 } },
      ],
      timestamp: 1,
    }];

    await expect(prepareDelegatedUserTurnForRequest(messages, undefined, 'conv-1'))
      .rejects.toThrow(/metadata conflict/i);
    expect(mocks.readDelegatedMedia).not.toHaveBeenCalled();
  });

  it('rejects a provider-bound media ref from an unexpected conversation before reading it', async () => {
    const messages = [{
      id: 'sub-user-0',
      role: 'user' as const,
      content: [{
        type: 'delegated_media_ref' as const,
        originConversationId: 'conv-other',
        attachment: {
          id: `media_${'d'.repeat(64)}`,
          sha256: 'd'.repeat(64),
          mediaType: 'image/png' as const,
          bytes: 8,
        },
      }],
      timestamp: 1,
    }];

    await expect(prepareDelegatedUserTurnForRequest(messages, undefined, 'conv-1'))
      .rejects.toThrow(/media origin mismatch/i);
    expect(mocks.readDelegatedMedia).not.toHaveBeenCalled();
  });

  it('materializes nested tool media even when the assistant message body is a string', async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    mocks.readDelegatedMedia.mockResolvedValue(imageBytes);
    const messages: Message[] = [{
      id: 'assistant-tool-result',
      role: 'assistant',
      content: 'Tool completed.',
      timestamp: 1,
      toolCalls: [{
        id: 'tool-1',
        name: 'computer',
        input: {},
        result: 'screenshot',
        resultContent: [{
          type: 'delegated_media_ref',
          originConversationId: 'conv-1',
          attachment: {
            id: `media_${'e'.repeat(64)}`,
            sha256: 'e'.repeat(64),
            mediaType: 'image/png',
            bytes: imageBytes.byteLength,
          },
        }] as never,
      }],
    }];

    const prepared = await prepareDelegatedUserTurnForRequest(messages, undefined, 'conv-1');

    expect(prepared[0].content).toBe('Tool completed.');
    expect(prepared[0].toolCalls?.[0].resultContent).toEqual([{
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: uint8ArrayToBase64(imageBytes),
      },
    }]);
    expect(mocks.readDelegatedMedia).toHaveBeenCalledTimes(1);
  });

  it('rejects promptly when a pending delegated media read is aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    mocks.readDelegatedMedia.mockReturnValueOnce(new Promise(() => undefined));
    const promise = prepareDelegatedUserTurnForRequest([{
      id: 'sub-user-0',
      role: 'user',
      content: [{
        type: 'delegated_media_ref',
        originConversationId: 'conv-1',
        attachment: { id: 'media_never', sha256: 'a'.repeat(64), mediaType: 'image/png', bytes: 8 },
      }] as never,
      timestamp: 1,
    }], controller.signal, 'conv-1');
    const assertion = expect(promise).rejects.toThrow(/aborted/i);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await assertion;
  });
});
