/**
 * Undoing what a turn's file tools changed, and putting it back.
 *
 * Both directions read the turn's undo record (`turnUndoRecord.ts`) and check
 * every file against the disk first, and each file again right before its own
 * write: a file is written only while it still holds what the turn (or the
 * undo) left in it, by the SHA-256 of its content.
 * The content a file holds before it is replaced is kept under the turn's
 * `after/` directory, which is what putting the changes back writes.
 *
 * The work runs in the conversation's settle queue, so it never crosses the
 * end of a turn, and it is refused while a turn of the conversation runs.
 */
import { exists, mkdir, readFile, writeFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { exists as fileExists } from '@/core/tools/fsBridge';
import { writeFileAtomic } from '@/utils/atomicFs';
import { getParentDir } from '@/utils/pathUtils';
import { assertConversationId } from './conversationPaths';
import {
  assertLoopId,
  changesDir,
  enqueue,
  ensureRecovered,
  hasOpenTurn,
  loadUndoRecord,
  readCurrentSide,
  readTurnChanges,
  saveUndoRecord,
  turnCopyPath,
  type FileSide,
} from './turnChanges';
import { sha256Hex, type TurnUndoEntry, type TurnUndoRecord } from './turnUndoRecord';

export type TurnUndoDirection = 'undo' | 'reapply';

/**
 * What is done to one file. Undoing writes the content before the turn
 * ('write-before'), moves a file the turn created to the trash ('trash') and
 * writes a file the turn deleted back ('put-back'). Putting back writes the
 * content the turn left ('write-after'), writes a created file back
 * ('put-back') and moves a deleted file to the trash again ('trash').
 */
export type TurnUndoAction = 'write-before' | 'write-after' | 'trash' | 'put-back';

export type TurnUndoSkipReason = 'by-command' | 'changed-since' | 'too-large' | 'folder-gone' | 'not-authorized';

export interface PlannedFile {
  path: string;
  display: string;
  action: TurnUndoAction;
}

export interface SkippedFile {
  path: string;
  display: string;
  reason: TurnUndoSkipReason;
}

export interface TurnUndoPlan {
  willRestore: PlannedFile[];
  wontRestore: SkippedFile[];
}

export interface TurnUndoFailure {
  path: string;
  display: string;
  reason: 'not-authorized' | 'write-failed';
}

export interface TurnUndoResult {
  /** Files that now hold the content this direction gives them. */
  done: number;
  /** Planned files that were not written: the write was not authorized, or it failed. */
  notDone: TurnUndoFailure[];
}

export interface TurnUndoOptions {
  /** Whether `path` may be written now. It only checks. A file it refuses is left as it is. */
  authorize: (path: string) => Promise<boolean>;
  /** Whether the conversation is still there. Nothing is read or written for one that is gone. */
  isConversationPresent?: () => boolean;
}

export type TurnUndoRefusal = 'turn-running' | 'wrong-state' | 'nothing-to-restore';

/** The turn cannot be undone or put back right now. */
export class TurnUndoRefusedError extends Error {
  readonly reason: TurnUndoRefusal;

  constructor(reason: TurnUndoRefusal) {
    super(`Turn undo refused: ${reason}`);
    this.name = 'TurnUndoRefusedError';
    this.reason = reason;
  }
}

interface Step {
  entry: TurnUndoEntry;
  display: string;
  action: TurnUndoAction;
  /** What the path holds while this direction may write it, with the SHA-256 of that content. */
  from: 'file' | 'absent';
  fromHash: string | undefined;
  /** The path already holds the content this direction gives it. */
  inPlace: boolean;
}

/** 'changed': the file no longer holds what this direction starts from, so it is left as it is. */
type FileOutcome = 'done' | 'changed' | 'not-authorized';

interface Assessment {
  steps: Step[];
  skipped: SkippedFile[];
}

const EMPTY_PLAN: TurnUndoPlan = { willRestore: [], wontRestore: [] };
const EMPTY_RESULT: TurnUndoResult = { done: 0, notDone: [] };

function compareDisplay(a: { display: string }, b: { display: string }): number {
  return a.display < b.display ? -1 : a.display > b.display ? 1 : 0;
}

async function holds(current: FileSide, kind: 'file' | 'absent', contentHash: string | undefined): Promise<boolean> {
  if (kind === 'absent') return current.state === 'absent';
  return current.state === 'file' && (await sha256Hex(current.bytes)) === contentHash;
}

function actionOf(direction: TurnUndoDirection, from: 'file' | 'absent', to: 'file' | 'absent'): TurnUndoAction {
  if (to === 'absent') return 'trash';
  if (from === 'absent') return 'put-back';
  return direction === 'undo' ? 'write-before' : 'write-after';
}

/** The side of the record a direction writes: the content before the turn, or the content kept at the undo. */
function targetSide(direction: TurnUndoDirection): 'before' | 'after' {
  return direction === 'undo' ? 'before' : 'after';
}

/**
 * Checks every file of the record against the disk. Undoing considers every
 * entry; putting back considers the entries the undo restored. A file that
 * holds neither what this direction starts from nor what it ends with, and one
 * whose copy is not on disk, is skipped as changed since.
 */
async function assess(
  dir: string,
  record: TurnUndoRecord,
  displays: ReadonlyMap<string, string>,
  direction: TurnUndoDirection,
): Promise<Assessment> {
  const steps: Step[] = [];
  const skipped: SkippedFile[] = [];
  const side = targetSide(direction);
  const entries = direction === 'undo' ? record.entries : record.entries.filter((entry) => entry.last === 'done');
  for (const entry of entries) {
    const display = displays.get(entry.path) ?? entry.path;
    const [from, fromHash, to, toHash] = direction === 'undo'
      ? [entry.after, entry.afterSha256, entry.before, entry.beforeSha256] as const
      : [entry.before, entry.beforeSha256, entry.after, entry.afterSha256] as const;
    if (!(await fileExists(getParentDir(entry.path)))) {
      skipped.push({ path: entry.path, display, reason: 'folder-gone' });
      continue;
    }
    const current = await readCurrentSide(entry.path);
    const action = actionOf(direction, from, to);
    if (await holds(current, to, toHash)) {
      steps.push({ entry, display, action, from, fromHash, inPlace: true });
    } else if (
      !(await holds(current, from, fromHash))
      || (to === 'file' && !(await exists(turnCopyPath(dir, record.loopId, side, entry.hash))))
    ) {
      skipped.push({ path: entry.path, display, reason: 'changed-since' });
    } else {
      steps.push({ entry, display, action, from, fromHash, inPlace: false });
    }
  }
  return { steps: steps.sort(compareDisplay), skipped: skipped.sort(compareDisplay) };
}

function assertState(record: TurnUndoRecord, direction: TurnUndoDirection): void {
  const expected = direction === 'undo' ? 'applied' : 'undone';
  if (record.state !== expected) throw new TurnUndoRefusedError('wrong-state');
}

/**
 * What undoing a turn, or putting its changes back, would do right now. Reads
 * only. A file that would be written and whose write `options.authorize`
 * refuses is listed as not authorized. Undoing also lists the turn's files
 * that have no kept content: the ones a command changed and the ones over the
 * copy size. Rejects with `TurnUndoRefusedError` when the turn is not in the
 * state the direction starts from; a turn without an undo record gives an
 * empty plan.
 */
export async function planTurnUndo(
  conversationId: string,
  loopId: string,
  direction: TurnUndoDirection,
  options: TurnUndoOptions,
): Promise<TurnUndoPlan> {
  assertConversationId(conversationId);
  assertLoopId(loopId);
  const isPresent = options.isConversationPresent ?? (() => true);
  if (!isPresent()) return EMPTY_PLAN;
  await ensureRecovered(conversationId);
  return enqueue(conversationId, async () => {
    if (!isPresent()) return EMPTY_PLAN;
    const dir = await changesDir(conversationId);
    const record = await loadUndoRecord(dir, loopId);
    if (!record) return EMPTY_PLAN;
    assertState(record, direction);
    const files = (await readTurnChanges(conversationId, loopId))?.files ?? [];
    const { steps, skipped } = await assess(dir, record, new Map(files.map((file) => [file.path, file.display])), direction);
    const willRestore: PlannedFile[] = [];
    const wontRestore = [...skipped];
    for (const step of steps) {
      const file = { path: step.entry.path, display: step.display };
      // A file that already holds its content is not written, so its write needs no authorization.
      if (step.inPlace || (await options.authorize(step.entry.path))) willRestore.push({ ...file, action: step.action });
      else wontRestore.push({ ...file, reason: 'not-authorized' });
    }
    if (direction === 'undo') {
      const recorded = new Set(record.entries.map((entry) => entry.path));
      const tooLarge = new Set(record.tooLarge ?? []);
      for (const file of files) {
        if (recorded.has(file.path)) continue;
        wontRestore.push({ path: file.path, display: file.display, reason: tooLarge.has(file.path) ? 'too-large' : 'by-command' });
      }
    }
    return { willRestore, wontRestore: wontRestore.sort(compareDisplay) };
  });
}

/**
 * Gives one file the content of this direction. The file is read again right
 * before its own write, and is left as it is unless it still holds what this
 * direction starts from. The content read then is kept first when undoing; the
 * copy that is written must hold the recorded content. The write publishes
 * the whole content in one step, so a stop halfway leaves the file as it was,
 * and it refuses a file that appeared or went away since that read: a file
 * that was absent is written only as a new file, a file that was there only
 * while it still exists.
 */
async function restoreFile(
  dir: string,
  loopId: string,
  direction: TurnUndoDirection,
  step: Step,
  authorize: TurnUndoOptions['authorize'],
): Promise<FileOutcome> {
  if (step.inPlace) return 'done';
  const { entry } = step;
  if (!(await authorize(entry.path))) return 'not-authorized';
  const current = await readCurrentSide(entry.path);
  if (!(await holds(current, step.from, step.fromHash))) return 'changed';
  if (direction === 'undo' && current.state === 'file') {
    const kept = turnCopyPath(dir, loopId, 'after', entry.hash);
    await mkdir(getParentDir(kept), { recursive: true });
    await writeFile(kept, current.bytes);
  }
  if (step.action === 'trash') {
    await invoke('move_to_trash', { path: entry.path });
    return 'done';
  }
  const side = targetSide(direction);
  const bytes = await readFile(turnCopyPath(dir, loopId, side, entry.hash));
  const recorded = side === 'before' ? entry.beforeSha256 : entry.afterSha256;
  if ((await sha256Hex(bytes)) !== recorded) throw new Error('Turn undo copy does not hold the recorded content');
  await writeFileAtomic(entry.path, bytes, step.from === 'absent' ? 'create' : 'replace');
  return 'done';
}

/** `entry` with `last` as its latest result, or with none. */
function withLast(entry: TurnUndoEntry, last: TurnUndoEntry['last']): TurnUndoEntry {
  return {
    path: entry.path,
    hash: entry.hash,
    before: entry.before,
    after: entry.after,
    ...(entry.beforeSha256 === undefined ? {} : { beforeSha256: entry.beforeSha256 }),
    ...(entry.afterSha256 === undefined ? {} : { afterSha256: entry.afterSha256 }),
    ...(last === undefined ? {} : { last }),
  };
}

async function runTurnUndo(
  conversationId: string,
  loopId: string,
  direction: TurnUndoDirection,
  options: TurnUndoOptions,
): Promise<TurnUndoResult> {
  assertConversationId(conversationId);
  assertLoopId(loopId);
  const isPresent = options.isConversationPresent ?? (() => true);
  if (!isPresent()) return EMPTY_RESULT;
  if (hasOpenTurn(conversationId)) throw new TurnUndoRefusedError('turn-running');
  await ensureRecovered(conversationId);
  return enqueue(conversationId, async () => {
    if (!isPresent()) return EMPTY_RESULT;
    if (hasOpenTurn(conversationId)) throw new TurnUndoRefusedError('turn-running');
    const dir = await changesDir(conversationId);
    const record = await loadUndoRecord(dir, loopId);
    if (!record) throw new TurnUndoRefusedError('nothing-to-restore');
    assertState(record, direction);
    const files = (await readTurnChanges(conversationId, loopId))?.files ?? [];
    const { steps, skipped } = await assess(dir, record, new Map(files.map((file) => [file.path, file.display])), direction);

    const last = new Map<string, TurnUndoEntry['last']>(skipped.map((file) => [file.path, 'skipped']));
    const notDone: TurnUndoFailure[] = [];
    let done = 0;
    for (const step of steps) {
      // One file at a time; a file that fails leaves the others to run.
      const [outcome] = await Promise.allSettled([restoreFile(dir, loopId, direction, step, options.authorize)]);
      if (outcome.status === 'fulfilled' && outcome.value === 'done') {
        done += 1;
        last.set(step.entry.path, 'done');
        continue;
      }
      if (outcome.status === 'fulfilled' && outcome.value === 'changed') {
        last.set(step.entry.path, 'skipped');
        continue;
      }
      last.set(step.entry.path, 'failed');
      notDone.push({
        path: step.entry.path,
        display: step.display,
        reason: outcome.status === 'fulfilled' ? 'not-authorized' : 'write-failed',
      });
    }
    if (done === 0) return { done, notDone };

    await saveUndoRecord(conversationId, dir, {
      ...record,
      state: direction === 'undo' ? 'undone' : 'applied',
      entries: record.entries.map((entry) => withLast(entry, last.get(entry.path))),
    });
    return { done, notDone };
  });
}

/**
 * Restores the files a turn's file tools changed to what they held before the
 * turn. A file changed since the turn is left as it is. The turn counts as
 * undone once at least one file is restored; with none, nothing is recorded.
 * Rejects with `TurnUndoRefusedError` while a turn of the conversation runs,
 * and for a turn that is not there to undo.
 */
export function undoTurn(conversationId: string, loopId: string, options: TurnUndoOptions): Promise<TurnUndoResult> {
  return runTurnUndo(conversationId, loopId, 'undo', options);
}

/**
 * Puts the files an undo restored back to what they held before the undo. A
 * file changed since the undo is left as it is. The turn counts as applied
 * again once at least one file is put back.
 */
export function reapplyTurn(conversationId: string, loopId: string, options: TurnUndoOptions): Promise<TurnUndoResult> {
  return runTurnUndo(conversationId, loopId, 'reapply', options);
}
