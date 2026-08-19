/**
 * Computer Use safety checks — sensitive app blocking and dangerous key interception.
 *
 * Prevents the model from:
 * 1. Interacting with sensitive apps (keychain, terminal, system settings)
 * 2. Pressing dangerous key combos (Cmd+Q, Alt+F4, etc.)
 */

import { isMacOS } from '../../utils/platform';
import policy from './computerUsePolicy.json';

// ─── Sensitive App Blocklist (by bundle ID) ───
//
// `computerUsePolicy.json` cannot carry comments, so the non-obvious hardDeny
// entries are explained here. Beyond the credential/terminal/system-settings
// apps the list started with, three entries encode the self-protection red
// line (permission plan §4.6 ②) — an agent must never be able to operate the
// UI that grants agents permission, nor its own app:
//
//  - `com.abu.app` — Abu itself. Driving our own window would let a single
//    injected instruction click through Abu's confirmation dialogs, flip the
//    permission mode, or approve a site, converting one approval into a
//    permanent back door. (The dev shell runs under Electron's own bundle id
//    and is NOT covered; blocking that would block every Electron app.)
//  - `com.apple.SecurityAgent` — the macOS authorization prompt (admin
//    password / Touch ID). This is the OS's own "grant permission" UI.
//  - `com.apple.authorizationhost` — the same authorization flow's other
//    process identity.
//
// Windows gets `abu` / `abu.exe` for the same self-protection reason
// (electron-builder productName is "Abu"; Windows matches on process name).
const HARD_DENY_MACOS = new Set(policy.macos.hardDeny);
const APPROVAL_REQUIRED_MACOS = new Set(policy.macos.approvalRequired);
const HARD_DENY_WINDOWS = new Set(policy.windows.hardDeny.map((value) => value.toLowerCase()));
const APPROVAL_REQUIRED_WINDOWS = new Set(
  policy.windows.approvalRequired.map((value) => value.toLowerCase()),
);

export type ComputerUseAppClass = 'ordinary' | 'approval-required' | 'hard-deny' | 'unknown';

export function classifyComputerUseApp(
  bundleId: string | null | undefined,
): ComputerUseAppClass {
  if (!bundleId?.trim()) return 'unknown';
  if (isMacOS()) {
    if (HARD_DENY_MACOS.has(bundleId)) return 'hard-deny';
    if (APPROVAL_REQUIRED_MACOS.has(bundleId)) return 'approval-required';
    return 'ordinary';
  }
  const processName = bundleId.toLowerCase();
  if (HARD_DENY_WINDOWS.has(processName)) return 'hard-deny';
  if (APPROVAL_REQUIRED_WINDOWS.has(processName)) return 'approval-required';
  return 'ordinary';
}

/**
 * Check if the foreground app is sensitive and should not be operated.
 * Returns error message if blocked, null if allowed.
 */
export function checkSensitiveApp(
  bundleId: string | null | undefined,
  appName: string,
  options?: { approvalHandledByHost?: boolean },
): string | null {
  const classification = classifyComputerUseApp(bundleId);
  if (classification === 'unknown') {
    // Electron has a main-process identity gate and must fail closed. Keep the
    // legacy Tauri behavior on platforms where get_active_window historically
    // returned no process identity, until that path gains an equivalent gate.
    if (!options?.approvalHandledByHost) return null;
    return `安全限制：无法确认「${appName || '当前应用'}」的稳定身份，已停止电脑操控。`;
  }
  if (classification === 'hard-deny') {
    return `安全限制：不允许操控「${appName}」。该应用涉及凭据、系统设置或终端，任何权限模式都不能绕过。`;
  }
  if (classification === 'approval-required') {
    if (options?.approvalHandledByHost) return null;
    return `安全限制：「${appName}」需要单独的应用授权，当前尚未获得授权。`;
  }

  return null;
}

// ─── Dangerous Key Combo Blocklist ───

/** macOS key combos that should never be sent by the model */
const BLOCKED_KEYS_MACOS = new Set([
  'meta+q',              // Quit frontmost app
  'meta+shift+q',        // Log out
  'alt+meta+escape',     // Force Quit dialog
  'meta+tab',            // App switcher (interferes with CU flow)
  'ctrl+meta+q',         // Lock screen
  'meta+shift+delete',   // Empty Trash
]);

/** Windows key combos that should never be sent */
const BLOCKED_KEYS_WINDOWS = new Set([
  'alt+f4',              // Close window
  'ctrl+alt+delete',     // Security options
  'meta+l',              // Lock screen
  'alt+tab',             // App switcher
]);

/**
 * Check if a key combo is blocked.
 * Returns error message if blocked, null if allowed.
 */
export function checkBlockedKeyCombo(key: string, modifiers?: string[]): string | null {
  // Normalize: sort modifiers alphabetically + lowercase key
  const mods = (modifiers ?? []).map(m => {
    const lower = m.toLowerCase();
    // Normalize aliases
    if (lower === 'cmd' || lower === 'command' || lower === 'super' || lower === 'win') return 'meta';
    if (lower === 'control') return 'ctrl';
    if (lower === 'option') return 'alt';
    return lower;
  }).sort();

  const normalized = [...mods, key.toLowerCase()].join('+');

  const blocklist = isMacOS() ? BLOCKED_KEYS_MACOS : BLOCKED_KEYS_WINDOWS;

  if (blocklist.has(normalized)) {
    return `安全限制：按键组合「${normalized}」被拦截。该组合可能导致系统操作（退出应用/锁屏/注销等），不允许通过 Computer Use 执行。`;
  }

  return null;
}
