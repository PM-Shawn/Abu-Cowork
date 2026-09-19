// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConversationWriterFixtures, replayWriterFixture } from '../../src/test/conversationWriterFixtures';

/**
 * The app data directory the shimmed `@tauri-apps/api/path` reports, so
 * `outputSnapshots.ts` — the module the sidecar writer's env reads its
 * manifest through — resolves the same conversations root the writer writes
 * to. In the real bundle that value comes from `bootstrap.ts`'s spawn-time
 * environment; here it is the test's temporary directory.
 */
const appDataState = vi.hoisted(() => ({ dir: '' }));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => appDataState.dir,
  homeDir: async () => appDataState.dir,
  tempDir: async () => appDataState.dir,
  resolve: async (...parts: string[]) => parts.join('/'),
  join: async (...parts: string[]) => parts.join('/'),
}));

// The mapping `scripts/build-sidecar.mjs` makes for the real bundle, so the
// manifest read runs against the same node:fs the writer's own adapter uses.
vi.mock('@tauri-apps/plugin-fs', async () => await import('./shims/pluginFsRun'));

type NodeWriterFactory = typeof import('./conversationWriterNode')['createNodeConversationWriter'];

describe('a sidecar-instantiated writer writes the bytes the renderer writes', () => {
  let appData: string;
  let createNodeConversationWriter: NodeWriterFactory;

  beforeEach(async () => {
    appData = await nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), 'abu-conv-writer-')));
    appDataState.dir = appData;
    // `outputSnapshots.ts` caches the conversations root it built from the
    // first `appDataDir()` it saw; a fresh module registry per case is what
    // lets every case have its own directory.
    vi.resetModules();
    ({ createNodeConversationWriter } = await import('./conversationWriterNode'));
  });
  afterEach(async () => { await nodeFs.rm(appData, { recursive: true, force: true }); });

  const readConversationFile = async (relativePath: string): Promise<string | null> => {
    try {
      return await nodeFs.readFile(join(appData, 'conversations', relativePath), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };

  const seedConversationFile = async (relativePath: string, content: string): Promise<void> => {
    const target = join(appData, 'conversations', relativePath);
    await nodeFs.mkdir(dirname(target), { recursive: true });
    await nodeFs.writeFile(target, content, 'utf-8');
  };

  // `concurrentRevisionBurst` cases are left out: their bytes depend on the
  // order two concurrent `exists` probes of the same ledger complete in, which
  // on real files is the kernel's order. See that field's doc comment.
  for (const testCase of loadConversationWriterFixtures().filter((c) => !c.concurrentRevisionBurst)) {
    it(`shared fixture: ${testCase.name}`, async () => {
      const writer = createNodeConversationWriter({
        appDataDir: appData,
        appVersion: '9.9.9',
        capabilities: { versionSweep: false, dailyBackup: false, indexWriter: true },
        trace: () => {},
        now: () => testCase.now,
        randomSuffix: () => testCase.randomSuffix,
      });
      const mismatches = await replayWriterFixture(testCase, writer, readConversationFile, seedConversationFile);
      expect(mismatches).toEqual([]);
    });
  }

  it('issues no catalog bump and refuses a conversation directory that is a link out of the root', async () => {
    const writer = createNodeConversationWriter({
      appDataDir: appData, appVersion: '9.9.9', trace: () => {},
      capabilities: { versionSweep: false, dailyBackup: false, indexWriter: false },
    });
    if (process.platform === 'win32') return;
    await nodeFs.mkdir(join(appData, 'conversations'), { recursive: true });
    await nodeFs.mkdir(join(appData, 'outside'));
    await nodeFs.symlink(join(appData, 'outside'), join(appData, 'conversations', 'c1'));
    await expect(writer.appendMessage('c1', { id: 'm1', role: 'user', content: 'x', timestamp: 1 }))
      .rejects.toMatchObject({ code: 'conversation_dir_outside_root' });
    expect(await nodeFs.readdir(join(appData, 'outside'))).toEqual([]);
  });

  it('terminates a torn tail a crash left behind instead of gluing the next line onto it', async () => {
    const options = {
      appDataDir: appData,
      appVersion: '9.9.9',
      capabilities: { versionSweep: false, dailyBackup: false, indexWriter: false },
      trace: () => {},
      now: () => 1_700_000_000_000,
      randomSuffix: () => 'i',
    };
    const first = createNodeConversationWriter(options);
    await first.appendMessage('c-torn', { id: 'm1', role: 'user', content: '问', timestamp: 1_700_000_000_000 });
    await first.flushWrites();

    // What a crash mid-append leaves: a line with no terminator.
    const ledger = join(appData, 'conversations', 'c-torn', 'messages.jsonl');
    await nodeFs.appendFile(ledger, '{"id":"m2","role":"assist', 'utf-8');

    // A second instance has checked no tail yet, so its first append re-reads it.
    const second = createNodeConversationWriter(options);
    await second.appendMessage('c-torn', { id: 'm3', role: 'assistant', content: '答', timestamp: 1_700_000_000_000 });
    await second.flushWrites();

    expect(await nodeFs.readFile(ledger, 'utf-8')).toBe(
      '{"id":"m1","role":"user","content":"问","timestamp":1700000000000}\n'
      + '{"id":"m2","role":"assist\n'
      + '{"id":"m3","role":"assistant","content":"答","timestamp":1700000000000}\n',
    );
  });
});
