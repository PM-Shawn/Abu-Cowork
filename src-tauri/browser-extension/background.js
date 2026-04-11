"use strict";
(() => {
  // src/background/index.ts
  var DISCOVERY_URL = "http://127.0.0.1:9875/status";
  var FIXED_WS_PORT = 9876;
  var RECONNECT_DELAYS = [1e3, 2e3, 4e3, 8e3, 15e3, 3e4];
  var CONTENT_SCRIPT_TIMEOUT = 3e4;
  var ws = null;
  var reconnectAttempt = 0;
  var reconnectTimer = null;
  var isConnecting = false;
  var MAX_RECENT_OPS = 20;
  var recentOps = [];
  function logOp(action2, success) {
    recentOps.unshift({ action: action2, success, time: Date.now() });
    if (recentOps.length > MAX_RECENT_OPS) recentOps.length = MAX_RECENT_OPS;
  }
  var lastActiveTabId = null;
  var lastActiveWindowId = null;
  chrome.storage.session.get(["lastActiveTabId", "lastActiveWindowId"], (result) => {
    if (result.lastActiveTabId) lastActiveTabId = result.lastActiveTabId;
    if (result.lastActiveWindowId) lastActiveWindowId = result.lastActiveWindowId;
    console.log(`[abu-ext] Restored tracking: tab=${lastActiveTabId}, window=${lastActiveWindowId}`);
    if (!lastActiveTabId || !lastActiveWindowId) {
      chrome.windows.getLastFocused({ populate: true }, (win) => {
        if (win && win.type === "normal" && win.id && win.tabs) {
          const activeTab = win.tabs.find((t) => t.active);
          if (activeTab?.id) {
            saveTracking(activeTab.id, win.id);
            console.log(`[abu-ext] Initialized tracking from getLastFocused: tab=${activeTab.id}, window=${win.id}`);
          }
        }
      });
    }
  });
  function saveTracking(tabId, windowId) {
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
  var state = {
    connected: false,
    lastConnected: null,
    reconnecting: false,
    port: null,
    error: null,
    discoveryOk: false
  };
  var bridgeAuthToken = null;
  async function discoverPort() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2e3);
      const res = await fetch(DISCOVERY_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data = await res.json();
      state.discoveryOk = true;
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
  async function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    if (isConnecting) return;
    isConnecting = true;
    state.error = null;
    try {
      const discoveredPort = await discoverPort();
      const port = discoveredPort ?? FIXED_WS_PORT;
      const success = await tryConnectPort(port);
      if (success) {
        isConnecting = false;
        return;
      }
      state.error = "Bridge not found. Is abu-browser-bridge running?";
      scheduleReconnect();
    } finally {
      isConnecting = false;
    }
  }
  function tryConnectPort(port) {
    return new Promise((resolve) => {
      const url = `ws://127.0.0.1:${port}`;
      let socket;
      try {
        const protocols = bridgeAuthToken ? [bridgeAuthToken] : void 0;
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
      }, 3e3);
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
  function setupSocketHandlers(socket) {
    socket.onmessage = async (event) => {
      try {
        const request2 = JSON.parse(event.data);
        const response = await handleRequest(request2);
        logOp(request2.action, response.success);
        socket.send(JSON.stringify(response));
      } catch (err) {
        console.error("[abu-ext] Error handling message:", err);
        try {
          const parsed = JSON.parse(event.data);
          const errorMsg = err instanceof Error ? err.message : String(err);
          logOp(parsed.action ?? "unknown", false);
          socket.send(JSON.stringify({ id: parsed.id, success: false, error: errorMsg }));
        } catch {
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
      console.error("[abu-ext] WebSocket error:", err);
    };
  }
  function scheduleReconnect() {
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
  var recentDownloads = [];
  chrome.downloads.onCreated.addListener((item) => {
    recentDownloads.unshift({
      id: item.id,
      filename: item.filename || item.url.split("/").pop() || "unknown",
      url: item.url,
      state: item.state,
      time: Date.now()
    });
    if (recentDownloads.length > 20) recentDownloads.length = 20;
  });
  chrome.downloads.onChanged.addListener((delta) => {
    const dl = recentDownloads.find((d) => d.id === delta.id);
    if (dl && delta.state) {
      dl.state = delta.state.current;
    }
    if (dl && delta.filename) {
      dl.filename = delta.filename.current;
    }
  });
  function isAllowedUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  async function handleRequest(request) {
    const { id, action, payload } = request;
    try {
      switch (action) {
        case "get_tabs": {
          const [allWindows, tabs, lastFocusedWindow] = await Promise.all([
            chrome.windows.getAll(),
            chrome.tabs.query({}),
            chrome.windows.getLastFocused({ populate: true })
          ]);
          const normalWindowIds = new Set(
            allWindows.filter((w) => w.type === "normal").map((w) => w.id)
          );
          let targetWindowId;
          let strategy = "none";
          const normalWindows = allWindows.filter((w) => w.type === "normal");
          console.log(`[abu-ext] get_tabs debug:`, {
            tracking: { lastActiveTabId, lastActiveWindowId },
            normalWindows: normalWindows.map((w) => ({ id: w.id, focused: w.focused })),
            lastFocusedWindow: { id: lastFocusedWindow.id, type: lastFocusedWindow.type, focused: lastFocusedWindow.focused },
            totalTabs: tabs.length
          });
          if (lastActiveWindowId && normalWindowIds.has(lastActiveWindowId)) {
            targetWindowId = lastActiveWindowId;
            strategy = "tracking";
          }
          if (!targetWindowId) {
            const focusedNormal = normalWindows.find((w) => w.focused);
            if (focusedNormal?.id) {
              targetWindowId = focusedNormal.id;
              strategy = "focused";
            }
          }
          if (!targetWindowId) {
            if (lastFocusedWindow.type === "normal" && lastFocusedWindow.id) {
              targetWindowId = lastFocusedWindow.id;
              strategy = "lastFocused";
              const activeInWindow = tabs.find((t) => t.active && t.windowId === targetWindowId);
              if (activeInWindow?.id) {
                saveTracking(activeInWindow.id, targetWindowId);
              }
            } else {
              targetWindowId = normalWindows[0]?.id;
              strategy = "fallback";
            }
          }
          console.log(`[abu-ext] get_tabs result: strategy=${strategy}, targetWindowId=${targetWindowId}`);
          let focusedTabId;
          if (lastActiveTabId) {
            const trackedTab = tabs.find((t) => t.id === lastActiveTabId);
            if (trackedTab) {
              focusedTabId = lastActiveTabId;
            }
          }
          if (!focusedTabId && targetWindowId) {
            const activeInTarget = tabs.find((t) => t.active && t.windowId === targetWindowId);
            focusedTabId = activeInTarget?.id ?? void 0;
          }
          const normalTabs = tabs.filter((t) => normalWindowIds.has(t.windowId));
          const windowGroups = {};
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
              tabs: wTabs.map((t) => ({
                tabId: t.id,
                url: t.url ?? "",
                title: t.title ?? "",
                active: t.active,
                isCurrentTab: t.id === focusedTabId
              }))
            };
          });
          windows.sort((a, b) => (b.isCurrentWindow ? 1 : 0) - (a.isCurrentWindow ? 1 : 0));
          const focusedTab = normalTabs.find((t) => t.id === focusedTabId);
          const data = {
            summary: {
              totalWindows: Object.keys(windowGroups).length,
              totalTabs: normalTabs.length,
              currentWindowId: targetWindowId,
              currentTabId: focusedTabId,
              currentTabUrl: focusedTab?.url ?? "",
              currentTabTitle: focusedTab?.title ?? "",
              detectionStrategy: strategy
            },
            windows
          };
          return { id, success: true, data };
        }
        case "get_downloads": {
          return { id, success: true, data: recentDownloads };
        }
        case "screenshot": {
          const tabId = payload.tabId;
          const tab = await chrome.tabs.get(tabId);
          if (!tab.active) {
            await chrome.tabs.update(tabId, { active: true });
            await new Promise((r) => setTimeout(r, 300));
          }
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          return { id, success: true, data: dataUrl };
        }
        case "screenshot_full_page": {
          const tabId = payload.tabId;
          const tab = await chrome.tabs.get(tabId);
          if (!tab.active) {
            await chrome.tabs.update(tabId, { active: true });
            await new Promise((r) => setTimeout(r, 300));
          }
          const result = await captureFullPage(tabId, tab.windowId);
          return { id, success: true, data: result };
        }
        case "navigate": {
          const tabId = payload.tabId;
          const navAction = payload.action ?? "goto";
          if (navAction === "goto" && payload.url) {
            const url = payload.url;
            if (!isAllowedUrl(url)) {
              return { id, success: false, error: `Invalid URL scheme. Only http: and https: URLs are allowed.` };
            }
            await chrome.tabs.update(tabId, { url });
          } else if (navAction === "reload") {
            await chrome.tabs.reload(tabId);
          } else if (navAction === "back" || navAction === "forward") {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (dir) => {
                if (dir === "back") {
                  history.back();
                } else {
                  history.forward();
                }
              },
              args: [navAction],
              world: "MAIN"
            });
          }
          return { id, success: true, data: `Navigation: ${navAction}` };
        }
        case "execute_js": {
          const execTabId = payload.tabId;
          const code = payload.code;
          const results = await chrome.scripting.executeScript({
            target: { tabId: execTabId },
            func: (jsCode) => {
              return eval(jsCode);
            },
            args: [code],
            world: "MAIN"
          });
          return { id, success: true, data: results[0]?.result };
        }
        case "snapshot":
        case "click":
        case "fill":
        case "select":
        case "wait_for":
        case "extract_text":
        case "extract_table":
        case "scroll":
        case "keyboard":
        case "start_recording":
        case "stop_recording": {
          const tabId = payload.tabId;
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
  var injectedTabs = /* @__PURE__ */ new Set();
  chrome.tabs.onRemoved.addListener((tabId) => injectedTabs.delete(tabId));
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") injectedTabs.delete(tabId);
  });
  async function ensureContentScript(tabId) {
    if (injectedTabs.has(tabId)) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["content.js"]
      });
      injectedTabs.add(tabId);
    } catch {
      injectedTabs.add(tabId);
    }
  }
  async function sendToContentScript(tabId, action2, payload2) {
    await ensureContentScript(tabId);
    const doSend = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Content script did not respond within ${CONTENT_SCRIPT_TIMEOUT / 1e3}s (action: ${action2})`));
      }, CONTENT_SCRIPT_TIMEOUT);
      chrome.tabs.sendMessage(tabId, { action: action2, payload: payload2 }, (response) => {
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
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("context invalidated") || msg.includes("Receiving end does not exist")) {
        console.log(`[abu-ext] Content script stale for tab ${tabId}, re-injecting...`);
        injectedTabs.delete(tabId);
        await ensureContentScript(tabId);
        return doSend();
      }
      throw err;
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "tab_visible" && sender.tab?.id && sender.tab?.windowId) {
      saveTracking(sender.tab.id, sender.tab.windowId);
      return;
    }
    if (message.type === "get_status") {
      sendResponse({
        connected: state.connected,
        lastConnected: state.lastConnected,
        reconnecting: state.reconnecting,
        port: state.port,
        error: state.error,
        discoveryOk: state.discoveryOk,
        authenticated: !!bridgeAuthToken && state.connected,
        recentOps
      });
      return true;
    }
    if (message.type === "reconnect") {
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
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
      if (!state.connected && !state.reconnecting && !isConnecting) {
        connect();
      }
    }
  });
  var offscreenCreated = false;
  async function ensureOffscreen() {
    if (offscreenCreated) return;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });
    if (contexts.length > 0) {
      offscreenCreated = true;
      return;
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.CANVAS],
      justification: "Stitching full-page screenshot slices on canvas"
    });
    offscreenCreated = true;
  }
  async function captureFullPage(tabId, windowId) {
    const dims = await sendToContentScript(tabId, "fullpage_prepare", {});
    const { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY } = dims;
    const sliceCount = Math.ceil(scrollHeight / viewportHeight);
    const slices = [];
    try {
      for (let i = 0; i < sliceCount; i++) {
        const scrollTop = i * viewportHeight;
        await sendToContentScript(tabId, "fullpage_scroll", { scrollTop });
        await new Promise((r) => setTimeout(r, 600));
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
        slices.push(dataUrl);
      }
    } finally {
      await sendToContentScript(tabId, "fullpage_restore", { scrollX, scrollY }).catch(() => {
      });
    }
    const lastSliceHeight = scrollHeight - (sliceCount - 1) * viewportHeight;
    await ensureOffscreen();
    const stitchResult = await chrome.runtime.sendMessage({
      type: "stitch",
      slices,
      viewportWidth,
      viewportHeight,
      totalHeight: scrollHeight,
      lastSliceHeight
    });
    if (!stitchResult.success) {
      throw new Error(`Stitch failed: ${stitchResult.error}`);
    }
    return stitchResult.data;
  }
  connect();
})();
//# sourceMappingURL=background.js.map
