import { writeFile as writeBinFile } from '@tauri-apps/plugin-fs';
import { desktopDir } from '@tauri-apps/api/path';
import { writeText as clipboardWriteText, readText as clipboardReadText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolResult, ToolResultContent } from '../../../types';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { resolveCapabilities } from '../../llm/modelCapabilities';
import { joinPath } from '../../../utils/pathUtils';
import { isMacOS, isWindows } from '../../../utils/platform';
import { TOOL_NAMES } from '../toolNames';
import { updateLatestScreenshot, checkCUSessionLimits } from '../../agent/computerUseStatus';
import { checkSensitiveApp, checkBlockedKeyCombo } from '../computerUseSafety';
import { getI18n, format } from '../../../i18n';

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

// ── AX session state ──────────────────────────────────────────────────────────
// One session per get_app_state / get_ui call. Holds live AX element refs on
// the Rust side, plus a JS-side element array for bound lookups (element-based
// scroll/click fallback). Auto-closed when a new snapshot is taken; survives
// multiple click/type/perform_action calls within the same turn.
let currentAxSessionId: string | null = null;
let currentAxElements: AxElement[] = [];

interface AxElement {
  id: number;
  role: string;
  label: string | null;
  value: string | null;
  bounds: [number, number, number, number]; // [x, y, w, h]
  actions: string[];
  depth: number;
}

interface AxSnapshotResult {
  session_id: string;
  app: string | null;
  total_visited: number;
  truncated: boolean;
  elements: AxElement[];
}

interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  scale_factor: number;
  origin_x?: number;
  origin_y?: number;
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
function currentAxAnchor(): { x: number; y: number } | null {
  const el = currentAxElements[0];
  if (!el) return null;
  const [x, y, w, h] = el.bounds;
  return { x: x + w / 2, y: y + h / 2 };
}

/** Release the current AX session and clear the element map. */
async function closeCurrentAxSession(): Promise<void> {
  if (currentAxSessionId) {
    try { await invoke('ax_close_session', { sessionId: currentAxSessionId }); } catch { /* ignore */ }
    currentAxSessionId = null;
  }
  currentAxElements = [];
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
export async function closeAxSession(): Promise<void> {
  await closeCurrentAxSession();
}

/**
 * Type text via keyboard / clipboard (no element_id, no AX).
 * Handles CJK via clipboard-paste to avoid IME issues.
 */
async function typeViaKeyboard(text: string): Promise<string> {
  const hasNonAscii = /[^ -~\t\n\r]/.test(text);
  if (hasNonAscii) {
    let savedClipboard: string | null = null;
    try { savedClipboard = await clipboardReadText(); } catch { /* empty clipboard */ }
    try {
      await clipboardWriteText(text);
      await new Promise(r => setTimeout(r, 50));
      const pasteModifier = isMacOS() ? 'meta' : 'ctrl';
      await invoke<string>('keyboard_press', { key: 'v', modifiers: [pasteModifier] });
      await new Promise(r => setTimeout(r, 150));
    } finally {
      if (savedClipboard != null) {
        try { await clipboardWriteText(savedClipboard); } catch { /* ignore */ }
      }
    }
    return `Typed (via paste): ${text} (${text.length} chars)`;
  } else {
    await invoke<string>('keyboard_type', { text });
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
async function takeAutoScreenshot(): Promise<ToolResultContent[]> {
  // Wait for UI to settle after the action (e.g. click animation, page load)
  await new Promise(r => setTimeout(r, AUTO_SCREENSHOT_DELAY_MS));

  try {
    const excludeId = await getExcludeWindowId();
    const anchor = currentAxAnchor();
    let result: ScreenshotResult;

    if (excludeId != null && !computerUseBatchMode) {
      // Exclusion mode: Abu is visible, exclude from screenshot (+ overlay if present)
      result = await invoke('capture_screen_excluding', {
        excludeWindowId: excludeId,
        x: null, y: null, width: null, height: null,
        maxWidth: SCREENSHOT_MAX_WIDTH,
        anchorX: anchor?.x ?? null, anchorY: anchor?.y ?? null,
      });
    } else {
      // Batch mode: Abu window is already hidden by toolExecutor, use regular capture
      result = await invoke('capture_screen', {
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

async function executeScreenshot(input: Record<string, unknown>, workspacePath: string | null | undefined): Promise<ToolResult> {
  // Permission is already checked in the main execute() entry point.
  // Capture screenshot excluding Abu + overlay windows (no need to hide/show).
  // Falls back to old capture_screen with window_hide if exclusion is unavailable.
  const excludeId = await getExcludeWindowId();

  if (excludeId != null) {
    // macOS: use capture_screen_excluding — Abu window stays visible to user
    return captureWithExclusion(excludeId, input, workspacePath);
  } else {
    // Fallback (Windows / error): hide window, capture, show window
    return captureWithWindowHide(input, workspacePath);
  }
}

/** Screenshot via CGWindowListCreateImage excluding Abu window. No window hide needed. */
async function captureWithExclusion(abuWindowId: number, input: Record<string, unknown>, workspacePath: string | null | undefined): Promise<ToolResult> {
  // Crop coords (input.x/y/...) are display-relative LOGICAL POINTS: screenshot-coord ×
  // points-per-pixel. Rust converts back to pixels via the display backing scale.
  const anchor = currentAxAnchor();
  const result = await invoke<ScreenshotResult>('capture_screen_excluding', {
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
async function captureWithWindowHide(input: Record<string, unknown>, workspacePath: string | null | undefined): Promise<ToolResult> {
  try { await invoke('window_hide'); } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 300));

  try {
    const result = await invoke<ScreenshotResult>('capture_screen', {
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

export const computerTool: ToolDefinition = {
  name: TOOL_NAMES.COMPUTER,
  description: `Control the computer screen: accessibility tree operations (recommended), screenshots, mouse and keyboard. Only use when you must see the screen or interact with a GUI.

[Recommended workflow (same as Codex)]
① get_app_state (optionally pass app to target a specific application) → returns AX element list + screenshot together
② click(element_id=N) or type(element_id=N, text="...") to operate elements — AX path does not move the mouse or steal focus
③ After each important action, call get_app_state again to confirm the result

Only fall back to screenshot + click(x,y) when get_app_state cannot retrieve elements (canvas/custom-drawn apps).

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
    },
    required: ['action'],
  },
  execute: async (input, context): Promise<ToolResult> => {
    // Auto-enable Computer Use on first call — no need for user to find the toggle
    if (!useSettingsStore.getState().computerUseEnabled) {
      useSettingsStore.getState().setComputerUseEnabled(true);
    }

    const action = input.action as string;
    const t = getI18n().toolResult.computer;

    // Whether the active model can understand images. Non-vision models (many
    // Chinese / local models, e.g. GLM, Qwen, MiMo) reject image inputs — sending
    // a screenshot makes the provider fail the whole request ("No endpoints found
    // that support image input"), crashing the agent turn. For those models the
    // pixel/screenshot path is useless; we steer to the AX path instead.
    const modelSupportsVision = resolveCapabilities(
      useSettingsStore.getState().activeModel.modelId,
    ).vision;

    // Check session limits (max steps / timeout)
    const limitError = checkCUSessionLimits();
    if (limitError) return limitError;

    // Wait action — no permission needed
    if (action === 'wait') {
      const ms = Math.min(Math.max((input.duration as number) || 1000, 100), 10000);
      await new Promise(r => setTimeout(r, ms));
      return `Waited ${ms}ms`;
    }

    // AX / native actions — no pixel capture, no cursor movement, no window hide.
    // get_app_state / get_ui: read-only snapshot.
    // perform_action: named AX action (AXShowMenu etc.).
    // activate_app / activate: native NSRunningApplication front-raise.
    // click/type with element_id: AX-first (pixel fallback may move cursor if AX fails).
    const isAxAction = ['get_app_state', 'get_ui', 'ax_click', 'ax_type', 'perform_action', 'activate_app', 'activate'].includes(action)
      || ((action === 'click' || action === 'type') && input.element_id != null);

    // Check system permissions (macOS) — auto-open Settings if missing
    try {
      const perms = await invoke<{ screen_recording: boolean; accessibility: boolean }>('check_macos_permissions');

      // AX-only actions (get_app_state / get_ui / ax_click / ax_type / perform_action) operate
      // entirely through the Accessibility API — they never capture pixels and do NOT need
      // Screen Recording. click/type with element_id take the AX path first too.
      const needsScreenRecording = !isAxAction;
      if (needsScreenRecording && !perms.screen_recording) {
        // Trigger the system permission dialog (first time shows the dialog,
        // subsequent times it's a no-op). The dialog has an "Open System Settings" button.
        const granted = await invoke<boolean>('request_screen_recording');
        if (!granted) {
          return getI18n().toolResult.computer.errNoScreenRecording;
        }
      }

      // AX actions (and non-screenshot pixel actions) need Accessibility permission.
      const needsAccessibility = isAxAction || action !== 'screenshot';
      if (needsAccessibility && !perms.accessibility) {
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
    } catch {
      // Non-macOS or FFI unavailable — proceed
    }

    // Safety checks for interactive actions
    if (action !== 'screenshot' && action !== 'wait') {
      // Check if foreground app is sensitive (with 100ms cache to avoid repeated osascript calls)
      try {
        const activeWin = await invoke<{ app_name: string; bundle_id: string | null }>('get_active_window');
        const blocked = checkSensitiveApp(activeWin.bundle_id, activeWin.app_name);
        if (blocked) return `Error: ${blocked}`;
      } catch { /* can't check, proceed */ }

      // Check for dangerous key combos
      if (action === 'key') {
        const keyBlocked = checkBlockedKeyCombo(input.key as string, input.modifiers as string[] | undefined);
        if (keyBlocked) return `Error: ${keyBlocked}`;
      }
    }

    // AX actions drive controls directly — no cursor movement, no window hide needed.
    // For click/type with element_id we treat them as AX (no hide); the pixel fallback
    // inside those cases will move the cursor but does not need a separate hide/show
    // cycle because the AX element bounds are already in absolute screen coordinates.
    const needsHideWindow = !computerUseBatchMode && !isAxAction &&
      ['click', 'move', 'scroll', 'drag', 'type', 'key'].includes(action);
    if (needsHideWindow) {
      try { await invoke('window_hide'); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 100)); // Let window animate away
    }

    // Actions that should auto-screenshot after execution (vision models only).
    // AX-only actions (ax_click / ax_type) excluded — model calls get_app_state to verify.
    // perform_action included — may change UI state needing visual confirmation.
    // click / type included regardless of AX/pixel path.
    const autoScreenshotActions = ['click', 'type', 'key', 'scroll', 'drag', 'perform_action'];

    try {
      let actionResult: string;
      switch (action) {
        case 'screenshot':
          if (!modelSupportsVision) {
            return t.errNoVision;
          }
          return await executeScreenshot(input, context?.workspacePath);

        // ── Bring an app to the foreground (native, no Apple Events) ──────────
        case 'activate_app':
        case 'activate': {
          const targetApp = (input.app as string | undefined) ?? (input.app_name as string | undefined);
          if (!targetApp) return t.errActivateNeedsApp;
          try {
            const name = await invoke<string>('activate_app', { appName: targetApp });
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
          await closeCurrentAxSession();
          const targetApp = (input.app as string | undefined)
            ?? (input.app_name as string | undefined)
            ?? null;
          // Bring the target app forward first (best-effort) so the window is visible,
          // the screenshot is meaningful, and the display anchor is correct. Native
          // activation — no Apple Events permission needed.
          if (targetApp) {
            try {
              await invoke('activate_app', { appName: targetApp });
              await new Promise(r => setTimeout(r, 250));
            } catch { /* app may not be running yet; ax_snapshot will report */ }
          }
          let axPart: string;
          try {
            const snap = await invoke<AxSnapshotResult>('ax_snapshot', { appName: targetApp });
            currentAxSessionId = snap.session_id;
            currentAxElements = snap.elements;
            const formatted = formatAxElements(snap.elements);
            const note = snap.truncated ? t.axTreeTruncated : '';
            axPart = format(t.axTreeHeader, {
              app: snap.app ?? 'unknown',
              count: snap.elements.length,
              visited: snap.total_visited,
              note,
              formatted,
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            axPart = format(t.axTreeFailed, { msg });
            currentAxElements = [];
          }

          // Vision models: also take screenshot and return both together (Codex style).
          // Non-vision: AX tree only — still actionable via element_id.
          if (modelSupportsVision) {
            const screenshotContent = await takeAutoScreenshot();
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

          if (elemId !== undefined && currentAxSessionId != null) {
            // AX path: try AXPress first (no cursor movement)
            try {
              await invoke('ax_press', { sessionId: currentAxSessionId, elementId: elemId });
              actionResult = format(t.clickAxSuccess, { elemId });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              // Fallback 1: pixel click at element center (AX bounds are screen points)
              const elem = currentAxElements[elemId];
              if (elem) {
                const cx = Math.round(elem.bounds[0] + elem.bounds[2] / 2);
                const cy = Math.round(elem.bounds[1] + elem.bounds[3] / 2);
                await invoke<string>('mouse_click', { x: cx, y: cy, button: btn });
                actionResult = format(t.clickAxFallbackCenter, { msg, cx, cy });
              } else if (input.x != null && input.y != null) {
                // Fallback 2: caller-supplied screenshot-space coords
                const sc = toScreenCoords(input.x as number, input.y as number);
                await invoke<string>('mouse_click', { x: sc.x, y: sc.y, button: btn });
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
            actionResult = await invoke<string>('mouse_click', { x: sc.x, y: sc.y, button: btn });
          }
          break;
        }

        case 'move': {
          const sc = toScreenCoords(input.x as number, input.y as number);
          actionResult = await invoke<string>('mouse_move', { x: sc.x, y: sc.y });
          break;
        }

        // ── Unified scroll: element_id (element center) or x,y (pixel) ───────
        case 'scroll': {
          const elemId = input.element_id as number | undefined;
          const dir = input.direction as string;
          const amt = (input.amount as number) || undefined;

          if (elemId !== undefined) {
            const elem = currentAxElements[elemId];
            if (elem) {
              // Scroll at element center (AX bounds → screen points, no scale needed)
              const cx = Math.round(elem.bounds[0] + elem.bounds[2] / 2);
              const cy = Math.round(elem.bounds[1] + elem.bounds[3] / 2);
              await invoke<string>('mouse_scroll', { x: cx, y: cy, direction: dir, amount: amt });
              actionResult = format(t.scrollAtElement, { dir, amt: amt ?? 3, elemId, cx, cy });
            } else if (input.x != null && input.y != null) {
              const sc = toScreenCoords(input.x as number, input.y as number);
              actionResult = await invoke<string>('mouse_scroll', { x: sc.x, y: sc.y, direction: dir, amount: amt });
            } else {
              return format(t.errScrollElemNotFound, { elemId });
            }
          } else {
            if (input.x == null || input.y == null) {
              return t.errScrollNeedsCoords;
            }
            const sc = toScreenCoords(input.x as number, input.y as number);
            actionResult = await invoke<string>('mouse_scroll', { x: sc.x, y: sc.y, direction: dir, amount: amt });
          }
          break;
        }

        case 'drag': {
          const start = toScreenCoords(input.startX as number, input.startY as number);
          const end = toScreenCoords(input.endX as number, input.endY as number);
          actionResult = await invoke<string>('mouse_drag', {
            startX: start.x, startY: start.y,
            endX: end.x, endY: end.y,
          });
          break;
        }

        // ── Unified type: element_id (AX set_value) or keyboard ───────────────
        case 'type': {
          const text = input.text as string;
          const elemId = input.element_id as number | undefined;

          if (elemId !== undefined && currentAxSessionId != null) {
            try {
              await invoke('ax_set_value', { sessionId: currentAxSessionId, elementId: elemId, text });
              actionResult = format(t.typeAxSuccess, { elemId });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              await typeViaKeyboard(text);
              actionResult = format(t.typeAxFallback, { msg });
            }
          } else {
            actionResult = await typeViaKeyboard(text);
          }
          break;
        }

        case 'key':
          actionResult = await invoke<string>('keyboard_press', {
            key: input.key as string,
            modifiers: (input.modifiers as string[]) || undefined,
          });
          break;

        // ── Perform secondary AX action (AXShowMenu, AXPick, etc.) ───────────
        case 'perform_action': {
          const elemId = input.element_id as number;
          const actionName = input.action_name as string;
          if (!actionName) return t.errPerformNeedsActionName;
          if (currentAxSessionId == null) {
            return t.errPerformNoSession;
          }
          try {
            await invoke('ax_perform_action', {
              sessionId: currentAxSessionId,
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
          if (currentAxSessionId == null) {
            return t.errAxClickNoSession;
          }
          try {
            await invoke('ax_press', { sessionId: currentAxSessionId, elementId: elemId });
            actionResult = format(t.axClickSuccess, { elemId });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (input.x != null && input.y != null) {
              const sc = toScreenCoords(input.x as number, input.y as number);
              await invoke<string>('mouse_click', { x: sc.x, y: sc.y, button: undefined });
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
          if (currentAxSessionId == null) {
            return t.errAxTypeNoSession;
          }
          try {
            await invoke('ax_set_value', { sessionId: currentAxSessionId, elementId: elemId, text });
            actionResult = format(t.axTypeSuccess, { elemId });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await typeViaKeyboard(text);
            actionResult = format(t.axTypeFallback, { msg });
          }
          break;
        }

        default:
          return `Unknown action: ${action}. Valid: get_app_state, activate_app, screenshot, click, type, perform_action, scroll, move, drag, key, wait (legacy: get_ui, ax_click, ax_type)`;
      }

      // Auto-screenshot after UI-affecting actions so the model can see the result.
      // Window stays HIDDEN during the wait + capture — don't show it prematurely!
      // In batch mode, intermediate tools skip auto-screenshot (only last computer tool takes one).
      // Skip entirely for non-vision models — they can't read the image and the provider
      // would reject the request, crashing the turn.
      if (modelSupportsVision && autoScreenshotActions.includes(action) && !skipAutoScreenshot) {
        const screenshotContent = await takeAutoScreenshot();
        return [
          { type: 'text', text: actionResult },
          ...screenshotContent,
        ];
      }

      return actionResult;
    } finally {
      // Restore Abu window AFTER everything is done (including auto-screenshot)
      if (needsHideWindow) {
        try { await invoke('window_show'); } catch { /* ignore */ }
      }
    }
  },
  isConcurrencySafe: false,
};
