"use strict";
(() => {
  // src/background/tabClaims.ts
  var LEGACY_CONVERSATION = "legacy";
  var MAIN_RUN_KEY = "main";
  var OWNER_KEY_SEPARATOR = String.fromCharCode(0);
  var LEGACY_OWNER = Object.freeze({
    conversationId: LEGACY_CONVERSATION,
    runKey: MAIN_RUN_KEY,
    key: `${LEGACY_CONVERSATION}${OWNER_KEY_SEPARATOR}${MAIN_RUN_KEY}`
  });
  function sanitizeOwnerPart(value) {
    return typeof value === "string" ? value.split(OWNER_KEY_SEPARATOR).join("").trim() : "";
  }
  function makeOwner(conversationId, runKey) {
    const conversation = sanitizeOwnerPart(conversationId);
    if (!conversation || conversation === LEGACY_CONVERSATION) return LEGACY_OWNER;
    const run = sanitizeOwnerPart(runKey) || MAIN_RUN_KEY;
    return Object.freeze({
      conversationId: conversation,
      runKey: run,
      key: `${conversation}${OWNER_KEY_SEPARATOR}${run}`
    });
  }
  function isLegacyOwner(owner) {
    return owner.conversationId === LEGACY_CONVERSATION;
  }
  function ownerFromPayload(payload2) {
    return makeOwner(payload2.ownerId, payload2.runId);
  }
  function createTabClaimStore() {
    const claims = /* @__PURE__ */ new Map();
    const currentTabByOwner = /* @__PURE__ */ new Map();
    function inScope(owner, conversationId, runKey) {
      if (owner.conversationId !== conversationId) return false;
      return runKey === void 0 || owner.runKey === runKey;
    }
    return {
      holderOf(tabId2) {
        return claims.get(tabId2)?.owner ?? null;
      },
      currentTabOf(owner) {
        return currentTabByOwner.get(owner.key) ?? null;
      },
      claim(tabId2, owner, claimedAt) {
        if (isLegacyOwner(owner)) return;
        if (!claims.has(tabId2)) claims.set(tabId2, { tabId: tabId2, owner, claimedAt });
      },
      touch(tabId2, owner) {
        if (isLegacyOwner(owner)) return;
        currentTabByOwner.set(owner.key, tabId2);
      },
      releaseTab(tabId2) {
        claims.delete(tabId2);
        for (const [ownerKey, current] of currentTabByOwner) {
          if (current === tabId2) currentTabByOwner.delete(ownerKey);
        }
      },
      releaseOwner(conversationId, runKey) {
        let dropped = 0;
        for (const [tabId2, record] of claims) {
          if (inScope(record.owner, conversationId, runKey)) {
            claims.delete(tabId2);
            dropped += 1;
          }
        }
        for (const ownerKey of Array.from(currentTabByOwner.keys())) {
          if (inScope(parseOwnerKey(ownerKey), conversationId, runKey)) {
            currentTabByOwner.delete(ownerKey);
          }
        }
        return dropped;
      },
      releaseAll() {
        claims.clear();
        currentTabByOwner.clear();
      },
      entries() {
        return Array.from(claims.values());
      }
    };
  }
  function parseOwnerKey(key) {
    const at = key.indexOf(OWNER_KEY_SEPARATOR);
    if (at < 0) return makeOwner(key, MAIN_RUN_KEY);
    return makeOwner(key.slice(0, at), key.slice(at + 1));
  }
  var LEGACY_LAST_ACTIVE_ACTIONS = /* @__PURE__ */ new Set([
    "snapshot",
    "get_html",
    "click",
    "fill",
    "select",
    "wait_for",
    "extract_text",
    "extract_table",
    "scroll",
    "keyboard",
    "start_recording",
    "stop_recording"
  ]);
  var OWNER_CURRENT_TAB_ACTIONS = /* @__PURE__ */ new Set(["get_html"]);
  var TAB_TARGETED_ACTIONS = /* @__PURE__ */ new Set([
    "screenshot",
    "screenshot_full_page",
    "navigate",
    "execute_js",
    "snapshot",
    "get_html",
    "click",
    "fill",
    "select",
    "wait_for",
    "extract_text",
    "extract_table",
    "scroll",
    "keyboard",
    "start_recording",
    "stop_recording"
  ]);
  var NO_ACTIVE_TAB_MESSAGE = "No active browser tab is available. Call get_tabs and pass tabId.";
  function staleTabMessage(tabId2) {
    return `Browser tab ${tabId2} is no longer open \u2014 it was closed, or the id is not a live tab. Call get_tabs to see the tabs you have now.`;
  }
  function crossConversationMessage(tabId2, holder) {
    return `Browser tab ${tabId2} belongs to another conversation's task (${holder.conversationId}). Call get_tabs to see the tabs you have now, and act on one this task already uses.`;
  }
  var NO_CLAIMED_TAB_MESSAGE = "This task has not acted on any browser tab yet, so there is no tab to fall back on. Call get_tabs and pass an explicit tabId.";
  function missingTabIdMessage(action2) {
    return `Missing tabId for browser action "${action2}". Call get_tabs and pass the target tabId.`;
  }
  function explicitTabId(payload2) {
    const raw = payload2.tabId;
    if (raw === void 0 || raw === null || raw === "") return void 0;
    const numeric = Number(raw);
    return Number.isInteger(numeric) ? numeric : void 0;
  }
  async function resolveTargetTab(store, action2, payload2, deps) {
    const owner = ownerFromPayload(payload2);
    const explicit = explicitTabId(payload2);
    if (isLegacyOwner(owner)) {
      if (explicit !== void 0) return explicit;
      if (!LEGACY_LAST_ACTIVE_ACTIONS.has(action2)) throw new Error(missingTabIdMessage(action2));
      const fallback = deps.lastActiveTabId();
      if (fallback === null) throw new Error(NO_ACTIVE_TAB_MESSAGE);
      return fallback;
    }
    if (explicit !== void 0) {
      if (!await deps.tabExists(explicit)) {
        store.releaseTab(explicit);
        throw new Error(staleTabMessage(explicit));
      }
      const holder = store.holderOf(explicit);
      if (!holder) {
        store.claim(explicit, owner, deps.now());
      } else if (holder.key !== owner.key) {
        if (holder.conversationId !== owner.conversationId) {
          throw new Error(crossConversationMessage(explicit, holder));
        }
        deps.log?.(
          `cross-run tab access: run ${owner.runKey} acting on tab ${explicit} owned by run ${holder.runKey} of the same conversation (explicit tabId hand-over)`
        );
      }
      store.touch(explicit, owner);
      return explicit;
    }
    if (!OWNER_CURRENT_TAB_ACTIONS.has(action2)) throw new Error(missingTabIdMessage(action2));
    const current = store.currentTabOf(owner);
    if (current === null) throw new Error(NO_CLAIMED_TAB_MESSAGE);
    if (!await deps.tabExists(current)) {
      store.releaseTab(current);
      throw new Error(staleTabMessage(current));
    }
    return current;
  }
  var NO_OWNERSHIP = /* @__PURE__ */ new Map();
  function tabListingFor(store, owner, liveTabIds, legacyCurrentTab) {
    if (isLegacyOwner(owner)) {
      return { currentTabId: legacyCurrentTab(), ownership: NO_OWNERSHIP };
    }
    const live = new Set(liveTabIds);
    const ownership = /* @__PURE__ */ new Map();
    for (const tabId2 of live) {
      const holder = store.holderOf(tabId2);
      if (!holder) continue;
      ownership.set(tabId2, holder.key === owner.key ? "you" : "other");
    }
    const current = store.currentTabOf(owner);
    return {
      currentTabId: current !== null && live.has(current) ? current : null,
      ownership
    };
  }
  function classifyInbound(raw) {
    const message = raw ?? {};
    if (typeof message.type !== "string") return { kind: "request" };
    if (message.type === "cancel") {
      return { kind: "cancel", requestId: String(message.requestId ?? "") };
    }
    if (message.type === "release" && typeof message.ownerId === "string") {
      return {
        kind: "release",
        ownerId: message.ownerId,
        runId: typeof message.runId === "string" ? message.runId : void 0
      };
    }
    return { kind: "unknown", type: message.type };
  }

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
  function saveTracking(tabId2, windowId) {
    lastActiveTabId = tabId2;
    lastActiveWindowId = windowId;
    chrome.storage.session.set({ lastActiveTabId: tabId2, lastActiveWindowId: windowId });
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
  var tabClaims = createTabClaimStore();
  var tabResolution = {
    tabExists: async (tabId2) => {
      try {
        await chrome.tabs.get(tabId2);
        return true;
      } catch {
        return false;
      }
    },
    // Read on the legacy (no `ownerId`) path only — an owned request never falls
    // back to the user's active tab.
    lastActiveTabId: () => lastActiveTabId,
    now: () => Date.now(),
    log: (message) => console.log(`[abu-ext] ${message}`)
  };
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
        const parsed = JSON.parse(event.data);
        const inbound = classifyInbound(parsed);
        if (inbound.kind !== "request") {
          handleControlMessage(inbound);
          return;
        }
        const request2 = parsed;
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
      tabClaims.releaseAll();
      scheduleReconnect();
    };
    socket.onerror = (err) => {
      console.error("[abu-ext] WebSocket error:", err);
    };
  }
  function handleControlMessage(inbound) {
    if (inbound.kind === "release") {
      const dropped = tabClaims.releaseOwner(inbound.ownerId, inbound.runId);
      if (dropped > 0) {
        console.log(`[abu-ext] Released ${dropped} tab claim(s) for ${inbound.ownerId}`);
      }
      return;
    }
    if (inbound.kind === "cancel") {
      console.log(`[abu-ext] Cancel received for ${inbound.requestId} (in-flight work is not stopped)`);
      return;
    }
    console.log(`[abu-ext] Ignoring unrecognized control message: ${inbound.type}`);
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
  function normalizedOrigin(href) {
    try {
      const parsed = new URL(String(href ?? ""));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      const hostname = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
      if (!hostname) return null;
      return `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      return null;
    }
  }
  async function assertTabOriginPin(tabId2, payload2, getTab = (id2) => chrome.tabs.get(id2)) {
    const expected = typeof payload2.expectedOrigin === "string" ? payload2.expectedOrigin : "";
    if (!expected) {
      if (payload2.unattended !== true) return;
      throw new Error(
        "Refused: this unattended run sent no approved origin for the page, so the action could not be verified against what was authorized. Call get_tabs to re-read where you are, then request this action again."
      );
    }
    let current;
    try {
      current = normalizedOrigin((await getTab(tabId2))?.url);
    } catch {
      current = null;
    }
    if (current === expected) return;
    throw new Error(
      `Refused: this tab is no longer on the page this action was approved for (approved ${expected}, now ${current ?? "an unknown page"}). The page moved \u2014 a redirect, a script navigation, or a reload. Take a fresh snapshot to re-read the current state before acting again; the earlier approval does not carry over to a different site.`
    );
  }
  async function handleRequest(request) {
    const { id, action, payload } = request;
    try {
      const tabId = TAB_TARGETED_ACTIONS.has(action) ? await resolveTargetTab(tabClaims, action, payload, tabResolution) : -1;
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
          const listing = tabListingFor(
            tabClaims,
            ownerFromPayload(payload),
            tabs.flatMap((t) => t.id === void 0 ? [] : [t.id]),
            () => {
              let legacyFocused;
              if (lastActiveTabId) {
                const trackedTab = tabs.find((t) => t.id === lastActiveTabId);
                if (trackedTab) {
                  legacyFocused = lastActiveTabId;
                }
              }
              if (!legacyFocused && targetWindowId) {
                const activeInTarget = tabs.find((t) => t.active && t.windowId === targetWindowId);
                legacyFocused = activeInTarget?.id ?? void 0;
              }
              return legacyFocused ?? null;
            }
          );
          const focusedTabId = listing.currentTabId ?? void 0;
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
              // `active` stays Chrome's own truth (which tab the user is looking
              // at in that window); `isCurrentTab` is the owner-scoped one. The
              // ownership marks tell a task which tabs are already being driven,
              // so it does not pick one that would only be refused — and are
              // simply absent for the tabs nobody holds, and for legacy callers.
              tabs: wTabs.map((t) => {
                const held = t.id === void 0 ? void 0 : listing.ownership.get(t.id);
                return {
                  tabId: t.id,
                  url: t.url ?? "",
                  title: t.title ?? "",
                  active: t.active,
                  isCurrentTab: t.id === focusedTabId,
                  ...held === "you" ? { ownedByYou: true } : {},
                  ...held === "other" ? { ownedByOther: true } : {}
                };
              })
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
          const tab = await chrome.tabs.get(tabId);
          if (!tab.active) {
            await chrome.tabs.update(tabId, { active: true });
            await new Promise((r) => setTimeout(r, 300));
          }
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          return { id, success: true, data: dataUrl };
        }
        case "screenshot_full_page": {
          const tab = await chrome.tabs.get(tabId);
          if (!tab.active) {
            await chrome.tabs.update(tabId, { active: true });
            await new Promise((r) => setTimeout(r, 300));
          }
          const result = await captureFullPage(tabId, tab.windowId);
          return { id, success: true, data: result };
        }
        case "navigate": {
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
          const code = payload.code;
          await assertTabOriginPin(tabId, payload);
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: (jsCode) => {
              return eval(jsCode);
            },
            args: [code],
            world: "MAIN"
          });
          return { id, success: true, data: results[0]?.result };
        }
        case "snapshot":
        case "get_html":
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
  chrome.tabs.onRemoved.addListener((tabId2) => {
    injectedTabs.delete(tabId2);
    tabClaims.releaseTab(tabId2);
  });
  chrome.tabs.onUpdated.addListener((tabId2, changeInfo) => {
    if (changeInfo.status === "loading") injectedTabs.delete(tabId2);
  });
  async function ensureContentScript(tabId2) {
    if (injectedTabs.has(tabId2)) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId2, allFrames: true },
        files: ["content.js"]
      });
      injectedTabs.add(tabId2);
    } catch {
      injectedTabs.add(tabId2);
    }
  }
  async function sendToContentScript(tabId2, action2, payload2) {
    await ensureContentScript(tabId2);
    const doSend = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Content script did not respond within ${CONTENT_SCRIPT_TIMEOUT / 1e3}s (action: ${action2})`));
      }, CONTENT_SCRIPT_TIMEOUT);
      chrome.tabs.sendMessage(tabId2, { action: action2, payload: payload2 }, (response) => {
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
        console.log(`[abu-ext] Content script stale for tab ${tabId2}, re-injecting...`);
        injectedTabs.delete(tabId2);
        await ensureContentScript(tabId2);
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
  async function captureFullPage(tabId2, windowId) {
    const dims = await sendToContentScript(tabId2, "fullpage_prepare", {});
    const { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY } = dims;
    const sliceCount = Math.ceil(scrollHeight / viewportHeight);
    const slices = [];
    try {
      for (let i = 0; i < sliceCount; i++) {
        const scrollTop = i * viewportHeight;
        await sendToContentScript(tabId2, "fullpage_scroll", { scrollTop });
        await new Promise((r) => setTimeout(r, 600));
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
        slices.push(dataUrl);
      }
    } finally {
      await sendToContentScript(tabId2, "fullpage_restore", { scrollX, scrollY }).catch(() => {
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
