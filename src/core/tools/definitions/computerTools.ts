import { writeFile as writeBinFile } from '@tauri-apps/plugin-fs';
import { desktopDir } from '@tauri-apps/api/path';
import { writeText as clipboardWriteText, readText as clipboardReadText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolResult, ToolResultContent } from '../../../types';
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

// Screenshot→global-point mapping. `lastScreenScaleFactor` is points-per-screenshot-pixel
// and `lastScreenOrigin` is the captured display's top-left in global logical points.
// A screenshot coord (sx, sy) maps to a click point via:
//   (originX + sx * scale, originY + sy * scale).
// This is correct across Retina (scale folds in the backing factor) and multiple
// monitors (origin shifts for non-main displays). See capture_excluding_impl.
let lastScreenScaleFactor = 1;
let lastScreenOrigin = { x: 0, y: 0 };
const SCREENSHOT_MAX_WIDTH = 1280;
const AUTO_SCREENSHOT_DELAY_MS = 800;

// Batch mode flags — controlled by agentLoop for sequential computer use batches
let computerUseBatchMode = false;
let skipAutoScreenshot = false;

const COMPUTER_USE_TOKEN_ARG = '__abuComputerUseToken';
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
  if (action === 'wait') return null;
  if (action === 'screenshot') return 'screen-read';
  const axAction = [
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

function computerUseAbortError(): DOMException {
  return new DOMException('Computer Use was stopped', 'AbortError');
}

interface ComputerUseInvocation {
  token: string | null;
  abortSignal: AbortSignal | null;
}

function assertComputerUseNotAborted(signal: AbortSignal | null = null): void {
  if (signal?.aborted) throw computerUseAbortError();
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

interface ComputerUseSessionResult {
  token: string;
  target: {
    app_name: string;
    bundle_id: string;
    process_id: number | null;
  };
  classification: 'ordinary' | 'approval-required' | 'hard-deny';
  expires_at: number;
}

type AxElement = ComputerAxElement;

interface AxSnapshotResult {
  session_id: string;
  state_id?: string;
  app: string | null;
  total_visited: number;
  truncated: boolean;
  elements: AxElement[];
  verification_receipt?: {
    attempt_count: number;
    command: string;
    before_state_id: string;
    after_state_id: string;
    status: 'verified-change' | 'no-change';
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
}

async function invokeComputerUse<T>(
  invocation: ComputerUseInvocation,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!hasElectronCommandHost()) return invoke<T>(command, args);
  if (!invocation.token) {
    throw new Error('Computer Use session is not authorized');
  }
  assertComputerUseNotAborted(invocation.abortSignal);
  return invoke<T>(command, {
    ...args,
    [COMPUTER_USE_TOKEN_ARG]: invocation.token,
  });
}

function explicitTargetApp(input: Record<string, unknown>): string | null {
  const target = (input.app as string | undefined)
    ?? (input.app_name as string | undefined);
  return target?.trim() || null;
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
  const session = await invoke<ComputerUseSessionResult>('computer_use_begin_session', {
    conversationId: context.conversationId,
    toolCallId: context.toolCallId,
    loopId: context.loopId ?? null,
    interactionMode: context.interactionMode,
    scope,
    targetApp: explicitTargetApp(input),
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
  });
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
  await closeAxSession(conversationId, loopId);
  if (!hasElectronCommandHost()) return;
  await invoke('computer_use_end_task', { conversationId, loopId });
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
    appName: target.app_name,
    bundleId: target.bundle_id,
    processId: target.process_id,
  };
}

/** Record the screenshot's scale + origin so toScreenCoords maps clicks correctly. */
function applyScreenshotResult(result: ScreenshotResult): void {
  lastScreenScaleFactor = result.scale_factor;
  lastScreenOrigin = { x: result.origin_x ?? 0, y: result.origin_y ?? 0 };
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
function formatAxElements(elements: AxElement[]): string {
  if (elements.length === 0) return getI18n().toolResult.computer.noInteractiveElements;
  return elements
    .slice(0, 120) // cap at 120 to stay within token budget
    .map(e => {
      const label = e.label ?? '—';
      const val = e.value ? ` val="${e.value}"` : '';
      const acts = e.actions.join(',');
      const b = e.bounds;
      return `[${e.id}] ${e.role} "${label}"${val}  actions=[${acts}]  bounds=(${Math.round(b[0])},${Math.round(b[1])} ${Math.round(b[2])}×${Math.round(b[3])})`;
    })
    .join('\n');
}

/** Export so agent loop can close session on conversation end. */
export async function closeAxSession(
  conversationId?: string,
  loopId?: string,
): Promise<void> {
  if (conversationId && loopId) {
    await closeNativeAxSession(computerUseController.invalidate({ conversationId, loopId }));
    return;
  }
  const sessions = computerUseController.invalidateAll();
  await Promise.all(sessions.map(closeNativeAxSession));
}

/**
 * Type text via keyboard / clipboard (no element_id, no AX).
 * Handles CJK via clipboard-paste to avoid IME issues.
 */
async function typeViaKeyboard(
  text: string,
  invocation: ComputerUseInvocation,
): Promise<string> {
  const hasNonAscii = /[^ -~\t\n\r]/.test(text);
  if (hasNonAscii) {
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
    return `Typed (via paste): ${text} (${text.length} chars)`;
  } else {
    await invokeComputerUse<string>(invocation, 'keyboard_type', { text });
    return `Typed: ${text} (${text.length} chars)`;
  }
}

export function setComputerUseBatchMode(value: boolean) { computerUseBatchMode = value; }
export function setSkipAutoScreenshot(value: boolean) { skipAutoScreenshot = value; }

/** Map LLM screenshot-space coordinates to global logical click points. */
function toScreenCoords(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(lastScreenOrigin.x + x * lastScreenScaleFactor),
    y: Math.round(lastScreenOrigin.y + y * lastScreenScaleFactor),
  };
}

/**
 * Take a lightweight auto-screenshot after an action.
 * Uses exclusion-based capture when available (no window hide needed).
 * Falls back to regular capture when Abu window is already hidden (batch mode).
 */
async function takeAutoScreenshot(
  elements: AxElement[],
  invocation: ComputerUseInvocation,
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

    applyScreenshotResult(result);
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
): Promise<ToolResult> {
  // Permission is already checked in the main execute() entry point.
  // Capture screenshot excluding Abu + overlay windows (no need to hide/show).
  // Falls back to old capture_screen with window_hide if exclusion is unavailable.
  const excludeId = await getExcludeWindowId();

  if (excludeId != null) {
    // macOS: use capture_screen_excluding — Abu window stays visible to user
    return captureWithExclusion(excludeId, input, workspacePath, elements, invocation);
  } else {
    // Fallback (Windows / error): hide window, capture, show window
    return captureWithWindowHide(input, workspacePath, invocation);
  }
}

/** Screenshot via CGWindowListCreateImage excluding Abu window. No window hide needed. */
async function captureWithExclusion(
  abuWindowId: number,
  input: Record<string, unknown>,
  workspacePath: string | null | undefined,
  elements: AxElement[],
  invocation: ComputerUseInvocation,
): Promise<ToolResult> {
  // Crop coords (input.x/y/...) are display-relative LOGICAL POINTS: screenshot-coord ×
  // points-per-pixel. Rust converts back to pixels via the display backing scale.
  const anchor = currentAxAnchor(elements);
  const result = await invokeComputerUse<ScreenshotResult>(invocation, 'capture_screen_excluding', {
    excludeWindowId: abuWindowId,
    x: input.x != null ? Math.round((input.x as number) * lastScreenScaleFactor) : null,
    y: input.y != null ? Math.round((input.y as number) * lastScreenScaleFactor) : null,
    width: input.width != null ? Math.round((input.width as number) * lastScreenScaleFactor) : null,
    height: input.height != null ? Math.round((input.height as number) * lastScreenScaleFactor) : null,
    maxWidth: SCREENSHOT_MAX_WIDTH,
    anchorX: anchor?.x ?? null, anchorY: anchor?.y ?? null,
  });
  applyScreenshotResult(result);

  return formatScreenshotResult(result, workspacePath);
}

/** Fallback: hide Abu window → capture → show window. Used on Windows or when exclusion fails. */
async function captureWithWindowHide(
  input: Record<string, unknown>,
  workspacePath: string | null | undefined,
  invocation: ComputerUseInvocation,
): Promise<ToolResult> {
  try { await invoke('window_hide'); } catch { /* ignore */ }
  await abortableDelay(300, invocation.abortSignal);

  try {
    const result = await invokeComputerUse<ScreenshotResult>(invocation, 'capture_screen', {
      x: input.x != null ? Math.round((input.x as number) * lastScreenScaleFactor) : null,
      y: input.y != null ? Math.round((input.y as number) * lastScreenScaleFactor) : null,
      width: input.width != null ? Math.round((input.width as number) * lastScreenScaleFactor) : null,
      height: input.height != null ? Math.round((input.height as number) * lastScreenScaleFactor) : null,
      maxWidth: SCREENSHOT_MAX_WIDTH,
    });
    applyScreenshotResult(result);

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
  let target = fallbackTarget;
  try {
    const resolved = await invoke<ComputerUseSessionResult['target']>('resolve_app_identity', {
      appName: snap.app ?? fallbackTarget.appName,
    });
    target = toControllerTarget(resolved);
  } catch {
    // The Host Gate already pinned the initial target. Keeping that identity is
    // safer than inventing one when the follow-up process probe is unavailable.
  }
  return {
    stateId: snap.state_id,
    target,
    axSessionId: snap.session_id,
    elements: snap.elements,
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

function verificationText(
  verification: ReturnType<typeof computerUseController.completeAction>['verification'],
  t: ReturnType<typeof getI18n>['toolResult']['computer'],
): string {
  const status = verification.status === 'verified-change'
    ? t.verificationChanged
    : verification.status === 'no-change'
      ? t.verificationNoChange
      : t.verificationAmbiguous;
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
① get_app_state (optionally pass app to target a specific application) → returns AX elements, screenshot when supported, and state_id
② Pass that exact state_id as expected_state_id with each write action. Add expected_effect when the result is machine-checkable.
③ Abu consumes state_id once and automatically observes the app again, returning verified-change, no-change, or ambiguous.

Only fall back to screenshot + click(x,y) when get_app_state cannot retrieve elements (canvas/custom-drawn apps).

SAFETY CONTRACT: Every call must set consequence. Use "none" only when this
specific action cannot itself send, publish, delete, overwrite, install,
purchase, change credentials, or change security settings. Typing a draft is
"none"; clicking Send is "send". For any non-none value, consequence_detail
must state the exact outcome without including secrets. Abu asks the user
immediately before that one action, even in Full Autonomy.

━━━ Action list ━━━

🔍 Perception + switching (always call get_app_state before each operation turn)
• get_app_state   Brings the target app to the foreground, then reads the AX tree + screenshot (for vision models) together. Parameter: app (app name, e.g. "Notes", "D-Chat").
• activate_app    Brings an app to the foreground only (does not read the tree). Parameter: app. Native switch, no AppleScript permission needed.
• screenshot      Take a standalone screenshot (fallback when AX tree is unavailable). Optional crop: x, y, width, height.

✅ Recommended operations (AX path — no mouse movement, no focus stealing)
• click           Click. element_id=N (AXPress, preferred) or x, y (pixel click). Optional button (left/right/middle/double).
• type            Type text. element_id=N (AXSetValue, preferred) + text, or text alone (keyboard input).
• perform_action  Execute a secondary AX action, e.g. context menu (AXShowMenu), select (AXPick), increment/decrement (AXIncrement/AXDecrement). Parameters: element_id, action_name.
• scroll          Scroll. element_id=N (scroll at element position) or x, y. direction (up/down/left/right), amount (default 3).

⌨️ Low-level operations (when AX is unavailable)
• move            Move mouse. Parameters: x, y.
• drag            Drag. Parameters: startX, startY, endX, endY.
• key             Press key. Parameters: key (Return/Tab/Escape/a etc.), modifiers ([ctrl/shift/alt/meta]).
• wait            Wait. Parameters: duration (ms, default 1000, max 10000).

All pixel coordinates use screenshot space (max width ${SCREENSHOT_MAX_WIDTH}px) and are automatically converted to real screen coordinates.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: get_app_state, activate_app, screenshot, click, type, perform_action, scroll, move, drag, key, wait',
      },
      // App targeting (for get_app_state / get_ui)
      app: { type: 'string', description: 'Target app name (e.g. "Notes", "Safari"). App does NOT need to be in foreground. Used with get_app_state.' },
      app_name: { type: 'string', description: 'Alias for app (legacy, prefer app).' },
      // AX element reference
      element_id: { type: 'number', description: 'Element id from get_app_state output. Used with click, type, perform_action, scroll.' },
      expected_state_id: {
        type: 'string',
        description: 'Required for click/type/perform_action/scroll/drag/key. Use the exact state_id from the latest get_app_state. It expires after 30 seconds and is consumed once.',
      },
      expected_effect: {
        type: 'object',
        description: 'Optional machine-checkable postcondition. Consequential actions must use a specific effect, not any-state-change.',
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
      x: { type: 'number', description: 'X coordinate (screenshot pixel space)' },
      y: { type: 'number', description: 'Y coordinate (screenshot pixel space)' },
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
      key: { type: 'string', description: 'Key name: Return, Tab, Escape, Space, ArrowUp, ArrowDown, a, etc.' },
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
    if (statefulAction && electronHost && !isWindows()) {
      if (!runKey || typeof input.expected_state_id !== 'string' || !input.expected_state_id.trim()) {
        return t.errStateRequired;
      }
      try {
        expectedEffect = parseExpectedEffect(input.expected_effect);
      } catch (error) {
        return stateErrorMessage(error, t);
      }
      if (!computerUseController.getLatestState(runKey)) {
        return t.errStateRequired;
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
          // On Windows accessibility=false means the process is not elevated
          // (check_macos_permissions maps it to admin rights). There is no
          // Settings panel to open and no system dialog will ever appear.
          return getI18n().toolResult.computer.errWindowsNeedsAdmin;
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
        const activeWin = await invoke<{ app_name: string; bundle_id: string | null }>(
          hasElectronCommandHost() && !isWindows()
            ? 'frontmost_app_identity'
            : 'get_active_window',
        );
        const blocked = checkSensitiveApp(activeWin.bundle_id, activeWin.app_name, {
          approvalHandledByHost: hasElectronCommandHost(),
        });
        if (blocked) return `Error: ${blocked}`;
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
    const sessionInput = statefulAction && latestState
      ? { ...input, app: latestState.target.appName }
      : input;
    try {
      const begun = await beginComputerUseSession(
        sessionInput,
        context,
        action === 'screenshot' ? 'screen-read' : 'ui-control',
      );
      hostSession = begun.hostSession;
      invocation = begun.invocation;
      if (hostSession) {
        setComputerUseContext({ targetApp: hostSession.target.app_name });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return format(t.errAuthorizationFailed, { msg });
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
      if (statefulAction && electronHost && !isWindows() && runKey) {
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

      // Actions that should auto-screenshot after execution (vision models only).
      // AX-only actions (ax_click / ax_type) excluded — model calls get_app_state to verify.
      // perform_action included — may change UI state needing visual confirmation.
      // click / type included regardless of AX/pixel path.
      const autoScreenshotActions = ['click', 'type', 'key', 'scroll', 'drag', 'perform_action'];
      let actionResult: string;
      setComputerUsePhase(
        action === 'get_app_state' || action === 'get_ui' || action === 'screenshot'
          ? 'observing'
          : 'acting',
      );
      switch (action) {
        case 'screenshot':
          if (!modelSupportsVision) {
            return t.errNoVision;
          }
          return await executeScreenshot(
            input,
            context?.workspacePath,
            latestState?.elements ?? [],
            invocation,
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
        case 'get_app_state':
        case 'get_ui': {
          setComputerUsePhase('observing');
          if (runKey) {
            await closeNativeAxSession(computerUseController.clearObservation(runKey));
          }
          const targetApp = (input.app as string | undefined)
            ?? (input.app_name as string | undefined)
            ?? null;
          // Bring the target app forward first (best-effort) so the window is visible,
          // the screenshot is meaningful, and the display anchor is correct. Native
          // activation — no Apple Events permission needed.
          if (targetApp) {
            try {
              await invokeComputerUse(invocation, 'activate_app', { appName: targetApp });
              await abortableDelay(250, invocation.abortSignal);
            } catch { /* app may not be running yet; ax_snapshot will report */ }
          }
          let axPart: string;
          let observedElements: AxElement[] = [];
          try {
            const snap = await invokeComputerUse<AxSnapshotResult>(invocation, 'ax_snapshot', { appName: targetApp });
            traceHostVerificationReceipt(snap, context);
            observedElements = snap.elements;
            const appName = snap.app ?? targetApp ?? 'unknown';
            const fallbackTarget = hostSession
              ? toControllerTarget(hostSession.target)
              : { appName, bundleId: `legacy:${appName}`, processId: null };
            const observation = await makeObservation(
              snap,
              fallbackTarget,
              modelSupportsVision ? 'full' : 'structured',
            );
            const state = runKey
              ? computerUseController.recordObservation(runKey, observation)
              : null;
            const formatted = formatAxElements(snap.elements);
            const note = snap.truncated ? t.axTreeTruncated : '';
            axPart = format(t.axTreeHeader, {
              app: snap.app ?? 'unknown',
              count: snap.elements.length,
              visited: snap.total_visited,
              note,
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
              axPart = `${format(t.stateHeader, { stateId: state.stateId })}\n${axPart}`;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            axPart = format(t.axTreeFailed, { msg });
          }

          // Vision models: also take screenshot and return both together (Codex style).
          // Non-vision: AX tree only — still actionable via element_id.
          if (modelSupportsVision) {
            const screenshotContent = await takeAutoScreenshot(observedElements, invocation);
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
                return format(t.errActionAmbiguous, { msg });
              }
              // Fallback 1: pixel click at element center (AX bounds are screen points)
              const elem = axElements.find((candidate) => candidate.id === elemId);
              if (elem) {
                const cx = Math.round(elem.bounds[0] + elem.bounds[2] / 2);
                const cy = Math.round(elem.bounds[1] + elem.bounds[3] / 2);
                await invokeComputerUse<string>(invocation, 'mouse_click', { x: cx, y: cy, button: btn });
                actionResult = format(t.clickAxFallbackCenter, { msg, cx, cy });
              } else if (input.x != null && input.y != null) {
                // Fallback 2: caller-supplied screenshot-space coords
                const sc = toScreenCoords(input.x as number, input.y as number);
                await invokeComputerUse<string>(invocation, 'mouse_click', { x: sc.x, y: sc.y, button: btn });
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
            const sc = toScreenCoords(input.x as number, input.y as number);
            actionResult = await invokeComputerUse<string>(invocation, 'mouse_click', { x: sc.x, y: sc.y, button: btn });
          }
          break;
        }

        case 'move': {
          const sc = toScreenCoords(input.x as number, input.y as number);
          actionResult = await invokeComputerUse<string>(invocation, 'mouse_move', { x: sc.x, y: sc.y });
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
              await invokeComputerUse<string>(invocation, 'mouse_scroll', { x: cx, y: cy, direction: dir, amount: amt });
              actionResult = format(t.scrollAtElement, { dir, amt: amt ?? 3, elemId, cx, cy });
            } else if (input.x != null && input.y != null) {
              const sc = toScreenCoords(input.x as number, input.y as number);
              actionResult = await invokeComputerUse<string>(invocation, 'mouse_scroll', { x: sc.x, y: sc.y, direction: dir, amount: amt });
            } else {
              return format(t.errScrollElemNotFound, { elemId });
            }
          } else {
            if (input.x == null || input.y == null) {
              return t.errScrollNeedsCoords;
            }
            const sc = toScreenCoords(input.x as number, input.y as number);
            actionResult = await invokeComputerUse<string>(invocation, 'mouse_scroll', { x: sc.x, y: sc.y, direction: dir, amount: amt });
          }
          break;
        }

        case 'drag': {
          const start = toScreenCoords(input.startX as number, input.startY as number);
          const end = toScreenCoords(input.endX as number, input.endY as number);
          actionResult = await invokeComputerUse<string>(invocation, 'mouse_drag', {
            startX: start.x, startY: start.y,
            endX: end.x, endY: end.y,
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
              await invokeComputerUse(invocation, 'ax_set_value', { sessionId: axSessionId, elementId: elemId, text });
              actionResult = format(t.typeAxSuccess, { elemId });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (electronHost) {
                return format(t.errActionAmbiguous, { msg });
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
              return format(t.errActionAmbiguous, { msg });
            }
            if (input.x != null && input.y != null) {
              const sc = toScreenCoords(input.x as number, input.y as number);
              await invokeComputerUse<string>(invocation, 'mouse_click', { x: sc.x, y: sc.y, button: undefined });
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
            await invokeComputerUse(invocation, 'ax_set_value', { sessionId: axSessionId, elementId: elemId, text });
            actionResult = format(t.axTypeSuccess, { elemId });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (electronHost) {
              return format(t.errActionAmbiguous, { msg });
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
      if (preparedState && runKey) {
        setComputerUsePhase('verifying');
        let completion: ReturnType<typeof computerUseController.completeAction>;
        try {
          const snap = await invokeComputerUse<AxSnapshotResult>(invocation, 'ax_snapshot', {
            appName: preparedState.target.appName,
          });
          traceHostVerificationReceipt(snap, context);
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
          resultElements = snap.elements;
        } catch {
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
        resultText = `${actionResult}\n\n${verificationText(completion.verification, t)}${
          progressText ? `\n\n${progressText}` : ''
        }`;
      }

      // Auto-screenshot after UI-affecting actions so the model can see the result.
      // Window stays HIDDEN during the wait + capture — don't show it prematurely!
      // In batch mode, intermediate tools skip auto-screenshot (only last computer tool takes one).
      // Skip entirely for non-vision models — they can't read the image and the provider
      // would reject the request, crashing the turn.
      if (modelSupportsVision && autoScreenshotActions.includes(action) && !skipAutoScreenshot) {
        const screenshotContent = await takeAutoScreenshot(resultElements, invocation);
        return [
          { type: 'text', text: resultText },
          ...screenshotContent,
        ];
      }

      return resultText;
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
};
