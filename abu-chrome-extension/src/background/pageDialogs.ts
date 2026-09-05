/**
 * JavaScript dialogs on the CHROME EXTENSION channel — what is possible here,
 * and what is honestly not.
 *
 * ## The hard constraint
 *
 * When a page calls `alert()` / `confirm()` / `prompt()`, Chrome suspends that
 * tab's ENTIRE renderer until the native box is answered. The content script
 * lives in that same renderer, so while a dialog is up:
 *
 *   - `chrome.tabs.sendMessage` to the content script never gets a reply;
 *   - `chrome.scripting.executeScript` cannot run either;
 *   - therefore NOTHING in this extension can read the dialog's text, and
 *     nothing can dismiss it. Only the user, or `chrome.debugger`, can.
 *
 * The built-in browser does not have this problem: it drives the dialog
 * through CDP (`Page.javascriptDialogOpening`), which suspends the page for
 * *us* and hands us the text — see `electron/browserHost.cjs`.
 *
 * ## What was rejected, and why
 *
 * - **`chrome.debugger`** would give this channel the same power CDP gives the
 *   built-in browser. It needs the `"debugger"` permission, which disables the
 *   extension until the user re-approves it on update and shows a standing
 *   "…started debugging this browser" bar on every tab it touches. That is a
 *   product decision about how loud this extension is allowed to be, not an
 *   implementation detail, so it is written up for Shawn rather than taken
 *   here.
 * - **Observing without intercepting** (wrap the dialog functions, record, then
 *   call the original) reads well and does nothing: the original blocks the
 *   renderer, so the record can never be fetched. Dead end, verified against
 *   the constraint above rather than assumed.
 * - **Intercepting by default, on every driven tab**, would keep the tab alive
 *   but silently swallow dialogs the USER raises on that page afterwards —
 *   they click "删除" themselves and the confirm never appears.
 *
 * ## What this is
 *
 * A one-shot, opt-in, self-uninstalling answer. `handle_dialog` ARMS the page:
 * the next dialog it raises gets the caller's answer and is recorded, and the
 * patch immediately restores the page's own functions, so the page is back to
 * native behavior after exactly one dialog. An arming nobody used expires
 * after `JS_DIALOG_AUTO_DISMISS_MS` and also restores the originals. That
 * bounds the blast radius to: one document, one dialog, within one minute,
 * only after an explicitly approved `handle_dialog` call.
 *
 * The three `pageWorld*` functions below are handed to
 * `chrome.scripting.executeScript({ world: 'MAIN' })`, which serializes them
 * with `Function.prototype.toString`. They must therefore be SELF-CONTAINED —
 * no imports, no module-level constants, no helpers from this file. That is
 * why they repeat a little.
 */

import {
  JS_DIALOG_AUTO_DISMISS_MS,
  JS_DIALOG_UNTRUSTED_NOTICE,
  type GetDialogResult,
  type HandleDialogResult,
  type JsDialogAction,
  type ResolvedJsDialog,
} from '../shared/types.js';

/** What the page-world helpers report back across the injection boundary. */
export interface PageDialogState {
  installed: boolean;
  armed: { action: JsDialogAction; expiresAt: number } | null;
  last: ResolvedJsDialog | null;
}

/** Said on every Chrome-channel dialog result, so the difference between the
 *  two channels is never something the model has to infer from silence. */
export const CHROME_DIALOG_CHANNEL_NOTE =
  'Chrome extension channel: a native dialog freezes the whole tab, so this channel cannot '
  + 'read or dismiss one that is already open — only the user can. handle_dialog instead arms '
  + 'a one-shot answer for the NEXT dialog the page raises; call it before the action you '
  + 'expect to raise one. beforeunload is not supported here. Abu\'s built-in browser holds '
  + 'all four kinds open and answers them directly.';

/**
 * Runs in the page's MAIN world. Reports what the interceptor knows WITHOUT
 * installing it — `get_dialog` is read-only, and installing from a read would
 * change how the page behaves for the user.
 */
export function pageWorldReadDialogState(): unknown {
  const state = (globalThis as Record<string, unknown>).__ABU_PAGE_DIALOGS__ as
    | { installed?: boolean; armed?: { action?: string; expiresAt?: number } | null; last?: unknown }
    | undefined;
  if (!state) return { installed: false, armed: null, last: null };
  return {
    installed: state.installed === true,
    armed: state.armed
      ? { action: state.armed.action, expiresAt: state.armed.expiresAt }
      : null,
    last: state.last ?? null,
  };
}

/**
 * Runs in the page's MAIN world. Installs the one-shot interceptor if needed
 * and arms it with `action` (+ `promptText`), valid for `ttlMs`.
 */
export function pageWorldArmDialogAnswer(
  action: string,
  promptText: string | null,
  ttlMs: number,
): unknown {
  const host = globalThis as unknown as Record<string, unknown> & {
    alert?: unknown; confirm?: unknown; prompt?: unknown;
  };
  let state = host.__ABU_PAGE_DIALOGS__ as {
    installed: boolean;
    originals: { alert: unknown; confirm: unknown; prompt: unknown };
    armed: { action: string; promptText: string | null; expiresAt: number } | null;
    last: unknown;
  } | undefined;

  if (!state) {
    state = {
      installed: false,
      originals: { alert: host.alert, confirm: host.confirm, prompt: host.prompt },
      armed: null,
      last: null,
    };
    host.__ABU_PAGE_DIALOGS__ = state;
  }

  const restore = (): void => {
    const current = host.__ABU_PAGE_DIALOGS__ as typeof state;
    if (!current || !current.installed) return;
    host.alert = current.originals.alert;
    host.confirm = current.originals.confirm;
    host.prompt = current.originals.prompt;
    current.installed = false;
  };

  // One entry point for all three kinds. Returns the answer the page's own
  // dialog function would have returned.
  const answer = (kind: string, message: unknown, fallback: unknown): unknown => {
    const current = host.__ABU_PAGE_DIALOGS__ as typeof state;
    const now = Date.now();
    const armed = current && current.armed;
    if (!armed || now > armed.expiresAt) {
      // Never armed, or the arming went stale. Hand the page back its own
      // dialogs and let this call behave exactly as it always did — the user
      // must not lose a confirm because Abu armed one a while ago.
      restore();
      const original = current ? current.originals[kind as 'alert' | 'confirm' | 'prompt'] : undefined;
      return typeof original === 'function'
        ? (original as (...a: unknown[]) => unknown).call(host, message, fallback)
        : undefined;
    }
    current!.armed = null;
    current!.last = {
      type: kind,
      message: typeof message === 'string' ? message : String(message ?? ''),
      ...(kind === 'prompt' && typeof fallback === 'string' ? { defaultPrompt: fallback } : {}),
      url: typeof location !== 'undefined' ? location.href : '',
      openedAt: now,
      disposition: armed.action === 'accept' ? 'accepted' : 'dismissed',
    };
    // One shot: the page gets its own dialogs back immediately, so a SECOND
    // dialog (the user's own, later) is never swallowed.
    restore();
    if (kind === 'alert') return undefined;
    if (kind === 'confirm') return armed.action === 'accept';
    if (armed.action !== 'accept') return null;
    if (typeof armed.promptText === 'string') return armed.promptText;
    return typeof fallback === 'string' ? fallback : '';
  };

  if (!state.installed) {
    state.originals = { alert: host.alert, confirm: host.confirm, prompt: host.prompt };
    host.alert = function (message?: unknown) { return answer('alert', message, undefined); };
    host.confirm = function (message?: unknown) { return answer('confirm', message, undefined); };
    host.prompt = function (message?: unknown, fallback?: unknown) { return answer('prompt', message, fallback); };
    state.installed = true;
  }
  state.armed = { action, promptText, expiresAt: Date.now() + ttlMs };
  return {
    installed: true,
    armed: { action, expiresAt: state.armed.expiresAt },
    last: state.last ?? null,
  };
}

function asState(raw: unknown): PageDialogState {
  const value = (raw ?? {}) as Partial<PageDialogState>;
  return {
    installed: value.installed === true,
    armed: value.armed ?? null,
    last: value.last ?? null,
  };
}

/** Shape a `get_dialog` answer for this channel out of what the page reported. */
export function chromeGetDialogResult(tabId: number, raw: unknown): GetDialogResult {
  const state = asState(raw);
  const message = state.last
    ? `No dialog can be open here for Abu to read. The last one this channel answered (${state.last.type}) was ${state.last.disposition}.`
    : state.armed
      ? 'No dialog has been raised since handle_dialog armed this page. Nothing to read yet.'
      : 'This channel is not armed for dialogs on this page, so it has seen none.';
  return {
    tabId,
    pending: false,
    ...(state.last ? { last: state.last, untrustedContentNotice: JS_DIALOG_UNTRUSTED_NOTICE } : {}),
    message: `${message} ${CHROME_DIALOG_CHANNEL_NOTE}`,
  };
}

/** Shape a `handle_dialog` answer for this channel. Never `handled` — this
 *  channel arms, it does not answer something already open. */
export function chromeHandleDialogResult(
  tabId: number,
  action: JsDialogAction,
  raw: unknown,
): HandleDialogResult {
  const state = asState(raw);
  return {
    tabId,
    action,
    handled: false,
    armed: true,
    ...(state.last ? { untrustedContentNotice: JS_DIALOG_UNTRUSTED_NOTICE } : {}),
    message:
      `Armed: the next dialog this page raises will be ${action === 'accept' ? 'accepted' : 'dismissed'}`
      + `, once, within ${Math.round(JS_DIALOG_AUTO_DISMISS_MS / 1000)}s; after that the page's own `
      + 'dialogs are restored. Take the action you expect to raise it, then call get_dialog to see '
      + `what the page actually asked. ${CHROME_DIALOG_CHANNEL_NOTE}`,
  };
}

export { JS_DIALOG_AUTO_DISMISS_MS };

// ── Injection plumbing ────────────────────────────────────────────────────
//
// `chrome.scripting` is read off `globalThis` rather than as the ambient
// global, for the same reason `contentActions.ts` touches no `chrome.*` at
// all: this module has to be importable — and its page-world helpers directly
// callable — from a plain test process that has no extension APIs.

interface ScriptingApi {
  executeScript(injection: {
    target: { tabId: number };
    world: 'MAIN';
    func: (...args: never[]) => unknown;
    args?: unknown[];
  }): Promise<{ result?: unknown }[]>;
}

function scriptingApi(): ScriptingApi {
  const api = (globalThis as { chrome?: { scripting?: ScriptingApi } }).chrome?.scripting;
  if (!api) throw new Error('chrome.scripting is unavailable in this context.');
  return api;
}

/**
 * Bounded on purpose. A tab that is ALREADY frozen by a native dialog cannot
 * be scripted at all, and the injection promise then simply never settles — so
 * without this the caller would sit out the bridge's 30s timeout and be told
 * "timeout", which points at the wrong thing entirely. The deadline turns that
 * into the one sentence that is both true and actionable.
 */
export const PAGE_WORLD_TIMEOUT_MS = 5_000;

export const PAGE_WORLD_FROZEN_HINT =
  'It is most likely frozen by a native JavaScript dialog (alert/confirm/prompt), which this '
  + 'channel cannot read or dismiss — ask the user to answer it, or use Abu\'s built-in browser, '
  + 'which can.';

export async function runInPageWorld(
  tabId: number,
  func: (...args: never[]) => unknown,
  args: unknown[],
): Promise<unknown> {
  const injection = scriptingApi().executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        `Tab ${tabId} did not respond within ${PAGE_WORLD_TIMEOUT_MS / 1000}s. ${PAGE_WORLD_FROZEN_HINT}`,
      )),
      PAGE_WORLD_TIMEOUT_MS,
    );
  });
  try {
    const results = await Promise.race([injection, deadline]);
    return results[0]?.result ?? null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
