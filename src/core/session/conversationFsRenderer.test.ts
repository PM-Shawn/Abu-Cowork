import { afterEach, describe, expect, it, vi } from 'vitest';
import { exists, mkdir, readTextFile } from '@tauri-apps/plugin-fs';
import { rendererConversationFs } from './conversationFsRenderer';

const invokeTextCommand = vi.hoisted(() => vi.fn());
vi.mock('@/core/ipc/rawBodyInvoke', () => ({ invokeTextCommand }));

type Bridge = { canonicalizePathForPolicy?: (path: string, followFinalSymlink?: boolean) => Promise<string> };
const runtime = globalThis as typeof globalThis & { __ABU_SHELL__?: Bridge };

afterEach(() => {
  delete runtime.__ABU_SHELL__;
  invokeTextCommand.mockReset();
  vi.mocked(exists).mockReset().mockResolvedValue(false);
  vi.mocked(readTextFile).mockReset().mockResolvedValue('');
  vi.mocked(mkdir).mockReset().mockResolvedValue(undefined);
});

describe('rendererConversationFs.appendText', () => {
  const FILE = '/data/abu/conversations/c1/messages.jsonl';
  const LINE = '{"id":"m3"}\n';

  /** The native append always rejects; `atomicWrite` answers each atomic write in turn. */
  function hostWhereNativeAppendRejects(atomicWrite: () => Promise<void> = async () => undefined) {
    invokeTextCommand.mockImplementation(async (command: string) => {
      if (command === 'append_file_text') throw new Error('append_file_text: command unavailable');
      return atomicWrite();
    });
  }

  function atomicWrites() {
    return invokeTextCommand.mock.calls.filter(([command]) => command === 'atomic_write_text');
  }

  it('rejects and writes nothing when the file exists and cannot be read', async () => {
    hostWhereNativeAppendRejects();
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(rendererConversationFs.appendText(FILE, LINE)).rejects.toThrow('EACCES');
    expect(atomicWrites()).toEqual([]);
  });

  it('writes the data as the whole file when the file is missing', async () => {
    hostWhereNativeAppendRejects();
    vi.mocked(exists).mockResolvedValue(false);

    await expect(rendererConversationFs.appendText(FILE, LINE)).resolves.toBeUndefined();
    expect(atomicWrites()).toEqual([['atomic_write_text', { path: FILE }, LINE]]);
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it('writes the current content followed by the data when the file is readable', async () => {
    hostWhereNativeAppendRejects();
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockResolvedValue('{"id":"m1"}\n{"id":"m2"}\n');

    await expect(rendererConversationFs.appendText(FILE, LINE)).resolves.toBeUndefined();
    expect(atomicWrites()).toEqual([['atomic_write_text', { path: FILE }, `{"id":"m1"}\n{"id":"m2"}\n${LINE}`]]);
  });

  it('creates the directory and writes the data again when the first write of a missing file fails', async () => {
    const atomicWrite = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValue(undefined);
    hostWhereNativeAppendRejects(atomicWrite);
    vi.mocked(exists).mockResolvedValue(false);

    await expect(rendererConversationFs.appendText(FILE, LINE)).resolves.toBeUndefined();
    expect(mkdir).toHaveBeenCalledWith('/data/abu/conversations/c1', { recursive: true });
    expect(atomicWrites()).toEqual([
      ['atomic_write_text', { path: FILE }, LINE],
      ['atomic_write_text', { path: FILE }, LINE],
    ]);
  });

  it('keeps the existing content when the first read fails and the second read succeeds', async () => {
    hostWhereNativeAppendRejects();
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockRejectedValueOnce(new Error('EBUSY')).mockResolvedValue('{"id":"m1"}\n');

    await expect(rendererConversationFs.appendText(FILE, LINE)).resolves.toBeUndefined();
    expect(atomicWrites()).toEqual([['atomic_write_text', { path: FILE }, `{"id":"m1"}\n${LINE}`]]);
  });
});

describe('rendererConversationFs.canonicalPath', () => {
  it('answers null when the Electron bridge is absent, so the tier has no canonical primitive', async () => {
    expect(runtime.__ABU_SHELL__).toBeUndefined();
    await expect(rendererConversationFs.canonicalPath('/data/abu/conversations/c1')).resolves.toBeNull();
  });

  it('asks main to follow the final component, so a linked conversation directory answers where it points', async () => {
    const canonicalizePathForPolicy = vi.fn(async () => '/Volumes/elsewhere/c1');
    runtime.__ABU_SHELL__ = { canonicalizePathForPolicy };
    await expect(rendererConversationFs.canonicalPath('/data/abu/conversations/c1')).resolves.toBe('/Volumes/elsewhere/c1');
    expect(canonicalizePathForPolicy).toHaveBeenCalledWith('/data/abu/conversations/c1', true);
  });

  it('lets a bridge rejection through, because a path that cannot be resolved is not a path that is contained', async () => {
    runtime.__ABU_SHELL__ = {
      canonicalizePathForPolicy: async () => { throw new Error('ELOOP'); },
    };
    await expect(rendererConversationFs.canonicalPath('/data/abu/conversations/c1')).rejects.toThrow('ELOOP');
  });
});
