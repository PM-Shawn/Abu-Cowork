/**
 * Content Script — injected into web pages.
 *
 * Handles all DOM operations: snapshot, click, fill, wait, extract, etc.
 * Communicates with Background script via chrome.runtime.onMessage.
 */

import type {
  ElementInfo,
  ElementLocator,
  FindMatch,
  FindQuery,
  FindResult,
  PageHandoff,
  PageHandoffKind,
  PageSnapshot,
} from '../shared/types.js';

// Max text size returned by extractText (50KB)
const MAX_EXTRACT_TEXT_SIZE = 50_000;
// Max interactive elements returned by snapshot
const MAX_SNAPSHOT_ELEMENTS = 200;
// Max serialized size of a snapshot, measured the way the bridge serializes it
// (pretty-printed JSON — see `formatResult`), so the budget means the same
// thing here as it does on the wire. Chosen so a full enterprise form fits in
// one call: the page in the field report was ~8.5KB for 52 elements.
// The caller can raise it; what matters is that the cut happens here, with a
// message, rather than as a blind character slice further up the stack.
const MAX_SNAPSHOT_CHARS = 30_000;

interface ElectronBrowserRuntime {
  handleAction?: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
}

const electronBrowserRuntime = (
  globalThis as typeof globalThis & {
    __ABU_ELECTRON_BROWSER_RUNTIME__?: ElectronBrowserRuntime;
  }
).__ABU_ELECTRON_BROWSER_RUNTIME__;

// The same audited DOM runtime serves two transports:
// - Chrome extension messages in the ordinary extension isolated world.
// - Electron main requests in a dedicated WebContents isolated world.
// The Electron marker exists only in that isolated world; arbitrary pages
// cannot see it and still receive no Node/preload privileges.
if (electronBrowserRuntime) {
  electronBrowserRuntime.handleAction = handleAction;
} else {
  const reportVisible = (): void => {
    if (document.visibilityState === 'visible') {
      chrome.runtime.sendMessage({ type: 'tab_visible' }).catch(() => {
        // Background not ready or extension context invalidated — ignore
      });
    }
  };
  document.addEventListener('visibilitychange', reportVisible);
  reportVisible();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { action, payload } = message;

    handleAction(action, payload)
      .then((data) => sendResponse({ data }))
      .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));

    return true; // Keep message channel open for async response
  });
}

// --- Element Reference Registry (populated by snapshot) ---
//
// Refs must survive across snapshots. The agent's loop is snapshot → act →
// snapshot → act, and it keeps using refs it already holds. Clearing the map
// and restarting the counter on every snapshot made `e1` mean "first element
// of the most recent walk", so a ref silently retargeted whenever the DOM
// shifted — clicking a different control while reporting success. Identity has
// to be per-element, not per-walk.
//
// WeakRef/WeakMap because the page owns these elements, not us: on a
// single-page app one document outlives thousands of snapshots, and our
// bookkeeping must not be the thing that keeps detached nodes alive.
const refByElement = new WeakMap<Element, string>();
const elementByRef = new Map<string, WeakRef<Element>>();
let refCounter = 0;

/** Stable ref for an element — same element, same ref, for as long as it lives. */
function refFor(el: Element): string {
  const existing = refByElement.get(el);
  if (existing && elementByRef.get(existing)?.deref() === el) return existing;
  const ref = `e${++refCounter}`;
  refByElement.set(el, ref);
  elementByRef.set(ref, new WeakRef(el));
  return ref;
}

/** Resolve a ref, dropping it if the element is gone or detached. */
function resolveRef(ref: string): Element | null {
  const el = elementByRef.get(ref)?.deref();
  if (!el || !el.isConnected) {
    elementByRef.delete(ref);
    return null;
  }
  return el;
}

/** Drop refs whose elements have been collected or removed from the document. */
function sweepRefs(): void {
  for (const [ref, weak] of elementByRef) {
    const el = weak.deref();
    if (!el || !el.isConnected) elementByRef.delete(ref);
  }
}

/**
 * Actions that change page state and must land on the page the approval gate
 * decided on. Mirrors `ORIGIN_PINNED_ACTIONS` in `electron/browserHost.cjs`;
 * `execute_js` is absent here only because the extension channel runs it in
 * the background worker (`chrome.scripting.executeScript`), which pins it
 * itself — the Electron channel's `execute_js` never reaches this file either.
 * `navigate` is exempt in both places: its target IS what was approved.
 */
const ORIGIN_PINNED_ACTIONS = new Set(['click', 'fill', 'select', 'keyboard']);

/**
 * ## Execution-time origin pin, content-script half (U5, review round 1)
 *
 * The first round pinned only the built-in Electron browser. The extension
 * channel drives the user's REAL logged-in Chrome — the more dangerous of the
 * two — and dropped `expectedOrigin` on the floor, leaving the TOCTOU window
 * wide open exactly where it matters most.
 *
 * `location.origin` here is the TRUE execution point on this channel: whatever
 * the background worker believed about the tab, this is the document the click
 * is about to land in. `payload.expectedOrigin` / `payload.unattended` are
 * stamped by Abu's approval gate into MCP `_meta` and are unreachable from the
 * tool's input schema, so a page cannot forge either.
 *
 * The message is deliberately WORD-FOR-WORD the host's (`assertOriginPin` in
 * `electron/browserHost.cjs`) — the model must not have to learn two dialects
 * of the same refusal. `contentOriginPinMessage.test` pins that they match.
 *
 * Both run modes compare (review ruling I3): a sub-second redirect landing
 * between approval and execution is invisible to a watching human too. Only
 * the MISSING-value rule is unattended-only, so an attended call that carried
 * no pin keeps its exact pre-U5 path.
 */
function assertOriginPin(action: string, payload: Record<string, unknown>): void {
  if (!ORIGIN_PINNED_ACTIONS.has(action)) return;
  const expected = typeof payload.expectedOrigin === 'string' ? payload.expectedOrigin : '';
  if (!expected) {
    if (payload.unattended !== true) return;
    throw new Error(
      'Refused: this unattended run sent no approved origin for the page, so the action could not be '
      + 'verified against what was authorized. Call get_tabs to re-read where you are, then request this action again.',
    );
  }
  const current = normalizedOrigin(location.href);
  if (current === expected) return;
  // A SUBFRAME that fails the pin is a different situation from a top frame
  // that drifted, and the drift wording is advice that can never work there:
  // this frame is permanently a different site from the approved one, so "take
  // a fresh snapshot" would send the model round a loop it cannot exit. Same
  // refusal, honest attribution.
  if (window.top !== window) {
    throw new Error(
      `Refused: this action targeted a frame from a different site than the one approved (approved `
      + `${expected}, this frame is ${current ?? 'not an ordinary web page'}). Embedded third-party `
      + 'frames are not covered by that approval and a fresh snapshot will not change it — act on the '
      + 'main page, or ask for this site to be authorized separately.',
    );
  }
  throw new Error(
    `Refused: this tab is no longer on the page this action was approved for (approved ${expected}, `
    + `now ${current ?? 'an unknown page'}). The page moved — a redirect, a script navigation, or a `
    + 'reload. Take a fresh snapshot to re-read the current state before acting again; the earlier '
    + 'approval does not carry over to a different site.',
  );
}

/**
 * A frame that does not service the action must not ACT either (N1).
 *
 * Locator actions already stop on their own: `frameServicesAction` and
 * `findElementOrThrow` call the same `findElement` against the same document,
 * so a frame that answered "not mine" is structurally guaranteed to throw
 * "Element not found" moments later — that is a second guard, not a
 * coincidence. `keyboard` has no such guard: it dispatches at
 * `document.activeElement`, which every document has. So it needs an explicit
 * abstention, or a subframe would skip the pin AND press the key — exactly
 * what the pin exists to prevent.
 */
function assertFrameAbstains(payload: Record<string, unknown>): void {
  if (payload.locator !== undefined) return;
  throw new Error(
    'Nothing is focused in this frame, so there is nowhere to send the key press. '
    + 'Click the field you want to type into first, then send the key.',
  );
}

/**
 * Origin in the exact spelling `normalizeBrowserOrigin` (browserToolPolicy.ts)
 * and `normalizedOriginOf` (browserHost.cjs) produce, so all three ends of the
 * pin compare like with like: http(s) only, default ports dropped by URL, and
 * a trailing FQDN dot stripped (`evil.com.` and `evil.com` are one host over
 * DNS and must not be two origins here). Null for anything else, which the pin
 * treats as a mismatch — a document that is not an ordinary web page is not
 * the page the user approved.
 */
function normalizedOrigin(href: string): string | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname.endsWith('.')
      ? parsed.hostname.slice(0, -1)
      : parsed.hostname;
    if (!hostname) return null;
    return `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return null;
  }
}

/**
 * Will THIS frame actually service this action?
 *
 * `ensureContentScript` injects with `allFrames: true` and
 * `chrome.tabs.sendMessage` broadcasts without a frameId, so every frame in
 * the tab answers and the FIRST response wins. Without this check a benign
 * `about:blank` / `srcdoc` / cross-origin subframe — which has nothing to do
 * with the action — would answer the pin refusal ("the page moved, take a
 * fresh snapshot") for a top frame that never moved: a false, unactionable
 * refusal that loops the model back into the same race.
 *
 * So the pin is DEFERRED until the frame knows it is the one acting. Two
 * shapes:
 *
 * - **locator actions** (click/fill/select): the frame that resolves the
 *   target is the acting frame. A frame that cannot resolve it falls through
 *   to its ordinary "Element not found", exactly as it did before the pin
 *   existed. This is what keeps iframe-targeted actions working: an action
 *   aimed into a SAME-ORIGIN iframe is still pinned, by that iframe, and
 *   passes. An action aimed into a CROSS-ORIGIN iframe is not "pinned" so much
 *   as permanently refused — that frame can never match the approved origin —
 *   which is fail-closed and correct, but is a refusal, not support.
 * - **`keyboard`** (no locator — it dispatches at `document.activeElement`):
 *   the frame holding a real focused element is acting, and the TOP frame
 *   always checks. The top frame checking is not a false refusal: it refuses
 *   only when its own origin genuinely drifted, which is the true answer.
 *   A subframe with nothing focused stays silent.
 */
function frameServicesAction(action: string, payload: Record<string, unknown>): boolean {
  const locator = payload.locator as ElementLocator | undefined;
  if (locator !== undefined) {
    try {
      return findElement(locator) !== null;
    } catch {
      // A malformed locator resolves nowhere in any frame; let the ordinary
      // handler report it rather than turning it into a pin refusal.
      return false;
    }
  }
  const focused = document.activeElement;
  const hasRealFocus = focused !== null
    && focused !== document.body
    && focused !== document.documentElement;
  return hasRealFocus || window.top === window;
}

async function handleAction(action: string, payload: Record<string, unknown>): Promise<unknown> {
  // Before the switch, so no action can be added that forgets it — but only in
  // the frame that is going to act (see `frameServicesAction`). A frame that
  // is NOT acting abstains rather than falling through to do the work
  // unchecked (see `assertFrameAbstains`).
  if (ORIGIN_PINNED_ACTIONS.has(action)) {
    if (frameServicesAction(action, payload)) assertOriginPin(action, payload);
    else assertFrameAbstains(payload);
  }
  // U6 — advisory annotation runs AFTER the action and AFTER the pin, so a
  // page-derived detection can never reorder, skip, or excuse the pin. See
  // `annotateAdvisory`'s "advisory only" note.
  return annotateAdvisory(action, await dispatchAction(action, payload));
}

async function dispatchAction(action: string, payload: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'snapshot': return takeSnapshot(
      payload.selector as string | undefined,
      typeof payload.maxChars === 'number' ? payload.maxChars : undefined,
    );
    case 'find': return findElements(payload.query, payload.limit);
    case 'click': return clickElement(payload.locator as ElementLocator);
    case 'fill': return fillElement(payload.locator as ElementLocator, payload.value as string);
    case 'select': return selectOption(payload.locator as ElementLocator, payload.value as string);
    case 'wait_for': return waitFor(payload.condition as Record<string, unknown>, payload.timeout as number | undefined);
    case 'get_html': return getHtml(payload.selector as string | undefined);
    case 'extract_text': return extractText(payload.selector as string | undefined);
    case 'extract_table': return extractTable(payload.selector as string | undefined);
    case 'scroll': return scrollPage(payload as Record<string, unknown>);
    case 'keyboard': return sendKeyboard(payload as Record<string, unknown>);
    case 'start_recording': return startRecording();
    case 'stop_recording': return stopRecording();
    case 'fullpage_prepare': return fullpagePrepare();
    case 'fullpage_scroll': return fullpageScroll(payload.scrollTop as number);
    case 'fullpage_restore': return fullpageRestore(payload.scrollX as number, payload.scrollY as number);
    default: throw new Error(`Unknown content action: ${action}`);
  }
}

// =============================================================================
// 0. SENSITIVE VALUE REDACTION (U5)
// =============================================================================

/**
 * What a redacted field's value reads as. A marker, not an omission: an absent
 * `value` means "this field is empty", and the agent would then try to fill a
 * password box it should be leaving alone (or report the form as blank).
 */
const REDACTED_VALUE = '[value redacted]';

/**
 * `autocomplete` tokens whose value must never leave the page.
 *
 * `cc-*` covers the whole payment-card family the HTML spec defines
 * (`cc-number`, `cc-csc`, `cc-exp`, `cc-name`, …) with one rule, so a token
 * added to the spec later is covered without touching this file.
 */
function isSensitiveAutocompleteToken(token: string): boolean {
  return token === 'one-time-code'
    || token === 'current-password'
    || token === 'new-password'
    || token.startsWith('cc-');
}

/**
 * Should this control's CURRENT value be withheld?
 *
 * Two signals, both read off the element itself — never off page text:
 *  - `type="password"`;
 *  - a sensitive `autocomplete` token. The attribute is space-separated and
 *    may carry section/billing prefixes (`section-blue billing cc-number`), so
 *    every token is checked, case-insensitively (authors shout it).
 *
 * NOTE what this does NOT cover, deliberately: a site that puts a card number
 * in a `type="text"` box with no `autocomplete` is indistinguishable from an
 * order-number box at this layer. This is a leak-reducer on the fields that
 * declare themselves, not a classifier.
 */
function hasSensitiveValue(el: Element): boolean {
  const type = (el as HTMLInputElement).type;
  if (typeof type === 'string' && type.toLowerCase() === 'password') return true;
  const autocomplete = el.getAttribute('autocomplete');
  if (!autocomplete) return false;
  return autocomplete
    .toLowerCase()
    .split(/\s+/)
    .some((token) => isSensitiveAutocompleteToken(token));
}

/**
 * How to NAME a field in the on-page status bubble.
 *
 * The bubble lives in `document.documentElement`, so whatever goes into it is
 * readable by every script on the page, outlives the tool call, and comes back
 * out through `get_html`. `fill` and `select` used to put the value being
 * written there verbatim — the last plaintext channel on this surface, and one
 * that leaked values every other path redacts. The status now names the FIELD
 * (which the page already knows about itself) and never the value.
 */
function fieldLabel(el: Element): string {
  const placeholder = (el as HTMLInputElement).placeholder;
  return placeholder
    || el.getAttribute('aria-label')
    || el.getAttribute('name')
    || (el.id ? `#${el.id}` : '')
    || `<${el.tagName.toLowerCase()}>`;
}

/**
 * The value to report for a control: the real one, the redaction marker, or
 * `undefined` when the field is genuinely empty (an empty password box has
 * nothing to hide, and marking it would misreport the form's state).
 */
function reportableValue(el: Element, value: string, maxChars: number): string | undefined {
  if (!value) return undefined;
  return hasSensitiveValue(el) ? REDACTED_VALUE : value.slice(0, maxChars);
}

// =============================================================================
// 0.5 LOGIN WALLS AND DEAD ENDS (U6 / PRD F2.4 + F2.5)
// =============================================================================

/**
 * ## What this is
 *
 * Two page-feature detectors that give the agent something to say instead of
 * something to retry:
 *
 * - **`authState: 'login_required'`** — the page is a login wall. On the
 *   built-in Electron browser the main process detects this at the HTTP layer
 *   too (`browserHost.cjs`, 401/403-challenge + login-shaped navigation); the
 *   extension channel has no `webRequest`, so this is the ONLY detector there,
 *   and it reports under the same key so both channels read alike. Known
 *   asymmetry: the shell gate learns `authState` from the HOST's `get_tabs`,
 *   which the extension channel does not carry, so there an unattended run is
 *   not pre-refused — it acts, reads this annotation, and hands back per the
 *   narration rules. Reporting rather than refusing is deliberate for a
 *   page-feature signal: a false positive would otherwise silently break a
 *   working unattended run, with nobody watching to notice.
 * - **`handoff: { kind, hint }`** — a step no automation can finish: a CAPTCHA,
 *   a QR sign-in, a one-time code, an MFA push, WeChat's external-link
 *   interstitial, a blanked OAuth popup. The hint tells the model to stop and
 *   name the manual step.
 *
 * ## 🔴 Advisory only — never an authorization input
 *
 * These read PAGE CONTENT, which is attacker-controlled. They therefore feed
 * only hints and REFUSALS: a page claiming "login required" or showing a fake
 * CAPTCHA can make the agent stop, and can never make anything be allowed.
 * Structurally: the values travel in the tool RESULT (which no gate reads
 * back), the origin pin runs BEFORE any of this (see `handleAction`), and the
 * shell gate reads `authState` only on its deny side
 * (`registry.ts`). `contentDeadEnd.test.ts` pins that a page asserting
 * authorization changes nothing.
 *
 * ## 🔴 Never retry an MFA push
 *
 * Re-triggering a push approval is how push-bombing works, and providers treat
 * a burst of prompts as an attack: the user's account gets rate-limited,
 * locked, or flagged for compromise. The `mfa_push` hint says so in as many
 * words because the model's default instinct on a pending state is to retry.
 *
 * ## Deliberately incomplete, and why misses beat false positives
 *
 * Like `highRiskSites.ts`'s domain table, the patterns below are a short list
 * of unambiguous cases, not a classifier. Everything they miss simply behaves
 * as it did before this existed — the agent gets no hint, which is today's
 * status quo, not a new hole.
 *
 * A FALSE POSITIVE is the expensive direction, and the asymmetry is worth
 * spelling out because it drove every co-signal below. The narration rules
 * tell the model to STOP acting on the site and tell the user what to do by
 * hand. So a wrong detection does not merely add noise: it halts a working run
 * and reports something untrue. That is why every text pattern here is paired
 * with a STRUCTURAL co-signal — a CAPTCHA must be operable, an MFA push must
 * be polling, a one-time code must have a box short enough to hold one, a
 * login wall must be a sign-in-shaped form rather than any password box (a
 * signup page and a change-password page both have one of those). Text alone
 * matched a help article, a docs page, a blog post and a news story in review.
 */

/** Cap on the page text scanned per detection pass. */
const MAX_DETECTION_TEXT = 20_000;

/**
 * Page text for MATCHING only — never echoed into a result. Scrubbed with the
 * same `sensitiveValuesIn` net `extract_text` uses, so a detector can never
 * become a side channel for a value every other surface redacts.
 */
function detectionText(): string {
  const body = document.body;
  if (!body) return '';
  let text = ((body as HTMLElement).innerText ?? body.textContent ?? '').slice(0, MAX_DETECTION_TEXT);
  for (const secret of sensitiveValuesIn(body)) {
    text = text.split(secret).join(REDACTED_VALUE);
  }
  return text;
}

/** First laid-out match, or null. Off-screen scaffolding must not count. */
function visibleMatch(selector: string): Element | null {
  for (const el of document.querySelectorAll(selector)) {
    if (hasBox(el)) return el;
  }
  return null;
}

const CAPTCHA_FRAME_PATTERN = /(recaptcha|hcaptcha|turnstile|geetest|captcha)/i;
const CAPTCHA_SELECTOR =
  '[class*="captcha" i],[id*="captcha" i],[class*="geetest" i],'
  + '[class*="slide-verify" i],[class*="slider-verify" i],[class*="nc-container" i]';

/**
 * A CAPTCHA is something you OPERATE. Naming alone is not enough — a blog's
 * `<div class="post-captcha-explainer">` is an article about CAPTCHAs, and
 * announcing one there stops a working run on a page that has no challenge.
 */
// `[tabindex]:not([tabindex^="-"])` — NOT bare `[tabindex]` (N2). `tabindex="-1"`
// means "focusable by script, not reachable by the user", and it is the standard
// docs anchor-heading attribute, so accepting it let a text-only explainer
// satisfy the very co-signal added to reject text-only explainers.
const CAPTCHA_INTERACTIVE_SELECTOR =
  'iframe,canvas,input,button,textarea,[role="button"],[role="checkbox"],'
  + '[tabindex]:not([tabindex^="-"]),img[src^="data:"]';

function containerIsOperable(el: Element): boolean {
  if (el.matches(CAPTCHA_INTERACTIVE_SELECTOR)) return true;
  for (const child of el.querySelectorAll(CAPTCHA_INTERACTIVE_SELECTOR)) {
    if (hasBox(child)) return true;
  }
  return false;
}

/** Slider puzzles included: they are a CAPTCHA wearing a different coat. */
function hasCaptcha(): boolean {
  for (const frame of document.querySelectorAll('iframe')) {
    const surface = `${frame.getAttribute('src') ?? ''} ${frame.getAttribute('title') ?? ''}`;
    if (CAPTCHA_FRAME_PATTERN.test(surface) && hasBox(frame)) return true;
  }
  for (const el of document.querySelectorAll(CAPTCHA_SELECTOR)) {
    if (hasBox(el) && containerIsOperable(el)) return true;
  }
  return false;
}

const QR_SELECTOR = '[class*="qrcode" i],[class*="qr-code" i],[class*="qr_code" i],[id*="qrcode" i],[class*="scan-login" i]';
const QR_TEXT_PATTERN = /(scan (the )?(qr|code)|qr code to (log|sign) in|扫码|扫一扫|二维码)/i;

function hasQrLogin(text: string): boolean {
  if (visibleMatch(QR_SELECTOR) !== null) return true;
  // Text alone is not enough — an article ABOUT QR codes is not a QR login —
  // so it must sit next to something that could actually render one.
  return QR_TEXT_PATTERN.test(text) && visibleMatch('canvas,img[src^="data:image"],svg') !== null;
}

const OTP_TEXT_PATTERN =
  /(one[- ]?time (code|password)|verification code|security code we sent|enter the code (we )?sent|短信验证码|验证码已发送|输入验证码)/i;

/**
 * A box that could actually hold a 6-digit code. `visibleMatch('input')` was
 * no co-signal at all — nearly every page has an input, so a docs page with a
 * search box and the phrase "verification code flow" was classified as a code
 * prompt.
 */
// `input[type="tel"]` is deliberately ABSENT: a support form's phone field is a
// `tel` input, and pairing it with prose about codes was enough to report a
// dead end on a contact page. A numeric INPUTMODE or an explicit digit pattern
// is authored for a code; a phone number is not a code.
const NUMERIC_CODE_INPUT_SELECTOR =
  'input[inputmode="numeric"],input[pattern*="0-9"],input[pattern*="d"]';

/** The six-box OTP grid: several single-character boxes side by side. */
const OTP_GRID_MIN_BOXES = 4;

function hasShortCodeInput(): boolean {
  if (visibleMatch(NUMERIC_CODE_INPUT_SELECTOR) !== null) return true;
  let singleCharBoxes = 0;
  for (const el of document.querySelectorAll('input[maxlength]')) {
    const max = Number(el.getAttribute('maxlength'));
    if (!Number.isFinite(max) || !hasBox(el)) continue;
    // One box holding the whole code...
    if (max >= 4 && max <= 8) return true;
    // ...or the split grid, which is a code only in the plural.
    if (max === 1 && ++singleCharBoxes >= OTP_GRID_MIN_BOXES) return true;
  }
  return false;
}

function hasOneTimeCodeEntry(text: string): boolean {
  if (visibleMatch('input[autocomplete~="one-time-code"]') !== null) return true;
  return OTP_TEXT_PATTERN.test(text) && hasShortCodeInput();
}

const MFA_PUSH_PATTERN =
  /(approve (this |the )?(sign[- ]?in|login|request)|check your (authenticator|authentication) app|open your authenticator|we sent a (push )?notification|tap [^.]{0,20} to approve|请在(手机|移动设备)上确认|已发送(推送|通知)，请确认)/i;

/**
 * What a page WAITING on a push looks like structurally: it is polling, or it
 * is a dedicated push/2FA surface. Without this the sentence alone matched any
 * help article that describes the flow — and rule ④ then tells the model to
 * stop working on a documentation site.
 */
// `role="status"` and `aria-live="polite"` are deliberately ABSENT: every docs
// site puts a "Was this page helpful?" live region on the page, which made any
// help article describing push approval look like one.
const PENDING_WIDGET_SELECTOR =
  '[role="progressbar"],[aria-busy="true"],'
  + '[class*="spinner" i],[class*="loading" i],[class*="pending" i],[class*="waiting" i],'
  + '[class*="push" i],[class*="mfa" i],[class*="2fa" i],[class*="authenticator" i]';

/**
 * The fallback for a push screen that carries no widget class at all (Duo is
 * the common one). Length ALONE cannot carry this — a short help-doc paragraph
 * describing push approval is just as terse — so it is paired with the page
 * being an auth surface by address. Both together: a page that is at an auth
 * URL and says one thing and stops is a prompt, not documentation.
 */
const TERSE_AUTH_SURFACE_CHARS = 400;

/**
 * WHOLE path segments, not a `[/_.-]` boundary. The boundary form made every
 * hyphenated doc slug qualify — `/blog/2fa-explained`, `/help/verify-email`,
 * `/docs/auth-tokens` — which handed a short help page the same standing as
 * `/auth/duo`, the one thing this gate exists to distinguish.
 */
const AUTH_SURFACE_SEGMENTS: ReadonlySet<string> = new Set([
  'sign-in', 'signin', 'login', 'sso', 'auth', 'oauth', 'oauth2',
  'mfa', '2fa', 'duo', 'verify', 'challenge',
]);

function isAuthSurfacePath(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* a lone `%` — match on the raw path rather than on nothing */
  }
  return decoded.split('/').some((segment) => AUTH_SURFACE_SEGMENTS.has(segment.toLowerCase()));
}

function hasMfaPush(text: string): boolean {
  if (!MFA_PUSH_PATTERN.test(text)) return false;
  if (visibleMatch(PENDING_WIDGET_SELECTOR) !== null) return true;
  return text.trim().length <= TERSE_AUTH_SURFACE_CHARS && isAuthSurfacePath(location.pathname);
}

const WECHAT_PATTERN = /(在浏览器中打开|即将离开微信|请在微信客户端打开|点击右上角.*浏览器)/;

function isWeChatInterstitial(text: string): boolean {
  const host = location.hostname.toLowerCase();
  const wechatHost = host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com');
  return wechatHost || WECHAT_PATTERN.test(text);
}

const OAUTH_URL_PATTERN = /(?:^|\/)(oauth2?|authorize|signin-oidc|callback)(?:\/|$)/i;

/**
 * The OAuth popup that never came back. Abu's built-in browser DENIES
 * `window.open` and loads the target in the SAME tab, and a real Chrome popup
 * can be closed by the user or severed from its opener by COOP — either way
 * the flow strands on a blank provider page that no click can advance.
 *
 * ## Why it has to SETTLE first (I3)
 *
 * A perfectly healthy `/auth/callback` is blank and `readyState === 'complete'`
 * for as long as its JS takes to exchange the code — the single commonest
 * shape in OAuth. Calling that a dead end tells the model to abandon a sign-in
 * that was about to succeed. So "blank" must hold across MORE THAN ONE
 * detection pass, i.e. two separate tool calls against the same URL, which is
 * long enough that a real exchange has either rendered or redirected.
 *
 * The counter is keyed on the URL, so any navigation restarts the observation
 * rather than inheriting the previous page's evidence.
 */
let blankOauthObservation: { href: string; passes: number } | null = null;

function isStrandedOauthPage(text: string): boolean {
  const blankNow = document.readyState !== 'loading'
    && OAUTH_URL_PATTERN.test(location.pathname)
    && text.trim().length <= 40
    && visibleMatch('input,button,a[href],form') === null;
  if (!blankNow) {
    blankOauthObservation = null;
    return false;
  }
  const href = location.href;
  blankOauthObservation = blankOauthObservation?.href === href
    ? { href, passes: blankOauthObservation.passes + 1 }
    : { href, passes: 1 };
  return blankOauthObservation.passes > 1;
}

const HANDOFF_HINTS: Record<PageHandoffKind, string> = {
  captcha:
    'This page is showing a CAPTCHA (a checkbox, image, or slider challenge). Do not retry the '
    + 'action and do not try to solve it. Stop, tell the user which page is asking, and ask them to '
    + 'complete the challenge themselves before you continue.',
  qr_login:
    'This page signs in by QR code, which only a person holding the phone can scan. Do not retry. '
    + 'Stop and ask the user to scan the code shown on this page, then continue once they say they '
    + 'are signed in.',
  sms_code:
    'This page is asking for a one-time code sent to the user by SMS, email, or an authenticator. '
    + 'You cannot read it. Do not retry or guess. Stop and ask the user for the code, or ask them to '
    + 'enter it themselves.',
  mfa_push:
    'This page is waiting for the user to approve a push prompt in their authenticator app. NEVER '
    + 'retry or re-trigger it: repeated push prompts are how push-bombing attacks work, and the '
    + 'provider may lock or flag the account. Stop and ask the user to approve the prompt once on '
    + 'their device.',
  wechat_external_link:
    'WeChat has intercepted this link and is asking for it to be opened in a browser. Retrying '
    + 'inside WeChat will keep landing here. Stop and ask the user to open the link in a browser.',
  oauth_popup:
    'The sign-in window this page opened is gone or blank, so the OAuth flow cannot finish here. Do '
    + 'not retry the popup. Ask for the provider\'s redirect flow instead (navigate to the '
    + 'authorization URL in this tab), or ask the user to complete the sign-in themselves.',
};

/**
 * First match wins, most specific first. Order matters only for which hint the
 * model reads: every kind says the same thing about retrying.
 */
function detectHandoff(text: string): PageHandoff | null {
  const kind: PageHandoffKind | null =
    isWeChatInterstitial(text) ? 'wechat_external_link'
      : hasCaptcha() ? 'captcha'
        : hasQrLogin(text) ? 'qr_login'
          : hasMfaPush(text) ? 'mfa_push'
            : hasOneTimeCodeEntry(text) ? 'sms_code'
              : isStrandedOauthPage(text) ? 'oauth_popup'
                : null;
  return kind === null ? null : { kind, hint: HANDOFF_HINTS[kind] };
}

// `401 Unauthorized`, `login required` and `authentication required` are all
// deliberately ABSENT, for one reason: they are what DOCUMENTATION about
// authentication says, not what an auth wall says to a person. The built-in
// browser already detects the real condition at the HTTP layer
// (`browserHost.cjs`), earlier and unforgeably. What is left are sentences
// addressed to a reader, which prose about auth does not contain.
const AUTH_WALL_TEXT_PATTERN =
  /(sign in to continue|log in to continue|please (sign|log) in|your session has expired|session expired|请先登录|登录已过期|请重新登录)/i;

/**
 * Pages that HAVE a password box and are NOT asking you to sign in. Signing up
 * and changing a password are things an agent legitimately does while fully
 * authenticated; reporting "your session expired" there stops a working run and
 * tells the user something false.
 */
// `create[ ]<up to two words>[ ]account` rather than a fixed article list: the
// governing-heading test caught `create (an? )?account` missing "Create YOUR
// account" and "Create your free account", which is how most signup panels
// actually word it.
const NOT_A_SIGN_IN_PATTERN =
  /(create[ \t]+(?:[a-z]+[ \t]+){0,2}account|sign up|signing up|registration|register now|change (your )?password|new password|reset (your )?password|注册账号|注册新用户|修改密码|设置新密码|重置密码)/i;

/** A field that names WHO is signing in — a login form has one, a password-change form does not. */
const IDENTIFIER_INPUT_SELECTOR =
  'input[autocomplete~="username"],input[autocomplete~="email"],input[type="email"],'
  + '[name*="user" i],[name*="email" i],[name*="login" i],[name*="account" i],'
  + '[id*="user" i],[id*="email" i]';

/**
 * The form the password box lives in, plus the nearest heading that describes
 * it — and NOTHING else on the page (N1).
 *
 * The first attempt tested `NOT_A_SIGN_IN_PATTERN` against the whole
 * `body.innerText`, which is not a co-signal at all: nearly every real login
 * page links to "Create an account" or "Reset your password", so the veto fired
 * on precisely the pages this feature exists for. A co-signal has to be
 * structurally LOCAL to the thing being detected; a page-wide text veto is an
 * off switch any page can trip.
 *
 * NAVIGATION LABELS are stripped before matching, and that is the crux:
 * "Create an account" as a link or a secondary button is a way OFF this page,
 * while the same words as a heading are the page describing ITSELF. That one
 * distinction separates a login page from a signup page more reliably than any
 * wording list. Buttons count as navigation too — the second round stripped
 * only links, and a login form with a "Create an account" button silently
 * stopped being detected.
 */
const NAVIGATION_LABEL_SELECTOR =
  'a,[role="link"],button,[role="button"],input[type="button"],input[type="submit"]';

function signInScopeText(passwordBox: Element): string {
  const scope = passwordBox.closest('form,[role="form"]')
    ?? passwordBox.closest('section,article,main')
    ?? passwordBox.parentElement
    ?? passwordBox;
  const clone = scope.cloneNode(true) as Element;
  for (const label of clone.querySelectorAll(NAVIGATION_LABEL_SELECTOR)) label.remove();
  return `${nearestHeadingText(scope)} ${clone.textContent ?? ''}`;
}

/**
 * The closest heading that GOVERNS `scope` — and never one that merely shares
 * an ancestor with it.
 *
 * The ancestor walk is the last place the "structurally local" rule was not
 * applied, and it failed in the single commonest SaaS login layout: a promo
 * `<aside>` beside the sign-in `<form>` inside one wrapper. A `querySelector`
 * on that wrapper returns the FIRST heading in document order, which is the
 * marketing one — and marketing copy on a login page is exactly where signup
 * wording lives. So the widened lookup did not pick an arbitrary heading, it
 * reliably picked the worst possible one, and the miss was silent: no
 * annotation, no refusal, nothing a gate could see.
 *
 * The bound: inside `scope` any descendant heading counts (scope contains the
 * password box). Above it, only a heading that is a DIRECT CHILD of an ancestor
 * on the box's own path — which is what "governs" means structurally. A heading
 * nested inside a SIBLING subtree describes that sibling, not us.
 */
function nearestHeadingText(scope: Element): string {
  const own = scope.querySelector('h1,h2,h3,legend,[role="heading"]');
  if (own && hasBox(own)) return own.textContent ?? '';
  for (let node = scope.parentElement; node; node = node.parentElement) {
    for (const child of node.children) {
      if (!child.matches('h1,h2,h3,legend,[role="heading"]')) continue;
      if (hasBox(child)) return child.textContent ?? '';
    }
    if (node.tagName === 'BODY') break;
  }
  return '';
}

/**
 * Exactly ONE on-screen password box, not a new-password one, next to a field
 * naming the account, on a form that does not describe itself as signup or
 * password-change. Signup and password-change forms fail on the count, on
 * `new-password`, or on their own heading; a re-auth prompt with no identifier
 * field is a deliberate miss (misses are preferred — see the module note).
 */
function looksLikeSignInForm(): boolean {
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(hasBox);
  if (passwords.length !== 1) return false;
  const autocomplete = (passwords[0].getAttribute('autocomplete') ?? '').toLowerCase();
  if (autocomplete.includes('new-password')) return false;
  if (visibleMatch(IDENTIFIER_INPUT_SELECTOR) === null) return false;
  return !NOT_A_SIGN_IN_PATTERN.test(signInScopeText(passwords[0]));
}

/**
 * A login wall, from page features: a sign-in-shaped form, or one of a short
 * list of auth-wall sentences.
 *
 * The sentence path carries NO veto (N1). "Your session has expired" is the
 * page telling us the answer directly; a signup link somewhere else on it
 * cannot make that untrue, and letting one do so silenced the single clearest
 * signal this detector has.
 */
function detectAuthWall(text: string): boolean {
  if (looksLikeSignInForm()) return true;
  return AUTH_WALL_TEXT_PATTERN.test(text);
}

/**
 * Actions whose result the model reads to decide what to do next. Deliberately
 * NOT every action:
 *
 *  - detection reads `body.innerText`, which forces a layout flush, so the
 *    mechanical actions (`scroll`, the `fullpage_*` screenshot steps, the
 *    recorder) must not pay for it on every call;
 *  - a `fullpage_*` result is screenshot plumbing, and a stray advisory key on
 *    one is noise in a place nothing reads prose.
 *
 * String-returning actions (`get_html`, `extract_text`) are absent for a
 * different reason — see `annotateAdvisory`.
 */
const ADVISORY_ANNOTATED_ACTIONS = new Set([
  'snapshot', 'click', 'fill', 'select', 'wait_for', 'extract_table',
]);

/**
 * The one place a result grows advisory fields. Only plain objects are
 * annotated: string results (`get_html`, `extract_text`) are page content the
 * caller slices and searches, and splicing a sentence into one would corrupt
 * exactly the thing it was asked for.
 */
function annotateAdvisory(action: string, result: unknown): unknown {
  if (!ADVISORY_ANNOTATED_ACTIONS.has(action)) return result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  const existing = result as Record<string, unknown>;
  if ('authState' in existing || 'handoff' in existing) return result;

  let text: string;
  try {
    text = detectionText();
  } catch {
    // Detection is advisory: a page that breaks it must not break the action
    // whose result this is.
    return result;
  }
  const handoff = detectHandoff(text);
  const loginRequired = detectAuthWall(text);
  if (!handoff && !loginRequired) return result;
  return {
    ...existing,
    ...(loginRequired ? { authState: 'login_required' as const } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

// =============================================================================
// 1. SNAPSHOT — Structured page element extraction
// =============================================================================

function takeSnapshot(
  scopeSelector?: string,
  maxChars: number = MAX_SNAPSHOT_CHARS,
): PageSnapshot {
  // `selector` means "narrow to this region". When several elements match,
  // all of them are the region — taking `querySelector`'s first match silently
  // picked one of three dropdown popups (the closed one) and returned an empty
  // snapshot, which reads as "nothing here" and sends the caller off to script
  // the page. Same defect as a text locator resolving to the first ancestor:
  // never resolve an ambiguous target by position.
  const roots: Element[] = scopeSelector
    ? [...document.querySelectorAll(scopeSelector)]
    : (document.body ? [document.body] : []);
  if (roots.length === 0) {
    throw new Error(
      `Scope element not found: ${scopeSelector}. ` +
      `Take a snapshot without a selector to see what the page actually contains.`
    );
  }

  // Refs deliberately survive across snapshots — see the registry above.
  // Sweeping first keeps the map from growing without bound on long-lived SPAs.
  sweepRefs();

  const interactiveTags = new Set([
    'a', 'button', 'input', 'textarea', 'select', 'details', 'summary',
  ]);

  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'listbox', 'option', 'menuitem', 'tab', 'switch', 'slider',
  ]);

  // Popups that are open right now. Their rows are what a user would click,
  // and on antd they carry no ARIA role at all — the roles live on a separate
  // zero-sized mirror — so nothing above would classify them as interactive
  // and an open dropdown looked empty. Anchoring on the listbox/menu that IS
  // roled keeps this generic instead of a per-library selector list.
  const openPopups = [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="grid"]')]
    .map((list) => popupRootFor(list))
    .filter((popup) => hasBox(popup));
  const isPopupRow = (el: Element): boolean => {
    if (openPopups.length === 0) return false;
    if (!hasBox(el)) return false;
    if (!openPopups.some((popup) => popup !== el && popup.contains(el))) return false;
    // A row is a leaf as far as laid-out content goes.
    if ([...el.children].some((child) => hasBox(child))) return false;
    const text = normalizedText(el);
    return text.length > 0 && text.length <= 100;
  };

  const elements: ElementInfo[] = [];
  const seenElements = new WeakSet<Element>();
  let hitCap = false;

  for (const root of roots) {
    if (hitCap) break;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.currentNode;
    while (node) {
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();

    const isInteractive =
      interactiveTags.has(tag) ||
      el.hasAttribute('onclick') ||
      el.hasAttribute('tabindex') ||
      (el.getAttribute('role') && interactiveRoles.has(el.getAttribute('role')!)) ||
      (el as HTMLElement).contentEditable === 'true' ||
      (tag === 'div' && el.getAttribute('role') && interactiveRoles.has(el.getAttribute('role')!)) ||
      isPopupRow(el);

    if (isInteractive && !seenElements.has(el) && isSnapshotVisible(el)) {
      // Scopes can nest or overlap; an element must be listed once.
      seenElements.add(el);
      const info: ElementInfo = {
        ref: refFor(el),
        tag,
        enabled: !(el as HTMLButtonElement).disabled,
        visible: true,
      };

      // Text content (truncated)
      const text = getVisibleText(el);
      if (text) info.text = text.slice(0, 100);

      // `id` / `name` cost a few characters and save a round trip: they are
      // what a caller needs to build a css locator that outlives a reload,
      // and without them the only way to learn a field's selector was to run
      // a script against the DOM.
      if (el.id) info.id = el.id;
      const nameAttr = el.getAttribute('name');
      if (nameAttr) info.name = nameAttr;

      // Input-specific
      if (tag === 'input') {
        const input = el as HTMLInputElement;
        info.type = input.type;
        if (input.placeholder) info.placeholder = input.placeholder;
        // Everything else about the field still ships — a redacted value must
        // not cost the agent the ability to find and fill it.
        const value = reportableValue(input, input.value, 100);
        if (value !== undefined) info.value = value;
        if (input.type === 'checkbox' || input.type === 'radio') {
          info.checked = input.checked;
        }
      }

      if (tag === 'textarea') {
        const ta = el as HTMLTextAreaElement;
        if (ta.placeholder) info.placeholder = ta.placeholder;
        const value = reportableValue(ta, ta.value, 200);
        if (value !== undefined) info.value = value;
      }

      if (tag === 'select') {
        const select = el as HTMLSelectElement;
        // The OPTION LIST stays: it is the page's own static set of choices
        // (`01`…`12` on a card-expiry select), it is identical for every
        // visitor, and without it the agent cannot pick a value at all — the
        // same "must not break filling" rule the input branch follows.
        // What is redacted is the SELECTION, which is the user's own datum.
        info.options = [...select.options].map(o => ({ value: o.value, text: o.text }));
        const value = reportableValue(select, select.value, 100);
        if (value !== undefined) info.value = value;
      }

      if (tag === 'a') {
        info.href = (el as HTMLAnchorElement).href;
      }

      // ARIA
      const role = el.getAttribute('role');
      if (role) info.role = role;
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) info.ariaLabel = ariaLabel;

      elements.push(info);
      if (elements.length >= MAX_SNAPSHOT_ELEMENTS) { hitCap = true; break; }
    }

      node = walker.nextNode();
    }
  }

  // Bound the payload here, at the only place that still knows what an element
  // is. Anything downstream can only cut characters, which turns a snapshot
  // into invalid JSON and drops refs without saying which ones went missing.
  const hitElementCap = elements.length >= MAX_SNAPSHOT_ELEMENTS;
  const total = elements.length;

  // Longest prefix that fits, found by binary search on the real serialized
  // size. Measuring exactly matters — an estimate that runs a little over
  // hands the payload to the upstream character-slicer, which is the failure
  // this budget exists to prevent. Binary search keeps it to ~8 passes instead
  // of the quadratic pop-and-re-serialize.
  const serializedLength = (count: number) => JSON.stringify(elements.slice(0, count), null, 2).length;
  let kept = total;
  if (serializedLength(total) > maxChars) {
    let low = 1;      // always return at least one element: a single oversized
    let high = total; // element is more useful than an empty list
    kept = 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (serializedLength(mid) <= maxChars) {
        kept = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    elements.length = kept;
  }
  const overBudget = kept < total;

  // A scope that matched something but holds nothing actionable is not the
  // same as an empty page, and saying so is what keeps the caller from
  // concluding the tools are broken and scripting the page instead.
  if (elements.length === 0 && scopeSelector) {
    return {
      url: location.href,
      title: document.title,
      elements,
      message:
        `"${scopeSelector}" matched ${roots.length} element${roots.length === 1 ? '' : 's'}, ` +
        `none of which contain anything interactive right now — a popup that is closed looks like this. ` +
        `Take a snapshot without a selector to see the whole page, or open the control first.`,
    };
  }

  const reasons: string[] = [];
  if (hitElementCap) reasons.push(`the ${MAX_SNAPSHOT_ELEMENTS}-element cap`);
  if (overBudget) reasons.push(`the ${maxChars}-character budget`);

  return {
    url: location.href,
    title: document.title,
    elements,
    ...(reasons.length
      ? {
        truncated: true,
        message:
            `Showing ${elements.length} of ${total}+ interactive elements — hit ${reasons.join(' and ')}. ` +
            `To see the rest: pass \`selector\` to scope the snapshot to one region ` +
            `(e.g. the form you are filling), or raise \`maxChars\`. ` +
            `The elements listed above are complete and their refs are valid.`,
      }
      : {}),
  };
}

// =============================================================================
// 2. ELEMENT LOCATOR — Multi-strategy element finding
// =============================================================================

/**
 * Escape a string for use in CSS attribute selectors.
 * Uses CSS.escape if available, otherwise a basic fallback.
 */
function escapeCSS(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) {
    return CSS.escape(value);
  }
  // Fallback: escape special chars
  return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

/** Elements that contain everything and are never a meaningful target. */
const NEVER_A_TARGET = new Set(['html', 'body', 'head', 'script', 'style', 'noscript', 'title']);

/**
 * Abu's own on-page UI: the highlight ring and the status bubble.
 *
 * These live on `document.documentElement`, outside `<body>`, so `snapshot`
 * never sees them — but every locator scans the document, and the bubble
 * echoes what was just done ("Abu: Click: 保存"). A `{text:"保存"}` locator
 * issued after a 保存 click therefore found the real button AND our own
 * caption, and the second call in a row became "matches 2 elements". The
 * automation must never be able to act on, or trip over, its own overlay.
 */
const ABU_OVERLAY_IDS = new Set(['abu-status', 'abu-highlight']);

function isAbuOverlay(el: Element): boolean {
  return ABU_OVERLAY_IDS.has(el.id);
}

/** Short, human-readable handle for an element, used in error messages. */
function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
  const text = (getVisibleText(el) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return `[${refFor(el)}] <${tag}${id}${cls}>${text ? ` "${text}"` : ''}`;
}

function isClickable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'option'].includes(tag)) return true;
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
  const role = el.getAttribute('role');
  return role !== null && ['button', 'link', 'option', 'menuitem', 'tab', 'checkbox', 'radio', 'switch'].includes(role);
}

// -----------------------------------------------------------------------------
// 2a. ACCESSIBLE SEMANTICS — implicit roles and accessible names
//
// A `{role, name}` locator used to be compiled into the attribute selector
// `[role="button"][aria-label="保存"]`, which can only ever match a page that
// spells its semantics out in attributes. Ordinary HTML does not: `<button>
// 保存</button>` carries the role in its tag and the name in its text, so the
// most natural locator a model can write returned "Element not found" and sent
// it off to script the page instead. What follows is the minimum needed to
// make that locator mean what a browser (and Playwright, and a screen reader)
// means by it.
//
// Deliberately NOT a full ARIA accname implementation: no `::before`/`::after`
// generated content, no recursive name computation, no `aria-owns` reordering,
// no role inheritance chains. Those matter for conformance testing; the eight
// native roles and six name sources below are what office forms are made of.
// -----------------------------------------------------------------------------

/** `<input type>` values that are buttons. Their name comes from `value`/`alt`. */
const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'image']);

/**
 * `<input type>` values that are text boxes. An input with no `type` at all
 * defaults to `text`, hence the empty string. Types outside this set (`date`,
 * `range`, `file`, `color`, …) map to roles this module does not model, and
 * claiming `textbox` for them would make an ambiguity check count elements the
 * caller never meant — so they get no implicit role at all.
 */
const TEXTBOX_INPUT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number']);

/** Tag → implicit role, for the tags whose role does not depend on attributes. */
const IMPLICIT_ROLE_BY_TAG: Record<string, string> = {
  button: 'button',
  textarea: 'textbox',
  select: 'combobox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  summary: 'button',
};

/**
 * The tags that can carry each implicit role, so a role lookup can stay a
 * single narrow `querySelectorAll` instead of walking every node on the page
 * and reading its attributes.
 */
const IMPLICIT_ROLE_SELECTORS: Record<string, string> = {
  button: 'button, input, summary',
  link: 'a[href]',
  textbox: 'input, textarea',
  checkbox: 'input',
  radio: 'input',
  combobox: 'select',
  heading: 'h1, h2, h3, h4, h5, h6',
  img: 'img',
};

/** `type`, lowercased, defaulting to the empty string (which means `text`). */
function inputType(el: Element): string {
  return (el.getAttribute('type') ?? '').trim().toLowerCase();
}

/** The role a native element has without anyone writing `role=`. */
function implicitRole(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = inputType(el);
    if (BUTTON_INPUT_TYPES.has(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (TEXTBOX_INPUT_TYPES.has(type)) return 'textbox';
    return null;
  }
  // A bare `<a>` with no href is a generic span as far as ARIA is concerned.
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
  // `alt=""` is how a page says "this image is decorative" — respecting it
  // keeps spacer GIFs out of an `{role:"img"}` match.
  if (tag === 'img') return el.getAttribute('alt') === '' ? null : 'img';
  return IMPLICIT_ROLE_BY_TAG[tag] ?? null;
}

/**
 * The role a locator should match: an explicit `role=` wins, otherwise the
 * native one. A role attribute may list fallbacks (`role="doc-subtitle
 * heading"`); the first token is the effective one.
 */
function effectiveRole(el: Element): string | null {
  const explicit = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0];
  if (explicit) return explicit.toLowerCase();
  return implicitRole(el);
}

/**
 * Roles whose accessible name may be taken from their own text.
 *
 * The exclusions are what matter: a `<select>`'s text content is the
 * concatenation of every option ("北京上海广州"), and a `<textarea>`'s is its
 * default value. Naming those from content would invent names no user ever
 * sees and make `{role:"combobox", name:"..."}` match by accident.
 */
const NAME_FROM_CONTENT_ROLES = new Set([
  'button', 'link', 'heading', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'treeitem',
  'cell', 'gridcell', 'columnheader', 'rowheader', 'row', 'tooltip',
]);

/** Elements a native `<label>` can name. */
const LABELABLE_TAGS = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);

/** Trim, and collapse every run of whitespace to one space. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Whitespace removed entirely — see `looselyNamed` for why this exists. */
function squashWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * Text of the native `<label>`s naming this control — both spellings:
 * `<label for="id">` anywhere in the document, and an ancestor `<label>` the
 * control sits inside.
 *
 * This is the single highest-value entry in the whole fallback chain. An
 * office form's inputs almost never carry `aria-label` or `role`; the label is
 * the only thing on the page that says what the field is, and it is what the
 * user calls it when they say "put my name in 姓名".
 *
 * `aria-describedby` is deliberately not consulted: a description ("8-20
 * characters") is not a name, and treating it as one makes two different
 * fields answer to the same locator.
 */
function nativeLabelText(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (!LABELABLE_TAGS.has(tag)) return '';
  if (tag === 'input' && inputType(el) === 'hidden') return '';

  // Collected by element identity, not by text: `<label for="x">姓名<input
  // id="x"></label>` — the shape form libraries and accessibility tutorials
  // both emit — is reachable BOTH ways, and pushing the same <label> twice
  // named the field "姓名 姓名". That name misses the exact and normalized
  // tiers, so `{name:"姓名"}` fell through to the substring tier, where any
  // unrelated `aria-label="姓名"` control wins the exact tier outright and
  // gets filled instead.
  const labels = new Set<Element>();
  if (el.id) {
    // Compared as attribute values rather than interpolated into a selector:
    // an id is author-controlled, and no escaping scheme has to be trusted if
    // nothing is ever concatenated into a query.
    for (const label of document.querySelectorAll('label[for]')) {
      if (label.getAttribute('for') === el.id) labels.add(label);
    }
  }
  const wrapping = el.closest?.('label');
  if (wrapping) labels.add(wrapping);

  const parts = [...labels].map((label) => normalizeWhitespace(label.textContent ?? ''));
  return normalizeWhitespace(parts.filter(Boolean).join(' '));
}

/**
 * The accessible name of an element, by the six sources that carry office
 * forms, first non-empty wins:
 *
 *   1. `aria-labelledby` — the IDREF list, joined
 *   2. `aria-label`
 *   3. the native `<label>` (for/id, or wrapping)
 *   4. `alt` / `value` (buttons only) / `title`
 *   5. its own visible text — only for roles that take a name from content
 *   6. `placeholder`
 */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const joined = labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
      .map((node) => normalizeWhitespace(node.textContent ?? ''))
      .filter(Boolean)
      .join(' ');
    if (joined) return joined;
  }

  const ariaLabel = normalizeWhitespace(el.getAttribute('aria-label') ?? '');
  if (ariaLabel) return ariaLabel;

  const label = nativeLabelText(el);
  if (label) return label;

  const alt = normalizeWhitespace(el.getAttribute('alt') ?? '');
  if (alt) return alt;
  if (el.tagName.toLowerCase() === 'input' && BUTTON_INPUT_TYPES.has(inputType(el))) {
    const value = normalizeWhitespace((el as HTMLInputElement).value ?? '');
    if (value) return value;
  }
  const title = normalizeWhitespace(el.getAttribute('title') ?? '');
  if (title) return title;

  const role = effectiveRole(el);
  if (role !== null && NAME_FROM_CONTENT_ROLES.has(role)) {
    const text = normalizeWhitespace(el.textContent ?? '');
    if (text) return text;
  }

  return normalizeWhitespace(el.getAttribute('placeholder') ?? '');
}

/**
 * Whether an element can be matched by a locator at all.
 *
 * `isSnapshotVisible` rather than the stricter `isVisible` on purpose: antd's
 * combobox puts the semantics on a `width: 0` `<input>` beside the span the
 * user sees, so "has a layout box" would make every dropdown on the page
 * unaddressable. The two extra checks below are the states that test cannot
 * see — `hidden` is applied by the UA stylesheet, and `type="hidden"` inputs
 * are laid out nowhere but are still perfectly ordinary inputs.
 */
function isLocatorVisible(el: Element): boolean {
  if (el.hasAttribute('hidden')) return false;
  if (el.tagName.toLowerCase() === 'input' && inputType(el) === 'hidden') return false;
  // Out of the accessibility tree, by the page's own declaration. A role/name
  // locator IS an accessibility-tree query, so matching a mirror the author
  // explicitly removed from it is wrong on the locator's own terms — and it is
  // how a duplicated render (antd's fixed table columns, a carousel, a
  // screen-reader mirror) made a normal page permanently ambiguous.
  if (el.closest?.('[aria-hidden="true"]')) return false;
  // `inert` is the platform's "present but unreachable" — the layer behind an
  // open modal. It cannot receive the click we would dispatch, so counting it
  // only blocks the copy that can.
  if (el.closest?.('[inert]')) return false;
  if (isFullyTransparent(el)) return false;
  return isSnapshotVisible(el);
}

/**
 * Painted, full-size, and invisible: a copy the user cannot see or click.
 *
 * Scoped to elements that HAVE a layout box on purpose. Two documented cases
 * are transparent deliberately and are still the right target, and both have a
 * *collapsed* box, so they never reach this test: antd's `role="combobox"`
 * lives on a `width: 0; opacity: 0` <input> (see `isSnapshotVisible`), and a
 * popup mid-entrance-animation sits at `opacity: 0` with a collapsed box and
 * never leaves that state in a background tab (see `isRendered`, which turns
 * `checkOpacity` off for exactly this reason). Widening the rule past "has a
 * box" would make every dropdown on the page unaddressable.
 */
function isFullyTransparent(el: Element): boolean {
  if (!hasBox(el)) return false;
  // opacity does not inherit — a transparent wrapper still reports `1` on its
  // children — so the chain has to be walked.
  for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
    if (getComputedStyle(node as HTMLElement).opacity === '0') return true;
  }
  return false;
}

/** A locator may land here — page content, visible, and not our own overlay. */
function isLocatorTarget(el: Element): boolean {
  if (NEVER_A_TARGET.has(el.tagName.toLowerCase())) return false;
  if (isAbuOverlay(el)) return false;
  return isLocatorVisible(el);
}

/**
 * Every element carrying `role`, explicit or implicit.
 *
 * `[role]` catches the attribute spelling; the tag list catches the native
 * one. An unmapped role (`dialog`, `alert`, …) scans only `[role]`, which is
 * correct — this module claims no implicit mapping for those.
 */
function elementsWithRole(role: string): Element[] {
  const wanted = role.trim().toLowerCase();
  const selectors = ['[role]'];
  const implicit = IMPLICIT_ROLE_SELECTORS[wanted];
  if (implicit) selectors.push(implicit);
  return [...document.querySelectorAll(selectors.join(', '))].filter(
    (el) => !NEVER_A_TARGET.has(el.tagName.toLowerCase()) && effectiveRole(el) === wanted,
  );
}

/**
 * The loosest tier of name matching: substring, after normalizing whitespace,
 * case-insensitively — plus the same match with whitespace removed entirely.
 *
 * The whitespace-free comparison is not pedantry: antd renders a two-character
 * Chinese button as `提 交` in the DOM while everyone — the user, the model,
 * the page's own design — calls it `提交`. `findByText` has carried this rule
 * since the field report that produced it; a name lookup that did not would
 * fail on exactly the buttons this work exists to reach.
 */
function looselyNamed(name: string, wanted: string): boolean {
  const normWanted = normalizeWhitespace(wanted).toLowerCase();
  if (normWanted === '') return true;
  if (normalizeWhitespace(name).toLowerCase().includes(normWanted)) return true;
  const squashedWanted = squashWhitespace(wanted).toLowerCase();
  return squashedWanted !== '' && squashWhitespace(name).toLowerCase().includes(squashedWanted);
}

/**
 * Narrow candidates by a name-ish query, keeping the STRICTEST tier that still
 * matches something: exact, then normalized, then substring.
 *
 * Order is the whole point. With `保存` and `保存并提交` both on the page, a
 * plain substring match makes `{name:"保存"}` ambiguous and refuses to act —
 * technically defensible, uselessly so, since one of them is called exactly
 * that. Taking the strictest non-empty tier means an exact name always wins,
 * and the substring tier only comes into play when nothing matched exactly.
 */
function narrowByName(
  candidates: Element[],
  wanted: string,
  nameOf: (el: Element) => string,
): Element[] {
  const exact = candidates.filter((el) => nameOf(el) === wanted);
  if (exact.length > 0) return exact;

  const normWanted = normalizeWhitespace(wanted).toLowerCase();
  const squashedWanted = squashWhitespace(wanted).toLowerCase();
  const normalized = candidates.filter((el) => {
    const name = nameOf(el);
    return normalizeWhitespace(name).toLowerCase() === normWanted
      || (squashedWanted !== '' && squashWhitespace(name).toLowerCase() === squashedWanted);
  });
  if (normalized.length > 0) return normalized;

  return candidates.filter((el) => looselyNamed(nameOf(el), wanted));
}

/**
 * A candidate line for an error message or a `find` result: enough for the
 * caller to tell two same-looking controls apart and pick one by ref.
 */
function describeCandidate(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const role = effectiveRole(el);
  const name = accessibleName(el);
  const text = normalizeWhitespace(getVisibleText(el) ?? '').slice(0, 40);
  return `[${refFor(el)}] <${tag}${id}>`
    + (role ? ` role=${role}` : '')
    + (name ? ` name=${JSON.stringify(name.slice(0, 40))}` : '')
    + (text && text !== name ? ` text=${JSON.stringify(text)}` : '')
    + (isVisible(el) ? '' : ' (no layout box)');
}

/**
 * Refuse an ambiguous locator instead of acting on the first match.
 *
 * `querySelector` returning the first of several `.primary` buttons is not a
 * near miss — with "保存" and "删除" side by side in the same toolbar it is a
 * wrong, irreversible action reported as a success. Nothing has happened to
 * the page by the time this throws: every action resolves its target before it
 * scrolls, highlights or dispatches anything.
 */
function uniqueOrAmbiguous(matches: Element[], what: string): Element | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  throw new Error(
    `${what} matches ${matches.length} elements, so it does not identify one. `
    + `Nothing on the page was clicked or changed. Pick one by ref:\n`
    + matches.slice(0, 8).map((el) => `  ${describeCandidate(el)}`).join('\n')
    + (matches.length > 8 ? `\n  ...and ${matches.length - 8} more` : ''),
  );
}

/**
 * Every element a text locator matches, narrowed by the rules below.
 *
 * The rule that matters here is "deepest wins". Matching the first element in
 * document order whose subtree text merely *contains* the string always
 * matched an ancestor first — in practice `<body>`, i.e. the whole page shell,
 * which was then clicked and reported as a success. An ancestor is only the
 * answer when nothing inside it is.
 *
 * Returning the set rather than "the one" is what lets `wait_for` ask a
 * different question of the same locator — see `matchElements`.
 */
function textMatches(text: string, tag?: string): Element[] {
  const scope = tag ?? '*';
  const wanted = text.trim();
  // antd inserts a space between the two characters of a two-character Chinese
  // button, so the DOM holds "提 交" while the user — and anyone describing the
  // page — says "提交". Whitespace is presentation here, not identity.
  const squashed = wanted.replace(/\s+/g, '');
  const candidates = [...document.querySelectorAll(scope)].filter((el) => {
    if (!isLocatorTarget(el)) return false;
    const own = normalizedText(el);
    return own.includes(wanted) || (squashed !== '' && own.replace(/\s+/g, '').includes(squashed));
  });
  // In a painted page the real control has a box and the offscreen mirrors do
  // not, so prefer boxes when there are any. In a background tab nothing has
  // one and the relaxed set is all there is.
  const laidOut = candidates.filter(hasBox);
  const matches = laidOut.length > 0 ? laidOut : candidates;
  if (matches.length === 0) return [];

  // Keep only the innermost matches: drop any candidate that contains another.
  let deepest = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));

  // An exact match beats a containing one ("动设备" over "动设备静设备电气设备").
  const exact = deepest.filter(
    (el) => normalizedText(el) === wanted || normalizedText(el).replace(/\s+/g, '') === squashed,
  );
  if (exact.length > 0) deepest = exact;

  // A real control beats the wrapper that happens to hold the same text.
  const clickable = deepest.filter(isClickable);
  if (clickable.length > 0) deepest = clickable;

  return deepest;
}

/** Which strategy read the locator, and everything that locator matches. */
interface LocatorMatches {
  elements: Element[];
  /** How to name the locator in an error message. */
  what: string;
  strategy: 'ref' | 'css' | 'text' | 'role' | 'testId' | 'xpath';
}

/**
 * Everything a locator matches, with no opinion about whether that is enough.
 *
 * Two callers ask different questions of the same locator, and collapsing them
 * into one was a regression. An ACTION must identify a single element, so
 * `findElement` refuses anything else — clicking the first of two `.primary`
 * buttons is a wrong, irreversible act reported as a success. `wait_for` only
 * asks whether the page has reached a state: `{appear, css:'.ant-table-row'}`
 * matching twelve rows, or `{disappear, css:'.ant-spin'}` with three spinners,
 * is the normal shape of that question rather than a mistake. Worse, refusing
 * it left `appear` with no way out at all — "pick one by ref" needs a ref, and
 * the caller is waiting for something that does not exist yet.
 */
function matchElements(locator: ElementLocator): LocatorMatches {
  // ref — from snapshot
  if (locator.ref) {
    const el = resolveRef(locator.ref);
    const what = `Ref ${JSON.stringify(locator.ref)}`;
    if (el) return { elements: [el], what, strategy: 'ref' };
    // Naming a ref that no longer resolves is not the same as naming nothing.
    // Falling through to another strategy here would act on a *different*
    // element than the caller asked for, and report success.
    const err = new Error(
      `Ref "${locator.ref}" no longer exists on this page (the element was removed or replaced). ` +
      `Take a fresh snapshot and use a ref from it.`
    );
    // `waitFor` discriminates on the name: a stale ref *satisfies* `disappear`
    // and can never satisfy any other condition, so polling on is pure
    // timeout burn.
    err.name = 'StaleRefError';
    throw err;
  }

  // CSS selector — every match, not the first one
  if (locator.css) {
    return {
      elements: [...document.querySelectorAll(locator.css)].filter(isLocatorTarget),
      what: `CSS selector ${JSON.stringify(locator.css)}`,
      strategy: 'css',
    };
  }

  // Text content
  if (locator.text) {
    return {
      elements: textMatches(locator.text, locator.tag),
      what: `Text ${JSON.stringify(locator.text)}`,
      strategy: 'text',
    };
  }

  // ARIA role + name — explicit `role=` and native roles both count
  if (locator.role) {
    const byRole = elementsWithRole(locator.role).filter(isLocatorTarget);
    return {
      elements: locator.name ? narrowByName(byRole, locator.name, accessibleName) : byRole,
      what: locator.name
        ? `role ${JSON.stringify(locator.role)} named ${JSON.stringify(locator.name)}`
        : `role ${JSON.stringify(locator.role)}`,
      strategy: 'role',
    };
  }

  // data-testid — escape to prevent injection
  if (locator.testId) {
    return {
      elements: [...document.querySelectorAll(`[data-testid="${escapeCSS(locator.testId)}"]`)]
        .filter(isLocatorTarget),
      what: `testId ${JSON.stringify(locator.testId)}`,
      strategy: 'testId',
    };
  }

  // XPath
  if (locator.xpath) {
    const result = document.evaluate(locator.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = result.singleNodeValue as Element | null;
    return {
      elements: el ? [el] : [],
      what: `XPath ${JSON.stringify(locator.xpath)}`,
      strategy: 'xpath',
    };
  }

  throw new Error(`Invalid locator: ${JSON.stringify(locator)}`);
}

/**
 * The one element a locator identifies, or `null` — the entry point for every
 * caller that is about to DO something. More than one match throws.
 */
function findElement(locator: ElementLocator): Element | null {
  const { elements, what, strategy } = matchElements(locator);
  if (elements.length <= 1) return elements[0] ?? null;
  if (strategy === 'text') {
    // The text path keeps its own wording, which existing callers and tests
    // read; the message is the same promise either way.
    throw new Error(
      `Text "${locator.text}" matches ${elements.length} different elements, so it does not identify one. ` +
      `Pick one by ref:\n${elements.slice(0, 8).map((el) => `  ${describeElement(el)}`).join('\n')}` +
      (elements.length > 8 ? `\n  ...and ${elements.length - 8} more` : '')
    );
  }
  return uniqueOrAmbiguous(elements, what);
}

/**
 * What the caller most plausibly meant, for the not-found path.
 *
 * "Element not found: {"role":"button","name":"保存"}" is true and useless: it
 * costs another round trip to learn whether the page has no buttons, or five
 * of them under other names. Naming the near misses lets the next call be the
 * right one — and keeps the model from concluding the tools are broken and
 * falling back to scripting the page.
 */
function nearbyCandidates(locator: ElementLocator, cap = 5): Element[] {
  if (locator.role) {
    return elementsWithRole(locator.role).filter(isLocatorTarget).slice(0, cap);
  }
  const wanted = normalizeWhitespace(locator.text ?? locator.name ?? '');
  if (!wanted) return [];
  // Half the query, so "保存并提交" still surfaces when "保存" was asked for.
  const needle = wanted.length > 2 ? wanted.slice(0, Math.ceil(wanted.length / 2)) : wanted;
  return [...document.querySelectorAll('a, button, input, textarea, select, summary, [role], [onclick], [tabindex]')]
    .filter(isLocatorTarget)
    .filter((el) => looselyNamed(`${accessibleName(el)} ${normalizeWhitespace(el.textContent ?? '')}`, needle))
    .slice(0, cap);
}

function findElementOrThrow(locator: ElementLocator): Element {
  const el = findElement(locator);
  if (el) return el;
  const near = nearbyCandidates(locator);
  throw new Error(
    `Element not found: ${JSON.stringify(locator)}.`
    + (near.length > 0
      ? ` The closest things on the page right now:\n${near.map((c) => `  ${describeCandidate(c)}`).join('\n')}\n`
        + `Pick one by ref, or call find to search by text.`
      : ` Call find to search the page by text/role, or snapshot to list what is there.`),
  );
}

// =============================================================================
// 2b. FIND — read-only search, the cheap step before acting
// =============================================================================

/** Matches returned by default; enough to choose from, small enough to read. */
const FIND_DEFAULT_LIMIT = 20;
/** Hard ceiling: past this the caller wants a snapshot, not a search. */
const FIND_MAX_LIMIT = 50;
/**
 * Max serialized size of a find result, measured the way the bridge serializes
 * it (pretty-printed JSON — see `formatResult`), and set to the budget
 * `src/core/context/truncation.ts` gives the `find` tool.
 *
 * A count cap alone is not a size cap: 50 matches with long names, long text
 * and long ids serialize to ~21,000 characters, past the budget, and what is
 * upstream can only cut CHARACTERS — which turns the JSON into something that
 * no longer parses and drops matches without saying which. `snapshot` bounds
 * itself for exactly this reason; `find` did not.
 */
const MAX_FIND_CHARS = 16_000;
/** Per-field caps, so one pathological attribute cannot eat the whole budget. */
const FIND_MAX_NAME_CHARS = 120;
const FIND_MAX_TEXT_CHARS = 80;
const FIND_MAX_ID_CHARS = 100;

/** Cut a field to its cap, marking the cut so the caller does not read a lie. */
function capField(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Every key of a find query, for validation and for the "empty query" error. */
const FIND_QUERY_KEYS = ['role', 'name', 'text', 'css', 'testId', 'label', 'placeholder'] as const;

/**
 * Search the page and report the candidates — without touching any of them.
 *
 * The loop this exists to shorten is: snapshot the whole page, read 200
 * elements to find the one button, act. `find` answers the same question
 * directly, in a fraction of the tokens, and — because it shares the locator's
 * matching rules exactly — its answer is also a preview of what `click` would
 * do. A caller that gets three matches here knows to disambiguate BEFORE
 * issuing an action that would be refused, or worse, guessed.
 *
 * Several keys are ANDed. Refs come from the same registry `snapshot` hands
 * out, so anything found here can be acted on by ref with no extra round trip.
 */
function findElements(rawQuery: unknown, rawLimit?: unknown): FindResult {
  const query = (rawQuery ?? {}) as FindQuery;
  if (typeof query !== 'object' || Array.isArray(query)) {
    throw new Error(`find: query must be an object with at least one of: ${FIND_QUERY_KEYS.join(', ')}`);
  }
  const used = FIND_QUERY_KEYS.filter((key) => {
    const value = query[key];
    return typeof value === 'string' && value !== '';
  });
  if (used.length === 0) {
    throw new Error(`find: query must contain at least one of: ${FIND_QUERY_KEYS.join(', ')}`);
  }

  const limit = Math.max(1, Math.min(FIND_MAX_LIMIT, Math.trunc(Number(rawLimit) || FIND_DEFAULT_LIMIT)));

  // Universe: the narrowest structural query the caller gave us. Everything
  // else is a filter, so the expensive per-element work (layout reads inside
  // the visibility test) runs on as few nodes as possible.
  let candidates: Element[];
  if (query.css) {
    candidates = [...document.querySelectorAll(query.css)];
  } else if (query.testId) {
    candidates = [...document.querySelectorAll(`[data-testid="${escapeCSS(query.testId)}"]`)];
  } else if (query.role) {
    candidates = elementsWithRole(query.role);
  } else {
    candidates = [...document.querySelectorAll('*')];
  }
  candidates = candidates.filter(
    (el) => !NEVER_A_TARGET.has(el.tagName.toLowerCase()) && !isAbuOverlay(el),
  );

  // Attribute/text filters first (no layout), visibility last.
  if (query.role && (query.css || query.testId)) {
    const wantedRole = query.role.trim().toLowerCase();
    candidates = candidates.filter((el) => effectiveRole(el) === wantedRole);
  }
  if (query.testId && query.css) {
    candidates = candidates.filter((el) => el.getAttribute('data-testid') === query.testId);
  }
  if (query.name) {
    candidates = candidates.filter((el) => looselyNamed(accessibleName(el), query.name as string));
  }
  if (query.label) {
    candidates = candidates.filter((el) => looselyNamed(nativeLabelText(el), query.label as string));
  }
  if (query.placeholder) {
    candidates = candidates.filter(
      (el) => looselyNamed(el.getAttribute('placeholder') ?? '', query.placeholder as string),
    );
  }
  if (query.text) {
    candidates = candidates.filter(
      (el) => looselyNamed(normalizeWhitespace(el.textContent ?? ''), query.text as string),
    );
  }

  candidates = candidates.filter(isLocatorVisible);

  // Strictest-tier narrowing, same ladder the locator uses, so `find` and
  // `click` never disagree about which elements a `{role,name}` identifies.
  if (query.name) candidates = narrowByName(candidates, query.name, accessibleName);
  if (query.label) candidates = narrowByName(candidates, query.label, nativeLabelText);
  if (query.placeholder) {
    candidates = narrowByName(candidates, query.placeholder, (el) => el.getAttribute('placeholder') ?? '');
  }
  if (query.text) {
    // Deepest wins, exactly as in `textMatches`: an ancestor is only the answer
    // when nothing inside it is, or every text query returns the page shell.
    candidates = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
  }

  const total = candidates.length;
  const matches = candidates.slice(0, limit).map<FindMatch>((el) => {
    const rect = el.getBoundingClientRect();
    const role = effectiveRole(el);
    const name = accessibleName(el);
    const rawText = normalizeWhitespace(el.textContent ?? '');
    const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
    return {
      ref: refFor(el),
      tag: el.tagName.toLowerCase(),
      ...(el.id ? { id: capField(el.id, FIND_MAX_ID_CHARS) } : {}),
      ...(role ? { role } : {}),
      ...(name ? { accessibleName: capField(name, FIND_MAX_NAME_CHARS) } : {}),
      ...(rawText && rawText !== name ? { text: capField(rawText, FIND_MAX_TEXT_CHARS) } : {}),
      // `false` means "on the page but with no layout box" — a collapsed antd
      // combobox input, say. It is still addressable; it just is not what the
      // user is looking at. Genuinely hidden elements never reach this list.
      visible: isVisible(el),
      interactive: isClickable(el),
      ...(disabled ? { disabled: true } : {}),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });

  const describeQuery = used.map((key) => `${key}=${JSON.stringify(query[key])}`).join(' ');
  const build = (kept: FindMatch[]): FindResult => ({
    url: location.href,
    title: document.title,
    matches: kept,
    total,
    ...(total === 0
      ? {
        message:
            `Nothing on this page matches ${describeQuery}. Hidden elements are excluded. `
            + `Try one key instead of several, or a shorter \`text\`; snapshot lists everything interactive.`,
      }
      : {}),
    ...(total > kept.length
      ? {
        truncated: true,
        message:
            `Showing ${kept.length} of ${total} matches. Narrow the query (add \`role\`, or a longer `
            + `\`text\`/\`name\`) rather than raising \`limit\` — a locator that matches ${total} elements `
            + `will be refused as ambiguous by click/fill/select.`,
      }
      : {}),
  });

  // Bound the payload here, where a match is still a structured thing, by
  // binary search on the REAL serialized size — and on the WHOLE result, the
  // way `formatResult` in the bridge serializes it. Measuring `matches` alone
  // would run ~1,200 characters under the truth on a worst-case page (the
  // array sits one level deeper inside the envelope, so every line carries two
  // more spaces, and url/title/message are unbudgeted), and an estimate that
  // runs under hands the result to the upstream character slicer, which cuts
  // CHARACTERS — the JSON stops parsing and matches vanish without saying
  // which. That is the failure this budget exists to prevent.
  const fits = (count: number) => JSON.stringify(build(matches.slice(0, count)), null, 2).length <= MAX_FIND_CHARS;
  if (matches.length > 0 && !fits(matches.length)) {
    let low = 1;                 // always return at least one match: a single
    let high = matches.length;   // oversized match beats an empty list
    let kept = 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (fits(mid)) {
        kept = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    matches.length = kept;
  }

  return build(matches);
}

// =============================================================================
// 3. CLICK
// =============================================================================

/** Identify what an action actually acted on, so a wrong target is visible. */
function targetInfo(el: Element): { ref: string; tag: string; id?: string; role?: string; text?: string } {
  const text = getVisibleText(el)?.replace(/\s+/g, ' ').trim().slice(0, 50);
  return {
    ref: refFor(el),
    tag: el.tagName.toLowerCase(),
    ...(el.id ? { id: el.id } : {}),
    ...(el.getAttribute('role') ? { role: el.getAttribute('role')! } : {}),
    ...(text ? { text } : {}),
  };
}

/**
 * Dispatch a click the way a component library expects to receive one.
 *
 * Pointer events come first because several widget libraries (rc-select, which
 * backs every antd dropdown, among them) open on `mousedown`/`pointerdown` and
 * never see a bare `.click()`. These are still synthetic (`isTrusted: false`);
 * driving real input events needs the debugger/CDP transport, which is a
 * separate change.
 */
function dispatchClickSequence(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, composed: true };
  if (typeof PointerEvent === 'function') {
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
  }
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  if (typeof PointerEvent === 'function') {
    el.dispatchEvent(new PointerEvent('pointerup', opts));
  }
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

function clickElement(locator: ElementLocator): {
  success: boolean;
  message: string;
  elementText?: string;
  target: ReturnType<typeof targetInfo>;
} {
  const el = findElementOrThrow(locator);
  const target = targetInfo(el);

  // Scroll into view if needed
  el.scrollIntoView({ behavior: 'instant', block: 'center' });

  // Visual feedback
  highlightElement(el);
  showStatus(`Click: ${target.text ?? 'element'}`, 'info');

  dispatchClickSequence(el as HTMLElement);

  return {
    success: true,
    // Naming the element that was actually hit — not just the text that was
    // asked for — is what lets a caller notice it landed on the wrong thing.
    message: `Clicked ${describeElement(el)}`,
    elementText: target.text,
    target,
  };
}

// =============================================================================
// 4. FILL
// =============================================================================

function fillElement(locator: ElementLocator, value: string): { success: boolean; message: string; previousValue?: string } {
  const el = findElementOrThrow(locator) as HTMLInputElement | HTMLTextAreaElement;
  // Same rule as the snapshot: what was ALREADY in the field is the user's
  // secret (a browser-autofilled password, a saved card), and handing it back
  // in the result would put it in the model's context, the logs, and any
  // approval message quoting the result. The value being written is the
  // caller's own and is echoed in `message` unchanged.
  const previousValue = reportableValue(el, el.value, 100);

  highlightElement(el);
  // NEVER the value: this string is written into the page (see `fieldLabel`).
  showStatus(`Fill: ${fieldLabel(el)}`, 'info');

  // Use native setter to bypass React's synthetic event system
  const nativeSetter = Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value'
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.value = value;
  }

  // Trigger events for framework compatibility
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));

  return {
    success: true,
    message: `Filled field with "${value.slice(0, 50)}"`,
    previousValue,
  };
}

// =============================================================================
// 5. SELECT
// =============================================================================

/** How long to wait for a custom dropdown's options to render after opening it. */
const DROPDOWN_OPEN_TIMEOUT_MS = 1500;

/**
 * Not `display:none` / `visibility:hidden`, regardless of its box.
 *
 * Deliberately weaker than `isVisible`. A popup that has just opened spends
 * its entrance animation at `opacity: 0` with a collapsed box, and a page in a
 * background tab never gets the animation frames to leave that state at all —
 * Abu drives tabs the user is not looking at, so "has a layout box" is not a
 * usable test for options inside a dropdown we know is open.
 */
function isRendered(el: Element): boolean {
  if (!el.isConnected) return false;
  // `checkVisibility` is the only single call that accounts for a hidden
  // *ancestor*: a child of `display:none` still reports `display: block` as
  // its own computed style, so checking the element alone answers the wrong
  // question. `checkOpacity: false` is the point of using it here — a popup
  // mid-entrance-animation sits at opacity 0, and in a background tab it never
  // leaves that state, but it is mounted and clickable.
  const target = el as Element & { checkVisibility?: (options?: Record<string, boolean>) => boolean };
  if (typeof target.checkVisibility === 'function') {
    return target.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
  }
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node as HTMLElement);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/**
 * Whether an interactive element belongs in the snapshot.
 *
 * Stricter `isVisible` asks "does this have a layout box", which component
 * libraries routinely answer no for the element that carries the semantics:
 * antd's `role="combobox"` sits on a `width: 0; opacity: 0` <input> beside the
 * span the user actually sees. Requiring a box dropped **every dropdown on the
 * page** out of the snapshot — verified against antd 5.21.6 — leaving an agent
 * to conclude the form had no selects at all.
 *
 * So for controls the question becomes: is it mounted, not hidden by CSS, and
 * does something it sits inside actually occupy space? A control inside a
 * closed menu fails the second test, which is what keeps this from listing
 * things the user cannot reach.
 */
function isSnapshotVisible(el: Element): boolean {
  if (isVisible(el)) return true;
  // Only real form controls get the exemption. Widening it to anything with an
  // ARIA role surfaced antd's zero-sized screen-reader mirror as if those were
  // the options — an agent then reasoned about two un-clickable rows out of
  // six and went back to scripting the page. A collapsed <input> is a control
  // the page is hiding on purpose; a collapsed `role="option"` is a mirror.
  const tag = el.tagName.toLowerCase();
  const isFormControl = ['input', 'textarea', 'select', 'button'].includes(tag)
    || (el as HTMLElement).contentEditable === 'true';
  if (!isFormControl) return false;
  if (!isRendered(el)) return false;
  let depth = 0;
  for (let node = el.parentElement; node && depth < 4; node = node.parentElement, depth++) {
    if (hasBox(node)) return true;
  }
  return false;
}

/** Has a real layout box — i.e. it is something a user could point at. */
function hasBox(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Where an option's label lives. `aria-label` wins: a virtualized row can be
 * an empty div with only the label on the attribute.
 */
function optionLabelOf(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The element a user would actually click for this option.
 *
 * antd (rc-select) renders the dropdown **twice**: a `role="listbox"` at
 * `height:0; width:0; overflow:hidden` that exists only for screen readers,
 * and a separate, completely un-roled list (`.ant-select-item-option`) that
 * takes the mouse. Clicking the ARIA node closes the dropdown and selects
 * nothing — verified against antd 5.21.6. Element Plus and friends put the
 * role on the real row instead, so both shapes have to work.
 *
 * The distinction that separates them is not a class name: it is whether the
 * node has a layout box at all.
 */
function clickTargetForOption(ariaOption: Element, popup: Element): Element | null {
  if (hasBox(ariaOption)) return ariaOption;

  const label = optionLabelOf(ariaOption);
  if (!label) return null;
  const rendered = [...popup.querySelectorAll('*')].filter(
    (el) => hasBox(el) && (el.textContent ?? '').replace(/\s+/g, ' ').trim() === label,
  );
  // Innermost wins, same rule as the text locator: an ancestor is only the
  // answer when nothing inside it is. The click bubbles up to whichever
  // element carries the handler.
  const deepest = rendered.filter((el) => !rendered.some((other) => other !== el && el.contains(other)));
  return deepest[0] ?? null;
}

/** Nearest ancestor of the a11y list that is actually laid out — the popup. */
function popupRootFor(container: Element): Element {
  let node: Element | null = container;
  while (node && node !== document.body) {
    if (hasBox(node)) return node;
    node = node.parentElement;
  }
  return container;
}

/** The `[role=option]` nodes belonging to this control, portal or not. */
function optionsFor(trigger: Element): Element[] {
  // A component library usually names its listbox on the trigger, and that
  // naming is authoritative: several dropdowns can be mounted at once, only
  // one of them ours. Verified against antd 5.21 (rc-select), which sets
  // `aria-controls="<id>_list"` on the combobox.
  const owned = (trigger.getAttribute('aria-controls') ?? trigger.getAttribute('aria-owns') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id))
    .filter((el): el is HTMLElement => el !== null);

  if (owned.length > 0) {
    // Ours by name — no need to guess from what is on screen.
    return owned
      .flatMap((c) => [...c.querySelectorAll('[role="option"], [role="menuitem"]')])
      .filter(isRendered);
  }

  // No naming: the options render in a portal on <body>, so the only way to
  // tell one dropdown from another is that ours is the one on screen. Here
  // the stricter check earns its keep.
  const containers = [...document.querySelectorAll('[role="listbox"], [role="menu"]')].filter(isVisible);
  const fromContainers = containers.flatMap((c) => [...c.querySelectorAll('[role="option"], [role="menuitem"]')]);
  const options = fromContainers.length > 0
    ? fromContainers
    : [...document.querySelectorAll('[role="option"], [role="menuitem"]')];

  return options.filter(isVisible);
}

/** The scrolling element of a popup — where a virtual list lives. */
function scrollerWithin(popup: Element): HTMLElement | null {
  const scrolls = (el: Element) => (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 1;
  if (scrolls(popup)) return popup as HTMLElement;
  for (const node of popup.querySelectorAll('*')) {
    if (scrolls(node)) return node as HTMLElement;
  }
  return null;
}

/** Normalized visible text, the form option labels are compared in. */
function normalizedText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Find a rendered row in the popup carrying exactly this label.
 *
 * The ARIA mirror is not always complete — antd virtualizes it, so a list of
 * six options can advertise two while all six are mounted in the list the
 * mouse actually sees. The rendered rows are the ground truth for what can be
 * clicked, so they get searched too rather than trusting the mirror alone.
 */
function renderedRowFor(popup: Element, label: string): Element | null {
  const matches = [...popup.querySelectorAll('*')].filter(
    (el) => hasBox(el) && normalizedText(el) === label,
  );
  const deepest = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
  return deepest[0] ?? null;
}

/** Labels of the rendered rows, for telling the caller what was on offer. */
function renderedRowLabels(popup: Element): string[] {
  const labels: string[] = [];
  for (const el of popup.querySelectorAll('*')) {
    if (!hasBox(el)) continue;
    // A row is a leaf as far as laid-out content goes.
    if ([...el.children].some((child) => hasBox(child))) continue;
    const text = normalizedText(el);
    if (text && text.length <= 80) labels.push(text);
  }
  return labels;
}

/**
 * Locate an option by label, scrolling the list if it is virtualized.
 *
 * rc-select — and every other list of any size — renders only the rows in
 * view. On a real antd dropdown of six options, two were in the DOM. So "not
 * found" among the rendered rows is not an answer; the list has to be walked.
 */
async function findOption(
  trigger: Element,
  value: string,
): Promise<{ option: Element | null; label: string; seen: string[] }> {
  const wanted = value.trim();
  const squashed = wanted.replace(/\s+/g, '');
  const seen = new Set<string>();

  /** One resolution pass over whatever the popup currently holds. */
  const attempt = (): { option: Element; label: string } | null => {
    const ariaOptions = optionsFor(trigger);
    if (ariaOptions.length === 0) return null;
    const popup = popupRootFor(ariaOptions[0].parentElement ?? ariaOptions[0]);

    const labelled = ariaOptions.map((el) => ({ el, label: optionLabelOf(el) }));
    labelled.forEach(({ label }) => label && seen.add(label));
    renderedRowLabels(popup).forEach((label) => seen.add(label));

    const hit = labelled.find(({ label }) => label === wanted)
      ?? labelled.find(({ label }) => label.replace(/\s+/g, '') === squashed)
      ?? labelled.find(({ label }) => label.includes(wanted));
    if (hit) {
      const target = clickTargetForOption(hit.el, popup);
      if (target) return { option: target, label: hit.label };
    }
    // The mirror can be virtualized and incomplete; the rendered rows are the
    // larger set and the only clickable one.
    const rendered = renderedRowFor(popup, wanted)
      ?? renderedRowFor(popup, [...seen].find((label) => label.replace(/\s+/g, '') === squashed) ?? wanted);
    if (rendered) return { option: rendered, label: normalizedText(rendered) };
    return null;
  };

  // Poll rather than resolve once. The accessibility mirror is mounted the
  // instant the dropdown opens, but the list the mouse can reach is laid out a
  // frame or two later — resolving on the first pass found the labels and no
  // click target, and reported "option not found" while listing that very
  // option as seen.
  const deadline = Date.now() + DROPDOWN_OPEN_TIMEOUT_MS;
  for (;;) {
    const hit = attempt();
    if (hit) return { ...hit, seen: [...seen] };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Still nothing: the row may not be mounted at all. Walk the list.
  const ariaOptions = optionsFor(trigger);
  const popup = ariaOptions.length > 0
    ? popupRootFor(ariaOptions[0].parentElement ?? ariaOptions[0])
    : null;
  const scroller = popup ? scrollerWithin(popup) : null;
  if (!scroller) return { option: null, label: '', seen: [...seen] };

  let previousTop = -1;
  for (let guard = 0; guard < 40 && scroller.scrollTop !== previousTop; guard++) {
    previousTop = scroller.scrollTop;
    scroller.scrollTop += Math.max(1, scroller.clientHeight - 8);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const hit = attempt();
    if (hit) return { ...hit, seen: [...seen] };
  }
  return { option: null, label: '', seen: [...seen] };
}

/**
 * Choose a value from a dropdown.
 *
 * Native `<select>` keeps its original path. Everything else is matched by
 * ARIA role, not by class name: `role="combobox"` with `role="option"`
 * children is what antd (rc-select), Element Plus, Arco and the rest all
 * render, so one implementation covers them instead of a per-library
 * selector list that rots whenever a library renames a class.
 */
async function selectOption(
  locator: ElementLocator,
  value: string,
): Promise<{ success: boolean; message: string; target?: ReturnType<typeof targetInfo> }> {
  const el = findElementOrThrow(locator);

  if (el.tagName.toLowerCase() === 'select') {
    const select = el as HTMLSelectElement;
    const options = [...select.options];
    const match = options.find((o) => o.value === value || o.text === value);
    if (!match) {
      throw new Error(
        `Option "${value}" not found. Available options: ${options.map((o) => `"${o.text}"`).join(', ') || '(none)'}`
      );
    }
    select.value = match.value;
    select.focus();
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, message: `Selected option: "${match.text}"`, target: targetInfo(select) };
  }

  const role = el.getAttribute('role');
  const isCustomDropdown =
    role === 'combobox' || role === 'listbox' ||
    el.getAttribute('aria-haspopup') === 'listbox' ||
    optionsFor(el).length > 0;

  if (!isCustomDropdown) {
    throw new Error(
      `${describeElement(el)} is not a dropdown: it is not a <select>, has no combobox/listbox role, ` +
      `and owns no options. If this is a text field use fill; if the control opens a menu, click it and ` +
      `take a snapshot to see what appeared.`
    );
  }

  // NEVER the value: same reason as fill (see `fieldLabel`).
  showStatus(`Select: ${fieldLabel(el)}`, 'info');
  el.scrollIntoView({ behavior: 'instant', block: 'center' });

  // Open it if it is not already open. `aria-expanded` is the library's own
  // answer to that question — asking beats clicking twice and toggling it shut.
  if (el.getAttribute('aria-expanded') !== 'true' && optionsFor(el).length === 0) {
    // (`aria-expanded` is checked first: clicking an open dropdown closes it.)
    dispatchClickSequence(el as HTMLElement);
  }

  const { option: chosen, label: chosenLabel, seen } = await findOption(el, value);
  if (seen.length === 0) {
    throw new Error(
      `Opened ${describeElement(el)} but no options appeared within ${DROPDOWN_OPEN_TIMEOUT_MS}ms. ` +
      `Take a snapshot to see the current state of the page.`
    );
  }
  if (!chosen) {
    // Listing what IS available turns a dead end into one more attempt,
    // instead of a fallback to running a script against the page.
    const wasListed = seen.some(
      (label) => label === value.trim() || label.replace(/\s+/g, '') === value.trim().replace(/\s+/g, ''),
    );
    throw new Error(
      wasListed
        ? `Option "${value}" is in ${describeElement(el)} but the dropdown never finished opening, ` +
          `so there was nothing to click. Take a snapshot to see the page's current state, then retry select.`
        : `Option "${value}" not found in ${describeElement(el)}. ` +
          `Options available: ${seen.map((label) => `"${label}"`).join(', ')}`
    );
  }

  highlightElement(chosen);
  chosen.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  dispatchClickSequence(chosen as HTMLElement);

  return {
    success: true,
    message: `Selected "${chosenLabel}" in ${describeElement(el)}`,
    target: targetInfo(chosen),
  };
}

// =============================================================================
// 6. WAIT FOR
// =============================================================================

async function waitFor(
  condition: Record<string, unknown>,
  timeout: number = 30000
): Promise<{ success: boolean; message: string; timedOut: boolean; elapsed: number; observed?: string }> {
  const start = Date.now();
  const condType = condition.type as string;

  /**
   * What the page actually looks like right now, for the timeout path.
   * "Timed out after 30000ms" tells the caller nothing it did not already
   * know, and costs another round trip to find out — which is exactly the
   * round trip that used to get spent on a script.
   */
  const describeCurrentState = (): string => {
    if (condType === 'urlContains') return `current url is ${location.href}`;
    let found: LocatorMatches;
    try {
      found = matchElements(condition.locator as ElementLocator);
    } catch (err) {
      // Only a stale ref is "the locator no longer resolves". Reporting every
      // other failure that way sent the caller off to re-snapshot for reasons
      // that had nothing to do with refs.
      if (err instanceof Error && err.name === 'StaleRefError') {
        return 'the locator no longer resolves (its ref is stale) — take a fresh snapshot';
      }
      return `the locator could not be evaluated: ${err instanceof Error ? err.message : String(err)}`;
    }
    const { elements } = found;
    if (elements.length === 0) return 'no element matches that locator';
    if (elements.length > 1) {
      // Not an error here — several matches is a legitimate way to ask "is the
      // table populated" — but on a timeout the caller needs to know that the
      // thing it waited for is a set, and which set.
      return `the locator matches ${elements.length} elements, none of which satisfy "${condType}":\n`
        + elements.slice(0, 5).map((el) => `  ${describeCandidate(el)}`).join('\n')
        + (elements.length > 5 ? `\n  ...and ${elements.length - 5} more` : '');
    }
    const el = elements[0];
    if (!isVisible(el)) return `matched <${el.tagName.toLowerCase()}> but it has no layout box (hidden or zero-sized)`;
    if (condType === 'enabled' && (el as HTMLButtonElement).disabled) {
      return `matched <${el.tagName.toLowerCase()}> but it is still disabled`;
    }
    if (condType === 'textContains') {
      return `matched <${el.tagName.toLowerCase()}> whose text is ${JSON.stringify((getVisibleText(el) ?? '').slice(0, 80))}`;
    }
    return `matched <${el.tagName.toLowerCase()}>, which does not satisfy "${condType}"`;
  };

  /**
   * Existence, not uniqueness: `appear` is satisfied by ANY match, `disappear`
   * only when EVERY match is gone. That is what `wait_for` did before the
   * locator rework, and what the question means — the alternative fails a
   * perfectly ordinary `{css:'.toast'}` on a page that shows two toasts.
   */
  const matched = (): Element[] => matchElements(condition.locator as ElementLocator).elements;

  const check = (): boolean => {
    switch (condType) {
      case 'appear': {
        return matched().some(isVisible);
      }
      case 'disappear': {
        let elements: Element[];
        try {
          elements = matched();
        } catch (err) {
          // A ref that no longer resolves IS the disappearance being waited
          // on — the node was removed. Before this branch, the throw was
          // swallowed as "not yet" and the wait always ran to full timeout.
          if (err instanceof Error && err.name === 'StaleRefError') return true;
          throw err;
        }
        return elements.every((el) => !isVisible(el));
      }
      case 'enabled': {
        return matched().some((el) => isVisible(el) && !(el as HTMLButtonElement).disabled);
      }
      case 'textContains': {
        const wanted = condition.text as string;
        return matched().some((el) => (getVisibleText(el) ?? '').includes(wanted));
      }
      case 'urlContains': {
        return location.href.includes(condition.pattern as string);
      }
      default:
        throw new Error(`Unknown wait condition: ${condType}`);
    }
  };

  const staleRefMessage = (err: unknown): string | null =>
    err instanceof Error && err.name === 'StaleRefError' ? err.message : null;

  // Fast check first
  try {
    if (check()) {
      return { success: true, message: `Condition met immediately`, timedOut: false, elapsed: 0 };
    }
  } catch (err) {
    const stale = staleRefMessage(err);
    if (stale === null) throw err;
    // appear/enabled/textContains on a dead node can never come true — fail
    // now with the re-snapshot guidance instead of burning the whole timeout.
    return { success: false, message: stale, timedOut: false, elapsed: Date.now() - start };
  }

  // Poll with MutationObserver + throttled interval fallback
  return new Promise((resolve) => {
    let resolved = false;
    let checkScheduled = false;

    const complete = (timedOut: boolean, failure?: string) => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      const elapsed = Date.now() - start;
      resolve({
        success: !timedOut && failure === undefined,
        message: failure ?? (timedOut
          ? `Timed out after ${timeout}ms waiting for "${condType}" — ${describeCurrentState()}.`
          : `Condition met after ${elapsed}ms`),
        timedOut,
        elapsed,
        ...(timedOut ? { observed: describeCurrentState() } : {}),
      });
    };

    const tryCheck = () => {
      if (resolved) return;
      try {
        if (check()) complete(false);
      } catch (err) {
        const stale = staleRefMessage(err);
        if (stale !== null) {
          // The ref went stale mid-poll (the framework replaced the node).
          // For every condition except `disappear` — which check() already
          // translated to success — the wait can never be satisfied, so
          // surface the re-snapshot guidance now instead of swallowing the
          // throw on every poll until the timeout fires.
          complete(false, stale);
          return;
        }
        // Ignore transient DOM errors during check
      }
    };

    // MutationObserver for DOM changes — throttled to avoid flooding
    const observer = new MutationObserver(() => {
      if (!checkScheduled && !resolved) {
        checkScheduled = true;
        requestAnimationFrame(() => {
          checkScheduled = false;
          tryCheck();
        });
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    // Interval fallback (for URL changes, computed styles, etc.)
    const pollTimer = setInterval(tryCheck, 500);

    // Timeout
    const timeoutTimer = setTimeout(() => complete(true), timeout);
  });
}

// =============================================================================
// 7. GET HTML — inert DOM source for query_js
// =============================================================================

function sameOriginFrameHtml(frame: HTMLIFrameElement): string {
  try {
    const doc = frame.contentDocument;
    if (!doc?.documentElement) {
      return '<abu-frame-unavailable data-reason="empty"></abu-frame-unavailable>';
    }
    return serializeElementWithFrames(doc.documentElement);
  } catch {
    return '<abu-frame-unavailable data-reason="cross-origin"></abu-frame-unavailable>';
  }
}

function inlineFrameElement(frame: HTMLIFrameElement, ownerDocument: Document): Element {
  const inline = ownerDocument.createElement('abu-inline-frame');
  inline.setAttribute('data-src', frame.getAttribute('src') ?? '');
  inline.setAttribute('data-title', frame.getAttribute('title') ?? '');
  inline.innerHTML = sameOriginFrameHtml(frame);
  return inline;
}

/**
 * Redact sensitive `value` ATTRIBUTES in a detached clone before it is
 * serialized for `get_html` / `query_js` (M6).
 *
 * The attribute and the property are different things: typing into a field
 * does not touch the attribute, so most live secrets never appear here. A
 * SERVER-RENDERED `<input type="password" value="…">` does carry one, though,
 * and `cloneNode(true)` copies attributes verbatim — so the one path that
 * hands the model raw page source was still emitting it after the snapshot
 * stopped.
 *
 * The attribute is replaced rather than removed: `value=""` would read as "the
 * field is empty", and a query_js reading `.value` should see the same marker
 * every other surface shows.
 */
function redactSensitiveValueAttributes(root: Element): void {
  const candidates = root.tagName === 'INPUT' || root.tagName === 'TEXTAREA' || root.tagName === 'SELECT'
    ? [root, ...root.querySelectorAll('input, textarea, select')]
    : [...root.querySelectorAll('input, textarea, select')];
  for (const el of candidates) {
    if (!hasSensitiveValue(el)) continue;
    // A TEXTAREA has no `value` attribute at all — its default value IS the
    // child text node, so rewriting attributes left it verbatim while the
    // snapshot of the same field said `[value redacted]`. Exactly the
    // "redacted on one surface, plaintext on the next" shape this pass exists
    // to close, and `queryJsWorker` reading `.value` off the parsed html gets
    // its value from precisely this text.
    if (el.tagName === 'TEXTAREA' && el.textContent) {
      el.textContent = REDACTED_VALUE;
      // FALLS THROUGH to the attribute rewrite on purpose. A `value` attribute
      // on a textarea is invalid HTML and inert in the DOM, but hand-written
      // SSR templates do emit it, and it is raw plaintext in the serialized
      // source either way. An earlier revision returned here and silently
      // stopped redacting exactly that case.
    }
    if (!el.getAttribute('value')) continue;
    el.setAttribute('value', REDACTED_VALUE);
  }
}

/**
 * Sensitive field values currently present in `scope`, for the one extraction
 * path that cannot work on a redacted clone.
 *
 * `extract_text` reads `innerText` off the LIVE DOM, and it has to: `innerText`
 * is layout-dependent, so a detached clone would return nothing at all. Rather
 * than edit the page the user is looking at, the extracted STRING is scrubbed
 * of any sensitive value the scope actually holds.
 *
 * ## A best-effort net, NOT a guarantee
 *
 * This is string matching, so it catches the common case (the value appears
 * verbatim) and misses three known ones. Named rather than implied, because an
 * over-stated guarantee here is worse than a modest one:
 *
 * - **Renders differently than it is stored.** A value containing whitespace
 *   is compared against text the engine normalized, so `"pass\\nphrase"` will
 *   not match `"pass phrase here"`.
 * - **Echoed from outside the scope.** Only fields INSIDE the extract scope
 *   contribute secrets; a page that copies a password into a `<div>` inside
 *   the scope while the field itself sits outside it is not caught.
 * - **Over-scrubs a short common value.** A password of `"admin"` turns "the
 *   admin panel for admin users" into markers. That is the fail-safe
 *   direction, and the 1-2 character floor below only blunts the worst of it.
 *
 * It does at least not depend on whether a given engine renders a textarea's
 * content into `innerText` (Chrome does not; other DOM implementations do) —
 * whatever the engine included, a verbatim occurrence is removed.
 */
function sensitiveValuesIn(scope: Element | null): string[] {
  const root = scope ?? document.body;
  if (!root) return [];
  const fields = [
    ...(root.matches?.('input, textarea, select') ? [root] : []),
    ...root.querySelectorAll('input, textarea, select'),
  ];
  const values: string[] = [];
  for (const el of fields) {
    if (!hasSensitiveValue(el)) continue;
    const value = (el as HTMLInputElement).value || el.textContent || '';
    // One-and-two-character values are skipped: scrubbing them would mangle
    // unrelated page text far more than it would protect anything.
    if (value.length > 2) values.push(value);
  }
  return values;
}

function serializeElementWithFrames(element: Element): string {
  if (element.tagName === 'IFRAME') {
    return inlineFrameElement(element as HTMLIFrameElement, element.ownerDocument).outerHTML;
  }

  const clone = element.cloneNode(true) as Element;
  // On the CLONE, never the live DOM: this must not edit the page the user is
  // looking at. Runs before the frame inlining below so an inlined frame's own
  // html — which came back through this same function — is already clean.
  redactSensitiveValueAttributes(clone);
  const liveFrames = [...element.querySelectorAll('iframe')];
  const clonedFrames = [...clone.querySelectorAll('iframe')];

  for (let i = 0; i < liveFrames.length; i += 1) {
    const live = liveFrames[i] as HTMLIFrameElement;
    const cloned = clonedFrames[i];
    if (!cloned?.parentNode) continue;
    const inline = inlineFrameElement(live, clone.ownerDocument);
    cloned.parentNode.replaceChild(inline, cloned);
  }

  return clone.outerHTML;
}

function getHtml(selector?: string): string {
  const root = selector ? document.querySelector(selector) : document.documentElement;
  if (!root) {
    throw new Error(
      `Scope element not found: ${selector}. ` +
      'Run query_js without a selector or take a snapshot to see what the page actually contains.',
    );
  }
  return serializeElementWithFrames(root);
}

// =============================================================================
// 7. EXTRACT TEXT
// =============================================================================

function extractText(selector?: string): string {
  let text: string;
  let scope: Element | null;
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    scope = el;
    text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  } else {
    scope = document.body;
    text = document.body.innerText ?? '';
  }
  // See `sensitiveValuesIn`: this path reads the live DOM (innerText needs
  // layout), so the scrubbing happens on the extracted string.
  for (const secret of sensitiveValuesIn(scope)) {
    text = text.split(secret).join(REDACTED_VALUE);
  }

  // Truncate to prevent sending megabytes through the message channel
  if (text.length > MAX_EXTRACT_TEXT_SIZE) {
    return text.slice(0, MAX_EXTRACT_TEXT_SIZE) + `\n\n[Truncated: ${text.length} chars total, showing first ${MAX_EXTRACT_TEXT_SIZE}]`;
  }
  return text;
}

// =============================================================================
// 8. EXTRACT TABLE
// =============================================================================

function extractTable(selector?: string): { headers: string[]; rows: string[][]; rowCount: number } {
  let table: HTMLTableElement | null;

  if (selector) {
    table = document.querySelector(selector) as HTMLTableElement;
  } else {
    const tables = [...document.querySelectorAll('table')] as HTMLTableElement[];
    table = tables.sort((a, b) => b.rows.length - a.rows.length)[0] ?? null;
  }

  if (!table) throw new Error('No table found on the page');

  const headers = [...(table.querySelectorAll('thead th, thead td') as NodeListOf<HTMLElement>)]
    .map(th => th.innerText?.trim() ?? '');

  if (headers.length === 0) {
    const firstRow = table.rows[0];
    if (firstRow) {
      for (const cell of firstRow.cells) {
        headers.push(cell.innerText?.trim() ?? '');
      }
    }
  }

  const rows: string[][] = [];
  const bodyRows = table.querySelectorAll('tbody tr');
  const rowElements = bodyRows.length > 0 ? bodyRows : table.rows;

  for (const tr of rowElements) {
    const row = [...(tr as HTMLTableRowElement).cells].map(td => (td as HTMLElement).innerText?.trim() ?? '');
    if (headers.length > 0 && row.join('') === headers.join('')) continue;
    rows.push(row);
  }

  // The same best-effort scrub `extract_text` applies, for the same reason and
  // with the same limits. Inert in Chrome today (neither input values nor
  // textarea content reach `innerText` there), but this was the one reporting
  // path that never got the U5 treatment, and "inert on one engine" is not a
  // property worth relying on.
  const secrets = sensitiveValuesIn(table);
  const scrub = (cell: string): string =>
    secrets.reduce((text, secret) => text.split(secret).join(REDACTED_VALUE), cell);

  return {
    headers: headers.map(scrub),
    rows: rows.map((row) => row.map(scrub)),
    rowCount: rows.length,
  };
}

// =============================================================================
// 9. SCROLL
// =============================================================================

function scrollPage(payload: Record<string, unknown>): { success: boolean; message: string } {
  const direction = payload.direction as string;
  const amount = (payload.amount as number) ?? 500;
  const selector = payload.selector as string | undefined;

  const target = selector ? document.querySelector(selector) : window;
  if (selector && !target) throw new Error(`Scroll target not found: ${selector}`);

  const scrollOptions: Record<string, number> = {};

  switch (direction) {
    case 'down': scrollOptions.top = amount; break;
    case 'up': scrollOptions.top = -amount; break;
    case 'right': scrollOptions.left = amount; break;
    case 'left': scrollOptions.left = -amount; break;
  }

  if (target === window) {
    window.scrollBy({ ...scrollOptions, behavior: 'smooth' });
  } else {
    (target as Element).scrollBy({ ...scrollOptions, behavior: 'smooth' });
  }

  return { success: true, message: `Scrolled ${direction} by ${amount}px` };
}

// =============================================================================
// 10. KEYBOARD
// =============================================================================

function sendKeyboard(payload: Record<string, unknown>): { success: boolean; message: string } {
  const key = payload.key as string;
  const modifiers = (payload.modifiers as string[]) ?? [];

  const eventInit: KeyboardEventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.includes('ctrl'),
    shiftKey: modifiers.includes('shift'),
    altKey: modifiers.includes('alt'),
    metaKey: modifiers.includes('meta'),
  };

  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  target.dispatchEvent(new KeyboardEvent('keyup', eventInit));

  // For printable characters, also dispatch an input event
  if (key.length === 1 && !modifiers.includes('ctrl') && !modifiers.includes('meta')) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.dispatchEvent(new InputEvent('beforeinput', {
        data: key,
        inputType: 'insertText',
        bubbles: true,
        cancelable: true,
      }));
      target.dispatchEvent(new InputEvent('input', {
        data: key,
        inputType: 'insertText',
        bubbles: true,
      }));
    }
  }

  return { success: true, message: `Key press: ${modifiers.length > 0 ? modifiers.join('+') + '+' : ''}${key}` };
}

// =============================================================================
// 11. RECORDING — Capture user interactions as replayable steps
// =============================================================================

interface RecordedStep {
  action: 'click' | 'fill' | 'select' | 'navigate';
  locator?: { css?: string; text?: string };
  value?: string;
  url?: string;
  timestamp: number;
}

let recording = false;
const recordedSteps: RecordedStep[] = [];
let recordClickHandler: ((e: MouseEvent) => void) | null = null;
let recordInputHandler: ((e: Event) => void) | null = null;

function getBestSelector(el: Element): { css?: string; text?: string } {
  // Try ID first
  if (el.id) return { css: `#${CSS.escape(el.id)}` };
  // Try data-testid
  const testId = el.getAttribute('data-testid');
  if (testId) return { css: `[data-testid="${CSS.escape(testId)}"]` };
  // Try aria-label
  const label = el.getAttribute('aria-label');
  if (label) return { text: label };
  // Try visible text (for buttons/links)
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a') {
    const text = (el as HTMLElement).innerText?.trim();
    if (text && text.length < 50) return { text };
  }
  // Fallback: build a CSS path
  const path: string[] = [];
  let current: Element | null = el;
  for (let i = 0; i < 3 && current && current !== document.body; i++) {
    let seg = current.tagName.toLowerCase();
    if (current.className && typeof current.className === 'string') {
      const cls = current.className.trim().split(/\s+/).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
      seg += cls;
    }
    path.unshift(seg);
    current = current.parentElement;
  }
  return { css: path.join(' > ') };
}

function startRecording(): { success: boolean; message: string } {
  if (recording) return { success: false, message: 'Already recording' };
  recording = true;
  recordedSteps.length = 0;

  recordClickHandler = (e: MouseEvent) => {
    const el = e.target as Element;
    if (!el || isAbuOverlay(el)) return;
    recordedSteps.push({
      action: 'click',
      locator: getBestSelector(el),
      timestamp: Date.now(),
    });
  };

  recordInputHandler = (e: Event) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      recordedSteps.push({
        action: 'select',
        locator: getBestSelector(el),
        value: (el as HTMLSelectElement).value,
        timestamp: Date.now(),
      });
    } else if (tag === 'input' || tag === 'textarea') {
      // Debounce: update last step if same element
      const last = recordedSteps[recordedSteps.length - 1];
      const loc = getBestSelector(el);
      if (last && last.action === 'fill' && JSON.stringify(last.locator) === JSON.stringify(loc)) {
        last.value = el.value;
        last.timestamp = Date.now();
      } else {
        recordedSteps.push({
          action: 'fill',
          locator: loc,
          value: el.value,
          timestamp: Date.now(),
        });
      }
    }
  };

  document.addEventListener('click', recordClickHandler, true);
  document.addEventListener('change', recordInputHandler, true);

  showStatus('Recording started...', 'info');
  return { success: true, message: `Recording started. Interact with the page, then call stop_recording to get the steps.` };
}

function stopRecording(): { success: boolean; steps: RecordedStep[]; message: string } {
  if (!recording) return { success: false, steps: [], message: 'Not recording' };
  recording = false;

  if (recordClickHandler) {
    document.removeEventListener('click', recordClickHandler, true);
    recordClickHandler = null;
  }
  if (recordInputHandler) {
    document.removeEventListener('change', recordInputHandler, true);
    recordInputHandler = null;
  }

  showStatus(`Recording stopped: ${recordedSteps.length} steps`, 'success');
  return {
    success: true,
    steps: [...recordedSteps],
    message: `Recorded ${recordedSteps.length} steps. Use these as a template for automation.`,
  };
}

// =============================================================================
// 12. FULL-PAGE SCREENSHOT — prepare/scroll/restore for scroll-and-stitch
// =============================================================================

/**
 * Elements whose position was temporarily overridden during full-page capture.
 * Stored as [element, originalPosition, originalTop] tuples for restoration.
 */
let savedFixedElements: [HTMLElement, string, string][] = [];

/**
 * Prepare for full-page screenshot:
 * 1. Record current scroll position
 * 2. Measure full page dimensions
 * 3. Hide fixed/sticky elements (except on first viewport) to avoid duplication
 */
function fullpagePrepare(): {
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  scrollX: number;
  scrollY: number;
} {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const scrollHeight = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  );

  // Find and hide fixed/sticky elements to prevent them repeating in every slice
  savedFixedElements = [];
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    const htmlEl = el as HTMLElement;
    const style = getComputedStyle(htmlEl);
    if (style.position === 'fixed' || style.position === 'sticky') {
      // Skip tiny elements (likely not headers/navbars)
      const rect = htmlEl.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 10) continue;
      savedFixedElements.push([htmlEl, style.position, htmlEl.style.top]);
      htmlEl.style.setProperty('position', 'absolute', 'important');
    }
  }

  return { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY };
}

/**
 * Scroll to a specific Y position (instant, no animation).
 */
function fullpageScroll(scrollTop: number): { success: boolean } {
  window.scrollTo({ top: scrollTop, left: 0, behavior: 'instant' as ScrollBehavior });
  return { success: true };
}

/**
 * Restore state after full-page capture:
 * 1. Restore fixed/sticky elements
 * 2. Restore original scroll position
 */
function fullpageRestore(scrollX: number, scrollY: number): { success: boolean } {
  // Restore fixed/sticky elements
  for (const [el, originalPosition, originalTop] of savedFixedElements) {
    el.style.position = originalPosition;
    el.style.top = originalTop;
  }
  savedFixedElements = [];

  // Restore scroll position
  window.scrollTo({ top: scrollY, left: scrollX, behavior: 'instant' as ScrollBehavior });
  return { success: true };
}

// =============================================================================
// VISUAL FEEDBACK — highlight elements during operations
// =============================================================================

let highlightOverlay: HTMLDivElement | null = null;

function highlightElement(el: Element): void {
  const rect = el.getBoundingClientRect();
  if (!highlightOverlay) {
    highlightOverlay = document.createElement('div');
    highlightOverlay.id = 'abu-highlight';
    highlightOverlay.style.cssText = `
      position: fixed; pointer-events: none; z-index: 2147483647;
      border: 2px solid #d97757; border-radius: 4px;
      background: rgba(217, 119, 87, 0.12);
      transition: all 0.15s ease;
    `;
    document.documentElement.appendChild(highlightOverlay);
  }
  highlightOverlay.style.top = `${rect.top - 2}px`;
  highlightOverlay.style.left = `${rect.left - 2}px`;
  highlightOverlay.style.width = `${rect.width + 4}px`;
  highlightOverlay.style.height = `${rect.height + 4}px`;
  highlightOverlay.style.display = 'block';
  highlightOverlay.style.opacity = '1';

  // Fade out after 1.5s
  setTimeout(() => {
    if (highlightOverlay) {
      highlightOverlay.style.opacity = '0';
      setTimeout(() => { if (highlightOverlay) highlightOverlay.style.display = 'none'; }, 300);
    }
  }, 1500);
}

// =============================================================================
// FLOATING STATUS INDICATOR
// =============================================================================

let statusBubble: HTMLDivElement | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function showStatus(text: string, type: 'info' | 'success' | 'error' = 'info'): void {
  if (!statusBubble) {
    statusBubble = document.createElement('div');
    statusBubble.id = 'abu-status';
    statusBubble.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
      padding: 8px 14px; border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px; line-height: 1.4;
      box-shadow: 0 2px 12px rgba(0,0,0,0.3);
      pointer-events: none;
      transition: opacity 0.3s ease, transform 0.3s ease;
      transform: translateY(0);
    `;
    document.documentElement.appendChild(statusBubble);
  }

  const colors = {
    info:    { bg: '#1a1a2e', border: '#d97757', text: '#e0e0e0' },
    success: { bg: '#0f2a1a', border: '#4ade80', text: '#4ade80' },
    error:   { bg: '#2a0f0f', border: '#f87171', text: '#f87171' },
  };
  const c = colors[type];
  statusBubble.style.background = c.bg;
  statusBubble.style.border = `1px solid ${c.border}`;
  statusBubble.style.color = c.text;
  statusBubble.textContent = `Abu: ${text}`;
  statusBubble.style.opacity = '1';
  statusBubble.style.transform = 'translateY(0)';

  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    if (statusBubble) {
      statusBubble.style.opacity = '0';
      statusBubble.style.transform = 'translateY(8px)';
    }
  }, 3000);
}

// =============================================================================
// UTILITIES
// =============================================================================

function isVisible(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  const style = getComputedStyle(htmlEl);
  // Checked unconditionally: `visibility: hidden` keeps the layout box, so
  // `offsetParent` stays non-null and the branch below never sees it — a
  // closed dropdown a library hides this way would otherwise count as the
  // live popup and its options as clickable. The computed value is per
  // element, so a `visibility: visible` child inside a hidden ancestor still
  // correctly reports visible.
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (htmlEl.offsetParent === null && htmlEl.style?.position !== 'fixed' && htmlEl.style?.position !== 'sticky') {
    if (style.display === 'none') return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * The element's text as a caller should see it.
 *
 * ⚠️ For INPUT/TEXTAREA this returns the field's VALUE, which makes it a
 * redaction path — and the one that was missed in the first U5 round. It feeds
 * `info.text` in the snapshot (on the very object whose `.value` is redacted),
 * `targetInfo` (→ click's `elementText`, `target.text`, the on-page status
 * toast), `describeElement` (→ click's `message`, error text, and whatever an
 * IM approval prompt quotes), and `wait_for`'s "whose text is …" explanation.
 * Redacting here covers all of them at once; anything that reaches for
 * `el.value` directly instead has to re-do this.
 *
 * A sensitive field falls through to placeholder / aria-label first, so the
 * caller can still tell WHICH field it is, and only shows the marker when the
 * page gave it nothing else to be called.
 */
function getVisibleText(el: Element): string | null {
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    if (hasSensitiveValue(input)) {
      return input.placeholder
        || input.getAttribute('aria-label')
        || (input.value ? REDACTED_VALUE : null);
    }
    return input.value || input.placeholder || input.getAttribute('aria-label') || null;
  }
  if (el.tagName === 'TEXTAREA') {
    const ta = el as HTMLTextAreaElement;
    if (hasSensitiveValue(ta)) {
      return ta.placeholder
        || ta.getAttribute('aria-label')
        || (ta.value ? REDACTED_VALUE : null);
    }
    return ta.value || ta.placeholder || null;
  }

  const text = (el as HTMLElement).innerText?.trim();
  return text || el.getAttribute('aria-label') || null;
}
