/** Prefix Electron puts on an error thrown back over `ipcRenderer.invoke`. */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': /;

/**
 * Wordings of "this path does not exist": Node's codes at the start of its
 * message, Node's description, Windows' description, and the OS error numbers
 * Rust prints (2: file not found, 3: path not found).
 */
const MISSING_PATH_DESCRIPTION = /^E(?:NOENT|NOTDIR)\b|no such file or directory|cannot find the (?:file|path) specified|os error [23]\b/i;

/**
 * The part of an error message that describes the failure. Node writes the
 * path after it, in quotes (`EACCES: permission denied, stat '/a/b'`), and a
 * path can hold any words, so only the text before the first quote is read.
 */
function failureDescription(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error))
    .replace(IPC_ERROR_PREFIX, '')
    .replace(/^Error: /, '');
  const quote = text.indexOf("'");
  return quote >= 0 ? text.slice(0, quote) : text;
}

/**
 * Whether a file-system error says the path does not exist. An error with a
 * code is judged by its code alone. An error that crossed the renderer IPC
 * boundary has lost its code, and is judged by the description in its message.
 */
export function isMissingPathError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code) return code === 'ENOENT' || code === 'ENOTDIR';
  return MISSING_PATH_DESCRIPTION.test(failureDescription(error));
}
