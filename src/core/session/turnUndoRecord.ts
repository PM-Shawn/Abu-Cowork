/**
 * The record a settled turn keeps so its file changes can be undone and put
 * back: `{appData}/conversations/{convId}/changes/{loopId}/undo.json`.
 *
 * An entry names one file the turn's file tools changed, what it held before
 * the turn and at its end, and the SHA-256 of both contents. The copy of a
 * content is stored under the hash of the path, so an entry whose `hash` is
 * not the hash of its `path` points at another file's copy and is dropped.
 */

const FORMAT_VERSION = 1 as const;

export interface TurnUndoEntry {
  /** Absolute, '/' separators. */
  path: string;
  /** First 16 hexadecimal digits of the SHA-256 of `path`; the file name of its copies. */
  hash: string;
  /** What the path held before the turn. */
  before: 'file' | 'absent';
  /** What the path held when the turn ended. */
  after: 'file' | 'absent';
  /** SHA-256 of the content before the turn, when `before` is 'file'. */
  beforeSha256?: string;
  /** SHA-256 of the content at the end of the turn, when `after` is 'file'. */
  afterSha256?: string;
  /** What the latest undo or put-back did with this file. */
  last?: 'done' | 'skipped' | 'failed';
}

export interface TurnUndoRecord {
  version: typeof FORMAT_VERSION;
  loopId: string;
  entries: TurnUndoEntry[];
  /** 'applied': the files are as the turn left them; 'undone': the turn is undone. */
  state: 'applied' | 'undone';
  /** Paths the file tools changed that were over the copy size on either side, so no entry names them. */
  tooLarge?: string[];
}

function hexOf(digest: ArrayBuffer): string {
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** The SHA-256 of `bytes` as 64 hexadecimal digits. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexOf(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

/** The name the copies of `path` are stored under. */
export async function pathHashOf(path: string): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(path))).slice(0, 16);
}

export function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isSide(value: unknown): value is 'file' | 'absent' {
  return value === 'file' || value === 'absent';
}

/** A path as the turn recorded it: absolute, '/' separators, no '.' or '..' segment. */
function isRecordedPath(value: unknown): value is string {
  return typeof value === 'string'
    && isAbsoluteFilePath(value)
    && !value.includes('\\')
    && !value.split('/').some((segment) => segment === '.' || segment === '..');
}

/** The entry `value` holds, or null when it does not have the saved shape. */
function parseEntry(value: unknown): TurnUndoEntry | null {
  if (
    !isRecord(value)
    || !isRecordedPath(value.path)
    || typeof value.hash !== 'string'
    || !/^[0-9a-f]{16}$/.test(value.hash)
    || !isSide(value.before)
    || !isSide(value.after)
    || (value.before === 'absent' && value.after === 'absent')
    || (value.before === 'file' ? !isContentHash(value.beforeSha256) : value.beforeSha256 !== undefined)
    || (value.after === 'file' ? !isContentHash(value.afterSha256) : value.afterSha256 !== undefined)
    || !(value.last === undefined || value.last === 'done' || value.last === 'skipped' || value.last === 'failed')
  ) {
    return null;
  }
  return {
    path: value.path,
    hash: value.hash,
    before: value.before,
    after: value.after,
    ...(value.before === 'file' ? { beforeSha256: value.beforeSha256 as string } : {}),
    ...(value.after === 'file' ? { afterSha256: value.afterSha256 as string } : {}),
    ...(value.last === undefined ? {} : { last: value.last }),
  };
}

/** The JSON value of `text`, or undefined when the text is no JSON (a write cut off halfway, a damaged disk). */
function jsonValueOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/**
 * Reads the text of an `undo.json`. Resolves to null when the text is no JSON
 * or the JSON does not have the saved shape, which a record of another format
 * version does not: like a record that is not there, it costs the turn its
 * undo and nothing else. An entry whose `hash` is not the hash of its `path`
 * is left out.
 */
export async function parseTurnUndoRecord(text: string): Promise<TurnUndoRecord | null> {
  const value = jsonValueOf(text);
  if (
    !isRecord(value)
    || value.version !== FORMAT_VERSION
    || typeof value.loopId !== 'string'
    || !(value.state === 'applied' || value.state === 'undone')
    || !Array.isArray(value.entries)
    || !(value.tooLarge === undefined || (Array.isArray(value.tooLarge) && value.tooLarge.every(isRecordedPath)))
  ) {
    return null;
  }
  const entries: TurnUndoEntry[] = [];
  for (const item of value.entries as unknown[]) {
    const entry = parseEntry(item);
    if (!entry) return null;
    if ((await pathHashOf(entry.path)) === entry.hash) entries.push(entry);
  }
  return {
    version: FORMAT_VERSION,
    loopId: value.loopId,
    state: value.state,
    entries,
    ...(value.tooLarge === undefined ? {} : { tooLarge: value.tooLarge as string[] }),
  };
}

export function createTurnUndoRecord(loopId: string, entries: TurnUndoEntry[], tooLarge: string[]): TurnUndoRecord {
  return { version: FORMAT_VERSION, loopId, entries, state: 'applied', ...(tooLarge.length > 0 ? { tooLarge } : {}) };
}
