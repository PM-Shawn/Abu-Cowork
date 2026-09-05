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
 * endpoints can act); `keyboard` because Enter submits; `handle_dialog`
 * because accepting a page's own confirm presses its OK button.
 *
 * This set is the pre-three-state `STATE_CHANGING_TOOLS` minus `execute_js`
 * (which is `SCRIPTING_TOOLS` below) — byte-compatible with the legacy gate
 * on purpose, plus `handle_dialog` which did not exist when that gate was
 * written. `scroll`, `start_recording`, and `stop_recording`
 * were ungated (read-only) before this module existed in three-state form;
 * they stay in `READ_ONLY_TOOLS` below rather than moving here, because
 * `toLegacyBrowserToolConsequence` feeds `registry.ts`'s still-unmigrated
 * attended gate, and reclassifying them as interactive would newly ask for
 * confirmation on actions that used to run free — a real behavior
 * regression for attended sessions, not just a naming change. (They may earn
 * their own row in a later task once the gate is fully operation-class-aware
 * and a product decision is made about gating scroll/recording explicitly.)
 */
const INTERACTIVE_TOOLS = new Set([
  'click',
  'fill',
  'select',
  'keyboard',
  'navigate',
  // Answering a page's own dialog MOVES THE PAGE: accepting a confirm submits
  // the form behind it, accepting a beforeunload leaves the page and discards
  // what is on it. `get_dialog` reads the same dialog and stays read-only —
  // that split is the whole reason the pair is two tools.
  'handle_dialog',
]);

/**
 * Observation and other non-state-changing tools — explicit on purpose (see
 * `classifyBrowserTool`'s fallback comment): a tool that isn't in any of the
 * three named sets is NOT assumed read-only, it falls back to the gated
 * `'interactive'` bucket instead.
 */
const READ_ONLY_TOOLS = new Set([
  'get_tabs',
  'snapshot',
  // Locating an element is reading the page — it returns candidates and
  // touches nothing. Listing it here rather than letting it ride the
  // `'interactive'` fallback is load-bearing: `find` is what the model calls
  // BEFORE every action, so a fallback classification would put an approval
  // dialog in front of every single one of them.
  'find',
  'wait_for',
  // Reading a pending dialog is reading; ANSWERING it is `handle_dialog`,
  // which is interactive above. Splitting the pair into two tools only buys
  // anything if the reading half is actually free.
  'get_dialog',
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
 *   existing per-site verdict today; an automatic run additionally
 *   fail-closes navigation outside the allowed-site set (see product spec).
 * - `scripting`: runs arbitrary code in the page's origin — the strongest
 *   capability. A site grant alone never authorizes it: it asks every time by
 *   default, and a user who sets it to `allow` still buys nothing for an
 *   automatic run beyond what the master switch and the standing site grant
 *   already permit (`decideBrowserOperation`).
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
 * A per-site grant never authorizes a tool in this set on its own — it is its
 * own row in the operation policy, defaulting to «ask every time», and an
 * automatic run may use it only where the master switch is on AND the site
 * carries a standing 'allowed' verdict AND the page is not high-risk
 * (`decideBrowserOperation`). This mirrors how competitors put "full page
 * control" behind a separate, stricter axis than ordinary browsing — Codex
 * ships CDP as its own high-risk switch, off by default and scoped per site,
 * rather than forbidding it.
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
 * Does this tool press a button on a dialog the PAGE put up?
 *
 * Its own predicate, alongside `isScriptingBrowserTool`, because it is gated
 * the same way and for a related reason (F2, 2026-09-06 review).
 *
 * `handle_dialog` is `'interactive'` — it moves the page, so the class is
 * right — but it must not ride the two grant scopes an ordinary click does:
 *
 * - The CONVERSATION grant is the wrong shape for it. That grant is minted by
 *   approving a click, and the most common dialog in existence is the one that
 *   click just raised. So the click's own approval, seconds earlier, silently
 *   bought "press OK on this page's confirm" — the two decisions the split
 *   into `get_dialog` / `handle_dialog` exists to keep apart. A click is
 *   "do this thing I named"; answering the page's confirm is "agree to
 *   whatever the page then asked", and the page wrote the question.
 * - What it agrees to is text the PAGE authored, which is exactly why
 *   `JS_DIALOG_UNTRUSTED_NOTICE` exists. The model's judgment about whether to
 *   accept is driven by an untrusted string.
 *
 * What it DOES ride, per the 2026-09-06 product ruling, is the same lever
 * scripting rides: the operation-class row set to `'allow'` on a site the user
 * set to 始终允许, and not high-risk. That is a permission the user granted in
 * so many words, and honouring it keeps this consistent with R1 rather than
 * inventing a third grant model. Everything short of that asks — at most once
 * per dialog, since a dialog is answered once.
 */
export function answersPageDialog(namespacedName: string): boolean {
  return browserToolNameOf(namespacedName) === 'handle_dialog';
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
 * Both verdicts are live in production UI: the confirmation dialog's "block
 * this site" writes 'denied' (`CommandConfirmDialog.tsx`'s `handleBlockSite`,
 * offered wherever an origin is known — even where a permanent grant may not
 * be), and Settings' per-site list switches an existing entry between the two
 * (`CapabilitiesSection.tsx`'s `BrowserSitePermissionsList`; removing the row
 * is what restores ask-every-time). So the precedence above is what makes a
 * block actually stick, and it is pinned by tests.
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
// whole call `'interactive'` (one ask, covering the run at the pinned origin);
// a batch of nothing but page reads stays `'read-only'`, exactly as those reads
// would be on their own. Everything else about the gate — blocked sites, site
// grants, the conversation grant, the run ceiling, and the operation-class
// policy `decideBrowserOperation` applies to whatever class comes out — is
// unchanged.
//
// The one thing a batch may NOT contain is page scripting. `execute_js` is
// deliberately approved run by run and never rides a site grant; a scripting
// step would let a single "allow" buy an unbounded number of script runs. The
// bridge refuses such a batch too (`abu-browser-bridge/src/batch.ts`), but the
// gate must not depend on that: this module is what stands between the model's
// arguments and the user's logged-in session.

/** Mirrors `MAX_BATCH_STEPS` in `abu-browser-bridge/src/batch.ts`. */
export const MAX_BROWSER_BATCH_STEPS = 25;

/**
 * The class each allowed step contributes, in the SAME three-class vocabulary
 * `classifyBrowserTool` speaks. A step kind absent from this table makes the
 * batch unreadable (`refuseBrowserBatch` → `'malformed'`); a scripting step is
 * caught earlier still (`BATCH_SCRIPTING_STEPS`), so this table deliberately
 * has no `'scripting'` row — a batch never carries that class.
 */
const BATCH_STEP_CLASS: Record<string, BrowserOperationClass> = {
  fill: 'interactive',
  select: 'interactive',
  click: 'interactive',
  keyboard: 'interactive',
  wait_for: 'read-only',
  find: 'read-only',
  read: 'read-only',
};

/** Step `action` values that mean "run code in the page", however spelled. */
const BATCH_SCRIPTING_STEPS = new Set(['execute_js', 'query_js', 'script', 'eval']);

export type BrowserBatchRefusalCode = 'scripting-step' | 'too-many-steps' | 'malformed';

/** Uses `browserToolNameOf` — the SAME parse the dispatcher and
 *  `classifyBrowserTool` use — so a name the gate reads as `batch` is exactly
 *  the name the executor would run as `batch`. */
function batchToolName(namespacedName: string): boolean {
  return browserToolNameOf(namespacedName) === 'batch';
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
    if (action === null || !(action in BATCH_STEP_CLASS)) return 'malformed';
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
 *
 * `input` is OPTIONAL and matters only for `batch`, whose class is not a
 * property of its name: a batch is classified by its HEAVIEST step, so the
 * arguments are the only place that class can be read from. Callers that do
 * not have the arguments to hand (the tool-list classifiers, the settings UI,
 * `browserToolPolicy.test.ts`'s sweep over `BROWSER_TOOL_SUFFIXES`) may keep
 * calling with one argument — a `batch` with no readable steps falls back to
 * the same gated `'interactive'` bucket as any other unclassified tool, which
 * is the safe direction: it over-asks, it never under-asks. `refuseBrowserBatch`
 * is the first lock on an unreadable batch; this is the second.
 */
export function classifyBrowserTool(
  namespacedName: string,
  input?: unknown,
): BrowserOperationClass | null {
  const toolName = browserToolNameOf(namespacedName);
  if (toolName === null) return null;
  if (toolName === 'batch') return classifyBrowserBatch(input);
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
 * A batch is its heaviest step. Anything unreadable — no arguments at all, a
 * `steps` that will not decode, a step kind this module has not been taught —
 * classifies `'interactive'`, the same gated fallback an unknown tool gets:
 * a call the gate cannot understand must not be the one that skips the ask.
 * (`refuseBrowserBatch` rejects those outright anyway; this is the second lock.)
 *
 * `'scripting'` is unreachable here by construction: a batch carrying a script
 * step is refused before it is ever classified, and `BATCH_STEP_CLASS` has no
 * scripting row. If that ever changes, the max below must learn to rank
 * scripting above interactive.
 */
function classifyBrowserBatch(input: unknown): BrowserOperationClass {
  const steps = decodeBatchSteps(input);
  if (steps === null || steps.length === 0) return 'interactive';
  for (const step of steps) {
    const action = stepAction(step);
    if (action === null) return 'interactive';
    const stepClass = BATCH_STEP_CLASS[action];
    if (stepClass === undefined || stepClass !== 'read-only') return 'interactive';
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

// ─────────────────────────────────────────────────────────────────────────
// Operation-class three-state policy + unattended master switch
// (batch-二「无人值守授权闭环」T1, `docs/abu-browser-batch2-brief-2026-09.md` §二)
// ─────────────────────────────────────────────────────────────────────────

/** Per-operation-class verdict. `ask` means "route through the confirmation
 *  channel available for the current run mode" — a dialog when attended, an
 *  IM approval round-trip when unattended (wired in a later task; this
 *  module only classifies the *policy*, not the channel). */
export type BrowserOperationState = 'allow' | 'deny' | 'ask';

/**
 * The policy persisted in settingsStore: one allow/deny/ask row per operation
 * class, keyed camelCase to match the settingsStore field naming convention
 * (`BrowserOperationClass` itself stays kebab-case because it is also a
 * tool-classification value).
 *
 * ## 2026-09-04 product ruling: ONE setting, two execution contexts
 *
 * This used to be two columns — `attended` and `unattended` — and the user set
 * every row twice. The ruling («不应该分在不在场，只要得到了用户允许，都能做»)
 * collapsed them: a permission the user granted is granted, and the run mode
 * decides only HOW it is carried out, not WHETHER.
 *
 *   allow → attended: proceed (the per-site gate still applies);
 *           automatic: proceed, once the master switch is on, the site carries
 *           a standing 'allowed' verdict and the page is not high-risk.
 *   ask   → attended: the in-app dialog;
 *           automatic: an IM approval round-trip, or an immediate `no_binding`
 *           refusal when the automation named nobody who could answer.
 *   deny  → refused in both.
 *
 * The automatic-run prerequisites (master switch, standing site grant,
 * not high-risk) did not move: they live where they always did —
 * `decideBrowserOperation`'s precedence steps and `registry.ts`'s
 * cross-origin fail-closed check — and they are what makes one shared value
 * safe to read from an unattended run.
 */
export interface BrowserOperationPolicy {
  readOnly: BrowserOperationState;
  interactive: BrowserOperationState;
  scripting: BrowserOperationState;
}

/**
 * The states one policy row may hold — all three, for every row.
 *
 * Scripting used to be the one restricted cell: under batch-二 the
 * automatic-task column offered it no `allow`, and the 2026-09-04 opt-in
 * ruling then reopened that tier as an explicit, warned, site-scoped choice.
 * With the columns collapsed into one setting (see `BrowserOperationPolicy`)
 * there is no cell left to restrict — a script the user allowed still needs
 * the master switch, a standing site grant and a non-high-risk page before an
 * automatic run may use it, and those conditions are enforced where they can
 * actually be evaluated (`decideBrowserOperation`, `registry.ts`), not by
 * withholding an option in the settings pane.
 *
 * The function is kept (rather than inlined) because it is the single seam
 * the settings UI reads its option list from, and the place a future
 * restricted row would be expressed.
 */
export function browserOperationStatesFor(
  _opClass: BrowserOperationClass,
): readonly BrowserOperationState[] {
  return ['allow', 'ask', 'deny'] as const;
}

/**
 * Product-spec defaults. These are exactly the values the two-column policy
 * shipped in its ATTENDED column, kept unchanged by the 2026-09-04 collapse:
 * read-only and interactive run unconfirmed (interactive still passes through
 * the existing per-site gate elsewhere; this policy layer does not relax
 * that), and scripting asks every time.
 *
 * What that means for an automatic run is decided by the conditions around
 * the value, not by a second copy of it: with the master switch off — its own
 * default — no automatic browser action happens at all, and with it on a
 * default-policy script `ask`s, which unattended means an IM approval
 * round-trip and, with nobody bound to answer, an immediate refusal. Nobody
 * acquires an unattended capability by upgrading.
 *
 * Exported so settingsStore's default state and its migration share the exact
 * same object instead of two hand-copied literals drifting apart.
 */
export const DEFAULT_BROWSER_OPERATION_POLICY: BrowserOperationPolicy = {
  readOnly: 'allow',
  interactive: 'allow',
  scripting: 'ask',
};

const OPERATION_CLASS_TO_POLICY_KEY: Record<
  BrowserOperationClass,
  keyof BrowserOperationPolicy
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
  /**
   * An ENTERPRISE policy refused this tool — a different thing from
   * `policy-denied`, which is the user's own three-state setting.
   *
   * It gets its own code precisely because the advice differs: "loosen the
   * setting in Settings → Capabilities" is the right next step for the
   * user's policy and actively wrong for an administered one (the user did
   * not set it and cannot change it there). Filing this under `policy-denied`
   * would make the card confidently give advice that cannot work.
   */
  | 'enterprise-policy-denied'
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
  /** The EXECUTION CONTEXT, not a second policy axis: since the 2026-09-04
   *  ruling both modes read the same configured row, and this only says which
   *  prerequisites and which confirmation channel apply. */
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

/**
 * The state a missing or unrecognized cell falls back to.
 *
 * `'ask'`, not `'deny'`. A malformed value means we cannot vouch for what the
 * user intended, and the honest response to that is to ask them — in the
 * dialog when they are here, over IM when a task is running and, with nobody
 * bound to answer, an immediate refusal. `'deny'` would be marginally
 * stricter and would silently take away a permission the user may well have
 * granted, with no prompt to reveal that anything was lost.
 *
 * It is also what the two-column policy clamped its ATTENDED column to, for
 * that same reason; the unattended column's stricter `'deny'` had no column
 * left to live in once the two collapsed into one value.
 */
const STRICTEST_OPERATION_STATE: BrowserOperationState = 'ask';

function normalizeClassPolicy(raw: unknown): BrowserOperationPolicy {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    readOnly: normalizeStateLeaf(row.readOnly, STRICTEST_OPERATION_STATE),
    interactive: normalizeStateLeaf(row.interactive, STRICTEST_OPERATION_STATE),
    scripting: normalizeStateLeaf(row.scripting, STRICTEST_OPERATION_STATE),
  };
}

/**
 * Coerce an arbitrary (possibly corrupted, partially-written, or hand-edited)
 * value into a well-formed `BrowserOperationPolicy` — the runtime counterpart
 * to the compile-time type, since persisted localStorage and any future
 * IPC/IM-delivered policy payload are not type-checked at the boundary.
 *
 * Any missing operation-class key, or leaf value outside
 * `'allow' | 'deny' | 'ask'`, is clamped to `STRICTEST_OPERATION_STATE`
 * rather than to the friendly product-spec default — a malformed value is a
 * signal something went wrong (corruption, a bug, manual tampering), and this
 * module's fail-safe posture (see `docs/abu-browser-batch2-brief-2026-09.md`'s
 * global constraint "任何新字段缺省=最严格档") treats "we don't know what this
 * row should be" as a question to put to the user rather than a permission to
 * assume. This is intentionally stricter than
 * `DEFAULT_BROWSER_OPERATION_POLICY`'s read-only/interactive `'allow'` — that
 * default is a deliberate, reviewed product choice for a KNOWN-absent field
 * (a pre-migration store), whereas this function handles the different case
 * of a PRESENT-but-broken value.
 *
 * It also accepts the LEGACY two-column shape (`{attended, unattended}`,
 * settingsStore v46). That shape sits in NO released copy of the app: v46 was
 * never published — `dev`, `main` and v0.42.0 all persist version 45 — so the
 * only stores carrying it are the ones this branch's own development machines
 * and e2e runs wrote. The compatibility is for those, and a released install
 * migrates 45 → 47 without ever seeing two columns.
 *
 * The 2026-09-04 ruling collapsed the columns by keeping the ATTENDED one —
 * that is where the user expressed what Abu may do, and the defaults the
 * merged policy ships are that column's values — so the unattended column is
 * read once, at migration time, only to be dropped. A dev store that had
 * tightened `attended` keeps that tightening; one that had tightened only
 * `unattended` loses a restriction whose column no longer exists, and the
 * automatic-run prerequisites (master switch, standing site grant, high-risk
 * exclusion) are what still stand behind it.
 *
 * A fully well-formed input passes through with the same values (not
 * necessarily the same object identity).
 */
export function normalizeBrowserOperationPolicy(input: unknown): BrowserOperationPolicy {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const legacyAttended = raw.attended;
  // Checked FIRST: a store still carrying the two-column shape has no
  // top-level rows at all, so reading it as the new shape would clamp every
  // row to `STRICTEST_OPERATION_STATE` and quietly reset a policy the user
  // had configured.
  return normalizeClassPolicy(
    legacyAttended !== null && typeof legacyAttended === 'object' ? legacyAttended : raw,
  );
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
 * 4. Otherwise, the configured three-state policy row for `opClass` decides,
 *    with two exceptions:
 *    - an UNATTENDED scripting `'allow'` is honoured only on a site carrying
 *      a standing `'allowed'` verdict (master switch and high-risk are
 *      already handled by 2 and 3). On any other site it is `'deny'`, not
 *      `'ask'`;
 *    - an ATTENDED `'allow'` on a high-risk site is upgraded to `'ask'` for
 *      the two acting classes. Read-only stays exactly as it was attended: a
 *      screenshot of a bank page is not a transfer, and asking on every
 *      observation is how a control trains users to click through it.
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
  const state = policy[OPERATION_CLASS_TO_POLICY_KEY[opClass]];
  /**
   * Automatic-task scripting — the one row whose configured `'allow'` is not
   * taken at face value here.
   *
   * `allow` here requires ALL THREE of:
   *   1. the unattended master switch is on — the user turned the whole
   *      surface on, not just this cell;
   *   2. the site carries a STANDING `'allowed'` verdict — the ruling's
   *      "effective only on sites the user set to 始终允许";
   *   3. the site is not high-risk — money movement and government pages are
   *      excluded from the opt-in the same way they are from everything else.
   *
   * Anything short of that is `deny`, deliberately NOT `ask`: `registry.ts`
   * refuses a state-changing action on a site with no standing grant anyway,
   * so routing it to an approval round-trip would wake a human at 3am to
   * approve something that is going to be refused either way.
   *
   * This is ALSO the load-bearing half of `mayUnattendedTierApproveBrowser`,
   * which asks this function whether an unattended capability tier may
   * approve a browser confirmation on its own. Without this clause an
   * `allow`ed scripting row would answer yes for any site, and that check
   * — which exists so a future gate refactor cannot reopen the "a chat
   * message got arbitrary code run" hole — would stop protecting anything.
   *
   * Only (2) is load-bearing HERE. (1) and (3) are already enforced by
   * precedence steps 2 and 3 above, and (3) is additionally SUBSUMED by (2):
   * `siteVerdict` is a single value, so `'high-risk'` REPLACES `'allowed'`
   * rather than accompanying it (see `DecideBrowserOperationSiteVerdict` and
   * `registry.ts`'s `const siteVerdict = highRisk ? 'high-risk' : stored`), and
   * a high-risk page therefore fails the standing-grant test on its own. So a
   * mutation that drops (1) or (3) from THIS line alone turns no test red —
   * the mutations that do are the ones removing the precedence steps, and
   * those are the ones the suite pins.
   *
   * The redundant conjuncts are written out anyway, deliberately: this is the
   * one place a reader sees the whole condition the ruling specified, and the
   * redundancy is what makes a later edit to the precedence order — or a
   * widening of the verdict union so 'allowed' and 'high-risk' can co-occur —
   * fail safe instead of silently widening this tier.
   */
  if (runMode === 'unattended' && opClass === 'scripting' && state === 'allow') {
    const optedIn = masterSwitchUnattended === true;
    const standingGrant = siteVerdict === 'allowed';
    const notHighRisk = siteVerdict !== 'high-risk';
    return optedIn && standingGrant && notHighRisk ? 'allow' : 'deny';
  }
  // Attended on a high-risk URL: a human is watching, so this asks rather than
  // denies — but it never runs silently. Read-only is exempt (see the
  // precedence doc above); a configured 'deny' is left alone, since upgrading
  // a deny to an ask would be a relaxation.
  if (siteVerdict === 'high-risk' && opClass !== 'read-only' && state === 'allow') return 'ask';
  return state;
}
