/**
 * The sidecar copy of `loadMessages` must keep the real module's contract,
 * including the `strictRead` option first-contact receipt recovery relies on:
 * a missing ledger is an empty ledger, but a read FAILURE has to be
 * distinguishable from one. `shimSurfaceTypes.ts` pins the signature; this
 * pins the behaviour. Real temp files, like the other sidecar shim tests.
 *
 * The unreadable case is a DIRECTORY sitting where the ledger file belongs:
 * reading it fails on every OS (EISDIR/EPERM — never ENOENT), unlike
 * `chmod 000`, which Windows ignores.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMessages } from './conversationStorageRun';

const root = { path: '' };
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => root.path }));

function ledgerPath(convId: string): string {
  return join(root.path, 'conversations', convId, 'messages.jsonl');
}

beforeAll(async () => {
  root.path = await mkdtemp(join(tmpdir(), 'abu-shim-ledger-'));
  await mkdir(join(root.path, 'conversations', 'readable'), { recursive: true });
  await writeFile(ledgerPath('readable'), [
    '{"id":"m1","role":"user","content":"a","timestamp":1}',
    '{"id":"m1","role":"user","content":"b","timestamp":1}',
    'not json',
  ].join('\n'), 'utf-8');
  await mkdir(ledgerPath('unreadable'), { recursive: true });
});
afterAll(async () => { await rm(root.path, { recursive: true, force: true }); });

describe('sidecar loadMessages', () => {
  it('reads a ledger, drops superseded rows and tolerates a corrupt line', async () => {
    expect(await loadMessages('readable')).toEqual([{ id: 'm1', role: 'user', content: 'b', timestamp: 1 }]);
  });

  it('treats a missing ledger as empty even under strictRead', async () => {
    expect(await loadMessages('absent')).toEqual([]);
    expect(await loadMessages('absent', { strictRead: true })).toEqual([]);
  });

  it('rethrows a real read failure only when the caller asked to tell them apart', async () => {
    expect(await loadMessages('unreadable')).toEqual([]);
    // Fails loudly if some OS ever reports an unreadable path as "missing":
    // that would make recovery drop a receipt it should have kept.
    await expect(loadMessages('unreadable', { strictRead: true })).rejects.toMatchObject({
      code: expect.not.stringMatching(/^ENOENT$/),
    });
  });
});
