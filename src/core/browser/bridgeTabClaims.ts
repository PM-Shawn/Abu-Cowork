import { mcpManager } from '../mcp/client';

/**
 * Release the Chrome-extension tab claims one agent run holds, at that run's
 * settlement seal.
 *
 * The extension channel's counterpart to `disposeRunBrowserViews` next door:
 * same seal, same `{conversationId, runKey}` owner, different transport. The
 * built-in host is told over Electron IPC; the bridge is a separate stdio MCP
 * process with no IPC to the app, so it is told over the MCP connection it
 * already has (`mcpManager.notifyBrowserBridgeRunSettled`, which carries the
 * scope rule and the best-effort contract).
 *
 * Call it for BOTH ways a run ends. It is the same seal either way, and the
 * bridge cannot tell "the user pressed Stop" from "a slow screenshot timed
 * out" on its own — which is exactly why it no longer guesses.
 *
 * `runKey` omitted ⇒ the conversation's own loop. Never means "every run".
 */
export function releaseRunBrowserTabClaims(conversationId?: string, runKey?: string): void {
  if (!conversationId) return;
  mcpManager.notifyBrowserBridgeRunSettled(conversationId, runKey);
}
