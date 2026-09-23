import type { ToolDefinition } from '@/types';

export type InventorySource = { kind: 'builtin' } | { kind: 'mcp'; server: string };
export type InventoryReason =
  | { kind: 'labs-gated'; experimentId: string }
  | { kind: 'mcp-disabled'; server: string }
  | { kind: 'mcp-not-connected'; server: string; status: string; error?: string }
  | { kind: 'duplicate-browser-tool'; server: string };

export interface InventoryCandidate {
  name: string;
  source: InventorySource;
  definition?: ToolDefinition;
  /** Connection errors must be sanitized before becoming candidates. */
  unavailableReasons: InventoryReason[];
}

/** Merge known and live definitions without losing a disabled gate. Builtins win. */
export function mergeToolInventory(candidates: readonly InventoryCandidate[]): InventoryCandidate[] {
  const entries = new Map<string, InventoryCandidate>();
  for (const candidate of candidates) {
    const previous = entries.get(candidate.name);
    if (!previous || (previous.source.kind !== 'builtin' && candidate.source.kind === 'builtin')) {
      entries.set(candidate.name, { ...candidate, unavailableReasons: [...candidate.unavailableReasons] });
    } else if (previous.source.kind !== 'builtin' && candidate.source.kind !== 'builtin') {
      const reasons = new Map(
        [...previous.unavailableReasons, ...candidate.unavailableReasons].map(reason => [JSON.stringify(reason), reason]),
      );
      entries.set(candidate.name, {
        ...previous,
        definition: previous.definition ?? candidate.definition,
        unavailableReasons: [...reasons.values()],
      });
    }
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Coarse, leak-free classification of a raw MCP connection error string.
 * Recognized categories cover the common failure shapes well enough to be
 * actionable ("auth-failed" tells the user to check credentials) without
 * repeating the raw message.
 */
export type McpErrorCategory =
  | 'timeout'
  | 'connection-refused'
  | 'dns-failure'
  | 'auth-failed'
  | 'not-found'
  | 'permission-denied'
  | 'unknown';

const MCP_ERROR_CATEGORY_PATTERNS: readonly (readonly [McpErrorCategory, RegExp])[] = [
  ['timeout', /timed?\s*out|ETIMEDOUT/i],
  ['connection-refused', /ECONNREFUSED|connection refused/i],
  ['dns-failure', /ENOTFOUND|EAI_AGAIN|getaddrinfo|dns lookup/i],
  ['auth-failed', /\b401\b|\b403\b|unauthorized|forbidden|invalid[ _-]?(api[ _-]?)?key|invalid[ _-]?token/i],
  ['not-found', /ENOENT|command not found/i],
  ['permission-denied', /EACCES|permission denied/i],
];

export function classifyMcpErrorCategory(raw: string): McpErrorCategory {
  for (const [category, pattern] of MCP_ERROR_CATEGORY_PATTERNS) {
    if (pattern.test(raw)) return category;
  }
  return 'unknown';
}

const MAX_SANITIZED_MCP_ERROR_LENGTH = 160;

/**
 * Strip a raw MCP connection error of anything that could leak into the
 * LLM's context: URL query strings (may carry an API token/secret) and
 * absolute filesystem paths (may carry the OS username) are removed,
 * keeping only a path's basename. Used as the fallback when
 * `classifyMcpErrorCategory` can't recognize the shape — the category is
 * always preferred when available (see `summarizeMcpConnectionError`).
 */
export function sanitizeMcpError(raw: string): string {
  let s = raw
    // Strip URL query strings — "?token=abc123" and everything after it up
    // to the next whitespace/quote/paren.
    .replace(/\?[^\s"')]*/g, '')
    // Absolute Unix path -> basename only ("/Users/alice/x/y.txt" -> "y.txt").
    .replace(/(?:\/[^\s"'()]+)+\/([^\s"'()/]+)/g, '$1')
    // Absolute Windows path -> basename only ("C:\Users\alice\x.txt" -> "x.txt").
    .replace(/[A-Za-z]:\\(?:[^\s"'()\\]+\\)+([^\s"'()\\]+)/g, '$1');
  if (s.length > MAX_SANITIZED_MCP_ERROR_LENGTH) {
    s = s.slice(0, MAX_SANITIZED_MCP_ERROR_LENGTH) + '…';
  }
  return s;
}

/**
 * Turn a raw `MCPServerEntry.error` into something safe to hand the LLM:
 * a bare category name when recognized ("timeout", "auth-failed", ...),
 * else a query-string-stripped, path-redacted, length-capped fallback.
 * `undefined` in, `undefined` out.
 */
export function summarizeMcpConnectionError(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const category = classifyMcpErrorCategory(raw);
  return category !== 'unknown' ? category : sanitizeMcpError(raw);
}
