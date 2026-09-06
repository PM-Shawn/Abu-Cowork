/**
 * Service Worker — Background script for Abu Browser Extension.
 *
 * Responsibilities:
 * 1. Discover bridge WS port + auth token via HTTP discovery endpoint (port 9875)
 * 2. Maintain WebSocket connection to abu-browser-bridge
 * 3. Route commands from bridge to content scripts
 * 4. Handle tab-level operations (get_tabs, navigate, screenshot)
 */

import type { BridgeRequest, BridgeResponse, FrameTree, JsDialogAction } from '../shared/types.js';
import { MAIN_FRAME_REF } from '../shared/types.js';
import { CONTENT_SCRIPT_ACTIONS } from './contentActions.js';
import {
  ambiguousFrameMessage,
  createFrameStore,
  hostFrameStamp,
  type FrameInjection,
} from './frames.js';
import {
  chromeGetDialogResult,
  chromeHandleDialogResult,
  JS_DIALOG_AUTO_DISMISS_MS,
  pageWorldArmDialogAnswer,
  pageWorldReadDialogState,
  runInPageWorld,
} from './pageDialogs.js';
import {
  TAB_TARGETED_ACTIONS,
  classifyInbound,
  createTabClaimStore,
  ownerFromPayload,
  resolveTargetTab,
  tabListingFor,
  type BridgeInbound,
  type TabResolutionDeps,
} from './tabClaims.js';

// Discovery endpoint (fixed port) and fallback WS ports
const DISCOVERY_URL = 'http://127.0.0.1:9875/status';
const FIXED_WS_PORT = 9876;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
const CONTENT_SCRIPT_TIMEOUT = 30_000; // 30s timeout for content script responses

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isConnecting = false;

// --- Recent operations log (for popup display) ---
const MAX_RECENT_OPS = 20;
const recentOps: { action: string; success: boolean; time: number }[] = [];

function logOp(action: string, success: boolean): void {
  recentOps.unshift({ action, success, time: Date.now() });
  if (recentOps.length > MAX_RECENT_OPS) recentOps.length = MAX_RECENT_OPS;
}

// --- Track the user's last active tab ---
let lastActiveTabId: number | null = null;
let lastActiveWindowId: number | null = null;

// Restore from session storage on SW startup, then backfill if empty
chrome.storage.session.get(['lastActiveTabId', 'lastActiveWindowId'], (result) => {
  if (result.lastActiveTabId) lastActiveTabId = result.lastActiveTabId;
  if (result.lastActiveWindowId) lastActiveWindowId = result.lastActiveWindowId;
  console.log(`[abu-ext] Restored tracking: tab=${lastActiveTabId}, window=${lastActiveWindowId}`);

  // If tracking is empty (extension just installed/reloaded), initialize from current state
  if (!lastActiveTabId || !lastActiveWindowId) {
    chrome.windows.getLastFocused({ populate: true }, (win) => {
      if (win && win.type === 'normal' && win.id && win.tabs) {
        const activeTab = win.tabs.find(t => t.active);
        if (activeTab?.id) {
          saveTracking(activeTab.id, win.id);
          console.log(`[abu-ext] Initialized tracking from getLastFocused: tab=${activeTab.id}, window=${win.id}`);
        }
      }
    });
  }
});

function saveTracking(tabId: number, windowId: number): void {
  lastActiveTabId = tabId;
  lastActiveWindowId = windowId;
  chrome.storage.session.set({ lastActiveTabId: tabId, lastActiveWindowId: windowId });
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  saveTracking(activeInfo.tabId, activeInfo.windowId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      if (tabs[0]?.id) {
        saveTracking(tabs[0].id, windowId);
      }
    });
  }
});

// --- Task-level tab claims ---
//
// `lastActiveTabId` above is the USER's tab, and until now it was also what a
// request without an explicit `tabId` acted on — so two tasks could drive the
// same signed-in page and a tabId-less `query_js` followed the user around.
// Requests carry `ownerId`/`runId`; `tabClaims` turns those into per-task tab
// ownership, mirroring `electron/browserHost.cjs` (see tabClaims.ts).
const tabClaims = createTabClaimStore();

const tabResolution: TabResolutionDeps = {
  tabExists: async (tabId) => {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  },
  // Read on the legacy (no `ownerId`) path only — an owned request never falls
  // back to the user's active tab.
  lastActiveTabId: () => lastActiveTabId,
  now: () => Date.now(),
  log: (message) => console.log(`[abu-ext] ${message}`),
};

// --- Connection State ---

interface ConnectionState {
  connected: boolean;
  lastConnected: number | null;
  reconnecting: boolean;
  port: number | null;
  error: string | null;
  discoveryOk: boolean;
}

const state: ConnectionState = {
  connected: false,
  lastConnected: null,
  reconnecting: false,
  port: null,
  error: null,
  discoveryOk: false,
};

// --- Port Discovery ---

interface DiscoveryResponse {
  wsPort: number;
  pid: number;
  extensionConnected: boolean;
  uptime: number;
  version: string;
  token?: string;
}

// Cached auth token from discovery
let bridgeAuthToken: string | null = null;

/**
 * Query the bridge's HTTP discovery endpoint to find the WS port and auth token.
 */
async function discoverPort(): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(DISCOVERY_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data: DiscoveryResponse = await res.json();
    state.discoveryOk = true;

    // Cache auth token for WS connection
    if (data.token) {
      bridgeAuthToken = data.token;
    }

    if (data.wsPort) {
      console.log(`[abu-ext] Discovery: bridge on port ${data.wsPort} (pid: ${data.pid}, uptime: ${data.uptime}s)`);
      return data.wsPort;
    }
    return null;
  } catch {
    state.discoveryOk = false;
    return null;
  }
}

// --- WebSocket Connection ---

async function connect(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (isConnecting) return;

  isConnecting = true;
  state.error = null;

  try {
    // Step 1: Try HTTP discovery to get the WS port + auth token
    const discoveredPort = await discoverPort();
    const port = discoveredPort ?? FIXED_WS_PORT;

    // Step 2: Connect to the single fixed port
    const success = await tryConnectPort(port);
    if (success) {
      isConnecting = false;
      return;
    }

    // Failed
    state.error = 'Bridge not found. Is abu-browser-bridge running?';
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

/**
 * Try connecting to a specific WS port. Returns true if connection opened.
 * Sends auth token via Sec-WebSocket-Protocol header.
 */
function tryConnectPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}`;

    let socket: WebSocket;
    try {
      // Pass auth token as subprotocol — bridge validates this on connection
      const protocols = bridgeAuthToken ? [bridgeAuthToken] : undefined;
      socket = new WebSocket(url, protocols);
    } catch {
      resolve(false);
      return;
    }

    let resolved = false;
    const connectTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.close();
        resolve(false);
      }
    }, 3000);

    socket.onopen = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(connectTimeout);
      console.log(`[abu-ext] Connected to bridge on port ${port}`);
      ws = socket;
      state.connected = true;
      state.lastConnected = Date.now();
      state.reconnecting = false;
      state.port = port;
      state.error = null;
      reconnectAttempt = 0;
      setupSocketHandlers(socket);
      resolve(true);
    };

    socket.onerror = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(connectTimeout);
      socket.close();
      resolve(false);
    };

    socket.onclose = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(connectTimeout);
      resolve(false);
    };
  });
}

function setupSocketHandlers(socket: WebSocket): void {
  socket.onmessage = async (event) => {
    try {
      const parsed: unknown = JSON.parse(event.data as string);
      const inbound = classifyInbound(parsed);
      if (inbound.kind !== 'request') {
        handleControlMessage(inbound);
        return;
      }
      const request = parsed as BridgeRequest;
      const response = await handleRequest(request);
      logOp(request.action, response.success);
      socket.send(JSON.stringify(response));
    } catch (err) {
      console.error('[abu-ext] Error handling message:', err);
      try {
        const parsed = JSON.parse(event.data as string);
        const errorMsg = err instanceof Error ? err.message : String(err);
        logOp(parsed.action ?? 'unknown', false);
        socket.send(JSON.stringify({ id: parsed.id, success: false, error: errorMsg }));
      } catch {
        // Can't even parse the request ID
      }
    }
  };

  socket.onclose = (event) => {
    console.log(`[abu-ext] Disconnected (code: ${event.code})`);
    state.connected = false;
    ws = null;
    // Claims only mean something for the bridge connection that minted their
    // owner ids: on close that bridge rejects every pending request of its own
    // (`wsServer.ts`'s `ws.on('close')`), so holding their tabs would only
    // refuse whoever reconnects next.
    tabClaims.releaseAll();
    scheduleReconnect();
  };

  socket.onerror = (err) => {
    console.error('[abu-ext] WebSocket error:', err);
  };
}

/**
 * Bridge → extension control messages. They carry a `type` instead of an
 * `action`, and there is no request id to answer.
 *
 * `release` drops the tab claims a finished run holds. `cancel` is now
 * recognised rather than parsed as a request and answered with
 * `Unknown action: undefined` — actually stopping in-flight content-script work
 * is a separate, already-scheduled item on the browser batch's remaining-work
 * list ("have the extension channel abort in-flight work on cancel") and is
 * deliberately not attempted here.
 */
function handleControlMessage(inbound: Exclude<BridgeInbound, { kind: 'request' }>): void {
  if (inbound.kind === 'release') {
    const dropped = tabClaims.releaseOwner(inbound.ownerId, inbound.runId);
    if (dropped > 0) {
      console.log(`[abu-ext] Released ${dropped} tab claim(s) for ${inbound.ownerId}`);
    }
    return;
  }
  if (inbound.kind === 'cancel') {
    console.log(`[abu-ext] Cancel received for ${inbound.requestId} (in-flight work is not stopped)`);
    return;
  }
  console.log(`[abu-ext] Ignoring unrecognized control message: ${inbound.type}`);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  state.reconnecting = true;
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  console.log(`[abu-ext] Reconnecting in ${delay}ms (attempt ${reconnectAttempt + 1})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt++;
    connect();
  }, delay);
}

// --- Download Tracking ---

const recentDownloads: { id: number; filename: string; url: string; state: string; time: number }[] = [];

chrome.downloads.onCreated.addListener((item) => {
  recentDownloads.unshift({
    id: item.id,
    filename: item.filename || item.url.split('/').pop() || 'unknown',
    url: item.url,
    state: item.state,
    time: Date.now(),
  });
  if (recentDownloads.length > 20) recentDownloads.length = 20;
});

chrome.downloads.onChanged.addListener((delta) => {
  const dl = recentDownloads.find(d => d.id === delta.id);
  if (dl && delta.state) {
    dl.state = delta.state.current;
  }
  if (dl && delta.filename) {
    dl.filename = delta.filename.current;
  }
});

// --- URL Validation ---

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// --- Execution-time origin pin (U5) ---

/**
 * Origin in the exact spelling the other two ends of the pin produce
 * (`normalizeBrowserOrigin` in browserToolPolicy.ts, `normalizedOriginOf` in
 * browserHost.cjs, `normalizedOrigin` in the content script): http(s) only,
 * default ports dropped by URL, trailing FQDN dot stripped. Null for anything
 * else, which the pin treats as a mismatch.
 */
export function normalizedOrigin(href: string | undefined): string | null {
  try {
    const parsed = new URL(String(href ?? ''));
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
 * The pin for actions that never reach the content script — `execute_js`,
 * which this worker runs through `chrome.scripting.executeScript`.
 *
 * Compares the tab's LIVE url (read here, not whatever the gate saw) against
 * the origin the approval was given for. Same rules and the same message as
 * the content script's `assertOriginPin` and the Electron host's: both run
 * modes compare, only the missing-value refusal is unattended-only.
 *
 * A tab whose url cannot be read at all is a mismatch, not a pass.
 */
export async function assertTabOriginPin(
  tabId: number,
  payload: Record<string, unknown>,
  getTab: (id: number) => Promise<{ url?: string }> = (id) => chrome.tabs.get(id),
): Promise<void> {
  const expected = typeof payload.expectedOrigin === 'string' ? payload.expectedOrigin : '';
  if (!expected) {
    if (payload.unattended !== true) return;
    throw new Error(
      'Refused: this unattended run sent no approved origin for the page, so the action could not be '
      + 'verified against what was authorized. Call get_tabs to re-read where you are, then request this action again.',
    );
  }
  // A tab whose url cannot be read at all falls through as null, which the
  // comparison below treats as a mismatch — never as a pass.
  let current: string | null;
  try {
    current = normalizedOrigin((await getTab(tabId))?.url);
  } catch {
    current = null;
  }
  if (current === expected) return;
  throw new Error(
    `Refused: this tab is no longer on the page this action was approved for (approved ${expected}, `
    + `now ${current ?? 'an unknown page'}). The page moved — a redirect, a script navigation, or a `
    + 'reload. Take a fresh snapshot to re-read the current state before acting again; the earlier '
    + 'approval does not carry over to a different site.',
  );
}

// --- Request Handler ---

async function handleRequest(request: BridgeRequest): Promise<BridgeResponse> {
  const { id, action, payload } = request;

  try {
    // Resolve (and, on first use, claim) the target BEFORE any handler runs, so
    // a refusal costs nothing: no tab activated, no content script injected, no
    // page driven. A refusal throws and is reported by the catch below.
    const tabId = TAB_TARGETED_ACTIONS.has(action)
      ? await resolveTargetTab(tabClaims, action, payload, tabResolution)
      : -1;

    switch (action) {
      case 'get_tabs': {
        const [allWindows, tabs, lastFocusedWindow] = await Promise.all([
          chrome.windows.getAll(),
          chrome.tabs.query({}),
          chrome.windows.getLastFocused({ populate: true }),
        ]);

        const normalWindowIds = new Set(
          allWindows.filter(w => w.type === 'normal').map(w => w.id)
        );

        let targetWindowId: number | undefined;
        let strategy = 'none';

        const normalWindows = allWindows.filter(w => w.type === 'normal');
        console.log(`[abu-ext] get_tabs debug:`, {
          tracking: { lastActiveTabId, lastActiveWindowId },
          normalWindows: normalWindows.map(w => ({ id: w.id, focused: w.focused })),
          lastFocusedWindow: { id: lastFocusedWindow.id, type: lastFocusedWindow.type, focused: lastFocusedWindow.focused },
          totalTabs: tabs.length,
        });

        // Strategy 1: event tracking (persisted across SW restarts)
        if (lastActiveWindowId && normalWindowIds.has(lastActiveWindowId)) {
          targetWindowId = lastActiveWindowId;
          strategy = 'tracking';
        }

        // Strategy 2: currently focused normal window
        if (!targetWindowId) {
          const focusedNormal = normalWindows.find(w => w.focused);
          if (focusedNormal?.id) {
            targetWindowId = focusedNormal.id;
            strategy = 'focused';
          }
        }

        // Strategy 3: getLastFocused
        if (!targetWindowId) {
          if (lastFocusedWindow.type === 'normal' && lastFocusedWindow.id) {
            targetWindowId = lastFocusedWindow.id;
            strategy = 'lastFocused';
            const activeInWindow = tabs.find(t => t.active && t.windowId === targetWindowId);
            if (activeInWindow?.id) {
              saveTracking(activeInWindow.id, targetWindowId);
            }
          } else {
            targetWindowId = normalWindows[0]?.id;
            strategy = 'fallback';
          }
        }

        console.log(`[abu-ext] get_tabs result: strategy=${strategy}, targetWindowId=${targetWindowId}`);

        // Which tab this listing may call "the current one" is owner-scoped:
        // an owned caller gets ITS OWN current tab (or none), never the page
        // the user happens to be looking at. `get_tabs` is where a model picks
        // its target, so leaving `lastActiveTabId` in that slot would hand the
        // user's active tab back through the listing — the very retarget
        // `resolveTargetTab` stopped doing. A caller that sent no `ownerId`
        // keeps the pre-claims answer, computed below exactly as before.
        const listing = tabListingFor(
          tabClaims,
          ownerFromPayload(payload),
          tabs.flatMap(t => (t.id === undefined ? [] : [t.id])),
          () => {
            let legacyFocused: number | undefined;
            if (lastActiveTabId) {
              const trackedTab = tabs.find(t => t.id === lastActiveTabId);
              if (trackedTab) {
                legacyFocused = lastActiveTabId;
              }
            }
            if (!legacyFocused && targetWindowId) {
              const activeInTarget = tabs.find(t => t.active && t.windowId === targetWindowId);
              legacyFocused = activeInTarget?.id ?? undefined;
            }
            return legacyFocused ?? null;
          },
        );
        const focusedTabId: number | undefined = listing.currentTabId ?? undefined;

        // Only include tabs from normal windows
        const normalTabs = tabs.filter(t => normalWindowIds.has(t.windowId));

        // Group tabs by window
        const windowGroups: Record<number, typeof normalTabs> = {};
        for (const t of normalTabs) {
          if (!windowGroups[t.windowId]) windowGroups[t.windowId] = [];
          windowGroups[t.windowId].push(t);
        }

        const windows = Object.entries(windowGroups).map(([wid, wTabs]) => {
          const windowId = Number(wid);
          const isCurrent = windowId === targetWindowId;
          return {
            windowId,
            isCurrentWindow: isCurrent,
            // `active` stays Chrome's own truth (which tab the user is looking
            // at in that window); `isCurrentTab` is the owner-scoped one. The
            // ownership marks tell a task which tabs are already being driven,
            // so it does not pick one that would only be refused — and are
            // simply absent for the tabs nobody holds, and for legacy callers.
            tabs: wTabs.map(t => {
              const held = t.id === undefined ? undefined : listing.ownership.get(t.id);
              return {
                tabId: t.id,
                url: t.url ?? '',
                title: t.title ?? '',
                active: t.active,
                isCurrentTab: t.id === focusedTabId,
                ...(held === 'you' ? { ownedByYou: true } : {}),
                ...(held === 'other' ? { ownedByOther: true } : {}),
              };
            }),
          };
        });

        // A frame tree costs one browser round trip, so it is computed only
        // for the tab a caller asked about by name — the APPROVAL GATE, which
        // needs it because a frame-targeted action is authorized against the
        // FRAME's origin, and `batch`'s own between-step re-read when a step
        // targets a region.
        //
        // It used to be computed for the caller's current tab as well, on
        // EVERY listing. `batch` re-reads the tab before every step, so an
        // ordinary 25-step batch that mentions no region paid 25
        // `executeScript` round trips for a frame list nobody asked for
        // (round-2 F6). The model still gets the regions from `snapshot`,
        // which `annotateWithFrames` decorates — that is where it reads the
        // page anyway. Unlike the built-in host there is no free precheck to
        // fall back on here: `webNavigation` is not among this extension's
        // permissions, and adding it would force every user to re-authorize.
        const framesWanted = new Set<number>();
        const askedFor = Number(payload.framesForTabId);
        if (Number.isFinite(askedFor)) framesWanted.add(askedFor);
        const framesByTab = new Map<number, FrameTree>();
        for (const wantedTabId of framesWanted) {
          if (!normalTabs.some((t) => t.id === wantedTabId)) continue;
          const tree = await frameStore.tree(wantedTabId).catch(() => [] as FrameTree);
          if (tree.length > 1) framesByTab.set(wantedTabId, tree);
        }
        for (const win of windows) {
          for (const tab of win.tabs) {
            const tree = tab.tabId === undefined ? undefined : framesByTab.get(tab.tabId);
            if (tree) (tab as { frames?: FrameTree }).frames = tree;
          }
        }

        // Sort: current window first
        windows.sort((a, b) => (b.isCurrentWindow ? 1 : 0) - (a.isCurrentWindow ? 1 : 0));

        const focusedTab = normalTabs.find(t => t.id === focusedTabId);
        const data = {
          summary: {
            totalWindows: Object.keys(windowGroups).length,
            totalTabs: normalTabs.length,
            currentWindowId: targetWindowId,
            currentTabId: focusedTabId,
            currentTabUrl: focusedTab?.url ?? '',
            currentTabTitle: focusedTab?.title ?? '',
            detectionStrategy: strategy,
          },
          windows,
        };
        return { id, success: true, data };
      }

      case 'get_downloads': {
        return { id, success: true, data: recentDownloads };
      }

      case 'screenshot': {
        const tab = await chrome.tabs.get(tabId);
        // Activate the target tab first to ensure we capture the right one
        if (!tab.active) {
          await chrome.tabs.update(tabId, { active: true });
          // Brief wait for tab switch to render
          await new Promise(r => setTimeout(r, 300));
        }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        return { id, success: true, data: dataUrl };
      }

      case 'screenshot_full_page': {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active) {
          await chrome.tabs.update(tabId, { active: true });
          await new Promise(r => setTimeout(r, 300));
        }
        const result = await captureFullPage(tabId, tab.windowId);
        return { id, success: true, data: result };
      }

      case 'navigate': {
        const navAction = (payload.action as string) ?? 'goto';
        if (navAction === 'goto' && payload.url) {
          const url = payload.url as string;
          // Validate URL scheme to prevent javascript:/file:/ etc.
          if (!isAllowedUrl(url)) {
            return { id, success: false, error: `Invalid URL scheme. Only http: and https: URLs are allowed.` };
          }
          await chrome.tabs.update(tabId, { url });
        } else if (navAction === 'reload') {
          await chrome.tabs.reload(tabId);
        } else if (navAction === 'back' || navAction === 'forward') {
          // Execute history navigation in page main world
          await chrome.scripting.executeScript({
            target: { tabId },
            func: (dir: string) => { if (dir === 'back') { history.back(); } else { history.forward(); } },
            args: [navAction],
            world: 'MAIN',
          });
        }
        return { id, success: true, data: `Navigation: ${navAction}` };
      }

      // Both dialog cases consume the OWNER-RESOLVED `tabId` from the top of
      // this function (they are in `TAB_TARGETED_ACTIONS`), never
      // `payload.tabId`: reading the payload raw here would let one task read
      // and answer dialogs on a tab another task has claimed — the exact
      // isolation `resolveTargetTab` exists to enforce.
      case 'get_dialog': {
        const state = await runInPageWorld(tabId, pageWorldReadDialogState, []);
        return { id, success: true, data: chromeGetDialogResult(tabId, state) };
      }

      case 'handle_dialog': {
        const dialogAction = payload.action as JsDialogAction;
        if (dialogAction !== 'accept' && dialogAction !== 'dismiss') {
          return { id, success: false, error: "handle_dialog needs action: 'accept' or 'dismiss'." };
        }
        const promptText = typeof payload.promptText === 'string' ? payload.promptText : null;
        const state = await runInPageWorld(
          tabId,
          pageWorldArmDialogAnswer,
          [dialogAction, promptText, JS_DIALOG_AUTO_DISMISS_MS],
        );
        return { id, success: true, data: chromeHandleDialogResult(tabId, dialogAction, state) };
      }

      case 'execute_js': {
        // Execute JS via chrome.scripting.executeScript to bypass CSP restrictions
        const code = payload.code as string;
        // The one state-changing action on this channel that never reaches the
        // content script, so the content script's own pin cannot cover it —
        // and the strongest capability of the set (arbitrary code with the
        // page's full authority). Pinned here against the tab's live URL.
        //
        // The tab pinned is the OWNER-RESOLVED one — the same `tabId` the
        // script is about to run in. It used to be a local `execTabId` read
        // straight from the payload; the tab-claims change (632d40cc) removed
        // that local and rewrote the `executeScript` target, but left this
        // call referring to the now-undefined name, so every `execute_js` on
        // this channel died with a ReferenceError before the pin ever ran.
        // Nothing caught it: this channel had no test for `execute_js` until
        // this branch added one.
        await assertTabOriginPin(tabId, payload);
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (jsCode: string) => {
            return eval(jsCode);
          },
          args: [code],
          world: 'MAIN',
        });
        return { id, success: true, data: results[0]?.result };
      }

      default: {
        // Every action executed by the content script, read from the shared
        // list rather than re-typed as `case` labels — an action missing from
        // it falls through to `Unknown action`, which reads to the model as
        // "the tool is broken" rather than "this channel forgot to route it".
        //
        // `tabId` is the OWNER-RESOLVED one from the top of this function, not
        // `payload.tabId`: every action in this list is in
        // `TAB_TARGETED_ACTIONS`, so it has already passed the claim gate (and
        // the tabId-less `get_html` case has already been given the owner's
        // current tab). Reading the payload again here would be a second,
        // ungated path to the same tab.
        if (!CONTENT_SCRIPT_ACTIONS.has(action)) {
          return { id, success: false, error: `Unknown action: ${action}` };
        }
        const result = await sendToContentScript(tabId, action, payload);
        return { id, success: true, data: result };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id, success: false, error: message };
  }
}

// --- Frame addressing ---

/**
 * Read from INSIDE one frame, in the extension's isolated world. `location` is
 * unforgeable and the world is out of the page's reach, so what comes back is
 * the frame's real current address — not the `src` the embedding page wrote.
 *
 * `hidden` answers "can the user see this region at all". It is measured on
 * the frame ELEMENT in the EMBEDDING document, which a frame can reach through
 * `window.frameElement` when its parent is same-origin — and same-origin is
 * exactly the direction that needs it, since a cross-site region is already
 * held by its own site grant and its own origin pin. When the parent is out of
 * reach the frame falls back to its own viewport, which is 0 for a `display:
 * none` or 0×0 region; anything it cannot decide is reported as visible, never
 * guessed.
 *
 * Serialized and injected by `chrome.scripting.executeScript`, so it has to be
 * entirely self-contained — no imports, no closure over this module. The rule
 * it applies is the same one `frameElementIsHidden` applies in the content
 * runtime. The two copies cannot be shared (a serialized function loses every
 * reference to its module), so each half is pinned by its own test:
 * `content/index.test.ts` for the built-in walk, `background/index.test.ts`
 * and `background/frames.test.ts` for this one.
 */
function probeFrameIdentity(): { url: string; origin: string; title: string; hidden?: true } {
  let hidden = false;
  try {
    const el = window.frameElement;
    if (el) {
      const view = el.ownerDocument.defaultView;
      const rect = el.getBoundingClientRect();
      if (!view) {
        hidden = true;
      } else if (rect.width < 2 || rect.height < 2) {
        hidden = true;
      } else if (view.getComputedStyle(el).visibility === 'hidden') {
        hidden = true;
      } else {
        const docLeft = rect.left + (view.scrollX || 0);
        const docTop = rect.top + (view.scrollY || 0);
        hidden = docLeft + rect.width <= 0 || docTop + rect.height <= 0;
      }
    } else if (window !== window.top) {
      hidden = window.innerWidth < 2 || window.innerHeight < 2;
    }
  } catch {
    // A cross-origin parent throws on `frameElement`. Not knowing is not the
    // same as hidden: the region stays routable and its own site grant and
    // origin pin decide whether anything may happen in it.
    hidden = false;
  }
  return {
    url: location.href,
    origin: location.origin,
    title: document.title,
    ...(hidden ? { hidden: true as const } : {}),
  };
}

const frameStore = createFrameStore({
  probeFrames: async (tabId) => (await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: probeFrameIdentity,
  })) as unknown as FrameInjection[],
  normalizeOrigin: normalizedOrigin,
});

/** Locator actions that may be resolved to the frame actually holding the target. */
const LOCATOR_ROUTED_ACTIONS = new Set(['click', 'fill', 'select']);

/** A frame list appended to a failed search, so "not found" is not the last word. */
async function framesHint(tabId: number): Promise<string> {
  try {
    const tree = await frameStore.tree(tabId);
    const others = tree.filter((f) => f.frameId !== MAIN_FRAME_REF);
    if (others.length === 0) return '';
    // `hidden` is said out loud: a region a locator will never be resolved
    // into automatically is one the caller has to name on purpose, and a bare
    // list would leave "why did it not find it there" unanswerable.
    const listed = others.slice(0, 5).map(
      (f) => `${f.frameId} (${f.origin ?? f.url ?? 'unknown'}${f.hidden ? ', hidden' : ''})`,
    );
    return (
      ` This page also has ${others.length} embedded region${others.length === 1 ? '' : 's'}: `
      + `${listed.join(', ')}${others.length > 5 ? ', …' : ''}. `
      + 'A search only covers one document — pass `frameId` to look inside one of these.'
    );
  } catch {
    return '';
  }
}

// --- Content Script Communication ---

const injectedTabs = new Set<number>();

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  frameStore.forget(tabId);
  // A closed tab belongs to nobody. Without this the claim outlives the page and
  // refuses the next task Chrome hands the same id to.
  tabClaims.releaseTab(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') injectedTabs.delete(tabId);
});

async function ensureContentScript(tabId: number): Promise<void> {
  if (injectedTabs.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
    injectedTabs.add(tabId);
  } catch {
    // Content script may already be injected — still usable
    injectedTabs.add(tabId);
  }
}

async function sendToContentScript(
  tabId: number,
  action: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  await ensureContentScript(tabId);

  // Which frame this action is for. A caller that named one gets exactly that
  // frame (and a refusal if it is gone or has been replaced since it last saw
  // the tree); a caller that named none gets the MAIN frame, deliberately —
  // the old no-frameId broadcast delivered to every frame and kept whichever
  // answered first, so "which element did that click land on" was decided by
  // scheduling.
  const namedFrame = payload.frameId !== undefined;
  const chromeFrameId = namedFrame ? await frameStore.resolve(tabId, payload.frameId) : 0;

  const doSend = (frameId: number, actionName = action, body = payload): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Content script did not respond within ${CONTENT_SCRIPT_TIMEOUT / 1000}s (action: ${actionName})`));
      }, CONTENT_SCRIPT_TIMEOUT);

      chrome.tabs.sendMessage(
        tabId,
        // `__abuFrameId` tells that copy of the runtime which frame it is, so
        // the refs it mints carry the handle a later call can route on. It is
        // stamped HERE, in the worker: the model's payload cannot name it (the
        // bridge builds payloads field by field from the tool schema) and a
        // page cannot see it (isolated world).
        { action: actionName, payload: { ...body, __abuFrameId: hostFrameStamp(frameId) } },
        { frameId },
        (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response?.data ?? response);
          }
        },
      );
    });

  const send = async (frameId: number): Promise<unknown> => {
    try {
      return await doSend(frameId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // Auto-retry once on "context invalidated" — re-inject content script
      if (msg.includes('context invalidated') || msg.includes('Receiving end does not exist')) {
        console.log(`[abu-ext] Content script stale for tab ${tabId}, re-injecting...`);
        injectedTabs.delete(tabId);
        await ensureContentScript(tabId);
        return doSend(frameId);
      }
      throw err;
    }
  };

  try {
    const result = await send(chromeFrameId);
    return namedFrame ? result : await annotateWithFrames(tabId, action, result);
  } catch (err) {
    if (namedFrame || !isNotFound(err)) throw err;
    return resolveAcrossFrames(tabId, action, payload, doSend, err);
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Element not found');
}

/**
 * A locator that named no frame and was not in the main document.
 *
 * Asking every frame "how many does this match" and acting only on a UNIQUE
 * answer is the frame-level form of the rule the locator layer already
 * follows inside one document: never resolve an ambiguous target by position.
 * It also restores — deterministically — what the old broadcast did by
 * accident, which is what keeps a form inside a same-origin iframe working.
 *
 * The origin pin is unaffected and does the security half: the gate approved
 * one origin, so a locator that resolves into a DIFFERENT site's region is
 * refused there by the frame's own pin, with the "ask for this site to be
 * authorized separately" wording.
 */
async function resolveAcrossFrames(
  tabId: number,
  action: string,
  payload: Record<string, unknown>,
  doSend: (frameId: number, actionName?: string, body?: Record<string, unknown>) => Promise<unknown>,
  notFound: unknown,
): Promise<unknown> {
  if (!LOCATOR_ROUTED_ACTIONS.has(action) || payload.locator === undefined) {
    throw await withFramesHint(tabId, notFound);
  }
  let others: number[];
  try {
    // Visible regions only. A page that plants a same-named control in a 0×0
    // or off-screen iframe would otherwise get a UNIQUE match there and steer
    // the click into a document the user cannot see, reported as a success.
    // Naming the frameId explicitly still reaches a hidden region.
    others = await frameStore.otherFrameIds(tabId);
  } catch {
    throw notFound;
  }
  // No VISIBLE region to ask. The hint still goes out — with hidden regions
  // excluded from resolution this is now the ordinary way a page with nothing
  // but hidden frames lands here, and "Element not found" alone would leave
  // the caller with no way to learn the regions exist at all.
  if (others.length === 0) throw await withFramesHint(tabId, notFound);

  const probes = await Promise.all(others.map(async (frameId) => {
    try {
      const counted = await doSend(frameId, 'locate', { locator: payload.locator }) as { matched?: number };
      return { frameId, matched: Number(counted?.matched ?? 0) };
    } catch {
      return { frameId, matched: 0 };
    }
  }));
  const hits = probes.filter((p) => p.matched === 1).map((p) => p.frameId);
  const ambiguous = probes.filter((p) => p.matched > 1).map((p) => p.frameId);

  if (hits.length === 1 && ambiguous.length === 0) return doSend(hits[0]);
  if (hits.length + ambiguous.length > 1 || ambiguous.length === 1) {
    throw new Error(ambiguousFrameMessage(await frameStore.tree(tabId), [...hits, ...ambiguous]));
  }
  throw await withFramesHint(tabId, notFound);
}

async function withFramesHint(tabId: number, err: unknown): Promise<unknown> {
  if (!(err instanceof Error)) return err;
  const hint = await framesHint(tabId);
  return hint ? new Error(err.message + hint) : err;
}

/**
 * Give a main-frame read the frame list it cannot compute for itself.
 *
 * The content runtime only walks child documents in the BUILT-IN browser (one
 * isolated world, main frame only). Here every frame has its own copy and the
 * authoritative list lives in Chrome, so the worker is the only place that can
 * answer "what regions does this page have".
 */
async function annotateWithFrames(tabId: number, action: string, result: unknown): Promise<unknown> {
  if (action !== 'snapshot' && action !== 'find') return result;
  if (typeof result !== 'object' || result === null) return result;
  const record = result as Record<string, unknown> & { frames?: FrameTree; total?: number; message?: string };
  if (action === 'snapshot') {
    const tree = await frameStore.tree(tabId).catch(() => [] as FrameTree);
    return tree.length > 1 ? { ...record, frames: tree } : record;
  }
  if (record.total !== 0) return record;
  const hint = await framesHint(tabId);
  return hint ? { ...record, message: `${record.message ?? ''}${hint}` } : record;
}

// --- Popup Communication ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'tab_visible' && sender.tab?.id && sender.tab?.windowId) {
    saveTracking(sender.tab.id, sender.tab.windowId);
    return;
  }

  if (message.type === 'get_status') {
    sendResponse({
      connected: state.connected,
      lastConnected: state.lastConnected,
      reconnecting: state.reconnecting,
      port: state.port,
      error: state.error,
      discoveryOk: state.discoveryOk,
      authenticated: !!bridgeAuthToken && state.connected,
      recentOps,
    });
    return true;
  }
  if (message.type === 'reconnect') {
    reconnectAttempt = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    state.reconnecting = false;
    connect();
    sendResponse({ ok: true });
    return true;
  }
});

// --- Keep Service Worker alive ---

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (!state.connected && !state.reconnecting && !isConnecting) {
      connect();
    }
  }
});

// --- Full-Page Screenshot ---

let offscreenCreated = false;

async function ensureOffscreen(): Promise<void> {
  if (offscreenCreated) return;
  // Check if already exists (e.g. after SW restart)
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) {
    offscreenCreated = true;
    return;
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.CANVAS],
    justification: 'Stitching full-page screenshot slices on canvas',
  });
  offscreenCreated = true;
}

/**
 * Capture a full-page screenshot by scrolling and stitching viewport slices.
 *
 * Flow:
 * 1. Content script reports page dimensions & hides fixed/sticky elements
 * 2. Background orchestrates scroll → captureVisibleTab loop
 * 3. Offscreen document stitches slices on canvas
 * 4. Content script restores fixed/sticky elements
 */
async function captureFullPage(tabId: number, windowId: number): Promise<string> {
  // Step 1: Get page dimensions and prepare (hide fixed elements)
  const dims = await sendToContentScript(tabId, 'fullpage_prepare', {}) as {
    scrollHeight: number;
    viewportHeight: number;
    viewportWidth: number;
    scrollX: number;
    scrollY: number;
  };

  const { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY } = dims;
  const sliceCount = Math.ceil(scrollHeight / viewportHeight);

  // Step 2: Capture each viewport slice
  const slices: string[] = [];
  try {
    for (let i = 0; i < sliceCount; i++) {
      const scrollTop = i * viewportHeight;
      // Scroll to position via content script (instant, no smooth)
      await sendToContentScript(tabId, 'fullpage_scroll', { scrollTop });
      // Wait for rendering + respect Chrome's captureVisibleTab rate limit (max 2/sec)
      await new Promise(r => setTimeout(r, 600));
      // Capture the visible viewport
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      slices.push(dataUrl);
    }
  } finally {
    // Step 4: Restore original state (fixed elements + scroll position)
    await sendToContentScript(tabId, 'fullpage_restore', { scrollX, scrollY }).catch(() => {
      // Best-effort restore
    });
  }

  // Calculate actual height of last slice
  const lastSliceHeight = scrollHeight - (sliceCount - 1) * viewportHeight;

  // Step 3: Stitch slices in offscreen document
  await ensureOffscreen();
  const stitchResult = await chrome.runtime.sendMessage({
    type: 'stitch',
    slices,
    viewportWidth,
    viewportHeight,
    totalHeight: scrollHeight,
    lastSliceHeight,
  }) as { success: boolean; data?: string; error?: string };

  if (!stitchResult.success) {
    throw new Error(`Stitch failed: ${stitchResult.error}`);
  }

  return stitchResult.data!;
}

// --- Initialize ---
connect();
