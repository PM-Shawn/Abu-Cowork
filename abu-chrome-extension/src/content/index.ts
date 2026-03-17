/**
 * Content Script — injected into web pages.
 *
 * Handles all DOM operations: snapshot, click, fill, wait, extract, etc.
 * Communicates with Background script via chrome.runtime.onMessage.
 */

import type { ElementInfo, ElementLocator } from '../shared/types.js';

// Max text size returned by extractText (50KB)
const MAX_EXTRACT_TEXT_SIZE = 50_000;
// Max interactive elements returned by snapshot
const MAX_SNAPSHOT_ELEMENTS = 200;

// --- Report visibility to background ---
function reportVisible(): void {
  if (document.visibilityState === 'visible') {
    chrome.runtime.sendMessage({ type: 'tab_visible' }).catch(() => {
      // Background not ready or extension context invalidated — ignore
    });
  }
}
document.addEventListener('visibilitychange', reportVisible);
reportVisible();

// --- Element Reference Map (populated by snapshot) ---
const refMap = new Map<string, Element>();
let refCounter = 0;

// --- Message Handler ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { action, payload } = message;

  handleAction(action, payload)
    .then((data) => sendResponse({ data }))
    .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));

  return true; // Keep message channel open for async response
});

async function handleAction(action: string, payload: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'snapshot': return takeSnapshot(payload.selector as string | undefined);
    case 'click': return clickElement(payload.locator as ElementLocator);
    case 'fill': return fillElement(payload.locator as ElementLocator, payload.value as string);
    case 'select': return selectOption(payload.locator as ElementLocator, payload.value as string);
    case 'wait_for': return waitFor(payload.condition as Record<string, unknown>, payload.timeout as number | undefined);
    case 'extract_text': return extractText(payload.selector as string | undefined);
    case 'extract_table': return extractTable(payload.selector as string | undefined);
    case 'scroll': return scrollPage(payload as Record<string, unknown>);
    case 'keyboard': return sendKeyboard(payload as Record<string, unknown>);
    case 'start_recording': return startRecording();
    case 'stop_recording': return stopRecording();
    case 'fullpage_prepare': return fullpagePrepare();
    case 'fullpage_scroll': return fullpageScroll(payload.scrollTop as number);
    case 'fullpage_restore': return fullpageRestore(payload.scrollX as number, payload.scrollY as number);
    default: throw new Error(`Unknown content action: ${action}`);
  }
}

// =============================================================================
// 1. SNAPSHOT — Structured page element extraction
// =============================================================================

function takeSnapshot(scopeSelector?: string): { url: string; title: string; elements: ElementInfo[] } {
  const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
  if (!root) throw new Error(`Scope element not found: ${scopeSelector}`);

  refMap.clear();
  refCounter = 0;

  const interactiveTags = new Set([
    'a', 'button', 'input', 'textarea', 'select', 'details', 'summary',
  ]);

  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'listbox', 'option', 'menuitem', 'tab', 'switch', 'slider',
  ]);

  const elements: ElementInfo[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

  let node: Node | null = walker.currentNode;
  while (node) {
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();

    const isInteractive =
      interactiveTags.has(tag) ||
      el.hasAttribute('onclick') ||
      el.hasAttribute('tabindex') ||
      (el.getAttribute('role') && interactiveRoles.has(el.getAttribute('role')!)) ||
      (el as HTMLElement).contentEditable === 'true' ||
      (tag === 'div' && el.getAttribute('role') && interactiveRoles.has(el.getAttribute('role')!));

    if (isInteractive && isVisible(el)) {
      const ref = `e${++refCounter}`;
      refMap.set(ref, el);

      const info: ElementInfo = {
        ref,
        tag,
        enabled: !(el as HTMLButtonElement).disabled,
        visible: true,
      };

      // Text content (truncated)
      const text = getVisibleText(el);
      if (text) info.text = text.slice(0, 100);

      // Input-specific
      if (tag === 'input') {
        const input = el as HTMLInputElement;
        info.type = input.type;
        if (input.placeholder) info.placeholder = input.placeholder;
        if (input.value) info.value = input.value.slice(0, 100);
        if (input.type === 'checkbox' || input.type === 'radio') {
          info.checked = input.checked;
        }
      }

      if (tag === 'textarea') {
        const ta = el as HTMLTextAreaElement;
        if (ta.placeholder) info.placeholder = ta.placeholder;
        if (ta.value) info.value = ta.value.slice(0, 200);
      }

      if (tag === 'select') {
        const select = el as HTMLSelectElement;
        info.options = [...select.options].map(o => ({ value: o.value, text: o.text }));
        info.value = select.value;
      }

      if (tag === 'a') {
        info.href = (el as HTMLAnchorElement).href;
      }

      // ARIA
      const role = el.getAttribute('role');
      if (role) info.role = role;
      const ariaLabel = el.getAttribute('aria-label');
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
    ...(truncated ? { truncated: true, message: `Showing first ${MAX_SNAPSHOT_ELEMENTS} elements. Use selector parameter to scope.` } : {}),
  };
}

// =============================================================================
// 2. ELEMENT LOCATOR — Multi-strategy element finding
// =============================================================================

/**
 * Escape a string for use in CSS attribute selectors.
 * Uses CSS.escape if available, otherwise a basic fallback.
 */
function escapeCSS(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) {
    return CSS.escape(value);
  }
  // Fallback: escape special chars
  return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function findElement(locator: ElementLocator): Element | null {
  // ref — from snapshot
  if (locator.ref) {
    const el = refMap.get(locator.ref);
    if (el && el.isConnected) return el;
    // Ref may be stale — fall through
  }

  // CSS selector
  if (locator.css) {
    return document.querySelector(locator.css);
  }

  // Text content
  if (locator.text) {
    const tag = locator.tag ?? '*';
    const candidates = document.querySelectorAll(tag);
    for (const el of candidates) {
      const text = getVisibleText(el);
      if (text && text.includes(locator.text) && isVisible(el)) {
        return el;
      }
    }
    return null;
  }

  // ARIA role + name — use CSS.escape to prevent selector injection
  if (locator.role) {
    const escapedRole = escapeCSS(locator.role);
    const selector = locator.name
      ? `[role="${escapedRole}"][aria-label="${escapeCSS(locator.name)}"]`
      : `[role="${escapedRole}"]`;
    return document.querySelector(selector);
  }

  // data-testid — escape to prevent injection
  if (locator.testId) {
    return document.querySelector(`[data-testid="${escapeCSS(locator.testId)}"]`);
  }

  // XPath
  if (locator.xpath) {
    const result = document.evaluate(locator.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue as Element | null;
  }

  throw new Error(`Invalid locator: ${JSON.stringify(locator)}`);
}

function findElementOrThrow(locator: ElementLocator): Element {
  const el = findElement(locator);
  if (!el) throw new Error(`Element not found: ${JSON.stringify(locator)}`);
  return el;
}

// =============================================================================
// 3. CLICK
// =============================================================================

function clickElement(locator: ElementLocator): { success: boolean; message: string; elementText?: string } {
  const el = findElementOrThrow(locator);
  const text = getVisibleText(el)?.slice(0, 50);

  // Scroll into view if needed
  el.scrollIntoView({ behavior: 'instant', block: 'center' });

  // Visual feedback
  highlightElement(el);
  showStatus(`Click: ${text ?? 'element'}`, 'info');

  // Dispatch full click sequence
  const htmlEl = el as HTMLElement;
  htmlEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  htmlEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  htmlEl.click();

  return {
    success: true,
    message: `Clicked element${text ? `: "${text}"` : ''}`,
    elementText: text ?? undefined,
  };
}

// =============================================================================
// 4. FILL
// =============================================================================

function fillElement(locator: ElementLocator, value: string): { success: boolean; message: string; previousValue?: string } {
  const el = findElementOrThrow(locator) as HTMLInputElement | HTMLTextAreaElement;
  const previousValue = el.value;

  highlightElement(el);
  showStatus(`Fill: "${value.slice(0, 30)}"`, 'info');

  // Use native setter to bypass React's synthetic event system
  const nativeSetter = Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value'
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.value = value;
  }

  // Trigger events for framework compatibility
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));

  return {
    success: true,
    message: `Filled field with "${value.slice(0, 50)}"`,
    previousValue: previousValue || undefined,
  };
}

// =============================================================================
// 5. SELECT
// =============================================================================

function selectOption(locator: ElementLocator, value: string): { success: boolean; message: string } {
  const el = findElementOrThrow(locator) as HTMLSelectElement;
  if (el.tagName.toLowerCase() !== 'select') {
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

  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true, message: `Selected option: "${value}"` };
}

// =============================================================================
// 6. WAIT FOR
// =============================================================================

async function waitFor(
  condition: Record<string, unknown>,
  timeout: number = 30000
): Promise<{ success: boolean; message: string; timedOut: boolean; elapsed: number }> {
  const start = Date.now();
  const condType = condition.type as string;

  const check = (): boolean => {
    switch (condType) {
      case 'appear': {
        const el = findElement(condition.locator as ElementLocator);
        return el !== null && isVisible(el);
      }
      case 'disappear': {
        const el = findElement(condition.locator as ElementLocator);
        return el === null || !isVisible(el);
      }
      case 'enabled': {
        const el = findElement(condition.locator as ElementLocator);
        return el !== null && isVisible(el) && !(el as HTMLButtonElement).disabled;
      }
      case 'textContains': {
        const el = findElement(condition.locator as ElementLocator);
        if (!el) return false;
        const text = getVisibleText(el) ?? '';
        return text.includes(condition.text as string);
      }
      case 'urlContains': {
        return location.href.includes(condition.pattern as string);
      }
      default:
        throw new Error(`Unknown wait condition: ${condType}`);
    }
  };

  // Fast check first
  if (check()) {
    return { success: true, message: `Condition met immediately`, timedOut: false, elapsed: 0 };
  }

  // Poll with MutationObserver + throttled interval fallback
  return new Promise((resolve) => {
    let resolved = false;
    let checkScheduled = false;

    const complete = (timedOut: boolean) => {
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
        elapsed,
      });
    };

    const tryCheck = () => {
      if (resolved) return;
      try {
        if (check()) complete(false);
      } catch {
        // Ignore transient DOM errors during check
      }
    };

    // MutationObserver for DOM changes — throttled to avoid flooding
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
      attributes: true,
    });

    // Interval fallback (for URL changes, computed styles, etc.)
    const pollTimer = setInterval(tryCheck, 500);

    // Timeout
    const timeoutTimer = setTimeout(() => complete(true), timeout);
  });
}

// =============================================================================
// 7. EXTRACT TEXT
// =============================================================================

function extractText(selector?: string): string {
  let text: string;
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  } else {
    text = document.body.innerText ?? '';
  }

  // Truncate to prevent sending megabytes through the message channel
  if (text.length > MAX_EXTRACT_TEXT_SIZE) {
    return text.slice(0, MAX_EXTRACT_TEXT_SIZE) + `\n\n[Truncated: ${text.length} chars total, showing first ${MAX_EXTRACT_TEXT_SIZE}]`;
  }
  return text;
}

// =============================================================================
// 8. EXTRACT TABLE
// =============================================================================

function extractTable(selector?: string): { headers: string[]; rows: string[][]; rowCount: number } {
  let table: HTMLTableElement | null;

  if (selector) {
    table = document.querySelector(selector) as HTMLTableElement;
  } else {
    const tables = [...document.querySelectorAll('table')] as HTMLTableElement[];
    table = tables.sort((a, b) => b.rows.length - a.rows.length)[0] ?? null;
  }

  if (!table) throw new Error('No table found on the page');

  const headers = [...(table.querySelectorAll('thead th, thead td') as NodeListOf<HTMLElement>)]
    .map(th => th.innerText?.trim() ?? '');

  if (headers.length === 0) {
    const firstRow = table.rows[0];
    if (firstRow) {
      for (const cell of firstRow.cells) {
        headers.push(cell.innerText?.trim() ?? '');
      }
    }
  }

  const rows: string[][] = [];
  const bodyRows = table.querySelectorAll('tbody tr');
  const rowElements = bodyRows.length > 0 ? bodyRows : table.rows;

  for (const tr of rowElements) {
    const row = [...(tr as HTMLTableRowElement).cells].map(td => (td as HTMLElement).innerText?.trim() ?? '');
    if (headers.length > 0 && row.join('') === headers.join('')) continue;
    rows.push(row);
  }

  return { headers, rows, rowCount: rows.length };
}

// =============================================================================
// 9. SCROLL
// =============================================================================

function scrollPage(payload: Record<string, unknown>): { success: boolean; message: string } {
  const direction = payload.direction as string;
  const amount = (payload.amount as number) ?? 500;
  const selector = payload.selector as string | undefined;

  const target = selector ? document.querySelector(selector) : window;
  if (selector && !target) throw new Error(`Scroll target not found: ${selector}`);

  const scrollOptions: Record<string, number> = {};

  switch (direction) {
    case 'down': scrollOptions.top = amount; break;
    case 'up': scrollOptions.top = -amount; break;
    case 'right': scrollOptions.left = amount; break;
    case 'left': scrollOptions.left = -amount; break;
  }

  if (target === window) {
    window.scrollBy({ ...scrollOptions, behavior: 'smooth' });
  } else {
    (target as Element).scrollBy({ ...scrollOptions, behavior: 'smooth' });
  }

  return { success: true, message: `Scrolled ${direction} by ${amount}px` };
}

// =============================================================================
// 10. KEYBOARD
// =============================================================================

function sendKeyboard(payload: Record<string, unknown>): { success: boolean; message: string } {
  const key = payload.key as string;
  const modifiers = (payload.modifiers as string[]) ?? [];

  const eventInit: KeyboardEventInit = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.includes('ctrl'),
    shiftKey: modifiers.includes('shift'),
    altKey: modifiers.includes('alt'),
    metaKey: modifiers.includes('meta'),
  };

  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  target.dispatchEvent(new KeyboardEvent('keyup', eventInit));

  // For printable characters, also dispatch an input event
  if (key.length === 1 && !modifiers.includes('ctrl') && !modifiers.includes('meta')) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.dispatchEvent(new InputEvent('beforeinput', {
        data: key,
        inputType: 'insertText',
        bubbles: true,
        cancelable: true,
      }));
      target.dispatchEvent(new InputEvent('input', {
        data: key,
        inputType: 'insertText',
        bubbles: true,
      }));
    }
  }

  return { success: true, message: `Key press: ${modifiers.length > 0 ? modifiers.join('+') + '+' : ''}${key}` };
}

// =============================================================================
// 11. RECORDING — Capture user interactions as replayable steps
// =============================================================================

interface RecordedStep {
  action: 'click' | 'fill' | 'select' | 'navigate';
  locator?: { css?: string; text?: string };
  value?: string;
  url?: string;
  timestamp: number;
}

let recording = false;
const recordedSteps: RecordedStep[] = [];
let recordClickHandler: ((e: MouseEvent) => void) | null = null;
let recordInputHandler: ((e: Event) => void) | null = null;

function getBestSelector(el: Element): { css?: string; text?: string } {
  // Try ID first
  if (el.id) return { css: `#${CSS.escape(el.id)}` };
  // Try data-testid
  const testId = el.getAttribute('data-testid');
  if (testId) return { css: `[data-testid="${CSS.escape(testId)}"]` };
  // Try aria-label
  const label = el.getAttribute('aria-label');
  if (label) return { text: label };
  // Try visible text (for buttons/links)
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a') {
    const text = (el as HTMLElement).innerText?.trim();
    if (text && text.length < 50) return { text };
  }
  // Fallback: build a CSS path
  const path: string[] = [];
  let current: Element | null = el;
  for (let i = 0; i < 3 && current && current !== document.body; i++) {
    let seg = current.tagName.toLowerCase();
    if (current.className && typeof current.className === 'string') {
      const cls = current.className.trim().split(/\s+/).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
      seg += cls;
    }
    path.unshift(seg);
    current = current.parentElement;
  }
  return { css: path.join(' > ') };
}

function startRecording(): { success: boolean; message: string } {
  if (recording) return { success: false, message: 'Already recording' };
  recording = true;
  recordedSteps.length = 0;

  recordClickHandler = (e: MouseEvent) => {
    const el = e.target as Element;
    if (!el || el.id === 'abu-status' || el.id === 'abu-highlight') return;
    recordedSteps.push({
      action: 'click',
      locator: getBestSelector(el),
      timestamp: Date.now(),
    });
  };

  recordInputHandler = (e: Event) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      recordedSteps.push({
        action: 'select',
        locator: getBestSelector(el),
        value: (el as HTMLSelectElement).value,
        timestamp: Date.now(),
      });
    } else if (tag === 'input' || tag === 'textarea') {
      // Debounce: update last step if same element
      const last = recordedSteps[recordedSteps.length - 1];
      const loc = getBestSelector(el);
      if (last && last.action === 'fill' && JSON.stringify(last.locator) === JSON.stringify(loc)) {
        last.value = el.value;
        last.timestamp = Date.now();
      } else {
        recordedSteps.push({
          action: 'fill',
          locator: loc,
          value: el.value,
          timestamp: Date.now(),
        });
      }
    }
  };

  document.addEventListener('click', recordClickHandler, true);
  document.addEventListener('change', recordInputHandler, true);

  showStatus('Recording started...', 'info');
  return { success: true, message: `Recording started. Interact with the page, then call stop_recording to get the steps.` };
}

function stopRecording(): { success: boolean; steps: RecordedStep[]; message: string } {
  if (!recording) return { success: false, steps: [], message: 'Not recording' };
  recording = false;

  if (recordClickHandler) {
    document.removeEventListener('click', recordClickHandler, true);
    recordClickHandler = null;
  }
  if (recordInputHandler) {
    document.removeEventListener('change', recordInputHandler, true);
    recordInputHandler = null;
  }

  showStatus(`Recording stopped: ${recordedSteps.length} steps`, 'success');
  return {
    success: true,
    steps: [...recordedSteps],
    message: `Recorded ${recordedSteps.length} steps. Use these as a template for automation.`,
  };
}

// =============================================================================
// 12. FULL-PAGE SCREENSHOT — prepare/scroll/restore for scroll-and-stitch
// =============================================================================

/**
 * Elements whose position was temporarily overridden during full-page capture.
 * Stored as [element, originalPosition, originalTop] tuples for restoration.
 */
let savedFixedElements: [HTMLElement, string, string][] = [];

/**
 * Prepare for full-page screenshot:
 * 1. Record current scroll position
 * 2. Measure full page dimensions
 * 3. Hide fixed/sticky elements (except on first viewport) to avoid duplication
 */
function fullpagePrepare(): {
  scrollHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  scrollX: number;
  scrollY: number;
} {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const scrollHeight = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  );

  // Find and hide fixed/sticky elements to prevent them repeating in every slice
  savedFixedElements = [];
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    const htmlEl = el as HTMLElement;
    const style = getComputedStyle(htmlEl);
    if (style.position === 'fixed' || style.position === 'sticky') {
      // Skip tiny elements (likely not headers/navbars)
      const rect = htmlEl.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 10) continue;
      savedFixedElements.push([htmlEl, style.position, htmlEl.style.top]);
      htmlEl.style.setProperty('position', 'absolute', 'important');
    }
  }

  return { scrollHeight, viewportHeight, viewportWidth, scrollX, scrollY };
}

/**
 * Scroll to a specific Y position (instant, no animation).
 */
function fullpageScroll(scrollTop: number): { success: boolean } {
  window.scrollTo({ top: scrollTop, left: 0, behavior: 'instant' as ScrollBehavior });
  return { success: true };
}

/**
 * Restore state after full-page capture:
 * 1. Restore fixed/sticky elements
 * 2. Restore original scroll position
 */
function fullpageRestore(scrollX: number, scrollY: number): { success: boolean } {
  // Restore fixed/sticky elements
  for (const [el, originalPosition, originalTop] of savedFixedElements) {
    el.style.position = originalPosition;
    el.style.top = originalTop;
  }
  savedFixedElements = [];

  // Restore scroll position
  window.scrollTo({ top: scrollY, left: scrollX, behavior: 'instant' as ScrollBehavior });
  return { success: true };
}

// =============================================================================
// VISUAL FEEDBACK — highlight elements during operations
// =============================================================================

let highlightOverlay: HTMLDivElement | null = null;

function highlightElement(el: Element): void {
  const rect = el.getBoundingClientRect();
  if (!highlightOverlay) {
    highlightOverlay = document.createElement('div');
    highlightOverlay.id = 'abu-highlight';
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
  highlightOverlay.style.display = 'block';
  highlightOverlay.style.opacity = '1';

  // Fade out after 1.5s
  setTimeout(() => {
    if (highlightOverlay) {
      highlightOverlay.style.opacity = '0';
      setTimeout(() => { if (highlightOverlay) highlightOverlay.style.display = 'none'; }, 300);
    }
  }, 1500);
}

// =============================================================================
// FLOATING STATUS INDICATOR
// =============================================================================

let statusBubble: HTMLDivElement | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function showStatus(text: string, type: 'info' | 'success' | 'error' = 'info'): void {
  if (!statusBubble) {
    statusBubble = document.createElement('div');
    statusBubble.id = 'abu-status';
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
    info:    { bg: '#1a1a2e', border: '#d97757', text: '#e0e0e0' },
    success: { bg: '#0f2a1a', border: '#4ade80', text: '#4ade80' },
    error:   { bg: '#2a0f0f', border: '#f87171', text: '#f87171' },
  };
  const c = colors[type];
  statusBubble.style.background = c.bg;
  statusBubble.style.border = `1px solid ${c.border}`;
  statusBubble.style.color = c.text;
  statusBubble.textContent = `Abu: ${text}`;
  statusBubble.style.opacity = '1';
  statusBubble.style.transform = 'translateY(0)';

  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    if (statusBubble) {
      statusBubble.style.opacity = '0';
      statusBubble.style.transform = 'translateY(8px)';
    }
  }, 3000);
}

// =============================================================================
// UTILITIES
// =============================================================================

function isVisible(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  if (htmlEl.offsetParent === null && htmlEl.style?.position !== 'fixed' && htmlEl.style?.position !== 'sticky') {
    const style = getComputedStyle(htmlEl);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getVisibleText(el: Element): string | null {
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    return input.value || input.placeholder || input.getAttribute('aria-label') || null;
  }
  if (el.tagName === 'TEXTAREA') {
    const ta = el as HTMLTextAreaElement;
    return ta.value || ta.placeholder || null;
  }

  const text = (el as HTMLElement).innerText?.trim();
  return text || el.getAttribute('aria-label') || null;
}
