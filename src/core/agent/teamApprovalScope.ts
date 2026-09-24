import type { DangerLevel } from '@/core/tools/commandSafety';
import type { BrowserPermissionResource } from '@/core/permissions/browserPermissionDefaults';
import { isAlwaysAskAction } from '@/core/permissions/alwaysAskPolicy';
import { getParentDir, normalizeSeparators } from '@/utils/pathUtils';

/** Same shell-control test as runPermissionCeiling's customCommandAllowed. */
const SHELL_CONTROL = /&&|\|\||[;&|<>`]|\$\(|[\r\n]/;

/**
 * What "the same kind of command" means for a task rule: its first two
 * words. A command that chains, pipes or redirects is only ever the same as
 * itself, so a rule minted for `npm run build` can never admit
 * `npm run build && rm -rf ~`. A leading environment assignment changes what
 * the command does, so it is kept exact too.
 */
export function commandScope(command: string): string {
  const text = command.trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || SHELL_CONTROL.test(text) || words[0].includes('=')) return `exact:${text}`;
  return `prefix:${words.slice(0, 2).join(' ')}`;
}

/**
 * A file request is the same kind as another in the same folder with the same
 * capabilities. When the path check asked for a whole top-level folder
 * (`isFolder`, e.g. ~/Documents), that folder is the scope; its parent would
 * be the home directory.
 */
export function fileScope(path: string, capabilities: readonly ('read' | 'write')[], isFolder: boolean): string {
  const caps = [...new Set(capabilities)].sort().join('+');
  const normalized = normalizeSeparators(path);
  return `${caps}:${isFolder ? normalized : getParentDir(normalized)}`;
}

export interface TeamTaskRuleSubject {
  kind: 'command' | 'browser' | 'browser-upload' | 'self-extension' | 'file';
  level?: DangerLevel;
  identity?: { scope?: string | null; cwd?: string | null };
  browserPermissionResource?: BrowserPermissionResource;
  allowPersistentGrant?: boolean;
}

/**
 * The category a "this task" rule is keyed on, or null when the request must
 * be asked every time. Browser requests reuse the gate's own verdict: the
 * gate only sets `allowPersistentGrant` where a standing site grant may be
 * offered (not a high-risk site, not "ask every time", origin known). A
 * command without a danger level is treated as one that must be asked.
 */
export function teamTaskRuleCategory(item: TeamTaskRuleSubject): string | null {
  const scope = item.identity?.scope;
  if (!scope) return null;
  switch (item.kind) {
    case 'self-extension':
      return null;
    case 'browser':
    case 'browser-upload':
      if (item.allowPersistentGrant !== true || !item.browserPermissionResource) return null;
      return `browser:${item.browserPermissionResource}:${scope}`;
    case 'file':
      return `file:${scope}`;
    case 'command':
      if (item.level === undefined || isAlwaysAskAction({ level: item.level, kind: 'command' })) return null;
      // 同样开头的命令在另一个目录里做的是另一件事（./deploy.sh、npm run build），目录也要相同
      return `command:${JSON.stringify([item.identity?.cwd ?? null, scope])}`;
  }
}
