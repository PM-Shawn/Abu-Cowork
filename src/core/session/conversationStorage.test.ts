import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exists, readTextFile, writeTextFile, mkdir, remove, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { foldMessageLog } from './messageLedger';
import { APP_VERSION } from '@/utils/version';
import type { Message } from '@/types';
import { DURABLE_TOOL_RESULT_MAX_BYTES_PER_LIST } from './durableToolResultContent';

// Must import AFTER vi.mock (global mock in setup.ts handles @tauri-apps/plugin-fs)
// We re-import the module fresh for each test to reset module-level state
let storage: typeof import('./conversationStorage');

// Deterministic id source (TESTING.md §3) — a monotonic counter guarantees each
// makeMsg() call gets a distinct id, which storage.ts's writtenIds dedup logic
// and "keep last occurrence per id" utilities depend on; a fixed constant would
// silently collapse distinct messages under repeated no-override calls (e.g.
// `[makeMsg(), makeMsg(), makeMsg()]`).
let msgIdCounter = 0;

// Helper: create a minimal message
function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${++msgIdCounter}`,
    role: 'user',
    content: 'Hello',
    timestamp: 1_700_000_000_000, // filler — not asserted on
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
    args?: { path?: string; content?: string; data?: string },
  ) => {
    if (cmd === 'atomic_write_text' && args?.path !== undefined) {
      writeToMemory(args.path, args.content ?? '');
      return;
    }
    if (cmd === 'append_file_text') {
      // Part B1: default to "native append unavailable" so every existing
      // test (written against the read+atomic-write fallback) keeps
      // exercising that path unchanged. Tests that specifically cover the
      // native-append success path override this mock locally.
      throw new Error('native append unavailable in test');
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

  describe('appendTruncateEvent', () => {
    it('durably truncates a persisted message and releases its dedup id', async () => {
      await storage.appendMessage('conv-delete-one', makeMsg({ id: 'keep', content: 'keep me' }));
      await storage.appendMessage('conv-delete-one', makeMsg({ id: 'ghost', role: 'assistant', content: '' }));
      await storage.flushWrites();

      await expect(
        storage.appendTruncateEvent('conv-delete-one', 'ghost', { pid: 'keep', removedIds: ['ghost'] }),
      ).resolves.toBe(true);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-delete-one');
      expect(loaded.map((message) => message.id)).toEqual(['keep']);
      expect(storage.isMessageWrittenToDisk('ghost')).toBe(false);
    });

    it('is a no-op (skip guard) for an id that never reached disk and has no pending put', async () => {
      await expect(
        storage.appendTruncateEvent('conv-missing', 'never-written', { removedIds: ['never-written'] }),
      ).resolves.toBe(false);
    });
  });

  describe('appendTruncateEvent · mid-drain race (review finding #1)', () => {
    it('still writes the truncate event while the target put is dequeued but unsettled', async () => {
      // Block the native append so the drain holding the put stays in flight.
      let releaseAppend!: () => void;
      const appendGate = new Promise<void>((r) => { releaseAppend = r; });
      let appendCalls = 0;
      (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string, args?: { path?: string; data?: string }) => {
        if (cmd === 'append_file_text') {
          appendCalls++;
          if (appendCalls === 1) await appendGate; // first drain (the put) blocks
          memFs.files.set(args!.path!, (memFs.files.get(args!.path!) ?? '') + (args!.data ?? ''));
          return undefined;
        }
        return undefined;
      });

      const putPromise = storage.appendMessage('race-conv', makeMsg({ id: 'race-put', content: 'checkpoint' }));
      // Drain microtasks so appendMessage's async preamble finishes ENQUEUEING
      // the put before we trigger the drain that dequeues it.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const drain = storage.flushWrites(); // dequeues the put; append now in flight
      await Promise.resolve(); // let drainAll register the in-flight keys
      // Window under test: not in writeQueues, not yet in writtenIds. Don't
      // await yet — the event's own drain queues behind the blocked append on
      // the same file lock; release the gate first, then assert.
      const truncPromise = storage.appendTruncateEvent('race-conv', 'race-put', { removedIds: ['race-put'] });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      releaseAppend();
      const wrote = await truncPromise;
      expect(wrote).toBe(true); // in-flight guard must count the put
      await Promise.all([putPromise, drain]);
      await storage.flushWrites();

      const raw = memFs.files.get('/Users/testuser/.abu/conversations/race-conv/messages.jsonl') ?? '';
      expect(raw).toContain('"race-put"');
      expect(raw).toContain('"lk":"msg.truncate"');
      const folded = foldMessageLog(raw.split('\n'));
      expect(folded.messages.some((m) => m.id === 'race-put')).toBe(false);
    });
  });

  describe('appendToFile · native append (Part B1)', () => {
    it('uses the native append_file_text command and skips the atomic-write fallback when it succeeds', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
      (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
        cmd: string,
        args?: Record<string, unknown>,
      ) => {
        calls.push({ cmd, args });
        if (cmd === 'append_file_text') {
          // Simulate a successful native append — no read/rewrite of the file.
          return undefined;
        }
        if (cmd === 'atomic_write_text') {
          throw new Error('should not fall back to atomic_write_text when native append succeeds');
        }
        return undefined;
      });

      const msg = makeMsg({ id: 'native-1', content: 'native hello' });
      await storage.appendMessage('conv-native', msg);
      await storage.flushWrites();

      const appendCalls = calls.filter((c) => c.cmd === 'append_file_text');
      expect(appendCalls).toHaveLength(1);
      expect(appendCalls[0].args?.path).toEqual(expect.stringContaining('conv-native'));
      expect(appendCalls[0].args?.data).toEqual(expect.stringContaining('native hello'));

      // Fallback path (atomicWrite → invoke('atomic_write_text')) must never fire
      // for THIS conversation's messages.jsonl. Scoped to that path rather than
      // "no atomic_write_text call at all": ensureBase's first call in a fresh
      // process also does a one-time, version-gated snapshot sweep (plan §3.6
      // addendum, part B) that writes its own marker file via atomicWrite —
      // an unrelated call this test isn't pinning down.
      expect(
        calls.some((c) => c.cmd === 'atomic_write_text' && String(c.args?.path ?? '').includes('conv-native')),
      ).toBe(false);
    });

    it('falls back to read + atomic-write when native append fails, and no data is lost', async () => {
      // memFs's default mock (set up in createMemoryFs) already rejects
      // append_file_text, so appendToFile should transparently fall back.
      const seed = makeMsg({ id: 'seed', content: 'seed message' });
      await storage.appendMessage('conv-fallback', seed);
      await storage.flushWrites();

      const appended = makeMsg({ id: 'fallback-1', content: 'fallback hello' });
      await storage.appendMessage('conv-fallback', appended);
      await storage.flushWrites();

      // atomic_write_text must have been used (the fallback path).
      const atomicWriteCalls = (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === 'atomic_write_text',
      );
      expect(atomicWriteCalls.length).toBeGreaterThan(0);

      const loaded = await storage.loadMessages('conv-fallback');
      expect(loaded).toHaveLength(2);
      expect(loaded[0].content).toBe('seed message');
      expect(loaded[1].content).toBe('fallback hello');
    });
  });

  describe('SQLite catalog write-through (message-storage P0)', () => {
    it('bumps the catalog count on each append, best-effort after the JSONL write', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
      (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
        cmd: string,
        args?: Record<string, unknown>,
      ) => {
        calls.push({ cmd, args });
        // append_file_text unavailable → exercises the atomic-write fallback,
        // matching every other test in this file.
        if (cmd === 'append_file_text') throw new Error('native append unavailable in test');
        if (cmd === 'atomic_write_text' && (args as { path?: string })?.path !== undefined) {
          return undefined;
        }
        return undefined;
      });

      await storage.appendMessage('conv-cat', makeMsg({ id: 'c1', timestamp: 111 }));
      await storage.appendMessage('conv-cat', makeMsg({ id: 'c2', timestamp: 222 }));
      await storage.flushWrites();

      const bumps = calls.filter((c) => c.cmd === 'catalog_bump_count');
      expect(bumps).toHaveLength(2);
      expect(bumps[0].args).toMatchObject({ convId: 'conv-cat', delta: 1, updatedAt: 111, lastMessageId: 'c1' });
      expect(bumps[1].args).toMatchObject({ convId: 'conv-cat', delta: 1, updatedAt: 222, lastMessageId: 'c2' });
      expect(bumps[0].args?.conversationsRoot).toEqual(expect.stringContaining('conversations'));
    });

    it('a failing catalog_bump_count never breaks the JSONL append', async () => {
      (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
        cmd: string,
        args?: { path?: string; content?: string },
      ) => {
        if (cmd === 'catalog_bump_count') throw new Error('catalog DB unavailable');
        if (cmd === 'append_file_text') throw new Error('native append unavailable in test');
        // atomic_write fallback routes to the memory fs via writeTextFile in the
        // default mock; re-implement the minimal write here so loadMessages sees it.
        if (cmd === 'atomic_write_text' && args?.path !== undefined) {
          await (writeTextFile as ReturnType<typeof vi.fn>)(args.path, args.content ?? '');
          return undefined;
        }
        return undefined;
      });

      await expect(
        storage.appendMessage('conv-safe', makeMsg({ id: 's1', content: 'kept' })),
      ).resolves.toBeUndefined();
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-safe');
      expect(loaded).toHaveLength(1);
      expect(loaded[0].content).toBe('kept');
    });

    // Regression (code-review fix #9): appendMessage must NOT await the
    // catalog bump — it is best-effort and already swallows its own errors,
    // so there is nothing for the JSONL hot path to gain by waiting on it.
    // Before the fix, `await catalogBumpCount(...)` inside appendMessage meant
    // a never-settling (or merely slow) catalog_bump_count invoke would hang
    // every message append behind it. This test proves the opposite: with a
    // catalog_bump_count invoke that never resolves, appendMessage still
    // resolves promptly.
    it('does not await the catalog bump — appendMessage resolves even if catalog_bump_count never settles', async () => {
      let bumpCalled = false;
      let resolveBump: () => void = () => {};
      const bumpPromise = new Promise<void>((resolve) => {
        resolveBump = resolve;
      });

      (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
        cmd: string,
      ) => {
        if (cmd === 'append_file_text') throw new Error('native append unavailable in test');
        if (cmd === 'catalog_bump_count') {
          bumpCalled = true;
          await bumpPromise; // deliberately never resolves during this test
          return undefined;
        }
        return undefined;
      });

      // If appendMessage awaited catalogBumpCount, this would hang until the
      // test's timeout since bumpPromise never settles. Resolving here proves
      // the catalog bump is fire-and-forget.
      await storage.appendMessage('conv-fire-forget', makeMsg({ id: 'ff1' }));
      expect(bumpCalled).toBe(true);

      resolveBump(); // let the dangling promise settle so it doesn't leak into other tests
    });

    it('reconcileCatalog invokes catalog_reconcile with the conversations root', async () => {
      const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
      (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
        cmd: string,
        args?: Record<string, unknown>,
      ) => {
        calls.push({ cmd, args });
        return undefined;
      });
      await storage.reconcileCatalog();
      const reconcile = calls.filter((c) => c.cmd === 'catalog_reconcile');
      expect(reconcile).toHaveLength(1);
      expect(reconcile[0].args?.conversationsRoot).toEqual(expect.stringContaining('conversations'));
    });

    describe('catalogGetCount', () => {
      it('resolves the message_count from catalog_get_conversation', async () => {
        (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
          cmd: string,
          args?: Record<string, unknown>,
        ) => {
          if (cmd === 'catalog_get_conversation') {
            expect(args?.convId).toBe('conv-count');
            return { conv_id: 'conv-count', message_count: 42 };
          }
          return undefined;
        });

        await expect(storage.catalogGetCount('conv-count')).resolves.toBe(42);
      });

      it('returns null when the row is missing', async () => {
        (invoke as ReturnType<typeof vi.fn>).mockImplementation(async () => null);
        await expect(storage.catalogGetCount('conv-missing')).resolves.toBeNull();
      });

      it('returns null when invoke throws', async () => {
        (invoke as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          throw new Error('IPC failure');
        });
        await expect(storage.catalogGetCount('conv-error')).resolves.toBeNull();
      });
    });

    // message-storage hybrid P2: FTS5 conversation search wrapper.
    describe('catalogSearch', () => {
      it('resolves the hits returned by catalog_search, passing query and limit through', async () => {
        const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
        (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
          cmd: string,
          args?: Record<string, unknown>,
        ) => {
          calls.push({ cmd, args });
          if (cmd === 'catalog_search') {
            return [
              { conv_id: 'conv-1', title: 'Widget Launch', snippet: '<mark>widget</mark> launch plan', rank: 0.5 },
            ];
          }
          return undefined;
        });

        const hits = await storage.catalogSearch('widget', 10);
        expect(hits).toEqual([
          { conv_id: 'conv-1', title: 'Widget Launch', snippet: '<mark>widget</mark> launch plan', rank: 0.5 },
        ]);
        const searchCall = calls.find((c) => c.cmd === 'catalog_search');
        expect(searchCall?.args).toEqual({ query: 'widget', limit: 10 });
      });

      it('returns [] when invoke throws', async () => {
        (invoke as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          throw new Error('IPC failure');
        });
        await expect(storage.catalogSearch('widget')).resolves.toEqual([]);
      });

      it('returns [] when catalog_search resolves nothing useful', async () => {
        (invoke as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
        await expect(storage.catalogSearch('ab')).resolves.toEqual([]);
      });
    });

    // message-storage hybrid P2: live-freshness single-conversation reindex.
    describe('catalogReindexConversation', () => {
      it('flushes the index then invokes catalog_reindex_conversation with convId + conversationsRoot', async () => {
        const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
        (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
          cmd: string,
          args?: Record<string, unknown>,
        ) => {
          calls.push({ cmd, args });
          return undefined;
        });

        // Populate indexCache the way a real caller would: both
        // renameConversation and turn-end call updateIndexEntry() immediately
        // before catalogReindexConversation. Without this, indexCache stays
        // null and flushIndex() is a correct no-op (nothing to flush).
        await storage.updateIndexEntry({
          id: 'conv-live',
          title: 'Widget Launch',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
        });
        calls.length = 0;

        await storage.catalogReindexConversation('conv-live');

        const reindexCalls = calls.filter((c) => c.cmd === 'catalog_reindex_conversation');
        expect(reindexCalls).toHaveLength(1);
        expect(reindexCalls[0].args?.convId).toBe('conv-live');
        expect(reindexCalls[0].args?.conversationsRoot).toEqual(expect.stringContaining('conversations'));

        // The index flush (atomic_write_text against index.json) must happen
        // BEFORE the reindex invoke — otherwise the Rust side would read a
        // stale on-disk title/timestamp for a rename that just updated the
        // in-memory indexCache but hasn't hit disk yet (debounced up to 2s).
        const flushIdx = calls.findIndex((c) => c.cmd === 'atomic_write_text' && typeof c.args?.path === 'string' && (c.args.path as string).includes('index.json'));
        const reindexIdx = calls.findIndex((c) => c.cmd === 'catalog_reindex_conversation');
        expect(flushIdx).toBeGreaterThanOrEqual(0);
        expect(flushIdx).toBeLessThan(reindexIdx);
      });

      it('swallows errors from invoke and never throws', async () => {
        (invoke as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          throw new Error('IPC failure');
        });
        await expect(storage.catalogReindexConversation('conv-error')).resolves.toBeUndefined();
      });

      // Fix #3: catalogReindexConversation must also drain the pending
      // message-append write queue (flushWrites), not just the index queue —
      // otherwise a turn-end reindex can race a still-queued final message
      // and scan a messages.jsonl missing the very content it's meant to index.
      it('drains the pending message-append queue before invoking catalog_reindex_conversation', async () => {
        const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
        (invoke as ReturnType<typeof vi.fn>).mockImplementation(async (
          cmd: string,
          args?: Record<string, unknown>,
        ) => {
          calls.push({ cmd, args });
          if (cmd === 'append_file_text') {
            throw new Error('native append unavailable in test');
          }
          return undefined;
        });

        await storage.updateIndexEntry({
          id: 'conv-live2',
          title: 'Widget Launch 2',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
        });
        calls.length = 0;

        // Enqueue a message write WITHOUT flushing it — this sits in the
        // 100ms-debounced write queue exactly like a real turn-end append
        // does when setConversationStatus fires the reindex immediately after.
        const appendPromise = storage.appendMessage('conv-live2', {
          id: 'm-late',
          role: 'assistant',
          content: 'final reply',
          timestamp: 1_700_000_000_000, // filler — not asserted on
        });

        await storage.catalogReindexConversation('conv-live2');
        await appendPromise;

        const writeIdx = calls.findIndex(
          (c) =>
            c.cmd === 'atomic_write_text' &&
            typeof c.args?.path === 'string' &&
            (c.args.path as string).includes('conv-live2') &&
            (c.args.path as string).includes('messages.jsonl'),
        );
        const reindexIdx = calls.findIndex((c) => c.cmd === 'catalog_reindex_conversation');
        expect(writeIdx).toBeGreaterThanOrEqual(0);
        expect(reindexIdx).toBeGreaterThanOrEqual(0);
        expect(writeIdx).toBeLessThan(reindexIdx);
      });
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

    it('dedups a duplicate line (non-idempotent native-append fallback)', async () => {
      const line = JSON.stringify(makeMsg({ id: 'dup', content: 'once' }));
      // Same line written twice — what a native append that durably wrote but
      // whose invoke promise rejected leaves behind (fallback re-appends).
      memFs.files.set(PATH, `${line}\n${line}\n`);
      const loaded = await storage.loadMessages('corrupt-conv');
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('dup');
    });

    it('keeps the last occurrence when a duplicate id has newer content', async () => {
      const older = JSON.stringify(makeMsg({ id: 'x', content: 'old' }));
      const newer = JSON.stringify(makeMsg({ id: 'x', content: 'new' }));
      memFs.files.set(PATH, `${older}\n${newer}\n`);
      const loaded = await storage.loadMessages('corrupt-conv');
      expect(loaded).toHaveLength(1);
      expect(loaded[0].content).toBe('new');
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

    it('strict replacement confirms that the message reached durable storage', async () => {
      await storage.appendMessage(
        'strict-conv',
        makeMsg({ id: 'strict-msg', content: 'before' }),
      );
      await storage.flushWrites();

      await storage.replaceMessageByIdStrict(
        'strict-conv',
        makeMsg({ id: 'strict-msg', content: 'after' }),
      );

      const loaded = await storage.loadMessages('strict-conv');
      expect(loaded.find((message) => message.id === 'strict-msg')?.content).toBe('after');
    });

    it('strict replacement rejects missing files and missing message rows', async () => {
      await expect(
        storage.replaceMessageByIdStrict(
          'missing-conv',
          makeMsg({ id: 'missing-msg' }),
        ),
      ).rejects.toThrow('does not exist');

      await storage.appendMessage(
        'strict-row-conv',
        makeMsg({ id: 'present-msg' }),
      );
      await storage.flushWrites();

      await expect(
        storage.replaceMessageByIdStrict(
          'strict-row-conv',
          makeMsg({ id: 'missing-msg' }),
        ),
      ).rejects.toThrow('was not found');
    });

    it('strict replacement surfaces atomic write failures', async () => {
      await storage.appendMessage(
        'strict-write-conv',
        makeMsg({ id: 'strict-write-msg', content: 'before' }),
      );
      await storage.flushWrites();
      // Both write paths fail: the native append AND the read+rewrite it falls
      // back to. A strict replacement must surface that, never report success.
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === 'atomic_write_text' || cmd === 'append_file_text') {
          throw new Error('disk full');
        }
        return undefined;
      });

      await expect(
        storage.replaceMessageByIdStrict(
          'strict-write-conv',
          makeMsg({ id: 'strict-write-msg', content: 'after' }),
        ),
      ).rejects.toThrow('disk full');
    });

    it('does not let a late whole-message write erase a settled recovery action', async () => {
      const recoveryToolCall = {
        id: 'recovery-tool',
        name: 'run_command',
        input: {},
        isExecuting: false,
        sandboxRecovery: {
          kind: 'app-automation' as const,
          targetApp: 'Notes',
        },
      };
      await storage.appendMessage(
        'recovery-race-conv',
        makeMsg({
          id: 'recovery-msg',
          toolCalls: [{
            ...recoveryToolCall,
            sandboxRecoveryAction: 'stopped',
          }],
        }),
      );
      await storage.flushWrites();

      await storage.replaceMessageById(
        'recovery-race-conv',
        makeMsg({
          id: 'recovery-msg',
          toolCalls: [recoveryToolCall],
        }),
      );

      const loaded = await storage.loadMessages('recovery-race-conv');
      expect(
        loaded.find((message) => message.id === 'recovery-msg')
          ?.toolCalls?.[0].sandboxRecoveryAction,
      ).toBe('stopped');
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

    // Regression (code-review fix #8): chatStore's ghost-message deletion
    // path (agentLoop.ts) checks isMessageWrittenToDisk before bumping the
    // catalog by -1, to avoid an unbalanced decrement when the +1 from
    // appendMessage never fired (message never durably reached disk).
    describe('isMessageWrittenToDisk', () => {
      it('is false before appendMessage runs and true after', async () => {
        const msg = makeMsg({ id: 'ghost-1', content: '' });
        expect(storage.isMessageWrittenToDisk('ghost-1')).toBe(false);
        await storage.appendMessage('conv-1', msg);
        expect(storage.isMessageWrittenToDisk('ghost-1')).toBe(true);
      });

      it('is true for a preexisting id populated from a disk load', async () => {
        const msg = makeMsg({ id: 'preexisting-2', content: 'From disk' });
        const path = '/Users/testuser/.abu/conversations/conv-3/messages.jsonl';
        memFs.files.set(path, JSON.stringify(msg) + '\n');
        memFs.dirs.add('/Users/testuser/.abu/conversations/conv-3');
        memFs.dirs.add('/Users/testuser/.abu/conversations');

        expect(storage.isMessageWrittenToDisk('preexisting-2')).toBe(false);
        await storage.loadMessages('conv-3');
        expect(storage.isMessageWrittenToDisk('preexisting-2')).toBe(true);
      });
    });
  });

  describe('stripForDisk', () => {
    it('preserves thinking content at full length', async () => {
      const longThinking = 'x'.repeat(2000);
      const msg = makeMsg({
        id: 'think-1',
        role: 'assistant',
        thinking: longThinking,
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded[0].thinking).toBe(longThinking);
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

    it('bounds nested tool-result images in both durable projections', async () => {
      const oversized = 'x'.repeat(DURABLE_TOOL_RESULT_MAX_BYTES_PER_LIST + 1);
      const image = {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png', data: oversized },
      };
      const msg = makeMsg({
        id: 'tool-rich-oversized',
        role: 'assistant',
        toolCalls: [{
          id: 'subagent-v1:run-a:call_1',
          name: 'computer',
          input: {},
          result: 'Screenshot attached',
          resultContent: [image],
          hidden: true,
          fromSubagent: true,
        }],
        toolCallsForContext: [{
          id: 'call_1',
          name: 'computer',
          input: {},
          result: 'Screenshot attached',
          resultContent: [image],
        }],
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const [loaded] = await storage.loadMessages('conv-1');
      expect(loaded.toolCalls?.[0].resultContent).toBeUndefined();
      expect(loaded.toolCalls?.[0].result).toContain('storage budget');
      expect(loaded.toolCallsForContext?.[0].resultContent).toBeUndefined();
      expect(loaded.toolCallsForContext?.[0].result).toContain('storage budget');
    });

    it('keeps a normal bounded subagent screenshot available for restart replay', async () => {
      const msg = makeMsg({
        id: 'tool-rich-normal',
        role: 'assistant',
        toolCalls: [{
          id: 'subagent-v1:run-a:call_1',
          name: 'computer',
          input: {},
          result: 'Screenshot attached',
          resultContent: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'NORMAL_IMAGE' },
          }],
          hidden: true,
          fromSubagent: true,
        }],
      });

      await storage.appendMessage('conv-1', msg);
      await storage.flushWrites();

      const [loaded] = await storage.loadMessages('conv-1');
      expect(loaded.toolCalls?.[0].resultContent?.[0]).toMatchObject({
        type: 'image',
        source: { data: 'NORMAL_IMAGE' },
      });
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
  // ══════════════════════════════════════════════════════════
  // Append-only ledger (docs/abu-message-ledger-plan.md, phase 2)
  // ══════════════════════════════════════════════════════════

  describe('ledger writes', () => {
    const MESSAGES = '/Users/testuser/.abu/conversations/conv-1/messages.jsonl';
    const SNAPSHOT = '/Users/testuser/.abu/conversations/conv-1/stream-snapshot.json';

    function physicalLines(path = MESSAGES): Record<string, unknown>[] {
      const raw = memFs.files.get(path) ?? '';
      return raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    }

    describe('replaceMessageById', () => {
      it('appends a revision instead of rewriting the matching line', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'v1' }));
        await storage.flushWrites();
        await storage.replaceMessageById('conv-1', makeMsg({ id: 'm1', content: 'v2' }));
        await storage.flushWrites();

        const rows = physicalLines();
        expect(rows).toHaveLength(2);
        // The original line is untouched — that is what append-only means.
        expect(rows[0]).toMatchObject({ id: 'm1', content: 'v1' });
        expect(rows[1]).toMatchObject({ id: 'm1', content: 'v2' });
      });

      it('keeps the revised message at its original position in the fold', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'first' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'm2', content: 'second' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'm3', content: 'third' }));
        await storage.flushWrites();

        await storage.replaceMessageById('conv-1', makeMsg({ id: 'm1', content: 'first-edited' }));
        await storage.flushWrites();

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
        expect(loaded[0].content).toBe('first-edited');
      });

      it('collapses revisions that are still queued into a single line', async () => {
        // No flush between the calls: all four writes sit in the queue at once,
        // so the same-id merge must leave exactly one physical line.
        void storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'v1' }));
        void storage.replaceMessageById('conv-1', makeMsg({ id: 'm1', content: 'v2' }));
        void storage.replaceMessageById('conv-1', makeMsg({ id: 'm1', content: 'v3' }));
        await storage.replaceMessageById('conv-1', makeMsg({ id: 'm1', content: 'v4' }));
        await storage.flushWrites();

        const rows = physicalLines();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'm1', content: 'v4' });
      });

      it('does not merge revisions of different messages into one line', async () => {
        void storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'a' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'm2', content: 'b' }));
        await storage.flushWrites();

        expect(physicalLines().map((r) => r.id)).toEqual(['m1', 'm2']);
      });

      it('is a no-op for an id the conversation never held', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'a' }));
        await storage.flushWrites();

        await storage.replaceMessageById('conv-1', makeMsg({ id: 'ghost', content: 'x' }));
        await storage.flushWrites();

        // An append is an upsert by nature; the old rewrite was not, and the
        // non-strict variant must keep behaving like the old one.
        expect(physicalLines()).toHaveLength(1);
      });

      it('preserves a settled sandbox recovery action without re-reading the file', async () => {
        const toolCall = {
          id: 'tc-1',
          name: 'run_command',
          input: {},
          sandboxRecovery: { kind: 'app-automation' as const, targetApp: 'Notes' },
        };
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', toolCalls: [toolCall] }));
        await storage.flushWrites();
        await storage.replaceMessageByIdStrict('conv-1', makeMsg({
          id: 'm1',
          toolCalls: [{ ...toolCall, sandboxRecoveryAction: 'completed' as const }],
        }));
        await storage.flushWrites();

        // A late whole-message write that lost the settled action must not
        // regress it — the protection now comes from the in-memory record, not
        // from reading the persisted row back.
        await storage.replaceMessageById('conv-1', makeMsg({ id: 'm1', toolCalls: [toolCall] }));
        await storage.flushWrites();

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded[0].toolCalls?.[0].sandboxRecoveryAction).toBe('completed');
      });

      it('records a parent pointer on first write and never re-parents a revision', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'a' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'm2', content: 'b' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'm3', content: 'c' }));
        await storage.flushWrites();
        await storage.replaceMessageById('conv-1', makeMsg({ id: 'm2', content: 'b-edited' }));
        await storage.flushWrites();

        const rows = physicalLines();
        expect(rows[0].pid).toBeUndefined();   // first message of the log has no parent
        expect(rows[1].pid).toBe('m1');
        expect(rows[2].pid).toBe('m2');
        // The revision keeps m2's original parent rather than pointing at the
        // current tail (m3) — plan §3.2.
        expect(rows[3]).toMatchObject({ id: 'm2', content: 'b-edited', pid: 'm1' });
      });
    });

    describe('updateLastMessage', () => {
      it('no longer overwrites a different message that happens to be last', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'assistant-1', content: 'partial' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'user-2', content: 'mid-stream question' }));
        await storage.flushWrites();

        await storage.updateLastMessage('conv-1', makeMsg({ id: 'assistant-1', content: 'complete' }));
        await storage.flushWrites();

        // The old blind last-line replace destroyed user-2 here.
        const loaded = await storage.loadMessages('conv-1');
        expect(loaded.map((m) => m.id)).toEqual(['assistant-1', 'user-2']);
        expect(loaded[0].content).toBe('complete');
        expect(loaded[1].content).toBe('mid-stream question');
      });

      it('writes nothing when the conversation has no file yet', async () => {
        await storage.updateLastMessage('conv-1', makeMsg({ id: 'm1' }));
        await storage.flushWrites();
        expect(memFs.files.has(MESSAGES)).toBe(false);
      });
    });

    describe('appendTruncateEvent', () => {
      it('edit-and-resend journey: append a,b,c → truncate from b → append d,e → fold keeps [a,d,e]', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'a', content: '1' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'b', content: '2' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'c', content: '3' }));
        await storage.flushWrites();

        await storage.appendTruncateEvent('conv-1', 'b', { pid: 'a', removedIds: ['b', 'c'] });
        await storage.appendMessage('conv-1', makeMsg({ id: 'd', content: '4' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'e', content: '5' }));
        await storage.flushWrites();

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded.map((m) => m.id)).toEqual(['a', 'd', 'e']);
      });

      it('revives a truncated id: re-appending it after the cut lands as a fresh row', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'a', content: '1' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'b', content: '2' }));
        await storage.flushWrites();

        await storage.appendTruncateEvent('conv-1', 'b', { pid: 'a', removedIds: ['b'] });
        await storage.flushWrites();
        expect(await storage.loadMessages('conv-1')).toHaveLength(1);

        // Without releasing `b` from writtenIds, this would be silently
        // dedup-skipped (appendMessage's `writtenIds.has` early return) and
        // the line would never even reach the queue.
        await storage.appendMessage('conv-1', makeMsg({ id: 'b', content: 'reborn' }));
        await storage.flushWrites();

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded.map((m) => m.id)).toEqual(['a', 'b']);
        expect(loaded[1].content).toBe('reborn');
      });

      it("the next message's parent pointer skips the removed tail and points at the surviving message", async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'a', content: '1' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'b', content: '2' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'c', content: '3' }));
        await storage.flushWrites();

        await storage.appendTruncateEvent('conv-1', 'b', { pid: 'a', removedIds: ['b', 'c'] });
        await storage.appendMessage('conv-1', makeMsg({ id: 'd', content: '4' }));
        await storage.flushWrites();

        const rows = physicalLines(MESSAGES);
        const dRow = rows.find((r) => r.id === 'd');
        // Points at 'a' (the surviving tail), never at 'c' (the removed
        // physical tail) — plan §3.2.
        expect(dRow).toMatchObject({ pid: 'a' });
      });

      it('truncating from the conversation\'s first message omits pid, and the next append has none either', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'a', content: '1' }));
        await storage.flushWrites();

        await storage.appendTruncateEvent('conv-1', 'a', { removedIds: ['a'] });
        await storage.appendMessage('conv-1', makeMsg({ id: 'b', content: '2' }));
        await storage.flushWrites();

        const rows = physicalLines(MESSAGES);
        const eventRow = rows.find((r) => r.lk === 'msg.truncate');
        expect(eventRow?.pid).toBeUndefined();
        const bRow = rows.find((r) => r.id === 'b');
        expect(bRow?.pid).toBeUndefined();
      });

      it('a persisted ghost gets a real truncate event line', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'user-1', content: 'hi' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'ghost-1', role: 'assistant', content: '' }));
        await storage.flushWrites();

        await expect(
          storage.appendTruncateEvent('conv-1', 'ghost-1', { pid: 'user-1', removedIds: ['ghost-1'] }),
        ).resolves.toBe(true);
        await storage.flushWrites();

        const rows = physicalLines(MESSAGES);
        expect(rows.some((r) => r.lk === 'msg.truncate' && r.from === 'ghost-1')).toBe(true);
      });

      it('a never-persisted ghost writes no event line at all', async () => {
        // Never appended, and nothing queued for it either — the pure
        // in-memory case (a streaming placeholder aborted before its first
        // checkpoint ever reached appendMessage).
        await expect(
          storage.appendTruncateEvent('conv-1', 'ghost-never-written', { removedIds: ['ghost-never-written'] }),
        ).resolves.toBe(false);
        expect(memFs.files.has(MESSAGES)).toBe(false);
      });

      it('survives a restart: loadMessages after a fresh module re-import still folds the truncate', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'a', content: '1' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'b', content: '2' }));
        await storage.flushWrites();
        await storage.appendTruncateEvent('conv-1', 'b', { pid: 'a', removedIds: ['b'] });
        await storage.flushWrites();

        // Simulate an app restart: all module-level state (writtenIds,
        // parentIdByMessage, ...) is gone, and the only source of truth left
        // is what actually landed in memFs.
        vi.resetModules();
        storage = await import('./conversationStorage');

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded.map((m) => m.id)).toEqual(['a']);
      });
    });

    describe('stream snapshot', () => {
      it('keeps in-flight revisions out of the ledger but readable after a crash', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: '' }));
        await storage.flushWrites();

        for (const chunk of ['a', 'ab', 'abc']) {
          await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'm1', content: chunk }));
        }

        expect(physicalLines()).toHaveLength(1);       // ledger untouched
        expect(memFs.files.has(SNAPSHOT)).toBe(true);  // but the state is durable

        // Simulate the reload after a crash mid-stream.
        vi.resetModules();
        storage = await import('./conversationStorage');
        const loaded = await storage.loadMessages('conv-1');
        expect(loaded).toHaveLength(1);
        expect(loaded[0].content).toBe('abc');
      });

      it('drops the buffered revision once a checkpoint commits it', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: '' }));
        await storage.flushWrites();
        await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'm1', content: 'streaming' }));
        expect(memFs.files.has(SNAPSHOT)).toBe(true);

        await storage.replaceMessageById('conv-1', makeMsg({ id: 'm1', content: 'final' }));
        await storage.flushWrites();

        expect(memFs.files.has(SNAPSHOT)).toBe(false);
        const loaded = await storage.loadMessages('conv-1');
        expect(loaded[0].content).toBe('final');
      });

      it('promotes anything still buffered into the ledger on shutdown', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: '' }));
        await storage.flushWrites();
        await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'm1', content: 'unflushed' }));

        await storage.shutdownConversationStorage();

        expect(memFs.files.has(SNAPSHOT)).toBe(false);
        const rows = physicalLines();
        expect(rows[rows.length - 1]).toMatchObject({ id: 'm1', content: 'unflushed' });
      });

      it('does not resurrect a message that was deleted while buffered', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'a' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'm2', content: 'b' }));
        await storage.flushWrites();
        await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'm2', content: 'b-live' }));

        await storage.appendTruncateEvent('conv-1', 'm2', { pid: 'm1', removedIds: ['m2'] });
        await storage.flushWrites();

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded.map((m) => m.id)).toEqual(['m1']);
      });
    });

    // ══════════════════════════════════════════════════════════
    // RB-03 (V0.40.0-RELEASE-READINESS-AUDIT.md): a crash-leftover stream
    // snapshot is folded in as a trailing put with no regard for whether the
    // ledger has since moved past it — a newer durable revision, or a
    // truncate that removed the id, can both be silently overridden by the
    // stale in-memory content. The fix stamps each snapshot entry with the
    // ledger's byte length at capture time and drops the entry at load if
    // the ledger contains, at or after that offset, either a newer put for
    // the same id or a removal event that cut it.
    //
    // Every "stale leftover" case below manipulates `memFs.files` directly
    // to restore a snapshot file AFTER the normal drop path (checkpoint /
    // truncate) already deleted it — that is exactly what a crash between
    // the ledger write landing and the snapshot delete completing leaves
    // behind, and is not reachable by driving the public API alone.
    describe('RB-03: stale stream-snapshot supersede guard', () => {
      it('audit repro 1: a stale snapshot must not override a newer final ledger revision', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: '' }));
        await storage.flushWrites();
        await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'm1', content: 'partial' }));
        const staleSnapshot = memFs.files.get(SNAPSHOT);
        expect(staleSnapshot).toBeDefined();

        // The checkpoint lands the final revision and (in the non-crash case)
        // deletes the now-superseded snapshot file.
        await storage.replaceMessageById('conv-1', makeMsg({ id: 'm1', content: 'FINAL' }));
        await storage.flushWrites();
        expect(memFs.files.has(SNAPSHOT)).toBe(false);

        // Simulate a crash between that ledger append landing and the
        // snapshot delete completing: the stale file survives on disk.
        memFs.files.set(SNAPSHOT, staleSnapshot!);
        vi.resetModules();
        storage = await import('./conversationStorage');

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded).toHaveLength(1);
        expect(loaded[0].content).toBe('FINAL');
      });

      it('audit repro 2: a stale snapshot must not revive a message a truncate already cut', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'a' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'm2', content: 'b' }));
        await storage.flushWrites();
        await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'm2', content: 'b-live' }));
        const staleSnapshot = memFs.files.get(SNAPSHOT);
        expect(staleSnapshot).toBeDefined();

        await storage.appendTruncateEvent('conv-1', 'm2', { pid: 'm1', removedIds: ['m2'] });
        await storage.flushWrites();
        expect(memFs.files.has(SNAPSHOT)).toBe(false);

        // Simulate the same crash window as above, but on the truncate path.
        memFs.files.set(SNAPSHOT, staleSnapshot!);
        vi.resetModules();
        storage = await import('./conversationStorage');

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded.map((m) => m.id)).toEqual(['m1']);
      });

      it('checkpoint-then-crash-before-delete via updateLastMessage also drops the stale entry', async () => {
        // Same hazard as audit repro 1, exercised through the OTHER checkpoint
        // call site (`updateLastMessage`, used when the caller does not know
        // the finishing message's id ahead of time) to cover both drop sites.
        await storage.appendMessage('conv-1', makeMsg({ id: 'assistant-1', content: '' }));
        await storage.flushWrites();
        await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'assistant-1', content: 'streaming...' }));
        const staleSnapshot = memFs.files.get(SNAPSHOT);
        expect(staleSnapshot).toBeDefined();

        await storage.updateLastMessage('conv-1', makeMsg({ id: 'assistant-1', content: 'complete' }));
        await storage.flushWrites();
        expect(memFs.files.has(SNAPSHOT)).toBe(false);

        memFs.files.set(SNAPSHOT, staleSnapshot!);
        vi.resetModules();
        storage = await import('./conversationStorage');

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded).toHaveLength(1);
        expect(loaded[0].content).toBe('complete');
      });

      it('a legacy (pre-fix) unstamped snapshot keeps the old unconditional-merge behavior', async () => {
        memFs.files.set(
          MESSAGES,
          JSON.stringify(makeMsg({ id: 'm1', content: 'FINAL' })) + '\n',
        );
        // v1 on-disk shape: no `stamp` on any entry — a build predating this
        // fix could have left this file behind.
        memFs.files.set(
          SNAPSHOT,
          JSON.stringify({
            version: 1,
            messages: [{ id: 'm1', role: 'user', content: 'legacy-partial', timestamp: 1 }],
          }),
        );

        const loaded = await storage.loadMessages('conv-1');
        // Unchanged from pre-fix behavior: an unstamped entry has nothing to
        // compare against the ledger, so it still folds in unconditionally.
        expect(loaded[0].content).toBe('legacy-partial');
      });

      it('a snapshot entry with no later ledger write still applies (crash-protection survives)', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: '' }));
        await storage.flushWrites();
        await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'm1', content: 'still-streaming' }));

        // Crash before any checkpoint ever reaches the ledger — the buffered
        // revision is the ONLY copy of this content anywhere.
        vi.resetModules();
        storage = await import('./conversationStorage');

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded).toHaveLength(1);
        expect(loaded[0].content).toBe('still-streaming');
      });

      it('a truncate BEFORE the snapshot stamp does not drop a post-truncate revival', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'a' }));
        await storage.flushWrites();
        await storage.appendTruncateEvent('conv-1', 'm1', { removedIds: ['m1'] });
        await storage.flushWrites();

        // The user revives m1 (a fresh put after the truncate — the fold's
        // put-after-truncate resurrection rule) and it is still streaming
        // when the crash-protection buffer captures it, well AFTER the
        // truncate's offset.
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'revived' }));
        await storage.flushWrites();
        await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'm1', content: 'revived-streaming' }));

        vi.resetModules();
        storage = await import('./conversationStorage');

        const loaded = await storage.loadMessages('conv-1');
        // Must NOT be misfiltered by the earlier (now-irrelevant) truncate —
        // the revival the user performed after it must survive.
        expect(loaded.map((m) => m.id)).toEqual(['m1']);
        expect(loaded[0].content).toBe('revived-streaming');
      });
    });

    describe('ledger byte watermark (plan §3.6 addendum, part A)', () => {
      // A snapshot's `ledgerBytes` records how long messages.jsonl was when the
      // snapshot was last written. `loadMessages` compares that against the
      // ledger it just read: append-only ledgers never shrink on their own, so
      // a shorter-than-watermark ledger means a foreign/older build rewrote the
      // file in place since the snapshot was taken (the downgrade-then-
      // reupgrade scenario) — the snapshot's revisions no longer apply and must
      // be discarded rather than merged over the user's edited history.

      it('discards and deletes a snapshot whose watermark exceeds the current ledger length', async () => {
        memFs.files.set(MESSAGES, JSON.stringify(makeMsg({ id: 'm1', content: 'ledger-content' })) + '\n');
        memFs.files.set(SNAPSHOT, JSON.stringify({
          version: 1,
          messages: [makeMsg({ id: 'm1', content: 'STALE — relative to a ledger tail that no longer exists' })],
          // Far beyond the (much shorter) ledger set above — simulates a
          // foreign/older build having rewritten messages.jsonl smaller since
          // this snapshot was taken.
          ledgerBytes: 1_000_000,
        }));

        const loaded = await storage.loadMessages('conv-1');

        expect(loaded).toHaveLength(1);
        expect(loaded[0].content).toBe('ledger-content'); // snapshot's stale revision was NOT merged
        expect(memFs.files.has(SNAPSHOT)).toBe(false);    // and the snapshot file itself was deleted
      });

      it('still merges when the watermark equals the current ledger length', async () => {
        const raw = JSON.stringify(makeMsg({ id: 'm1', content: 'ledger-content' })) + '\n';
        memFs.files.set(MESSAGES, raw);
        memFs.files.set(SNAPSHOT, JSON.stringify({
          version: 1,
          messages: [makeMsg({ id: 'm1', content: 'still-streaming' })],
          ledgerBytes: raw.length,
        }));

        const loaded = await storage.loadMessages('conv-1');

        expect(loaded[0].content).toBe('still-streaming');
        expect(memFs.files.has(SNAPSHOT)).toBe(true); // merge is the normal path — nothing discarded
      });

      it('still merges when the watermark is smaller than the current ledger length', async () => {
        const raw = JSON.stringify(makeMsg({ id: 'm1', content: 'ledger-content' })) + '\n';
        memFs.files.set(MESSAGES, raw);
        memFs.files.set(SNAPSHOT, JSON.stringify({
          version: 1,
          messages: [makeMsg({ id: 'm1', content: 'still-streaming' })],
          ledgerBytes: raw.length - 1,
        }));

        const loaded = await storage.loadMessages('conv-1');

        expect(loaded[0].content).toBe('still-streaming');
        expect(memFs.files.has(SNAPSHOT)).toBe(true);
      });

      it('merges unconditionally when the snapshot predates the watermark field (legacy snapshot)', async () => {
        const raw = JSON.stringify(makeMsg({ id: 'm1', content: 'ledger-content' })) + '\n';
        memFs.files.set(MESSAGES, raw);
        memFs.files.set(SNAPSHOT, JSON.stringify({
          version: 1,
          messages: [makeMsg({ id: 'm1', content: 'still-streaming' })],
          // No `ledgerBytes` — a snapshot written by a build that predates this
          // field. Missing watermark must fall back to today's behavior: merge.
        }));

        const loaded = await storage.loadMessages('conv-1');

        expect(loaded[0].content).toBe('still-streaming');
        expect(memFs.files.has(SNAPSHOT)).toBe(true);
      });
    });

    describe('crash windows', () => {
      it('keeps the snapshot file when a shutdown promotion never reaches the ledger', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: '' }));
        await storage.flushWrites();
        await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'm1', content: 'unflushed' }));

        // Both ledger write paths fail at exit. Dropping the snapshot anyway
        // would discard the revision with no copy left anywhere.
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
          if (cmd === 'append_file_text' || cmd === 'atomic_write_text') {
            throw new Error('disk full');
          }
          return undefined;
        });

        await storage.shutdownConversationStorage();

        expect(memFs.files.has(SNAPSHOT)).toBe(true);
      });


      it('does not let a torn last line swallow the next append', async () => {
        // A crash mid-append (native append has no atomicity guarantee, see
        // appendToFile) leaves the tail unterminated. Nothing rewrites the file
        // any more, so without an explicit repair every later append is glued
        // onto that stump and both messages parse as one corrupt line.
        memFs.files.set(
          MESSAGES,
          JSON.stringify({ id: 'm1', role: 'user', content: 'a', timestamp: 1 }) + '\n'
            + '{"id":"m2","role":"user","content":"tor',
        );

        await storage.loadMessages('conv-1');
        await storage.appendMessage('conv-1', makeMsg({ id: 'm3', content: 'after crash' }));
        await storage.flushWrites();

        const loaded = await storage.loadMessages('conv-1');
        expect(loaded.map((m) => m.id)).toEqual(['m1', 'm3']);
      });

      it('a queued put lands BEFORE a same-drain-window truncate event, and the fold still removes it (queue ordering)', async () => {
        await storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'a' }));
        await storage.appendMessage('conv-1', makeMsg({ id: 'm2', content: 'b' }));
        await storage.flushWrites();

        // Checkpoint write still sitting in the 100ms-debounced queue when the
        // truncate lands — the abort path does exactly this (agentLoop's ghost
        // cleanup runs right behind the turn's last persist). The pending put
        // is what keeps appendTruncateEvent's skip guard from firing: `m2`
        // isn't in `writtenIds` yet, but it IS `hasPendingPut`.
        const queued = storage.replaceMessageById('conv-1', makeMsg({ id: 'm2', content: 'b-checkpoint' }));
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await expect(
          storage.appendTruncateEvent('conv-1', 'm2', { pid: 'm1', removedIds: ['m2'] }),
        ).resolves.toBe(true);
        await storage.flushWrites();
        await queued;

        const rows = physicalLines(MESSAGES);
        // The put physically lands before the event line — order-sensitive
        // enqueue, no coalescing across it.
        expect(rows.map((r) => r.id)).toEqual(['m1', 'm2', 'm2', rows[3].id]);
        expect(rows[2]).toMatchObject({ id: 'm2', content: 'b-checkpoint' });
        expect(rows[3]).toMatchObject({ lk: 'msg.truncate', from: 'm2' });
        // ...and the fold then removes it.
        const loaded = await storage.loadMessages('conv-1');
        expect(loaded.map((m) => m.id)).toEqual(['m1']);
      });
    });

    describe('write amplification budget', () => {
      // Plan §3.6: a tool-heavy conversation revises the same growing message
      // many times per turn. The acceptance criterion is that messages.jsonl
      // stays within 3x the folded content it represents.
      //
      // The simulation mirrors the real call sequence in agentLoop: each turn
      // creates its OWN assistant message, buffers the streaming flushes and
      // every tool result to the snapshot, then commits the finished message
      // to the ledger at the batch checkpoint and again at turn end.
      const TURNS = 4;
      const TOOLS_PER_TURN = 3;
      const STREAM_FLUSHES_PER_TURN = 6;

      function assistantAfter(turn: number, toolResults: number): Message {
        return {
          id: `assistant-${turn}`,
          role: 'assistant',
          content: 'Working through the task. '.repeat(20),
          timestamp: 100 + turn,
          toolCalls: Array.from({ length: toolResults }, (_, i) => ({
            id: `tc-${turn}-${i}`,
            name: 'read_file',
            input: { path: `/src/file-${turn}-${i}.ts` },
            result: `contents of file ${i} `.repeat(40),
          })),
        };
      }

      function foldedBytes(path: string): number {
        const raw = memFs.files.get(path) ?? '';
        return foldMessageLog(raw.split('\n')).messages
          .reduce((sum, m) => sum + JSON.stringify(m).length + 1, 0);
      }

      /**
       * Drive one write all the way to disk as its own line. Draining
       * explicitly instead of awaiting the 100 ms debounce keeps the
       * simulation instant; the extra microtask turns just make sure the line
       * has reached the queue before the drain (and cost nothing if it has).
       */
      async function commit(write: Promise<unknown>): Promise<void> {
        for (let i = 0; i < 10; i++) await Promise.resolve();
        await storage.flushWrites();
        await write;
      }

      async function runTurn(convId: string, turn: number, toLedger: boolean): Promise<void> {
        await commit(storage.appendMessage(convId, assistantAfter(turn, 0)));
        const revise = async (message: Message) => {
          if (toLedger) await commit(storage.replaceMessageById(convId, message));
          else await storage.snapshotMessageRevision(convId, message);
        };
        for (let i = 0; i < STREAM_FLUSHES_PER_TURN; i++) await revise(assistantAfter(turn, 0));
        for (let i = 1; i <= TOOLS_PER_TURN; i++) await revise(assistantAfter(turn, i));
        // Batch checkpoint, then the turn-end persist — both real ledger writes.
        await commit(storage.replaceMessageById(convId, assistantAfter(turn, TOOLS_PER_TURN)));
        await commit(storage.replaceMessageById(convId, assistantAfter(turn, TOOLS_PER_TURN)));
      }

      it('holds messages.jsonl within 3x the folded content for a tool-heavy conversation', async () => {
        await commit(storage.appendMessage('conv-1', makeMsg({ id: 'user-1', content: 'do the thing', timestamp: 1 })));
        for (let turn = 0; turn < TURNS; turn++) await runTurn('conv-1', turn, false);

        const physical = (memFs.files.get(MESSAGES) ?? '').length;
        const folded = foldedBytes(MESSAGES);
        expect(folded).toBeGreaterThan(0);
        expect(physical).toBeLessThanOrEqual(folded * 3);
      });

      it('would blow the budget if every revision became a ledger line', async () => {
        // Guards the test above from passing vacuously: the identical turns with
        // the snapshot governance bypassed must exceed the same threshold.
        const path = '/Users/testuser/.abu/conversations/conv-2/messages.jsonl';
        await commit(storage.appendMessage('conv-2', makeMsg({ id: 'user-1', content: 'do the thing', timestamp: 1 })));
        for (let turn = 0; turn < TURNS; turn++) await runTurn('conv-2', turn, true);

        const physical = (memFs.files.get(path) ?? '').length;
        expect(physical).toBeGreaterThan(foldedBytes(path) * 3);
      });
    });
  });

  describe('snapshot sweep on version change (plan §3.6 addendum, part B)', () => {
    const BASE = '/Users/testuser/.abu/conversations';
    const MARKER = `${BASE}/.snapshot-sweep-version`;

    it('deletes every stale stream-snapshot.json exactly once, then the marker gates repeats across a restart', async () => {
      // Simulate leftovers from a previous app version, present before any
      // storage call has had a chance to run ensureBase's one-shot sweep.
      memFs.dirs.add(BASE);
      memFs.dirs.add(`${BASE}/conv-1`);
      memFs.dirs.add(`${BASE}/conv-2`);
      memFs.files.set(`${BASE}/conv-1/stream-snapshot.json`, JSON.stringify({ version: 1, messages: [makeMsg({ id: 'm1' })] }));
      memFs.files.set(`${BASE}/conv-2/stream-snapshot.json`, JSON.stringify({ version: 1, messages: [makeMsg({ id: 'm2' })] }));

      // "Launch" 1: no marker on disk yet → the first ensureBase() must sweep.
      await storage.loadIndex();

      expect(memFs.files.has(`${BASE}/conv-1/stream-snapshot.json`)).toBe(false);
      expect(memFs.files.has(`${BASE}/conv-2/stream-snapshot.json`)).toBe(false);
      expect(memFs.files.get(MARKER)).toBe(APP_VERSION);

      // A legitimate new snapshot gets written later in this same launch.
      await storage.appendMessage('conv-1', makeMsg({ id: 'live', content: '' }));
      await storage.flushWrites();
      await storage.snapshotMessageRevision('conv-1', makeMsg({ id: 'live', content: 'still streaming' }));
      expect(memFs.files.has(`${BASE}/conv-1/stream-snapshot.json`)).toBe(true);

      // "Restart" with no version change: module-level state resets, but the
      // on-disk marker still matches APP_VERSION.
      vi.resetModules();
      storage = await import('./conversationStorage');

      await storage.loadIndex();

      // The marker gates this launch's sweep — the still-fresh snapshot from
      // moments ago survives instead of being wiped as "stale".
      expect(memFs.files.has(`${BASE}/conv-1/stream-snapshot.json`)).toBe(true);
      expect(memFs.files.get(MARKER)).toBe(APP_VERSION);
    });

    it('a sweep failure (fs throw) does not break loadMessages or storage init', async () => {
      (readDir as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        throw new Error('boom: readDir unavailable');
      });

      // ensureBase's sweep must swallow this and still let normal storage
      // operations proceed — it must never block or throw out of the init path.
      await expect(
        storage.appendMessage('conv-1', makeMsg({ id: 'm1', content: 'hello' })),
      ).resolves.toBeUndefined();
      await storage.flushWrites();

      const loaded = await storage.loadMessages('conv-1');
      expect(loaded.map((m) => m.content)).toEqual(['hello']);
    });
  });
});
