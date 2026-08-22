"use strict";
(() => {
  // src/content/index.ts
  var MAX_EXTRACT_TEXT_SIZE = 5e4;
  var MAX_SNAPSHOT_ELEMENTS = 200;
  var MAX_SNAPSHOT_CHARS = 3e4;
  var electronBrowserRuntime = globalThis.__ABU_ELECTRON_BROWSER_RUNTIME__;
  if (electronBrowserRuntime) {
    electronBrowserRuntime.handleAction = handleAction;
  } else {
    const reportVisible = () => {
      if (document.visibilityState === "visible") {
        chrome.runtime.sendMessage({ type: "tab_visible" }).catch(() => {
        });
      }
    };
    document.addEventListener("visibilitychange", reportVisible);
    reportVisible();
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const { action, payload } = message;
      handleAction(action, payload).then((data) => sendResponse({ data })).catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
      return true;
    });
  }
  var refByElement = /* @__PURE__ */ new WeakMap();
  var elementByRef = /* @__PURE__ */ new Map();
  var refCounter = 0;
  function refFor(el) {
    const existing = refByElement.get(el);
    if (existing && elementByRef.get(existing)?.deref() === el) return existing;
    const ref = `e${++refCounter}`;
    refByElement.set(el, ref);
    elementByRef.set(ref, new WeakRef(el));
    return ref;
  }
  function resolveRef(ref) {
    const el = elementByRef.get(ref)?.deref();
    if (!el || !el.isConnected) {
      elementByRef.delete(ref);
      return null;
    }
    return el;
  }
  function sweepRefs() {
    for (const [ref, weak] of elementByRef) {
      const el = weak.deref();
      if (!el || !el.isConnected) elementByRef.delete(ref);
    }
  }
  async function handleAction(action, payload) {
    switch (action) {
      case "snapshot":
        return takeSnapshot(
          payload.selector,
          typeof payload.maxChars === "number" ? payload.maxChars : void 0
        );
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
  function takeSnapshot(scopeSelector, maxChars = MAX_SNAPSHOT_CHARS) {
    const roots = scopeSelector ? [...document.querySelectorAll(scopeSelector)] : document.body ? [document.body] : [];
    if (roots.length === 0) {
      throw new Error(
        `Scope element not found: ${scopeSelector}. Take a snapshot without a selector to see what the page actually contains.`
      );
    }
    sweepRefs();
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
    const openPopups = [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="grid"]')].map((list) => popupRootFor(list)).filter((popup) => hasBox(popup));
    const isPopupRow = (el) => {
      if (openPopups.length === 0) return false;
      if (!hasBox(el)) return false;
      if (!openPopups.some((popup) => popup !== el && popup.contains(el))) return false;
      if ([...el.children].some((child) => hasBox(child))) return false;
      const text = normalizedText(el);
      return text.length > 0 && text.length <= 100;
    };
    const elements = [];
    const seenElements = /* @__PURE__ */ new WeakSet();
    let hitCap = false;
    for (const root of roots) {
      if (hitCap) break;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node) {
        const el = node;
        const tag = el.tagName?.toLowerCase();
        const isInteractive = interactiveTags.has(tag) || el.hasAttribute("onclick") || el.hasAttribute("tabindex") || el.getAttribute("role") && interactiveRoles.has(el.getAttribute("role")) || el.contentEditable === "true" || tag === "div" && el.getAttribute("role") && interactiveRoles.has(el.getAttribute("role")) || isPopupRow(el);
        if (isInteractive && !seenElements.has(el) && isSnapshotVisible(el)) {
          seenElements.add(el);
          const info = {
            ref: refFor(el),
            tag,
            enabled: !el.disabled,
            visible: true
          };
          const text = getVisibleText(el);
          if (text) info.text = text.slice(0, 100);
          if (el.id) info.id = el.id;
          const nameAttr = el.getAttribute("name");
          if (nameAttr) info.name = nameAttr;
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
          if (elements.length >= MAX_SNAPSHOT_ELEMENTS) {
            hitCap = true;
            break;
          }
        }
        node = walker.nextNode();
      }
    }
    const hitElementCap = elements.length >= MAX_SNAPSHOT_ELEMENTS;
    const total = elements.length;
    const serializedLength = (count) => JSON.stringify(elements.slice(0, count), null, 2).length;
    let kept = total;
    if (serializedLength(total) > maxChars) {
      let low = 1;
      let high = total;
      kept = 1;
      while (low <= high) {
        const mid = low + high >> 1;
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
    if (elements.length === 0 && scopeSelector) {
      return {
        url: location.href,
        title: document.title,
        elements,
        message: `"${scopeSelector}" matched ${roots.length} element${roots.length === 1 ? "" : "s"}, none of which contain anything interactive right now \u2014 a popup that is closed looks like this. Take a snapshot without a selector to see the whole page, or open the control first.`
      };
    }
    const reasons = [];
    if (hitElementCap) reasons.push(`the ${MAX_SNAPSHOT_ELEMENTS}-element cap`);
    if (overBudget) reasons.push(`the ${maxChars}-character budget`);
    return {
      url: location.href,
      title: document.title,
      elements,
      ...reasons.length ? {
        truncated: true,
        message: `Showing ${elements.length} of ${total}+ interactive elements \u2014 hit ${reasons.join(" and ")}. To see the rest: pass \`selector\` to scope the snapshot to one region (e.g. the form you are filling), or raise \`maxChars\`. The elements listed above are complete and their refs are valid.`
      } : {}
    };
  }
  function escapeCSS(value) {
    if (typeof CSS !== "undefined" && CSS.escape) {
      return CSS.escape(value);
    }
    return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }
  var NEVER_A_TARGET = /* @__PURE__ */ new Set(["html", "body", "head", "script", "style", "noscript", "title"]);
  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join(".")}` : "";
    const text = (getVisibleText(el) ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `[${refFor(el)}] <${tag}${id}${cls}>${text ? ` "${text}"` : ""}`;
  }
  function isClickable(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea", "summary", "label", "option"].includes(tag)) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
    const role = el.getAttribute("role");
    return role !== null && ["button", "link", "option", "menuitem", "tab", "checkbox", "radio", "switch"].includes(role);
  }
  function findByText(text, tag) {
    const scope = tag ?? "*";
    const wanted = text.trim();
    const squashed = wanted.replace(/\s+/g, "");
    const candidates = [...document.querySelectorAll(scope)].filter((el) => {
      if (NEVER_A_TARGET.has(el.tagName.toLowerCase())) return false;
      if (!isSnapshotVisible(el)) return false;
      const own = normalizedText(el);
      return own.includes(wanted) || squashed !== "" && own.replace(/\s+/g, "").includes(squashed);
    });
    const laidOut = candidates.filter(hasBox);
    const matches = laidOut.length > 0 ? laidOut : candidates;
    if (matches.length === 0) return null;
    let deepest = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    const exact = deepest.filter(
      (el) => normalizedText(el) === wanted || normalizedText(el).replace(/\s+/g, "") === squashed
    );
    if (exact.length > 0) deepest = exact;
    const clickable = deepest.filter(isClickable);
    if (clickable.length > 0) deepest = clickable;
    if (deepest.length === 1) return deepest[0];
    throw new Error(
      `Text "${text}" matches ${deepest.length} different elements, so it does not identify one. Pick one by ref:
${deepest.slice(0, 8).map((el) => `  ${describeElement(el)}`).join("\n")}` + (deepest.length > 8 ? `
  ...and ${deepest.length - 8} more` : "")
    );
  }
  function findElement(locator) {
    if (locator.ref) {
      const el = resolveRef(locator.ref);
      if (el) return el;
      const err = new Error(
        `Ref "${locator.ref}" no longer exists on this page (the element was removed or replaced). Take a fresh snapshot and use a ref from it.`
      );
      err.name = "StaleRefError";
      throw err;
    }
    if (locator.css) {
      return document.querySelector(locator.css);
    }
    if (locator.text) {
      return findByText(locator.text, locator.tag);
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
  function targetInfo(el) {
    const text = getVisibleText(el)?.replace(/\s+/g, " ").trim().slice(0, 50);
    return {
      ref: refFor(el),
      tag: el.tagName.toLowerCase(),
      ...el.id ? { id: el.id } : {},
      ...el.getAttribute("role") ? { role: el.getAttribute("role") } : {},
      ...text ? { text } : {}
    };
  }
  function dispatchClickSequence(el) {
    const opts = { bubbles: true, cancelable: true, composed: true };
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
    }
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    }
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
  }
  function clickElement(locator) {
    const el = findElementOrThrow(locator);
    const target = targetInfo(el);
    el.scrollIntoView({ behavior: "instant", block: "center" });
    highlightElement(el);
    showStatus(`Click: ${target.text ?? "element"}`, "info");
    dispatchClickSequence(el);
    return {
      success: true,
      // Naming the element that was actually hit — not just the text that was
      // asked for — is what lets a caller notice it landed on the wrong thing.
      message: `Clicked ${describeElement(el)}`,
      elementText: target.text,
      target
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
  var DROPDOWN_OPEN_TIMEOUT_MS = 1500;
  function isRendered(el) {
    if (!el.isConnected) return false;
    const target = el;
    if (typeof target.checkVisibility === "function") {
      return target.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    }
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function isSnapshotVisible(el) {
    if (isVisible(el)) return true;
    const tag = el.tagName.toLowerCase();
    const isFormControl = ["input", "textarea", "select", "button"].includes(tag) || el.contentEditable === "true";
    if (!isFormControl) return false;
    if (!isRendered(el)) return false;
    let depth = 0;
    for (let node = el.parentElement; node && depth < 4; node = node.parentElement, depth++) {
      if (hasBox(node)) return true;
    }
    return false;
  }
  function hasBox(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function optionLabelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  function clickTargetForOption(ariaOption, popup) {
    if (hasBox(ariaOption)) return ariaOption;
    const label = optionLabelOf(ariaOption);
    if (!label) return null;
    const rendered = [...popup.querySelectorAll("*")].filter(
      (el) => hasBox(el) && (el.textContent ?? "").replace(/\s+/g, " ").trim() === label
    );
    const deepest = rendered.filter((el) => !rendered.some((other) => other !== el && el.contains(other)));
    return deepest[0] ?? null;
  }
  function popupRootFor(container) {
    let node = container;
    while (node && node !== document.body) {
      if (hasBox(node)) return node;
      node = node.parentElement;
    }
    return container;
  }
  function optionsFor(trigger) {
    const owned = (trigger.getAttribute("aria-controls") ?? trigger.getAttribute("aria-owns") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter((el) => el !== null);
    if (owned.length > 0) {
      return owned.flatMap((c) => [...c.querySelectorAll('[role="option"], [role="menuitem"]')]).filter(isRendered);
    }
    const containers = [...document.querySelectorAll('[role="listbox"], [role="menu"]')].filter(isVisible);
    const fromContainers = containers.flatMap((c) => [...c.querySelectorAll('[role="option"], [role="menuitem"]')]);
    const options = fromContainers.length > 0 ? fromContainers : [...document.querySelectorAll('[role="option"], [role="menuitem"]')];
    return options.filter(isVisible);
  }
  function scrollerWithin(popup) {
    const scrolls = (el) => el.scrollHeight > el.clientHeight + 1;
    if (scrolls(popup)) return popup;
    for (const node of popup.querySelectorAll("*")) {
      if (scrolls(node)) return node;
    }
    return null;
  }
  function normalizedText(el) {
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  function renderedRowFor(popup, label) {
    const matches = [...popup.querySelectorAll("*")].filter(
      (el) => hasBox(el) && normalizedText(el) === label
    );
    const deepest = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    return deepest[0] ?? null;
  }
  function renderedRowLabels(popup) {
    const labels = [];
    for (const el of popup.querySelectorAll("*")) {
      if (!hasBox(el)) continue;
      if ([...el.children].some((child) => hasBox(child))) continue;
      const text = normalizedText(el);
      if (text && text.length <= 80) labels.push(text);
    }
    return labels;
  }
  async function findOption(trigger, value) {
    const wanted = value.trim();
    const squashed = wanted.replace(/\s+/g, "");
    const seen = /* @__PURE__ */ new Set();
    const attempt = () => {
      const ariaOptions2 = optionsFor(trigger);
      if (ariaOptions2.length === 0) return null;
      const popup2 = popupRootFor(ariaOptions2[0].parentElement ?? ariaOptions2[0]);
      const labelled = ariaOptions2.map((el) => ({ el, label: optionLabelOf(el) }));
      labelled.forEach(({ label }) => label && seen.add(label));
      renderedRowLabels(popup2).forEach((label) => seen.add(label));
      const hit = labelled.find(({ label }) => label === wanted) ?? labelled.find(({ label }) => label.replace(/\s+/g, "") === squashed) ?? labelled.find(({ label }) => label.includes(wanted));
      if (hit) {
        const target = clickTargetForOption(hit.el, popup2);
        if (target) return { option: target, label: hit.label };
      }
      const rendered = renderedRowFor(popup2, wanted) ?? renderedRowFor(popup2, [...seen].find((label) => label.replace(/\s+/g, "") === squashed) ?? wanted);
      if (rendered) return { option: rendered, label: normalizedText(rendered) };
      return null;
    };
    const deadline = Date.now() + DROPDOWN_OPEN_TIMEOUT_MS;
    for (; ; ) {
      const hit = attempt();
      if (hit) return { ...hit, seen: [...seen] };
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const ariaOptions = optionsFor(trigger);
    const popup = ariaOptions.length > 0 ? popupRootFor(ariaOptions[0].parentElement ?? ariaOptions[0]) : null;
    const scroller = popup ? scrollerWithin(popup) : null;
    if (!scroller) return { option: null, label: "", seen: [...seen] };
    let previousTop = -1;
    for (let guard = 0; guard < 40 && scroller.scrollTop !== previousTop; guard++) {
      previousTop = scroller.scrollTop;
      scroller.scrollTop += Math.max(1, scroller.clientHeight - 8);
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const hit = attempt();
      if (hit) return { ...hit, seen: [...seen] };
    }
    return { option: null, label: "", seen: [...seen] };
  }
  async function selectOption(locator, value) {
    const el = findElementOrThrow(locator);
    if (el.tagName.toLowerCase() === "select") {
      const select = el;
      const options = [...select.options];
      const match = options.find((o) => o.value === value || o.text === value);
      if (!match) {
        throw new Error(
          `Option "${value}" not found. Available options: ${options.map((o) => `"${o.text}"`).join(", ") || "(none)"}`
        );
      }
      select.value = match.value;
      select.focus();
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true, message: `Selected option: "${match.text}"`, target: targetInfo(select) };
    }
    const role = el.getAttribute("role");
    const isCustomDropdown = role === "combobox" || role === "listbox" || el.getAttribute("aria-haspopup") === "listbox" || optionsFor(el).length > 0;
    if (!isCustomDropdown) {
      throw new Error(
        `${describeElement(el)} is not a dropdown: it is not a <select>, has no combobox/listbox role, and owns no options. If this is a text field use fill; if the control opens a menu, click it and take a snapshot to see what appeared.`
      );
    }
    showStatus(`Select: "${value}"`, "info");
    el.scrollIntoView({ behavior: "instant", block: "center" });
    if (el.getAttribute("aria-expanded") !== "true" && optionsFor(el).length === 0) {
      dispatchClickSequence(el);
    }
    const { option: chosen, label: chosenLabel, seen } = await findOption(el, value);
    if (seen.length === 0) {
      throw new Error(
        `Opened ${describeElement(el)} but no options appeared within ${DROPDOWN_OPEN_TIMEOUT_MS}ms. Take a snapshot to see the current state of the page.`
      );
    }
    if (!chosen) {
      const wasListed = seen.some(
        (label) => label === value.trim() || label.replace(/\s+/g, "") === value.trim().replace(/\s+/g, "")
      );
      throw new Error(
        wasListed ? `Option "${value}" is in ${describeElement(el)} but the dropdown never finished opening, so there was nothing to click. Take a snapshot to see the page's current state, then retry select.` : `Option "${value}" not found in ${describeElement(el)}. Options available: ${seen.map((label) => `"${label}"`).join(", ")}`
      );
    }
    highlightElement(chosen);
    chosen.scrollIntoView({ behavior: "instant", block: "nearest" });
    dispatchClickSequence(chosen);
    return {
      success: true,
      message: `Selected "${chosenLabel}" in ${describeElement(el)}`,
      target: targetInfo(chosen)
    };
  }
  async function waitFor(condition, timeout = 3e4) {
    const start = Date.now();
    const condType = condition.type;
    const describeCurrentState = () => {
      if (condType === "urlContains") return `current url is ${location.href}`;
      let el;
      try {
        el = findElement(condition.locator);
      } catch {
        return "the locator no longer resolves (its ref is stale) \u2014 take a fresh snapshot";
      }
      if (!el) return "no element matches that locator";
      if (!isVisible(el)) return `matched <${el.tagName.toLowerCase()}> but it has no layout box (hidden or zero-sized)`;
      if (condType === "enabled" && el.disabled) {
        return `matched <${el.tagName.toLowerCase()}> but it is still disabled`;
      }
      if (condType === "textContains") {
        return `matched <${el.tagName.toLowerCase()}> whose text is ${JSON.stringify((getVisibleText(el) ?? "").slice(0, 80))}`;
      }
      return `matched <${el.tagName.toLowerCase()}>, which does not satisfy "${condType}"`;
    };
    const check = () => {
      switch (condType) {
        case "appear": {
          const el = findElement(condition.locator);
          return el !== null && isVisible(el);
        }
        case "disappear": {
          let el;
          try {
            el = findElement(condition.locator);
          } catch (err) {
            if (err instanceof Error && err.name === "StaleRefError") return true;
            throw err;
          }
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
    const staleRefMessage = (err) => err instanceof Error && err.name === "StaleRefError" ? err.message : null;
    try {
      if (check()) {
        return { success: true, message: `Condition met immediately`, timedOut: false, elapsed: 0 };
      }
    } catch (err) {
      const stale = staleRefMessage(err);
      if (stale === null) throw err;
      return { success: false, message: stale, timedOut: false, elapsed: Date.now() - start };
    }
    return new Promise((resolve) => {
      let resolved = false;
      let checkScheduled = false;
      const complete = (timedOut, failure) => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        const elapsed = Date.now() - start;
        resolve({
          success: !timedOut && failure === void 0,
          message: failure ?? (timedOut ? `Timed out after ${timeout}ms waiting for "${condType}" \u2014 ${describeCurrentState()}.` : `Condition met after ${elapsed}ms`),
          timedOut,
          elapsed,
          ...timedOut ? { observed: describeCurrentState() } : {}
        });
      };
      const tryCheck = () => {
        if (resolved) return;
        try {
          if (check()) complete(false);
        } catch (err) {
          const stale = staleRefMessage(err);
          if (stale !== null) {
            complete(false, stale);
            return;
          }
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
    const style = getComputedStyle(htmlEl);
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (htmlEl.offsetParent === null && htmlEl.style?.position !== "fixed" && htmlEl.style?.position !== "sticky") {
      if (style.display === "none") return false;
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
