/**
 * The one list of credential shapes that every place which strips secrets from
 * text on its way out (runtime traces, error telemetry, Langfuse, the
 * diagnostic bundle, the Electron main process) reads. A key is cut at 12
 * characters and a JWT part or bearer token at 8, so a short or truncated
 * credential never survives in one place and not another.
 *
 * Bundled for the Electron main process into electron/generated/secretPatterns.cjs
 * (npm run gen:secret-patterns), which cannot import TypeScript.
 */

/** `sk-` and `sk-ant-` API keys. */
export const SK_KEY_PATTERN = /\bsk-[a-zA-Z0-9_-]{12,}/g;
/** Three base64url parts separated by dots. */
export const JWT_PATTERN = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g;
/** `Bearer <token>`. */
export const BEARER_PATTERN = /\bBearer\s+[a-zA-Z0-9._\-+/=]{8,}/gi;
/** `token=…`, `api_key: …`, `password=…`: the name and the value after it. */
export const KEY_VALUE_PATTERN = /\b(?:token|api[_-]?key|password|secret|authorization)\s*[=:]\s*\S+/gi;

/** What a trace or telemetry string is scrubbed with, in order. */
export const TRACE_SECRET_PATTERNS: readonly RegExp[] = [
  SK_KEY_PATTERN,
  JWT_PATTERN,
  BEARER_PATTERN,
  KEY_VALUE_PATTERN,
];

/** Replace every credential shape in `value` with `[REDACTED]`. */
export function redactTraceSecrets(value: string): string {
  let result = value;
  for (const pattern of TRACE_SECRET_PATTERNS) result = result.replace(pattern, '[REDACTED]');
  return result;
}
