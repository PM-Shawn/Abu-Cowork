/**
 * Browser-automation consequence classification.
 *
 * Computer Use already treats browsers as `approval-required` (see
 * `computerUsePolicy.json`): driving Safari/Chrome asks the user in every
 * permission mode, because a click in a logged-in session can submit, pay, or
 * delete. The browser-automation tools reach the *same* logged-in sessions
 * through a different mechanism (the `abu-browser` runtime and the Chrome
 * extension bridge), so the gate has to follow the consequence, not the
 * mechanism — otherwise the cheaper path is also the ungated one.
 *
 * Only page-state-changing actions are gated. Reading the page (snapshot,
 * extract, screenshot) stays free: it is what the agent does constantly while
 * browsing, and gating it would train users to click through prompts.
 */

/** Built-in browser runtime + Chrome extension bridge — both expose the same tool set. */
const BROWSER_SERVER_NAMES = new Set(['abu-browser', 'abu-browser-bridge']);

/**
 * Actions that change page state or run code in the page's origin.
 * `navigate` is included because it drives the session somewhere new (and GET
 * endpoints can act); `keyboard` because Enter submits.
 */
const STATE_CHANGING_TOOLS = new Set([
  'click',
  'fill',
  'select',
  'keyboard',
  'execute_js',
  'navigate',
]);

export type BrowserToolConsequence = 'read-only' | 'state-changing';

/**
 * Classify a namespaced MCP tool name (`server__tool`).
 * Returns null when the tool is not a browser-automation tool.
 */
export function classifyBrowserTool(namespacedName: string): BrowserToolConsequence | null {
  const separator = namespacedName.indexOf('__');
  if (separator === -1) return null;
  const serverName = namespacedName.slice(0, separator);
  if (!BROWSER_SERVER_NAMES.has(serverName)) return null;
  const toolName = namespacedName.slice(separator + 2);
  return STATE_CHANGING_TOOLS.has(toolName) ? 'state-changing' : 'read-only';
}

/**
 * Conversations that already approved browser automation.
 *
 * Scoped per conversation and kept in memory on purpose, mirroring Computer
 * Use's task grant: the user approves once for the task at hand, and the grant
 * dies with the app rather than silently outliving the session that earned it.
 */
const grantedConversations = new Set<string>();

export function hasBrowserGrant(conversationId: string | undefined): boolean {
  return conversationId !== undefined && grantedConversations.has(conversationId);
}

export function grantBrowserAutomation(conversationId: string | undefined): void {
  if (conversationId !== undefined) grantedConversations.add(conversationId);
}

export function revokeBrowserGrant(conversationId: string): void {
  grantedConversations.delete(conversationId);
}

export function __resetBrowserGrantsForTests(): void {
  grantedConversations.clear();
}
