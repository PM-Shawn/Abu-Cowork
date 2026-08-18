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

/**
 * The state-changing tools that act ON the page, as opposed to driving the
 * session somewhere new. `navigate` is deliberately excluded: "only reads
 * information, changes nothing" still has to be able to open the page it
 * reads (permission plan §4.2 lists "view web pages" under that tier), while
 * the same tier explicitly cannot "click web page buttons".
 */
const PAGE_MUTATING_TOOLS = [...STATE_CHANGING_TOOLS].filter((tool) => tool !== 'navigate');

/**
 * Namespaced names of every page-mutating browser tool, for callers that gate
 * by tool name rather than per call.
 *
 * The unattended read-only tier needs this because a standing per-site grant
 * short-circuits the approval chain entirely (`registry.ts` resolves an
 * 'allowed' verdict to `decideOtherTool(..., granted = true)` → 'allow', so no
 * confirmation callback ever runs). A site grant answers "is this site
 * trusted"; the tier answers "how far may this unattended run go". Per the
 * plan's own model (§2) the tier is the CEILING, so it has to be enforced
 * where the site grant cannot reach — at tool-list level.
 */
export function listPageMutatingBrowserTools(): string[] {
  const names: string[] = [];
  for (const server of BROWSER_SERVER_NAMES) {
    for (const tool of PAGE_MUTATING_TOOLS) names.push(`${server}__${tool}`);
  }
  return names;
}

export type BrowserToolConsequence = 'read-only' | 'state-changing';

/**
 * Running page code is a different decision from clicking a button: it can
 * read cookies, exfiltrate the DOM, and act with the page's full authority.
 * Tools in this set never get a persistent per-site grant — each use is its
 * own ask (mirrors how competitors put "full page control" behind a separate,
 * stricter axis than ordinary browsing).
 */
const SCRIPTING_TOOLS = new Set(['execute_js']);

export function isScriptingBrowserTool(namespacedName: string): boolean {
  const separator = namespacedName.indexOf('__');
  if (separator === -1) return false;
  if (!BROWSER_SERVER_NAMES.has(namespacedName.slice(0, separator))) return false;
  return SCRIPTING_TOOLS.has(namespacedName.slice(separator + 2));
}

/**
 * Normalize a URL to its origin (scheme://host[:port]). Exact-match keys, no
 * wildcards — `sub.example.com` and `example.com` are distinct entries, the
 * same rule competitors apply. Returns null for unparseable or non-http(s)
 * URLs (about:, chrome:, file: pages never earn a persistent grant).
 */
export function normalizeBrowserOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Rebuild instead of using `.origin`: a FQDN trailing dot resolves to the
    // same host over DNS but would otherwise mint a distinct key
    // (`evil.com.` vs `evil.com`), letting one spelling slip past a verdict
    // stored under the other. URL already lowercases the host, strips
    // userinfo, punycodes IDN, and drops default ports.
    const hostname = parsed.hostname.endsWith('.')
      ? parsed.hostname.slice(0, -1)
      : parsed.hostname;
    if (!hostname) return null;
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${hostname}${port}`;
  } catch {
    return null;
  }
}

export type SiteVerdict = 'allowed' | 'denied' | 'default';

/**
 * Resolve a persistent per-site verdict. Precedence is fixed:
 * denied > allowed > default — a site the user blocked stays blocked no
 * matter what else would have allowed it.
 *
 * NOTE: no production UI writes 'denied' yet — the dialog only writes
 * 'allowed' and Settings only revokes. The denied branch is forward schema
 * for the planned block-site control; it is pinned by tests so wiring the
 * UI later cannot regress the precedence.
 */
export function getSiteVerdict(
  origin: string | null,
  sitePermissions: Record<string, 'allowed' | 'denied'>,
): SiteVerdict {
  if (!origin) return 'default';
  const verdict = sitePermissions[origin];
  if (verdict === 'denied') return 'denied';
  if (verdict === 'allowed') return 'allowed';
  return 'default';
}

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
