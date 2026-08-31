/**
 * Generic atomic directory install primitive.
 *
 * Shared by skill / agent / plugin installers: build the new directory
 * contents in a staging dir, then swap it into place. Any failure —
 * during the write, or during the staging→target rename — rolls back to
 * exactly the state before the call: the caller never observes a partial
 * target, and an existing target is never lost.
 */

import { mkdir, exists, remove, rename } from '@tauri-apps/plugin-fs';
import { joinPath, getBaseName, getParentDir } from '@/utils/pathUtils';

export interface AtomicInstallOptions {
  /** Final destination directory. */
  targetDir: string;
  /** Write content into the given staging directory. Throwing aborts the install. */
  write: (stagingDir: string) => Promise<void>;
  /** Parent directory for the staging/backup dirs. Defaults to the parent of targetDir. */
  workDir?: string;
}

/**
 * Install a directory atomically: stage → (back up any existing target) → swap in → clean up.
 * Any failure at any step rolls back to the pre-call state.
 *
 * The staging/backup dir names are derived from `targetDir`'s basename plus a
 * per-call unique suffix, so concurrent installs of the same target never collide
 * on a staging path, and the staging dir is never a same-name collision with the
 * default `workDir` (the target's own parent).
 */
export async function atomicInstallDir(opts: AtomicInstallOptions): Promise<void> {
  const { targetDir, write } = opts;
  const targetName = getBaseName(targetDir);
  const parentDir = getParentDir(targetDir);
  const workDir = opts.workDir ?? parentDir;

  const suffix = uniqueSuffix();
  const stagingDir = joinPath(workDir, `${targetName}.${suffix}`);
  const backupDir = joinPath(workDir, `__backup__${targetName}.${suffix}`);

  try {
    // Defensive: clear any stale staging dir left over from a previous crashed
    // install that happened to reuse this exact suffix (astronomically unlikely,
    // but keeps the precondition "staging starts empty" always true).
    if (await exists(stagingDir)) {
      await remove(stagingDir, { recursive: true });
    }

    await write(stagingDir);

    await mkdir(parentDir, { recursive: true });

    // Move any existing target aside so a failed swap can be rolled back.
    const hadExisting = await exists(targetDir);
    if (hadExisting) {
      if (await exists(backupDir)) await remove(backupDir, { recursive: true });
      await rename(targetDir, backupDir);
    }
    try {
      await rename(stagingDir, targetDir);
    } catch (swapErr) {
      // Restore the original so the caller never ends up with nothing.
      if (hadExisting) {
        try {
          await rename(backupDir, targetDir);
        } catch {
          /* best-effort restore */
        }
      }
      throw swapErr;
    }
    // Swap succeeded — drop the backup.
    if (hadExisting) {
      try {
        await remove(backupDir, { recursive: true });
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    // Roll back the staging dir so nothing partial is left behind.
    try {
      await remove(stagingDir, { recursive: true });
    } catch {
      /* best-effort cleanup — staging may not exist yet */
    }
    throw err;
  }
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
