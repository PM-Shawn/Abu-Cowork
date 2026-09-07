/**
 * Which local files an `upload_file` call is allowed to send, and what the
 * confirmation says about them (batch-三 T5).
 *
 * ## Why this is its own module, and why it is here rather than in the host
 *
 * An upload is the one browser action whose subject is NOT the page: it is a
 * file on the user's disk. So the gate has two questions to answer before it
 * can ask anybody anything —
 *
 *   1. **may Abu read this path at all?** That is `pathSafety`'s question, and
 *      `pathSafety` lives in the shell because the answer depends on the
 *      workspaces the user authorized THIS session. The browser host and the
 *      MCP bridge are separate processes that know none of that, so a check
 *      done only there would be a check against nothing.
 *   2. **what do I tell the user they are sending?** A confirmation that says
 *      「上传文件」 and nothing else is not consent. The name and the size come
 *      from the filesystem, not from the model's argument string.
 *
 * Both answers are then FROZEN into the approval (`BrowserExecutionPin`'s
 * `approvedUploadFiles`) and travel to the runtime over `_meta`, the same
 * channel `expectedOrigin` uses and for the same reason: the executor must
 * send the file the user saw, not whatever the argument said by the time it
 * reached the wire.
 *
 * ## Pure by injection
 *
 * `checkReadPath` and `lstat` come in as dependencies rather than being
 * imported, so the whole rule set is testable without a filesystem and
 * without `pathSafety`'s module-level workspace state. The registry passes
 * the real ones.
 */

import { getBaseName, normalizeSeparators } from '../../utils/pathUtils';

/**
 * Per-file and per-call ceilings.
 *
 * Not a technical limit of either channel — the built-in browser hands
 * Chromium a PATH and never reads the bytes at all, and the Chrome extension's
 * WebSocket would carry far more. It is a product bound, and it is here rather
 * than in one of the runtimes precisely so the two channels cannot differ:
 * a rule the user can discover on one browser and not the other is not a rule.
 *
 * 20 MiB covers what office work actually attaches — a scanned PDF, a photo
 * set, a spreadsheet — while keeping the extension channel's base64 round trip
 * (bytes → bridge → WebSocket → content script) inside a size a page can
 * actually take. Anything above it is a file the user should attach by hand,
 * and the refusal says so instead of trying and stalling.
 */
export const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
/** The whole call, so ten files at the per-file ceiling is still refused. */
export const MAX_UPLOAD_TOTAL_BYTES = 40 * 1024 * 1024;
/** One `<input multiple>` submission, not a directory sync. */
export const MAX_UPLOAD_FILES = 10;

/**
 * Why an upload was refused before anybody was asked about it.
 *
 * A closed vocabulary for the same reason `BrowserDenialReasonCode` is one:
 * the sentence the model reads, the sentence the user reads and the test that
 * pins the rule all have to name the same thing.
 */
export type BrowserUploadRefusalCode =
  /** `files` did not decode as a non-empty list of `{ path }`. */
  | 'malformed'
  /** More than `MAX_UPLOAD_FILES` entries. */
  | 'too-many-files'
  /** The path is outside every workspace the user authorized. */
  | 'not-authorized'
  /** The path does not exist, or is not a regular file. */
  | 'not-a-file'
  /** The final component is a symbolic link. */
  | 'symlink'
  /** Over `MAX_UPLOAD_FILE_BYTES`, or the call is over the total. */
  | 'too-large'
  /**
   * The filesystem gave back neither an mtime nor an inode, so nothing about
   * this file could be frozen except its length — and a length is not an
   * identity. Refused rather than approved with a pin that cannot be checked.
   */
  | 'unidentifiable';

export interface ApprovedUploadFile {
  /** The CANONICAL path `pathSafety` resolved — what actually gets read. */
  path: string;
  /** Its base name, for the confirmation and for the page's file input. */
  name: string;
  size: number;
  /**
   * Modification time in whole milliseconds, or `0` when the platform did not
   * report one.
   *
   * ## Why size alone was not a pin (2026-09-07 review F1)
   *
   * Everything above happens BEFORE the user answers, and the file is read
   * AFTER. In that window anything with write access to the workspace — a
   * background script the model started earlier, a sync client, any local
   * process — can put a different file at the approved path. `size` was the
   * only thing carried across it, so a same-size swap (a symbolic link to
   * `~/.ssh/id_rsa`, a rewritten spreadsheet) sailed through both senders.
   *
   * Identity, not just length, is what has to survive the wait. `mtimeMs`
   * changes on any in-place rewrite; `ino` changes when the path is made to
   * point at a different file at all, which is what a swap or a planted link
   * does. Whole milliseconds because that is the resolution the shell's
   * `FileInfo` carries (`Date` → `toISOString`), while `fstat` on the sending
   * side reports sub-millisecond — the two must be comparable.
   */
  mtimeMs: number;
  /** Inode, where the platform has one (`null` on Windows → omitted). */
  ino?: number;
  /** Device id, paired with `ino`: an inode number is only unique per device. */
  dev?: number;
}

/**
 * Is this frozen entry actually identifiable on disk later?
 *
 * A pin carrying nothing but a size cannot answer «是不是同一个文件», so a
 * sender that gets one must refuse rather than fall back to comparing lengths
 * — which is precisely the state F1 found. Exported so both senders spell the
 * rule the same way.
 */
export function hasUploadIdentityPin(file: {
  mtimeMs?: number;
  ino?: number;
}): boolean {
  return (typeof file.mtimeMs === 'number' && file.mtimeMs > 0)
    || (typeof file.ino === 'number' && Number.isFinite(file.ino));
}

export type BrowserUploadResolution =
  | { ok: true; files: ApprovedUploadFile[] }
  | { ok: false; code: BrowserUploadRefusalCode; detail?: string };

/** What this module needs from the outside world. */
export interface BrowserUploadDeps {
  /** `pathSafety.checkReadPath`, already bound to the run's scope. */
  checkReadPath: (path: string) => Promise<{
    allowed: boolean;
    resolvedPath?: string;
    reason?: string;
  }>;
  /**
   * `@tauri-apps/plugin-fs`'s `lstat` — the NON-following stat, which is the
   * whole point: `checkReadPath` canonicalizes, so by the time it says yes we
   * know where the link POINTS. What we still do not know is that the caller
   * named a link at all, and a link is how a path inside an authorized
   * workspace becomes a file outside it in the window between the check and
   * the read. Refusing links outright is cheaper than closing that race.
   */
  lstat: (path: string) => Promise<{
    isFile: boolean;
    isSymlink: boolean;
    size: number;
    /** Whole milliseconds, or 0 when the platform reported no mtime. */
    mtimeMs?: number;
    /** `null`/absent on Windows, where there is no inode. */
    ino?: number | null;
    dev?: number | null;
  }>;
}

/**
 * Decode the tool's `files` argument.
 *
 * Accepts the JSON string the schema declares and an already-decoded array,
 * exactly as `decodeBatchSteps` does — the gate and a caller that pre-parsed
 * must read the same call the same way.
 */
export function decodeUploadFiles(input: unknown): string[] | null {
  const raw = (input as { files?: unknown } | undefined)?.files;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? safeParseArray(raw)
      : null;
  if (list === null || list.length === 0) return null;
  const paths: string[] = [];
  for (const entry of list) {
    // `{ path }` objects, and a bare string for a model that skipped the
    // wrapper. Anything else makes the whole call unreadable rather than
    // silently uploading the subset that parsed.
    const path = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as { path?: unknown }).path
        : undefined);
    if (typeof path !== 'string' || path.trim() === '') return null;
    paths.push(path.trim());
  }
  return paths;
}

function safeParseArray(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve every path the call names into an approved file, or refuse.
 *
 * All-or-nothing on purpose: a call that names three attachments and gets two
 * has submitted a form the user did not approve. There is no partial upload.
 */
export async function resolveUploadFiles(
  input: unknown,
  deps: BrowserUploadDeps,
): Promise<BrowserUploadResolution> {
  const paths = decodeUploadFiles(input);
  if (paths === null) return { ok: false, code: 'malformed' };
  if (paths.length > MAX_UPLOAD_FILES) {
    return { ok: false, code: 'too-many-files', detail: String(paths.length) };
  }

  const files: ApprovedUploadFile[] = [];
  let total = 0;
  for (const raw of paths) {
    /**
     * The path AS THE CALLER WROTE IT, lstat'ed before anything canonicalizes
     * it — and the security-relevant one of the two lstats here. A link
     * inside an authorized workspace pointing at `~/.ssh/id_rsa` is the whole
     * attack, and it is invisible from the canonical path alone, which is the
     * link's destination.
     *
     * It also has to come before `checkReadPath`, which realpaths: a link that
     * SITS in an authorized workspace and POINTS outside it canonicalizes to
     * an unauthorized target, so asking about authorization first answered
     * 「未授权目录」 — sending the user off to authorize a directory that is
     * not the problem, about a file whose actual problem is that it is a link
     * (acceptance F2). Reaching the link verdict first widens nothing:
     * `lstat` does not follow the link, the path is still confined to the fs
     * host's own capability scope or the call throws, and either way the
     * upload is refused — only the sentence changes.
     */
    let named: Awaited<ReturnType<BrowserUploadDeps['lstat']>> | null = null;
    try {
      named = await deps.lstat(raw);
    } catch {
      // Out of the fs host's scope, or simply not there. `checkReadPath` below
      // has the better sentence for the first and `not-a-file` for the second,
      // so say nothing yet.
    }
    if (named !== null && named.isSymlink) {
      return { ok: false, code: 'symlink', detail: displayName(raw) };
    }

    const check = await deps.checkReadPath(raw);
    // `needsPermission` is an ALLOWED: false too, and it is deliberately not
    // turned into a permission prompt here. That prompt authorizes a whole
    // directory for the rest of the session, and an upload is the wrong place
    // to buy one — the user came here to send one file.
    if (!check.allowed || !check.resolvedPath) {
      return { ok: false, code: 'not-authorized', detail: displayName(raw) };
    }
    const resolved = check.resolvedPath;
    let info: Awaited<ReturnType<BrowserUploadDeps['lstat']>>;
    try {
      if (named === null) named = await deps.lstat(raw);
      info = await deps.lstat(resolved);
    } catch {
      return { ok: false, code: 'not-a-file', detail: displayName(raw) };
    }
    if (named.isSymlink || info.isSymlink) {
      return { ok: false, code: 'symlink', detail: displayName(raw) };
    }
    if (!info.isFile) return { ok: false, code: 'not-a-file', detail: displayName(raw) };
    const size = Number.isFinite(info.size) && info.size >= 0 ? info.size : 0;
    if (size > MAX_UPLOAD_FILE_BYTES) {
      return { ok: false, code: 'too-large', detail: displayName(resolved) };
    }
    total += size;
    if (total > MAX_UPLOAD_TOTAL_BYTES) {
      return { ok: false, code: 'too-large', detail: displayName(resolved) };
    }
    // The identity pin travels with the entry, and the senders refuse an entry
    // that carries none (`hasUploadIdentityPin`) rather than degrading to the
    // size-only comparison F1 walked through.
    const mtimeMs = Number.isFinite(info.mtimeMs) && (info.mtimeMs as number) > 0
      ? Math.floor(info.mtimeMs as number)
      : 0;
    const identified = mtimeMs > 0
      || (typeof info.ino === 'number' && Number.isFinite(info.ino));
    if (!identified) {
      return { ok: false, code: 'unidentifiable', detail: displayName(resolved) };
    }
    files.push({
      path: resolved,
      name: displayName(resolved),
      size,
      mtimeMs,
      ...(typeof info.ino === 'number' && Number.isFinite(info.ino) ? { ino: info.ino } : {}),
      ...(typeof info.dev === 'number' && Number.isFinite(info.dev) ? { dev: info.dev } : {}),
    });
  }
  return { ok: true, files };
}

/**
 * The file's own name, flattened for a single-line surface.
 *
 * A filename is not page content, but it IS attacker-influenceable in the one
 * case that matters here (a file the user downloaded from somewhere), and a
 * newline in it would let a confirmation dialog grow a second line that reads
 * like the app wrote it. Separators are normalized first so a Windows path
 * yields its last component rather than the whole string.
 *
 * The BIDI OVERRIDES belong with the control characters, and they are why this
 * is not merely a tidiness rule: `report\u202Egpj.exe` RENDERS as
 * `reportexe.jpg` anywhere Unicode bidi is honoured, so a confirmation naming
 * the file about to be sent would name a different file than the one being
 * sent — the one lie this dialog cannot afford. U+202A–U+202E (embedding /
 * override) and U+2066–U+2069 (isolates) are the whole vocabulary of that
 * trick; U+200B–U+200F covers the cruder zero-width and mark characters.
 */
export function displayName(path: string): string {
  const base = getBaseName(normalizeSeparators(path));
  // `\p{Cc}` (control) and `\p{Cf}` (format) as CATEGORIES rather than a
  // hand-written range (review F7). The hand-written one covered the bidi
  // overrides and the zero-width block and missed U+2060 WORD JOINER, U+00AD
  // SOFT HYPHEN, U+061C ARABIC LETTER MARK, U+180E and the whole U+E0000
  // tag-character plane — every one of which renders as nothing and can pad a
  // name in a confirmation dialog. `\p{Zl}`/`\p{Zp}` are the line and
  // paragraph separators `\s` does not cover.
  const flattened = base
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ')
    .trim();
  if (flattened === '') return '(unnamed)';
  return truncateKeepingExtension(flattened, 80);
}

/**
 * Shorten in the MIDDLE, so the extension survives.
 *
 * `report<70 more chars>.pdf.exe` truncated from the right becomes
 * `report<…>…` — the dialog stops naming the very thing that decides what the
 * file IS. Splitting by code point rather than by UTF-16 unit is the other
 * half: slicing an emoji or a rare CJK character in half leaves a lone
 * surrogate, which renders as a replacement box.
 */
function truncateKeepingExtension(value: string, max: number): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  const dot = value.lastIndexOf('.');
  const ext = dot > 0 && dot > value.length - 12 ? value.slice(dot) : '';
  const extChars = [...ext];
  // No usable extension, or one so long it leaves no room: plain head + ellipsis.
  if (extChars.length === 0 || extChars.length + 2 >= max) {
    return `${chars.slice(0, max - 1).join('')}…`;
  }
  const head = chars.slice(0, max - extChars.length - 1).join('');
  return `${head}…${ext}`;
}

/**
 * "report.xlsx (1.2 MB) + 2 more" — what the confirmation puts next to the
 * site, in every channel that asks.
 *
 * Names and sizes only: no directory, because the confirmation's question is
 * «要把这个文件发给这个网站吗», and the answer does not depend on which folder
 * it came out of — while a full path is exactly the kind of thing a screenshot
 * of an approval dialog should not carry.
 */
export function summarizeUploadFiles(files: readonly ApprovedUploadFile[]): string {
  // ALL of them (review F6). The old「前三个 +N」 asked a user to sign for
  // seven files it would not name — and `MAX_UPLOAD_FILES` is 10, so the
  // whole list is at most ten short lines, which a dialog can show.
  const shown = files.slice(0, MAX_UPLOAD_FILES)
    .map((f) => `${f.name} (${formatBytes(f.size)})`);
  const rest = files.length - shown.length;
  const listed = rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ');
  // The total, so a ten-file call is one number to weigh rather than ten.
  if (files.length < 2) return listed;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  return `${listed} — ${formatBytes(total)}`;
}

/** Sizes a person reads, in the one spelling both locales use. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
