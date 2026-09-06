/**
 * `batch` — one ordered run of several actions against ONE page.
 *
 * ## Why the orchestration lives here and not in the page
 *
 * The obvious shape is a new `batch` wire action handed to the content script,
 * which then loops. It does not work, for two reasons that are both about
 * losing guards the single actions already have:
 *
 *  1. `keyboard` is NOT a content-script action on the built-in browser.
 *     `electron/browserHost.cjs` answers it natively (`keyboardAutomation`,
 *     via `webContents.sendInputEvent`) and it is deliberately absent from
 *     that file's `domActions` set. A content-side loop could not perform a
 *     keyboard step there at all.
 *  2. The user-takeover backoff (`awaitUserIdle`, 3s of quiet), the HTTP 429
 *     per-origin backoff and the user-reclaim refusal are all applied ONCE per
 *     wire action, in the Electron main process, before the action reaches the
 *     page. One `batch` action would pass those gates once and then perform N
 *     page actions behind them — the user starts typing mid-batch and the
 *     automation keeps typing over them.
 *
 * Dispatching each step as its own ordinary wire action keeps every one of
 * those guards, on both channels, with no logic copied: a `click` step IS the
 * `click` action. What this module adds is only what a batch needs beyond a
 * single action — the ordering, the page-identity check between steps, and
 * stopping at the first failure.
 *
 * ## What a batch is not
 *
 * It is not a new authority. The permission gate
 * (`src/core/permissions/browserToolPolicy.ts` + `src/core/tools/registry.ts`)
 * classifies a batch by its HEAVIEST step and asks once for the whole run, at
 * the pinned origin. Page scripting therefore has no step type: `execute_js`
 * is approved run by run, and a scripting step would let one approval buy many
 * runs. A batch carrying one is refused whole, here and independently at the
 * gate.
 */

import type {
  BatchResult,
  BatchStep,
  BatchStepOutcome,
  BatchStepType,
  BatchStopReason,
} from './types.js';
import {
  validateCondition,
  validateFindQuery,
  validateFrameId,
  validateKeyboardModifiers,
  validateLocator,
} from './locators.js';

/** One approval must not buy an unbounded run. */
export const MAX_BATCH_STEPS = 25;

/**
 * Wall-clock ceiling for the whole run. A batch of `wait_for`s could otherwise
 * sit on 25 × 30s of timeouts under a single approval while the user watches
 * nothing happen.
 *
 * Enforced in TWO places, because between-steps alone was not a ceiling (F4,
 * 2026-09-06 review): the loop checks it before each step, AND a `wait_for`
 * step's own deadline is clamped to what is left of it. Without the clamp a
 * single `{action:'wait_for', timeout: 3_600_000}` ran for an hour under this
 * constant's own promise — the between-steps check never fired, because there
 * was no next step for it to run before. The single-action `wait_for` tool has
 * no upper bound on its `timeout`; that is its own pre-existing behaviour and
 * its own approval. What this fixes is a BATCH advertising a bound it did not
 * have.
 */
export const MAX_BATCH_DURATION_MS = 120_000;

/**
 * Size budget for the serialized result, mirroring `find`'s: a step's result
 * can be a whole `find` payload (16k) or an `extract_text` (20k), so 25 of
 * them would sail past `truncation.ts`'s character slicer and come back as
 * shredded JSON. Bounded HERE, with a message, and `MCP_TOOL_RULES.batch` is
 * set to the same number so the slicer never gets to re-cut it.
 */
export const MAX_BATCH_CHARS = 32_000;

/** Per-step share of that budget, before the envelope-level trim runs. */
export const MAX_BATCH_STEP_RESULT_CHARS = 4_000;

/**
 * Step type → the wire action it dispatches.
 *
 * `src/core/tools/browserToolRouting.test.ts` checks that every step action is
 * routed on BOTH channels — an unrouted step type answers `Unknown action`
 * halfway through a run the user already approved — but it does NOT read this
 * table: it derives the list from a real `runBatch`, which is stronger,
 * because a table that drifted from what the runner dispatches would still
 * agree with itself. Exported for readers and for a caller that wants the
 * mapping; nothing outside this module depends on it.
 */
export const BATCH_STEP_ACTIONS: Readonly<Record<BatchStepType, string>> = {
  fill: 'fill',
  select: 'select',
  click: 'click',
  keyboard: 'keyboard',
  wait_for: 'wait_for',
  find: 'find',
  read: 'extract_text',
};

/**
 * Steps that only look at the page. Two or more in a row are dispatched
 * together; nothing else ever is. Note `wait_for` is read-only but NOT here —
 * a wait is about when it happens, and running it alongside its neighbours
 * would change what it is waiting for.
 */
const PARALLEL_READ_ACTIONS: ReadonlySet<BatchStepType> = new Set(['find', 'read']);

const STEP_TYPES = Object.keys(BATCH_STEP_ACTIONS) as BatchStepType[];

/** Named so the refusal the model reads names the fix, not just the problem. */
const SCRIPTING_STEP_TYPES = new Set(['execute_js', 'query_js', 'script', 'eval']);

export const BATCH_SCRIPT_STEP_ERROR =
  'A batch may not run page scripts. Scripts act with the page\'s full authority and are '
  + 'approved one run at a time, so allowing one inside a batch would let a single approval buy '
  + 'many runs. Remove the script step and call execute_js (or query_js) on its own.';

export const BATCH_NAVIGATE_STEP_ERROR =
  'A batch may not navigate. Every step of a batch is checked against the page the batch was '
  + 'approved for; a navigation step would move the run to another page under that same approval. '
  + 'Split the run: batch up to the navigation, call navigate, then start a new batch.';

function stepTypeError(type: string): string {
  return `Unknown batch step "${type}". Steps must be one of: ${STEP_TYPES.join(', ')}.`;
}

/**
 * Decode and validate the `steps` argument.
 *
 * Accepts the JSON string the tool schema asks for, or an already-decoded
 * array (which is what the permission gate hands its own copy of this check).
 * Throws — a batch that cannot be read is refused whole, never partially run.
 */
export function parseBatchSteps(raw: unknown): BatchStep[] {
  const decoded = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(decoded)) {
    throw new Error('Batch steps must be a JSON array of step objects.');
  }
  if (decoded.length === 0) {
    throw new Error('A batch needs at least one step.');
  }
  if (decoded.length > MAX_BATCH_STEPS) {
    throw new Error(
      `A batch may contain at most ${MAX_BATCH_STEPS} steps; this one has ${decoded.length}. `
      + 'Split it into several batches.',
    );
  }
  return decoded.map((raw, index) => {
    try {
      return validateStep(raw);
    } catch (err) {
      throw new Error(
        `Step ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`\`${field}\` must be a non-empty string.`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`\`${field}\` must be a positive number of milliseconds.`);
  }
  return value;
}

function validateStep(raw: unknown): BatchStep {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('each step must be a JSON object.');
  }
  const step = raw as Record<string, unknown>;
  const action = step.action;
  if (typeof action !== 'string') {
    throw new Error('`action` must be a string.');
  }
  if (SCRIPTING_STEP_TYPES.has(action)) throw new Error(BATCH_SCRIPT_STEP_ERROR);
  if (action === 'navigate') throw new Error(BATCH_NAVIGATE_STEP_ERROR);
  if (!STEP_TYPES.includes(action as BatchStepType)) throw new Error(stepTypeError(action));
  const type = action as BatchStepType;

  // Which document the step acts in. `keyboard` is deliberately excluded: it
  // sends to whatever holds focus rather than to a located element, so a frame
  // handle there would promise a targeting this layer does not do.
  const frame = validateFrameId(step.frameId);
  if (frame !== undefined && type === 'keyboard') {
    throw new Error(
      'a `keyboard` step takes no `frameId` — it goes to whatever has focus. '
      + 'Click into the region first, then send the key.',
    );
  }
  const inFrame = frame !== undefined ? { frameId: frame } : {};

  switch (type) {
    case 'fill':
    case 'select':
      return {
        action: type,
        ...inFrame,
        locator: validateLocator(step.locator) as BatchStep['locator'],
        value: requireString(step.value, 'value'),
      };
    case 'click':
      return { action: type, ...inFrame, locator: validateLocator(step.locator) as BatchStep['locator'] };
    case 'keyboard':
      return {
        action: type,
        key: requireString(step.key, 'key'),
        // The same whitelist the single-action tool's zod enum is built from,
        // not a second "any non-empty string" parser — see `KEYBOARD_MODIFIERS`.
        ...(step.modifiers !== undefined
          ? { modifiers: validateKeyboardModifiers(step.modifiers) }
          : {}),
      };
    case 'wait_for':
      return {
        action: type,
        ...inFrame,
        condition: validateCondition(step.condition) as BatchStep['condition'],
        // A positive, finite number or nothing. `typeof x === 'number'` alone
        // let `Infinity` and `NaN` through, and both reached `runStep`'s
        // `timeout + 5000` — one as an infinite transport deadline, the other
        // as a NaN one.
        ...(step.timeout !== undefined
          ? { timeout: requirePositiveNumber(step.timeout, 'timeout') }
          : {}),
      };
    case 'find':
      return {
        action: type,
        ...inFrame,
        query: validateFindQuery(step.query) as BatchStep['query'],
        ...(typeof step.limit === 'number' ? { limit: step.limit } : {}),
      };
    case 'read':
      return {
        action: type,
        ...inFrame,
        ...(typeof step.selector === 'string' ? { selector: step.selector } : {}),
      };
  }
}

/**
 * The payload one step sends, minus the owner fields the caller merges in.
 *
 * `pinnedOrigin` is the origin THIS step must be checked against at the point
 * it executes, and it is not always the page's. A step aimed into an embedded
 * region runs inside that region's document, where the runtime's own
 * `assertOriginPin` compares against `location` — so a step carrying the
 * PAGE's origin into a third-party region is refused every time, which is how
 * a cross-region batch used to fail on its first step (round-2 F1). The caller
 * merges the owner fields UNDER this payload for the same reason: whatever pin
 * rode `_meta` for the batch as a whole must not overwrite the per-step one.
 */
export function batchStepPayload(
  step: BatchStep,
  tabId: number,
  pinnedOrigin?: string,
): Record<string, unknown> {
  const inFrame = step.frameId !== undefined ? { frameId: step.frameId } : {};
  const pin = pinnedOrigin !== undefined ? { expectedOrigin: pinnedOrigin } : {};
  switch (step.action) {
    case 'fill':
    case 'select':
      return { tabId, ...inFrame, ...pin, locator: step.locator, value: step.value };
    case 'click':
      return { tabId, ...inFrame, ...pin, locator: step.locator };
    case 'keyboard':
      return { tabId, key: step.key, modifiers: step.modifiers };
    case 'wait_for':
      return { tabId, ...inFrame, ...pin, condition: step.condition, timeout: step.timeout };
    case 'find':
      return { tabId, ...inFrame, ...pin, query: step.query, limit: step.limit };
    case 'read':
      return { tabId, ...inFrame, ...pin, selector: step.selector };
  }
}

/**
 * Origin of a tab URL, by the same rules as the host gate's
 * `normalizeBrowserOrigin` (`src/core/permissions/browserToolPolicy.ts`): a
 * FQDN trailing dot collapses onto the same key, non-http(s) pages have no
 * origin worth pinning. The two live in separate packages and cannot import
 * each other; `src/core/tools/browserBatchContract.test.ts` pins them to the
 * same answers, because a batch that pinned a DIFFERENT origin than the one
 * the gate approved would be checking the wrong thing.
 */
export function batchOrigin(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname.endsWith('.')
      ? parsed.hostname.slice(0, -1)
      : parsed.hostname;
    if (!hostname) return null;
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${hostname}${port}`;
  } catch {
    return null;
  }
}

export interface BatchSend {
  (action: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>;
}

export interface BatchDeps {
  send: BatchSend;
  /** Injected so tests do not depend on the wall clock (TESTING.md §3). */
  now: () => number;
}

interface TabRow {
  tabId?: number;
  url?: string;
  frames?: Array<{ frameId?: string; origin?: string | null; accessible?: boolean }>;
}

/** Pull one tab's row out of a `get_tabs` response, whatever its shape. */
function tabRowFrom(data: unknown, tabId: number): TabRow | null {
  const parsed = typeof data === 'string' ? safeJson(data) : data;
  const windows = (parsed as { windows?: Array<{ tabs?: TabRow[] }> })?.windows;
  if (!Array.isArray(windows)) return null;
  for (const win of windows) {
    for (const tab of win?.tabs ?? []) {
      if (tab?.tabId === tabId) return tab;
    }
  }
  return null;
}

/** Pull the tab's current URL out of a `get_tabs` response, whatever its shape. */
function tabUrlFrom(data: unknown, tabId: number): string | null {
  const url = tabRowFrom(data, tabId)?.url;
  return typeof url === 'string' ? url : null;
}

/**
 * Each addressable region's CURRENT origin, from the same listing the tab's
 * own origin came from.
 *
 * Only `accessible` regions are read: on a region this channel cannot see
 * into, the reported origin is a hint the embedding page could author, and the
 * shared type is explicit that only an accessible frame's origin is
 * browser-authoritative. A step aimed at an inaccessible region therefore has
 * no verifiable origin and stops the run, which is the right answer — that
 * step could not have run anyway.
 */
function frameOriginsFrom(data: unknown, tabId: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const frame of tabRowFrom(data, tabId)?.frames ?? []) {
    if (!frame || frame.accessible !== true) continue;
    if (typeof frame.frameId !== 'string' || typeof frame.origin !== 'string') continue;
    out[frame.frameId] = frame.origin;
  }
  return out;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The tab's origin right now.
 *
 * `createIfEmpty: false` keeps this read-only: the host's `get_tabs`
 * provisions an automation view when the caller owns none, and a check that
 * runs between two steps must never be the thing that opens a tab.
 */
/**
 * The tab's origin, and — when the batch has frame-targeted steps — the
 * current origin of every addressable region.
 *
 * `framesForTabId` is what makes the listing carry the frame tree; without it
 * a listing over every tab would pay a browser round trip per tab for
 * information almost no caller wants.
 */
async function readTab(
  deps: BatchDeps,
  tabId: number,
  wantFrames: boolean,
): Promise<{ origin: string | null; frameOrigins: Record<string, string> }> {
  const res = await deps.send('get_tabs', {
    createIfEmpty: false,
    ...(wantFrames ? { framesForTabId: tabId } : {}),
  });
  if (!res.success) return { origin: null, frameOrigins: {} };
  return {
    origin: batchOrigin(tabUrlFrom(res.data, tabId)),
    frameOrigins: wantFrames ? frameOriginsFrom(res.data, tabId) : {},
  };
}

function stopMessage(reason: BatchStopReason, ran: number, total: number, pinned: string | null): string {
  const progress = `${ran} of ${total} steps ran`;
  switch (reason) {
    case 'step-failed':
      return `Batch stopped: ${progress}, and the next one failed. Nothing after it was attempted — `
        + 'read `failedStep.error`, re-read the page, and send a new batch for what is left.';
    case 'origin-changed':
      return `Batch stopped: ${progress}, then the tab left ${pinned ?? 'the page this batch was approved for'}. `
        + 'The remaining steps were NOT run on the new page — this batch was authorized for the old one. '
        + 'Check where the tab went, then decide what to do there.';
    case 'origin-unverifiable':
      return `Batch stopped: ${progress}, then the tab's current address could not be read, so the next step `
        + 'could not be checked against the page this batch was approved for. Call get_tabs and try again.';
    case 'frame-origin-changed':
      return `Batch stopped: ${progress}, then the embedded region the next step targets was no longer showing `
        + 'the site it was authorized for — it reloaded, navigated, or was replaced. The remaining steps were '
        + 'NOT run: an approval for one region does not carry over to whatever took its place. Take a fresh '
        + 'snapshot to re-read the regions, then send a new batch.';
    case 'time-limit':
      return `Batch stopped: ${progress} before hitting the ${Math.round(MAX_BATCH_DURATION_MS / 1000)}s limit `
        + 'for one batch. Send the rest as another batch.';
  }
}

/** Serialized size of a result, the way the bridge puts it on the wire. */
function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value, null, 2)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function capStepResult(outcome: BatchStepOutcome): BatchStepOutcome {
  let capped = outcome;
  if (capped.error !== undefined && capped.error.length > MAX_BATCH_STEP_RESULT_CHARS) {
    capped = {
      ...capped,
      error: `${capped.error.slice(0, MAX_BATCH_STEP_RESULT_CHARS)}…[cut]`,
      resultTruncated: true,
    };
  }
  if (capped.result === undefined) return capped;
  if (sizeOf(capped.result) <= MAX_BATCH_STEP_RESULT_CHARS) return capped;
  return {
    ...capped,
    result: `[cut: this step's result was larger than ${MAX_BATCH_STEP_RESULT_CHARS} characters. `
      + `Re-read it on its own with ${BATCH_STEP_ACTIONS[capped.action]}.]`,
    resultTruncated: true,
  };
}

/**
 * Drop step results, oldest first, until the whole envelope fits. Oldest
 * first because the caller most needs the end of the run — the failure and
 * what immediately preceded it.
 */
function fitEnvelope(result: BatchResult): BatchResult {
  if (sizeOf(result) <= MAX_BATCH_CHARS) return result;
  const completed = result.completedSteps.map((step) => ({ ...step }));
  for (const step of completed) {
    if (sizeOf({ ...result, completedSteps: completed }) <= MAX_BATCH_CHARS) break;
    if (step.result === undefined) continue;
    delete step.result;
    step.resultTruncated = true;
  }
  return {
    ...result,
    completedSteps: completed,
    truncated: true,
    message: `${result.message} Some step results were dropped to stay within the size budget; `
      + 're-read what you need with find or extract_text.',
  };
}

/**
 * Run the steps in order against one tab, checking before each that the tab is
 * still on the origin the batch started (and was approved) on, and stopping at
 * the first failure without attempting anything after it.
 */
export async function runBatch(
  deps: BatchDeps,
  tabId: number,
  steps: BatchStep[],
  /**
   * The origin the GATE approved this batch for (`expectedOrigin`, U5's pin).
   *
   * Without it the run pinned whatever the tab happened to show when it
   * started, which is not the same instant the user approved: a meta refresh,
   * a login bounce or a JS timer firing while the confirmation dialog was on
   * screen would leave the batch pinning the NEW origin and running all 25
   * steps there, self-consistently. Each step's own `expectedOrigin` still
   * reached the host and would have been refused there, so the outcome was
   * fail-closed — but reported as "step 1 failed", not as "the page moved
   * between approving this and running it", which is the thing that happened.
   *
   * Given, it is the pin, and a mismatch at the start stops the run before
   * step 0. Optional so the pre-U5 shape (and the bridge's own tests) still
   * work: absent, the run re-reads as before.
   */
  approvedOrigin?: string,
  /**
   * The origin the gate approved for each embedded region a step targets.
   *
   * A batch is authorized per TARGET FRAME, not per page: a step aimed into
   * `f3` was judged against `f3`'s own origin, so `approvedOrigin` (the top
   * page) says nothing about whether that step may still run. Without this the
   * only check between steps was the tab's address, which a third-party region
   * navigating away does not change at all — the region could swap sites
   * mid-batch and keep the approval.
   *
   * Optional: absent, each region's origin is pinned from the listing taken
   * before step 0, which is still self-consistent and still stops on drift,
   * just from an instant slightly later than the approval.
   */
  approvedFrameOrigins?: Record<string, string>,
): Promise<BatchResult> {
  const startedAt = deps.now();
  const completedSteps: BatchStepOutcome[] = [];
  let failedStep: BatchStepOutcome | undefined;
  let stopped: BatchStopReason | undefined;

  const framedSteps = steps.some((step) => step.frameId !== undefined);
  const opening = await readTab(deps, tabId, framedSteps);
  const observed = opening.origin;
  // The gate's map REPLACES the observed one rather than extending it: a step
  // naming a region the gate never judged must have no pin to check against
  // (and so stop the run), not quietly inherit whatever that region happened
  // to be showing when the batch started.
  const pinnedFrames: Record<string, string> = approvedFrameOrigins ?? opening.frameOrigins;
  // The gate's origin wins as the pin — never the observed one — so a run that
  // drifted before it began stops rather than re-pinning onto where it landed.
  const pinned = approvedOrigin ?? observed;
  const driftedBeforeStart =
    approvedOrigin !== undefined && observed !== null && observed !== approvedOrigin;
  let index = 0;

  const finish = (): BatchResult => {
    const ran = completedSteps.length + (failedStep ? 1 : 0);
    const remainingSteps = steps.length - ran;
    return fitEnvelope({
      tabId,
      origin: pinned,
      ...(framedSteps ? { frameOrigins: pinnedFrames } : {}),
      completedSteps,
      ...(failedStep ? { failedStep } : {}),
      remainingSteps,
      ...(stopped ? { stopped } : {}),
      message: stopped
        ? stopMessage(stopped, completedSteps.length, steps.length, pinned)
        : `All ${steps.length} steps ran on ${pinned ?? 'this page'}.`,
    });
  };

  if (driftedBeforeStart) {
    // Zero steps run, and the report names the drift rather than blaming the
    // first step for a refusal it never earned.
    stopped = 'origin-changed';
    return finish();
  }

  if (pinned === null) {
    stopped = 'origin-unverifiable';
    return finish();
  }

  while (index < steps.length) {
    if (deps.now() - startedAt >= MAX_BATCH_DURATION_MS) {
      stopped = 'time-limit';
      break;
    }

    // Page identity, re-read from the tab and never cached: the batch was
    // approved for one origin, and a step that would run somewhere else must
    // not run at all. A same-origin navigation (a form posting to its own
    // results page) is not a drift and does not stop the run.
    // Step 0 reuses the listing taken a moment ago rather than paying for a
    // second one; every later step re-reads, because anything could have
    // happened while the previous step ran.
    const reading: { origin: string | null; frameOrigins: Record<string, string> } =
      index === 0
        ? { origin: pinned, frameOrigins: opening.frameOrigins }
        : await readTab(deps, tabId, framedSteps);
    const here: string | null = reading.origin;
    if (here === null) {
      stopped = 'origin-unverifiable';
      break;
    }
    if (here !== pinned) {
      stopped = 'origin-changed';
      break;
    }

    // And the same question for the REGION this step targets. The tab staying
    // put says nothing about a third-party region inside it: that region can
    // navigate on its own, and an approval given for the site it was showing
    // must not carry over to whatever replaced it.
    const targetFrame = steps[index].frameId;
    if (targetFrame !== undefined) {
      const expected = pinnedFrames[targetFrame];
      const nowShowing = reading.frameOrigins[targetFrame];
      if (expected === undefined || nowShowing === undefined) {
        stopped = 'origin-unverifiable';
        break;
      }
      if (nowShowing !== expected) {
        stopped = 'frame-origin-changed';
        break;
      }
    }

    // Consecutive page reads go together; an action never shares the page with
    // anything else. The identity check above covers the whole group — the
    // reads are dispatched at one instant, and none of them can move the page.
    let groupEnd = index;
    while (
      groupEnd < steps.length
      && PARALLEL_READ_ACTIONS.has(steps[groupEnd].action)
    ) groupEnd += 1;
    const group = groupEnd > index ? steps.slice(index, groupEnd) : [steps[index]];

    // Read once for the whole group: its steps are dispatched at one instant,
    // so they share the remaining budget rather than each getting all of it.
    const budgetLeftMs = Math.max(0, MAX_BATCH_DURATION_MS - (deps.now() - startedAt));
    const outcomes = await Promise.all(
      group.map((step, offset) => runStep(deps, tabId, step, index + offset, budgetLeftMs, pinnedFrames)),
    );
    // Every outcome is accounted for, not just those before the first failure.
    // `outcomes` is in step order, so the FIRST failure is the one reported —
    // but its successful siblings were dispatched in the same instant and did
    // complete, and dropping them made `remainingSteps` over-count the work
    // still to do. Reads have no side effects, so this is report fidelity
    // rather than safety; a caller told "3 steps remain" when 2 do re-sends
    // one it already got.
    for (const outcome of outcomes) {
      if (outcome.ok) completedSteps.push(capStepResult(outcome));
      else if (!failedStep) failedStep = capStepResult(outcome);
    }
    if (failedStep) {
      stopped = 'step-failed';
      break;
    }
    index += group.length;
  }

  return finish();
}

async function runStep(
  deps: BatchDeps,
  tabId: number,
  step: BatchStep,
  index: number,
  /** What is left of `MAX_BATCH_DURATION_MS` when this step is dispatched. */
  budgetLeftMs: number,
  /** The approved origin of each region a step may target — see `runBatch`. */
  pinnedFrames: Record<string, string>,
): Promise<BatchStepOutcome> {
  const action = BATCH_STEP_ACTIONS[step.action];
  const startedAt = deps.now();
  // A wait owns its own deadline — but not one longer than the run it is part
  // of (F4). Clamped to the remaining budget, so the 120s ceiling this module
  // advertises is one a single step cannot step over; the +5000 is the same
  // transport headroom the single-action `wait_for` tool gives it.
  const timeoutMs = step.action === 'wait_for'
    ? Math.min(typeof step.timeout === 'number' ? step.timeout : 30_000, budgetLeftMs) + 5_000
    : undefined;
  try {
    // A framed step is pinned to ITS OWN region's approved origin; a step on
    // the main document carries none here and inherits the batch's page-level
    // pin from the owner fields the caller merges in.
    const stepPin = step.frameId !== undefined ? pinnedFrames[step.frameId] : undefined;
    const res = await deps.send(action, batchStepPayload(step, tabId, stepPin), timeoutMs);
    const durationMs = deps.now() - startedAt;
    if (!res.success) {
      return { index, action: step.action, ok: false, durationMs, error: res.error ?? 'Unknown error' };
    }
    return { index, action: step.action, ok: true, durationMs, result: res.data };
  } catch (err) {
    return {
      index,
      action: step.action,
      ok: false,
      durationMs: deps.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
