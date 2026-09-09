/**
 * Approval policy for MCP tools that a *plugin* brought in.
 *
 * ## Why this module exists
 *
 * `decideConsequentialTool` (permissionMode.ts) treats an unknown consequence
 * as harmless:
 *
 *     if (consequence !== 'state-changing') return 'allow';
 *
 * and the only producer of that consequence is `classifyBrowserTool`, which
 * returns `null` for every server outside `abu-browser` / `abu-browser-bridge`.
 * So today an MCP tool from any other server executes with **no approval at
 * all**, identically in all three permission modes.
 *
 * That is a pre-existing gap — it already applies to servers the user wired up
 * by hand. What the plugin system changes is the *scale*: installing from a
 * marketplace turns "the user hand-edited a config" into "one click", so the
 * same gap now means one click grants silent execution to third-party code.
 * This module closes it for plugin-contributed servers.
 *
 * ## Policy
 *
 * Every tool from a plugin-contributed server is `'state-changing'` — we
 * cannot know what third-party code does, and a name like `get_*` is not
 * evidence of anything. The first call in a conversation asks; approval then
 * covers that (conversation, server) pair for `PLUGIN_GRANT_TTL_MS`, mirroring
 * the browser grant. Per-server rather than per-plugin-set: approving a
 * weather plugin must not silently unlock an unrelated one.
 *
 * A future manifest may declare genuinely read-only tools (Codex does this via
 * per-tool `approval_mode`); until a declaration is *verified* rather than
 * merely trusted, treating it as read-only would be a WorkBuddy-style
 * "declared but never enforced" field.
 */

import { BROWSER_SERVER_NAMES_FOR_POLICY } from './browserToolPolicy';

/**
 * How long one approval covers the rest of the task, per plugin server.
 * Same 30 minutes as the browser grant and Computer Use — an approval that
 * never expired would be strictly weaker than the model it mirrors.
 */
export const PLUGIN_GRANT_TTL_MS = 30 * 60 * 1000;

/**
 * MCP server names contributed by currently-installed plugins.
 *
 * Kept as a module-level set (not read from disk) because `registry.ts` calls
 * `classifyPluginTool` on the synchronous hot path for every tool call. The
 * installer/uninstaller and startup hydration own writing to it.
 */
let pluginServerNames: ReadonlySet<string> = new Set();

/** Conversation grants, keyed `${conversationId}\x00${serverName}`. */
const grants = new Map<string, number>();

function grantKey(conversationId: string, serverName: string): string {
  return `${conversationId}\x00${serverName}`;
}

/**
 * Replace the set of plugin-contributed server names.
 *
 * Grants for servers that are no longer contributed are dropped: an uninstall
 * must not leave a live grant that a same-named plugin could later ride.
 */
export function setPluginServerNames(names: Iterable<string>): void {
  pluginServerNames = new Set(names);
  for (const key of [...grants.keys()]) {
    const serverName = key.slice(key.indexOf('\x00') + 1);
    if (!pluginServerNames.has(serverName)) grants.delete(key);
  }
}

export function getPluginServerNames(): ReadonlySet<string> {
  return pluginServerNames;
}

/**
 * Classify a namespaced MCP tool name (`server__tool`).
 * Returns `null` when the tool did not come from a plugin.
 */
export function classifyPluginTool(namespacedName: string): 'state-changing' | null {
  const separator = namespacedName.indexOf('__');
  if (separator === -1) return null;
  const serverName = namespacedName.slice(0, separator);
  // The browser servers keep their own (richer: site verdicts, scripting
  // carve-out) policy. A manifest that names its server `abu-browser` must not
  // be able to shadow it from here.
  if (BROWSER_SERVER_NAMES_FOR_POLICY.has(serverName)) return null;
  return pluginServerNames.has(serverName) ? 'state-changing' : null;
}

export function hasPluginGrant(
  conversationId: string | undefined,
  serverName: string,
  now: number = Date.now(),
): boolean {
  if (conversationId === undefined) return false;
  const key = grantKey(conversationId, serverName);
  const grantedAt = grants.get(key);
  if (grantedAt === undefined) return false;
  if (now - grantedAt >= PLUGIN_GRANT_TTL_MS) {
    grants.delete(key);
    return false;
  }
  return true;
}

export function grantPluginServer(
  conversationId: string | undefined,
  serverName: string,
  now: number = Date.now(),
): void {
  if (conversationId === undefined) return;
  grants.set(grantKey(conversationId, serverName), now);
}

/** Drop every grant. Used by tests and on sign-out/reset. */
export function forgetPluginGrants(): void {
  grants.clear();
}

/** Server name out of a namespaced tool name, or `null` when not namespaced. */
export function pluginServerOf(namespacedName: string): string | null {
  const separator = namespacedName.indexOf('__');
  if (separator === -1) return null;
  return namespacedName.slice(0, separator);
}
