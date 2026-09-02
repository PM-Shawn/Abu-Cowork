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
 * Actions that change page state by driving the UI — clicking, typing,
 * navigating — as opposed to running arbitrary code in the page's origin
 * (see `SCRIPTING_TOOLS` below, a stronger and separately-gated capability).
 * `navigate` is included because it drives the session somewhere new (and GET
 * endpoints can act); `keyboard` because Enter submits; `scroll` because it
 * can trigger infinite-scroll loads / lazy actions and because it belongs
 * with the rest of the "drives the live page" tools rather than pure
 * observation; the two recording tools because they start/stop capturing the
 * user's screen, a capability-changing action in its own right.
 */
const INTERACTIVE_TOOLS = new Set([
  'click',
  'fill',
  'select',
  'scroll',
  'keyboard',
  'navigate',
  'start_recording',
  'stop_recording',
]);

/**
 * Union of `INTERACTIVE_TOOLS` and `SCRIPTING_TOOLS` (defined below) — the
 * legacy two-state classification's "state-changing" bucket. Kept only for
 * `toLegacyBrowserToolConsequence`; new code should branch on the three-state
 * `BrowserOperationClass` from `classifyBrowserTool` instead.
 */

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

/**
 * @deprecated Legacy two-state classification, kept only for callers that
 * have not migrated to the three-state `BrowserOperationClass` (registry.ts's
 * `strategy.decideOtherTool` gate, migrated in a later task). Derive it from
 * `BrowserOperationClass` via `toLegacyBrowserToolConsequence` rather than
 * re-classifying — the two must never diverge.
 */
export type BrowserToolConsequence = 'read-only' | 'state-changing';

/**
 * Three-class model (batch-二 authorization redesign, `docs/abu-browser-batch2-brief-2026-09.md`
 * §二). Replaces the old read-only/state-changing split with the axis the
 * unattended policy actually gates on:
 * - `read-only`: observation — never gated, allowed in every run mode.
 * - `interactive`: drives the UI (click/fill/navigate/…) — gated by the
 *   existing per-site verdict today; the unattended column additionally
 *   fail-closes navigation outside the allowed-site set (see product spec).
 * - `scripting`: runs arbitrary code in the page's origin — the strongest
 *   capability, never covered by a site grant, asked every time when
 *   attended and denied by default when unattended.
 */
export type BrowserOperationClass = 'read-only' | 'interactive' | 'scripting';

/** Map the three-state class down to the legacy two-state shape, for callers
 *  that have not migrated (see `BrowserToolConsequence`'s deprecation note). */
export function toLegacyBrowserToolConsequence(
  opClass: BrowserOperationClass,
): BrowserToolConsequence {
  return opClass === 'read-only' ? 'read-only' : 'state-changing';
}

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
 * Classify a namespaced MCP tool name (`server__tool`) into the three-class
 * model. Returns null when the tool is not a browser-automation tool.
 */
export function classifyBrowserTool(namespacedName: string): BrowserOperationClass | null {
  const separator = namespacedName.indexOf('__');
  if (separator === -1) return null;
  const serverName = namespacedName.slice(0, separator);
  if (!BROWSER_SERVER_NAMES.has(serverName)) return null;
  const toolName = namespacedName.slice(separator + 2);
  if (SCRIPTING_TOOLS.has(toolName)) return 'scripting';
  if (INTERACTIVE_TOOLS.has(toolName)) return 'interactive';
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

// ─────────────────────────────────────────────────────────────────────────
// Operation-class three-state policy + unattended master switch
// (batch-二「无人值守授权闭环」T1, `docs/abu-browser-batch2-brief-2026-09.md` §二)
// ─────────────────────────────────────────────────────────────────────────

/** Per-operation-class verdict. `ask` means "route through the confirmation
 *  channel available for the current run mode" — a dialog when attended, an
 *  IM approval round-trip when unattended (wired in a later task; this
 *  module only classifies the *policy*, not the channel). */
export type BrowserOperationState = 'allow' | 'deny' | 'ask';

/** One run mode's three-row policy, keyed by operation class (camelCase to
 *  match the settingsStore field naming convention — `BrowserOperationClass`
 *  itself stays kebab-case because it is also a tool-classification value). */
export interface BrowserOperationClassPolicy {
  readOnly: BrowserOperationState;
  interactive: BrowserOperationState;
  scripting: BrowserOperationState;
}

/** The full two-column policy persisted in settingsStore. */
export interface BrowserOperationPolicy {
  attended: BrowserOperationClassPolicy;
  unattended: BrowserOperationClassPolicy;
}

/**
 * Product-spec defaults (§二 table). Attended equals today's shipped
 * semantics exactly — read-only and interactive already run unconfirmed
 * (interactive still passes through the existing per-site gate elsewhere;
 * this policy layer does not relax that), scripting still asks every time.
 * Unattended is fail-safe: only read-only runs free, interactive still needs
 * its per-site allow (site verdict is a separate input to
 * `decideBrowserOperation`, not encoded here), scripting is denied outright.
 * Exported so settingsStore's default state and v45→v46 migration share the
 * exact same object instead of two hand-copied literals drifting apart.
 */
export const DEFAULT_BROWSER_OPERATION_POLICY: BrowserOperationPolicy = {
  attended: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' },
  unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'deny' },
};

const OPERATION_CLASS_TO_POLICY_KEY: Record<
  BrowserOperationClass,
  keyof BrowserOperationClassPolicy
> = {
  'read-only': 'readOnly',
  interactive: 'interactive',
  scripting: 'scripting',
};

/**
 * `SiteVerdict` plus a reserved `'high-risk'` value for a later task (U5,
 * §三 T2's "high-risk site" classification — payment/transfer/checkout URL
 * patterns). Accepted by `decideBrowserOperation` now so U5 does not need a
 * signature break, but it currently has NO effect on the decision: it is not
 * `'denied'`, so it falls through to the ordinary policy lookup exactly like
 * `'default'` does, until U5 gives it teeth.
 */
export type DecideBrowserOperationSiteVerdict = SiteVerdict | 'high-risk';

export interface DecideBrowserOperationInput {
  opClass: BrowserOperationClass;
  runMode: 'attended' | 'unattended';
  policy: BrowserOperationPolicy;
  /** The global "allow unattended tasks to use the browser at all" switch —
   *  defaults to false (settingsStore `allowUnattendedBrowser`). Irrelevant
   *  when `runMode === 'attended'`. */
  masterSwitchUnattended: boolean;
  siteVerdict: DecideBrowserOperationSiteVerdict;
  /**
   * RESERVED for a later task (U5, per-origin scoping of the fail-closed
   * cross-domain navigation rule). Accepted so callers can pass it through
   * now without a signature break later, but it has no effect on the
   * decision yet.
   */
  targetOrigin?: string;
}

/**
 * Decide whether one browser operation may proceed, purely from policy state
 * — no I/O, no side effects, no confirmation dialogs. Callers turn `'ask'`
 * into an actual prompt (dialog or IM round-trip); this function only says
 * which of the three outcomes applies.
 *
 * Precedence (fixed, matches the product spec):
 * 1. `siteVerdict === 'denied'` → deny. A site the user explicitly blocked
 *    stays blocked regardless of operation class or master switch.
 * 2. `runMode === 'unattended' && !masterSwitchUnattended` → deny. The
 *    master switch is the fail-safe global gate: off means no unattended
 *    browser use at all, independent of how permissive the per-class policy
 *    looks.
 * 3. Otherwise, the configured three-state policy for
 *    `policy[runMode][opClass]` decides.
 */
export function decideBrowserOperation(
  input: DecideBrowserOperationInput,
): BrowserOperationState {
  const { opClass, runMode, policy, masterSwitchUnattended, siteVerdict } = input;
  if (siteVerdict === 'denied') return 'deny';
  if (runMode === 'unattended' && !masterSwitchUnattended) return 'deny';
  return policy[runMode][OPERATION_CLASS_TO_POLICY_KEY[opClass]];
}
