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

// --- Find (read-only semantic search over the page) ---
//
// Distinct from `ElementLocator` on purpose. A locator names ONE element and
// is refused when it names more; a query describes what to look for and is
// expected to come back with several. `label` and `placeholder` exist here and
// not there for the same reason: they are how a person describes a form field
// they are looking for, not how a caller pins the one it has already found.

export interface FindQuery {
  role?: string;
  name?: string;
  text?: string;
  css?: string;
  testId?: string;
  /** Text of the field's native `<label>` (for/id or wrapping). */
  label?: string;
  placeholder?: string;
}

export interface FindMatch {
  ref: string;
  tag: string;
  id?: string;
  /** Explicit `role=` or the native implicit role. */
  role?: string;
  /**
   * Accessible name, by the same six-source fallback the locator uses — what
   * `{role, name}` matches against.
   *
   * Deliberately NOT called `name`: `ElementInfo.name` (what `snapshot`
   * returns) is the HTML `name` ATTRIBUTE, a different thing entirely. One
   * field name meaning two things across the pair of tools a model uses back
   * to back is how `{role:"textbox", name:"username"}` comes to be written
   * from a snapshot and answered with "not found" — the accessible name was
   * "用户名", in the <label>.
   */
  accessibleName?: string;
  /** Visible text, when it differs from the accessible name. */
  text?: string;
  /** Has a layout box. `false` = on the page but collapsed, still addressable. */
  visible: boolean;
  interactive: boolean;
  disabled?: true;
  rect: { x: number; y: number; width: number; height: number };
}

export interface FindResult {
  url: string;
  title: string;
  matches: FindMatch[];
  /** Total matches before `limit` — `matches.length` when nothing was cut. */
  total: number;
  truncated?: boolean;
  message?: string;
}

// --- Snapshot (structured page representation for LLM) ---

export interface ElementInfo {
  ref: string;          // Short reference ID (e.g., "e1", "e2"); stable across snapshots
  tag: string;          // HTML tag name
  id?: string;          // DOM id, when present — lets a caller build a durable css locator
  name?: string;        // the HTML `name` ATTRIBUTE — not the accessible name (see FindMatch.accessibleName)
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

// --- Batch (one ordered run of several actions against ONE page) ---
//
// A batch is a TRANSPORT, not a new authority: every step is the same single
// action the caller could have sent on its own, and the orchestrator
// (`abu-browser-bridge/src/tools.ts`) dispatches them one at a time so each
// keeps the guards that already wrap it — the user-takeover backoff, the 429
// backoff, the user-reclaim refusal, tab resolution and the abort signal.
// That is also why page scripting has no step type here: `execute_js` is
// approved run by run, and a step type for it would let one approval buy many
// runs.

export type BatchStepType =
  | 'fill'
  | 'select'
  | 'click'
  | 'keyboard'
  | 'wait_for'
  | 'find'
  | 'read';

export interface BatchStep {
  action: BatchStepType;
  /** fill / select / click */
  locator?: ElementLocator;
  /** fill / select */
  value?: string;
  /** keyboard */
  key?: string;
  modifiers?: string[];
  /** wait_for */
  condition?: WaitCondition;
  timeout?: number;
  /** find */
  query?: FindQuery;
  limit?: number;
  /** read (extract_text) */
  selector?: string;
}

export interface BatchStepOutcome {
  /** 0-based position in the submitted step list. */
  index: number;
  action: BatchStepType;
  ok: boolean;
  durationMs: number;
  /** The single action's own result, verbatim; dropped when the batch is trimmed. */
  result?: unknown;
  /** Set when `result` was cut to keep the batch within its size budget. */
  resultTruncated?: true;
  error?: string;
}

/** Why the run stopped before the last step. Absent ⇒ every step ran. */
export type BatchStopReason =
  | 'step-failed'
  /** The tab left the origin the batch was authorized against. */
  | 'origin-changed'
  /** The tab's current origin could not be read, so it could not be checked. */
  | 'origin-unverifiable'
  | 'time-limit';

export interface BatchResult {
  tabId: number;
  /** The origin every step was verified against before it ran. */
  origin: string | null;
  completedSteps: BatchStepOutcome[];
  failedStep?: BatchStepOutcome;
  /** How many submitted steps never ran. */
  remainingSteps: number;
  stopped?: BatchStopReason;
  /** Set when step results were dropped to stay inside the size budget. */
  truncated?: true;
  message: string;
}
