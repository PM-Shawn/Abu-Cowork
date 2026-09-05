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

interface SentMessage { tabId: number; action: string; payload: Record<string, unknown> }

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
} = {
  windows: [], tabs: [], updated: [], reloaded: [], injected: [], captured: [], sessionStore: {},
};

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
        cb: (response: { data?: unknown; error?: string }) => void,
      ) => {
        sentToContent.push({ tabId, action: message.action, payload: message.payload });
        cb({ data: { routed: message.action } });
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
    downloads: { onCreated: slot('downloads.onCreated'), onChanged: slot('downloads.onChanged') },
    runtime: { onMessage: slot('runtime.onMessage'), lastError: undefined },
    alarms: { create: () => {}, onAlarm: slot('alarms.onAlarm') },
    scripting: {
      executeScript: async (opts: { target: { tabId: number }; files?: string[]; world?: string; args?: unknown[] }) => {
        browserState.injected.push({
          tabId: opts.target.tabId, files: opts.files, world: opts.world, args: opts.args,
        });
        return [{ result: 'evaluated' }];
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
  // The handler is async; give it the microtasks it needs to reply.
  for (let i = 0; i < 20 && socket.sent.length === 0; i += 1) await Promise.resolve();
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
  browserState.updated.length = 0;
  browserState.reloaded.length = 0;
  browserState.injected.length = 0;
  browserState.captured.length = 0;
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
      { tabId: 42, action, payload: { tabId: 42, marker: action } },
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

describe('find', () => {
  it('forwards the query and limit untouched', async () => {
    sentToContent.length = 0;

    await request('find', { tabId: 9, query: { role: 'button', name: '保存' }, limit: 5 });

    expect(sentToContent[0].payload).toEqual({
      tabId: 9,
      query: { role: 'button', name: '保存' },
      limit: 5,
    });
  });

  it('refuses without a tab rather than guessing one, when nothing is tracked', async () => {
    // `lastActiveTabId` is null in this fixture (no real browsing happened), so
    // a tabId-less request has nothing legitimate to fall back to.
    const response = await request('find', { query: { role: 'button' } });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/No active browser tab/);
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

  it('sends a tabId-less action to the tab the user last used', async () => {
    twoTabWindow();
    fire('tabs.onActivated', { tabId: 12, windowId: 1 });

    await request('find', { query: { role: 'button' } });

    expect(sentToContent[0].tabId).toBe(12);
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
    expect(browserState.injected.at(-1)).toMatchObject({ tabId: 11, world: 'MAIN', args: ['1 + 1'] });
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

  it('reports a download and the state it ended in', async () => {
    fire('downloads.onCreated', { id: 7, filename: '', url: 'https://x.example/report.xlsx', state: 'in_progress' });
    fire('downloads.onChanged', { id: 7, state: { current: 'complete' }, filename: { current: '/tmp/report.xlsx' } });

    const downloads = (await request('get_downloads', {})).data as
      { id: number; filename: string; state: string }[];

    expect(downloads[0]).toMatchObject({ id: 7, filename: '/tmp/report.xlsx', state: 'complete' });
  });

  it('answers a missing tab with the browser error rather than a silent success', async () => {
    twoTabWindow();

    const response = await request('screenshot', { tabId: 999 });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/No tab with id/);
  });
});

describe('content script injection', () => {
  it('injects into every frame once, then reuses it', async () => {
    twoTabWindow();

    await request('snapshot', { tabId: 11 });
    const first = browserState.injected.length;
    await request('snapshot', { tabId: 11 });

    expect(browserState.injected[0]).toMatchObject({ tabId: 11, files: ['content.js'] });
    expect(browserState.injected.length).toBe(first);
  });

  it('re-injects after the tab starts loading a new document', async () => {
    twoTabWindow();
    await request('snapshot', { tabId: 11 });
    browserState.injected.length = 0;

    fire('tabs.onUpdated', 11, { status: 'loading' });
    await request('snapshot', { tabId: 11 });

    expect(browserState.injected).toHaveLength(1);
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
