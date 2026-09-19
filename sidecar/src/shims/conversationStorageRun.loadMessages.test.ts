/**
 * The sidecar's reader of a conversation ledger, held to the same contract the
 * renderer's is: every case of the shared fixture file
 * (`src/core/session/__fixtures__/ledgerReader.fixtures.json`) is replayed
 * through real files on disk, so ledger events and a stream snapshot produce
 * the same message list on this side as they do on the shell side.
 *
 * On top of that it pins what belongs to this side alone: the snapshot file is
 * only ever read, a byte watermark cuts the ledger at the offset the shell
 * reported after a flush and returns that prefix alone, and the `strictRead`
 * option first-contact receipt recovery relies on still tells a missing ledger
 * from an unreadable one.
 * `shimSurfaceTypes.ts` pins the signature; this pins the behaviour.
 *
 * Real temp files, like the other sidecar shim tests. The unreadable case is a
 * DIRECTORY sitting where the ledger file belongs: reading it fails on every
 * OS (EISDIR/EPERM — never ENOENT), unlike `chmod 000`, which Windows ignores.
 *
 * Each test imports the module after `vi.resetModules()`: the shim resolves its
 * base path once and caches it, so a fresh module per test is what makes that
 * test's own temp directory take effect.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectFolded } from '@/test/foldFixtures';
import { loadLedgerReaderFixtures, snapshotTextOf } from '@/test/ledgerReaderFixtures';

const root = { path: '' };
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => root.path }));

async function seed(convId: string, ledgerText: string, snapshotText: string | null): Promise<string> {
  const dir = join(root.path, 'conversations', convId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'messages.jsonl'), ledgerText, 'utf-8');
  if (snapshotText !== null) await writeFile(join(dir, 'stream-snapshot.json'), snapshotText, 'utf-8');
  return dir;
}

const { cases } = loadLedgerReaderFixtures();

describe('sidecar loadMessages', () => {
  beforeEach(async () => {
    root.path = await mkdtemp(join(tmpdir(), 'abu-shim-ledger-'));
    vi.resetModules();
  });
  afterEach(async () => {
    await rm(root.path, { recursive: true, force: true });
  });

  for (const [i, testCase] of cases.entries()) {
    it(`shared fixture: ${testCase.name}`, async () => {
      const convId = `conv-${i}`;
      await seed(convId, testCase.ledgerText, snapshotTextOf(testCase.snapshot));
      const { loadMessages } = await import('./conversationStorageRun');
      expect(projectFolded(await loadMessages(convId))).toEqual(testCase.expected.messages);
    });
  }

  it('never writes or deletes the snapshot file', async () => {
    const stale = cases.find((c) => c.expected.droppedIds.length > 0)!;
    const dir = await seed('conv-ro', stale.ledgerText, snapshotTextOf(stale.snapshot));
    const before = await readFile(join(dir, 'stream-snapshot.json'), 'utf-8');
    const { loadMessages } = await import('./conversationStorageRun');
    await loadMessages('conv-ro');
    expect(await readFile(join(dir, 'stream-snapshot.json'), 'utf-8')).toBe(before);
  });

  it('reads only up to the byte watermark', async () => {
    const first = JSON.stringify({ id: 'u1', role: 'user', content: '第一条', timestamp: 1 }) + '\n';
    const second = JSON.stringify({ id: 'a1', role: 'assistant', content: '第二条', timestamp: 2 }) + '\n';
    await seed('conv-wm', first + second, null);
    const { loadMessages } = await import('./conversationStorageRun');
    const upto = Buffer.byteLength(first, 'utf8');
    // The cut is a BYTE offset: the first line is longer in bytes than in
    // characters, so a character count here would land inside it.
    expect(upto).toBeGreaterThan(first.length);
    expect((await loadMessages('conv-wm', { uptoBytes: upto })).map((m) => m.id)).toEqual(['u1']);
  });

  it('a watermarked read returns the ledger prefix alone, with no snapshot merged', async () => {
    const first = JSON.stringify({ id: 'u1', role: 'user', content: '第一条', timestamp: 1 }) + '\n';
    const second = JSON.stringify({ id: 'a1', role: 'assistant', content: '第二条', timestamp: 2 }) + '\n';
    const ledgerText = first + second;
    // Stamped at the full ledger length, so a read of the whole file without a
    // watermark merges it in place over the ledger's own `a1`.
    const snapshotText = JSON.stringify({
      version: 2,
      ledgerBytes: ledgerText.length,
      entries: [
        { message: { id: 'a1', role: 'assistant', content: '流式中的最新内容', timestamp: 2 }, stamp: ledgerText.length },
      ],
    });
    await seed('conv-wm-snap', ledgerText, snapshotText);
    const { loadMessages } = await import('./conversationStorageRun');

    const contentOf = (messages: { id?: string; content?: unknown }[]): unknown[] =>
      messages.map((m) => m.content);

    expect(contentOf(await loadMessages('conv-wm-snap'))).toEqual(['第一条', '流式中的最新内容']);
    expect(contentOf(await loadMessages('conv-wm-snap', { uptoBytes: Buffer.byteLength(ledgerText, 'utf8') })))
      .toEqual(['第一条', '第二条']);
    expect(contentOf(await loadMessages('conv-wm-snap', { uptoBytes: Buffer.byteLength(first, 'utf8') })))
      .toEqual(['第一条']);
  });

  it('refuses a watermark beyond the file or inside a line', async () => {
    const line = JSON.stringify({ id: 'u1', role: 'user', content: '内容', timestamp: 1 }) + '\n';
    await seed('conv-bad', line, null);
    const { loadMessages } = await import('./conversationStorageRun');
    await expect(loadMessages('conv-bad', { uptoBytes: Buffer.byteLength(line, 'utf8') + 1 }))
      .rejects.toMatchObject({ code: 'watermark_beyond_file' });
    await expect(loadMessages('conv-bad', { uptoBytes: 5 }))
      .rejects.toMatchObject({ code: 'watermark_not_at_line_end' });
  });

  it('refuses a watermark above zero on a conversation that has no ledger', async () => {
    const { loadMessages } = await import('./conversationStorageRun');
    // The watermark is a size the shell measured on this very file, so a file
    // that is not there contradicts it — the same disagreement a watermark past
    // the end of an existing file is refused for.
    await expect(loadMessages('conv-none-wm', { uptoBytes: 10 })).rejects.toMatchObject({
      code: 'watermark_beyond_file',
      uptoBytes: 10,
      fileBytes: 0,
    });
    // A zero watermark measured nothing, so it agrees with a missing file.
    expect(await loadMessages('conv-none-wm', { uptoBytes: 0 })).toEqual([]);
  });

  it('treats a missing ledger as empty even under strictRead', async () => {
    const { loadMessages } = await import('./conversationStorageRun');
    expect(await loadMessages('conv-none')).toEqual([]);
    expect(await loadMessages('conv-none', { strictRead: true })).toEqual([]);
  });

  it('rethrows a real read failure only when the caller asked to tell them apart', async () => {
    await mkdir(join(root.path, 'conversations', 'conv-dir', 'messages.jsonl'), { recursive: true });
    const { loadMessages } = await import('./conversationStorageRun');
    expect(await loadMessages('conv-dir')).toEqual([]);
    // Fails loudly if some OS ever reports an unreadable path as "missing":
    // that would make recovery drop a receipt it should have kept.
    await expect(loadMessages('conv-dir', { strictRead: true })).rejects.toMatchObject({
      code: expect.not.stringMatching(/^ENOENT$/),
    });
  });
});
