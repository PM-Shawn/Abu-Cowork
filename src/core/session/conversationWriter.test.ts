import { describe, expect, it, vi } from 'vitest';
import { createMemoryConversationFs } from '@/test/conversationWriterMemoryFs';
import { loadConversationWriterFixtures, replayWriterFixture } from '@/test/conversationWriterFixtures';
import { STREAM_SNAPSHOT_FILENAME } from './ledgerReader';
import { createConversationPaths } from './conversationPaths';
import {
  ConversationWriterCapabilityError,
  createConversationWriter,
  type ConversationWriterCapabilities,
  type ConversationWriterEnv,
} from './conversationWriter';
import type { Message } from '@/types';

const APP_DATA = '/data/abu';
const ROOT = `${APP_DATA}/conversations`;
const ALL: ConversationWriterCapabilities = { versionSweep: true, dailyBackup: true, indexWriter: true };
const NONE: ConversationWriterCapabilities = { versionSweep: false, dailyBackup: false, indexWriter: false };

function makeEnv(overrides: Partial<ConversationWriterEnv> = {}): ConversationWriterEnv {
  return {
    appDataDir: async () => APP_DATA,
    appVersion: '9.9.9',
    now: () => 1_700_000_000_000,
    randomSuffix: () => 'i',
    trace: vi.fn(),
    errorType: () => 'error',
    outputManifest: { refresh: async () => ({}), findToolResultImageSnapshot: () => null },
    ...overrides,
  };
}

const msg = (id: string, content: string, extra: Partial<Message> = {}): Message =>
  ({ id, role: 'assistant', content, timestamp: 1_700_000_000_000, ...extra });

describe('createConversationWriter', () => {
  for (const testCase of loadConversationWriterFixtures()) {
    it(`shared fixture: ${testCase.name}`, async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({
        fs,
        env: makeEnv({ now: () => testCase.now, randomSuffix: () => testCase.randomSuffix }),
        capabilities: ALL,
      });
      const mismatches = await replayWriterFixture(testCase, writer, async (p) => fs.files.get(`${ROOT}/${p}`) ?? null);
      expect(mismatches).toEqual([]);
    });
  }

  it('names the snapshot file the way the reader does', () => {
    expect(createConversationPaths(APP_DATA).streamSnapshotPath('c1').endsWith(`/${STREAM_SNAPSHOT_FILENAME}`)).toBe(true);
  });

  it('two instances share nothing', async () => {
    const fsA = createMemoryConversationFs();
    const fsB = createMemoryConversationFs();
    const a = createConversationWriter({ fs: fsA, env: makeEnv(), capabilities: ALL });
    const b = createConversationWriter({ fs: fsB, env: makeEnv(), capabilities: NONE });
    await a.appendMessage('c1', msg('m1', 'x'));
    await a.flushWrites();
    expect(a.isMessageWrittenToDisk('m1')).toBe(true);
    expect(b.isMessageWrittenToDisk('m1')).toBe(false);
    expect(fsB.files.size).toBe(0);
  });

  it('calls the catalog bump once per first append, and tolerates an env without one', async () => {
    const bump = vi.fn(async () => {});
    const withBump = createConversationWriter({ fs: createMemoryConversationFs(), env: makeEnv({ catalogBumpCount: bump }), capabilities: ALL });
    await withBump.appendMessage('c1', msg('m1', 'x'));
    await withBump.appendMessage('c1', msg('m1', 'x'));
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith('c1', 1, 1_700_000_000_000, 'm1');
    const without = createConversationWriter({ fs: createMemoryConversationFs(), env: makeEnv(), capabilities: ALL });
    await expect(without.appendMessage('c1', msg('m1', 'x'))).resolves.toBeUndefined();
  });

  it('refuses a conversation id outside the grammar before any path is built', async () => {
    const fs = createMemoryConversationFs();
    const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
    await expect(writer.appendMessage('../escape', msg('m1', 'x'))).rejects.toMatchObject({
      code: 'conversation_id_invalid',
    });
    expect(fs.calls.some((call) => call.includes('escape'))).toBe(false);
  });

  describe('capabilities', () => {
    it('version sweep off: a snapshot of another version survives the first use', async () => {
      const fs = createMemoryConversationFs();
      fs.files.set(`${ROOT}/.snapshot-sweep-version`, '0.0.1');
      fs.files.set(`${ROOT}/c1/stream-snapshot.json`, '{"version":2,"entries":[],"ledgerBytes":0}');
      await fs.mkdir(`${ROOT}/c1`, { recursive: true });
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: NONE });
      await writer.loadMessages('c1');
      expect(fs.files.has(`${ROOT}/c1/stream-snapshot.json`)).toBe(true);
      expect(fs.files.get(`${ROOT}/.snapshot-sweep-version`)).toBe('0.0.1');
    });
    it('version sweep on: the same snapshot is removed and the marker rewritten', async () => {
      const fs = createMemoryConversationFs();
      fs.files.set(`${ROOT}/.snapshot-sweep-version`, '0.0.1');
      fs.files.set(`${ROOT}/c1/stream-snapshot.json`, '{"version":2,"entries":[],"ledgerBytes":0}');
      await fs.mkdir(`${ROOT}/c1`, { recursive: true });
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.loadMessages('c1');
      expect(fs.files.has(`${ROOT}/c1/stream-snapshot.json`)).toBe(false);
      expect(fs.files.get(`${ROOT}/.snapshot-sweep-version`)).toBe('9.9.9');
    });
    it('index writer off: every index method throws and shutdown writes no index', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: NONE });
      const meta = { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 };
      await expect(writer.loadIndex()).rejects.toBeInstanceOf(ConversationWriterCapabilityError);
      await expect(writer.updateIndexEntry(meta)).rejects.toMatchObject({ capability: 'indexWriter' });
      await expect(writer.removeIndexEntry('c1')).rejects.toBeInstanceOf(ConversationWriterCapabilityError);
      await expect(writer.flushIndex()).rejects.toBeInstanceOf(ConversationWriterCapabilityError);
      expect(() => writer.getIndexEntries()).toThrow(ConversationWriterCapabilityError);
      await writer.init();
      await writer.shutdown();
      expect(fs.files.has(`${ROOT}/index.json`)).toBe(false);
      expect(fs.calls.some((c) => c.startsWith('readTextFile') && c.endsWith('/index.json'))).toBe(false);
    });
    it('daily backup off: init starts none and a direct call throws', async () => {
      const fs = createMemoryConversationFs();
      fs.files.set(`${ROOT}/index.json`, '{"version":1,"entries":{}}');
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: { ...ALL, dailyBackup: false } });
      await writer.init();
      await writer.shutdown();
      expect([...fs.files.keys()].some((p) => p.startsWith(`${APP_DATA}/backups/`))).toBe(false);
      await expect(writer.dailyBackup()).rejects.toMatchObject({ capability: 'dailyBackup' });
    });
    it('daily backup on: init copies the index under the date the injected clock gives', async () => {
      const fs = createMemoryConversationFs();
      fs.files.set(`${ROOT}/index.json`, '{"version":1,"entries":{}}');
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.init();
      await writer.dailyBackup();
      expect(fs.files.get(`${APP_DATA}/backups/index.2023-11-14.json`)).toBe('{"version":1,"entries":{}}');
    });
  });

  it('a failed append rejects the write and leaves the id unclaimed', async () => {
    const fs = createMemoryConversationFs();
    const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
    fs.failNextAppend(`${ROOT}/c1/messages.jsonl`, new Error('disk full'));
    await expect(writer.appendMessage('c1', msg('m1', 'x'))).rejects.toThrow('disk full');
    expect(writer.isMessageWrittenToDisk('m1')).toBe(false);
    await writer.appendMessage('c1', msg('m1', 'x'));
    expect(fs.files.get(`${ROOT}/c1/messages.jsonl`)).toContain('"m1"');
  });

  it('traces a snapshot write failure without a tier prefix and without content', async () => {
    const trace = vi.fn();
    const fs = createMemoryConversationFs();
    const writer = createConversationWriter({ fs, env: makeEnv({ trace, errorType: () => 'boom' }), capabilities: ALL });
    fs.atomicWriteText = async () => { throw new Error('nope'); };
    await writer.snapshotMessageRevision('c1', msg('m1', 'secret text'));
    expect(trace).toHaveBeenCalledWith('stream_snapshot_write_failed', { conversationId: 'c1', outcome: 'error', errorType: 'boom' });
  });

  describe('operations the shared fixtures do not reach', () => {
    it('updateLastMessage writes nothing when the conversation has no file yet', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.updateLastMessage('c1', msg('m1', 'x'));
      await writer.flushWrites();
      expect(fs.files.has(`${ROOT}/c1/messages.jsonl`)).toBe(false);
    });

    it('updateLastMessage appends a revision of an existing message', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.appendMessage('c1', msg('m1', 'half'));
      await writer.flushWrites();
      await writer.updateLastMessage('c1', msg('m1', 'whole'));
      await writer.flushWrites();
      const lines = (fs.files.get(`${ROOT}/c1/messages.jsonl`) ?? '').trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1])).toMatchObject({ id: 'm1', content: 'whole' });
    });

    it('replaceMessageByIdStrict throws for a message the ledger never held', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await expect(writer.replaceMessageByIdStrict('c1', msg('ghost', 'x'))).rejects.toThrow(
        'Conversation messages file does not exist: c1',
      );
      await writer.appendMessage('c1', msg('m1', 'x'));
      await writer.flushWrites();
      await expect(writer.replaceMessageByIdStrict('c1', msg('ghost', 'x'))).rejects.toThrow(
        'Message "ghost" was not found in conversation "c1"',
      );
    });

    it('appendTruncateEvent skips a message no write ever claimed', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.appendMessage('c1', msg('m1', 'x'));
      await writer.flushWrites();
      const before = fs.files.get(`${ROOT}/c1/messages.jsonl`);
      expect(await writer.appendTruncateEvent('c1', 'never-written', { removedIds: ['never-written'] })).toBe(false);
      await writer.flushWrites();
      expect(fs.files.get(`${ROOT}/c1/messages.jsonl`)).toBe(before);
      expect(await writer.appendTruncateEvent('c1', 'm1', { removedIds: ['m1'] })).toBe(true);
      await writer.flushWrites();
      expect(fs.files.get(`${ROOT}/c1/messages.jsonl`)).toContain('"msg.truncate"');
    });

    it('removeIndexEntry drops the row the next flush writes', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.updateIndexEntry({ id: 'c1', title: 'one', createdAt: 1, updatedAt: 1, messageCount: 1 });
      await writer.updateIndexEntry({ id: 'c2', title: 'two', createdAt: 1, updatedAt: 1, messageCount: 1 });
      await writer.removeIndexEntry('c1');
      await writer.flushIndex();
      expect(Object.keys(writer.getIndexEntries())).toEqual(['c2']);
      expect(fs.files.get(`${ROOT}/index.json`)).toContain('"c2"');
      expect(fs.files.get(`${ROOT}/index.json`)).not.toContain('"c1"');
    });

    it('flushStreamSnapshots promotes every conversation and removes the files', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.appendMessage('c1', msg('m1', ''));
      await writer.appendMessage('c2', msg('m2', ''));
      await writer.flushWrites();
      await writer.snapshotMessageRevision('c1', msg('m1', 'partial one', { isStreaming: true }));
      await writer.snapshotMessageRevision('c2', msg('m2', 'partial two', { isStreaming: true }));
      expect(writer.hasArmedStreamSnapshot('c1')).toBe(true);
      await writer.flushStreamSnapshots();
      expect(writer.hasArmedStreamSnapshot('c1')).toBe(false);
      expect(fs.files.has(`${ROOT}/c1/stream-snapshot.json`)).toBe(false);
      expect(fs.files.has(`${ROOT}/c2/stream-snapshot.json`)).toBe(false);
      expect(fs.files.get(`${ROOT}/c1/messages.jsonl`)).toContain('partial one');
      expect(fs.files.get(`${ROOT}/c2/messages.jsonl`)).toContain('partial two');
    });

    it('flushAndGetLedgerWatermark reports the ledger size in bytes', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      expect(await writer.flushAndGetLedgerWatermark('c1')).toBe(0);
      await writer.appendMessage('c1', msg('m1', '你好'));
      const watermark = await writer.flushAndGetLedgerWatermark('c1');
      const ledger = fs.files.get(`${ROOT}/c1/messages.jsonl`) ?? '';
      expect(watermark).toBe(new TextEncoder().encode(ledger).byteLength);
      expect(watermark).toBeGreaterThan(ledger.length);
    });

    it('loadMessages folds the ledger the writer wrote', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.appendMessage('c1', msg('m1', 'one'));
      await writer.appendMessage('c1', msg('m2', 'two'));
      await writer.flushWrites();
      const loaded = await writer.loadMessages('c1');
      expect(loaded.map((m) => [m.id, m.content])).toEqual([['m1', 'one'], ['m2', 'two']]);
    });

    it('deleteConversationFiles removes the directory and disarms the buffer', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.appendMessage('c1', msg('m1', ''));
      await writer.flushWrites();
      await writer.snapshotMessageRevision('c1', msg('m1', 'partial', { isStreaming: true }));
      await writer.deleteConversationFiles('c1');
      expect(writer.hasArmedStreamSnapshot('c1')).toBe(false);
      expect([...fs.files.keys()].some((p) => p.startsWith(`${ROOT}/c1/`))).toBe(false);
      expect(fs.calls).toContain(`remove ${ROOT}/c1 recursive`);
    });
  });
});
