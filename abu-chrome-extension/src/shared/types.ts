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

/**
 * Sent Bridge → Extension when the run that was driving the browser has
 * stopped, so the extension can drop the task-level tab claims that run holds
 * (`abu-chrome-extension/src/background/tabClaims.ts`). Without it a finished
 * task keeps its claim and the next task is refused a tab nobody is using any
 * more.
 *
 * Scope mirrors the built-in host's `browser_dispose_owner`: with `runId`,
 * exactly that subagent run; without it, every run of the conversation. An
 * extension that does not recognise the message ignores it — releasing is
 * best-effort, and a tab closing or the socket dropping clears the claim too.
 */
export interface BridgeReleaseMessage {
  type: 'release';
  ownerId: string;
  runId?: string;
}

// --- MCP notification (Abu client → Bridge) ---

/**
 * MCP notification method the Abu desktop client sends to the BRIDGE when one
 * agent run settles — whether it finished on its own or the user stopped it.
 * The bridge answers it by releasing that run's tab claims, i.e. by sending
 * the `BridgeReleaseMessage` above on to the extension.
 *
 * Why a notification and not a tool: every tool is listed to the model, and a
 * model-callable "release" would invite one task to free a tab another task is
 * driving. Nothing about this method reaches the model. It is also not a
 * per-request signal — the bridge deliberately does NOT treat a request abort
 * as a run ending, because the MCP SDK aborts handlers for its own request
 * timeouts too (see the long note in `abu-browser-bridge/src/wsServer.ts`).
 *
 * The built-in browser host has the equivalent channel already, over Electron
 * IPC (`browser_dispose_owner`); this bridge is a separate stdio MCP process
 * with no IPC to the app, so the MCP connection it already has is the channel.
 */
export const ABU_RUN_SETTLED_NOTIFICATION = 'notifications/abu/runSettled';

/**
 * Params of `ABU_RUN_SETTLED_NOTIFICATION`.
 *
 * `runId` is REQUIRED on the wire, unlike `BridgeReleaseMessage.runId`. Tab
 * ownership is the pair `{ownerId, runId}` and a run's settlement releases
 * that run only — the conversation-wide scope (the release message's omitted
 * `runId`) belongs to conversation deletion, and a run settling must never
 * reach for it, or one delegation ending would strip its siblings and the
 * conversation's own loop of tabs they are still driving. A receiver that gets
 * this notification without a usable `runId` therefore reads it as the run key
 * `main` — the same "absent ⇒ the conversation's own loop" convention
 * `abu/runKey` uses everywhere else in this protocol — and never as
 * "every run".
 */
export interface RunSettledNotificationParams {
  ownerId: string;
  runId: string;
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
