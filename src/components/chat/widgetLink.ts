/**
 * The one way a sandboxed in-chat view gets a link opened.
 *
 * Extracted from `HtmlWidgetBlock`'s `abu-widget-link` message handler so the
 * MCP App bridge (`ui/open-link`, spec §4.3) goes through the SAME path instead
 * of inventing a second one. Nothing here decides policy on its own — it is the
 * middle link in a chain that is already fail-closed at both ends:
 *
 *  1. the caller filters the scheme (a widget only forwards `<a href>` clicks;
 *     `appBridgeHandlers.onopenlink` refuses anything but http/https, bounds the
 *     URL and asks the user first),
 *  2. this call hands the URL to the shell as a popup request,
 *  3. `electron/securityBoundary.cjs`'s `setWindowOpenHandler` DENIES the popup
 *     and re-routes it to `shell.openExternal`, but only for `http:` / `https:`
 *     / `mailto:` — every other scheme is dropped there.
 *
 * ⚠️ This function itself never prompts. A WIDGET link still opens straight in
 * the system browser, because a human clicked the anchor. An MCP App can call
 * `ui/open-link` on its own initiative, so `McpAppBlock` puts a consent dialog
 * in front of this call; the asymmetry is deliberate, not an oversight.
 */
export function openWidgetLink(url: string): void {
  window.open(url, '_blank', 'noopener');
}
