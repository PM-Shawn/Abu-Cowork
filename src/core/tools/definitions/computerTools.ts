import { writeFile as writeBinFile } from '@tauri-apps/plugin-fs';
import { desktopDir } from '@tauri-apps/api/path';
import { writeText as clipboardWriteText, readText as clipboardReadText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import type { ToolDefinition, ToolResult, ToolResultContent } from '../../../types';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { joinPath } from '../../../utils/pathUtils';
import { isMacOS } from '../../../utils/platform';
import { TOOL_NAMES } from '../toolNames';
import { updateLatestScreenshot, checkCUSessionLimits } from '../../agent/computerUseStatus';
import { checkSensitiveApp, checkBlockedKeyCombo } from '../computerUseSafety';

let lastScreenScaleFactor = 1;
const SCREENSHOT_MAX_WIDTH = 1280;
const AUTO_SCREENSHOT_DELAY_MS = 800;

// Batch mode flags — controlled by agentLoop for sequential computer use batches
let computerUseBatchMode = false;
let skipAutoScreenshot = false;

// ── AX session state ──────────────────────────────────────────────────────────
// One session per get_ui call. Holds live AX element refs on the Rust side.
// auto-closed when a new get_ui is called; survives multiple ax_click / ax_type.
let currentAxSessionId: string | null = null;

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

/** Release the current AX session (no-op if none). Call before taking a new snapshot. */
async function closeCurrentAxSession(): Promise<void> {
  if (currentAxSessionId) {
    try { await invoke('ax_close_session', { sessionId: currentAxSessionId }); } catch { /* ignore */ }
    currentAxSessionId = null;
  }
}

/** Format AX elements as a numbered list for the model (Set-of-Mark style). */
function formatAxElements(elements: AxElement[]): string {
  if (elements.length === 0) return '（没有找到可交互元素）';
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

export function setComputerUseBatchMode(value: boolean) { computerUseBatchMode = value; }
export function setSkipAutoScreenshot(value: boolean) { skipAutoScreenshot = value; }

/** Map LLM coordinates (in scaled screenshot space) back to real screen pixels. */
function toScreenCoords(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(x * lastScreenScaleFactor),
    y: Math.round(y * lastScreenScaleFactor),
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
    let result: { base64: string; width: number; height: number; scale_factor: number };

    if (excludeId != null && !computerUseBatchMode) {
      // Exclusion mode: Abu is visible, exclude from screenshot (+ overlay if present)
      result = await invoke('capture_screen_excluding', {
        excludeWindowId: excludeId,
        x: null, y: null, width: null, height: null,
        maxWidth: SCREENSHOT_MAX_WIDTH,
      });
    } else {
      // Batch mode: Abu window is already hidden by toolExecutor, use regular capture
      result = await invoke('capture_screen', {
        x: null, y: null, width: null, height: null,
        maxWidth: SCREENSHOT_MAX_WIDTH,
      });
    }

    lastScreenScaleFactor = result.scale_factor;
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

async function executeScreenshot(input: Record<string, unknown>): Promise<ToolResult> {
  // Permission is already checked in the main execute() entry point.
  // Capture screenshot excluding Abu + overlay windows (no need to hide/show).
  // Falls back to old capture_screen with window_hide if exclusion is unavailable.
  const excludeId = await getExcludeWindowId();

  if (excludeId != null) {
    // macOS: use capture_screen_excluding — Abu window stays visible to user
    return captureWithExclusion(excludeId, input);
  } else {
    // Fallback (Windows / error): hide window, capture, show window
    return captureWithWindowHide(input);
  }
}

/** Screenshot via CGWindowListCreateImage excluding Abu window. No window hide needed. */
async function captureWithExclusion(abuWindowId: number, input: Record<string, unknown>): Promise<ToolResult> {
  const result = await invoke<{ base64: string; width: number; height: number; scale_factor: number }>('capture_screen_excluding', {
    excludeWindowId: abuWindowId,
    x: input.x != null ? Math.round((input.x as number) * lastScreenScaleFactor) : null,
    y: input.y != null ? Math.round((input.y as number) * lastScreenScaleFactor) : null,
    width: input.width != null ? Math.round((input.width as number) * lastScreenScaleFactor) : null,
    height: input.height != null ? Math.round((input.height as number) * lastScreenScaleFactor) : null,
    maxWidth: SCREENSHOT_MAX_WIDTH,
  });
  lastScreenScaleFactor = result.scale_factor;

  return formatScreenshotResult(result);
}

/** Fallback: hide Abu window → capture → show window. Used on Windows or when exclusion fails. */
async function captureWithWindowHide(input: Record<string, unknown>): Promise<ToolResult> {
  try { await invoke('window_hide'); } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 300));

  try {
    const result = await invoke<{ base64: string; width: number; height: number; scale_factor: number }>('capture_screen', {
      x: input.x != null ? Math.round((input.x as number) * lastScreenScaleFactor) : null,
      y: input.y != null ? Math.round((input.y as number) * lastScreenScaleFactor) : null,
      width: input.width != null ? Math.round((input.width as number) * lastScreenScaleFactor) : null,
      height: input.height != null ? Math.round((input.height as number) * lastScreenScaleFactor) : null,
      maxWidth: SCREENSHOT_MAX_WIDTH,
    });
    lastScreenScaleFactor = result.scale_factor;

    return formatScreenshotResult(result);
  } finally {
    try { await invoke('window_show'); } catch { /* ignore */ }
  }
}

/** Format screenshot result with saved file path. */
async function formatScreenshotResult(result: { base64: string; width: number; height: number; scale_factor: number }): Promise<ToolResultContent[]> {
  // Save screenshot — prefer workspace, then desktop
  let savedPath = '';
  try {
    const workspacePath = useWorkspaceStore.getState().currentPath;
    const saveDir = workspacePath || await desktopDir();
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
  description: `操控电脑屏幕：截图、无障碍树操作（推荐）、鼠标和键盘操作。仅在必须看屏幕画面或操作 GUI 界面时才用，能用其他工具完成的不要用此工具。

【推荐工作流】先 get_ui 读无障碍树 → 再 ax_click / ax_type 操作元素。这条路径不移动鼠标、不抢焦点、丝滑无感知。只有 get_ui 拿不到元素（canvas/自绘 app）时再退回 screenshot + click(x,y)。

操作类型（action）：

无障碍树操作（AX 路径，推荐）：
- get_ui：读取目标应用的无障碍树，返回可交互元素列表（id / role / label / bounds / actions）。不截图、不动鼠标。参数：app_name（推荐，如 "Notes"、"Safari"）——指定后不需要该 App 在前台，用户可以继续操作电脑；不指定则读当前前台应用。
- ax_click：按元素 id 点击控件（AXPress），不移动光标。参数：element_id。可选降级坐标：x, y。
- ax_type：按元素 id 设置文本（AXSetValue），不合成键盘事件。参数：element_id, text。

像素坐标操作（降级路径，当 AX 不可用时使用）：
- screenshot：截屏（阿布窗口不会出现在截图中）。可选 x, y, width, height 裁剪区域。
- click：点击坐标。参数：x, y, button（left/right/middle/double，默认 left）。
- move：移动鼠标。参数：x, y。
- scroll：滚动。参数：x, y, direction（up/down/left/right）, amount（默认 3）。
- drag：拖拽。参数：startX, startY, endX, endY。
- type：输入文本（中文自动使用剪贴板粘贴）。参数：text。
- key：按键组合。参数：key（如 Return, Tab, a）, modifiers（如 ["ctrl","shift"]）。
- wait：等待指定毫秒数。参数：duration（默认 1000，最大 10000）。

像素坐标使用截图像素坐标系（最大宽度 ${SCREENSHOT_MAX_WIDTH}px），自动映射回真实屏幕坐标。`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: screenshot, click, move, scroll, drag, type, key, wait',
      },
      // Coordinate params (for click, move, scroll, screenshot crop)
      x: { type: 'number', description: 'X coordinate (screenshot space)' },
      y: { type: 'number', description: 'Y coordinate (screenshot space)' },
      // Click
      button: { type: 'string', description: 'Mouse button: left, right, middle, double (default: left)' },
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
      // Type
      text: { type: 'string', description: 'Text to type' },
      // Key
      key: { type: 'string', description: 'Key name (Return, Tab, Escape, Space, ArrowUp, a, etc.)' },
      modifiers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Modifier keys: ctrl, shift, alt, meta',
      },
      // Wait
      duration: { type: 'number', description: 'Wait duration in ms (default 1000, max 10000)' },
      // AX actions (get_ui / ax_click / ax_type)
      element_id: { type: 'number', description: 'Element id from get_ui snapshot (for ax_click / ax_type)' },
      app_name: { type: 'string', description: 'Target app name for get_ui (e.g. "Notes", "Safari"). When provided, the app does NOT need to be in the foreground — AX operates on any running app. Omit to target the current frontmost window.' },
      // Display control
      show_user: {
        type: 'boolean',
        description: 'Whether to display the screenshot to the user in chat. Set true when user asks to see the screen. Default: true for screenshot action, false for other actions.',
      },
    },
    required: ['action'],
  },
  execute: async (input): Promise<ToolResult> => {
    // Auto-enable Computer Use on first call — no need for user to find the toggle
    if (!useSettingsStore.getState().computerUseEnabled) {
      useSettingsStore.getState().setComputerUseEnabled(true);
    }

    const action = input.action as string;

    // Check session limits (max steps / timeout)
    const limitError = checkCUSessionLimits();
    if (limitError) return limitError;

    // Wait action — no permission needed
    if (action === 'wait') {
      const ms = Math.min(Math.max((input.duration as number) || 1000, 100), 10000);
      await new Promise(r => setTimeout(r, ms));
      return `Waited ${ms}ms`;
    }

    // AX actions drive controls directly — no cursor movement, no window hide needed.
    // Declared early because the permission block below needs it.
    const isAxAction = ['get_ui', 'ax_click', 'ax_type'].includes(action);

    // Check system permissions (macOS) — auto-open Settings if missing
    try {
      const perms = await invoke<{ screen_recording: boolean; accessibility: boolean }>('check_macos_permissions');

      // AX-only actions (get_ui / ax_click / ax_type) operate entirely through the
      // Accessibility API — they never capture pixels and do NOT need Screen Recording.
      const needsScreenRecording = !isAxAction;
      if (needsScreenRecording && !perms.screen_recording) {
        // Trigger the system permission dialog (first time shows the dialog,
        // subsequent times it's a no-op). The dialog has an "Open System Settings" button.
        const granted = await invoke<boolean>('request_screen_recording');
        if (!granted) {
          return 'Error: 没有录屏权限。请在弹出的系统对话框中点击「打开系统设置」，授权 Abu 后重启。\n\nNo Screen Recording permission. Please click "Open System Settings" in the dialog, grant Abu access, then restart Abu.';
        }
      }

      // AX actions (and non-screenshot pixel actions) need Accessibility permission.
      const needsAccessibility = isAxAction || action !== 'screenshot';
      if (needsAccessibility && !perms.accessibility) {
        // No system dialog for Accessibility — need to open Settings directly
        await openMacOSSettings('Accessibility');
        return 'Error: 没有辅助功能权限。已自动打开系统设置，请在「辅助功能」中授权 Abu，然后重启 Abu。\n\nNo Accessibility permission. System Settings has been opened — please grant Abu access in Accessibility, then restart Abu.';
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
    // Only pixel-based actions (click/move/scroll/drag/type/key) need window hide.
    // (isAxAction was declared above the permission check block)
    const needsHideWindow = !computerUseBatchMode && !isAxAction &&
      ['click', 'move', 'scroll', 'drag', 'type', 'key'].includes(action);
    if (needsHideWindow) {
      try { await invoke('window_hide'); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 100)); // Let window animate away
    }

    // Actions that should auto-screenshot after execution.
    // AX actions (ax_click / ax_type) are intentionally excluded: they return structured
    // text feedback directly and don't need a screenshot to verify. Auto-screenshotting
    // after AX actions also fails for non-vision models ("No endpoints found that
    // support image input"). The model can call get_ui or screenshot explicitly if needed.
    const autoScreenshotActions = ['click', 'type', 'key', 'scroll', 'drag'];

    try {
      let actionResult: string;
      switch (action) {
        case 'screenshot':
          return await executeScreenshot(input);

        case 'click': {
          const sc = toScreenCoords(input.x as number, input.y as number);
          actionResult = await invoke<string>('mouse_click', {
            x: sc.x, y: sc.y,
            button: (input.button as string) || undefined,
          });
          break;
        }

        case 'move': {
          const sc = toScreenCoords(input.x as number, input.y as number);
          actionResult = await invoke<string>('mouse_move', { x: sc.x, y: sc.y });
          break;
        }

        case 'scroll': {
          const sc = toScreenCoords(input.x as number, input.y as number);
          actionResult = await invoke<string>('mouse_scroll', {
            x: sc.x, y: sc.y,
            direction: input.direction as string,
            amount: (input.amount as number) || undefined,
          });
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

        case 'type': {
          const text = input.text as string;
          // Detect non-ASCII (Chinese/CJK etc.) — use clipboard + Cmd+V for reliable input
          const hasNonAscii = /[^\u0020-\u007E\t\n\r]/.test(text);
          if (hasNonAscii) {
            // Save user's clipboard, paste our text, then restore
            let savedClipboard: string | null = null;
            try { savedClipboard = await clipboardReadText(); } catch { /* empty clipboard */ }
            try {
              await clipboardWriteText(text);
              await new Promise(r => setTimeout(r, 50));
              const pasteModifier = isMacOS() ? 'meta' : 'ctrl';
              await invoke<string>('keyboard_press', { key: 'v', modifiers: [pasteModifier] });
              // Wait for paste to take effect before restoring
              await new Promise(r => setTimeout(r, 150));
            } finally {
              // Restore original clipboard content
              if (savedClipboard != null) {
                try { await clipboardWriteText(savedClipboard); } catch { /* ignore */ }
              }
            }
            actionResult = `Typed (via paste): ${text} (${text.length} characters)`;
          } else {
            actionResult = await invoke<string>('keyboard_type', { text });
          }
          break;
        }

        case 'key':
          actionResult = await invoke<string>('keyboard_press', {
            key: input.key as string,
            modifiers: (input.modifiers as string[]) || undefined,
          });
          break;

        // ── AX path (no cursor movement, no window hide) ───────────────────

        case 'get_ui': {
          // Close previous session before taking a fresh snapshot.
          await closeCurrentAxSession();
          const targetApp = (input.app_name as string | undefined) ?? null;
          try {
            const snap = await invoke<AxSnapshotResult>('ax_snapshot', {
              appName: targetApp,
            });
            currentAxSessionId = snap.session_id;
            const formatted = formatAxElements(snap.elements);
            const note = snap.truncated ? '\n⚠️ 元素列表已截断（树太大）。' : '';
            actionResult =
              `UI 树快照成功（${snap.app ?? 'unknown'}）` +
              `，共 ${snap.elements.length} 个可交互元素，遍历 ${snap.total_visited} 个节点。${note}\n\n` +
              `${formatted}\n\n` +
              `要操作元素，使用 ax_click(element_id) 点击按钮/链接，或 ax_type(element_id, text) 输入文字。`;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // AX unavailable (no permission, non-macOS, etc.)
            actionResult = `get_ui 不可用：${msg}`;
          }
          break;
        }

        case 'ax_click': {
          const elemId = input.element_id as number;
          if (currentAxSessionId == null) {
            return 'Error: 需要先调用 get_ui 获取 UI 快照，再使用 ax_click。';
          }
          try {
            await invoke('ax_press', { sessionId: currentAxSessionId, elementId: elemId });
            actionResult = `ax_click 成功：元素 [${elemId}] 已按下（AXPress，光标未移动）`;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Fallback: pixel click if caller provided coordinates
            if (input.x != null && input.y != null) {
              const sc = toScreenCoords(input.x as number, input.y as number);
              await invoke<string>('mouse_click', { x: sc.x, y: sc.y, button: undefined });
              actionResult = `ax_click 失败（${msg}），已降级为像素点击 (${sc.x}, ${sc.y})`;
            } else {
              return `Error: ax_click 失败：${msg}。请尝试 screenshot 后用 click(x, y)。`;
            }
          }
          break;
        }

        case 'ax_type': {
          const elemId = input.element_id as number;
          const text = input.text as string;
          if (currentAxSessionId == null) {
            return 'Error: 需要先调用 get_ui 获取 UI 快照，再使用 ax_type。';
          }
          try {
            await invoke('ax_set_value', {
              sessionId: currentAxSessionId,
              elementId: elemId,
              text,
            });
            actionResult = `ax_type 成功：元素 [${elemId}] 已设置文本（无键盘事件）`;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Fallback: keyboard / clipboard
            const hasNonAscii = /[^ -~\t\n\r]/.test(text);
            if (hasNonAscii) {
              let saved: string | null = null;
              try { saved = await clipboardReadText(); } catch { /* empty */ }
              try {
                await clipboardWriteText(text);
                await new Promise(r => setTimeout(r, 50));
                await invoke<string>('keyboard_press', {
                  key: 'v', modifiers: [isMacOS() ? 'meta' : 'ctrl'],
                });
                await new Promise(r => setTimeout(r, 150));
              } finally {
                if (saved != null) try { await clipboardWriteText(saved); } catch { /* ignore */ }
              }
            } else {
              await invoke<string>('keyboard_type', { text });
            }
            actionResult = `ax_type 失败（${msg}），已降级为键盘输入`;
          }
          break;
        }

        default:
          return `Unknown action: ${action}. Valid actions: screenshot, click, move, scroll, drag, type, key, wait, get_ui, ax_click, ax_type`;
      }

      // Auto-screenshot after UI-affecting actions so the model can see the result.
      // Window stays HIDDEN during the wait + capture — don't show it prematurely!
      // In batch mode, intermediate tools skip auto-screenshot (only last computer tool takes one).
      if (autoScreenshotActions.includes(action) && !skipAutoScreenshot) {
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
