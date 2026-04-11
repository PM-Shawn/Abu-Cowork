"use strict";
(() => {
  // src/content/index.ts
  var MAX_EXTRACT_TEXT_SIZE = 5e4;
  var MAX_SNAPSHOT_ELEMENTS = 200;
  function reportVisible() {
    if (document.visibilityState === "visible") {
      chrome.runtime.sendMessage({ type: "tab_visible" }).catch(() => {
      });
    }
  }
  document.addEventListener("visibilitychange", reportVisible);
  reportVisible();
  var refMap = /* @__PURE__ */ new Map();
  var refCounter = 0;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { action, payload } = message;
    handleAction(action, payload).then((data) => sendResponse({ data })).catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  });
  async function handleAction(action, payload) {
    switch (action) {
      case "snapshot":
        return takeSnapshot(payload.selector);
      case "click":
        return clickElement(payload.locator);
      case "fill":
        return fillElement(payload.locator, payload.value);
      case "select":
        return selectOption(payload.locator, payload.value);
      case "wait_for":
        return waitFor(payload.condition, payload.timeout);
      case "extract_text":
        return extractText(payload.selector);
      case "extract_table":
        return extractTable(payload.selector);
      case "scroll":
        return scrollPage(payload);
      case "keyboard":
        return sendKeyboard(payload);
      case "start_recording":
        return startRecording();
      case "stop_recording":
        return stopRecording();
      case "fullpage_prepare":
        return fullpagePrepare();
      case "fullpage_scroll":
        return fullpageScroll(payload.scrollTop);
      case "fullpage_restore":
        return fullpageRestore(payload.scrollX, payload.scrollY);
      default:
        throw new Error(`Unknown content action: ${action}`);
    }
  }
  function takeSnapshot(scopeSelector) {
    const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
    if (!root) throw new Error(`Scope element not found: ${scopeSelector}`);
    refMap.clear();
    refCounter = 0;
    const interactiveTags = /* @__PURE__ */ new Set([
      "a",
      "button",
      "input",
      "textarea",
      "select",
      "details",
      "summary"
    ]);
    const interactiveRoles = /* @__PURE__ */ new Set([
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "listbox",
      "option",
      "menuitem",
      "tab",
      "switch",
      "slider"
    ]);
    const elements = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      const el = node;
      const tag = el.tagName?.toLowerCase();
      const isInteractive = interactiveTags.has(tag) || el.hasAttribute("onclick") || el.hasAttribute("tabindex") || el.getAttribute("role") && interactiveRoles.has(el.getAttribute("role")) || el.contentEditable === "true" || tag === "div" && el.getAttribute("role") && interactiveRoles.has(el.getAttribute("role"));
      if (isInteractive && isVisible(el)) {
        const ref = `e${++refCounter}`;
        refMap.set(ref, el);
        const info = {
          ref,
          tag,
          enabled: !el.disabled,
          visible: true
        };
        const text = getVisibleText(el);
        if (text) info.text = text.slice(0, 100);
        if (tag === "input") {
          const input = el;
          info.type = input.type;
          if (input.placeholder) info.placeholder = input.placeholder;
          if (input.value) info.value = input.value.slice(0, 100);
          if (input.type === "checkbox" || input.type === "radio") {
            info.checked = input.checked;
          }
        }
        if (tag === "textarea") {
          const ta = el;
          if (ta.placeholder) info.placeholder = ta.placeholder;
          if (ta.value) info.value = ta.value.slice(0, 200);
        }
        if (tag === "select") {
          const select = el;
          info.options = [...select.options].map((o) => ({ value: o.value, text: o.text }));
          info.value = select.value;
        }
        if (tag === "a") {
          info.href = el.href;
        }
        const role = el.getAttribute("role");
        if (role) info.role = role;
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) info.ariaLabel = ariaLabel;
        elements.push(info);
        if (elements.length >= MAX_SNAPSHOT_ELEMENTS) break;
      }
      node = walker.nextNode();
    }
    const truncated = elements.length >= MAX_SNAPSHOT_ELEMENTS;
    return {
      url: location.href,
      title: document.title,
      elements,
      ...truncated ? { truncated: true, message: `Showing first ${MAX_SNAPSHOT_ELEMENTS} elements. Use selector parameter to scope.` } : {}
    };
  }
  function escapeCSS(value) {
    if (typeof CSS !== "undefined" && CSS.escape) {
      return CSS.escape(value);
    }
    return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }
  function findElement(locator) {
    if (locator.ref) {
      const el = refMap.get(locator.ref);
      if (el && el.isConnected) return el;
    }
    if (locator.css) {
      return document.querySelector(locator.css);
    }
    if (locator.text) {
      const tag = locator.tag ?? "*";
      const candidates = document.querySelectorAll(tag);
      for (const el of candidates) {
        const text = getVisibleText(el);
        if (text && text.includes(locator.text) && isVisible(el)) {
          return el;
        }
      }
      return null;
    }
    if (locator.role) {
      const escapedRole = escapeCSS(locator.role);
      const selector = locator.name ? `[role="${escapedRole}"][aria-label="${escapeCSS(locator.name)}"]` : `[role="${escapedRole}"]`;
      return document.querySelector(selector);
    }
    if (locator.testId) {
      return document.querySelector(`[data-testid="${escapeCSS(locator.testId)}"]`);
    }
    if (locator.xpath) {
      const result = document.evaluate(locator.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    }
    throw new Error(`Invalid locator: ${JSON.stringify(locator)}`);
  }
  function findElementOrThrow(locator) {
    const el = findElement(locator);
    if (!el) throw new Error(`Element not found: ${JSON.stringify(locator)}`);
    return el;
  }
  function clickElement(locator) {
    const el = findElementOrThrow(locator);
    const text = getVisibleText(el)?.slice(0, 50);
    el.scrollIntoView({ behavior: "instant", block: "center" });
    highlightElement(el);
    showStatus(`Click: ${text ?? "element"}`, "info");
    const htmlEl = el;
    htmlEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    htmlEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    htmlEl.click();
    return {
      success: true,
      message: `Clicked element${text ? `: "${text}"` : ""}`,
      elementText: text ?? void 0
    };
  }
  function fillElement(locator, value) {
    const el = findElementOrThrow(locator);
    const previousValue = el.value;
    highlightElement(el);
    showStatus(`Fill: "${value.slice(0, 30)}"`, "info");
    const nativeSetter = Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return {
      success: true,
      message: `Filled field with "${value.slice(0, 50)}"`,
      previousValue: previousValue || void 0
    };
  }
  function selectOption(locator, value) {
    const el = findElementOrThrow(locator);
    if (el.tagName.toLowerCase() !== "select") {
      throw new Error(`Element is not a <select>: ${el.tagName}`);
    }
    let found = false;
    for (const option of el.options) {
      if (option.value === value || option.text === value) {
        el.value = option.value;
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`Option not found: "${value}"`);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { success: true, message: `Selected option: "${value}"` };
  }
  async function waitFor(condition, timeout = 3e4) {
    const start = Date.now();
    const condType = condition.type;
    const check = () => {
      switch (condType) {
        case "appear": {
          const el = findElement(condition.locator);
          return el !== null && isVisible(el);
        }
        case "disappear": {
          const el = findElement(condition.locator);
          return el === null || !isVisible(el);
        }
        case "enabled": {
          const el = findElement(condition.locator);
          return el !== null && isVisible(el) && !el.disabled;
        }
        case "textContains": {
          const el = findElement(condition.locator);
          if (!el) return false;
          const text = getVisibleText(el) ?? "";
          return text.includes(condition.text);
        }
        case "urlContains": {
          return location.href.includes(condition.pattern);
        }
        default:
          throw new Error(`Unknown wait condition: ${condType}`);
      }
    };
    if (check()) {
      return { success: true, message: `Condition met immediately`, timedOut: false, elapsed: 0 };
    }
    return new Promise((resolve) => {
      let resolved = false;
      let checkScheduled = false;
      const complete = (timedOut) => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        const elapsed = Date.now() - start;
        resolve({
          success: !timedOut,
          message: timedOut ? `Timed out after ${timeout}ms` : `Condition met after ${elapsed}ms`,
          timedOut,
          elapsed
        });
      };
      const tryCheck = () => {
        if (resolved) return;
        try {
          if (check()) complete(false);
        } catch {
        }
      };
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
        attributes: true
      });
      const pollTimer = setInterval(tryCheck, 500);
      const timeoutTimer = setTimeout(() => complete(true), timeout);
    });
  }
  function extractText(selector) {
    let text;
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      text = el.innerText ?? el.textContent ?? "";
    } else {
      text = document.body.innerText ?? "";
    }
    if (text.length > MAX_EXTRACT_TEXT_SIZE) {
      return text.slice(0, MAX_EXTRACT_TEXT_SIZE) + `

[Truncated: ${text.length} chars total, showing first ${MAX_EXTRACT_TEXT_SIZE}]`;
    }
    return text;
  }
  function extractTable(selector) {
    let table;
    if (selector) {
      table = document.querySelector(selector);
    } else {
      const tables = [...document.querySelectorAll("table")];
      table = tables.sort((a, b) => b.rows.length - a.rows.length)[0] ?? null;
    }
    if (!table) throw new Error("No table found on the page");
    const headers = [...table.querySelectorAll("thead th, thead td")].map((th) => th.innerText?.trim() ?? "");
    if (headers.length === 0) {
      const firstRow = table.rows[0];
      if (firstRow) {
        for (const cell of firstRow.cells) {
          headers.push(cell.innerText?.trim() ?? "");
        }
      }
    }
    const rows = [];
    const bodyRows = table.querySelectorAll("tbody tr");
    const rowElements = bodyRows.length > 0 ? bodyRows : table.rows;
    for (const tr of rowElements) {
      const row = [...tr.cells].map((td) => td.innerText?.trim() ?? "");
      if (headers.length > 0 && row.join("") === headers.join("")) continue;
      rows.push(row);
    }
    return { headers, rows, rowCount: rows.length };
  }
  function scrollPage(payload) {
    const direction = payload.direction;
    const amount = payload.amount ?? 500;
    const selector = payload.selector;
    const target = selector ? document.querySelector(selector) : window;
    if (selector && !target) throw new Error(`Scroll target not found: ${selector}`);
    const scrollOptions = {};
    switch (direction) {
      case "down":
        scrollOptions.top = amount;
        break;
      case "up":
        scrollOptions.top = -amount;
        break;
      case "right":
        scrollOptions.left = amount;
        break;
      case "left":
        scrollOptions.left = -amount;
        break;
    }
    if (target === window) {
      window.scrollBy({ ...scrollOptions, behavior: "smooth" });
    } else {
      target.scrollBy({ ...scrollOptions, behavior: "smooth" });
    }
    return { success: true, message: `Scrolled ${direction} by ${amount}px` };
  }
  function sendKeyboard(payload) {
    const key = payload.key;
    const modifiers = payload.modifiers ?? [];
    const eventInit = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.includes("ctrl"),
      shiftKey: modifiers.includes("shift"),
      altKey: modifiers.includes("alt"),
      metaKey: modifiers.includes("meta")
    };
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    if (key.length === 1 && !modifiers.includes("ctrl") && !modifiers.includes("meta")) {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.dispatchEvent(new InputEvent("beforeinput", {
          data: key,
          inputType: "insertText",
          bubbles: true,
          cancelable: true
        }));
        target.dispatchEvent(new InputEvent("input", {
          data: key,
          inputType: "insertText",
          bubbles: true
        }));
      }
    }
    return { success: true, message: `Key press: ${modifiers.length > 0 ? modifiers.join("+") + "+" : ""}${key}` };
  }
  var recording = false;
  var recordedSteps = [];
  var recordClickHandler = null;
  var recordInputHandler = null;
  function getBestSelector(el) {
    if (el.id) return { css: `#${CSS.escape(el.id)}` };
    const testId = el.getAttribute("data-testid");
    if (testId) return { css: `[data-testid="${CSS.escape(testId)}"]` };
    const label = el.getAttribute("aria-label");
    if (label) return { text: label };
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "a") {
      const text = el.innerText?.trim();
      if (text && text.length < 50) return { text };
    }
    const path = [];
    let current = el;
    for (let i = 0; i < 3 && current && current !== document.body; i++) {
      let seg = current.tagName.toLowerCase();
      if (current.className && typeof current.className === "string") {
        const cls = current.className.trim().split(/\s+/).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
        seg += cls;
      }
      path.unshift(seg);
      current = current.parentElement;
    }
    return { css: path.join(" > ") };
  }
  function startRecording() {
    if (recording) return { success: false, message: "Already recording" };
    recording = true;
    recordedSteps.length = 0;
    recordClickHandler = (e) => {
      const el = e.target;
      if (!el || el.id === "abu-status" || el.id === "abu-highlight") return;
      recordedSteps.push({
        action: "click",
        locator: getBestSelector(el),
        timestamp: Date.now()
      });
    };
    recordInputHandler = (e) => {
      const el = e.target;
      if (!el) return;
      const tag = el.tagName.toLowerCase();
      if (tag === "select") {
        recordedSteps.push({
          action: "select",
          locator: getBestSelector(el),
          value: el.value,
          timestamp: Date.now()
        });
      } else if (tag === "input" || tag === "textarea") {
        const last = recordedSteps[recordedSteps.length - 1];
        const loc = getBestSelector(el);
        if (last && last.action === "fill" && JSON.stringify(last.locator) === JSON.stringify(loc)) {
          last.value = el.value;
          last.timestamp = Date.now();
        } else {
          recordedSteps.push({
            action: "fill",
            locator: loc,
            value: el.value,
            timestamp: Date.now()
          });
        }
      }
    };
    document.addEventListener("click", recordClickHandler, true);
    document.addEventListener("change", recordInputHandler, true);
    showStatus("Recording started...", "info");
    return { success: true, message: `Recording started. Interact with the page, then call stop_recording to get the steps.` };
  }
  function stopRecording() {
    if (!recording) return { success: false, steps: [], message: "Not recording" };
    recording = false;
    if (recordClickHandler) {
      document.removeEventListener("click", recordClickHandler, true);
      recordClickHandler = null;
    }
    if (recordInputHandler) {
      document.removeEventListener("change", recordInputHandler, true);
      recordInputHandler = null;
    }
    showStatus(`Recording stopped: ${recordedSteps.length} steps`, "success");
    return {
      success: true,
      steps: [...recordedSteps],
      message: `Recorded ${recordedSteps.length} steps. Use these as a template for automation.`
    };
  }
  var savedFixedElements = [];
  function fullpagePrepare() {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const scrollHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    savedFixedElements = [];
    const allElements = document.querySelectorAll("*");
    for (const el of allElements) {
      const htmlEl = el;
      const style = getComputedStyle(htmlEl);
      if (style.position === "fixed" || style.position === "sticky") {
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 10) continue;
        savedFixedElements.push([htmlEl, style.position, htmlEl.style.top]);
        htmlEl.style.setProperty("position", "absolute", "important");
      }
    }
    return { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY };
  }
  function fullpageScroll(scrollTop) {
    window.scrollTo({ top: scrollTop, left: 0, behavior: "instant" });
    return { success: true };
  }
  function fullpageRestore(scrollX, scrollY) {
    for (const [el, originalPosition, originalTop] of savedFixedElements) {
      el.style.position = originalPosition;
      el.style.top = originalTop;
    }
    savedFixedElements = [];
    window.scrollTo({ top: scrollY, left: scrollX, behavior: "instant" });
    return { success: true };
  }
  var highlightOverlay = null;
  function highlightElement(el) {
    const rect = el.getBoundingClientRect();
    if (!highlightOverlay) {
      highlightOverlay = document.createElement("div");
      highlightOverlay.id = "abu-highlight";
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
    highlightOverlay.style.display = "block";
    highlightOverlay.style.opacity = "1";
    setTimeout(() => {
      if (highlightOverlay) {
        highlightOverlay.style.opacity = "0";
        setTimeout(() => {
          if (highlightOverlay) highlightOverlay.style.display = "none";
        }, 300);
      }
    }, 1500);
  }
  var statusBubble = null;
  var statusTimer = null;
  function showStatus(text, type = "info") {
    if (!statusBubble) {
      statusBubble = document.createElement("div");
      statusBubble.id = "abu-status";
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
      info: { bg: "#1a1a2e", border: "#d97757", text: "#e0e0e0" },
      success: { bg: "#0f2a1a", border: "#4ade80", text: "#4ade80" },
      error: { bg: "#2a0f0f", border: "#f87171", text: "#f87171" }
    };
    const c = colors[type];
    statusBubble.style.background = c.bg;
    statusBubble.style.border = `1px solid ${c.border}`;
    statusBubble.style.color = c.text;
    statusBubble.textContent = `Abu: ${text}`;
    statusBubble.style.opacity = "1";
    statusBubble.style.transform = "translateY(0)";
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (statusBubble) {
        statusBubble.style.opacity = "0";
        statusBubble.style.transform = "translateY(8px)";
      }
    }, 3e3);
  }
  function isVisible(el) {
    const htmlEl = el;
    if (htmlEl.offsetParent === null && htmlEl.style?.position !== "fixed" && htmlEl.style?.position !== "sticky") {
      const style = getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function getVisibleText(el) {
    if (el.tagName === "INPUT") {
      const input = el;
      return input.value || input.placeholder || input.getAttribute("aria-label") || null;
    }
    if (el.tagName === "TEXTAREA") {
      const ta = el;
      return ta.value || ta.placeholder || null;
    }
    const text = el.innerText?.trim();
    return text || el.getAttribute("aria-label") || null;
  }
})();
//# sourceMappingURL=content.js.map
