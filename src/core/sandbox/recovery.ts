/**
 * Sandbox recovery — detects sandbox-blocked errors and provides
 * actionable recovery (authorize path + suggest retry).
 */

import { useToastStore } from '../../stores/toastStore';
import { authorizeWorkspace } from '../tools/pathSafety';
import { useSettingsStore } from '../../stores/settingsStore';
import { getI18n } from '../../i18n';

/**
 * Extract the target write path from a sandbox-blocked command.
 * Heuristic: looks for destination paths in cp, mv, tee, and redirect patterns.
 * Returns the parent directory (for authorization) or null if can't determine.
 */
export function extractBlockedPath(command: string): string | null {
  // cp "src" "dest" — take the last path argument
  const cpMatch = command.match(/\b(?:cp|mv)\s+(?:-\S+\s+)*(?:"[^"]+"|'[^']+'|\S+)\s+["']?([^"'\s]+)["']?/);
  if (cpMatch) return getParentDir(cpMatch[1]);

  // python3 -c "...save('/path/to/file.docx')" — extract path from save() call
  const saveMatch = command.match(/\.save\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (saveMatch) return getParentDir(saveMatch[1]);

  // writeFileSync('path') or writeFile('path')
  const writeMatch = command.match(/writeFile(?:Sync)?\s*\(\s*['"]([^'"]+)['"]/);
  if (writeMatch) return getParentDir(writeMatch[1]);

  // tee /path/to/file or > /path/to/file (tee often follows a pipe)
  const redirectMatch = command.match(/(?:\btee\s+|>\s*)["']?([/~][^"'\s]+)["']?/);
  if (redirectMatch) return getParentDir(redirectMatch[1]);

  return null;
}

function getParentDir(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.length <= 1) return filePath;
  return parts.slice(0, -1).join('/');
}

/**
 * Show a recovery toast when sandbox blocks a write.
 * Offers "Authorize this directory" and "Go to settings" actions.
 */
export function showSandboxBlockedToast(command: string): void {
  const t = getI18n();
  const blockedDir = extractBlockedPath(command);

  if (blockedDir) {
    useToastStore.getState().addToast({
      type: 'warning',
      title: t.sandbox.writeBlocked,
      message: `${t.sandbox.writeBlockedDir}: ${blockedDir}`,
      actions: [
        {
          label: t.sandbox.authorizePath,
          onClick: () => {
            authorizeWorkspace(blockedDir, ['read', 'write']);
            useToastStore.getState().addToast({
              type: 'success',
              title: t.sandbox.pathAuthorized,
              message: t.sandbox.retryHint,
            });
          },
        },
        {
          label: t.sandbox.goToSettings,
          onClick: openSecuritySettings,
        },
      ],
    });
  } else {
    // Can't determine path — generic message
    useToastStore.getState().addToast({
      type: 'warning',
      title: t.sandbox.writeBlocked,
      message: t.sandbox.writeBlockedGeneric,
      actions: [
        {
          label: t.sandbox.goToSettings,
          onClick: openSecuritySettings,
        },
      ],
    });
  }
}

// The settings window, on the security page (sandbox settings).
function openSecuritySettings(): void {
  useSettingsStore.getState().openSystemSettings('sandbox');
}
