/**
 * Atomic file writes with optional backup + rollback.
 *
 * Thin TS wrapper over the `atomic_write` Tauri module. All writes use a
 * tempfile + rename sequence so the target file is never left in a
 * half-written state, even on crash or kill. See `src-tauri/src/atomic_write.rs`
 * for the OS-level guarantees.
 *
 * Scope: used by memdir writes and (future) skill_manage. Other `writeTextFile`
 * call sites intentionally kept as-is to limit blast radius.
 */

import { invoke } from '@tauri-apps/api/core';
import { invokeTextCommand } from '@/core/ipc/rawBodyInvoke';

/** Result of an atomic write with backup. */
export interface AtomicWriteResult {
  /** True on successful write. */
  wrote: boolean;
  /**
   * Absolute path to the backup of the previous content, or null if the
   * target didn't exist (nothing to back up). Caller should either consume
   * via `restoreFromBackup` on failure or leave it for the TTL sweeper.
   */
  backupPath: string | null;
}

/** Shape returned by the Rust side. Names stay snake_case at the boundary. */
interface RawAtomicWriteResult {
  wrote: boolean;
  backup_path: string | null;
}

/**
 * Write `content` to `path` atomically. Parent dirs are created as needed.
 * Overwrites any existing file at `path`.
 *
 * @throws If the write fails at any stage. The target is untouched on failure.
 */
export async function atomicWrite(path: string, content: string): Promise<void> {
  // #549: conversation-sized content travels on the 128 MiB raw-body channel
  // in the Electron renderer; elsewhere (incl. the sidecar shim) the plain form.
  await invokeTextCommand('atomic_write_text', { path }, content);
}

/**
 * Like `atomicWrite`, but copies any existing file to a timestamped backup
 * first. The backup lives alongside the target as `.{filename}.backup.{ts}`.
 *
 * Intended for "write then validate" flows: write with backup, validate the
 * new content, call `restoreFromBackup` if validation fails.
 *
 * @returns `{ wrote, backupPath }` — `backupPath` is null when no prior file existed.
 * @throws If the write fails. The original file is untouched.
 */
export async function atomicWriteWithBackup(
  path: string,
  content: string,
): Promise<AtomicWriteResult> {
  const raw = await invoke<RawAtomicWriteResult>('atomic_write_with_backup', {
    path,
    content,
  });
  return { wrote: raw.wrote, backupPath: raw.backup_path };
}

/**
 * Restore `target` from a `backup` path previously returned by
 * `atomicWriteWithBackup`. The backup is consumed (renamed away) on success,
 * so callers shouldn't delete it afterward.
 *
 * @throws If the backup doesn't exist or the rename/copy fails.
 */
export async function restoreFromBackup(
  target: string,
  backup: string,
): Promise<void> {
  await invoke<void>('restore_from_backup', { target, backup });
}

/**
 * Remove backup files in `dir` older than `ttlHours`. Only files matching the
 * pattern `.*.backup.*` are touched, so user files are never accidentally
 * removed. Safe to call on non-existent directories (silent zero).
 *
 * @returns Count of files removed.
 */
export async function cleanupOldBackups(
  dir: string,
  ttlHours: number,
): Promise<number> {
  return await invoke<number>('cleanup_old_backups', { dir, ttlHours });
}
