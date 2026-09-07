/**
 * Downloads on the CHROME EXTENSION channel (batch-三 T6) — what is possible
 * here, and what honestly is not.
 *
 * ## The hard constraint
 *
 * The built-in browser owns its Electron `session`, so it can point a download
 * anywhere on disk (`item.setSavePath`) and suppress the "Save as" window by
 * doing so. This channel drives the user's REAL Chrome through the extension
 * APIs, and `chrome.downloads` deliberately does not offer that:
 *
 *   - `onDeterminingFilename`'s `suggest()` accepts a path RELATIVE to the
 *     browser's own download directory, and Chrome rejects an absolute path,
 *     a `..`, or anything that would escape it. So an extension download
 *     cannot land in Abu's app-data folder; the best available is a
 *     recognizable subfolder of the user's Downloads.
 *   - Whether a "Save as" window appears is the user's own Chrome setting
 *     ("Ask where to save each file"). `suggest()` supplies a name; it does
 *     not turn that setting off, and nothing in an extension can.
 *
 * Both of those are reported as capability facts rather than papered over —
 * the tool result says where the file actually landed, and the two-channel
 * matrix in the task report says the rest. What this module DOES buy is the
 * part that matters most: the file this click produced is identified, its
 * completion is waited for, and one task cannot see another's downloads.
 *
 * ## Ownership
 *
 * `chrome.downloads` is browser-wide: every download the USER starts while a
 * run is going shows up in the same event stream. So a download is attributed
 * the same way the built-in host attributes one — FIFO, to a waiter that
 * registered itself BEFORE the click that should have produced it. A download
 * nobody was waiting for stays unclaimed and is invisible to every task,
 * which is the correct answer for "the user downloaded something themselves".
 *
 * No `chrome.*` access at module scope, so this file stays importable from a
 * plain Node test process — the deps come in.
 */

/** The subset of `chrome.downloads.DownloadItem` this module reads. */
export interface DownloadItemLike {
  id: number;
  url?: string;
  filename?: string;
  state?: string;
  mime?: string;
  totalBytes?: number;
  bytesReceived?: number;
  fileSize?: number;
  error?: string;
}

/** What a download looks like once it belongs to a task. */
export interface OwnedDownload {
  downloadId: string;
  chromeId: number;
  ownerKey: string;
  filename: string;
  url: string;
  state: string;
  time: number;
  path: string;
  size: number;
  mime: string;
  interruptReason?: string;
}

export interface DownloadTrackerDeps {
  now: () => number;
  /** `setTimeout`, injectable so a test does not wait in real seconds. */
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** A short random suffix, injectable for the same reason. */
  randomId: () => string;
}

/** Chrome's terminal states. `in_progress` is the only non-terminal one. */
function isTerminal(state: string | undefined): boolean {
  return state === 'complete' || state === 'interrupted';
}

/**
 * The folder an extension download is steered into, relative to Chrome's own
 * download directory. One level per task, so «A 看不到 B 的文件» is visible on
 * disk too and not only in the tool's answer.
 */
export function suggestedDownloadPath(ownerKey: string, filename: string): string {
  return `Abu/${safeSegment(ownerKey)}/${safeDownloadName(filename)}`;
}

/** Same rule as `safePathSegment` in `electron/browserHost.cjs`. */
export function safeSegment(value: string): string {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 64);
  return cleaned || 'shared';
}

/**
 * The name Abu writes, derived from the one the server suggested.
 *
 * Separators, leading dots, control characters and Windows-reserved
 * punctuation go; non-ASCII stays, because 「排班表.xlsx」 is the normal case
 * and stripping it would leave a folder full of `download`. Mirrors
 * `safeDownloadFileName` in `electron/browserHost.cjs` — the two channels must
 * not name the same export differently.
 */
export function safeDownloadName(raw: string): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return 'download';
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

interface Waiter {
  ownerKey: string;
  claim: (item: OwnedDownload) => void;
}

export interface DownloadTracker {
  /** Register interest BEFORE the click that should start the download. */
  expect(ownerKey: string): { cancel: () => void; claimed: () => OwnedDownload | null;
    wait: (ms: number) => Promise<OwnedDownload | null> };
  /** `chrome.downloads.onCreated`. */
  onCreated(item: DownloadItemLike): OwnedDownload | null;
  /** `chrome.downloads.onChanged`. */
  onChanged(delta: { id: number; state?: { current: string }; filename?: { current: string };
    error?: { current: string }; totalBytes?: { current: number } }): void;
  /** `chrome.downloads.onDeterminingFilename` — returns the suggestion, or
   *  null when this download belongs to nobody (the user's own). */
  suggestFilename(item: DownloadItemLike): string | null;
  /** Everything one task downloaded, newest first. */
  listFor(ownerKey: string): OwnedDownload[];
  /** One download, only if it belongs to this task. */
  find(ownerKey: string, downloadId: string): OwnedDownload | null;
  /** Wait for a download already in flight to reach a terminal state. */
  awaitDone(downloadId: string, ms: number): Promise<void>;
}

const MAX_RECENT = 20;

export function createDownloadTracker(deps: DownloadTrackerDeps): DownloadTracker {
  const recent: OwnedDownload[] = [];
  const byChromeId = new Map<number, OwnedDownload>();
  const byDownloadId = new Map<string, OwnedDownload>();
  const waitersByOwner = new Map<string, Waiter[]>();
  /**
   * chromeId -> the owner that had a waiter when the download was CREATED.
   *
   * `onDeterminingFilename` can fire before or after `onCreated` depending on
   * how the download started, so the claim is recorded on whichever arrives
   * first and read by the other.
   */
  const pendingOwnerByChromeId = new Map<number, string>();
  const doneWaiters = new Map<string, Array<() => void>>();

  const takeWaiter = (ownerKey: string): Waiter | null => {
    const queue = waitersByOwner.get(ownerKey);
    if (!queue || queue.length === 0) return null;
    const waiter = queue.shift() as Waiter;
    if (queue.length === 0) waitersByOwner.delete(ownerKey);
    return waiter;
  };

  /** Which owner (if any) this download is for, taking the waiter if it is
   *  the first of the two Chrome events to ask. */
  const ownerFor = (chromeId: number): string | null => {
    const already = pendingOwnerByChromeId.get(chromeId);
    if (already !== undefined) return already;
    for (const ownerKey of waitersByOwner.keys()) {
      // Exactly one owner may claim, and it is the first with a waiter. There
      // is no way to do better: Chrome does not say which tab started a
      // download, so two tasks downloading in the same instant are told apart
      // by the order they armed, the same rule the built-in host uses.
      pendingOwnerByChromeId.set(chromeId, ownerKey);
      return ownerKey;
    }
    return null;
  };

  const notifyDone = (downloadId: string): void => {
    const list = doneWaiters.get(downloadId);
    if (!list) return;
    doneWaiters.delete(downloadId);
    for (const resolve of list.slice()) resolve();
  };

  return {
    expect(ownerKey) {
      let claimed: OwnedDownload | null = null;
      let onClaim: (() => void) | null = null;
      const waiter: Waiter = {
        ownerKey,
        claim: (item) => {
          claimed = item;
          if (onClaim) onClaim();
        },
      };
      const queue = waitersByOwner.get(ownerKey) ?? [];
      queue.push(waiter);
      waitersByOwner.set(ownerKey, queue);
      const cancel = (): void => {
        const live = waitersByOwner.get(ownerKey);
        if (!live) return;
        const at = live.indexOf(waiter);
        if (at >= 0) live.splice(at, 1);
        if (live.length === 0) waitersByOwner.delete(ownerKey);
      };
      return {
        cancel,
        claimed: () => claimed,
        wait: (ms) => new Promise<OwnedDownload | null>((resolve) => {
          if (claimed) { resolve(claimed); return; }
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            deps.clearTimeout(timer);
            onClaim = null;
            resolve(claimed);
          };
          onClaim = finish;
          const timer = deps.setTimeout(finish, ms);
        }),
      };
    },

    onCreated(item) {
      const ownerKey = ownerFor(item.id);
      if (ownerKey === null) return null;
      const record: OwnedDownload = {
        downloadId: `dl_${deps.now().toString(36)}_${deps.randomId()}`,
        chromeId: item.id,
        ownerKey,
        filename: safeDownloadName(item.filename ?? item.url ?? ''),
        url: item.url ?? '',
        state: item.state ?? 'in_progress',
        time: deps.now(),
        path: item.filename ?? '',
        size: item.totalBytes ?? 0,
        mime: item.mime ?? '',
      };
      recent.unshift(record);
      byChromeId.set(item.id, record);
      byDownloadId.set(record.downloadId, record);
      if (recent.length > MAX_RECENT) {
        for (const dropped of recent.splice(MAX_RECENT)) {
          byChromeId.delete(dropped.chromeId);
          byDownloadId.delete(dropped.downloadId);
        }
      }
      pendingOwnerByChromeId.delete(item.id);
      const waiter = takeWaiter(ownerKey);
      if (waiter) waiter.claim(record);
      if (isTerminal(record.state)) notifyDone(record.downloadId);
      return record;
    },

    onChanged(delta) {
      const record = byChromeId.get(delta.id);
      if (!record) return;
      if (delta.filename?.current) {
        record.path = delta.filename.current;
        record.filename = safeDownloadName(delta.filename.current);
      }
      if (typeof delta.totalBytes?.current === 'number') record.size = delta.totalBytes.current;
      if (delta.error?.current) record.interruptReason = delta.error.current;
      if (delta.state?.current) {
        record.state = delta.state.current;
        if (isTerminal(record.state)) {
          if (record.state === 'interrupted' && !record.interruptReason) {
            record.interruptReason = 'the download was interrupted before it finished';
          }
          notifyDone(record.downloadId);
        }
      }
    },

    suggestFilename(item) {
      const ownerKey = ownerFor(item.id);
      if (ownerKey === null) return null;
      return suggestedDownloadPath(ownerKey, item.filename ?? item.url ?? '');
    },

    listFor(ownerKey) {
      return recent.filter((record) => record.ownerKey === ownerKey);
    },

    find(ownerKey, downloadId) {
      const record = byDownloadId.get(downloadId);
      // Ownership before existence: answering "not yours" and "no such id"
      // differently would let one task probe for another's downloads.
      return record && record.ownerKey === ownerKey ? record : null;
    },

    awaitDone(downloadId, ms) {
      const record = byDownloadId.get(downloadId);
      if (!record || isTerminal(record.state)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          deps.clearTimeout(timer);
          const list = doneWaiters.get(downloadId);
          if (list) {
            const at = list.indexOf(done);
            if (at >= 0) list.splice(at, 1);
          }
          resolve();
        };
        const timer = deps.setTimeout(done, ms);
        const list = doneWaiters.get(downloadId) ?? [];
        list.push(done);
        doneWaiters.set(downloadId, list);
      });
    },
  };
}

/** The tool result both channels return, built from one download record. */
export function downloadResultFor(record: OwnedDownload | null): Record<string, unknown> {
  if (!record) {
    return {
      started: false,
      message: 'That click produced no download. Nothing was saved, and no other file was '
        + 'adopted in its place. Check the page — the export may have opened a dialog, '
        + 'failed, or rendered inline instead of downloading.',
    };
  }
  const done = record.state === 'complete';
  return {
    started: true,
    complete: done,
    download: {
      downloadId: record.downloadId,
      filename: record.filename,
      url: record.url,
      state: record.state,
      time: record.time,
      path: record.path,
      size: record.size,
      mime: record.mime,
      ...(record.interruptReason ? { interruptReason: record.interruptReason } : {}),
    },
    message: done
      ? `Saved to ${record.path}. The file is complete.`
      : record.state === 'in_progress'
        ? 'Still downloading. Call download again with action "wait" and this downloadId; '
          + 'the file is not usable until it reports complete.'
        : `The download did not finish (${record.state}). Nothing usable was saved.`,
  };
}
