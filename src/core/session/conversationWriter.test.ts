import { describe, expect, it, vi } from 'vitest';
import { createMemoryConversationFs } from '@/test/conversationWriterMemoryFs';
import { loadConversationWriterFixtures, replayWriterFixture } from '@/test/conversationWriterFixtures';
import { STREAM_SNAPSHOT_FILENAME } from './ledgerReader';
import { createConversationPaths } from './conversationPaths';
import type { FindToolResultImageSnapshot, ToolResultImageSnapshotRef } from './ledgerLineSerializer';
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

/**
 * This tier has no `outputSnapshots.ts`: its env answers the manifest lookup
 * from the `outputs/manifest.json` a fixture case seeded into the memory fs,
 * by the same key the real module uses. A tier that reads the real module
 * instead must agree byte for byte, which is what the shared fixtures hold.
 */
function seededSnapshotLookup(files: Map<string, string>): FindToolResultImageSnapshot {
  return (convId, toolCallId) => {
    const raw = convId ? files.get(`${ROOT}/${convId}/outputs/manifest.json`) : undefined;
    if (!raw) return null;
    const manifest = JSON.parse(raw) as { entries: Record<string, ToolResultImageSnapshotRef> };
    return manifest.entries[`tool-result://${toolCallId}`] ?? null;
  };
}

describe('createConversationWriter', () => {
  for (const testCase of loadConversationWriterFixtures()) {
    it(`shared fixture: ${testCase.name}`, async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({
        fs,
        env: makeEnv({
          now: () => testCase.now,
          randomSuffix: () => testCase.randomSuffix,
          outputManifest: { refresh: async () => ({}), findToolResultImageSnapshot: seededSnapshotLookup(fs.files) },
        }),
        capabilities: ALL,
      });
      const mismatches = await replayWriterFixture(
        testCase,
        writer,
        async (p) => fs.files.get(`${ROOT}/${p}`) ?? null,
        async (p, content) => { fs.files.set(`${ROOT}/${p}`, content); },
      );
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

  describe('forgetConversation', () => {
    const LEDGER = `${ROOT}/c1/messages.jsonl`;
    const SNAPSHOT = `${ROOT}/c1/stream-snapshot.json`;
    const line = (m: Record<string, unknown>): string => `${JSON.stringify(m)}\n`;

    async function setup() {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.appendMessage('c1', msg('m1', 'first'));
      await writer.flushWrites();
      const otherWriterAppends = (text: string): void => { fs.files.set(LEDGER, fs.files.get(LEDGER)! + text); };
      return { fs, writer, otherWriterAppends };
    }

    it('control: without forget, a stump another writer left is glued to the next line', async () => {
      const { fs, writer, otherWriterAppends } = await setup();
      otherWriterAppends('{"id":"torn","role":"assis');
      await writer.appendMessage('c1', msg('m2', 'second'));
      await writer.flushWrites();
      expect(fs.files.get(LEDGER)).toContain('"assis{"id":"m2"');
    });

    it('after forget, the stump is terminated before the next line', async () => {
      const { fs, writer, otherWriterAppends } = await setup();
      otherWriterAppends('{"id":"torn","role":"assis');
      await writer.forgetConversation('c1');
      await writer.appendMessage('c1', msg('m2', 'second'));
      await writer.flushWrites();
      expect(fs.files.get(LEDGER)).toContain('"assis\n{"id":"m2"');
      expect((await writer.loadMessages('c1')).map((m) => m.id)).toEqual(['m1', 'm2']);
    });

    it('after forget, a snapshot is stamped with the length of the ledger on disk', async () => {
      const { fs, writer, otherWriterAppends } = await setup();
      otherWriterAppends(line({ id: 'x1', role: 'assistant', content: '另一个写入者写的一行', timestamp: 1, pid: 'm1' }));
      await writer.forgetConversation('c1');
      await writer.snapshotMessageRevision('c1', msg('x1', 'newer', { isStreaming: true }));
      const snapshot = JSON.parse(fs.files.get(SNAPSHOT)!) as { ledgerBytes: number; entries: { stamp: number }[] };
      expect(snapshot.ledgerBytes).toBe(fs.files.get(LEDGER)!.length);
      expect(snapshot.entries[0].stamp).toBe(fs.files.get(LEDGER)!.length);
    });

    it('control: without forget, the stamp is the stale shorter length', async () => {
      const { fs, writer, otherWriterAppends } = await setup();
      const before = fs.files.get(LEDGER)!.length;
      otherWriterAppends(line({ id: 'x1', role: 'assistant', content: 'y', timestamp: 1 }));
      await writer.snapshotMessageRevision('c1', msg('x1', 'newer'));
      expect((JSON.parse(fs.files.get(SNAPSHOT)!) as { ledgerBytes: number }).ledgerBytes).toBe(before);
    });

    it('after forget, an id the other writer wrote is known: no duplicate append, and a strict replace succeeds', async () => {
      const { fs, writer, otherWriterAppends } = await setup();
      otherWriterAppends(line({ id: 'x1', role: 'assistant', content: 'y', timestamp: 1, pid: 'm1' }));
      await writer.forgetConversation('c1');
      await writer.appendMessage('c1', msg('x1', 'y'));
      await writer.flushWrites();
      expect(fs.files.get(LEDGER)!.split('\n').filter((l) => l.includes('"x1"'))).toHaveLength(1);
      await expect(writer.replaceMessageByIdStrict('c1', msg('x1', 'revised'))).resolves.toBeUndefined();
    });

    it('after forget, the next message is parented to the tail the other writer left, and a revision keeps the parent on disk', async () => {
      const { fs, writer, otherWriterAppends } = await setup();
      otherWriterAppends(line({ id: 'x1', role: 'assistant', content: 'y', timestamp: 1, pid: 'm1' }));
      await writer.forgetConversation('c1');
      await writer.appendMessage('c1', msg('m3', 'third'));
      await writer.replaceMessageById('c1', msg('x1', 'revised'));
      await writer.flushWrites();
      const lines = fs.files.get(LEDGER)!.trim().split('\n').map((l) => JSON.parse(l) as { id: string; pid?: string });
      expect(lines.find((l) => l.id === 'm3')!.pid).toBe('x1');
      expect(lines.filter((l) => l.id === 'x1').at(-1)!.pid).toBe('m1');
    });

    it('after forget, a settled sandbox action the other writer recorded is not regressed', async () => {
      const { fs, writer, otherWriterAppends } = await setup();
      const toolCall = { id: 't1', name: 'run_command', input: {}, sandboxRecoveryAction: 'completed' };
      otherWriterAppends(line({ id: 'x1', role: 'assistant', content: '', timestamp: 1, toolCalls: [toolCall] }));
      await writer.forgetConversation('c1');
      await writer.replaceMessageById('c1', {
        ...msg('x1', ''),
        toolCalls: [{ ...toolCall, sandboxRecoveryAction: 'pending' }],
      } as Message);
      await writer.flushWrites();
      const last = JSON.parse(fs.files.get(LEDGER)!.trim().split('\n').at(-1)!) as { toolCalls: { sandboxRecoveryAction: string }[] };
      expect(last.toolCalls[0].sandboxRecoveryAction).toBe('completed');
    });

    it('after forget, a snapshot the other writer armed is promoted by the next promotion', async () => {
      const { fs, writer } = await setup();
      const ledgerLength = fs.files.get(LEDGER)!.length;
      fs.files.set(SNAPSHOT, JSON.stringify({
        version: 2,
        entries: [{ message: { id: 'x9', role: 'assistant', content: '半句', timestamp: 1 }, stamp: ledgerLength }],
        ledgerBytes: ledgerLength,
      }));
      await writer.forgetConversation('c1');
      expect(writer.hasArmedStreamSnapshot('c1')).toBe(false);
      expect(await writer.promoteStreamSnapshots('c1')).toBe(1);
      expect(fs.files.get(LEDGER)).toContain('"x9"');
      expect(fs.files.has(SNAPSHOT)).toBe(false);
    });

    it('drops an armed snapshot from memory without touching its file', async () => {
      const { fs, writer } = await setup();
      await writer.snapshotMessageRevision('c1', msg('m1', 'partial'));
      const before = fs.files.get(SNAPSHOT);
      await writer.forgetConversation('c1');
      expect(writer.hasArmedStreamSnapshot('c1')).toBe(false);
      expect(fs.files.get(SNAPSHOT)).toBe(before);
    });

    it('flushes queued writes before it forgets', async () => {
      const { fs, writer } = await setup();
      const pending = writer.appendMessage('c1', msg('m2', 'queued'));
      await writer.forgetConversation('c1');
      await pending;
      expect(fs.files.get(LEDGER)).toContain('"m2"');
      expect(writer.isMessageWrittenToDisk('m2')).toBe(false);
      await writer.appendMessage('c1', msg('m2', 'queued'));
      await writer.flushWrites();
      expect(fs.files.get(LEDGER)!.split('\n').filter((l) => l.includes('"m2"'))).toHaveLength(1);
    });

    it('leaves every other conversation alone and adds no read to a conversation that was never forgotten', async () => {
      const { fs, writer } = await setup();
      await writer.appendMessage('c2', msg('n1', 'other'));
      await writer.flushWrites();
      await writer.forgetConversation('c1');
      expect(writer.isMessageWrittenToDisk('n1')).toBe(true);
      const readsBefore = fs.calls.filter((c) => c.startsWith('readTextFile')).length;
      await writer.appendMessage('c2', msg('n2', 'other 2'));
      await writer.flushWrites();
      expect(fs.calls.filter((c) => c.startsWith('readTextFile')).length).toBe(readsBefore);
    });

    it('a write after forget rejects when the ledger cannot be read, and writes nothing', async () => {
      const { fs, writer } = await setup();
      await writer.forgetConversation('c1');
      const size = fs.files.get(LEDGER)!.length;
      const read = fs.readTextFile.bind(fs);
      fs.readTextFile = async (path) => { if (path === LEDGER) throw new Error('EIO'); return read(path); };
      await expect(writer.appendMessage('c1', msg('m2', 'x'))).rejects.toThrow('EIO');
      expect(fs.files.get(LEDGER)!.length).toBe(size);
    });

    it('refuses an invalid id', async () => {
      const { writer } = await setup();
      await expect(writer.forgetConversation('../c1')).rejects.toMatchObject({ code: 'conversation_id_invalid' });
    });

    it('a load that straddles a forget leaves the conversation forgotten, and the next write re-derives', async () => {
      const { fs, writer, otherWriterAppends } = await setup();
      const read = fs.readTextFile.bind(fs);
      let reachedRead = (): void => {};
      let releaseRead = (): void => {};
      const atRead = new Promise<void>((resolve) => { reachedRead = resolve; });
      const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
      let gated = false;
      fs.readTextFile = async (path) => {
        const content = await read(path);
        if (path === LEDGER && !gated) {
          gated = true;
          reachedRead();
          await readGate;
        }
        return content;
      };

      const loading = writer.loadMessages('c1');
      await atRead;
      // The hand-over happens between the load's read of the ledger and the
      // state it would derive from it.
      otherWriterAppends(line({ id: 'x1', role: 'assistant', content: 'y', timestamp: 1, pid: 'm1' }));
      await writer.forgetConversation('c1');
      releaseRead();
      expect((await loading).map((m) => m.id)).toEqual(['m1']);

      await writer.appendMessage('c1', msg('m3', 'third'));
      await writer.flushWrites();
      const lines = fs.files.get(LEDGER)!.trim().split('\n').map((l) => JSON.parse(l) as { id: string; pid?: string });
      expect(lines.find((l) => l.id === 'm3')!.pid).toBe('x1');
    });

    it('two writes dispatched together after a forget share one re-derivation and one chain', async () => {
      const { fs, writer, otherWriterAppends } = await setup();
      otherWriterAppends(line({ id: 'x1', role: 'assistant', content: 'y', timestamp: 1, pid: 'm1' }));
      await writer.forgetConversation('c1');
      const read = fs.readTextFile.bind(fs);
      let ledgerReads = 0;
      fs.readTextFile = async (path) => {
        const content = await read(path);
        // A second read of the same ledger comes back later than the first, the
        // way two IPC round trips do.
        if (path === LEDGER && ++ledgerReads === 2) {
          for (let turn = 0; turn < 8; turn++) await Promise.resolve();
        }
        return content;
      };
      const readsBefore = fs.calls.filter((c) => c === `readTextFile ${LEDGER}`).length;
      await Promise.all([
        writer.appendMessage('c1', msg('m2', 'second')),
        writer.appendMessage('c1', msg('m3', 'third')),
      ]);
      await writer.flushWrites();
      const lines = fs.files.get(LEDGER)!.trim().split('\n').map((l) => JSON.parse(l) as { id: string; pid?: string });
      expect(lines.find((l) => l.id === 'm2')!.pid).toBe('x1');
      expect(lines.find((l) => l.id === 'm3')!.pid).toBe('m2');
      expect(fs.calls.filter((c) => c === `readTextFile ${LEDGER}`).length).toBe(readsBefore + 1);
    });

    it('a snapshot armed before the first ledger line survives the re-derivation of a conversation with no ledger', async () => {
      const { fs, writer } = await setup();
      const snapshotPath = `${ROOT}/c3/stream-snapshot.json`;
      fs.files.set(snapshotPath, JSON.stringify({
        version: 2,
        entries: [{ message: { id: 'x9', role: 'assistant', content: '半句', timestamp: 1 }, stamp: 0 }],
        ledgerBytes: 0,
      }));
      await writer.forgetConversation('c3');
      await writer.snapshotMessageRevision('c3', msg('m9', 'partial'));
      const entries = (JSON.parse(fs.files.get(snapshotPath)!) as { entries: { message: { id: string } }[] }).entries;
      expect(entries.map((e) => e.message.id)).toEqual(['x9', 'm9']);
    });
  });

  describe('containment', () => {
    const resolveWith = (links: Record<string, string>) => (path: string): string => {
      for (const [from, to] of Object.entries(links)) {
        if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
      }
      return path;
    };

    it('an invalid id rejects every conversation-scoped method before any fs call', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.ensureReady();
      const callsBefore = fs.calls.length;
      const bad = '../escape';
      const m = msg('m1', 'x');
      for (const attempt of [
        () => writer.appendMessage(bad, m),
        () => writer.replaceMessageById(bad, m),
        () => writer.replaceMessageByIdStrict(bad, m),
        () => writer.updateLastMessage(bad, m),
        () => writer.snapshotMessageRevision(bad, m),
        () => writer.appendTruncateEvent(bad, 'm1', { removedIds: ['m1'] }),
        () => writer.promoteStreamSnapshots(bad),
        () => writer.loadMessages(bad),
        () => writer.flushAndGetLedgerWatermark(bad),
        () => writer.deleteConversationFiles(bad),
        () => writer.forgetConversation(bad),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ code: 'conversation_id_invalid' });
      }
      expect(fs.calls.length).toBe(callsBefore);
    });

    it('a conversation directory that resolves outside the root is refused, and nothing is written', async () => {
      const fs = createMemoryConversationFs();
      // The marker already names this version, so the version sweep — the one
      // root-level write `ensureBase` makes — returns before it rewrites it.
      fs.files.set(`${ROOT}/.snapshot-sweep-version`, '9.9.9');
      fs.setCanonical(resolveWith({ [`${ROOT}/c1`]: '/etc/abu-escape' }));
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await expect(writer.appendMessage('c1', msg('m1', 'x'))).rejects.toMatchObject({ code: 'conversation_dir_outside_root' });
      await expect(writer.snapshotMessageRevision('c1', msg('m1', 'x'))).rejects.toMatchObject({ code: 'conversation_dir_outside_root' });
      await expect(writer.loadMessages('c1')).rejects.toMatchObject({ code: 'conversation_dir_outside_root' });
      expect(fs.calls.some((c) => c.startsWith('appendText') || c.startsWith('atomicWriteText'))).toBe(false);
    });

    it('a root that is itself behind a link is fine: both sides are canonical', async () => {
      const fs = createMemoryConversationFs();
      fs.setCanonical(resolveWith({ [APP_DATA]: '/Volumes/real/abu' }));
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.appendMessage('c1', msg('m1', 'x'));
      await writer.flushWrites();
      expect(fs.files.get(`${ROOT}/c1/messages.jsonl`)).toContain('"m1"');
    });

    it('checks a conversation once per process, and again after forget', async () => {
      const fs = createMemoryConversationFs();
      fs.setCanonical((path) => path);
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.appendMessage('c1', msg('m1', 'x'));
      await writer.appendMessage('c1', msg('m2', 'y'));
      await writer.flushWrites();
      const count = (): number => fs.calls.filter((c) => c === `canonicalPath ${ROOT}/c1`).length;
      expect(count()).toBe(1);
      await writer.forgetConversation('c1');
      await writer.appendMessage('c1', msg('m3', 'z'));
      expect(count()).toBe(2);
    });

    it('a tier without a canonical primitive makes no canonical call after the root probe', async () => {
      const fs = createMemoryConversationFs();
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await writer.appendMessage('c1', msg('m1', 'x'));
      await writer.appendMessage('c2', msg('n1', 'x'));
      expect(fs.calls.filter((c) => c.startsWith('canonicalPath'))).toEqual([`canonicalPath ${ROOT}`]);
    });

    it('a root that answers null only transiently records nothing, so the next write resolves the conversation', async () => {
      const fs = createMemoryConversationFs();
      fs.setCanonical((path) => path);
      const canonicalPath = fs.canonicalPath;
      let rootAsks = 0;
      // A `canonicalPath` built on `realpath` answers null for a directory that
      // does not exist yet, and `ensureBase` publishes `paths` before it creates
      // the root and before it resolves it.
      fs.canonicalPath = async (path) => {
        const resolved = await canonicalPath(path);
        return path === ROOT && rootAsks++ === 0 ? null : resolved;
      };
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      const exists = fs.exists;
      let second: Promise<void> | undefined;
      // The root probe of `ensureBase`, the first call it makes after it has
      // published `paths`: a second conversation entering here resolves the root
      // itself, ahead of the probe.
      fs.exists = async (path) => {
        if (path === ROOT && !second) second = writer.appendMessage('c2', msg('n1', 'y'));
        return exists(path);
      };
      await writer.appendMessage('c1', msg('m1', 'x'));
      await second;
      // c2 passed through the window: nothing resolved it, while c1 was compared
      // against the root the probe went on to resolve.
      expect(fs.calls.filter((c) => c === `canonicalPath ${ROOT}/c2`)).toEqual([]);
      expect(fs.calls).toContain(`canonicalPath ${ROOT}/c1`);
      fs.setCanonical(resolveWith({ [`${ROOT}/c2`]: '/etc/abu-escape' }));
      await expect(writer.appendMessage('c2', msg('n2', 'z'))).rejects.toMatchObject({ code: 'conversation_dir_outside_root' });
    });

    it('a primitive that resolves the root and then answers null is an error', async () => {
      const fs = createMemoryConversationFs();
      let asked = 0;
      fs.canonicalPath = async (path) => (asked++ === 0 ? path : null);
      const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
      await expect(writer.appendMessage('c1', msg('m1', 'x'))).rejects.toMatchObject({ code: 'canonical_path_unavailable' });
    });

    describe('deleteConversationFiles', () => {
      it('removes the conversation directory and the legacy session directory of a contained conversation', async () => {
        const fs = createMemoryConversationFs();
        fs.setCanonical((path) => path);
        const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
        await writer.appendMessage('c1', msg('m1', 'x'));
        await writer.flushWrites();
        await fs.mkdir(`${APP_DATA}/sessions/c1`, { recursive: true });
        fs.files.set(`${APP_DATA}/sessions/c1/old.json`, '{}');
        await writer.deleteConversationFiles('c1');
        expect([...fs.files.keys()].filter((p) => p.includes('/c1/'))).toEqual([]);
        expect(fs.calls).toContain(`remove ${ROOT}/c1 recursive`);
      });

      it('re-checks at delete time and refuses a directory that now resolves elsewhere, loudly', async () => {
        const fs = createMemoryConversationFs();
        fs.setCanonical((path) => path);
        const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
        await writer.appendMessage('c1', msg('m1', 'x'));
        await writer.flushWrites();
        fs.setCanonical(resolveWith({ [`${ROOT}/c1`]: '/Users/victim/Documents' }));
        await expect(writer.deleteConversationFiles('c1')).rejects.toMatchObject({ code: 'conversation_dir_outside_root' });
        expect(fs.calls.some((c) => c.startsWith('remove'))).toBe(false);
      });

      it('refuses a legacy session directory that resolves elsewhere and removes nothing under sessions', async () => {
        const fs = createMemoryConversationFs();
        await fs.mkdir(`${APP_DATA}/sessions/c1`, { recursive: true });
        fs.files.set(`${APP_DATA}/sessions/c1/old.json`, '{}');
        fs.setCanonical(resolveWith({ [`${APP_DATA}/sessions/c1`]: '/Users/victim' }));
        const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
        await expect(writer.deleteConversationFiles('c1')).rejects.toMatchObject({ code: 'conversation_dir_outside_root' });
        expect(fs.calls.some((c) => c.startsWith(`remove ${APP_DATA}/sessions`))).toBe(false);
      });

      it('a refused legacy leg leaves nothing recorded: the next write resolves the conversation again', async () => {
        const fs = createMemoryConversationFs();
        fs.setCanonical((path) => path);
        const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
        await writer.appendMessage('c1', msg('m1', 'x'));
        await writer.flushWrites();
        fs.setCanonical(resolveWith({ [`${APP_DATA}/sessions/c1`]: '/Users/victim' }));
        await expect(writer.deleteConversationFiles('c1')).rejects.toMatchObject({ code: 'conversation_dir_outside_root' });
        const checks = (): number => fs.calls.filter((c) => c === `canonicalPath ${ROOT}/c1`).length;
        const before = checks();
        await writer.appendMessage('c1', msg('m2', 'y'));
        expect(checks()).toBe(before + 1);
      });

      it('a remove that fails for an ordinary reason stays non-critical', async () => {
        const fs = createMemoryConversationFs();
        const writer = createConversationWriter({ fs, env: makeEnv(), capabilities: ALL });
        await writer.appendMessage('c1', msg('m1', 'x'));
        await writer.flushWrites();
        fs.remove = async () => { throw new Error('EBUSY'); };
        await expect(writer.deleteConversationFiles('c1')).resolves.toBeUndefined();
      });
    });
  });
});
