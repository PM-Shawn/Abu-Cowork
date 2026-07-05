import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation, Message } from '@/types';
import type { SnapshotEntry } from './outputSnapshots';

// Hoist mocks so the module-under-test sees them at import time.
const mockListSnapshots = vi.fn<(convId: string) => Promise<SnapshotEntry[]>>();
const mockReadSnapshotBytes = vi.fn<(convId: string, rel: string) => Promise<Uint8Array | null>>();
const mockReadFile = vi.fn<(path: string) => Promise<Uint8Array>>();

vi.mock('./outputSnapshots', async () => {
  const actual = await vi.importActual<typeof import('./outputSnapshots')>('./outputSnapshots');
  return {
    ...actual,
    listSnapshots: (convId: string) => mockListSnapshots(convId),
    readSnapshotBytes: (convId: string, rel: string) => mockReadSnapshotBytes(convId, rel),
  };
});

vi.mock('@tauri-apps/plugin-fs', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/plugin-fs')>('@tauri-apps/plugin-fs');
  return {
    ...actual,
    readFile: (path: string) => mockReadFile(path),
  };
});

import { buildShareBundle, SHARE_SCHEMA_VERSION } from './shareBundle';

function makeConv(messages: Message[], overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-abc',
    title: 'Test Conversation',
    messages,
    createdAt: 1_000_000,
    updatedAt: 2_000_000,
    status: 'idle',
    // Fields that MUST NOT leak into the bundle:
    workspacePath: '/Users/alice/projects/secret',
    scheduledTaskId: 'task-123',
    triggerId: 'trig-456',
    projectId: 'proj-789',
    imChannelId: 'chan-xyz',
    imPlatform: 'dchat',
    activeSkills: ['skill-a'],
    enabledMCPServers: ['mcp-1'],
    ...overrides,
  };
}

function snapshot(over: Partial<SnapshotEntry>): SnapshotEntry {
  return {
    originalPath: '/Users/alice/file.png',
    basename: 'file.png',
    snapshotRelPath: 'files/abc/file.png',
    size: 10,
    originalMtime: 0,
    snapshottedAt: 0,
    source: 'tool-output',
    refId: 'r1',
    refKind: 'image',
    ...over,
  };
}

beforeEach(() => {
  mockListSnapshots.mockReset();
  mockReadSnapshotBytes.mockReset();
  mockReadFile.mockReset();
  // Safe defaults — individual tests override as needed.
  mockListSnapshots.mockResolvedValue([]);
  mockReadSnapshotBytes.mockResolvedValue(null);
  mockReadFile.mockRejectedValue(new Error('not mocked'));
});

describe('buildShareBundle', () => {
  it('emits the current schema version and Standard tier by default', async () => {
    const conv = makeConv([{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.schema.abuShareVersion).toBe(SHARE_SCHEMA_VERSION);
    expect(bundle.schema.tier).toBe('standard');
    expect(bundle.schema.exportedAt).toBeGreaterThan(0);
  });

  it('only keeps id/title/createdAt/updatedAt on bundle.conversation (strips external refs)', async () => {
    const conv = makeConv([]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.conversation).toEqual({
      id: 'conv-abc',
      title: 'Test Conversation',
      createdAt: 1_000_000,
      updatedAt: 2_000_000,
    });
    // Serialized form must not contain any of the stripped refs anywhere.
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('task-123');
    expect(serialized).not.toContain('trig-456');
    expect(serialized).not.toContain('proj-789');
    expect(serialized).not.toContain('chan-xyz');
    expect(serialized).not.toContain('skill-a');
    expect(serialized).not.toContain('mcp-1');
  });

  it('redacts credentials inside message text and reports count', async () => {
    const conv = makeConv([
      {
        id: 'm1',
        role: 'user',
        content: 'my key sk-ant-abcdefghijklmnopqrstuvwxyz123456 pls',
        timestamp: 1,
      },
    ]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.stats.redactionCount).toBeGreaterThan(0);
    expect(JSON.stringify(bundle)).not.toContain('sk-ant-abc');
    expect(JSON.stringify(bundle)).toContain('[REDACTED:anthropic-key]');
  });

  it('clears isStreaming flags and tool-call execution state', async () => {
    const conv = makeConv([
      {
        id: 'm1',
        role: 'assistant',
        content: 'working',
        timestamp: 1,
        isStreaming: true,
        toolCalls: [
          { id: 't1', name: 'run_command', input: { cmd: 'ls' }, result: '', isExecuting: true },
        ],
      },
    ]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.messages[0].isStreaming).toBe(false);
    expect(bundle.messages[0].toolCalls?.[0].isExecuting).toBe(false);
  });

  it('drops system-injected messages (isSystem=true) to match in-app visibility', async () => {
    const conv = makeConv([
      { id: 'real-1', role: 'user', content: 'real question', timestamp: 1 },
      // Mimics App.tsx's orphan-checkpoint recovery notice that piles up
      // across crash/restart cycles and must not leak to recipients.
      {
        id: 'sys-1',
        role: 'assistant',
        content: '⚠️ 上次对话在第 2 轮等待模型响应时中断。你可以继续发送消息恢复工作。',
        timestamp: 2,
        isSystem: true,
      },
      {
        id: 'sys-2',
        role: 'assistant',
        content: '⚠️ 上次对话在第 2 轮等待模型响应时中断。你可以继续发送消息恢复工作。',
        timestamp: 3,
        isSystem: true,
      },
      { id: 'real-2', role: 'assistant', content: 'real answer', timestamp: 4 },
    ]);
    const bundle = await buildShareBundle(conv);
    expect(bundle.messages).toHaveLength(2);
    expect(bundle.messages.map((m) => m.id)).toEqual(['real-1', 'real-2']);
    expect(JSON.stringify(bundle)).not.toContain('上次对话在第');
  });

  it('does not mutate the source conversation object', async () => {
    const conv = makeConv([
      {
        id: 'm1',
        role: 'assistant',
        content: 'x',
        timestamp: 1,
        isStreaming: true,
        toolCalls: [{ id: 't1', name: 'foo', input: {}, result: 'r', isExecuting: true }],
      },
    ]);
    await buildShareBundle(conv);
    expect(conv.messages[0].isStreaming).toBe(true);
    expect(conv.messages[0].toolCalls?.[0].isExecuting).toBe(true);
  });

  describe('Standard tier — attachment classification', () => {
    it('embeds tool-output attachments as base64', async () => {
      mockListSnapshots.mockResolvedValue([
        snapshot({ source: 'tool-output', basename: 'report.xlsx', originalPath: '/Users/alice/report.xlsx' }),
      ]);
      mockReadSnapshotBytes.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]));

      const bundle = await buildShareBundle(makeConv([]));
      const att = Object.values(bundle.attachments)[0];
      expect(att.source).toBe('tool-output');
      expect(att.data).toBeTruthy();
      expect(att.skipReason).toBeUndefined();
      expect(bundle.stats.embeddedCount).toBe(1);
    });

    it('excludes user-upload attachments from embedding', async () => {
      mockListSnapshots.mockResolvedValue([
        snapshot({ source: 'user-upload', basename: 'secret.pdf', originalPath: '/Users/alice/secret.pdf' }),
      ]);

      const bundle = await buildShareBundle(makeConv([]));
      const att = Object.values(bundle.attachments)[0];
      expect(att.data).toBeUndefined();
      expect(att.skipReason).toBe('user-upload-excluded');
      expect(bundle.stats.embeddedCount).toBe(0);
    });

    it('marks missing snapshots with skipReason=missing', async () => {
      mockListSnapshots.mockResolvedValue([
        snapshot({ source: 'tool-output', snapshotRelPath: 'files/x/y.pdf' }),
      ]);
      mockReadSnapshotBytes.mockResolvedValue(null);

      const bundle = await buildShareBundle(makeConv([]));
      const att = Object.values(bundle.attachments)[0];
      expect(att.skipReason).toBe('missing');
    });

    it('redacts home paths in attachment keys', async () => {
      mockListSnapshots.mockResolvedValue([
        snapshot({ originalPath: '/Users/alice/file.png', basename: 'file.png' }),
      ]);
      mockReadSnapshotBytes.mockResolvedValue(new Uint8Array([1]));

      const bundle = await buildShareBundle(makeConv([]));
      const keys = Object.keys(bundle.attachments);
      expect(keys[0]).toBe('~/file.png');
    });
  });

  describe('Standard tier — ImageContent in message body', () => {
    it('strips user-uploaded images (no manifest entry defaults to user-upload)', async () => {
      const conv = makeConv([
        {
          id: 'm1',
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'OLD_DATA' },
              filePath: '/Users/alice/paste.png',
            },
          ],
          timestamp: 1,
        },
      ]);
      const bundle = await buildShareBundle(conv);
      const block = (bundle.messages[0].content as Array<{ type: string; source?: { data: string }; filePath?: string }>)[0];
      expect(block.source?.data).toBe('');
      // Path redacted.
      expect(block.filePath).toBe('~/paste.png');
    });

    it('embeds AI-generated images (manifest source=tool-output)', async () => {
      const screenshotPath = '/Users/alice/screenshot.png';
      mockListSnapshots.mockResolvedValue([
        snapshot({
          source: 'tool-output',
          originalPath: screenshotPath,
          basename: 'screenshot.png',
          snapshotRelPath: 'files/a/screenshot.png',
        }),
      ]);
      mockReadSnapshotBytes.mockResolvedValue(new Uint8Array([42, 42]));

      const conv = makeConv([
        {
          id: 'm1',
          role: 'assistant',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: '' },
              filePath: screenshotPath,
            },
          ],
          timestamp: 1,
        },
      ]);
      const bundle = await buildShareBundle(conv);
      const block = (bundle.messages[0].content as Array<{ type: string; source?: { data: string } }>)[0];
      expect(block.source?.data.length).toBeGreaterThan(0);
    });
  });

  describe('progress + cancel (#7)', () => {
    it('calls onProgress once per visible (non-system) message', async () => {
      const conv = makeConv([
        { id: 'm1', role: 'user', content: 'a', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'b', timestamp: 2 },
        { id: 'm3', role: 'user', content: 'sys', timestamp: 3, isSystem: true },
      ]);
      const seen: Array<[number, number]> = [];
      await buildShareBundle(conv, { onProgress: (d, t) => seen.push([d, t]) });
      expect(seen).toEqual([[1, 2], [2, 2]]); // m3 (system) excluded from total
    });

    it('rejects when the signal is already aborted', async () => {
      const conv = makeConv([{ id: 'm1', role: 'user', content: 'a', timestamp: 1 }]);
      const controller = new AbortController();
      controller.abort();
      await expect(buildShareBundle(conv, { signal: controller.signal })).rejects.toThrow();
    });
  });
});
