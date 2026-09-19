// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { constants as fsConstants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConversationWriter,
  type ConversationWriterCapabilities,
  type ConversationWriterEnv,
} from '@/core/session/conversationWriter';
import type { Message } from '@/types';
import { createNodeConversationFs, TOLERATED_DIRECTORY_FSYNC_ERRNOS } from './conversationFsNode';

const posixOnly = it.skipIf(process.platform === 'win32');

const NOW = 1_700_000_000_000;
const NO_CAPABILITIES: ConversationWriterCapabilities = {
  versionSweep: false,
  dailyBackup: false,
  indexWriter: false,
};

function makeEnv(appDataDir: string): ConversationWriterEnv {
  return {
    appDataDir: async () => appDataDir,
    appVersion: '9.9.9',
    now: () => NOW,
    randomSuffix: () => 'i',
    trace: () => undefined,
    errorType: () => 'error',
    outputManifest: { refresh: async () => ({}), findToolResultImageSnapshot: () => null },
  };
}

const msg = (id: string, content: string): Message => ({
  id,
  role: 'assistant',
  content,
  timestamp: NOW,
});

describe('sidecar conversation fs primitives', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), 'abu-conv-fs-')));
  });
  afterEach(async () => {
    await nodeFs.rm(dir, { recursive: true, force: true });
  });

  describe('appendText', () => {
    it('creates the parent directory and the file, then only ever adds at the end', async () => {
      const fs = createNodeConversationFs();
      const path = join(dir, 'c1', 'messages.jsonl');
      await fs.appendText(path, '第一行\n');
      await fs.appendText(path, 'second\n');
      expect(await nodeFs.readFile(path, 'utf-8')).toBe('第一行\nsecond\n');
    });

    it('opens with O_APPEND, O_CREAT, O_WRONLY and no-follow', async () => {
      const seen: number[] = [];
      const fs = createNodeConversationFs({
        open: (async (path: never, flags: never, mode: never) => {
          if (typeof flags === 'number') seen.push(flags);
          return nodeFs.open(path, flags, mode);
        }) as typeof nodeFs.open,
      });
      await fs.appendText(join(dir, 'a.jsonl'), 'x\n');
      const flags = seen[0];
      expect(flags & fsConstants.O_APPEND).toBe(fsConstants.O_APPEND);
      expect(flags & fsConstants.O_CREAT).toBe(fsConstants.O_CREAT);
      expect(flags & fsConstants.O_WRONLY).toBe(fsConstants.O_WRONLY);
      if (typeof fsConstants.O_NOFOLLOW === 'number') {
        expect(flags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
      }
    });

    it('interleaved appends from two instances lose nothing', async () => {
      const a = createNodeConversationFs();
      const b = createNodeConversationFs();
      const path = join(dir, 'race.jsonl');
      await Promise.all(
        Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).appendText(path, `line-${i}\n`)),
      );
      const lines = (await nodeFs.readFile(path, 'utf-8')).trim().split('\n');
      expect(lines).toHaveLength(50);
      expect(new Set(lines).size).toBe(50);
    });

    posixOnly('refuses a ledger that is a symbolic link and leaves its target alone', async () => {
      const fs = createNodeConversationFs();
      const target = join(dir, 'victim.txt');
      await nodeFs.writeFile(target, 'untouched');
      await nodeFs.symlink(target, join(dir, 'messages.jsonl'));
      await expect(fs.appendText(join(dir, 'messages.jsonl'), 'x\n')).rejects.toMatchObject({ code: 'ELOOP' });
      expect(await nodeFs.readFile(target, 'utf-8')).toBe('untouched');
    });

    // A platform without `O_NOFOLLOW` (Windows) inspects the entry before the
    // open instead. Driving it here is what gives that branch a test at all:
    // the CI Windows job cannot create the symbolic link this needs.
    posixOnly('refuses a linked ledger on a platform without O_NOFOLLOW', async () => {
      const fs = createNodeConversationFs({ platform: 'win32' });
      const target = join(dir, 'victim.txt');
      await nodeFs.writeFile(target, 'untouched');
      await nodeFs.symlink(target, join(dir, 'messages.jsonl'));
      await expect(fs.appendText(join(dir, 'messages.jsonl'), 'x\n')).rejects.toMatchObject({ code: 'ELOOP' });
      expect(await nodeFs.readFile(target, 'utf-8')).toBe('untouched');
    });
  });

  describe('atomicWriteText', () => {
    it('creates parents, replaces the content, and leaves no temporary file', async () => {
      const fs = createNodeConversationFs();
      const path = join(dir, 'c1', 'stream-snapshot.json');
      await fs.atomicWriteText(path, '{"v":1}');
      await fs.atomicWriteText(path, '{"v":2,"text":"中文"}');
      expect(await nodeFs.readFile(path, 'utf-8')).toBe('{"v":2,"text":"中文"}');
      expect(await nodeFs.readdir(join(dir, 'c1'))).toEqual(['stream-snapshot.json']);
    });

    it('removes its temporary file and leaves the target as it was when the rename fails', async () => {
      const fs = createNodeConversationFs();
      const path = join(dir, 'index.json');
      await nodeFs.mkdir(path); // a directory in the target's place makes the rename fail
      await expect(fs.atomicWriteText(path, 'x')).rejects.toBeTruthy();
      expect(await nodeFs.readdir(dir)).toEqual(['index.json']);
    });

    posixOnly('replaces a symbolic link at the target instead of writing through it', async () => {
      const fs = createNodeConversationFs();
      const victim = join(dir, 'victim.txt');
      await nodeFs.writeFile(victim, 'untouched');
      await nodeFs.symlink(victim, join(dir, 'index.json'));
      await fs.atomicWriteText(join(dir, 'index.json'), 'new');
      expect(await nodeFs.readFile(victim, 'utf-8')).toBe('untouched');
      expect((await nodeFs.lstat(join(dir, 'index.json'))).isSymbolicLink()).toBe(false);
    });

    posixOnly('fsyncs the directory after the rename', async () => {
      const opened: string[] = [];
      const fs = createNodeConversationFs({
        open: (async (path: never, flags: never, mode: never) => {
          opened.push(String(path));
          return nodeFs.open(path, flags, mode);
        }) as typeof nodeFs.open,
      });
      await fs.atomicWriteText(join(dir, 'index.json'), 'x');
      expect(opened.at(-1)).toBe(dir);
    });

    it.each(TOLERATED_DIRECTORY_FSYNC_ERRNOS)('tolerates %s from the directory fsync', async (code) => {
      const fs = createNodeConversationFs({
        platform: 'linux',
        open: (async (path: never, flags: never, mode: never) => {
          if (String(path) === dir) throw Object.assign(new Error(code), { code });
          return nodeFs.open(path, flags, mode);
        }) as typeof nodeFs.open,
      });
      await fs.atomicWriteText(join(dir, 'index.json'), 'x');
      expect(await nodeFs.readFile(join(dir, 'index.json'), 'utf-8')).toBe('x');
    });

    it('any other directory fsync error is thrown', async () => {
      const fs = createNodeConversationFs({
        platform: 'linux',
        open: (async (path: never, flags: never, mode: never) => {
          if (String(path) === dir) throw Object.assign(new Error('EIO'), { code: 'EIO' });
          return nodeFs.open(path, flags, mode);
        }) as typeof nodeFs.open,
      });
      await expect(fs.atomicWriteText(join(dir, 'index.json'), 'x')).rejects.toMatchObject({ code: 'EIO' });
    });

    it('never opens the directory on win32', async () => {
      const opened: string[] = [];
      const fs = createNodeConversationFs({
        platform: 'win32',
        open: (async (path: never, flags: never, mode: never) => {
          opened.push(String(path));
          return nodeFs.open(path, flags, mode);
        }) as typeof nodeFs.open,
      });
      await fs.atomicWriteText(join(dir, 'index.json'), 'x');
      expect(opened).not.toContain(dir);
    });

    it('the tolerated list is the one electron/pluginLease.cjs uses', () => {
      expect([...TOLERATED_DIRECTORY_FSYNC_ERRNOS]).toEqual(['EINVAL', 'EPERM', 'EACCES', 'EBADF', 'EISDIR', 'ENOTSUP']);
    });
  });

  describe('readTextFile', () => {
    posixOnly('refuses a file that is a symbolic link', async () => {
      const fs = createNodeConversationFs();
      await nodeFs.writeFile(join(dir, 'secret.txt'), 'secret');
      await nodeFs.symlink(join(dir, 'secret.txt'), join(dir, 'messages.jsonl'));
      await expect(fs.readTextFile(join(dir, 'messages.jsonl'))).rejects.toMatchObject({ code: 'ELOOP' });
    });

    it('reads UTF-8 text', async () => {
      const fs = createNodeConversationFs();
      await nodeFs.writeFile(join(dir, 'a.txt'), '你好');
      expect(await fs.readTextFile(join(dir, 'a.txt'))).toBe('你好');
    });
  });

  describe('canonicalPath', () => {
    it('keeps a missing tail as written under the resolved ancestor', async () => {
      const fs = createNodeConversationFs();
      expect(await fs.canonicalPath(join(dir, 'conversations', 'c1'))).toBe(join(dir, 'conversations', 'c1'));
    });

    posixOnly('resolves a linked directory to where it points', async () => {
      const fs = createNodeConversationFs();
      await nodeFs.mkdir(join(dir, 'elsewhere'));
      await nodeFs.mkdir(join(dir, 'conversations'));
      await nodeFs.symlink(join(dir, 'elsewhere'), join(dir, 'conversations', 'c1'));
      expect(await fs.canonicalPath(join(dir, 'conversations', 'c1'))).toBe(join(dir, 'elsewhere'));
    });

    posixOnly('rejects a dangling link instead of treating it as a missing path', async () => {
      const fs = createNodeConversationFs();
      await nodeFs.symlink(join(dir, 'nowhere'), join(dir, 'c1'));
      await expect(fs.canonicalPath(join(dir, 'c1'))).rejects.toThrow(/cannot resolve path safely/);
    });
  });

  describe('remove', () => {
    posixOnly('a recursive remove of a linked directory removes the link and keeps the target', async () => {
      const fs = createNodeConversationFs();
      await nodeFs.mkdir(join(dir, 'victim'));
      await nodeFs.writeFile(join(dir, 'victim', 'keep.txt'), 'keep');
      await nodeFs.symlink(join(dir, 'victim'), join(dir, 'c1'));
      await fs.remove(join(dir, 'c1'), { recursive: true });
      expect(await nodeFs.readFile(join(dir, 'victim', 'keep.txt'), 'utf-8')).toBe('keep');
    });
  });

  // The writer's containment check (`assertDirectChild`) asks the adapter for a
  // canonical path BEFORE the conversation directory exists, and turns a null
  // answer into a refusal. These two cases hold both halves of that hand-off at
  // once: a conversation that is not on disk yet must write, and one whose
  // directory resolves outside the root must not.
  describe('the writer over these primitives', () => {
    it('writes the first line of a conversation whose directory does not exist yet', async () => {
      const writer = createConversationWriter({
        fs: createNodeConversationFs(),
        env: makeEnv(dir),
        capabilities: NO_CAPABILITIES,
      });
      await writer.appendMessage('c1', msg('m1', 'first'));
      await writer.flushWrites();
      expect(await nodeFs.readFile(join(dir, 'conversations', 'c1', 'messages.jsonl'), 'utf-8')).toBe(
        `{"id":"m1","role":"assistant","content":"first","timestamp":${NOW}}\n`,
      );
    });

    posixOnly('refuses a conversation directory that is a link out of the root, and writes nothing', async () => {
      await nodeFs.mkdir(join(dir, 'conversations'), { recursive: true });
      await nodeFs.mkdir(join(dir, 'elsewhere'));
      await nodeFs.symlink(join(dir, 'elsewhere'), join(dir, 'conversations', 'c2'));
      const writer = createConversationWriter({
        fs: createNodeConversationFs(),
        env: makeEnv(dir),
        capabilities: NO_CAPABILITIES,
      });
      await expect(writer.appendMessage('c2', msg('m1', 'first'))).rejects.toMatchObject({
        code: 'conversation_dir_outside_root',
      });
      expect(await nodeFs.readdir(join(dir, 'elsewhere'))).toEqual([]);
    });

    it('re-terminates a ledger a crash left mid-line instead of gluing the next line onto it', async () => {
      const torn = '{"id":"m0","role":"user","content":"半';
      await nodeFs.mkdir(join(dir, 'conversations', 'c1'), { recursive: true });
      await nodeFs.writeFile(join(dir, 'conversations', 'c1', 'messages.jsonl'), torn);
      const writer = createConversationWriter({
        fs: createNodeConversationFs(),
        env: makeEnv(dir),
        capabilities: NO_CAPABILITIES,
      });
      await writer.appendMessage('c1', msg('m1', 'after the crash'));
      await writer.flushWrites();
      expect(await nodeFs.readFile(join(dir, 'conversations', 'c1', 'messages.jsonl'), 'utf-8')).toBe(
        `${torn}\n{"id":"m1","role":"assistant","content":"after the crash","timestamp":${NOW}}\n`,
      );
    });
  });
});
