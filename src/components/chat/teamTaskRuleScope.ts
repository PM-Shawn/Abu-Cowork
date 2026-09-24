import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import type { TeamConfirmation } from '@/stores/teamConfirmationStore';

/**
 * One line saying what a "this task" allowance covers, in the user's words.
 * Read from the request itself: `identity.scope` is teamApprovalScope.ts's
 * command / file / site scope, and a command rule also needs the same folder.
 */
export function describeTaskRuleScope(item: TeamConfirmation, member: string, t: TranslationDict['team']): string {
  const scope = item.identity?.scope ?? '';
  if (item.kind === 'command') {
    const cwd = item.identity?.cwd ?? t.confirmationDefaultCwd;
    return scope.startsWith('prefix:')
      ? format(t.confirmationScopeCommand, { member, cwd, prefix: scope.slice('prefix:'.length) })
      : format(t.confirmationScopeExactCommand, { member, cwd });
  }
  if (item.kind === 'file') {
    const [caps, ...folder] = scope.split(':');
    return format(caps.includes('write') ? t.confirmationScopeFileWrite : t.confirmationScopeFileRead,
      { member, folder: folder.join(':') });
  }
  // 嵌入区域的范围写作「区域 in 页面」（teamConfirmationIdentity.ts 的 scopeFor）
  const [region, page] = scope.split(' in ');
  const site = page ? format(t.confirmationScopeEmbeddedSite, { region, page }) : scope;
  if (item.browserPermissionResource === 'script') return format(t.confirmationScopeScript, { member, site });
  if (item.browserPermissionResource === 'upload') return format(t.confirmationScopeUpload, { member, site });
  return format(t.confirmationScopeBrowse, { member, site });
}
