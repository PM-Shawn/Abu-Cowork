/**
 * I2 — the origin pin for the ONE state-changing action on the extension
 * channel that never reaches the content script.
 *
 * `execute_js` runs through `chrome.scripting.executeScript` in this worker,
 * so the content script's own `assertOriginPin` cannot see it — and it is the
 * strongest capability of the set (arbitrary code with the page's full
 * authority in the user's real logged-in Chrome). It is pinned here against
 * the tab's LIVE url instead.
 *
 * The module registers `chrome.*` listeners at load, so the stub below has to
 * exist before the import. `assertTabOriginPin` itself takes an injectable
 * `getTab`, which is what keeps the unit cases free of chrome plumbing.
 *
 * The last suite is the other half of the same guarantee, and the half that was
 * missing: that the WORKER actually calls the pin, on the tab it is about to
 * script. The unit cases above all passed while `execute_js` was calling
 * `assertTabOriginPin(execTabId, …)` — a name 632d40cc had deleted — so every
 * call on this channel died with a ReferenceError before the pin ever ran, and
 * nothing was red. Those cases go through the real wire, which is why the stub
 * carries a socket and the tab/scripting surface the request path uses.
 */
import { runInNewContext } from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const APPROVED = 'https://shop.example.com';

type AssertTabOriginPin = (
  tabId: number,
  payload: Record<string, unknown>,
  getTab?: (id: number) => Promise<{ url?: string }>,
) => Promise<void>;

let assertTabOriginPin: AssertTabOriginPin;
let normalizedOrigin: (href: string | undefined) => string | null;

// --- The browser the fake `chrome` reports, and what the worker did to it ---

interface FakeTab { id: number; windowId: number; url: string; title: string; active: boolean }

/** Tabs the fake Chrome knows about. Tests reshape this per case. */
let tabs: FakeTab[] = [];
/** Every `chrome.scripting.executeScript` the worker performed. */
const injected: { tabId: number; world?: string; args?: unknown[]; documentIds?: string[] }[] = [];
let currentDocumentId = 'document-a';
let beforeProbe: (() => void) | null = null;
let beforeMain: (() => void) | null = null;
let probeAnswer: unknown[] | null = null;
let probeFailure = false;
let retargetCachedDocument = false;
let poisonMainPromiseResolution = false;
const scriptEffects: string[] = [];
const executedOrigins: string[] = [];
/** Every `chrome.tabs.captureVisibleTab` — the pixels that left the browser. */
const captured: number[] = [];
/** Every `chrome.tabs.sendMessage` — the full-page capture's first move. */
const messaged: { tabId: number; action: unknown }[] = [];
/** The socket(s) the service worker opened at load. */
const sockets: FakeSocket[] = [];

/**
 * The bridge connection, faked. `handleRequest` is module-private on purpose,
 * so a frame on this socket is the only honest way to reach `execute_js` —
 * the same path `wsServer.ts` drives in production.
 */
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

/** One window, two tabs: the target is NOT the one the user is looking at. */
function twoTabWindow(): void {
  tabs = [
    { id: 11, windowId: 1, url: `${APPROVED}/cart`, title: 'cart', active: false },
    { id: 12, windowId: 1, url: 'https://b.example/', title: 'B', active: true },
  ];
}

/** Enough of the extension APIs to drive the real request path. */
function fakeChrome(): Record<string, unknown> {
  const noopListener = { addListener: () => {} };
  return {
    storage: {
      session: {
        get: (_keys: unknown, cb: (r: Record<string, number>) => void) => cb({}),
        set: () => {},
      },
    },
    tabs: {
      onActivated: noopListener,
      onRemoved: noopListener,
      onUpdated: noopListener,
      query: async (q: { active?: boolean; windowId?: number }) => tabs.filter(
        (t) => (q.active === undefined || t.active === q.active)
          && (q.windowId === undefined || t.windowId === q.windowId),
      ),
      get: async (tabId: number) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}`);
        return tab;
      },
      update: async () => undefined,
      captureVisibleTab: async (windowId: number) => {
        captured.push(windowId);
        return 'data:image/png;base64,PIXELS';
      },
      sendMessage: async (tabId: number, msg: { action?: unknown }) => {
        messaged.push({ tabId, action: msg?.action });
        // `screenshot_full_page` asks the page for its dimensions first. No
        // case here is expected to get this far, so the shape only has to be
        // enough that an accidental pass is loud rather than a crash.
        return { success: true, data: { scrollHeight: 100, viewportHeight: 100, viewportWidth: 100, scrollX: 0, scrollY: 0 } };
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: noopListener,
      getAll: async () => [{ id: 1, type: 'normal', focused: true }],
      getLastFocused: (_opts: unknown, cb?: (w: unknown) => void) => {
        const win = { id: 1, type: 'normal', focused: true, tabs };
        if (cb) { cb(win); return undefined; }
        return Promise.resolve(win);
      },
    },
    downloads: { onCreated: noopListener, onChanged: noopListener },
    runtime: { onMessage: noopListener, lastError: undefined },
    alarms: { create: () => {}, onAlarm: noopListener },
    scripting: {
      executeScript: async (opts: {
        target: { tabId: number; documentIds?: string[]; frameIds?: number[] };
        world?: string; args?: unknown[]; func: (...args: never[]) => unknown;
      }) => {
        injected.push({
          tabId: opts.target.tabId, world: opts.world, args: opts.args,
          ...(opts.target.documentIds ? { documentIds: opts.target.documentIds } : {}),
        });
        const tab = tabs.find((t) => t.id === opts.target.tabId)!;
        if (opts.world === 'ISOLATED') {
          expect(opts.target.frameIds).toEqual([0]);
          beforeProbe?.();
          if (probeFailure) throw new Error('Cannot access document');
          if (probeAnswer !== null) return probeAnswer;
          // Run the serialized function without its module closure, just as
          // Chrome does. Only this read-only world supplies the document URL.
          const result = runInNewContext(`(${opts.func.toString()})()`, {
            location: { href: tab.url },
          });
          return [{ frameId: 0, documentId: currentDocumentId, result }];
        }
        beforeMain?.();
        if (!retargetCachedDocument && opts.target.documentIds && !opts.target.documentIds.includes(currentDocumentId)) {
          throw new Error('No document with id: document-a');
        }
        const poison = poisonMainPromiseResolution
          ? "Object.prototype.then = function(resolve) { resolve({ __proto__: null, originMatched: true, value: 'spoofed' }); };"
          : '';
        const result = await Promise.resolve(runInNewContext(`${poison}(${opts.func.toString()})(...args)`, {
          args: opts.args, location: { href: tab.url, origin: new URL(tab.url).origin },
          recordEffect: () => scriptEffects.push(tab.url),
        })).catch(() => null);
        if (result?.originMatched === true) executedOrigins.push(new URL(tab.url).origin);
        return [{ frameId: 0, documentId: currentDocumentId, result }];
      },
    },
  };
}

/** Feed one bridge frame through the socket and read the reply the worker sends. */
async function request(
  action: string,
  payload: Record<string, unknown>,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const socket = sockets[0];
  socket.onmessage?.({ data: JSON.stringify({ id: `req-${action}`, action, payload }) });
  // The handler is async; give it the microtasks it needs to reply. Nothing on
  // the `execute_js` path sleeps, so no timer has to be advanced here.
  for (let i = 0; i < 50 && socket.sent.length === 0; i += 1) await Promise.resolve();
  const raw = socket.sent.shift();
  if (raw === undefined) throw new Error(`no response for action "${action}"`);
  return JSON.parse(raw) as { success: boolean; data?: unknown; error?: string };
}

beforeAll(async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.chrome = fakeChrome();
  globals.WebSocket = FakeSocket;
  // Discovery is expected to fail here; the module then falls back to the fixed
  // port, which is all these cases need.
  globals.fetch = vi.fn(async () => { throw new Error('no discovery endpoint in tests'); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const mod = await import('./index');
  assertTabOriginPin = mod.assertTabOriginPin;
  normalizedOrigin = mod.normalizedOrigin;

  // The worker connects at load. Wait for the socket AND for its handlers, or
  // a frame would be posted into a socket nobody is listening on.
  for (let i = 0; i < 200 && !sockets[0]?.onmessage; i += 1) await Promise.resolve();
  if (!sockets[0]?.onmessage) throw new Error('background script never opened a socket');
});

beforeEach(() => {
  injected.length = 0;
  currentDocumentId = 'document-a';
  beforeProbe = null;
  beforeMain = null;
  probeAnswer = null;
  probeFailure = false;
  retargetCachedDocument = false;
  poisonMainPromiseResolution = false;
  scriptEffects.length = 0;
  executedOrigins.length = 0;
  captured.length = 0;
  messaged.length = 0;
  twoTabWindow();
});

/**
 * The target tab is the one the user is already looking at.
 *
 * Both screenshot cases activate a background tab and then wait 300ms for it
 * to paint. That real timer is not what these cases are about — the pin is
 * taken after it either way — so they start from a tab that needs no
 * activation and the request completes within microtasks.
 */
function activeTargetWindow(): void {
  tabs = [
    { id: 11, windowId: 1, url: `${APPROVED}/cart`, title: 'cart', active: true },
    { id: 12, windowId: 1, url: 'https://b.example/', title: 'B', active: false },
  ];
}

/** A tab that reports `url`; `null` models a tab whose url cannot be read. */
const tabAt = (url: string | null) => async () =>
  url === null ? Promise.reject(new Error('no such tab')) : { url };

describe('assertTabOriginPin (execute_js on the extension channel)', () => {
  it('passes when the tab is still on the approved origin', async () => {
    await expect(
      assertTabOriginPin(1, { unattended: true, expectedOrigin: APPROVED }, tabAt(`${APPROVED}/cart`)),
    ).resolves.toBeUndefined();
  });

  it('refuses after the tab drifted cross-origin, naming both ends', async () => {
    await expect(
      assertTabOriginPin(
        1,
        { unattended: true, expectedOrigin: APPROVED },
        tabAt('https://evil.example.com/'),
      ),
    ).rejects.toThrow(/no longer on the page this action was approved for.*https:\/\/evil\.example\.com/s);
  });

  it('treats a same-origin path change as no drift', async () => {
    await expect(
      assertTabOriginPin(
        1,
        { unattended: true, expectedOrigin: APPROVED },
        tabAt(`${APPROVED}/cart/step-2?x=1`),
      ),
    ).resolves.toBeUndefined();
  });

  it('fail-closed: an unattended call with no approved origin is refused', async () => {
    await expect(
      assertTabOriginPin(1, { unattended: true }, tabAt(`${APPROVED}/cart`)),
    ).rejects.toThrow(/sent no approved origin/);
  });

  it('an ATTENDED call is compared too (I3)', async () => {
    await expect(
      assertTabOriginPin(1, { expectedOrigin: APPROVED }, tabAt('https://evil.example.com/')),
    ).rejects.toThrow(/no longer on the page/);
  });

  it('an attended call carrying NO pin keeps its exact pre-U5 path', async () => {
    await expect(
      assertTabOriginPin(1, {}, tabAt('https://evil.example.com/')),
    ).resolves.toBeUndefined();
  });

  it('a tab whose url cannot be read is a mismatch, not a pass', async () => {
    await expect(
      assertTabOriginPin(1, { unattended: true, expectedOrigin: APPROVED }, tabAt(null)),
    ).rejects.toThrow(/an unknown page/);
  });
});

describe('normalizedOrigin agrees with the other ends of the pin', () => {
  it('strips a trailing FQDN dot, so one spelling cannot dodge the other', () => {
    expect(normalizedOrigin('https://shop.example.com./cart')).toBe(APPROVED);
  });

  it('drops a default port and keeps a non-default one', () => {
    expect(normalizedOrigin('https://shop.example.com:443/x')).toBe(APPROVED);
    expect(normalizedOrigin('https://shop.example.com:8443/x')).toBe('https://shop.example.com:8443');
  });

  it('returns null for non-http(s) and unparseable input', () => {
    expect(normalizedOrigin('about:blank')).toBeNull();
    expect(normalizedOrigin('not a url')).toBeNull();
    expect(normalizedOrigin(undefined)).toBeNull();
  });
});

/**
 * Three ends now speak the refusal: the Electron host, the extension's content
 * script, and this worker. A model that has to learn two dialects of the same
 * refusal will treat one of them as a novel error and retry into it, so the
 * sentences are pinned identical here rather than left to convention.
 */
describe('the refusal reads the same on every channel', () => {
  const SENTENCES = [
    'no longer on the page this action was approved for (approved ',
    'Take a fresh snapshot to re-read the current state before acting again; the earlier ',
    'sent no approved origin for the page, so the action could not be ',
  ];
  const SOURCES: Array<[string, URL]> = [
    ['electron/browserHost.cjs', new URL('../../../electron/browserHost.cjs', import.meta.url)],
    ['content/index.ts', new URL('../content/index.ts', import.meta.url)],
    ['background/index.ts', new URL('./index.ts', import.meta.url)],
  ];

  for (const [label, url] of SOURCES) {
    for (const sentence of SENTENCES) {
      it(`${label} carries: ${sentence.slice(0, 34)}…`, async () => {
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        expect(readFileSync(fileURLToPath(url), 'utf8')).toContain(sentence);
      });
    }
  }
});

/**
 * The pin is only worth anything if the worker actually calls it, on the tab
 * the script is about to run in. That link was broken and silent: `execute_js`
 * referred to `execTabId`, a local the tab-claims change (632d40cc) had
 * deleted, so every call threw a ReferenceError — before the pin, and before
 * the script. Fail-closed, but broken: the tool answered "execTabId is not
 * defined" to every request on this channel.
 *
 * Two things nothing caught it: this channel had no `execute_js` test at all,
 * and `abu-chrome-extension/` is outside the typecheck gate (its own
 * `tsconfig.json` is not in the root project references, and `build.js` is
 * esbuild, which strips types without checking them), so `tsc -b` never saw
 * the dangling name. #367 is closing that gate; until it lands, these cases
 * are what stands between this file and the same class of bug.
 */
describe('execute_js: the worker pins the tab it is about to script', () => {
  const OWNER = { ownerId: 'conv-1', runId: 'run-1' };

  it('runs the script in the target tab while that tab is still on the approved origin', async () => {
    const response = await request('execute_js', {
      ...OWNER, tabId: 11, code: '1 + 1', expectedOrigin: APPROVED, unattended: true,
    });

    // Before the fix this was `{ success: false, error: 'execTabId is not defined' }`.
    expect(response).toMatchObject({ success: true, data: 2 });
    expect(injected).toEqual([
      { tabId: 11, world: 'ISOLATED', args: undefined },
      { tabId: 11, world: 'MAIN', documentIds: ['document-a'], args: ['1 + 1', APPROVED] },
    ]);
  });

  it('refuses, and injects nothing, once the target tab has drifted cross-origin', async () => {
    tabs.find((t) => t.id === 11)!.url = 'https://evil.example.com/';

    const response = await request('execute_js', {
      ...OWNER, tabId: 11, code: 'document.cookie', expectedOrigin: APPROVED, unattended: true,
    });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/no longer on the page this action was approved for/);
    // The refusal cost the page nothing — no code ran with its authority.
    expect(injected).toEqual([]);
  });

  it('pins the TARGET tab, not the one the user happens to be looking at', async () => {
    // Tab 12 is the user's active tab and IS on the approved origin; tab 11,
    // the one the script would run in, is not. A pin that read the active tab
    // would wave this through.
    const response = await request('execute_js', {
      ...OWNER, tabId: 11, code: 'document.cookie',
      expectedOrigin: 'https://b.example', unattended: true,
    });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/no longer on the page this action was approved for/);
    expect(injected).toEqual([]);
  });

  it('fail-closed: an unattended call carrying no approved origin never reaches the page', async () => {
    const response = await request('execute_js', {
      ...OWNER, tabId: 11, code: '1 + 1', unattended: true,
    });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/sent no approved origin/);
    expect(injected).toEqual([]);
  });

  it('an attended call carrying no pin still binds execution to the observed document', async () => {
    const response = await request('execute_js', { ...OWNER, tabId: 11, code: '1 + 1' });

    expect(response).toMatchObject({ success: true, data: 2 });
    expect(injected).toEqual([
      { tabId: 11, world: 'ISOLATED', args: undefined },
      { tabId: 11, world: 'MAIN', documentIds: ['document-a'], args: ['1 + 1', APPROVED] },
    ]);
  });
});


describe('execute_js document identity across asynchronous navigation (#351)', () => {
  const payload = {
    ownerId: 'conv-1', runId: 'run-1', tabId: 11, code: '1 + 1', expectedOrigin: APPROVED,
  };

  it.each([false, true])('rejects cross-origin drift before the probe (unattended=%s)', async (unattended) => {
    beforeProbe = () => {
      tabs[0].url = 'https://evil.example/stolen';
      currentDocumentId = 'document-b';
    };
    const response = await request('execute_js', { ...payload, unattended });
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/no longer on the page this action was approved for/);
    expect(injected.map((i) => i.world)).toEqual(['ISOLATED']);
    expect(executedOrigins).toEqual([]);
  });

  it.each(['https://evil.example/stolen', `${APPROVED}/replacement`])(
    'never retargets code after the pinned document is replaced by %s', async (url) => {
      beforeMain = () => { tabs[0].url = url; currentDocumentId = 'document-b'; };
      const response = await request('execute_js', payload);
      expect(response.success).toBe(false);
      expect(response.error).toMatch(/No document with id/);
      expect(injected.filter((i) => i.world === 'MAIN')).toEqual([
        { tabId: 11, world: 'MAIN', documentIds: ['document-a'], args: ['1 + 1', APPROVED] },
      ]);
      expect(executedOrigins).toEqual([]);
    },
  );

  it.each([false, true])('rejects cross-origin retargeting of a cached document before eval (unattended=%s)', async (unattended) => {
    // Real Chromium 149 with BFCache enabled can resolve an old documentId
    // through its frame tree node to the new active document.
    retargetCachedDocument = true;
    beforeMain = () => { tabs[0].url = 'https://evil.example/stolen'; currentDocumentId = 'document-b'; };
    const response = await request('execute_js', { ...payload, unattended, code: 'recordEffect();1 + 1' });
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/page origin changed before script execution/);
    expect(scriptEffects).toEqual([]);
    expect(executedOrigins).toEqual([]);
    expect(injected.filter((i) => i.world === 'MAIN')).toHaveLength(1);
  });

  it('does not let a hostile MAIN Promise resolution turn a refusal into success', async () => {
    retargetCachedDocument = true;
    poisonMainPromiseResolution = true;
    beforeMain = () => { tabs[0].url = 'https://evil.example/stolen'; currentDocumentId = 'document-b'; };
    expect(await request('execute_js', { ...payload, code: 'recordEffect();1 + 1' }))
      .toMatchObject({ success: false, error: expect.stringMatching(/page origin changed/) });
    expect(scriptEffects).toEqual([]);
  });

  it('uses the observed raw FQDN origin after the policy canonicalizes its trailing dot', async () => {
    tabs[0].url = 'https://shop.example.com./cart';
    expect(await request('execute_js', payload)).toMatchObject({ success: true, data: 2 });
  });

  it.each(['null', 'Promise.resolve(null)', 'Promise.resolve(42)'])(
    'preserves valid script results for %s', async (code) => {
      expect(await request('execute_js', { ...payload, code }))
        .toMatchObject({ success: true, data: code.includes('42') ? 42 : null });
    },
  );

  it('does not report success when Chrome returns null after an injected error', async () => {
    expect(await request('execute_js', { ...payload, code: "throw new Error('bad script')" }))
      .toMatchObject({ success: false, error: expect.stringMatching(/did not return a result/) });
  });

  it('allows a same-document path change without changing the document target', async () => {
    beforeMain = () => { tabs[0].url = `${APPROVED}/cart#details`; };
    expect(await request('execute_js', payload)).toMatchObject({ success: true, data: 2 });
    expect(executedOrigins).toEqual([APPROVED]);
  });

  it.each([
    [],
    [{ frameId: 0, result: { url: `${APPROVED}/cart` } }],
    [{ frameId: 0, documentId: '', result: { url: `${APPROVED}/cart` } }],
    [{ frameId: 1, documentId: 'iframe', result: { url: `${APPROVED}/cart` } }],
    [{ frameId: 0, documentId: 'document-a', result: { url: 'about:blank' } }],
    [{ frameId: 0, documentId: 'document-a', result: {} }],
  ])('fails closed on an unusable Chrome identity: %j', async (...rows) => {
    probeAnswer = rows;
    const response = await request('execute_js', payload);
    expect(response.success).toBe(false);
    expect(response.error).toMatch(/document identity/);
    expect(executedOrigins).toEqual([]);
    expect(injected.map((i) => i.world)).toEqual(['ISOLATED']);
  });

  it('does not fall back to tab-only execution if the probe fails', async () => {
    probeFailure = true;
    expect(await request('execute_js', payload)).toMatchObject({ success: false, error: 'Cannot access document' });
    expect(injected.map((i) => i.world)).toEqual(['ISOLATED']);
    expect(executedOrigins).toEqual([]);
  });
});


/**
 * R3-A — the screenshots are reads too, and they are the widest ones.
 *
 * Round 2 brought the TEXT reads under the execution-time pin on both
 * channels. Pixels were left out, and not by decision: a screenshot on this
 * channel never reaches the content script (where the read pin lives) — the
 * worker takes it itself with `chrome.tabs.captureVisibleTab`. So the
 * highest-bandwidth read of the whole set was the one still unchecked, on the
 * channel that drives the user's real logged-in Chrome, while the content
 * script's comment claimed its list mirrored the host's.
 *
 * The screenshots are READS, so they follow the read rule, not `execute_js`'s:
 * a pin they carry is compared in both run modes, and a call carrying NO pin
 * keeps its previous path in both run modes (whether an unattended run may
 * look at a page with no resolved origin is the gate's question).
 */
describe('screenshot: the worker pins the tab before it captures pixels', () => {
  const OWNER = { ownerId: 'conv-1', runId: 'run-1' };

  beforeEach(() => { activeTargetWindow(); });

  it('captures while the tab is still on the approved origin', async () => {
    const response = await request('screenshot', {
      ...OWNER, tabId: 11, expectedOrigin: APPROVED, unattended: true,
    });

    expect(response).toMatchObject({ success: true, data: 'data:image/png;base64,PIXELS' });
    expect(captured).toEqual([1]);
  });

  it('refuses, and captures nothing, once the tab has drifted cross-origin', async () => {
    tabs.find((t) => t.id === 11)!.url = 'https://evil.example.com/';

    const response = await request('screenshot', {
      ...OWNER, tabId: 11, expectedOrigin: APPROVED, unattended: true,
    });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/no longer on the page this action was approved for/);
    // The whole point: no screen of the new site reached the transcript.
    expect(captured).toEqual([]);
  });

  it('compares an ATTENDED pin too (I3)', async () => {
    tabs.find((t) => t.id === 11)!.url = 'https://evil.example.com/';

    const response = await request('screenshot', { ...OWNER, tabId: 11, expectedOrigin: APPROVED });

    expect(response.success).toBe(false);
    expect(captured).toEqual([]);
  });

  it('a call carrying NO pin keeps its previous path — in BOTH run modes', async () => {
    // Reads split from state changes here: `execute_js` with no pin is refused
    // when unattended, a read is not. Absence of a pin is the gate's business.
    const unattendedNoPin = await request('screenshot', { ...OWNER, tabId: 11, unattended: true });
    expect(unattendedNoPin).toMatchObject({ success: true });

    const attendedNoPin = await request('screenshot', { ...OWNER, tabId: 11 });
    expect(attendedNoPin).toMatchObject({ success: true });
    expect(captured).toEqual([1, 1]);
  });

  it('screenshot_full_page is pinned before its first scroll', async () => {
    tabs.find((t) => t.id === 11)!.url = 'https://evil.example.com/';

    const response = await request('screenshot_full_page', {
      ...OWNER, tabId: 11, expectedOrigin: APPROVED, unattended: true,
    });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/no longer on the page this action was approved for/);
    expect(captured).toEqual([]);
    // It never even asked the page for its dimensions: the refusal costs the
    // drifted site nothing, and leaves its scroll position alone.
    expect(messaged).toEqual([]);
  });
});
