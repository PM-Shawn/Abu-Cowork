// @vitest-environment happy-dom
/**
 * Bridge → extension request routing.
 *
 * The extension channel and the built-in Electron browser share one tool
 * schema (`abu-browser-bridge/src/tools.ts`) and one DOM runtime
 * (`content/index.ts`), but each maintains its OWN hand-written `switch` over
 * action names. A tool that is registered, implemented in the content script,
 * and simply missing from this file's `switch` falls through to `default:` and
 * answers `Unknown action: find` — which reads to the model as "this tool is
 * broken" and sends it back to scripting the page. Nothing in the compiler
 * links the three lists.
 *
 * So the routing is exercised from the real entry point: a JSON frame arriving
 * on the WebSocket, exactly as `wsServer.ts` sends it — not by reaching into
 * `handleRequest`, which is module-private for good reason.
 *
 * The rest of the file covers the actions this service worker answers ITSELF
 * (tabs, navigation, downloads, screenshots) and the state it keeps for them.
 * That side of the channel had no tests at all, which is how `ownerId`/`runId`
 * came to be sent by the bridge and consumed by nobody (F5-②).
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResponse } from '../shared/types.js';
// The list the router itself reads, not a fourth hand-typed copy of it — the
// previous copy here was missing `get_html` entirely, so the case it was
// supposed to guard was never exercised. Whether that list covers everything
// the bridge registers is pinned separately, against the real registration, in
// `src/core/tools/browserToolRouting.test.ts`.
import { CONTENT_SCRIPT_ACTIONS } from './contentActions.js';

type HandleAction = (action: string, payload: Record<string, unknown>) => Promise<unknown>;

const ROUTED_ACTIONS = [...CONTENT_SCRIPT_ACTIONS];

interface SentMessage {
  tabId: number;
  action: string;
  payload: Record<string, unknown>;
  /** Which frame the worker aimed at. `undefined` would mean a broadcast. */
  frameId?: number;
}

const sentToContent: SentMessage[] = [];
const sockets: FakeSocket[] = [];

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    sockets.push(this);
    // The real socket opens asynchronously; a microtask is enough here.
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
}

/** Listeners the service worker registered, so a test can fire a real event. */
type Listener = (...args: unknown[]) => unknown;
const listeners = new Map<string, Listener[]>();
function slot(name: string): { addListener: (fn: Listener) => void } {
  listeners.set(name, []);
  return { addListener: (fn: Listener) => { listeners.get(name)!.push(fn); } };
}
function fire(name: string, ...args: unknown[]): unknown {
  let last: unknown;
  for (const fn of listeners.get(name) ?? []) last = fn(...args);
  return last;
}

/** Browser state the fake reports; tests reshape it per case. */
interface FakeTab { id: number; windowId: number; url: string; title: string; active: boolean }
const browserState: {
  windows: { id: number; type: string; focused: boolean }[];
  tabs: FakeTab[];
  updated: { tabId: number; props: Record<string, unknown> }[];
  reloaded: number[];
  injected: { tabId: number; files?: string[]; world?: string; args?: unknown[] }[];
  captured: number[];
  sessionStore: Record<string, number>;
  /** What the page's MAIN world answers a dialog helper with. */
  pageDialogState: unknown;
  /** When true, an injection never settles — a tab frozen by a native dialog. */
  pageIsFrozen: boolean;
  /**
   * What `executeScript({allFrames:true})` reports per tab — Chrome's own
   * frame ids, document ids and the address each frame reads from its own
   * `location`. This is the browser-authoritative source the frame handles and
   * the gate's per-frame origins are built from, so the fake carries it in the
   * same shape rather than letting the worker invent one.
   */
  frames: Record<number, { frameId: number; documentId: string; url: string; hidden?: true }[]>;
  /**
   * The probe function Chrome was asked to inject, kept so its rules can be
   * RUN rather than only faked. Everything else in this file supplies the
   * probe's ANSWER; `probeFrameIdentity` decides what that answer is, and its
   * own branches had no coverage at all (round-2 R2-F).
   */
  probeFunc?: (...a: never[]) => unknown;
  /** Content-script answers by `${tabId}:${frameId}:${action}`; default is a routed echo. */
  contentAnswers: Record<string, { data?: unknown; error?: string }>;
  /**
   * What the BROWSER does while a content-script message is in flight.
   *
   * `download`'s whole contract is about ordering — the waiter is armed before
   * the click and the file may land before the click even returns — so a test
   * needs a seam at exactly that instant. This is it; everything else in this
   * file leaves it null.
   */
  onContentMessage: ((action: string, tabId: number) => void) | null;
  /** Every `offscreen.createDocument` the worker got as far as calling. */
  offscreenCreated: { url: string; reasons: unknown[]; justification: string }[];
  /** The `stitch` messages the offscreen document was asked to composite. */
  stitchRequests: Record<string, unknown>[];
} = {
  windows: [], tabs: [], updated: [], reloaded: [], injected: [], captured: [], sessionStore: {},
  pageDialogState: { installed: false, armed: null, last: null },
  pageIsFrozen: false,
  frames: {},
  contentAnswers: {},
  onContentMessage: null,
  offscreenCreated: [],
  stitchRequests: [],
};

/**
 * `chrome.offscreen.Reason`, as the browser actually defines it.
 *
 * Copied from the runtime rather than from memory: dumped out of a real
 * service worker with `Object.keys(chrome.offscreen.Reason)` (Chrome 149 and
 * 152 agree), and identical to the enum in `@types/chrome` and to the list on
 * developer.chrome.com. There is deliberately no CANVAS here — see the
 * full-page screenshot case at the bottom of this file for why that matters.
 */
const CHROME_OFFSCREEN_REASONS = [
  'AUDIO_PLAYBACK', 'BATTERY_STATUS', 'BLOBS', 'CLIPBOARD', 'DISPLAY_MEDIA',
  'DOM_PARSER', 'DOM_SCRAPING', 'GEOLOCATION', 'IFRAME_SCRIPTING', 'LOCAL_STORAGE',
  'MATCH_MEDIA', 'TESTING', 'USER_MEDIA', 'WEB_RTC', 'WORKERS',
] as const;

/** Enough of the extension APIs to drive the real request path. */
function fakeChrome(): Record<string, unknown> {
  return {
    storage: {
      session: {
        get: (_keys: unknown, cb: (r: Record<string, number>) => void) => cb({}),
        set: (entries: Record<string, number>) => { Object.assign(browserState.sessionStore, entries); },
      },
    },
    tabs: {
      onActivated: slot('tabs.onActivated'),
      onRemoved: slot('tabs.onRemoved'),
      onUpdated: slot('tabs.onUpdated'),
      query: async (q: { active?: boolean; windowId?: number }) => browserState.tabs.filter(
        (t) => (q.active === undefined || t.active === q.active)
          && (q.windowId === undefined || t.windowId === q.windowId),
      ),
      get: async (tabId: number) => {
        const tab = browserState.tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      },
      update: async (tabId: number, props: Record<string, unknown>) => {
        browserState.updated.push({ tabId, props });
        if (props.active === true) {
          for (const t of browserState.tabs) if (t.windowId === browserState.tabs.find((x) => x.id === tabId)?.windowId) t.active = t.id === tabId;
        }
        return browserState.tabs.find((t) => t.id === tabId);
      },
      reload: async (tabId: number) => { browserState.reloaded.push(tabId); },
      captureVisibleTab: async (windowId: number) => {
        browserState.captured.push(windowId);
        return 'data:image/png;base64,AAAA';
      },
      sendMessage: (
        tabId: number,
        message: { action: string; payload: Record<string, unknown> },
        options: { frameId?: number } | ((response: { data?: unknown; error?: string }) => void),
        maybeCb?: (response: { data?: unknown; error?: string }) => void,
      ) => {
        const cb = typeof options === 'function' ? options : maybeCb!;
        const frameId = typeof options === 'function' ? undefined : options.frameId;
        sentToContent.push({ tabId, action: message.action, payload: message.payload, frameId });
        browserState.onContentMessage?.(message.action, tabId);
        const scripted = browserState.contentAnswers[`${tabId}:${frameId ?? 0}:${message.action}`];
        cb(scripted ?? { data: { routed: message.action } });
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: slot('windows.onFocusChanged'),
      getAll: async () => browserState.windows,
      getLastFocused: (opts: unknown, cb?: (w: unknown) => void) => {
        const win = browserState.windows.find((w) => w.focused) ?? browserState.windows[0]
          ?? { id: 1, type: 'normal', focused: true };
        const populated = { ...win, tabs: browserState.tabs.filter((t) => t.windowId === win.id) };
        if (cb) { cb(populated); return undefined; }
        return Promise.resolve(populated);
      },
    },
    downloads: {
      onCreated: slot('downloads.onCreated'),
      onChanged: slot('downloads.onChanged'),
      // T6 — the hook that files an Abu download into its own folder. Present
      // here because the worker registers it conditionally, and a fake without
      // it would make the "leaves the user's own downloads alone" claim
      // vacuously true.
      onDeterminingFilename: slot('downloads.onDeterminingFilename'),
    },
    runtime: {
      onMessage: slot('runtime.onMessage'),
      lastError: undefined,
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      // No document until one is created, which is the state the worker's
      // `getContexts` check exists to detect after a service-worker restart.
      getContexts: async () => (browserState.offscreenCreated.length > 0
        ? [{ contextType: 'OFFSCREEN_DOCUMENT' }]
        : []),
      sendMessage: async (message: Record<string, unknown>) => {
        if (message.type === 'stitch') {
          browserState.stitchRequests.push(message);
          return { success: true, data: 'data:image/png;base64,STITCHED' };
        }
        return undefined;
      },
    },
    offscreen: {
      Reason: Object.fromEntries(CHROME_OFFSCREEN_REASONS.map((r) => [r, r])),
      // Chrome validates `reasons` against the enum and rejects anything else
      // before the document is created. The fake refuses in the same place and
      // with the same sentence, because THAT rejection is what this suite has
      // to be able to see — a permissive fake would accept `[undefined]` and
      // report a passing test for a call the browser throws on.
      createDocument: async (params: { url: string; reasons: unknown[]; justification: string }) => {
        params.reasons.forEach((reason, index) => {
          if (typeof reason !== 'string' || !(CHROME_OFFSCREEN_REASONS as readonly string[]).includes(reason)) {
            throw new TypeError(
              "Error in invocation of offscreen.createDocument(offscreen.CreateParameters parameters, "
              + "optional function callback): Error at parameter 'parameters': Error at property 'reasons': "
              + `Error at index ${index}: Invalid type: expected offscreen.Reason, found ${String(reason)}.`,
            );
          }
        });
        browserState.offscreenCreated.push(params);
      },
    },
    alarms: { create: () => {}, onAlarm: slot('alarms.onAlarm') },
    scripting: {
      executeScript: async (opts: {
        target: { tabId: number; allFrames?: boolean }; files?: string[]; world?: string; args?: unknown[];
        func?: (...a: never[]) => unknown;
      }) => {
        browserState.injected.push({
          tabId: opts.target.tabId, files: opts.files, world: opts.world, args: opts.args,
        });
        // The frame probe: one result row per frame, exactly as Chrome returns
        // it, so the worker reads frame ids and document ids from the browser
        // rather than from anything the page could author.
        if (String(opts.func ?? '').includes('location.href')) {
          browserState.probeFunc = opts.func;
          const rows = browserState.frames[opts.target.tabId];
          if (rows === undefined) {
            const tab = browserState.tabs.find((t) => t.id === opts.target.tabId);
            return [{ frameId: 0, documentId: 'doc-main', result: { url: tab?.url ?? '', title: '' } }];
          }
          return rows.map((row) => ({
            frameId: row.frameId,
            documentId: row.documentId,
            result: { url: row.url, title: '', ...(row.hidden ? { hidden: true } : {}) },
          }));
        }
        // A tab held by a native dialog cannot be scripted at all, and Chrome
        // simply never settles the promise — the case `runInPageWorld`'s
        // deadline exists for.
        if (browserState.pageIsFrozen) return new Promise<never>(() => {});
        // The dialog helpers are the one place the RETURNED VALUE matters
        // here; every other injection in this suite is checked by its args.
        // Matched on the page-world marker rather than the function name, so
        // it cannot quietly stop matching under a bundler.
        if (String(opts.func ?? '').includes('__ABU_PAGE_DIALOGS__')) {
          return [{ result: browserState.pageDialogState }];
        }
        return [{ result: { originMatched: true, value: 'evaluated' } }];
      },
    },
  };
}

/** Feed one bridge frame through the socket and read the reply the SW sends. */
async function request(
  action: string,
  payload: Record<string, unknown>,
  opts: { pumpMs?: number } = {},
): Promise<BridgeResponse> {
  const socket = sockets[0];
  const id = `req-${action}`;
  socket.onmessage?.({ data: JSON.stringify({ id, action, payload }) });
  // The handler is async; give it the microtasks it needs to reply. Frame
  // routing adds a couple of awaited probes to some paths, so this has to be
  // generous — a reply that lands one turn late is not a failure of the code,
  // and (worse) it desynchronises every later `request` in the file.
  for (let i = 0; i < 500 && socket.sent.length === 0; i += 1) await Promise.resolve();
  // A couple of paths sleep on a real timer (the tab-switch settle before a
  // screenshot). Advance a FAKE clock rather than waiting on a real one — the
  // suite must not be able to fail because a machine was busy.
  if (socket.sent.length === 0 && opts.pumpMs !== undefined) {
    await vi.advanceTimersByTimeAsync(opts.pumpMs);
  }
  const raw = socket.sent.shift();
  if (raw === undefined) throw new Error(`no response for action "${action}"`);
  return JSON.parse(raw) as BridgeResponse;
}

/**
 * Does the content runtime implement this action? Anything it does not know
 * throws `Unknown content action` from its `default:` branch, before it can
 * touch the DOM — so an action that fails for any OTHER reason (a missing
 * locator in the empty payload below, say) counts as implemented.
 */
const contentRuntime: { handleAction?: HandleAction } = {};
async function contentImplements(action: string): Promise<boolean> {
  const outcome = await contentRuntime.handleAction?.(action, {}).catch((err: unknown) => err);
  return !(outcome instanceof Error && /Unknown content action/.test(outcome.message));
}

/** One window, two tabs, the second active — the ordinary case. */
function twoTabWindow(): void {
  browserState.windows = [{ id: 1, type: 'normal', focused: true }];
  browserState.tabs = [
    { id: 11, windowId: 1, url: 'https://a.example/', title: 'A', active: false },
    { id: 12, windowId: 1, url: 'https://b.example/', title: 'B', active: true },
  ];
}

beforeEach(() => {
  browserState.pageDialogState = { installed: false, armed: null, last: null };
  browserState.pageIsFrozen = false;
  browserState.updated.length = 0;
  browserState.reloaded.length = 0;
  browserState.injected.length = 0;
  browserState.captured.length = 0;
  browserState.frames = {};
  browserState.contentAnswers = {};
  browserState.onContentMessage = null;
  browserState.stitchRequests.length = 0;
  sentToContent.length = 0;
});

beforeAll(async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.chrome = fakeChrome();
  globals.WebSocket = FakeSocket;
  // Discovery is expected to fail here; the module then falls back to the
  // fixed port, which is all this test needs.
  globals.fetch = vi.fn(async () => { throw new Error('no discovery endpoint in tests'); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  await import('./index');
  for (let i = 0; i < 50 && sockets.length === 0; i += 1) await Promise.resolve();
  if (sockets.length === 0) throw new Error('background script never opened a socket');

  // The same bundle the built-in browser injects; with the marker set it
  // exposes `handleAction` and never touches `chrome.*`.
  globals.__ABU_ELECTRON_BROWSER_RUNTIME__ = contentRuntime;
  await import('../content/index.js');
  if (!contentRuntime.handleAction) throw new Error('content runtime did not register handleAction');
});

describe('every content-script action the bridge registers is routed', () => {
  it.each(ROUTED_ACTIONS)('routes %s to the content script', async (action) => {
    sentToContent.length = 0;

    const response = await request(action, { tabId: 42, marker: action });

    expect(response.success).toBe(true);
    expect(sentToContent).toEqual([
      {
        tabId: 42,
        action,
        // Aimed at the MAIN frame, not broadcast: `frameId: undefined` would
        // mean every frame of the tab answers and the first reply wins.
        frameId: 0,
        payload: { tabId: 42, marker: action, __abuFrameId: 'f0' },
      },
    ]);
  });

  it('routes only actions the content runtime actually implements', async () => {
    // The other half of the same coupling: this channel must not forward an
    // action the DOM runtime does not know, or the model gets
    // `Unknown content action` from one layer deeper. Probed against the real
    // content runtime rather than a re-typed list.
    const unimplemented: string[] = [];
    for (const action of ROUTED_ACTIONS) {
      if (!(await contentImplements(action))) unimplemented.push(action);
    }
    expect(unimplemented).toEqual([]);
    // The probe has to be able to fail, or the assertion above proves nothing.
    expect(await contentImplements('teleport')).toBe(false);
  });

  it('still answers Unknown action for something nobody registered', async () => {
    const response = await request('teleport', { tabId: 42 });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/Unknown action: teleport/);
  });
});

describe('frames', () => {
  /** A page whose form sits in a cross-origin embedded region. */
  function tabWithVendorFrame(): void {
    twoTabWindow();
    browserState.frames[11] = [
      { frameId: 0, documentId: 'doc-main', url: 'https://a.example/' },
      { frameId: 4, documentId: 'doc-vendor', url: 'https://vendor.example/form' },
    ];
  }

  it('aims a named region at that frame, and tells its runtime which frame it is', async () => {
    tabWithVendorFrame();

    const response = await request('fill', {
      tabId: 11, frameId: 'f4', locator: { css: '#name' }, value: '张三',
    });

    expect(response.success).toBe(true);
    expect(sentToContent).toEqual([
      {
        tabId: 11,
        action: 'fill',
        frameId: 4,
        payload: {
          tabId: 11, frameId: 'f4', locator: { css: '#name' }, value: '张三', __abuFrameId: 'f4',
        },
      },
    ]);
  });

  it('refuses a region that reloaded, and touches the page not at all', async () => {
    tabWithVendorFrame();
    await request('snapshot', { tabId: 11 });
    browserState.frames[11] = [
      { frameId: 0, documentId: 'doc-main', url: 'https://a.example/' },
      { frameId: 4, documentId: 'doc-vendor-2', url: 'https://vendor.example/form' },
    ];
    sentToContent.length = 0;

    const response = await request('click', { tabId: 11, frameId: 'f4', locator: { css: '#save' } });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/reloaded, or was removed/);
    expect(sentToContent).toHaveLength(0);
  });

  it('refuses a region the page does not have, rather than acting on the main document', async () => {
    tabWithVendorFrame();

    const response = await request('click', { tabId: 11, frameId: 'f9', locator: { css: '#save' } });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/not on this page any more/);
    expect(sentToContent).toHaveLength(0);
  });

  it('resolves a locator that named no region to the ONE region that holds it', async () => {
    tabWithVendorFrame();
    browserState.contentAnswers['11:0:fill'] = { error: 'Element not found: {"css":"#name"}.' };
    browserState.contentAnswers['11:4:locate'] = { data: { matched: 1 } };
    browserState.contentAnswers['11:4:fill'] = { data: { success: true, message: 'filled' } };

    const response = await request('fill', { tabId: 11, locator: { css: '#name' }, value: '张三' });

    expect(response.success).toBe(true);
    // Main frame first, then a read-only probe, then the action in the frame
    // that actually holds the field — never a broadcast.
    expect(sentToContent.map((m) => [m.action, m.frameId])).toEqual([
      ['fill', 0], ['locate', 4], ['fill', 4],
    ]);
  });

  it('refuses when two regions hold the same locator instead of picking one', async () => {
    twoTabWindow();
    browserState.frames[11] = [
      { frameId: 0, documentId: 'doc-main', url: 'https://a.example/' },
      { frameId: 4, documentId: 'doc-4', url: 'https://vendor.example/form' },
      { frameId: 5, documentId: 'doc-5', url: 'https://other.example/form' },
    ];
    browserState.contentAnswers['11:0:click'] = { error: 'Element not found: {"css":".primary"}.' };
    browserState.contentAnswers['11:4:locate'] = { data: { matched: 1 } };
    browserState.contentAnswers['11:5:locate'] = { data: { matched: 1 } };

    const response = await request('click', { tabId: 11, locator: { css: '.primary' } });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/2 different embedded regions/);
    expect(response.error).toMatch(/https:\/\/vendor\.example/);
    // The probe is read-only; the refusal costs the page nothing.
    expect(sentToContent.filter((m) => m.action === 'click').map((m) => m.frameId)).toEqual([0]);
  });

  it('keeps "not found" when no region holds it, and points at the regions that exist', async () => {
    tabWithVendorFrame();
    browserState.contentAnswers['11:0:click'] = { error: 'Element not found: {"css":"#nope"}.' };
    browserState.contentAnswers['11:4:locate'] = { data: { matched: 0 } };

    const response = await request('click', { tabId: 11, locator: { css: '#nope' } });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/Element not found/);
    expect(response.error).toMatch(/embedded region/);
    expect(response.error).toMatch(/f4 \(https:\/\/vendor\.example\)/);
  });

  it('never resolves ACROSS frames for an action that named one', async () => {
    tabWithVendorFrame();
    browserState.contentAnswers['11:4:click'] = { error: 'Element not found: {"css":"#nope"}.' };

    const response = await request('click', { tabId: 11, frameId: 'f4', locator: { css: '#nope' } });

    expect(response.success).toBe(false);
    expect(sentToContent.map((m) => m.action)).toEqual(['click']);
  });

  /**
   * TESTING §13.1, "隐藏 / 零尺寸 iframe 里塞一份同名控件", extension half.
   *
   * The probe reads visibility from inside each frame (`window.frameElement`
   * when the parent is same-origin — which is the direction that needs it —
   * and the frame's own viewport otherwise), and a region the user cannot see
   * is left out of the list a frameless locator is resolved against. Otherwise
   * a decoy carrying the same control is the unique match, and the fill lands
   * in a document nobody can look at, reported as a success.
   */
  it('never resolves a frameless locator into a HIDDEN region', async () => {
    twoTabWindow();
    browserState.frames[11] = [
      { frameId: 0, documentId: 'doc-main', url: 'https://a.example/' },
      { frameId: 4, documentId: 'doc-vendor', url: 'https://a.example/decoy', hidden: true },
    ];
    browserState.contentAnswers['11:0:fill'] = { error: 'Element not found: {"css":"#name"}.' };
    browserState.contentAnswers['11:4:locate'] = { data: { matched: 1 } };

    const response = await request('fill', { tabId: 11, locator: { css: '#name' }, value: '张三' });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/Element not found/);
    // Not even probed, let alone filled.
    expect(sentToContent.map((m) => [m.action, m.frameId])).toEqual([['fill', 0]]);
    // And the region is named as hidden, so "why did it not look there" has an
    // answer the caller can act on.
    expect(response.error).toMatch(/f4 \(https:\/\/a\.example, hidden\)/);
  });

  /**
   * Round-2 R2-F — the probe's OWN rules, run rather than faked.
   *
   * Every other case in this file supplies `hidden: true` as the probe's
   * answer, which pins what the worker DOES with it and nothing about how it
   * is decided. `probeFrameIdentity` is serialized into the page by
   * `chrome.scripting.executeScript`, so it is reachable here only as the
   * function the fake was handed — which is exactly what makes it callable.
   *
   * `visibility: hidden` is the arm that most needed this: such a frame has an
   * ordinary layout box inside the viewport, so neither the zero-size nor the
   * off-screen arm says anything about it.
   */
  describe('the frame probe itself decides what "hidden" means', () => {
    /** One `window.frameElement`, as the probe reads it. */
    function frameElement(box: {
      width: number; height: number; left?: number; top?: number; visibility?: string;
    }): unknown {
      const view = {
        scrollX: 0,
        scrollY: 0,
        getComputedStyle: () => ({ visibility: box.visibility ?? 'visible' }),
      };
      return {
        ownerDocument: { defaultView: view },
        getBoundingClientRect: () => ({
          width: box.width, height: box.height, left: box.left ?? 0, top: box.top ?? 0,
        }),
      };
    }

    /** Run the real probe with `window.frameElement` set to `el`. */
    async function probeWith(el: unknown): Promise<{ hidden?: true }> {
      twoTabWindow();
      // Any request that probes the tree; its answer is irrelevant here — what
      // matters is that the fake captured the function it was asked to inject.
      await request('snapshot', { tabId: 11 });
      const probe = browserState.probeFunc;
      if (probe === undefined) throw new Error('the frame probe was never injected');
      const original = Object.getOwnPropertyDescriptor(window, 'frameElement');
      Object.defineProperty(window, 'frameElement', { configurable: true, value: el });
      try {
        return (probe as () => { hidden?: true })();
      } finally {
        if (original) Object.defineProperty(window, 'frameElement', original);
        else delete (window as unknown as Record<string, unknown>).frameElement;
      }
    }

    it('calls a VISIBILITY:HIDDEN frame hidden, box and position notwithstanding', async () => {
      const result = await probeWith(frameElement({ width: 800, height: 600, visibility: 'hidden' }));

      expect(result.hidden).toBe(true);
    });

    it('calls a zero-sized frame hidden', async () => {
      const result = await probeWith(frameElement({ width: 0, height: 0 }));

      expect(result.hidden).toBe(true);
    });

    it('calls a frame parked off the left edge hidden', async () => {
      const result = await probeWith(frameElement({ width: 800, height: 600, left: -9999 }));

      expect(result.hidden).toBe(true);
    });

    it('leaves an ordinary laid-out frame alone', async () => {
      const result = await probeWith(frameElement({ width: 800, height: 600 }));

      expect(result.hidden).toBeUndefined();
    });
  });

  it('still acts in a hidden region when the caller names it on purpose', async () => {
    twoTabWindow();
    browserState.frames[11] = [
      { frameId: 0, documentId: 'doc-main', url: 'https://a.example/' },
      { frameId: 4, documentId: 'doc-vendor', url: 'https://a.example/step2', hidden: true },
    ];

    const response = await request('fill', {
      tabId: 11, frameId: 'f4', locator: { css: '#name' }, value: '张三',
    });

    expect(response.success).toBe(true);
    expect(sentToContent.map((m) => [m.action, m.frameId])).toEqual([['fill', 4]]);
  });

  it('gives a snapshot the tab\'s frame list, which only the worker can know here', async () => {
    tabWithVendorFrame();
    browserState.contentAnswers['11:0:snapshot'] = { data: { url: 'https://a.example/', elements: [] } };

    const response = await request('snapshot', { tabId: 11 });

    expect((response.data as { frames?: unknown[] }).frames).toEqual([
      {
        frameId: 'f0', origin: 'https://a.example', url: 'https://a.example/',
        sameOriginAsTop: true, accessible: true,
      },
      {
        frameId: 'f4', origin: 'https://vendor.example', url: 'https://vendor.example/form',
        sameOriginAsTop: false, accessible: true,
      },
    ]);
  });

  it('leaves a frameless page\'s snapshot alone', async () => {
    twoTabWindow();
    browserState.contentAnswers['11:0:snapshot'] = { data: { url: 'https://a.example/', elements: [] } };

    const response = await request('snapshot', { tabId: 11 });

    expect(response.data).toEqual({ url: 'https://a.example/', elements: [] });
  });

  it('gives get_tabs the frame tree of the tab the GATE names, not of every tab', async () => {
    tabWithVendorFrame();
    browserState.frames[12] = [
      { frameId: 0, documentId: 'doc-b', url: 'https://b.example/' },
      { frameId: 2, documentId: 'doc-b2', url: 'https://ads.example/' },
    ];

    const response = await request('get_tabs', { framesForTabId: 11 });

    const windows = (response.data as { windows: { tabs: { tabId: number; frames?: unknown[] }[] }[] }).windows;
    const tabs = windows.flatMap((w) => w.tabs);
    expect(tabs.find((t) => t.tabId === 11)?.frames).toHaveLength(2);
    // Round-2 F6: NO other tab is probed, the caller's own active one
    // included. `batch` re-reads the tab before every step, so a frame list
    // computed for a tab nobody asked about was 25 browser round trips per
    // ordinary batch. `snapshot` is where the model reads regions.
    expect(tabs.find((t) => t.tabId === 12)?.frames).toBeUndefined();
  });

  it('costs no browser round trip when no caller asked for a frame tree', async () => {
    tabWithVendorFrame();
    browserState.injected.length = 0;

    const response = await request('get_tabs', {});

    const windows = (response.data as { windows: { tabs: { tabId: number; frames?: unknown[] }[] }[] }).windows;
    expect(windows.flatMap((w) => w.tabs).every((t) => t.frames === undefined)).toBe(true);
    expect(browserState.injected).toEqual([]);
  });
});

describe('find', () => {
  it('forwards the query and limit untouched', async () => {
    sentToContent.length = 0;

    await request('find', { tabId: 9, query: { role: 'button', name: '保存' }, limit: 5 });

    expect(sentToContent[0].payload).toEqual({
      tabId: 9,
      query: { role: 'button', name: '保存' },
      limit: 5,
      __abuFrameId: 'f0',
    });
  });

  it('refuses without a tab rather than guessing one', async () => {
    const response = await request('find', { query: { role: 'button' } });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/Missing tabId for browser action "find"/);
  });
});

describe('actions the service worker answers itself', () => {
  it('lists tabs grouped by window, with the focused one marked current', async () => {
    twoTabWindow();
    browserState.windows.push({ id: 2, type: 'popup', focused: false });
    browserState.tabs.push({ id: 21, windowId: 2, url: 'https://popup/', title: 'P', active: true });

    const response = await request('get_tabs', {});
    const data = response.data as {
      summary: { totalWindows: number; totalTabs: number; currentTabId: number; currentTabUrl: string };
      windows: { windowId: number; isCurrentWindow: boolean; tabs: { tabId: number; isCurrentTab: boolean }[] }[];
    };

    expect(response.success).toBe(true);
    // A popup window is not a place to drive automation, and its tab must not
    // show up as somewhere the model can act.
    expect(data.summary.totalWindows).toBe(1);
    expect(data.summary.totalTabs).toBe(2);
    expect(data.summary.currentTabId).toBe(12);
    expect(data.summary.currentTabUrl).toBe('https://b.example/');
    expect(data.windows[0].tabs.map((t) => t.tabId)).toEqual([11, 12]);
  });

  it('follows the tab the user switched to', async () => {
    twoTabWindow();
    fire('tabs.onActivated', { tabId: 11, windowId: 1 });

    const response = await request('get_tabs', {});

    expect((response.data as { summary: { currentTabId: number } }).summary.currentTabId).toBe(11);
    expect(browserState.sessionStore.lastActiveTabId).toBe(11);
  });

  it('does NOT send a tabId-less action to the tab the user last used', async () => {
    // The pre-claims behaviour — a request with no `tabId` followed whatever
    // tab the user had most recently looked at — was deliberately retired for
    // every action added after task-level claims existed
    // (`tabClaims.ts`'s frozen `LEGACY_LAST_ACTIVE_ACTIONS`). `find` is one of
    // those, so it refuses instead of guessing: an automation that drifts onto
    // the page the user just opened is the failure claims exist to stop.
    twoTabWindow();
    fire('tabs.onActivated', { tabId: 12, windowId: 1 });
    sentToContent.length = 0;

    const response = await request('find', { query: { role: 'button' } });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/Missing tabId for browser action "find"/);
    // The refusal cost the page nothing.
    expect(sentToContent).toHaveLength(0);
  });

  it('navigates, reloads, and walks history', async () => {
    twoTabWindow();

    expect((await request('navigate', { tabId: 11, url: 'https://ok.example/' })).success).toBe(true);
    expect(browserState.updated).toEqual([{ tabId: 11, props: { url: 'https://ok.example/' } }]);

    await request('navigate', { tabId: 11, action: 'reload' });
    expect(browserState.reloaded).toEqual([11]);

    await request('navigate', { tabId: 11, action: 'back' });
    expect(browserState.injected.at(-1)).toMatchObject({ tabId: 11, world: 'MAIN', args: ['back'] });
  });

  it('refuses a javascript: or file: URL instead of handing it to the tab', async () => {
    twoTabWindow();

    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x']) {
      const response = await request('navigate', { tabId: 11, url });
      expect(response.success).toBe(false);
      expect(response.error).toMatch(/Only http: and https:/);
    }
    expect(browserState.updated).toEqual([]);
  });

  it('runs execute_js in the page main world and returns its value', async () => {
    twoTabWindow();

    const response = await request('execute_js', { tabId: 11, code: '1 + 1' });

    expect(response.data).toBe('evaluated');
    expect(browserState.injected.at(-1)).toMatchObject({ tabId: 11, world: 'MAIN', args: ['1 + 1', 'https://a.example'] });
  });

  describe('JavaScript dialogs', () => {
    // What this channel can honestly do is narrower than the built-in
    // browser's, and the narrowness is the point of these tests: a native
    // dialog freezes the whole renderer, so nothing here can read or dismiss
    // one that is already up. `handle_dialog` therefore ARMS a one-shot answer
    // for the next dialog; `get_dialog` reports what that armed run saw.
    it('reads the page-world record without arming anything', async () => {
      twoTabWindow();
      browserState.pageDialogState = {
        installed: false,
        armed: null,
        last: {
          type: 'confirm', message: '确定要提交吗', url: 'https://b.example/',
          openedAt: 1, disposition: 'accepted',
        },
      };

      const response = await request('get_dialog', { tabId: 11 });

      expect(response.success).toBe(true);
      const data = response.data as { pending: boolean; last?: { type: string }; message: string };
      expect(data.pending).toBe(false);
      expect(data.last?.type).toBe('confirm');
      // The channel difference is stated, never left to be inferred.
      expect(data.message).toMatch(/cannot read or dismiss one that is already open/);
      expect(data.message).toMatch(/beforeunload is not supported here/);
      // Read-only: it injects a reader, and passes no arming arguments.
      expect(browserState.injected.at(-1)).toMatchObject({ tabId: 11, world: 'MAIN', args: [] });
    });

    it('arms a one-shot answer, and says that is what it did rather than "handled"', async () => {
      twoTabWindow();

      const response = await request('handle_dialog', {
        tabId: 11, action: 'accept', promptText: 'EQ-001',
      });

      expect(response.success).toBe(true);
      const data = response.data as { handled: boolean; armed?: true; action: string; message: string };
      expect(data.handled).toBe(false);
      expect(data.armed).toBe(true);
      expect(data.action).toBe('accept');
      expect(data.message).toMatch(/Armed/);
      expect(browserState.injected.at(-1)).toMatchObject({
        tabId: 11, world: 'MAIN', args: ['accept', 'EQ-001', 60_000],
      });
    });

    it('refuses an answer that is neither accept nor dismiss', async () => {
      twoTabWindow();

      const response = await request('handle_dialog', { tabId: 11, action: 'maybe' });

      expect(response.success).toBe(false);
      expect(response.error).toMatch(/needs action/);
      // And nothing was injected into the page on the way to refusing.
      expect(browserState.injected).toEqual([]);
    });

    it('says a frozen tab is probably holding a dialog, instead of timing out with no reason', async () => {
      twoTabWindow();
      browserState.pageIsFrozen = true;
      vi.useFakeTimers();
      try {
        const response = await request('get_dialog', { tabId: 11 }, { pumpMs: 6_000 });

        expect(response.success).toBe(false);
        expect(response.error).toMatch(/did not respond within 5s/);
        expect(response.error).toMatch(/native JavaScript dialog/);
        expect(response.error).toMatch(/ask the user to answer it/);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('activates a background tab before screenshotting it, so it shoots the right page', async () => {
    twoTabWindow();
    vi.useFakeTimers();
    let response: BridgeResponse;
    try {
      response = await request('screenshot', { tabId: 11 }, { pumpMs: 500 });
    } finally {
      vi.useRealTimers();
    }

    expect(response.data).toMatch(/^data:image\/png;base64,/);
    expect(browserState.updated).toEqual([{ tabId: 11, props: { active: true } }]);
    expect(browserState.captured).toEqual([1]);
  });

  /**
   * T6 — a download nobody armed for belongs to nobody.
   *
   * Before T6 `get_downloads` answered with the last 20 downloads Chrome had
   * seen, whoever started them: one task could read another's exports, and so
   * could a task read the user's own. Now a download is attributed only to a
   * run that registered interest before the click, so a bare `onCreated` with
   * no waiting run is invisible to everybody.
   */
  it('does not attribute a download nobody was waiting for', async () => {
    fire('downloads.onCreated', { id: 7, filename: '', url: 'https://x.example/report.xlsx', state: 'in_progress' });
    fire('downloads.onChanged', { id: 7, state: { current: 'complete' }, filename: { current: '/tmp/report.xlsx' } });

    const downloads = (await request('get_downloads', { ownerId: 'conv-a' })).data as unknown[];

    expect(downloads).toEqual([]);
  });

  /**
   * T6 — the `download` tool on this channel: arm, click, follow the file.
   *
   * The waiter is armed BEFORE the click for a reason a slower fake would
   * hide: a small file can finish before `sendToContentScript` returns, and a
   * waiter armed afterwards would miss the download its own click produced and
   * then report «这次点击没产生可识别的下载» for a file already on disk. The
   * hook below fires the browser events at exactly that instant.
   */
  it('presses the control and comes back with the file that click produced', async () => {
    twoTabWindow();
    browserState.onContentMessage = (action) => {
      if (action !== 'click') return;
      fire('downloads.onCreated', {
        id: 31, filename: '', url: 'https://a.example/排班表.xlsx',
        referrer: 'https://a.example/', state: 'in_progress',
      });
      fire('downloads.onChanged', {
        id: 31,
        filename: { current: '/Users/me/Downloads/Abu/conv-a/排班表.xlsx' },
        state: { current: 'complete' },
      });
    };

    const response = await request('download', {
      ownerId: 'conv-a', tabId: 11, action: 'click', locator: { css: 'a#export' }, timeoutMs: 5_000,
    });

    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({ started: true, complete: true });
    expect((response.data as { download: { filename: string; path: string } }).download)
      .toMatchObject({
        filename: '排班表.xlsx',
        path: '/Users/me/Downloads/Abu/conv-a/排班表.xlsx',
      });
    // A plain click, through the ordinary content-script path.
    expect(sentToContent.filter((m) => m.action === 'click')).toHaveLength(1);
  });

  it('files the download it asked for under this task, and leaves the user\'s own alone', async () => {
    twoTabWindow();
    const suggested: unknown[] = [];
    browserState.onContentMessage = (action) => {
      if (action !== 'click') return;
      // Chrome asks the extension where to put it, before or after onCreated.
      fire('downloads.onDeterminingFilename',
        { id: 32, filename: '排班表.xlsx', referrer: 'https://a.example/' },
        (s: unknown) => suggested.push(s));
      fire('downloads.onCreated', {
        id: 32, filename: '', url: 'https://a.example/a',
        referrer: 'https://a.example/', state: 'in_progress',
      });
      fire('downloads.onChanged', { id: 32, state: { current: 'complete' } });
    };

    await request('download', {
      ownerId: 'conv-a', tabId: 11, action: 'click', locator: { css: 'a#export' }, timeoutMs: 5_000,
    });
    // A download nobody armed for: the user's own, and untouched.
    const before = suggested.length;
    fire('downloads.onDeterminingFilename',
      { id: 33, filename: 'mine.pdf', referrer: 'https://bank.example/statements' },
      (s: unknown) => suggested.push(s));

    // One folder per OWNER — conversation plus subagent run, flattened into a
    // single writable segment (`safeSegment`), which is as deep as `suggest()`
    // lets an extension file anything.
    expect(suggested).toEqual([{ filename: 'Abu/conv-a_main/排班表.xlsx', conflictAction: 'uniquify' }]);
    expect(suggested).toHaveLength(before);
  });

  /**
   * Review F2. The export produced nothing, so the waiter stays armed for its
   * whole budget — and the user downloads their own file in that window.
   * Before the site check it was claimed: renamed into the task's folder and
   * reported to the model as what the click produced.
   */
  it('does not adopt the user\'s own download while its waiter is still armed', async () => {
    twoTabWindow();
    const suggested: unknown[] = [];
    vi.useFakeTimers();
    try {
      browserState.onContentMessage = (action) => {
        if (action !== 'click') return;
        // The click did nothing. The user, meanwhile, saves a bank statement.
        fire('downloads.onDeterminingFilename',
          { id: 41, filename: 'my-tax-return.pdf', referrer: 'https://bank.example/statements' },
          (s: unknown) => suggested.push(s));
        fire('downloads.onCreated', {
          id: 41,
          filename: '/Users/me/Downloads/my-tax-return.pdf',
          url: 'https://cdn.bank.example/2026.pdf',
          referrer: 'https://bank.example/statements',
          state: 'in_progress',
        });
        fire('downloads.onChanged', { id: 41, state: { current: 'complete' } });
      };

      const response = await request('download', {
        ownerId: 'conv-a', tabId: 11, action: 'click', locator: { css: 'a#export' }, timeoutMs: 50,
      }, { pumpMs: 200 });

      expect(response.data).toMatchObject({ started: false });
      // Not renamed, not moved, and not in the task's list either. (The
      // service worker is a module singleton, so earlier cases' downloads are
      // still in this owner's list — the claim is about THIS file.)
      expect(suggested).toEqual([]);
      const listed = (await request('get_downloads', { ownerId: 'conv-a' })).data as
        Array<{ filename: string }>;
      expect(listed.map((d) => d.filename)).not.toContain('my-tax-return.pdf');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the click produced no download rather than adopting another task\'s file', async () => {
    twoTabWindow();
    vi.useFakeTimers();
    try {
      const response = await request('download', {
        ownerId: 'conv-a', tabId: 11, action: 'click', locator: { css: 'a#export' }, timeoutMs: 50,
      }, { pumpMs: 200 });

      expect(response.success).toBe(true);
      expect(response.data).toMatchObject({ started: false });
      expect((response.data as { message: string }).message).toMatch(/no other file was adopted/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to wait on a download id that is not this task\'s', async () => {
    twoTabWindow();
    browserState.onContentMessage = (action) => {
      if (action !== 'click') return;
      fire('downloads.onCreated', {
        id: 34, filename: '/d/a.csv', url: 'https://a.example/a',
        referrer: 'https://a.example/', state: 'in_progress',
      });
      fire('downloads.onChanged', { id: 34, state: { current: 'complete' } });
    };
    const started = await request('download', {
      ownerId: 'conv-a', tabId: 11, action: 'click', locator: { css: 'a#export' }, timeoutMs: 5_000,
    });
    const downloadId = (started.data as { download: { downloadId: string } }).download.downloadId;

    // A DIFFERENT tab, so the tab-claim gate (which would refuse first, and
    // for its own reason) is out of the way and the download's own ownership
    // check is what answers.
    const other = await request('download', {
      ownerId: 'conv-b', tabId: 12, action: 'wait', downloadId,
    });

    expect(other.success).toBe(false);
    expect(other.error).toMatch(/belongs to this task/);
    // And the neighbour cannot see it in a listing either.
    expect((await request('get_downloads', { ownerId: 'conv-b' })).data).toEqual([]);
  });

  it('answers a missing tab with the browser error rather than a silent success', async () => {
    twoTabWindow();

    const response = await request('screenshot', { tabId: 999 });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/No tab with id/);
  });
});

/**
 * Full-page capture, and the offscreen document it composites in.
 *
 * This path shipped broken: `ensureOffscreen()` asked for
 * `chrome.offscreen.Reason.CANVAS`, and there is no CANVAS in that enum — the
 * expression is `undefined` at runtime, so Chrome rejected the call with
 * "Invalid type: expected offscreen.Reason, found undefined" and every
 * `screenshot_full_page` ended in an error. Confirmed in a real Chrome (149
 * and 152) against the built extension before the fix.
 *
 * The cost was paid before the failure, too: the reason is only read AFTER the
 * scroll-and-capture loop, so the page was dragged to the bottom and every
 * slice was captured before the request died.
 *
 * `screenshot_full_page` had no test of any kind, on either channel, which is
 * why a call that the browser could never accept survived review and shipped.
 */
describe('full-page screenshot', () => {
  /** Two slices of a 1000px page through a 500px viewport. */
  function tallPage(tabId: number): void {
    browserState.contentAnswers[`${tabId}:0:fullpage_prepare`] = {
      data: { scrollHeight: 1000, viewportHeight: 500, viewportWidth: 800, scrollX: 0, scrollY: 0 },
    };
  }

  it('composites the slices into one image instead of dying at the offscreen document', async () => {
    twoTabWindow();
    tallPage(12);

    vi.useFakeTimers();
    let response: BridgeResponse;
    try {
      // Each slice waits out Chrome's captureVisibleTab rate limit, on a fake
      // clock so a busy machine cannot fail the suite.
      response = await request('screenshot_full_page', { tabId: 12 }, { pumpMs: 4_000 });
    } finally {
      vi.useRealTimers();
    }

    expect(response.success).toBe(true);
    expect(response.data).toMatch(/^data:image\/png;base64,/);
    // One capture per slice, and all of them handed to the stitcher.
    expect(browserState.captured).toEqual([1, 1]);
    expect(browserState.stitchRequests).toHaveLength(1);
    expect(browserState.stitchRequests[0]).toMatchObject({
      type: 'stitch', viewportWidth: 800, viewportHeight: 500, totalHeight: 1000, lastSliceHeight: 500,
    });
    expect((browserState.stitchRequests[0].slices as string[])).toHaveLength(2);
  });

  it('asks for the offscreen document with a reason the browser actually defines', async () => {
    // The regression itself. `reasons` is what Chrome validates, and the
    // failure mode is silent at build time: the bad member typechecks as
    // `undefined` only because the extension sat outside the typecheck gate.
    expect(browserState.offscreenCreated).toHaveLength(1);
    const [created] = browserState.offscreenCreated;

    expect(created.url).toBe('offscreen.html');
    expect(created.justification).toBeTruthy();
    expect(created.reasons.length).toBeGreaterThan(0);
    for (const reason of created.reasons) {
      expect(CHROME_OFFSCREEN_REASONS).toContain(reason);
    }
  });

  it('the fake refuses an undefined reason, so the case above can fail', async () => {
    // Without this, "every reason is valid" would also pass against a fake
    // that never checked anything — including for the exact call that shipped.
    const offscreen = (globalThis as unknown as {
      chrome: { offscreen: { createDocument: (p: unknown) => Promise<void> } };
    }).chrome.offscreen;

    await expect(offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [(undefined as unknown as string)],
      justification: 'the call that shipped',
    })).rejects.toThrow(/Invalid type: expected offscreen\.Reason, found undefined/);
  });
});

/**
 * Only the `content.js` injections. A snapshot also runs the frame probe
 * (`executeScript` with a function, no files), and counting those as
 * "injections" would make this suite assert something it does not mean.
 */
function contentScriptInjections(): typeof browserState.injected {
  return browserState.injected.filter((row) => row.files !== undefined);
}

describe('content script injection', () => {
  it('injects into every frame once, then reuses it', async () => {
    twoTabWindow();
    // Self-contained: whether an EARLIER test in this file already drove tab 11
    // must not decide what this one observes.
    fire('tabs.onUpdated', 11, { status: 'loading' });
    browserState.injected.length = 0;

    await request('snapshot', { tabId: 11 });
    const first = contentScriptInjections().length;
    await request('snapshot', { tabId: 11 });

    expect(contentScriptInjections()[0]).toMatchObject({ tabId: 11, files: ['content.js'] });
    expect(contentScriptInjections().length).toBe(first);
  });

  it('re-injects after the tab starts loading a new document', async () => {
    twoTabWindow();
    await request('snapshot', { tabId: 11 });
    browserState.injected.length = 0;

    fire('tabs.onUpdated', 11, { status: 'loading' });
    await request('snapshot', { tabId: 11 });

    expect(contentScriptInjections()).toHaveLength(1);
  });
});

describe('popup status channel', () => {
  it('reports the live connection state to the popup', async () => {
    const sent: unknown[] = [];
    fire('runtime.onMessage', { type: 'get_status' }, {}, (r: unknown) => sent.push(r));

    expect(sent[0]).toMatchObject({ connected: true, reconnecting: false, port: 9876 });
  });

  it('records the tab a content script says is visible', async () => {
    twoTabWindow();
    fire('runtime.onMessage', { type: 'tab_visible' }, { tab: { id: 11, windowId: 1 } }, () => {});

    expect(browserState.sessionStore.lastActiveTabId).toBe(11);
  });
});
