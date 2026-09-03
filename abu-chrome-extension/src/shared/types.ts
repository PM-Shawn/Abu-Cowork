/**
 * Shared types for Abu Browser Bridge communication protocol.
 *
 * Single source of truth — imported by both:
 *   - abu-browser-bridge (MCP server)
 *   - abu-chrome-extension (Chrome Extension)
 */

// --- Bridge Messages (WS protocol between Bridge and Extension) ---

export interface BridgeRequest {
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface BridgeResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Sent Bridge → Extension when the caller aborts before a response for
 * `requestId` arrived. The extension is not required to act on it (this PR
 * only asks it not to crash on an unrecognized message shape); it exists so a
 * future extension version can stop in-flight work early.
 */
export interface BridgeCancelMessage {
  type: 'cancel';
  requestId: string;
}

// --- Element Locator (multi-strategy targeting) ---
// All fields optional — only one strategy should be specified per locator.

export interface ElementLocator {
  css?: string;
  text?: string;
  tag?: string;
  role?: string;
  name?: string;
  xpath?: string;
  testId?: string;
  ref?: string; // Reference ID from a previous snapshot (e.g., "e1")
}

// --- Snapshot (structured page representation for LLM) ---

export interface ElementInfo {
  ref: string;          // Short reference ID (e.g., "e1", "e2"); stable across snapshots
  tag: string;          // HTML tag name
  id?: string;          // DOM id, when present — lets a caller build a durable css locator
  name?: string;        // name attribute, when present
  type?: string;        // Input type (for input elements)
  text?: string;        // Visible text content (truncated)
  placeholder?: string;
  value?: string;
  href?: string;
  role?: string;
  ariaLabel?: string;
  enabled: boolean;
  visible: boolean;
  checked?: boolean;
  selected?: boolean;
  options?: { value: string; text: string }[]; // For select elements
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementInfo[];
  /** Set when the element list was cut short; `message` says why and how to narrow. */
  truncated?: boolean;
  message?: string;
}

// --- Wait Conditions ---

export type WaitCondition =
  | { type: 'appear'; locator: ElementLocator; timeout?: number }
  | { type: 'disappear'; locator: ElementLocator; timeout?: number }
  | { type: 'enabled'; locator: ElementLocator; timeout?: number }
  | { type: 'textContains'; locator: ElementLocator; text: string; timeout?: number }
  | { type: 'urlContains'; pattern: string; timeout?: number };

// --- Tab Info ---

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  focused: boolean;
  windowId: number;
  windowFocused: boolean;
}

// --- Login walls and dead ends (U6 / PRD F2.4 + F2.5) ---

/**
 * A step no automation can complete, only a person can. Detected from PAGE
 * FEATURES only — never from model text, and never as an authorization input
 * (see the detection module's doc in `content/index.ts`).
 */
export type PageHandoffKind =
  | 'captcha'
  | 'qr_login'
  | 'sms_code'
  | 'mfa_push'
  | 'wechat_external_link'
  | 'oauth_popup';

export interface PageHandoff {
  kind: PageHandoffKind;
  /** LLM-facing English: what the human has to do, and why not to retry. */
  hint: string;
}

/**
 * Advisory fields any action result may carry. Both keys are OMITTED when
 * nothing was detected, so a healthy page's result keeps the exact shape it
 * had before this existed.
 */
export interface PageAdvisory {
  authState?: 'login_required';
  handoff?: PageHandoff;
}

// --- Action Results ---

/** What an action actually acted on — lets a caller spot a wrong target. */
export interface ActionTarget {
  ref: string;
  tag: string;
  id?: string;
  role?: string;
  text?: string;
}

export interface ClickResult {
  success: boolean;
  message: string;
  elementText?: string;
  /** The element the click actually landed on. */
  target?: ActionTarget;
}

export interface FillResult {
  success: boolean;
  message: string;
  previousValue?: string;
}

export interface WaitResult {
  success: boolean;
  message: string;
  timedOut: boolean;
  elapsed: number; // ms
}

export interface ExtractTableResult {
  headers: string[];
  rows: string[][];
  rowCount: number;
}
