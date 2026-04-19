import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, readTextFile, writeTextFile, mkdir, remove, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import type { Message } from '@/types';

// Must import AFTER vi.mock (global mock in setup.ts handles @tauri-apps/plugin-fs)
// We re-import the module fresh for each test to reset module-level state
let storage: typeof import('./conversationStorage');

// Helper: create a minimal message
function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    role: 'user',
    content: 'Hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

// Helper: simulate in-memory filesystem
function createMemoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  (exists as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    return files.has(path) || dirs.has(path);
  });

  (readTextFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (!files.has(path)) throw new Error(`File not found: ${path}`);
    return files.get(path)!;
  });

  const writeToMemory = (path: string, content: string) => {
    files.set(path, content);
    // Auto-create parent dirs
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  };

  (writeTextFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, content: string) => {
    writeToMemory(path, content);
  });

  // conversationStorage now uses atomicWrite which calls invoke('atomic_write_text').
  // Route that command to the same in-memory fs so the tests see writes.
  (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
    cmd: string,
    args?: { path?: string; content?: string },
  ) => {
    if (cmd === 'atomic_write_text' && args?.path !== undefined) {
      writeToMemory(args.path, args.content ?? '');
      return;
    }
    return undefined;
  });

  (mkdir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    dirs.add(path);
  });

  (remove as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    // Remove file and any nested paths
    for (const key of files.keys()) {
      if (key.startsWith(path)) files.delete(key);
    }
    dirs.delete(path);
  });

  (readDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    const entries: { name: string; isDirectory: boolean }[] = [];
    const seen = new Set<string>();

    for (const key of [...files.keys(), ...dirs]) {
      if (!key.startsWith(path + '/')) continue;
      const relative = key.slice(path.length + 1);
      const topLevel = relative.split('/')[0];
      if (seen.has(topLevel)) continue;
      seen.add(topLevel);
      entries.push({
        name: topLevel,
        isDirectory: dirs.has(path + '/' + topLevel),
      });
    }
    return entries;
  });

  return { files, dirs };
}

describe('conversationStorage', () => {
  let memFs: ReturnType<typeof createMemoryFs>;

  beforeEach(async () => {
    memFs = createMemoryFs();
    // Reset module-level state by re-importing
    vi.resetModules();
    storage = await import('./conversationStorage');
  });

  describe('appendMessage + loadMessages', () => {
    it('writes and reads back a single message', async () => {
      const msg = makeMsg({ id: 'test-1', content: 'Hello world' });
      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('test-1');
      expect(loaded[0].content).toBe('Hello world');
    });

    it('appends multiple messages as separate JSONL lines', async () => {
      const msg1 = makeMsg({ id: 'a', content: 'First' });
      const msg2 = makeMsg({ id: 'b', content: 'Second' });
      const msg3 = makeMsg({ id: 'c', content: 'Third' });

      await storage.appendMessage('conv-1', msg1);
      await storage.appendMessage('conv-1', msg2);
      await storage.appendMessage('conv-1', msg3);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded).toHaveLength(3);
      expect(loaded[0].content).toBe('First');
      expect(loaded[1].content).toBe('Second');
      expect(loaded[2].content).toBe('Third');
    });

    it('returns empty array for non-existent conversation', async () => {
      const loaded = await storage.loadMessages('nonexistent');
      expect(loaded).toHaveLength(0);
    });
  });

  describe('loadMessages · corruption resilience', () => {
    // Path shape matches ensureBase() + messagesPath() (see conversationStorage.ts).
    // appDataDir is mocked globally to '/Users/testuser/.abu'.
    const PATH = '/Users/testuser/.abu/conversations/corrupt-conv/messages.jsonl';

    it('skips a single corrupt line and returns intact messages', async () => {
      const good1 = JSON.stringify(makeMsg({ id: 'a', content: 'First' }));
      const corrupt = '"toolCallsForContext":[{orphaned fragment with no leading {';
      const good2 = JSON.stringify(makeMsg({ id: 'b', content: 'Second' }));
      memFs.files.set(PATH, `${good1}\n${corrupt}\n${good2}\n`);

      const loaded = await storage.loadMessages('corrupt-conv');
      expect(loaded).toHaveLength(2);
      expect(loaded[0].content).toBe('First');
      expect(loaded[1].content).toBe('Second');
    });

    it('returns intact messages when multiple lines are corrupt', async () => {
      const good1 = JSON.stringify(makeMsg({ id: 'a', content: 'Kept' }));
      const bad1 = '{broken opening';
      const bad2 = 'totally not JSON';
      const good2 = JSON.stringify(makeMsg({ id: 'b', content: 'Also kept' }));
      memFs.files.set(PATH, `${good1}\n${bad1}\n${bad2}\n${good2}\n`);

      const loaded = await storage.loadMessages('corrupt-conv');
      expect(loaded.map((m) => m.content)).toEqual(['Kept', 'Also kept']);
    });

    it('returns empty when every line is corrupt', async () => {
      memFs.files.set(PATH, 'garbage line 1\ngarbage line 2\n');
      const loaded = await storage.loadMessages('corrupt-conv');
      expect(loaded).toEqual([]);
    });

    it('concurrent appendMessage + replaceMessageById do not race', async () => {
      // Seed: two messages on disk
      const seed1 = makeMsg({ id: 'seed-1', content: 'seed one' });
      const seed2 = makeMsg({ id: 'seed-2', content: 'seed two' });
      await storage.appendMessage('race-conv', seed1);
      await storage.appendMessage('race-conv', seed2);
      await storage.flushWrites();

      // Fire concurrent ops: append 3 new messages while replacing seed-1.
      // Before the mutex, two of these would read overlapping snapshots and
      // produce either lost messages or corrupt JSONL fragments on disk.
      const append1 = storage.appendMessage(
        'race-conv',
        makeMsg({ id: 'new-1', content: 'after race' }),
      );
      const replace = storage.replaceMessageById(
        'race-conv',
        makeMsg({ id: 'seed-1', content: 'REPLACED' }),
      );
      const append2 = storage.appendMessage(
        'race-conv',
        makeMsg({ id: 'new-2', content: 'another after race' }),
      );

      await Promise.all([append1, replace, append2]);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('race-conv');
      // Every message should exist — no lost appends, no duplicate lines
      const ids = loaded.map((m) => m.id).sort();
      expect(ids).toEqual(['new-1', 'new-2', 'seed-1', 'seed-2'].sort());
      // seed-1 should carry the replacement content
      const seed1Loaded = loaded.find((m) => m.id === 'seed-1');
      expect(seed1Loaded?.content).toBe('REPLACED');
    });

    it('concurrent writes to different conversations run in parallel', async () => {
      // Different paths use different locks — throughput should not suffer.
      const writes = Array.from({ length: 5 }, (_, i) =>
        storage.appendMessage(
          `parallel-conv-${i}`,
          makeMsg({ id: `p-${i}`, content: `msg ${i}` }),
        ),
      );
      await Promise.all(writes);
      await storage.flushWrites();

      for (let i = 0; i < 5; i++) {
        const loaded = await storage.loadMessages(`parallel-conv-${i}`);
        expect(loaded).toHaveLength(1);
        expect(loaded[0].content).toBe(`msg ${i}`);
      }
    });

    it('does not put corrupt messages in the dedup cache', async () => {
      const good = JSON.stringify(makeMsg({ id: 'kept', content: 'original' }));
      const corrupt = '{broken line';
      memFs.files.set(PATH, `${good}\n${corrupt}\n`);

      await storage.loadMessages('corrupt-conv');

      // The corrupt line's id is unrecoverable; a new append with the same
      // "kept" id should still be deduped, but a new id should append cleanly.
      const newMsg = makeMsg({ id: 'kept', content: 'would dupe' });
      await storage.appendMessage('corrupt-conv', newMsg);
      await storage.flushWrites();

      const reloaded = await storage.loadMessages('corrupt-conv');
      expect(reloaded.filter((m) => m.id === 'kept')).toHaveLength(1);
      expect(reloaded[0].content).toBe('original'); // dedup kept the original
    });
  });

  describe('UUID dedup', () => {
    it('skips duplicate message IDs', async () => {
      const msg = makeMsg({ id: 'dedup-1', content: 'Original' });
      await storage.appendMessage('conv-1', msg);
      await storage.appendMessage('conv-1', msg); // duplicate
      await storage.appendMessage('conv-1', { ...msg, content: 'Modified' }); // same ID, different content
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded).toHaveLength(1);
      expect(loaded[0].content).toBe('Original');
    });

    it('populates dedup cache on load', async () => {
      // Write directly to "disk" to simulate pre-existing data
      const msg = makeMsg({ id: 'preexisting', content: 'From disk' });
      const path = '/Users/testuser/.abu/conversations/conv-2/messages.jsonl';
      memFs.files.set(path, JSON.stringify(msg) + '\n');
      memFs.dirs.add('/Users/testuser/.abu/conversations/conv-2');
      memFs.dirs.add('/Users/testuser/.abu/conversations');

      // Load messages (populates dedup cache)
      const loaded = await storage.loadMessages('conv-2');
      expect(loaded).toHaveLength(1);

      // Try to append the same message — should be skipped
      await storage.appendMessage('conv-2', msg);
      await storage.flushWrites();

      const reloaded = await storage.loadMessages('conv-2');
      expect(reloaded).toHaveLength(1); // Still 1, not 2
    });
  });

  describe('stripForDisk', () => {
    it('truncates thinking content to 500 chars', async () => {
      const longThinking = 'x'.repeat(2000);
      const msg = makeMsg({
        id: 'think-1',
        role: 'assistant',
        thinking: longThinking,
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded[0].thinking!.length).toBeLessThan(600); // 500 + "[truncated]"
      expect(loaded[0].thinking!).toContain('[truncated]');
    });

    it('preserves short thinking content', async () => {
      const msg = makeMsg({
        id: 'think-2',
        role: 'assistant',
        thinking: 'Short thought',
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded[0].thinking).toBe('Short thought');
    });

    it('clears image base64 data but keeps filePath', async () => {
      const msg = makeMsg({
        id: 'img-1',
        content: [
          { type: 'text', text: 'Look at this' },
          {
            type: 'image',
            source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgo...' },
            filePath: '/path/to/image.png',
          },
        ],
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      const content = loaded[0].content as Array<Record<string, unknown>>;
      const imageBlock = content.find((b) => b.type === 'image') as Record<string, unknown>;
      expect(imageBlock).toBeDefined();
      const source = imageBlock.source as Record<string, string>;
      expect(source.data).toBe(''); // base64 cleared
      expect(imageBlock.filePath).toBe('/path/to/image.png'); // filePath preserved
    });

    it('clears streaming flag', async () => {
      const msg = makeMsg({ id: 'stream-1', isStreaming: true });
      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded[0].isStreaming).toBe(false);
    });
  });

  describe('updateLastMessage', () => {
    it('replaces the last line in JSONL', async () => {
      const msg1 = makeMsg({ id: 'u1', content: 'First' });
      const msg2 = makeMsg({ id: 'u2', role: 'assistant', content: 'Partial...' });

      await storage.appendMessage('conv-1', msg1);
      await storage.appendMessage('conv-1', msg2);
      await storage.flushWrites();

      // Update last message with complete content
      const updated = { ...msg2, content: 'Complete response with tool results' };
      await storage.updateLastMessage('conv-1', updated);

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded).toHaveLength(2);
      expect(loaded[0].content).toBe('First');
      expect(loaded[1].content).toBe('Complete response with tool results');
    });
  });

  describe('index management', () => {
    it('stores and retrieves index entries', async () => {
      const meta: import('./conversationStorage').ConversationMeta = {
        id: 'conv-1',
        title: 'Test conversation',
        createdAt: 1000,
        updatedAt: 2000,
        messageCount: 5,
      };

      await storage.updateIndexEntry(meta);
      await storage.flushIndex();

      // Read index from "disk"
      const indexPath = '/Users/testuser/.abu/conversations/index.json';
      const raw = memFs.files.get(indexPath);
      expect(raw).toBeDefined();

      const parsed = JSON.parse(raw!);
      expect(parsed.entries['conv-1'].title).toBe('Test conversation');
      expect(parsed.entries['conv-1'].messageCount).toBe(5);
    });

    it('removes index entries', async () => {
      const meta: import('./conversationStorage').ConversationMeta = {
        id: 'conv-del',
        title: 'To delete',
        createdAt: 1000,
        updatedAt: 2000,
        messageCount: 1,
      };

      await storage.updateIndexEntry(meta);
      await storage.flushIndex();
      await storage.removeIndexEntry('conv-del');
      await storage.flushIndex();

      const indexPath = '/Users/testuser/.abu/conversations/index.json';
      const parsed = JSON.parse(memFs.files.get(indexPath)!);
      expect(parsed.entries['conv-del']).toBeUndefined();
    });
  });

  describe('deleteConversationFiles', () => {
    it('removes the conversation directory', async () => {
      const msg = makeMsg({ id: 'del-1' });
      await storage.appendMessage('conv-del', msg);
      await storage.flushWrites();

      // Verify file exists
      const loaded = await storage.loadMessages('conv-del');
      expect(loaded).toHaveLength(1);

      // Delete
      await storage.deleteConversationFiles('conv-del');

      // Verify file is gone
      const afterDelete = await storage.loadMessages('conv-del');
      expect(afterDelete).toHaveLength(0);
    });
  });

  describe('buildMeta', () => {
    it('builds ConversationMeta from conversation object', () => {
      const meta = storage.buildMeta({
        id: 'c1',
        title: 'My chat',
        createdAt: 1000,
        updatedAt: 2000,
        messages: [makeMsg(), makeMsg(), makeMsg()],
        workspacePath: '/workspace',
        projectId: 'proj-1',
      });

      expect(meta.id).toBe('c1');
      expect(meta.title).toBe('My chat');
      expect(meta.messageCount).toBe(3);
      expect(meta.workspacePath).toBe('/workspace');
      expect(meta.projectId).toBe('proj-1');
    });
  });

  describe('migrateConversation', () => {
    it('writes messages to JSONL and updates index', async () => {
      const messages = [
        makeMsg({ id: 'mig-1', content: 'User message' }),
        makeMsg({ id: 'mig-2', role: 'assistant', content: 'AI response' }),
      ];

      await storage.migrateConversation({
        id: 'conv-mig',
        title: 'Migrated',
        createdAt: 1000,
        updatedAt: 2000,
        messages,
      });

      // Verify messages
      const loaded = await storage.loadMessages('conv-mig');
      expect(loaded).toHaveLength(2);
      expect(loaded[0].content).toBe('User message');
      expect(loaded[1].content).toBe('AI response');

      // Verify index
      const entries = storage.getIndexEntries();
      expect(entries['conv-mig']).toBeDefined();
      expect(entries['conv-mig'].title).toBe('Migrated');
      expect(entries['conv-mig'].messageCount).toBe(2);
    });
  });

  describe('rich content preservation', () => {
    it('preserves HTML widget content intact', async () => {
      const html = '<html><body><h1>Widget</h1><script>alert("hi")</script></body></html>';
      const msg = makeMsg({
        id: 'html-1',
        role: 'assistant',
        content: `Here is the widget:\n\`\`\`html\n${html}\n\`\`\``,
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded[0].content).toContain(html);
    });

    it('preserves Mermaid diagram content intact', async () => {
      const mermaid = 'graph TD\n  A-->B\n  B-->C';
      const msg = makeMsg({
        id: 'mermaid-1',
        role: 'assistant',
        content: `\`\`\`mermaid\n${mermaid}\n\`\`\``,
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded[0].content).toContain(mermaid);
    });

    it('preserves tool calls with results', async () => {
      const msg = makeMsg({
        id: 'tc-1',
        role: 'assistant',
        content: 'Let me read the file',
        toolCalls: [{
          id: 'tc-call-1',
          name: 'read_file',
          input: { path: '/src/main.ts' },
          result: 'console.log("hello")',
        }],
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded[0].toolCalls).toHaveLength(1);
      expect(loaded[0].toolCalls![0].name).toBe('read_file');
      expect(loaded[0].toolCalls![0].result).toBe('console.log("hello")');
    });

    it('preserves large tool result disk references', async () => {
      const diskRef = '[session-memory:tc-big-1]\n[Full output: 50000 chars]\nPreview...';
      const msg = makeMsg({
        id: 'ref-1',
        role: 'assistant',
        content: 'Search results',
        toolCalls: [{
          id: 'tc-big-1',
          name: 'search_files',
          input: { pattern: '*.ts' },
          result: diskRef,
        }],
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded[0].toolCalls![0].result).toBe(diskRef);
    });
  });
});
