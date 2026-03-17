/**
 * Service Worker — Background script for Abu Browser Extension.
 *
 * Responsibilities:
 * 1. Discover bridge WS port + auth token via HTTP discovery endpoint (port 9875)
 * 2. Maintain WebSocket connection to abu-browser-bridge
 * 3. Route commands from bridge to content scripts
 * 4. Handle tab-level operations (get_tabs, navigate, screenshot)
 */

import type { BridgeRequest, BridgeResponse } from '../shared/types.js';

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
      const request: BridgeRequest = JSON.parse(event.data as string);
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
    scheduleReconnect();
  };

  socket.onerror = (err) => {
    console.error('[abu-ext] WebSocket error:', err);
  };
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

// --- Request Handler ---

async function handleRequest(request: BridgeRequest): Promise<BridgeResponse> {
  const { id, action, payload } = request;

  try {
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

        let focusedTabId: number | undefined;
        if (lastActiveTabId) {
          const trackedTab = tabs.find(t => t.id === lastActiveTabId);
          if (trackedTab) {
            focusedTabId = lastActiveTabId;
          }
        }
        if (!focusedTabId && targetWindowId) {
          const activeInTarget = tabs.find(t => t.active && t.windowId === targetWindowId);
          focusedTabId = activeInTarget?.id ?? undefined;
        }

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
            tabs: wTabs.map(t => ({
              tabId: t.id,
              url: t.url ?? '',
              title: t.title ?? '',
              active: t.active,
              isCurrentTab: t.id === focusedTabId,
            })),
          };
        });

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
        const tabId = payload.tabId as number;
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
        const tabId = payload.tabId as number;
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active) {
          await chrome.tabs.update(tabId, { active: true });
          await new Promise(r => setTimeout(r, 300));
        }
        const result = await captureFullPage(tabId, tab.windowId);
        return { id, success: true, data: result };
      }

      case 'navigate': {
        const tabId = payload.tabId as number;
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

      case 'execute_js': {
        // Execute JS via chrome.scripting.executeScript to bypass CSP restrictions
        const execTabId = payload.tabId as number;
        const code = payload.code as string;
        const results = await chrome.scripting.executeScript({
          target: { tabId: execTabId },
          func: (jsCode: string) => {
            return eval(jsCode);
          },
          args: [code],
          world: 'MAIN',
        });
        return { id, success: true, data: results[0]?.result };
      }

      case 'snapshot':
      case 'click':
      case 'fill':
      case 'select':
      case 'wait_for':
      case 'extract_text':
      case 'extract_table':
      case 'scroll':
      case 'keyboard':
      case 'start_recording':
      case 'stop_recording': {
        const tabId = payload.tabId as number;
        const result = await sendToContentScript(tabId, action, payload);
        return { id, success: true, data: result };
      }

      default:
        return { id, success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id, success: false, error: message };
  }
}

// --- Content Script Communication ---

const injectedTabs = new Set<number>();

chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(tabId));
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

  const doSend = (): Promise<unknown> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Content script did not respond within ${CONTENT_SCRIPT_TIMEOUT / 1000}s (action: ${action})`));
    }, CONTENT_SCRIPT_TIMEOUT);

    chrome.tabs.sendMessage(tabId, { action, payload }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response?.data ?? response);
      }
    });
  });

  try {
    return await doSend();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    // Auto-retry once on "context invalidated" — re-inject content script
    if (msg.includes('context invalidated') || msg.includes('Receiving end does not exist')) {
      console.log(`[abu-ext] Content script stale for tab ${tabId}, re-injecting...`);
      injectedTabs.delete(tabId);
      await ensureContentScript(tabId);
      return doSend();
    }
    throw err;
  }
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
