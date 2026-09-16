/**
 * The validation that stands between model-authored JSON and the DOM runtime.
 *
 * Extracted from `tools.ts` so `batch.ts` can apply the SAME checks to a step
 * as the single-action tool applies to its own argument. A batch step that
 * went through a second, slightly different parser would be a way to reach the
 * page with a locator the single-action path refuses — which is exactly the
 * shape of gate bypass this module exists to prevent.
 *
 * Each `parse*` takes the raw string an MCP argument carries; each `validate*`
 * takes an already-decoded object, which is the form a batch step is in.
 */

export const LOCATOR_KEYS = ['css', 'text', 'tag', 'role', 'name', 'xpath', 'testId', 'ref'];

/**
 * A frame handle, or nothing.
 *
 * `frameId` is not a locator key: it says which DOCUMENT to look in, and every
 * strategy above is then applied inside it. Validated in one place so a batch
 * step and a single action refuse the same strings — a step that reached the
 * page with a handle the single-action path rejects would be the second-parser
 * bypass this module exists to prevent.
 */
export function validateFrameId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^f\d+$/.test(value)) {
    throw new Error(
      '`frameId` must be a frame handle from a snapshot\'s `frames` list, like "f0" or "f3". '
      + 'Omit it to act on the main document.',
    );
  }
  return value;
}

/**
 * Keys a `find` query accepts. Separate from `LOCATOR_KEYS` because the two
 * mean different things: a locator must identify one element, a query is
 * allowed — expected — to match several, and it accepts `label`/`placeholder`,
 * which are how a person names a form field rather than how a caller pins one
 * down.
 */
export const FIND_QUERY_KEYS = ['role', 'name', 'text', 'css', 'testId', 'label', 'placeholder'];

export const WAIT_CONDITION_TYPES = ['appear', 'disappear', 'enabled', 'textContains', 'urlContains'];

/**
 * The modifier keys `keyboard` accepts — the ONE list, read by both paths.
 *
 * `tools.ts` builds its zod enum from it and `validateKeyboardModifiers` below
 * checks a batch step against it, so the two cannot disagree. They used to:
 * the single-action tool took `z.enum(['ctrl','shift','alt','meta'])` while a
 * batch step took `requireString`, i.e. any non-empty string, which
 * `browserHost.cjs` then passed to `webContents.sendInputEvent` almost
 * verbatim. Electron's modifier set is larger than these four (`capsLock`,
 * `numLock`, `leftButtonDown`, `isAutoRepeat`, …), so a batch could send
 * modifier bits the single-action path refuses — the second-parser bypass this
 * module's header names as the thing it exists to prevent, in the one field
 * that had been left out of the extraction.
 */
export const KEYBOARD_MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'] as const;

export type KeyboardModifier = (typeof KEYBOARD_MODIFIERS)[number];

/** Validate an already-decoded `modifiers` array from a batch step. */
export function validateKeyboardModifiers(value: unknown): KeyboardModifier[] {
  if (!Array.isArray(value)) throw new Error('`modifiers` must be an array');
  return value.map((m) => {
    if (typeof m !== 'string' || !(KEYBOARD_MODIFIERS as readonly string[]).includes(m)) {
      throw new Error(`\`modifiers[]\` must be one of: ${KEYBOARD_MODIFIERS.join(', ')}`);
    }
    return m as KeyboardModifier;
  });
}

function asPlainObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Ensure a decoded locator names at least one known strategy. */
export function validateLocator(value: unknown): Record<string, unknown> {
  const parsed = asPlainObject(value, 'Locator');
  if (!Object.keys(parsed).some((k) => LOCATOR_KEYS.includes(k))) {
    throw new Error(`Locator must contain at least one of: ${LOCATOR_KEYS.join(', ')}`);
  }
  return parsed;
}

/** Ensure a decoded `find` query carries at least one non-empty known key. */
export function validateFindQuery(value: unknown): Record<string, unknown> {
  const parsed = asPlainObject(value, 'Find query');
  const usable = Object.entries(parsed).some(
    ([key, v]) => FIND_QUERY_KEYS.includes(key) && typeof v === 'string' && v !== '',
  );
  if (!usable) {
    throw new Error(`Find query must contain at least one non-empty: ${FIND_QUERY_KEYS.join(', ')}`);
  }
  return parsed;
}

/** Ensure a decoded wait condition names one of the supported types. */
export function validateCondition(value: unknown): Record<string, unknown> {
  const parsed = asPlainObject(value, 'Condition');
  if (!WAIT_CONDITION_TYPES.includes(parsed.type as string)) {
    throw new Error(`Condition type must be one of: ${WAIT_CONDITION_TYPES.join(', ')}`);
  }
  return parsed;
}

export function parseLocator(raw: string): Record<string, unknown> {
  return validateLocator(JSON.parse(raw));
}

export function parseFindQuery(raw: string): Record<string, unknown> {
  return validateFindQuery(JSON.parse(raw));
}

export function parseCondition(raw: string): Record<string, unknown> {
  return validateCondition(JSON.parse(raw));
}

/**
 * One entry of the file list Abu's approval gate froze for an `upload_file`
 * call (T5). It arrives over MCP `_meta`, never the tool's input schema — the
 * model can neither read nor forge it, exactly like `expectedOrigin`.
 */
export interface ApprovedUploadFile {
  /** Canonical path, already checked against the user's authorized dirs. */
  path: string;
  /** Base name, which is what the page's `<input>` will report. */
  name: string;
  size: number;
  /**
   * The identity the gate froze, so the sender can tell «同一个文件» from
   * «同样大小的另一个文件» (2026-09-07 review F1).
   *
   * Mirrors `ApprovedUploadFile` in
   * `src/core/permissions/browserUploadFiles.ts`; the shell fills it from the
   * same `lstat` it uses to refuse links, and every sender re-checks it
   * against an `fstat` of the descriptor it is actually reading from. An
   * entry that carries neither `mtimeMs` nor `ino` is REFUSED rather than
   * compared by length — a length is not an identity.
   */
  mtimeMs: number;
  ino?: number;
  dev?: number;
}

/** True iff this entry carries something a sender can actually re-check. */
export function hasUploadIdentityPin(file: ApprovedUploadFile): boolean {
  return file.mtimeMs > 0 || (typeof file.ino === 'number' && Number.isFinite(file.ino));
}

/**
 * Read the approved list, or `null` when it is absent / unreadable.
 *
 * Null is a REFUSAL at every call site, never "upload nothing": the gate
 * stamps this on every upload it approves, so its absence means the chain
 * broke — and the one thing that must not happen then is for the tool
 * argument's own paths to be used instead. That is why `upload_file`'s
 * handler validates `files` for shape and then never reads a path out of it.
 */
export function parseApprovedUploadFiles(raw: unknown): ApprovedUploadFile[] | null {
  const decoded = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(decoded) || decoded.length === 0) return null;
  const out: ApprovedUploadFile[] = [];
  for (const entry of decoded) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const { path, name, size, mtimeMs, ino, dev } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || path === '') return null;
    if (typeof name !== 'string' || name === '') return null;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
    // The identity pin is REQUIRED, and a stamp missing it reads as no stamp
    // at all: an upload approved by a build that froze only a size cannot be
    // re-checked here, and refusing is the fail-closed half of F1.
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
    const entryOut: ApprovedUploadFile = { path, name, size, mtimeMs: Math.floor(mtimeMs) };
    if (typeof ino === 'number' && Number.isFinite(ino)) entryOut.ino = ino;
    if (typeof dev === 'number' && Number.isFinite(dev)) entryOut.dev = dev;
    if (!hasUploadIdentityPin(entryOut)) return null;
    out.push(entryOut);
  }
  return out;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Validate the model-facing `files` argument for SHAPE only.
 *
 * Its paths are deliberately thrown away: the gate already resolved them
 * (canonicalized, checked against the authorized workspaces, refused links and
 * oversize files) and stamped the result into `_meta`. Re-reading them here
 * would be a second, unchecked road to the filesystem — the "second parser"
 * this module exists to prevent, one layer up.
 *
 * It is still validated, because a call whose `files` will not decode is a
 * call the user was never shown a correct confirmation for.
 */
export function validateUploadFilesArgument(raw: unknown): void {
  // A JSON string OR an already-decoded array, exactly as the gate's
  // `decodeUploadFiles` reads it (review F13). They disagreed: the gate
  // accepted an array, resolved the files, and asked the user — and then this
  // schema refused the same call, spending a consent on nothing.
  const decoded = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(decoded) || decoded.length === 0) {
    throw new Error('`files` must be a non-empty JSON array like [{"path": "/abs/path/report.xlsx"}]');
  }
  for (const entry of decoded) {
    const path = typeof entry === 'string'
      ? entry
      : (typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as { path?: unknown }).path
        : undefined);
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error('Every entry of `files` needs a non-empty `path` (an absolute path on this computer)');
    }
  }
}

/** `download`'s two shapes: press something, or wait for one already started. */
export const DOWNLOAD_ACTIONS = ['click', 'wait'] as const;

export type DownloadAction = (typeof DOWNLOAD_ACTIONS)[number];

/**
 * The ceiling on how long one `download` call blocks.
 *
 * A wait that can outlast the run is a wait nobody can stop, and the model's
 * own `timeoutMs` is a model-authored number — so it is clamped rather than
 * trusted. Past it the call RETURNS with the `downloadId` and the state so
 * far, which is what makes a large file a poll instead of a stall.
 */
export const MAX_DOWNLOAD_WAIT_MS = 120_000;
export const DEFAULT_DOWNLOAD_WAIT_MS = 30_000;

export function clampDownloadWait(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DOWNLOAD_WAIT_MS;
  return Math.min(Math.floor(n), MAX_DOWNLOAD_WAIT_MS);
}
