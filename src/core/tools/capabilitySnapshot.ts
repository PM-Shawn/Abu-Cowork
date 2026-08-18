/**
 * Capability snapshot — a read-only inventory of which tools are ACTUALLY
 * usable right now, and why any tool isn't. Answers "what can the agent do
 * in this session" (Abu's analogue of Claude Code's `/context`), pulling
 * every judgment from the real gating logic instead of re-deriving it:
 *
 * - Labs gating: `isToolGatedOff` / `getToolLabsGateId` — the exact functions
 *   `getAllTools()` uses (registry.ts), not a second copy of the gate map.
 * - MCP connection status: `useMCPStore` — the same store the customize
 *   panel and the diagnostic MCP check (`diagnostic/checks/mcp.ts`) read.
 * - Duplicate-browser filtering: `PLAYWRIGHT_BROWSER_TOOLS` — the exact set
 *   `getAllTools()` filters when Abu's own browser is connected.
 * - Enterprise policy: `checkTool(getCurrentPolicy(), name, '')` — a
 *   best-effort, no-input probe through the real policy matcher (OSS builds
 *   always resolve to `{decision:'allow'}` via the stub).
 * - `permissionMode` / `computerUseEnabled`: read straight from
 *   `settingsStore` — no re-implementation of their semantics.
 *
 * This module only computes structured data; `definitions/capabilitySnapshotTool.ts`
 * formats it into an i18n'd, user-facing report string.
 */

import type { ToolDefinition } from '../../types';
import type { PermissionMode } from '../permissions/permissionMode';
import { toolRegistry, isToolGatedOff, getToolLabsGateId, PLAYWRIGHT_BROWSER_TOOLS } from './registry';
import { mcpManager } from '../mcp/client';
import { useMCPStore } from '../../stores/mcpStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getCurrentPolicy } from '../enterprise/policy/enforcer';
import { checkTool } from '../enterprise/policy/matcher';

export type CapabilitySource =
  | { kind: 'builtin' }
  | { kind: 'mcp'; server: string };

/** A single, real (non-guessed) reason a tool is currently unusable. */
export type UnavailableReason =
  | { kind: 'labs-gated'; experimentId: string }
  | { kind: 'mcp-disabled'; server: string }
  /** `error`, when present, is ALREADY sanitized by `summarizeMcpConnectionError`
   *  below — never the raw `MCPServerEntry.error` string. Raw MCP connection
   *  errors can carry a URL with a query-string token, or an absolute
   *  filesystem path revealing the OS username, and this reason's text is
   *  read directly by the LLM (capability_snapshot's tool result). */
  | { kind: 'mcp-not-connected'; server: string; status: string; error?: string }
  | { kind: 'duplicate-browser-tool'; server: string }
  | { kind: 'policy-denied'; reason?: string };

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

export type ConcurrencySafety = 'safe' | 'unsafe' | 'input-dependent';

export interface CapabilityEntry {
  name: string;
  source: CapabilitySource;
  /** Empty when the tool is fully active. */
  unavailableReasons: UnavailableReason[];
  concurrencySafety: ConcurrencySafety;
  /** Enterprise policy pre-check against this tool NAME with no concrete
   *  input — real for name-level policies, best-effort for input-dependent
   *  ones (the actual decision at call time may differ). */
  policy: { decision: 'allow' | 'confirm' | 'deny'; reason?: string };
}

export interface CapabilitySnapshot {
  permissionMode: PermissionMode;
  computerUseEnabled: boolean;
  entries: CapabilityEntry[];
}

function classifyConcurrencySafety(tool: ToolDefinition | undefined): ConcurrencySafety {
  if (!tool) return 'unsafe';
  if (typeof tool.isConcurrencySafe === 'function') return 'input-dependent';
  return tool.isConcurrencySafe === true ? 'safe' : 'unsafe';
}

function policyProbe(name: string): CapabilityEntry['policy'] {
  const result = checkTool(getCurrentPolicy(), name, '');
  return { decision: result.decision, reason: result.reason };
}

/**
 * Compute the full capability snapshot. Pure read — no side effects, no
 * network calls (MCP status comes from the already-maintained store, not a
 * fresh probe).
 */
export function computeCapabilitySnapshot(): CapabilitySnapshot {
  const entries: CapabilityEntry[] = [];
  const seenNames = new Set<string>();

  const hasAbuBrowser =
    mcpManager.isConnected('abu-browser') || mcpManager.isConnected('abu-browser-bridge');

  // 1. Builtin tools — includes Labs-gated ones (toolRegistry.getAll() does
  //    NOT apply the Labs filter; getAllTools() does that on top of it).
  //    Builtin tools always take priority over an MCP tool of the same name,
  //    mirroring getAllTools()'s dedup order.
  for (const tool of toolRegistry.getAll()) {
    seenNames.add(tool.name);
    const unavailableReasons: UnavailableReason[] = [];
    const experimentId = getToolLabsGateId(tool.name);
    if (experimentId !== undefined && isToolGatedOff(tool.name)) {
      unavailableReasons.push({ kind: 'labs-gated', experimentId });
    }
    const policy = policyProbe(tool.name);
    if (policy.decision === 'deny') {
      unavailableReasons.push({ kind: 'policy-denied', reason: policy.reason });
    }
    entries.push({
      name: tool.name,
      source: { kind: 'builtin' },
      unavailableReasons,
      concurrencySafety: classifyConcurrencySafety(tool),
      policy,
    });
  }

  // 2. MCP tools — walk every CONFIGURED server (useMCPStore), not just the
  //    live-connected mcpManager map, so a disabled/disconnected/errored
  //    server's tools still show up with the real reason instead of
  //    silently disappearing from the snapshot.
  const mcpServers = useMCPStore.getState().servers;
  for (const [serverName, serverEntry] of Object.entries(mcpServers)) {
    for (const toolInfo of serverEntry.tools) {
      if (seenNames.has(toolInfo.name)) continue; // builtin name collision — builtin wins
      seenNames.add(toolInfo.name);

      const unavailableReasons: UnavailableReason[] = [];
      if (!serverEntry.config.enabled) {
        unavailableReasons.push({ kind: 'mcp-disabled', server: serverName });
      } else if (serverEntry.status !== 'connected') {
        unavailableReasons.push({
          kind: 'mcp-not-connected',
          server: serverName,
          status: serverEntry.status,
          // Sanitized — see summarizeMcpConnectionError's doc. Never pass
          // serverEntry.error (the raw connection error) through directly:
          // this text is read by the LLM.
          error: summarizeMcpConnectionError(serverEntry.error),
        });
      } else if (hasAbuBrowser && PLAYWRIGHT_BROWSER_TOOLS.has(toolInfo.name)) {
        unavailableReasons.push({ kind: 'duplicate-browser-tool', server: serverName });
      }

      const policy = policyProbe(toolInfo.name);
      if (policy.decision === 'deny') {
        unavailableReasons.push({ kind: 'policy-denied', reason: policy.reason });
      }

      // Live ToolDefinition only exists for a connected server; MCP tools
      // never declare isConcurrencySafe today, so this resolves to 'unsafe'
      // (fail-closed) whether or not we can look up the live definition —
      // looking it up anyway keeps this correct if that ever changes.
      const liveDef = serverEntry.status === 'connected'
        ? mcpManager.getServerTools(serverName).find((t) => t.name === toolInfo.name)
        : undefined;

      entries.push({
        name: toolInfo.name,
        source: { kind: 'mcp', server: serverName },
        unavailableReasons,
        concurrencySafety: classifyConcurrencySafety(liveDef),
        policy,
      });
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const settings = useSettingsStore.getState();
  return {
    permissionMode: settings.permissionMode,
    computerUseEnabled: settings.computerUseEnabled,
    entries,
  };
}
