const DATA_URL_PREFIX_PATTERN = /data:/gi;
const BASE64_PAYLOAD_CHARACTER = /^[a-zA-Z0-9+/_=-]$/;
/** Characters that end a path: whitespace, quotes, angle brackets, and Chinese/Japanese full-width punctuation. */
const PATH_STOP = /[\s"'`<>，。；：！？、）】」』》]/u;
/** Trailing characters that belong to the sentence or the markup around a path, not to the path. */
const TRAILING_PUNCTUATION = /[.,;:!?*]$/;
/**
 * Top-level folders under which a POSIX absolute path names something on this
 * machine: homes and user files, temporary and app-data locations, mounted and
 * container volumes. Matched in their real case and only with a folder after
 * them: `/tmp 目录`, `首页/Home`, `图书馆/Library` and `</var>` name nobody.
 */
const POSIX_ROOTS = new Set([
  'Users', 'home', 'root', 'Volumes', 'private', 'var', 'tmp', 'opt', 'mnt', 'media', 'srv',
  'Library', 'Applications', 'System', 'Network', 'data', 'workspace',
]);
/** A user's folder, wherever a path reaches it (`/System/Volumes/Data/Users/x`, `/c/Users/x`, `../Users/x`). */
const USER_FOLDERS = new Set(['Users', 'home']);
/** A URL other than file://: its path is the site's, never a local path. */
const URL_PATTERN = /\b[a-zA-Z][a-zA-Z0-9+.-]+:\/\/[^\s"'`<>]*/g;
/** A drive letter, also right after Chinese text (`已保存到C:\…`), not inside a word (`ABC:/`). */
const WINDOWS_PATH_START = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/g;
/** `\\server\share`; a lone escaped backslash in JSON text (`\\n`) is no share. */
const UNC_PATH_START = /\\\\[\p{L}\p{N}_.$?-]+\\/gu;
const ANGLE_PATH = /<((?:[\\/]|~[\\/]|[A-Za-z]:[\\/])[^<>\r\n]*)>/g;

function redactBase64DataUrls(value: string): string {
  let cursor = 0;
  let searchFrom = 0;
  let output = '';

  while (searchFrom < value.length) {
    DATA_URL_PREFIX_PATTERN.lastIndex = searchFrom;
    const match = DATA_URL_PREFIX_PATTERN.exec(value);
    if (!match) break;

    const start = match.index;
    let index = DATA_URL_PREFIX_PATTERN.lastIndex;
    let quote: '"' | "'" | null = null;
    let comma = -1;
    while (index < value.length) {
      const character = value[index];
      if (quote) {
        if (character === '\\') {
          index += 2;
          continue;
        }
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ',') {
        comma = index;
        break;
      } else if (character === '\r' || character === '\n' || character === '<' || character === '>') {
        break;
      }
      index++;
    }

    if (comma < 0 || !/;\s*base64\s*$/i.test(value.slice(DATA_URL_PREFIX_PATTERN.lastIndex, comma))) {
      searchFrom = DATA_URL_PREFIX_PATTERN.lastIndex;
      continue;
    }

    let end = comma + 1;
    while (end < value.length) {
      const character = value[end];
      if (BASE64_PAYLOAD_CHARACTER.test(character)) {
        end++;
        continue;
      }
      if (character === '\r' || character === '\n') {
        let next = end;
        while (value[next] === '\r' || value[next] === '\n') next++;
        if (next < value.length && BASE64_PAYLOAD_CHARACTER.test(value[next])) {
          end = next;
          continue;
        }
      }
      break;
    }

    output += value.slice(cursor, start);
    output += '[REDACTED:base64]';
    cursor = end;
    searchFrom = end;
  }

  return output + value.slice(cursor);
}

/** Redact inline media payloads without removing ordinary filesystem paths. */
export function redactInlineMediaPayloads(value: string): string {
  return redactBase64DataUrls(value);
}

/** The segments of a path, any run of slashes and backslashes taken as one separator. */
function segmentsOf(path: string): string[] {
  return path.replace(/[\\/]+/g, '/').split('/');
}

/**
 * Whether a path that starts with `/`, `~/` or `../` names a place on this
 * machine: a folder under one of `POSIX_ROOTS`, the home folder, or a user's
 * folder reached any other way.
 */
function isLocalPosixPath(path: string): boolean {
  const segments = segmentsOf(path);
  if (segments[0] === '~') return segments.length > 1 && segments[1] !== '';
  if (segments[0] === '' && POSIX_ROOTS.has(segments[1] ?? '') && (segments[2] ?? '') !== '') return true;
  return segments.some((segment, i) => USER_FOLDERS.has(segment) && (segments[i + 1] ?? '') !== '');
}

/**
 * Where a path that starts at `start` ends. A path ends at `PATH_STOP`, except
 * that a user's folder name may hold spaces (`C:\Users\Zhang San\…`): while the
 * segment after `Users` or `home` is being read, a space followed by more of
 * the path (a separator before the next space) continues it. Trailing
 * sentence punctuation, Markdown emphasis and an unmatched closing bracket
 * are left to the text around the path.
 */
function pathEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length) {
    const character = text[end];
    if (!PATH_STOP.test(character)) {
      end++;
      continue;
    }
    if (character !== ' ') break;
    const segments = segmentsOf(text.slice(start, end));
    // Windows writes the folder in any case (`c:\\users\\…`).
    const inUserFolder = segments.length >= 2 && /^(users|home)$/i.test(segments[segments.length - 2]) && segments[segments.length - 1] !== '';
    const next = /^ [^\s"'`<>]*/.exec(text.slice(end))?.[0] ?? '';
    if (!inUserFolder || !/[\\/]/.test(next)) break;
    end++;
  }
  let path = text.slice(start, end);
  for (;;) {
    if (TRAILING_PUNCTUATION.test(path)) path = path.slice(0, -1);
    else if (path.endsWith(')') && path.split('(').length < path.split(')').length) path = path.slice(0, -1);
    else if (path.endsWith(']') && path.split('[').length < path.split(']').length) path = path.slice(0, -1);
    else break;
  }
  return start + path.length;
}

/** Replace every path that a start pattern finds and `pathEnd` ends, when `redact` says it is local. */
function replacePaths(text: string, starts: RegExp, redact: (path: string) => boolean): string {
  let output = '';
  let cursor = 0;
  starts.lastIndex = 0;
  for (let match = starts.exec(text); match; match = starts.exec(text)) {
    if (match.index < cursor) continue;
    const end = pathEnd(text, match.index);
    if (!redact(text.slice(match.index, end))) continue;
    output += `${text.slice(cursor, match.index)}[REDACTED:path]`;
    cursor = end;
    starts.lastIndex = end;
  }
  return output + text.slice(cursor);
}

/**
 * POSIX paths: a `/` not inside a word, number or URL (a JSON-escaped `\/`
 * counts), `~/` not right after a letter (`元~/月` is a price), or `../`.
 * Chinese text may run right up to a `/` path (`已保存到/Users/a.png`).
 */
const POSIX_PATH_START = /(?<![A-Za-z0-9_.~/-])\/(?!\/)|(?<![\p{L}\p{N}_.~/\\-])~(?=[\\/])|(?<![\p{L}\p{N}_.~/\\-])(?:\.\.[\\/])+/gu;

function redactLocalPaths(text: string): string {
  const windows = replacePaths(text, WINDOWS_PATH_START, () => true);
  const unc = replacePaths(windows, UNC_PATH_START, () => true);
  return replacePaths(unc, POSIX_PATH_START, isLocalPosixPath);
}

/** A file:// URL keeps its scheme and loses its path; any other URL is kept whole. */
function redactUrl(url: string): string {
  if (!/^file:\/\//i.test(url)) return url;
  const end = pathEnd(url, 0);
  return `${url.slice(0, 7)}[REDACTED:path]${url.slice(end)}`;
}

/**
 * Redact local filesystem paths and inline media from transport/telemetry
 * text, and nothing else: the text is often a document the model must read
 * exactly. A path is a drive letter (`C:\…`), a UNC share (`\\server\share`),
 * a `file://` URL, a POSIX path under one of the folders where this machine
 * keeps files (`POSIX_ROOTS`, in their real case, with a folder after the
 * root), `~/…`, or any path through a user's folder (`…/Users/<name>`).
 * Colon-prefixed labels like `output:/tmp/a.png` count; an angle-bracketed
 * path may hold spaces (`</Users/a b.png>`) while HTML closing tags such as
 * `</div>` stay. A slash inside a word, a number or a URL (`https://host/Users/x`,
 * `元/年`, `and/or`, `2026/09/28`, `首页/Home`) starts no path.
 */
export function redactSensitiveMediaText(value: string): string {
  const text = redactInlineMediaPayloads(value).replace(ANGLE_PATH, (whole, inner: string) => (
    /^[A-Za-z]:|^\\\\/.test(inner) || isLocalPosixPath(inner) ? '<[REDACTED:path]>' : whole
  ));
  let output = '';
  let cursor = 0;
  URL_PATTERN.lastIndex = 0;
  for (let match = URL_PATTERN.exec(text); match; match = URL_PATTERN.exec(text)) {
    output += redactLocalPaths(text.slice(cursor, match.index)) + redactUrl(match[0]);
    cursor = match.index + match[0].length;
  }
  return output + redactLocalPaths(text.slice(cursor));
}
