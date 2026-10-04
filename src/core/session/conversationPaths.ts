/**
 * Conversation ids and the paths built from them.
 *
 * A conversation id becomes a directory name under `<appData>/conversations`,
 * and in the sidecar nothing stands between a path and `node:fs`. So the id is
 * checked against one grammar before any path exists, and the builders below
 * are the only code that turns an id into a path. The grammar is the opaque-id
 * grammar the delegated-media store already applies to conversation ids in all
 * three tiers (`electron/delegatedMediaHost.cjs`, `isOpaqueMediaId`), minus two
 * kinds of name that alias something else on Windows: a name ending in `.`
 * (the trailing dot is dropped, so `abc.` is `abc`) and a device name (`nul`,
 * `com1.txt`, ...), and the names the conversations root already holds for
 * itself. Every id the app has ever generated — base-36 time plus up to six
 * base-36 characters — passes.
 *
 * This module imports nothing, so every tier can bundle it.
 */

export const CONVERSATION_ID_MAX_LENGTH = 128;

const ID_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_DEVICE_STEM = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const INDEX_FILENAME = 'index.json';
const LEDGER_FILENAME = 'messages.jsonl';
const STREAM_SNAPSHOT_FILENAME = 'stream-snapshot.json';
const SNAPSHOT_SWEEP_MARKER_FILENAME = '.snapshot-sweep-version';
const CHECKPOINT_FILENAME = 'checkpoint.json';
const OUTPUTS_DIRNAME = 'outputs';
const RESULTS_DIRNAME = 'results';

/**
 * Everything `createConversationPaths` places directly under the conversations
 * root besides the conversation directories. An id equal to one of these makes
 * `conversationDir` name that file, so a recursive remove of what the caller
 * believes is a conversation directory would take the index of every
 * conversation with it. Compared lower-cased, because macOS and Windows open
 * `INDEX.JSON` and `index.json` as the same file. The marker is already outside
 * the character class; it is listed so the set stays the literal contents of
 * the root rather than a hand-picked subset.
 */
const ROOT_RESERVED_NAMES = new Set([INDEX_FILENAME, SNAPSHOT_SWEEP_MARKER_FILENAME]);

export type ConversationIdRejection =
  | 'not_a_string' | 'empty' | 'too_long' | 'charset' | 'dot_dot' | 'trailing_dot'
  | 'reserved_device_name' | 'reserved_sibling_name';

export function conversationIdRejection(value: unknown): ConversationIdRejection | null {
  if (typeof value !== 'string') return 'not_a_string';
  if (value.length === 0) return 'empty';
  if (value.length > CONVERSATION_ID_MAX_LENGTH) return 'too_long';
  if (!ID_CHARSET.test(value)) return 'charset';
  if (value.includes('..')) return 'dot_dot';
  if (value.endsWith('.')) return 'trailing_dot';
  if (WINDOWS_DEVICE_STEM.test(value.split('.')[0])) return 'reserved_device_name';
  if (ROOT_RESERVED_NAMES.has(value.toLowerCase())) return 'reserved_sibling_name';
  return null;
}

export function isConversationId(value: unknown): value is string {
  return conversationIdRejection(value) === null;
}

export class ConversationIdError extends Error {
  readonly code = 'conversation_id_invalid' as const;
  readonly reason: ConversationIdRejection;
  constructor(reason: ConversationIdRejection) {
    // The value is attacker-shaped by definition, so it never enters a message or a log.
    super(`Conversation id is not valid (${reason})`);
    this.name = 'ConversationIdError';
    this.reason = reason;
  }
}

export function assertConversationId(value: unknown): asserts value is string {
  const reason = conversationIdRejection(value);
  if (reason !== null) throw new ConversationIdError(reason);
}

export type ConversationPathErrorCode = 'conversation_dir_outside_root' | 'canonical_path_unavailable';

export class ConversationPathError extends Error {
  readonly code: ConversationPathErrorCode;
  constructor(code: ConversationPathErrorCode) {
    super(`Conversation path refused (${code})`);
    this.name = 'ConversationPathError';
    this.code = code;
  }
}

export function joinConversationPath(...segments: string[]): string {
  return segments
    .map((segment) => segment.replace(/\\/g, '/'))
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export interface ConversationPaths {
  readonly appDataDir: string;
  readonly root: string;
  readonly legacySessionsRoot: string;
  readonly backupDir: string;
  indexFilePath(): string;
  sweepMarkerPath(): string;
  conversationDir(convId: string): string;
  messagesPath(convId: string): string;
  streamSnapshotPath(convId: string): string;
  checkpointPath(convId: string): string;
  outputsDir(convId: string): string;
  resultsDir(convId: string): string;
  legacySessionDir(convId: string): string;
  conversationIdOfMessagesPath(filePath: string): string | undefined;
}

export function createConversationPaths(appDataDir: string): ConversationPaths {
  const root = joinConversationPath(appDataDir, 'conversations');
  const legacySessionsRoot = joinConversationPath(appDataDir, 'sessions');
  const under = (base: string, convId: string, ...rest: string[]): string => {
    assertConversationId(convId);
    return joinConversationPath(base, convId, ...rest);
  };
  return {
    appDataDir,
    root,
    legacySessionsRoot,
    backupDir: joinConversationPath(appDataDir, 'backups'),
    indexFilePath: () => joinConversationPath(root, INDEX_FILENAME),
    sweepMarkerPath: () => joinConversationPath(root, SNAPSHOT_SWEEP_MARKER_FILENAME),
    conversationDir: (convId) => under(root, convId),
    messagesPath: (convId) => under(root, convId, LEDGER_FILENAME),
    streamSnapshotPath: (convId) => under(root, convId, STREAM_SNAPSHOT_FILENAME),
    checkpointPath: (convId) => under(root, convId, CHECKPOINT_FILENAME),
    outputsDir: (convId) => under(root, convId, OUTPUTS_DIRNAME),
    resultsDir: (convId) => under(root, convId, RESULTS_DIRNAME),
    legacySessionDir: (convId) => under(legacySessionsRoot, convId),
    conversationIdOfMessagesPath: (filePath) => {
      const parts = filePath.split('/');
      if (parts.length < 2 || parts[parts.length - 1] !== LEDGER_FILENAME) return undefined;
      return parts[parts.length - 2];
    },
  };
}

function comparable(path: string): string {
  const normalised = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return normalised.length > 1 && normalised.endsWith('/') ? normalised.slice(0, -1) : normalised;
}

export function isDirectChildPath(canonicalRoot: string, canonicalTarget: string): boolean {
  const root = comparable(canonicalRoot);
  const target = comparable(canonicalTarget);
  const cut = target.lastIndexOf('/');
  if (cut <= 0) return false;
  // `comparable` normalises separators without resolving anything, so a final
  // `.` or `..` still names the root itself or its parent while the prefix
  // before it compares equal to the root. Neither is a child.
  const name = target.slice(cut + 1);
  if (name === '' || name === '.' || name === '..') return false;
  return target.slice(0, cut) === root;
}
