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

import { parseNamespacedToolName } from '../mcp/toolName';

/** Built-in browser runtime + Chrome extension bridge — both expose the same tool set. */
const BROWSER_SERVER_NAMES = new Set(['abu-browser', 'abu-browser-bridge']);

/**
 * Actions that change page state by driving the UI — clicking, typing,
 * navigating — as opposed to running arbitrary code in the page's origin
 * (see `SCRIPTING_TOOLS` below, a stronger and separately-gated capability).
 * `navigate` is included because it drives the session somewhere new (and GET
 * endpoints can act); `keyboard` because Enter submits.
 *
 * This set is EXACTLY the pre-three-state `STATE_CHANGING_TOOLS` minus
 * `execute_js` (which is `SCRIPTING_TOOLS` below) — byte-compatible with the
 * legacy gate on purpose. `scroll`, `start_recording`, and `stop_recording`
 * were ungated (read-only) before this module existed in three-state form;
 * they stay in `READ_ONLY_TOOLS` below rather than moving here, because
 * `toLegacyBrowserToolConsequence` feeds `registry.ts`'s still-unmigrated
 * attended gate, and reclassifying them as interactive would newly ask for
 * confirmation on actions that used to run free — a real behavior
 * regression for attended sessions, not just a naming change. (They may earn
 * their own row in a later task once the gate is fully operation-class-aware
 * and a product decision is made about gating scroll/recording explicitly.)
 */
const INTERACTIVE_TOOLS = new Set(['click', 'fill', 'select', 'keyboard', 'navigate']);

/**
 * Observation and other non-state-changing tools — explicit on purpose (see
 * `classifyBrowserTool`'s fallback comment): a tool that isn't in any of the
 * three named sets is NOT assumed read-only, it falls back to the gated
 * `'interactive'` bucket instead.
 */
const READ_ONLY_TOOLS = new Set([
  'get_tabs',
  'snapshot',
  'wait_for',
  'extract_text',
  'extract_table',
  'query_js',
  'screenshot',
  'screenshot_full_page',
  'connection_status',
  'get_downloads',
  'scroll',
  'start_recording',
  'stop_recording',
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

/**
 * Split a namespaced name and keep it only if it names a browser tool.
 *
 * The parse is `parseNamespacedToolName` — the SAME one `executeAnyTool`'s
 * dispatcher uses — because a gate that disagrees with the executor about
 * which tool a name names is not a gate (U9 / C1: this module used to slice
 * from the first `__` and keep `execute_js__x` as the tool name, while the
 * dispatcher's `split('__', 2)` truncated it back to `execute_js` and ran it).
 *
 * A name that does not round-trip is not a browser tool here, and the
 * dispatcher fail-closes it on the "Unknown tool" path — so it can never
 * reach a server. This is NOT the `'interactive'` fallback (U1 Ruling C1),
 * which still applies to names that are well-formed and merely unknown.
 */
function browserToolNameOf(namespacedName: string): string | null {
  const parsed = parseNamespacedToolName(namespacedName);
  if (parsed === null) return null;
  return BROWSER_SERVER_NAMES.has(parsed.serverName) ? parsed.toolName : null;
}

export function isScriptingBrowserTool(namespacedName: string): boolean {
  const toolName = browserToolNameOf(namespacedName);
  if (toolName === null) return false;
  return SCRIPTING_TOOLS.has(toolName);
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

/**
 * Browser tools that do not act on a page: they report on the runtime itself
 * (which tabs exist, whether the bridge is connected, what was downloaded).
 * There is no site behind them, so there is no site verdict to check.
 *
 * Everything else — including a read like `screenshot` and an unknown tool
 * this module has not been taught about — DOES act on a page, which is what
 * makes "we could not determine the origin" a refusal rather than a shrug in
 * an unattended run: a probe that times out because the browser host is
 * wedged must not become permission to read a site the user blocked.
 */
const PAGELESS_TOOLS = new Set(['get_tabs', 'connection_status', 'get_downloads']);

export function browserToolTargetsPage(namespacedName: string): boolean {
  const toolName = browserToolNameOf(namespacedName);
  if (toolName === null) return false;
  return !PAGELESS_TOOLS.has(toolName);
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
 * model. Returns null when the tool is not a browser-automation tool — which
 * includes a name that does not round-trip through `parseNamespacedToolName`
 * (`abu-browser__execute_js__x`): that is a malformed name, not an unknown
 * tool, and the dispatcher refuses it outright rather than gating it. See
 * `browserToolNameOf`.
 *
 * All three buckets are explicit sets — there is deliberately no "else ⇒
 * read-only" implicit fallback. A tool under a recognized browser server
 * that isn't in any of the three sets (e.g. a newly added tool that shipped
 * before this module was updated to know about it) falls back to
 * `'interactive'`, not `'read-only'`: `'interactive'` is gated in every
 * default policy (attended asks via the existing site gate, unattended
 * requires the master switch), so an unclassified tool degrades to "asks /
 * needs explicit unattended allow" rather than silently running ungated.
 * Fail-open on an unknown capability is the wrong default for a surface that
 * acts inside the user's live, logged-in sessions.
 */
export function classifyBrowserTool(namespacedName: string): BrowserOperationClass | null {
  const toolName = browserToolNameOf(namespacedName);
  if (toolName === null) return null;
  if (SCRIPTING_TOOLS.has(toolName)) return 'scripting';
  if (INTERACTIVE_TOOLS.has(toolName)) return 'interactive';
  if (READ_ONLY_TOOLS.has(toolName)) return 'read-only';
  // Unknown tool under a recognized browser server (e.g. added before this
  // module was updated to classify it) — fail-safe fallback: gated
  // 'interactive', not the fail-open 'read-only' an implicit else-bucket
  // would have produced.
  return 'interactive';
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
 * The states one policy cell may hold. Every cell offers all three EXCEPT
 * unattended scripting, which offers `ask | deny` only.
 *
 * Why that cell is special: a site grant is minted from a human approving a
 * CLICK ("always allow this site"), and page scripting is a categorically
 * stronger capability — it reads cookies and the whole DOM and acts with the
 * page's full authority. Letting `unattended.scripting` be `allow` would mean
 * consent given for clicking silently authorizes arbitrary code execution in
 * that logged-in session, forever, with nobody watching. `ask` is the
 * strongest thing this cell may express: it routes to an approval round-trip
 * where a human answers THIS request. This is enforced in three places —
 * here (the option list the UI renders), `normalizeBrowserOperationPolicy`
 * (which clamps a stored 'allow'), and `decideBrowserOperation` (which never
 * returns 'allow' for the pair) — because a value that reaches any one of
 * them can bypass the other two.
 */
export function browserOperationStatesFor(
  runMode: 'attended' | 'unattended',
  opClass: BrowserOperationClass,
): readonly BrowserOperationState[] {
  return runMode === 'unattended' && opClass === 'scripting'
    ? (['ask', 'deny'] as const)
    : (['allow', 'ask', 'deny'] as const);
}

/**
 * Product-spec defaults (§二 table). Attended equals today's shipped
 * semantics exactly — read-only and interactive already run unconfirmed
 * (interactive still passes through the existing per-site gate elsewhere;
 * this policy layer does not relax that), scripting still asks every time.
 * Unattended is fail-safe: read-only runs free EXCEPT on a site the user
 * blocked, interactive still needs its per-site allow (site verdict is a
 * separate input to `decideBrowserOperation`, not encoded here), and scripting
 * is denied outright — the one cell that cannot be set to 'allow' at all
 * (`browserOperationStatesFor`).
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
 * `SiteVerdict` plus `'high-risk'` — a site `highRiskSites.ts` classified as
 * money movement or government from its URL alone (U5, §三 T2).
 *
 * It is NOT a fourth stored verdict: nothing persists it, and it is computed
 * per call from the target URL. It OUTRANKS an `'allowed'` grant on purpose —
 * "always allow this bank" is precisely the artifact this control exists to
 * prevent — while `'denied'` still outranks it (a blocked site stays blocked).
 * See `decideBrowserOperation` for what it does.
 */
export type DecideBrowserOperationSiteVerdict = SiteVerdict | 'high-risk';

/**
 * Why the browser authorization gate refused — ONE closed vocabulary, used by
 * every consumer that has to explain a refusal.
 *
 * There are three such consumers and they must never disagree: the sentence
 * the run result shows the user (`registry.ts`'s `browserDenialReasonText`),
 * the observability signal (`browserSignals.ts`'s `gate_denied`), and the
 * unattended task report card. Before this union each of those either had its
 * own wording or, in the signal's case, nothing at all — so "how many actions
 * were blocked and why" had no single answer.
 *
 * These are codes, not copy: they are locale-independent, so a report card
 * snapshotted while the app was in Chinese still renders in English after the
 * user switches, and two runs blocked for the same cause aggregate together
 * regardless of the wording in force when each was recorded.
 *
 * The order below is the gate's own precedence order, most-specific first.
 */
export type BrowserDenialReasonCode =
  /** The unattended master switch is off — the whole capability is unavailable. */
  | 'master-switch-off'
  /** The user blocked this site (persistent 'denied' verdict). */
  | 'site-denied'
  /** URL looks like money movement / a government service (`highRiskSites.ts`). */
  | 'high-risk-site'
  /** The user's operation-class policy says deny for this class. */
  | 'policy-denied'
  /** This run's capability tier carries no browser access at all. */
  | 'capability-denied'
  /** The page's origin could not be determined, so it could not be checked. */
  | 'origin-unverified'
  /** The site is asking for a sign-in and nobody is here to do it (U6). */
  | 'login-required'
  /** An unattended state-changing action on a site with no standing grant. */
  | 'site-not-allowed'
  /** A human was asked and said no, or could not be reached in time (U3). */
  | 'approval-refused'
  /** An attended dialog the user dismissed. */
  | 'user-cancelled';

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

const VALID_OPERATION_STATES: ReadonlySet<string> = new Set(['allow', 'deny', 'ask']);

function normalizeStateLeaf(
  value: unknown,
  strictest: BrowserOperationState,
): BrowserOperationState {
  return typeof value === 'string' && VALID_OPERATION_STATES.has(value)
    ? (value as BrowserOperationState)
    : strictest;
}

function normalizeClassPolicy(
  raw: unknown,
  strictest: BrowserOperationState,
): BrowserOperationClassPolicy {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    readOnly: normalizeStateLeaf(row.readOnly, strictest),
    interactive: normalizeStateLeaf(row.interactive, strictest),
    scripting: normalizeStateLeaf(row.scripting, strictest),
  };
}

/**
 * Coerce an arbitrary (possibly corrupted, partially-written, or hand-edited)
 * value into a well-formed `BrowserOperationPolicy` — the runtime counterpart
 * to the compile-time type, since persisted localStorage and any future
 * IPC/IM-delivered policy payload are not type-checked at the boundary.
 *
 * Any missing run-mode key, missing operation-class key, or leaf value
 * outside `'allow' | 'deny' | 'ask'` is clamped to the STRICTEST state for
 * that cell rather than to the friendly product-spec default — a malformed
 * value is a signal something went wrong (corruption, a bug, manual
 * tampering), and this module's fail-safe posture (see
 * `docs/abu-browser-batch2-brief-2026-09.md`'s global constraint "任何新字段
 * 缺省=最严格档") treats "we don't know what this cell should be" the same
 * way in both columns: attended clamps to `'ask'` (never silently allow or
 * deny without asking), unattended clamps to `'deny'` (never silently allow
 * an unattended run). This is intentionally stricter than
 * `DEFAULT_BROWSER_OPERATION_POLICY`'s attended read-only/interactive
 * `'allow'` — that default is a deliberate, reviewed product choice for a
 * KNOWN-absent field (pre-v46 migration), whereas this function handles the
 * different case of a PRESENT-but-broken value, where the safer assumption
 * is that we cannot vouch for what was intended.
 *
 * A fully well-formed input passes through with the same values (not
 * necessarily the same object identity).
 */
export function normalizeBrowserOperationPolicy(input: unknown): BrowserOperationPolicy {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const unattended = normalizeClassPolicy(raw.unattended, 'deny');
  return {
    attended: normalizeClassPolicy(raw.attended, 'ask'),
    unattended: {
      ...unattended,
      // `unattended.scripting` has no 'allow' value — see
      // `browserOperationStatesFor`. A stored/hand-edited 'allow' is clamped
      // to 'ask' (the strongest thing the cell may express) rather than to
      // 'deny', so a user who deliberately opted into unattended scripting
      // still gets the approval round-trip instead of a silent hard block.
      scripting: unattended.scripting === 'allow' ? 'ask' : unattended.scripting,
    },
  };
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
 * 3. `siteVerdict === 'high-risk' && runMode === 'unattended'` → deny, for
 *    EVERY class including read-only. Nobody is there to answer for a wire
 *    transfer, and quietly reading a bank page into an LLM context is the
 *    exfiltration half of the same problem.
 * 4. Otherwise, the configured three-state policy for
 *    `policy[runMode][opClass]` decides — except that an ATTENDED `'allow'`
 *    on a high-risk site is upgraded to `'ask'` for the two acting classes.
 *    Read-only stays exactly as it was attended: a screenshot of a bank page
 *    is not a transfer, and asking on every observation is how a control
 *    trains users to click through it.
 *
 * `input.policy` is run through `normalizeBrowserOperationPolicy` before use
 * — defense in depth against a malformed value reaching this function
 * despite the `BrowserOperationPolicy` compile-time type (e.g. a settingsStore
 * rehydration bug, or a caller that skipped the store's own normalization).
 * A well-formed policy is unaffected.
 */
export function decideBrowserOperation(
  input: DecideBrowserOperationInput,
): BrowserOperationState {
  const { opClass, runMode, masterSwitchUnattended, siteVerdict } = input;
  const policy = normalizeBrowserOperationPolicy(input.policy);
  if (siteVerdict === 'denied') return 'deny';
  if (runMode === 'unattended' && !masterSwitchUnattended) return 'deny';
  // A money-movement / government URL, unattended: there is no answer an
  // automated run can give to "confirm this transfer", so it does not get to
  // act OR to read there. See `highRiskSites.ts`.
  if (siteVerdict === 'high-risk' && runMode === 'unattended') return 'deny';
  const state = policy[runMode][OPERATION_CLASS_TO_POLICY_KEY[opClass]];
  // Belt and braces on top of the normalizer: this function must never hand
  // back 'allow' for unattended scripting, whatever the policy object said.
  if (runMode === 'unattended' && opClass === 'scripting' && state === 'allow') return 'ask';
  // Attended on a high-risk URL: a human is watching, so this asks rather than
  // denies — but it never runs silently. Read-only is exempt (see the
  // precedence doc above); a configured 'deny' is left alone, since upgrading
  // a deny to an ask would be a relaxation.
  if (siteVerdict === 'high-risk' && opClass !== 'read-only' && state === 'allow') return 'ask';
  return state;
}
