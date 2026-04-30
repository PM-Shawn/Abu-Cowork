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
 *    where 95% of debugging signal lives.
 */

import type { Message, MessageContent, ToolCall } from '@/types';

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

function isSecretField(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_FIELD_PATTERNS.some((p) => lower.includes(p));
}

function redactStringValue(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
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
  const out: Record<string, unknown> = {
    id: tc.id,
    name: tc.name,
    input: scrubSecrets(tc.input),
    isExecuting: tc.isExecuting ?? false,
  };
  if (tc.result !== undefined) {
    out.result = redactStringValue(tc.result);
  }
  if (tc.resultContent !== undefined) {
    out.resultContent = scrubSecrets(tc.resultContent);
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
