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
 * Wildcard patterns matching every tool exposed by the browser-automation MCP
 * servers, gated or not — including `navigate` and the read-only tools
 * (snapshot, screenshot, extract, get_tabs, ...) that are never enumerated in
 * this module because the servers register them dynamically.
 *
 * Used by the unattended read-only tier, which must not carry ANY browser
 * capability at all (not even "view web pages" — a user correction reversed
 * the earlier design that kept `navigate` available). A standing per-site
 * grant also short-circuits the approval chain entirely (`registry.ts`
 * resolves an 'allowed' verdict to `decideOtherTool(..., granted = true)` →
 * 'allow', so no confirmation callback ever runs), so the exclusion has to
 * hold at the tool-list level, not just at the confirm-callback level. A
 * namespace wildcard (`server__*`) rather than an enumerated list means a
 * newly added browser tool is blocked automatically instead of needing this
 * module updated — the matching happens at `agentLoop.ts`'s `resolveTools`
 * and `toolExecutor.ts`'s fail-closed check, both of which already
 * understand `matchesToolName`'s glob patterns.
 */
export function listAllBrowserToolPatterns(): string[] {
  return [...BROWSER_SERVER_NAMES].map((server) => `${server}__*`);
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

// ── `batch`: one call, several actions, still one authority ────────────────
//
// `batch` is not a new permission surface. It carries N ordinary steps, so it
// is classified by its HEAVIEST step: any click/fill/select/keyboard makes the
// whole call state-changing (one ask, covering the run at the pinned origin);
// a batch of nothing but page reads stays read-only, exactly as those reads
// would be on their own. Everything else about the gate — blocked sites, site
// grants, the conversation grant, the run ceiling — is unchanged.
//
// The one thing a batch may NOT contain is page scripting. `execute_js` is
// deliberately approved run by run and never rides a site grant; a scripting
// step would let a single "allow" buy an unbounded number of script runs. The
// bridge refuses such a batch too (`abu-browser-bridge/src/batch.ts`), but the
// gate must not depend on that: this module is what stands between the model's
// arguments and the user's logged-in session.

/** Mirrors `MAX_BATCH_STEPS` in `abu-browser-bridge/src/batch.ts`. */
export const MAX_BROWSER_BATCH_STEPS = 25;

const BATCH_STEP_CONSEQUENCE: Record<string, BrowserToolConsequence> = {
  fill: 'state-changing',
  select: 'state-changing',
  click: 'state-changing',
  keyboard: 'state-changing',
  wait_for: 'read-only',
  find: 'read-only',
  read: 'read-only',
};

/** Step `action` values that mean "run code in the page", however spelled. */
const BATCH_SCRIPTING_STEPS = new Set(['execute_js', 'query_js', 'script', 'eval']);

export type BrowserBatchRefusalCode = 'scripting-step' | 'too-many-steps' | 'malformed';

function batchToolName(namespacedName: string): boolean {
  const separator = namespacedName.indexOf('__');
  if (separator === -1) return false;
  if (!BROWSER_SERVER_NAMES.has(namespacedName.slice(0, separator))) return false;
  return namespacedName.slice(separator + 2) === 'batch';
}

/**
 * Decode `input.steps`, which the tool schema carries as a JSON string but
 * which a caller may already have decoded. Returns null when it cannot be read
 * as a list — which the gate treats as a refusal, never as an empty batch.
 */
function decodeBatchSteps(input: unknown): unknown[] | null {
  const raw = (input as { steps?: unknown } | undefined)?.steps;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stepAction(step: unknown): string | null {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) return null;
  const action = (step as { action?: unknown }).action;
  return typeof action === 'string' ? action : null;
}

/**
 * Why this `batch` must be refused outright, or null when it is acceptable
 * (or when the tool is not a browser `batch` at all).
 *
 * Refusing is separate from classifying on purpose: a batch whose only steps
 * are reads still has to be refused if one of them is a script, and the
 * read-only path never reaches the state-changing branch of the gate.
 */
export function refuseBrowserBatch(
  namespacedName: string,
  input: unknown,
): BrowserBatchRefusalCode | null {
  if (!batchToolName(namespacedName)) return null;
  const steps = decodeBatchSteps(input);
  if (steps === null || steps.length === 0) return 'malformed';
  if (steps.length > MAX_BROWSER_BATCH_STEPS) return 'too-many-steps';
  for (const step of steps) {
    const action = stepAction(step);
    if (action !== null && BATCH_SCRIPTING_STEPS.has(action)) return 'scripting-step';
  }
  for (const step of steps) {
    const action = stepAction(step);
    if (action === null || !(action in BATCH_STEP_CONSEQUENCE)) return 'malformed';
  }
  return null;
}

/**
 * A one-line "what this batch will do" for the confirmation dialog: step kinds
 * and counts, in order, and nothing else. Deliberately carries no locator, no
 * value and no page text — the same rule `deriveTargetKey` follows in the
 * signal collector, for the same reason.
 */
export function summarizeBrowserBatch(namespacedName: string, input: unknown): string | null {
  if (!batchToolName(namespacedName)) return null;
  const steps = decodeBatchSteps(input);
  if (steps === null || steps.length === 0) return null;
  const counts: Array<[string, number]> = [];
  for (const step of steps) {
    const action = stepAction(step) ?? '?';
    const last = counts[counts.length - 1];
    if (last && last[0] === action) last[1] += 1;
    else counts.push([action, 1]);
  }
  return counts.map(([action, n]) => (n > 1 ? `${action} ×${n}` : action)).join(' → ');
}

/**
 * Classify a namespaced MCP tool name (`server__tool`).
 * Returns null when the tool is not a browser-automation tool.
 *
 * `input` matters only for `batch`, which is classified by its heaviest step.
 * Anything unreadable there classifies as state-changing: a call the gate
 * cannot understand must not be the one that skips the ask. (It is refused
 * outright by `refuseBrowserBatch` anyway — this is the second lock.)
 */
export function classifyBrowserTool(
  namespacedName: string,
  input?: unknown,
): BrowserToolConsequence | null {
  const separator = namespacedName.indexOf('__');
  if (separator === -1) return null;
  const serverName = namespacedName.slice(0, separator);
  if (!BROWSER_SERVER_NAMES.has(serverName)) return null;
  const toolName = namespacedName.slice(separator + 2);
  if (toolName === 'batch') return classifyBrowserBatch(input);
  return STATE_CHANGING_TOOLS.has(toolName) ? 'state-changing' : 'read-only';
}

function classifyBrowserBatch(input: unknown): BrowserToolConsequence {
  const steps = decodeBatchSteps(input);
  if (steps === null || steps.length === 0) return 'state-changing';
  for (const step of steps) {
    const action = stepAction(step);
    if (action === null) return 'state-changing';
    const consequence = BATCH_STEP_CONSEQUENCE[action];
    if (consequence === undefined || consequence === 'state-changing') return 'state-changing';
  }
  return 'read-only';
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
