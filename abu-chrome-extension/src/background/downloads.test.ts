/**
 * Downloads on the Chrome-extension channel (T6).
 *
 * Two claims are under test and they are not the same claim:
 *
 *  1. **Attribution.** `chrome.downloads` is browser-wide — the user's own
 *     downloads arrive on the same event stream as the ones Abu asked for. A
 *     download belongs to a task only if that task armed a waiter BEFORE the
 *     click, and a download nobody armed for belongs to nobody at all. Before
 *     T6 `get_downloads` answered with the last 20 downloads Chrome had seen,
 *     whoever started them.
 *  2. **Naming.** The suggested filename is derived, never accepted: it comes
 *     from a `Content-Disposition` header, which is attacker-controlled.
 *
 * Time is injected, so the waits below are exact rather than slept through.
 */
import { describe, expect, it } from 'vitest';
import {
  createDownloadTracker,
  downloadResultFor,
  safeDownloadName,
  safeSegment,
  suggestedDownloadPath,
  type DownloadTracker,
  type DownloadTrackerDeps,
} from './downloads';

/** A clock whose timers only fire when a test says so. */
function fakeDeps(): DownloadTrackerDeps & { fireAll: () => void; pending: () => number } {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    now: () => 1_700_000_000_000,
    setTimeout: (fn: () => void) => {
      const handle = ++seq;
      timers.set(handle, fn);
      return handle;
    },
    clearTimeout: (handle: unknown) => { timers.delete(handle as number); },
    randomId: () => `r${++seq}`,
    fireAll: () => {
      for (const [handle, fn] of [...timers]) {
        timers.delete(handle);
        fn();
      }
    },
    pending: () => timers.size,
  };
}

const A = 'conv-a';
const B = 'conv-b';

function created(tracker: DownloadTracker, id: number, filename = '/Users/me/Downloads/report.xlsx') {
  return tracker.onCreated({ id, filename, url: 'https://x.example/report.xlsx', state: 'in_progress' });
}

describe('safeDownloadName', () => {
  it('keeps a Chinese name — 排班表.xlsx is the normal case, not an edge one', () => {
    expect(safeDownloadName('排班表.xlsx')).toBe('排班表.xlsx');
  });

  it('takes the last component of a path the server tried to smuggle in', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('passwd');
    expect(safeDownloadName('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
  });

  it('replaces the Windows-reserved punctuation rather than producing an unwritable name', () => {
    expect(safeDownloadName('a:b*c?d"e<f>g|h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
  });

  it('strips control characters, which no file name legitimately carries', () => {
    expect(safeDownloadName('rep\u0000ort\u001f.xlsx')).toBe('report.xlsx');
  });

  it('drops leading dots so a download cannot become a hidden dotfile', () => {
    expect(safeDownloadName('...bashrc')).toBe('bashrc');
  });

  it('falls back to a readable name when nothing survives', () => {
    expect(safeDownloadName('')).toBe('download');
    expect(safeDownloadName('///')).toBe('download');
  });

  it('caps an absurdly long name', () => {
    expect(safeDownloadName(`${'x'.repeat(400)}.zip`)).toHaveLength(120);
  });
});

describe('safeSegment / suggestedDownloadPath', () => {
  /**
   * A separator is what a traversal needs, and there is none left: `.` is kept
   * (it is ordinary in a name) but every `/`, `\` and `:` becomes `_`, so the
   * result is one directory whose name merely contains dots.
   */
  it('reduces an owner key to one writable path segment with no separator left in it', () => {
    const segment = safeSegment('conv-a::run/../../b');
    expect(segment).toBe('conv-a__run_.._.._b');
    expect(segment).not.toMatch(/[\\/:]/);
  });

  it('never yields an empty segment, or one that IS a parent reference', () => {
    expect(safeSegment('')).toBe('shared');
    expect(safeSegment('...')).toBe('shared');
    expect(safeSegment('..')).toBe('shared');
  });

  /**
   * `suggest()` takes a path RELATIVE to Chrome's own download directory and
   * refuses anything that escapes it. This is the furthest an extension can
   * go, and the shape is what keeps two tasks' exports apart on disk.
   */
  it('files a download under Abu/<task>/ inside the browser download directory', () => {
    expect(suggestedDownloadPath(A, '/tmp/排班表.xlsx')).toBe('Abu/conv-a/排班表.xlsx');
  });

  it('cannot be talked out of that folder by a traversing filename', () => {
    expect(suggestedDownloadPath(A, '../../../../evil.exe')).toBe('Abu/conv-a/evil.exe');
  });
});

describe('attribution', () => {
  it('gives a download to the task that armed a waiter before the click', () => {
    const tracker = createDownloadTracker(fakeDeps());
    const expectation = tracker.expect(A);
    const record = created(tracker, 1);

    expect(record?.ownerKey).toBe(A);
    expect(expectation.claimed()).toBe(record);
  });

  /**
   * The user's own downloads. Renaming or filing THOSE because an extension
   * happens to be installed would be a bug that shows up in somebody's
   * Downloads folder.
   */
  it('attributes a download nobody was waiting for to nobody, and leaves its name alone', () => {
    const tracker = createDownloadTracker(fakeDeps());
    expect(created(tracker, 1)).toBeNull();
    expect(tracker.suggestFilename({ id: 2, filename: 'mine.pdf' })).toBeNull();
    expect(tracker.listFor(A)).toEqual([]);
    expect(tracker.listFor('')).toEqual([]);
  });

  it('claims in arm order when one task fires two downloads', () => {
    const tracker = createDownloadTracker(fakeDeps());
    const first = tracker.expect(A);
    const second = tracker.expect(A);

    created(tracker, 1, '/d/one.csv');
    created(tracker, 2, '/d/two.csv');

    expect(first.claimed()?.filename).toBe('one.csv');
    expect(second.claimed()?.filename).toBe('two.csv');
  });

  it('does not let one task see, wait on, or name another task\'s download', () => {
    const tracker = createDownloadTracker(fakeDeps());
    tracker.expect(A);
    const record = created(tracker, 1);

    expect(tracker.listFor(B)).toEqual([]);
    expect(tracker.find(B, record!.downloadId)).toBeNull();
    // Ownership before existence: "not yours" and "no such id" answer the same
    // way, or one task could probe for another's downloads.
    expect(tracker.find(B, 'dl_nope')).toBeNull();
    expect(tracker.find(A, record!.downloadId)).toBe(record);
  });

  it('forgets a cancelled expectation instead of letting it claim a later download', () => {
    const tracker = createDownloadTracker(fakeDeps());
    const expectation = tracker.expect(A);
    expectation.cancel();

    expect(created(tracker, 1)).toBeNull();
    expect(expectation.claimed()).toBeNull();
  });

  it('files the download under the owner that armed it, once, and stops answering for the next one', () => {
    const tracker = createDownloadTracker(fakeDeps());
    tracker.expect(A);
    expect(tracker.suggestFilename({ id: 1, filename: 'a.csv' })).toBe('Abu/conv-a/a.csv');
    created(tracker, 1, '/d/a.csv');
    // The waiter has been consumed; a second download is unowned again.
    expect(tracker.suggestFilename({ id: 2, filename: 'b.csv' })).toBeNull();
  });

  it('keeps only the most recent downloads and forgets the ids it dropped', () => {
    const tracker = createDownloadTracker(fakeDeps());
    const ids: string[] = [];
    for (let i = 1; i <= 22; i += 1) {
      tracker.expect(A);
      ids.push(created(tracker, i, `/d/${i}.csv`)!.downloadId);
    }
    expect(tracker.listFor(A)).toHaveLength(20);
    expect(tracker.find(A, ids[0])).toBeNull();
    expect(tracker.find(A, ids[21])).not.toBeNull();
  });
});

describe('lifecycle', () => {
  it('follows the real path and size Chrome settles on', () => {
    const tracker = createDownloadTracker(fakeDeps());
    tracker.expect(A);
    const record = created(tracker, 1, '');

    tracker.onChanged({
      id: 1,
      filename: { current: '/Users/me/Downloads/Abu/conv-a/排班表.xlsx' },
      totalBytes: { current: 4096 },
      state: { current: 'complete' },
    });

    expect(record).toMatchObject({
      state: 'complete',
      filename: '排班表.xlsx',
      path: '/Users/me/Downloads/Abu/conv-a/排班表.xlsx',
      size: 4096,
    });
  });

  it('reports an interruption as an interruption, with a readable reason', () => {
    const tracker = createDownloadTracker(fakeDeps());
    tracker.expect(A);
    const record = created(tracker, 1);

    tracker.onChanged({ id: 1, state: { current: 'interrupted' } });

    expect(record!.state).toBe('interrupted');
    expect(downloadResultFor(record)).toMatchObject({ started: true, complete: false });
    expect(downloadResultFor(record).message).toContain('did not finish');
  });

  it('prefers Chrome\'s own error string when it gives one', () => {
    const tracker = createDownloadTracker(fakeDeps());
    tracker.expect(A);
    const record = created(tracker, 1);

    tracker.onChanged({ id: 1, error: { current: 'SERVER_FORBIDDEN' }, state: { current: 'interrupted' } });

    expect(record!.interruptReason).toBe('SERVER_FORBIDDEN');
  });

  it('ignores a change for a download it does not own', () => {
    const tracker = createDownloadTracker(fakeDeps());
    expect(() => tracker.onChanged({ id: 99, state: { current: 'complete' } })).not.toThrow();
  });

  it('wakes an awaitDone as soon as the download reaches a terminal state', async () => {
    const deps = fakeDeps();
    const tracker = createDownloadTracker(deps);
    tracker.expect(A);
    const record = created(tracker, 1);

    let settled = false;
    const waiting = tracker.awaitDone(record!.downloadId, 30_000).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.onChanged({ id: 1, state: { current: 'complete' } });
    await waiting;
    expect(settled).toBe(true);
    // And the timer it armed is gone, not left to fire into a dead promise.
    expect(deps.pending()).toBe(0);
  });

  it('returns immediately for a download that already finished', async () => {
    const deps = fakeDeps();
    const tracker = createDownloadTracker(deps);
    tracker.expect(A);
    const record = created(tracker, 1);
    tracker.onChanged({ id: 1, state: { current: 'complete' } });

    await tracker.awaitDone(record!.downloadId, 30_000);
    expect(deps.pending()).toBe(0);
  });

  it('returns for an unknown id rather than hanging forever', async () => {
    const deps = fakeDeps();
    const tracker = createDownloadTracker(deps);
    await tracker.awaitDone('dl_nope', 30_000);
    expect(deps.pending()).toBe(0);
  });

  /**
   * The bound that makes a large file a poll instead of a stall: the wait
   * expires, the call comes back, and the download is still tracked.
   */
  it('gives up waiting on expiry and leaves the download in progress', async () => {
    const deps = fakeDeps();
    const tracker = createDownloadTracker(deps);
    tracker.expect(A);
    const record = created(tracker, 1);

    const waiting = tracker.awaitDone(record!.downloadId, 30_000);
    deps.fireAll();
    await waiting;

    expect(record!.state).toBe('in_progress');
    expect(downloadResultFor(record).message).toContain('Still downloading');
  });

  it('resolves a click\'s wait with nothing when no download arrived', async () => {
    const deps = fakeDeps();
    const tracker = createDownloadTracker(deps);
    const expectation = tracker.expect(A);

    const waiting = expectation.wait(30_000);
    deps.fireAll();

    expect(await waiting).toBeNull();
  });

  it('resolves a click\'s wait as soon as the download it started appears', async () => {
    const deps = fakeDeps();
    const tracker = createDownloadTracker(deps);
    const expectation = tracker.expect(A);

    const waiting = expectation.wait(30_000);
    const record = created(tracker, 1);

    expect(await waiting).toBe(record);
    expect(deps.pending()).toBe(0);
  });

  it('resolves at once when the file finished before anyone started waiting', async () => {
    const tracker = createDownloadTracker(fakeDeps());
    const expectation = tracker.expect(A);
    const record = created(tracker, 1);

    expect(await expectation.wait(30_000)).toBe(record);
  });
});

describe('downloadResultFor', () => {
  /**
   * The sentence that keeps the model from adopting some other file: an
   * unclaimed click says so, in words, and offers nothing else.
   */
  it('says the click produced no download rather than guessing at one', () => {
    const result = downloadResultFor(null);
    expect(result).toMatchObject({ started: false });
    expect(result.download).toBeUndefined();
    expect(String(result.message)).toContain('no other file was adopted');
  });

  it('reports a finished download with its path, size and type', () => {
    const tracker = createDownloadTracker(fakeDeps());
    tracker.expect(A);
    const record = created(tracker, 1, '/d/排班表.xlsx');
    tracker.onChanged({ id: 1, state: { current: 'complete' }, totalBytes: { current: 12 } });

    const result = downloadResultFor(record);
    expect(result).toMatchObject({ started: true, complete: true });
    expect(result.download).toMatchObject({ filename: '排班表.xlsx', path: '/d/排班表.xlsx', size: 12 });
    // The internal owner key is bookkeeping, not something the model is told.
    expect(JSON.stringify(result)).not.toContain(A);
  });
});
