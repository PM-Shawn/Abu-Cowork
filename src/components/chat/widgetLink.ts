/**
 * The one way a sandboxed in-chat view gets a link opened.
 *
 * Extracted from `HtmlWidgetBlock`'s `abu-widget-link` message handler so the
 * MCP App bridge (`ui/open-link`, spec §4.3) goes through the SAME path instead
 * of inventing a second one. Nothing here decides policy on its own — it is the
 * middle link in a chain that is already fail-closed at both ends:
 *
 *  1. the caller filters the scheme (a widget only forwards `<a href>` clicks;
 *     `appBridgeHandlers.onopenlink` refuses anything but http/https),
 *  2. this call hands the URL to the shell as a popup request,
 *  3. `electron/securityBoundary.cjs`'s `setWindowOpenHandler` DENIES the popup
 *     and re-routes it to `shell.openExternal`, but only for `http:` / `https:`
 *     / `mailto:` — every other scheme is dropped there.
 *
 * ⚠️ There is no confirmation dialog on this path today (a widget link opens
 * straight in the system browser). Reusing it keeps MCP Apps exactly as
 * permissive as the widgets that already ship, and no more; adding a prompt is
 * a product decision that should change BOTH callers at once.
 */
export function openWidgetLink(url: string): void {
  window.open(url, '_blank', 'noopener');
}
