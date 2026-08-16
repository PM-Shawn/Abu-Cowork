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
 * How long one approval covers the rest of the task.
 *
 * Same 30 minutes Computer Use gives a task grant. An approval that never
 * expires would be strictly weaker than the model it mirrors: the user would
 * approve once and the conversation would keep acting in their browser for as
 * long as the app stays open, including after they tightened the permission
 * mode expecting to be asked again.
 */
export const BROWSER_GRANT_TTL_MS = 30 * 60 * 1000;

/**
 * Conversations that already approved browser automation, with the moment the
 * approval was given. Kept in memory on purpose — the grant dies with the app
 * rather than silently outliving the session that earned it.
 */
const grantedConversations = new Map<string, number>();

export function hasBrowserGrant(
  conversationId: string | undefined,
  now: number = Date.now(),
): boolean {
  if (conversationId === undefined) return false;
  const grantedAt = grantedConversations.get(conversationId);
  if (grantedAt === undefined) return false;
  if (now - grantedAt >= BROWSER_GRANT_TTL_MS) {
    grantedConversations.delete(conversationId);
    return false;
  }
  return true;
}

export function grantBrowserAutomation(
  conversationId: string | undefined,
  now: number = Date.now(),
): void {
  if (conversationId !== undefined) grantedConversations.set(conversationId, now);
}

/** Drop a grant early — used when the conversation's permission posture changes. */
export function revokeBrowserGrant(conversationId: string): void {
  grantedConversations.delete(conversationId);
}

export function __resetBrowserGrantsForTests(): void {
  grantedConversations.clear();
}
