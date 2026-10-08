import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConversationWriter, type ConversationWriterEnv } from './conversationWriter';
import { rendererConversationFs } from './conversationFsRenderer';
import type { Message } from '@/types';

// A record that is on disk and cannot be read, seen through the renderer's own file access:
// every host command that would write is recorded, the native append and the read both fail.
const host = vi.hoisted(() => ({
  commands: [] as Array<{ command: string; path: string; body: string }>,
  unreadable: true,
}));

vi.mock('@/core/ipc/rawBodyInvoke', () => ({
  invokeTextCommand: vi.fn(async (command: string, args: { path: string }, body: string) => {
    host.commands.push({ command, path: args.path, body });
    if (command === 'append_file_text') throw new Error('EACCES: permission denied');
  }),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => true),
  readTextFile: vi.fn(async (path: string) => {
    if (host.unreadable && path.endsWith('/messages.jsonl')) throw new Error(`EACCES: permission denied, open '${path}'`);
    return '';
  }),
  mkdir: vi.fn(async () => undefined),
  readDir: vi.fn(async () => []),
  remove: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 0 })),
}));

const APP_DATA = '/data/abu';
const LEDGER = `${APP_DATA}/conversations/c1/messages.jsonl`;

const env: ConversationWriterEnv = {
  appDataDir: async () => APP_DATA,
  appVersion: '9.9.9',
  now: () => 1_700_000_000_000,
  randomSuffix: () => 'i',
  trace: vi.fn(),
  errorType: () => 'error',
  outputManifest: { refresh: async () => ({}), findToolResultImageSnapshot: () => null },
};

const message = (id: string): Message => ({ id, role: 'user', content: 'arrives late', timestamp: 1 });
const writesToLedger = () => host.commands.filter((entry) => entry.path === LEDGER);

describe('renderer file access: a record that is on disk and cannot be read', () => {
  beforeEach(() => {
    host.commands.length = 0;
    host.unreadable = true;
  });

  // The guarantee of the conversation load (F13): once a strict read of the record has failed,
  // no write of the writer reaches the host for that record, so the append fallback below is
  // never entered for it.
  it('after a strict read failed, a write reaches no host command for that record', async () => {
    const writer = createConversationWriter({
      fs: rendererConversationFs,
      env,
      capabilities: { versionSweep: false, dailyBackup: false, indexWriter: false },
    });
    await expect(writer.loadMessages('c1', { strictRead: true })).rejects.toThrow('EACCES');
    await expect(writer.appendMessage('c1', message('late'))).rejects.toThrow('EACCES');
    await expect(writer.replaceMessageById('c1', message('late'))).rejects.toThrow('EACCES');
    await writer.flushWrites();
    expect(writesToLedger()).toEqual([]);
  });

  // NOT this task's code. This case states what `appendText` does today when it is called
  // directly for such a record: the native append rejects, the rewrite cannot read what is
  // there, and the retry writes the new line alone as the whole file. The task "Stop appendText
  // fallback overwriting an unreadable record" changes `appendText` so that it rejects and
  // writes nothing; that change turns this case around (expect a rejection and no
  // `atomic_write_text`). It stays here so the exposure is visible until then.
  it('exposure owned by the appendText-fallback task: a direct append replaces the record with the new line', async () => {
    await expect(rendererConversationFs.appendText(LEDGER, '{"id":"late"}\n')).resolves.toBeUndefined();
    expect(writesToLedger().filter((entry) => entry.command === 'atomic_write_text'))
      .toEqual([{ command: 'atomic_write_text', path: LEDGER, body: '{"id":"late"}\n' }]);
  });
});
