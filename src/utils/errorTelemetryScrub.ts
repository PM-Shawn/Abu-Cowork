/**
 * What an automatic error report is allowed to carry off the machine.
 *
 * `reportError` is the single funnel for every automatic remote report — the
 * agent loop's api_error/agent_crash, the shell crash channel's
 * main/renderer crashes, and the sidecar crash-loop breaker all go through
 * it. Until now it forwarded `Error.message` with only four credential-shaped
 * patterns replaced, so anything else the message happened to carry left the
 * machine intact:
 *
 *     ENOENT: no such file or directory, open '/Users/alice/客户方案/plan.docx'
 *
 * Provider response bodies were already kept local (`rawBody` is hardcoded
 * `null`); this closes the same hole for the message itself.
 *
 * The approach is normalisation, not deletion. A category code alone would
 * make a brand-new failure unreadable ("something broke, 240 times"), so the
 * message keeps its diagnostic skeleton and loses every span that could
 * carry user content:
 *
 *     ENOENT: no such file or directory, open <str>
 *
 * That still says exactly what failed, groups cleanly, and names nothing.
 * The raw message is untouched locally — the runtime-observability log and
 * the user-initiated diagnostic bundle both still have it, which is where
 * root-causing actually happens.
 *
 * KNOWN LIMIT, stated so nobody reads this as a guarantee it does not make:
 * normalisation removes spans that have a recognisable SHAPE — paths, URLs,
 * emails, CJK runs, quoted spans, credential formats. A bare unquoted latin
 * token cannot be told apart from ordinary error prose ("board-memo" and
 * "connection refused" are the same shape), so one can still ride along in a
 * message like `Unknown provider board-memo`. Closing that last gap means
 * dropping the message entirely and reporting `errorType` + `errorCode` +
 * `fingerprint` only. That remains a one-line change here — the fingerprint
 * is computed from the normalised text, so grouping survives it — and is a
 * product call about how readable the remote signal has to be, not a
 * technical blocker.
 */

/** Credential shapes — kept from the original `safeErrorMessage`. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{12,}/g,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g,
  /\bBearer\s+[a-zA-Z0-9._\-+/=]{8,}/gi,
  /\b(?:token|api[_-]?key|password|secret|authorization)\s*[=:]\s*\S+/gi,
];

/**
 * Content-bearing spans, in the order they must run.
 *
 * URLs go before paths: a URL's own path segment would otherwise be eaten by
 * the POSIX-path rule and leave a bare scheme behind. Quoted spans go last
 * so the more specific replacements above have already claimed what they can
 * — an `open '<path>'` reads better than an opaque `open <str>`.
 */
const CONTENT_PATTERNS: Array<[RegExp, string]> = [
  [/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`)]+/g, '<url>'],
  [/\b[^\s'"`<>@]+@[^\s'"`<>@]+\.[a-zA-Z]{2,}\b/g, '<email>'],
  // Windows absolute paths (drive-letter or UNC) before POSIX, since a UNC
  // path starts with separators the POSIX rule would not claim anyway but the
  // drive-letter form contains no leading slash at all.
  [/\b[a-zA-Z]:[\\/][^\s'"`<>|?*]*/g, '<path>'],
  [/\\\\[^\s'"`<>|?*]+/g, '<path>'],
  [/(?<![\w<])\/(?:[^\s'"`<>|?*/]+\/)*[^\s'"`<>|?*/]*/g, '<path>'],
  // Any run of CJK is user content by construction — no runtime error
  // message this app produces is written in Chinese (AGENTS.md §1 keeps
  // code, comments and LLM-facing prompts English), so a CJK run can only
  // have come from data: a filename, a conversation title, a customer name.
  [/[㐀-䶿一-鿿぀-ヿ가-힯]+/g, '<text>'],
  // Quoted spans last — the catch-all for interpolated values that none of
  // the shape rules above recognised.
  [/'[^']*'|"[^"]*"|`[^`]*`/g, '<str>'],
];

const MAX_ERROR_MESSAGE_CHARS = 500;

/** Control characters, minus \t \n \r, which stay readable in a log line. */
function stripControlChars(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
      ? ''
      : char;
  }).join('');
}

/**
 * Reduce an error message to its shape: diagnostic skeleton in, user content
 * out. Returns `null` for an empty/absent message so the caller can send
 * `null` rather than an empty string.
 */
export function normalizeErrorMessage(value: string | undefined): string | null {
  if (!value) return null;
  let result = value;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[REDACTED]');
  for (const [pattern, replacement] of CONTENT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  const cleaned = stripControlChars(result).slice(0, MAX_ERROR_MESSAGE_CHARS);
  return cleaned === '' ? null : cleaned;
}

/**
 * Stable 32-bit FNV-1a over the NORMALISED message, so identical failures
 * group together across machines while differing only in redacted spans.
 * Deliberately not a cryptographic digest: this is a grouping key, it must
 * be synchronous (`crypto.subtle` is async), and it is computed over text
 * that already carries no user content.
 */
export function errorFingerprint(normalizedMessage: string | null): string | null {
  if (!normalizedMessage) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalizedMessage.length; i++) {
    hash ^= normalizedMessage.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
