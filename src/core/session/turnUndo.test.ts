import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeWorkspace, checkWritePath, revokeWorkspace } from '@/core/tools/pathSafety';
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
  writeFile: (path: string, bytes: Uint8Array, options?: { create?: boolean; createNew?: boolean }) => host.fs.pluginFs.writeFile(path, bytes, options),
  remove: (path: string, options?: { recursive?: boolean }) => host.fs.pluginFs.remove(path, options),
  readDir: (path: string) => host.fs.pluginFs.readDir(path),
  stat: (path: string) => host.fs.pluginFs.stat(path),
  // The write check inspects the components of a path; the memory disk holds no link.
  lstat: async () => ({ isSymlink: false }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: { path: string }) => {
    if (command !== 'move_to_trash') throw new Error(`unexpected command ${command}`);
    return host.fs.moveToTrash(args.path);
  },
}));
vi.mock('@/core/tools/fsBridge', () => ({
  exists: (path: string) => host.fs.bridge.exists(path),
  stat: (path: string) => host.fs.bridge.stat(path),
  readFile: (path: string) => host.fs.bridge.readFile(path),
}));
vi.mock('@/utils/atomicFs', () => ({
  atomicWrite: (path: string, content: string) => host.fs.atomicWrite(path, content),
  writeFileAtomic: (path: string, bytes: Uint8Array, mode: 'replace' | 'create') => host.fs.writeFileAtomic(path, bytes, mode),
}));
vi.mock('@/core/files/workspaceFiles', () => ({
  listConversationWorkspaceFiles: (...args: unknown[]) => host.listWorkspace(...args),
}));

type TurnChangesModule = typeof import('./turnChanges');
type TurnUndoModule = typeof import('./turnUndo');

const HOME = '/Users/testuser';
const WS = `${HOME}/project`;
const CONVERSATION = `${HOME}/.abu/conversations/conv-1`;
const CHANGES = `${CONVERSATION}/changes`;
const BIG = new Uint8Array(2 * 1024 * 1024 + 1).fill(97);

let fs: MemoryHostFs;
let changes: TurnChangesModule;
let undo: TurnUndoModule;
let authorize: import('vitest').Mock<(path: string) => Promise<boolean>>;

/** Fresh module instances over the same disk: what an app restart leaves behind. */
async function restart(): Promise<void> {
  vi.resetModules();
  changes = await import('./turnChanges');
  undo = await import('./turnUndo');
}

async function runTurn(loopId: string, edits: (capture: (path: string) => Promise<void>) => Promise<void> | void): Promise<void> {
  await changes.beginTurn('conv-1', loopId, WS);
  await edits((path) => changes.captureBefore(loopId, path));
  await changes.endTurn(loopId);
}

/** A turn that modifies plan.md, creates new.md and deletes old.md. */
async function runMixedTurn(loopId = 'loop-1'): Promise<void> {
  fs.write(`${WS}/plan.md`, 'one\n');
  fs.write(`${WS}/old.md`, 'gone\n');
  await runTurn(loopId, async (capture) => {
    for (const file of ['plan.md', 'new.md', 'old.md']) await capture(`${WS}/${file}`);
    fs.write(`${WS}/plan.md`, 'two\n');
    fs.write(`${WS}/new.md`, 'n\n');
    fs.delete(`${WS}/old.md`);
  });
}

function workspaceFiles(): Record<string, string> {
  return Object.fromEntries(fs.list(`${WS}/`).map((path) => [path.slice(WS.length + 1), fs.read(path)]));
}

function recordOf(loopId = 'loop-1'): { state: string; entries: Array<{ path: string; hash: string; last?: string }> } {
  return fs.readJson(`${CHANGES}/${loopId}/undo.json`);
}

function lastByFile(loopId = 'loop-1'): Record<string, string | undefined> {
  return Object.fromEntries(recordOf(loopId).entries.map((entry) => [entry.path.slice(WS.length + 1), entry.last]));
}

beforeAll(async () => {
  host.fs = createMemoryHostFs();
  await import('./turnChanges');
  await import('./turnUndo');
});

beforeEach(async () => {
  fs = createMemoryHostFs();
  host.fs = fs;
  host.listWorkspace = vi.fn(async (_conversationId: string, root: string): Promise<ConversationWorkspaceFiles> => fs.listWorkspace(root));
  authorize = vi.fn(async () => true);
  await restart();
});

describe('turnUndo', () => {
  describe('planTurnUndo', () => {
    it('lists a modified, a created and a deleted file with what undoing does to each', async () => {
      await runMixedTurn();

      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize })).resolves.toEqual({
        willRestore: [
          { path: `${WS}/new.md`, display: 'new.md', action: 'trash' },
          { path: `${WS}/old.md`, display: 'old.md', action: 'put-back' },
          { path: `${WS}/plan.md`, display: 'plan.md', action: 'write-before' },
        ],
        wontRestore: [],
      });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'two\n', 'new.md': 'n\n' });
    });

    it('lists a file changed after the turn as changed since', async () => {
      await runMixedTurn();
      fs.write(`${WS}/plan.md`, 'mine\n');
      fs.write(`${WS}/old.md`, 'back by hand\n');
      fs.write(`${WS}/new.md`, 'extended\n');

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize });

      expect(plan.willRestore).toEqual([]);
      expect(plan.wontRestore).toEqual([
        { path: `${WS}/new.md`, display: 'new.md', reason: 'changed-since' },
        { path: `${WS}/old.md`, display: 'old.md', reason: 'changed-since' },
        { path: `${WS}/plan.md`, display: 'plan.md', reason: 'changed-since' },
      ]);
    });

    it('lists a file that grew past 2 MB after the turn as changed since', async () => {
      await runMixedTurn();
      fs.writeBytes(`${WS}/plan.md`, BIG);

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize });

      expect(plan.wontRestore).toEqual([{ path: `${WS}/plan.md`, display: 'plan.md', reason: 'changed-since' }]);
    });

    it('lists files a command changed as by command and files over 2 MB as too large', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      fs.writeBytes(`${WS}/was-big.log`, BIG);
      fs.write(`${WS}/grew.log`, 'small\n');
      await runTurn('loop-1', async (capture) => {
        for (const file of ['plan.md', 'was-big.log', 'grew.log']) await capture(`${WS}/${file}`);
        fs.write(`${WS}/plan.md`, 'two\n');
        fs.write(`${WS}/was-big.log`, 'now small\n');
        fs.writeBytes(`${WS}/grew.log`, BIG);
        fs.write(`${WS}/by-command.md`, 'x\n');
      });

      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize })).resolves.toEqual({
        willRestore: [{ path: `${WS}/plan.md`, display: 'plan.md', action: 'write-before' }],
        wontRestore: [
          { path: `${WS}/by-command.md`, display: 'by-command.md', reason: 'by-command' },
          { path: `${WS}/grew.log`, display: 'grew.log', reason: 'too-large' },
          { path: `${WS}/was-big.log`, display: 'was-big.log', reason: 'too-large' },
        ],
      });
    });

    it('lists a file whose folder is gone as folder gone', async () => {
      fs.write(`${WS}/docs/old.md`, 'gone\n');
      fs.write(`${WS}/plan.md`, 'one\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/docs/old.md`);
        await capture(`${WS}/plan.md`);
        fs.delete(`${WS}/docs/old.md`);
        fs.write(`${WS}/plan.md`, 'two\n');
      });
      fs.delete(`${WS}/docs`);

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize });

      expect(plan.willRestore.map((file) => file.display)).toEqual(['plan.md']);
      expect(plan.wontRestore).toEqual([{ path: `${WS}/docs/old.md`, display: 'docs/old.md', reason: 'folder-gone' }]);
    });

    it('lists a file whose before copy is not on disk among the files that are not restored', async () => {
      await runMixedTurn();
      fs.delete(`${CHANGES}/loop-1/before/${await pathHashOf(`${WS}/plan.md`)}`);

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize });

      expect(plan.willRestore.map((file) => file.display)).toEqual(['new.md', 'old.md']);
      expect(plan.wontRestore.map((file) => file.display)).toEqual(['plan.md']);
    });

    it('lists a file whose write is not authorized as not authorized, and asks about no file that is left alone anyway', async () => {
      await runMixedTurn();
      fs.write(`${WS}/plan.md`, 'mine\n');
      authorize.mockImplementation(async (path) => path !== `${WS}/old.md`);

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize });

      expect(plan).toEqual({
        willRestore: [{ path: `${WS}/new.md`, display: 'new.md', action: 'trash' }],
        wontRestore: [
          { path: `${WS}/old.md`, display: 'old.md', reason: 'not-authorized' },
          { path: `${WS}/plan.md`, display: 'plan.md', reason: 'changed-since' },
        ],
      });
      expect(authorize.mock.calls.map(([path]) => path).sort()).toEqual([`${WS}/new.md`, `${WS}/old.md`]);
      expect(workspaceFiles()).toEqual({ 'plan.md': 'mine\n', 'new.md': 'n\n' });
    });

    it('lists every file as not authorized when no write is authorized', async () => {
      await runMixedTurn();
      authorize.mockResolvedValue(false);

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize });

      expect(plan.willRestore).toEqual([]);
      expect(plan.wontRestore.map((file) => [file.display, file.reason])).toEqual([
        ['new.md', 'not-authorized'],
        ['old.md', 'not-authorized'],
        ['plan.md', 'not-authorized'],
      ]);
    });

    it('gives an empty plan for a turn that has no undo record', async () => {
      await runTurn('loop-1', () => {
        fs.write(`${WS}/by-command.md`, 'x\n');
      });
      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize })).resolves.toEqual({ willRestore: [], wontRestore: [] });
    });

    it('rejects a plan for the direction the turn is not in', async () => {
      await runMixedTurn();
      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'reapply', { authorize })).rejects.toBeInstanceOf(undo.TurnUndoRefusedError);
    });
  });

  describe('undoTurn', () => {
    it('restores a modified file, moves a created file to the trash and writes a deleted file back', async () => {
      await runMixedTurn();
      const told: Array<[string, string]> = [];
      changes.onTurnChangesSaved((conversationId, loopId) => told.push([conversationId, loopId]));

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 3, notDone: [] });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'one\n', 'old.md': 'gone\n' });
      expect(fs.trashed).toEqual([`${WS}/new.md`]);
      expect(authorize.mock.calls.map(([path]) => path).sort()).toEqual([`${WS}/new.md`, `${WS}/old.md`, `${WS}/plan.md`]);
      expect(recordOf().state).toBe('undone');
      expect(lastByFile()).toEqual({ 'new.md': 'done', 'old.md': 'done', 'plan.md': 'done' });
      await expect(changes.readTurnIndex('conv-1')).resolves.toMatchObject({ 'loop-1': { restorable: 3, undone: true } });
      expect(told).toEqual([['conv-1', 'loop-1']]);
    });

    it('keeps what each file held before it is written, under the after directory', async () => {
      await runMixedTurn();

      await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(fs.list(`${CHANGES}/loop-1/after/`)).toEqual([
        `${CHANGES}/loop-1/after/${await pathHashOf(`${WS}/new.md`)}`,
        `${CHANGES}/loop-1/after/${await pathHashOf(`${WS}/plan.md`)}`,
      ].sort());
      expect(fs.read(`${CHANGES}/loop-1/after/${await pathHashOf(`${WS}/plan.md`)}`)).toBe('two\n');
      expect(fs.read(`${CHANGES}/loop-1/after/${await pathHashOf(`${WS}/new.md`)}`)).toBe('n\n');
    });

    it('restores the bytes of a file that is no text', async () => {
      const before = new Uint8Array([0, 255, 1, 254, 13, 10]);
      fs.writeBytes(`${WS}/data.bin`, before);
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/data.bin`);
        fs.writeBytes(`${WS}/data.bin`, new Uint8Array([9, 0, 9]));
      });

      await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect([...(fs.files.get(`${WS}/data.bin`) as Uint8Array)]).toEqual([...before]);
    });

    it('leaves a file changed after the turn exactly as it is and restores the others', async () => {
      await runMixedTurn();
      fs.write(`${WS}/plan.md`, 'my own edit\n');
      const mine = fs.files.get(`${WS}/plan.md`);

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 2, notDone: [] });
      expect(fs.files.get(`${WS}/plan.md`)).toBe(mine);
      expect(authorize.mock.calls.map(([path]) => path)).not.toContain(`${WS}/plan.md`);
      expect(lastByFile()).toEqual({ 'new.md': 'done', 'old.md': 'done', 'plan.md': 'skipped' });
      expect(recordOf().state).toBe('undone');
    });

    it('checks each file again when it runs, so a file changed after the plan was read is left alone', async () => {
      await runMixedTurn();
      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize });
      expect(plan.willRestore).toHaveLength(3);
      fs.write(`${WS}/plan.md`, 'changed while the question was open\n');

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result.done).toBe(2);
      expect(fs.read(`${WS}/plan.md`)).toBe('changed while the question was open\n');
    });

    it('leaves a file that is changed after every file was checked, and before its own write, as the user has it', async () => {
      await runMixedTurn();
      // The authorization of a file is asked after the check of all files and before the write of this one.
      authorize.mockImplementation(async (path) => {
        if (path === `${WS}/plan.md`) fs.write(path, 'saved while the undo ran\n');
        if (path === `${WS}/new.md`) fs.write(path, 'extended while the undo ran\n');
        return true;
      });

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 1, notDone: [] });
      expect(workspaceFiles()).toEqual({
        'plan.md': 'saved while the undo ran\n',
        'new.md': 'extended while the undo ran\n',
        'old.md': 'gone\n',
      });
      expect(fs.trashed).toEqual([]);
      expect(fs.list(`${CHANGES}/loop-1/after/`)).toEqual([]);
      expect(lastByFile()).toEqual({ 'new.md': 'skipped', 'old.md': 'done', 'plan.md': 'skipped' });
      expect(recordOf().state).toBe('undone');
    });

    it('does not overwrite a file that appears where a deleted file is being written back', async () => {
      await runMixedTurn();
      const copy = `${CHANGES}/loop-1/before/${await pathHashOf(`${WS}/old.md`)}`;
      const readFile = fs.pluginFs.readFile;
      // The copy is read after the file was checked for the last time.
      fs.pluginFs.readFile = async (path) => {
        if (path === copy) fs.write(`${WS}/old.md`, 'created while the undo ran\n');
        return readFile(path);
      };

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 2, notDone: [{ path: `${WS}/old.md`, display: 'old.md', reason: 'write-failed' }] });
      expect(fs.read(`${WS}/old.md`)).toBe('created while the undo ran\n');
      expect(lastByFile()).toMatchObject({ 'old.md': 'failed' });
    });

    it('does not create a file again that is removed while its content before the turn is being written', async () => {
      await runMixedTurn();
      const copy = `${CHANGES}/loop-1/before/${await pathHashOf(`${WS}/plan.md`)}`;
      const readFile = fs.pluginFs.readFile;
      fs.pluginFs.readFile = async (path) => {
        if (path === copy) fs.delete(`${WS}/plan.md`);
        return readFile(path);
      };

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 2, notDone: [{ path: `${WS}/plan.md`, display: 'plan.md', reason: 'write-failed' }] });
      expect(fs.has(`${WS}/plan.md`)).toBe(false);
      expect(fs.read(`${CHANGES}/loop-1/after/${await pathHashOf(`${WS}/plan.md`)}`)).toBe('two\n');
    });

    it('records a file whose write is not authorized as not done and restores the others', async () => {
      await runMixedTurn();
      authorize.mockImplementation(async (path) => path !== `${WS}/plan.md`);

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 2, notDone: [{ path: `${WS}/plan.md`, display: 'plan.md', reason: 'not-authorized' }] });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'two\n', 'old.md': 'gone\n' });
      expect(lastByFile()).toEqual({ 'new.md': 'done', 'old.md': 'done', 'plan.md': 'failed' });
    });

    it('records a file whose write fails as not done and restores the others', async () => {
      await runMixedTurn();
      fs.failNextWrite(`${WS}/old.md`);

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 2, notDone: [{ path: `${WS}/old.md`, display: 'old.md', reason: 'write-failed' }] });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'one\n' });
      expect(lastByFile()).toEqual({ 'new.md': 'done', 'old.md': 'failed', 'plan.md': 'done' });
      expect(recordOf().state).toBe('undone');
    });

    it('does not write a before copy whose content is not the recorded one', async () => {
      await runMixedTurn();
      fs.write(`${CHANGES}/loop-1/before/${await pathHashOf(`${WS}/plan.md`)}`, 'tampered\n');

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result.notDone).toEqual([{ path: `${WS}/plan.md`, display: 'plan.md', reason: 'write-failed' }]);
      expect(fs.read(`${WS}/plan.md`)).toBe('two\n');
    });

    it('leaves the state and the index as they are when no file is restored', async () => {
      await runMixedTurn();
      const record = fs.read(`${CHANGES}/loop-1/undo.json`);
      const index = fs.read(`${CHANGES}/index.json`);
      const told: string[] = [];
      changes.onTurnChangesSaved((_conversationId, loopId) => told.push(loopId));
      authorize.mockResolvedValue(false);

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result.done).toBe(0);
      expect(result.notDone.map((file) => file.display)).toEqual(['new.md', 'old.md', 'plan.md']);
      expect(fs.read(`${CHANGES}/loop-1/undo.json`)).toBe(record);
      expect(fs.read(`${CHANGES}/index.json`)).toBe(index);
      expect(workspaceFiles()).toEqual({ 'plan.md': 'two\n', 'new.md': 'n\n' });
      expect(told).toEqual([]);
    });

    it('refuses while the conversation has a turn that is running', async () => {
      await runMixedTurn();
      await changes.beginTurn('conv-1', 'loop-2', WS);

      await expect(undo.undoTurn('conv-1', 'loop-1', { authorize })).rejects.toBeInstanceOf(undo.TurnUndoRefusedError);
      expect(authorize).not.toHaveBeenCalled();
      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize })).resolves.toMatchObject({ willRestore: [{}, {}, {}] });

      expect(workspaceFiles()).toEqual({ 'plan.md': 'two\n', 'new.md': 'n\n' });
      await changes.endTurn('loop-2');
      await expect(undo.undoTurn('conv-1', 'loop-1', { authorize })).resolves.toMatchObject({ done: 3 });
    });

    it('does not refuse for a turn that is running in another conversation', async () => {
      await runMixedTurn();
      await changes.beginTurn('conv-2', 'loop-9', null);
      await expect(undo.undoTurn('conv-1', 'loop-1', { authorize })).resolves.toMatchObject({ done: 3 });
    });

    it('refuses a turn that is already undone', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      await expect(undo.undoTurn('conv-1', 'loop-1', { authorize })).rejects.toBeInstanceOf(undo.TurnUndoRefusedError);
    });

    it('runs after the settle work of the turn that just ended', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      await changes.beginTurn('conv-1', 'loop-1', WS);
      await changes.captureBefore('loop-1', `${WS}/plan.md`);
      fs.write(`${WS}/plan.md`, 'two\n');

      const ending = changes.endTurn('loop-1');
      const undoing = undo.undoTurn('conv-1', 'loop-1', { authorize });
      await ending;

      await expect(undoing).resolves.toEqual({ done: 1, notDone: [] });
      expect(fs.read(`${WS}/plan.md`)).toBe('one\n');
    });

    it('gives the same result after a restart', async () => {
      await runMixedTurn();
      await restart();

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 3, notDone: [] });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'one\n', 'old.md': 'gone\n' });
      expect(fs.trashed).toEqual([`${WS}/new.md`]);
    });

    it('counts a file that already holds its content before the turn as restored, after the app quit half-way', async () => {
      await runMixedTurn();
      // What an undo that stopped after its first file leaves: the file restored, the record untouched.
      fs.write(`${CHANGES}/loop-1/after/${await pathHashOf(`${WS}/plan.md`)}`, 'two\n');
      fs.write(`${WS}/plan.md`, 'one\n');
      await restart();

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize });
      expect(plan).toEqual({
        willRestore: [
          { path: `${WS}/new.md`, display: 'new.md', action: 'trash' },
          { path: `${WS}/old.md`, display: 'old.md', action: 'put-back' },
          { path: `${WS}/plan.md`, display: 'plan.md', action: 'write-before' },
        ],
        wontRestore: [],
      });

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 3, notDone: [] });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'one\n', 'old.md': 'gone\n' });
      expect(fs.read(`${CHANGES}/loop-1/after/${await pathHashOf(`${WS}/plan.md`)}`)).toBe('two\n');
      expect(authorize.mock.calls.map(([path]) => path)).not.toContain(`${WS}/plan.md`);
      expect(recordOf().state).toBe('undone');
    });

    it('drops an entry of the record that was pointed at a path outside the workspace, and never asks about it', async () => {
      await runMixedTurn();
      const outside = `${HOME}/.ssh/authorized_keys`;
      fs.write(outside, 'keys\n');
      const record = fs.readJson<{ entries: Array<{ path: string }> }>(`${CHANGES}/loop-1/undo.json`);
      record.entries = record.entries.map((entry) => (entry.path === `${WS}/plan.md` ? { ...entry, path: outside } : entry));
      fs.write(`${CHANGES}/loop-1/undo.json`, JSON.stringify(record));

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize });
      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(plan.willRestore.map((file) => file.path)).toEqual([`${WS}/new.md`, `${WS}/old.md`]);
      expect(result.done).toBe(2);
      expect(fs.read(outside)).toBe('keys\n');
      expect(fs.read(`${WS}/plan.md`)).toBe('two\n');
      expect([...new Set(authorize.mock.calls.map(([path]) => path))].sort()).toEqual([`${WS}/new.md`, `${WS}/old.md`]);
    });

    it('has nothing to restore for a record that does not have the saved shape, and writes nothing', async () => {
      await runMixedTurn();
      const record = fs.readJson<{ entries: Array<{ path: string }> }>(`${CHANGES}/loop-1/undo.json`);
      record.entries[0].path = '../../outside.md';
      fs.write(`${CHANGES}/loop-1/undo.json`, JSON.stringify(record));

      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize })).resolves.toEqual({ willRestore: [], wontRestore: [] });
      await expect(undo.undoTurn('conv-1', 'loop-1', { authorize })).rejects.toBeInstanceOf(undo.TurnUndoRefusedError);
      expect(workspaceFiles()).toEqual({ 'plan.md': 'two\n', 'new.md': 'n\n' });
      expect(authorize).not.toHaveBeenCalled();
    });

    it.each(['index', '../x', ''])('refuses the loop id %j', async (loopId) => {
      await expect(undo.undoTurn('conv-1', loopId, { authorize })).rejects.toThrow();
      await expect(undo.planTurnUndo('conv-1', loopId, 'undo', { authorize })).rejects.toThrow();
    });
  });

  describe('reapplyTurn', () => {
    it('puts every file back to what it held before the undo, byte for byte', async () => {
      await runMixedTurn();
      const beforeUndo = new Map([...fs.files].filter(([path]) => path.startsWith(`${WS}/`)));
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      const told: string[] = [];
      changes.onTurnChangesSaved((_conversationId, loopId) => told.push(loopId));

      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'reapply', { authorize })).resolves.toEqual({
        willRestore: [
          { path: `${WS}/new.md`, display: 'new.md', action: 'put-back' },
          { path: `${WS}/old.md`, display: 'old.md', action: 'trash' },
          { path: `${WS}/plan.md`, display: 'plan.md', action: 'write-after' },
        ],
        wontRestore: [],
      });
      const result = await undo.reapplyTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 3, notDone: [] });
      const afterReapply = new Map([...fs.files].filter(([path]) => path.startsWith(`${WS}/`)));
      expect([...afterReapply.keys()].sort()).toEqual([...beforeUndo.keys()].sort());
      for (const [path, bytes] of beforeUndo) expect([...(afterReapply.get(path) as Uint8Array)]).toEqual([...bytes]);
      expect(fs.trashed).toEqual([`${WS}/new.md`, `${WS}/old.md`]);
      expect(recordOf().state).toBe('applied');
      const index = await changes.readTurnIndex('conv-1');
      expect(index['loop-1']).toMatchObject({ total: 3, added: 2, deleted: 2, firstFile: 'new.md', restorable: 3 });
      expect(index['loop-1']).not.toHaveProperty('undone');
      expect(told).toEqual(['loop-1']);
    });

    it('can be undone and put back again', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      await undo.reapplyTurn('conv-1', 'loop-1', { authorize });

      await expect(undo.undoTurn('conv-1', 'loop-1', { authorize })).resolves.toEqual({ done: 3, notDone: [] });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'one\n', 'old.md': 'gone\n' });
      await expect(undo.reapplyTurn('conv-1', 'loop-1', { authorize })).resolves.toEqual({ done: 3, notDone: [] });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'two\n', 'new.md': 'n\n' });
    });

    it('leaves a file changed after the undo as it is and lists it as changed since', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      fs.write(`${WS}/plan.md`, 'edited after the undo\n');

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'reapply', { authorize });
      const result = await undo.reapplyTurn('conv-1', 'loop-1', { authorize });

      expect(plan.wontRestore).toEqual([{ path: `${WS}/plan.md`, display: 'plan.md', reason: 'changed-since' }]);
      expect(result).toEqual({ done: 2, notDone: [] });
      expect(fs.read(`${WS}/plan.md`)).toBe('edited after the undo\n');
      expect(lastByFile()).toEqual({ 'new.md': 'done', 'old.md': 'done', 'plan.md': 'skipped' });
    });

    it('leaves a file that is changed after every file was checked, and before its own write, as the user has it', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      authorize.mockImplementation(async (path) => {
        if (path === `${WS}/plan.md`) fs.write(path, 'saved while the changes were put back\n');
        if (path === `${WS}/new.md`) fs.write(path, 'created while the changes were put back\n');
        if (path === `${WS}/old.md`) fs.write(path, 'extended while the changes were put back\n');
        return true;
      });

      const result = await undo.reapplyTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 0, notDone: [] });
      expect(workspaceFiles()).toEqual({
        'plan.md': 'saved while the changes were put back\n',
        'new.md': 'created while the changes were put back\n',
        'old.md': 'extended while the changes were put back\n',
      });
      expect(fs.trashed).toEqual([`${WS}/new.md`]);
      expect(recordOf().state).toBe('undone');
    });

    it('does not overwrite a file that appears where a created file is being put back', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      const copy = `${CHANGES}/loop-1/after/${await pathHashOf(`${WS}/new.md`)}`;
      const readFile = fs.pluginFs.readFile;
      fs.pluginFs.readFile = async (path) => {
        if (path === copy) fs.write(`${WS}/new.md`, 'created while the changes were put back\n');
        return readFile(path);
      };

      const result = await undo.reapplyTurn('conv-1', 'loop-1', { authorize });

      expect(result).toEqual({ done: 2, notDone: [{ path: `${WS}/new.md`, display: 'new.md', reason: 'write-failed' }] });
      expect(fs.read(`${WS}/new.md`)).toBe('created while the changes were put back\n');
    });

    it('lists a file whose folder is gone as folder gone', async () => {
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/docs/new.md`);
        fs.write(`${WS}/docs/new.md`, 'n\n');
        await capture(`${WS}/plan.md`);
        fs.write(`${WS}/plan.md`, 'p\n');
      });
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      fs.delete(`${WS}/docs`);

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'reapply', { authorize });

      expect(plan.willRestore.map((file) => file.display)).toEqual(['plan.md']);
      expect(plan.wontRestore).toEqual([{ path: `${WS}/docs/new.md`, display: 'docs/new.md', reason: 'folder-gone' }]);
    });

    it('lists a file whose after copy is not on disk among the files that are not put back', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      fs.delete(`${CHANGES}/loop-1/after/${await pathHashOf(`${WS}/new.md`)}`);

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'reapply', { authorize });
      const result = await undo.reapplyTurn('conv-1', 'loop-1', { authorize });

      expect(plan.willRestore.map((file) => file.display)).toEqual(['old.md', 'plan.md']);
      expect(plan.wontRestore.map((file) => file.display)).toEqual(['new.md']);
      expect(result.done).toBe(2);
      expect(fs.has(`${WS}/new.md`)).toBe(false);
      expect(lastByFile()).toMatchObject({ 'new.md': 'skipped' });
    });

    it('leaves out the files the undo did not restore, and the files the turn changed by command', async () => {
      fs.write(`${WS}/plan.md`, 'one\n');
      fs.write(`${WS}/notes.md`, 'n1\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/plan.md`);
        await capture(`${WS}/notes.md`);
        fs.write(`${WS}/plan.md`, 'two\n');
        fs.write(`${WS}/notes.md`, 'n2\n');
        fs.write(`${WS}/by-command.md`, 'x\n');
      });
      fs.write(`${WS}/notes.md`, 'mine\n');
      await undo.undoTurn('conv-1', 'loop-1', { authorize });

      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'reapply', { authorize })).resolves.toEqual({
        willRestore: [{ path: `${WS}/plan.md`, display: 'plan.md', action: 'write-after' }],
        wontRestore: [],
      });
      await expect(undo.reapplyTurn('conv-1', 'loop-1', { authorize })).resolves.toEqual({ done: 1, notDone: [] });
      expect(fs.read(`${WS}/notes.md`)).toBe('mine\n');
      expect(lastByFile()).toEqual({ 'notes.md': undefined, 'plan.md': 'done' });
    });

    it('lists a file whose write is not authorized as not authorized', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      authorize.mockImplementation(async (path) => path !== `${WS}/plan.md`);

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'reapply', { authorize });

      expect(plan).toEqual({
        willRestore: [
          { path: `${WS}/new.md`, display: 'new.md', action: 'put-back' },
          { path: `${WS}/old.md`, display: 'old.md', action: 'trash' },
        ],
        wontRestore: [{ path: `${WS}/plan.md`, display: 'plan.md', reason: 'not-authorized' }],
      });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'one\n', 'old.md': 'gone\n' });
    });

    it('records a file whose write is not authorized as not done and keeps the turn undone when none is put back', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      const record = fs.read(`${CHANGES}/loop-1/undo.json`);
      authorize.mockResolvedValue(false);

      const result = await undo.reapplyTurn('conv-1', 'loop-1', { authorize });

      expect(result.done).toBe(0);
      expect(result.notDone.map((file) => [file.display, file.reason])).toEqual([
        ['new.md', 'not-authorized'],
        ['old.md', 'not-authorized'],
        ['plan.md', 'not-authorized'],
      ]);
      expect(fs.read(`${CHANGES}/loop-1/undo.json`)).toBe(record);
      await expect(changes.readTurnIndex('conv-1')).resolves.toMatchObject({ 'loop-1': { undone: true } });
    });

    it('refuses a turn that is not undone, and while a turn is running', async () => {
      await runMixedTurn();
      await expect(undo.reapplyTurn('conv-1', 'loop-1', { authorize })).rejects.toBeInstanceOf(undo.TurnUndoRefusedError);
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      await changes.beginTurn('conv-1', 'loop-2', WS);
      await expect(undo.reapplyTurn('conv-1', 'loop-1', { authorize })).rejects.toBeInstanceOf(undo.TurnUndoRefusedError);
      expect(workspaceFiles()).toEqual({ 'plan.md': 'one\n', 'old.md': 'gone\n' });
    });

    it('gives the same result after a restart', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      await restart();

      await expect(changes.readTurnIndex('conv-1')).resolves.toMatchObject({ 'loop-1': { restorable: 3, undone: true } });
      await expect(undo.reapplyTurn('conv-1', 'loop-1', { authorize })).resolves.toEqual({ done: 3, notDone: [] });
      expect(workspaceFiles()).toEqual({ 'plan.md': 'two\n', 'new.md': 'n\n' });
    });
  });

  describe('a record rewritten as a whole to point outside the workspace', () => {
    const SENSITIVE = `${HOME}/.ssh/authorized_keys`;
    const ELSEWHERE = `${HOME}/Documents/elsewhere/notes.md`;
    const PAYLOAD = 'payload\n';
    /** The real write check, with the grant the app gives the workspace of a conversation. */
    let writeCheck: import('vitest').Mock<(path: string) => Promise<boolean>>;

    beforeEach(() => {
      authorizeWorkspace(WS);
      writeCheck = vi.fn(async (path: string) => (await checkWritePath(path)).allowed);
    });

    afterEach(() => {
      revokeWorkspace(WS);
    });

    /** Adds an entry for each target that passes every check of the record: path hash, copy and content hash agree. */
    async function pointRecordAt(targets: string[]): Promise<void> {
      const record = fs.readJson<{ entries: unknown[] }>(`${CHANGES}/loop-1/undo.json`);
      for (const target of targets) {
        fs.makeDir(target.slice(0, target.lastIndexOf('/')));
        const hash = await pathHashOf(target);
        fs.write(`${CHANGES}/loop-1/before/${hash}`, PAYLOAD);
        record.entries.push({
          path: target,
          hash,
          before: 'file',
          after: 'absent',
          beforeSha256: await sha256Hex(new TextEncoder().encode(PAYLOAD)),
        });
      }
      fs.write(`${CHANGES}/loop-1/undo.json`, JSON.stringify(record));
    }

    it('lists the entries as not authorized and plans the files of the workspace', async () => {
      await runMixedTurn();
      await pointRecordAt([SENSITIVE, ELSEWHERE]);

      const plan = await undo.planTurnUndo('conv-1', 'loop-1', 'undo', { authorize: writeCheck });

      expect(plan.willRestore.map((file) => file.path)).toEqual([`${WS}/new.md`, `${WS}/old.md`, `${WS}/plan.md`]);
      expect(plan.wontRestore).toEqual([
        { path: SENSITIVE, display: SENSITIVE, reason: 'not-authorized' },
        { path: ELSEWHERE, display: ELSEWHERE, reason: 'not-authorized' },
      ]);
      expect(fs.has(SENSITIVE)).toBe(false);
      expect(fs.has(ELSEWHERE)).toBe(false);
    });

    it('writes nothing to them when the turn is undone, and restores the files of the workspace', async () => {
      await runMixedTurn();
      await pointRecordAt([SENSITIVE, ELSEWHERE]);

      const result = await undo.undoTurn('conv-1', 'loop-1', { authorize: writeCheck });

      expect(result).toEqual({
        done: 3,
        notDone: [
          { path: SENSITIVE, display: SENSITIVE, reason: 'not-authorized' },
          { path: ELSEWHERE, display: ELSEWHERE, reason: 'not-authorized' },
        ],
      });
      expect(writeCheck).toHaveBeenCalledWith(SENSITIVE);
      expect(writeCheck).toHaveBeenCalledWith(ELSEWHERE);
      expect(fs.has(SENSITIVE)).toBe(false);
      expect(fs.has(ELSEWHERE)).toBe(false);
      expect(fs.list(`${HOME}/.ssh/`)).toEqual([]);
      expect(fs.list(`${HOME}/Documents/`)).toEqual([]);
      expect(workspaceFiles()).toEqual({ 'plan.md': 'one\n', 'old.md': 'gone\n' });
    });

    it('writes the content there only for an authorization that allows it, which the write check does not', async () => {
      await runMixedTurn();
      await pointRecordAt([ELSEWHERE]);

      await expect(checkWritePath(ELSEWHERE)).resolves.toMatchObject({ allowed: false, needsPermission: true });
      await undo.undoTurn('conv-1', 'loop-1', { authorize });

      expect(fs.read(ELSEWHERE)).toBe(PAYLOAD);
    });
  });

  describe('copy limit of a conversation', () => {
    it('counts the content kept at the undo in the size of the turn', async () => {
      await runMixedTurn();
      await expect(changes.readTurnIndex('conv-1')).resolves.toMatchObject({ 'loop-1': { copyBytes: 9 } });

      await undo.undoTurn('conv-1', 'loop-1', { authorize });

      await expect(changes.readTurnIndex('conv-1')).resolves.toMatchObject({ 'loop-1': { copyBytes: 15, settledAt: 1 } });
    });

    it('removes the copies of an undone turn like any other, after which it is still undone and cannot be put back', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      changes.__testing.setConversationCopyLimit(10);

      await runTurn('loop-2', async (capture) => {
        await capture(`${WS}/plan.md`);
        fs.write(`${WS}/plan.md`, 'three\n');
      });

      expect(fs.has(`${CHANGES}/loop-1`)).toBe(false);
      const undoneEntry = { total: 3, added: 2, deleted: 2, firstFile: 'new.md', undone: true, undoneCount: 3 };
      const index = await changes.readTurnIndex('conv-1');
      expect(index['loop-1']).toEqual(undoneEntry);
      expect(index['loop-2']).toMatchObject({ restorable: 1 });
      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'reapply', { authorize })).resolves.toEqual({ willRestore: [], wontRestore: [] });
      await expect(undo.reapplyTurn('conv-1', 'loop-1', { authorize })).rejects.toBeInstanceOf(undo.TurnUndoRefusedError);
      expect(workspaceFiles()).toEqual({ 'plan.md': 'three\n', 'old.md': 'gone\n' });

      await restart();
      await expect(changes.readTurnIndex('conv-1')).resolves.toMatchObject({ 'loop-1': undoneEntry });
    });

    it('keeps the name of the one file an undone turn restored when its copies are removed', async () => {
      fs.write(`${WS}/notes.md`, 'one\n');
      await runTurn('loop-1', async (capture) => {
        await capture(`${WS}/notes.md`);
        fs.write(`${WS}/notes.md`, 'two\n');
      });
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      changes.__testing.setConversationCopyLimit(5);

      await runTurn('loop-2', async (capture) => {
        await capture(`${WS}/other.md`);
        fs.write(`${WS}/other.md`, 'x\n');
      });

      await expect(changes.readTurnIndex('conv-1')).resolves.toMatchObject({
        'loop-1': { firstFile: 'notes.md', undone: true, undoneCount: 1, undoneName: 'notes.md' },
      });
    });

    it('leaves a turn whose changes were put back saying it is edited when its copies are removed', async () => {
      await runMixedTurn();
      await undo.undoTurn('conv-1', 'loop-1', { authorize });
      await undo.reapplyTurn('conv-1', 'loop-1', { authorize });
      changes.__testing.setConversationCopyLimit(10);

      await runTurn('loop-2', async (capture) => {
        await capture(`${WS}/plan.md`);
        fs.write(`${WS}/plan.md`, 'three\n');
      });

      await expect(changes.readTurnIndex('conv-1')).resolves.toMatchObject({
        'loop-1': { total: 3, added: 2, deleted: 2, firstFile: 'new.md' },
      });
      expect((await changes.readTurnIndex('conv-1'))['loop-1'].undone).toBeUndefined();
    });
  });

  describe('a conversation that is gone', () => {
    it('reads and writes nothing', async () => {
      await runMixedTurn();
      const disk = new Map(fs.files);
      const reads: string[] = [];
      const readFile = fs.pluginFs.readFile;
      const readTextFile = fs.pluginFs.readTextFile;
      const exists = fs.pluginFs.exists;
      const bridgeRead = fs.bridge.readFile;
      fs.pluginFs.readFile = async (path) => { reads.push(path); return readFile(path); };
      fs.pluginFs.readTextFile = async (path) => { reads.push(path); return readTextFile(path); };
      fs.pluginFs.exists = async (path) => { reads.push(path); return exists(path); };
      fs.bridge.readFile = async (path) => { reads.push(path); return bridgeRead(path); };
      const gone = { authorize, isConversationPresent: () => false };

      await expect(undo.planTurnUndo('conv-1', 'loop-1', 'undo', gone)).resolves.toEqual({ willRestore: [], wontRestore: [] });
      await expect(undo.undoTurn('conv-1', 'loop-1', gone)).resolves.toEqual({ done: 0, notDone: [] });
      await expect(undo.reapplyTurn('conv-1', 'loop-1', gone)).resolves.toEqual({ done: 0, notDone: [] });

      expect(reads).toEqual([]);
      expect([...fs.files.keys()]).toEqual([...disk.keys()]);
      for (const [path, bytes] of disk) expect(fs.files.get(path)).toBe(bytes);
      expect(authorize).not.toHaveBeenCalled();
    });
  });
});
