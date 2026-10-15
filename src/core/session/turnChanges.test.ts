import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHostFs, type MemoryHostFs } from './__fixtures__/memoryHostFs';
import { pathHashOf, sha256Hex } from './turnUndoRecord';
import type { ConversationWorkspaceFiles } from '@/core/files/workspaceFiles';

const host = vi.hoisted(() => ({
  fs: null as unknown as import('./__fixtures__/memoryHostFs').MemoryHostFs,
  listWorkspace: null as unknown as import('vitest').Mock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: (path: string) => host.fs.pluginFs.exists(path),
  mkdir: (path: string, options?: { recursive?: boolean }) => host.fs.pluginFs.mkdir(path, options),
  readFile: (path: string) => host.fs.pluginFs.readFile(path),
  readTextFile: (path: string) => host.fs.pluginFs.readTextFile(path),
  writeFile: (path: string, bytes: Uint8Array) => host.fs.pluginFs.writeFile(path, bytes),
  remove: (path: string, options?: { recursive?: boolean }) => host.fs.pluginFs.remove(path, options),
  readDir: (path: string) => host.fs.pluginFs.readDir(path),
  stat: (path: string) => host.fs.pluginFs.stat(path),
}));
vi.mock('@/core/tools/fsBridge', () => ({
  exists: (path: string) => host.fs.bridge.exists(path),
  stat: (path: string) => host.fs.bridge.stat(path),
  readFile: (path: string) => host.fs.bridge.readFile(path),
}));
vi.mock('@/utils/atomicFs', () => ({
  atomicWrite: (path: string, content: string) => host.fs.atomicWrite(path, content),
}));
vi.mock('@/core/files/workspaceFiles', () => ({
  listConversationWorkspaceFiles: (...args: unknown[]) => host.listWorkspace(...args),
}));

type TurnChangesModule = typeof import('./turnChanges');

const HOME = '/Users/testuser';
const WS = `${HOME}/project`;
const CHANGES = `${HOME}/.abu/conversations/conv-1/changes`;

let fs: MemoryHostFs;
let mod: TurnChangesModule;

/** A fresh module instance over the same disk: what an app restart leaves behind. */
async function restart(): Promise<TurnChangesModule> {
  vi.resetModules();
  mod = await import('./turnChanges');
  return mod;
}

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';
}

async function runTurn(loopId: string, edits: (capture: (path: string) => Promise<void>) => Promise<void> | void): Promise<void> {
  await mod.beginTurn('conv-1', loopId, WS);
  await edits((path) => mod.captureBefore(loopId, path));
  await mod.endTurn(loopId);
}

beforeAll(async () => {
  host.fs = createMemoryHostFs();
  await import('./turnChanges');
});

beforeEach(async () => {
  fs = createMemoryHostFs();
  host.fs = fs;
  host.listWorkspace = vi.fn(async (_conversationId: string, root: string): Promise<ConversationWorkspaceFiles> => fs.listWorkspace(root));
  await restart();
});

describe('turnChanges', () => {
  describe('captureBefore', () => {
    it('copies the bytes of an existing file once per turn and records it in the manifest', async () => {
      fs.write(`${WS}/plan.md`, 'first\n');
      await mod.beginTurn('conv-1', 'loop-1', WS);

      await mod.captureBefore('loop-1', `${WS}/plan.md`);
      fs.write(`${WS}/plan.md`, 'second\n');
      await mod.captureBefore('loop-1', `${WS}/plan.md`);

      const manifest = fs.readJson<{ loopId: string; workspaceRoots: string[]; entries: Array<{ path: string; hash: string; state: string }> }>(
        `${CHANGES}/loop-1/before/manifest.json`,
      );
      expect(manifest.loopId).toBe('loop-1');
      expect(manifest.workspaceRoots).toEqual([WS]);
      expect(manifest.entries).toEqual([{ path: `${WS}/plan.md`, hash: expect.stringMatching(/^[0-9a-f]{16}$/), state: 'file' }]);
      expect(fs.read(`${CHANGES}/loop-1/before/${manifest.entries[0].hash}`)).toBe('first\n');
    });

    it('records a path that does not exist as absent and stores no copy', async () => {
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/new.md`);

      const manifest = fs.readJson<{ entries: Array<{ path: string; state: string }> }>(`${CHANGES}/loop-1/before/manifest.json`);
      expect(manifest.entries).toMatchObject([{ path: `${WS}/new.md`, state: 'absent' }]);
      expect(fs.list(`${CHANGES}/loop-1/before/`)).toEqual([`${CHANGES}/loop-1/before/manifest.json`]);
    });

    it('records a file over 2 MB as oversized and stores no copy', async () => {
      fs.writeBytes(`${WS}/big.log`, new Uint8Array(2 * 1024 * 1024 + 1).fill(97));
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/big.log`);

      const manifest = fs.readJson<{ entries: Array<{ state: string }> }>(`${CHANGES}/loop-1/before/manifest.json`);
      expect(manifest.entries).toMatchObject([{ state: 'oversized' }]);
      expect(fs.list(`${CHANGES}/loop-1/before/`)).toHaveLength(1);
    });

    it('stores a file of exactly 2 MB', async () => {
      fs.writeBytes(`${WS}/edge.txt`, new Uint8Array(2 * 1024 * 1024).fill(97));
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/edge.txt`);

      const manifest = fs.readJson<{ entries: Array<{ state: string }> }>(`${CHANGES}/loop-1/before/manifest.json`);
      expect(manifest.entries).toMatchObject([{ state: 'file' }]);
    });

    it('records nothing for a directory', async () => {
      fs.makeDir(`${WS}/folder`);
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/folder`);
      expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
    });

    it('does nothing for a loop that has not begun, has ended, or for a relative path', async () => {
      fs.write(`${WS}/plan.md`, 'first\n');
      await mod.captureBefore('loop-9', `${WS}/plan.md`);
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', 'plan.md');
      await mod.endTurn('loop-1');
      await mod.captureBefore('loop-1', `${WS}/plan.md`);
      expect(fs.has(CHANGES)).toBe(false);
    });

    it('treats backslash and slash spellings of a path as one file', async () => {
      fs.write('C:/work/a.md', 'one\n');
      await mod.beginTurn('conv-1', 'loop-1', 'C:/work');
      await mod.captureBefore('loop-1', 'C:\\work\\a.md');
      await mod.captureBefore('loop-1', 'C:/work/a.md');
      const manifest = fs.readJson<{ entries: Array<{ path: string }> }>(`${CHANGES}/loop-1/before/manifest.json`);
      expect(manifest.entries.map((entry) => entry.path)).toEqual(['C:/work/a.md']);
    });

    it('rejects when the copy cannot be read and captures on the next call', async () => {
      fs.write(`${WS}/plan.md`, 'first\n');
      await mod.beginTurn('conv-1', 'loop-1', WS);
      fs.failNextRead(`${WS}/plan.md`);

      await expect(mod.captureBefore('loop-1', `${WS}/plan.md`)).rejects.toThrow('EIO');
      await mod.captureBefore('loop-1', `${WS}/plan.md`);

      const manifest = fs.readJson<{ entries: Array<{ state: string }> }>(`${CHANGES}/loop-1/before/manifest.json`);
      expect(manifest.entries).toMatchObject([{ state: 'file' }]);
    });

    it('keeps every entry when two files are captured at the same time', async () => {
      fs.write(`${WS}/a.md`, 'a\n');
      fs.write(`${WS}/b.md`, 'b\n');
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await Promise.all([mod.captureBefore('loop-1', `${WS}/a.md`), mod.captureBefore('loop-1', `${WS}/b.md`)]);
      const manifest = fs.readJson<{ entries: Array<{ path: string }> }>(`${CHANGES}/loop-1/before/manifest.json`);
      expect(manifest.entries.map((entry) => entry.path).sort()).toEqual([`${WS}/a.md`, `${WS}/b.md`]);
    });
  });

  describe('endTurn', () => {
    it('saves a modified file with its line counts and hunks against the start of the turn', async () => {
      fs.write(`${WS}/plan.md`, 'one\ntwo\nthree\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/plan.md`);
        fs.write(`${WS}/plan.md`, 'one\nTWO\nthree\n');
        await capture(`${WS}/plan.md`);
        fs.write(`${WS}/plan.md`, 'one\n2\nthree\nfour\n');
      });

      expect(fs.readJson(`${CHANGES}/loop-1.json`)).toEqual({
        loopId: 'loop-1',
        files: [{
          path: `${WS}/plan.md`,
          display: 'plan.md',
          status: 'modified',
          added: 2,
          deleted: 1,
          hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' one', '-two', '+2', ' three', '+four'] }],
        }],
        total: 1,
        added: 2,
        deleted: 1,
      });
    });

    it('saves a created file as additions only', async () => {
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/new.md`);
        fs.write(`${WS}/new.md`, 'a\nb\n');
      });

      const saved = fs.readJson<{ files: unknown[] }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toEqual([{
        path: `${WS}/new.md`,
        display: 'new.md',
        status: 'created',
        added: 2,
        deleted: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }],
      }]);
    });

    it('saves a deleted file as deletions only', async () => {
      fs.write(`${WS}/old.md`, 'a\nb\nc\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/old.md`);
        fs.delete(`${WS}/old.md`);
      });

      const saved = fs.readJson<{ files: Array<Record<string, unknown>>; added: number; deleted: number }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toMatchObject([{ display: 'old.md', status: 'deleted', added: 0, deleted: 3 }]);
      expect(saved).toMatchObject({ added: 0, deleted: 3 });
    });

    it('leaves out a file whose content ends as it began, and writes nothing when no file changed', async () => {
      fs.write(`${WS}/plan.md`, 'same\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/plan.md`);
        fs.write(`${WS}/plan.md`, 'other\n');
        fs.write(`${WS}/plan.md`, 'same\n');
        await capture(`${WS}/ghost.md`);
      });

      expect(fs.has(`${CHANGES}/loop-1.json`)).toBe(false);
      expect(fs.has(`${CHANGES}/index.json`)).toBe(false);
      expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
      await expect(mod.readTurnIndex('conv-1')).resolves.toEqual({});
      await expect(mod.readTurnChanges('conv-1', 'loop-1')).resolves.toBeNull();
    });

    it('lists a file with a NUL byte without line counts', async () => {
      fs.writeBytes(`${WS}/data.bin`, new Uint8Array([1, 0, 2]));
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/data.bin`);
        fs.writeBytes(`${WS}/data.bin`, new Uint8Array([1, 0, 3]));
      });

      const saved = fs.readJson<{ files: unknown[]; added: number; deleted: number }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toEqual([{ path: `${WS}/data.bin`, display: 'data.bin', status: 'modified' }]);
      expect(saved).toMatchObject({ total: 1, added: 0, deleted: 0 });
    });

    it('lists a file that is over 2 MB at either end without line counts', async () => {
      const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(97);
      fs.writeBytes(`${WS}/was-big.log`, big);
      fs.write(`${WS}/grew.log`, 'small\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/was-big.log`);
        await capture(`${WS}/grew.log`);
        fs.write(`${WS}/was-big.log`, 'now small\n');
        fs.writeBytes(`${WS}/grew.log`, big);
      });

      const saved = fs.readJson<{ files: unknown[] }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toEqual([
        { path: `${WS}/grew.log`, display: 'grew.log', status: 'modified' },
        { path: `${WS}/was-big.log`, display: 'was-big.log', status: 'modified' },
      ]);
    });

    it('lists a file whose texts differ only in line endings without line counts', async () => {
      fs.write(`${WS}/crlf.txt`, 'a\r\nb\r\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/crlf.txt`);
        fs.write(`${WS}/crlf.txt`, 'a\nb\n');
      });
      const saved = fs.readJson<{ files: unknown[] }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toEqual([{ path: `${WS}/crlf.txt`, display: 'crlf.txt', status: 'modified' }]);
    });

    it('removes the turn directory once the result is saved, when no file can be restored', async () => {
      fs.writeBytes(`${WS}/big.log`, new Uint8Array(2 * 1024 * 1024 + 1).fill(97));
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/big.log`);
        fs.write(`${WS}/big.log`, 'small\n');
      });
      expect(fs.has(`${CHANGES}/loop-1.json`)).toBe(true);
      expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
    });

    it('does nothing for a loop that never began', async () => {
      await mod.endTurn('loop-9');
      expect(fs.has(CHANGES)).toBe(false);
    });

    it('gives other tasks the thread between two files', async () => {
      fs.write(`${WS}/a.md`, 'a\n');
      fs.write(`${WS}/b.md`, 'b\n');
      const order: string[] = [];
      const read = fs.bridge.readFile;
      fs.bridge.readFile = async (path) => {
        if (path.startsWith(WS)) order.push(`read ${path.slice(WS.length + 1)}`);
        return read(path);
      };
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/a.md`);
      await mod.captureBefore('loop-1', `${WS}/b.md`);
      fs.write(`${WS}/a.md`, 'A\n');
      fs.write(`${WS}/b.md`, 'B\n');
      order.length = 0;

      const ending = mod.endTurn('loop-1');
      const between = new Promise<void>((resolve) => {
        const poll = (): void => {
          if (order.includes('read a.md')) {
            order.push('other task');
            resolve();
          } else setTimeout(poll, 0);
        };
        setTimeout(poll, 0);
      });
      await Promise.all([ending, between]);

      expect(order).toEqual(['read a.md', 'other task', 'read b.md']);
    });
  });

  describe('workspace list comparison', () => {
    it('lists files a command created, modified and deleted, without line counts', async () => {
      fs.write(`${WS}/合同.docx`, 'v1');
      fs.write(`${WS}/旧稿.md`, 'old\n');
      fs.write(`${WS}/untouched.md`, 'same\n');
      await runTurn('loop-1', () => {
        fs.write(`${WS}/报表.xlsx`, 'sheet');
        fs.write(`${WS}/合同.docx`, 'v2');
        fs.delete(`${WS}/旧稿.md`);
      });

      const saved = fs.readJson<{ files: unknown[]; total: number; added: number; deleted: number }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toEqual([
        { path: `${WS}/合同.docx`, display: '合同.docx', status: 'modified' },
        { path: `${WS}/报表.xlsx`, display: '报表.xlsx', status: 'created' },
        { path: `${WS}/旧稿.md`, display: '旧稿.md', status: 'deleted' },
      ]);
      expect(saved).toMatchObject({ total: 3, added: 0, deleted: 0 });
    });

    it('reports a file as modified when only its size or only its modification time changed', async () => {
      host.listWorkspace
        .mockResolvedValueOnce({ root: WS, exceeded: false, files: [
          { path: 'size.md', size: 1, mtimeMs: 10 },
          { path: 'time.md', size: 1, mtimeMs: 10 },
          { path: 'same.md', size: 1, mtimeMs: 10 },
        ] })
        .mockResolvedValueOnce({ root: WS, exceeded: false, files: [
          { path: 'size.md', size: 2, mtimeMs: 10 },
          { path: 'time.md', size: 1, mtimeMs: 11 },
          { path: 'same.md', size: 1, mtimeMs: 10 },
        ] });
      await runTurn('loop-1', () => {});

      const saved = fs.readJson<{ files: Array<{ display: string; status: string }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => [file.display, file.status])).toEqual([['size.md', 'modified'], ['time.md', 'modified']]);
    });

    it('keeps one entry, with line counts, for a file the file tools and the list both report', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      fs.write(`${WS}/back.md`, 'same\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/plan.md`);
        await capture(`${WS}/back.md`);
        fs.write(`${WS}/plan.md`, 'two\n');
        fs.write(`${WS}/back.md`, 'other\n');
        fs.write(`${WS}/back.md`, 'same\n');
      });

      const saved = fs.readJson<{ files: unknown[] }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toMatchObject([{ display: 'plan.md', status: 'modified', added: 1, deleted: 1 }]);
      expect(saved.files).toHaveLength(1);
    });

    it('asks for the list of the conversation workspace inside the given authorization scope', async () => {
      await mod.beginTurn('conv-1', 'loop-1', WS, { scopeId: 'scope-3' });
      await mod.endTurn('loop-1');
      expect(host.listWorkspace.mock.calls).toEqual([['conv-1', WS, 'scope-3'], ['conv-1', WS, 'scope-3']]);
    });

    it.each([
      ['at the start of the turn', 0],
      ['at the end of the turn', 1],
    ])('skips the comparison when the list is exceeded %s; captured files are still saved', async (_label, exceededCall) => {
      fs.write(`${WS}/plan.md`, 'one\n');
      let call = 0;
      host.listWorkspace.mockImplementation(async (_conversationId: string, root: string) => (
        call++ === exceededCall ? { root, exceeded: true } : fs.listWorkspace(root)
      ));
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/plan.md`);
        fs.write(`${WS}/plan.md`, 'two\n');
        fs.write(`${WS}/by-command.md`, 'x\n');
      });

      const saved = fs.readJson<{ files: Array<{ display: string }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => file.display)).toEqual(['plan.md']);
    });

    it('asks for no list when the conversation has no workspace', async () => {
      fs.write('/data/notes.md', 'one\n');
      await mod.beginTurn('conv-1', 'loop-1', null);
      await mod.captureBefore('loop-1', '/data/notes.md');
      fs.write('/data/notes.md', 'two\n');
      await mod.endTurn('loop-1');

      expect(host.listWorkspace).not.toHaveBeenCalled();
      const saved = fs.readJson<{ files: Array<{ display: string }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => file.display)).toEqual(['/data/notes.md']);
    });

    it('rejects beginTurn when the list fails, still captures, and compares no list at the end', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      host.listWorkspace.mockRejectedValueOnce(new Error('list failed'));

      await expect(mod.beginTurn('conv-1', 'loop-1', WS)).rejects.toThrow('list failed');
      await mod.captureBefore('loop-1', `${WS}/plan.md`);
      fs.write(`${WS}/plan.md`, 'two\n');
      fs.write(`${WS}/by-command.md`, 'x\n');
      await mod.endTurn('loop-1');

      expect(host.listWorkspace).toHaveBeenCalledTimes(1);
      const saved = fs.readJson<{ files: Array<{ display: string }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => file.display)).toEqual(['plan.md']);
    });

    it('keeps the changes the file tools made when the list request at the end fails', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/plan.md`);
      fs.write(`${WS}/plan.md`, 'two\n');
      fs.write(`${WS}/by-command.md`, 'x\n');
      const told: string[] = [];
      mod.onTurnChangesSaved((_conversationId, loopId) => told.push(loopId));
      host.listWorkspace.mockRejectedValueOnce(new Error('ENOENT: no such file or directory, lstat'));

      await expect(mod.endTurn('loop-1')).rejects.toThrow('ENOENT');

      const saved = fs.readJson<{ files: unknown[]; total: number }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toMatchObject([{ display: 'plan.md', status: 'modified', added: 1, deleted: 1 }]);
      expect(saved.total).toBe(1);
      expect(fs.readJson(`${CHANGES}/index.json`)).toEqual({
        version: 1,
        turns: { 'loop-1': { total: 1, added: 1, deleted: 1, firstFile: 'plan.md', restorable: 1, settledAt: 1, copyBytes: 4 } },
      });
      const undoRecord = fs.read(`${CHANGES}/loop-1/undo.json`);
      expect(JSON.parse(undoRecord)).toMatchObject({ state: 'applied', entries: [{ path: `${WS}/plan.md` }] });
      expect(fs.has(`${CHANGES}/loop-1/before/manifest.json`)).toBe(false);
      expect(told).toEqual(['loop-1']);

      const afterRestart = await restart();
      await expect(afterRestart.readTurnIndex('conv-1')).resolves.toEqual({
        'loop-1': { total: 1, added: 1, deleted: 1, firstFile: 'plan.md', restorable: 1, settledAt: 1, copyBytes: 4 },
      });
      expect(fs.readJson(`${CHANGES}/loop-1.json`)).toEqual(saved);
      expect(fs.read(`${CHANGES}/loop-1/undo.json`)).toBe(undoRecord);
    });

    it('saves the files the list adds together with the ones the file tools changed', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      const told: string[] = [];
      mod.onTurnChangesSaved((_conversationId, loopId) => told.push(loopId));
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/plan.md`);
        fs.write(`${WS}/plan.md`, 'two\n');
        fs.write(`${WS}/by-command.md`, 'x\n');
      });

      const saved = fs.readJson<{ files: Array<{ display: string }>; total: number }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => file.display)).toEqual(['by-command.md', 'plan.md']);
      expect(saved.total).toBe(2);
      await expect(mod.readTurnIndex('conv-1')).resolves.toEqual({
        'loop-1': { total: 2, added: 1, deleted: 1, firstFile: 'by-command.md', restorable: 1, settledAt: 1, copyBytes: 4 },
      });
      expect(told).toEqual(['loop-1', 'loop-1']);
    });
  });

  describe('display and order', () => {
    it('shows a workspace file by relative path, a home file with ~/, any other by absolute path, sorted by that text', async () => {
      await runTurn('loop-1', async (capture) => {
        for (const path of [`${WS}/src/b.ts`, `${WS}/a.md`, `${HOME}/notes/todo.md`, '/opt/tool/config.ini']) {
          await capture(path);
          fs.write(path, 'x\n');
        }
      });

      const saved = fs.readJson<{ files: Array<{ display: string }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => file.display)).toEqual(['/opt/tool/config.ini', 'a.md', 'src/b.ts', '~/notes/todo.md']);
    });

    it('reads a path under the resolved spelling of the workspace as inside it, and lists the file once', async () => {
      const lexical = '/var/work/project';
      const resolved = '/private/var/work/project';
      fs.write(`${resolved}/plan.md`, 'one\n');
      host.listWorkspace.mockImplementation(async () => ({ ...fs.listWorkspace(resolved), root: resolved }));

      await mod.beginTurn('conv-1', 'loop-1', lexical);
      await mod.captureBefore('loop-1', `${resolved}/plan.md`);
      fs.write(`${resolved}/plan.md`, 'two\n');
      fs.write(`${resolved}/by-command.md`, 'x\n');
      await mod.endTurn('loop-1');

      expect(host.listWorkspace.mock.calls[0].slice(0, 2)).toEqual(['conv-1', lexical]);
      const saved = fs.readJson<{ files: Array<{ path: string; display: string; added?: number }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toMatchObject([
        { path: `${resolved}/by-command.md`, display: 'by-command.md' },
        { path: `${resolved}/plan.md`, display: 'plan.md', added: 1 },
      ]);
      expect(saved.files).toHaveLength(2);
    });

    it('shows paths relative to the workspace the conversation has when the turn ends, if it began without one', async () => {
      await mod.beginTurn('conv-1', 'loop-1', null);
      await mod.captureBefore('loop-1', `${WS}/docs/outline.md`);
      fs.write(`${WS}/docs/outline.md`, 'x\n');
      await mod.endTurn('loop-1', { workspacePath: WS });

      expect(host.listWorkspace).not.toHaveBeenCalled();
      const saved = fs.readJson<{ files: Array<{ display: string }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => file.display)).toEqual(['docs/outline.md']);
    });

    it('does not read a sibling folder with the workspace name as a prefix as inside the workspace', async () => {
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}-old/a.md`);
        fs.write(`${WS}-old/a.md`, 'x\n');
      });
      const saved = fs.readJson<{ files: Array<{ display: string }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => file.display)).toEqual(['~/project-old/a.md']);
    });
  });

  describe('limits', () => {
    it('keeps the first 500 files by display path and counts the rest in moreFiles and the totals', async () => {
      const name = (index: number): string => `f${String(index).padStart(4, '0')}.md`;
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/z-last.md`);
        fs.write(`${WS}/z-last.md`, 'a\nb\n');
        for (let index = 0; index < 501; index++) fs.write(`${WS}/${name(index)}`, 'x\n');
      });

      const saved = fs.readJson<{ files: Array<{ display: string }>; moreFiles?: number; total: number; added: number }>(`${CHANGES}/loop-1.json`);
      expect(saved.files).toHaveLength(500);
      expect(saved.files[0].display).toBe(name(0));
      expect(saved.files[499].display).toBe(name(499));
      expect(saved.moreFiles).toBe(2);
      expect(saved.total).toBe(502);
      expect(saved.added).toBe(2);
      await expect(mod.readTurnIndex('conv-1')).resolves.toEqual({
        'loop-1': { total: 502, added: 2, deleted: 0, firstFile: name(0), restorable: 1, settledAt: 1, copyBytes: 0 },
      });
    });

    it('saves a file without hunks, with its line counts, when its hunks do not fit in what is left of 20000 lines', async () => {
      const sizes: Record<string, number> = { 'a.md': 12000, 'b.md': 9000, 'c.md': 3 };
      await runTurn('loop-1', async (capture) => {
        for (const [file, count] of Object.entries(sizes)) {
          await capture(`${WS}/${file}`);
          fs.write(`${WS}/${file}`, lines(count));
        }
      });

      const saved = fs.readJson<{ files: Array<{ display: string; added?: number; hunks?: unknown[] }>; added: number }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => [file.display, file.added, Boolean(file.hunks)])).toEqual([
        ['a.md', 12000, true],
        ['b.md', 9000, false],
        ['c.md', 3, true],
      ]);
      expect(saved.added).toBe(21003);
    });

    it('keeps the hunks of the files after one whose own hunks are over 20000 lines', async () => {
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/a-huge.csv`);
        fs.write(`${WS}/a-huge.csv`, lines(20001));
        await capture(`${WS}/b.md`);
        fs.write(`${WS}/b.md`, lines(3));
      });

      const saved = fs.readJson<{ files: Array<{ display: string; added?: number; hunks?: unknown[] }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => [file.display, file.added, Boolean(file.hunks)])).toEqual([
        ['a-huge.csv', 20001, false],
        ['b.md', 3, true],
      ]);
    });

    it('stops saving hunks once a turn holds 5 MB of them', async () => {
      const wide = (count: number): string => Array.from({ length: count }, (_, index) => `${index}`.padEnd(1000, 'x')).join('\n') + '\n';
      await runTurn('loop-1', async (capture) => {
        for (const file of ['a.md', 'b.md', 'c.md', 'd.md']) {
          await capture(`${WS}/${file}`);
          fs.write(`${WS}/${file}`, wide(1900));
        }
      });

      const saved = fs.readJson<{ files: Array<{ display: string; hunks?: unknown[] }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => [file.display, Boolean(file.hunks)])).toEqual([
        ['a.md', true],
        ['b.md', true],
        ['c.md', false],
        ['d.md', false],
      ]);
    });
  });

  describe('saved index and notifications', () => {
    it('records each turn with changes in index.json and tells listeners', async () => {
      const saved: Array<[string, string]> = [];
      const stop = mod.onTurnChangesSaved((conversationId, loopId) => saved.push([conversationId, loopId]));
      fs.write(`${WS}/docs/plan.md`, 'one\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/docs/plan.md`);
        fs.write(`${WS}/docs/plan.md`, 'two\nthree\n');
      });
      await runTurn('loop-2', async (capture) => {
        await capture(`${WS}/b.md`);
        fs.write(`${WS}/b.md`, 'b\n');
      });
      stop();
      await runTurn('loop-3', () => {});

      expect(fs.readJson(`${CHANGES}/index.json`)).toEqual({
        version: 1,
        turns: {
          'loop-1': { total: 1, added: 2, deleted: 1, firstFile: 'plan.md', restorable: 1, settledAt: 1, copyBytes: 4 },
          'loop-2': { total: 1, added: 1, deleted: 0, firstFile: 'b.md', restorable: 1, settledAt: 2, copyBytes: 0 },
        },
      });
      expect(saved).toEqual([['conv-1', 'loop-1'], ['conv-1', 'loop-2']]);
      await expect(mod.readTurnChanges('conv-1', 'loop-2')).resolves.toMatchObject({ loopId: 'loop-2', total: 1 });
    });

    it('tells listeners when a turn ends without changes', async () => {
      const saved: string[] = [];
      mod.onTurnChangesSaved((_conversationId, loopId) => saved.push(loopId));
      await runTurn('loop-1', () => {});
      expect(saved).toEqual(['loop-1']);
    });

    it.each(['index', 'INDEX', '../x', 'a/b', '', 'nul'])('refuses the loop id %j', async (loopId) => {
      await expect(mod.beginTurn('conv-1', loopId, WS)).rejects.toThrow();
      await expect(mod.readTurnChanges('conv-1', loopId)).rejects.toThrow();
      expect(fs.has(CHANGES)).toBe(false);
    });

    it('rejects a saved file that does not have the saved shape', async () => {
      fs.write(`${CHANGES}/loop-1.json`, '{"loopId":"loop-1"}');
      fs.write(`${CHANGES}/index.json`, '[]');
      await expect(mod.readTurnChanges('conv-1', 'loop-1')).rejects.toThrow();
      await expect(mod.readTurnIndex('conv-1')).rejects.toThrow();
    });

    it.each([
      ['a hunk that is no object', ['x']],
      ['a hunk without line numbers', [{ lines: ['+a'] }]],
      ['hunk lines that are no array', [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: '+a' }]],
      ['a hunk line that is no text', [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [1] }]],
      ['a hunk line without a marker', [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['a'] }]],
    ])('rejects a saved file with %s', async (_label, hunks) => {
      const file = { path: `${WS}/a.md`, display: 'a.md', status: 'modified', added: 1, deleted: 0, hunks };
      fs.write(`${CHANGES}/loop-1.json`, JSON.stringify({ loopId: 'loop-1', files: [file], total: 1, added: 1, deleted: 0 }));
      await expect(mod.readTurnChanges('conv-1', 'loop-1')).rejects.toThrow('not in the saved format');
    });

    it('rejects a saved file that names another turn', async () => {
      fs.write(`${CHANGES}/loop-1.json`, JSON.stringify({ loopId: 'loop-2', files: [], total: 0, added: 0, deleted: 0 }));
      await expect(mod.readTurnChanges('conv-1', 'loop-1')).rejects.toThrow('another turn');
    });
  });

  describe('a conversation deleted while its turn runs', () => {
    it('writes nothing at the end of the turn', async () => {
      let present = true;
      await mod.beginTurn('conv-1', 'loop-1', null, { isConversationPresent: () => present });
      await mod.captureBefore('loop-1', `${WS}/new.md`);
      fs.write(`${WS}/new.md`, 'n\n');
      fs.delete(`${HOME}/.abu/conversations/conv-1`);
      present = false;
      const told: string[] = [];
      mod.onTurnChangesSaved((_conversationId, loopId) => told.push(loopId));

      await mod.endTurn('loop-1');

      expect(fs.has(`${HOME}/.abu/conversations/conv-1`)).toBe(false);
      expect(told).toEqual([]);
    });

    it('keeps no copy of a file written after the conversation is gone', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      await mod.beginTurn('conv-1', 'loop-1', null, { isConversationPresent: () => false });

      await mod.captureBefore('loop-1', `${WS}/plan.md`);

      expect(fs.has(`${HOME}/.abu/conversations/conv-1`)).toBe(false);
    });
  });

  describe('one turn after another', () => {
    it('begins the next turn of a conversation only after the previous one has settled', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/plan.md`);
      fs.write(`${WS}/plan.md`, 'two\n');

      const order: string[] = [];
      let releaseEndList: () => void = () => {};
      let endListRequested: () => void = () => {};
      const requested = new Promise<void>((resolve) => { endListRequested = resolve; });
      host.listWorkspace.mockImplementation(async (_conversationId: string, root: string) => {
        if (order.length === 0) {
          order.push('end list of loop-1');
          const released = new Promise<void>((resolve) => { releaseEndList = resolve; });
          endListRequested();
          await released;
        } else {
          order.push(`start list of loop-2, loop-1 saved: ${fs.has(`${CHANGES}/loop-1.json`)}`);
        }
        return fs.listWorkspace(root);
      });

      const ending = mod.endTurn('loop-1');
      const beginning = mod.beginTurn('conv-1', 'loop-2', WS);
      await requested;
      expect(order).toEqual(['end list of loop-1']);
      releaseEndList();
      await Promise.all([ending, beginning]);

      expect(order).toEqual(['end list of loop-1', 'start list of loop-2, loop-1 saved: true']);
    });

    it('does not wait for a turn of another conversation', async () => {
      let release: () => void = () => {};
      let listRequested: () => void = () => {};
      const requested = new Promise<void>((resolve) => { listRequested = resolve; });
      await mod.beginTurn('conv-1', 'loop-1', WS);
      host.listWorkspace.mockImplementationOnce(() => new Promise<ConversationWorkspaceFiles>((resolve) => {
        release = () => resolve({ root: WS, exceeded: false, files: [] });
        listRequested();
      }));
      const ending = mod.endTurn('loop-1');
      await requested;

      await mod.beginTurn('conv-2', 'loop-2', null);
      release();
      await ending;
    });

    it('begins the next turn even when the previous one failed to settle', async () => {
      await mod.beginTurn('conv-1', 'loop-1', WS);
      host.listWorkspace.mockRejectedValueOnce(new Error('list failed'));
      await expect(mod.endTurn('loop-1')).rejects.toThrow('list failed');
      await expect(mod.beginTurn('conv-1', 'loop-2', WS)).resolves.toBeUndefined();
    });
  });

  describe('undo record', () => {
    const text = (value: string): Promise<string> => sha256Hex(new TextEncoder().encode(value));
    /** Texts of an `undo.json` of loop-1 that are JSON and no record of that turn. */
    const UNREADABLE_RECORDS: Array<[string, string]> = [
      ['of a later format version', '{"version":2}'],
      ['with an entry that has no path', JSON.stringify({ version: 1, loopId: 'loop-1', state: 'applied', entries: [{ hash: 'x' }] })],
      ['of another turn', JSON.stringify({ version: 1, loopId: 'loop-2', state: 'applied', entries: [] })],
      ['whose text is no JSON', '{"version":1,"loopId":"loop-1","sta'],
      ['that is empty', ''],
    ];

    it('keeps what a modified, a created and a deleted file held before the turn, with both content hashes', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      fs.write(`${WS}/old.md`, 'gone\n');
      fs.write(`${WS}/same.md`, 'same\n');
      await runTurn('loop-1', async (capture) => {
        for (const file of ['plan.md', 'new.md', 'old.md', 'same.md']) await capture(`${WS}/${file}`);
        fs.write(`${WS}/plan.md`, 'two\n');
        fs.write(`${WS}/new.md`, 'n\n');
        fs.delete(`${WS}/old.md`);
      });

      const hashes = {
        plan: await pathHashOf(`${WS}/plan.md`),
        created: await pathHashOf(`${WS}/new.md`),
        old: await pathHashOf(`${WS}/old.md`),
      };
      expect(fs.readJson(`${CHANGES}/loop-1/undo.json`)).toEqual({
        version: 1,
        loopId: 'loop-1',
        state: 'applied',
        entries: [
          { path: `${WS}/new.md`, hash: hashes.created, before: 'absent', after: 'file', afterSha256: await text('n\n') },
          { path: `${WS}/old.md`, hash: hashes.old, before: 'file', after: 'absent', beforeSha256: await text('gone\n') },
          {
            path: `${WS}/plan.md`,
            hash: hashes.plan,
            before: 'file',
            after: 'file',
            beforeSha256: await text('one\n'),
            afterSha256: await text('two\n'),
          },
        ],
      });
      expect(fs.list(`${CHANGES}/loop-1/`)).toEqual([
        `${CHANGES}/loop-1/before/${hashes.old}`,
        `${CHANGES}/loop-1/before/${hashes.plan}`,
        `${CHANGES}/loop-1/undo.json`,
      ].sort());
      expect(fs.read(`${CHANGES}/loop-1/before/${hashes.plan}`)).toBe('one\n');
      expect(fs.read(`${CHANGES}/loop-1/before/${hashes.old}`)).toBe('gone\n');
      await expect(mod.readTurnIndex('conv-1')).resolves.toMatchObject({ 'loop-1': { total: 3, restorable: 3 } });
      await expect(mod.readTurnUndoRecord('conv-1', 'loop-1')).resolves.toMatchObject({ state: 'applied' });
    });

    it('keeps no before directory when every restorable file was created by the turn', async () => {
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/new.md`);
        fs.write(`${WS}/new.md`, 'n\n');
      });

      expect(fs.list(`${CHANGES}/loop-1/`)).toEqual([`${CHANGES}/loop-1/undo.json`]);
      expect(fs.has(`${CHANGES}/loop-1/before`)).toBe(false);
    });

    it('leaves out an unchanged file, a file over 2 MB at either end, and a file only the list shows', async () => {
      const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(97);
      fs.write(`${WS}/plan.md`, 'one\n');
      fs.write(`${WS}/same.md`, 'same\n');
      fs.writeBytes(`${WS}/was-big.log`, big);
      fs.write(`${WS}/grew.log`, 'small\n');
      await runTurn('loop-1', async (capture) => {
        for (const file of ['plan.md', 'same.md', 'was-big.log', 'grew.log']) await capture(`${WS}/${file}`);
        fs.write(`${WS}/plan.md`, 'two\n');
        fs.write(`${WS}/was-big.log`, 'now small\n');
        fs.writeBytes(`${WS}/grew.log`, big);
        fs.write(`${WS}/by-command.md`, 'x\n');
      });

      const record = await mod.readTurnUndoRecord('conv-1', 'loop-1');
      expect(record?.entries.map((entry) => entry.path)).toEqual([`${WS}/plan.md`]);
      expect(fs.list(`${CHANGES}/loop-1/before/`)).toEqual([`${CHANGES}/loop-1/before/${await pathHashOf(`${WS}/plan.md`)}`]);
      await expect(mod.readTurnIndex('conv-1')).resolves.toMatchObject({ 'loop-1': { total: 4, restorable: 1 } });
    });

    it('removes the turn directory and records no restorable count when only a command changed files', async () => {
      await runTurn('loop-1', () => {
        fs.write(`${WS}/by-command.md`, 'x\n');
      });

      expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
      expect(fs.readJson(`${CHANGES}/index.json`)).toEqual({
        version: 1,
        turns: { 'loop-1': { total: 1, added: 0, deleted: 0, firstFile: 'by-command.md' } },
      });
      await expect(mod.readTurnUndoRecord('conv-1', 'loop-1')).resolves.toBeNull();
    });

    it.each(UNREADABLE_RECORDS)('reads a record %s as no record', async (_label, text) => {
      fs.write(`${CHANGES}/loop-1/undo.json`, text);
      await expect(mod.readTurnUndoRecord('conv-1', 'loop-1')).resolves.toBeNull();
    });

    it.each(['index', '../x', ''])('refuses the loop id %j', async (loopId) => {
      await expect(mod.readTurnUndoRecord('conv-1', loopId)).rejects.toThrow();
    });

    it('rejects an index entry whose restorable count or undone mark has another type', async () => {
      const entry = { total: 1, added: 0, deleted: 0, firstFile: 'a.md' };
      fs.write(`${CHANGES}/index.json`, JSON.stringify({ version: 1, turns: { 'loop-1': { ...entry, restorable: '1' } } }));
      await expect(mod.readTurnIndex('conv-1')).rejects.toThrow('not in the saved format');
      fs.write(`${CHANGES}/index.json`, JSON.stringify({ version: 1, turns: { 'loop-1': { ...entry, undone: 1 } } }));
      await expect((await restart()).readTurnIndex('conv-1')).rejects.toThrow('not in the saved format');
    });

    describe('after a restart', () => {
      it('leaves a settled turn with its record and copies as they are', async () => {
        fs.write(`${WS}/plan.md`, 'one\n');
        await runTurn('loop-1', async (capture) => {
          await capture(`${WS}/plan.md`);
          fs.write(`${WS}/plan.md`, 'two\n');
        });
        const kept = fs.list(`${CHANGES}/`).map((path) => [path, fs.read(path)]);
        fs.write(`${WS}/plan.md`, 'three\n');

        const afterRestart = await restart();
        const told: string[] = [];
        afterRestart.onTurnChangesSaved((_conversationId, loopId) => told.push(loopId));
        await afterRestart.readTurnIndex('conv-1');

        expect(fs.list(`${CHANGES}/`).map((path) => [path, fs.read(path)])).toEqual(kept);
        expect(told).toEqual([]);
      });

      it('finishes removing the copies a settled turn does not need when the app quit before that', async () => {
        fs.write(`${WS}/plan.md`, 'one\n');
        fs.write(`${WS}/same.md`, 'same\n');
        await runTurn('loop-1', async (capture) => {
          await capture(`${WS}/plan.md`);
          await capture(`${WS}/same.md`);
          fs.write(`${WS}/plan.md`, 'two\n');
        });
        const sameCopy = `${CHANGES}/loop-1/before/${await pathHashOf(`${WS}/same.md`)}`;
        fs.write(sameCopy, 'same\n');
        fs.write(`${CHANGES}/loop-1/before/manifest.json`, JSON.stringify({ version: 1, loopId: 'loop-1', workspaceRoots: [WS], entries: [] }));

        await (await restart()).readTurnIndex('conv-1');

        expect(fs.list(`${CHANGES}/loop-1/`)).toEqual([
          `${CHANGES}/loop-1/before/${await pathHashOf(`${WS}/plan.md`)}`,
          `${CHANGES}/loop-1/undo.json`,
        ]);
      });

      it('drops the restorable count of a turn whose record is not on disk', async () => {
        fs.write(`${WS}/plan.md`, 'one\n');
        await runTurn('loop-1', async (capture) => {
          await capture(`${WS}/plan.md`);
          fs.write(`${WS}/plan.md`, 'two\n');
        });
        fs.delete(`${CHANGES}/loop-1/undo.json`);

        await expect((await restart()).readTurnIndex('conv-1')).resolves.toEqual({
          'loop-1': { total: 1, added: 1, deleted: 1, firstFile: 'plan.md' },
        });
        expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
      });

      it.each(UNREADABLE_RECORDS)(
        'takes the undo from a turn that has a record %s, keeps its directory and leaves the other turns as they are',
        async (_label, unreadable) => {
          fs.write(`${WS}/plan.md`, 'one\n');
          fs.write(`${WS}/notes.md`, 'n1\n');
          await runTurn('loop-1', async (capture) => {
            await capture(`${WS}/plan.md`);
            fs.write(`${WS}/plan.md`, 'two\n');
          });
          await runTurn('loop-2', async (capture) => {
            await capture(`${WS}/notes.md`);
            fs.write(`${WS}/notes.md`, 'n2\n');
          });
          fs.write(`${CHANGES}/loop-1/undo.json`, unreadable);
          const kept = fs.list(`${CHANGES}/loop-1/`).map((path) => [path, fs.read(path)]);
          const expected = {
            'loop-1': { total: 1, added: 1, deleted: 1, firstFile: 'plan.md' },
            'loop-2': { total: 1, added: 1, deleted: 1, firstFile: 'notes.md', restorable: 1, settledAt: 2, copyBytes: 3 },
          };

          const afterRestart = await restart();
          await expect(afterRestart.readTurnIndex('conv-1')).resolves.toEqual(expected);
          await expect(afterRestart.readTurnIndex('conv-1')).resolves.toEqual(expected);
          await expect(afterRestart.readTurnChanges('conv-1', 'loop-1')).resolves.toMatchObject({ total: 1 });
          await expect(afterRestart.readTurnUndoRecord('conv-1', 'loop-1')).resolves.toBeNull();
          await expect(afterRestart.readTurnUndoRecord('conv-1', 'loop-2')).resolves.toMatchObject({ state: 'applied' });

          await expect((await restart()).readTurnIndex('conv-1')).resolves.toEqual(expected);
          expect(fs.list(`${CHANGES}/loop-1/`).map((path) => [path, fs.read(path)])).toEqual(kept);
        },
      );

      it('removes a record that has no saved result beside it', async () => {
        fs.write(`${CHANGES}/loop-1/undo.json`, JSON.stringify({ version: 1, loopId: 'loop-1', state: 'applied', entries: [] }));

        await mod.readTurnIndex('conv-1');

        expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
      });
    });
  });

  describe('copy limit of a conversation', () => {
    /** A turn that replaces the 10 bytes of `file` with other content. */
    async function runTenByteTurn(loopId: string, file: string): Promise<void> {
      fs.write(`${WS}/${file}`, '0123456789');
      await runTurn(loopId, async (capture) => {
        await capture(`${WS}/${file}`);
        fs.write(`${WS}/${file}`, `changed by ${loopId}`);
      });
    }

    it('keeps 200 MB of copies per conversation', () => {
      expect(mod.MAX_CONVERSATION_COPY_BYTES).toBe(200 * 1024 * 1024);
    });

    it('records the settle order and the copy size of each restorable turn', async () => {
      await runTenByteTurn('loop-b', 'b.md');
      await runTurn('loop-x', () => {
        fs.write(`${WS}/by-command.md`, 'x\n');
      });
      await runTenByteTurn('loop-a', 'a.md');

      const index = await mod.readTurnIndex('conv-1');
      expect(index['loop-b']).toMatchObject({ settledAt: 1, copyBytes: 10 });
      expect(index['loop-a']).toMatchObject({ settledAt: 2, copyBytes: 10 });
      expect(index['loop-x']).toEqual({ total: 1, added: 0, deleted: 0, firstFile: 'by-command.md' });
    });

    it('removes the copies of the turns settled longest ago once the limit is passed', async () => {
      mod.__testing.setConversationCopyLimit(25);
      const told: string[] = [];
      mod.onTurnChangesSaved((_conversationId, loopId) => told.push(loopId));
      await runTenByteTurn('loop-c', 'c.md');
      await runTenByteTurn('loop-a', 'a.md');
      expect(fs.has(`${CHANGES}/loop-c/undo.json`)).toBe(true);
      told.length = 0;

      await runTenByteTurn('loop-b', 'b.md');

      expect(fs.has(`${CHANGES}/loop-c`)).toBe(false);
      expect(fs.has(`${CHANGES}/loop-a/undo.json`)).toBe(true);
      expect(fs.has(`${CHANGES}/loop-b/undo.json`)).toBe(true);
      const index = await mod.readTurnIndex('conv-1');
      expect(index['loop-c']).toEqual({ total: 1, added: 1, deleted: 1, firstFile: 'c.md' });
      expect(index['loop-a']).toMatchObject({ restorable: 1 });
      expect(index['loop-b']).toMatchObject({ restorable: 1 });
      expect(fs.has(`${CHANGES}/loop-c.json`)).toBe(true);
      await expect(mod.readTurnUndoRecord('conv-1', 'loop-c')).resolves.toBeNull();
      expect(told).toEqual(['loop-c', 'loop-b']);
    });

    it('removes several turns when one settle passes the limit by more than one of them', async () => {
      await runTenByteTurn('loop-1', 'a.md');
      await runTenByteTurn('loop-2', 'b.md');
      await runTenByteTurn('loop-3', 'c.md');
      mod.__testing.setConversationCopyLimit(15);

      await runTenByteTurn('loop-4', 'd.md');

      const index = await mod.readTurnIndex('conv-1');
      expect(Object.entries(index).map(([loopId, entry]) => [loopId, entry.restorable])).toEqual([
        ['loop-1', undefined],
        ['loop-2', undefined],
        ['loop-3', undefined],
        ['loop-4', 1],
      ]);
      expect(fs.list(`${CHANGES}/`).filter((path) => path.endsWith('undo.json'))).toEqual([`${CHANGES}/loop-4/undo.json`]);
    });

    it('keeps no copies of a turn that is over the limit by itself, also when the list adds files to it', async () => {
      mod.__testing.setConversationCopyLimit(5);
      fs.write(`${WS}/a.md`, '0123456789');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/a.md`);
        fs.write(`${WS}/a.md`, 'changed');
        fs.write(`${WS}/by-command.md`, 'x\n');
      });

      expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
      await expect(mod.readTurnIndex('conv-1')).resolves.toEqual({
        'loop-1': { total: 2, added: 1, deleted: 1, firstFile: 'a.md' },
      });
    });

    it('keeps the turns of another conversation', async () => {
      mod.__testing.setConversationCopyLimit(15);
      await runTenByteTurn('loop-1', 'a.md');
      fs.write(`${WS}/other.md`, '0123456789');
      await mod.beginTurn('conv-2', 'loop-2', WS);
      await mod.captureBefore('loop-2', `${WS}/other.md`);
      fs.write(`${WS}/other.md`, 'changed');
      await mod.endTurn('loop-2');

      expect(fs.has(`${CHANGES}/loop-1/undo.json`)).toBe(true);
      expect(fs.has(`${HOME}/.abu/conversations/conv-2/changes/loop-2/undo.json`)).toBe(true);
    });
  });

  describe('after the app quit in the middle of a turn', () => {
    it('settles the left-over turn from the disk as it is when the conversation is read', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/plan.md`);
      await mod.captureBefore('loop-1', `${WS}/new.md`);
      fs.write(`${WS}/plan.md`, 'two\n');
      fs.write(`${WS}/new.md`, 'n\n');
      fs.write(`${WS}/by-command.md`, 'x\n');

      const afterRestart = await restart();
      const saved: string[] = [];
      afterRestart.onTurnChangesSaved((_conversationId, loopId) => saved.push(loopId));
      const index = await afterRestart.readTurnIndex('conv-1');

      expect(index).toEqual({
        'loop-1': { total: 2, added: 2, deleted: 1, firstFile: 'new.md', restorable: 2, settledAt: 1, copyBytes: 4 },
      });
      const turn = await afterRestart.readTurnChanges('conv-1', 'loop-1');
      expect(turn?.files.map((file) => [file.display, file.status, file.added, file.deleted])).toEqual([
        ['new.md', 'created', 1, 0],
        ['plan.md', 'modified', 1, 1],
      ]);
      const record = await afterRestart.readTurnUndoRecord('conv-1', 'loop-1');
      expect(record?.entries.map((entry) => [entry.path, entry.before, entry.after])).toEqual([
        [`${WS}/new.md`, 'absent', 'file'],
        [`${WS}/plan.md`, 'file', 'file'],
      ]);
      expect(fs.list(`${CHANGES}/loop-1/`)).toEqual([
        `${CHANGES}/loop-1/before/${await pathHashOf(`${WS}/plan.md`)}`,
        `${CHANGES}/loop-1/undo.json`,
      ]);
      expect(saved).toEqual(['loop-1']);
      expect(host.listWorkspace).toHaveBeenCalledTimes(1);
    });

    it('settles a left-over turn once, also when the index is read twice at the same time', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/plan.md`);
      fs.write(`${WS}/plan.md`, 'two\n');

      const afterRestart = await restart();
      const saved: string[] = [];
      afterRestart.onTurnChangesSaved((_conversationId, loopId) => saved.push(loopId));
      const [first, second] = await Promise.all([afterRestart.readTurnIndex('conv-1'), afterRestart.readTurnIndex('conv-1')]);

      expect(first).toEqual(second);
      expect(saved).toEqual(['loop-1']);
    });

    it('leaves a turn that is still running alone', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/plan.md`);

      await expect(mod.readTurnIndex('conv-1')).resolves.toEqual({});
      expect(fs.has(`${CHANGES}/loop-1/before/manifest.json`)).toBe(true);
    });

    it('leaves a turn of this run to its own end when the index is first read just before it ends', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      await mod.beginTurn('conv-1', 'loop-1', WS);
      await mod.captureBefore('loop-1', `${WS}/plan.md`);
      fs.write(`${WS}/plan.md`, 'two\n');
      fs.write(`${WS}/by-command.md`, 'x\n');

      const index = mod.readTurnIndex('conv-1');
      await mod.endTurn('loop-1');
      await index;

      const saved = fs.readJson<{ files: Array<{ display: string }> }>(`${CHANGES}/loop-1.json`);
      expect(saved.files.map((file) => file.display)).toEqual(['by-command.md', 'plan.md']);
    });

    it('removes a left-over directory without a manifest, and one whose result is already saved', async () => {
      fs.write(`${CHANGES}/loop-1/before/abcdef0123456789`, 'orphan');
      fs.write(`${CHANGES}/loop-2.json`, JSON.stringify({ loopId: 'loop-2', files: [], total: 0, added: 0, deleted: 0 }));
      fs.write(`${CHANGES}/loop-2/before/manifest.json`, JSON.stringify({ version: 1, loopId: 'loop-2', workspaceRoots: [WS], entries: [] }));
      const savedBefore = fs.read(`${CHANGES}/loop-2.json`);

      await mod.readTurnIndex('conv-1');

      expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
      expect(fs.has(`${CHANGES}/loop-2`)).toBe(false);
      expect(fs.read(`${CHANGES}/loop-2.json`)).toBe(savedBefore);
    });

    it('adds the index entry of a saved result the index does not list yet', async () => {
      const saved = {
        loopId: 'loop-2',
        files: [{ path: `${WS}/docs/a.md`, display: 'docs/a.md', status: 'created', added: 3, deleted: 0 }],
        total: 1,
        added: 3,
        deleted: 0,
      };
      fs.write(`${CHANGES}/loop-2.json`, JSON.stringify(saved));
      fs.write(`${CHANGES}/loop-2/before/manifest.json`, JSON.stringify({ version: 1, loopId: 'loop-2', workspaceRoots: [WS], entries: [] }));

      await expect(mod.readTurnIndex('conv-1')).resolves.toEqual({
        'loop-2': { total: 1, added: 3, deleted: 0, firstFile: 'a.md' },
      });
    });

    it('reads an empty index for a conversation that has no changes directory', async () => {
      await expect(mod.readTurnIndex('conv-1')).resolves.toEqual({});
      await expect(mod.readTurnChanges('conv-1', 'loop-1')).resolves.toBeNull();
    });
  });
});
