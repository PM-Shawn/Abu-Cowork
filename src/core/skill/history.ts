/**
 * Skill modification history — append-only log per skill.
 *
 * Goal: let users see what an AI agent changed in a skill and revert
 * with one click. Non-technical users (Abu's main audience) can't fall
 * back to git — this module provides the product-level audit trail.
 *
 * Storage model
 * -------------
 *   <skillDir>/
 *     .history/
 *       index.jsonl              # append-only log of HistoryEntry
 *       tombstones/              # copies of files before remove/delete
 *         <ts>-<sanitized-path>
 *     .SKILL.md.backup.<ts>       # already written by atomicWriteWithBackup
 *     scripts/.helper.sh.backup.<ts>
 *     …
 *
 * The backup files already exist — every skill_manage(patch|edit|
 * write_file) call goes through `atomicWriteWithBackup` and leaves a
 * timestamped backup alongside the target file. `cleanupOldBackups`
 * has never been wired in production, so those backups accumulate
 * indefinitely. We piggyback on them: the backupPath returned by
 * atomicWriteWithBackup is recorded in our JSONL entry as a snapshot
 * pointer. No duplicate storage.
 *
 * For `remove_file` the file is about to disappear — no backup gets
 * written — so the caller must first call `writeTombstone` to stash
 * the pre-remove content. Same pattern for the future if we ever want
 * to track full-skill deletes (MVP: workspace-auto deletes destroy
 * history too; draft deletes go through drafts trash which already
 * preserves history inside the moved directory).
 *
 * Turn grouping
 * -------------
 * `turnId` is per-mutation, not per-agent-loop: if an agent calls
 * skill_manage twice in one loop, each call gets its own entry. This
 * costs a bit of UX fidelity (user sees 2 entries not 1 grouped) but
 * keeps the implementation pragmatic — the agent-loop loopId isn't
 * currently threaded through ToolExecutionContext, and migrating it
 * would balloon this module's scope.
 */

import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
  remove,
} from '@tauri-apps/plugin-fs';

import { atomicWrite, restoreFromBackup } from '../../utils/atomicFs';
import { joinPath } from '../../utils/pathUtils';

// ── Types ──────────────────────────────────────────────────────────────

export type HistoryOp =
  | 'edit'
  | 'patch'
  | 'write_file'
  | 'remove_file'
  | 'revert';

export type HistoryFileAction = 'modified' | 'created' | 'removed';

export interface HistoryFileChange {
  /** File path relative to the skill directory. */
  relPath: string;
  /**
   * Absolute path to a file that can restore the *prior* content.
   * - 'modified' → the `.backup.{ts}` file atomicWriteWithBackup wrote
   * - 'removed'  → the tombstone path from writeTombstone
   * - 'created'  → null (to revert a create, we just delete the file)
   */
  snapshotPath: string | null;
  action: HistoryFileAction;
}

export interface HistoryEntry {
  turnId: string;
  ts: number;
  op: HistoryOp;
  files: HistoryFileChange[];
  /** Short human-readable summary ("replaced step 3", strategy name, etc.). */
  summary?: string;
  /** For op='revert' only — points to the turnId that was rolled back. */
  revertedTurnId?: string;
}

// ── Path helpers ───────────────────────────────────────────────────────

function getHistoryDir(skillDir: string): string {
  return joinPath(skillDir, '.history');
}

function getIndexPath(skillDir: string): string {
  return joinPath(getHistoryDir(skillDir), 'index.jsonl');
}

function getTombstoneDir(skillDir: string): string {
  return joinPath(getHistoryDir(skillDir), 'tombstones');
}

/**
 * Generate a filesystem-safe tombstone filename from a relPath. A
 * relPath like `scripts/build.sh` becomes `<ts>-scripts__build.sh` so
 * it lives flat under tombstones/ instead of recreating subdirs.
 * (Subdirs would work too, but this keeps cleanup / browsing simpler.)
 */
function tombstoneFilename(ts: number, relPath: string): string {
  const safe = relPath.replace(/\//g, '__');
  return `${ts}-${safe}`;
}

/** Short, URL-safe turn ID. Not security-sensitive; dedup is nice-to-have. */
export function newTurnId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Read / Write ───────────────────────────────────────────────────────

/**
 * Append an entry to the history log. Creates .history/ on demand.
 * JSONL format: one entry per line. `ts` is filled in if absent.
 */
export async function appendHistoryEntry(
  skillDir: string,
  entry: Omit<HistoryEntry, 'ts'> & { ts?: number },
): Promise<void> {
  const historyDir = getHistoryDir(skillDir);
  if (!(await exists(historyDir).catch(() => false))) {
    await mkdir(historyDir, { recursive: true });
  }
  const full: HistoryEntry = { ...entry, ts: entry.ts ?? Date.now() };
  const line = JSON.stringify(full) + '\n';

  const indexPath = getIndexPath(skillDir);
  let existing = '';
  if (await exists(indexPath).catch(() => false)) {
    existing = await readTextFile(indexPath).catch(() => '');
  }
  // writeTextFile is atomic on the Tauri side (write-then-rename on
  // supported platforms); we pay a full-file rewrite per append but
  // history is <100 lines typically so perf isn't a concern.
  await writeTextFile(indexPath, existing + line);
}

/**
 * Read all history entries for a skill, newest first. Returns [] if no
 * history exists or the index file can't be read.
 *
 * Resilient to corruption: if a line fails to parse, skip it silently
 * instead of throwing. A single bad line from a mid-write crash must
 * not blind the rest of the log.
 */
export async function readHistory(skillDir: string): Promise<HistoryEntry[]> {
  const indexPath = getIndexPath(skillDir);
  if (!(await exists(indexPath).catch(() => false))) return [];

  const raw = await readTextFile(indexPath).catch(() => '');
  if (!raw) return [];

  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as HistoryEntry;
      // Minimal shape check — if critical fields are missing we'd rather
      // drop the row than let a malformed entry crash the UI later.
      if (parsed.turnId && typeof parsed.ts === 'number' && Array.isArray(parsed.files)) {
        entries.push(parsed);
      }
    } catch {
      /* skip malformed line */
    }
  }
  // Newest first — matches typical UI rendering order.
  entries.sort((a, b) => b.ts - a.ts);
  return entries;
}

/**
 * Tombstone the current content of a file before the caller removes it.
 * Used by `remove_file` so revert can restore the deleted file. Returns
 * the absolute tombstone path (caller records it in the history entry).
 *
 * If the source file doesn't exist, returns null — nothing to tombstone.
 */
export async function writeTombstone(
  skillDir: string,
  relPath: string,
  ts: number = Date.now(),
): Promise<string | null> {
  const sourcePath = joinPath(skillDir, relPath);
  if (!(await exists(sourcePath).catch(() => false))) return null;

  const content = await readTextFile(sourcePath).catch(() => null);
  if (content === null) return null;

  const tombstoneDir = getTombstoneDir(skillDir);
  if (!(await exists(tombstoneDir).catch(() => false))) {
    await mkdir(tombstoneDir, { recursive: true });
  }
  const tombstonePath = joinPath(tombstoneDir, tombstoneFilename(ts, relPath));
  await atomicWrite(tombstonePath, content);
  return tombstonePath;
}

// ── Revert ─────────────────────────────────────────────────────────────

export interface RevertResult {
  ok: boolean;
  restored: number;
  failed: Array<{ relPath: string; reason: string }>;
}

/**
 * Restore every file in a given turn to its pre-turn state.
 *
 * - `modified` files → `restoreFromBackup(target, snapshotPath)` (backup
 *   from atomicWriteWithBackup is consumed in the process)
 * - `created` files → remove them (no prior state to restore)
 * - `removed` files → tombstone is copied back; we then delete the
 *   tombstone so re-reverts from the same entry fail cleanly instead
 *   of silently re-restoring (a re-revert is the user saying "hm wait,
 *   redo the undo" which is a separate product decision we don't want
 *   to silently support in MVP)
 *
 * Best-effort: individual file failures are collected and returned in
 * `failed`; as long as any file restored, `ok=true`. Records a new
 * history entry (op='revert') so the audit trail is append-only and
 * the revert itself is visible in the list.
 */
export async function revertTurn(
  skillDir: string,
  turnId: string,
): Promise<RevertResult> {
  const history = await readHistory(skillDir);
  const entry = history.find((e) => e.turnId === turnId);
  if (!entry) {
    return { ok: false, restored: 0, failed: [{ relPath: '-', reason: 'turn not found' }] };
  }

  const failed: RevertResult['failed'] = [];
  let restored = 0;

  for (const change of entry.files) {
    const targetPath = joinPath(skillDir, change.relPath);
    try {
      if (change.action === 'modified') {
        if (!change.snapshotPath) {
          failed.push({ relPath: change.relPath, reason: 'snapshot missing' });
          continue;
        }
        if (!(await exists(change.snapshotPath).catch(() => false))) {
          failed.push({ relPath: change.relPath, reason: 'backup file no longer exists' });
          continue;
        }
        await restoreFromBackup(targetPath, change.snapshotPath);
        restored++;
      } else if (change.action === 'created') {
        // Revert of a create = delete the file. If it's already gone,
        // count that as "restored" — end state matches intent.
        if (await exists(targetPath).catch(() => false)) {
          await remove(targetPath).catch(() => {});
        }
        restored++;
      } else if (change.action === 'removed') {
        if (!change.snapshotPath) {
          failed.push({ relPath: change.relPath, reason: 'tombstone missing' });
          continue;
        }
        if (!(await exists(change.snapshotPath).catch(() => false))) {
          failed.push({ relPath: change.relPath, reason: 'tombstone no longer exists' });
          continue;
        }
        const content = await readTextFile(change.snapshotPath);
        await atomicWrite(targetPath, content);
        // Consume the tombstone — prevents the same entry from being
        // reverted twice against itself.
        await remove(change.snapshotPath).catch(() => {});
        restored++;
      }
    } catch (err) {
      failed.push({
        relPath: change.relPath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Audit: record the revert itself. Entries are immutable, so the
  // original turn stays in the log; the revert shows up as its own
  // row pointing at what it undid.
  await appendHistoryEntry(skillDir, {
    turnId: newTurnId(),
    op: 'revert',
    files: entry.files.map((f) => ({
      relPath: f.relPath,
      snapshotPath: null, // reverts don't have their own snapshots
      action: f.action,
    })),
    summary: `Reverted turn ${turnId}`,
    revertedTurnId: turnId,
  }).catch(() => {
    /* best-effort audit — revert already succeeded on disk */
  });

  return { ok: restored > 0 || failed.length === 0, restored, failed };
}
