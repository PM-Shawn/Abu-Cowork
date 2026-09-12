/**
 * The sidecar copy of `loadMessages` must keep the real module's contract,
 * including the `strictRead` option first-contact receipt recovery relies on:
 * a missing ledger is an empty ledger, but a read FAILURE has to be
 * distinguishable from one. `shimSurfaceTypes.ts` pins the signature; this
 * pins the behaviour. Real temp files, like the other sidecar shim tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMessages } from './conversationStorageRun';

const root = { path: '' };
vi.mock('@tauri-apps/api/path', () => ({ appDataDir: async () => root.path }));

async function seed(convId: string, body: string, mode?: number): Promise<void> {
  const dir = join(root.path, 'conversations', convId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'messages.jsonl');
  await writeFile(file, body, 'utf-8');
  if (mode !== undefined) await chmod(file, mode);
}

beforeAll(async () => {
  root.path = await mkdtemp(join(tmpdir(), 'abu-shim-ledger-'));
  await seed('readable', [
    '{"id":"m1","role":"user","content":"a","timestamp":1}',
    '{"id":"m1","role":"user","content":"b","timestamp":1}',
    'not json',
  ].join('\n'));
  await seed('denied', '{"id":"m1","role":"user","content":"a","timestamp":1}', 0o000);
});
afterAll(async () => {
  await chmod(join(root.path, 'conversations', 'denied', 'messages.jsonl'), 0o600).catch(() => undefined);
  await rm(root.path, { recursive: true, force: true });
});

describe('sidecar loadMessages', () => {
  it('reads a ledger, drops superseded rows and tolerates a corrupt line', async () => {
    expect(await loadMessages('readable')).toEqual([{ id: 'm1', role: 'user', content: 'b', timestamp: 1 }]);
  });

  it('treats a missing ledger as empty even under strictRead', async () => {
    expect(await loadMessages('absent')).toEqual([]);
    expect(await loadMessages('absent', { strictRead: true })).toEqual([]);
  });

  it('rethrows a real read failure only when the caller asked to tell them apart', async () => {
    expect(await loadMessages('denied')).toEqual([]);
    await expect(loadMessages('denied', { strictRead: true })).rejects.toThrow();
  });
});
