import { writeFile as writeBinFile } from '@tauri-apps/plugin-fs';
import { desktopDir } from '@tauri-apps/api/path';
import { writeText as clipboardWriteText, readText as clipboardReadText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import {
  invokeComputerUse,
  assertComputerUseNotAborted,
  computerUseAbortError,
  COMPUTER_USE_TOKEN_ARG,
  type ComputerUseInvocation,
} from '@/core/computer-use/computerSession';
import {
  ComputerProtocolFailure,
  listComputerUseWindows,
  parseComputerUseSessionResponse,
  type ComputerDriverCapabilities,
  type ComputerProtocolError,
  type ComputerUseSessionResponse,
  type ComputerWindowTarget,
} from '@/core/computer-use/windowProtocol';
import { computerObservationContexts } from '@/core/computer-use/observationContext';
import { recoveryBudget, runBudgetKey } from '@/core/computer-use/recoveryBudget';
import type {
  ComputerStepOutcome,
  ComputerStepReport,
  ToolDefinition,
  ToolExecutionMetadata,
  ToolResult,
  ToolResultContent,
} from '../../../types';
import { getSettingsReader } from '../../agent/ports/settingsReader';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useChatStore } from '../../../stores/chatStore';
import { resolveCapabilities } from '../../llm/modelCapabilities';
import { joinPath } from '../../../utils/pathUtils';
import { isMacOS, isWindows } from '../../../utils/platform';
import { TOOL_NAMES } from '../toolNames';
import {
  updateLatestScreenshot,
  checkCUSessionLimits,
  setComputerUseContext,
  setComputerUsePhase,
  beginComputerUseConsentPause,
  notePausedByTakeover,
  getCUStatusSnapshot,
} from '../../agent/computerUseStatus';
import { checkSensitiveApp, checkBlockedKeyCombo } from '../computerUseSafety';
import { requestCapabilitySetup } from '../../capabilityPlugins/setupBridge';
import { getI18n, format } from '../../../i18n';
import { hasElectronCommandHost } from '../../../utils/electronHost';
import {
  computerUseController,
  ComputerUseStateError,
  type ComputerAxElement,
  type ComputerObservationInput,
  type ComputerState,
  type ComputerTargetIdentity,
  type ComputerUseRunKey,
  type ComputerVerification,
  type ExpectedEffect,
} from '../../agent/computerUseController';
import {
  checkComputerUsePermissions,
  requiredComputerUsePermissions,
} from '../../agent/computerUsePermission';
import {
  traceRuntimeEvent,
  type RuntimeTraceAttributes,
} from '../../observability/runtimeTrace';

const SCREENSHOT_MAX_WIDTH = 1280;
const AUTO_SCREENSHOT_DELAY_MS = 800;
// Native Office dialogs often materialize a few hundred milliseconds after
// the initiating key/click. Verify after the same bounded settle window used
// by screenshots so a late modal becomes the next state instead of receiving
// a stale follow-up action.
const WINDOWS_POST_ACTION_SETTLE_MS = 800;

// Batch mode flags — controlled by agentLoop for sequential computer use batches
let computerUseBatchMode = false;
let skipAutoScreenshot = false;

const CONSEQUENCE_CATEGORIES = new Set([
  'none',
  'send',
  'publish',
  'delete',
  'overwrite',
  'install',
  'purchase',
  'credential-change',
  'security-change',
]);
const STATEFUL_ACTIONS = new Set([
  'click',
  'move',
  'type',
  'perform_action',
  'scroll',
  'drag',
  'key',
  'ax_click',
  'ax_type',
]);

function computerUseExecutionPath(
  action: string,
  input: Record<string, unknown>,
): 'ax' | 'screen-read' | 'pixel-control' | null {
  if (action === 'wait' || action === 'list_windows') return null;
  if (action === 'screenshot' || action === 'get_screen_state') return 'screen-read';
  const axAction = [
    'get_window_state',
    'get_app_state',
    'get_ui',
    'ax_click',
    'ax_type',
    'perform_action',
    'activate_app',
    'activate',
  ].includes(action)
    || ((action === 'click' || action === 'type') && input.element_id != null);
  return axAction ? 'ax' : 'pixel-control';
}

function permissionRequirementsForAction(
  action: string,
  input: Record<string, unknown>,
) {
  const path = computerUseExecutionPath(action, input);
  return path
    ? requiredComputerUsePermissions(path)
    : { screenRead: false, uiControl: false };
}

async function abortableDelay(
  ms: number,
  signal: AbortSignal | null = null,
): Promise<void> {
  assertComputerUseNotAborted(signal);
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(computerUseAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type ComputerUseSessionResult = Extract<ComputerUseSessionResponse, { status: 'authorized' }>;

interface ComputerUseTaskStatus {
  active: boolean;
  stopped: boolean;
  stopped_reason: string | null;
  outcome_unknown_receipt: {
    status: 'outcome-unknown';
    /** Host attestation of how far the action got (execution-receipt contract). */
    execution?: 'dispatched' | 'outcome-unknown';
    helper_code?: string;
    command: string;
    before_state_id: string;
    attempt_count: number;
    consequential: boolean;
    decision: 'observe-required' | 'stop-ambiguous-side-effect';
  } | null;
  /**
   * The helper refused before anything reached the target. Nothing is
   * uncertain, so the Host neither blocks replay nor stops the run; the
   * renderer decides between one fresh observation and a hand-off via the
   * recovery budget.
   */
  not_executed_receipt?: {
    status: 'not-executed';
    execution: 'not-executed';
    helper_code: string;
    retryable: boolean;
    command: string;
    before_state_id: string;
    attempt_count: number;
    consequential: boolean;
    decision: 'observe-required';
  } | null;
}

type AxElement = ComputerAxElement;

interface AxSnapshotResult {
  session_id: string;
  state_id?: string;
  app: string | null;
  total_visited: number;
  truncated: boolean;
  elements: AxElement[];
  modal?: boolean;
  modal_window_id?: string | null;
  target?: ComputerUseSessionResult['target'];
  related_windows?: ComputerWindowTarget[];
  protocol_error?: ComputerProtocolError;
  window_graph_revision?: string;
  window_graph?: {
    target_window_id: string;
    foreground_window_id?: string | null;
    nodes: Array<{
      window_id: string;
      window_ref?: string;
      owner_window_id?: string | null;
      app_name: string;
      process_id: number;
      title: string;
      bounds: [number, number, number, number];
      minimized: boolean;
      z_index: number;
      relation: 'exact' | 'owned-popup' | 'owner' | 'same-process' | 'same-app';
      foreground: boolean;
    }>;
  };
  verification_receipt?: {
    attempt_count: number;
    command: string;
    before_state_id: string;
    after_state_id: string;
    status: 'verified-change' | 'no-change';
    /** Missing on receipts created by older Hosts; never infer assertion success from status. */
    observation?: 'changed' | 'unchanged' | 'unavailable';
    /** Generic Host AX receipts have no task assertion and therefore use not-requested. */
    expectation?: 'not-requested' | 'satisfied' | 'not-satisfied' | 'unverifiable';
    decision: 'continue' | 'recover' | 'stop-no-progress' | 'stop-ambiguous-side-effect';
    consecutive_no_change: number;
    recovery_used: boolean;
  };
}

interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  scale_factor: number;
  origin_x?: number;
  origin_y?: number;
  screenshot_id?: string;
  input_epoch?: number;
}

function explicitTargetApp(input: Record<string, unknown>): string | null {
  const target = (input.app as string | undefined)
    ?? (input.app_name as string | undefined);
  return target?.trim() || null;
}

/**
 * Copy for a refusal the helper marked non-retryable because a platform
 * boundary is in the way — the user has to clear it; no observation will.
 * Codes outside this table are the model's to fix (a key it cannot type,
 * text too long, an app it named wrong) and go back to it as the error.
 */
function platformBoundaryCopy(
  code: string,
  t: ReturnType<typeof getI18n>['toolResult']['computer'],
): string | null {
  switch (code) {
    case 'secure-desktop': return t.boundarySecureDesktop;
    case 'higher-integrity': return t.boundaryHigherIntegrity;
    case 'input-lease': return t.boundaryInputLease;
    case 'dpi-unaware': return t.boundaryDpiUnaware;
    case 'send-input-failed': return t.boundaryInputBlocked;
    default: return null;
  }
}

function targetUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bhas no visible window\b/i.test(message)
    || /\bno visible window(?:s)?\b/i.test(message)
    || /\bapp(?:lication)?\b.{0,80}\bnot running\b/i.test(message);
}

async function beginComputerUseSession(
  input: Record<string, unknown>,
  context: Parameters<ToolDefinition['execute']>[1],
  scope: 'screen-read' | 'ui-control',
): Promise<{ hostSession: ComputerUseSessionResult | null; invocation: ComputerUseInvocation }> {
  if (!hasElectronCommandHost()) {
    return {
      hostSession: null,
      invocation: { token: null, abortSignal: context?.abortSignal ?? null },
    };
  }
  if (!context?.conversationId || !context.toolCallId || context.interactionMode !== 'foreground') {
    throw new Error('Computer Use is only available in a visible foreground task');
  }
  assertComputerUseNotAborted(context.abortSignal);
  const currentConversationMode = context.conversationId
    ? useChatStore.getState().conversations[context.conversationId]?.permissionMode
    : undefined;
  const response = parseComputerUseSessionResponse(await invoke<unknown>('computer_use_begin_session', {
    conversationId: context.conversationId,
    toolCallId: context.toolCallId,
    loopId: context.loopId ?? null,
    interactionMode: context.interactionMode,
    scope,
    windowRef: typeof input.window_ref === 'string' ? input.window_ref : null,
    targetApp: explicitTargetApp(input),
    targetSelector: input.target_selector === 'foreground-at-submit'
      ? 'foreground-at-submit'
      : null,
    expectedStateId: typeof input.expected_state_id === 'string'
      ? input.expected_state_id
      : null,
    actionIntent: {
      action: input.action,
      category: input.consequence,
      summary: input.consequence_detail ?? '',
    },
    permissionMode: currentConversationMode
      ?? context.permissionMode
      ?? getSettingsReader().getSnapshot().permissionMode,
  }));
  if (response.status === 'target-error') {
    throw new ComputerProtocolFailure(response.error);
  }
  const session = response;
  const invocation = { token: session.token, abortSignal: context.abortSignal ?? null };
  if (invocation.abortSignal?.aborted) {
    try {
      await invoke('computer_use_end_session', {
        [COMPUTER_USE_TOKEN_ARG]: session.token,
      });
    } catch {
      // The task-level abort cleanup remains authoritative.
    }
    throw computerUseAbortError();
  }
  return { hostSession: session, invocation };
}

async function endComputerUseSession(invocation: ComputerUseInvocation): Promise<void> {
  if (!hasElectronCommandHost() || !invocation.token) return;
  const token = invocation.token;
  invocation.token = null;
  try {
    await invoke('computer_use_end_session', {
      [COMPUTER_USE_TOKEN_ARG]: token,
    });
  } catch {
    // Main-process TTL and sender cleanup remain authoritative.
  }
}

export async function endComputerUseTask(
  conversationId: string,
  loopId: string,
): Promise<void> {
  computerObservationContexts.clear({ conversationId, loopId });
  await closeAxSession(conversationId, loopId);
  if (!hasElectronCommandHost()) return;
  await invoke('computer_use_end_task', { conversationId, loopId });
}

export async function stopComputerUseTurn(
  conversationId: string,
  loopId: string,
  reason = 'user-stop',
): Promise<void> {
  computerObservationContexts.clear({ conversationId, loopId });
  await closeAxSession(conversationId, loopId);
  if (!hasElectronCommandHost()) return;
  await invoke('computer_use_stop_turn', { conversationId, loopId, reason });
}

function computerRunKey(
  context: Parameters<ToolDefinition['execute']>[1],
): ComputerUseRunKey | null {
  if (!context?.conversationId || !context.loopId) return null;
  return { conversationId: context.conversationId, loopId: context.loopId };
}

function computerTraceAttributes(
  context: Parameters<ToolDefinition['execute']>[1],
  attributes: RuntimeTraceAttributes = {},
): RuntimeTraceAttributes {
  const conversationId = context?.conversationId;
  const loopId = context?.loopId;
  const computerRunId = conversationId && loopId
    ? `${conversationId}:${loopId}`
    : undefined;
  return {
    conversationId,
    loopId,
    computerRunId,
    traceId: computerRunId,
    toolCallId: context?.toolCallId,
    modelId: context?.modelId,
    modelTier: context?.computerUseTier,
    capabilitySource: context?.modelCapabilitySource,
    ...attributes,
  };
}

function traceComputerUse(
  event: string,
  context: Parameters<ToolDefinition['execute']>[1],
  attributes: RuntimeTraceAttributes = {},
): void {
  traceRuntimeEvent(
    `renderer.computer_use_${event}`,
    computerTraceAttributes(context, attributes),
  );
}

function traceHostVerificationReceipt(
  snap: AxSnapshotResult,
  context: Parameters<ToolDefinition['execute']>[1],
): void {
  const receipt = snap.verification_receipt;
  if (!receipt) return;
  traceComputerUse('host_verification', context, {
    stage: receipt.command,
    stateId: receipt.after_state_id,
    verificationStatus: receipt.status,
    outcome: receipt.decision,
    attemptCount: receipt.attempt_count,
    consecutiveNoChange: receipt.consecutive_no_change,
    recoveryUsed: receipt.recovery_used,
  });
}

function toControllerTarget(target: ComputerUseSessionResult['target']): ComputerTargetIdentity {
  return {
    windowRef: target.window_ref,
    appName: target.app_name,
    bundleId: target.bundle_id,
    processId: target.process_id,
  };
}

/** Bind screenshot coordinates and freshness to one task, never module-global state. */
function applyScreenshotResult(
  runKey: ComputerUseRunKey | null,
  result: ScreenshotResult,
  binding: { windowRef: string | null; stateId: string | null },
): void {
  if (!runKey) return;
  computerObservationContexts.record(runKey, {
    ...binding,
    screenshotId: result.screenshot_id ?? null,
    scaleFactor: result.scale_factor,
    origin: { x: result.origin_x ?? 0, y: result.origin_y ?? 0 },
  });
}

function screenshotGuardArgs(
  runKey: ComputerUseRunKey | null,
  input: Record<string, unknown>,
  binding: { windowRef: string | null; stateId: string | null },
): { screenshotId?: string } {
  if (!runKey) return {};
  const supplied = typeof input.screenshot_id === 'string' ? input.screenshot_id : null;
  if (hasElectronCommandHost() && isWindows()) {
    const context = computerObservationContexts.requireScreenshot(runKey, supplied, binding);
    return { screenshotId: context.screenshotId as string };
  }
  const context = computerObservationContexts.get(runKey);
  if (supplied && context) {
    computerObservationContexts.requireScreenshot(runKey, supplied, binding);
  }
  return context?.screenshotId ? { screenshotId: context.screenshotId } : {};
}

function availableScreenshotGuardArgs(
  runKey: ComputerUseRunKey | null,
  binding: { windowRef: string | null; stateId: string | null },
): { screenshotId?: string } {
  if (!runKey) return {};
  const context = computerObservationContexts.get(runKey);
  if (
    !context
    || context.screenshotId === null
    || context.windowRef !== binding.windowRef
    || context.stateId !== binding.stateId
  ) return {};
  return { screenshotId: context.screenshotId };
}

/**
 * Anchor point (global logical points) used to pick which display to screenshot.
 * Uses the first AX element of the current snapshot (typically the app's window) so
 * the capture lands on the monitor the target app is actually on. Null → main display.
 */
function currentAxAnchor(elements: AxElement[]): { x: number; y: number } | null {
  const el = elements[0];
  if (!el) return null;
  const [x, y, w, h] = el.bounds;
  return { x: x + w / 2, y: y + h / 2 };
}

/** Release the current AX session and clear the element map. */
async function closeNativeAxSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  try { await invoke('ax_close_session', { sessionId }); } catch { /* ignore */ }
}

/** Format AX elements as a numbered list for the model (Set-of-Mark style). */
export function selectAxElementsForModel(
  elements: AxElement[],
  limit = 120,
): AxElement[] {
  const priority = (element: AxElement): number => {
    if (element.focused) return 0;
    if (element.actions.includes('SetValue')) return 1;
    if (element.role === 'Document') return 2;
    if (element.role === 'TextField') return 3;
    if (element.role === 'DataItem' || element.role === 'DataGrid') return 4;
    if (element.actions.includes('Focus')) return 5;
    return 6;
  };
  return elements
    .map((element, index) => ({ element, index, priority: priority(element) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map(({ element }) => element);
}

function formatAxElements(elements: AxElement[]): string {
  if (elements.length === 0) return getI18n().toolResult.computer.noInteractiveElements;
  return selectAxElementsForModel(elements)
    .map(e => {
      const label = e.label ?? '—';
      const val = e.value ? ` val="${e.value}"` : '';
      const acts = e.actions.join(',');
      const b = e.bounds;
      const focus = e.focused ? ' focused=true' : '';
      return `[${e.id}] ${e.role} "${label}"${val}${focus}  actions=[${acts}]  bounds=(${Math.round(b[0])},${Math.round(b[1])} ${Math.round(b[2])}×${Math.round(b[3])})`;
    })
    .join('\n');
}

function formatWindowGraph(
  graph: AxSnapshotResult['window_graph'],
  relatedWindows: AxSnapshotResult['related_windows'],
): string {
  const trusted = (relatedWindows ?? []).map((window) => (
    `- window_ref=${window.window_ref} relation=${window.relation} app=${window.app_name}`
  ));
  const legacy = (graph?.nodes ?? [])
    .filter((node) => typeof node.window_ref === 'string' && node.window_ref.length > 0)
    .slice(0, 12)
    .map((node) => {
    const foreground = node.foreground ? ' foreground=true' : '';
    return `- window_ref=${node.window_ref} relation=${node.relation}${foreground} app=${node.app_name}`;
  });
  const nodes = [...new Set([...trusted, ...legacy])];
  return nodes.length > 0 ? `related_windows:\n${nodes.join('\n')}` : '';
}

function screenshotIdForState(
  runKey: ComputerUseRunKey | null,
  target: ComputerTargetIdentity,
  stateId: string,
): string | null {
  if (!runKey) return null;
  const context = computerObservationContexts.get(runKey);
  if (
    !context
    || context.windowRef !== target.windowRef
    || context.stateId !== stateId
  ) return null;
  return context.screenshotId;
}

/**
 * One line of the L3 declaration, phrased for the model: only the facts that
 * change what it should do next (LLM-facing, so English like the rest of the
 * structured observation block).
 */
function formatDriverLine(driver: ComputerDriverCapabilities): string {
  const input = driver.input.foreground_required
    ? `foreground-only${driver.input.background_element_actions ? '+background-element-actions' : ''}`
    : 'background-ok';
  const identity = driver.elements.identity === 'runtime-id' ? 'stable' : 'per-snapshot';
  return [
    `driver: ${driver.id}`,
    `input=${input}`,
    `element-identity=${identity}`,
    `ime=${driver.input.ime_aware ? 'detected' : 'unknown'}`,
    `occluded-capture=${driver.capture.occluded_window ? 'yes' : 'no'}`,
  ].join('; ');
}

function formatComputerWindowState(input: {
  label: 'state' | 'next_state';
  target: ComputerTargetIdentity;
  stateId: string;
  screenshotId: string | null;
  snapshot: AxSnapshotResult;
  driver?: ComputerDriverCapabilities | null;
}): string {
  const graph = formatWindowGraph(
    input.snapshot.window_graph,
    input.snapshot.related_windows,
  );
  return [
    `${input.label}:`,
    `window_ref: ${input.target.windowRef ?? 'none'}`,
    `app: ${input.target.appName}`,
    `state_id: ${input.stateId}`,
    input.screenshotId ? `screenshot_id: ${input.screenshotId}` : '',
    input.driver ? formatDriverLine(input.driver) : '',
    formatAxElements(input.snapshot.elements),
    graph,
  ].filter(Boolean).join('\n');
}

function formatWindowCandidates(candidates: ComputerWindowTarget[]): string {
  if (candidates.length === 0) return 'windows: []';
  return [
    'windows:',
    ...candidates.map((candidate) => [
      `- window_ref: ${candidate.window_ref}`,
      `  app: ${candidate.app_name}`,
      `  relation: ${candidate.relation}`,
      ...(candidate.title ? [`  title: ${candidate.title.replace(/[\r\n]+/g, ' ').slice(0, 160)}`] : []),
    ].join('\n')),
  ].join('\n');
}

function protocolErrorText(
  error: ComputerProtocolError,
  t: ReturnType<typeof getI18n>['toolResult']['computer'],
): string {
  switch (error.code) {
    case 'target-required':
      return t.errTargetRequired;
    case 'target-not-found':
      return t.errTargetNotFound;
    case 'target-ambiguous':
      return `${t.errTargetAmbiguous}\n${formatWindowCandidates(error.candidates ?? [])}`;
    case 'window-ref-invalid':
    case 'window-ref-expired':
      return t.errWindowRefStale;
    case 'screenshot-stale':
      return t.errScreenshotStale;
    case 'manual-handoff-required':
    case 'user-takeover':
      return t.errManualHandoff;
    case 'approval-denied':
      return t.errScreenReadDenied;
    default:
      return `Error: Computer Use protocol failure (${error.code}).`;
  }
}

function officeEditingUnavailable(elements: AxElement[]): boolean {
  return elements.some((element) => /(?:未经授权产品|产品已停用|unlicensed product|product deactivated|大部分功能已禁用|most features (?:have been )?disabled)/i.test(
    `${element.label ?? ''} ${element.value ?? ''}`,
  ));
}

/** Export so agent loop can close session on conversation end. */
export async function closeAxSession(
  conversationId?: string,
  loopId?: string,
): Promise<void> {
  if (conversationId && loopId) {
    computerObservationContexts.clear({ conversationId, loopId });
    recoveryBudget.clear(runBudgetKey({ conversationId, loopId }));
    await closeNativeAxSession(computerUseController.invalidate({ conversationId, loopId }));
    return;
  }
  const sessions = computerUseController.invalidateAll();
  await Promise.all(sessions.map(closeNativeAxSession));
}

/**
 * Type text via keyboard / clipboard (no element_id, no AX).
 * Windows uses native Unicode SendInput for all text. macOS keeps the existing
 * clipboard fallback for CJK and restores the prior clipboard value.
 */
async function typeViaKeyboard(
  text: string,
  invocation: ComputerUseInvocation,
): Promise<string> {
  const hasNonAscii = /[^ -~\t\n\r]/.test(text);
  if (hasNonAscii && !isWindows()) {
    let savedClipboard: string | null = null;
    try { savedClipboard = await clipboardReadText(); } catch { /* empty clipboard */ }
    try {
      await clipboardWriteText(text);
      await abortableDelay(50, invocation.abortSignal);
      const pasteModifier = isMacOS() ? 'meta' : 'ctrl';
      await invokeComputerUse<string>(invocation, 'keyboard_press', { key: 'v', modifiers: [pasteModifier] });
      await abortableDelay(150, invocation.abortSignal);
    } finally {
      if (savedClipboard != null) {
        try { await clipboardWriteText(savedClipboard); } catch { /* ignore */ }
      }
    }
    return `Typed ${text.length} chars via paste`;
  } else {
    await invokeComputerUse<string>(invocation, 'keyboard_type', { text });
    return `Typed ${text.length} chars`;
  }
}

export function setComputerUseBatchMode(value: boolean) { computerUseBatchMode = value; }
export function setSkipAutoScreenshot(value: boolean) { skipAutoScreenshot = value; }

/** Map LLM screenshot-space coordinates using only this task's latest capture. */
function toScreenCoords(
  runKey: ComputerUseRunKey | null,
  x: number,
  y: number,
): { x: number; y: number } {
  if (!runKey) throw new Error('screenshot-required');
  return computerObservationContexts.toScreenCoords(runKey, x, y);
}

function screenshotScaleFactor(runKey: ComputerUseRunKey | null): number {
  return runKey ? computerObservationContexts.get(runKey)?.scaleFactor ?? 1 : 1;
}

/**
 * Take a lightweight auto-screenshot after an action.
 * Uses exclusion-based capture when available (no window hide needed).
 * Falls back to regular capture when Abu window is already hidden (batch mode).
 */
async function takeAutoScreenshot(
  elements: AxElement[],
  invocation: ComputerUseInvocation,
  runKey: ComputerUseRunKey | null,
  binding: { windowRef: string | null; stateId: string | null },
): Promise<ToolResultContent[]> {
  // Wait for UI to settle after the action (e.g. click animation, page load)
  await abortableDelay(AUTO_SCREENSHOT_DELAY_MS, invocation.abortSignal);

  try {
    const excludeId = await getExcludeWindowId();
    const anchor = currentAxAnchor(elements);
    let result: ScreenshotResult;

    if (excludeId != null && !computerUseBatchMode) {
      // Exclusion mode: Abu is visible, exclude from screenshot (+ overlay if present)
      result = await invokeComputerUse<ScreenshotResult>(invocation, 'capture_screen_excluding', {
        excludeWindowId: excludeId,
        x: null, y: null, width: null, height: null,
        maxWidth: SCREENSHOT_MAX_WIDTH,
        anchorX: anchor?.x ?? null, anchorY: anchor?.y ?? null,
      });
    } else {
      // Batch mode: Abu window is already hidden by toolExecutor, use regular capture
      result = await invokeComputerUse<ScreenshotResult>(invocation, 'capture_screen', {
        x: null, y: null, width: null, height: null,
        maxWidth: SCREENSHOT_MAX_WIDTH,
      });
    }

    applyScreenshotResult(runKey, result, binding);
    // Update floating console preview
    updateLatestScreenshot(result.base64);
    return [
      { type: 'text', text: `Auto-screenshot after action: ${result.width}x${result.height} (scale: ${result.scale_factor.toFixed(2)}x)\nExamine the screenshot to verify the action result and determine next steps.` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: result.base64 } },
    ];
  } catch (e) {
    return [{ type: 'text', text: `Auto-screenshot failed: ${e instanceof Error ? e.message : String(e)}` }];
  }
}

/** Cached Abu window ID for screenshot exclusion (macOS). */
let cachedAbuWindowId: number | null = null;

/** Get the Abu window's CGWindowID, cached after first call. */
async function getAbuWindowId(): Promise<number | null> {
  if (cachedAbuWindowId != null) return cachedAbuWindowId;
  try {
    cachedAbuWindowId = await invoke<number>('get_abu_window_id');
    return cachedAbuWindowId;
  } catch {
    return null; // Non-macOS or API unavailable
  }
}

/**
 * Get the best window ID for screenshot exclusion.
 * If the overlay is visible, use its ID (higher level → excludes both overlay and Abu).
 * Otherwise use Abu's window ID.
 */
async function getExcludeWindowId(): Promise<number | null> {
  try {
    const overlayId = await invoke<number | null>('get_overlay_window_id');
    if (overlayId != null) return overlayId;
  } catch { /* ignore */ }
  return getAbuWindowId();
}

/** Open macOS System Settings to a specific privacy panel. */
async function openMacOSSettings(panel: 'ScreenCapture' | 'Accessibility'): Promise<void> {
  try {
    // macOS 13+ uses the new URL scheme
    const url = `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_${panel}`;
    await invoke('run_shell_command', {
      command: `open "${url}"`,
      cwd: null, timeout: 5000, env: null,
    });
  } catch {
    // Fallback for older macOS
    try {
      const url = `x-apple.systempreferences:com.apple.preference.security?Privacy_${panel}`;
      await invoke('run_shell_command', {
        command: `open "${url}"`,
        cwd: null, timeout: 5000, env: null,
      });
    } catch { /* ignore */ }
  }
}

async function executeScreenshot(
  input: Record<string, unknown>,
  workspacePath: string | null | undefined,
  elements: AxElement[],
  invocation: ComputerUseInvocation,
  runKey: ComputerUseRunKey | null,
  binding: { windowRef: string | null; stateId: string | null },
): Promise<ToolResult> {
  // Permission is already checked in the main execute() entry point.
  // Capture screenshot excluding Abu + overlay windows (no need to hide/show).
  // Falls back to old capture_screen with window_hide if exclusion is unavailable.
  const excludeId = await getExcludeWindowId();

  if (excludeId != null || isWindows()) {
    // macOS uses explicit CGWindow exclusion. Windows uses WGC together with
    // WDA_EXCLUDEFROMCAPTURE on Abu/overlay windows; the numeric id is ignored.
    return captureWithExclusion(
      excludeId ?? 0, input, workspacePath, elements, invocation, runKey, binding,
    );
  } else {
    // Legacy fallback for platforms without a capture-exclusion mechanism.
    return captureWithWindowHide(input, workspacePath, invocation, runKey, binding);
  }
}

/** Screenshot via CGWindowListCreateImage excluding Abu window. No window hide needed. */
async function captureWithExclusion(
  abuWindowId: number,
  input: Record<string, unknown>,
  workspacePath: string | null | undefined,
  elements: AxElement[],
  invocation: ComputerUseInvocation,
  runKey: ComputerUseRunKey | null,
  binding: { windowRef: string | null; stateId: string | null },
): Promise<ToolResult> {
  // Crop coords (input.x/y/...) are display-relative LOGICAL POINTS: screenshot-coord ×
  // points-per-pixel. Rust converts back to pixels via the display backing scale.
  const anchor = currentAxAnchor(elements);
  const scaleFactor = screenshotScaleFactor(runKey);
  const result = await invokeComputerUse<ScreenshotResult>(invocation, 'capture_screen_excluding', {
    excludeWindowId: abuWindowId,
    x: input.x != null ? Math.round((input.x as number) * scaleFactor) : null,
    y: input.y != null ? Math.round((input.y as number) * scaleFactor) : null,
    width: input.width != null ? Math.round((input.width as number) * scaleFactor) : null,
    height: input.height != null ? Math.round((input.height as number) * scaleFactor) : null,
    maxWidth: SCREENSHOT_MAX_WIDTH,
    anchorX: anchor?.x ?? null, anchorY: anchor?.y ?? null,
  });
  applyScreenshotResult(runKey, result, binding);

  return formatScreenshotResult(result, workspacePath);
}

/** Fallback: hide Abu window → capture → show window. Used on Windows or when exclusion fails. */
async function captureWithWindowHide(
  input: Record<string, unknown>,
  workspacePath: string | null | undefined,
  invocation: ComputerUseInvocation,
  runKey: ComputerUseRunKey | null,
  binding: { windowRef: string | null; stateId: string | null },
): Promise<ToolResult> {
  try { await invoke('window_hide'); } catch { /* ignore */ }
  await abortableDelay(300, invocation.abortSignal);

  try {
    const scaleFactor = screenshotScaleFactor(runKey);
    const result = await invokeComputerUse<ScreenshotResult>(invocation, 'capture_screen', {
      x: input.x != null ? Math.round((input.x as number) * scaleFactor) : null,
      y: input.y != null ? Math.round((input.y as number) * scaleFactor) : null,
      width: input.width != null ? Math.round((input.width as number) * scaleFactor) : null,
      height: input.height != null ? Math.round((input.height as number) * scaleFactor) : null,
      maxWidth: SCREENSHOT_MAX_WIDTH,
    });
    applyScreenshotResult(runKey, result, binding);

    return formatScreenshotResult(result, workspacePath);
  } finally {
    try { await invoke('window_show'); } catch { /* ignore */ }
  }
}

/** Format screenshot result with saved file path. */
async function formatScreenshotResult(result: ScreenshotResult, workspacePath: string | null | undefined): Promise<ToolResultContent[]> {
  // Save screenshot — prefer workspace, then desktop
  let savedPath = '';
  try {
    const saveDir = (workspacePath ?? useWorkspaceStore.getState().currentPath) || await desktopDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `screenshot-${timestamp}.png`;
    const filePath = joinPath(saveDir, fileName);
    const binaryStr = atob(result.base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    await writeBinFile(filePath, bytes);
    savedPath = filePath;
  } catch (e) {
    console.warn('Failed to save screenshot file:', e);
  }

  const saveInfo = savedPath ? `\nScreenshot saved to: ${savedPath}` : '';
  return [
    { type: 'text', text: `Screenshot: ${result.width}x${result.height} (scale: ${result.scale_factor.toFixed(2)}x)${saveInfo}\nThe screenshot image is attached. Examine it carefully to identify UI elements and their coordinates. Do NOT use screencapture command to take another screenshot.` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: result.base64 } },
  ];
}

function parseExpectedEffect(value: unknown): ExpectedEffect | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected_effect must be an object');
  }
  const effect = value as Record<string, unknown>;
  switch (effect.type) {
    case 'any-state-change':
      return { type: 'any-state-change' };
    case 'element-value':
      if (typeof effect.element_id !== 'number' || typeof effect.equals !== 'string') break;
      return { type: 'element-value', elementId: effect.element_id, equals: effect.equals };
    case 'element-state':
      if (
        typeof effect.element_id !== 'number'
        || typeof effect.attribute !== 'string'
        || (typeof effect.equals !== 'string' && typeof effect.equals !== 'boolean')
      ) break;
      return {
        type: 'element-state',
        elementId: effect.element_id,
        attribute: effect.attribute,
        equals: effect.equals,
      };
    case 'element-appears':
      if (
        effect.role !== undefined && typeof effect.role !== 'string'
        || effect.label !== undefined && typeof effect.label !== 'string'
      ) break;
      if (
        !(typeof effect.role === 'string' && effect.role.trim())
        && !(typeof effect.label === 'string' && effect.label.trim())
      ) break;
      return {
        type: 'element-appears',
        role: effect.role as string | undefined,
        label: effect.label as string | undefined,
      };
    case 'element-disappears':
      if (typeof effect.element_id !== 'number') break;
      return { type: 'element-disappears', elementId: effect.element_id };
    case 'frontmost-app':
      if (typeof effect.bundle_id !== 'string' || !effect.bundle_id.trim()) break;
      return { type: 'frontmost-app', bundleId: effect.bundle_id };
  }
  throw new Error('expected_effect has invalid fields');
}

async function makeObservation(
  snap: AxSnapshotResult,
  fallbackTarget: ComputerTargetIdentity,
  capabilityTier: 'full' | 'structured',
): Promise<ComputerObservationInput> {
  let target = snap.target ? toControllerTarget(snap.target) : fallbackTarget;
  if (!hasElectronCommandHost()) {
    try {
      const resolved = await invoke<ComputerUseSessionResult['target']>('resolve_app_identity', {
        appName: snap.app ?? fallbackTarget.appName,
      });
      target = toControllerTarget(resolved);
    } catch {
      // The legacy path keeps the authorized fallback identity when its
      // follow-up process probe is unavailable.
    }
  }
  return {
    stateId: snap.state_id,
    target,
    axSessionId: snap.session_id,
    elements: snap.elements,
    modalWindowId: snap.modal_window_id ?? null,
    capabilityTier,
  };
}

function stateErrorMessage(
  error: unknown,
  t: ReturnType<typeof getI18n>['toolResult']['computer'],
): string {
  if (!(error instanceof ComputerUseStateError)) {
    return format(t.errStateProtocol, { reason: error instanceof Error ? error.message : String(error) });
  }
  switch (error.code) {
    case 'state-required':
    case 'run-context-required':
      return t.errStateRequired;
    case 'state-mismatch':
    case 'state-expired':
    case 'state-consumed':
      return t.errStateStale;
    case 'target-mismatch':
      return t.errStateTargetChanged;
    case 'action-in-flight':
      return t.errActionInFlight;
    case 'run-stopped':
      return t.errRunStopped;
    case 'weak-verification-for-consequence':
      return t.errWeakConsequenceVerification;
  }
}

export function formatComputerVerification(
  verification: ComputerVerification,
  t: ReturnType<typeof getI18n>['toolResult']['computer'],
): string {
  let status: string;
  if (!verification.observation || !verification.expectation) {
    status = t.verificationLegacyWeak;
  } else if (verification.expectation === 'not-requested') {
    status = verification.observation === 'changed'
      ? t.verificationChangedNoExpectation
      : verification.observation === 'unchanged'
        ? t.verificationUnchangedNoExpectation
        : t.verificationUnavailableNoExpectation;
  } else {
    const observation = verification.observation === 'changed'
      ? t.verificationObservationChanged
      : verification.observation === 'unchanged'
        ? t.verificationObservationUnchanged
        : t.verificationObservationUnavailable;
    const expectation = verification.expectation === 'satisfied'
      ? t.verificationExpectationSatisfied
      : verification.expectation === 'not-satisfied'
        ? t.verificationExpectationNotSatisfied
        : t.verificationExpectationUnverifiable;
    status = format(expectation, { observation });
  }
  return format(t.verificationResult, {
    status,
    stateId: verification.afterStateId ?? 'none',
  });
}

function progressDecisionText(
  decision: ReturnType<typeof computerUseController.assessProgress>['decision'],
  t: ReturnType<typeof getI18n>['toolResult']['computer'],
): string {
  switch (decision) {
    case 'recover':
      return t.progressRecover;
    case 'stop-no-progress':
      return t.progressStopped;
    case 'stop-expectation-not-satisfied':
      return '';
    case 'stop-ambiguous-side-effect':
      return t.ambiguousSideEffectStopped;
    case 'continue':
      return '';
  }
}

export const computerTool: ToolDefinition = {
  name: TOOL_NAMES.COMPUTER,
  description: `Control the computer screen: accessibility tree operations (recommended), screenshots, mouse and keyboard. Only use when you must see the screen or interact with a GUI.

[Recommended workflow (same as Codex)]
① list_windows when an app can have multiple visible windows, then get_window_state with exactly one returned window_ref. get_app_state remains a compatibility alias. When the user refers to the window active at submission, explicitly pass target_selector="foreground-at-submit".
   If the result is target-ambiguous, choose exactly one returned candidate and retry with its opaque window_ref. Never invent or modify a window_ref.
② Every write must carry window_ref, the exact state_id as expected_state_id, and screenshot_id for coordinate actions. Add expected_effect when the result is machine-checkable.
③ Abu consumes state_id once and automatically observes the app again, returning separate observation evidence (changed/unchanged/unavailable) and expectation evidence (not-requested/satisfied/not-satisfied/unverifiable). A UI change without a specific expected_effect does not prove the target was achieved.

COORDINATE CONTRACT: AX element bounds are screen coordinates. x/y action coordinates are relative to the referenced screenshot and must carry that screenshot's screenshot_id. Never copy screen-coordinate bounds into x/y.

For a named app, never call standalone screenshot before get_window_state: window state already includes the image and establishes one target-bound grant. Only fall back to screenshot + click(x,y) when the AX tree cannot retrieve elements (canvas/custom-drawn apps); later screenshots reuse that observed target and grant. Never fall back to the whole screen. Use get_screen_state only when the user explicitly asks to inspect the whole screen; it is authorized separately and must not establish a write target.
If a named app is unavailable or has no visible window, do not omit/change the app and do not inspect or operate another foreground app. Stop and ask the user to open a visible window for that exact app. When several windows match, select only from the returned window_ref candidates.
When the user names an application—even with a localized name such as “记事本”—you MUST pass that name in app on the first get_app_state call. Omit app only when the user truly did not identify an application. Never use run_command, a shell, or another tool to launch a missing app when the user asked to operate only the current/already-open app.

SAFETY CONTRACT: Every call must set consequence. Use "none" only when this
specific action cannot itself send, publish, delete, overwrite, install,
purchase, change credentials, or change security settings. Typing a draft is
"none"; clicking Send is "send". For any non-none value, consequence_detail
must state the exact outcome without including secrets. Abu asks the user
immediately before that one action, even in Full Autonomy.

━━━ Action list ━━━

🔍 Perception + switching (always call get_app_state before each operation turn)
• list_windows    Lists visible windows for one named app and returns opaque window_ref candidates. Parameter: app.
• get_window_state Reads one exact window's AX tree + screenshot. Parameter: window_ref (preferred), or app/target_selector for first selection.
• get_app_state   Compatibility alias for get_window_state.
• activate_app    Brings an app to the foreground only (does not read the tree). Parameter: app. Native switch, no AppleScript permission needed.
• screenshot      Take a standalone screenshot only as a fallback after get_app_state. Reuses the latest observed app when available. Optional crop: x, y, width, height.
• get_screen_state Separately authorized whole-screen screenshot. Read-only; never use its coordinates for a window write.

✅ Recommended operations (AX path — no mouse movement, no focus stealing)
• click           Click. element_id=N (AXPress, preferred) or x, y (pixel click). Optional button (left/right/middle/double).
• type            Type text. element_id=N (AXSetValue, preferred) + text, or text alone (keyboard input).
• perform_action  Execute a secondary AX action, e.g. context menu (AXShowMenu), select (AXPick), increment/decrement (AXIncrement/AXDecrement). Parameters: element_id, action_name.
• scroll          Scroll. element_id=N (scroll at element position) or x, y. direction (up/down/left/right), amount (default 3).

⌨️ Low-level operations (when AX is unavailable)
• move            Move mouse. Parameters: x, y.
• drag            Drag. Parameters: startX, startY, endX, endY.
• key             Press a named key or a modifier chord. Parameters: key (Return/Tab/Escape/Space/ArrowUp/Home/F1…), modifiers ([ctrl/shift/alt/meta]). A single plain character is injected as text (IME-safe); for words use type.
• wait            Wait. Parameters: duration (ms, default 1000, max 10000).

All pixel coordinates use screenshot space (max width ${SCREENSHOT_MAX_WIDTH}px) and are automatically converted to real screen coordinates.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: list_windows, get_window_state, get_app_state, get_screen_state, activate_app, screenshot, click, type, perform_action, scroll, move, drag, key, wait',
      },
      // App targeting (for get_app_state / get_ui)
      app: { type: 'string', description: 'Target app name (e.g. "Notes", "Safari"). App does NOT need to be in foreground. Used with get_app_state.' },
      app_name: { type: 'string', description: 'Alias for app (legacy, prefer app).' },
      window_ref: { type: 'string', description: 'Opaque target returned by list_windows/get_window_state. Required for every write and takes precedence over app and target_selector.' },
      target_selector: {
        type: 'string',
        enum: ['foreground-at-submit'],
        description: 'Use the external window that was foreground when the user submitted this turn. Supply explicitly only when the user did not name an app.',
      },
      // AX element reference
      element_id: { type: 'number', description: 'Element id from get_app_state output. Used with click, type, perform_action, scroll.' },
      expected_state_id: {
        type: 'string',
        description: 'Required for click/type/perform_action/scroll/drag/key. Use the exact state_id from the latest get_app_state. It expires after 30 seconds and is consumed once.',
      },
      screenshot_id: {
        type: 'string',
        description: 'Required for coordinate actions; copy it from the same window state that supplied the coordinates.',
      },
      expected_effect: {
        type: 'object',
        description: 'Optional machine-checkable postcondition. Consequential actions must use a specific effect, not any-state-change. element-appears requires at least one non-empty role or label.',
        properties: {
          type: {
            type: 'string',
            enum: ['element-value', 'element-state', 'element-appears', 'element-disappears', 'frontmost-app', 'any-state-change'],
          },
          element_id: { type: 'number' },
          attribute: { type: 'string' },
          equals: { type: 'string', description: 'Expected string value. Boolean state checks are reserved for AX attributes exposed by a later helper protocol.' },
          role: { type: 'string' },
          label: { type: 'string' },
          bundle_id: { type: 'string' },
        },
        required: ['type'],
      },
      // Named AX action (perform_action)
      action_name: { type: 'string', description: 'AX action name for perform_action, e.g. "AXShowMenu", "AXPick", "AXIncrement", "AXDecrement".' },
      // Coordinate params (click, move, scroll, screenshot crop)
      x: { type: 'number', description: 'X coordinate relative to the referenced screenshot; AX element bounds use screen coordinates instead.' },
      y: { type: 'number', description: 'Y coordinate relative to the referenced screenshot; AX element bounds use screen coordinates instead.' },
      // Click
      button: { type: 'string', description: 'Mouse button: left (default), right, middle, double' },
      // Scroll
      direction: { type: 'string', description: 'Scroll direction: up, down, left, right' },
      amount: { type: 'number', description: 'Scroll ticks (default 3)' },
      // Drag
      startX: { type: 'number', description: 'Drag start X' },
      startY: { type: 'number', description: 'Drag start Y' },
      endX: { type: 'number', description: 'Drag end X' },
      endY: { type: 'number', description: 'Drag end Y' },
      // Screenshot crop
      width: { type: 'number', description: 'Crop width (screenshot only)' },
      height: { type: 'number', description: 'Crop height (screenshot only)' },
      // Text input (type / ax_type)
      text: { type: 'string', description: 'Text to type or set on the element' },
      // Key
      key: { type: 'string', description: 'Key name (Return, Tab, Escape, Space, ArrowUp, ArrowDown, Home, End, PageUp, PageDown, Delete, Backspace, F1-F12) or one character for a chord such as ctrl+c. A plain character without modifiers is typed as text.' },
      modifiers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Modifier keys: ctrl, shift, alt, meta',
      },
      // Wait
      duration: { type: 'number', description: 'Wait duration in ms (default 1000, max 10000)' },
      // Display control
      show_user: {
        type: 'boolean',
        description: 'Show screenshot to user in chat. Default true for screenshot/get_app_state, false for other actions.',
      },
      consequence: {
        type: 'string',
        enum: [
          'none',
          'send',
          'publish',
          'delete',
          'overwrite',
          'install',
          'purchase',
          'credential-change',
          'security-change',
        ],
        description: 'Required safety declaration for the direct outcome of THIS action. Use none for viewing, navigation, scrolling, selecting, or typing a draft that is not submitted. Use the exact category when this action itself sends, publishes, deletes, overwrites, installs, purchases, changes credentials, or changes security settings. Never label a consequential action as none.',
      },
      consequence_detail: {
        type: 'string',
        description: 'Required when consequence is not none. Concisely tell the user exactly what will be sent, published, deleted, overwritten, installed, purchased, or changed. Do not include passwords, tokens, or other secret values.',
      },
    },
    required: ['action', 'consequence'],
  },
  execute: async (input, context): Promise<ToolResult> => {
    const t = getI18n().toolResult.computer;
    const action = input.action as string;

    traceComputerUse('capability', context, {
      stage: action,
      outcome: context?.computerUseTier ?? 'legacy-unknown',
    });
    setComputerUseContext({
      targetApp: explicitTargetApp(input),
      capabilityMode: context?.computerUseTier ?? null,
    });

    if (context?.interactionMode === 'background') {
      setComputerUsePhase('blocked');
      traceComputerUse('blocked', context, { stage: action, reason: 'background' });
      return t.errBackgroundUnavailable;
    }
    if (context?.computerUseTier === 'unsupported') {
      setComputerUsePhase('blocked');
      traceComputerUse('blocked', context, { stage: action, reason: 'model-unsupported' });
      return format(t.errModelUnsupported, { model: context.modelId ?? 'current model' });
    }
    if (context?.computerUseTier === 'unknown') {
      setComputerUsePhase('blocked');
      traceComputerUse('blocked', context, { stage: action, reason: 'model-unknown' });
      return format(t.errModelUnknown, { model: context.modelId ?? 'current model' });
    }

    // The user-facing switch is a hard gate. An interactive request can open
    // the setup surface, but neither the model nor a background task may grant
    // itself Computer Use.
    if (!getSettingsReader().getSnapshot().computerUseEnabled) {
      const ready = context
        ? await requestCapabilitySetup('computer', context, {
            computerUseRequirements: permissionRequirementsForAction(action, input),
          })
        : false;
      if (!ready || !getSettingsReader().getSnapshot().computerUseEnabled) {
        return t.errDisabled;
      }
    }

    const electronHost = hasElectronCommandHost();
    const runKey = computerRunKey(context)
      ?? (!electronHost ? { conversationId: '__legacy__', loopId: '__legacy__' } : null);
    const explicitApp = explicitTargetApp(input);
    const statefulAction = STATEFUL_ACTIONS.has(action);
    let expectedEffect: ExpectedEffect | undefined;
    const consequence = typeof input.consequence === 'string'
      ? input.consequence
      : '';
    if (!CONSEQUENCE_CATEGORIES.has(consequence)) {
      return t.errConsequenceRequired;
    }
    if (
      consequence !== 'none'
      && (
        typeof input.consequence_detail !== 'string'
        || !input.consequence_detail.trim()
        || input.consequence_detail.trim().length > 400
      )
    ) {
      return t.errConsequenceDetailRequired;
    }
    if (statefulAction && electronHost) {
      if (!runKey || typeof input.expected_state_id !== 'string' || !input.expected_state_id.trim()) {
        return t.errStateRequired;
      }
      if (typeof input.window_ref !== 'string' || !input.window_ref.trim()) {
        return t.errTargetRequired;
      }
      try {
        expectedEffect = parseExpectedEffect(input.expected_effect);
      } catch (error) {
        return stateErrorMessage(error, t);
      }
      if (!computerUseController.getLatestState(runKey)) {
        return t.errStateRequired;
      }
      if (isWindows() && (['move', 'scroll', 'drag'].includes(action)
        || action === 'click' && input.element_id === undefined)) {
        try {
          screenshotGuardArgs(runKey, input, { windowRef: input.window_ref, stateId: input.expected_state_id });
        } catch {
          // Reject before approval, focus changes or consuming the observed
          // state. Windows coordinate input never borrows an implicit image.
          return t.errScreenshotStale;
        }
      }
    } else if (input.expected_effect !== undefined) {
      try {
        expectedEffect = parseExpectedEffect(input.expected_effect);
      } catch (error) {
        return stateErrorMessage(error, t);
      }
    }

    // Whether the active model can understand images. Non-vision models (many
    // Chinese / local models, e.g. GLM, Qwen, MiMo) reject image inputs — sending
    // a screenshot makes the provider fail the whole request ("No endpoints found
    // that support image input"), crashing the agent turn. For those models the
    // pixel/screenshot path is useless; we steer to the AX path instead.
    const modelSupportsVision = context?.supportsVision ?? resolveCapabilities(
      getSettingsReader().getSnapshot().activeModel.modelId,
    ).vision;

    // Check session limits (max steps / timeout)
    const limitError = checkCUSessionLimits();
    if (limitError) return limitError;

    // Wait action — no permission needed
    if (action === 'wait') {
      const ms = Math.min(Math.max((input.duration as number) || 1000, 100), 10000);
      await abortableDelay(ms, context?.abortSignal ?? null);
      return `Waited ${ms}ms`;
    }

    if (action === 'list_windows') {
      if (!runKey || !electronHost || !isWindows()) {
        return t.errTargetRequired;
      }
      const app = explicitTargetApp(input);
      if (!app) return t.errTargetRequired;
      const response = await listComputerUseWindows(
        runKey.conversationId,
        runKey.loopId,
        app,
      );
      if (response.status === 'target-error') {
        return protocolErrorText(response.error, t);
      }
      return formatWindowCandidates(response.candidates);
    }

    // AX / native actions — no pixel capture, no cursor movement, no window hide.
    // get_app_state / get_ui: read-only snapshot.
    // perform_action: named AX action (AXShowMenu etc.).
    // activate_app / activate: native NSRunningApplication front-raise.
    // click/type with element_id: AX-first (pixel fallback may move cursor if AX fails).
    const executionPath = computerUseExecutionPath(action, input);
    const isAxAction = executionPath === 'ax';

    // Check system permissions (macOS) — auto-open Settings if missing
    setComputerUsePhase('checking');
    try {
      let perms = await checkComputerUsePermissions();
      if (!perms) throw new Error('permission status is unavailable');

      // AX-only actions (get_app_state / get_ui / ax_click / ax_type / perform_action) operate
      // entirely through the Accessibility API — they never capture pixels and do NOT need
      // Screen Recording. click/type with element_id take the AX path first too.
      const requiredPermissions = permissionRequirementsForAction(action, input);
      const needsScreenRecording = requiredPermissions.screenRead;
      const needsAccessibility = requiredPermissions.uiControl;
      const relaunchRequired = (
        (needsScreenRecording && perms.screenReadStatus === 'granted-relaunch-required')
        || (needsAccessibility && perms.uiControlStatus === 'granted-relaunch-required')
      );
      const permissionPath = executionPath ?? 'none';
      const missingRequiredPermission = (
        (needsScreenRecording && !perms.screenRead)
        || (needsAccessibility && !perms.uiControl)
      );
      traceComputerUse('permission', context, {
        stage: action,
        permissionPath,
        outcome: relaunchRequired
          ? 'relaunch-required'
          : missingRequiredPermission
            ? 'missing'
            : 'granted',
      });
      if (relaunchRequired) {
        return t.errPermissionRelaunch;
      }

      if (missingRequiredPermission && context?.conversationId && context.toolCallId) {
        const ready = await requestCapabilitySetup('computer', context, {
          computerUseRequirements: requiredPermissions,
        });
        if (!ready) return t.errDisabled;
        perms = await checkComputerUsePermissions();
        if (!perms) throw new Error('permission status is unavailable after setup');
        if (
          (needsScreenRecording && perms.screenReadStatus === 'granted-relaunch-required')
          || (needsAccessibility && perms.uiControlStatus === 'granted-relaunch-required')
        ) {
          return t.errPermissionRelaunch;
        }
        if (
          (needsScreenRecording && !perms.screenRead)
          || (needsAccessibility && !perms.uiControl)
        ) {
          return t.errDisabled;
        }
      }

      if (needsScreenRecording && !perms.screenRead) {
        // Trigger the system permission dialog (first time shows the dialog,
        // subsequent times it's a no-op). The dialog has an "Open System Settings" button.
        const granted = await invoke<boolean>('request_screen_recording');
        if (!granted) {
          return getI18n().toolResult.computer.errNoScreenRecording;
        }
      }

      // AX actions (and non-screenshot pixel actions) need Accessibility permission.
      if (needsAccessibility && !perms.uiControl) {
        if (isWindows()) {
          // Windows has no Accessibility consent switch. Electron normally
          // reports this capability as available and the native action guard
          // rejects only a concrete higher-integrity target. Reaching this
          // branch means the Windows backend itself is unavailable.
          return getI18n().toolResult.computer.errWindowsControlUnavailable;
        }
        // No system dialog for Accessibility — need to open Settings directly
        await openMacOSSettings('Accessibility');
        return getI18n().toolResult.computer.errMacOSNeedsAccessibility;
      }
    } catch (e) {
      // The Electron main process treats the permission probe as part of the
      // authorization boundary. A missing helper or failed probe must not turn
      // into an implicit grant.
      if (hasElectronCommandHost()) {
        const msg = e instanceof Error ? e.message : String(e);
        traceComputerUse('blocked', context, {
          stage: action,
          reason: 'permission-probe-failed',
          errorType: e instanceof Error ? e.name : typeof e,
        });
        return format(t.errPermissionProbeFailed, { msg });
      }
      // Keep the historical Tauri fallback while Electron migration is active.
    }

    // Safety checks for interactive actions
    if (action !== 'screenshot' && action !== 'wait') {
      // Check whether the foreground app is sensitive. Electron resolves this
      // through the native helper (NSWorkspace on macOS), so the Computer Use
      // path does not require Apple Events/System Events authorization.
      try {
        const electronHostOwnsIdentityPolicy = hasElectronCommandHost();
        const activeWin = await invoke<{ app_name: string; bundle_id: string | null }>(
          electronHostOwnsIdentityPolicy
            ? 'frontmost_app_identity'
            : 'get_active_window',
        );
        const blocked = checkSensitiveApp(activeWin.bundle_id, activeWin.app_name, {
          approvalHandledByHost: electronHostOwnsIdentityPolicy,
        });
        // The Electron Host Gate resolves the actual requested/pinned target
        // after this renderer probe. Prompt submission commonly makes Abu the
        // foreground app, so a renderer-side denial here would reject Abu
        // before the Host can recover the external Z-order target. The probe
        // remains useful on the legacy Tauri path; Electron's process/HWND-
        // bound gate is the authoritative policy boundary.
        if (blocked && !electronHostOwnsIdentityPolicy) return `Error: ${blocked}`;
      } catch (e) {
        if (hasElectronCommandHost()) {
          const msg = e instanceof Error ? e.message : String(e);
          return format(t.errTargetIdentityFailed, { msg });
        }
      }

      // Check for dangerous key combos
      if (action === 'key') {
        const keyBlocked = checkBlockedKeyCombo(input.key as string, input.modifiers as string[] | undefined);
        if (keyBlocked) return `Error: ${keyBlocked}`;
      }
    }

    let hostSession: ComputerUseSessionResult | null;
    let invocation: ComputerUseInvocation;
    const latestState = runKey ? computerUseController.getLatestState(runKey) : null;
    if (
      runKey
      && latestState
      && (
        (typeof input.window_ref === 'string' && input.window_ref !== latestState.target.windowRef)
        || (
          explicitApp !== null
          && explicitApp.toLowerCase() !== latestState.target.appName.toLowerCase()
        )
      )
    ) {
      computerObservationContexts.clear(runKey);
    }
    const reusesTargetContext = action === 'screenshot' && latestState !== null;
    const screenshotHasExplicitTarget = action === 'screenshot' && (
      explicitApp !== null
      || (typeof input.window_ref === 'string' && input.window_ref.trim().length > 0)
    );
    const sessionInput = (statefulAction || reusesTargetContext) && latestState
      ? {
          ...input,
          app: latestState.target.appName,
          ...(latestState.target.windowRef === null
            ? {}
            : { window_ref: latestState.target.windowRef }),
        }
      : input;
    const consentPause = beginComputerUseConsentPause(context?.conversationId ?? null);
    setComputerUsePhase('awaiting-approval');
    try {
      const begun = await beginComputerUseSession(
        sessionInput,
        context,
        (action === 'screenshot' || action === 'get_screen_state')
          && !reusesTargetContext
          && !screenshotHasExplicitTarget
          ? 'screen-read'
          : 'ui-control',
      );
      hostSession = begun.hostSession;
      invocation = begun.invocation;
      if (hostSession) {
        setComputerUseContext({ targetApp: hostSession.target.app_name });
      }
    } catch (e) {
      setComputerUsePhase('blocked');
      if (e instanceof ComputerProtocolFailure) {
        if (
          runKey
          && (
            e.protocolError.code === 'window-ref-invalid'
            || e.protocolError.code === 'window-ref-expired'
            || e.protocolError.code === 'state-stale'
          )
        ) {
          computerObservationContexts.clear(runKey);
          await closeNativeAxSession(computerUseController.clearObservation(runKey));
        }
        traceComputerUse('blocked', context, {
          stage: action,
          reason: e.protocolError.code,
        });
        if (
          e.protocolError.code === 'target-required'
          || e.protocolError.code === 'target-not-found'
          || e.protocolError.code === 'target-ambiguous'
        ) {
          context?.reportMetadata?.({
            requiresUserRecovery: 'computer-target-unavailable',
          });
        } else if (e.protocolError.code === 'outcome-unknown') {
          context?.reportMetadata?.({
            requiresUserRecovery: 'computer-outcome-unknown-new-turn',
          });
        }
        if (e.protocolError.code === 'target-ambiguous') {
          return protocolErrorText(e.protocolError, t);
        }
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const requestedApp = explicitTargetApp(sessionInput);
      if (requestedApp && targetUnavailableError(e)) {
        traceComputerUse('blocked', context, {
          stage: action,
          reason: 'target-unavailable',
        });
        context?.reportMetadata?.({
          requiresUserRecovery: 'computer-target-unavailable',
        });
        return format(t.errTargetUnavailable, { app: requestedApp });
      }
      return format(t.errAuthorizationFailed, { msg });
    } finally {
      consentPause.resume();
    }

    // AX actions drive controls directly — no cursor movement, no window hide needed.
    // For click/type with element_id we treat them as AX (no hide); the pixel fallback
    // inside those cases will move the cursor but does not need a separate hide/show
    // cycle because the AX element bounds are already in absolute screen coordinates.
    const needsHideWindow = !computerUseBatchMode && !isAxAction &&
      ['click', 'move', 'scroll', 'drag', 'type', 'key'].includes(action);
    let preparedState: ComputerState | null = null;
    let actionCompleted = false;
    try {
      if (statefulAction && electronHost && runKey) {
        try {
          preparedState = computerUseController.prepareAction(runKey, {
            expectedStateId: input.expected_state_id as string,
            target: hostSession ? toControllerTarget(hostSession.target) : undefined,
            expectedEffect,
            consequence,
          });
        } catch (error) {
          traceComputerUse('blocked', context, {
            stage: action,
            reason: error instanceof ComputerUseStateError
              ? error.code
              : 'state-protocol-error',
          });
          return stateErrorMessage(error, t);
        }
        setComputerUsePhase('acting');
        traceComputerUse('action_prepared', context, {
          stage: action,
          stateId: preparedState.stateId,
          targetBundleId: preparedState.target.bundleId,
          ...(preparedState.target.processId === null
            ? {}
            : { targetProcessId: preparedState.target.processId }),
        });
      } else if (statefulAction && runKey) {
        preparedState = computerUseController.getLatestState(runKey);
      }
      if (needsHideWindow) {
        try { await invoke('window_hide'); } catch { /* ignore */ }
        await abortableDelay(100, invocation.abortSignal); // Let window animate away
      }

      let actionResult: string;
      const coordinateBinding = {
        windowRef: preparedState?.target.windowRef
          ?? hostSession?.target.window_ref
          ?? null,
        stateId: preparedState?.stateId ?? latestState?.stateId ?? null,
      };
      setComputerUsePhase(
        action === 'get_window_state'
          || action === 'get_app_state'
          || action === 'get_ui'
          || action === 'screenshot'
          || action === 'get_screen_state'
          ? 'observing'
          : 'acting',
      );
      switch (action) {
        case 'screenshot':
        case 'get_screen_state':
          if (!modelSupportsVision) {
            return t.errNoVision;
          }
          return await executeScreenshot(
            sessionInput,
            context?.workspacePath,
            action === 'get_screen_state' ? [] : latestState?.elements ?? [],
            invocation,
            runKey,
            action === 'get_screen_state'
              ? { windowRef: null, stateId: null }
              : {
                  windowRef: hostSession?.target.window_ref ?? latestState?.target.windowRef ?? null,
                  stateId: latestState?.stateId ?? null,
                },
          );

        // ── Bring an app to the foreground (native, no Apple Events) ──────────
        case 'activate_app':
        case 'activate': {
          const targetApp = (input.app as string | undefined) ?? (input.app_name as string | undefined);
          if (!targetApp) return t.errActivateNeedsApp;
          if (runKey) {
            // Switching/raising the target invalidates the observation and AX
            // session, but must not erase no-progress or ambiguous-side-effect
            // guards for the same task. Otherwise the model could escape a
            // stopped run by calling activate_app and trying again.
            computerObservationContexts.clear(runKey);
            await closeNativeAxSession(computerUseController.clearObservation(runKey));
          }
          try {
            const name = await invokeComputerUse<string>(invocation, 'activate_app', { appName: targetApp });
            actionResult = format(t.activateSuccess, { name });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return format(t.errActivateFailed, { msg });
          }
          break;
        }

        // ── Codex-style: AX tree + screenshot together ────────────────────────
        // get_app_state is the new primary action; get_ui is its legacy alias.
        case 'get_window_state':
        case 'get_app_state':
        case 'get_ui': {
          setComputerUsePhase('observing');
          if (runKey) {
            computerObservationContexts.clear(runKey);
            await closeNativeAxSession(computerUseController.clearObservation(runKey));
          }
          const explicitApp = explicitTargetApp(input);
          // Explicit WindowRef selection has the same activation semantics as
          // naming an app. Observe after focus-created auxiliary surfaces settle,
          // not before the first write raises the window and changes its graph.
          // Windows Host resolves this command to the authorized exact HWND;
          // macOS/Tauri retain their existing named-app-only behavior.
          const activationApp = electronHost && isWindows() && input.window_ref && hostSession
            ? hostSession.target.app_name : explicitApp;
          if (activationApp) {
            try {
              await invokeComputerUse(invocation, 'activate_app', { appName: activationApp });
              await abortableDelay(250, invocation.abortSignal);
            } catch { /* app may not be running yet; ax_snapshot will report */ }
          }
          // Structured-mode (non-vision) models have no way to name the app they
          // haven't seen. Fall back to the app name the Host Gate already resolved
          // for this session (hostSession.target.app_name, from the same
          // NSWorkspace.frontmostApplication() lookup the security check below
          // relies on) so ax_snapshot still gets a real name instead of null.
          const targetApp = explicitApp ?? hostSession?.target.app_name ?? null;
          let axPart: string;
          let observedElements: AxElement[] = [];
          let observedSnapshot: AxSnapshotResult | null = null;
          let observedState: ComputerState | null = null;
          let observationNote = '';
          try {
            const snap = await invokeComputerUse<AxSnapshotResult>(invocation, 'ax_snapshot', { appName: targetApp });
            traceHostVerificationReceipt(snap, context);
            if (snap.protocol_error) {
              if (runKey) {
                computerObservationContexts.clear(runKey);
                await closeNativeAxSession(computerUseController.clearObservation(runKey));
              }
              setComputerUsePhase('blocked');
              context?.reportMetadata?.({
                requiresUserRecovery: 'computer-manual-handoff',
              });
              return protocolErrorText(snap.protocol_error, t);
            }
            observedElements = snap.elements;
            observedSnapshot = snap;
            const appName = snap.app ?? targetApp ?? 'unknown';
            const fallbackTarget = hostSession
              ? toControllerTarget(hostSession.target)
              : { windowRef: null, appName, bundleId: `legacy:${appName}`, processId: null };
            const observation = await makeObservation(
              snap,
              fallbackTarget,
              modelSupportsVision ? 'full' : 'structured',
            );
            const state = runKey
              ? computerUseController.recordObservation(runKey, observation)
              : null;
            observedState = state;
            const formatted = formatAxElements(snap.elements);
            observationNote = [
              snap.modal ? t.axTreeModal : '',
              snap.truncated ? t.axTreeTruncated : '',
              officeEditingUnavailable(snap.elements) ? t.officeEditingUnavailable : '',
            ].filter(Boolean).join('');
            axPart = state
              ? `${formatComputerWindowState({
                  driver: hostSession?.driver ?? null,
                  label: 'state',
                  target: state.target,
                  stateId: state.stateId,
                  screenshotId: null,
                  snapshot: snap,
                })}${observationNote}`
              : format(t.axTreeHeader, {
                  app: snap.app ?? 'unknown',
                  count: snap.elements.length,
                  visited: snap.total_visited,
                  note: observationNote,
                  formatted,
                });
            if (state) {
              traceComputerUse('observation', context, {
                stage: action,
                stateId: state.stateId,
                targetBundleId: state.target.bundleId,
                ...(state.target.processId === null
                  ? {}
                  : { targetProcessId: state.target.processId }),
                ...(state.axTreeHash === null ? {} : { axTreeHash: state.axTreeHash }),
                elementCount: state.elements.length,
              });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            axPart = `Error: ${format(t.axTreeFailed, { msg })}`;
          }

          // Vision models: also take screenshot and return both together (Codex style).
          // Non-vision: AX tree only — still actionable via element_id.
          if (modelSupportsVision) {
            const screenshotContent = await takeAutoScreenshot(
              observedElements,
              invocation,
              runKey,
              {
                windowRef: observedState?.target.windowRef
                  ?? hostSession?.target.window_ref
                  ?? null,
                stateId: observedState?.stateId ?? null,
              },
            );
            if (observedState && observedSnapshot) {
              axPart = `${formatComputerWindowState({
                driver: hostSession?.driver ?? null,
                label: 'state',
                target: observedState.target,
                stateId: observedState.stateId,
                screenshotId: screenshotIdForState(runKey, observedState.target, observedState.stateId),
                snapshot: observedSnapshot,
              })}${observationNote}`;
            }
            return [
              { type: 'text', text: axPart + t.axSuffixVision + t.axScreenshotSeparator },
              ...screenshotContent,
            ];
          }
          actionResult = axPart + t.axSuffixNoVision;
          break;
        }

        // ── Unified click: element_id (AX-first) or x,y (pixel) ─────────────
        case 'click': {
          const elemId = input.element_id as number | undefined;
          const btn = (input.button as string) || undefined;
          const axSessionId = preparedState?.axSessionId ?? null;
          const axElements = preparedState?.elements ?? [];

          if (elemId !== undefined && axSessionId != null) {
            // AX path: try AXPress first (no cursor movement)
            try {
              await invokeComputerUse(invocation, 'ax_press', { sessionId: axSessionId, elementId: elemId });
              actionResult = format(t.clickAxSuccess, { elemId });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (electronHost) {
                throw e;
              }
              // Fallback 1: pixel click at element center (AX bounds are screen points)
              const elem = axElements.find((candidate) => candidate.id === elemId);
              if (elem) {
                const cx = Math.round(elem.bounds[0] + elem.bounds[2] / 2);
                const cy = Math.round(elem.bounds[1] + elem.bounds[3] / 2);
                await invokeComputerUse<string>(invocation, 'mouse_click', {
                  x: cx, y: cy, button: btn,
                  ...availableScreenshotGuardArgs(runKey, coordinateBinding),
                });
                actionResult = format(t.clickAxFallbackCenter, { msg, cx, cy });
              } else if (input.x != null && input.y != null) {
                // Fallback 2: caller-supplied screenshot-space coords
                const sc = toScreenCoords(runKey, input.x as number, input.y as number);
                await invokeComputerUse<string>(invocation, 'mouse_click', {
                  x: sc.x, y: sc.y, button: btn,
                  ...screenshotGuardArgs(runKey, input, coordinateBinding),
                });
                actionResult = format(t.clickAxFallbackCoords, { msg, x: sc.x, y: sc.y });
              } else {
                return format(t.errClickAxNoFallback, { msg });
              }
            }
          } else if (elemId !== undefined) {
            // element_id provided but no active AX session — caller forgot get_app_state
            return t.errClickNoSession;
          } else {
            // Pixel-only path (no element_id)
            if (input.x == null || input.y == null) {
              return t.errClickNeedsCoords;
            }
            const sc = toScreenCoords(runKey, input.x as number, input.y as number);
            actionResult = await invokeComputerUse<string>(invocation, 'mouse_click', {
              x: sc.x, y: sc.y, button: btn,
              ...screenshotGuardArgs(runKey, input, coordinateBinding),
            });
          }
          break;
        }

        case 'move': {
          const sc = toScreenCoords(runKey, input.x as number, input.y as number);
          actionResult = await invokeComputerUse<string>(invocation, 'mouse_move', {
            x: sc.x, y: sc.y,
            ...screenshotGuardArgs(runKey, input, coordinateBinding),
          });
          break;
        }

        // ── Unified scroll: element_id (element center) or x,y (pixel) ───────
        case 'scroll': {
          const elemId = input.element_id as number | undefined;
          const dir = input.direction as string;
          const amt = (input.amount as number) || undefined;
          const axElements = preparedState?.elements ?? [];

          if (elemId !== undefined) {
            const elem = axElements.find((candidate) => candidate.id === elemId);
            if (elem) {
              // Scroll at element center (AX bounds → screen points, no scale needed)
              const cx = Math.round(elem.bounds[0] + elem.bounds[2] / 2);
              const cy = Math.round(elem.bounds[1] + elem.bounds[3] / 2);
              await invokeComputerUse<string>(invocation, 'mouse_scroll', {
                x: cx, y: cy, direction: dir, amount: amt,
                ...(electronHost && isWindows()
                  ? screenshotGuardArgs(runKey, input, coordinateBinding)
                  : availableScreenshotGuardArgs(runKey, coordinateBinding)),
              });
              actionResult = format(t.scrollAtElement, { dir, amt: amt ?? 3, elemId, cx, cy });
            } else if (input.x != null && input.y != null) {
              const sc = toScreenCoords(runKey, input.x as number, input.y as number);
              actionResult = await invokeComputerUse<string>(invocation, 'mouse_scroll', {
                x: sc.x, y: sc.y, direction: dir, amount: amt,
                ...screenshotGuardArgs(runKey, input, coordinateBinding),
              });
            } else {
              return format(t.errScrollElemNotFound, { elemId });
            }
          } else {
            if (input.x == null || input.y == null) {
              return t.errScrollNeedsCoords;
            }
            const sc = toScreenCoords(runKey, input.x as number, input.y as number);
            actionResult = await invokeComputerUse<string>(invocation, 'mouse_scroll', {
              x: sc.x, y: sc.y, direction: dir, amount: amt,
              ...screenshotGuardArgs(runKey, input, coordinateBinding),
            });
          }
          break;
        }

        case 'drag': {
          const start = toScreenCoords(runKey, input.startX as number, input.startY as number);
          const end = toScreenCoords(runKey, input.endX as number, input.endY as number);
          actionResult = await invokeComputerUse<string>(invocation, 'mouse_drag', {
            startX: start.x, startY: start.y,
            endX: end.x, endY: end.y,
            ...screenshotGuardArgs(runKey, input, coordinateBinding),
          });
          break;
        }

        // ── Unified type: element_id (AX set_value) or keyboard ───────────────
        case 'type': {
          const text = input.text as string;
          const elemId = input.element_id as number | undefined;
          const axSessionId = preparedState?.axSessionId ?? null;

          if (elemId !== undefined && axSessionId != null) {
            try {
              await invokeComputerUse(
                invocation,
                isWindows() ? 'ax_replace_text' : 'ax_set_value',
                { sessionId: axSessionId, elementId: elemId, text },
              );
              actionResult = format(t.typeAxSuccess, { elemId });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (electronHost) {
                throw e;
              }
              await typeViaKeyboard(text, invocation);
              actionResult = format(t.typeAxFallback, { msg });
            }
          } else {
            actionResult = await typeViaKeyboard(text, invocation);
          }
          break;
        }

        case 'key':
          actionResult = await invokeComputerUse<string>(invocation, 'keyboard_press', {
            key: input.key as string,
            modifiers: (input.modifiers as string[]) || undefined,
          });
          break;

        // ── Perform secondary AX action (AXShowMenu, AXPick, etc.) ───────────
        case 'perform_action': {
          const elemId = input.element_id as number;
          const actionName = input.action_name as string;
          const axSessionId = preparedState?.axSessionId ?? null;
          if (!actionName) return t.errPerformNeedsActionName;
          if (axSessionId == null) {
            return t.errPerformNoSession;
          }
          try {
            await invokeComputerUse(invocation, 'ax_perform_action', {
              sessionId: axSessionId,
              elementId: elemId,
              actionName,
            });
            actionResult = format(t.performSuccess, { elemId, actionName });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (electronHost) throw e;
            return format(t.errPerformFailed, { msg });
          }
          break;
        }

        // ── Legacy AX actions (kept for backward compat) ──────────────────────
        case 'ax_click': {
          const elemId = input.element_id as number;
          const axSessionId = preparedState?.axSessionId ?? null;
          if (axSessionId == null) {
            return t.errAxClickNoSession;
          }
          try {
            await invokeComputerUse(invocation, 'ax_press', { sessionId: axSessionId, elementId: elemId });
            actionResult = format(t.axClickSuccess, { elemId });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (electronHost) {
              throw e;
            }
            if (input.x != null && input.y != null) {
              const sc = toScreenCoords(runKey, input.x as number, input.y as number);
              await invokeComputerUse<string>(invocation, 'mouse_click', {
                x: sc.x, y: sc.y, button: undefined,
                ...screenshotGuardArgs(runKey, input, coordinateBinding),
              });
              actionResult = format(t.axClickFallback, { msg, x: sc.x, y: sc.y });
            } else {
              return format(t.errAxClickFailed, { msg });
            }
          }
          break;
        }

        case 'ax_type': {
          const elemId = input.element_id as number;
          const text = input.text as string;
          const axSessionId = preparedState?.axSessionId ?? null;
          if (axSessionId == null) {
            return t.errAxTypeNoSession;
          }
          try {
            await invokeComputerUse(
              invocation,
              isWindows() ? 'ax_replace_text' : 'ax_set_value',
              { sessionId: axSessionId, elementId: elemId, text },
            );
            actionResult = format(t.axTypeSuccess, { elemId });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (electronHost) {
              throw e;
            }
            await typeViaKeyboard(text, invocation);
            actionResult = format(t.axTypeFallback, { msg });
          }
          break;
        }

        default:
          return `Unknown action: ${action}. Valid: get_app_state, activate_app, screenshot, click, type, perform_action, scroll, move, drag, key, wait (legacy: get_ui, ax_click, ax_type)`;
      }

      let resultText = actionResult;
      let resultElements = preparedState?.elements ?? [];
      let verificationModalText = '';
      let nextSnapshot: AxSnapshotResult | null = null;
      let nextState: ComputerState | null = null;
      if (preparedState && runKey) {
        setComputerUsePhase('verifying');
        let completion: ReturnType<typeof computerUseController.completeAction>;
        try {
          if (isWindows()) {
            await abortableDelay(WINDOWS_POST_ACTION_SETTLE_MS, invocation.abortSignal);
          }
          const snap = await invokeComputerUse<AxSnapshotResult>(invocation, 'ax_snapshot', {
            appName: preparedState.target.appName,
          });
          traceHostVerificationReceipt(snap, context);
          if (snap.protocol_error) {
            throw new ComputerProtocolFailure(snap.protocol_error);
          }
          const observation = await makeObservation(
            snap,
            preparedState.target,
            preparedState.capabilityTier,
          );
          completion = computerUseController.completeAction(
            runKey,
            preparedState,
            observation,
            expectedEffect,
          );
          noteComputerStep(context, { outcome: completion.verification.status });
          if (completion.verification.status === 'verified-change') {
            recoveryBudget.recordVerifiedProgress(runBudgetKey(runKey));
          }
          nextSnapshot = snap;
          nextState = completion.state;
          resultElements = snap.elements;
          if (snap.modal) {
            verificationModalText = format(t.verificationModal, {
              formatted: formatAxElements(snap.elements),
            });
          }
        } catch (error) {
          if (
            error instanceof ComputerProtocolFailure
            && (
              error.protocolError.code === 'manual-handoff-required'
              || error.protocolError.code === 'user-takeover'
            )
          ) {
            computerObservationContexts.clear(runKey);
            verificationModalText = `\n\n${protocolErrorText(error.protocolError, t)}`;
            setComputerUsePhase('blocked');
            context?.reportMetadata?.({
              requiresUserRecovery: 'computer-manual-handoff',
            });
          }
          completion = computerUseController.completeAction(
            runKey,
            preparedState,
            null,
            expectedEffect,
          );
          resultElements = [];
        }
        actionCompleted = true;
        const progress = computerUseController.assessProgress(
          runKey,
          completion.verification,
          consequence,
        );
        if (progress.decision === 'stop-expectation-not-satisfied') {
          context?.reportMetadata?.({
            requiresUserRecovery: 'computer-verification-mismatch',
          });
        }
        await closeNativeAxSession(preparedState.axSessionId);
        traceComputerUse('action_verified', context, {
          stage: action,
          stateId: completion.verification.afterStateId
            ?? completion.verification.beforeStateId,
          targetBundleId: preparedState.target.bundleId,
          ...(preparedState.target.processId === null
            ? {}
            : { targetProcessId: preparedState.target.processId }),
          verificationStatus: completion.verification.status,
          outcome: completion.verification.reason,
          reason: progress.decision,
        });
        const progressText = progressDecisionText(progress.decision, t);
        if (progress.decision.startsWith('stop-')) setComputerUsePhase('blocked');
        resultText = `${actionResult}\n\n${formatComputerVerification(completion.verification, t)}${verificationModalText}${
          progressText ? `\n\n${progressText}` : ''
        }`;
      }

      // Auto-screenshot after every verified write so the model receives one
      // complete target-bound next_state, not a receipt that requires guessing.
      // Window stays HIDDEN during the wait + capture — don't show it prematurely!
      // In batch mode, intermediate tools skip auto-screenshot (only last computer tool takes one).
      // Skip entirely for non-vision models — they can't read the image and the provider
      // would reject the request, crashing the turn.
      if (modelSupportsVision && statefulAction && !skipAutoScreenshot) {
        const resultState = runKey ? computerUseController.getLatestState(runKey) : null;
        const screenshotContent = await takeAutoScreenshot(
          resultElements,
          invocation,
          runKey,
          {
            windowRef: resultState?.target.windowRef
              ?? preparedState?.target.windowRef
              ?? null,
            stateId: resultState?.stateId ?? null,
          },
        );
        if (nextState && nextSnapshot) {
          resultText = `${resultText}\n\n${formatComputerWindowState({
            driver: hostSession?.driver ?? null,
            label: 'next_state',
            target: nextState.target,
            stateId: nextState.stateId,
            screenshotId: screenshotIdForState(runKey, nextState.target, nextState.stateId),
            snapshot: nextSnapshot,
          })}`;
        }
        return [
          { type: 'text', text: resultText },
          ...screenshotContent,
        ];
      }

      if (nextState && nextSnapshot) {
        resultText = `${resultText}\n\n${formatComputerWindowState({
          driver: hostSession?.driver ?? null,
          label: 'next_state',
          target: nextState.target,
          stateId: nextState.stateId,
          screenshotId: screenshotIdForState(runKey, nextState.target, nextState.stateId),
          snapshot: nextSnapshot,
        })}`;
      }

      return resultText;
    } catch (error) {
      if (
        !electronHost
        || !preparedState
        || !runKey
        || invocation.abortSignal?.aborted
      ) {
        throw error;
      }
      let status: ComputerUseTaskStatus | null = null;
      try {
        status = await invoke<ComputerUseTaskStatus>('computer_use_get_task_status', {
          conversationId: runKey.conversationId,
          loopId: runKey.loopId,
        });
      } catch {
        // A broken status channel after native dispatch is itself uncertain.
        // Keep the conservative no-replay result below.
      }
      if (status?.stopped === true && status.stopped_reason === 'user-input-detected') {
        // The user took the mouse or keyboard while this action was in
        // flight. The Host has already revoked the task, so nothing more can
        // reach the app; hand the turn back as a pause the user can resume
        // from — scene untouched, nothing undone — not as a stop or an error.
        computerObservationContexts.clear(runKey);
        await closeNativeAxSession(computerUseController.clearObservation(runKey));
        actionCompleted = true;
        setComputerUsePhase('blocked');
        traceComputerUse('user_takeover', context, { stage: action, reason: 'user-input-detected' });
        noteComputerStep(context, { outcome: 'paused' });
        // Keep the on-screen strip up in its paused form with 【继续】; the
        // run ends when this result returns, and the strip outlives it.
        notePausedByTakeover(runKey.conversationId);
        try { await invoke('computer_use_chrome_paused', {}); } catch { /* chrome may already be gone */ }
        context?.reportMetadata?.({ requiresUserRecovery: 'computer-user-takeover' });
        return t.userTakeoverPaused;
      }
      // A receipt is evidence about one attempt. The Host keeps the last one
      // per run, and a refusal raised before any attempt began is written
      // against the state_id the renderer offered — so match on that before
      // believing either receipt, or a stale verdict becomes this action's.
      const offeredStateId = preparedState.stateId;
      const attributed = <R extends { before_state_id: string | null }>(
        receipt: R | null | undefined,
      ): R | null => (receipt && receipt.before_state_id === offeredStateId ? receipt : null);
      const notExecuted = attributed(status?.not_executed_receipt);
      if (notExecuted && notExecuted.retryable === false) {
        // The helper says re-observing would not change the answer. Either a
        // platform boundary the user has to clear — hand the turn back with
        // copy that says what to do — or a request the model has to change,
        // which goes back to it as the error at no recovery cost.
        const boundary = platformBoundaryCopy(notExecuted.helper_code, t);
        noteComputerStep(context, { outcome: boundary ? 'boundary' : 'error', detail: notExecuted.helper_code });
        traceComputerUse('action_not_executed', context, {
          stage: action,
          reason: notExecuted.helper_code,
          outcome: boundary ? 'boundary-handoff' : 'model-error',
        });
        if (!boundary) throw error;
        computerObservationContexts.clear(runKey);
        await closeNativeAxSession(computerUseController.clearObservation(runKey));
        actionCompleted = true;
        setComputerUsePhase('blocked');
        context?.reportMetadata?.({ requiresUserRecovery: 'computer-platform-boundary' });
        return format(boundary, { msg: error instanceof Error ? error.message : String(error) });
      }
      if (notExecuted) {
        // The Host attests nothing reached the target, so a fresh observation
        // is safe. The budget bounds it: one per refusal, a few per run — a
        // target that keeps refusing is the user's to fix, not a retry loop.
        const decision = recoveryBudget.decide(
          runBudgetKey(runKey),
          'not-executed',
          status?.stopped === true,
        );
        computerObservationContexts.clear(runKey);
        await closeNativeAxSession(computerUseController.clearObservation(runKey));
        actionCompleted = true;
        setComputerUsePhase('blocked');
        traceComputerUse('action_not_executed', context, {
          stage: action,
          reason: notExecuted.helper_code,
          outcome: decision,
        });
        noteComputerStep(context, {
          outcome: decision === 'observe-once' ? 'not-executed' : decision === 'handoff' ? 'handoff' : 'stopped',
          detail: notExecuted.helper_code,
        });
        const msg = error instanceof Error ? error.message : String(error);
        if (decision === 'observe-once') {
          const notice = format(t.actionNotExecuted, { msg, code: notExecuted.helper_code });
          // Observe on the model's behalf. The receipt already proves the
          // action did not run, so the only useful next input is the state to
          // choose from — one round-trip saved, and no way to "retry first,
          // observe later". A failed observation falls back to asking for one.
          let fresh: ToolResult;
          try {
            const targetApp = explicitTargetApp(input);
            fresh = await computerTool.execute(
              {
                action: 'get_app_state',
                consequence: 'none',
                ...(typeof input.window_ref === 'string' ? { window_ref: input.window_ref } : {}),
                ...(targetApp ? { app: targetApp } : {}),
              },
              { ...context, toolCallId: `${context?.toolCallId ?? 'computer'}-reobserve` },
            );
          } catch (observeError) {
            const detail = observeError instanceof Error ? observeError.message : String(observeError);
            return `${notice}\n\n${format(t.actionNotExecutedReobserveFailed, { msg: detail })}`;
          }
          if (typeof fresh === 'string') return `${notice}\n\n${fresh}`;
          const [head, ...rest] = fresh;
          return head?.type === 'text'
            ? [{ ...head, text: `${notice}\n\n${head.text}` }, ...rest]
            : [{ type: 'text', text: notice }, ...fresh];
        }
        if (decision === 'handoff') {
          context?.reportMetadata?.({
            requiresUserRecovery: 'computer-target-unavailable',
          });
          return format(t.actionNotExecutedHandoff, { msg });
        }
        return format(t.actionNotExecutedStopped, { msg });
      }
      const hostDeclaredUnknown = attributed(status?.outcome_unknown_receipt)?.status === 'outcome-unknown';
      if (!hostDeclaredUnknown && status !== null) throw error;

      const completion = computerUseController.completeAction(
        runKey,
        preparedState,
        null,
        expectedEffect,
      );
      actionCompleted = true;
      const progress = computerUseController.assessProgress(
        runKey,
        completion.verification,
        consequence,
      );
      await closeNativeAxSession(preparedState.axSessionId);
      setComputerUsePhase('blocked');
      if (consequence !== 'none') {
        context?.reportMetadata?.({
          requiresUserRecovery: 'computer-outcome-unknown-new-turn',
        });
      }
      traceComputerUse('action_verified', context, {
        stage: action,
        stateId: preparedState.stateId,
        targetBundleId: preparedState.target.bundleId,
        ...(preparedState.target.processId === null
          ? {}
          : { targetProcessId: preparedState.target.processId }),
        verificationStatus: 'ambiguous',
        outcome: 'outcome-unknown',
        reason: status?.outcome_unknown_receipt?.decision ?? progress.decision,
      });
      const msg = error instanceof Error ? error.message : String(error);
      const progressText = progressDecisionText(progress.decision, t);
      return `${format(t.errActionAmbiguous, { msg })}\n\n${formatComputerVerification(
        completion.verification,
        t,
      )}${progressText ? `\n\n${progressText}` : ''}`;
    } finally {
      if (preparedState && runKey && !actionCompleted) {
        computerUseController.failAction(runKey);
        if (consequence !== 'none') {
          computerUseController.assessProgress(runKey, {
            status: 'ambiguous',
            beforeStateId: preparedState.stateId,
            afterStateId: null,
            reason: 'observation-failed',
          }, consequence);
          setComputerUsePhase('blocked');
        }
      }
      await endComputerUseSession(invocation);
      // Restore Abu window AFTER everything is done (including auto-screenshot)
      if (needsHideWindow) {
        try { await invoke('window_show'); } catch { /* ignore */ }
      }
    }
  },
  isConcurrencySafe: false,
  execution: { presentation: 'computer-use' },
};

// ─── Step report for the chat's run card (proposal §4.2 "分步汇报 + 截图回看") ───
//
// Every computer tool call ends by reporting one ComputerStepReport through
// the trusted metadata channel. Most outcomes the wrapper can derive on its own
// (an observation, a plain success, a thrown error, or the recovery reason the
// tool already reported); the four it cannot — the Host's verification
// verdict, a not-executed decision, a boundary code, a takeover — are noted by
// the tool body via noteComputerStep. The wrapper sits outside the tool
// literal so the body keeps its shape; the auto-re-observe call inside a
// refusal is skipped (its toolCallId carries the -reobserve suffix and has no
// tool call of its own in the transcript).
const OBSERVATION_ACTIONS = new Set([
  'get_app_state', 'get_ui', 'get_window_state', 'screenshot', 'get_screen_state', 'list_windows', 'wait',
]);
const RECOVERY_OUTCOMES: Record<NonNullable<ToolExecutionMetadata['requiresUserRecovery']>, ComputerStepOutcome> = {
  'computer-target-unavailable': 'handoff',
  'computer-manual-handoff': 'handoff',
  'computer-platform-boundary': 'boundary',
  'computer-user-takeover': 'paused',
  'computer-verification-mismatch': 'mismatch',
  'computer-outcome-unknown-new-turn': 'outcome-unknown',
};
const stepNotes = new Map<string, Partial<ComputerStepReport>>();

function noteComputerStep(
  context: Parameters<ToolDefinition['execute']>[1],
  note: Partial<ComputerStepReport>,
): void {
  const id = context?.toolCallId;
  if (!id) return;
  stepNotes.set(id, { ...stepNotes.get(id), ...note });
}

function resultText(result: ToolResult | undefined): string {
  if (typeof result === 'string') return result;
  if (!Array.isArray(result)) return '';
  const text = result.find((part): part is Extract<ToolResultContent, { type: 'text' }> => part.type === 'text');
  return text?.text ?? '';
}

const executeComputerActionUnreported = computerTool.execute;
computerTool.execute = async (input, context) => {
  const toolCallId = context?.toolCallId;
  const report = context?.reportMetadata;
  if (!toolCallId || !report || toolCallId.endsWith('-reobserve')) {
    return executeComputerActionUnreported(input, context);
  }
  const startedAt = Date.now();
  let recovery: ToolExecutionMetadata['requiresUserRecovery'];
  const observed = {
    ...context,
    reportMetadata: (metadata: ToolExecutionMetadata) => {
      if (metadata.requiresUserRecovery) recovery = metadata.requiresUserRecovery;
      report(metadata);
    },
  };
  let result: ToolResult | undefined;
  let failure: unknown;
  try {
    result = await executeComputerActionUnreported(input, observed);
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const note = stepNotes.get(toolCallId) ?? {};
    stepNotes.delete(toolCallId);
    const action = String(input.action ?? '');
    const errored = failure !== undefined || /^Error:/.test(resultText(result).trimStart());
    const outcome: ComputerStepOutcome = note.outcome
      ?? (recovery ? RECOVERY_OUTCOMES[recovery]
        : errored ? 'error'
          : OBSERVATION_ACTIONS.has(action) ? 'observed'
            : 'done');
    const detail = note.detail
      ?? (failure instanceof Error && /not approved/i.test(failure.message) ? 'approval-denied' : undefined);
    const consequenceDetail = typeof input.consequence_detail === 'string' && input.consequence_detail.trim()
      ? input.consequence_detail.trim().slice(0, 200)
      : undefined;
    report({
      computerStep: {
        action,
        targetApp: getCUStatusSnapshot().targetApp ?? null,
        consequence: typeof input.consequence === 'string' && input.consequence ? input.consequence : 'none',
        ...(consequenceDetail ? { consequenceDetail } : {}),
        outcome,
        ...(detail ? { detail } : {}),
        durationMs: Date.now() - startedAt,
      },
    });
  }
};
