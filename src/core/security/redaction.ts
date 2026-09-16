const DATA_URL_PREFIX_PATTERN = /data:/gi;
const BASE64_PAYLOAD_CHARACTER = /^[a-zA-Z0-9+/_=-]$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s"'`<>]*/g;
const UNC_ABSOLUTE_PATH_PATTERN = /\\\\[^\s"'`<>]*/g;
const FILE_URI_ABSOLUTE_PATH_PATTERN = /(file:\/\/)\/[^\s"'`<>]*/gi;
const ANGLE_ABSOLUTE_PATH_PATTERN = /<(?:(?:\/(?=[^>\r\n]*[\\/]))|(?:[A-Za-z]:[\\/])|(?:\\\\))[^>\r\n]*>/g;
const GENERIC_UNIX_ABSOLUTE_PATH_PATTERN = /(?<![/\w<])\/(?!\/)[^\s"'`<>]*/g;

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

/**
 * Redact media-bearing transport/telemetry text without treating ordinary
 * URLs as local filesystem paths. Explicit sidecar/file prefixes are handled
 * before the generic POSIX rule because the generic rule allows colon-prefixed
 * labels like `output:/tmp/a.png`; a dedicated angle-bracket path rule catches
 * `</Users/a.png>` while preserving simple HTML closing tags such as `</div>`.
 * URL schemes stay intact through the leading-slash `(?!/)` guard plus the
 * slash/word/angle negative lookbehind.
 */
export function redactSensitiveMediaText(value: string): string {
  return redactInlineMediaPayloads(value)
    .replace(ANGLE_ABSOLUTE_PATH_PATTERN, '<[REDACTED:path]>')
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, '[REDACTED:path]')
    .replace(UNC_ABSOLUTE_PATH_PATTERN, '[REDACTED:path]')
    .replace(FILE_URI_ABSOLUTE_PATH_PATTERN, '$1[REDACTED:path]')
    .replace(GENERIC_UNIX_ABSOLUTE_PATH_PATTERN, '[REDACTED:path]');
}
