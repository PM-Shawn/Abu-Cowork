// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '@/types';
import { normalizeSeparators } from '@/utils/pathUtils';

/**
 * The renderer and the sidecar each load their own copy of
 * `outputSnapshots.ts` and record entries for the same conversation. Every
 * case here loads the module twice, each in its own module registry, over one
 * real directory, so the two copies share the disk and nothing else.
 */
const appDataState = vi.hoisted(() => ({ dir: '' }));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => appDataState.dir,
  homeDir: async () => appDataState.dir,
  tempDir: async () => appDataState.dir,
  resolve: async (...parts: string[]) => parts.join('/'),
  join: async (...parts: string[]) => parts.join('/'),
}));

// The mapping `scripts/build-sidecar.mjs` makes for the real bundle: real node:fs.
vi.mock('@tauri-apps/plugin-fs', async () => await import('./shims/pluginFsRun'));

type SnapshotModule = typeof import('@/core/session/outputSnapshots');
type ShareModule = typeof import('@/core/session/shareBundle');

const CONV_ID = 'conv_two_processes';
const FIXED_TIMESTAMP = 1_700_000_000_000;

function toolOutput(toolCallId: string) {
  return { source: 'tool-output' as const, refId: toolCallId, refKind: 'write_file' };
}

describe('output manifest shared by two processes', () => {
  let root: string;
  let appData: string;
  let userDir: string;
  let renderer: SnapshotModule;
  let rendererShare: ShareModule;
  let sidecar: SnapshotModule;

  beforeEach(async () => {
    root = await nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), 'abu-manifest-two-')));
    appData = join(root, 'appdata');
    userDir = join(root, 'user');
    await nodeFs.mkdir(appData, { recursive: true });
    await nodeFs.mkdir(userDir, { recursive: true });
    appDataState.dir = appData;

    vi.resetModules();
    renderer = await import('@/core/session/outputSnapshots');
    rendererShare = await import('@/core/session/shareBundle');
    vi.resetModules();
    sidecar = await import('@/core/session/outputSnapshots');
  });

  afterEach(async () => {
    await nodeFs.rm(root, { recursive: true, force: true });
  });

  /** Write a user file and return its path with '/' separators, the form the app records. */
  async function userFile(name: string, content: string): Promise<string> {
    const path = join(userDir, name);
    await nodeFs.writeFile(path, content, 'utf-8');
    return normalizeSeparators(path);
  }

  /** What a process that starts now reads from disk. */
  async function keysOnDisk(): Promise<string[]> {
    vi.resetModules();
    const fresh: SnapshotModule = await import('@/core/session/outputSnapshots');
    return (await fresh.listSnapshots(CONV_ID)).map((e) => e.originalPath).sort();
  }

  function logPath(): string {
    return join(appData, 'conversations', CONV_ID, 'outputs', 'manifest-log.jsonl');
  }

  it('the two modules are separate instances', () => {
    expect(renderer).not.toBe(sidecar);
  });

  describe('alternating writers', () => {
    it('keeps every entry when the renderer writes after the sidecar', async () => {
      const a = await userFile('a.md', 'a');
      const b = await userFile('b.md', 'b');
      const c = await userFile('c.md', 'c');

      await renderer.snapshotFile(CONV_ID, a, toolOutput('tc-a'));
      await sidecar.snapshotFile(CONV_ID, b, toolOutput('tc-b'));
      await renderer.snapshotFile(CONV_ID, c, toolOutput('tc-c'));

      expect(await keysOnDisk()).toEqual([a, b, c].sort());
    });
  });

  describe('a read in the renderer after a write in the sidecar', () => {
    it('lists the entry the sidecar recorded', async () => {
      const a = await userFile('a.md', 'a');
      const b = await userFile('b.md', 'b');
      await renderer.snapshotFile(CONV_ID, a, toolOutput('tc-a'));

      await sidecar.snapshotFile(CONV_ID, b, toolOutput('tc-b'));

      const listed = (await renderer.listSnapshots(CONV_ID)).map((e) => e.originalPath).sort();
      expect(listed).toEqual([a, b].sort());
    });

    it('resolves a moved file to the copy the sidecar kept', async () => {
      const a = await userFile('a.md', 'a');
      const b = await userFile('b.md', 'b');
      await renderer.snapshotFile(CONV_ID, a, toolOutput('tc-a'));

      await sidecar.snapshotFile(CONV_ID, b, toolOutput('tc-b'));
      await nodeFs.rm(b);

      const resolved = await renderer.resolveFileSource(CONV_ID, b);
      expect(resolved.status).toBe('available');
    });

    it('exports the file the sidecar recorded as an attachment', async () => {
      const a = await userFile('a.md', 'a');
      const b = await userFile('b.md', 'kept by the sidecar');
      await renderer.snapshotFile(CONV_ID, a, toolOutput('tc-a'));

      await sidecar.snapshotFile(CONV_ID, b, toolOutput('tc-b'));

      const conv = {
        id: CONV_ID,
        title: 'two processes',
        createdAt: FIXED_TIMESTAMP,
        updatedAt: FIXED_TIMESTAMP,
        workspacePath: null,
        messages: [
          { id: 'u1', role: 'user', content: 'write two files', timestamp: FIXED_TIMESTAMP },
          {
            id: 'a1',
            role: 'assistant',
            content: 'done',
            timestamp: FIXED_TIMESTAMP,
            toolCalls: [
              { id: 'tc-a', name: 'write_file', input: { path: a, content: 'a' }, result: 'ok' },
              { id: 'tc-b', name: 'write_file', input: { path: b, content: 'kept by the sidecar' }, result: 'ok' },
            ],
          },
        ],
      } as unknown as Conversation;

      const bundle = await rendererShare.buildShareBundle(conv);
      const attached = Object.values(bundle.attachments ?? {})
        .filter((attachment) => attachment.data)
        .map((attachment) => attachment.basename)
        .sort();
      expect(attached).toEqual(['a.md', 'b.md']);
    });
  });

  describe('writers at the same time', () => {
    it('keeps every entry when both processes record at once', async () => {
      const ours: string[] = [];
      const theirs: string[] = [];
      for (let i = 0; i < 20; i++) {
        ours.push(await userFile(`r${i}.md`, `r${i}`));
        theirs.push(await userFile(`s${i}.md`, `s${i}`));
      }

      await Promise.all([
        ...ours.map((path, i) => renderer.snapshotFile(CONV_ID, path, toolOutput(`tc-r${i}`))),
        ...theirs.map((path, i) => sidecar.snapshotFile(CONV_ID, path, toolOutput(`tc-s${i}`))),
      ]);

      expect(await keysOnDisk()).toEqual([...ours, ...theirs].sort());
    });

    it('reads every complete record after a process died inside an append', async () => {
      const a = await userFile('a.md', 'a');
      const b = await userFile('b.md', 'b');
      await renderer.snapshotFile(CONV_ID, a, toolOutput('tc-a'));
      await nodeFs.appendFile(logPath(), '\n{"op":"set","entry":{"originalPath":"/half', 'utf-8');

      await sidecar.snapshotFile(CONV_ID, b, toolOutput('tc-b'));

      expect(await keysOnDisk()).toEqual([a, b].sort());
    });

    it('keeps its cache valid after a line cut inside a multi-byte character', async () => {
      const first = await userFile('报价单甲.md', 'a');
      await renderer.snapshotFile(CONV_ID, first, toolOutput('tc-a'));
      // A process died after the first byte of the three-byte "报".
      await nodeFs.appendFile(logPath(), Buffer.concat([Buffer.from('\n{"op":"set","entry":{"originalPath":"'), Buffer.from('报').subarray(0, 1)]));
      expect((await renderer.listSnapshots(CONV_ID)).map((e) => e.basename)).toEqual(['报价单甲.md']);

      // Same byte length, different name: only a re-read of the log would see it.
      const log = await nodeFs.readFile(logPath());
      await nodeFs.writeFile(logPath(), Buffer.from(log.toString('latin1').replace('tc-a', 'tc-z'), 'latin1'));

      expect((await renderer.listSnapshots(CONV_ID)).map((e) => e.refId)).toEqual(['tc-a']);
    });
  });
});
