/**
 * File access for a conversation writer that runs in the sidecar, with the
 * write guarantees the Electron main process gives the renderer
 * (`electron/fsHost.cjs`):
 *   - append: `O_APPEND`, so the kernel places every write at the end — never
 *     a size read followed by a positional write. Not atomic, not fsynced.
 *   - atomic write: exclusive random temp file beside the target, write, fsync,
 *     rename, then fsync of the directory so the rename itself survives a power
 *     loss. The directory fsync is skipped on Windows, which has no such
 *     operation, and tolerates the errnos filesystems without it answer — the
 *     list `electron/pluginLease.cjs` uses.
 *   - the final component is never followed: appends, reads and temp files
 *     open with `O_NOFOLLOW` where the platform has it, and a rename replaces
 *     the directory entry. Where it does not (Windows) the entry is inspected
 *     with `lstat` before the open.
 *   - `canonicalPath` resolves every existing component through the filesystem
 *     and keeps a missing tail as written, the way `canonicalizeForScope` does,
 *     so the writer can contain a conversation directory that its first write
 *     is about to create. A link that resolves nowhere is an error, never a
 *     missing path.
 * The sidecar's `node:fs` calls pass no scope check, so which paths reach this
 * adapter is decided by the writer (`conversationPaths.ts`, containment).
 */
import { constants as fsConstants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ConversationFsPrimitives } from '@/core/session/conversationWriter';
import { exists, mkdir, readDir, remove, stat } from './shims/pluginFsRun';

/** errno values a directory fsync may fail with on a filesystem that has no such operation. */
export const TOLERATED_DIRECTORY_FSYNC_ERRNOS: readonly string[] = [
  'EINVAL',
  'EPERM',
  'EACCES',
  'EBADF',
  'EISDIR',
  'ENOTSUP',
];

export interface NodeConversationFsIo {
  /** Injected so a test can make the directory fsync fail. Defaults to `node:fs/promises`' `open`. */
  open: typeof nodeFs.open;
  platform: NodeJS.Platform;
}

/**
 * `O_NOFOLLOW` where the platform has it. Windows has neither the flag nor a
 * no-follow open, so it is zero there and the `lstat` check below stands in.
 */
function noFollowFlagFor(platform: NodeJS.Platform): number {
  if (platform === 'win32') return 0;
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

export function createNodeConversationFs(overrides: Partial<NodeConversationFsIo> = {}): ConversationFsPrimitives & {
  canonicalPath(path: string): Promise<string>;
} {
  const io: NodeConversationFsIo = { open: nodeFs.open, platform: process.platform, ...overrides };
  const noFollow = noFollowFlagFor(io.platform);

  /** Without `O_NOFOLLOW` the entry is inspected first; a link is refused the way the flag would refuse it. */
  async function refuseLinkWithoutNoFollow(target: string): Promise<void> {
    if (noFollow !== 0) return;
    let info;
    try {
      info = await nodeFs.lstat(target);
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') return;
      throw err;
    }
    if (info.isSymbolicLink()) {
      throw Object.assign(new Error(`ELOOP: refusing to follow a link: ${target}`), { code: 'ELOOP' });
    }
  }

  async function syncDirectory(dir: string): Promise<void> {
    if (io.platform === 'win32') return;
    let handle: nodeFs.FileHandle | undefined;
    try {
      handle = await io.open(dir, 'r');
      await handle.sync();
    } catch (err) {
      if (!TOLERATED_DIRECTORY_FSYNC_ERRNOS.includes(errnoOf(err) ?? '')) throw err;
    } finally {
      await handle?.close();
    }
  }

  async function openExclusiveSibling(parent: string, prefix: string): Promise<{ path: string; handle: nodeFs.FileHandle }> {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = path.join(parent, `${prefix}.${randomBytes(16).toString('hex')}`);
      try {
        return { path: candidate, handle: await io.open(candidate, flags, 0o600) };
      } catch (err) {
        if (errnoOf(err) !== 'EEXIST') throw err;
      }
    }
    throw new Error(`conversation fs: could not create an exclusive temporary file in ${parent}`);
  }

  return {
    exists: (p) => exists(p),
    mkdir: (p, options) => mkdir(p, options),
    remove: (p, options) => remove(p, options),
    readDir: async (p) => (await readDir(p)).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory })),
    stat: async (p) => ({ size: (await stat(p)).size }),

    async readTextFile(target) {
      await refuseLinkWithoutNoFollow(target);
      const handle = await io.open(target, fsConstants.O_RDONLY | noFollow);
      try {
        return await handle.readFile('utf-8');
      } finally {
        await handle.close();
      }
    },

    async appendText(target, data) {
      await nodeFs.mkdir(path.dirname(target), { recursive: true });
      await refuseLinkWithoutNoFollow(target);
      const handle = await io.open(
        target,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollow,
        0o666,
      );
      try {
        await handle.writeFile(data, 'utf-8');
      } finally {
        await handle.close();
      }
    },

    async atomicWriteText(target, content) {
      const parent = path.dirname(target);
      await nodeFs.mkdir(parent, { recursive: true });
      // Random + O_EXCL prevents a pre-seeded symlink from redirecting the write.
      const temp = await openExclusiveSibling(parent, `.${path.basename(target)}.tmp.${process.pid}`);
      let open: nodeFs.FileHandle | undefined = temp.handle;
      try {
        await open.writeFile(content, 'utf-8');
        await open.sync(); // durable before the rename
        await open.close();
        open = undefined;
        await nodeFs.rename(temp.path, target);
      } catch (err) {
        // Cleanup must not replace the error that brought us here.
        try {
          await open?.close();
        } catch {
          /* already closed */
        }
        try {
          await nodeFs.rm(temp.path, { force: true });
        } catch {
          /* temp may not exist */
        }
        throw err;
      }
      await syncDirectory(parent);
    },

    async canonicalPath(target) {
      let cursor = path.resolve(target);
      const missingTail: string[] = [];
      for (;;) {
        let present = false;
        try {
          await nodeFs.lstat(cursor);
          present = true;
        } catch (err) {
          if (errnoOf(err) !== 'ENOENT' && errnoOf(err) !== 'ENOTDIR') throw err;
        }
        if (present) {
          let real: string;
          try {
            real = await nodeFs.realpath(cursor);
          } catch (err) {
            throw new Error(
              `conversation fs: cannot resolve path safely (dangling or inaccessible link): ${cursor}: ${
                err instanceof Error ? err.message : String(err)
              }`,
              { cause: err },
            );
          }
          return path.resolve(real, ...missingTail);
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          throw new Error(`conversation fs: cannot resolve an existing ancestor for path: ${target}`);
        }
        missingTail.unshift(path.basename(cursor));
        cursor = parent;
      }
    },
  };
}
