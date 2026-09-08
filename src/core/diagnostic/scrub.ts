/**
 * Diagnostic scrubbing — pure functions that take in-memory state objects
 * and return JSON-safe redacted copies for inclusion in the diagnostic
 * bundle.
 *
 * Two distinct concerns are handled here:
 *
 * 1. **Secret redaction** (always on, no opt-out): API keys, tokens, anything
 *    that matches a known secret-shaped pattern. Failing to redact a secret
 *    is a much worse outcome than over-redacting; tests cover both layered
 *    defenses (field-name match + regex match on string values).
 *
 * 2. **Binary stripping** (always on, no opt-out): base64-encoded images and
 *    binaries get replaced with metadata placeholders like
 *    `[image: 312KB png]`. This is purely for bundle size — diagnostic
 *    debugging value of binary data is low and the user can always re-attach
 *    the original.
 *
 * 3. **Text scrubbing** (default on, opt-out via `includeRawText`): user/
 *    assistant message text and thinking content get replaced with size
 *    placeholders. tool_use input/result are preserved fully because that's
 *    where 95% of debugging signal lives — with one structural exception:
 *    browser fill values (see the fill section below), which are always
 *    redacted because a filled password has no detectable shape.
 */

import type { Message, MessageContent, ToolCall } from '@/types';
import { sanitizeMemoryText } from '@/core/memdir/sanitize';

// ════════════════════════════════════════════════════════════════════════
// Secret redaction
// ════════════════════════════════════════════════════════════════════════

const REDACTED = '[REDACTED]';

/**
 * Field names whose values are scrubbed regardless of content shape.
 * Match is case-insensitive and substring-based, so `userApiKey` /
 * `oauth_token` both match.
 */
const SECRET_FIELD_PATTERNS = [
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'auth',
  'authorization',
  'credential',
  'private_key',
];

/**
 * Field names that look like secrets (contain a pattern from SECRET_FIELD_PATTERNS)
 * but are actually benign config values that should remain visible in bundles.
 * "token" matches "maxOutputTokens", "contextWindowSize" matches nothing but
 * was previously redacted by a wider rule — list here proactively.
 */
const SECRET_FIELD_ALLOWLIST = new Set([
  'maxtokens',
  'maxoutputtokens',
  'maxtokenslimit',
  'contextwindowsize',
  'numtokens',
  'tokenlimit',
  'tokencount',
  'tokenbudget',
  'tokenizer',
]);

/**
 * Regex patterns that flag secret-shaped strings even when they show up in
 * unexpected places (e.g. inside log lines or tool output text).
 *
 * Tuned to minimise false positives — short hex strings and casual base64
 * fragments don't match. False negatives are far more dangerous than false
 * positives, but spamming `[REDACTED]` over normal content kills the
 * bundle's debug value.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic style: sk-... or sk-ant-...
  /\bsk-[a-zA-Z0-9_-]{20,}/g,
  // JWT (3 base64-url segments separated by dots, total 30+ chars)
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g,
  // Bearer header
  /\bBearer\s+[a-zA-Z0-9._\-+/=]{16,}/gi,
  // GitHub PAT
  /\bghp_[a-zA-Z0-9]{30,}/g,
  // Google API key
  /\bAIza[a-zA-Z0-9_-]{30,}/g,
];

// Secret-looking key/value pairs embedded inside plain log strings, where
// recursive field-name scrubbing cannot see the serialized object shape.
const SERIALIZED_SECRET_VALUE_PATTERN =
  /\b(api[_-]?key|access[_-]?token|token|password|secret|authorization)(["']?\s*[:=]\s*["']?)([^"',}\s]+)/gi;

// ════════════════════════════════════════════════════════════════════════
// Browser fill values (v0.42.0 incident: a login password left the machine
// in a diagnostic bundle via the abu-browser fill tool's echoed result)
// ════════════════════════════════════════════════════════════════════════
//
// A filled value is an arbitrary user string — passwords have no detectable
// shape — so this redaction is STRUCTURAL, keyed off the tool name: the
// `value` input of a fill-shaped tool IS the filled value, and that exact
// string is erased wherever the same call's result echoes it. The two regex
// backstops below catch echoes in conversations recorded before the
// extension itself stopped echoing sensitive values (≤ v0.42.x).

/** fill (abu-browser / bridge-local) and form_input (external browser MCPs). */
const FILL_TOOL_NAME_RE = /(^|__)(fill|form_input)$/;
/** The abu-browser batch tool — its `steps` JSON string carries fill values. */
const BROWSER_BATCH_TOOL_NAME_RE = /(^|__)batch$/;
const FILL_VALUE_REDACTED = '[REDACTED:fill-value]';

/**
 * `Filled field with "<value>"` — the ≤ v0.42.x echo shape, in both raw and
 * JSON-escaped (`\"`) forms. `(?!\[)` skips values already replaced by an
 * upstream marker (`[value redacted]`, `[REDACTED…]`) so the pass is
 * idempotent and never hides that redaction happened at the source.
 */
const FILLED_ECHO_RE = /(Filled field with \\?")(?!\[)((?:[^"\\]|\\.)*?)(\\?")/g;

/**
 * `"previousValue":"<value>"` in serialized fill results — what the field
 * held BEFORE the fill (a browser-autofilled password, a saved card), which
 * exact-value erasure cannot know.
 */
const PREVIOUS_VALUE_RE = /(\\?"previousValue\\?"\s*:\s*\\?")(?!\[)((?:[^"\\]|\\.)*?)(\\?")/g;

/**
 * Exact-erasing values shorter than this from result text is skipped — a 1–3
 * char value ("1", "ok") would mangle unrelated result text. The structural
 * input redaction above has no such floor.
 */
const MIN_FILL_VALUE_ERASE_LENGTH = 4;

/** Erase each filled value — and its JSON-escaped form — from a string. */
function eraseFillValues(s: string, values: string[]): string {
  let out = s;
  for (const v of values) {
    out = out.split(v).join(FILL_VALUE_REDACTED);
    const escaped = JSON.stringify(v).slice(1, -1);
    if (escaped !== v) out = out.split(escaped).join(FILL_VALUE_REDACTED);
  }
  return out;
}

/**
 * Deep-walk a JSON-shaped value, applying `fn` to every string. Pure; guards
 * against cycles the same way scrubSecrets does (inputs are tree-shaped in
 * practice, but a cycle must degrade, not hang).
 */
function mapStrings(
  value: unknown,
  fn: (s: string) => string,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return fn(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = mapStrings(v, fn, seen);
  }
  return out;
}

/**
 * Redact fill-step values inside a batch tool's `steps` JSON string, and
 * report them so the caller can erase their echoes from the result. Select /
 * click steps stay readable — a dropdown option is debugging signal, not a
 * secret. An unparseable payload gets every `"value"` redacted instead:
 * over-redacting a malformed input beats letting one slip through.
 */
function redactBatchStepsInput(steps: string): { steps: string; fillValues: string[] } {
  try {
    const parsed: unknown = JSON.parse(steps);
    if (!Array.isArray(parsed)) throw new Error('steps is not an array');
    const fillValues: string[] = [];
    const redacted = parsed.map((step) => {
      if (
        step && typeof step === 'object' && !Array.isArray(step) &&
        (step as Record<string, unknown>).action === 'fill' &&
        typeof (step as Record<string, unknown>).value === 'string' &&
        (step as Record<string, unknown>).value !== ''
      ) {
        fillValues.push((step as Record<string, unknown>).value as string);
        return { ...(step as Record<string, unknown>), value: FILL_VALUE_REDACTED };
      }
      return step;
    });
    return { steps: JSON.stringify(redacted), fillValues };
  } catch {
    return {
      steps: steps.replace(
        /(\\?"value\\?"\s*:\s*\\?")(?!\[)((?:[^"\\]|\\.)*?)(\\?")/g,
        `$1${FILL_VALUE_REDACTED}$3`,
      ),
      fillValues: [],
    };
  }
}

function isSecretField(key: string): boolean {
  const lower = key.toLowerCase();
  if (SECRET_FIELD_ALLOWLIST.has(lower)) return false;
  return SECRET_FIELD_PATTERNS.some((p) => lower.includes(p));
}

function redactStringValue(s: string): string {
  let out = s.replace(
    SERIALIZED_SECRET_VALUE_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  // Browser-fill echo backstops — see the fill section above.
  out = out.replace(FILLED_ECHO_RE, `$1${REDACTED}$3`);
  out = out.replace(PREVIOUS_VALUE_RE, `$1${REDACTED}$3`);
  // M1 parity: the memory write funnel's credential detector (vendor-prefixed
  // shapes via shareRedactor + keyword-context bare credentials) knows shapes
  // this file's own regexes miss. Reusing it keeps the two channels from
  // drifting: what the memory gate redacts must not sail through a bundle.
  out = sanitizeMemoryText(out).text;
  return out;
}

/**
 * Recursively walk an arbitrary JSON-shaped value, redacting secret fields
 * and secret-shaped strings. Returns a new value; never mutates input.
 *
 * Handles cycles defensively by tracking visited objects, though our
 * inputs (settings, store snapshots) are tree-shaped in practice.
 */
export function scrubSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactStringValue(value);
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => scrubSecrets(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretField(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = scrubSecrets(v, seen);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// Binary stripping (always on)
// ════════════════════════════════════════════════════════════════════════

/**
 * Estimate the original binary size from a base64 string length.
 * `base64Length * 0.75 ≈ raw bytes` (ignoring padding rounding).
 */
function estimateBytesFromBase64(b64Length: number): number {
  return Math.round(b64Length * 0.75);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Replace embedded base64 image / document blocks with size-only placeholder
 * text blocks. Pure — never mutates input.
 */
export function stripBinaryContent(content: MessageContent[]): MessageContent[] {
  return content.map((block) => {
    if (block.type === 'image') {
      const bytes = estimateBytesFromBase64(block.source.data.length);
      const mediaType = block.source.media_type.replace(/^image\//, '');
      return { type: 'text', text: `[image: ${formatSize(bytes)} ${mediaType}]` } as MessageContent;
    }
    if (block.type === 'document') {
      const bytes = estimateBytesFromBase64(block.source.data.length);
      return { type: 'text', text: `[document: ${formatSize(bytes)} pdf]` } as MessageContent;
    }
    return block;
  });
}

// ════════════════════════════════════════════════════════════════════════
// Message scrubbing
// ════════════════════════════════════════════════════════════════════════

interface ScrubMessageOpts {
  /** When true, message text is preserved (still secret-redacted). */
  includeRawText: boolean;
}

function scrubText(s: string, opts: ScrubMessageOpts): string {
  if (opts.includeRawText) {
    return redactStringValue(s);
  }
  // Replace with size placeholder
  return `[text: ${s.length} chars]`;
}

/**
 * Scrub a single tool call. The structural fields (name, input, result) are
 * always preserved — they're the highest-value debugging signal. Result
 * content gets secret-scanned but never truncated.
 */
function scrubToolCall(tc: ToolCall): unknown {
  // Structural fill-value redaction — see the fill section at the top.
  let input = tc.input;
  let fillValues: string[] = [];
  if (FILL_TOOL_NAME_RE.test(tc.name) && typeof input?.value === 'string' && input.value !== '') {
    fillValues = [input.value];
    input = { ...input, value: FILL_VALUE_REDACTED };
  } else if (BROWSER_BATCH_TOOL_NAME_RE.test(tc.name) && typeof input?.steps === 'string') {
    const redacted = redactBatchStepsInput(input.steps);
    input = { ...input, steps: redacted.steps };
    fillValues = redacted.fillValues;
  }
  fillValues = fillValues.filter((v) => v.length >= MIN_FILL_VALUE_ERASE_LENGTH);
  const erase = (s: string) => eraseFillValues(s, fillValues);

  const out: Record<string, unknown> = {
    id: tc.id,
    name: tc.name,
    input: scrubSecrets(input),
    isExecuting: tc.isExecuting ?? false,
  };
  if (tc.result !== undefined) {
    out.result = redactStringValue(fillValues.length > 0 ? erase(tc.result) : tc.result);
  }
  if (tc.resultContent !== undefined) {
    const content = fillValues.length > 0 ? mapStrings(tc.resultContent, erase) : tc.resultContent;
    out.resultContent = scrubSecrets(content);
  }
  if (tc.hidden) out.hidden = true;
  return out;
}

/**
 * Scrub an entire message: handles string and array content, strips binaries,
 * scrubs thinking, scrubs each tool call.
 */
export function scrubMessage(m: Message, opts: ScrubMessageOpts): unknown {
  const out: Record<string, unknown> = {
    id: m.id,
    role: m.role,
    timestamp: m.timestamp,
  };
  if (m.loopId) out.loopId = m.loopId;
  if (m.skill) out.skill = scrubSecrets(m.skill);

  // Content: string vs MessageContent[]
  if (typeof m.content === 'string') {
    out.content = scrubText(m.content, opts);
  } else {
    const stripped = stripBinaryContent(m.content);
    out.content = stripped.map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: scrubText(block.text, opts) };
      }
      return block; // image/document already replaced by stripBinaryContent
    });
  }

  if (m.thinking) out.thinking = scrubText(m.thinking, opts);
  if (m.usage) out.usage = m.usage;
  if (m.isStreaming) out.isStreaming = true;
  if (m.toolCalls && m.toolCalls.length > 0) {
    out.toolCalls = m.toolCalls.map(scrubToolCall);
  }
  if (m.executionSteps) {
    // executionSteps may carry text fields; recurse via scrubSecrets +
    // redact text inside those structures. Conservative — preserve structure.
    out.executionSteps = scrubSecrets(m.executionSteps);
  }
  return out;
}
