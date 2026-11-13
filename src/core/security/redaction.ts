const DATA_URL_PREFIX_PATTERN = /data:/gi;
const BASE64_PAYLOAD_CHARACTER = /^[a-zA-Z0-9+/_=-]$/;
/** Characters that end a path: whitespace, quotes, angle brackets, and Chinese/Japanese full-width punctuation. */
const PATH_STOP = /[\s"'`<>，。；：！？、）】」』》]/u;
/** Trailing characters that belong to the sentence or the markup around a path, not to the path. */
const TRAILING_PUNCTUATION = /[.,;:!?*]$/;
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

/** What can stand right before a lone `/name` without it being a divisor (`(¥3)/year`, `12%/year`). */
const DIVISOR_BEFORE = /[)\]）】%]/;
/** A file name with an extension (`/a.png`), or a plain ASCII name (`/tmp`, `/etc`). */
const FILE_NAME = /\.[A-Za-z0-9]{1,8}$/;
const ASCII_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Whether a path that starts with `/`, `~/` or `../` names a place on this
 * machine, told by its shape and never by which folder it starts in (any
 * root, any case, any language): `~/x`, a path through a user's folder, a
 * path of two or more segments (`/a/b`), or a lone `/name` that is a file
 * name or a plain ASCII name (`/tmp`) and does not follow a closing bracket
 * or percent sign (inside `<…>` a lone name is a closing tag, as in `</div>`). A lone `/年` or `/个` is a divisor in prose, not a path.
 */
function isLocalPosixPath(path: string, before = '', loneNameCounts = true): boolean {
  const segments = segmentsOf(path);
  if (segments[0] === '~') return segments.length > 1 && segments[1] !== '';
  if (segments.some((segment, i) => USER_FOLDERS.has(segment) && (segments[i + 1] ?? '') !== '')) return true;
  if (segments[0] !== '') return false;
  const names = segments.slice(1).filter(Boolean);
  if (names.length >= 2) return true;
  if (names.length === 0) return false;
  return loneNameCounts && !DIVISOR_BEFORE.test(before) && (FILE_NAME.test(names[0]) || ASCII_NAME.test(names[0]));
}

/** Words after a path that may still belong to it: one space apart, on the same line. */
const FOLLOWING_WORDS = /^(?: [^\s"'`<>，。；：！？、）】」』》]+)+/u;
/** Most words a folder or file name may hold after the space that ends a segment. */
const NAME_WORDS_MAX = 4;
/** A word that begins a new path, so it is not the rest of this one. */
const PATH_WORD_START = /^(?:[A-Za-z]:[\\/]|\\\\|[\\/]|~[\\/]|\.\.[\\/])/;
/** `and/or`, `TCP/IP`: a slash between two plain words. */
const SLASHED_WORDS = /^[A-Za-z]+\/[A-Za-z]+$/;
const FILE_NAME_WORD = /^[^\s\\/]+\.[A-Za-z0-9]{1,5}$/;

/**
 * Whether the words after a space, taken as the rest of a name under a user's
 * folder, reach the end of the path: a word with a separator inside it
 * (`Folder\contract.pdf`) or, when the segment so far has no extension, a file
 * name (`b.docx`), within `NAME_WORDS_MAX` words and before any word that ends a
 * sentence. Prose after the path (`and then closed the file.`) reaches neither.
 */
function nameContinues(following: string, lastSegment: string): boolean {
  if (TRAILING_PUNCTUATION.test(lastSegment)) return false;
  const words = (FOLLOWING_WORDS.exec(following)?.[0] ?? '').slice(1).split(' ').slice(0, NAME_WORDS_MAX);
  for (const word of words) {
    // After a file name (`a.pdf and/or …`) a slash between two plain words is prose.
    const prose = lastSegment.includes('.') && SLASHED_WORDS.test(word);
    const separated = /[\\/]/.test(word) && !PATH_WORD_START.test(word) && !prose;
    if (separated || (!lastSegment.includes('.') && FILE_NAME_WORD.test(word))) return true;
    if (PATH_WORD_START.test(word) || TRAILING_PUNCTUATION.test(word)) return false;
  }
  return false;
}

/**
 * Where a path that starts at `start` ends. A path ends at `PATH_STOP`, except
 * that names under a user's folder (`~` included) may hold several spaces (`C:\Users\Zhang San\AppData\…`,
 * `…/Library/Application Support/…`, `My Great Folder/contract.pdf`): at a space
 * the path goes on when `nameContinues` finds its end in the next few words. Trailing
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
    const userAt = segments.findIndex((segment) => /^(users|home)$/i.test(segment));
    // A leading `~` is the user folder itself.
    const underUser = (userAt >= 0 && (segments[userAt + 1] ?? '') !== '') || (segments[0] === '~' && (segments[1] ?? '') !== '');
    if (!underUser || !nameContinues(text.slice(end), segments[segments.length - 1])) break;
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
function replacePaths(text: string, starts: RegExp, redact: (path: string, before: string) => boolean): string {
  let output = '';
  let cursor = 0;
  starts.lastIndex = 0;
  for (let match = starts.exec(text); match; match = starts.exec(text)) {
    if (match.index < cursor) continue;
    const end = pathEnd(text, match.index);
    if (!redact(text.slice(match.index, end), text[match.index - 1] ?? '')) continue;
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
const POSIX_PATH_START = /(?<![A-Za-z0-9_\p{M}.~/<-])\/(?!\/)|(?<![\p{L}\p{N}\p{M}_.~/\\-])~(?=[\\/])|(?<![\p{L}\p{N}_.~/\\-])(?:\.\.[\\/])+/gu;

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
 * a `file://` URL, a POSIX path (any root; see `isLocalPosixPath` for the
 * shapes that count), `~/…`, or any path through a user's folder (`…/Users/<name>`).
 * Colon-prefixed labels like `output:/tmp/a.png` count; an angle-bracketed
 * path may hold spaces (`</Users/a b.png>`) while HTML closing tags such as
 * `</div>` stay. A slash inside a word, a number or a URL (`https://host/Users/x`,
 * `元/年`, `and/or`, `2026/09/28`, `首页/Home`) starts no path.
 */
export function redactSensitiveMediaText(value: string): string {
  const text = redactInlineMediaPayloads(value).replace(ANGLE_PATH, (whole, inner: string) => (
    /^[A-Za-z]:|^\\\\/.test(inner) || isLocalPosixPath(inner, '', false) ? '<[REDACTED:path]>' : whole
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
